// Dispatch flows: one Route per provider and product with the tenant guard and
// live schema confirmation in front of every call; the read flow with its
// gated fallback; the journaled write flow (preview, apply); and the operator
// flows (receipts, adjudicate, unlock, parity). Each flow returns an Outcome
// that the CLI renders into one envelope. Provider text never crosses the
// transport seam; the outcomes carry fixed text and identifiers only.
import { type CauseCode, OFFICIAL_RESOURCES_TOOL, OFFICIAL_USER_TOOL, type OperationId, type OperationSpec, OPERATION_SPECS, type Product, type Provenance, type ProviderName, serverFor, type TransactionState } from "./contract.ts";
import type { BindResult, CredentialBinding } from "../custody/index.ts";
import {
	attestationMatches,
	confirmSchema,
	credentialDigest,
	type Dependencies,
	fallbackDecision,
	type Input,
	inputShape,
	matchCloudId,
	OBJECT_SEMANTICS,
	type ParityAttestation,
	type ParityRequest,
	providerArguments,
	REPAIR_TEXT,
	readSchema,
	type SchemaTool,
	type TransportFailure,
	type TransportResult,
} from "./engine.ts";
import { canonicalDigest, type Effect, type Evidence, JournalError, type Receipt, type WriteOperation } from "./journal.ts";
import { baselineFromReply, effectsFromReply, observeIssue, observePage, observeSpaceInstructions, type PreparedContext, preparation, readBackEvidence, readBackPlan, type ReadBack, type RevisionMatch, spaceIdFromSearch, spaceSearchPlan, unwrapReply, type WriteInput, writeArguments, writeInput } from "./writes.ts";

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
	contentObserved: boolean;
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

	route(provider: ProviderName, product: Product, binding: CredentialBinding): Route {
		return new Route(this, provider, product, binding);
	}
}

// One provider and product route for one call sequence: lists the live
// schema once, resolves the Official cloudId through the tenant guard once,
// and confirms every tool against the schema before it is called.
export class Route {
	readonly server: string;
	private tools: SchemaTool[] | undefined;
	cloudId: string | undefined;

	constructor(
		private readonly session: Session,
		readonly provider: ProviderName,
		readonly product: Product,
		private readonly binding: CredentialBinding,
	) {
		this.server = serverFor(provider, product);
	}

	// The transport already translated the failure; this records provenance
	// and attaches the fixed repair text plus the fixed hint, if any.
	private failure(tool: string, failure: TransportFailure): Attempt {
		this.session.provenance.push({ provider: this.server, tool, status: failure.cause });
		return { cause: failure.cause, data: null, detail: failure.hint ? `${REPAIR_TEXT[failure.cause]}; ${failure.hint}` : REPAIR_TEXT[failure.cause], contentObserved: failure.contentObserved };
	}

	private unavailable(): Attempt {
		return { cause: "capability-unavailable", data: null, detail: REPAIR_TEXT["capability-unavailable"], contentObserved: false };
	}

	// Live schema, then the Official tenant guard. Ready once per route. The
	// first tool the caller intends to use is confirmed against the schema
	// before the guard runs, so an unusable route makes no call at all; the
	// caller shapes that intent with a placeholder cloudId where the tool
	// takes one, because only the guard can supply the real value.
	async ready(intent?: { tool: string; args: Record<string, unknown> }): Promise<Attempt | null> {
		if (this.tools) return null;
		const listed = await this.session.deps.transport.listTools(this.binding, this.server);
		if (!listed.ok) return this.failure("list", listed);
		const tools = readSchema(listed);
		if (!tools) return this.unavailable();
		this.tools = tools;
		if (intent && !confirmSchema(tools, intent.tool, intent.args).ok) return this.unavailable();
		if (this.provider !== "official") return null;
		if (!confirmSchema(tools, OFFICIAL_RESOURCES_TOOL, {}).ok) return this.unavailable();
		const resources = await this.transportCall(OFFICIAL_RESOURCES_TOOL, {});
		if (resources.cause !== "success") return resources;
		const matched = matchCloudId(resources.data, this.binding.origin);
		if (!matched) return { cause: "refused-tenant", data: null, detail: REPAIR_TEXT["refused-tenant"], contentObserved: true };
		this.cloudId = matched;
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
			return { cause: "failed-unknown", data: null, detail: REPAIR_TEXT["failed-unknown"], contentObserved: false };
		}
		if (!result.ok) return this.failure(tool, result);
		this.session.provenance.push({ provider: this.server, tool, status: "success" });
		return { cause: "success", data: result.data, detail: null, contentObserved: true };
	}

	async call(tool: string, args: Record<string, unknown>): Promise<Attempt> {
		return this.confirm(tool, args) ?? this.transportCall(tool, args);
	}
}

async function guarded(route: Route, tool: string, args: Record<string, unknown>): Promise<Attempt> {
	return (await route.ready({ tool, args })) ?? route.call(tool, args);
}

// Community writes need an exact attestation on the product's base read.
// Explicit Community reads use one selected Provider and do not fall over.
const BASE_READ: Record<Product, { operation: OperationId; shape: string[] }> = {
	jira: { operation: "issue.get", shape: ["issueKey"] },
	confluence: { operation: "page.get", shape: ["pageId"] },
};

async function communityGate(session: Session, spec: OperationSpec, input: Record<string, unknown>, binding: CredentialBinding): Promise<Outcome | null> {
	const base = spec.kind === "read" ? { operation: spec.id, shape: inputShape(input) } : BASE_READ[spec.product];
	const request: ParityRequest = { tenant: session.tenant, product: spec.product, operation: base.operation, inputShape: base.shape, origin: binding.origin, credentialDigest: credentialDigest(binding), now: session.deps.now() };
	const verdict = attestationMatches(await session.deps.parity(request), request);
	return verdict.ok ? null : refusal("refused-parity", `${REPAIR_TEXT["refused-parity"]}; ${verdict.reason}`);
}

// One Official attempt, then at most one Community read fallback when the
// gate allows it. The reported cause stays the Official one when the
// fallback also fails, so the caller sees why the default route failed.
export async function readFlow(session: Session, spec: OperationSpec, input: Input, provider: ProviderName | undefined): Promise<Outcome> {
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const context = bound.binding;
	const attempt = async (name: ProviderName) => {
		const route = session.route(name, spec.product, context);
		const ready = await route.ready({ tool: spec[name].tool, args: providerArguments(spec, name, input, name === "official" ? "pending" : undefined) });
		if (ready) return ready;
		return route.call(spec[name].tool, providerArguments(spec, name, input, route.cloudId));
	};
	const primary = await attempt(provider ?? "official");
	if (primary.cause === "success") return success(primary.data);
	if (provider !== undefined) return failed(primary);
	const request: ParityRequest = { tenant: session.tenant, product: spec.product, operation: spec.id, inputShape: inputShape(input), origin: context.origin, credentialDigest: credentialDigest(context), now: session.deps.now() };
	const decision = fallbackDecision(spec, primary.cause, primary.contentObserved, await session.deps.parity(request), request);
	const detail = primary.detail ?? primary.cause;
	if (!decision.eligible) return { ...failed(primary), detail: `${detail}; ${decision.reason}` };
	const secondary = await attempt("community");
	if (secondary.cause === "success") return success(secondary.data);
	const refused = secondary.cause === "capability-unavailable" ? "fallback-refused:community-schema" : `fallback-failed:${secondary.cause}`;
	return { ...failed(primary), detail: `${detail}; ${decision.reason}; ${refused}: ${secondary.detail ?? secondary.cause}` };
}

type Prepared = { ctx: PreparedContext } | { outcome: Outcome };

// An unknown Jira update needs an explicit provider revision. `updated` is a
// timestamp, so it can never qualify a potentially sent write.
async function prepareIssue(route: Route, ctx: PreparedContext, issueKey: string): Promise<Prepared> {
	const official = route.provider === "official";
	const read = await route.call(official ? "getJiraIssue" : "jira_get_issue", official ? { cloudId: route.cloudId, issueIdOrKey: issueKey, fields: ["version"] } : { issue_key: issueKey, fields: "version" });
	if (read.cause !== "success") return { outcome: failed(read) };
	const issue = observeIssue(read.data);
	if (issue.key === undefined) return { outcome: refusal("capability-unavailable", "the preparatory Jira read names no issue key") };
	if (issue.key !== issueKey) return { outcome: refusal("capability-unavailable", "the preparatory Jira read names a different issue") };
	if (issue.revision === null) return { outcome: refusal("capability-unavailable", "the Jira reply exposes no stable revision; live qualification is required before issue.update") };
	return { ctx: { ...ctx, revision: issue.revision } };
}

// The page version is the revision; Official also needs the snapshot token of
// that version, which only a full-detail read returns.
async function preparePage(route: Route, ctx: PreparedContext, pageId: string): Promise<Prepared> {
	const official = route.provider === "official";
	const read = await route.call(
		official ? "getConfluenceContent" : "confluence_get_page",
		official ? { cloudId: route.cloudId, content_id: pageId, content_format: "markdown", detail: "full", include_metadata: true } : { page_id: pageId, detail: "full", include_metadata: true },
	);
	if (read.cause !== "success") return { outcome: failed(read) };
	const page = observePage(read.data);
	if (page.id === undefined) return { outcome: refusal("capability-unavailable", "the preparatory page read names no page id") };
	if (page.id !== pageId) return { outcome: refusal("capability-unavailable", "the preparatory page read names a different page") };
	if (page.spaceInstructions !== false) return { outcome: refusal("capability-unavailable", "getConfluenceSpace retrieval and instruction compliance need live qualification") };
	if (page.version === null) return { outcome: refusal("capability-unavailable", "the page read exposed no version to bind the revision") };
	if (official && page.snapshotToken === undefined) return { outcome: refusal("capability-unavailable", "the Official page read returned no snapshot token; a full-detail read is required before an update") };
	const prepared: PreparedContext = { ...ctx, revision: page.version, spaceInstructions: false };
	if (page.snapshotToken !== undefined) prepared.snapshotToken = page.snapshotToken;
	if (page.title !== undefined) prepared.currentTitle = page.title;
	return { ctx: prepared };
}

async function prepareSpace(route: Route, ctx: PreparedContext, reference: { key?: string; id?: string }): Promise<Prepared> {
	let spaceId = reference.id;
	if (reference.key !== undefined) {
		const plan = spaceSearchPlan(reference.key, route.provider, route.cloudId);
		const read = await route.call(plan.tool, plan.args);
		if (read.cause !== "success") return { outcome: failed(read) };
		spaceId = spaceIdFromSearch(reference.key, read.data);
	}
	if (spaceId === undefined) return { outcome: refusal("space-unresolved") };
	const plan = route.provider === "official"
		? { tool: "getConfluenceSpace", args: { cloudId: route.cloudId, spaceId } }
		: reference.key === undefined
			? null
			: { tool: "confluence_get_space", args: { space_key: reference.key } };
	if (plan === null) return { outcome: refusal("capability-unavailable", "getConfluenceSpace retrieval and instruction compliance need live qualification") };
	const observed = await route.call(plan.tool, plan.args);
	if (observed.cause !== "success") return { outcome: failed(observed) };
	if (observeSpaceInstructions(observed.data) !== false) return { outcome: refusal("capability-unavailable", "getConfluenceSpace retrieval and instruction compliance need live qualification") };
	return { ctx: { ...ctx, spaceId, spaceInstructions: false } };
}

async function bindBaseline(route: Route, operation: WriteOperation, input: WriteInput, ctx: PreparedContext): Promise<Prepared> {
	const plan = readBackPlan(operation, route.provider, input, route.cloudId);
	if ("refused" in plan) return { outcome: refusal("capability-unavailable", `${plan.refused}; live qualification is required`) };
	const read = await route.call(plan.tool, plan.args);
	if (read.cause !== "success") return { outcome: failed(read) };
	const observed = baselineFromReply(operation, input, read.data);
	if (observed.kind === "indeterminate") return { outcome: refusal("capability-unavailable", `${observed.reason}; live qualification is required`) };
	return { ctx: { ...ctx, baseline: observed.baseline } };
}

// Preparatory reads before a write: the target's current revision and, for
// Official page updates, its snapshot token; a space id resolved from a key;
// then baseline identifiers that make a later read-back temporal rather than
// merely textual.
async function prepare(route: Route, operation: WriteOperation, input: WriteInput): Promise<Prepared> {
	const step = preparation(operation, route.provider, input);
	const ctx: PreparedContext = { revision: null, baseline: { effectIds: [], commentIds: [], revision: null } };
	if (route.cloudId !== undefined) ctx.cloudId = route.cloudId;
	let prepared: Prepared;
	switch (step.kind) {
		case "refused":
			return { outcome: refusal("input-invalid", step.reason) };
		case "none":
			prepared = { ctx };
			break;
		case "issue":
			prepared = await prepareIssue(route, ctx, step.issueKey);
			break;
		case "page":
			prepared = await preparePage(route, ctx, step.pageId);
			break;
		case "space":
			prepared = await prepareSpace(route, ctx, step);
			break;
	}
	if ("outcome" in prepared) return prepared;
	return bindBaseline(route, operation, canonicalWriteInput(input, prepared.ctx), prepared.ctx);
}

// The canonical input the journal binds: the caller's input with a resolved
// space id folded in, so key-only input and id input derive one identity.
export function canonicalWriteInput(input: WriteInput, ctx: PreparedContext): WriteInput {
	if (ctx.spaceId === undefined) return input;
	const space = typeof input.space === "object" && input.space !== null ? input.space : {};
	return { ...input, space: { ...space, id: ctx.spaceId } };
}

const JOURNAL_CAUSES: Record<string, Exclude<CauseCode, "success">> = {
	"preview-unknown": "refused-preview",
	"preview-consumed": "refused-preview",
	"preview-expired": "refused-preview",
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
	canonical: WriteInput;
	ctx: PreparedContext;
	tool: string;
	bound: Record<string, unknown>;
}

// Shared front half of preview and apply: provider choice, the deferred
// Official refusal, the Community attestation gate, readiness, preparation,
// argument shaping, and schema confirmation of the shaped arguments.
async function writeContext(session: Session, spec: OperationSpec, input: WriteInput, provider: ProviderName): Promise<WriteContext | Outcome> {
	if (provider === "official" && !spec.official.reachable) return refusal("operation-unavailable");
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const context = bound.binding;
	if (provider === "community") {
		const gate = await communityGate(session, spec, input, context);
		if (gate) return gate;
	}
	const route = session.route(provider, spec.product, context);
	const placeholder: PreparedContext = { revision: null, baseline: { effectIds: [], commentIds: [], revision: null }, snapshotToken: "pending", currentTitle: "pending", spaceId: "1" };
	if (provider === "official") placeholder.cloudId = "pending";
	const ready = await route.ready({ tool: spec[provider].tool, args: writeArguments(spec, provider, input, placeholder).args });
	if (ready) return failed(ready);
	const prepared = await prepare(route, spec.id as WriteOperation, input);
	if ("outcome" in prepared) return prepared.outcome;
	const suppliedSpace = typeof input.space === "object" && input.space !== null ? (input.space as { id?: unknown }) : undefined;
	if (prepared.ctx.spaceId !== undefined && typeof suppliedSpace?.id === "string" && suppliedSpace.id !== prepared.ctx.spaceId) {
		return refusal("input-invalid", "the supplied space id does not match the resolved space key");
	}
	const canonical = canonicalWriteInput(input, prepared.ctx);
	const shaped = writeArguments(spec, provider, canonical, prepared.ctx);
	const tool = spec[provider].tool;
	const shape = route.confirm(tool, shaped.args);
	if (shape) return failed(shape);
	return { route, spec, input, canonical, ctx: prepared.ctx, tool, bound: shaped.bound };
}

export async function previewFlow(session: Session, spec: OperationSpec, input: WriteInput, provider: ProviderName): Promise<Outcome> {
	const context = await writeContext(session, spec, input, provider);
	if ("cause" in context) return context;
	try {
		const preview = session.deps.journal(session.tenant).recordPreview({
			operation: spec.id as WriteOperation,
			provider,
			canonicalInput: context.canonical,
			providerArgs: context.bound,
			revision: context.ctx.revision,
			baseline: context.ctx.baseline,
			spaceInstructions: context.ctx.spaceInstructions,
		});
		return success({
			previewId: preview.previewId,
			operation: preview.operation,
			provider: preview.provider,
			server: context.route.server,
			tool: context.tool,
			objectIdentity: preview.objectIdentity,
			revision: context.ctx.revision,
			baseline: context.ctx.baseline,
			expiresAt: preview.expiresAt,
			input: context.canonical,
			arguments: context.bound,
		});
	} catch (error) {
		return journalRefusal(error);
	}
}

function replyEffectIsNew(operation: WriteOperation, id: string, context: WriteContext): boolean {
	if (operation.endsWith(".comment")) return !context.ctx.baseline.commentIds.includes(id);
	if (operation.endsWith(".create")) return !context.ctx.baseline.effectIds.includes(id);
	return false;
}

// Evidence from the provider reply, else from an immediate read-back.
async function settleEvidence(context: WriteContext, attempt: Attempt): Promise<Evidence> {
	const operation = context.spec.id as WriteOperation;
	if (attempt.cause === "success") {
		const effects = effectsFromReply(operation, context.canonical, attempt.data);
		if (effects.length > 0 && effects.every((effect) => replyEffectIsNew(operation, effect.id, context))) return { proof: "completed", effects };
	}
	const revisionMatches: RevisionMatch = (observed) => context.ctx.revision !== null && observed === context.ctx.revision;
	const readBack = await readBackFor(context.route, operation, context.canonical, revisionMatches, context.ctx.baseline);
	if (readBack.kind === "found") return { proof: "completed", effects: readBack.effects };
	if (readBack.kind === "absent") return { proof: "unchanged", basis: readBack.revisionUnchanged ? "revision-unchanged" : "readback-absent" };
	return { proof: "unknown" };
}

async function readBackFor(route: Route, operation: WriteOperation, input: WriteInput, revisionMatches: RevisionMatch, baseline: PreparedContext["baseline"]): Promise<ReadBack> {
	const plan = readBackPlan(operation, route.provider, input, route.cloudId);
	if ("refused" in plan) return { kind: "indeterminate", reason: plan.refused };
	const read = await route.call(plan.tool, plan.args);
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
			return { cause, data: base, detail: attempt?.detail ?? REPAIR_TEXT[cause], transactionState: "unchanged", effects: [], uncertain: [] };
		}
		default:
			return { cause: "outcome-unknown", data: base, detail: REPAIR_TEXT["outcome-unknown"], transactionState: "unknown", effects: [], uncertain: [receipt.objectIdentity] };
	}
}

export async function applyFlow(session: Session, spec: OperationSpec, input: WriteInput, provider: ProviderName, previewId: string): Promise<Outcome> {
	const context = await writeContext(session, spec, input, provider);
	if ("cause" in context) return context;
	let attempt: Attempt | null = null;
	try {
		const receipt = await session.deps.journal(session.tenant).apply(
			{ previewId, canonicalInput: context.canonical, providerArgs: context.bound, revision: context.ctx.revision, baseline: context.ctx.baseline, spaceInstructions: context.ctx.spaceInstructions },
			async (_intent, sending, boundArgs) => {
				const shape = context.route.confirm(context.tool, boundArgs);
				if (shape) {
					attempt = shape;
					return { proof: "unchanged", basis: "readback-absent" };
				}
				sending();
				attempt = await context.route.call(context.tool, boundArgs);
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

export function unlockFlow(session: Session, runId: string): Outcome {
	try {
		const journal = session.deps.journal(session.tenant);
		try {
			const receipt = journal.receipt(runId);
			journal.unlock(receipt.objectIdentity);
			return success({ runId, objectIdentity: receipt.objectIdentity, unlocked: true });
		} catch (error) {
			if (!(error instanceof JournalError) || error.code !== "receipt-unknown") throw error;
			const preview = journal.preview(runId);
			journal.unlock(preview.objectIdentity);
			return success({ previewId: preview.previewId, objectIdentity: preview.objectIdentity, unlocked: true });
		}
	} catch (error) {
		return journalRefusal(error);
	}
}

async function canonicalAdjudicationInput(route: Route, receipt: Receipt, rawInput: unknown): Promise<WriteInput | Outcome> {
	const validated = writeInput(receipt.operation, rawInput);
	if (!validated.ok) return refusal("input-invalid", validated.reason);
	let canonical = validated.input;
	if (receipt.operation === "page.create") {
		const prepared = await prepare(route, receipt.operation, canonical);
		if ("outcome" in prepared) return prepared.outcome;
		canonical = canonicalWriteInput(canonical, prepared.ctx);
	}
	return canonicalDigest(canonical) === receipt.inputDigest ? canonical : refusal("input-invalid", "the supplied input is not the input this receipt was recorded from");
}

function isOutcome(value: WriteInput | Outcome): value is Outcome {
	return "cause" in value && "transactionState" in value;
}

// Operator adjudication: read the object back through the receipt's own
// provider and resolve only on evidence. Read-back absence releases an object
// only when the receipt never reached the send mark or a monotonic revision
// proves nothing landed; otherwise the receipt stays open and the outcome
// says so.
export async function adjudicateFlow(session: Session, runId: string, rawInput: unknown): Promise<Outcome> {
	const journal = session.deps.journal(session.tenant);
	let receipt: Receipt;
	try {
		receipt = journal.receipt(runId);
	} catch (error) {
		return journalRefusal(error);
	}
	if (receipt.status === "completed" || receipt.status === "unchanged") return refusal("refused-evidence", `${REPAIR_TEXT["refused-evidence"]}; receipt-already-resolved`);
	const spec = OPERATION_SPECS[receipt.operation];
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const route = session.route(receipt.provider, spec.product, bound.binding);
	const ready = await route.ready();
	if (ready) return failed(ready);
	const canonical = await canonicalAdjudicationInput(route, receipt, rawInput);
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

const PARITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const keySet = (data: unknown, key: "key" | "id"): string[] => {
	const found = new Set<string>();
	const walk = (value: unknown, depth: number) => {
		if (depth > 6) return;
		if (Array.isArray(value)) for (const entry of value) walk(entry, depth + 1);
		else if (typeof value === "object" && value !== null) {
			const record = value as Record<string, unknown>;
			if (typeof record[key] === "string") found.add(record[key] as string);
			for (const entry of Object.values(record)) walk(entry, depth + 1);
		}
	};
	walk(unwrapReply(data), 0);
	return [...found].sort();
};

// Object semantics compared per read operation; both replies must agree on
// every field named by OBJECT_SEMANTICS.
function sameObject(operation: OperationId, official: unknown, community: unknown): boolean {
	switch (operation) {
		case "issue.get": {
			const a = observeIssue(official);
			const b = observeIssue(community);
			const idOf = (reply: unknown) => (typeof unwrapReply(reply) === "object" && unwrapReply(reply) !== null ? String((unwrapReply(reply) as Record<string, unknown>).id ?? "") : "");
			return a.key !== undefined && a.key === b.key && idOf(official) !== "" && idOf(official) === idOf(community);
		}
		case "issue.search":
			return keySet(official, "key").length > 0 && keySet(official, "key").join(",") === keySet(community, "key").join(",");
		case "page.get": {
			const a = observePage(official);
			const b = observePage(community);
			return a.id !== undefined && a.id === b.id && a.version !== null && a.version === b.version && a.title !== undefined && a.title === b.title;
		}
		case "page.search":
			return keySet(official, "id").length > 0 && keySet(official, "id").join(",") === keySet(community, "id").join(",");
		default:
			return false;
	}
}

function principalOf(reply: unknown): string | undefined {
	const data = unwrapReply(reply);
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	const email = record.email ?? record.emailAddress;
	return typeof email === "string" && email.length > 0 ? email.toLowerCase() : undefined;
}

// Live parity attestation for one read: the same tenant origin, the Official
// principal equal to the item's username, and the same object identity from
// both providers. Only then is an attestation written; nothing is persisted on
// a mismatch.
export async function parityFlow(session: Session, spec: OperationSpec, input: Input): Promise<Outcome> {
	const semantics = OBJECT_SEMANTICS[spec.id];
	if (spec.kind !== "read" || semantics === undefined) return refusal("usage-invalid", "parity attests a read operation");
	const bound = await session.binding(spec.product);
	if (!bound.ok) return refusal(bound.cause, bound.detail);
	const context = bound.binding;
	const principal = context.principal.toLowerCase();
	const boundCredential = credentialDigest(context);
	const official = session.route("official", spec.product, context);
	const user = await guarded(official, OFFICIAL_USER_TOOL, {});
	if (user.cause !== "success") return failed(user);
	if (principalOf(user.data) !== principal) return refusal("refused-parity", `${REPAIR_TEXT["refused-parity"]}; principal-mismatch`);
	const officialRead = await official.call(spec.official.tool, providerArguments(spec, "official", input, official.cloudId));
	if (officialRead.cause !== "success") return failed(officialRead);
	const community = session.route("community", spec.product, context);
	const communityRead = await guarded(community, spec.community.tool, providerArguments(spec, "community", input));
	if (communityRead.cause !== "success") return failed(communityRead);
	if (!sameObject(spec.id, officialRead.data, communityRead.data)) return refusal("refused-parity", `${REPAIR_TEXT["refused-parity"]}; object-mismatch`);
	const now = session.deps.now();
	const attestation: ParityAttestation = {
		tenant: session.tenant,
		product: spec.product,
		operation: spec.id,
		inputShape: inputShape(input),
		origin: context.origin,
		credentialDigest: boundCredential,
		objectSemantics: semantics,
		recordedAt: now,
		expiresAt: now + PARITY_TTL_MS,
		source: "parity-attest",
	};
	await session.deps.attestParity(attestation);
	return success({ attested: true, ...attestation, credentialDigest: undefined });
}
