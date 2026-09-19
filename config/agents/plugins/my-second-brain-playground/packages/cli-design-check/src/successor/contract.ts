export const CHECKER_CONTRACT_VERSION = "2.0.0" as const
export const CHECKER_ENVELOPE_VERSION = 2 as const

export const SUCCESSOR_FINDINGS = {
	STDOUT_NOT_SINGLE_JSON_OBJECT: "STDOUT_NOT_SINGLE_JSON_OBJECT",
	STDOUT_EMPTY: "STDOUT_EMPTY",
	STDERR_NOT_EMPTY: "STDERR_NOT_EMPTY",
	HUMAN_OUTPUT_IS_JSON: "HUMAN_OUTPUT_IS_JSON",
	TARGET_JSON_DEPTH_EXCEEDED: "TARGET_JSON_DEPTH_EXCEEDED",
	TARGET_AVAILABLE_PATHS_INVALID: "TARGET_AVAILABLE_PATHS_INVALID",
	TARGET_COMMAND_UNDECLARED: "TARGET_COMMAND_UNDECLARED",
	TARGET_CAUSE_CORRELATION: "TARGET_CAUSE_CORRELATION",
	EXIT_MISMATCH: "EXIT_MISMATCH",
	ENVELOPE_NEXT_STEP_RULE: "ENVELOPE_NEXT_STEP_RULE",
	TARGET_GUIDANCE_CORRELATION: "TARGET_GUIDANCE_CORRELATION",
	TARGET_RETRY_CORRELATION: "TARGET_RETRY_CORRELATION",
	ENVELOPE_UNRESOLVED_RETRYABLE: "ENVELOPE_UNRESOLVED_RETRYABLE",
	TARGET_OUTCOME_DATA_CORRELATION: "TARGET_OUTCOME_DATA_CORRELATION",
	TARGET_EFFECTS_INVALID: "TARGET_EFFECTS_INVALID",
	TARGET_EFFECT_STATE_CORRELATION: "TARGET_EFFECT_STATE_CORRELATION",
	TARGET_INSPECT_EFFECT_CORRELATION: "TARGET_INSPECT_EFFECT_CORRELATION",
	TARGET_SUCCESS_REMAINS: "TARGET_SUCCESS_REMAINS",
	TARGET_ATTEMPTED_EFFECT_INVALID: "TARGET_ATTEMPTED_EFFECT_INVALID",
} as const

export type JsonRecord = Record<string, unknown>
export type ObservedVersion = string | null

export interface TargetValidation {
	observedContractVersion: ObservedVersion
	findings: string[]
	declaredCommands: string[]
}

export type Guidance = "next" | "handoff"
export type Outcome = "success" | "refused" | "failed"
export type State = "unchanged" | "completed" | "partially-completed" | "unknown"
export type FailureClass = "usage" | "domain" | "schema" | "internal" | "transient"

export interface CauseRule {
	failureClass: FailureClass | null
	outcome: Outcome
	state: State
	retryable: boolean
	guidance: Guidance
	exit: number
}

const CHECKER_EXIT = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, transient: 75 } as const

// fallow-ignore-next-line code-duplication -- Validator correlation truth must remain independent of the frozen target exemplar.
const cause = (failureClass: FailureClass | null, outcome: Outcome, state: State, retryable: boolean, guidance: Guidance): CauseRule => ({
	failureClass,
	outcome,
	state,
	retryable,
	guidance,
	exit: failureClass === null ? CHECKER_EXIT.success : CHECKER_EXIT[failureClass],
})

const CAUSE_RULES = {
	SUCCESS_UNCHANGED: cause(null, "success", "unchanged", false, "next"),
	SUCCESS_COMPLETED: cause(null, "success", "completed", false, "next"),
	USAGE_INVALID_INVOCATION: cause("usage", "refused", "unchanged", false, "next"),
	USAGE_UNKNOWN_COMMAND: cause("usage", "refused", "unchanged", false, "next"),
	SCHEMA_INVALID_INPUT: cause("schema", "refused", "unchanged", false, "next"),
	SCHEMA_UNSUPPORTED_CONTRACT: cause("schema", "refused", "unchanged", false, "next"),
	DOMAIN_PRECONDITION_UNMET: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_AUTHORITY_REQUIRED: cause("domain", "refused", "unchanged", false, "handoff"),
	TRANSIENT_NOT_STARTED: cause("transient", "refused", "unchanged", true, "next"),
	TRANSIENT_ATTEMPT_UNCHANGED: cause("transient", "failed", "unchanged", true, "next"),
	DOMAIN_DEADLINE_BEFORE_START: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_DEADLINE_UNCHANGED: cause("domain", "failed", "unchanged", false, "next"),
	DOMAIN_DEADLINE_COMPLETED: cause("domain", "failed", "completed", false, "handoff"),
	DOMAIN_DEADLINE_PARTIAL: cause("domain", "failed", "partially-completed", false, "handoff"),
	DOMAIN_DEADLINE_UNKNOWN: cause("domain", "failed", "unknown", false, "handoff"),
	INTERNAL_PREPARATION: cause("internal", "refused", "unchanged", false, "next"),
	INTERNAL_RESULT_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_RESULT_COMPLETED: cause("internal", "failed", "completed", false, "handoff"),
	INTERNAL_RESULT_PARTIAL: cause("internal", "failed", "partially-completed", false, "handoff"),
	INTERNAL_RESULT_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: cause("domain", "failed", "unknown", false, "handoff"),
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_EFFECT_NOT_OBSERVED: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_UNEXPECTED: cause("internal", "failed", "unchanged", false, "handoff"),
	// Vault Steward CLI product causes (CONTRACT.md 3.3 of the vault-steward package), additive: each row keeps its class
	// prefix and the correlations the core rows imply, so agents match on causeCode instead of parsing messages.
	SCHEMA_CONFIG_INVALID: cause("schema", "refused", "unchanged", false, "next"),
	SCHEMA_MANIFEST_INVALID: cause("schema", "refused", "unchanged", false, "handoff"),
	SCHEMA_RECEIPT_INVALID: cause("schema", "refused", "unchanged", false, "handoff"),
	SCHEMA_PREVIEW_INVALID: cause("schema", "refused", "unchanged", false, "handoff"),
	DOMAIN_CONFIG_MISSING: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_VAULT_NOT_FOUND: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANONICAL_NOT_MAIN: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_PATH_REFUSED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANDIDATE_NOT_FOUND: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANDIDATE_INVALID: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_PATH_SET_MISMATCH: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CHECK_FAILED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_FORMAT_FAILED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_GUARD_INCOMPATIBLE: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANONICAL_NOT_READY: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_MAIN_DIVERGED: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_SEMANTIC_OVERLAP: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_PREVIEW_NOT_FOUND: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_PREVIEW_CONSUMED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_PREVIEW_STALE: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_REBASE_CONFLICT: cause("domain", "failed", "unchanged", false, "handoff"),
	DOMAIN_REBASED_CHECK_FAILED: cause("domain", "failed", "unchanged", false, "next"),
	DOMAIN_RECOVERY_UNPROVABLE: cause("domain", "refused", "unchanged", false, "handoff"),
	TRANSIENT_INTEGRATION_BUSY: cause("transient", "refused", "unchanged", true, "next"),
	INTERNAL_GIT_FAILED_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_GIT_FAILED_PARTIAL: cause("internal", "failed", "partially-completed", false, "handoff"),
	INTERNAL_GIT_FAILED_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_INTEGRATION_UNPROVED: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_INTEGRATION_UNPROVED_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_COMPLETION_RECORD_FAILED: cause("internal", "failed", "partially-completed", false, "next"),
	INTERNAL_UNEXPECTED_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_UNEXPECTED_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
} satisfies Readonly<Record<string, CauseRule>>

export type CauseCode = keyof typeof CAUSE_RULES

export function causeRuleFor(causeCode: CauseCode): CauseRule {
	return CAUSE_RULES[causeCode]
}

export function checkerExitMeanings(): Record<string, string> {
	return Object.fromEntries(Object.entries(CHECKER_EXIT).map(([meaning, exit]) => [String(exit), meaning]))
}

const TOP_KEYS = ["availablePaths", "contractVersion", "diagnostics", "envelopeVersion", "message", "result"] as const
const RESULT_KEYS = ["attemptedEffect", "causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "handoff", "idempotencyKey", "nextAction", "outcome", "repairAction", "retryable", "retryDelayMilliseconds", "runId", "transactionState"] as const
const EFFECT_KEYS = ["completed", "inventoryComplete", "remaining", "uncertain"] as const
const HANDOFF_KEYS = ["inspect", "owner", "reason", "resource"] as const
const AVAILABLE_DIAGNOSTIC_KEYS = ["closed", "countsComplete", "droppedRecords", "file", "sinkFailure", "status", "truncatedRecords", "unflushedRecords"] as const
const UNAVAILABLE_DIAGNOSTIC_KEYS = ["reason", "status", "trusted"] as const
const TRUSTED_DIAGNOSTIC_KEYS = ["closed", "countsComplete", "droppedRecords", "file", "sinkFailure", "truncatedRecords", "unflushedRecords"] as const

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value)
const isNonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const isSafeNonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isNonblank)
const isFailureClass = (value: unknown): value is FailureClass => ["usage", "domain", "schema", "internal", "transient"].includes(value as string)
const hasOwn = (value: JsonRecord, key: string): boolean => Object.hasOwn(value, key)
const fieldMissing = (path: string): string => `TARGET_FIELD_MISSING:${path}`
const fieldInvalid = (path: string): string => `TARGET_FIELD_INVALID:${path}`
const fieldUndeclared = (path: string): string => `TARGET_FIELD_UNDECLARED:${path}`

function firstMissing(value: JsonRecord, keys: readonly string[], path: string): string | null {
	const missing = keys.find((key) => !hasOwn(value, key))
	return missing === undefined ? null : fieldMissing(`${path}${missing}`)
}

function firstUndeclared(value: JsonRecord, keys: readonly string[], path: string): string | null {
	const allowed = new Set(keys)
	const extra = Object.keys(value).find((key) => !allowed.has(key))
	return extra === undefined ? null : fieldUndeclared(`${path}${extra}`)
}

function safeObservedVersion(value: unknown): ObservedVersion {
	if (!isRecord(value) || typeof value.contractVersion !== "string") return null
	return [...value.contractVersion].map((character) => {
		const code = character.charCodeAt(0)
		return code <= 31 || code === 127 ? " " : character
	}).join("").slice(0, 128)
}

function exceedsDepth(value: unknown, maximumDepth = 64): boolean {
	const visit = (candidate: unknown, depth: number): boolean => {
		if (depth > maximumDepth) return true
		if (Array.isArray(candidate)) return candidate.some((entry) => visit(entry, depth + 1))
		if (isRecord(candidate)) return Object.values(candidate).some((entry) => visit(entry, depth + 1))
		return false
	}
	return visit(value, 0)
}

function sortedUnique(values: readonly string[]): boolean {
	return new Set(values).size === values.length && values.every((value, index) => index === 0 || (values[index - 1] as string) < value)
}

function basicTopFinding(value: JsonRecord): string | null {
	return (
		firstMissing(value, ["envelopeVersion", "contractVersion", "message", "availablePaths", "result"], "") ??
		firstUndeclared(value, TOP_KEYS, "") ??
		(value.envelopeVersion === CHECKER_ENVELOPE_VERSION ? null : fieldInvalid("envelopeVersion")) ??
		(isNonblank(value.message) ? null : fieldInvalid("message")) ??
		(isStringArray(value.availablePaths) ? null : fieldInvalid("availablePaths"))
	)
}

interface FieldCheck {
	path: string
	value: unknown
	valid: (value: unknown) => boolean
}

function firstInvalidField(checks: readonly FieldCheck[]): string | null {
	const invalid = checks.find((check) => !check.valid(check.value))
	return invalid === undefined ? null : fieldInvalid(invalid.path)
}

function basicResultFinding(result: JsonRecord): string | null {
	const required = ["runId", "commandIdentity", "outcome", "effectClass", "transactionState", "causeCode", "failureClass", "exitCode", "data", "retryable", "repairAction", "effects"]
	const shapeFinding = firstMissing(result, required, "result.") ?? firstUndeclared(result, RESULT_KEYS, "result.")
	if (shapeFinding !== null) return shapeFinding
	const fieldFinding = firstInvalidField([
		{ path: "result.runId", value: result.runId, valid: isNonblank },
		{ path: "result.commandIdentity", value: result.commandIdentity, valid: isNonblank },
		{ path: "result.outcome", value: result.outcome, valid: (value) => ["success", "refused", "failed"].includes(String(value)) },
		{ path: "result.effectClass", value: result.effectClass, valid: (value) => ["inspect", "repository-local", "external"].includes(String(value)) },
		{ path: "result.transactionState", value: result.transactionState, valid: (value) => ["unchanged", "completed", "partially-completed", "unknown"].includes(String(value)) },
		{ path: "result.causeCode", value: result.causeCode, valid: isNonblank },
		{ path: "result.failureClass", value: result.failureClass, valid: (value) => value === null || isFailureClass(value) },
		{ path: "result.retryable", value: result.retryable, valid: (value) => typeof value === "boolean" },
		{ path: "result.exitCode", value: result.exitCode, valid: (value) => [0, 1, 2, 3, 4, 75].includes(value as number) },
	])
	if (fieldFinding !== null) return fieldFinding
	if (hasOwn(result, "idempotencyKey") && !isNonblank(result.idempotencyKey)) return fieldInvalid("result.idempotencyKey")
	if (hasOwn(result, "attemptedEffect") && !isNonblank(result.attemptedEffect)) return fieldInvalid("result.attemptedEffect")
	return null
}

function effectsFinding(result: JsonRecord): string | null {
	if (!isRecord(result.effects)) return fieldInvalid("result.effects")
	const effects = result.effects
	const shapeFinding = firstMissing(effects, EFFECT_KEYS, "result.effects.") ?? firstUndeclared(effects, EFFECT_KEYS, "result.effects.")
	if (shapeFinding !== null) return shapeFinding
	if (!isStringArray(effects.completed) || !isStringArray(effects.remaining) || !isStringArray(effects.uncertain) || typeof effects.inventoryComplete !== "boolean") return fieldInvalid("result.effects")
	const collections = [effects.completed, effects.remaining, effects.uncertain] as const
	const all = collections.flat()
	if (!collections.every(sortedUnique) || new Set(all).size !== all.length) return SUCCESSOR_FINDINGS.TARGET_EFFECTS_INVALID
	return null
}

function stateEffectsHold(result: JsonRecord): boolean {
	const effects = result.effects as { completed: string[]; remaining: string[]; uncertain: string[]; inventoryComplete: boolean }
	if (result.transactionState === "unchanged") return effects.inventoryComplete && effects.completed.length === 0 && effects.uncertain.length === 0
	if (result.transactionState === "completed") return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length === 0 && effects.uncertain.length === 0
	if (result.transactionState === "partially-completed") return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length > 0 && effects.uncertain.length === 0
	return !effects.inventoryComplete || effects.uncertain.length > 0
}

function effectCorrelationFinding(result: JsonRecord): string | null {
	const effects = result.effects as { completed: string[]; remaining: string[]; uncertain: string[]; inventoryComplete: boolean }
	const all = [...effects.completed, ...effects.remaining, ...effects.uncertain]
	if (!stateEffectsHold(result)) return SUCCESSOR_FINDINGS.TARGET_EFFECT_STATE_CORRELATION
	if (result.effectClass === "inspect" && (result.transactionState !== "unchanged" || !effects.inventoryComplete || all.length !== 0)) return SUCCESSOR_FINDINGS.TARGET_INSPECT_EFFECT_CORRELATION
	if (result.outcome === "success" && effects.remaining.length !== 0) return SUCCESSOR_FINDINGS.TARGET_SUCCESS_REMAINS
	if (hasOwn(result, "attemptedEffect") && (result.outcome !== "failed" || !isNonblank(result.attemptedEffect) || !all.includes(result.attemptedEffect))) return SUCCESSOR_FINDINGS.TARGET_ATTEMPTED_EFFECT_INVALID
	return null
}

function handoffValid(value: unknown): boolean {
	if (!isRecord(value) || firstUndeclared(value, HANDOFF_KEYS, "") !== null) return false
	if (!(["human", "operator"] as const).includes(value.owner as "human" | "operator") || !isNonblank(value.reason) || !isStringArray(value.inspect) || value.inspect.length === 0) return false
	if (!hasOwn(value, "resource")) return true
	return isRecord(value.resource) && Object.keys(value.resource).sort().join(",") === "id,kind" && isNonblank(value.resource.id) && isNonblank(value.resource.kind)
}

function guidanceFinding(result: JsonRecord, rule: CauseRule): string | null {
	const hasNext = hasOwn(result, "nextAction")
	const hasHandoff = hasOwn(result, "handoff")
	if (hasNext === hasHandoff) return SUCCESSOR_FINDINGS.ENVELOPE_NEXT_STEP_RULE
	if (hasNext && !isNonblank(result.nextAction)) return fieldInvalid("result.nextAction")
	if (hasHandoff && !handoffValid(result.handoff)) return fieldInvalid("result.handoff")
	if ((rule.guidance === "next") !== hasNext) return SUCCESSOR_FINDINGS.TARGET_GUIDANCE_CORRELATION
	return null
}

function retryFinding(result: JsonRecord): string | null {
	if ((result.transactionState === "partially-completed" || result.transactionState === "unknown") && result.retryable === true) return SUCCESSOR_FINDINGS.ENVELOPE_UNRESOLVED_RETRYABLE
	const hasDelay = hasOwn(result, "retryDelayMilliseconds")
	if (result.retryable === true) return hasDelay && isPositiveInteger(result.retryDelayMilliseconds) ? null : SUCCESSOR_FINDINGS.TARGET_RETRY_CORRELATION
	return hasDelay ? SUCCESSOR_FINDINGS.TARGET_RETRY_CORRELATION : null
}

function causeFinding(result: JsonRecord, observedExit: number | null): string | null {
	const rule = typeof result.causeCode === "string" && result.causeCode in CAUSE_RULES ? CAUSE_RULES[result.causeCode as CauseCode] : undefined
	if (rule === undefined) return fieldInvalid("result.causeCode")
	if (rule.failureClass !== result.failureClass || rule.outcome !== result.outcome || rule.state !== result.transactionState || rule.retryable !== result.retryable || rule.exit !== result.exitCode) return SUCCESSOR_FINDINGS.TARGET_CAUSE_CORRELATION
	if (observedExit !== rule.exit) return SUCCESSOR_FINDINGS.EXIT_MISMATCH
	return guidanceFinding(result, rule)
}

function outcomeFinding(result: JsonRecord): string | null {
	if (result.outcome === "success") return result.failureClass === null && result.repairAction === null ? null : SUCCESSOR_FINDINGS.TARGET_OUTCOME_DATA_CORRELATION
	if (result.data !== null) return SUCCESSOR_FINDINGS.TARGET_OUTCOME_DATA_CORRELATION
	return isNonblank(result.repairAction) ? null : fieldInvalid("result.repairAction")
}

const validDiagnosticFile = (value: unknown): boolean => value === null || (typeof value === "string" && value.startsWith("/"))
const validSinkFailure = (value: unknown): boolean => value === null || ["capacity", "setup", "write", "flush-timeout", "close"].includes(String(value))
const validBoolean = (value: unknown): boolean => typeof value === "boolean"

function diagnosticFieldChecks(value: JsonRecord): FieldCheck[] {
	return [
		{ path: "file", value: value.file, valid: validDiagnosticFile },
		{ path: "sinkFailure", value: value.sinkFailure, valid: validSinkFailure },
		{ path: "droppedRecords", value: value.droppedRecords, valid: isSafeNonnegativeInteger },
		{ path: "unflushedRecords", value: value.unflushedRecords, valid: isSafeNonnegativeInteger },
		{ path: "truncatedRecords", value: value.truncatedRecords, valid: isSafeNonnegativeInteger },
		{ path: "countsComplete", value: value.countsComplete, valid: validBoolean },
		{ path: "closed", value: value.closed, valid: validBoolean },
	]
}

function availableDiagnosticsValid(value: JsonRecord): boolean {
	const shapeFinding = firstMissing(value, AVAILABLE_DIAGNOSTIC_KEYS, "") ?? firstUndeclared(value, AVAILABLE_DIAGNOSTIC_KEYS, "")
	return shapeFinding === null && firstInvalidField(diagnosticFieldChecks(value)) === null
}

function trustedDiagnosticsValid(value: JsonRecord): boolean {
	if (firstUndeclared(value, TRUSTED_DIAGNOSTIC_KEYS, "") !== null) return false
	return diagnosticFieldChecks(value).filter((check) => hasOwn(value, check.path)).every((check) => check.valid(check.value))
}

function diagnosticsFinding(value: unknown): string | null {
	if (value === undefined) return null
	if (!isRecord(value)) return "TARGET_DIAGNOSTICS_INVALID:diagnostics"
	if (value.status === "available") return availableDiagnosticsValid(value) ? null : "TARGET_DIAGNOSTICS_INVALID:diagnostics"
	if (value.status !== "unavailable" || firstMissing(value, UNAVAILABLE_DIAGNOSTIC_KEYS, "") !== null || firstUndeclared(value, UNAVAILABLE_DIAGNOSTIC_KEYS, "") !== null) return "TARGET_DIAGNOSTICS_INVALID:diagnostics"
	if (!["status-invalid", "status-unavailable"].includes(String(value.reason)) || !isRecord(value.trusted)) return "TARGET_DIAGNOSTICS_INVALID:diagnostics"
	return trustedDiagnosticsValid(value.trusted) ? null : "TARGET_DIAGNOSTICS_INVALID:diagnostics"
}

function commandSummaryValid(value: unknown): value is JsonRecord {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "commandIdentity,effectClass,route,summary") return false
	const finding = firstInvalidField([
		{ path: "commandIdentity", value: value.commandIdentity, valid: isNonblank },
		{ path: "effectClass", value: value.effectClass, valid: (entry) => ["inspect", "repository-local", "external"].includes(String(entry)) },
		{ path: "route", value: value.route, valid: (entry) => Array.isArray(entry) && entry.every((token) => typeof token === "string") },
		{ path: "summary", value: value.summary, valid: isNonblank },
	])
	return finding === null
}

function exactObject(value: unknown, expected: JsonRecord): boolean {
	return isRecord(value) && JSON.stringify(value) === JSON.stringify(expected)
}

function discoveryCommands(result: JsonRecord): { finding: string | null; commands: string[] } {
	if (!isRecord(result.data)) return { finding: fieldInvalid("result.data"), commands: [] }
	const data = result.data
	const dataKeys = ["contractVersion", "generationConventionVersion", "profile", "commands", "exitMeanings", "signalExits", "effectExclusions"] as const
	const dataShape = firstMissing(data, dataKeys, "result.data.") ?? firstUndeclared(data, dataKeys, "result.data.")
	if (dataShape !== null) return { finding: dataShape, commands: [] }
	const metadataFinding = firstInvalidField([
		{ path: "result.data.contractVersion", value: data.contractVersion, valid: (value) => value === CHECKER_CONTRACT_VERSION },
		{ path: "result.data.generationConventionVersion", value: data.generationConventionVersion, valid: (value) => value === CHECKER_CONTRACT_VERSION },
		{ path: "result.data.profile", value: data.profile, valid: (value) => ["simple", "complex"].includes(String(value)) },
	])
	if (metadataFinding !== null) return { finding: metadataFinding, commands: [] }
	if (!Array.isArray(data.commands) || data.commands.length === 0) return { finding: fieldInvalid("result.data.commands"), commands: [] }
	if (!data.commands.every(commandSummaryValid)) return { finding: fieldInvalid("result.data.commands"), commands: [] }
	const commands = data.commands.map((entry) => entry.commandIdentity as string)
	if (new Set(commands).size !== commands.length) return { finding: fieldInvalid("result.data.commands"), commands: [] }
	const exitMeanings = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" }
	if (!exactObject(data.exitMeanings, exitMeanings)) return { finding: fieldInvalid("result.data.exitMeanings"), commands: [] }
	if (!exactObject(data.signalExits, { "130": "SIGINT", "143": "SIGTERM" })) return { finding: fieldInvalid("result.data.signalExits"), commands: [] }
	if (!isStringArray(data.effectExclusions)) return { finding: fieldInvalid("result.data.effectExclusions"), commands: [] }
	return { finding: null, commands }
}

function validateSupported(value: JsonRecord, observedExit: number | null, declaredCommands: readonly string[] | undefined, discovery: boolean): TargetValidation {
	const version = CHECKER_CONTRACT_VERSION
	if (exceedsDepth(value)) return { observedContractVersion: version, findings: [SUCCESSOR_FINDINGS.TARGET_JSON_DEPTH_EXCEEDED], declaredCommands: [] }
	const topFinding = basicTopFinding(value)
	if (topFinding !== null) return { observedContractVersion: version, findings: [topFinding], declaredCommands: [] }
	if (!isRecord(value.result)) return { observedContractVersion: version, findings: ["TARGET_SCHEMA_INVALID:result"], declaredCommands: [] }
	const result = value.result
	const structural = basicResultFinding(result) ?? effectsFinding(result)
	if (structural !== null) return { observedContractVersion: version, findings: [structural], declaredCommands: [] }
	const semantic = retryFinding(result) ?? causeFinding(result, observedExit) ?? outcomeFinding(result) ?? effectCorrelationFinding(result) ?? diagnosticsFinding(value.diagnostics)
	if (semantic !== null) return { observedContractVersion: version, findings: [semantic], declaredCommands: [] }
	if (!sortedUnique(value.availablePaths as string[])) return { observedContractVersion: version, findings: [SUCCESSOR_FINDINGS.TARGET_AVAILABLE_PATHS_INVALID], declaredCommands: [] }
	if (declaredCommands !== undefined && ![result.commandIdentity, ...(value.availablePaths as string[])].every((identity) => declaredCommands.includes(identity as string))) return { observedContractVersion: version, findings: [SUCCESSOR_FINDINGS.TARGET_COMMAND_UNDECLARED], declaredCommands: [] }
	if (!discovery) return { observedContractVersion: version, findings: [], declaredCommands: [] }
	const declared = discoveryCommands(result)
	return { observedContractVersion: version, findings: declared.finding === null ? [] : [declared.finding], declaredCommands: declared.commands }
}

export function validateTargetEnvelope(value: unknown, observedExit: number | null, declaredCommands?: readonly string[], discovery = false): TargetValidation {
	const observedContractVersion = safeObservedVersion(value)
	if (!isRecord(value)) return { observedContractVersion, findings: [SUCCESSOR_FINDINGS.STDOUT_NOT_SINGLE_JSON_OBJECT], declaredCommands: [] }
	if (observedContractVersion !== CHECKER_CONTRACT_VERSION) return { observedContractVersion, findings: ["TARGET_CONTRACT_UNSUPPORTED"], declaredCommands: [] }
	return validateSupported(value, observedExit, declaredCommands, discovery)
}
