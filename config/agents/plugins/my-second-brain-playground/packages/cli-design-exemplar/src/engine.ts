import { declarationForRoute, parseResourceId, type Authorization, type CauseCode, type CommandIdentity, type CommandRoute, type ResourceId } from "./command-contract.ts"
import type { DomainOutcome, EffectId, ExecutionFacts, Guidance, JournalEntry, JournalScan, Preview, Resource, TransactionState } from "./model.ts"
import { JournalLockHeld } from "./journal-lock.ts"
import { JOURNAL_SCAN_BOUND_BYTES, RETRY_DELAY_MS, type Runtime, RuntimeRefusal, sha256Hex, TransientLock } from "./runtime.ts"
import { JOURNAL_LOCK_HELD_REASON, JOURNAL_LOCK_HELD_REPAIR_ACTION } from "./station-catalogue.ts"

// Pure policy over plain data plus the runtime seam: authority, preview matching, staleness, consumption order,
// unknown classification, retry policy, redaction and result shaping (brief 12, sections 3.3 through 3.5).

export const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i
export const REDACTED = "[REDACTED]"
function requiredResourceId(value: string): ResourceId {
	const parsed = parseResourceId(value)
	if (parsed === null) throw new Error("internal resource identity is empty")
	return parsed
}

export const FIXTURE_AUTHORITY = "fixture-authority" as const

export interface Decision {
	commandIdentity: CommandIdentity
	domainOutcome: DomainOutcome
	failureClass: "usage" | "domain" | "schema" | "internal" | "unavailable" | null
	causeCode: CauseCode | null
	message: string
	effectClass: "inspect" | "repository-local"
	transactionState: TransactionState
	retryable: boolean
	retryDelayMilliseconds: number | null
	guidance: Guidance
	repairAction: string | null
	stationLabel: string
	result: Record<string, unknown> | null
	humanStdout: string[]
	humanStderr: string[]
	events: string[]
	redactedFields: string[]
	completedEffectIds: EffectId[]
	remainingEffectIds: EffectId[]
	inventoryComplete: boolean
}

export interface Request {
	route: CommandRoute
	statePath: ResourceId | undefined
	previewId: ResourceId | undefined
	authority: Authorization | undefined
	automation: boolean
	includeDiagnostics: boolean
}

export type ParsedRequest = Request

const INSPECT: Guidance = { kind: "next-action", target: "repair-lab inspect" }
const RECOVER: Guidance = { kind: "next-action", target: "repair-lab recover" }
const HANDOFF: Guidance = { kind: "handoff", station: "repair-lab.required-handoff" }
const APPLY_PLAN: EffectId[] = ["effect.update-index", "effect.write-journal"]
const REPAIR_PLAN: EffectId[] = ["effect.repair-cache", "effect.write-journal"]

export function redactJson(value: unknown, redacted: string[], path = ""): unknown {
	if (Array.isArray(value)) return value.map((item, index) => redactJson(item, redacted, `${path}[${index}]`))
	if (typeof value !== "object" || value === null) return value
	const output: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			output[key] = REDACTED
			redacted.push(key)
		} else output[key] = redactJson(child, redacted, path ? `${path}.${key}` : key)
	}
	return output
}

function base(route: CommandRoute): Decision {
	const { identity: commandIdentity, effectClass } = declarationForRoute(route)
	return {
		commandIdentity,
		domainOutcome: "success",
		failureClass: null,
		causeCode: null,
		message: "",
		effectClass,
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		guidance: INSPECT,
		repairAction: null,
		stationLabel: "",
		result: null,
		humanStdout: [],
		humanStderr: [],
		events: [],
		redactedFields: [],
		completedEffectIds: [],
		remainingEffectIds: [],
		inventoryComplete: true,
	}
}

function refusal(decision: Decision, failureClass: NonNullable<Decision["failureClass"]>, causeCode: CauseCode, message: string, repairAction: string | null, stationLabel: string, humanLine: string): Decision {
	return { ...decision, domainOutcome: "refused", failureClass, causeCode, message, repairAction, stationLabel, humanStderr: [humanLine] }
}

export function factsOf(decision: Decision, runIdentity: string): ExecutionFacts {
	return {
		commandIdentity: decision.commandIdentity,
		runIdentity,
		domainOutcome: decision.domainOutcome,
		effectClass: decision.effectClass,
		transactionState: decision.transactionState,
		completedEffectIds: [...decision.completedEffectIds],
		remainingEffectIds: [...decision.remainingEffectIds],
		inventoryComplete: decision.inventoryComplete,
		stationLabel: decision.stationLabel,
		guidance: decision.guidance,
	}
}

function inputRefusal(decision: Decision, error: RuntimeRefusal, command: string): Decision {
	switch (error.causeCode) {
		case "DOMAIN_PATH_ESCAPE":
			return {
				...refusal(decision, "domain", error.causeCode, "state path must remain inside the fixture root", `${command}: provide a state path inside the fixture root`, "repair-lab.hostile-input", `${command} refused: state path must remain inside the fixture root`),
				result: { result: "path-refused", station_id: "repair-lab.hostile-input", transaction_state: "unchanged", path_escape: false },
				events: ["input.path-rejected"],
			}
		case "DOMAIN_INPUT_MISSING":
			return { ...refusal(decision, "domain", error.causeCode, error.message, "provide a readable state file inside the fixture root", "repair-lab.input-missing", `${command} refused: state file is missing`), result: { result: "input-missing", station_id: "repair-lab.input-missing", transaction_state: "unchanged" }, events: ["input.missing"] }
		case "DOMAIN_INPUT_MALFORMED":
			return { ...refusal(decision, "domain", error.causeCode, error.message, "correct the state file bytes; nothing was changed", "repair-lab.input-malformed", `${command} refused: state file is malformed JSON`), result: { result: "input-malformed", station_id: "repair-lab.input-malformed", transaction_state: "unchanged" }, events: ["input.malformed"] }
		case "DOMAIN_INPUT_UNREADABLE":
			return { ...refusal(decision, "domain", error.causeCode, error.message, "make the state file readable", "repair-lab.input-unreadable", `${command} refused: state file is not readable`), result: { result: "input-unreadable", station_id: "repair-lab.input-unreadable", transaction_state: "unchanged" }, events: ["input.unreadable"] }
		case "SCHEMA_STATE_INVALID":
			// The message names the state file that failed (resource, preview or journal); the station and guidance stay the
			// one accepted schema row.
			return { ...refusal(decision, "schema", error.causeCode, error.message, "restore state that matches its schema", "repair-lab.state-schema-invalid", `${command} refused: ${error.message}`), result: { result: "state-schema-invalid", station_id: "repair-lab.state-schema-invalid", transaction_state: "unchanged" }, events: ["input.schema-invalid"] }
		case "USAGE_INVALID_ARGUMENTS":
			return { ...refusal(decision, "usage", error.causeCode, error.message, "correct the arguments; run repair-lab --help", "repair-lab.usage", `${command} refused: ${error.message}`), guidance: INSPECT, result: null }
	}
}

// Journal admission (O1 Candidate A). Every routed state command validates the journal: a corrupt or unversioned
// journal refuses as schema from the runtime. Readers tolerate a torn tail and keep the validated prefix; writers refuse
// a torn tail before any durable write, refuse a journal over the scan bound, and refuse while a consumed plan is
// unresolved so the recovery inventory is never overwritten and no mutation starts on unresolved state.
function readJournalForReader(runtime: Runtime): JournalScan {
	return runtime.readJournal()
}

function readJournalForWriter(runtime: Runtime): JournalScan {
	const scan = runtime.readJournal()
	if (scan.torn) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "journal ends in a torn frame; writers are blocked until it is inspected")
	return scan
}

const LIMIT_MESSAGE = `journal scan bound of ${JOURNAL_SCAN_BOUND_BYTES.toLocaleString("en-US")} bytes reached; inspect, then archive the journal manually`
const PRIOR_RUN_MESSAGE = "a prior run's consumed plan has unresolved effects; recover before previewing or applying again"

function limitReached(decision: Decision, command: string, events: string[]): Decision {
	return { ...refusal(decision, "domain", "DOMAIN_JOURNAL_LIMIT_REACHED", LIMIT_MESSAGE, "inspect, then archive the journal manually; nothing is rotated or pruned automatically", "repair-lab.journal-limit", `${command} refused: ${LIMIT_MESSAGE}`), result: { result: "journal-limit-reached", station_id: "repair-lab.journal-limit", transaction_state: "unchanged" }, events: [...events, `${command}.journal-limit-reached`] }
}

function priorRunPending(decision: Decision, command: string, preview: Preview, events: string[]): Decision {
	return { ...refusal(decision, "domain", "DOMAIN_PRIOR_RUN_PENDING", PRIOR_RUN_MESSAGE, "run repair-lab recover; do not retry automatically", "repair-lab.prior-run-pending", `${command} refused: a prior run's consumed plan has unresolved effects; run repair-lab recover`), guidance: HANDOFF, result: { result: "prior-run-pending", station_id: "repair-lab.prior-run-pending", transaction_state: "unchanged", preview_id: preview.preview_id, human_handoff: true }, events: [...events, `${command}.prior-run-pending`] }
}

// A consumed plan is resolved when nothing is uncertain and it is either wholly completed or wholly not applied.
function resolvedPlan(observed: Classification): boolean {
	return observed.uncertain.length === 0 && (observed.remaining.length === 0 || observed.completed.length === 0)
}

// The writer admission shared by every preview and mutating route: scan bound, then the prior-run check against the
// consumed preview, returning the preview the route then binds.
function admitWriter(runtime: Runtime, decision: Decision, command: string, resourceBytes: string, events: string[]): { preview: Preview | null } | { refused: Decision } {
	const scan = readJournalForWriter(runtime)
	if (scan.exceedsScanBound) return { refused: limitReached(decision, command, events) }
	const preview = runtime.readPreview()
	if (preview !== null && preview.consumed && !resolvedPlan(classifyPlan(scan, preview, resourceBytes))) return { refused: priorRunPending(decision, command, preview, events) }
	return { preview }
}

function decideStatus(runtime: Runtime): Decision {
	const decision = base("status")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource().value
	readJournalForReader(runtime)
	const redacted: string[] = []
	return {
		...decision,
		message: "resource status reported",
		retryable: true,
		stationLabel: "repair-lab.healthy",
		result: { result: "healthy", station_id: "repair-lab.healthy", effect_ids: [], resource: redactJson(resource, redacted) },
		humanStdout: [`resource: ${resource.resource}`, `revision: ${resource.revision}`, `status: ${resource.status}`],
		redactedFields: redacted,
	}
}

function decideInspect(runtime: Runtime, request: Request): Decision {
	const decision = base(request.includeDiagnostics ? "inspect-diagnostics" : "inspect")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource(request.statePath).value
	readJournalForReader(runtime)
	const redacted: string[] = []
	const projected = redactJson(resource, redacted) as Record<string, unknown>
	if (request.includeDiagnostics) {
		return {
			...decision,
			message: "inspection ready; sensitive fields redacted",
			retryable: true,
			stationLabel: "repair-lab.secret-marker",
			result: { result: "inspected-redacted", station_id: "repair-lab.secret-marker", marker_absent: true, redaction_placeholder: REDACTED, redacted_fields: [...redacted], resource: projected },
			humanStdout: ["inspection: ready", "redaction: applied", "next: inspect"],
			events: ["inspect.started", "inspect.redaction-applied", "inspect.completed"],
			redactedFields: redacted,
		}
	}
	return {
		...decision,
		message: "inspection ready",
		retryable: true,
		stationLabel: "repair-lab.inspect",
		result: { result: "inspected", station_id: "repair-lab.inspect", effect_ids: [], resource: projected },
		humanStdout: ["inspection: ready", "next: preview"],
		events: ["inspect.started", "inspect.completed"],
		redactedFields: redacted,
	}
}

function decidePreview(runtime: Runtime): Decision {
	const decision = base("preview")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const { value: resource, bytes } = runtime.readResource()
	const admitted = admitWriter(runtime, decision, "apply", bytes, ["preview.started"])
	if ("refused" in admitted) return admitted.refused
	const previewId = requiredResourceId(`preview-${resource.status}-revision-${resource.revision}`)
	runtime.writePreview({ preview_id: previewId, kind: "apply", resource_revision: resource.revision, expected_effect_ids: APPLY_PLAN, consumed: false })
	return {
		...decision,
		message: "preview ready; authorize apply to continue",
		stationLabel: "repair-lab.preview",
		result: { result: "previewed", station_id: "repair-lab.preview", preview_revision: resource.revision, effect_ids: APPLY_PLAN, preview_id: previewId },
		humanStdout: ["preview: ready", `effects: ${APPLY_PLAN.join(", ")}`, "next: authorize apply"],
		events: ["preview.started", "preview.effects-declared", "preview.completed"],
	}
}

function decideRepairPreview(runtime: Runtime): Decision {
	const decision = base("repair-preview")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const { value: resource, bytes } = runtime.readResource()
	const admitted = admitWriter(runtime, decision, "repair", bytes, ["repair.inspect.started"])
	if ("refused" in admitted) return admitted.refused
	if (resource.status === "healthy") {
		return { ...refusal(decision, "domain", "DOMAIN_REPAIR_NOT_REQUIRED", "the derived index is present; nothing to repair", null, "repair-lab.repair-not-required", "repair refused: nothing to repair; inspect"), result: { result: "repair-not-required", station_id: "repair-lab.repair-not-required", transaction_state: "unchanged" }, events: ["repair.inspect.started", "repair.precondition.present"] }
	}
	const previewId = requiredResourceId("repair-preview-missing-index")
	runtime.writePreview({ preview_id: previewId, kind: "repair", resource_revision: resource.revision, expected_effect_ids: REPAIR_PLAN, consumed: false })
	return {
		...refusal(decision, "domain", "DOMAIN_REPAIR_REQUIRED", "derived index is absent; inspect and authorize repair", "repair", "repair-lab.repairable-precondition", "repair required: derived index is absent; inspect and authorize repair"),
		guidance: { kind: "next-action", target: "repair-lab inspect" },
		result: { result: "repair-required", station_id: "repair-lab.repairable-precondition", transaction_state: "unchanged", repair_action: "repair", preview_effect_ids: REPAIR_PLAN, preview_id: previewId, repair_is_authorized: false },
		events: ["repair.inspect.started", "repair.precondition.missing", "repair.preview.ready"],
	}
}

interface MutationPlan {
	identity: CommandIdentity
	command: string
	kind: "apply" | "repair"
	plan: EffectId[]
	label: { success: string; result: string }
	events: { started: string; completed: string }
	humanCompleted: string[]
}

const PLANS: Record<"apply" | "repair" | "repair-retry", Omit<MutationPlan, "identity" | "command">> = {
	apply: { kind: "apply", plan: APPLY_PLAN, label: { success: "repair-lab.authorized-apply", result: "applied" }, events: { started: "apply.started", completed: "apply.completed" }, humanCompleted: ["apply: completed", `effects: ${APPLY_PLAN.join(", ")}`, "next: inspect"] },
	repair: { kind: "repair", plan: REPAIR_PLAN, label: { success: "repair-lab.authorized-repair", result: "repair-applied" }, events: { started: "repair.apply.started", completed: "repair.apply.completed" }, humanCompleted: ["repair: completed", `effects: ${REPAIR_PLAN.join(", ")}`, "next: inspect"] },
	"repair-retry": { kind: "repair", plan: REPAIR_PLAN, label: { success: "repair-lab.permitted-transient-retry", result: "retried-once" }, events: { started: "repair.started", completed: "repair.completed" }, humanCompleted: ["repair: completed after one bounded retry", "next: inspect"] },
}

// Refusal precedence inside every effect-executing route (brief 12, 3.5). Returns the bound preview or a refusal.
interface Admitted {
	preview: Preview
	missing(reason: "absent" | "mismatch"): { refused: Decision }
}

function admitMutation(runtime: Runtime, request: Request, plan: MutationPlan, decision: Decision, resource: Resource, resourceBytes: string): Admitted | { refused: Decision } {
	if (request.automation || request.authority !== FIXTURE_AUTHORITY) {
		return {
			refused: {
				...refusal(decision, "domain", "DOMAIN_AUTHORITY_MISSING", "fixture-local authority is required", `inspect, then supply --authorize ${FIXTURE_AUTHORITY} with a fresh preview, or hand off`, "repair-lab.prohibited-automation", `${plan.command} refused: fixture-local authority is required; inspect or hand off`),
				result: { result: "automation-refused", station_id: "repair-lab.prohibited-automation", transaction_state: "unchanged", effect_attempted: false, human_handoff: false },
				events: [`${plan.command}.authority-missing`, `${plan.command}.refused`],
			},
		}
	}
	// Authority precedes every state read that feeds admission; the journal and prior-run checks precede preview binding.
	const admitted = admitWriter(runtime, decision, plan.command, resourceBytes, [plan.events.started])
	if ("refused" in admitted) return admitted
	const { preview } = admitted
	const missing = (reason: "absent" | "mismatch"): { refused: Decision } => ({
		refused: {
			...refusal(decision, "domain", "DOMAIN_PREVIEW_MISSING", `no matching unconsumed preview (${reason})`, `run repair-lab ${plan.command} --preview, then authorize`, "repair-lab.preview-missing", `${plan.command} refused: no matching unconsumed preview; preview first`),
			guidance: { kind: "next-action", target: "repair-lab inspect" },
			result: { result: "preview-missing", station_id: "repair-lab.preview-missing", transaction_state: "unchanged", reason },
			events: [plan.events.started, `${plan.command}.preview-missing`],
		},
	})
	if (preview === null) return missing("absent")
	if (plan.identity !== "repair-lab.repair-retry" && preview.preview_id !== request.previewId) return missing("mismatch")
	if (plan.identity === "repair-lab.repair-retry" && preview.kind !== "repair") return missing("mismatch")
	if (preview.consumed) {
		return {
			refused: {
				...refusal(decision, "domain", "DOMAIN_PREVIEW_CONSUMED", "the preview was already consumed", "inspect, then preview again", "repair-lab.preview-consumed", `${plan.command} refused: preview already consumed; inspect and preview again`),
				result: { result: "preview-consumed", station_id: "repair-lab.preview-consumed", transaction_state: "unchanged", preview_id: preview.preview_id },
				events: [plan.events.started, `${plan.command}.preview-consumed`],
			},
		}
	}
	if (preview.resource_revision !== resource.revision) {
		return {
			refused: {
				...refusal(decision, "domain", "DOMAIN_PREVIEW_STALE", "preview is stale; inspect current state and preview again", "inspect current state and preview again", "repair-lab.stale-preview", `${plan.command} refused: preview is stale; inspect current state and preview again`),
				result: { result: "stale-preview", station_id: "repair-lab.stale-preview", transaction_state: "unchanged", completed_effect_ids: [], remaining_effect_ids: plan.plan, preview_revision: preview.resource_revision, resource_revision: resource.revision },
				events: [plan.events.started, `${plan.command}.stale-preview.refused`],
				remainingEffectIds: [...plan.plan],
			},
		}
	}
	if (preview.kind !== plan.kind) return missing("mismatch")
	if (plan.kind === "repair" && resource.status === "healthy") {
		return { refused: { ...refusal(decision, "domain", "DOMAIN_REPAIR_NOT_REQUIRED", "the derived index is present; nothing to repair", null, "repair-lab.repair-not-required", "repair refused: nothing to repair; inspect"), result: { result: "repair-not-required", station_id: "repair-lab.repair-not-required", transaction_state: "unchanged" }, events: [plan.events.started, "repair.precondition.present"] } }
	}
	return { preview, missing }
}

function busy(decision: Decision, plan: MutationPlan, retryCount: number): Decision {
	return {
		...refusal(decision, "unavailable", "UNAVAILABLE_STORAGE_BUSY", "storage is busy; retry the same command after a bounded delay", `retry the same command after ${RETRY_DELAY_MS} ms`, "repair-lab.storage-busy", `${plan.command} refused: storage is busy; retry the same command after ${RETRY_DELAY_MS} ms`),
		retryable: true,
		retryDelayMilliseconds: RETRY_DELAY_MS,
		guidance: { kind: "next-action", target: "repair-lab inspect" },
		result: { result: "storage-busy", station_id: "repair-lab.storage-busy", transaction_state: "unchanged", retry_count: retryCount },
		events: [plan.events.started, `${plan.command}.transient-refused`],
	}
}

function sleepMilliseconds(milliseconds: number): void {
	const target = Date.now() + milliseconds
	while (Date.now() < target) {
		// bounded busy wait: the retry delay is 25 ms and the process owns no other work
	}
}

function executePlan(runtime: Runtime, plan: MutationPlan, preview: Preview, decision: Decision, runIdentity: string, retryCount: number): Decision {
	let sequence = 0
	const seq = (): number => {
		sequence += 1
		return sequence
	}
	const events: string[] = retryCount > 0 ? [plan.events.started, "repair.transient-refused", "repair.retry-permitted"] : [plan.events.started]
	// Containment of every state path the plan touches precedes the first durable write (preview consumption).
	runtime.admitStatePaths()
	runtime.facts.remaining = [...plan.plan]
	runtime.consumePreview(preview, runIdentity)
	const completed: EffectId[] = []
	for (const effectId of plan.plan) {
		const outcome = runtime.applyEffect(effectId, plan.kind, preview.preview_id, runIdentity, seq)
		if (outcome === "completed") {
			completed.push(effectId)
			runtime.facts.remaining = plan.plan.filter((id) => !completed.includes(id))
			events.push(`${effectId}.completed`)
			continue
		}
		const remaining = plan.plan.filter((id) => !completed.includes(id))
		if (outcome === "unknown") {
			return {
				...decision,
				domainOutcome: "unknown",
				failureClass: "internal",
				causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN",
				message: `${plan.command} outcome unknown: inspect state or request human handoff; do not retry automatically`,
				transactionState: "unknown",
				guidance: RECOVER,
				repairAction: "inspect: run repair-lab recover; do not retry automatically",
				stationLabel: "repair-lab.partial-unknown",
				result: { result: "unknown-outcome", station_id: "repair-lab.partial-unknown", transaction_state: "unknown", completed_effect_ids: completed, remaining_effect_ids: remaining, retry_safety: "unsafe", human_handoff: true },
				humanStderr: [`${plan.command} outcome unknown: inspect state or request human handoff; do not retry automatically`],
				events: [...events, `${effectId}.unknown`, `${plan.command}.handoff-required`],
				completedEffectIds: completed,
				remainingEffectIds: remaining,
			}
		}
		return {
			...decision,
			domainOutcome: "failed",
			failureClass: "internal",
			causeCode: "INTERNAL_EFFECT_NOT_OBSERVED",
			message: `${effectId} returned without an observable change`,
			transactionState: "unknown",
			guidance: RECOVER,
			repairAction: "run repair-lab recover; do not retry automatically",
			stationLabel: "repair-lab.effect-not-observed",
			result: { result: "effect-not-observed", station_id: "repair-lab.effect-not-observed", transaction_state: "unknown", completed_effect_ids: completed, remaining_effect_ids: remaining },
			humanStderr: [`${plan.command} failed: ${effectId} was not observed; run repair-lab recover`],
			events: [...events, `${effectId}.not-observed`],
			completedEffectIds: completed,
			remainingEffectIds: remaining,
		}
	}
	const result: Record<string, unknown> = { result: plan.label.result, station_id: plan.label.success, transaction_state: "completed", completed_effect_ids: completed, remaining_effect_ids: [] }
	if (plan.identity === "repair-lab.repair-retry") Object.assign(result, { retry_count: retryCount, retry_safety: "safe", automatic_retry_limit: 1, retry_delay_milliseconds: RETRY_DELAY_MS })
	if (plan.identity === "repair-lab.repair") result.repair_is_authorized = true
	return {
		...decision,
		message: retryCount > 0 ? `${plan.command} completed after one bounded retry` : `${plan.command} completed`,
		transactionState: "completed",
		stationLabel: plan.label.success,
		result,
		humanStdout: plan.humanCompleted,
		humanStderr: plan.identity === "repair-lab.repair-retry" ? ["retry: one permitted transient retry after bounded delay"] : [],
		events: [...events, plan.events.completed],
		completedEffectIds: completed,
	}
}

function decideMutation(runtime: Runtime, request: Request, key: "apply" | "repair" | "repair-retry", runIdentity: string): Decision {
	const declaration = declarationForRoute(key)
	const plan: MutationPlan = { ...PLANS[key], identity: declaration.identity, command: declaration.word }
	const decision = base(key)
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const { value: resource, bytes } = runtime.readResource()
	const admitted = admitMutation(runtime, request, plan, decision, resource, bytes)
	if ("refused" in admitted) return admitted.refused
	let retryCount = 0
	try {
		runtime.probeStorage(1)
	} catch (error) {
		if (!(error instanceof TransientLock)) throw error
		if (key !== "repair-retry") return busy(decision, plan, 0)
		sleepMilliseconds(RETRY_DELAY_MS)
		retryCount = 1
		try {
			runtime.probeStorage(2)
		} catch (again) {
			if (!(again instanceof TransientLock)) throw again
			return busy(decision, plan, 1)
		}
	}
	// Step 10 (brief 12, 3.5) after the storage probe (step 9): the preview's expected effects must equal the route's
	// computed plan; for repair-retry this is the content match that binds the preview without an argv id (B1).
	const bound = admitted.preview.expected_effect_ids
	if (bound.length !== plan.plan.length || bound.some((id, index) => id !== plan.plan[index])) return admitted.missing("mismatch").refused
	return executePlan(runtime, plan, admitted.preview, decision, runIdentity, retryCount)
}

// Recovery observation (O1 Candidate A, D3). Each effect of the consumed preview's plan is classified from
// independently observed bytes against the observation tuple its intent recorded: a resource effect is completed when
// the resource digest equals the expected digest, remaining when it equals the pre-image digest; effect.write-journal is
// completed when an event frame in the valid prefix carries the expected payload digest. An effect with no intent is
// remaining under a complete scan and uncertain under an incomplete one; more than one scoped intent is contradictory
// evidence. Completed bookkeeping frames are never consulted.
type Classification = { completed: EffectId[]; remaining: EffectId[]; uncertain: EffectId[] }
type EffectState = "completed" | "remaining" | "uncertain"
type IntentEntry = Extract<JournalEntry["record"], { kind: "intent" }>

function classifyResourceEffect(intents: readonly IntentEntry[], complete: boolean, resourceSha256: string): EffectState {
	const intent = intents[0]
	if (intent === undefined) return complete ? "remaining" : "uncertain"
	if (intents.length > 1) return "uncertain"
	if (resourceSha256 === intent.expected_after_sha256) return "completed"
	return resourceSha256 === intent.before_sha256 ? "remaining" : "uncertain"
}

function classifyJournalEffect(intents: readonly IntentEntry[], events: readonly JournalEntry[], complete: boolean): EffectState {
	const intent = intents[0]
	if (intent === undefined) return complete ? "remaining" : "uncertain"
	if (intents.length > 1) return "uncertain"
	if (events.some((entry) => entry.payloadSha256 === intent.expected_after_sha256)) return "completed"
	return complete ? "remaining" : "uncertain"
}

function classifyPlan(scan: JournalScan, preview: Preview, resourceBytes: string): Classification {
	const complete = !scan.torn && !scan.exceedsScanBound
	const resourceSha256 = sha256Hex(resourceBytes)
	const classification: Classification = { completed: [], remaining: [], uncertain: [] }
	for (const effect of preview.expected_effect_ids) {
		const scoped = scan.entries.filter((entry) => entry.record.preview_id === preview.preview_id && entry.record.run === preview.consumed_by_run && entry.record.effect === effect)
		const intents = scoped.map((entry) => entry.record).filter((record): record is IntentEntry => record.kind === "intent")
		const state = effect === "effect.write-journal" ? classifyJournalEffect(intents, scoped.filter((entry) => entry.record.kind === "event"), complete) : classifyResourceEffect(intents, complete, resourceSha256)
		classification[state].push(effect)
	}
	return classification
}

function nothingPending(decision: Decision, resource: Resource, preview: Preview | null, observed: Classification): Decision {
	return {
		...decision,
		message: "recovery: nothing pending",
		retryable: true,
		stationLabel: "repair-lab.nothing-pending",
		result: { result: "nothing-pending", station_id: "repair-lab.nothing-pending", transaction_state: "unchanged", observed_resource_revision: resource.revision, consumed_preview_id: preview === null ? null : preview.preview_id, observed_completed_effect_ids: observed.completed, not_applied_effect_ids: observed.remaining },
		humanStdout: ["recovery: nothing pending", "next: inspect"],
		events: ["recovery.started", "recovery.nothing-pending"],
	}
}

const PARTIAL_MESSAGE = "handoff required: a known subset of effects completed and the remaining effects are known not applied; no safe automatic action is available"
const UNKNOWN_MESSAGE = "handoff required: the remaining effect outcome is unknown; no safe automatic action is available"

function partialHandoff(decision: Decision, resource: Resource, observed: Classification): Decision {
	return {
		...decision,
		domainOutcome: "failed",
		failureClass: "domain",
		causeCode: "DOMAIN_RECOVERY_PARTIAL_HANDOFF",
		message: PARTIAL_MESSAGE,
		transactionState: "partially-completed",
		guidance: HANDOFF,
		repairAction: "inspect the known partial effects before separately authorized recovery",
		stationLabel: "repair-lab.partial-handoff",
		result: { result: "partial-handoff", station_id: "repair-lab.partial-handoff", transaction_state: "partially-completed", next_action: null, fabricated_action: false, completed_effect_ids: observed.completed, remaining_effect_ids: observed.remaining, resource_revision: resource.revision, human_handoff: true },
		humanStderr: [PARTIAL_MESSAGE],
		events: ["recovery.started", "recovery.partial-handoff"],
		completedEffectIds: observed.completed,
		remainingEffectIds: observed.remaining,
	}
}

function unknownHandoff(decision: Decision, resource: Resource, preview: Preview, observed: Classification, inventoryComplete: boolean): Decision {
	const remaining = preview.expected_effect_ids.filter((id) => !observed.completed.includes(id))
	return {
		...decision,
		domainOutcome: "unknown",
		failureClass: "domain",
		causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED",
		message: UNKNOWN_MESSAGE,
		transactionState: "unknown",
		guidance: HANDOFF,
		stationLabel: "repair-lab.required-handoff",
		result: { result: "handoff-required", station_id: "repair-lab.required-handoff", transaction_state: "unknown", next_action: null, fabricated_action: false, completed_effect_ids: observed.completed, remaining_effect_ids: remaining, resource_revision: resource.revision, human_handoff: true },
		humanStderr: [UNKNOWN_MESSAGE],
		events: ["recovery.started", "recovery.handoff-required"],
		completedEffectIds: observed.completed,
		remainingEffectIds: remaining,
		inventoryComplete,
	}
}

// Recovery reads the consumed preview's bound plan and classifies it from independently observed bytes; it never
// repairs. A scan cut at its bound always hands off with an incomplete inventory.
function decideRecover(runtime: Runtime): Decision {
	const decision = base("recover")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const { value: resource, bytes } = runtime.readResource()
	const scan = readJournalForReader(runtime)
	const preview = runtime.readPreview()
	if (preview === null || !preview.consumed) return nothingPending(decision, resource, null, { completed: [], remaining: [], uncertain: [] })
	const observed = classifyPlan(scan, preview, bytes)
	if (scan.exceedsScanBound || observed.uncertain.length > 0) return unknownHandoff(decision, resource, preview, observed, !scan.exceedsScanBound)
	if (resolvedPlan(observed)) return nothingPending(decision, resource, preview, observed)
	return partialHandoff(decision, resource, observed)
}

// Facts for a real unexpected exception (brief 12, section 5): W1 when no durable write was attempted (unchanged),
// W2 when one was and nothing established its outcome (unknown; read-back may not downgrade it). W2 keeps the presented
// outcome failed with the existing domain cause INTERNAL_EFFECT_OUTCOME_UNKNOWN so its tuple is distinct from W1
// (coordinator ruling, implementation01/w2-owner-resolution.md; brief 12's INTERNAL_UNEXPECTED binding collided).
function unexpected(route: CommandRoute, runtime: Runtime, error: unknown): Decision {
	const decision = base(route)
	const command = declarationForRoute(route).word
	const detail = (error instanceof Error ? error.message : String(error)).slice(0, 120)
	if (runtime.facts.durableWriteAttempted) {
		const completed = [...runtime.facts.completed]
		const remaining = [...runtime.facts.remaining]
		return {
			...decision,
			domainOutcome: "failed",
			failureClass: "internal",
			causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN",
			message: "a durable write was attempted and its outcome is not established",
			transactionState: "unknown",
			guidance: RECOVER,
			repairAction: "run repair-lab recover; do not retry automatically",
			stationLabel: "repair-lab.write-outcome-unknown",
			result: { result: "write-outcome-unknown", station_id: "repair-lab.write-outcome-unknown", transaction_state: "unknown", completed_effect_ids: completed, remaining_effect_ids: remaining, detail },
			humanStderr: [`${command} failed: a durable write was attempted and its outcome is not established; run repair-lab recover`],
			events: [`${command}.write-outcome-unknown`],
			completedEffectIds: completed,
			remainingEffectIds: remaining,
		}
	}
	return {
		...decision,
		domainOutcome: "failed",
		failureClass: "internal",
		causeCode: "INTERNAL_UNEXPECTED",
		message: "unexpected internal error",
		guidance: INSPECT,
		repairAction: "inspect; report the diagnostics file",
		stationLabel: "repair-lab.internal-unexpected",
		result: { result: "internal-unexpected", station_id: "repair-lab.internal-unexpected", transaction_state: "unchanged", detail },
		humanStderr: [`${command} failed: unexpected internal error`],
		events: [`${command}.internal-unexpected`],
	}
}

function dispatchDecision(runtime: Runtime, request: ParsedRequest, runIdentity: string): Decision {
	switch (request.route) {
		case "status":
			return decideStatus(runtime)
		case "inspect":
		case "inspect-diagnostics":
			return decideInspect(runtime, request)
		case "preview":
			return decidePreview(runtime)
		case "repair-preview":
			return decideRepairPreview(runtime)
		case "apply":
		case "repair":
		case "repair-retry":
			return decideMutation(runtime, request, request.route, runIdentity)
		case "recover":
			return decideRecover(runtime)
	}
}

export function decide(runtime: Runtime, request: ParsedRequest, runIdentity: string): Decision {
	let release: (() => void) | undefined
	try {
		if (["preview", "repair-preview", "apply", "repair", "repair-retry"].includes(request.route)) release = runtime.acquireJournalLock(runIdentity)
		return dispatchDecision(runtime, request, runIdentity)
	} catch (error) {
		if (error instanceof JournalLockHeld) return { ...refusal(base(request.route), "domain", error.causeCode, JOURNAL_LOCK_HELD_REASON, JOURNAL_LOCK_HELD_REPAIR_ACTION, "repair-lab.journal-lock-held", `${declarationForRoute(request.route).word} refused: ${JOURNAL_LOCK_HELD_REASON}`), guidance: HANDOFF, result: { result: "journal-lock-held", human_handoff: true } }
		// An input refusal is only an "unchanged" fact before the first durable write; after one it is W2 (section 5).
		if (error instanceof RuntimeRefusal && !runtime.facts.durableWriteAttempted) {
			return inputRefusal(base(request.route), error, declarationForRoute(request.route).word)
		}
		return unexpected(request.route, runtime, error)
	} finally {
		release?.()
	}
}
