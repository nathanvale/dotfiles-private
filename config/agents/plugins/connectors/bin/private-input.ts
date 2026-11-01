import { rmSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";

export const MAX_PRIVATE_INPUT_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 5_000;

async function stdinText(): Promise<string | null> {
	if (process.stdin.isTTY) return null;
	const chunks: Buffer[] = [];
	let size = 0;
	let expired = false;
	const timer = setTimeout(() => { expired = true; process.stdin.destroy(); }, STDIN_TIMEOUT_MS);
	try {
		for await (const chunk of process.stdin) {
			if (!Buffer.isBuffer(chunk)) return null;
			size += chunk.length;
			if (size > MAX_PRIVATE_INPUT_BYTES) { process.stdin.destroy(); return null; }
			chunks.push(chunk);
		}
		return expired ? null : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export async function readPrivateInput(file: string): Promise<string | null> {
	if (file === "-") return stdinText();
	const read = readPrivateFile(file, MAX_PRIVATE_INPUT_BYTES);
	return read.ok ? read.text : null;
}

// MCPorter's native key=@file reads the private JSON into its protocol, not
// its arguments. Normal exit removes our one-use copy.
export function stagePrivateInput(env: EnvironmentSource, input: Readonly<Record<string, unknown>>): { file: string; dispose(): void } | null {
	const text = JSON.stringify(input);
	if (Buffer.byteLength(text) > MAX_PRIVATE_INPUT_BYTES) return null;
	const directory = path.join(stateRoot(env), "connectors", "private-input");
	if (!ownedDirectory(directory).ok) return null;
	const file = path.join(directory, `${crypto.randomUUID()}.json`);
	const written = publishPrivateFileOnce(file, text);
	if (!written.ok || !written.published) return null;
	const remove = () => { try { rmSync(file); } catch { /* A private orphan never authorizes replay. */ } };
	process.once("exit", remove);
	return { file, dispose() { process.removeListener("exit", remove); remove(); } };
}

export interface PrivateFileArgument { readonly name: string; readonly file: string; }
export function privateInputToken(argument: PrivateFileArgument, env: EnvironmentSource): string | null {
 if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument.name)) return null;
 const directory = path.join(stateRoot(env), "connectors", "private-input");
 if (path.dirname(argument.file) !== directory || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(path.basename(argument.file))) return null;
 return readPrivateFile(argument.file, MAX_PRIVATE_INPUT_BYTES).ok ? `${argument.name}=@${argument.file}` : null;
}
