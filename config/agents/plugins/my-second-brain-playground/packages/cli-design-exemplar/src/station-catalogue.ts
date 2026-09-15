import { stationIdOfRow } from "./branch-station-catalog.ts"
import { CAUSE, causeRule, type CommandIdentity, type CommandSummary, type ExitCode, exitFor, type FailureClass, type Handoff, HELP_PATH, INSPECT_ACTION, type Outcome, STATIONS, type StationRow, type WireCauseCode, type WireTransactionState } from "./command-contract.ts"
import type { EffectClass } from "./model.ts"
import { RETRY_DELAY_MS } from "./runtime.ts"

// B1 typed catalogue (CDS-BC-1): one readonly STATIONS owner supplies every public station, the selected-command
// discovery data and the enforcement inputs. Identity stays the JSON tuple [commandIdentity, outcome, causeCode];
// no wire station ID is added. Discovery is descriptive: possible outcomes only, never live state, approval or
// replay authority (accepted C0 packet, PublicStation and CommandDiscoveryData).

export type Reachability = "required" | "declared-unreachable"
export type RetryDelayPolicy = { readonly kind: "none" } | { readonly kind: "bounded"; readonly minimumMilliseconds: number; readonly maximumMilliseconds: number }
export type PublicGuidance = { readonly nextAction: string } | { readonly handoff: Handoff }
export type PublicStation = {
	readonly commandIdentity: CommandIdentity
	readonly outcome: Outcome
	readonly causeCode: WireCauseCode
	readonly failureClass: FailureClass | null
	readonly exitCode: ExitCode
	readonly effectClass: EffectClass
	readonly transactionState: WireTransactionState
	readonly retryable: boolean
	readonly retryDelayPolicy: RetryDelayPolicy
	readonly trigger: string
	readonly guidance: PublicGuidance
	readonly repairAction: string | null
	readonly reachability: Reachability
	readonly unreachableRationale: string | null
}
export type CommandDiscoveryData = { readonly command: CommandSummary; readonly semantics: "possible-outcomes"; readonly stations: readonly PublicStation[] }

// Internal entry: the public record plus its derived identity and the pointer to independent process evidence. The
// pointer describes where the evidence lives; it is not an independently authored oracle (C0).
export type CatalogueDeclaration = PublicStation & { readonly identity: string; readonly independentObservable: string }
export type CatalogueObservation = { readonly identity: string; readonly station: PublicStation }
export type CatalogueMode = "strict-new" | "gradual-existing"
export type CatalogueFindingCode = "STATION_UNREACHED" | "STATION_UNDECLARED" | "STATION_FIELD_MISMATCH" | "STATION_DUPLICATE_IDENTITY" | "STATION_UNREACHABLE_OBSERVED"
export type CatalogueFinding = { readonly code: CatalogueFindingCode; readonly identity: string; readonly field?: string }
// Gradual existing-project adoption never claims full qualification; only a clean strict run does.
export type CatalogueReport = { readonly mode: CatalogueMode; readonly findings: readonly CatalogueFinding[]; readonly fullQualification: boolean }

// Wire guidance owner (accepted C0 template rule, control-contract-evolution.md lines 665-674): one truthful, stable
// next action or handoff plus repair action per derived station identity. The CLI writer emits exactly these strings
// and PublicStation publishes the same template, so discovery reproduces real output. Templates are literal: no
// admitted substitution token is needed here, and an unavailable value such as a preview id is never embedded;
// conservative read-only inspection guidance is preferred. Every handoff inspects through the public read-only route.
export type WireGuidance = { readonly guidance: PublicGuidance; readonly repairAction: string | null }
const RETRY_ACTION = `retry the same command after ${RETRY_DELAY_MS} ms`
const FALLBACK_ACTION = "Inspect trusted effect evidence before continuing."
const RECOVER_ACTION = "run repair-lab recover; do not retry automatically"
const USAGE_ACTION = `Correct the command arguments or run ${HELP_PATH}`
// O1 Candidate B lock refusal wording: the engine's envelope message and human line read these same two strings, so the
// exception carries only its cause identity and no second copy of the wording exists.
export const JOURNAL_LOCK_HELD_REASON = "state/journal.lock already exists; inspect its owner and resource state before manual removal"
export const JOURNAL_LOCK_HELD_REPAIR_ACTION = "Inspect state/journal.lock and resource state; remove the lock manually only after confirming its owner is stopped. Do not retry automatically."
const next = (nextAction: string, repairAction: string | null): WireGuidance => ({ guidance: { nextAction }, repairAction })
const handoff = (reason: string, repairAction: string): WireGuidance => ({ guidance: { handoff: { owner: "operator", reason, inspect: [INSPECT_ACTION] } }, repairAction })
// Total over the cause owner so an unhandled cause is a compiler error; unreachable causes restate the C0 table.
const GUIDANCE_BY_CAUSE: Readonly<Record<WireCauseCode, WireGuidance>> = {
	SUCCESS_UNCHANGED: next(INSPECT_ACTION, null),
	SUCCESS_COMPLETED: next(INSPECT_ACTION, null),
	USAGE_INVALID_INVOCATION: next(HELP_PATH, USAGE_ACTION),
	USAGE_UNKNOWN_COMMAND: next(HELP_PATH, `Select a canonical command identity from availablePaths or run ${HELP_PATH}`),
	SCHEMA_INVALID_INPUT: next(INSPECT_ACTION, "Restore a resource that matches the resource schema, then inspect"),
	SCHEMA_UNSUPPORTED_CONTRACT: next(INSPECT_ACTION, "Select or produce a contract 2.0.0 document; no adaptation is performed"),
	DOMAIN_PRECONDITION_UNMET: next(INSPECT_ACTION, "Inspect the reported precondition and repair it before running the command again"),
	DOMAIN_AUTHORITY_REQUIRED: handoff("Obtain the named authority before continuing.", "Inspect, then supply --authorize fixture-authority with a fresh preview, or hand off"),
	TRANSIENT_NOT_STARTED: next(RETRY_ACTION, RETRY_ACTION),
	TRANSIENT_ATTEMPT_UNCHANGED: next(RETRY_ACTION, RETRY_ACTION),
	DOMAIN_DEADLINE_BEFORE_START: next(INSPECT_ACTION, "Inspect the deadline and input, then explicitly decide a new run"),
	DOMAIN_DEADLINE_UNCHANGED: next(INSPECT_ACTION, "Inspect the deadline and input, then explicitly decide a new run"),
	DOMAIN_DEADLINE_COMPLETED: handoff("The deadline passed after the effects completed.", "Inspect the confirmed completed effects before any new run"),
	DOMAIN_DEADLINE_PARTIAL: handoff("The deadline passed after a known subset of effects completed.", "Inspect the known partial effects before separately authorized recovery"),
	DOMAIN_DEADLINE_UNKNOWN: handoff("The deadline passed with uncertain effects.", "Inspect the uncertain effects before any retry"),
	INTERNAL_PREPARATION: next(INSPECT_ACTION, FALLBACK_ACTION),
	INTERNAL_RESULT_UNCHANGED: handoff(FALLBACK_ACTION, FALLBACK_ACTION),
	INTERNAL_RESULT_COMPLETED: handoff(FALLBACK_ACTION, FALLBACK_ACTION),
	INTERNAL_RESULT_PARTIAL: handoff(FALLBACK_ACTION, FALLBACK_ACTION),
	INTERNAL_RESULT_UNKNOWN: handoff(FALLBACK_ACTION, FALLBACK_ACTION),
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: handoff("handoff required: the remaining effect outcome is unknown; no safe automatic action is available", "Inspect the failure before continuing."),
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: handoff("a durable write was attempted and its outcome is not established", RECOVER_ACTION),
	INTERNAL_EFFECT_NOT_OBSERVED: handoff("an effect returned without an observable change", RECOVER_ACTION),
	INTERNAL_UNEXPECTED: handoff("unexpected internal error", "inspect; report the diagnostics file"),
	// O1 Candidate A (ticket freeze 2026-09-15): the journal is never rotated or pruned automatically; an unresolved prior
	// run and a known partial completion both hand off to the operator through the read-only inspect route.
	DOMAIN_JOURNAL_LIMIT_REACHED: next(INSPECT_ACTION, "Inspect, then archive the journal manually; nothing is rotated or pruned automatically"),
	DOMAIN_JOURNAL_LOCK_HELD: handoff(JOURNAL_LOCK_HELD_REASON, JOURNAL_LOCK_HELD_REPAIR_ACTION),
	DOMAIN_PRIOR_RUN_PENDING: handoff("a prior run's consumed plan has unresolved effects; recover before previewing or applying again", RECOVER_ACTION),
	DOMAIN_RECOVERY_PARTIAL_HANDOFF: handoff("handoff required: a known subset of effects completed and the remaining effects are known not applied; no safe automatic action is available", "Inspect the known partial effects before separately authorized recovery"),
}
// Command-specific meanings: the inspect route's success leads to a preview; a mutating route's precondition refusal
// (stale, consumed or missing preview, unreadable input) is repaired by inspecting and previewing again.
const MUTATING: ReadonlySet<CommandIdentity> = new Set<CommandIdentity>(["repair-lab.preview", "repair-lab.apply", "repair-lab.repair", "repair-lab.repair-retry"])
export function wireGuidance(commandIdentity: CommandIdentity, causeCode: WireCauseCode): WireGuidance {
	if (commandIdentity === "repair-lab.inspect" && causeCode === "SUCCESS_UNCHANGED") return next("repair-lab apply --preview", null)
	if (causeCode === "DOMAIN_PRECONDITION_UNMET") return MUTATING.has(commandIdentity) ? next(INSPECT_ACTION, "inspect current state and preview again") : next(INSPECT_ACTION, "provide a readable state file inside the fixture root, then inspect")
	return GUIDANCE_BY_CAUSE[causeCode]
}

const EVIDENCE_OWNER = "tests/catalog/station-map.test.ts"
const identityOf = (station: Pick<PublicStation, "commandIdentity" | "outcome" | "causeCode">): string => JSON.stringify([station.commandIdentity, station.outcome, station.causeCode])
const policyOf = (row: StationRow): RetryDelayPolicy => row.retryable && row.retryDelayMilliseconds !== null ? { kind: "bounded", minimumMilliseconds: row.retryDelayMilliseconds, maximumMilliseconds: row.retryDelayMilliseconds } : { kind: "none" }
const armOf = (guidance: PublicGuidance): "next" | "handoff" => ("handoff" in guidance ? "handoff" : "next")

function declarationOf(row: StationRow): CatalogueDeclaration {
	const identity = stationIdOfRow(row)
	const { guidance, repairAction } = wireGuidance(row.commandIdentity, row.causeCode)
	if ((repairAction === null) !== !row.repairAction) throw new Error(`station declaration ${identity} disagrees with its wire guidance on repairAction presence`)
	return {
		commandIdentity: row.commandIdentity,
		outcome: row.outcome,
		causeCode: row.causeCode,
		failureClass: CAUSE[row.causeCode],
		exitCode: row.exit,
		effectClass: row.effectClass,
		transactionState: row.transactionState,
		retryable: row.retryable,
		retryDelayPolicy: policyOf(row),
		trigger: row.fixtureLabel === null ? `The command reports ${row.outcome} with ${row.causeCode}.` : `Fixture scenario ${row.fixtureLabel}.`,
		guidance,
		repairAction,
		reachability: "required",
		unreachableRationale: null,
		identity,
		independentObservable: `${EVIDENCE_OWNER} binding ${identity}${row.fixtureLabel === null ? "" : ` (fixture scenario ${row.fixtureLabel})`}`,
	}
}

const nonempty = (value: string): boolean => value.trim().length > 0
const positiveSafe = (value: number): boolean => Number.isSafeInteger(value) && value >= 1
// The only admitted template substitutions (C0); any other brace token in a guidance, handoff resource or repair
// string is invalid. Substitution applies to every guidance string, including the optional handoff resource fields.
const ADMITTED_TOKENS: ReadonlySet<string> = new Set(["{runId}", "{completedEffects}", "{remainingEffects}", "{uncertainEffects}", "{idempotencyKey}"])
const unknownTokens = (value: string): string[] => (value.match(/\{[^{}]*\}/g) ?? []).filter((token) => !ADMITTED_TOKENS.has(token))
function guidanceStrings(guidance: PublicGuidance): string[] {
	if ("nextAction" in guidance) return [guidance.nextAction]
	const { handoff } = guidance
	return handoff.resource === undefined ? [handoff.reason, ...handoff.inspect] : [handoff.reason, ...handoff.inspect, handoff.resource.kind, handoff.resource.id]
}
function templateIssues(declaration: CatalogueDeclaration): string[] {
	const strings = guidanceStrings(declaration.guidance)
	if (declaration.repairAction !== null) strings.push(declaration.repairAction)
	return strings.flatMap(unknownTokens).map((token) => `template token ${token} is not admitted`)
}

function guidanceIssues(guidance: PublicGuidance): string[] {
	if ("nextAction" in guidance) return nonempty(guidance.nextAction) ? [] : ["guidance.nextAction must be nonempty"]
	const { handoff } = guidance
	const issues: string[] = []
	if (!nonempty(handoff.reason)) issues.push("guidance.handoff.reason must be nonempty")
	if (handoff.inspect.length === 0 || !handoff.inspect.every(nonempty)) issues.push("guidance.handoff.inspect must be a nonempty list of nonempty instructions")
	// The optional resource is strict (C0): when present, both fields are nonempty.
	if (handoff.resource !== undefined && !nonempty(handoff.resource.kind)) issues.push("guidance.handoff.resource.kind must be nonempty")
	if (handoff.resource !== undefined && !nonempty(handoff.resource.id)) issues.push("guidance.handoff.resource.id must be nonempty")
	return issues
}

// The cause owner fixes outcome, failure class, state, retry and guidance arm; the exit owner fixes the exit code.
function causeRuleIssues(declaration: CatalogueDeclaration): string[] {
	const rule = causeRule(declaration.causeCode)
	const checks: ReadonlyArray<readonly [field: string, agrees: boolean]> = [
		["outcome", declaration.outcome === rule.outcome],
		["failureClass", declaration.failureClass === rule.failureClass],
		["transactionState", declaration.transactionState === rule.transactionState],
		["retryable", declaration.retryable === rule.retryable],
		["guidance arm", armOf(declaration.guidance) === rule.guidance],
	]
	const issues = checks.filter(([, agrees]) => !agrees).map(([field]) => `${field} disagrees with cause ${declaration.causeCode}`)
	if (declaration.exitCode !== exitFor(declaration.failureClass)) issues.push("exitCode disagrees with failureClass")
	return issues
}

function retryPolicyIssues(declaration: CatalogueDeclaration): string[] {
	const { retryDelayPolicy: policy } = declaration
	const issues: string[] = []
	if ((policy.kind === "bounded") !== declaration.retryable) issues.push("retryDelayPolicy must be bounded exactly when retryable")
	if (policy.kind === "bounded" && (!positiveSafe(policy.minimumMilliseconds) || !positiveSafe(policy.maximumMilliseconds) || policy.maximumMilliseconds < policy.minimumMilliseconds)) issues.push("retryDelayPolicy bounds must be positive safe integers with maximum at least minimum")
	return issues
}

function reachabilityIssues(declaration: CatalogueDeclaration): string[] {
	const { reachability, unreachableRationale: rationale } = declaration
	if (reachability === "required") return rationale === null ? [] : ["required stations carry no unreachable rationale"]
	return rationale !== null && nonempty(rationale) ? [] : ["declared-unreachable stations need a nonempty reviewed rationale"]
}

function fieldIssues(declaration: CatalogueDeclaration): string[] {
	const issues: string[] = []
	if (declaration.effectClass === "inspect" && declaration.transactionState !== "unchanged") issues.push("inspect stations are always unchanged")
	if ((declaration.repairAction === null) !== (declaration.outcome === "success")) issues.push("repairAction is null exactly on success")
	if (declaration.repairAction !== null && !nonempty(declaration.repairAction)) issues.push("repairAction must be nonempty")
	if (!nonempty(declaration.trigger)) issues.push("trigger must be nonempty")
	if (!nonempty(declaration.independentObservable)) issues.push("independentObservable must be nonempty")
	if (declaration.identity !== identityOf(declaration)) issues.push("identity disagrees with the derived tuple")
	return issues
}

// Strict catalogue schema: every declaration must agree with its cause's accepted result-table row, its exit
// class, its retry policy, its reachability rationale and its own derived identity (cross-field contradictions).
export function catalogueSchemaIssues(declaration: CatalogueDeclaration): readonly string[] {
	const issues = [...causeRuleIssues(declaration), ...retryPolicyIssues(declaration), ...fieldIssues(declaration), ...reachabilityIssues(declaration), ...guidanceIssues(declaration.guidance), ...templateIssues(declaration)]
	return issues.map((issue) => `${declaration.identity}: ${issue}`)
}

function sealed(declarations: readonly CatalogueDeclaration[]): readonly CatalogueDeclaration[] {
	const issues = declarations.flatMap(catalogueSchemaIssues)
	if (issues.length > 0) throw new Error(`station catalogue schema: ${issues.join("; ")}`)
	return declarations
}

/** Every station of the typed catalogue, derived from STATIONS and checked against the strict schema at load. */
export const BRANCH_STATIONS: readonly CatalogueDeclaration[] = sealed(STATIONS.map(declarationOf))

export function commandDiscovery(command: CommandSummary): CommandDiscoveryData {
	return { command, semantics: "possible-outcomes", stations: BRANCH_STATIONS.filter((station) => station.commandIdentity === command.commandIdentity).map(({ identity: _identity, independentObservable: _observable, ...station }) => station) }
}

// The public fields compared between a declaration and a process observation. The trigger is descriptive prose and
// the identity fields are the lookup key; every other field, including full guidance and repair strings, must agree.
const COMPARED_FIELDS = ["failureClass", "exitCode", "effectClass", "transactionState", "retryable", "retryDelayPolicy", "guidance", "repairAction", "reachability", "unreachableRationale"] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function firstArrayDifference(left: readonly unknown[], right: readonly unknown[], path: string): string | undefined {
	if (left.length !== right.length) return path
	return left.map((item, index) => firstDifference(item, right[index], `${path}[${index}]`)).find((difference) => difference !== undefined)
}

function firstRecordDifference(left: Record<string, unknown>, right: Record<string, unknown>, path: string): string | undefined {
	const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
	return keys.map((key) => firstDifference(left[key], right[key], `${path}.${key}`)).find((difference) => difference !== undefined)
}

// The path of the first differing leaf, so a finding names the exact guidance or policy field that disagrees.
function firstDifference(left: unknown, right: unknown, path: string): string | undefined {
	if (Array.isArray(left) && Array.isArray(right)) return firstArrayDifference(left, right, path)
	if (isRecord(left) && isRecord(right)) return firstRecordDifference(left, right, path)
	return Object.is(left, right) ? undefined : path
}

function mismatchedField(declaration: PublicStation, observed: PublicStation): string | undefined {
	for (const field of COMPARED_FIELDS) {
		const difference = firstDifference(declaration[field], observed[field], field)
		if (difference !== undefined) return difference
	}
	return undefined
}

function declarationsByIdentity(declarations: readonly CatalogueDeclaration[], findings: CatalogueFinding[]): ReadonlyMap<string, CatalogueDeclaration> {
	const byIdentity = new Map<string, CatalogueDeclaration>()
	for (const declaration of declarations) {
		if (byIdentity.has(declaration.identity)) findings.push({ code: "STATION_DUPLICATE_IDENTITY", identity: declaration.identity })
		else byIdentity.set(declaration.identity, declaration)
	}
	return byIdentity
}

// A baseline names only reviewed legacy gaps; it is an explicit input, never inferred, so a new gap cannot be
// absorbed silently. Strict new-CLI enforcement admits no baseline at all.
function declarationFindings(byIdentity: ReadonlyMap<string, CatalogueDeclaration>, observed: ReadonlyMap<string, PublicStation>, baseline: ReadonlySet<string>): CatalogueFinding[] {
	const findings: CatalogueFinding[] = []
	for (const [identity, declaration] of byIdentity) {
		if (declaration.reachability === "declared-unreachable" && observed.has(identity)) findings.push({ code: "STATION_UNREACHABLE_OBSERVED", identity })
		if (declaration.reachability === "required" && !observed.has(identity) && !baseline.has(identity)) findings.push({ code: "STATION_UNREACHED", identity })
	}
	return findings
}

function observationFindings(byIdentity: ReadonlyMap<string, CatalogueDeclaration>, observed: ReadonlyMap<string, PublicStation>, baseline: ReadonlySet<string>): CatalogueFinding[] {
	const findings: CatalogueFinding[] = []
	for (const [identity, station] of observed) {
		const declaration = byIdentity.get(identity)
		if (declaration === undefined) {
			if (!baseline.has(identity)) findings.push({ code: "STATION_UNDECLARED", identity })
			continue
		}
		const field = mismatchedField(declaration, station)
		if (field !== undefined) findings.push({ code: "STATION_FIELD_MISMATCH", identity, field })
	}
	return findings
}

export function validateCatalogue(declarations: readonly CatalogueDeclaration[], observations: readonly CatalogueObservation[], mode: CatalogueMode, legacyGapIdentities: readonly string[] = []): CatalogueReport {
	const findings: CatalogueFinding[] = []
	const byIdentity = declarationsByIdentity(declarations, findings)
	const observed = new Map(observations.map((observation) => [observation.identity, observation.station]))
	const baseline = new Set(mode === "strict-new" ? [] : legacyGapIdentities)
	findings.push(...declarationFindings(byIdentity, observed, baseline), ...observationFindings(byIdentity, observed, baseline))
	return { mode, findings, fullQualification: mode === "strict-new" && findings.length === 0 }
}
