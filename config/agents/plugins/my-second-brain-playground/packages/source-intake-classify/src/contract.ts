// The one typed owner for Source Intake classify command identities, routes, stations, exit meanings and the Contract
// Core 2.0 envelope. Every public path, the discovery catalogue and the process tests read these tables.
// Profile: complex, because classify discloses a granted projection to a model (an external effect) and must prove
// read prevention before it starts. Only classify is external; the control routes are inspect-only.
const CONTRACT_VERSION = "2.0.0"

/** The one external effect: sending the lane input to the classifier model. */
const MODEL_CALL_EFFECT = "classifier-model-call"

export type CommandIdentity = "source-intake-classify.classify"
export type ControlIdentity =
	| "source-intake-classify.command-discovery"
	| "source-intake-classify.discovery"
	| "source-intake-classify.dispatch"
	| "source-intake-classify.help"
export type Identity = CommandIdentity | ControlIdentity
export type EffectClass = "inspect" | "external"

export const COMMANDS = [
	{ commandIdentity: "source-intake-classify.dispatch", effectClass: "inspect", route: [], summary: "Refuse a missing, unknown or malformed invocation." },
	{ commandIdentity: "source-intake-classify.help", effectClass: "inspect", route: ["--help"], summary: "Show usage, commands and options." },
	{ commandIdentity: "source-intake-classify.discovery", effectClass: "inspect", route: ["--discover"], summary: "Describe the contract, commands and effect exclusions." },
	{ commandIdentity: "source-intake-classify.command-discovery", effectClass: "inspect", route: ["--discover-command"], summary: "Describe the possible stations of one command." },
	{
		commandIdentity: "source-intake-classify.classify",
		effectClass: "external",
		route: ["classify"],
		summary: "Classify one granted projection piped on standard input in a read-denied Codex lane, after a per-run pre-flight proves the denial.",
	},
] as const satisfies readonly { commandIdentity: Identity; effectClass: EffectClass; route: string[]; summary: string }[]

const AVAILABLE_PATHS = ["source-intake-classify.classify", "source-intake-classify.command-discovery", "source-intake-classify.discovery", "source-intake-classify.help"]

export type Handoff = { owner: "human"; reason: string; inspect: string[] }
export type Guidance = { nextAction: string } | { handoff: Handoff }
export type TransactionState = "unchanged" | "completed" | "unknown"

/** A refusal or failure station. Cause, outcome, state, exit and retry policy agree with the Contract Core cause table. */
export interface Station {
	causeCode: string
	outcome: "refused" | "failed"
	transactionState: TransactionState
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
		transactionState: "unchanged",
		failureClass: "usage",
		exitCode: 2,
		trigger: "The arguments do not name one supported command with its required operands.",
		repairAction: "Choose one listed invocation with its required operands and retry.",
		guidance: { nextAction: "Run source-intake-classify --help and choose a listed invocation." },
	},
	// Fixed and value-free: every setup or pre-flight failure ends here with the same bytes, and no model is started.
	laneUnproven: {
		causeCode: "DOMAIN_PRECONDITION_UNMET",
		outcome: "refused",
		transactionState: "unchanged",
		failureClass: "domain",
		exitCode: 3,
		trigger: "The classifier lane could not be prepared, or its pre-flight did not prove that the lane denies both private receipt roots.",
		repairAction: "Inspect the Codex install, the lane profile and both receipt roots, then retry.",
		guidance: { nextAction: "Ask Stage Manager to inspect the classifier lane pre-flight before any retry." },
	},
	inputInvalid: {
		causeCode: "SCHEMA_INVALID_INPUT",
		outcome: "refused",
		transactionState: "unchanged",
		failureClass: "schema",
		exitCode: 4,
		trigger: "Standard input is not one JSON object holding a dispatch projection, owner notes and Bead state of the declared shape.",
		repairAction: "Pipe exactly one lane input object with the keys and value formats in the package README.",
		guidance: { nextAction: "Fix the piped lane input against the package README, then retry." },
	},
	inputBusy: {
		causeCode: "TRANSIENT_NOT_STARTED",
		outcome: "refused",
		transactionState: "unchanged",
		failureClass: "transient",
		exitCode: 75,
		retryDelayMilliseconds: INPUT_RETRY_DELAY_MILLISECONDS,
		trigger: "A file-descriptor limit was reached before input was read; no lane was started.",
		repairAction: "Wait for open files to be released, then retry the same command.",
		guidance: { nextAction: "Retry the same command after the stated delay." },
	},
	inputUnreadable: {
		causeCode: "INTERNAL_UNEXPECTED",
		outcome: "failed",
		transactionState: "unchanged",
		failureClass: "internal",
		exitCode: 1,
		trigger: "Standard input cannot be read.",
		repairAction: "Pipe the lane input from a readable file or stream.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "Standard input could not be read, which the command cannot repair.",
				inspect: ["the standard input redirection of the calling command"],
			},
		},
	},
	outcomeUnknown: {
		causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN",
		outcome: "failed",
		transactionState: "unknown",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The classifier lane started but ended without a completed turn, so whether the model received the input is unknown.",
		repairAction: "Inspect the lane rollout before deciding on a new run; never replay automatically.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "The model may have received the granted projection; only the rollout can say.",
				inspect: ["the newest rollout under the lane Codex home named in the package README"],
			},
		},
	},
	resultCompleted: {
		causeCode: "INTERNAL_RESULT_COMPLETED",
		outcome: "failed",
		transactionState: "completed",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The model turn completed, but its final message is not a valid classification or the result could not be emitted safely.",
		repairAction: "Inspect the completed lane rollout; do not rerun to repair reporting.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "The model received the granted projection and completed; its result was not usable.",
				inspect: ["the newest rollout under the lane Codex home named in the package README"],
			},
		},
	},
	serialization: {
		causeCode: "INTERNAL_RESULT_UNCHANGED",
		outcome: "failed",
		transactionState: "unchanged",
		failureClass: "internal",
		exitCode: 1,
		trigger: "The command fails unexpectedly before the lane starts, or its result cannot be serialized or fails envelope validation.",
		repairAction: "Inspect the serialization failure before retrying.",
		guidance: {
			handoff: {
				owner: "human",
				reason: "The command produced a result it could not emit safely.",
				inspect: ["source-intake-classify --discover --json"],
			},
		},
	},
} as const satisfies Record<string, Station>

export type StationKey = keyof typeof STATIONS

const CLASSIFY_STATIONS: readonly StationKey[] = ["usage", "laneUnproven", "inputInvalid", "inputBusy", "inputUnreadable", "outcomeUnknown", "resultCompleted", "serialization"]

/** Stdout cannot be written. It is a lifecycle exception, not an envelope-bearing station. */
export const EMISSION_FAILURE = "stdout cannot be written. Inspect the output stream before retrying."

export type Effects = { completed: string[]; inventoryComplete: true; remaining: []; uncertain: string[] }

export interface ResultBase {
	runId: string
	commandIdentity: Identity
	effectClass: EffectClass
	transactionState: TransactionState
	effects: Effects
}

export interface SuccessResult extends ResultBase {
	outcome: "success"
	causeCode: "SUCCESS_UNCHANGED" | "SUCCESS_COMPLETED"
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

function effectClassOf(commandIdentity: Identity): EffectClass {
	return commandIdentity === "source-intake-classify.classify" ? "external" : "inspect"
}

function effectsFor(state: TransactionState): Effects {
	const completed = state === "completed" ? [MODEL_CALL_EFFECT] : []
	const uncertain = state === "unknown" ? [MODEL_CALL_EFFECT] : []
	return { completed, inventoryComplete: true, remaining: [], uncertain }
}

// The run identity is fixed per command: the command keeps no journal to correlate, and a fixed identity keeps the
// lane refusal byte-identical. The rollout thread identity in the success data correlates a completed model call.
function runId(commandIdentity: Identity): string {
	return `run-${commandIdentity}`
}

export function success(commandIdentity: Identity, data: unknown, message: string, nextAction: string): Envelope {
	const completed = commandIdentity === "source-intake-classify.classify"
	const state: TransactionState = completed ? "completed" : "unchanged"
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(commandIdentity),
			commandIdentity,
			outcome: "success",
			effectClass: effectClassOf(commandIdentity),
			transactionState: state,
			causeCode: completed ? "SUCCESS_COMPLETED" : "SUCCESS_UNCHANGED",
			failureClass: null,
			exitCode: 0,
			data,
			retryable: false,
			repairAction: null,
			effects: effectsFor(state),
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
			effectClass: effectClassOf(commandIdentity),
			transactionState: station.transactionState,
			causeCode: station.causeCode,
			failureClass: station.failureClass,
			exitCode: station.exitCode,
			data: null,
			...retry,
			repairAction: station.repairAction,
			effects: effectsFor(station.transactionState),
			...station.guidance,
		},
	}
}

/** The internal fallback that keeps the trusted effect facts of a result that could not be emitted. */
export function fallbackKey(envelope: Envelope): StationKey {
	const state = envelope.result.transactionState
	if (state === "completed") return "resultCompleted"
	return state === "unknown" ? "outcomeUnknown" : "serialization"
}

// ---- validated serialization ----

type Json = Record<string, unknown>

const IDENTITIES: readonly string[] = COMMANDS.map((command) => command.commandIdentity)
const ENVELOPE_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"]
const BASE_RESULT_KEYS = ["causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "outcome", "repairAction", "retryable", "runId", "transactionState"]
const STATES: readonly string[] = ["unchanged", "completed", "unknown"]

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

/** Effect class follows the command, and the effect inventory follows the transaction state exactly. */
function baseHolds(result: Json): boolean {
	if (!nonblank(result.runId) || !IDENTITIES.includes(String(result.commandIdentity))) return false
	const state = String(result.transactionState)
	if (result.effectClass !== effectClassOf(result.commandIdentity as Identity) || !STATES.includes(state) || !isRecord(result.effects)) return false
	if (result.effectClass === "inspect" && state !== "unchanged") return false
	return JSON.stringify(result.effects) === JSON.stringify(effectsFor(state as TransactionState))
}

function successHolds(result: Json): boolean {
	if (!sameKeys(result, [...BASE_RESULT_KEYS, "nextAction"]) || !nonblank(result.nextAction)) return false
	const cause = result.transactionState === "completed" ? "SUCCESS_COMPLETED" : "SUCCESS_UNCHANGED"
	return result.causeCode === cause && result.failureClass === null && result.exitCode === 0 && result.retryable === false && result.repairAction === null
}

function handoffHolds(value: unknown): boolean {
	if (!isRecord(value) || !sameKeys(value, ["inspect", "owner", "reason"]) || value.owner !== "human" || !nonblank(value.reason)) return false
	return Array.isArray(value.inspect) && value.inspect.length > 0 && value.inspect.every(nonblank)
}

/** A refusal or failure row must match one declared station exactly: cause, outcome, state, class, exit, retry and guidance arm. */
function stationHolds(result: Json): boolean {
	const station: Station | undefined = Object.values(STATIONS).find((entry: Station) => entry.causeCode === result.causeCode)
	if (station === undefined || result.data !== null || result.repairAction !== station.repairAction || result.transactionState !== station.transactionState) return false
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
			"Never opens a caller-supplied input path; the lane input arrives on standard input.",
			"Never reads a private receipt; it passes on only the granted dispatch projection, owner notes and Bead state.",
			"Never starts the classifier model unless the per-run pre-flight proves the lane profile denies both private receipt roots.",
			"Never forwards pre-flight probe output or lane tool output.",
			"Never writes a receipt, grant, Beads record, vault note or Codex user configuration.",
			"Never reads Google Drive.",
		],
	}
}

function stationEntry(commandIdentity: CommandIdentity, station: Station) {
	return {
		commandIdentity,
		causeCode: station.causeCode,
		outcome: station.outcome,
		effectClass: effectClassOf(commandIdentity),
		transactionState: station.transactionState,
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
				causeCode: "SUCCESS_COMPLETED",
				outcome: "success",
				effectClass: effectClassOf(commandIdentity),
				transactionState: "completed",
				failureClass: null,
				exitCode: 0,
				retryable: false,
				retryDelayPolicy: { kind: "none" },
				repairAction: null,
				guidance: { nextAction: "Hand the classification back to the granted foreground Steward; record the lane evidence in the private receipt." },
				trigger: "The pre-flight passed and the model turn completed with a valid classification.",
				reachability: "required",
				unreachableRationale: null,
			},
			...CLASSIFY_STATIONS.map((key) => stationEntry(commandIdentity, STATIONS[key])),
		],
		lifecycleExceptions: [EMISSION_FAILURE],
	}
}

export function isCommandIdentity(value: string | undefined): value is CommandIdentity {
	return value === "source-intake-classify.classify"
}
