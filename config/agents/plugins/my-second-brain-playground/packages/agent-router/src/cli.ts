// Agent Router public entry point: strict argv parsing, dispatch, and the validated Contract Core 2.0 output path.
// Every command is inspect-only; see contract.ts for the typed catalogue and effect exclusions.
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { decisionCard, type Inputs, inventory } from "./card.ts"
import {
	COMMANDS,
	type CommandIdentity,
	commandDiscovery,
	discoveryData,
	type Envelope,
	isCommandIdentity,
	serializeEnvelope,
	STATIONS,
	StationError,
	stationResult,
	success,
} from "./contract.ts"
import { loadRoutes } from "./declarations.ts"
import { collectEvidence } from "./evidence.ts"
import { renderCard, renderInventory } from "./render.ts"

const USAGE = [
	"Usage:",
	"  agent-router routes [--routes-file PATH] [--probe-timeout-ms N] [--json]",
	"  agent-router run TASK --dry-run [--project NAME] [--herdr-projects-root DIR] [--routes-file PATH] [--probe-timeout-ms N] [--json]",
	"  agent-router --discover [--json] | --discover-command COMMAND_IDENTITY [--json] | --help [--json]",
]

const OPTIONS = [
	{ name: "--json", valueName: null, summary: "Emit one Contract Core 2.0 envelope on stdout." },
	{ name: "--dry-run", valueName: null, summary: "Required by run: show the decision card; nothing is launched." },
	{ name: "--routes-file", valueName: "PATH", summary: "Routes file; default $XDG_CONFIG_HOME/agent-router/routes.json." },
	{ name: "--probe-timeout-ms", valueName: "N", summary: "Time budget per read-only probe, 1 to 600000; default 10000." },
	{ name: "--project", valueName: "NAME", summary: "Herdr Projects project the worker would join." },
	{ name: "--herdr-projects-root", valueName: "DIR", summary: "Herdr Projects root; default $HERDR_PROJECTS_ROOT." },
	{ name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
	{ name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible stations." },
	{ name: "--help", valueName: null, summary: "Show this help." },
]

const VALUE_OPTIONS = new Set(OPTIONS.filter((option) => option.valueName !== null).map((option) => option.name))
const FLAG_OPTIONS = new Set(["--dry-run", "--discover", "--help", "-h"])
const TASK_IDENTIFIER = /^[a-z][a-z0-9]*-[a-z0-9]+(\.[0-9]+)*$/
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
const DEFAULT_TIMEOUT_MS = 10_000

interface Parsed {
	words: string[]
	flags: Set<string>
	values: Map<string, string>
}

class UsageError extends Error {}

function parse(args: string[]): Parsed {
	const parsed: Parsed = { words: [], flags: new Set(), values: new Map() }
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string
		if (VALUE_OPTIONS.has(arg)) {
			const value = args[index + 1]
			if (value === undefined || parsed.values.has(arg)) throw new UsageError(`${arg} needs exactly one value.`)
			parsed.values.set(arg, value)
			index += 1
		} else if (FLAG_OPTIONS.has(arg)) parsed.flags.add(arg === "-h" ? "--help" : arg)
		else if (arg.startsWith("-")) throw new UsageError("An option is not recognised.")
		else parsed.words.push(arg)
	}
	return parsed
}

function allowOnly(parsed: Parsed, allowed: string[]): void {
	const names = [...parsed.flags, ...parsed.values.keys()]
	if (names.some((name) => !allowed.includes(name))) throw new UsageError("An option does not apply to this command.")
}

function timeout(parsed: Parsed): number {
	const raw = parsed.values.get("--probe-timeout-ms")
	if (raw === undefined) return DEFAULT_TIMEOUT_MS
	const value = Number(raw)
	if (!/^\d+$/.test(raw) || value < 1 || value > 600_000) throw new StationError("malformedInput", "--probe-timeout-ms must be an integer from 1 to 600000.")
	return value
}

function xdg(variable: string, fallback: string): string {
	const value = process.env[variable]
	return value !== undefined && isAbsolute(value) ? value : join(homedir(), fallback)
}

async function inputs(parsed: Parsed, requireRoutes: boolean, target: { root: string | null; project: string | null }): Promise<Inputs> {
	const routesFile = loadRoutes(resolve(parsed.values.get("--routes-file") ?? join(xdg("XDG_CONFIG_HOME", ".config"), "agent-router", "routes.json")))
	if (routesFile.status === "missing" && requireRoutes) throw new StationError("routesMissing", `No routes file exists at ${routesFile.path}.`)
	const evidence = await collectEvidence({
		harnesses: routesFile.routes.map((route) => route.harness),
		declaredHosts: routesFile.routes.flatMap((route) => route.hosts),
		timeoutMs: timeout(parsed),
		herdrProjectsRoot: target.root,
		project: target.project,
	})
	return { routesFile, evidence, now: Date.now() }
}

const COMMON = ["--routes-file", "--probe-timeout-ms"]

async function routesCommand(parsed: Parsed): Promise<Output> {
	allowOnly(parsed, COMMON)
	if (parsed.words.length !== 1) throw new UsageError("routes takes no operands.")
	timeout(parsed)
	const value = inventory(await inputs(parsed, false, { root: null, project: null }))
	const message = `Inventoried ${value.routes.length} routes with ${value.gaps.length} owned gaps.`
	return { envelope: success("agent-router.routes", value, message, "Read the inventory; run a dry run to judge the gates."), human: renderInventory(value) }
}

function targetOf(parsed: Parsed): { root: string | null; project: string | null } {
	const project = parsed.values.get("--project") ?? null
	if (project !== null && !PROJECT_NAME.test(project)) throw new StationError("malformedInput", "--project must be a Herdr Projects project name.")
	const root = parsed.values.get("--herdr-projects-root") ?? process.env.HERDR_PROJECTS_ROOT ?? null
	if (root !== null && !isAbsolute(root)) throw new StationError("malformedInput", "--herdr-projects-root must be an absolute path.")
	return { root, project }
}

const PICK_ACTIONS: Record<string, (route: string | null, candidates: string[], confirm: string[]) => string> = {
	"needs-confirmation": (route, _candidates, confirm) => `Ask Nathan to confirm ${confirm.join(", ")} for ${route} before any launch.`,
	ask: (_route, candidates) => `Ask Nathan to choose one route: ${candidates.join(", ")}.`,
	"none-eligible": () => "Resolve the listed refusals and gaps, then rerun the dry run.",
}

async function runCommand(parsed: Parsed): Promise<Output> {
	allowOnly(parsed, [...COMMON, "--dry-run", "--project", "--herdr-projects-root"])
	if (parsed.words.length !== 2) throw new UsageError("run takes exactly one TASK operand.")
	const task = parsed.words[1] as string
	if (!TASK_IDENTIFIER.test(task)) throw new StationError("malformedInput", "TASK must be a Beads Task identifier such as hpr-f5n.3; Task text is never accepted.")
	if (!parsed.flags.has("--dry-run")) throw new StationError("launchRefused", "Launch is refused: this build only shows the dry-run card.")
	timeout(parsed)
	const card = decisionCard(task, await inputs(parsed, true, targetOf(parsed)))
	const action = PICK_ACTIONS[card.pick.status]?.(card.pick.route, card.pick.candidates, card.pick.confirmations) ?? "Read the card."
	return { envelope: success("agent-router.run", card, `Dry-run pick: ${card.pick.status}.`, action), human: renderCard(card) }
}

interface Output {
	envelope: Envelope
	human: string
}

function helpOutput(): Output {
	const data = { summary: "Inspect-only Agent Router: route inventory and dry-run decision card.", usage: USAGE.slice(1).map((line) => line.trim()), commands: COMMANDS, options: OPTIONS }
	return { envelope: success("agent-router.help", data, "Show help.", "Choose a command from the usage lines."), human: [...USAGE, "", "Options:", ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`)].join("\n") }
}

function discoverOutput(): Output {
	const human = "Commands: routes (inspect), run TASK --dry-run (inspect)"
	return { envelope: success("agent-router.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human }
}

function discoverCommandOutput(parsed: Parsed): Output {
	const selector = parsed.values.get("--discover-command")
	if (!isCommandIdentity(selector)) throw new UsageError("--discover-command needs a listed command identity.")
	const data = commandDiscovery(selector)
	const human = `${selector}: ${data.stations.map((station) => `${station.causeCode}/${station.outcome}`).join(", ")}`
	return { envelope: success("agent-router.command-discovery", data, `Describe ${selector}.`, "Read the stations; discovery reports no live state."), human }
}

function commandOf(parsed: Parsed): CommandIdentity | "agent-router.dispatch" {
	if (parsed.words[0] === "routes") return "agent-router.routes"
	if (parsed.words[0] === "run") return "agent-router.run"
	return "agent-router.dispatch"
}

async function dispatch(parsed: Parsed): Promise<Output> {
	if (parsed.flags.has("--help") && parsed.words.length === 0 && parsed.values.size === 0 && parsed.flags.size === 1) return helpOutput()
	if (parsed.flags.has("--discover") && parsed.words.length === 0 && parsed.values.size === 0 && parsed.flags.size === 1) return discoverOutput()
	if (parsed.values.has("--discover-command") && parsed.words.length === 0 && parsed.values.size === 1 && parsed.flags.size === 0) return discoverCommandOutput(parsed)
	if (parsed.words[0] === "routes") return routesCommand(parsed)
	if (parsed.words[0] === "run") return runCommand(parsed)
	throw new UsageError("Choose a supported command.")
}

function refusal(identity: CommandIdentity | "agent-router.dispatch", error: unknown): Output {
	if (error instanceof StationError) return { envelope: stationResult(identity, error.station, error.message), human: "" }
	if (error instanceof UsageError) return { envelope: stationResult(identity, "usage", error.message), human: "" }
	return { envelope: stationResult(identity, "inputUnreadable", "The command failed unexpectedly before producing a result."), human: "" }
}

let humanFailureReported = false
let transportFailed = false

/** Human mode only: one repair line on stderr. Machine mode never writes stderr. */
function reportToStderr(envelope: Envelope): void {
	if (humanFailureReported) return
	humanFailureReported = true
	process.stderr.write(`${envelope.message} Repair: ${String(envelope.result.repairAction)}\n`)
}

/**
 * A transport failure (stdout cannot be written, including a closed pipe) is not a serialization failure: machine
 * mode keeps stderr empty, preserves whatever was observed and never emits a replacement envelope.
 */
function transportFailure(json: boolean): number {
	transportFailed = true
	if (!json) reportToStderr(stationResult("agent-router.dispatch", "emission", STATIONS.emission.trigger))
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
function emitMachine(identity: CommandIdentity | "agent-router.dispatch", envelope: Envelope): number {
	const text = serializeEnvelope(envelope)
	if (text !== null) return write(text, true) ?? (envelope.result.exitCode as number)
	const fallback = serializeEnvelope(stationResult(identity, "serialization", STATIONS.serialization.trigger))
	if (fallback === null) return 1
	return write(fallback, true) ?? 1
}

function emit(identity: CommandIdentity | "agent-router.dispatch", output: Output, json: boolean): number {
	if (json) return emitMachine(identity, output.envelope)
	const exitCode = output.envelope.result.exitCode as number
	if (exitCode !== 0) {
		reportToStderr(output.envelope)
		return exitCode
	}
	return write(`${output.human}\n`, false) ?? exitCode
}

async function main(argv: string[]): Promise<number> {
	const separator = argv.indexOf("--")
	const json = (separator === -1 ? argv : argv.slice(0, separator)).includes("--json")
	const args = argv.filter((value) => value !== "--json")
	process.stdout.on("error", () => transportFailure(json))
	let parsed: Parsed | null = null
	let output: Output
	try {
		parsed = parse(args)
		output = await dispatch(parsed)
	} catch (error) {
		output = refusal(parsed === null ? "agent-router.dispatch" : commandOf(parsed), error)
	}
	return emit(parsed === null ? "agent-router.dispatch" : commandOf(parsed), output, json)
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = transportFailed ? 1 : exitCode
