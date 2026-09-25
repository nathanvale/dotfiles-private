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

type Guidance = { nextAction: string } | { handoff: { owner: "human"; reason: string; inspect: string[] } }

/** A refusal or failure station. Cause, outcome, exit and retry policy agree with the Contract Core cause table. */
interface Station {
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
		trigger: "An operand, option value or the observations file does not match its declared format.",
		repairAction: "Pass a Beads Task identifier (never Task text) and well-formed option values, or repair the observations file.",
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
		trigger: "The machine result cannot be serialized.",
		repairAction: "Inspect the serialization failure before retrying.",
		guidance: { nextAction: "Inspect the runtime and retry the command." },
	},
	emission: {
		causeCode: "INTERNAL_RESULT_EMISSION",
		outcome: "failed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The result output cannot be emitted.",
		repairAction: "Inspect the output stream before retrying.",
		guidance: { nextAction: "Inspect the output stream and retry the command." },
	},
} as const satisfies Record<string, Station>

export type StationKey = keyof typeof STATIONS

const COMMAND_STATIONS: Record<CommandIdentity, readonly StationKey[]> = {
	"agent-router.routes": ["malformedInput", "routesInvalid", "probeTimeout", "inputUnreadable", "serialization", "emission"],
	"agent-router.run": ["usage", "malformedInput", "routesInvalid", "routesMissing", "launchRefused", "probeTimeout", "inputUnreadable", "serialization", "emission"],
}

const SUCCESS_TRIGGERS: Record<CommandIdentity, string> = {
	"agent-router.routes": "The route inventory completes; unknown or stale evidence is reported, never hidden.",
	"agent-router.run": "The dry-run card completes; its pick is selected, needs-confirmation, ask or none-eligible.",
}

function effects() {
	return { completed: [], inventoryComplete: true, remaining: [], uncertain: [] }
}

function envelope(message: string, result: Record<string, unknown>) {
	return { envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message, availablePaths: AVAILABLE_PATHS, result }
}

export type Envelope = ReturnType<typeof envelope>

export function success(commandIdentity: CommandIdentity | ControlIdentity, data: unknown, message: string, nextAction: string): Envelope {
	return envelope(message, {
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
	})
}

export function stationResult(commandIdentity: CommandIdentity | ControlIdentity, key: StationKey, message: string): Envelope {
	const station: Station = STATIONS[key]
	const retry = station.retryDelayMilliseconds === undefined ? { retryable: false } : { retryable: true, retryDelayMilliseconds: station.retryDelayMilliseconds }
	return envelope(message, {
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
	})
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
