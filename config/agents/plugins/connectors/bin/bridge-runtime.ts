// Connector-owned runtime for the pinned upstream bridge. The release archive
// and extracted executable are checked against literal SHA-256 values before
// installation into Connector state. No PATH or global package is trusted.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { ownedDirectory, stateRoot } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";

export const BRIDGE_VERSION = "0.5.0";
const RELEASE = `https://github.com/hyper-mcp-rs/hyper-mcp-remote/releases/download/v${BRIDGE_VERSION}`;
export interface BridgeTarget { archive: string; digest: string; binaryDigest: string }
export type BridgeFetcher = (url: string, init: RequestInit) => Promise<Response>;
const TARGETS: Record<string, BridgeTarget> = {
	"darwin-arm64": { archive: "hyper-mcp-remote-aarch64-apple-darwin.tar.gz", digest: "ccc17421f965295b0aadf8f8b6b7ad01ce2886d203d3b88892d84ca215bc6ab6", binaryDigest: "26b92a983fb2f70dc60b0d8b4f7389a502dbce8919fc71c0760cc920fa68a502" },
	"linux-arm64": { archive: "hyper-mcp-remote-aarch64-unknown-linux-gnu.tar.gz", digest: "7ca68d6e7e5e6dc2b9ce4e9e58679e8cc71d3b4d348db36a1bdd5d99ebd5f726", binaryDigest: "f0fbc5ee100b4a3ad2d889d94b75e6aa9261b3abfa040242c57ce7c9fef5c6a9" },
	"linux-x64": { archive: "hyper-mcp-remote-x86_64-unknown-linux-gnu.tar.gz", digest: "8d57d73fe95d25b39168f5323b7de330d0cc71ad1df41be396ee392ad9a1aeb5", binaryDigest: "b6af910017b371c7961f33fff768205c2ac59b4e6e1a41b86caa07481f4e36a5" },
};
const MAX_ARCHIVE_BYTES = 16_000_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const currentTarget = (): BridgeTarget => {
	const target = TARGETS[`${process.platform}-${process.arch}`];
	if (!target) throw new Error("bridge-platform-unsupported");
	return target;
};

export function ownedBridgePath(env: EnvironmentSource): string {
	return path.join(stateRoot(env), "connectors", "bridge", BRIDGE_VERSION, "hyper-mcp-remote");
}

function verifiedOwnedBridge(file: string, expectedDigest: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return false;
	}
	try {
		const info = fstatSync(fd);
		return info.isFile() && info.uid === os.userInfo().uid && (info.mode & 0o7777) === 0o700 && sha256(readFileSync(fd)) === expectedDigest;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

export function ownedBridgeReady(file: string): boolean {
	return verifiedOwnedBridge(file, currentTarget().binaryDigest);
}

// The published tarball contains one regular executable. Read that entry only;
// never expand archive paths onto the filesystem.
function tarEntry(tar: Uint8Array, offset: number): { next: number; binary?: Uint8Array } | null {
	const header = tar.subarray(offset, offset + 512);
	const name = Buffer.from(header.subarray(0, 100)).toString("utf8").replace(/\0.*$/, "");
	if (!name) return null;
	const sizeText = Buffer.from(header.subarray(124, 136)).toString("utf8").replace(/\0.*$/, "").trim();
	const size = Number.parseInt(sizeText, 8);
	if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("bridge-archive-invalid");
	const next = offset + 512 + Math.ceil(size / 512) * 512;
	const isExecutable = (name === "hyper-mcp-remote" || name === "./hyper-mcp-remote") && (header[156] === 0 || header[156] === 48);
	return { next, ...(isExecutable ? { binary: tar.subarray(offset + 512, offset + 512 + size) } : {}) };
}

export function bridgeFromArchive(archive: Uint8Array, expectedDigest: string, expectedBinaryDigest: string): Uint8Array {
	if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("bridge-archive-invalid");
	if (sha256(archive) !== expectedDigest) throw new Error("bridge-checksum-invalid");
	const tar = gunzipSync(archive, { maxOutputLength: 50_000_000 });
	for (let offset = 0; offset + 512 <= tar.length;) {
		const entry = tarEntry(tar, offset);
		if (entry === null) break;
		if (entry.binary !== undefined) {
			if (sha256(entry.binary) !== expectedBinaryDigest) throw new Error("bridge-binary-invalid");
			return entry.binary;
		}
		offset = entry.next;
	}
	throw new Error("bridge-archive-invalid");
}

// The reader limits bytes before buffering, even when Content-Length is
// missing or dishonest. Aborting also cancels a stalled first-use fetch.
function checkContentLength(reply: Response, maxBytes: number): void {
	const declared = reply.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("bridge-download-bounded");
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = body.getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) throw new Error("bridge-download-bounded");
			chunks.push(next.value);
		}
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const archive = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.byteLength; }
	return archive;
}

export async function downloadBridgeArchive(url: string, fetcher: BridgeFetcher, maxBytes = MAX_ARCHIVE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Uint8Array> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	try {
		const reply = await fetcher(url, { signal: controller.signal });
		if (!reply.ok || !reply.body) throw new Error("bridge-download-failed");
		checkContentLength(reply, maxBytes);
		return await readBoundedBody(reply.body, maxBytes);
	} catch (error) {
		controller.abort();
		if (timedOut) throw new Error("bridge-download-timeout");
		if (error instanceof Error && error.message === "bridge-download-bounded") throw error;
		throw new Error("bridge-download-failed");
	} finally {
		clearTimeout(timer);
	}
}

// Target and fetcher are injected for archive-level tests. The production
// entrypoint below always supplies the literal release target and global fetch.
export async function provisionBridgeForTarget(file: string, target: BridgeTarget, fetcher: BridgeFetcher = fetch): Promise<string> {
	const directory = path.dirname(file);
	if (!ownedDirectory(directory).ok) throw new Error("bridge-directory-invalid");
	try {
		lstatSync(file);
		if (verifiedOwnedBridge(file, target.binaryDigest)) return file;
		throw new Error("bridge-owned-invalid");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const archive = await downloadBridgeArchive(`${RELEASE}/${target.archive}`, fetcher);
	const binary = bridgeFromArchive(archive, target.digest, target.binaryDigest);
	const temporary = path.join(directory, `.hyper-mcp-remote.${crypto.randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, binary, { flag: "wx", mode: 0o700 });
		chmodSync(temporary, 0o700);
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
	if (!verifiedOwnedBridge(file, target.binaryDigest)) throw new Error("bridge-install-invalid");
	return file;
}

async function installOwnedBridge(env: EnvironmentSource = process.env): Promise<string> {
	return provisionBridgeForTarget(ownedBridgePath(env), currentTarget());
}

if (import.meta.main) {
	try {
		const file = await installOwnedBridge();
		// The path is nonsecret; the Provider suppresses this subprocess output.
		process.stdout.write(`${file}\n`);
	} catch {
		process.stderr.write("connectors:error:bridge-install-failed:install the pinned Connector bridge\n");
		process.exit(4);
	}
}
