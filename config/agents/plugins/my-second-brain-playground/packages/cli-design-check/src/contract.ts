export const ENVELOPE_VERSION = 1 as const
export const CONTRACT_VERSION = "1.0.0" as const
const GENERATION_CONVENTION_VERSION = "1.0.0" as const
const MACHINE_MODE = "--json" as const
export const REDACTED = "[REDACTED]"

const EXIT_MEANINGS = {
	"0": "success",
	"1": "internal",
	"2": "usage",
	"3": "domain",
	"4": "schema",
	"75": "unavailable",
} as const

const OUTCOMES = ["success", "refused", "failed", "unknown"] as const
const FAILURE_OUTCOMES: readonly unknown[] = OUTCOMES.filter((outcome) => outcome !== "success")
const FAILURE_CLASSES = ["usage", "domain", "schema", "internal", "unavailable"] as const
const EFFECT_CLASSES = ["inspect", "repository-local", "external"] as const
const TRANSACTION_STATES = ["unchanged", "completed", "partially-completed", "rolled-back", "unknown"] as const

export const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i
const CAUSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

export const FINDINGS = {
	EXIT_MISMATCH: "EXIT_MISMATCH",
	STDOUT_NOT_EMPTY: "STDOUT_NOT_EMPTY",
	STDOUT_EMPTY: "STDOUT_EMPTY",
	STDERR_NOT_EMPTY: "STDERR_NOT_EMPTY",
	STDERR_NOT_ONE_LINE: "STDERR_NOT_ONE_LINE",
	STDOUT_NOT_SINGLE_JSON_OBJECT: "STDOUT_NOT_SINGLE_JSON_OBJECT",
	JSON_ON_STDERR: "JSON_ON_STDERR",
	PROMPTED_OR_HUNG: "PROMPTED_OR_HUNG",
	TARGET_MUTATED: "TARGET_MUTATED",
	HUMAN_OUTPUT_IS_JSON: "HUMAN_OUTPUT_IS_JSON",
	HELP_MISSING_USAGE: "HELP_MISSING_USAGE",
	ENVELOPE_NEXT_STEP_RULE: "ENVELOPE_NEXT_STEP_RULE",
	SECRET_MARKER_LEAKED: "SECRET_MARKER_LEAKED",
	SECRET_KEY_NOT_REDACTED: "SECRET_KEY_NOT_REDACTED",
} as const

export type JsonRecord = Record<string, unknown>
type FailureClass = (typeof FAILURE_CLASSES)[number]
type Check = (value: unknown) => boolean
type FieldCheck = readonly [field: string, accept: Check]
type FindingName = (field: string) => string

export interface MachineEnvelope {
	envelopeVersion: typeof ENVELOPE_VERSION
	contractVersion: typeof CONTRACT_VERSION
	commandIdentity: string
	runIdentity: string
	outcome: (typeof OUTCOMES)[number]
	failureClass: (typeof FAILURE_CLASSES)[number] | null
	causeCode: string | null
	message: string
	effectClass: (typeof EFFECT_CLASSES)[number]
	transactionState: (typeof TRANSACTION_STATES)[number]
	retryable: boolean
	retryDelayMilliseconds: number | null
	nextAction: string | null
	availablePaths: string[]
	repairAction: string | null
	handoff: { reason: string; prerequisites: string[] } | null
	result: JsonRecord | null
}

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

const isString: Check = (value) => typeof value === "string"
const isBoolean: Check = (value) => typeof value === "boolean"
const isNonEmptyString: Check = (value) => typeof value === "string" && value.length > 0
const isNonNegativeNumber: Check = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const isStringArray: Check = (value) => Array.isArray(value) && value.every(isString)
const isPresent: Check = (value) => value !== null && value !== undefined
const equals = (expected: unknown): Check => (value) => value === expected
const oneOf = (allowed: readonly unknown[]): Check => (value) => allowed.includes(value)
const nullable = (accept: Check): Check => (value) => value === null || accept(value)
const isValidFailureClass = nullable(oneOf(FAILURE_CLASSES))
const isHandoff: Check = (value) => isRecord(value) && isString(value.reason) && isStringArray(value.prerequisites)

function hasOwn(value: JsonRecord, field: string): boolean {
	return Object.hasOwn(value, field)
}

function unique(findings: string[]): string[] {
	return [...new Set(findings)]
}

function envelopeFieldMissing(field: string): string {
	return `ENVELOPE_FIELD_MISSING:${field}`
}

export function envelopeFieldInvalid(field: string): string {
	return `ENVELOPE_FIELD_INVALID:${field}`
}

function discoveryFieldMissing(field: string): string {
	return `DISCOVERY_FIELD_MISSING:${field}`
}

function fieldFinding(record: JsonRecord, check: FieldCheck, missing: FindingName, invalid: FindingName): string[] {
	const [field, accept] = check
	if (!hasOwn(record, field)) return [missing(field)]
	return accept(record[field]) ? [] : [invalid(field)]
}

function fieldFindings(record: JsonRecord, checks: readonly FieldCheck[], missing: FindingName, invalid: FindingName): string[] {
	return checks.flatMap((check) => fieldFinding(record, check, missing, invalid))
}

const ENVELOPE_FIELD_CHECKS: readonly FieldCheck[] = [
	["envelopeVersion", equals(ENVELOPE_VERSION)],
	["contractVersion", equals(CONTRACT_VERSION)],
	["commandIdentity", isNonEmptyString],
	["runIdentity", isNonEmptyString],
	["outcome", oneOf(OUTCOMES)],
	["failureClass", isValidFailureClass],
	["causeCode", nullable((value) => typeof value === "string" && CAUSE_CODE_PATTERN.test(value))],
	["message", isString],
	["effectClass", oneOf(EFFECT_CLASSES)],
	["transactionState", oneOf(TRANSACTION_STATES)],
	["retryable", isBoolean],
	["retryDelayMilliseconds", nullable(isNonNegativeNumber)],
	["nextAction", nullable(isString)],
	["availablePaths", isStringArray],
	["repairAction", nullable(isString)],
	["handoff", nullable(isHandoff)],
	["result", nullable(isRecord)],
]

const EXIT_FOR_MEANING = new Map(Object.entries(EXIT_MEANINGS).map(([code, meaning]) => [meaning, Number(code)]))

function isCauseCode(value: unknown, failureClass: FailureClass | null): boolean {
	if (failureClass === null) return value === null
	return typeof value === "string" && CAUSE_CODE_PATTERN.test(value) && value.startsWith(`${failureClass.toUpperCase()}_`)
}

function outcomeMatchesFailureClass(value: JsonRecord): boolean {
	if (!hasOwn(value, "outcome") || !hasOwn(value, "failureClass")) return true
	return (value.outcome === "success") === (value.failureClass === null)
}

function causeCodeMatchesFailureClass(value: JsonRecord): boolean {
	if (!hasOwn(value, "causeCode") || !isValidFailureClass(value.failureClass)) return true
	return isCauseCode(value.causeCode, value.failureClass as FailureClass | null)
}

// On a refused, failed, or unknown outcome exactly one of nextAction or handoff is non-null.
function nextStepRuleHolds(value: JsonRecord): boolean {
	if (!FAILURE_OUTCOMES.includes(value.outcome)) return true
	return isPresent(value.nextAction) !== isPresent(value.handoff)
}

function crossFieldFindings(value: JsonRecord): string[] {
	const rules: ReadonlyArray<readonly [finding: string, holds: boolean]> = [
		[envelopeFieldInvalid("outcome"), outcomeMatchesFailureClass(value)],
		[envelopeFieldInvalid("causeCode"), causeCodeMatchesFailureClass(value)],
		[FINDINGS.ENVELOPE_NEXT_STEP_RULE, nextStepRuleHolds(value)],
	]
	return rules.filter(([, holds]) => !holds).map(([finding]) => finding)
}

function exitAlignmentFindings(value: JsonRecord, observedExit: number | undefined): string[] {
	if (observedExit === undefined || !isValidFailureClass(value.failureClass)) return []
	const expectedExit = EXIT_FOR_MEANING.get((value.failureClass as FailureClass | null) ?? "success")
	return expectedExit === observedExit ? [] : [envelopeFieldInvalid("failureClass")]
}

export function envelopeFindings(value: unknown, observedExit?: number): string[] {
	if (!isRecord(value)) return []
	return unique([
		...fieldFindings(value, ENVELOPE_FIELD_CHECKS, envelopeFieldMissing, envelopeFieldInvalid),
		...crossFieldFindings(value),
		...exitAlignmentFindings(value, observedExit),
	])
}

const COMMAND_FIELD_CHECKS: readonly FieldCheck[] = [
	["identity", isString],
	["argv", isString],
	["effectClass", oneOf(EFFECT_CLASSES)],
	["description", isString],
]
const acceptsCommandFields = (command: JsonRecord): boolean => COMMAND_FIELD_CHECKS.every(([field, accept]) => accept(command[field]))
const isCommand: Check = (value) => isRecord(value) && acceptsCommandFields(value)
const isCommandList: Check = (value) => Array.isArray(value) && value.length > 0 && value.every(isCommand)

const DISCOVERY_FIELD_CHECKS: readonly FieldCheck[] = [
	["name", isString],
	["contractVersion", equals(CONTRACT_VERSION)],
	["generationConventionVersion", equals(GENERATION_CONVENTION_VERSION)],
	["machineMode", equals(MACHINE_MODE)],
	["commands", isCommandList],
	["exitMeanings", isRecord],
	["logtape", isBoolean],
]

function exitMeaningFindings(result: JsonRecord): string[] {
	if (!isRecord(result.exitMeanings)) return []
	const exitMeanings = result.exitMeanings
	return Object.keys(EXIT_MEANINGS)
		.filter((code) => !hasOwn(exitMeanings, code))
		.map((code) => discoveryFieldMissing(`exitMeanings.${code}`))
}

export function discoveryFindings(value: unknown): string[] {
	if (!isRecord(value) || !isRecord(value.result)) return [discoveryFieldMissing("result")]
	const result = value.result
	const invalid: FindingName = (field) => envelopeFieldInvalid(`result.${field}`)
	return unique([...fieldFindings(result, DISCOVERY_FIELD_CHECKS, discoveryFieldMissing, invalid), ...exitMeaningFindings(result)])
}

