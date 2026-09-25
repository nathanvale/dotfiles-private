// The one typed owner for Agent Router command identities, routes, cause stations, exit meanings and the
// Contract Core 2.0 envelope. Every public path, the discovery catalogue and the process tests read these tables.
import { randomUUID } from "node:crypto"

const CONTRACT_VERSION = "2.0.0"

export type CommandIdentity = "agent-router.routes" | "agent-router.run"
export type ControlIdentity = "agent-router.help" | "agent-router.discovery" | "agent-router.command-discovery" | "agent-router.dispatch"

export const COMMANDS = [
	{ commandIdentity: "agent-router.dispatch", effectClass: "inspect", route: [], summary: "Refuse a missing, unknown or malformed command selection." },
	{ commandIdentity: "agent-router.help", effectClass: "inspect", route: ["--help"], summary: "Show usage, commands and options." },
	{ commandIdentity: "agent-router.discovery", effectClass: "inspect", route: ["--discover"], summary: "Describe the contract, commands and effect exclusions." },
	{ commandIdentity: "agent-router.command-discovery", effectClass: "inspect", route: ["--discover-command"], summary: "Describe the possible stations of one command." },
	{
		commandIdentity: "agent-router.routes",
		effectClass: "inspect",
		route: ["routes"],
		summary: "Inventory declared and Monash Foundry routes with their evidence, freshness and owned gaps.",
	},
	{
		commandIdentity: "agent-router.run",
		effectClass: "inspect",
		route: ["run"],
		summary: "Show the dry-run decision card for one Beads Task; launch is refused in this build.",
	},
] as const satisfies readonly { commandIdentity: CommandIdentity | ControlIdentity; effectClass: "inspect"; route: string[]; summary: string }[]

const AVAILABLE_PATHS = [
	"agent-router.command-discovery",
	"agent-router.discovery",
	"agent-router.help",
	"agent-router.routes",
	"agent-router.run",
]

export type Guidance = { nextAction: string } | { handoff: { owner: "human"; reason: string; inspect: string[] } }

/** A refusal or failure station. Cause, outcome, exit and retry policy agree with the Contract Core cause table. */
export interface Station {
	causeCode: string
	outcome: "refused" | "failed"
	failureClass: "usage" | "domain" | "schema" | "internal" | "transient"
	exitCode: 1 | 2 | 3 | 4 | 75
	retryDelayMilliseconds?: number
	trigger: string
	repairAction: string
	guidance: Guidance
}

const PROBE_RETRY_DELAY_MILLISECONDS = 5_000

export const STATIONS = {
	usage: {
		causeCode: "USAGE_INVALID_INVOCATION",
		outcome: "refused",
		failureClass: "usage",
		exitCode: 2,
		trigger: "The arguments do not name one supported command with its required operands.",
		repairAction: "Choose one listed command with its required operands and retry.",
		guidance: { nextAction: "Run agent-router --help and choose a listed command." },
	},
	malformedInput: {
		causeCode: "SCHEMA_INVALID_INPUT",
		outcome: "refused",
		failureClass: "schema",
		exitCode: 4,
		trigger: "An operand or option value does not match its declared format.",
		repairAction: "Pass a Beads Task identifier (never Task text) and well-formed option values.",
		guidance: { nextAction: "Read agent-router --help --json for each value format, then retry." },
	},
	routesInvalid: {
		causeCode: "SCHEMA_CONFIG_INVALID",
		outcome: "refused",
		failureClass: "schema",
		exitCode: 4,
		trigger: "The routes file is not valid JSON or does not match the version 1 routes schema.",
		repairAction: "Repair the routes file against the schema in the agent-router README, then retry.",
		guidance: { nextAction: "Fix the reported routes-file field and rerun the command." },
	},
	routesMissing: {
		causeCode: "DOMAIN_CONFIG_MISSING",
		outcome: "refused",
		failureClass: "domain",
		exitCode: 3,
		trigger: "The dry run has no routes file to read, so no declared route can be judged.",
		repairAction: "Declare routes in the routes file (default $XDG_CONFIG_HOME/agent-router/routes.json) or pass --routes-file.",
		guidance: { nextAction: "Ask Nathan to declare permitted routes, then rerun the dry run." },
	},
	launchRefused: {
		causeCode: "DOMAIN_AUTHORITY_REQUIRED",
		outcome: "refused",
		failureClass: "domain",
		exitCode: 3,
		trigger: "run was invoked without --dry-run; this build never launches an agent.",
		repairAction: "Add --dry-run to inspect the decision card; launch belongs to the approved Herdr Projects launch path.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "Launching a worker needs the approved launch slice and Nathan's decision.",
				inspect: ["agent-router run TASK --dry-run"],
			},
		},
	},
	probeTimeout: {
		causeCode: "TRANSIENT_NOT_STARTED",
		outcome: "refused",
		failureClass: "transient",
		exitCode: 75,
		retryDelayMilliseconds: PROBE_RETRY_DELAY_MILLISECONDS,
		trigger: "A read-only evidence probe did not answer within the probe time budget; no card was produced.",
		repairAction: "Retry after the delay, or raise --probe-timeout-ms when the probe is known to be slow.",
		guidance: { nextAction: "Retry the same command after the stated delay." },
	},
	inputUnreadable: {
		causeCode: "INTERNAL_UNEXPECTED",
		outcome: "failed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "An input file exists but cannot be read, or the command fails unexpectedly.",
		repairAction: "Inspect the path named in the message; it must be a readable regular file.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "An input file is present but unreadable, which the router cannot repair.",
				inspect: ["ls -l on the path named in the message"],
			},
		},
	},
	serialization: {
		causeCode: "INTERNAL_RESULT_SERIALIZATION",
		outcome: "failed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The result cannot be serialized, or the serialized value fails envelope validation.",
		repairAction: "Inspect the serialization failure before retrying.",
		guidance: { nextAction: "Inspect the runtime and retry the command." },
	},
	emission: {
		causeCode: "INTERNAL_RESULT_EMISSION",
		outcome: "failed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "stdout cannot be written. Machine mode then emits no envelope and nothing on stderr; human mode prints this repair on stderr.",
		repairAction: "Inspect the output stream before retrying.",
		guidance: { nextAction: "Inspect the output stream and retry the command." },
	},
} as const satisfies Record<string, Station>

export type StationKey = keyof typeof STATIONS

const COMMAND_STATIONS: Record<CommandIdentity, readonly StationKey[]> = {
	"agent-router.routes": ["usage", "malformedInput", "routesInvalid", "probeTimeout", "inputUnreadable", "serialization", "emission"],
	"agent-router.run": ["usage", "malformedInput", "routesInvalid", "routesMissing", "launchRefused", "probeTimeout", "inputUnreadable", "serialization", "emission"],
}

const SUCCESS_TRIGGERS: Record<CommandIdentity, string> = {
	"agent-router.routes": "The route inventory completes; unknown or stale evidence is reported, never hidden.",
	"agent-router.run": "The dry-run card completes; its pick is needs-confirmation, ask or none-eligible.",
}

export type Handoff = { owner: "human"; reason: string; inspect: string[] }
export type Effects = { completed: []; inventoryComplete: true; remaining: []; uncertain: [] }

export interface ResultBase {
	runId: string
	commandIdentity: CommandIdentity | ControlIdentity
	effectClass: "inspect"
	transactionState: "unchanged"
	effects: Effects
}

export interface SuccessResult extends ResultBase {
	outcome: "success"
	causeCode: "SUCCESS_UNCHANGED"
	failureClass: null
	exitCode: 0
	data: unknown
	retryable: false
	repairAction: null
	nextAction: string
}

export type StationArm = ResultBase & {
	outcome: Station["outcome"]
	causeCode: string
	failureClass: Station["failureClass"]
	exitCode: Station["exitCode"]
	data: null
	repairAction: string
} & ({ retryable: false } | { retryable: true; retryDelayMilliseconds: number }) &
	({ nextAction: string } | { handoff: Handoff })

export interface Envelope {
	envelopeVersion: 2
	contractVersion: typeof CONTRACT_VERSION
	message: string
	availablePaths: string[]
	result: SuccessResult | StationArm
}

function effects(): Effects {
	return { completed: [], inventoryComplete: true, remaining: [], uncertain: [] }
}

export function success(commandIdentity: CommandIdentity | ControlIdentity, data: unknown, message: string, nextAction: string): Envelope {
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: randomUUID(),
			commandIdentity,
			outcome: "success",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "SUCCESS_UNCHANGED",
			failureClass: null,
			exitCode: 0,
			data,
			retryable: false,
			repairAction: null,
			effects: effects(),
			nextAction,
		},
	}
}

export function stationResult(commandIdentity: CommandIdentity | ControlIdentity, key: StationKey, message: string): Envelope {
	const station: Station = STATIONS[key]
	const retry = station.retryDelayMilliseconds === undefined ? { retryable: false as const } : { retryable: true as const, retryDelayMilliseconds: station.retryDelayMilliseconds }
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: randomUUID(),
			commandIdentity,
			outcome: station.outcome,
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: station.causeCode,
			failureClass: station.failureClass,
			exitCode: station.exitCode,
			data: null,
			...retry,
			repairAction: station.repairAction,
			effects: effects(),
			...station.guidance,
		},
	}
}

// ---- validated serialization ----

type Json = Record<string, unknown>

const IDENTITIES: readonly string[] = COMMANDS.map((command) => command.commandIdentity)
const ENVELOPE_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"]
const BASE_RESULT_KEYS = ["causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "outcome", "repairAction", "retryable", "runId", "transactionState"]

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonblank(value: unknown): boolean {
	return typeof value === "string" && value.trim() !== ""
}

function sameKeys(value: Json, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

function envelopeHolds(value: Json): boolean {
	const paths = value.availablePaths
	if (!sameKeys(value, ENVELOPE_KEYS) || value.envelopeVersion !== 2 || value.contractVersion !== CONTRACT_VERSION || !nonblank(value.message)) return false
	if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && IDENTITIES.includes(path))) return false
	return JSON.stringify(paths) === JSON.stringify([...new Set(paths)].sort())
}

function baseHolds(result: Json): boolean {
	const effects = result.effects
	if (!nonblank(result.runId) || !IDENTITIES.includes(String(result.commandIdentity))) return false
	if (result.effectClass !== "inspect" || result.transactionState !== "unchanged" || !isRecord(effects)) return false
	return JSON.stringify(effects) === JSON.stringify({ completed: [], inventoryComplete: true, remaining: [], uncertain: [] })
}

function successHolds(result: Json): boolean {
	if (!sameKeys(result, [...BASE_RESULT_KEYS, "nextAction"]) || !nonblank(result.nextAction)) return false
	return result.causeCode === "SUCCESS_UNCHANGED" && result.failureClass === null && result.exitCode === 0 && result.retryable === false && result.repairAction === null
}

function handoffHolds(value: unknown): boolean {
	if (!isRecord(value) || !sameKeys(value, ["inspect", "owner", "reason"]) || value.owner !== "human" || !nonblank(value.reason)) return false
	return Array.isArray(value.inspect) && value.inspect.length > 0 && value.inspect.every(nonblank)
}

/** A refusal or failure row must match its declared station exactly: cause, outcome, class, exit, retry and guidance arm. */
function stationHolds(result: Json): boolean {
	const station: Station | undefined = Object.values(STATIONS).find((entry: Station) => entry.causeCode === result.causeCode)
	if (station === undefined || result.data !== null || result.repairAction !== station.repairAction) return false
	if (result.outcome !== station.outcome || result.failureClass !== station.failureClass || result.exitCode !== station.exitCode) return false
	const retryKeys = station.retryDelayMilliseconds === undefined ? [] : ["retryDelayMilliseconds"]
	if (result.retryable !== (station.retryDelayMilliseconds !== undefined) || result.retryDelayMilliseconds !== station.retryDelayMilliseconds) return false
	const guidance = "handoff" in station.guidance ? "handoff" : "nextAction"
	if (!sameKeys(result, [...BASE_RESULT_KEYS, ...retryKeys, guidance])) return false
	return guidance === "handoff" ? handoffHolds(result.handoff) : nonblank(result.nextAction)
}

function envelopeValid(value: unknown): boolean {
	if (!isRecord(value) || !envelopeHolds(value) || !isRecord(value.result) || !baseHolds(value.result)) return false
	return value.result.outcome === "success" ? successHolds(value.result) : stationHolds(value.result)
}

/** Serializes, then validates the complete serialized value against the correlated result arms. Null means unsafe. */
export function serializeEnvelope(envelope: Envelope): string | null {
	try {
		const text = JSON.stringify(envelope)
		return typeof text === "string" && envelopeValid(JSON.parse(text)) ? `${text}\n` : null
	} catch {
		return null
	}
}

export function discoveryData() {
	return {
		contractVersion: CONTRACT_VERSION,
		generationConventionVersion: CONTRACT_VERSION,
		profile: "simple",
		commands: COMMANDS,
		exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
		signalExits: { "130": "SIGINT", "143": "SIGTERM" },
		effectExclusions: [
			"Never launches an agent, creates a pane or starts a Herdr Projects thread.",
			"Never consults TypeSafe or sends Task text anywhere.",
			"Never reads credentials or runs harness authentication commands.",
			"Never writes the routes file, Beads, Herdr Projects state or any configuration.",
			"Never refreshes the Monash snapshot (no monash models --refresh).",
		],
	}
}

function stationEntry(commandIdentity: CommandIdentity, station: Station) {
	return {
		commandIdentity,
		causeCode: station.causeCode,
		outcome: station.outcome,
		effectClass: "inspect",
		transactionState: "unchanged",
		failureClass: station.failureClass,
		exitCode: station.exitCode,
		retryable: station.retryDelayMilliseconds !== undefined,
		retryDelayPolicy: station.retryDelayMilliseconds === undefined ? { kind: "none" } : { kind: "fixed", milliseconds: station.retryDelayMilliseconds },
		repairAction: station.repairAction,
		guidance: station.guidance,
		trigger: station.trigger,
		reachability: "required",
		unreachableRationale: null,
	}
}

export function commandDiscovery(commandIdentity: CommandIdentity) {
	const command = COMMANDS.find((entry) => entry.commandIdentity === commandIdentity)
	return {
		command,
		semantics: "possible-outcomes",
		stations: [
			{
				commandIdentity,
				causeCode: "SUCCESS_UNCHANGED",
				outcome: "success",
				effectClass: "inspect",
				transactionState: "unchanged",
				failureClass: null,
				exitCode: 0,
				retryable: false,
				retryDelayPolicy: { kind: "none" },
				repairAction: null,
				guidance: { nextAction: "Read the card or inventory; no follow-up effect is implied." },
				trigger: SUCCESS_TRIGGERS[commandIdentity],
				reachability: "required",
				unreachableRationale: null,
			},
			...COMMAND_STATIONS[commandIdentity].map((key) => stationEntry(commandIdentity, STATIONS[key])),
		],
	}
}

export function isCommandIdentity(value: string | undefined): value is CommandIdentity {
	return value === "agent-router.routes" || value === "agent-router.run"
}

/** Raised by any layer to end the command at one declared station. */
export class StationError extends Error {
	constructor(
		readonly station: StationKey,
		message: string,
	) {
		super(message)
	}
}
