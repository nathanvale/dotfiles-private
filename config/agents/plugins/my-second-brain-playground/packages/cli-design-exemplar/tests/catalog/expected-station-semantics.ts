import type { CommandSummary, FailureClass, WireTransactionState } from "../../src/command-contract.ts"
import type { PublicStation } from "../../src/station-catalogue.ts"

// B1 independent oracle (CDS-BC-1; accepted C0 packet, PublicStation and template rules). Every expected public
// value below is authored from the accepted C0 and TC-D6 meanings; nothing is read from STATIONS, stationIdOf, the
// renderer, a production guidance helper or a process envelope. The tuple inventory is test-owned and literal: the
// compiler rejects a tuple outside the production vocabulary, but production never supplies an expected value.
// Marked independent oracle: a dedupe pass must not hoist these tables into the production catalogue.

type Outcome = "success" | "refused" | "failed"
export type Tuple = readonly [commandIdentity: PublicStation["commandIdentity"], outcome: PublicStation["outcome"], causeCode: PublicStation["causeCode"]]

// Read-only identities carry the inspect stance; every other identity is repository-local (brief 12, section 3.4).
const READ_ONLY = new Set<string>(["repair-lab.dispatch", "repair-lab.help", "repair-lab.discovery", "repair-lab.command-discovery", "repair-lab.status", "repair-lab.inspect", "repair-lab.inspect-diagnostics"])
// Causes whose accepted guidance arm is a handoff (C0 cause table plus the exemplar's admitted domain causes).
const HANDOFF_CAUSES = new Set<string>(["DOMAIN_AUTHORITY_REQUIRED", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "DOMAIN_RECOVERY_PARTIAL_HANDOFF", "DOMAIN_PRIOR_RUN_PENDING", "DOMAIN_JOURNAL_LOCK_HELD", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "INTERNAL_EFFECT_NOT_OBSERVED", "INTERNAL_UNEXPECTED", "INTERNAL_RESULT_UNCHANGED", "INTERNAL_RESULT_COMPLETED", "INTERNAL_RESULT_PARTIAL", "INTERNAL_RESULT_UNKNOWN"])
const FAILURE_BY_CAUSE: Readonly<Record<string, FailureClass>> = {
	USAGE_INVALID_INVOCATION: "usage",
	USAGE_UNKNOWN_COMMAND: "usage",
	SCHEMA_INVALID_INPUT: "schema",
	DOMAIN_PRECONDITION_UNMET: "domain",
	DOMAIN_AUTHORITY_REQUIRED: "domain",
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: "domain",
	DOMAIN_RECOVERY_PARTIAL_HANDOFF: "domain",
	DOMAIN_JOURNAL_LOCK_HELD: "domain",
	DOMAIN_PRIOR_RUN_PENDING: "domain",
	DOMAIN_JOURNAL_LIMIT_REACHED: "domain",
	TRANSIENT_NOT_STARTED: "transient",
	INTERNAL_PREPARATION: "internal",
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: "internal",
	INTERNAL_EFFECT_NOT_OBSERVED: "internal",
	INTERNAL_UNEXPECTED: "internal",
	INTERNAL_RESULT_UNCHANGED: "internal",
	INTERNAL_RESULT_COMPLETED: "internal",
	INTERNAL_RESULT_PARTIAL: "internal",
	INTERNAL_RESULT_UNKNOWN: "internal",
}
const EXIT_BY_CLASS = { usage: 2, domain: 3, schema: 4, transient: 75, internal: 1 } as const
// Fixture-labelled success stations (station_catalog, brief 12 section 3.3).
const FIXTURE_LABELS: Readonly<Record<string, string>> = {
	'["repair-lab.status","success","SUCCESS_UNCHANGED"]': "repair-lab.healthy",
	'["repair-lab.inspect","success","SUCCESS_UNCHANGED"]': "repair-lab.inspect",
	'["repair-lab.preview","success","SUCCESS_UNCHANGED"]': "repair-lab.preview",
	'["repair-lab.apply","success","SUCCESS_COMPLETED"]': "repair-lab.authorized-apply",
	'["repair-lab.repair","success","SUCCESS_COMPLETED"]': "repair-lab.authorized-repair",
	'["repair-lab.repair-retry","success","SUCCESS_COMPLETED"]': "repair-lab.permitted-transient-retry",
	'["repair-lab.inspect-diagnostics","success","SUCCESS_UNCHANGED"]': "repair-lab.secret-marker",
}

// The complete expected tuple inventory: 86 historical stations, the five B1 command-discovery stations and the ten O1
// Candidate A stations (ticket freeze 2026-09-15): the three accepted causes on their reachable identities plus the
// D6-c partial fallback that the partially-completed recover facts make reachable.
const EXPECTED_TUPLES = [
	["repair-lab.status", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.inspect", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.preview", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.apply", "success", "SUCCESS_COMPLETED"],
	["repair-lab.apply", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"],
	["repair-lab.apply", "refused", "DOMAIN_AUTHORITY_REQUIRED"],
	["repair-lab.repair", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.repair", "success", "SUCCESS_COMPLETED"],
	["repair-lab.repair-retry", "success", "SUCCESS_COMPLETED"],
	["repair-lab.recover", "failed", "DOMAIN_RECOVERY_HANDOFF_REQUIRED"],
	["repair-lab.inspect", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.inspect-diagnostics", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.help", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.discovery", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.help", "refused", "USAGE_UNKNOWN_COMMAND"],
	["repair-lab.help", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.dispatch", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.dispatch", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.status", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.discovery", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.inspect", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.preview", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.apply", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.repair", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.recover", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.inspect", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.inspect-diagnostics", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.repair-retry", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.repair", "refused", "TRANSIENT_NOT_STARTED"],
	["repair-lab.repair-retry", "refused", "TRANSIENT_NOT_STARTED"],
	["repair-lab.apply", "failed", "INTERNAL_EFFECT_NOT_OBSERVED"],
	["repair-lab.recover", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.inspect-diagnostics", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.repair-retry", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.status", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.inspect", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.inspect-diagnostics", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.preview", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.apply", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.repair", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.repair-retry", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.recover", "failed", "INTERNAL_UNEXPECTED"],
	["repair-lab.repair", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"],
	["repair-lab.repair-retry", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"],
	["repair-lab.status", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.status", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.inspect-diagnostics", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.preview", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.preview", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.apply", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.repair", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.repair-retry", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.recover", "refused", "DOMAIN_PRECONDITION_UNMET"],
	["repair-lab.recover", "refused", "SCHEMA_INVALID_INPUT"],
	["repair-lab.repair", "refused", "DOMAIN_AUTHORITY_REQUIRED"],
	["repair-lab.repair-retry", "refused", "DOMAIN_AUTHORITY_REQUIRED"],
	["repair-lab.apply", "refused", "TRANSIENT_NOT_STARTED"],
	["repair-lab.repair", "failed", "INTERNAL_EFFECT_NOT_OBSERVED"],
	["repair-lab.repair-retry", "failed", "INTERNAL_EFFECT_NOT_OBSERVED"],
	["repair-lab.help", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.discovery", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.discovery", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.status", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.status", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.inspect", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.inspect", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.inspect-diagnostics", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.inspect-diagnostics", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.preview", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.preview", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.apply", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.apply", "failed", "INTERNAL_RESULT_COMPLETED"],
	["repair-lab.apply", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.apply", "failed", "INTERNAL_RESULT_UNKNOWN"],
	["repair-lab.repair", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.repair", "failed", "INTERNAL_RESULT_COMPLETED"],
	["repair-lab.repair", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.repair", "failed", "INTERNAL_RESULT_UNKNOWN"],
	["repair-lab.repair-retry", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.repair-retry", "failed", "INTERNAL_RESULT_COMPLETED"],
	["repair-lab.repair-retry", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN"],
	["repair-lab.recover", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.recover", "refused", "INTERNAL_PREPARATION"],
	["repair-lab.recover", "failed", "INTERNAL_RESULT_UNKNOWN"],
	// B1: the accepted C0 built-in selected-command discovery identity.
	["repair-lab.command-discovery", "success", "SUCCESS_UNCHANGED"],
	["repair-lab.command-discovery", "refused", "USAGE_UNKNOWN_COMMAND"],
	["repair-lab.command-discovery", "refused", "USAGE_INVALID_INVOCATION"],
	["repair-lab.command-discovery", "failed", "INTERNAL_RESULT_UNCHANGED"],
	["repair-lab.command-discovery", "refused", "INTERNAL_PREPARATION"],
	// O1 Candidate A (ticket freeze 2026-09-15): journal scan bound and unresolved prior run on every writer identity,
	// known partial completion on recover, and the D6-c partial fallback of recover's new partially-completed facts.
	["repair-lab.preview", "refused", "DOMAIN_JOURNAL_LIMIT_REACHED"],
	["repair-lab.apply", "refused", "DOMAIN_JOURNAL_LIMIT_REACHED"],
	["repair-lab.repair", "refused", "DOMAIN_JOURNAL_LIMIT_REACHED"],
	["repair-lab.repair-retry", "refused", "DOMAIN_JOURNAL_LIMIT_REACHED"],
	["repair-lab.preview", "refused", "DOMAIN_PRIOR_RUN_PENDING"],
	["repair-lab.apply", "refused", "DOMAIN_PRIOR_RUN_PENDING"],
	["repair-lab.repair", "refused", "DOMAIN_PRIOR_RUN_PENDING"],
	["repair-lab.repair-retry", "refused", "DOMAIN_PRIOR_RUN_PENDING"],
	["repair-lab.recover", "failed", "DOMAIN_RECOVERY_PARTIAL_HANDOFF"],
	["repair-lab.recover", "failed", "INTERNAL_RESULT_PARTIAL"],
	["repair-lab.preview", "refused", "DOMAIN_JOURNAL_LOCK_HELD"],
	["repair-lab.apply", "refused", "DOMAIN_JOURNAL_LOCK_HELD"],
	["repair-lab.repair", "refused", "DOMAIN_JOURNAL_LOCK_HELD"],
	["repair-lab.repair-retry", "refused", "DOMAIN_JOURNAL_LOCK_HELD"],
] as const satisfies readonly Tuple[]
export const EXPECTED_STATION_COUNT = 105

// Expected wire guidance (accepted C0 template rule; TC-D6 one meaning per derived identity). Each string below is
// the literal next action, handoff reason or repair action the CLI must emit and discovery must publish for that
// cause; the two command-specific meanings follow. Authored from the accepted contract and the fixture's recovery
// intent, never read from the guidance owner. Literal templates: no admitted substitution token is used.
export const EXPECTED_INSPECT = "repair-lab inspect"
const HELP = "repair-lab --help"
const RETRY = "retry the same command after 25 ms"
const FALLBACK = "Inspect trusted effect evidence before continuing."
const RECOVER = "run repair-lab recover; do not retry automatically"
type ExpectedGuidance = { readonly nextAction: string; readonly repairAction: string | null } | { readonly handoffReason: string; readonly repairAction: string }
const EXPECTED_GUIDANCE_BY_CAUSE: Readonly<Record<string, ExpectedGuidance>> = {
	SUCCESS_UNCHANGED: { nextAction: EXPECTED_INSPECT, repairAction: null },
	SUCCESS_COMPLETED: { nextAction: EXPECTED_INSPECT, repairAction: null },
	USAGE_INVALID_INVOCATION: { nextAction: HELP, repairAction: "Correct the command arguments or run repair-lab --help" },
	USAGE_UNKNOWN_COMMAND: { nextAction: HELP, repairAction: "Select a canonical command identity from availablePaths or run repair-lab --help" },
	SCHEMA_INVALID_INPUT: { nextAction: EXPECTED_INSPECT, repairAction: "Restore a resource that matches the resource schema, then inspect" },
	DOMAIN_PRECONDITION_UNMET: { nextAction: EXPECTED_INSPECT, repairAction: "provide a readable state file inside the fixture root, then inspect" },
	DOMAIN_AUTHORITY_REQUIRED: { handoffReason: "Obtain the named authority before continuing.", repairAction: "Inspect, then supply --authorize fixture-authority with a fresh preview, or hand off" },
	TRANSIENT_NOT_STARTED: { nextAction: RETRY, repairAction: RETRY },
	INTERNAL_PREPARATION: { nextAction: EXPECTED_INSPECT, repairAction: FALLBACK },
	INTERNAL_RESULT_UNCHANGED: { handoffReason: FALLBACK, repairAction: FALLBACK },
	INTERNAL_RESULT_COMPLETED: { handoffReason: FALLBACK, repairAction: FALLBACK },
	INTERNAL_RESULT_UNKNOWN: { handoffReason: FALLBACK, repairAction: FALLBACK },
	INTERNAL_RESULT_PARTIAL: { handoffReason: FALLBACK, repairAction: FALLBACK },
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: { handoffReason: "handoff required: the remaining effect outcome is unknown; no safe automatic action is available", repairAction: "Inspect the failure before continuing." },
	// O1 Candidate A (ticket freeze 2026-09-15): the three accepted causes' literal guidance.
	DOMAIN_RECOVERY_PARTIAL_HANDOFF: { handoffReason: "handoff required: a known subset of effects completed and the remaining effects are known not applied; no safe automatic action is available", repairAction: "Inspect the known partial effects before separately authorized recovery" },
	DOMAIN_JOURNAL_LOCK_HELD: { handoffReason: "state/journal.lock already exists; inspect its owner and resource state before manual removal", repairAction: "Inspect state/journal.lock and resource state; remove the lock manually only after confirming its owner is stopped. Do not retry automatically." },
	DOMAIN_PRIOR_RUN_PENDING: { handoffReason: "a prior run's consumed plan has unresolved effects; recover before previewing or applying again", repairAction: RECOVER },
	DOMAIN_JOURNAL_LIMIT_REACHED: { nextAction: EXPECTED_INSPECT, repairAction: "Inspect, then archive the journal manually; nothing is rotated or pruned automatically" },
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: { handoffReason: "a durable write was attempted and its outcome is not established", repairAction: RECOVER },
	INTERNAL_EFFECT_NOT_OBSERVED: { handoffReason: "an effect returned without an observable change", repairAction: RECOVER },
	INTERNAL_UNEXPECTED: { handoffReason: "unexpected internal error", repairAction: "inspect; report the diagnostics file" },
}
// Command-specific meanings: a successful inspect leads to a preview; a mutating route's unmet precondition (stale,
// consumed or missing preview, unreadable input) is repaired by inspecting current state and previewing again.
const MUTATING = new Set<string>(["repair-lab.preview", "repair-lab.apply", "repair-lab.repair", "repair-lab.repair-retry"])
export function expectedGuidance(commandIdentity: string, causeCode: string): { readonly guidance: PublicStation["guidance"]; readonly repairAction: string | null } {
	const expected = commandIdentity === "repair-lab.inspect" && causeCode === "SUCCESS_UNCHANGED" ? { nextAction: "repair-lab apply --preview", repairAction: null }
		: causeCode === "DOMAIN_PRECONDITION_UNMET" && MUTATING.has(commandIdentity) ? { nextAction: EXPECTED_INSPECT, repairAction: "inspect current state and preview again" }
		: EXPECTED_GUIDANCE_BY_CAUSE[causeCode]
	if (expected === undefined) throw new Error(`test oracle lacks guidance for ${causeCode}`)
	if ("handoffReason" in expected) return { guidance: { handoff: { owner: "operator", reason: expected.handoffReason, inspect: [EXPECTED_INSPECT] } }, repairAction: expected.repairAction }
	if (HANDOFF_CAUSES.has(causeCode)) throw new Error(`test oracle expects a handoff for ${causeCode}`)
	return { guidance: { nextAction: expected.nextAction }, repairAction: expected.repairAction }
}

export const identityOf = (tuple: Tuple): string => JSON.stringify(tuple)

function transactionStateOf(outcome: Outcome, causeCode: string): WireTransactionState {
	if (outcome === "success") return causeCode === "SUCCESS_COMPLETED" ? "completed" : "unchanged"
	if (causeCode === "INTERNAL_RESULT_COMPLETED") return "completed"
	if (causeCode === "INTERNAL_RESULT_PARTIAL" || causeCode === "DOMAIN_RECOVERY_PARTIAL_HANDOFF") return "partially-completed"
	if (causeCode === "DOMAIN_RECOVERY_HANDOFF_REQUIRED" || causeCode === "INTERNAL_EFFECT_OUTCOME_UNKNOWN" || causeCode === "INTERNAL_EFFECT_NOT_OBSERVED" || causeCode === "INTERNAL_RESULT_UNKNOWN") return "unknown"
	return "unchanged"
}

function triggerOf(identity: string, outcome: Outcome, causeCode: string): string {
	const label = FIXTURE_LABELS[identity]
	return label === undefined ? `The command reports ${outcome} with ${causeCode}.` : `Fixture scenario ${label}.`
}

function expectedStationFromAcceptedSemantics(tuple: Tuple): PublicStation {
	const [commandIdentity, outcome, causeCode] = tuple
	const identity = identityOf(tuple)
	const retryable = causeCode === "TRANSIENT_NOT_STARTED"
	const failureClass = outcome === "success" ? null : FAILURE_BY_CAUSE[causeCode]
	if (failureClass === undefined) throw new Error(`test oracle lacks a failure class for ${identity}`)
	return {
		commandIdentity,
		outcome,
		causeCode,
		failureClass,
		exitCode: failureClass === null ? 0 : EXIT_BY_CLASS[failureClass],
		effectClass: READ_ONLY.has(commandIdentity) ? "inspect" : "repository-local",
		transactionState: transactionStateOf(outcome, causeCode),
		retryable,
		retryDelayPolicy: retryable ? { kind: "bounded", minimumMilliseconds: 25, maximumMilliseconds: 25 } : { kind: "none" },
		trigger: triggerOf(identity, outcome, causeCode),
		...expectedGuidance(commandIdentity, causeCode),
		reachability: "required",
		unreachableRationale: null,
	}
}

export const EXPECTED_STATION_SEMANTICS: ReadonlyMap<string, PublicStation> = new Map(EXPECTED_TUPLES.map((tuple) => [identityOf(tuple), expectedStationFromAcceptedSemantics(tuple)]))

export function expectedStation(identity: string): PublicStation {
	const station = EXPECTED_STATION_SEMANTICS.get(identity)
	if (station === undefined) throw new Error(`test oracle lacks station semantics for ${identity}`)
	return station
}

export function expectedStationsFor(commandIdentity: string): readonly PublicStation[] {
	return EXPECTED_TUPLES.filter((tuple) => tuple[0] === commandIdentity).map((tuple) => expectedStation(identityOf(tuple)))
}

// The selected command whose discovery record the JSON and human tests pin literally (accepted C0 CommandSummary).
export const EXPECTED_APPLY_COMMAND: CommandSummary = { commandIdentity: "repair-lab.apply", route: ["apply"], effectClass: "repository-local", summary: "Apply a fresh preview with fixture-local authority" }
export const EXPECTED_COMMAND_DISCOVERY_COMMAND: CommandSummary = { commandIdentity: "repair-lab.command-discovery", route: ["--discover-command"], effectClass: "inspect", summary: "Describe the possible outcomes of one selected command" }
