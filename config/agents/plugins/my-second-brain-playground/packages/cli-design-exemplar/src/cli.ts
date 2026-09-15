import { parseArgs } from "node:util"
import { z } from "zod"
import { fallbackCause } from "./branch-station-catalog.ts"
import { type CliRoute, type CommandIdentity, type CommandRoute, COMMANDS, CONTRACT_VERSION, declarationForRoute, DISCOVER_PATH, discovery, ENVELOPE_VERSION, EXIT_MEANINGS, exitFor, handoffFor, HELP_PATH, INSPECT_ACTION, type MachineEnvelope, MachineEnvelopeSchema, PARSE_ARGS_CONFIG, RECOVER_ACTION } from "./command-contract.ts"
import { type DiagnosticsStatus, openRunDiagnostics } from "./diagnostics.ts"
import { type Decision, decide, factsOf, type Request } from "./engine.ts"
import type { EgressFault, ExecutionFacts, FallbackCase, Faults } from "./model.ts"
import { createRuntime, parseFaults, resolveRoot, RETRY_DELAY_MS } from "./runtime.ts"

// run(argv, io, env): parsing with node:util parseArgs (strict), --json detection anywhere in raw argv, identity derived
// from the raw argv command word before strict parsing, human rendering literal to the fixture lines, and the one
// two-stage machine writer emitMachine with the accepted D6-c fallback (brief 12, sections 3.4, 5 and 7.2).

export interface Io {
	stdout(text: string): void
	stderr(text: string): void
}

const HELP_TEXT = "repair-lab: inspect, preview, apply and repair a fixture-local resource with journal-backed recovery\nusage: repair-lab <command> [options] [--json]\n\ncommands:\n  status                              report the resource status\n  inspect [--state <path>] [--include-diagnostics]\n  apply --preview                     write an apply preview\n  apply --preview-id <id> --authorize fixture-authority\n  repair --preview | repair --apply --preview-id <id> --authorize fixture-authority\n  repair --apply --retry-once --authorize fixture-authority\n  recover                             report recovery state from the journal\n  --discover --json                   describe commands and the contract\n\nexample:\n  repair-lab status --json\n"

export type Routed = { identity: CommandIdentity; route: CliRoute }

function routed(route: CliRoute): Routed {
	return { identity: declarationForRoute(route).identity, route }
}

// Identity is derived from the raw argv command word and route flags before strict parsing, so a usage refusal keeps
// the routed identity (brief 12, section 3.4 and the 7.3 gotcha).
export function routeRawArgv(argv: readonly string[]): Routed {
	if (argv.includes("--help")) return routed("help")
	if (argv.includes("--discover")) return routed("discover")
	const word = argv.find((token) => !token.startsWith("-"))
	switch (word) {
		case "status":
			return routed("status")
		case "inspect":
			return argv.includes("--include-diagnostics") ? routed("inspect-diagnostics") : routed("inspect")
		case "apply":
			return argv.includes("--preview") ? routed("preview") : routed("apply")
		case "repair":
			if (argv.includes("--retry-once")) return routed("repair-retry")
			return argv.includes("--preview") && !argv.includes("--apply") ? routed("repair-preview") : routed("repair")
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
function shapeViolation(parsed: Parsed, route: CliRoute): string | null {
	const shape = declarationForRoute(route)
	if (route === "help" || route === "discover") {
		if (parsed.positionals.length !== 0) return `${shape.word} takes no positional arguments`
	} else if (parsed.positionals.length !== 1 || parsed.positionals[0] !== shape.word) return `${shape.word} takes no further positional arguments`
	const present = Object.keys(parsed.values)
	const allowed = new Set<string>(shape.allowedOptions)
	const stray = present.find((name) => !allowed.has(name))
	if (stray !== undefined) return `--${stray} is not an option of ${shape.word}`
	const missing = shape.requiredOptions.find((name) => parsed.values[name] === undefined)
	return missing === undefined ? null : `${shape.word} requires --${missing}`
}

function usageFacts(identity: CommandIdentity, runIdentity: string): ExecutionFacts {
	const effectClass = identity === "repair-lab.help" || identity === "repair-lab.discover" || identity === "repair-lab.status" || identity.startsWith("repair-lab.inspect") ? "inspect" : "repository-local"
	return { commandIdentity: identity, runIdentity, domainOutcome: "refused", effectClass, transactionState: "unchanged", completedEffectIds: [], remainingEffectIds: [], stationLabel: "repair-lab.usage", guidance: { kind: "next-action", target: "repair-lab inspect" } }
}

function availablePaths(nextAction: string | null): string[] {
	const paths = [HELP_PATH, DISCOVER_PATH]
	if (nextAction !== null && !paths.includes(nextAction)) paths.push(nextAction)
	return paths
}

// The constant head every envelope shares; the three builders below differ only in what follows it.
function envelopeHead(identity: CommandIdentity, runIdentity: string): Pick<MachineEnvelope, "envelopeVersion" | "contractVersion" | "commandIdentity" | "runIdentity"> {
	return { envelopeVersion: ENVELOPE_VERSION, contractVersion: CONTRACT_VERSION, commandIdentity: identity, runIdentity }
}

function usageEnvelope(identity: CommandIdentity, runIdentity: string, causeCode: UsageCause, message: string, facts: ExecutionFacts): MachineEnvelope {
	return {
		...envelopeHead(identity, runIdentity),
		outcome: "refused",
		failureClass: "usage",
		causeCode,
		message,
		effectClass: facts.effectClass,
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: HELP_PATH,
		availablePaths: [HELP_PATH, DISCOVER_PATH],
		repairAction: `Correct the command arguments or run ${HELP_PATH}`,
		handoff: null,
		result: null,
	}
}

function decisionEnvelope(decision: Decision, runIdentity: string, diagnostics: DiagnosticsStatus | null): MachineEnvelope {
	const nextAction = decision.guidance.kind === "next-action" ? (decision.guidance.target === "repair-lab recover" ? RECOVER_ACTION : nextActionFor(decision)) : null
	const result = decision.result === null ? null : { ...decision.result, ...(diagnostics === null ? {} : { diagnostics }) }
	return {
		...envelopeHead(decision.commandIdentity, runIdentity),
		outcome: decision.domainOutcome,
		failureClass: decision.failureClass,
		causeCode: decision.causeCode,
		message: decision.message,
		effectClass: decision.effectClass,
		transactionState: decision.transactionState,
		retryable: decision.retryable,
		retryDelayMilliseconds: decision.retryDelayMilliseconds,
		nextAction,
		availablePaths: availablePaths(nextAction),
		repairAction: decision.repairAction,
		handoff: decision.guidance.kind === "handoff" ? handoffFor(decision.remainingEffectIds) : null,
		result,
	}
}

// The fixture's next actions per station (brief 12, section 3.3 and 3.4).
function nextActionFor(decision: Decision): string {
	switch (decision.stationLabel) {
		case "repair-lab.inspect":
			return "repair-lab apply --preview"
		case "repair-lab.preview":
			return `repair-lab apply --preview-id ${String((decision.result as Record<string, unknown>).preview_id)} --authorize fixture-authority`
		case "repair-lab.repairable-precondition":
			return "repair-lab repair --apply --preview-id repair-preview-missing-index --authorize fixture-authority"
		case "repair-lab.preview-missing":
			return decision.commandIdentity === "repair-lab.apply" ? "repair-lab apply --preview" : "repair-lab repair --preview"
		case "repair-lab.storage-busy":
			return `retry the same command after ${RETRY_DELAY_MS} ms`
		case "repair-lab.usage":
			return HELP_PATH
		default:
			return INSPECT_ACTION
	}
}

export class EgressInvariantError extends Error {}

// Stage-2 narrowing: total over the facts the section 5 binding can produce, an invariant failure for anything else.
export function narrowFallback(facts: ExecutionFacts): FallbackCase {
	const presented = facts.domainOutcome === "success" ? "failed" : facts.domainOutcome
	if (presented === "refused" && facts.transactionState === "unchanged") return "preparation"
	if (presented === "failed" && facts.transactionState === "unchanged") return "result-unchanged"
	if (presented === "failed" && facts.transactionState === "completed") return "result-completed"
	if (facts.domainOutcome === "failed" && facts.transactionState === "unknown") return "result-unknown"
	if (presented === "unknown" && facts.transactionState === "unknown") return "unknown-unresolved"
	throw new EgressInvariantError(`no accepted fallback case for ${facts.domainOutcome}/${facts.transactionState}`)
}

export function internalFailureEnvelope(facts: ExecutionFacts, issues: string[]): MachineEnvelope {
	const fallbackCase = narrowFallback(facts)
	const outcome = facts.domainOutcome === "success" ? "failed" : facts.domainOutcome
	const handoff = facts.guidance.kind === "handoff"
	const nextAction = handoff ? null : fallbackCase === "result-unknown" || fallbackCase === "unknown-unresolved" ? RECOVER_ACTION : INSPECT_ACTION
	return {
		...envelopeHead(facts.commandIdentity, facts.runIdentity),
		outcome,
		failureClass: "internal",
		causeCode: fallbackCause(fallbackCase),
		message: "the candidate envelope could not be rendered; the trusted domain facts are reported",
		effectClass: facts.effectClass,
		transactionState: facts.transactionState,
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction,
		availablePaths: availablePaths(nextAction),
		repairAction: handoff ? null : nextAction === RECOVER_ACTION ? "run repair-lab recover (read-only); hand off if it cannot resolve the state" : "run repair-lab inspect; the completed effects are never replayed",
		handoff: handoff ? handoffFor(facts.remainingEffectIds) : null,
		result: { station_id: "repair-lab.envelope-invalid", stage: "candidate", domain_outcome: facts.domainOutcome, completed_effect_ids: [...facts.completedEffectIds], remaining_effect_ids: [...facts.remainingEffectIds], issues: issues.slice(0, 10) },
	}
}

function corrupt(candidate: MachineEnvelope, fault: EgressFault | null): unknown {
	if (fault === null) return candidate
	if (fault.kind === "egress-non-json") {
		switch (fault.variant) {
			case "cycle": {
				const cyclic: Record<string, unknown> = { ...candidate }
				cyclic.result = { ...(candidate.result ?? {}), self: cyclic }
				return cyclic
			}
			case "date":
				return { ...candidate, result: { ...(candidate.result ?? {}), at: new Date() } }
			case "undefined":
				return { ...candidate, result: { ...(candidate.result ?? {}), missing: undefined } }
			case "function":
				return { ...candidate, result: { ...(candidate.result ?? {}), fn: () => 1 } }
			case "bigint":
				return { ...candidate, result: { ...(candidate.result ?? {}), big: 1n } }
			case "nan":
				return { ...candidate, result: { ...(candidate.result ?? {}), nan: Number.NaN } }
		}
	}
	switch (fault.variant) {
		case "non-string-message":
			return { ...candidate, message: 42 }
		case "extra-key":
			return { ...candidate, extra: true }
		case "bad-enum":
			return { ...candidate, outcome: "maybe" }
		case "both-guidance":
			return { ...candidate, nextAction: INSPECT_ACTION, handoff: { reason: "both", prerequisites: [] } }
	}
}

// Every machine outcome emits exactly one validated envelope; there is no silent path and no third builder.
export function emitMachine(candidate: unknown, facts: ExecutionFacts, io: Io): number {
	const issues: string[] = []
	try {
		z.json().parse(candidate)
		const parsed = MachineEnvelopeSchema.safeParse(candidate)
		if (parsed.success) {
			io.stdout(`${JSON.stringify(parsed.data)}\n`)
			return exitFor(parsed.data.failureClass)
		}
		for (const issue of parsed.error.issues) issues.push(`${issue.path.join(".") || "<root>"}: ${issue.code}`)
	} catch (error) {
		issues.push(`candidate: ${error instanceof Error ? error.name : "non-json"}`)
	}
	const fallback = internalFailureEnvelope(facts, issues)
	const validated = MachineEnvelopeSchema.safeParse(fallback)
	if (!validated.success) throw new EgressInvariantError(validated.error.issues.map((issue) => issue.code).join(","))
	io.stdout(`${JSON.stringify(validated.data)}\n`)
	return 1
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
	const lines = ["name: repair-lab", `contractVersion: ${CONTRACT_VERSION}`, "generationConventionVersion: 1.0.0"]
	for (const command of COMMANDS) lines.push(`command: ${command.identity} | ${command.argv} | ${command.effectClass} | ${command.description}`)
	for (const [code, meaning] of Object.entries(EXIT_MEANINGS)) lines.push(`exit ${code}: ${meaning}`)
	lines.push("machineMode: --json", "logtape: true")
	return `${lines.join("\n")}\n`
}

function successEnvelope(identity: CommandIdentity, runIdentity: string, message: string, result: Record<string, unknown>): MachineEnvelope {
	return { ...envelopeHead(identity, runIdentity), outcome: "success", failureClass: null, causeCode: null, message, effectClass: "inspect", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null, nextAction: null, availablePaths: [HELP_PATH, DISCOVER_PATH], repairAction: null, handoff: null, result }
}

function buildRequest(parsed: Parsed, route: CommandRoute): Request {
	return { route, statePath: parsed.values.state, previewId: parsed.values["preview-id"], authority: parsed.values.authorize, automation: parsed.values.automation === true, includeDiagnostics: parsed.values["include-diagnostics"] === true }
}

interface Session {
	argv: readonly string[]
	io: Io
	runIdentity: string
	jsonMode: boolean
	machine(candidate: MachineEnvelope, facts: ExecutionFacts): number
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
		return session.machine(successEnvelope(identity, session.runIdentity, "Help completed", { usage: "repair-lab <command> [options] [--json]", example: "repair-lab status --json" }), facts)
	}
	const word = session.argv.find((token) => !token.startsWith("-"))
	if (word === undefined) return usageRefusal(session, identity, "USAGE_COMMAND_REQUIRED", "a command is required")
	return usageRefusal(session, identity, "USAGE_UNKNOWN_COMMAND", `unknown command ${word}`)
}

function runDiscover(session: Session): number {
	const identity = "repair-lab.discover"
	if (!session.jsonMode) {
		session.io.stdout(discoveryText())
		return 0
	}
	const facts = { ...usageFacts(identity, session.runIdentity), domainOutcome: "success" as const }
	return session.machine({ ...successEnvelope(identity, session.runIdentity, "Command discovery completed", discovery()), availablePaths: [HELP_PATH] }, facts)
}

// A routed command: resolve the root, open diagnostics, decide, dispose diagnostics, then render once.
async function runCommand(session: Session, routed: Routed, route: CommandRoute, parsed: Parsed, faults: Faults, root: string): Promise<number> {
	const request = buildRequest(parsed, route)
	const diagnosticsFault = faults.domain === "sink-throw" || faults.domain === "sink-dispose-throw" || faults.domain === "diagnostics-flood" ? faults.domain : null
	const diagnostics = await openRunDiagnostics({ runIdentity: session.runIdentity, command: routed.identity, root, fault: diagnosticsFault })
	const runtime = createRuntime(root, faults)
	const decision = decide(runtime, request, session.runIdentity)
	decision.events.forEach((event, index) => {
		if (index === decision.events.length - 1) diagnostics.setStation(decision.stationLabel)
		diagnostics.log(event, `${decision.commandIdentity}: ${event}`, { sensitive_fields_redacted: event === "inspect.redaction-applied" ? decision.redactedFields : [] })
	})
	const status = await diagnostics.dispose()
	if (!session.jsonMode) {
		renderHuman(decision, session.io)
		return exitFor(decision.failureClass)
	}
	return session.machine(decisionEnvelope(decision, session.runIdentity, status), factsOf(decision, session.runIdentity))
}

export async function run(argv: readonly string[], io: Io, env: Record<string, string | undefined>, runIdentity: string, cwd: string): Promise<number> {
	const routed = routeRawArgv(argv)
	const faults = parseFaults(env.REPAIR_LAB_FAULT)
	const egress = faults?.egress ?? null
	const session: Session = {
		argv,
		io,
		runIdentity,
		jsonMode: argv.some((token) => token === "--json"),
		machine: (candidate, facts) => emitMachine(corrupt(candidate, egress), facts, io),
	}
	const parsed = parse(argv)
	if ("usage" in parsed) return usageRefusal(session, routed.identity, parsed.usage, parsed.message)
	// Explicit help and discovery use their declaration-owned flag-only grammar. Default help routing for a bare or
	// unknown command stays with runHelp so it retains USAGE_COMMAND_REQUIRED and USAGE_UNKNOWN_COMMAND.
	const violation = routed.route === "help" && parsed.values.help !== true ? null : shapeViolation(parsed, routed.route)
	if (violation !== null) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", violation)
	if (routed.route === "help") return runHelp(session, parsed)
	if (routed.route === "discover") return runDiscover(session)
	// Argv shape is judged before the environment (fault channel, root) and before diagnostics or any state read.
	if (faults === null) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", "REPAIR_LAB_FAULT is not a supported fault")
	const root = resolveRoot(env, cwd)
	if (root === null) return usageRefusal(session, routed.identity, "USAGE_INVALID_ARGUMENTS", "REPAIR_LAB_ROOT must be an absolute existing directory")
	return runCommand(session, routed, routed.route, parsed, faults, root)
}
