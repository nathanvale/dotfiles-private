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
import { isatty } from "node:tty"
import { chooseItem, closeChooser } from "./choose.ts"
import { descriptorLimitReached, isDescriptorLimit, runGate } from "./gate.ts"

const USAGE = [
	"Usage:",
	"  source-intake-dispatch project [--json] < GRANT_AND_REQUEST.json",
	"  source-intake-dispatch choose [--json]",
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
// A grant and request are a few hundred bytes; the bound keeps a runaway pipe from growing memory without limit.
const INPUT_LIMIT_BYTES = 64 * 1024

// Fixed, value-free messages. None names a path, receipt value, source label or raw error.
const MESSAGES: Record<Exclude<StationKey, "usage" | "serialization">, string> = {
	cancelled: "No file was selected.",
	chooserUnavailable: "The native chooser is unavailable in this session.",
	denied: "Request denied. Stage Manager must verify the private grant before retrying.",
	inputBusy: "A file-descriptor limit was reached before input was read; no receipt was touched.",
	inputInvalid: "Standard input is not a valid grant and request.",
	inputUnreadable: "Standard input cannot be read.",
	noInbox: "No local Google Drive 00 Inbox was found.",
	selectionRefused: "The selection is not one file directly inside a local 00 Inbox.",
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
	const data = { summary: "Project exactly granted Source Intake metadata, let Nathan choose one local 00 Inbox file, or return a fixed redacted result.", usage: USAGE.slice(1).map((line) => line.trim()), commands: COMMANDS, options: OPTIONS }
	const human = [...USAGE, "", "Options:", ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`)].join("\n")
	return { envelope: success("source-intake-dispatch.help", data, "Show help.", "Choose an invocation from the usage lines."), human }
}

function discoverOutput(): Output {
	const human = "Profile complex. Commands: project (inspect, reads standard input), choose (inspect, attended native chooser), --redacted RECIPIENT (inspect)."
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

type InputRead = { kind: "text"; text: string } | { kind: "inputBusy" | "inputInvalid" | "inputUnreadable" }

/** Reads standard input to end of file, bounded. It is the only source of the grant and request. */
async function readInput(): Promise<InputRead> {
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		const reader = Bun.stdin.stream().getReader()
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			size += chunk.value.byteLength
			if (size > INPUT_LIMIT_BYTES) {
				// Release standard input so a producer that keeps writing cannot hold the process open.
				await reader.cancel()
				return { kind: "inputInvalid" }
			}
			chunks.push(chunk.value)
		}
	} catch (error) {
		return { kind: isDescriptorLimit(error) ? "inputBusy" : "inputUnreadable" }
	}
	return { kind: "text", text: Buffer.concat(chunks).toString("utf8") }
}

function refusalOutput(identity: CommandIdentity, key: keyof typeof MESSAGES): Output {
	return { envelope: stationResult(identity, key, MESSAGES[key]), human: "" }
}

async function projectOutput(): Promise<Output> {
	const identity: CommandIdentity = "source-intake-dispatch.project"
	if (isatty(0)) throw new UsageError(identity, "Pipe the grant and request on standard input; the command never prompts.")
	if (descriptorLimitReached()) return refusalOutput(identity, "inputBusy")
	const input = await readInput()
	if (input.kind !== "text") return refusalOutput(identity, input.kind)
	const outcome = runGate(input.text)
	if (outcome.kind !== "allowed") return refusalOutput(identity, outcome.kind)
	const fields = Object.keys(outcome.projection)
	const envelope = success(identity, { opaqueItemRef: outcome.opaqueItemRef, projection: outcome.projection }, `Projected ${fields.length} granted fields.`, "Pass the projection to its granted recipient only.")
	const human = [`Granted projection for ${outcome.opaqueItemRef}:`, ...Object.entries(outcome.projection).map(([field, value]) => `  ${field}: ${value}`)].join("\n")
	return { envelope, human }
}

async function chooseOutput(): Promise<Output> {
	const identity: CommandIdentity = "source-intake-dispatch.choose"
	if (descriptorLimitReached()) return refusalOutput(identity, "inputBusy")
	const outcome = await chooseItem()
	if (outcome.kind !== "selected") return refusalOutput(identity, outcome.kind)
	const { fileName, localAccount } = outcome
	const envelope = success(identity, { fileName, localAccount }, "Nathan selected one file in a local 00 Inbox.", "Keep the selection in the granted foreground's private receipt only.")
	return { envelope, human: ["Selected one file in a local 00 Inbox:", `  fileName: ${fileName}`, `  localAccount: ${localAccount}`].join("\n") }
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

async function dispatch(args: readonly string[]): Promise<Output> {
	const routed = optionRoute(args)
	if (routed !== null) return routed
	if (args.some((arg) => arg.startsWith("-"))) throw new UsageError("source-intake-dispatch.dispatch", "An option is not recognised.")
	if (args.length === 0) throw new UsageError("source-intake-dispatch.dispatch", "Choose a supported invocation.")
	if (args[0] === "choose") {
		if (args.length > 1) throw new UsageError("source-intake-dispatch.choose", "choose takes no operands; Nathan selects the file in the native chooser.")
		return chooseOutput()
	}
	if (args[0] !== "project") throw new UsageError("source-intake-dispatch.dispatch", "Choose a supported invocation.")
	if (args.length > 1) throw new UsageError("source-intake-dispatch.project", "project takes no operands; pipe the grant and request on standard input.")
	return projectOutput()
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

async function main(argv: readonly string[]): Promise<number> {
	const json = argv.includes("--json")
	const args = argv.filter((value) => value !== "--json")
	// A pipe error can arrive after main() returned and the exit status was assigned; it must still fail the run.
	process.stdout.on("error", () => {
		transportFailure(json)
		if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
	})
	let output: Output
	try {
		output = await dispatch(args)
	} catch (error) {
		// An unexpected failure keeps a fixed message: a raw error could quote private input.
		const envelope = error instanceof UsageError ? stationResult(error.identity, "usage", error.message) : stationResult("source-intake-dispatch.dispatch", "serialization", "The command failed unexpectedly.")
		output = { envelope, human: "" }
	}
	return emit(output, json)
}

// Contract Core bounded stop. The command keeps no diagnostics to flush, so a signal closes any open chooser, exits at
// once and writes nothing.
process.on("SIGINT", () => {
	closeChooser()
	process.exit(130)
})
process.on("SIGTERM", () => {
	closeChooser()
	process.exit(143)
})

const exitCode = await main(process.argv.slice(2))
process.exitCode = transportFailed ? 1 : exitCode
