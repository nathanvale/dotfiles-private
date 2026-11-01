import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot, writePrivateFile } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import { record, UUID } from "./policy.ts";

export const PREVIEW_ID = /^lp-[0-9a-f-]{36}$/;
export const RUN_ID = /^lr-[0-9a-f-]{36}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export interface Preview {
	previewId: string;
	operation: string;
	profile: string;
	notebookId: string;
	sourceId: string | null;
	inputDigest: string;
	baselineDigest: string;
	titleDigest: string;
	expiresAt: number;
}
export interface Receipt {
	runId: string;
	preview: Preview;
	status: "sending" | "unknown" | "completed";
}
const read = (file: string): unknown => {
	const stored = readPrivateFile(file);
	if (!stored.ok) return null;
	try { return JSON.parse(stored.text); } catch { return null; }
};
function preview(value: unknown): Preview | null {
	if (!record(value) || Object.keys(value).sort().join(",") !== "baselineDigest,expiresAt,inputDigest,notebookId,operation,previewId,profile,sourceId,titleDigest") return null;
	if (typeof value.previewId !== "string" || !PREVIEW_ID.test(value.previewId) || typeof value.operation !== "string" || !["notebook_rename", "source_rename"].includes(value.operation)) return null;
	if (typeof value.profile !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(value.profile) || typeof value.notebookId !== "string" || !UUID.test(value.notebookId)) return null;
	if (!(value.sourceId === null || typeof value.sourceId === "string" && UUID.test(value.sourceId)) || value.operation === "source_rename" && value.sourceId === null) return null;
	if (![value.inputDigest, value.baselineDigest, value.titleDigest].every((item) => typeof item === "string" && DIGEST.test(item)) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
	return value as unknown as Preview;
}
function receipt(value: unknown): Receipt | null {
	if (!record(value) || Object.keys(value).sort().join(",") !== "preview,runId,status" || typeof value.runId !== "string" || !RUN_ID.test(value.runId)) return null;
	if (typeof value.status !== "string" || !["sending", "unknown", "completed"].includes(value.status)) return null;
	const parsed = preview(value.preview);
	return parsed === null ? null : { runId: value.runId, preview: parsed, status: value.status as Receipt["status"] };
}
export type Journal = NonNullable<ReturnType<typeof openJournal>>;
export function openJournal(env: EnvironmentSource, profile: string) {
	const parent = path.join(stateRoot(env), "connectors", "notebooklm", profile);
	const root = path.join(parent, "journal");
	const previews = path.join(root, "previews");
	const receipts = path.join(root, "receipts");
	if (![parent, root, previews, receipts].every((dir) => ownedDirectory(dir).ok)) return null;
	const lock = path.join(root, "apply.lock");
	const all = (): Receipt[] | null => {
		const items: Receipt[] = [];
		for (const name of readdirSync(receipts)) {
			if (/^\.lr-[0-9a-f-]+\.json\.[0-9a-f-]+\.tmp$/.test(name)) continue;
			const item = receipt(read(path.join(receipts, name)));
			if (!item || name !== `${item.runId}.json` || item.preview.profile !== profile) return null;
			items.push(item);
		}
		return items;
	};
	return {
		all,
		preview(id: string) { const value = PREVIEW_ID.test(id) ? preview(read(path.join(previews, `${id}.json`))) : null; return value?.previewId === id && value.profile === profile ? value : null; },
		receipt(id: string) { const value = RUN_ID.test(id) ? receipt(read(path.join(receipts, `${id}.json`))) : null; return value?.runId === id && value.preview.profile === profile ? value : null; },
		create(fields: Omit<Preview, "previewId" | "expiresAt">): Preview | null {
			const value = { ...fields, previewId: `lp-${randomUUID()}`, expiresAt: Date.now() + 15 * 60 * 1000 };
			const published = publishPrivateFileOnce(path.join(previews, `${value.previewId}.json`), JSON.stringify(value));
			return published.ok && published.published ? value : null;
		},
		begin(value: Preview): Receipt | null {
			const item: Receipt = { runId: `lr-${randomUUID()}`, preview: value, status: "sending" };
			const published = publishPrivateFileOnce(path.join(receipts, `${item.runId}.json`), JSON.stringify(item));
			return published.ok && published.published ? item : null;
		},
		settle(value: Receipt, status: Receipt["status"]): Receipt | null {
			const next = { ...value, status };
			return writePrivateFile(path.join(receipts, `${value.runId}.json`), JSON.stringify(next)).ok ? next : null;
		},
		lock(): boolean { const saved = publishPrivateFileOnce(lock, JSON.stringify({ pid: process.pid })); return saved.ok && saved.published; },
		release(): void { rmSync(lock, { force: true }); },
		unlock(): boolean {
			const holder = read(lock);
			if (!record(holder) || typeof holder.pid !== "number" || !Number.isSafeInteger(holder.pid) || holder.pid <= 0) return false;
			try { process.kill(holder.pid, 0); return false; } catch (error) { if (!record(error) || error.code !== "ESRCH") return false; }
			rmSync(lock);
			return true;
		},
	};
}
