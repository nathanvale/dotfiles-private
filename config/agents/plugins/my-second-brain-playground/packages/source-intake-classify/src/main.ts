#!/usr/bin/env bun
// Source Intake classify public entry point: strict argv parsing, dispatch, and the validated Contract Core 2.0 output
// path. See contract.ts for the typed catalogue, lane.ts for the lane shape, preflight.ts for the fail-closed proof and
// run.ts for the one model run.
import { closeSync, constants, openSync, rmdirSync } from "node:fs"
import { isatty } from "node:tty"
import {
	classifySuccess,
	COMMANDS,
	commandDiscovery,
	discoveryData,
	EMISSION_FAILURE,
	type Envelope,
	fallbackKey,
	type Identity,
	isCommandIdentity,
	type StationKey,
	serializeEnvelope,
	stationResult,
	success,
} from "./contract.ts"
import { type LaneInput, parseLaneInput } from "./input.ts"
import { createWorkspace, LANE_MODEL, LANE_REASONING_EFFORT, type Lane, prepareLane, configHash } from "./lane.ts"
import { codexVersion, runPreflight } from "./preflight.ts"
import { runLane, stopLane } from "./run.ts"

const USAGE = [
	"Usage:",
	"  source-intake-classify classify [--json] < LANE_INPUT.json",
	"  source-intake-classify --discover [--json] | --discover-command COMMAND_IDENTITY [--json] | --help [--json]",
]

const OPTIONS = [
	{ name: "--json", valueName: null, summary: "Emit one Contract Core 2.0 envelope on stdout." },
	{ name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
	{ name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible stations." },
	{ name: "--help", valueName: null, summary: "Show this help." },
]

// Owner notes and Bead state make the lane input larger than a grant; the bound keeps a runaway pipe from growing memory.
const INPUT_LIMIT_BYTES = 256 * 1024
const DESCRIPTOR_LIMIT_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE"])

// Fixed, value-free messages. None names a path, projection value, probe output or raw error.
const MESSAGES: Record<Exclude<StationKey, "usage" | "serialization">, string> = {
	laneUnproven: "Classifier lane not started. Its read-prevention pre-flight did not pass.",
	inputBusy: "A file-descriptor limit was reached before input was read; no lane was started.",
	inputInvalid: "Standard input is not a valid lane input.",
	inputUnreadable: "Standard input cannot be read.",
	outcomeUnknown: "The classifier lane ended without a completed turn; the model call outcome is unknown.",
	resultCompleted: "The classifier lane completed, but its result is not a valid classification.",
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
	const data = { summary: "Classify one granted Source Intake projection in a read-denied Codex lane.", usage: USAGE.slice(1).map((line) => line.trim()), commands: COMMANDS, options: OPTIONS }
	const human = [...USAGE, "", "Options:", ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`)].join("\n")
	return { envelope: success("source-intake-classify.help", data, "Show help.", "Choose an invocation from the usage lines."), human }
}

function discoverOutput(): Output {
	const human = "Profile complex. Commands: classify (external, reads standard input, starts one Codex lane after a pre-flight)."
	return { envelope: success("source-intake-classify.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human }
}

function discoverCommandOutput(selector: string): Output {
	if (!isCommandIdentity(selector)) throw new UsageError("source-intake-classify.command-discovery", "--discover-command needs a listed command identity.")
	const data = commandDiscovery(selector)
	const human = `${selector}: ${data.stations.map((station) => `${station.causeCode}/${station.outcome}`).join(", ")}`
	return { envelope: success("source-intake-classify.command-discovery", data, `Describe ${selector}.`, "Read the stations; discovery reports no live state or grant."), human }
}

function isDescriptorLimit(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code
	return code !== undefined && DESCRIPTOR_LIMIT_CODES.has(code)
}

/** Checked once before input is read, so a descriptor limit is one retryable refusal before any lane setup. */
function descriptorLimitReached(): boolean {
	try {
		closeSync(openSync("/dev/null", constants.O_RDONLY))
		return false
	} catch (error) {
		return isDescriptorLimit(error)
	}
}

type InputRead = { kind: "text"; text: string } | { kind: "inputBusy" | "inputInvalid" | "inputUnreadable" }

/** Reads standard input to end of file, bounded. It is the only source of the lane input. */
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

function refusalOutput(key: keyof typeof MESSAGES): Output {
	return { envelope: stationResult("source-intake-classify.classify", key, MESSAGES[key]), human: "" }
}

// The run's workspace, held so a signal can remove it: process.exit in a signal handler skips the finally below.
let activeWorkspace: string | null = null

/** The workspace is read-only to the lane, so it is still empty; a non-empty one is left for inspection. */
function removeWorkspace(): void {
	const workspace = activeWorkspace
	activeWorkspace = null
	if (workspace === null) return
	try {
		rmdirSync(workspace)
	} catch {}
}

/** The pre-flight gates the model: only a passing proof on this run's workspace starts it. */
async function classifyInLane(lane: Lane, input: LaneInput): Promise<Output> {
	const workspace = createWorkspace()
	activeWorkspace = workspace
	try {
		const version = codexVersion(lane)
		if (version === null || !runPreflight(lane, workspace)) return refusalOutput("laneUnproven")
		const outcome = await runLane(lane, workspace, input)
		if (outcome.kind !== "classified") return refusalOutput(outcome.kind)
		const evidence = { codexVersion: version, laneConfigSha256: configHash(lane.configArgs), model: LANE_MODEL, reasoningEffort: LANE_REASONING_EFFORT, threadId: outcome.threadId }
		const data = { opaqueItemRef: input.dispatch.opaqueItemRef, classification: outcome.classification, lane: evidence }
		const { classification } = outcome
		const human = [
			`Classification for ${input.dispatch.opaqueItemRef}:`,
			`  owner: ${classification.ownerKind} ${classification.ownerName}`,
			`  summary: ${classification.summary}`,
			`  uncertainty: ${classification.uncertainty}`,
			`  decision question: ${classification.decisionQuestion}`,
			`  lane: codex ${version}, ${LANE_MODEL} ${LANE_REASONING_EFFORT}, thread ${outcome.threadId}`,
		].join("\n")
		return { envelope: classifySuccess(data), human }
	} finally {
		removeWorkspace()
	}
}

async function classifyOutput(): Promise<Output> {
	if (isatty(0)) throw new UsageError("source-intake-classify.classify", "Pipe the lane input on standard input; the command never prompts.")
	if (descriptorLimitReached()) return refusalOutput("inputBusy")
	const read = await readInput()
	if (read.kind !== "text") return refusalOutput(read.kind)
	const input = parseLaneInput(read.text)
	if (input === null) return refusalOutput("inputInvalid")
	const lane = prepareLane()
	if (lane === null) return refusalOutput("laneUnproven")
	return classifyInLane(lane, input)
}

/** Routes selected by a leading option, or null when the first argument is not a route option. */
function optionRoute(args: readonly string[]): Output | null {
	const [first, second, ...rest] = args
	if (args.length === 1 && (first === "--help" || first === "-h")) return helpOutput()
	if (args.length === 1 && first === "--discover") return discoverOutput()
	if (first !== "--discover-command") return null
	if (second === undefined || rest.length > 0) throw new UsageError("source-intake-classify.command-discovery", `${first} needs exactly one value.`)
	return discoverCommandOutput(second)
}

async function dispatch(args: readonly string[]): Promise<Output> {
	const routed = optionRoute(args)
	if (routed !== null) return routed
	if (args.some((arg) => arg.startsWith("-"))) throw new UsageError("source-intake-classify.dispatch", "An option is not recognised.")
	if (args[0] !== "classify") throw new UsageError("source-intake-classify.dispatch", "Choose a supported invocation.")
	if (args.length > 1) throw new UsageError("source-intake-classify.classify", "classify takes no operands; pipe the lane input on standard input.")
	return classifyOutput()
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

/** Machine output: the validated envelope, else the validated fallback that keeps its effect facts, else nothing. */
function emitMachine(envelope: Envelope): number {
	const text = serializeEnvelope(envelope)
	if (text !== null) return write(text, true) ?? envelope.result.exitCode
	const fallback = serializeEnvelope(stationResult(envelope.result.commandIdentity, fallbackKey(envelope), "The result could not be emitted safely."))
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
		const envelope = error instanceof UsageError ? stationResult(error.identity, "usage", error.message) : stationResult("source-intake-classify.dispatch", "serialization", "The command failed unexpectedly.")
		output = { envelope, human: "" }
	}
	return emit(output, json)
}

// Contract Core bounded stop. A running lane is killed first so no model process outlives the command, then the run's
// empty workspace is removed; nothing is written.
process.on("SIGINT", () => {
	stopLane()
	removeWorkspace()
	process.exit(130)
})
process.on("SIGTERM", () => {
	stopLane()
	removeWorkspace()
	process.exit(143)
})

const exitCode = await main(process.argv.slice(2))
process.exitCode = transportFailed ? 1 : exitCode
