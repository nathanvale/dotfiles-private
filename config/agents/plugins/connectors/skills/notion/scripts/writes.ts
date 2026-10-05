import type { Executed } from "../../../bin/adapters/contract.ts";
import { afterCall, replyReferenceAllowed, hasReplyReference, digest, observedText, record, toolData, type Write } from "./catalogue.ts";
import type { Baseline, Journal, Preview, Receipt } from "./journal.ts";
import type { Caller, Reply } from "./transport.ts";

export const refused = (connectorCause: string, repair: string): Executed => ({ kind: "refused", refusal: { kind: "domain", connectorCause, repair } });
const REPAIR = "Inspect the account's private Notion journal and connector configuration; restore owned 0700 directories and exact-0600 records";
export const JOURNAL_CORRUPT = refused("journal-corrupt", REPAIR);
const retryPreview = "Preview this Notion operation again, then apply that previewId with the identical input";
const unknownRepair = (account: string, runId: string) => `The write may have happened. Do not retry it. Run connectors recover notion --select account=${account} --run ${runId} --adjudicate --input with the identical input`;

function blocked(journal: Journal, identity: string): Executed | null {
	const scan = journal.blocking(identity);
	if (!scan.ok) return JOURNAL_CORRUPT;
	return scan.receipt ? refused("account-write-blocked", "Resolve the account's open Notion write receipt through connectors recover before another write") : null;
}

// Fetch documents include an observation time that changes between reads;
// discard only that wrapper attribute. The actual content and revision remain.
function baseline(data: unknown): Baseline {
	return { digest: digest(observedText(data).replace(/\bas-of="[^"]*"/g, "")), ids: [], version: null };
}
function matches(write: Write, data: unknown): boolean {
	if (write.verify.reply === "prepared-handle") return false;
	const text = observedText(data);
	return write.verify.contains.every((value) => text.includes(value)) && write.verify.absent.every((value) => !text.includes(value));
}
function distinguishes(write: Write, data: unknown): boolean {
	if (write.verify.reply === "prepared-handle") return true;
	const text = observedText(data);
	return write.verify.contains.every((value) => !text.includes(value)) && write.verify.absent.every((value) => text.includes(value));
}
function fixedAfter(write: Write): ReturnType<typeof afterCall> {
	return write.verify.after && !hasReplyReference(write.verify.after.args) ? write.verify.after : null;
}
function readFailure(reply: Extract<Reply, { ok: false }>): Executed {
	return reply.sent ? { kind: "failed", connectorCause: reply.cause, repair: "Check Notion authentication and the declared verification read; no write was sent" } : refused(reply.cause, REPAIR);
}
async function afterBaseline(write: Write, caller: Caller): Promise<{ ok: true; baseline: Baseline | null } | { ok: false; result: Executed }> {
	const call = fixedAfter(write);
	if (call === null) return { ok: true, baseline: null };
	const reply = await caller.call(call);
	if (!reply.ok) return { ok: false, result: readFailure(reply) };
	if (!distinguishes(write, reply.data)) return { ok: false, result: refused("already-present", "Select evidence that distinguishes the requested transition in the declared after read") };
	return { ok: true, baseline: baseline(reply.data) };
}
export async function previewWrite(write: Write, caller: Caller, journal: Journal | null, account: string): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", REPAIR);
	const identity = `notion-account:${account}`;
	const refusal = blocked(journal, identity);
	if (refusal) return refusal;
	const before = await caller.call(write.verify.before);
	if (!before.ok) return readFailure(before);
	if (!distinguishes(write, before.data)) return refused("already-present", "Select evidence absent before addition and present before removal");
	const after = await afterBaseline(write, caller);
	if (!after.ok) return after.result;
	const preview = journal.recordPreview({ operation: write.operation, objectIdentity: identity, inputDigest: write.digest, baseline: baseline(before.data), fixedAfterBaseline: after.baseline });
	return preview === null ? refused("journal-unavailable", REPAIR) : { kind: "recorded", effect: "write-preview", data: { operation: write.operation, previewId: preview.previewId, account, expiresAt: new Date(preview.expiresAt).toISOString() } };
}
function taskValue(data: unknown): Record<string, unknown> | null {
	const value = toolData(data);
	return record(value) ? record(value.async_task) ? value.async_task : value : null;
}
function taskId(data: unknown): string | null {
	const task = taskValue(data);
	if (task === null) return null;
	const id = task.task_id ?? (task.object === "async_task" || record(toolData(data)) && record((toolData(data) as Record<string, unknown>).async_task) ? task.id : null);
	return typeof id === "string" && id.length > 0 ? id : null;
}
type Task = { state: "pending" | "failed"; data: null } | { state: "succeeded"; data: unknown };
async function resolveTask(receipt: Receipt, caller: Caller): Promise<Task> {
	const reply = await caller.call({ tool: "notion-get-async-task", args: { task_id: receipt.taskId } });
	if (!reply.ok) return { state: "pending", data: null };
	const value = taskValue(reply.data);
	if (value?.status === "failed") return { state: "failed", data: null };
	return value?.status === "succeeded" ? { state: "succeeded", data: value.result ?? value } : { state: "pending", data: null };
}
function boundArguments(template: unknown, resolved: unknown): boolean {
	if (typeof template === "string" && template.startsWith("$reply.")) return replyReferenceAllowed(template, resolved);
	if (Array.isArray(template)) return Array.isArray(resolved) && template.length === resolved.length && template.every((item, index) => boundArguments(item, resolved[index]));
	if (record(template)) return record(resolved) && Object.keys(template).sort().join(",") === Object.keys(resolved).sort().join(",") && Object.entries(template).every(([key, item]) => boundArguments(item, resolved[key]));
	return template === resolved;
}
function boundReadBack(write: Write, call: NonNullable<Receipt["readBack"]>): boolean {
	return write.verify.after !== undefined && write.verify.after.tool === call.tool && boundArguments(write.verify.after.args, call.args);
}
async function evidence(write: Write, receipt: Receipt, caller: Caller): Promise<boolean> {
	if (receipt.taskState === "pending" || receipt.readBack === null || !boundReadBack(write, receipt.readBack)) return false;
	const reply = await caller.call(receipt.readBack);
	return reply.ok && matches(write, reply.data);
}
async function unchanged(write: Write, receipt: Receipt, caller: Caller): Promise<boolean> {
	if (receipt.taskState === "pending" || receipt.terminalFailure === null) return false;
	const before = await caller.call(write.verify.before);
	if (!before.ok || baseline(before.data).digest !== receipt.baseline.digest) return false;
	const after = fixedAfter(write);
	if (after === null) return true;
	if (receipt.fixedAfterBaseline === null) return false;
	const result = await caller.call(after);
	return result.ok && baseline(result.data).digest === receipt.fixedAfterBaseline.digest;
}
function save(journal: Journal, receipt: Receipt, status: Receipt["status"]): Receipt | null {
	return journal.settle(receipt, { status, replied: receipt.replied, effects: status === "completed" ? [{ kind: "notion-object", id: receipt.objectIdentity }] : [], readBack: receipt.readBack, taskId: receipt.taskId, taskState: receipt.taskState, terminalFailure: receipt.terminalFailure });
}
function unknownResult(receipt: Receipt, account: string, reply: unknown = null): Executed {
	return { kind: "effect-unknown", data: { runId: receipt.runId, receipt, reply }, repair: unknownRepair(account, receipt.runId) };
}
function unchangedResult(receipt: Receipt): Executed {
	return { kind: "failed-after-record", connectorCause: receipt.terminalFailure === "task-failed" ? "task-failed" : "provider-refused", data: { runId: receipt.runId, receipt }, repair: "The terminal provider failure and matching verification baselines prove unchanged; correct the input and preview again" };
}
function preparedHandle(write: Write, value: unknown): boolean {
	const data = toolData(value);
	if (!record(data)) return false;
	if (write.operation === "notion-create-attachment") return typeof data.markdown_source === "string" && /^file-upload:\/\/[^\s]+$/.test(data.markdown_source);
	let url: URL;
	try { url = new URL(String(data.upload_url)); } catch { return false; }
	const headers = record(data.upload_headers) && Object.values(data.upload_headers).every((header) => typeof header === "string");
	return url.protocol === "https:" && headers && (write.operation !== "notion-upload-skill" || typeof data.upload_token === "string" && data.upload_token.length > 0);
}
async function refreshTask(write: Write, receipt: Receipt, caller: Caller, journal: Journal): Promise<Receipt | null> {
	if (receipt.taskId === null || receipt.taskState === "failed" || receipt.taskState === "succeeded") return receipt;
	const task = await resolveTask(receipt, caller);
	if (task.state === "pending") return receipt;
	const next = { ...receipt, taskState: task.state, terminalFailure: task.state === "failed" ? "task-failed" as const : null, readBack: task.state === "succeeded" ? afterCall(write, task.data) : receipt.readBack };
	return save(journal, next, "unknown");
}
async function outcome(write: Write, receipt: Receipt, caller: Caller): Promise<Receipt["status"]> {
	if (await evidence(write, receipt, caller)) return "completed";
	return await unchanged(write, receipt, caller) ? "unchanged" : "unknown";
}
function sentReceipt(write: Write, receipt: Receipt, sent: Reply): Receipt {
	const id = taskId(sent.data);
	return { ...receipt, replied: sent.ok || sent.cause === "tool-error", taskId: id, taskState: id === null ? null : "pending", terminalFailure: !sent.ok && sent.cause === "tool-error" && id === null ? "tool-error" : null, readBack: afterCall(write, sent.data === undefined ? null : toolData(sent.data)) };
}
async function observedSettlement(write: Write, receipt: Receipt, caller: Caller, journal: Journal, account: string, reply: unknown): Promise<Executed> {
	const current = await refreshTask(write, receipt, caller, journal);
	if (current === null) return unknownResult(receipt, account);
	const final = save(journal, current, await outcome(write, current, caller));
	if (final === null) return unknownResult(current, account);
	if (final.status === "completed") return { kind: "applied", data: { runId: final.runId, receipt: final, reply } };
	return final.status === "unchanged" ? unchangedResult(final) : unknownResult(final, account, reply);
}
async function settle(write: Write, receipt: Receipt, sent: Reply, caller: Caller, journal: Journal, account: string): Promise<Executed> {
	// Only nonsecret task IDs and resolved verification arguments are durable.
	const recorded = save(journal, sentReceipt(write, receipt, sent), "unknown");
	if (recorded === null) return unknownResult(receipt, account);
	if (sent.ok && write.verify.reply === "prepared-handle" && preparedHandle(write, sent.data)) {
		const completed = save(journal, recorded, "completed");
		return completed ? { kind: "applied", data: { runId: completed.runId, receipt: completed, reply: sent.data, verifiedEffect: "prepared-handle" } } : unknownResult(recorded, account);
	}
	return observedSettlement(write, recorded, caller, journal, account, sent.ok ? sent.data : null);
}

function previewRefusal(write: Write, previewId: string, journal: Journal): Executed | null {
	const preview: Preview | null = journal.preview(previewId);
	if (preview === null || preview.operation !== write.operation) return refused("preview-unknown", retryPreview);
	if (preview.inputDigest !== write.digest) return refused("preview-input-mismatch", "Apply requires exactly the input, including _verify, that was previewed");
	if (journal.expired(preview)) return refused("preview-expired", retryPreview);
	if (journal.consumed(previewId)) return refused("preview-consumed", "This preview already applied once; inspect its receipt before further work");
	return null;
}

async function lockedApply(write: Write, previewId: string, caller: Caller, journal: Journal, account: string): Promise<Executed> {
	const refusal = blocked(journal, `notion-account:${account}`);
	if (refusal) return refusal;
	const preview = journal.preview(previewId);
	if (preview === null) return refused("preview-unknown", retryPreview);
	const before = await caller.call(write.verify.before);
	if (!before.ok) return readFailure(before);
	if (baseline(before.data).digest !== preview.baseline.digest) return refused("preview-stale", retryPreview);
	const after = fixedAfter(write);
	if (after !== null) {
		const observed = await caller.call(after);
		if (!observed.ok) return readFailure(observed);
		if (baseline(observed.data).digest !== preview.fixedAfterBaseline?.digest) return refused("preview-stale", retryPreview);
	}
	const ready = await caller.prepare({ tool: write.operation, args: write.args });
	if (!ready.ok) return refused(ready.cause, REPAIR);
	if (!journal.consume(previewId)) return refused("preview-consumed", retryPreview);
	const receipt = journal.begin(preview, preview.baseline);
	if (receipt === null) return refused("journal-unavailable", REPAIR);
	try { return await settle(write, receipt, ready.send(), caller, journal, account); }
	catch { const current = journal.receipt(receipt.runId) ?? receipt; const recorded = save(journal, current, "unknown"); return unknownResult(recorded ?? current, account); }
}

export async function applyWrite(write: Write, previewId: string, caller: Caller, journal: Journal | null, account: string): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", REPAIR);
	const refusal = previewRefusal(write, previewId, journal);
	if (refusal) return refusal;
	const identity = `notion-account:${account}`;
	if (!journal.lock(identity)) return refused("write-locked", "Another Notion apply holds this account; wait, or recover its lock once its process has exited");
	try { return await lockedApply(write, previewId, caller, journal, account); }
	finally { journal.release(identity); }
}

async function lockedAdjudicate(write: Write, receipt: Receipt, caller: Caller, journal: Journal): Promise<Executed> {
	const locked = journal.receipt(receipt.runId);
	if (locked === null) return JOURNAL_CORRUPT;
	if (locked.status !== "sending" && locked.status !== "unknown") return refused("receipt-settled", "This receipt is already settled");
	let current = await refreshTask(write, locked, caller, journal);
	if (current === null) return refused("journal-unavailable", REPAIR);
	if (current.readBack === null) current = { ...current, readBack: afterCall(write, null) };
	const status = await outcome(write, current, caller);
	if (status === "unknown") return refused(current.taskState === "pending" ? "task-pending" : "evidence-insufficient", "The requested effect or terminal unchanged evidence is unproved; keep the receipt open and never replay the write");
	const settled = save(journal, current, status);
	return settled === null ? refused("journal-unavailable", REPAIR) : { kind: "recorded", effect: "write-adjudication", data: { runId: settled.runId, receipt: settled } };
}
export async function adjudicate(write: Write, receipt: Receipt, caller: Caller, journal: Journal): Promise<Executed> {
	if (receipt.status !== "sending" && receipt.status !== "unknown") return refused("receipt-settled", "This receipt is already settled");
	if (receipt.inputDigest !== write.digest || receipt.operation !== write.operation) return refused("adjudicate-input-mismatch", "Use the identical input including _verify");
	// Re-read the receipt under the lock so sequential adjudicators cannot use stale state.
	if (!journal.lock(receipt.objectIdentity)) return refused("write-locked", "The account is locked; wait for its owner, or unlock after it exited");
	try { return await lockedAdjudicate(write, receipt, caller, journal); }
	finally { journal.release(receipt.objectIdentity); }
}

export function unlockWrite(journal: Journal, id: string): Executed {
	const value = id.startsWith("np-") ? journal.preview(id) : journal.receipt(id);
	if (value === null) return refused("run-unknown", "Inspect connectors recover notion for this account");
	const outcome = journal.unlock(value.objectIdentity);
	return outcome === "holder-alive" ? refused("holder-alive", "Wait for the owning process to exit") : outcome === "unlocked" ? { kind: "recorded", effect: "write-unlock", data: { id, unlocked: true } } : { kind: "success", data: { id, unlocked: false } };
}
