#!/usr/bin/env bun
// Source Intake dispatch public entry point: strict argv parsing, dispatch, and the validated Contract Core 2.0 output
// path. See contract.ts for the typed catalogue and gate.ts for the exact-item grant gate.
import {
	COMMANDS,
	type CommandIdentity,
	commandDiscovery,
	discoveryData,
	EMISSION_FAILURE,
	type Envelope,
	type Identity,
	isCommandIdentity,
	type StationKey,
	serializeEnvelope,
	stationResult,
	success,
} from "./contract.ts"
import { runGate } from "./gate.ts"

const USAGE = [
	"Usage:",
	"  source-intake-dispatch GRANT REQUEST [--json]",
	"  source-intake-dispatch --redacted RECIPIENT [--json]",
	"  source-intake-dispatch --discover [--json] | --discover-command COMMAND_IDENTITY [--json] | --help [--json]",
]

const OPTIONS = [
	{ name: "--json", valueName: null, summary: "Emit one Contract Core 2.0 envelope on stdout." },
	{ name: "--redacted", valueName: "RECIPIENT", summary: "Return the fixed redacted projection for status or evaluation." },
	{ name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
	{ name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible stations." },
	{ name: "--help", valueName: null, summary: "Show this help." },
]

const REDACTED_RECIPIENTS = new Set(["status", "evaluation"])

// Fixed, value-free messages. None names a path, receipt value, source label or raw error.
const MESSAGES: Record<Exclude<StationKey, "usage" | "serialization">, string> = {
	denied: "Request denied. Stage Manager must verify the private grant before retrying.",
	inputBusy: "The grant or request could not be opened yet; no receipt was touched.",
	inputInvalid: "The grant or request is not valid for this command.",
	inputUnreadable: "The grant or request is not a readable regular file.",
}

interface Output {
	envelope: Envelope
	human: string
}

class UsageError extends Error {
	constructor(
		readonly identity: Identity,
		message: string,
	) {
		super(message)
	}
}

function helpOutput(): Output {
	const data = { summary: "Project exactly granted Source Intake metadata, or a fixed redacted result.", usage: USAGE.slice(1).map((line) => line.trim()), commands: COMMANDS, options: OPTIONS }
	const human = [...USAGE, "", "Options:", ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`)].join("\n")
	return { envelope: success("source-intake-dispatch.help", data, "Show help.", "Choose an invocation from the usage lines."), human }
}

function discoverOutput(): Output {
	const human = "Profile complex. Commands: GRANT REQUEST (inspect), --redacted RECIPIENT (inspect)."
	return { envelope: success("source-intake-dispatch.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human }
}

function discoverCommandOutput(selector: string): Output {
	if (!isCommandIdentity(selector)) throw new UsageError("source-intake-dispatch.command-discovery", "--discover-command needs a listed command identity.")
	const data = commandDiscovery(selector)
	const human = `${selector}: ${data.stations.map((station) => `${station.causeCode}/${station.outcome}`).join(", ")}`
	return { envelope: success("source-intake-dispatch.command-discovery", data, `Describe ${selector}.`, "Read the stations; discovery reports no live state or grant."), human }
}

function redactedOutput(recipient: string): Output {
	if (!REDACTED_RECIPIENTS.has(recipient)) throw new UsageError("source-intake-dispatch.redacted", "--redacted needs status or evaluation.")
	const data = { recipient, projection: { receipt: "[REDACTED]" } }
	return { envelope: success("source-intake-dispatch.redacted", data, `Redacted projection for ${recipient}.`, "Use only the redacted projection."), human: `${recipient}: receipt [REDACTED]` }
}

function projectOutput(grantPath: string, requestPath: string): Output {
	const identity: CommandIdentity = "source-intake-dispatch.project"
	const outcome = runGate(grantPath, requestPath)
	if (outcome.kind !== "allowed") return { envelope: stationResult(identity, outcome.kind, MESSAGES[outcome.kind]), human: "" }
	const fields = Object.keys(outcome.projection)
	const envelope = success(identity, { opaqueItemRef: outcome.opaqueItemRef, projection: outcome.projection }, `Projected ${fields.length} granted fields.`, "Pass the projection to its granted recipient only.")
	const human = [`Granted projection for ${outcome.opaqueItemRef}:`, ...Object.entries(outcome.projection).map(([field, value]) => `  ${field}: ${value}`)].join("\n")
	return { envelope, human }
}

/** Routes selected by a leading option, or null when the first argument is not a route option. */
function optionRoute(args: readonly string[]): Output | null {
	const [first, second, ...rest] = args
	if (args.length === 1 && (first === "--help" || first === "-h")) return helpOutput()
	if (args.length === 1 && first === "--discover") return discoverOutput()
	const valued = first === "--discover-command" || first === "--redacted"
	if (!valued) return null
	const identity = first === "--redacted" ? "source-intake-dispatch.redacted" : "source-intake-dispatch.command-discovery"
	if (second === undefined || rest.length > 0) throw new UsageError(identity, `${first} needs exactly one value.`)
	return first === "--redacted" ? redactedOutput(second) : discoverCommandOutput(second)
}

function dispatch(args: readonly string[]): Output {
	const routed = optionRoute(args)
	if (routed !== null) return routed
	const [first, second, ...rest] = args
	if (args.some((arg) => arg.startsWith("-"))) throw new UsageError("source-intake-dispatch.dispatch", "An option is not recognised.")
	if (args.length === 0) throw new UsageError("source-intake-dispatch.dispatch", "Choose a supported invocation.")
	if (first === undefined || second === undefined || rest.length > 0) throw new UsageError("source-intake-dispatch.project", "Pass exactly one grant path and one request path.")
	return projectOutput(first, second)
}

let humanFailureReported = false
let transportFailed = false

function guidanceLine(envelope: Envelope): string {
	const result = envelope.result
	return "nextAction" in result ? `Next: ${result.nextAction}` : `Repair: ${String(result.repairAction)}`
}

/** Human mode only: one line on stderr. Machine mode never writes stderr. */
function reportToStderr(line: string): void {
	if (humanFailureReported) return
	humanFailureReported = true
	process.stderr.write(`${line}\n`)
}

/**
 * A transport failure (stdout cannot be written, including a closed pipe) is not a serialization failure: machine
 * mode keeps stderr empty, preserves whatever was observed and never emits a replacement envelope.
 */
function transportFailure(json: boolean): number {
	transportFailed = true
	if (!json) reportToStderr(EMISSION_FAILURE)
	return 1
}

function write(text: string, json: boolean): number | null {
	try {
		process.stdout.write(text)
		return null
	} catch {
		return transportFailure(json)
	}
}

/** Machine output: the validated envelope, else the validated internal fallback, else nothing. */
function emitMachine(envelope: Envelope): number {
	const text = serializeEnvelope(envelope)
	if (text !== null) return write(text, true) ?? envelope.result.exitCode
	const fallback = serializeEnvelope(stationResult(envelope.result.commandIdentity, "serialization", "The result could not be emitted safely."))
	if (fallback === null) return 1
	return write(fallback, true) ?? 1
}

function emit(output: Output, json: boolean): number {
	if (json) return emitMachine(output.envelope)
	const exitCode = output.envelope.result.exitCode
	if (exitCode !== 0) {
		reportToStderr(`${output.envelope.message} ${guidanceLine(output.envelope)}`)
		return exitCode
	}
	return write(`${output.human}\n`, false) ?? exitCode
}

function main(argv: readonly string[]): number {
	const json = argv.includes("--json")
	const args = argv.filter((value) => value !== "--json")
	// A pipe error can arrive after main() returned and the exit status was assigned; it must still fail the run.
	process.stdout.on("error", () => {
		transportFailure(json)
		if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
	})
	let output: Output
	try {
		output = dispatch(args)
	} catch (error) {
		// An unexpected failure keeps a fixed message: a raw error could quote private input.
		const envelope = error instanceof UsageError ? stationResult(error.identity, "usage", error.message) : stationResult("source-intake-dispatch.dispatch", "serialization", "The command failed unexpectedly.")
		output = { envelope, human: "" }
	}
	return emit(output, json)
}

const exitCode = main(process.argv.slice(2))
process.exitCode = transportFailed ? 1 : exitCode
