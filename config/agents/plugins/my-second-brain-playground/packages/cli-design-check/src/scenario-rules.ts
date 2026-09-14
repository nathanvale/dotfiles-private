import {
	discoveryFindings,
	envelopeFieldInvalid,
	envelopeFindings,
	FINDINGS,
	isRecord,
	type JsonRecord,
	REDACTED,
	SECRET_KEY_PATTERN,
} from "./contract.ts"

export interface ScenarioSpec {
	scenario: string
	argv: string[]
	// One exit, or the closed set a row accepts (the malformed row: domain with 3 or schema with 4).
	expectedExit: number | readonly number[]
	secretMarker?: string | undefined
}

export interface ProcessResult {
	stdout: string
	stderr: string
	observedExit: number | null
	timedOut: boolean
	durationMilliseconds: number
}

export interface ScenarioOptions {
	successArgs: string[]
	missingArgs: string[]
	effectArgs?: string[] | undefined
	secretArgs?: string[] | undefined
	secretMarker?: string | undefined
	malformedArgs?: string[] | undefined
	largeArgs?: string[] | undefined
}

interface Observation {
	spec: ScenarioSpec
	result: ProcessResult
	stdoutObject: JsonRecord | null
	stderrObject: JsonRecord | null
}

type Rule = (observation: Observation) => string[]
type Expectation = readonly [field: string, accept: (value: unknown) => boolean]

const JSON_FLAG = "--json"

function isOneNonEmptyLine(text: string): boolean {
	const withoutTrailingNewlines = text.replace(/(?:\r\n|\n|\r)+$/g, "")
	return withoutTrailingNewlines.length > 0 && !/[\r\n]/.test(withoutTrailingNewlines)
}

function when(failed: boolean, finding: string): string[] {
	return failed ? [finding] : []
}

function parseSingleJsonObject(text: string): JsonRecord | null {
	if (text.trim() === "") return null
	try {
		const value: unknown = JSON.parse(text)
		return isRecord(value) ? value : null
	} catch {
		return null
	}
}

function secretMarkerLeaked(stream: string): string {
	return `${FINDINGS.SECRET_MARKER_LEAKED}:${stream}`
}

function secretKeyEntryFindings(path: string, key: string, child: unknown): string[] {
	if (SECRET_KEY_PATTERN.test(key) && child !== REDACTED) return [`${FINDINGS.SECRET_KEY_NOT_REDACTED}:${path}`]
	return secretKeyFindings(child, `${path}.`)
}

// Walks objects and arrays; a key matching the secret pattern must hold the literal redaction marker.
function secretKeyFindings(value: unknown, prefix = ""): string[] {
	if (!isRecord(value) && !Array.isArray(value)) return []
	return Object.entries(value).flatMap(([key, child]) => secretKeyEntryFindings(`${prefix}${key}`, key, child))
}

const helpRule: Rule = ({ result }) => [
	...when(result.stdout.length === 0, FINDINGS.STDOUT_EMPTY),
	...when(result.stdout.length > 0 && !/usage/i.test(result.stdout), FINDINGS.HELP_MISSING_USAGE),
]

const humanRefusalRule: Rule = ({ result }) => [
	...when(result.stdout.length !== 0, FINDINGS.STDOUT_NOT_EMPTY),
	...when(!isOneNonEmptyLine(result.stderr), FINDINGS.STDERR_NOT_ONE_LINE),
]

// CC:42: human output is prose. A JSON object or array is machine output; a bare number or string still reads as prose.
function isJsonStructure(text: string): boolean {
	if (text.trim() === "") return false
	try {
		const value: unknown = JSON.parse(text)
		return isRecord(value) || Array.isArray(value)
	} catch {
		return false
	}
}

const humanSuccessRule: Rule = ({ result }) => [
	...when(result.stdout.length === 0, FINDINGS.STDOUT_EMPTY),
	...when(isJsonStructure(result.stdout), FINDINGS.HUMAN_OUTPUT_IS_JSON),
]

const stderrEmptyRule: Rule = ({ result }) => when(result.stderr.length !== 0, FINDINGS.STDERR_NOT_EMPTY)

// Every --json scenario shares one stderr discipline: silent, and never a JSON object.
const jsonStderrRule: Rule = ({ result, stderrObject }) => [
	...when(result.stderr.length !== 0, FINDINGS.STDERR_NOT_EMPTY),
	...when(stderrObject !== null, FINDINGS.JSON_ON_STDERR),
]

const envelopeRule: Rule = ({ result, stdoutObject }) => {
	if (stdoutObject === null) return [FINDINGS.STDOUT_NOT_SINGLE_JSON_OBJECT]
	return envelopeFindings(stdoutObject, result.observedExit ?? undefined)
}

const discoveryRule: Rule = ({ stdoutObject }) => (stdoutObject === null ? [] : discoveryFindings(stdoutObject))

// 1 MiB: below it, truncation through the checker's reader was never observed on Bun 1.4.0.
const LARGE_ENVELOPE_THRESHOLD_BYTES = 1024 * 1024

// A declared large success must arrive complete; a parseable envelope under the threshold proves nothing about draining.
const largeEnvelopeRule: Rule = ({ result, stdoutObject }) =>
	when(stdoutObject !== null && Buffer.byteLength(result.stdout, "utf8") < LARGE_ENVELOPE_THRESHOLD_BYTES, FINDINGS.LARGE_ENVELOPE_BELOW_THRESHOLD)

function expecting(expectations: readonly Expectation[]): Rule {
	return ({ stdoutObject }) => {
		if (stdoutObject === null) return []
		return expectations.filter(([field, accept]) => !accept(stdoutObject[field])).map(([field]) => envelopeFieldInvalid(field))
	}
}

const secretRule: Rule = ({ spec, result, stdoutObject }) => {
	const marker = spec.secretMarker ?? ""
	return [
		...secretKeyFindings(stdoutObject?.result),
		...when(marker !== "" && result.stdout.includes(marker), secretMarkerLeaked("stdout")),
		...when(marker !== "" && result.stderr.includes(marker), secretMarkerLeaked("stderr")),
	]
}

const isUnchanged = (value: unknown): boolean => value === "unchanged"
const isFalse = (value: unknown): boolean => value === false
const isDomain = (value: unknown): boolean => value === "domain"
const isRefused = (value: unknown): boolean => value === "refused"

// A usage refusal in machine mode: bare --json and an unknown option share one shape (CC:44).
const usageRefusalRules: readonly Rule[] = [
	envelopeRule,
	expecting([
		["outcome", isRefused],
		["failureClass", (value) => value === "usage"],
		["causeCode", (value) => typeof value === "string" && value.startsWith("USAGE_")],
		["transactionState", isUnchanged],
	]),
	jsonStderrRule,
]

const RULES: Readonly<Record<string, readonly Rule[]>> = {
	help: [helpRule, stderrEmptyRule],
	"help-json": [envelopeRule, jsonStderrRule],
	discover: [envelopeRule, discoveryRule, jsonStderrRule],
	"no-arguments": [humanRefusalRule],
	"no-arguments-json": usageRefusalRules,
	"unknown-option": [humanRefusalRule],
	"unknown-option-json": usageRefusalRules,
	"success-human": [humanSuccessRule, stderrEmptyRule],
	"success-json": [
		envelopeRule,
		expecting([
			["outcome", (value) => value === "success"],
			["failureClass", (value) => value === null],
			["transactionState", isUnchanged],
		]),
		jsonStderrRule,
	],
	"missing-input": [
		envelopeRule,
		expecting([
			["outcome", (value) => value === "refused" || value === "failed"],
			["failureClass", isDomain],
			["retryable", isFalse],
			["transactionState", isUnchanged],
			["repairAction", (value) => typeof value === "string" && value.length > 0],
		]),
		jsonStderrRule,
	],
	// A malformed declared value is refused or failed as domain or schema (class not pinned, B-10),
	// exit aligned, unchanged, with repair guidance (CC:10, CC:11, CC:68).
	"malformed-value-json": [
		envelopeRule,
		expecting([
			["outcome", (value) => value === "refused" || value === "failed"],
			["failureClass", (value) => value === "domain" || value === "schema"],
			["retryable", isFalse],
			["transactionState", isUnchanged],
			["repairAction", (value) => typeof value === "string" && value.length > 0],
		]),
		jsonStderrRule,
	],
	"unauthorized-effect": [
		envelopeRule,
		expecting([
			["outcome", isRefused],
			["failureClass", isDomain],
			["transactionState", isUnchanged],
			["retryable", isFalse],
		]),
		jsonStderrRule,
	],
	"secret-redaction": [envelopeRule, secretRule, jsonStderrRule],
	"large-envelope": [envelopeRule, largeEnvelopeRule, jsonStderrRule],
}

function exitAccepted(expectedExit: number | readonly number[], observedExit: number | null): boolean {
	return typeof expectedExit === "number" ? observedExit === expectedExit : observedExit !== null && expectedExit.includes(observedExit)
}

export function scenarioFindings(spec: ScenarioSpec, result: ProcessResult): string[] {
	const observation: Observation = {
		spec,
		result,
		stdoutObject: parseSingleJsonObject(result.stdout),
		stderrObject: parseSingleJsonObject(result.stderr),
	}
	const rules = RULES[spec.scenario] ?? []
	const findings = [
		...when(result.timedOut, FINDINGS.PROMPTED_OR_HUNG),
		...rules.flatMap((rule) => rule(observation)),
		...when(!exitAccepted(spec.expectedExit, result.observedExit), FINDINGS.EXIT_MISMATCH),
	]
	return [...new Set(findings)]
}

interface OptionalRow {
	scenario: string
	argv: string[] | undefined
	expectedExit: number | readonly number[]
	secretMarker?: string | undefined
}

// One table owns the optional rows: a supplied row runs, an unsupplied one is reported as skipped (O-18).
function optionalRows(options: ScenarioOptions): OptionalRow[] {
	const secretArgs = options.secretMarker === undefined ? undefined : options.secretArgs
	return [
		{ scenario: "malformed-value-json", argv: options.malformedArgs, expectedExit: [3, 4] },
		{ scenario: "large-envelope", argv: options.largeArgs, expectedExit: 0 },
		{ scenario: "unauthorized-effect", argv: options.effectArgs, expectedExit: 3 },
		{ scenario: "secret-redaction", argv: secretArgs, expectedExit: 0, secretMarker: options.secretMarker },
	]
}

function optionalScenario(row: OptionalRow): ScenarioSpec[] {
	if (row.argv === undefined) return []
	return [{ scenario: row.scenario, argv: [...row.argv, JSON_FLAG], expectedExit: row.expectedExit, secretMarker: row.secretMarker }]
}

export function skippedScenarios(options: ScenarioOptions): string[] {
	return optionalRows(options)
		.filter((row) => row.argv === undefined)
		.map((row) => row.scenario)
}

export function buildScenarios(options: ScenarioOptions): ScenarioSpec[] {
	return [
		{ scenario: "help", argv: ["--help"], expectedExit: 0 },
		{ scenario: "help-json", argv: [JSON_FLAG, "--help"], expectedExit: 0 },
		{ scenario: "discover", argv: ["--discover", JSON_FLAG], expectedExit: 0 },
		{ scenario: "no-arguments", argv: [], expectedExit: 2 },
		{ scenario: "no-arguments-json", argv: [JSON_FLAG], expectedExit: 2 },
		{ scenario: "unknown-option", argv: ["--definitely-unknown-option"], expectedExit: 2 },
		{ scenario: "unknown-option-json", argv: ["--definitely-unknown-option", JSON_FLAG], expectedExit: 2 },
		{ scenario: "success-human", argv: [...options.successArgs], expectedExit: 0 },
		{ scenario: "success-json", argv: [...options.successArgs, JSON_FLAG], expectedExit: 0 },
		{ scenario: "missing-input", argv: [...options.missingArgs, JSON_FLAG], expectedExit: 3 },
		...optionalRows(options).flatMap(optionalScenario),
	]
}
