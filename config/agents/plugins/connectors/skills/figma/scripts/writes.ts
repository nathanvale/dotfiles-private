// Figma's journaled writes: preview, apply, and recovery, following the
// Mermaid flow. A preview reads the object and records its baseline; nothing
// is sent. An apply sends only the previewed input, once: under the object
// lock it refuses a blocked or changed object, readies the call (route and
// MCPorter), and only then consumes the preview, makes its receipt durable,
// sends, and reads back. The receipt completes only on found evidence (see
// evidence.ts). A Provider refusal that left the object at its baseline is
// unchanged; anything else is unknown, never retried, and blocks the object
// until adjudication finds evidence.
//
// weave_run_tool spends Weave credits. Figma documents that a run without
// acknowledgedCost only quotes; a free tool, though, runs at once. Every run
// call is therefore a journaled apply. A quote reply whose run list is still
// at its baseline settles unchanged and records the quoted cost for that exact
// input; a later preview may carry acknowledgedCost only when it equals a
// fresh recorded quote, so no apply can acknowledge a cost Figma never quoted.
import type { Executed } from "../../../bin/adapters/contract.ts";
import { sendArgs, sha256, type WriteInput } from "./catalogue.ts";
import { baselineRefusal, costOf, type Evidence, evidenceFor, type Observed, observe, runIdsOf, statusOf } from "./evidence.ts";
import type { Baseline, Journal, Receipt } from "./journal.ts";
import type { Caller, SentResult } from "./transport.ts";

export const JOURNAL_REPAIR = "the Figma write journal could not be prepared; check that the Figma Connectors state directory is an owned, non-symlink directory";
export const PREVIEW_AGAIN = "run connectors run figma <operation> --input <json> --preview again, then apply the new previewId with the identical input";
export const recoverRun = (runId: string) => `connectors recover figma --run ${runId}`;
export const UNKNOWN_REPAIR = (runId: string) => `Do not retry the write. Run ${recoverRun(runId)} to inspect it, then settle it with ${recoverRun(runId)} --adjudicate --input and the identical input`;
const BASELINE_REPAIR: Readonly<Record<string, string>> = {
	"destination-unknown": "the authenticated account does not show the destination plan; run whoami and use one of its plan keys",
	"already-present": "the object already shows every requested value; nothing to write",
	"name-exists": "an object with this name already exists, so a created one could not be told apart; choose a distinct name",
	"runs-finished": "at least one named run has already finished; preview again with only runs that are still running",
};
const COST_REPAIR = "acknowledgedCost must equal a cost Figma quoted for this exact input in the last 15 minutes; apply the run without acknowledgedCost to get a quote, show Nathan the cost, and on his approval preview again with that cost";

export const refused = (connectorCause: string, repair: string): Executed => ({ kind: "refused", refusal: { kind: "domain", connectorCause, repair } });
export const JOURNAL_CORRUPT: Executed = refused("journal-corrupt", "a Figma write receipt is unreadable, malformed, or misnamed, so no write can prove its object is clear; restore it in the Figma journal's receipts directory as <runId>.json, an owner-only (0600) file holding its recorded JSON, then run connectors recover figma");

export function blockedRefusal(journal: Journal, identity: string): Executed | null {
	const blocking = journal.blocking(identity);
	if (!blocking.ok) return JOURNAL_CORRUPT;
	return blocking.receipt ? refused("object-blocked", `an earlier write to this object has an unresolved receipt; run ${recoverRun(blocking.receipt.runId)}`) : null;
}

export const digestOf = (operation: string, input: Record<string, unknown>): string => sha256(JSON.stringify([operation, Object.entries(input).sort(([left], [right]) => left.localeCompare(right))]));
const inputDigest = (write: WriteInput): string => digestOf(write.operation, { ...write.input });
// The run input a quote applies to: everything but the acknowledgement.
const quoteKey = (write: WriteInput): string => digestOf(write.operation, Object.fromEntries(Object.entries(write.input).filter(([key]) => key !== "acknowledgedCost")));

export function readFailure(result: Extract<Observed, { ok: false }>["result"]): Executed {
	if (!result.sent) return refused(result.cause, result.repair);
	return { kind: "failed", connectorCause: result.cause, repair: "The Figma read did not complete; check the input against connectors schema figma, then run the same command again" };
}

function costRefusal(write: WriteInput, journal: Journal): Executed | null {
	if (write.operation !== "weave_run_tool" || write.input.acknowledgedCost === undefined) return null;
	return journal.quote(quoteKey(write)) === write.input.acknowledgedCost ? null : refused("cost-not-quoted", COST_REPAIR);
}

export async function previewWrite(write: WriteInput, caller: Caller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const identity = write.spec.identity(write.input);
	const blocked = blockedRefusal(journal, identity) ?? costRefusal(write, journal);
	if (blocked) return blocked;
	const observed = await observe(write.spec.observe(write.input), caller);
	if (!observed.ok) return readFailure(observed.result);
	const clash = baselineRefusal(write, observed.observation);
	if (clash) return refused(clash, BASELINE_REPAIR[clash] as string);
	const preview = journal.recordPreview({ operation: write.operation, objectIdentity: identity, inputDigest: inputDigest(write), baseline: observed.observation.baseline });
	if (preview === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	return { kind: "recorded", effect: "write-preview", data: { operation: write.operation, previewId: preview.previewId, objectIdentity: identity, expiresAt: new Date(preview.expiresAt).toISOString() } };
}

function previewRefusal(journal: Journal, write: WriteInput, previewId: string): Executed | null {
	const preview = journal.preview(previewId);
	if (preview === null || preview.operation !== write.operation) return refused("preview-unknown", PREVIEW_AGAIN);
	if (preview.inputDigest !== inputDigest(write)) return refused("preview-input-mismatch", `apply needs the identical --input the preview recorded; ${PREVIEW_AGAIN}`);
	if (journal.expired(preview)) return refused("preview-expired", PREVIEW_AGAIN);
	if (journal.consumed(previewId)) return refused("preview-consumed", `a preview applies at most once; ${PREVIEW_AGAIN}`);
	return null;
}

const QUOTES = new Set(["cost_confirmation_required", "inputs_required"]);

// A Weave quote: the reply ran nothing, names no run, and the run list still
// stands at its baseline.
async function settleQuote(write: WriteInput, receipt: Receipt, reply: unknown, caller: Caller, journal: Journal): Promise<Executed | null> {
	const status = statusOf(reply).find((value) => QUOTES.has(value));
	if (write.operation !== "weave_run_tool" || status === undefined || runIdsOf(reply).length > 0) return null;
	const evidence = await evidenceFor(write, receipt.baseline, null, caller);
	if (evidence.proof !== "baseline") return null;
	const settled = journal.settle(receipt, { status: "unchanged", replied: true, effects: [] });
	if (settled === null) return null;
	const cost = costOf(reply);
	if (status === "cost_confirmation_required" && cost !== null) journal.recordQuote(quoteKey(write), cost);
	const data = { operation: write.operation, runId: receipt.runId, receipt: settled, quote: { status, cost }, reply };
	const repair = status === "inputs_required" ? "Weave needs more inputs; read the reply, set them, and preview again" : "Weave quoted this cost and spent nothing; show Nathan the cost, and only on his explicit approval preview again with acknowledgedCost set to it";
	return { kind: "failed-after-record", connectorCause: status === "inputs_required" ? "inputs-required" : "cost-confirmation-required", data, repair };
}

function settleFrom(write: WriteInput, receipt: Receipt, evidence: Evidence, sent: SentResult, journal: Journal): Executed {
	const replied = sent.ok || sent.cause !== "transport-failed";
	const data = (settled: Receipt | null) => ({ operation: write.operation, runId: receipt.runId, receipt: settled ?? receipt, ...(sent.ok ? { reply: sent.data } : {}) });
	if (evidence.proof === "completed") {
		const settled = journal.settle(receipt, { status: "completed", replied, effects: evidence.ids.map((id) => ({ kind: "figma-object" as const, id })) });
		if (settled) return { kind: "applied", data: data(settled) };
	}
	if (evidence.proof === "baseline" && !sent.ok && sent.cause === "tool-error") {
		const settled = journal.settle(receipt, { status: "unchanged", replied, effects: [] });
		if (settled) return { kind: "failed-after-record", connectorCause: "provider-refused", data: data(settled), repair: "Figma refused the write and the object is unchanged; correct the input, then preview again" };
	}
	const settled = journal.settle(receipt, { status: "unknown", replied, effects: [] });
	return { kind: "effect-unknown", data: data(settled), repair: UNKNOWN_REPAIR(receipt.runId) };
}

async function settleSent(write: WriteInput, receipt: Receipt, sent: SentResult, caller: Caller, journal: Journal): Promise<Executed> {
	if (sent.ok) {
		const quoted = await settleQuote(write, receipt, sent.data, caller, journal);
		if (quoted) return quoted;
	}
	const evidence = await evidenceFor(write, receipt.baseline, sent.ok ? sent.data : null, caller);
	return settleFrom(write, receipt, evidence, sent, journal);
}

const stale = (preview: Baseline, current: Baseline): boolean => preview.digest !== current.digest;

async function lockedApply(write: WriteInput, previewId: string, caller: Caller, journal: Journal, identity: string): Promise<Executed> {
	const blocked = blockedRefusal(journal, identity) ?? costRefusal(write, journal);
	if (blocked) return blocked;
	const preview = journal.preview(previewId);
	if (preview === null) return refused("preview-unknown", PREVIEW_AGAIN);
	const observed = await observe(write.spec.observe(write.input), caller);
	if (!observed.ok) return readFailure(observed.result);
	if (stale(preview.baseline, observed.observation.baseline)) return refused("preview-stale", `the object changed after the preview; ${PREVIEW_AGAIN}`);
	// Nothing can leave before send(): a refusal here keeps the preview.
	const ready = await caller.prepare({ tool: write.operation, args: sendArgs(write) });
	if (!ready.ok) return refused(ready.cause, ready.repair);
	if (write.operation === "weave_run_tool" && write.input.acknowledgedCost !== undefined && !journal.consumeQuote(quoteKey(write))) return refused("journal-unavailable", JOURNAL_REPAIR);
	if (!journal.consume(previewId)) return refused("preview-consumed", `a preview applies at most once; ${PREVIEW_AGAIN}`);
	const receipt = journal.begin(preview, observed.observation.baseline);
	if (receipt === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	return settleSent(write, receipt, ready.send(), caller, journal);
}

export async function applyWrite(write: WriteInput, previewId: string, caller: Caller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const invalid = previewRefusal(journal, write, previewId);
	if (invalid) return invalid;
	const identity = write.spec.identity(write.input);
	if (!journal.lock(identity)) return refused("write-locked", `another apply holds this object's lock; if no apply is running, release it with ${recoverRun(previewId)} --unlock, then apply again`);
	try {
		return await lockedApply(write, previewId, caller, journal, identity);
	} finally {
		journal.release(identity);
	}
}

// Operator lock recovery through a receipt or, when an apply died before its
// receipt existed, through its preview. A lock goes only once its holder has
// exited.
export function unlockWrite(journal: Journal, id: string): Executed {
	const record = id.startsWith("fp-") ? journal.preview(id) : journal.receipt(id);
	if (record === null) return refused("run-unknown", "Run connectors recover figma to list open receipts, or use the previewId a write-locked refusal named");
	const unlocked = journal.unlock(record.objectIdentity);
	if (unlocked === "holder-alive") return refused("holder-alive", "the lock's holder is still running; wait for it to exit");
	const data = id.startsWith("fp-") ? { previewId: id, unlocked: unlocked === "unlocked" } : { runId: id, unlocked: unlocked === "unlocked" };
	return unlocked === "unlocked" ? { kind: "recorded", effect: "write-unlock", data } : { kind: "success", data };
}

// Adjudication settles an open receipt only on found evidence: the requested
// effect, or, when Figma had replied, the object still at its baseline. It
// never sends a write.
export async function adjudicate(receipt: Receipt, write: WriteInput | null, caller: Caller, journal: Journal): Promise<Executed> {
	if (receipt.status !== "sending" && receipt.status !== "unknown") return refused("receipt-settled", "this receipt is already settled; nothing to adjudicate");
	if (write === null || write.operation !== receipt.operation || inputDigest(write) !== receipt.inputDigest) return refused("adjudicate-input-mismatch", "adjudication needs the identical --input the write recorded");
	const evidence = await evidenceFor(write, receipt.baseline, null, caller);
	if (evidence.proof === "completed") {
		const settled = journal.settle(receipt, { status: "completed", replied: receipt.replied, effects: evidence.ids.map((id) => ({ kind: "figma-object" as const, id })) });
		if (settled) return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.runId, receipt: settled } };
	}
	if (evidence.proof === "baseline" && receipt.replied) {
		const settled = journal.settle(receipt, { status: "unchanged", replied: true, effects: [] });
		if (settled) return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.runId, receipt: settled } };
	}
	return refused("evidence-insufficient", "the read-back found neither the requested effect nor, for a request that may still have been in flight, proof of no effect; the receipt stays unresolved and its object stays blocked");
}
