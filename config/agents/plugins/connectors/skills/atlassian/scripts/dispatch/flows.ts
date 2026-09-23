// Dispatch flows: one Route per product with live schema confirmation in
// front of every call; the read flow; the journaled write flow (preview,
// apply); and the operator flows (receipts, receipt, adjudicate, unlock). Each
// flow returns an Outcome that the CLI renders into one envelope. Provider
// text never crosses the transport seam; the outcomes carry fixed text and
// identifiers only.
import type { BindResult, CredentialBinding } from "../custody/index.ts";
import { type CauseCode, OPERATION_SPECS, type OperationSpec, type Product, PROVIDER, type Provenance, serverFor, type TransactionState } from "./contract.ts";
import { confirmSchema, type Dependencies, type Input, providerArguments, REPAIR_TEXT, readSchema, type SchemaTool, type TransportFailure, type TransportResult } from "./engine.ts";
import { canonicalDigest, type Effect, type Evidence, JournalError, type Receipt, type WriteOperation } from "./journal.ts";
import { baselineFromReply, effectKindOf, effectsFromReply, isObjectDelete, observeIssue, observePage, type PreparedContext, preparation, readBackEvidence, readBackPlan, type ReadBack, type RevisionMatch, transitionTo, uploadFailed, type WriteInput, writeArguments, writeInput } from "./writes.ts";

export interface Outcome {
	cause: CauseCode;
	data: unknown;
	detail: string | null;
	transactionState: TransactionState;
	effects: string[];
	uncertain: string[];
}

export interface Attempt {
	cause: CauseCode;
	data: unknown;
	detail: string | null;
}

const refusal = (cause: CauseCode, detail: string | null = REPAIR_TEXT[cause as Exclude<CauseCode, "success">] ?? null): Outcome => ({ cause, data: null, detail, transactionState: "unchanged", effects: [], uncertain: [] });
const success = (data: unknown): Outcome => ({ cause: "success", data, detail: null, transactionState: "unchanged", effects: [], uncertain: [] });
const failed = (attempt: Attempt): Outcome => ({ cause: attempt.cause, data: null, detail: attempt.detail, transactionState: "unchanged", effects: [], uncertain: [] });
const effectId = (effect: Effect) => `${effect.kind}:${effect.id}`;

export class Session {
	readonly provenance: Provenance[] = [];
	private readonly bindings = new Map<Product, Promise<BindResult>>();
	constructor(
		readonly deps: Dependencies,
		readonly tenant: string,
	) {}

	// One custody read per product per session: the nonsecret binding with the
	// trusted site origin, or a closed refusal cause with fixed detail.
	binding(product: Product): Promise<BindResult> {
		let bound = this.bindings.get(product);
		if (!bound) {
			bound = this.deps.bindCredential(this.tenant, product);
			this.bindings.set(product, bound);
		}
		return bound;
	}

	route(product: Product, binding: CredentialBinding): Route {
		return new Route(this, product, binding);
	}
}

// One product route for one call sequence: lists the live schema once and
// confirms every tool against it before the tool is called.
export class Route {
	readonly server: string;
	private tools: SchemaTool[] | undefined;

	constructor(
		private readonly session: Session,
		readonly product: Product,
		private readonly binding: CredentialBinding,
	) {
		this.server = serverFor(product);
	}

	// The transport already translated the failure; this records provenance
	// and attaches the fixed repair text plus the fixed hint, if any.
	private failure(tool: string, failure: TransportFailure): Attempt {
		this.session.provenance.push({ provider: this.server, tool, status: failure.cause });
		return { cause: failure.cause, data: null, detail: failure.hint ? `${REPAIR_TEXT[failure.cause]}; ${failure.hint}` : REPAIR_TEXT[failure.cause] };
	}

	private unavailable(): Attempt {
		return { cause: "capability-unavailable", data: null, detail: REPAIR_TEXT["capability-unavailable"] };
	}

	// Live schema, once per route. The first tool the caller intends to use is
	// confirmed against the schema before anything else, so an unusable route
	// makes no call at all.
	async ready(intent?: { tool: string; args: Record<string, unknown> }): Promise<Attempt | null> {
		if (this.tools) return null;
		const listed = await this.session.deps.transport.listTools(this.binding, this.server);
		if (!listed.ok) return this.failure("list", listed);
		const tools = readSchema(listed);
		if (!tools) return this.unavailable();
		this.tools = tools;
		if (intent && !confirmSchema(tools, intent.tool, intent.args).ok) return this.unavailable();
		return null;
	}

	confirm(tool: string, args: Record<string, unknown>): Attempt | null {
		return this.tools && confirmSchema(this.tools, tool, args).ok ? null : this.unavailable();
	}

	// A transport that throws is an internal fault of the adapter; it becomes a
	// fixed outcome and the thrown text is never carried outward.
	private async transportCall(tool: string, args: Record<string, unknown>): Promise<Attempt> {
		let result: TransportResult;
		try {
			result = await this.session.deps.transport.call(this.binding, this.server, tool, args);
		} catch {
			this.session.provenance.push({ provider: this.server, tool, status: "failed-unknown" });
			return { cause: "failed-unknown", data: null, detail: REPAIR_TEXT["failed-unknown"] };
		}
		if (!result.ok) return this.failure(tool, result);
		this.session.provenance.push({ provider: this.server, tool, status: "success" });
		return { cause: "success", data: result.data, detail: null };
	}

	async call(tool: string, args: Record<string, unknown>): Promise<Attempt> {
		return this.confirm(tool, args) ?? this.transportCall(tool, args);
	}
}

// One attempt on the product route. Any failure is final: there is no other
// Provider to fall over to, and the cause says why this one failed.
export async function readFlow(session: Session, spec: OperationSpec, input: Input): Promise<Outcome> {
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const route = session.route(spec.product, bound.binding);
	const args = providerArguments(spec, input);
	const attempt = (await route.ready({ tool: spec.tool, args })) ?? (await route.call(spec.tool, args));
	return attempt.cause === "success" ? success(attempt.data) : failed(attempt);
}

type Prepared = { ctx: PreparedContext } | { outcome: Outcome };

// One preparatory Jira read that must name the requested issue.
async function readIssue(route: Route, issueKey: string, args: Record<string, unknown>): Promise<{ issue: ReturnType<typeof observeIssue> } | { outcome: Outcome }> {
	const read = await route.call("jira_get_issue", { issue_key: issueKey, ...args });
	if (read.cause !== "success") return { outcome: failed(read) };
	const issue = observeIssue(read.data);
	if (issue.key === undefined) return { outcome: refusal("capability-unavailable", "the preparatory Jira read names no issue key") };
	if (issue.key !== issueKey) return { outcome: refusal("capability-unavailable", "the preparatory Jira read names a different issue") };
	return { issue };
}

// Jira exposes no monotonic issue revision; the `updated` timestamp binds the
// issue between preview and apply so a moved issue refuses the apply.
async function prepareIssue(route: Route, ctx: PreparedContext, issueKey: string): Promise<Prepared> {
	const read = await readIssue(route, issueKey, { fields: "summary,updated" });
	if ("outcome" in read) return read;
	if (read.issue.revision === null) return { outcome: refusal("capability-unavailable", "the Jira reply exposes no revision or updated timestamp") };
	return { ctx: { ...ctx, revision: read.issue.revision } };
}

// The issue's `updated` binds it; the transition id is resolved live from the
// transitions the site currently allows, by the status it leads to.
async function prepareTransition(route: Route, ctx: PreparedContext, issueKey: string, toStatus: string): Promise<Prepared> {
	const read = await readIssue(route, issueKey, { fields: "status,updated" });
	if ("outcome" in read) return read;
	if (read.issue.revision === null) return { outcome: refusal("capability-unavailable", "the Jira reply exposes no revision or updated timestamp") };
	const listed = await route.call("jira_get_transitions", { issue_key: issueKey });
	if (listed.cause !== "success") return { outcome: failed(listed) };
	const transitionId = transitionTo(listed.data, toStatus);
	if (transitionId === undefined) return { outcome: refusal("not-found", "no transition available to this principal leads to that status") };
	return { ctx: { ...ctx, revision: read.issue.revision, transitionId } };
}

// The comment's own `updated` timestamp binds it between preview and apply.
async function prepareComment(route: Route, ctx: PreparedContext, issueKey: string, commentId: string): Promise<Prepared> {
	const read = await readIssue(route, issueKey, { fields: "comment,updated", comment_limit: 100 });
	if ("outcome" in read) return read;
	const comment = read.issue.comments.find((entry) => entry.id === commentId);
	if (comment === undefined) return { outcome: refusal("not-found", "the issue has no comment with that id among its first 100 comments") };
	if (comment.updated === undefined) return { outcome: refusal("capability-unavailable", "the comment read exposes no updated timestamp to bind the revision") };
	return { ctx: { ...ctx, revision: comment.updated } };
}

// The page version is the revision; the current title is kept for an update
// that omits one.
async function preparePage(route: Route, ctx: PreparedContext, pageId: string): Promise<Prepared> {
	const read = await route.call("confluence_get_page", { page_id: pageId, include_metadata: true });
	if (read.cause !== "success") return { outcome: failed(read) };
	const page = observePage(read.data);
	if (page.id === undefined) return { outcome: refusal("capability-unavailable", "the preparatory page read names no page id") };
	if (page.id !== pageId) return { outcome: refusal("capability-unavailable", "the preparatory page read names a different page") };
	if (page.version === null) return { outcome: refusal("capability-unavailable", "the page read exposed no version to bind the revision") };
	const prepared: PreparedContext = { ...ctx, revision: page.version };
	if (page.title !== undefined) prepared.currentTitle = page.title;
	return { ctx: prepared };
}

async function bindBaseline(route: Route, operation: WriteOperation, input: WriteInput, ctx: PreparedContext): Promise<Prepared> {
	const plan = readBackPlan(operation, input);
	const read = await route.call(plan.tool, plan.args);
	if (read.cause !== "success") return { outcome: failed(read) };
	const observed = baselineFromReply(operation, input, read.data);
	if (observed.kind === "refused") return { outcome: refusal("input-invalid", observed.reason) };
	if (observed.kind === "indeterminate") return { outcome: refusal("capability-unavailable", `${observed.reason}; live qualification is required`) };
	return { ctx: { ...ctx, baseline: observed.baseline } };
}

// Preparatory reads before a write: the target's current revision, then
// baseline identifiers that make a later read-back temporal rather than
// merely textual.
async function prepare(route: Route, operation: WriteOperation, input: WriteInput): Promise<Prepared> {
	const step = preparation(operation, input);
	const ctx: PreparedContext = { revision: null, baseline: { effectIds: [], commentIds: [], revision: null } };
	let prepared: Prepared;
	switch (step.kind) {
		case "none":
			prepared = { ctx };
			break;
		case "issue":
			prepared = await prepareIssue(route, ctx, step.issueKey);
			break;
		case "comment":
			prepared = await prepareComment(route, ctx, step.issueKey, step.commentId);
			break;
		case "transition":
			prepared = await prepareTransition(route, ctx, step.issueKey, step.toStatus);
			break;
		case "page":
			prepared = await preparePage(route, ctx, step.pageId);
			break;
	}
	if ("outcome" in prepared) return prepared;
	return bindBaseline(route, operation, input, prepared.ctx);
}

const JOURNAL_CAUSES: Record<string, Exclude<CauseCode, "success">> = {
	"preview-unknown": "refused-preview",
	"preview-consumed": "refused-preview",
	"preview-expired": "refused-preview",
	"preview-provider-retired": "refused-preview",
	"preview-input-mismatch": "refused-preview",
	"preview-args-mismatch": "refused-preview",
	"preview-revision-changed": "refused-preview",
	"preview-baseline-changed": "refused-preview",
	"preview-instructions-changed": "refused-preview",
	"write-blocked-open-receipt": "refused-write-blocked",
	"write-locked": "refused-write-blocked",
	"lock-held": "refused-write-blocked",
	"receipt-unknown": "refused-preview",
	"receipt-already-resolved": "refused-evidence",
	"receipt-provider-retired": "refused-state",
	"receipt-in-flight": "refused-write-blocked",
	"evidence-insufficient": "refused-evidence",
	"evidence-invalid": "refused-evidence",
	"input-invalid": "input-invalid",
};

function journalRefusal(error: unknown): Outcome {
	if (!(error instanceof JournalError)) throw error;
	const cause = JOURNAL_CAUSES[error.code] ?? "refused-state";
	return refusal(cause, `${REPAIR_TEXT[cause]}; ${error.code}`);
}

interface WriteContext {
	route: Route;
	spec: OperationSpec;
	input: WriteInput;
	ctx: PreparedContext;
	bound: Record<string, unknown>;
}

// Shared front half of preview and apply: readiness, preparation, argument
// shaping, and schema confirmation of the shaped arguments.
async function writeContext(session: Session, spec: OperationSpec, input: WriteInput): Promise<WriteContext | Outcome> {
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const route = session.route(spec.product, bound.binding);
	const placeholder: PreparedContext = { revision: null, baseline: { effectIds: [], commentIds: [], revision: null }, currentTitle: "pending", transitionId: "pending" };
	const ready = await route.ready({ tool: spec.tool, args: writeArguments(spec, input, placeholder).args });
	if (ready) return failed(ready);
	const prepared = await prepare(route, spec.id as WriteOperation, input);
	if ("outcome" in prepared) return prepared.outcome;
	if (typeof input.file === "string") {
		const staged = session.deps.stage(session.tenant, input.file);
		if (!staged.ok) return staged.reason === "file-unreadable" ? refusal("input-invalid", "input key file names no readable regular file") : refusal("refused-state", `${REPAIR_TEXT["refused-state"]}; outbox-unavailable`);
		prepared.ctx.stagedFile = staged.relative;
	}
	const shaped = writeArguments(spec, input, prepared.ctx);
	const shape = route.confirm(spec.tool, shaped.args);
	if (shape) return failed(shape);
	return { route, spec, input, ctx: prepared.ctx, bound: shaped.bound };
}

export async function previewFlow(session: Session, spec: OperationSpec, input: WriteInput): Promise<Outcome> {
	const context = await writeContext(session, spec, input);
	if ("cause" in context) return context;
	try {
		const preview = session.deps.journal(session.tenant).recordPreview({
			operation: spec.id as WriteOperation,
			provider: PROVIDER,
			canonicalInput: context.input,
			providerArgs: context.bound,
			revision: context.ctx.revision,
			baseline: context.ctx.baseline,
		});
		return success({
			previewId: preview.previewId,
			operation: preview.operation,
			provider: preview.provider,
			server: context.route.server,
			tool: context.spec.tool,
			objectIdentity: preview.objectIdentity,
			revision: context.ctx.revision,
			baseline: context.ctx.baseline,
			expiresAt: preview.expiresAt,
			input: context.input,
			arguments: context.bound,
		});
	} catch (error) {
		return journalRefusal(error);
	}
}

// A reply proves a create, comment, or attachment only with an identifier
// outside the preview baseline; updates and deletes are always read back.
function replyEffectIsNew(operation: WriteOperation, id: string, context: WriteContext): boolean {
	if (operation.endsWith(".comment")) return !context.ctx.baseline.commentIds.includes(id);
	if (operation.endsWith(".create") || operation.endsWith(".attach")) return !context.ctx.baseline.effectIds.includes(id);
	return false;
}

// Evidence from the provider reply, else from an immediate read-back.
async function settleEvidence(context: WriteContext, attempt: Attempt): Promise<Evidence> {
	const operation = context.spec.id as WriteOperation;
	if (attempt.cause === "success") {
		const effects = effectsFromReply(operation, context.input, attempt.data);
		if (effects.length > 0 && effects.every((effect) => replyEffectIsNew(operation, effect.id, context))) return { proof: "completed", effects };
	}
	const revisionMatches: RevisionMatch = (observed) => context.ctx.revision !== null && observed === context.ctx.revision;
	const readBack = await readBackFor(context.route, operation, context.input, revisionMatches, context.ctx.baseline);
	if (readBack.kind === "found") return { proof: "completed", effects: readBack.effects };
	if (readBack.kind === "absent") return { proof: "unchanged", basis: readBack.revisionUnchanged ? "revision-unchanged" : "readback-absent" };
	return { proof: "unknown" };
}

// A delete is proven by the Provider refusing to find the object afterwards;
// any other read-back failure proves nothing.
async function readBackFor(route: Route, operation: WriteOperation, input: WriteInput, revisionMatches: RevisionMatch, baseline: PreparedContext["baseline"]): Promise<ReadBack> {
	const plan = readBackPlan(operation, input);
	const read = await route.call(plan.tool, plan.args);
	if (read.cause === "not-found" && isObjectDelete(operation)) {
		return { kind: "found", effects: [{ kind: effectKindOf(operation), id: (operation === "issue.delete" ? input.issueKey : input.pageId) as string }] };
	}
	if (read.cause !== "success") return { kind: "indeterminate", reason: read.cause };
	return readBackEvidence(operation, input, revisionMatches, read.data, baseline);
}

function receiptOutcome(receipt: Receipt, attempt: Attempt | null): Outcome {
	const base = { runId: receipt.runId, previewId: receipt.previewId, operation: receipt.operation, provider: receipt.provider, objectIdentity: receipt.objectIdentity, status: receipt.status, send: receipt.send, effects: receipt.effects };
	switch (receipt.status) {
		case "completed":
			return { cause: "success", data: { ...base, reply: attempt?.data ?? null }, detail: null, transactionState: "completed", effects: receipt.effects.map(effectId), uncertain: [] };
		case "unchanged": {
			const cause: Exclude<CauseCode, "success"> = attempt && attempt.cause !== "success" ? attempt.cause : "failed-unknown";
			const detail = attempt?.cause === "success" && uploadFailed(attempt.data) ? `${REPAIR_TEXT[cause]}; the Provider reported the upload failed: check the file path and the Create Attachments permission` : (attempt?.detail ?? REPAIR_TEXT[cause]);
			return { cause, data: base, detail, transactionState: "unchanged", effects: [], uncertain: [] };
		}
		default:
			return { cause: "outcome-unknown", data: base, detail: REPAIR_TEXT["outcome-unknown"], transactionState: "unknown", effects: [], uncertain: [receipt.objectIdentity] };
	}
}

export async function applyFlow(session: Session, spec: OperationSpec, input: WriteInput, previewId: string): Promise<Outcome> {
	// A preview recorded for a Provider this route no longer has is refused
	// before any binding or provider call: `writeContext` below binds
	// credentials, lists the live schema, and runs preparatory reads, none of
	// which a retired preview may cause. `recordIntent` re-checks the same
	// condition under the object lock as the atomic, authoritative guard.
	try {
		const recorded = session.deps.journal(session.tenant).preview(previewId);
		if (recorded.provider !== PROVIDER) throw new JournalError("preview-provider-retired", "the preview was recorded for a Provider this route no longer has; preview again");
	} catch (error) {
		return journalRefusal(error);
	}
	const context = await writeContext(session, spec, input);
	if ("cause" in context) return context;
	let attempt: Attempt | null = null;
	try {
		const receipt = await session.deps.journal(session.tenant).apply(
			{ previewId, provider: PROVIDER, canonicalInput: context.input, providerArgs: context.bound, revision: context.ctx.revision, baseline: context.ctx.baseline },
			async (_intent, sending, boundArgs) => {
				const shape = context.route.confirm(context.spec.tool, boundArgs);
				if (shape) {
					attempt = shape;
					return { proof: "unchanged", basis: "readback-absent" };
				}
				sending();
				attempt = await context.route.call(context.spec.tool, boundArgs);
				return settleEvidence(context, attempt);
			},
		);
		return receiptOutcome(receipt, attempt);
	} catch (error) {
		return journalRefusal(error);
	}
}

export function receiptsFlow(session: Session): Outcome {
	try {
		return success({ open: session.deps.journal(session.tenant).openReceipts() });
	} catch (error) {
		return journalRefusal(error);
	}
}

export function receiptFlow(session: Session, runId: string): Outcome {
	try {
		return success(session.deps.journal(session.tenant).receipt(runId));
	} catch (error) {
		return journalRefusal(error);
	}
}

// Operator lock recovery through a receipt or its preview. A record from a
// retired Provider is refused here as everywhere else: its object stays
// blocked until an operator resolves it by hand, never through this route.
export function unlockFlow(session: Session, runId: string): Outcome {
	try {
		const journal = session.deps.journal(session.tenant);
		try {
			const receipt = journal.receipt(runId);
			if (receipt.provider !== PROVIDER) return refusal("refused-state", `${REPAIR_TEXT["refused-state"]}; receipt-provider-retired`);
			journal.unlock(receipt.objectIdentity);
			return success({ runId, objectIdentity: receipt.objectIdentity, unlocked: true });
		} catch (error) {
			if (!(error instanceof JournalError) || error.code !== "receipt-unknown") throw error;
			const preview = journal.preview(runId);
			if (preview.provider !== PROVIDER) return refusal("refused-preview", `${REPAIR_TEXT["refused-preview"]}; preview-provider-retired`);
			journal.unlock(preview.objectIdentity);
			return success({ previewId: preview.previewId, objectIdentity: preview.objectIdentity, unlocked: true });
		}
	} catch (error) {
		return journalRefusal(error);
	}
}

function canonicalAdjudicationInput(receipt: Receipt, rawInput: unknown): WriteInput | Outcome {
	const validated = writeInput(receipt.operation, rawInput);
	if (!validated.ok) return refusal("input-invalid", validated.reason);
	return canonicalDigest(validated.input) === receipt.inputDigest ? validated.input : refusal("input-invalid", "the supplied input is not the input this receipt was recorded from");
}

function isOutcome(value: WriteInput | Outcome): value is Outcome {
	return "cause" in value && "transactionState" in value;
}

// Operator adjudication: read the object back through the receipt's own
// Provider and resolve only on evidence. A receipt recorded through a retired
// Provider has no route to read back through and is refused before any call;
// it stays open and keeps its object blocked. Read-back absence releases an
// object only when the receipt never reached the send mark or a monotonic
// revision proves nothing landed; otherwise the receipt stays open and the
// outcome says so.
export async function adjudicateFlow(session: Session, runId: string, rawInput: unknown): Promise<Outcome> {
	const journal = session.deps.journal(session.tenant);
	let receipt: Receipt;
	try {
		receipt = journal.receipt(runId);
	} catch (error) {
		return journalRefusal(error);
	}
	if (receipt.status === "completed" || receipt.status === "unchanged") return refusal("refused-evidence", `${REPAIR_TEXT["refused-evidence"]}; receipt-already-resolved`);
	if (receipt.provider !== PROVIDER) return refusal("refused-state", `${REPAIR_TEXT["refused-state"]}; receipt-provider-retired`);
	const spec = OPERATION_SPECS[receipt.operation];
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const route = session.route(spec.product, bound.binding);
	const ready = await route.ready();
	if (ready) return failed(ready);
	const canonical = canonicalAdjudicationInput(receipt, rawInput);
	if (isOutcome(canonical)) return canonical;
	const digestOf = (observed: string) => new Bun.CryptoHasher("sha256").update(observed).digest("hex");
	const readBack = await readBackFor(route, receipt.operation, canonical, (observed) => receipt.revisionDigest !== null && digestOf(observed) === receipt.revisionDigest, receipt.baseline);
	if (readBack.kind === "indeterminate") return refusal("refused-evidence", `${REPAIR_TEXT["refused-evidence"]}; ${readBack.reason}`);
	const evidence: Evidence = readBack.kind === "found" ? { proof: "completed", effects: readBack.effects } : { proof: "unchanged", basis: readBack.revisionUnchanged ? "revision-unchanged" : "readback-absent" };
	try {
		const settled = journal.resolve(runId, evidence);
		const state: TransactionState = settled.status === "completed" ? "completed" : "unchanged";
		return { cause: "success", data: settled, detail: null, transactionState: state, effects: settled.effects.map(effectId), uncertain: [] };
	} catch (error) {
		return journalRefusal(error);
	}
}
