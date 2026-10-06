// Account-scoped private journal. Stores digests, identifiers, and verification arguments.
// Raw provider replies, mutation content, OAuth grants, and prepared upload grants are never stored.
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot, writePrivateFile } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import type { Call } from "./catalogue.ts";
import { operationKind, record, sha256 } from "./catalogue.ts";

const PREVIEW_TTL_MS = 15 * 60 * 1000;
export const PREVIEW_ID = /^np-[0-9a-f-]{36}$/;
export const RUN_ID = /^nr-[0-9a-f-]{36}$/;

// What a read of the object observed: a digest of the whole result, the
// identifiers it carries, and its version when it names one.
export interface Baseline {
	digest: string;
	ids: string[];
	version: string | null;
}

export interface Preview {
	previewId: string;
	operation: string;
	objectIdentity: string;
	inputDigest: string;
	baseline: Baseline;
	fixedAfterBaseline: Baseline | null;
	createdAt: number;
	expiresAt: number;
}

// sending: durable before the call; the request may have left. replied: the
// call returned, so no request is still in flight.
export type ReceiptStatus = "sending" | "completed" | "unknown" | "unchanged";
export interface Receipt {
	runId: string;
	previewId: string;
	operation: string;
	objectIdentity: string;
	inputDigest: string;
	baseline: Baseline;
	fixedAfterBaseline: Baseline | null;
	status: ReceiptStatus;
	replied: boolean;
	readBack: Call | null;
	taskId: string | null;
	taskState: "pending" | "succeeded" | "failed" | null;
	terminalFailure: "tool-error" | "task-failed" | null;
	effects: { kind: "notion-object"; id: string }[];
	holder: { pid: number };
	createdAt: number;
	updatedAt: number;
}

const OPEN_STATUSES: ReadonlySet<ReceiptStatus> = new Set(["sending", "unknown"]);
const STATUSES: ReadonlySet<unknown> = new Set(["sending", "completed", "unknown", "unchanged"]);
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTITY = /^notion-account:[a-z][a-z0-9-]{0,31}$/;
const OPERATION = /^notion-[a-z-]+$/;
const TEMPORARY = /^\.nr-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/;

type ReceiptScan = { ok: true; receipts: Receipt[] } | { ok: false };
export type Journal = NonNullable<ReturnType<typeof openJournal>>;

function readJson<T>(file: string): T | null {
	const read = readPrivateFile(file);
	if (!read.ok) return null;
	try {
		return JSON.parse(read.text) as T;
	} catch {
		return null;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

function validBaseline(value: unknown): boolean {
	return isRecord(value) && typeof value.digest === "string" && HEX64.test(value.digest) && strings(value.ids) && (value.version === null || typeof value.version === "string");
}

const validEffects = (value: unknown): boolean => Array.isArray(value) && value.every((effect) => isRecord(effect) && effect.kind === "notion-object" && typeof effect.id === "string");

function validIdentity(value: Record<string, unknown>): boolean {
	return typeof value.operation === "string" && OPERATION.test(value.operation) && operationKind(value.operation) === "write" && typeof value.objectIdentity === "string" && IDENTITY.test(value.objectIdentity) && typeof value.inputDigest === "string" && HEX64.test(value.inputDigest);
}

// The receipt named runId, only in its closed shape.
function validReadBack(value: unknown): boolean {
	if (value === null) return true;
	return record(value) && typeof value.tool === "string" && operationKind(value.tool) === "read" && record(value.args) && Object.keys(value).sort().join(",") === "args,tool";
}
function validLifecycle(value: Record<string, unknown>): boolean {
	return [null, "pending", "succeeded", "failed"].includes(value.taskState as null) && [null, "tool-error", "task-failed"].includes(value.terminalFailure as null) && (value.taskId === null || typeof value.taskId === "string") && STATUSES.has(value.status) && typeof value.replied === "boolean" && validEffects(value.effects);
}
function validBaselines(value: Record<string, unknown>): boolean {
	return validBaseline(value.baseline) && (value.fixedAfterBaseline === null || validBaseline(value.fixedAfterBaseline));
}
function asReceipt(runId: string, value: unknown): Receipt | null {
	if (!isRecord(value) || value.runId !== runId || typeof value.previewId !== "string" || !PREVIEW_ID.test(value.previewId)) return null;
	if (!validIdentity(value) || !validBaselines(value) || !validReadBack(value.readBack) || !validLifecycle(value)) return null;
	return isRecord(value.holder) && finite(value.holder.pid) && finite(value.createdAt) && finite(value.updatedAt) ? (value as unknown as Receipt) : null;
}
function asPreview(previewId: string, value: unknown): Preview | null {
	return isRecord(value) && value.previewId === previewId && validIdentity(value) && validBaseline(value.baseline) && (value.fixedAfterBaseline === null || validBaseline(value.fixedAfterBaseline)) && finite(value.createdAt) && finite(value.expiresAt) ? value as unknown as Preview : null;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: unknown }).code === "EPERM";
	}
}

// null when the journal directories cannot be prepared as owned 0700.
export function openJournal(env: EnvironmentSource, account: string, now: () => number = Date.now) {
	const notion = path.join(stateRoot(env), "connectors", "notion", account);
	const root = path.join(notion, "journal");
	const dirs = { previews: path.join(root, "previews"), consumed: path.join(root, "consumed"), receipts: path.join(root, "receipts"), locks: path.join(root, "locks") };
	if (![notion, root, ...Object.values(dirs)].every((directory) => ownedDirectory(directory).ok)) return null;
	const lockFile = (objectIdentity: string) => path.join(dirs.locks, `${sha256(objectIdentity)}.lock`);
	const receiptFile = (runId: string) => path.join(dirs.receipts, `${runId}.json`);
	return {
		recordPreview(fields: Omit<Preview, "previewId" | "createdAt" | "expiresAt">): Preview | null {
			const createdAt = now();
			const preview: Preview = { previewId: `np-${randomUUID()}`, ...fields, createdAt, expiresAt: createdAt + PREVIEW_TTL_MS };
			return publishPrivateFileOnce(path.join(dirs.previews, `${preview.previewId}.json`), `${JSON.stringify(preview)}\n`).ok ? preview : null;
		},
		preview(previewId: string): Preview | null {
			const preview = PREVIEW_ID.test(previewId) ? asPreview(previewId, readJson(path.join(dirs.previews, `${previewId}.json`))) : null;
			return preview?.objectIdentity === `notion-account:${account}` ? preview : null;
		},
		expired: (preview: Preview): boolean => now() > preview.expiresAt,
		consumed: (previewId: string): boolean => readPrivateFile(path.join(dirs.consumed, previewId)).ok,
		// Exactly one caller consumes a preview, even across processes.
		consume(previewId: string): boolean {
			const published = publishPrivateFileOnce(path.join(dirs.consumed, previewId), `${JSON.stringify({ pid: process.pid, at: now() })}\n`);
			return published.ok && published.published;
		},
		lock(objectIdentity: string): boolean {
			const published = publishPrivateFileOnce(lockFile(objectIdentity), `${JSON.stringify({ pid: process.pid })}\n`);
			return published.ok && published.published;
		},
		release(objectIdentity: string): void {
			rmSync(lockFile(objectIdentity), { force: true });
		},
		// Removes a lock only once its holder has exited.
		unlock(objectIdentity: string): "unlocked" | "absent" | "holder-alive" {
			const holder = readJson<{ pid?: unknown }>(lockFile(objectIdentity));
			if (holder === null) return "absent";
			if (typeof holder.pid === "number" && alive(holder.pid)) return "holder-alive";
			rmSync(lockFile(objectIdentity), { force: true });
			return "unlocked";
		},
		receipts(): ReceiptScan {
			const receipts: Receipt[] = [];
			for (const name of readdirSync(dirs.receipts).filter((entry) => !TEMPORARY.test(entry))) {
				const runId = name.endsWith(".json") ? name.slice(0, -5) : "";
				const receipt = RUN_ID.test(runId) ? asReceipt(runId, readJson(path.join(dirs.receipts, name))) : null;
				if (receipt === null || receipt.objectIdentity !== `notion-account:${account}`) return { ok: false };
				receipts.push(receipt);
			}
			return { ok: true, receipts: receipts.sort((left, right) => left.createdAt - right.createdAt) };
		},
		receipt(runId: string): Receipt | null {
			const receipt = RUN_ID.test(runId) ? asReceipt(runId, readJson(receiptFile(runId))) : null;
			return receipt?.objectIdentity === `notion-account:${account}` ? receipt : null;
		},
		blocking(objectIdentity: string): { ok: true; receipt: Receipt | null } | { ok: false } {
			const scan = this.receipts();
			if (!scan.ok) return scan;
			return { ok: true, receipt: scan.receipts.find((receipt) => receipt.objectIdentity === objectIdentity && OPEN_STATUSES.has(receipt.status)) ?? null };
		},
		// The receipt is durable before the caller sends anything.
		begin(preview: Preview, baseline: Baseline): Receipt | null {
			const at = now();
			const receipt: Receipt = { runId: `nr-${randomUUID()}`, previewId: preview.previewId, operation: preview.operation, objectIdentity: preview.objectIdentity, inputDigest: preview.inputDigest, baseline, fixedAfterBaseline: preview.fixedAfterBaseline, status: "sending", replied: false, readBack: null, taskId: null, taskState: null, terminalFailure: null, effects: [], holder: { pid: process.pid }, createdAt: at, updatedAt: at };
			return publishPrivateFileOnce(receiptFile(receipt.runId), `${JSON.stringify(receipt)}\n`).ok ? receipt : null;
		},
		settle(receipt: Receipt, update: Pick<Receipt, "status" | "replied" | "effects" | "readBack" | "taskId" | "taskState" | "terminalFailure">): Receipt | null {
			const next: Receipt = { ...receipt, ...update, updatedAt: now() };
			return writePrivateFile(receiptFile(receipt.runId), `${JSON.stringify(next)}\n`).ok ? next : null;
		},
	};
}
