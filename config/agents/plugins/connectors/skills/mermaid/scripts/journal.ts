// The private Mermaid write journal under <stateRoot>/connectors/mermaid/
// journal: previews bind an apply to its exact input and observed baseline;
// a create-once consumption mark lets exactly one apply use a preview; an
// object lock guards the apply's critical section; and a receipt is durable
// before any request can leave. A receipt that is sending or unknown blocks
// every write to its object until adjudication settles it. A receipt that
// cannot be read privately or fails its closed shape may hide an open effect
// on any object, so the scan fails closed on it. Records hold only
// identifiers, digests, statuses, timestamps, and holder pids.
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, writePrivateFile } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import { sha256, type WriteOperation } from "./catalogue.ts";
import { mermaidDirectory } from "./custody/index.ts";

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_ID = /^mp-[0-9a-f-]{36}$/;
const RUN_ID = /^mr-[0-9a-f-]{36}$/;

// What the preview read observed: the diagram's content digest for an
// update, the project's diagram IDs for a create.
export type Baseline = { kind: "diagram"; digest: string } | { kind: "project"; documentIDs: string[] };

interface Preview {
	previewId: string;
	operation: WriteOperation;
	objectIdentity: string;
	inputDigest: string;
	baseline: Baseline;
	createdAt: number;
	expiresAt: number;
}

// sending: durable before the call; the request may have left. replied: the
// call returned, so no request is still in flight.
export type ReceiptStatus = "sending" | "completed" | "unknown" | "unchanged";
export interface Receipt {
	runId: string;
	previewId: string;
	operation: WriteOperation;
	objectIdentity: string;
	inputDigest: string;
	baseline: Baseline;
	status: ReceiptStatus;
	replied: boolean;
	effects: { kind: "mermaid-diagram"; id: string }[];
	holder: { pid: number };
	createdAt: number;
	updatedAt: number;
}

const OPEN_STATUSES: ReadonlySet<ReceiptStatus> = new Set(["sending", "unknown"]);
const STATUSES: ReadonlySet<unknown> = new Set(["sending", "completed", "unknown", "unchanged"]);
const OPERATIONS: ReadonlySet<unknown> = new Set(["create_mermaid_chart_diagram", "update_mermaid_chart_diagram"]);
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTITY = /^mermaid-(?:diagram|project):\S+$/;

// Publishing's own atomic-write temporary: .<name>.<uuid>.tmp.
const TEMPORARY = /^\.mr-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/;

// Every receipt, or ok: false when any entry is not a receipt file in its
// closed shape, including one renamed out of the <runId>.json form.
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

function validBaseline(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "diagram") return typeof value.digest === "string" && HEX64.test(value.digest);
	return value.kind === "project" && Array.isArray(value.documentIDs) && value.documentIDs.every((id) => typeof id === "string");
}

const validEffects = (value: unknown): boolean => Array.isArray(value) && value.every((effect) => isRecord(effect) && effect.kind === "mermaid-diagram" && typeof effect.id === "string");

// The receipt named runId, only in its closed shape.
function asReceipt(runId: string, value: unknown): Receipt | null {
	if (!isRecord(value) || value.runId !== runId || typeof value.previewId !== "string" || !PREVIEW_ID.test(value.previewId)) return null;
	if (!OPERATIONS.has(value.operation) || typeof value.objectIdentity !== "string" || !IDENTITY.test(value.objectIdentity)) return null;
	if (typeof value.inputDigest !== "string" || !HEX64.test(value.inputDigest) || !validBaseline(value.baseline)) return null;
	if (!STATUSES.has(value.status) || typeof value.replied !== "boolean" || !validEffects(value.effects)) return null;
	return isRecord(value.holder) && finite(value.holder.pid) && finite(value.createdAt) && finite(value.updatedAt) ? (value as unknown as Receipt) : null;
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
export function openJournal(env: EnvironmentSource, now: () => number = Date.now) {
	const root = path.join(mermaidDirectory(env), "journal");
	const dirs = { previews: path.join(root, "previews"), consumed: path.join(root, "consumed"), receipts: path.join(root, "receipts"), locks: path.join(root, "locks") };
	if (!Object.values(dirs).every((directory) => ownedDirectory(directory).ok)) return null;
	const lockFile = (objectIdentity: string) => path.join(dirs.locks, `${sha256(objectIdentity)}.lock`);
	const receiptFile = (runId: string) => path.join(dirs.receipts, `${runId}.json`);
	return {
		recordPreview(fields: Omit<Preview, "previewId" | "createdAt" | "expiresAt">): Preview | null {
			const createdAt = now();
			const preview: Preview = { previewId: `mp-${randomUUID()}`, ...fields, createdAt, expiresAt: createdAt + PREVIEW_TTL_MS };
			return publishPrivateFileOnce(path.join(dirs.previews, `${preview.previewId}.json`), `${JSON.stringify(preview)}\n`).ok ? preview : null;
		},
		preview(previewId: string): Preview | null {
			return PREVIEW_ID.test(previewId) ? readJson<Preview>(path.join(dirs.previews, `${previewId}.json`)) : null;
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
				if (receipt === null) return { ok: false };
				receipts.push(receipt);
			}
			return { ok: true, receipts: receipts.sort((left, right) => left.createdAt - right.createdAt) };
		},
		receipt(runId: string): Receipt | null {
			return RUN_ID.test(runId) ? asReceipt(runId, readJson(receiptFile(runId))) : null;
		},
		blocking(objectIdentity: string): { ok: true; receipt: Receipt | null } | { ok: false } {
			const scan = this.receipts();
			if (!scan.ok) return scan;
			return { ok: true, receipt: scan.receipts.find((receipt) => receipt.objectIdentity === objectIdentity && OPEN_STATUSES.has(receipt.status)) ?? null };
		},
		// The receipt is durable before the caller sends anything.
		// baseline is the apply's own fresh read, taken under the object lock.
		begin(preview: Preview, baseline: Baseline): Receipt | null {
			const at = now();
			const receipt: Receipt = { runId: `mr-${randomUUID()}`, previewId: preview.previewId, operation: preview.operation, objectIdentity: preview.objectIdentity, inputDigest: preview.inputDigest, baseline, status: "sending", replied: false, effects: [], holder: { pid: process.pid }, createdAt: at, updatedAt: at };
			return publishPrivateFileOnce(receiptFile(receipt.runId), `${JSON.stringify(receipt)}\n`).ok ? receipt : null;
		},
		settle(receipt: Receipt, update: Pick<Receipt, "status" | "replied" | "effects">): Receipt | null {
			const next: Receipt = { ...receipt, ...update, updatedAt: now() };
			return writePrivateFile(receiptFile(receipt.runId), `${JSON.stringify(next)}\n`).ok ? next : null;
		},
	};
}
