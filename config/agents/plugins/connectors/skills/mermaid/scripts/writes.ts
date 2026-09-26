// Mermaid's journaled writes: preview, apply, and recovery. A preview reads
// the object and records its baseline; nothing is sent. An apply sends only
// the previewed input, once: under the object lock it refuses a blocked or
// changed object, readies the call (route, Provider preflight, MCPorter), and
// only then consumes the preview, makes its receipt durable, sends, and reads
// back, so an interruption before the send leaves no receipt to adjudicate. The receipt completes only on found evidence: an update whose
// requested values are all present, or a create whose one new diagram in the
// project carries the requested title. A Provider refusal that left the
// object at its baseline is unchanged; anything else is unknown, never
// retried, and blocks the object until adjudication finds evidence.
import type { Executed } from "../../../bin/adapters/contract.ts";
import { objectIdentity, sha256, type WriteInput } from "./catalogue.ts";
import { type Diagram, diagramOf, diagramsOf } from "./diagrams.ts";
import type { Baseline, Journal, Receipt } from "./journal.ts";
import type { AccountCaller, CallResult, SentResult } from "./transport.ts";

const JOURNAL_REPAIR = "the Mermaid write journal could not be prepared; check that the Mermaid Connectors state directory is an owned, non-symlink directory";
const PREVIEW_AGAIN = "run connectors run mermaid <operation> --input <json> --preview again, then apply the new previewId with the identical input";
const recoverRun = (runId: string) => `connectors recover mermaid --run ${runId}`;
const UNKNOWN_REPAIR = (runId: string) => `Do not retry the write. Run ${recoverRun(runId)} to inspect it, then settle it with ${recoverRun(runId)} --adjudicate --input and the identical input`;

const refused = (connectorCause: string, repair: string): Executed => ({ kind: "refused", refusal: { kind: "domain", connectorCause, repair } });
// Fixed text: a receipt file's name is state-controlled, so it never reaches
// output.
export const JOURNAL_CORRUPT: Executed = refused("journal-corrupt", "a Mermaid write receipt is unreadable, malformed, or misnamed, so no write can prove its object is clear; restore it in the Mermaid journal's receipts directory as <runId>.json, an owner-only (0600) file holding its recorded JSON, then run connectors recover mermaid");

// A refusal when an open or unreadable receipt could hold an effect on this
// object; null when the object is clear.
function blockedRefusal(journal: Journal, identity: string): Executed | null {
	const blocking = journal.blocking(identity);
	if (!blocking.ok) return JOURNAL_CORRUPT;
	return blocking.receipt ? refused("object-blocked", `an earlier write to this object has an unresolved receipt; run ${recoverRun(blocking.receipt.runId)}`) : null;
}
const inputDigest = (write: WriteInput): string => sha256(JSON.stringify([write.operation, Object.entries(write.input).sort(([left], [right]) => left.localeCompare(right))]));
const contentDigest = (diagram: Diagram): string => sha256(JSON.stringify([diagram.title, diagram.code]));

type Observed = { ok: true; baseline: Baseline; diagrams: Diagram[] | null; current: Diagram | null } | { ok: false; result: Extract<CallResult, { ok: false }> | { ok: false; sent: true; cause: "readback-unrecognized" } };

// The object's current state: the diagram for an update, the project's
// diagrams for a create.
async function observe(write: WriteInput, caller: AccountCaller): Promise<Observed> {
	const { clientName } = write.input;
	if (write.operation === "update_mermaid_chart_diagram") {
		const read = await caller.call("get_mermaid_chart_diagram", { documentID: write.input.documentID, clientName });
		if (!read.ok) return { ok: false, result: read };
		const current = diagramOf(read.data);
		if (current === null || current.documentID !== write.input.documentID) return { ok: false, result: { ok: false, sent: true, cause: "readback-unrecognized" } };
		return { ok: true, baseline: { kind: "diagram", digest: contentDigest(current) }, diagrams: null, current };
	}
	const read = await caller.call("list_mermaid_chart_diagrams", { projectID: write.input.projectID, clientName });
	if (!read.ok) return { ok: false, result: read };
	const diagrams = diagramsOf(read.data);
	if (diagrams === null) return { ok: false, result: { ok: false, sent: true, cause: "readback-unrecognized" } };
	return { ok: true, baseline: { kind: "project", documentIDs: diagrams.map((diagram) => diagram.documentID).sort() }, diagrams, current: null };
}

// Every requested update value is present on the diagram.
function updateFound(write: Extract<WriteInput, { operation: "update_mermaid_chart_diagram" }>, current: Diagram): boolean {
	return (write.input.title === undefined || current.title === write.input.title) && (write.input.code === undefined || current.code === write.input.code);
}

// The one diagram outside the baseline carrying the requested title.
function createdIds(write: Extract<WriteInput, { operation: "create_mermaid_chart_diagram" }>, baseline: Baseline, diagrams: Diagram[]): string[] {
	const known = new Set(baseline.kind === "project" ? baseline.documentIDs : []);
	return diagrams.filter((diagram) => !known.has(diagram.documentID) && diagram.title === write.input.title).map((diagram) => diagram.documentID);
}

type Evidence = { proof: "completed"; id: string } | { proof: "baseline" } | { proof: "none" };

async function evidenceFor(write: WriteInput, baseline: Baseline, caller: AccountCaller): Promise<Evidence> {
	const observed = await observe(write, caller);
	if (!observed.ok) return { proof: "none" };
	if (write.operation === "update_mermaid_chart_diagram") {
		const current = observed.current as Diagram;
		if (updateFound(write, current)) return { proof: "completed", id: current.documentID };
		return baseline.kind === "diagram" && contentDigest(current) === baseline.digest ? { proof: "baseline" } : { proof: "none" };
	}
	const created = createdIds(write, baseline, observed.diagrams ?? []);
	if (created.length === 1 && created[0] !== undefined) return { proof: "completed", id: created[0] };
	return created.length === 0 && (observed.diagrams ?? []).every((diagram) => diagram.title !== write.input.title) ? { proof: "baseline" } : { proof: "none" };
}

function readFailure(result: Extract<Observed, { ok: false }>["result"]): Executed {
	if (!result.sent) return refused(result.cause, result.repair);
	return { kind: "failed", connectorCause: result.cause, repair: "The Mermaid account read did not complete; check the object IDs, then run the same command again" };
}

export async function previewWrite(write: WriteInput, caller: AccountCaller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const identity = objectIdentity(write);
	const blocked = blockedRefusal(journal, identity);
	if (blocked) return blocked;
	const observed = await observe(write, caller);
	if (!observed.ok) return readFailure(observed.result);
	if (write.operation === "update_mermaid_chart_diagram" && updateFound(write, observed.current as Diagram)) return refused("update-no-change", "the diagram already has every requested value; nothing to write");
	if (write.operation === "create_mermaid_chart_diagram" && (observed.diagrams ?? []).some((diagram) => diagram.title === write.input.title)) {
		return refused("title-exists", "the project already has a diagram with this title, so a created diagram could not be told apart; choose a distinct title");
	}
	const preview = journal.recordPreview({ operation: write.operation, objectIdentity: identity, inputDigest: inputDigest(write), baseline: observed.baseline });
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

// Settle a sent write from its read-back. A Provider refusal proves nothing
// was changed only when the object still stands at its baseline.
async function settleSent(write: WriteInput, receipt: Receipt, sent: SentResult, caller: AccountCaller, journal: Journal): Promise<Executed> {
	const replied = sent.ok || sent.cause !== "transport-failed";
	const evidence = await evidenceFor(write, receipt.baseline, caller);
	const data = (settled: Receipt | null) => ({ operation: write.operation, runId: receipt.runId, receipt: settled ?? receipt });
	if (evidence.proof === "completed") {
		const settled = journal.settle(receipt, { status: "completed", replied, effects: [{ kind: "mermaid-diagram", id: evidence.id }] });
		if (settled) return { kind: "applied", data: data(settled) };
	}
	if (evidence.proof === "baseline" && !sent.ok && sent.cause === "tool-error") {
		const settled = journal.settle(receipt, { status: "unchanged", replied, effects: [] });
		if (settled) return { kind: "failed-after-record", connectorCause: "provider-refused", data: data(settled), repair: "Mermaid refused the write and the object is unchanged; correct the input, then preview again" };
	}
	const settled = journal.settle(receipt, { status: "unknown", replied, effects: [] });
	return { kind: "effect-unknown", data: data(settled), repair: UNKNOWN_REPAIR(receipt.runId) };
}

async function lockedApply(write: WriteInput, previewId: string, caller: AccountCaller, journal: Journal, identity: string): Promise<Executed> {
	const blocked = blockedRefusal(journal, identity);
	if (blocked) return blocked;
	const preview = journal.preview(previewId);
	if (preview === null) return refused("preview-unknown", PREVIEW_AGAIN);
	const observed = await observe(write, caller);
	if (!observed.ok) return readFailure(observed.result);
	const stale = write.operation === "update_mermaid_chart_diagram" ? preview.baseline.kind !== "diagram" || preview.baseline.digest !== (observed.baseline as { digest: string }).digest : (observed.diagrams ?? []).some((diagram) => diagram.title === write.input.title);
	if (stale) return refused("preview-stale", `the object changed after the preview; ${PREVIEW_AGAIN}`);
	// Nothing can leave before send(): a refusal here keeps the preview.
	const ready = await caller.prepare(write.operation, write.input as unknown as Record<string, unknown>);
	if (!ready.ok) return refused(ready.cause, ready.repair);
	if (!journal.consume(previewId)) return refused("preview-consumed", `a preview applies at most once; ${PREVIEW_AGAIN}`);
	const receipt = journal.begin(preview, observed.baseline);
	if (receipt === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	return settleSent(write, receipt, ready.send(), caller, journal);
}

export async function applyWrite(write: WriteInput, previewId: string, caller: AccountCaller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const invalid = previewRefusal(journal, write, previewId);
	if (invalid) return invalid;
	const identity = objectIdentity(write);
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
	const record = id.startsWith("mp-") ? journal.preview(id) : journal.receipt(id);
	if (record === null) return refused("run-unknown", "Run connectors recover mermaid to list open receipts, or use the previewId a write-locked refusal named");
	const unlocked = journal.unlock(record.objectIdentity);
	if (unlocked === "holder-alive") return refused("holder-alive", "the lock's holder is still running; wait for it to exit");
	const data = id.startsWith("mp-") ? { previewId: id, unlocked: unlocked === "unlocked" } : { runId: id, unlocked: unlocked === "unlocked" };
	return unlocked === "unlocked" ? { kind: "recorded", effect: "write-unlock", data } : { kind: "success", data };
}

// Adjudication settles an open receipt only on found evidence: the
// requested effect, or, when the Provider had replied, the object still at
// its baseline. It never sends a write.
export async function adjudicate(receipt: Receipt, write: WriteInput | null, caller: AccountCaller, journal: Journal): Promise<Executed> {
	if (receipt.status !== "sending" && receipt.status !== "unknown") return refused("receipt-settled", "this receipt is already settled; nothing to adjudicate");
	if (write === null || write.operation !== receipt.operation || inputDigest(write) !== receipt.inputDigest) return refused("adjudicate-input-mismatch", "adjudication needs the identical --input the write recorded");
	const evidence = await evidenceFor(write, receipt.baseline, caller);
	if (evidence.proof === "completed") {
		const settled = journal.settle(receipt, { status: "completed", replied: receipt.replied, effects: [{ kind: "mermaid-diagram", id: evidence.id }] });
		if (settled) return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.runId, receipt: settled } };
	}
	if (evidence.proof === "baseline" && receipt.replied) {
		const settled = journal.settle(receipt, { status: "unchanged", replied: true, effects: [] });
		if (settled) return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.runId, receipt: settled } };
	}
	return refused("evidence-insufficient", "the read-back found neither the requested effect nor, for a request that may still have been in flight, proof of no effect; the receipt stays unresolved and its object stays blocked");
}
