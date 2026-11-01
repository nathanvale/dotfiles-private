import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot, writePrivateFile } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import { type InferenceInput, record } from "./catalogue.ts";
export interface Receipt {
	schemaVersion: 1;
	runId: string;
	digest: string;
	model: string;
	status: "reserved" | "sending" | "unknown" | "answered";
	requestId: string | null;
	usage: { input_tokens: number; output_tokens: number } | null;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const runId = (key: string) => `ji-${hash(key)}`;
export const payloadDigest = (input: InferenceInput) =>
	hash(
		JSON.stringify({
			model: input.model,
			state: input.state,
			questions: input.questions,
		}),
	);
const directory = (env: EnvironmentSource) => path.join(stateRoot(env), "connectors", "jev", "inferences");
const file = (env: EnvironmentSource, id: string) => path.join(directory(env), `${id}.json`);
export const validRunId = (id: string) => /^ji-[0-9a-f]{64}$/.test(id);
function usageOf(value: unknown): Receipt["usage"] | false {
	if (value === null) return null;
	if (!record(value) || typeof value.input_tokens !== "number" || typeof value.output_tokens !== "number") return false;
	if (!Number.isSafeInteger(value.input_tokens) || !Number.isSafeInteger(value.output_tokens) || value.input_tokens < 0 || value.output_tokens < 0)
		return false;
	return {
		input_tokens: value.input_tokens,
		output_tokens: value.output_tokens,
	};
}
function receiptStatus(value: unknown): value is Receipt["status"] {
	return value === "reserved" || value === "sending" || value === "unknown" || value === "answered";
}
function parseReceipt(value: unknown, id: string): Receipt | null {
	if (!record(value) || value.schemaVersion !== 1 || value.runId !== id || !receiptStatus(value.status)) return null;
	if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.model !== "string") return null;
	if (value.requestId !== null && typeof value.requestId !== "string") return null;
	const usage = usageOf(value.usage);
	if (usage === false || (value.status === "answered" && usage === null)) return null;
	return {
		schemaVersion: 1,
		runId: id,
		digest: value.digest,
		model: value.model,
		status: value.status,
		requestId: value.requestId,
		usage,
	};
}
export function receipt(env: EnvironmentSource, id: string): Receipt | null {
	const read = readPrivateFile(file(env, id));
	if (!read.ok) return null;
	try {
		return parseReceipt(JSON.parse(read.text), id);
	} catch {
		return null;
	}
}
export function reserve(env: EnvironmentSource, input: InferenceInput): Receipt | null {
	if (!ownedDirectory(directory(env)).ok) return null;
	const value: Receipt = {
		schemaVersion: 1,
		runId: runId(input.requestKey),
		digest: payloadDigest(input),
		model: input.model,
		status: "reserved",
		requestId: null,
		usage: null,
	};
	const published = publishPrivateFileOnce(file(env, value.runId), `${JSON.stringify(value)}\n`);
	return published.ok && published.published ? value : null;
}
export function save(env: EnvironmentSource, value: Receipt): boolean {
	return writePrivateFile(file(env, value.runId), `${JSON.stringify(value)}\n`).ok;
}
// The atomic one-use send claim also survives a Provider dying before fetch.
export function claimSend(env: EnvironmentSource, input: InferenceInput): Receipt | null {
	const id = runId(input.requestKey);
	const value = receipt(env, id);
	if (!value || value.digest !== payloadDigest(input) || value.status !== "reserved") return null;
	const claimed = publishPrivateFileOnce(path.join(directory(env), `${id}.sent`), `${value.digest}\n`);
	if (!claimed.ok || !claimed.published) return null;
	const sending: Receipt = { ...value, status: "sending" };
	return save(env, sending) ? sending : null;
}
export function receipts(env: EnvironmentSource): Receipt[] | null {
	let names: string[];
	try {
		names = readdirSync(directory(env)).filter((name) => name.endsWith(".json"));
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT" ? [] : null;
	}
	const values = names.map((name) => receipt(env, name.slice(0, -5)));
	return values.every((value): value is Receipt => value !== null) ? values : null;
}
