// fallow-ignore-file code-duplication -- The accepted 2.0 successor must remain separate from the frozen 1.0 predecessor oracle and source boundary.
import { SUCCESSOR_FINDINGS, type JsonRecord, type ObservedVersion, validateTargetEnvelope } from "./contract.ts"

export interface ScenarioSpec {
	scenario: string
	argv: string[]
	expectedExit: number | readonly number[]
	kind: "human-help" | "human-discovery" | "human-refusal" | "human-success" | "machine"
	discovery?: boolean
	largeEnvelope?: boolean | undefined
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
	internalArgs: string[]
	schemaArgs: string[]
	transientArgs: string[]
	effectArgs?: string[] | undefined
	secretArgs?: string[] | undefined
	secretMarker?: string | undefined
	malformedArgs?: string[] | undefined
	largeArgs?: string[] | undefined
}

export interface ScenarioAnalysis {
	findings: string[]
	observedContractVersion: ObservedVersion
	declaredCommands: string[]
}

const JSON_FLAG = "--json"
const LARGE_ENVELOPE_THRESHOLD_BYTES = 1024 * 1024
const REDACTED = "[REDACTED]"
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i

function parseSingleJsonRecord(text: string): JsonRecord | null {
	if (text.trim() === "") return null
	try {
		const value: unknown = JSON.parse(text)
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
	} catch {
		return null
	}
}

function parsesAsObjectOrArray(text: string): boolean {
	try {
		const value: unknown = JSON.parse(text)
		return typeof value === "object" && value !== null
	} catch {
		return false
	}
}

function oneLine(text: string): boolean {
	const trimmed = text.replace(/(?:\r\n|\n|\r)+$/g, "")
	return trimmed.length > 0 && !/[\r\n]/.test(trimmed)
}

function humanFindings(spec: ScenarioSpec, result: ProcessResult): string[] {
	if (result.stderr !== "" && spec.kind !== "human-refusal") return [SUCCESSOR_FINDINGS.STDERR_NOT_EMPTY]
	if (spec.kind === "human-refusal") {
		if (result.stdout !== "") return ["STDOUT_NOT_EMPTY"]
		return oneLine(result.stderr) ? [] : ["STDERR_NOT_ONE_LINE"]
	}
	if (result.stdout === "") return [SUCCESSOR_FINDINGS.STDOUT_EMPTY]
	if (spec.kind === "human-help" && !/usage/i.test(result.stdout)) return ["HELP_MISSING_USAGE"]
	if ((spec.kind === "human-discovery" || spec.kind === "human-success") && parsesAsObjectOrArray(result.stdout)) return [SUCCESSOR_FINDINGS.HUMAN_OUTPUT_IS_JSON]
	return []
}

function secretKeyFindings(value: unknown, prefix = ""): string[] {
	if (typeof value !== "object" || value === null) return []
	return Object.entries(value).flatMap(([key, child]) => {
		const path = `${prefix}${key}`
		if (SECRET_KEY_PATTERN.test(key) && child !== REDACTED) return [`SECRET_KEY_NOT_REDACTED:${path}`]
		return secretKeyFindings(child, `${path}.`)
	})
}

function optionalFindings(spec: ScenarioSpec, result: ProcessResult, parsed: JsonRecord | null): string[] {
	const findings: string[] = []
	if (spec.largeEnvelope === true && parsed !== null && Buffer.byteLength(result.stdout, "utf8") < LARGE_ENVELOPE_THRESHOLD_BYTES) findings.push("LARGE_ENVELOPE_BELOW_THRESHOLD")
	if (spec.secretMarker !== undefined) {
		findings.push(...secretKeyFindings(parsed))
		if (result.stdout.includes(spec.secretMarker)) findings.push("SECRET_MARKER_LEAKED:stdout")
		if (result.stderr.includes(spec.secretMarker)) findings.push("SECRET_MARKER_LEAKED:stderr")
	}
	return findings
}

function exitAccepted(expected: number | readonly number[], observed: number | null): boolean {
	return typeof expected === "number" ? observed === expected : observed !== null && expected.includes(observed)
}

export function analyzeScenario(spec: ScenarioSpec, result: ProcessResult, declaredCommands?: readonly string[]): ScenarioAnalysis {
	if (result.timedOut) return { findings: ["PROMPTED_OR_HUNG"], observedContractVersion: null, declaredCommands: [] }
	if (spec.kind !== "machine") {
		const findings = humanFindings(spec, result)
		if (findings.length === 0 && !exitAccepted(spec.expectedExit, result.observedExit)) findings.push(SUCCESSOR_FINDINGS.EXIT_MISMATCH)
		return { findings, observedContractVersion: null, declaredCommands: [] }
	}
	const parsed = parseSingleJsonRecord(result.stdout)
	const optional = optionalFindings(spec, result, parsed)
	if (result.stderr !== "") return { findings: [...new Set([SUCCESSOR_FINDINGS.STDERR_NOT_EMPTY, ...optional])], observedContractVersion: null, declaredCommands: [] }
	if (parsed === null) return { findings: [...new Set([SUCCESSOR_FINDINGS.STDOUT_NOT_SINGLE_JSON_OBJECT, ...optional])], observedContractVersion: null, declaredCommands: [] }
	const validation = validateTargetEnvelope(parsed, result.observedExit, declaredCommands, spec.discovery === true)
	return { ...validation, findings: [...new Set([...validation.findings, ...optional])] }
}

interface OptionalRow {
	scenario: string
	argv: string[] | undefined
	expectedExit: number | readonly number[]
	largeEnvelope?: boolean | undefined
	secretMarker?: string | undefined
}

function optionalRows(options: ScenarioOptions): OptionalRow[] {
	const secretArgs = options.secretMarker === undefined ? undefined : options.secretArgs
	return [
		{ scenario: "malformed-value-json", argv: options.malformedArgs, expectedExit: [3, 4] },
		{ scenario: "large-envelope", argv: options.largeArgs, expectedExit: 0, largeEnvelope: true },
		{ scenario: "unauthorized-effect", argv: options.effectArgs, expectedExit: 3 },
		{ scenario: "secret-redaction", argv: secretArgs, expectedExit: 0, secretMarker: options.secretMarker },
	]
}

function optionalScenario(row: OptionalRow): ScenarioSpec[] {
	if (row.argv === undefined) return []
	return [{ scenario: row.scenario, argv: [...row.argv, JSON_FLAG], expectedExit: row.expectedExit, kind: "machine", largeEnvelope: row.largeEnvelope, secretMarker: row.secretMarker }]
}

export function skippedSuccessorScenarios(options: ScenarioOptions): string[] {
	return optionalRows(options).filter((row) => row.argv === undefined).map((row) => row.scenario)
}

export function buildSuccessorScenarios(options: ScenarioOptions): ScenarioSpec[] {
	return [
		{ scenario: "help-human", argv: ["--help"], expectedExit: 0, kind: "human-help" },
		{ scenario: "help-json", argv: ["--help", JSON_FLAG], expectedExit: 0, kind: "machine" },
		{ scenario: "discover-human", argv: ["--discover"], expectedExit: 0, kind: "human-discovery" },
		{ scenario: "discover-json", argv: ["--discover", JSON_FLAG], expectedExit: 0, kind: "machine", discovery: true },
		{ scenario: "no-arguments-human", argv: [], expectedExit: 2, kind: "human-refusal" },
		{ scenario: "no-arguments-json", argv: [JSON_FLAG], expectedExit: 2, kind: "machine" },
		{ scenario: "unknown-option-human", argv: ["--definitely-unknown-option"], expectedExit: 2, kind: "human-refusal" },
		{ scenario: "unknown-option-json", argv: ["--definitely-unknown-option", JSON_FLAG], expectedExit: 2, kind: "machine" },
		{ scenario: "success-human", argv: [...options.successArgs], expectedExit: 0, kind: "human-success" },
		{ scenario: "success-json", argv: [...options.successArgs, JSON_FLAG], expectedExit: 0, kind: "machine" },
		{ scenario: "missing-input-json", argv: [...options.missingArgs, JSON_FLAG], expectedExit: 3, kind: "machine" },
		...optionalRows(options).flatMap(optionalScenario),
		{ scenario: "internal-failure-json", argv: [...options.internalArgs, JSON_FLAG], expectedExit: 1, kind: "machine" },
		{ scenario: "schema-refusal-json", argv: [...options.schemaArgs, JSON_FLAG], expectedExit: 4, kind: "machine" },
		{ scenario: "transient-refusal-json", argv: [...options.transientArgs, JSON_FLAG], expectedExit: 75, kind: "machine" },
	]
}
