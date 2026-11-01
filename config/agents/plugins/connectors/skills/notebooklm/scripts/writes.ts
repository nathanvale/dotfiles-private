import type { Executed, WriteRequest } from "../../../bin/adapters/contract.ts";
import type { Journal, Preview, Receipt } from "./journal.ts";
import { hash, record } from "./policy.ts";
import type { Caller } from "./transport.ts";

const REPAIR = "Inspect connectors recover notebooklm for this profile; unknown writes must not be replayed";
export const refusal = (cause: string, repair = REPAIR): Executed => ({ kind: "refused", refusal: { kind: "domain", connectorCause: cause, repair } });
function targetTitle(data: Record<string, unknown>, sourceId: string | null): string | null {
	if (sourceId === null) return record(data.notebook) && typeof data.notebook.title === "string" ? data.notebook.title : null;
	if (!Array.isArray(data.sources)) return null;
	const source = data.sources.find((item) => record(item) && item.id === sourceId);
	return record(source) && typeof source.title === "string" ? source.title : null;
}
async function observed(caller: Caller, notebookId: string, sourceId: string | null) {
	const read = await caller.call("notebook_get", { notebook_id: notebookId });
	if (!read.ok || !record(read.data.notebook) || read.data.notebook.id !== notebookId) return null;
	const title = targetTitle(read.data, sourceId);
	return title === null ? null : { baseline: hash(read.data), title: hash(title) };
}
const unknown = (receipt: Receipt): Executed => ({ kind: "effect-unknown", data: { runId: receipt.runId, receipt }, repair: REPAIR });
function blocked(journal: Journal): Executed | null {
	const receipts = journal.all();
	if (receipts === null) return refusal("journal-corrupt");
	return receipts.some((item) => item.status !== "completed") ? refusal("unresolved-write") : null;
}
async function previewWrite(request: WriteRequest, args: Record<string, unknown>, caller: Caller, journal: Journal): Promise<Executed> {
	const block = blocked(journal);
	if (block) return block;
	const notebookId = String(args.notebook_id);
	const sourceId = typeof args.source_id === "string" ? args.source_id : null;
	const baseline = await observed(caller, notebookId, sourceId);
	if (baseline === null) return refusal("target-unreadable", "Read this exact notebook and source before requesting a rename");
	if (baseline.title === hash(args.new_title)) return { kind: "success", data: { alreadySatisfied: true } };
	const value = journal.create({ operation: request.operation, profile: request.selectors.profile ?? "default", notebookId, sourceId, inputDigest: hash(args), baselineDigest: baseline.baseline, titleDigest: hash(args.new_title) });
	return value === null ? refusal("journal-unavailable") : { kind: "recorded", effect: "write-preview", data: { previewId: value.previewId, preview: value } };
}
async function dispatch(preview: Preview, args: Record<string, unknown>, caller: Caller, journal: Journal): Promise<Executed> {
	const baseline = await observed(caller, preview.notebookId, preview.sourceId);
	if (baseline === null || baseline.baseline !== preview.baselineDigest) return refusal("preview-stale", "The notebook changed; create and review a new preview");
	const receipt = journal.begin(preview);
	if (receipt === null) return refusal("journal-unavailable");
	try {
		const sent = await caller.call(preview.operation, args);
		if (!sent.ok) { journal.settle(receipt, "unknown"); return unknown(receipt); }
		const current = await observed(caller, preview.notebookId, preview.sourceId);
		const settled = journal.settle(receipt, current?.title === preview.titleDigest ? "completed" : "unknown");
		return settled?.status === "completed" ? { kind: "applied", data: { runId: settled.runId, receipt: settled } } : unknown(settled ?? receipt);
	} catch { journal.settle(receipt, "unknown"); return unknown(receipt); }
}
export async function write(request: WriteRequest, args: Record<string, unknown>, caller: Caller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refusal("journal-unavailable");
	if (request.phase.kind === "preview") return previewWrite(request, args, caller, journal);
	const value = journal.preview(request.phase.previewId);
	if (value === null) return refusal("preview-unknown");
	if (value.operation !== request.operation || value.inputDigest !== hash(args)) return refusal("preview-input-mismatch", "Apply the identical operation and input that were previewed");
	if (Date.now() >= value.expiresAt) return refusal("preview-expired", "Create and review a fresh preview");
	if (!journal.lock()) return refusal("write-locked");
	try {
		const receipts = journal.all();
		if (receipts === null) return refusal("journal-corrupt");
		if (receipts.some((item) => item.preview.previewId === value.previewId)) return refusal("preview-consumed");
		const block = blocked(journal);
		return block ?? await dispatch(value, args, caller, journal);
	} finally { journal.release(); }
}
export async function adjudicate(receipt: Receipt, caller: Caller, journal: Journal): Promise<Executed> {
	if (!journal.lock()) return refusal("write-locked");
	try {
		const current = journal.receipt(receipt.runId);
		if (!current) return refusal("journal-corrupt");
		if (current.status === "completed") return refusal("receipt-settled");
		const state = await observed(caller, current.preview.notebookId, current.preview.sourceId);
		if (state?.title !== current.preview.titleDigest) return refusal("evidence-insufficient", "The requested rename is unproved; an unchanged title does not prove a timed-out request cannot finish later");
		const settled = journal.settle(current, "completed");
		return settled === null ? refusal("journal-unavailable") : { kind: "recorded", effect: "write-adjudication", data: { runId: settled.runId, receipt: settled } };
	} finally { journal.release(); }
}
