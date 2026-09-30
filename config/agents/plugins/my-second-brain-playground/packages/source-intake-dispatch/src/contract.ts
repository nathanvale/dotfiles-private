// The one typed owner for Source Intake dispatch command identities, routes, stations, exit meanings and the
// Contract Core 2.0 envelope. Every public path, the discovery catalogue and the process tests read these tables.
// Profile: complex, because the projection command checks an exact-item approval grant. Every command is inspect-only.
const CONTRACT_VERSION = "2.0.0"

export type CommandIdentity = "source-intake-dispatch.project" | "source-intake-dispatch.redacted"
export type ControlIdentity =
	| "source-intake-dispatch.command-discovery"
	| "source-intake-dispatch.discovery"
	| "source-intake-dispatch.dispatch"
	| "source-intake-dispatch.help"
export type Identity = CommandIdentity | ControlIdentity

export const COMMANDS = [
	{ commandIdentity: "source-intake-dispatch.dispatch", effectClass: "inspect", route: [], summary: "Refuse a missing, unknown or malformed invocation." },
	{ commandIdentity: "source-intake-dispatch.help", effectClass: "inspect", route: ["--help"], summary: "Show usage, commands and options." },
	{ commandIdentity: "source-intake-dispatch.discovery", effectClass: "inspect", route: ["--discover"], summary: "Describe the contract, commands and effect exclusions." },
	{ commandIdentity: "source-intake-dispatch.command-discovery", effectClass: "inspect", route: ["--discover-command"], summary: "Describe the possible stations of one command." },
	{
		commandIdentity: "source-intake-dispatch.project",
		effectClass: "inspect",
		route: ["GRANT", "REQUEST"],
		summary: "Project only the granted classification metadata fields after validating a private grant and request.",
	},
	{ commandIdentity: "source-intake-dispatch.redacted", effectClass: "inspect", route: ["--redacted"], summary: "Return the fixed redacted projection for status or evaluation." },
] as const satisfies readonly { commandIdentity: Identity; effectClass: "inspect"; route: string[]; summary: string }[]

const AVAILABLE_PATHS = [
	"source-intake-dispatch.command-discovery",
	"source-intake-dispatch.discovery",
	"source-intake-dispatch.help",
	"source-intake-dispatch.project",
	"source-intake-dispatch.redacted",
]

export type Handoff = { owner: "human"; reason: string; inspect: string[] }
export type Guidance = { nextAction: string } | { handoff: Handoff }

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

const INPUT_RETRY_DELAY_MILLISECONDS = 1_000

const STATIONS = {
	usage: {
		causeCode: "USAGE_INVALID_INVOCATION",
		outcome: "refused",
		failureClass: "usage",
		exitCode: 2,
		trigger: "The arguments do not name one supported command with its required operands.",
		repairAction: "Choose one listed invocation with its required operands and retry.",
		guidance: { nextAction: "Run source-intake-dispatch --help and choose a listed invocation." },
	},
	// Fixed and value-free: every authority mismatch and every receipt-dependent failure ends here with the same bytes.
	denied: {
		causeCode: "DOMAIN_PRECONDITION_UNMET",
		outcome: "refused",
		failureClass: "domain",
		exitCode: 3,
		trigger: "The request does not match a verified private grant, or the granted receipt cannot supply the projection.",
		repairAction: "Verify the private grant, then issue a request that matches it exactly.",
		guidance: { nextAction: "Ask Stage Manager to verify the private grant and issue a matching request." },
	},
	inputInvalid: {
		causeCode: "SCHEMA_INVALID_INPUT",
		outcome: "refused",
		failureClass: "schema",
		exitCode: 4,
		trigger: "The grant or request file is not JSON or does not match its declared shape.",
		repairAction: "Rewrite the grant and request with exactly the keys and value formats in the package README.",
		guidance: { nextAction: "Fix the grant or request file against the package README, then retry." },
	},
	inputBusy: {
		causeCode: "TRANSIENT_NOT_STARTED",
		outcome: "refused",
		failureClass: "transient",
		exitCode: 75,
		retryDelayMilliseconds: INPUT_RETRY_DELAY_MILLISECONDS,
		trigger: "The grant or request file could not be opened because a file-descriptor limit was reached; no receipt was touched.",
		repairAction: "Wait for open files to be released, then retry the same command.",
		guidance: { nextAction: "Retry the same command after the stated delay." },
	},
	inputUnreadable: {
		causeCode: "INTERNAL_UNEXPECTED",
		outcome: "failed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The grant or request path exists outside the item receipts but is not a readable regular file.",
		repairAction: "Pass a readable regular file for the grant and the request.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "A private input file is present but unreadable, which the command cannot repair.",
				inspect: ["ls -l on the grant and request paths"],
			},
		},
	},
	serialization: {
		causeCode: "INTERNAL_RESULT_UNCHANGED",
		outcome: "failed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The command fails unexpectedly, or its result cannot be serialized or fails envelope validation.",
		repairAction: "Inspect the serialization failure before retrying.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "The command produced a result it could not emit safely.",
				inspect: ["source-intake-dispatch --discover --json"],
			},
		},
	},
} as const satisfies Record<string, Station>

export type StationKey = keyof typeof STATIONS

const COMMAND_STATIONS: Record<CommandIdentity, readonly StationKey[]> = {
	"source-intake-dispatch.project": ["usage", "denied", "inputInvalid", "inputBusy", "inputUnreadable", "serialization"],
	"source-intake-dispatch.redacted": ["usage", "serialization"],
}

const SUCCESS_TRIGGERS: Record<CommandIdentity, string> = {
	"source-intake-dispatch.project": "A matching grant and request yield exactly the requested granted fields from the bound receipt.",
	"source-intake-dispatch.redacted": "The recipient is status or evaluation; the fixed redacted projection is returned.",
}

/** Stdout cannot be written. It is a lifecycle exception, not an envelope-bearing station. */
export const EMISSION_FAILURE = "stdout cannot be written. Inspect the output stream before retrying."

export type Effects = { completed: []; inventoryComplete: true; remaining: []; uncertain: [] }

export interface ResultBase {
	runId: string
	commandIdentity: Identity
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
	Guidance

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

// The command keeps no journal or diagnostics to correlate, so the run identity is fixed per command. This keeps
// every authority refusal byte-identical, which the no-existence-oracle invariant requires.
function runId(commandIdentity: Identity): string {
	return `run-${commandIdentity}`
}

export function success(commandIdentity: Identity, data: unknown, message: string, nextAction: string): Envelope {
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(commandIdentity),
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

export function stationResult(commandIdentity: Identity, key: StationKey, message: string): Envelope {
	const station: Station = STATIONS[key]
	const retry = station.retryDelayMilliseconds === undefined ? { retryable: false as const } : { retryable: true as const, retryDelayMilliseconds: station.retryDelayMilliseconds }
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(commandIdentity),
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
	if (!nonblank(result.runId) || !IDENTITIES.includes(String(result.commandIdentity))) return false
	if (result.effectClass !== "inspect" || result.transactionState !== "unchanged" || !isRecord(result.effects)) return false
	return JSON.stringify(result.effects) === JSON.stringify(effects())
}

function successHolds(result: Json): boolean {
	if (!sameKeys(result, [...BASE_RESULT_KEYS, "nextAction"]) || !nonblank(result.nextAction)) return false
	return result.causeCode === "SUCCESS_UNCHANGED" && result.failureClass === null && result.exitCode === 0 && result.retryable === false && result.repairAction === null
}

function handoffHolds(value: unknown): boolean {
	if (!isRecord(value) || !sameKeys(value, ["inspect", "owner", "reason"]) || value.owner !== "human" || !nonblank(value.reason)) return false
	return Array.isArray(value.inspect) && value.inspect.length > 0 && value.inspect.every(nonblank)
}

/** A refusal or failure row must match one declared station exactly: cause, outcome, class, exit, retry and guidance arm. */
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
		profile: "complex",
		commands: COMMANDS,
		exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
		signalExits: { "130": "SIGINT", "143": "SIGTERM" },
		effectExclusions: [
			"Never writes a file, receipt, grant, request, Beads record, vault note or configuration.",
			"Never reads Google Drive or any network resource.",
			"Never discloses a receipt value, source label, path or raw error in a refusal.",
			"Never opens a private receipt before the grant and request match.",
			"Never approves a grant; it only checks one the Stage Manager prepared.",
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
				guidance: { nextAction: "Pass the projection to its granted recipient only; no follow-up effect is implied." },
				trigger: SUCCESS_TRIGGERS[commandIdentity],
				reachability: "required",
				unreachableRationale: null,
			},
			...COMMAND_STATIONS[commandIdentity].map((key) => stationEntry(commandIdentity, STATIONS[key])),
		],
		lifecycleExceptions: [EMISSION_FAILURE],
	}
}

export function isCommandIdentity(value: string | undefined): value is CommandIdentity {
	return value === "source-intake-dispatch.project" || value === "source-intake-dispatch.redacted"
}
