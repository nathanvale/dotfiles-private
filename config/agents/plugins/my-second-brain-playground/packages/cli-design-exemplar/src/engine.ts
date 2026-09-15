import { type CauseCode, type CommandIdentity, type CommandRoute, declarationForRoute } from "./command-contract.ts"
import type { DomainOutcome, EffectId, ExecutionFacts, Guidance, JournalRecord, Preview, Resource, TransactionState } from "./model.ts"
import { RETRY_DELAY_MS, type Runtime, RuntimeRefusal, TransientLock } from "./runtime.ts"

// Pure policy over plain data plus the runtime seam: authority, preview matching, staleness, consumption order,
// unknown classification, retry policy, redaction and result shaping (brief 12, sections 3.3 through 3.5).

export const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i
export const REDACTED = "[REDACTED]"
export const FIXTURE_AUTHORITY = "fixture-authority"

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
}

export interface Request {
	route: CommandRoute
	statePath: string | undefined
	previewId: string | undefined
	authority: string | undefined
	automation: boolean
	includeDiagnostics: boolean
}

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

function base(commandIdentity: CommandIdentity, effectClass: Decision["effectClass"]): Decision {
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
			return { ...refusal(decision, "schema", error.causeCode, error.message, "restore a resource that matches the resource schema", "repair-lab.state-schema-invalid", `${command} refused: resource does not match the resource schema`), result: { result: "state-schema-invalid", station_id: "repair-lab.state-schema-invalid", transaction_state: "unchanged" }, events: ["input.schema-invalid"] }
		case "USAGE_INVALID_ARGUMENTS":
			return { ...refusal(decision, "usage", error.causeCode, error.message, "correct the arguments; run repair-lab --help", "repair-lab.usage", `${command} refused: ${error.message}`), guidance: INSPECT, result: null }
	}
}

function decideStatus(runtime: Runtime): Decision {
	const decision = base("repair-lab.status", "inspect")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource().value
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
	const identity = request.includeDiagnostics ? "repair-lab.inspect-diagnostics" : "repair-lab.inspect"
	const decision = base(identity, "inspect")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource(request.statePath).value
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
	const decision = base("repair-lab.preview", "repository-local")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource().value
	const previewId = `preview-${resource.status}-revision-${resource.revision}`
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
	const decision = base("repair-lab.repair", "repository-local")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource().value
	if (resource.status === "healthy") {
		return { ...refusal(decision, "domain", "DOMAIN_REPAIR_NOT_REQUIRED", "the derived index is present; nothing to repair", null, "repair-lab.repair-not-required", "repair refused: nothing to repair; inspect"), result: { result: "repair-not-required", station_id: "repair-lab.repair-not-required", transaction_state: "unchanged" }, events: ["repair.inspect.started", "repair.precondition.present"] }
	}
	const previewId = "repair-preview-missing-index"
	runtime.writePreview({ preview_id: previewId, kind: "repair", resource_revision: resource.revision, expected_effect_ids: REPAIR_PLAN, consumed: false })
	return {
		...refusal(decision, "domain", "DOMAIN_REPAIR_REQUIRED", "derived index is absent; inspect and authorize repair", "repair", "repair-lab.repairable-precondition", "repair required: derived index is absent; inspect and authorize repair"),
		guidance: { kind: "next-action", target: "repair-lab inspect" },
		result: { result: "repair-required", station_id: "repair-lab.repairable-precondition", transaction_state: "unchanged", repair_action: "repair", preview_effect_ids: REPAIR_PLAN, preview_id: previewId, repair_is_authorized: false },
		events: ["repair.inspect.started", "repair.precondition.missing", "repair.preview.ready"],
	}
}

interface MutationPlan {
	identity: "repair-lab.apply" | "repair-lab.repair" | "repair-lab.repair-retry"
	command: "apply" | "repair"
	kind: "apply" | "repair"
	plan: EffectId[]
	label: { success: string; result: string }
	events: { started: string; completed: string }
	humanCompleted: string[]
}

const PLANS: Record<"apply" | "repair" | "repair-retry", MutationPlan> = {
	apply: { identity: "repair-lab.apply", command: "apply", kind: "apply", plan: APPLY_PLAN, label: { success: "repair-lab.authorized-apply", result: "applied" }, events: { started: "apply.started", completed: "apply.completed" }, humanCompleted: ["apply: completed", `effects: ${APPLY_PLAN.join(", ")}`, "next: inspect"] },
	repair: { identity: "repair-lab.repair", command: "repair", kind: "repair", plan: REPAIR_PLAN, label: { success: "repair-lab.authorized-repair", result: "repair-applied" }, events: { started: "repair.apply.started", completed: "repair.apply.completed" }, humanCompleted: ["repair: completed", `effects: ${REPAIR_PLAN.join(", ")}`, "next: inspect"] },
	"repair-retry": { identity: "repair-lab.repair-retry", command: "repair", kind: "repair", plan: REPAIR_PLAN, label: { success: "repair-lab.permitted-transient-retry", result: "retried-once" }, events: { started: "repair.started", completed: "repair.completed" }, humanCompleted: ["repair: completed after one bounded retry", "next: inspect"] },
}

// Refusal precedence inside every effect-executing route (brief 12, 3.5). Returns the bound preview or a refusal.
interface Admitted {
	preview: Preview
	missing(reason: "absent" | "mismatch"): { refused: Decision }
}

function admitMutation(runtime: Runtime, request: Request, plan: MutationPlan, decision: Decision, resource: Resource): Admitted | { refused: Decision } {
	if (request.automation || request.authority !== FIXTURE_AUTHORITY) {
		return {
			refused: {
				...refusal(decision, "domain", "DOMAIN_AUTHORITY_MISSING", "fixture-local authority is required", `inspect, then supply --authorize ${FIXTURE_AUTHORITY} with a fresh preview, or hand off`, "repair-lab.prohibited-automation", `${plan.command} refused: fixture-local authority is required; inspect or hand off`),
				result: { result: "automation-refused", station_id: "repair-lab.prohibited-automation", transaction_state: "unchanged", effect_attempted: false, human_handoff: false },
				events: [`${plan.command}.authority-missing`, `${plan.command}.refused`],
			},
		}
	}
	const preview = runtime.readPreview()
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
	const plan = PLANS[key]
	const decision = base(plan.identity, "repository-local")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource().value
	const admitted = admitMutation(runtime, request, plan, decision, resource)
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

// A completion record is established only when the resource read back agrees with it (PR 184, thread 4003813581):
// the current revision equals the revision the record observed, and a repair plan also finds the index present.
// Journal claims the resource contradicts establish nothing; recovery then hands off rather than reporting success.
function establishedCompletions(journal: readonly JournalRecord[], preview: Preview, resource: Resource): EffectId[] {
	const statusAgrees = preview.kind !== "repair" || resource.status === "healthy"
	// Completed ids come only from completed records of the consumed preview's own run (F2): an earlier cycle's
	// records never satisfy a later preview's plan.
	return journal
		.filter((record): record is Extract<JournalRecord, { kind: "completed" }> => record.kind === "completed" && record.preview_id === preview.preview_id && record.run === preview.consumed_by_run)
		.filter((record) => statusAgrees && record.resource_revision === resource.revision)
		.map((record) => record.effect)
}

// Recovery reads the consumed preview's bound plan, the journal's completed records and the resource; it never repairs (brief 12, 8.1).
function decideRecover(runtime: Runtime): Decision {
	const decision = base("repair-lab.recover", "repository-local")
	if (runtime.faults.domain === "throw-internal") throw new Error("injected internal failure")
	const resource = runtime.readResource().value
	const preview = runtime.readPreview()
	const journal = runtime.readJournal()
	const completed = preview === null ? [] : establishedCompletions(journal, preview, resource)
	if (preview === null || !preview.consumed || preview.expected_effect_ids.every((id) => completed.includes(id))) {
		return { ...decision, message: "recovery: nothing pending", retryable: true, stationLabel: "repair-lab.nothing-pending", result: { result: "nothing-pending", station_id: "repair-lab.nothing-pending", transaction_state: "unchanged", observed_resource_revision: resource.revision }, humanStdout: ["recovery: nothing pending", "next: inspect"], events: ["recovery.started", "recovery.nothing-pending"] }
	}
	const remaining = preview.expected_effect_ids.filter((id) => !completed.includes(id))
	return {
		...decision,
		domainOutcome: "unknown",
		failureClass: "domain",
		causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED",
		message: "handoff required: the remaining effect outcome is unknown; no safe automatic action is available",
		transactionState: "unknown",
		guidance: HANDOFF,
		stationLabel: "repair-lab.required-handoff",
		result: { result: "handoff-required", station_id: "repair-lab.required-handoff", transaction_state: "unknown", next_action: null, fabricated_action: false, completed_effect_ids: completed, remaining_effect_ids: remaining, resource_revision: resource.revision, human_handoff: true },
		humanStderr: ["handoff required: the remaining effect outcome is unknown; no safe automatic action is available"],
		events: ["recovery.started", "recovery.handoff-required"],
		completedEffectIds: completed,
		remainingEffectIds: remaining,
	}
}

// Facts for a real unexpected exception (brief 12, section 5): W1 when no durable write was attempted (unchanged),
// W2 when one was and nothing established its outcome (unknown; read-back may not downgrade it). W2 keeps the presented
// outcome failed with the existing domain cause INTERNAL_EFFECT_OUTCOME_UNKNOWN so its tuple is distinct from W1
// (coordinator ruling, implementation01/w2-owner-resolution.md; brief 12's INTERNAL_UNEXPECTED binding collided).
function unexpected(route: CommandRoute, runtime: Runtime, error: unknown): Decision {
	const declaration = declarationForRoute(route)
	const decision = base(declaration.identity, declaration.effectClass)
	const command = declaration.word
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

export function decide(runtime: Runtime, request: Request, runIdentity: string): Decision {
	try {
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
	} catch (error) {
		// An input refusal is only an "unchanged" fact before the first durable write; after one it is W2 (section 5).
		if (error instanceof RuntimeRefusal && !runtime.facts.durableWriteAttempted) {
			const declaration = declarationForRoute(request.route)
			return inputRefusal(base(declaration.identity, declaration.effectClass), error, declaration.word)
		}
		return unexpected(request.route, runtime, error)
	}
}
