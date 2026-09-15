import { appendFileSync, chmodSync, writeFileSync } from "node:fs"

type JsonRecord = Record<string, unknown>

const mutation = process.env.CLI_DESIGN_SUCCESSOR_MUTATION ?? ""
const rawArgs = process.argv.slice(2)
const json = rawArgs.includes("--json")
const route = rawArgs.filter((arg) => arg !== "--json")

const COMMANDS = [
	{ commandIdentity: "fixture.discovery", route: ["--discover"], summary: "Describe the fixture contract", effectClass: "inspect" },
	{ commandIdentity: "fixture.effect", route: ["effect"], summary: "Return an authority refusal", effectClass: "repository-local" },
	{ commandIdentity: "fixture.help", route: ["--help"], summary: "Show fixture help", effectClass: "inspect" },
	{ commandIdentity: "fixture.internal", route: ["internal"], summary: "Return a bounded internal failure", effectClass: "inspect" },
	{ commandIdentity: "fixture.large", route: ["large"], summary: "Return a large success", effectClass: "inspect" },
	{ commandIdentity: "fixture.malformed", route: ["malformed"], summary: "Return a malformed-input refusal", effectClass: "inspect" },
	{ commandIdentity: "fixture.missing", route: ["missing"], summary: "Return a missing-input refusal", effectClass: "inspect" },
	{ commandIdentity: "fixture.schema", route: ["schema"], summary: "Return a schema refusal", effectClass: "inspect" },
	{ commandIdentity: "fixture.secret", route: ["secret"], summary: "Return a redacted success", effectClass: "inspect" },
	{ commandIdentity: "fixture.success", route: ["success"], summary: "Return a success", effectClass: "inspect" },
	{ commandIdentity: "fixture.transient", route: ["transient"], summary: "Return a transient refusal", effectClass: "repository-local" },
	{ commandIdentity: "fixture.usage", route: [], summary: "Return an invocation refusal", effectClass: "inspect" },
] as const

const EMPTY_EFFECTS = { completed: [], remaining: [], uncertain: [], inventoryComplete: true }
const HANDOFF = { owner: "operator", reason: "Inspect the bounded fixture failure.", inspect: ["fixture.internal"] }

function result(overrides: JsonRecord): JsonRecord {
	return {
		runId: "run-successor-fixture",
		commandIdentity: "fixture.success",
		outcome: "success",
		effectClass: "inspect",
		transactionState: "unchanged",
		causeCode: "SUCCESS_UNCHANGED",
		failureClass: null,
		exitCode: 0,
		data: { value: "ok" },
		retryable: false,
		repairAction: null,
		effects: EMPTY_EFFECTS,
		nextAction: "fixture.success",
		...overrides,
	}
}

function envelope(resultValue: JsonRecord): JsonRecord {
	const availablePaths = typeof resultValue.nextAction === "string" ? [resultValue.nextAction] : []
	return { envelopeVersion: 2, contractVersion: "2.0.0", message: "Fixture result produced.", availablePaths, result: resultValue }
}

function usageResult(): JsonRecord {
	return result({ commandIdentity: "fixture.usage", outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exitCode: 2, data: null, repairAction: "Choose a declared fixture command.", nextAction: "fixture.help" })
}

function discoveryResult(): JsonRecord {
	return result({
		commandIdentity: "fixture.discovery",
		data: {
			contractVersion: "2.0.0",
			generationConventionVersion: "2.0.0",
			profile: "complex",
			commands: COMMANDS,
			exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
			signalExits: { "130": "SIGINT", "143": "SIGTERM" },
			effectExclusions: [],
		},
		nextAction: "fixture.success",
	})
}

function missingResult(): JsonRecord {
	return result({ commandIdentity: "fixture.missing", outcome: "refused", causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exitCode: 3, data: null, repairAction: "Provide the missing fixture input.", nextAction: "fixture.success" })
}

function internalResult(): JsonRecord {
	const value = result({ commandIdentity: "fixture.internal", outcome: "failed", causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", exitCode: 1, data: null, repairAction: "Inspect the bounded fixture failure.", handoff: HANDOFF })
	delete value.nextAction
	return value
}

function schemaResult(): JsonRecord {
	return result({ commandIdentity: "fixture.schema", outcome: "refused", causeCode: "SCHEMA_INVALID_INPUT", failureClass: "schema", exitCode: 4, data: null, repairAction: "Correct the fixture input schema.", nextAction: "fixture.success" })
}

function malformedResult(): JsonRecord {
	return result({ commandIdentity: "fixture.malformed", outcome: "refused", causeCode: "SCHEMA_INVALID_INPUT", failureClass: "schema", exitCode: 4, data: null, repairAction: "Correct the malformed fixture value.", nextAction: "fixture.success" })
}

function transientResult(): JsonRecord {
	return result({ commandIdentity: "fixture.transient", outcome: "refused", effectClass: "repository-local", causeCode: "TRANSIENT_NOT_STARTED", failureClass: "transient", exitCode: 75, data: null, retryable: true, retryDelayMilliseconds: 25, repairAction: "Retry after the bounded delay.", effects: { completed: [], remaining: ["fixture-write"], uncertain: [], inventoryComplete: true }, nextAction: "fixture.transient" })
}

function effectResult(): JsonRecord {
	const value = result({ commandIdentity: "fixture.effect", outcome: "refused", effectClass: "repository-local", causeCode: "DOMAIN_AUTHORITY_REQUIRED", failureClass: "domain", exitCode: 3, data: null, repairAction: "Obtain authority before the fixture effect.", handoff: { owner: "human", reason: "Authority is required.", inspect: ["fixture.success"] } })
	delete value.nextAction
	return value
}

function deleteField(record: JsonRecord, key: string): JsonRecord {
	const copy = { ...record }
	delete copy[key]
	return copy
}

function nestedData(): JsonRecord {
	let value: unknown = "leaf"
	for (let depth = 0; depth < 66; depth += 1) value = { nested: value }
	return value as JsonRecord
}

function formatMutation(candidate: JsonRecord): JsonRecord {
	if (mutation === "format-v1-short") return { ...candidate, contractVersion: "1.0" }
	if (mutation === "format-v1-full") return { ...candidate, contractVersion: "1.0.0" }
	if (mutation === "format-v1-later") return { ...candidate, contractVersion: "1.2.3" }
	if (mutation === "format-v0") return { ...candidate, contractVersion: "0.9.0" }
	if (mutation === "format-missing") return deleteField(candidate, "contractVersion")
	if (mutation === "format-malformed") return { ...candidate, contractVersion: "2.0 beta" }
	if (mutation === "format-unrecognized") return { ...candidate, contractVersion: "banana" }
	if (mutation === "format-newer") return { ...candidate, contractVersion: "2.1.0" }
	if (mutation === "format-broken-v2") return { ...candidate, result: null }
	return candidate
}

function successMutation(candidate: JsonRecord): JsonRecord | string {
	if (mutation === "stdout-prose") return "not json\n"
	if (mutation === "field-missing") return { ...candidate, result: deleteField(candidate.result as JsonRecord, "runId") }
	if (mutation === "field-undeclared") return { ...candidate, result: { ...(candidate.result as JsonRecord), extra: true } }
	if (mutation === "field-invalid") return { ...candidate, message: 42 }
	if (mutation === "json-depth") return { ...candidate, result: { ...(candidate.result as JsonRecord), data: nestedData() } }
	if (mutation === "available-paths") return { ...candidate, availablePaths: ["fixture.success", "fixture.success"] }
	if (mutation === "command-undeclared") return { ...candidate, result: { ...(candidate.result as JsonRecord), commandIdentity: "fixture.undeclared" } }
	if (mutation === "success-repair-action") return { ...candidate, result: { ...(candidate.result as JsonRecord), repairAction: "Nothing to repair." } }
	if (mutation === "effects-invalid") return { ...candidate, result: { ...(candidate.result as JsonRecord), effectClass: "repository-local", transactionState: "completed", causeCode: "SUCCESS_COMPLETED", effects: { completed: ["x", "x"], remaining: [], uncertain: [], inventoryComplete: true } } }
	if (mutation === "inspect-effects") return { ...candidate, result: { ...(candidate.result as JsonRecord), effects: { completed: [], remaining: ["x"], uncertain: [], inventoryComplete: true } } }
	if (mutation === "success-remains") return { ...candidate, result: { ...(candidate.result as JsonRecord), effectClass: "repository-local", effects: { completed: [], remaining: ["x"], uncertain: [], inventoryComplete: true } } }
	if (mutation === "diagnostics-invalid") return { ...candidate, diagnostics: { status: "available" } }
	return candidate
}

function schemaMutation(candidate: JsonRecord): JsonRecord {
	const current = candidate.result as JsonRecord
	if (mutation === "cause-correlation") return { ...candidate, result: { ...current, outcome: "failed" } }
	if (mutation === "both-guidance") return { ...candidate, result: { ...current, handoff: { owner: "operator", reason: "Review.", inspect: ["fixture.schema"] } } }
	if (mutation === "neither-guidance") return { ...candidate, result: deleteField(current, "nextAction") }
	if (mutation === "wrong-guidance") return { ...candidate, result: { ...deleteField(current, "nextAction"), handoff: { owner: "operator", reason: "Review.", inspect: ["fixture.schema"] } } }
	if (mutation === "blank-next-action") return { ...candidate, result: { ...current, nextAction: "" } }
	if (mutation === "blank-repair-action") return { ...candidate, result: { ...current, repairAction: "" } }
	if (mutation === "nonretry-delay") return { ...candidate, result: { ...current, retryDelayMilliseconds: 25 } }
	if (mutation === "failure-data") return { ...candidate, result: { ...current, data: { unexpected: true } } }
	if (mutation === "effect-state") return { ...candidate, result: { ...current, effects: { completed: ["x"], remaining: [], uncertain: [], inventoryComplete: true } } }
	return candidate
}

function internalMutation(candidate: JsonRecord): JsonRecord {
	const current = candidate.result as JsonRecord
	if (mutation === "invalid-handoff") return { ...candidate, result: { ...current, handoff: { owner: "operator", reason: "", inspect: [] } } }
	if (mutation === "unresolved-retryable") return { ...candidate, result: { ...current, transactionState: "unknown", causeCode: "INTERNAL_RESULT_UNKNOWN", retryable: true, retryDelayMilliseconds: 25, effects: { completed: [], remaining: [], uncertain: ["x"], inventoryComplete: false } } }
	if (mutation === "attempted-effect") return { ...candidate, result: { ...current, attemptedEffect: "x" } }
	return candidate
}

function transientMutation(candidate: JsonRecord): JsonRecord {
	if (mutation !== "retry-delay-missing") return candidate
	return { ...candidate, result: deleteField(candidate.result as JsonRecord, "retryDelayMilliseconds") }
}

function mutate(candidate: JsonRecord, identity: string): JsonRecord | string {
	const formatted = formatMutation(candidate)
	if (formatted.contractVersion !== "2.0.0" || mutation === "format-broken-v2") return formatted
	if (identity === "fixture.success") return successMutation(formatted)
	if (identity === "fixture.schema") return schemaMutation(formatted)
	if (identity === "fixture.internal") return internalMutation(formatted)
	if (identity === "fixture.transient") return transientMutation(formatted)
	return formatted
}

function emit(candidate: JsonRecord, identity: string, exit: number): never {
	const transformed = mutate(candidate, identity)
	if (identity === "fixture.success" && mutation === "machine-stderr") process.stderr.write("fixture diagnostic\n")
	process.stdout.write(typeof transformed === "string" ? transformed : `${JSON.stringify(transformed)}\n`)
	process.exit(exit)
}

function maybeRecordInvocation(): void {
	const counter = process.env.CLI_DESIGN_INVOCATION_COUNTER
	if (counter !== undefined) appendFileSync(counter, "1\n")
	const retention = process.env.CLI_DESIGN_RETENTION_DIR
	if (retention !== undefined && rawArgs.length === 1 && rawArgs[0] === "--help") chmodSync(retention, 0o500)
}

function humanDiscovery(): never {
	if (mutation === "human-discovery-empty") process.stdout.write("")
	else if (mutation === "human-discovery-json") process.stdout.write("[]\n")
	else process.stdout.write("successor fixture commands: success, missing, internal, schema, transient\n")
	if (mutation === "human-discovery-stderr") process.stderr.write("fixture diagnostic\n")
	process.exit(0)
}

maybeRecordInvocation()

if (route.length === 1 && route[0] === "--help") {
	if (!json) {
		process.stdout.write("usage: successor-fixture <success|missing|malformed|internal|schema|transient|effect|secret|large> [--json]\n")
		process.exit(0)
	}
	emit(envelope(result({ commandIdentity: "fixture.help", data: { usage: "successor-fixture <command>" }, nextAction: "fixture.success" })), "fixture.help", 0)
}
if (route.length === 1 && route[0] === "--discover") {
	if (!json) humanDiscovery()
	emit(envelope(discoveryResult()), "fixture.discovery", 0)
}
if (route.length === 0) {
	if (!json) {
		process.stderr.write("successor-fixture: command required; run successor-fixture --help\n")
		process.exit(2)
	}
	emit(envelope(usageResult()), "fixture.usage", 2)
}
if (route.length !== 1 || !["success", "missing", "malformed", "internal", "schema", "transient", "effect", "secret", "large"].includes(route[0] as string)) {
	if (!json) {
		process.stderr.write("successor-fixture: unknown command; run successor-fixture --help\n")
		process.exit(2)
	}
	emit(envelope(usageResult()), "fixture.usage", 2)
}
if (route[0] === "success") {
	if (!json) {
		process.stdout.write("fixture success\n")
		process.exit(0)
	}
	emit(envelope(result({})), "fixture.success", 0)
}
if (route[0] === "missing") emit(envelope(missingResult()), "fixture.missing", 3)
if (route[0] === "malformed") emit(envelope(malformedResult()), "fixture.malformed", 4)
if (route[0] === "internal") emit(envelope(internalResult()), "fixture.internal", 1)
if (route[0] === "schema") {
	const exit = mutation === "exit-mismatch" ? 3 : 4
	emit(envelope(schemaResult()), "fixture.schema", exit)
}
if (route[0] === "effect") emit(envelope(effectResult()), "fixture.effect", 3)
if (route[0] === "secret") emit(envelope(result({ commandIdentity: "fixture.secret", data: { apiToken: "[REDACTED]" }, nextAction: "fixture.secret" })), "fixture.secret", 0)
if (route[0] === "large") {
	const candidate = envelope(result({ commandIdentity: "fixture.large", data: { payload: "x".repeat(1024 * 1024) }, nextAction: "fixture.large" }))
	writeFileSync(1, `${JSON.stringify(candidate)}\n`)
	process.exit(0)
}
emit(envelope(transientResult()), "fixture.transient", 75)
