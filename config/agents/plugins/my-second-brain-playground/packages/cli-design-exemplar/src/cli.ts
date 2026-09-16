import { parseArgs } from "node:util"
import {
	COMMANDS,
	CONTRACT_VERSION,
	declarationForIdentity,
	declarationForRoute,
	DISCOVER_PATH,
	discovery,
	ENVELOPE_VERSION,
	EXIT_MEANINGS,
	exitFor,
	HELP_DATA,
	HELP_PATH,
	INSPECT_ACTION,
	isSafeJson,
	MachineEnvelopeSchema,
	mintAuthorization,
	PARSE_ARGS_CONFIG,
	parseResourceId,
	type CliRoute,
	type CommandIdentity,
	type CommandRoute,
	type ContractResult,
	type Diagnostics,
	type Effects,
	type EnvelopeV2,
	type Handoff,
	type JsonValue,
	type WireCauseCode,
} from "./command-contract.ts"
import { type DiagnosticsStatus, openRunDiagnostics } from "./diagnostics.ts"
import { type Decision, decide, factsOf, type ParsedRequest } from "./engine.ts"
import type { EgressFault, ExecutionFacts, Faults } from "./model.ts"
import { createOperationDeadline } from "./operation-deadline.ts"
import { createRuntime, parseFaults, resolveRoot, RETRY_DELAY_MS } from "./runtime.ts"
import { commandDiscovery, type PublicStation, wireGuidance } from "./station-catalogue.ts"

// run(argv, io, env): parsing with node:util parseArgs (strict), --json detection anywhere in raw argv, identity derived
// from the raw argv command word before strict parsing, human rendering literal to the fixture lines, and the one
// two-stage machine writer emitMachine with the accepted D6-c fallback (brief 12, sections 3.4, 5 and 7.2).

export interface Io {
	stdout(text: string): void
	stderr(text: string): void
}

const HELP_TEXT = "repair-lab: inspect, preview, apply and repair a fixture-local resource with journal-backed recovery\nusage: repair-lab <command> [options] [--json]\n\ncommands:\n  status                              report the resource status\n  inspect [--state <path>] [--include-diagnostics]\n  apply --preview                     write an apply preview\n  apply --preview-id <id> --authorize fixture-authority\n  repair --preview | repair --apply --preview-id <id> --authorize fixture-authority\n  repair --apply --retry-once --authorize fixture-authority\n  recover                             report recovery state from the journal\n  --discover --json                   describe commands and the contract\n  --discover-command <identity>       describe the possible outcomes of one command\n\nexample:\n  repair-lab status --json\n"

export type Routed = { identity: CommandIdentity; route: CliRoute }

function controls(argv: readonly string[]): readonly string[] {
	const delimiter = argv.indexOf("--")
	return delimiter === -1 ? argv : argv.slice(0, delimiter)
}

export function machineMode(argv: readonly string[]): boolean {
	return controls(argv).includes("--json")
}

function routed(route: CliRoute): Routed { return { identity: declarationForRoute(route).identity, route } }

// Built-in help, discovery and command-discovery options are mutually exclusive (accepted C0): any two together, or a
// command-discovery selector that is missing or option-shaped, is the dispatch refusal before strict parsing.
function builtInRoute(beforeDelimiter: readonly string[]): Routed | undefined {
	const help = beforeDelimiter.includes("--help")
	const discover = beforeDelimiter.includes("--discover")
	const selectorIndex = beforeDelimiter.indexOf("--discover-command")
	const discoverCommand = selectorIndex !== -1
	if ((help && discover) || (help && discoverCommand) || (discover && discoverCommand)) return routed("dispatch")
	if (help) return routed("help")
	if (discover) return routed("discover")
	if (!discoverCommand) return undefined
	const selector = beforeDelimiter[selectorIndex + 1]
	return selector === undefined || selector.startsWith("-") ? routed("dispatch") : routed("command-discovery")
}

// Identity is derived from the raw argv command word and route flags before strict parsing, so a usage refusal keeps
// the routed identity (brief 12, section 3.4 and the 7.3 gotcha).
export function routeRawArgv(argv: readonly string[]): Routed {
	const beforeDelimiter = controls(argv)
	const builtIn = builtInRoute(beforeDelimiter)
	if (builtIn !== undefined) return builtIn
	const word = beforeDelimiter.find((token) => !token.startsWith("-"))
	if (word === undefined) return routed("dispatch")
	switch (word) {
		case "status":
			return routed("status")
		case "inspect":
			return beforeDelimiter.includes("--include-diagnostics") ? routed("inspect-diagnostics") : routed("inspect")
		case "apply":
			return beforeDelimiter.includes("--preview") ? routed("preview") : routed("apply")
		case "repair":
			if (beforeDelimiter.includes("--retry-once")) return routed("repair-retry")
			return beforeDelimiter.includes("--preview") && !beforeDelimiter.includes("--apply") ? routed("repair-preview") : routed("repair")
		case "recover":
			return routed("recover")
		default:
			return routed("help")
	}
}

type Parsed = ReturnType<typeof parseArgs<typeof PARSE_ARGS_CONFIG>>

type UsageCause = "USAGE_UNKNOWN_OPTION" | "USAGE_COMMAND_REQUIRED" | "USAGE_UNKNOWN_COMMAND" | "USAGE_INVALID_ARGUMENTS"

// The stable parse-error classification (PR 184, thread 4003813436): only an unknown option is USAGE_UNKNOWN_OPTION; a
// known option with a missing, option-like or forbidden value is malformed input, USAGE_INVALID_ARGUMENTS.
function parse(argv: readonly string[]): Parsed | { usage: UsageCause; message: string } {
	try {
		return parseArgs({
			...PARSE_ARGS_CONFIG,
			args: [...argv],
		})
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined
		return code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? { usage: "USAGE_UNKNOWN_OPTION", message: "unknown option" } : { usage: "USAGE_INVALID_ARGUMENTS", message: "malformed option value" }
	}
}

// The command-contract route declaration owns the one command word and admitted options. This check runs before root
// resolution, diagnostics or any state read (PR 184, thread 4003813481).
function shapeViolation(parsed: Parsed, route: Exclude<CliRoute, "dispatch">): string | null {
	const shape = declarationForRoute(route)
	if (route === "help" || route === "discover" || route === "command-discovery") {
		if (parsed.positionals.length !== 0) return `${shape.word} takes no positional arguments`
	} else if (parsed.positionals.length !== 1 || parsed.positionals[0] !== shape.word) return `${shape.word} takes no further positional arguments`
	const allowed = new Set<string>(shape.allowedOptions)
	const stray = Object.keys(parsed.values).find((name) => !allowed.has(name))
	if (stray !== undefined) return `--${stray} is not an option of ${shape.word}`
	const missing = shape.requiredOptions.find((name) => parsed.values[name] === undefined)
	return missing === undefined ? null : `${shape.word} requires --${missing}`
}

function usageFacts(identity: CommandIdentity, runIdentity: string): ExecutionFacts {
	const { effectClass } = declarationForIdentity(identity)
	return { commandIdentity: identity, runIdentity, domainOutcome: "refused", effectClass, transactionState: "unchanged", completedEffectIds: [], remainingEffectIds: [], inventoryComplete: true, stationLabel: "repair-lab.usage", guidance: { kind: "next-action", target: "repair-lab inspect" } }
}

function pathIdentity(instruction: string | undefined): string | undefined {
	if (instruction === undefined) return undefined
	if (instruction === HELP_PATH) return "repair-lab.help"
	if (instruction === DISCOVER_PATH) return "repair-lab.discovery"
	if (instruction === INSPECT_ACTION) return "repair-lab.inspect"
	if (instruction.startsWith("repair-lab apply")) return "repair-lab.apply"
	if (instruction.startsWith("repair-lab repair")) return "repair-lab.repair"
	return undefined
}
function paths(...extra: Array<string | undefined>): string[] { return [...new Set(["repair-lab.help", "repair-lab.discovery", ...extra.map(pathIdentity).filter((value): value is string => value !== undefined)])].sort() }
function unchangedEffects(facts: ExecutionFacts, successful = false): Effects { return { completed: [], remaining: successful ? [] : [...facts.remainingEffectIds].sort(), uncertain: [], inventoryComplete: true } }
function nonempty(values: readonly string[]): [string, ...string[]] | null { const sorted = [...values].sort(); const first = sorted[0]; return first === undefined ? null : [first, ...sorted.slice(1)] }
function completedEffects(facts: ExecutionFacts): Extract<ContractResult, { transactionState: "completed" }>["effects"] | null { const completed = nonempty(facts.completedEffectIds); return completed === null ? null : { completed, remaining: [], uncertain: [], inventoryComplete: true } }
function partialEffects(facts: ExecutionFacts): Extract<ContractResult, { transactionState: "partially-completed" }>["effects"] | null { const completed = nonempty(facts.completedEffectIds); const remaining = nonempty(facts.remainingEffectIds); return completed === null || remaining === null ? null : { completed, remaining, uncertain: [], inventoryComplete: true } }
// An unknown state lists every non-completed effect as uncertain; the inventory is complete only when the facts say so
// and at least one effect is uncertain (a scan cut at its bound reports inventoryComplete false).
function unknownEffects(facts: ExecutionFacts): Effects { const uncertain = [...facts.remainingEffectIds].sort(); return { completed: [...facts.completedEffectIds].sort(), remaining: [], uncertain, inventoryComplete: facts.inventoryComplete && uncertain.length > 0 } }
// Every wire next action, handoff and repair action comes from the one station guidance owner, never from a
// scenario-specific decision string, so each derived identity has exactly the meaning its PublicStation publishes.
function nextActionOf(identity: CommandIdentity, cause: WireCauseCode): string {
	const { guidance } = wireGuidance(identity, cause)
	if (!("nextAction" in guidance)) throw new Error(`station guidance for ${cause} is a handoff`)
	return guidance.nextAction
}
function handoffOf(identity: CommandIdentity, cause: WireCauseCode): Handoff {
	const { guidance } = wireGuidance(identity, cause)
	if (!("handoff" in guidance)) throw new Error(`station guidance for ${cause} is a next action`)
	return guidance.handoff
}
function repairActionOf(identity: CommandIdentity, cause: WireCauseCode): string {
	const { repairAction } = wireGuidance(identity, cause)
	if (repairAction === null) throw new Error(`station guidance for ${cause} has no repair action`)
	return repairAction
}
function envelope(message: string, result: ContractResult, diagnostics?: Diagnostics): EnvelopeV2 { return { envelopeVersion: ENVELOPE_VERSION, contractVersion: CONTRACT_VERSION, message, availablePaths: paths(result.nextAction), result, ...(diagnostics === undefined ? {} : { diagnostics }) } }
function usageEnvelope(identity: CommandIdentity, runId: string, cause: UsageCause, message: string, facts: ExecutionFacts): EnvelopeV2 {
	const causeCode = cause === "USAGE_UNKNOWN_COMMAND" ? "USAGE_UNKNOWN_COMMAND" : "USAGE_INVALID_INVOCATION"
	const result: ContractResult = { runId, commandIdentity: identity, outcome: "refused", effectClass: facts.effectClass, transactionState: "unchanged", causeCode, failureClass: "usage", exitCode: 2, data: null, retryable: false, repairAction: repairActionOf(identity, causeCode), effects: unchangedEffects(facts), nextAction: nextActionOf(identity, causeCode) }
	return envelope(message, result)
}
function successResult(decision: Decision, runId: string): EnvelopeV2 {
	if (!isSafeJson(decision.result)) throw new Error("decision data is not JSON")
	const facts = factsOf(decision, runId)
	const identity = decision.commandIdentity
	let result: ContractResult
	if (decision.transactionState === "completed") {
		if (decision.effectClass === "inspect") throw new Error("inspect success cannot be completed")
			const effectInventory = completedEffects(facts)
			if (effectInventory === null) throw new Error("completed success lacks completed effects")
			result = { runId, commandIdentity: identity, outcome: "success", effectClass: decision.effectClass, transactionState: "completed", causeCode: "SUCCESS_COMPLETED", failureClass: null, exitCode: 0, data: decision.result, retryable: false, repairAction: null, effects: effectInventory, nextAction: nextActionOf(identity, "SUCCESS_COMPLETED") }
		} else if (decision.effectClass === "inspect") {
			result = { runId, commandIdentity: identity, outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: decision.result, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: nextActionOf(identity, "SUCCESS_UNCHANGED") }
		} else {
			result = { runId, commandIdentity: identity, outcome: "success", effectClass: "repository-local", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: decision.result, retryable: false, repairAction: null, effects: unchangedEffects(facts, true), nextAction: nextActionOf(identity, "SUCCESS_UNCHANGED") }
	}
	return envelope(decision.message, result)
}
function transientResult(decision: Decision, runId: string): EnvelopeV2 {
	if (decision.effectClass === "inspect") throw new Error("inspect results cannot be transient")
	const facts = factsOf(decision, runId)
	const identity = decision.commandIdentity
	const causeCode = decision.domainOutcome === "refused" ? "TRANSIENT_NOT_STARTED" : "TRANSIENT_ATTEMPT_UNCHANGED"
	const common = { runId, commandIdentity: identity, effectClass: decision.effectClass, transactionState: "unchanged" as const, failureClass: "transient" as const, exitCode: 75 as const, data: null, retryable: true as const, retryDelayMilliseconds: RETRY_DELAY_MS, repairAction: repairActionOf(identity, causeCode), effects: unchangedEffects(facts), nextAction: nextActionOf(identity, causeCode) }
	const result: ContractResult = causeCode === "TRANSIENT_NOT_STARTED" ? { ...common, outcome: "refused", causeCode } : { ...common, outcome: "failed", causeCode }
	return envelope(decision.message, result)
}
function refusalResult(decision: Decision, runId: string): EnvelopeV2 {
	const facts = factsOf(decision, runId)
	const identity = decision.commandIdentity
	const common = { runId, commandIdentity: identity, outcome: "refused" as const, effectClass: decision.effectClass, transactionState: "unchanged" as const, data: null, retryable: false as const, effects: unchangedEffects(facts) }
	const next = (causeCode: WireCauseCode) => ({ repairAction: repairActionOf(identity, causeCode), nextAction: nextActionOf(identity, causeCode) })
	let result: ContractResult
	if (decision.failureClass === "usage") result = { ...common, causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exitCode: 2, ...next("USAGE_INVALID_INVOCATION") }
	else if (decision.failureClass === "schema") result = { ...common, causeCode: "SCHEMA_INVALID_INPUT", failureClass: "schema", exitCode: 4, ...next("SCHEMA_INVALID_INPUT") }
	else if (decision.causeCode === "DOMAIN_AUTHORITY_MISSING") result = { ...common, causeCode: "DOMAIN_AUTHORITY_REQUIRED", failureClass: "domain", exitCode: 3, repairAction: repairActionOf(identity, "DOMAIN_AUTHORITY_REQUIRED"), handoff: handoffOf(identity, "DOMAIN_AUTHORITY_REQUIRED") }
	else if (decision.causeCode === "DOMAIN_DEADLINE_BEFORE_START") result = { ...common, causeCode: "DOMAIN_DEADLINE_BEFORE_START", failureClass: "domain", exitCode: 3, ...next("DOMAIN_DEADLINE_BEFORE_START") }
	// O1 Candidate A: the two writer refusals keep their own accepted causes and arms rather than folding into the
	// precondition row.
	else if (decision.causeCode === "DOMAIN_JOURNAL_LOCK_HELD") result = { ...common, causeCode: "DOMAIN_JOURNAL_LOCK_HELD", failureClass: "domain", exitCode: 3, repairAction: repairActionOf(identity, "DOMAIN_JOURNAL_LOCK_HELD"), handoff: handoffOf(identity, "DOMAIN_JOURNAL_LOCK_HELD") }
	else if (decision.causeCode === "DOMAIN_PRIOR_RUN_PENDING") result = { ...common, causeCode: "DOMAIN_PRIOR_RUN_PENDING", failureClass: "domain", exitCode: 3, repairAction: repairActionOf(identity, "DOMAIN_PRIOR_RUN_PENDING"), handoff: handoffOf(identity, "DOMAIN_PRIOR_RUN_PENDING") }
	else if (decision.causeCode === "DOMAIN_JOURNAL_LIMIT_REACHED") result = { ...common, causeCode: "DOMAIN_JOURNAL_LIMIT_REACHED", failureClass: "domain", exitCode: 3, ...next("DOMAIN_JOURNAL_LIMIT_REACHED") }
	else if (decision.failureClass === "internal") result = { ...common, causeCode: "INTERNAL_PREPARATION", failureClass: "internal", exitCode: 1, ...next("INTERNAL_PREPARATION") }
	else result = { ...common, causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exitCode: 3, ...next("DOMAIN_PRECONDITION_UNMET") }
	return envelope(decision.message, result)
}

function deadlineFailureBase(decision: Decision, runId: string) {
	const facts = factsOf(decision, runId)
	const identity = decision.commandIdentity
	const common = { runId, commandIdentity: identity, outcome: "failed" as const, data: null, retryable: false as const, failureClass: "domain" as const, exitCode: 3 as const }
	const handoff = (causeCode: WireCauseCode) => ({ repairAction: repairActionOf(identity, causeCode), handoff: handoffOf(identity, causeCode) })
	return { facts, identity, common, handoff }
}

function deadlineUnchangedEnvelope(decision: Decision, runId: string): EnvelopeV2 {
	if (decision.effectClass === "inspect" || decision.transactionState !== "unchanged") throw new Error("deadline unchanged facts are inadmissible")
	const { facts, identity, common } = deadlineFailureBase(decision, runId)
	const causeCode = "DOMAIN_DEADLINE_UNCHANGED"
	return envelope(decision.message, { ...common, effectClass: "repository-local", transactionState: "unchanged", causeCode, effects: unchangedEffects(facts), repairAction: repairActionOf(identity, causeCode), nextAction: nextActionOf(identity, causeCode) })
}

function deadlineCompletedEnvelope(decision: Decision, runId: string): EnvelopeV2 {
	if (decision.effectClass === "inspect" || decision.transactionState !== "completed") throw new Error("deadline completed facts are inadmissible")
	const { facts, common, handoff } = deadlineFailureBase(decision, runId)
	const effects = completedEffects(facts)
	if (effects === null) throw new Error("deadline completed facts are inadmissible")
	const causeCode = "DOMAIN_DEADLINE_COMPLETED"
	return envelope(decision.message, { ...common, effectClass: "repository-local", transactionState: "completed", causeCode, effects, ...handoff(causeCode) })
}

function deadlinePartialEnvelope(decision: Decision, runId: string): EnvelopeV2 {
	if (decision.effectClass === "inspect" || decision.transactionState !== "partially-completed") throw new Error("deadline partial facts are inadmissible")
	const { facts, common, handoff } = deadlineFailureBase(decision, runId)
	const effects = partialEffects(facts)
	if (effects === null) throw new Error("deadline partial facts are inadmissible")
	const causeCode = "DOMAIN_DEADLINE_PARTIAL"
	return envelope(decision.message, { ...common, effectClass: "repository-local", transactionState: "partially-completed", causeCode, effects, ...handoff(causeCode) })
}

function deadlineUnknownEnvelope(decision: Decision, runId: string): EnvelopeV2 {
	if (decision.effectClass === "inspect" || decision.transactionState !== "unknown") throw new Error("deadline unknown facts are inadmissible")
	const { facts, common, handoff } = deadlineFailureBase(decision, runId)
	const causeCode = "DOMAIN_DEADLINE_UNKNOWN"
	return envelope(decision.message, { ...common, effectClass: "repository-local", transactionState: "unknown", causeCode, effects: unknownEffects(facts), ...handoff(causeCode) })
}

function deadlineFailureEnvelope(decision: Decision, runId: string): EnvelopeV2 | null {
	switch (decision.causeCode) {
		case "DOMAIN_DEADLINE_UNCHANGED":
			return deadlineUnchangedEnvelope(decision, runId)
		case "DOMAIN_DEADLINE_COMPLETED":
			return deadlineCompletedEnvelope(decision, runId)
		case "DOMAIN_DEADLINE_PARTIAL":
			return deadlinePartialEnvelope(decision, runId)
		case "DOMAIN_DEADLINE_UNKNOWN":
			return deadlineUnknownEnvelope(decision, runId)
		default:
			return null
	}
}

function ordinaryFailureResult(decision: Decision, runId: string): EnvelopeV2 {
	const facts = factsOf(decision, runId)
	const identity = decision.commandIdentity
	const common = { runId, commandIdentity: identity, outcome: "failed" as const, data: null, retryable: false as const }
	const handoff = (causeCode: WireCauseCode) => ({ repairAction: repairActionOf(identity, causeCode), handoff: handoffOf(identity, causeCode) })
	let result: ContractResult
	if (decision.causeCode === "INTERNAL_UNEXPECTED") {
		result = { ...common, effectClass: decision.effectClass, transactionState: "unchanged", causeCode: "INTERNAL_UNEXPECTED", failureClass: "internal", exitCode: 1, effects: unchangedEffects(facts), ...handoff("INTERNAL_UNEXPECTED") }
	} else if (decision.causeCode === "DOMAIN_RECOVERY_PARTIAL_HANDOFF") {
		// O1 Candidate A: known partial completion carries both a completed and a remaining inventory.
		if (decision.effectClass === "inspect") throw new Error("partial recovery facts are inadmissible")
		const effectInventory = partialEffects(facts)
		if (effectInventory === null) throw new Error("partial recovery facts are inadmissible")
		result = { ...common, effectClass: decision.effectClass, transactionState: "partially-completed", causeCode: "DOMAIN_RECOVERY_PARTIAL_HANDOFF", failureClass: "domain", exitCode: 3, effects: effectInventory, ...handoff("DOMAIN_RECOVERY_PARTIAL_HANDOFF") }
	} else {
		if (decision.effectClass === "inspect" || decision.transactionState !== "unknown") throw new Error("ordinary effect failure facts are inadmissible")
		const effectInventory = unknownEffects(facts)
		if (decision.causeCode === "DOMAIN_RECOVERY_HANDOFF_REQUIRED") result = { ...common, effectClass: decision.effectClass, transactionState: "unknown", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", failureClass: "domain", exitCode: 3, effects: effectInventory, ...handoff("DOMAIN_RECOVERY_HANDOFF_REQUIRED") }
		else if (decision.causeCode === "INTERNAL_EFFECT_OUTCOME_UNKNOWN") result = { ...common, effectClass: decision.effectClass, transactionState: "unknown", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", failureClass: "internal", exitCode: 1, effects: effectInventory, ...handoff("INTERNAL_EFFECT_OUTCOME_UNKNOWN") }
		else if (decision.causeCode === "INTERNAL_EFFECT_NOT_OBSERVED") result = { ...common, effectClass: decision.effectClass, transactionState: "unknown", causeCode: "INTERNAL_EFFECT_NOT_OBSERVED", failureClass: "internal", exitCode: 1, effects: effectInventory, ...handoff("INTERNAL_EFFECT_NOT_OBSERVED") }
		else throw new Error("ordinary failure cause is not admitted")
	}
	return envelope(decision.message, result)
}
type SinkFailure = Extract<Diagnostics, { status: "available" }>["sinkFailure"]
function sinkFailureOf(failure: string): SinkFailure | undefined {
	if (failure.startsWith("timeout:")) return "flush-timeout"
	if (failure.startsWith("capacity:")) return "capacity"
	if (failure.startsWith("open:") || failure.startsWith("configure:")) return "setup"
	if (failure.startsWith("dispose:") || failure.startsWith("logtape-dispose:")) return "close"
	if (failure.startsWith("log:") || failure.startsWith("flush:") || failure.startsWith("meta:")) return "write"
	return undefined
}

// The accepted diagnostics schema is validated independently. A diagnostics-only defect never reaches egress
// validation as an invalid combined envelope, and therefore cannot invoke the frozen domain fallback.
const diagnosticsSchema = MachineEnvelopeSchema.shape.diagnostics.unwrap()
const diagnosticsFields = diagnosticsSchema.options[0].shape
interface DiagnosticInspection { trusted: Record<string, unknown>; invalid: boolean; damagedAccounting: boolean; missingCounter: boolean }

function inspectDiagnosticField(status: object, name: string, schema: { safeParse(value: unknown): { success: boolean; data?: unknown } }, inspected: DiagnosticInspection): void {
	const descriptor = Object.getOwnPropertyDescriptor(status, name)
	const counter = name.endsWith("Records")
	if (descriptor === undefined) {
		inspected.invalid = true
		inspected.damagedAccounting ||= counter || name === "countsComplete"
		return
	}
	const unknown = descriptor.value === null && name !== "file" && name !== "sinkFailure"
	if (unknown) { inspected.missingCounter ||= counter; return }
	const value = name === "sinkFailure" && typeof descriptor.value === "string" ? sinkFailureOf(descriptor.value) : descriptor.value
	const parsed = schema.safeParse(value)
	if (parsed.success && "value" in descriptor) { inspected.trusted[name] = parsed.data; return }
	inspected.invalid = true
	inspected.damagedAccounting ||= counter || name === "countsComplete"
}

function inspectDiagnostics(status: object): DiagnosticInspection {
	const inspected: DiagnosticInspection = { trusted: {}, invalid: Object.keys(status).some((name) => name === "status" || !Object.hasOwn(diagnosticsFields, name)), damagedAccounting: false, missingCounter: false }
	for (const [name, schema] of Object.entries(diagnosticsFields)) {
		if (name !== "status") inspectDiagnosticField(status, name, schema, inspected)
	}
	if (inspected.missingCounter && inspected.trusted.countsComplete === true) inspected.damagedAccounting = true
	if (inspected.damagedAccounting) {
		inspected.invalid = true
		// Individually valid surviving counters are lower bounds once exact accounting integrity is lost.
		inspected.trusted.countsComplete = false
	}
	return inspected
}

// C0 ties timeout to unconfirmed closure and pending admitted records. Loss cannot coexist with a claim of
// no sink failure, and neither can an unconfirmed closure: the producer only leaves closed false after a sink failure.
// Conflicting fields do not independently establish which side is wrong, so omit both claims.
function conflictingDiagnosticClaims(trusted: Record<string, unknown>): Set<string> {
	const { sinkFailure, closed, unflushedRecords, countsComplete } = trusted
	const conflicting = new Set<string>()
	if (sinkFailure === "flush-timeout" && closed === true) { conflicting.add("sinkFailure"); conflicting.add("closed") }
	if (sinkFailure === "flush-timeout" && unflushedRecords === 0 && countsComplete === true) { conflicting.add("sinkFailure"); conflicting.add("unflushedRecords") }
	if (sinkFailure !== null) return conflicting
	if (closed === false) { conflicting.add("sinkFailure"); conflicting.add("closed") }
	for (const name of ["droppedRecords", "unflushedRecords"]) {
		const value = trusted[name]
		if (typeof value === "number" && value > 0) { conflicting.add("sinkFailure"); conflicting.add(name) }
	}
	return conflicting
}

function validateDiagnosticInvariants(inspected: DiagnosticInspection): void {
	const conflicting = conflictingDiagnosticClaims(inspected.trusted)
	if (conflicting.size === 0) return
	inspected.invalid = true
	for (const name of conflicting) {
		delete inspected.trusted[name]
		if (name.endsWith("Records")) inspected.trusted.countsComplete = false
	}
}

function diagnosticsDisclosure(status: unknown): Diagnostics {
	const invalid: Diagnostics = { status: "unavailable", reason: "status-invalid", trusted: {} }
	try {
		if (typeof status !== "object" || status === null || Array.isArray(status)) return invalid
		const inspected = inspectDiagnostics(status)
		validateDiagnosticInvariants(inspected)
		const available = diagnosticsSchema.safeParse({ status: "available", ...inspected.trusted })
		if (!inspected.invalid && available.success) return available.data
		const unavailable = diagnosticsSchema.safeParse({ status: "unavailable", reason: inspected.invalid ? "status-invalid" : "status-unavailable", trusted: inspected.trusted })
		return unavailable.success ? unavailable.data : invalid
	} catch { return invalid }
}
function decisionEnvelope(decision: Decision, runId: string, diagnostics: DiagnosticsStatus | null): EnvelopeV2 {
	const ordinaryCause = decision.causeCode === "DOMAIN_DEADLINE_UNCHANGED" || decision.causeCode === "DOMAIN_DEADLINE_COMPLETED" || decision.causeCode === "DOMAIN_DEADLINE_PARTIAL" || decision.causeCode === "DOMAIN_DEADLINE_UNKNOWN" || decision.causeCode === "DOMAIN_RECOVERY_HANDOFF_REQUIRED" || decision.causeCode === "DOMAIN_RECOVERY_PARTIAL_HANDOFF" || decision.causeCode === "INTERNAL_EFFECT_OUTCOME_UNKNOWN" || decision.causeCode === "INTERNAL_EFFECT_NOT_OBSERVED" || decision.causeCode === "INTERNAL_UNEXPECTED"
	const deadlineResult = deadlineFailureEnvelope(decision, runId)
	const result = decision.domainOutcome === "success" ? successResult(decision, runId) : decision.failureClass === "unavailable" ? transientResult(decision, runId) : decision.domainOutcome === "refused" ? refusalResult(decision, runId) : deadlineResult ?? (ordinaryCause ? ordinaryFailureResult(decision, runId) : fallbackEnvelope(factsOf(decision, runId)))
	if (result === null) throw new Error("uncomposable fallback facts")
	if (diagnostics === null) return result
	return { ...result, diagnostics: diagnosticsDisclosure(diagnostics) }
}

type FallbackFacts =
	| (ExecutionFacts & { readonly domainOutcome: "refused"; readonly transactionState: "unchanged"; readonly fallbackCase: "preparation" })
	| (ExecutionFacts & { readonly domainOutcome: "success" | "failed" | "unknown"; readonly transactionState: "unchanged"; readonly fallbackCase: "result-unchanged" })
	| (ExecutionFacts & { readonly domainOutcome: "success" | "failed" | "unknown"; readonly transactionState: "completed"; readonly fallbackCase: "result-completed" })
	| (ExecutionFacts & { readonly domainOutcome: "success" | "failed" | "unknown"; readonly transactionState: "partially-completed"; readonly fallbackCase: "result-partial" })
	| (ExecutionFacts & { readonly domainOutcome: "success" | "failed" | "unknown"; readonly transactionState: "unknown"; readonly fallbackCase: "result-unknown" })

function fallbackFacts(facts: ExecutionFacts): FallbackFacts | null {
	if (facts.domainOutcome === "refused" && facts.transactionState === "unchanged") return { ...facts, domainOutcome: "refused", transactionState: "unchanged", fallbackCase: "preparation" }
	if ((facts.domainOutcome === "success" || facts.domainOutcome === "failed" || facts.domainOutcome === "unknown") && facts.transactionState === "unchanged") return { ...facts, domainOutcome: facts.domainOutcome, transactionState: "unchanged", fallbackCase: "result-unchanged" }
	if ((facts.domainOutcome === "success" || facts.domainOutcome === "failed" || facts.domainOutcome === "unknown") && facts.transactionState === "completed") return { ...facts, domainOutcome: facts.domainOutcome, transactionState: "completed", fallbackCase: "result-completed" }
	if ((facts.domainOutcome === "success" || facts.domainOutcome === "failed" || facts.domainOutcome === "unknown") && facts.transactionState === "partially-completed") return { ...facts, domainOutcome: facts.domainOutcome, transactionState: "partially-completed", fallbackCase: "result-partial" }
	if ((facts.domainOutcome === "success" || facts.domainOutcome === "failed" || facts.domainOutcome === "unknown") && facts.transactionState === "unknown") return { ...facts, domainOutcome: facts.domainOutcome, transactionState: "unknown", fallbackCase: "result-unknown" }
	return null
}

function fallbackEnvelope(facts: ExecutionFacts): EnvelopeV2 | null {
	const fallback = fallbackFacts(facts)
	if (fallback === null) return null
	const identity = fallback.commandIdentity
	const common = { runId: fallback.runIdentity, commandIdentity: identity, failureClass: "internal" as const, exitCode: 1 as const, data: null, retryable: false as const }
	const handoff = (causeCode: WireCauseCode) => ({ repairAction: repairActionOf(identity, causeCode), handoff: handoffOf(identity, causeCode) })
	let result: ContractResult
	switch (fallback.fallbackCase) {
		case "preparation":
			result = { ...common, outcome: "refused", effectClass: fallback.effectClass, transactionState: "unchanged", causeCode: "INTERNAL_PREPARATION", effects: unchangedEffects(fallback), repairAction: repairActionOf(identity, "INTERNAL_PREPARATION"), nextAction: nextActionOf(identity, "INTERNAL_PREPARATION") }
			break
		case "result-unchanged":
			result = { ...common, outcome: "failed", effectClass: fallback.effectClass, transactionState: "unchanged", causeCode: "INTERNAL_RESULT_UNCHANGED", effects: unchangedEffects(fallback), ...handoff("INTERNAL_RESULT_UNCHANGED") }
			break
		case "result-completed": {
			if (fallback.effectClass === "inspect") return null
			const effectInventory = completedEffects(fallback)
			if (effectInventory === null) return null
			result = { ...common, outcome: "failed", effectClass: fallback.effectClass, transactionState: "completed", causeCode: "INTERNAL_RESULT_COMPLETED", effects: effectInventory, ...handoff("INTERNAL_RESULT_COMPLETED") }
			break
		}
		case "result-partial": {
			if (fallback.effectClass === "inspect") return null
			const effectInventory = partialEffects(fallback)
			if (effectInventory === null) return null
			result = { ...common, outcome: "failed", effectClass: fallback.effectClass, transactionState: "partially-completed", causeCode: "INTERNAL_RESULT_PARTIAL", effects: effectInventory, ...handoff("INTERNAL_RESULT_PARTIAL") }
			break
		}
		case "result-unknown":
			if (fallback.effectClass === "inspect") return null
			result = { ...common, outcome: "failed", effectClass: fallback.effectClass, transactionState: "unknown", causeCode: "INTERNAL_RESULT_UNKNOWN", effects: unknownEffects(fallback), ...handoff("INTERNAL_RESULT_UNKNOWN") }
			break
	}
	return envelope("The result could not be serialized safely.", result)
}
export function internalFailureEnvelope(facts: ExecutionFacts, _issues: string[]): EnvelopeV2 | null { return fallbackEnvelope(facts) }

type Corrupt = (candidate: EnvelopeV2) => unknown
function resultWith(candidate: EnvelopeV2, field: string, value: unknown): Record<string, unknown> { return { ...candidate, result: { ...candidate.result, [field]: value } } }
function cyclic(candidate: EnvelopeV2): Record<string, unknown> { const value: Record<string, unknown> = { ...candidate }; value.result = { ...candidate.result, self: value }; return value }
function tooDeep(candidate: EnvelopeV2): Record<string, unknown> { let nested: unknown = "leaf"; for (let depth = 0; depth < 65; depth += 1) nested = { nested }; return resultWith(candidate, "nested", nested) }
const NON_JSON_CORRUPTIONS: Readonly<Record<Extract<EgressFault, { kind: "egress-non-json" }> ["variant"], Corrupt>> = { cycle: cyclic, depth65: tooDeep, date: (candidate) => resultWith(candidate, "at", new Date()), undefined: (candidate) => resultWith(candidate, "missing", undefined), function: (candidate) => resultWith(candidate, "fn", () => 1), bigint: (candidate) => resultWith(candidate, "big", 1n), nan: (candidate) => resultWith(candidate, "nan", Number.NaN), infinity: (candidate) => resultWith(candidate, "infinity", Number.POSITIVE_INFINITY) }
const SCHEMA_CORRUPTIONS: Readonly<Record<Extract<EgressFault, { kind: "egress-schema-invalid" }> ["variant"], Corrupt>> = { "non-string-message": (candidate) => resultWith(candidate, "message", 42), "extra-key": (candidate) => ({ ...candidate, extra: true }), "bad-enum": (candidate) => resultWith(candidate, "outcome", "maybe"), "both-guidance": (candidate) => ({ ...candidate, result: { ...candidate.result, nextAction: INSPECT_ACTION, handoff: { owner: "operator", reason: "both", inspect: [INSPECT_ACTION] } } }) }
function corrupt(candidate: EnvelopeV2, fault: EgressFault | null): unknown { if (fault === null) return candidate; return fault.kind === "egress-non-json" ? NON_JSON_CORRUPTIONS[fault.variant](candidate) : SCHEMA_CORRUPTIONS[fault.variant](candidate) }

// Every machine outcome emits exactly one validated envelope; there is no silent path and no third builder.
export function emitMachine(candidate: unknown, facts: ExecutionFacts, io: Io): number {
	let normalWriteStarted = false
	try {
		if (!isSafeJson(candidate)) throw new Error("candidate is not guarded JSON")
		const parsed = MachineEnvelopeSchema.safeParse(candidate)
		if (parsed.success) {
			normalWriteStarted = true
			io.stdout(`${JSON.stringify(parsed.data)}\n`)
			return parsed.data.result.exitCode
		}
	} catch {}
	if (normalWriteStarted) return 1
	const fallback = fallbackEnvelope(facts)
	const encoded = encodeFallbackEnvelope(fallback)
	if (encoded === null) return 1
	try { io.stdout(`${encoded}\n`) } catch { return 1 }
	return 1
}

export function encodeFallbackEnvelope(candidate: unknown): string | null {
	const inspected = inspectFallbackEncoding(candidate)
	return inspected.ok ? inspected.encoded : null
}

export function inspectFallbackEncoding(candidate: unknown): { ok: true; encoded: string } | { ok: false; reason: "depth-or-json" | "schema" | "size" } {
	if (!isSafeJson(candidate, 8)) return { ok: false, reason: "depth-or-json" }
	const validated = MachineEnvelopeSchema.safeParse(candidate)
	if (!validated.success) return { ok: false, reason: "schema" }
	const encoded = JSON.stringify(validated.data)
	return new TextEncoder().encode(encoded).byteLength <= 16_384 ? { ok: true, encoded } : { ok: false, reason: "size" }
}

function renderHuman(decision: Decision, io: Io): void {
	for (const line of decision.humanStdout) io.stdout(`${line}\n`)
	for (const line of decision.humanStderr) io.stderr(`${line}\n`)
}

function humanUsage(io: Io, message: string): number {
	io.stderr(`repair-lab: ${message}; run ${HELP_PATH}\n`)
	return 2
}

function discoveryText(): string {
	const document = discovery()
	const lines = [`contractVersion: ${document.contractVersion}`, `generationConventionVersion: ${document.generationConventionVersion}`, `profile: ${document.profile}`]
	for (const command of document.commands) lines.push(`command: ${command.commandIdentity} | ${command.route.join(" ")} | ${command.effectClass} | ${command.summary}`)
	for (const [code, meaning] of Object.entries(EXIT_MEANINGS)) lines.push(`exit ${code}: ${meaning}`)
	for (const [code, signal] of Object.entries(document.signalExits)) lines.push(`signal ${code}: ${signal}`)
	for (const exclusion of document.effectExclusions) lines.push(`effect exclusion: ${exclusion}`)
	return `${lines.join("\n")}\n`
}

function successEnvelope(identity: CommandIdentity, runIdentity: string, message: string, data: JsonValue): EnvelopeV2 {
	const result: ContractResult = { runId: runIdentity, commandIdentity: identity, outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: nextActionOf(identity, "SUCCESS_UNCHANGED") }
	return envelope(message, result)
}

function buildRequest(parsed: Parsed, route: CommandRoute): { request: ParsedRequest } | { usage: string } {
	const statePath = parsed.values.state === undefined ? undefined : parseResourceId(parsed.values.state)
	const previewId = parsed.values["preview-id"] === undefined ? undefined : parseResourceId(parsed.values["preview-id"])
	const authority = parsed.values.authorize === undefined ? undefined : mintAuthorization(parsed.values.authorize)
	if (statePath === null || previewId === null) return { usage: "resource identities must be nonempty" }
	const deadlineValue = parsed.values["deadline-ms"]
	const deadlineMilliseconds = deadlineValue === undefined ? undefined : Number(deadlineValue)
	if (deadlineMilliseconds !== undefined && (!Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds <= 0 || String(deadlineMilliseconds) !== deadlineValue)) return { usage: "--deadline-ms must be a positive integer" }
	return { request: { route, statePath, previewId, authority: authority ?? undefined, automation: parsed.values.automation === true, includeDiagnostics: parsed.values["include-diagnostics"] === true, deadline: deadlineMilliseconds === undefined ? null : createOperationDeadline(deadlineMilliseconds) } }
}

interface Session {
	argv: readonly string[]
	io: Io
	runIdentity: string
	jsonMode: boolean
	machine(candidate: EnvelopeV2, facts: ExecutionFacts): number
}

// One usage refusal in the mode the caller asked for.
function usageRefusal(session: Session, identity: CommandIdentity, causeCode: UsageCause, message: string): number {
	const facts = usageFacts(identity, session.runIdentity)
	return session.jsonMode ? session.machine(usageEnvelope(identity, session.runIdentity, causeCode, `${message}; run ${HELP_PATH}`, facts), facts) : humanUsage(session.io, message)
}

function runHelp(session: Session, parsed: Parsed): number {
	const identity = "repair-lab.help"
	if (parsed.values.help === true) {
		if (!session.jsonMode) {
			session.io.stdout(HELP_TEXT)
			return 0
		}
		const facts = { ...usageFacts(identity, session.runIdentity), domainOutcome: "success" as const }
			return session.machine(successEnvelope(identity, session.runIdentity, "Help completed", HELP_DATA), facts)
	}
	const word = session.argv.find((token) => !token.startsWith("-"))
	if (word === undefined) return usageRefusal(session, identity, "USAGE_COMMAND_REQUIRED", "a command is required")
	return usageRefusal(session, identity, "USAGE_UNKNOWN_COMMAND", `unknown command ${word}`)
}

function runDiscover(session: Session): number {
	const identity = "repair-lab.discovery"
	if (!session.jsonMode) {
		session.io.stdout(discoveryText())
		return 0
	}
	const facts = { ...usageFacts(identity, session.runIdentity), domainOutcome: "success" as const }
	return session.machine(successEnvelope(identity, session.runIdentity, "Command discovery completed", discovery()), facts)
}

// One selected command's possible stations from the typed catalogue (accepted C0 command-scoped discovery). The
// selector is the parsed option value; an unknown canonical identity is refused at the command-discovery identity.
function stationLine(station: PublicStation): string {
	return `  ${station.outcome} | ${station.causeCode} | ${station.transactionState} | exit ${station.exitCode} | retryable ${station.retryable} | ${"handoff" in station.guidance ? "handoff" : "next-action"} | ${station.reachability}`
}

function runCommandDiscovery(session: Session, parsed: Parsed): number {
	const identity = "repair-lab.command-discovery"
	const selected = parsed.values["discover-command"]
	const command = COMMANDS.find((candidate) => candidate.commandIdentity === selected)
	if (command === undefined) return usageRefusal(session, identity, "USAGE_UNKNOWN_COMMAND", `unknown command ${String(selected)}`)
	const data = commandDiscovery(command)
	if (!session.jsonMode) {
		session.io.stdout(`${data.command.commandIdentity}: possible outcomes\n`)
		for (const station of data.stations) session.io.stdout(`${stationLine(station)}\n`)
		return 0
	}
	const facts = { ...usageFacts(identity, session.runIdentity), domainOutcome: "success" as const }
	return session.machine(successEnvelope(identity, session.runIdentity, "Command discovery completed", data), facts)
}

// A routed command: resolve the root, open diagnostics, decide, dispose diagnostics, then render once.
async function runCommand(session: Session, routed: Routed, route: CommandRoute, parsed: Parsed, faults: Faults, root: string, env: Record<string, string | undefined>): Promise<number> {
	const request = buildRequest(parsed, route)
	if ("usage" in request) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", request.usage)
	const diagnosticsFault = faults.domain === "sink-throw" || faults.domain === "sink-dispose-throw" || faults.domain === "diagnostics-flood" ? faults.domain : null
	const diagnostics = await openRunDiagnostics({ runIdentity: session.runIdentity, command: routed.identity, env, fault: diagnosticsFault })
	const runtime = createRuntime(root, faults)
	const decision = decide(runtime, request.request, session.runIdentity)
	decision.events.forEach((event, index) => {
		if (index === decision.events.length - 1) diagnostics.setStation(decision.stationLabel)
		diagnostics.log(event, `${decision.commandIdentity}: ${event}`, { sensitive_fields_redacted: event === "inspect.redaction-applied" ? decision.redactedFields : [] })
	})
	const frozen = structuredClone(decisionEnvelope(decision, session.runIdentity, null))
	const facts = structuredClone(factsOf(decision, session.runIdentity))
	const status = await diagnostics.dispose()
	if (!session.jsonMode) {
		renderHuman(decision, session.io)
		return exitFor(decision.failureClass === "unavailable" ? "transient" : decision.failureClass)
	}
	return session.machine({ ...frozen, diagnostics: diagnosticsDisclosure(status) }, facts)
}

export async function run(argv: readonly string[], io: Io, env: Record<string, string | undefined>, runIdentity: string, cwd: string): Promise<number> {
	const routed = routeRawArgv(argv)
	const faults = parseFaults(env.REPAIR_LAB_FAULT)
	const egress = faults?.egress ?? null
	const session: Session = {
		argv,
		io,
		runIdentity,
	jsonMode: machineMode(argv),
		machine: (candidate, facts) => emitMachine(corrupt(candidate, egress), facts, io),
	}
	const parsed = parse(argv)
	if ("usage" in parsed) return usageRefusal(session, routed.identity, parsed.usage, parsed.message)
	if (routed.route === "dispatch") return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", "built-in options are incompatible or a command is required")
	// Explicit help and discovery use their declaration-owned flag-only grammar. Default help routing for a bare or
	// unknown command stays with runHelp so it retains USAGE_COMMAND_REQUIRED and USAGE_UNKNOWN_COMMAND.
	if (routed.route === "help" && parsed.values.help !== true) return runHelp(session, parsed)
	const violation = shapeViolation(parsed, routed.route)
	if (violation !== null) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", violation)
	if (routed.route === "help") return runHelp(session, parsed)
	if (routed.route === "discover") return runDiscover(session)
	if (routed.route === "command-discovery") return runCommandDiscovery(session, parsed)
	// Argv shape is judged before the environment (fault channel, root) and before diagnostics or any state read.
	if (faults === null) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", "REPAIR_LAB_FAULT is not a supported fault")
	const root = resolveRoot(env, cwd)
	if (root === null) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", "REPAIR_LAB_ROOT must be an absolute existing directory")
	return runCommand(session, routed, routed.route, parsed, faults, root, env)
}
