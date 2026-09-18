import { stationIdOfRow } from "./branch-station-catalog.ts"
import { type CommandIdentity, type CommandSummary, causeRule, type EffectClass, type ExitCode, exitFor, type FailureClass, type Outcome, STATIONS, type StationRow, type WireCauseCode, type WireTransactionState } from "./command-contract.ts"

// The typed catalogue: one readonly STATIONS owner supplies every public station, the selected-command discovery
// data, and the enforcement inputs. Discovery is descriptive: possible outcomes only, never live state, approval, or
// replay authority. Guidance is published as the set of next-action identities (or the handoff owner) a station may
// emit; process evidence must stay inside that set and every declared next action must be observed.

export type Reachability = "required" | "declared-unreachable"
export type RetryDelayPolicy = { readonly kind: "none" } | { readonly kind: "bounded"; readonly minimumMilliseconds: number; readonly maximumMilliseconds: number }
export type PublicGuidance = { readonly kind: "next-action"; readonly nextActions: readonly string[] } | { readonly kind: "handoff"; readonly owners: readonly ("human" | "operator")[] }
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
	readonly reasons: readonly string[]
	readonly guidance: PublicGuidance
	readonly repairAction: boolean
	readonly reachability: Reachability
	readonly unreachableRationale: string | null
}
export type CommandDiscoveryData = { readonly command: CommandSummary; readonly semantics: "possible-outcomes"; readonly stations: readonly PublicStation[] }

export type CatalogueDeclaration = PublicStation & { readonly identity: string }
// One process observation: the derived identity plus the fields the catalogue compares and the guidance it emitted.
export type CatalogueObservation = {
	readonly identity: string
	readonly failureClass: FailureClass | null
	readonly exitCode: number
	readonly effectClass: string
	readonly transactionState: string
	readonly retryable: boolean
	readonly retryDelayMilliseconds: number | null
	readonly reason: string | null
	readonly nextAction: string | null
	readonly handoffOwner: string | null
	readonly repairAction: boolean
}
export type CatalogueFindingCode = "STATION_UNREACHED" | "STATION_UNDECLARED" | "STATION_FIELD_MISMATCH" | "STATION_UNREACHABLE_OBSERVED" | "STATION_NEXT_ACTION_UNREACHED" | "STATION_REASON_UNREACHED"
export type CatalogueFinding = { readonly code: CatalogueFindingCode; readonly identity: string; readonly field?: string }
export type CatalogueReport = { readonly findings: readonly CatalogueFinding[]; readonly fullQualification: boolean }

const HANDOFF_OWNERS: Readonly<Record<WireCauseCode, readonly ("human" | "operator")[]>> = {
	SUCCESS_UNCHANGED: [],
	SUCCESS_COMPLETED: [],
	USAGE_INVALID_INVOCATION: [],
	USAGE_UNKNOWN_COMMAND: [],
	SCHEMA_INVALID_INPUT: [],
	DOMAIN_PRECONDITION_UNMET: [],
	DOMAIN_AUTHORITY_REQUIRED: ["human"],
	TRANSIENT_NOT_STARTED: [],
	INTERNAL_RESULT_UNCHANGED: ["operator"],
	INTERNAL_RESULT_PARTIAL: ["operator"],
	INTERNAL_RESULT_UNKNOWN: ["operator"],
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: ["operator"],
	INTERNAL_UNEXPECTED: ["operator"],
}

const policyOf = (row: StationRow): RetryDelayPolicy => (row.retryable && row.retryDelayMilliseconds !== null ? { kind: "bounded", minimumMilliseconds: row.retryDelayMilliseconds, maximumMilliseconds: row.retryDelayMilliseconds } : { kind: "none" })

function declarationOf(row: StationRow): CatalogueDeclaration {
	const rule = causeRule(row.causeCode)
	return {
		commandIdentity: row.commandIdentity,
		outcome: row.outcome,
		causeCode: row.causeCode,
		failureClass: rule.failureClass,
		exitCode: row.exit,
		effectClass: row.effectClass,
		transactionState: row.transactionState,
		retryable: row.retryable,
		retryDelayPolicy: policyOf(row),
		reasons: row.reasons,
		guidance: row.guidance === "handoff" ? { kind: "handoff", owners: HANDOFF_OWNERS[row.causeCode] } : { kind: "next-action", nextActions: row.nextActions },
		repairAction: row.outcome !== "success",
		reachability: row.reachability,
		unreachableRationale: row.unreachableRationale,
		identity: stationIdOfRow(row),
	}
}

// Strict catalogue schema: every declaration agrees with its cause's accepted rule, its exit class, its retry policy,
// its guidance arm, and its reachability rationale. Each check is one (holds, message) row.
export function catalogueSchemaIssues(declaration: CatalogueDeclaration): readonly string[] {
	const rule = causeRule(declaration.causeCode)
	const { guidance, retryDelayPolicy: policy } = declaration
	const checks: readonly (readonly [holds: boolean, message: string])[] = [
		[declaration.outcome === rule.outcome, "outcome disagrees with the cause"],
		[declaration.transactionState === rule.transactionState, "transactionState disagrees with the cause"],
		[declaration.retryable === rule.retryable, "retryable disagrees with the cause"],
		[(guidance.kind === "handoff") === (rule.guidance === "handoff"), "guidance arm disagrees with the cause"],
		[declaration.exitCode === exitFor(declaration.failureClass), "exitCode disagrees with failureClass"],
		[(policy.kind === "bounded") === declaration.retryable, "retryDelayPolicy must be bounded exactly when retryable"],
		[declaration.effectClass !== "inspect" || declaration.transactionState === "unchanged", "inspect stations are always unchanged"],
		[guidance.kind !== "next-action" || guidance.nextActions.length > 0, "a next-action station declares at least one next action"],
		[guidance.kind !== "handoff" || guidance.owners.length > 0, "a handoff station declares its owner"],
		[declaration.outcome === "success" || declaration.reasons.length > 0, "a refusal or failure station names its product reasons"],
		[declaration.reachability !== "required" || declaration.unreachableRationale === null, "required stations carry no unreachable rationale"],
		[declaration.reachability !== "declared-unreachable" || Boolean(declaration.unreachableRationale?.trim()), "declared-unreachable stations need a nonempty rationale"],
	]
	return checks.filter(([holds]) => !holds).map(([, message]) => `${declaration.identity}: ${message}`)
}

function sealed(declarations: readonly CatalogueDeclaration[]): readonly CatalogueDeclaration[] {
	const issues = declarations.flatMap(catalogueSchemaIssues)
	if (issues.length > 0) throw new Error(`station catalogue schema: ${issues.join("; ")}`)
	return declarations
}

/** Every station of the typed catalogue, derived from STATIONS and checked against the strict schema at load. */
export const BRANCH_STATIONS: readonly CatalogueDeclaration[] = sealed(STATIONS.map(declarationOf))

export function commandDiscovery(command: CommandSummary): CommandDiscoveryData {
	return { command, semantics: "possible-outcomes", stations: BRANCH_STATIONS.filter((station) => station.commandIdentity === command.commandIdentity).map(({ identity: _identity, ...station }) => station) }
}

// The first compared field on which an observation disagrees with its declaration.
function mismatchedField(declaration: CatalogueDeclaration, observed: CatalogueObservation): string | undefined {
	const delay = declaration.retryDelayPolicy.kind === "bounded" ? declaration.retryDelayPolicy.minimumMilliseconds : null
	const guidanceHolds = declaration.guidance.kind === "next-action" ? observed.nextAction !== null && declaration.guidance.nextActions.includes(observed.nextAction) : observed.handoffOwner !== null && (declaration.guidance.owners as readonly string[]).includes(observed.handoffOwner)
	const checks: readonly (readonly [holds: boolean, field: string])[] = [
		[declaration.failureClass === observed.failureClass, "failureClass"],
		[declaration.exitCode === observed.exitCode, "exitCode"],
		[declaration.effectClass === observed.effectClass, "effectClass"],
		[declaration.transactionState === observed.transactionState, "transactionState"],
		[declaration.retryable === observed.retryable, "retryable"],
		[delay === observed.retryDelayMilliseconds, "retryDelayPolicy"],
		[declaration.repairAction === observed.repairAction, "repairAction"],
		[guidanceHolds, declaration.guidance.kind === "next-action" ? "guidance.nextActions" : "guidance.owners"],
		[observed.reason === null || declaration.reasons.includes(observed.reason), "reasons"],
	]
	return checks.find(([holds]) => !holds)?.[1]
}

function declarationFindings(declaration: CatalogueDeclaration, runs: readonly CatalogueObservation[]): CatalogueFinding[] {
	const { identity } = declaration
	if (declaration.reachability === "declared-unreachable") return runs.length > 0 ? [{ code: "STATION_UNREACHABLE_OBSERVED", identity }] : []
	if (runs.length === 0) return [{ code: "STATION_UNREACHED", identity }]
	const nextActions = declaration.guidance.kind === "next-action" ? declaration.guidance.nextActions : []
	return [
		...nextActions.filter((nextAction) => !runs.some((run) => run.nextAction === nextAction)).map((nextAction): CatalogueFinding => ({ code: "STATION_NEXT_ACTION_UNREACHED", identity, field: nextAction })),
		...declaration.reasons.filter((reason) => !runs.some((run) => run.reason === reason)).map((reason): CatalogueFinding => ({ code: "STATION_REASON_UNREACHED", identity, field: reason })),
	]
}

function observationFindings(byIdentity: ReadonlyMap<string, CatalogueDeclaration>, identity: string, runs: readonly CatalogueObservation[]): CatalogueFinding[] {
	const declaration = byIdentity.get(identity)
	if (declaration === undefined) return [{ code: "STATION_UNDECLARED", identity }]
	return runs.flatMap((run) => {
		const field = mismatchedField(declaration, run)
		return field === undefined ? [] : [{ code: "STATION_FIELD_MISMATCH", identity, field }]
	})
}

// Strict new-project enforcement: every required station reached, every observed station declared with agreeing
// fields, every declared next action and product reason observed at least once, no declared-unreachable station
// observed. There is no legacy baseline.
export function validateCatalogue(declarations: readonly CatalogueDeclaration[], observations: readonly CatalogueObservation[]): CatalogueReport {
	const byIdentity = new Map(declarations.map((declaration) => [declaration.identity, declaration]))
	const observed = new Map<string, CatalogueObservation[]>()
	for (const observation of observations) observed.set(observation.identity, [...(observed.get(observation.identity) ?? []), observation])
	const findings = [
		...declarations.flatMap((declaration) => declarationFindings(declaration, observed.get(declaration.identity) ?? [])),
		...[...observed].flatMap(([identity, runs]) => observationFindings(byIdentity, identity, runs)),
	]
	return { findings, fullQualification: findings.length === 0 }
}
