// The single owner of the msb-workflow public contract: Contract Core 1.0.0 envelope spelling, validation,
// discovery, closed exit mapping, redaction before public output, human rendering, and the terminal fallback.
// Every envelope command path returns through renderOutcome(). The `hook` identity is declared here for
// discovery and usage refusals only; its delivery output belongs to the Harness (see commands/hook.ts).

import type { DomainOutcome, EffectClass, JsonValue, TransactionState } from "./model.ts"

const CLI_NAME = "msb-workflow" as const
const ENVELOPE_VERSION = 1 as const
const CONTRACT_VERSION = "1.0.0" as const
const GENERATION_CONVENTION_VERSION = "1.0.0" as const
const MACHINE_MODE = "--json" as const
const REDACTED = "[REDACTED]"
// Contract Core redaction key pattern, repeated here independently of the diagnostics sink by design.
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i
const CAUSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

const EXIT = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, unavailable: 75 } as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
export type FailureClass = Exclude<keyof typeof EXIT, "success">
const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "unavailable" } as const
const FAILURE_CLASSES: readonly FailureClass[] = ["usage", "domain", "schema", "internal", "unavailable"]
const OUTCOMES: readonly DomainOutcome[] = ["success", "refused", "failed", "unknown"]
const EFFECT_CLASSES: readonly EffectClass[] = ["inspect", "repository-local", "external"]
const TRANSACTION_STATES: readonly TransactionState[] = ["unchanged", "completed", "partially-completed", "rolled-back", "unknown"]

export function exitFor(failureClass: FailureClass | null): ExitCode {
	return EXIT[failureClass ?? "success"]
}

export type CommandIdentity = "msb-workflow.help" | "msb-workflow.discover" | "msb-workflow.inspect" | "msb-workflow.bind" | "msb-workflow.recover" | "msb-workflow.hook"

export interface CommandDeclaration {
	readonly identity: CommandIdentity
	readonly argv: string
	readonly effectClass: EffectClass
	readonly description: string
}

export const COMMANDS: readonly CommandDeclaration[] = [
	{ identity: "msb-workflow.help", argv: "msb-workflow --help", effectClass: "inspect", description: "Print one usage line and one example" },
	{ identity: "msb-workflow.discover", argv: "msb-workflow --discover --json", effectClass: "inspect", description: "Describe the contract, commands, effect classes, exit meanings, machine mode and the private binding schema" },
	{ identity: "msb-workflow.inspect", argv: "msb-workflow inspect --workspace <absolute-path> [--session <id>]", effectClass: "inspect", description: "Check the pinned bd executable, the selected store, the state root, the binding, the marker and the lock files without writing" },
	{ identity: "msb-workflow.bind", argv: "msb-workflow bind --workspace <absolute-path> --bead <bead-id> [--session <id>] [--evidence <absolute-file>]", effectClass: "repository-local", description: "Bind this session to one Bead in the selected store, or refresh the same owner; the one private local write" },
	{ identity: "msb-workflow.recover", argv: "msb-workflow recover --workspace <absolute-path> [--session <id>]", effectClass: "inspect", description: "Rebuild this session's Resume Panel from current read-only bd reads and name one next safe action" },
	{ identity: "msb-workflow.hook", argv: "msb-workflow hook", effectClass: "repository-local", description: "Deliver session guidance or the Resume Panel for one Harness event read from stdin; Harness JSON out, always exit 0" },
]

export function commandDeclaration(identity: CommandIdentity): CommandDeclaration {
	const declaration = COMMANDS.find((command) => command.identity === identity)
	if (declaration === undefined) throw new Error(`undeclared command identity: ${identity}`)
	return declaration
}

export const HELP_TEXT = [
	"usage: msb-workflow <inspect|bind|recover|hook> [options] [--json]",
	"example: msb-workflow recover --workspace /absolute/path/to/workspace --session <id> --json",
	"",
	"commands:",
	...COMMANDS.slice(2).map((command) => `  ${command.argv}`),
	"",
	"--session or CODEX_SESSION_ID supplies the session; both present and different refuses.",
	"MSB_WORKFLOW_BD_EXECUTABLE names the pinned bd for inspect and bind; recover and hook use the bound one.",
	"Add --json anywhere for one Contract Core 1.0.0 envelope on stdout. Run msb-workflow --discover --json for the machine contract.",
	"",
].join("\n")

export const HELP_ACTION = "msb-workflow --help"
export const DISCOVER_ACTION = "msb-workflow --discover --json"

/** The additive machine-readable description of the private schema-v3 binding this helper owns. */
export const BINDING_SCHEMA = {
	schemaVersion: 3,
	address: "<state-root>/my-second-brain-playground/workflow-cli/recovery/sessions/<session-id>.json",
	markerAddress: "<state-root>/my-second-brain-playground/workflow-cli/recovery/sessions/<session-id>.marker.json",
	stateRootOrder: ["MSB_WORKFLOW_STATE_HOME", "XDG_STATE_HOME", "$HOME/.local/state"],
	required: ["schemaVersion", "sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "beadObservedAt", "sourceRepository", "evidencePath", "observedAt"],
	additionalProperties: false,
	nullable: ["evidencePath"],
	sessionIdentityPattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
	observedAt: "UTC RFC 3339 timestamp ending in Z",
	limitBytes: 16384,
	freshForSeconds: 3600,
	futureSkewSeconds: 300,
	fileMode: "0600",
	directoryMode: "0700",
} as const

export interface DiscoveryResult {
	readonly name: typeof CLI_NAME
	readonly contractVersion: typeof CONTRACT_VERSION
	readonly generationConventionVersion: typeof GENERATION_CONVENTION_VERSION
	readonly commands: readonly CommandDeclaration[]
	readonly exitMeanings: typeof EXIT_MEANINGS
	readonly machineMode: typeof MACHINE_MODE
	readonly logtape: true
	readonly bindingSchema: typeof BINDING_SCHEMA
}

export function discovery(): DiscoveryResult {
	return {
		name: CLI_NAME,
		contractVersion: CONTRACT_VERSION,
		generationConventionVersion: GENERATION_CONVENTION_VERSION,
		commands: COMMANDS,
		exitMeanings: EXIT_MEANINGS,
		machineMode: MACHINE_MODE,
		logtape: true,
		bindingSchema: BINDING_SCHEMA,
	}
}

export function machineMode(argv: readonly string[]): boolean {
	return argv.includes(MACHINE_MODE)
}

export type Mode = "human" | "machine"

export interface Handoff {
	readonly reason: string
	readonly prerequisites: readonly string[]
}

/** Execution facts the CLI hands to the contract; the same spelling as the public envelope minus the fixed version fields. */
export interface OutcomeFacts {
	readonly commandIdentity: CommandIdentity
	readonly runIdentity: string
	readonly outcome: DomainOutcome
	readonly failureClass: FailureClass | null
	readonly causeCode: string | null
	readonly message: string
	readonly effectClass: EffectClass
	readonly transactionState: TransactionState
	readonly retryable: boolean
	readonly retryDelayMilliseconds: number | null
	readonly nextAction: string | null
	readonly availablePaths: readonly string[]
	readonly repairAction: string | null
	readonly handoff: Handoff | null
	readonly result: { readonly [key: string]: JsonValue } | null
}

export interface Rendered {
	readonly stdout: string
	readonly stderr: string
	readonly exit: ExitCode
}

export interface RenderOptions {
	readonly knownSecretValues?: readonly string[] | undefined
}

type Envelope = Omit<OutcomeFacts, "result"> & {
	envelopeVersion: typeof ENVELOPE_VERSION
	contractVersion: typeof CONTRACT_VERSION
	result: Record<string, unknown> | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function nonBlank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

function validGuidance(facts: OutcomeFacts): boolean {
	const hasNext = facts.nextAction !== null
	const hasHandoff = facts.handoff !== null
	if (facts.outcome === "success") return true
	return hasNext !== hasHandoff
}

function validCause(facts: OutcomeFacts): boolean {
	if (facts.failureClass === null) return facts.causeCode === null
	return typeof facts.causeCode === "string" && CAUSE_CODE_PATTERN.test(facts.causeCode) && facts.causeCode.startsWith(`${facts.failureClass.toUpperCase()}_`)
}

const nullableOr = (accept: (value: unknown) => boolean) => (value: unknown): boolean => value === null || accept(value)
const isDelay = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0
const isHandoff = (value: unknown): boolean => isPlainObject(value) && nonBlank(value.reason) && Array.isArray(value.prerequisites) && value.prerequisites.every(nonBlank)
const isUnresolved = (state: TransactionState): boolean => state === "partially-completed" || state === "unknown"

// One rule per envelope field, then the cross-field rules Contract Core states in prose.
const FIELD_RULES: ReadonlyArray<readonly [field: string, holds: (facts: OutcomeFacts) => boolean]> = [
	["commandIdentity", (facts) => COMMANDS.some((command) => command.identity === facts.commandIdentity)],
	["runIdentity", (facts) => nonBlank(facts.runIdentity)],
	["outcome", (facts) => OUTCOMES.includes(facts.outcome)],
	["failureClass", (facts) => facts.failureClass === null || FAILURE_CLASSES.includes(facts.failureClass)],
	["outcome/failureClass", (facts) => (facts.outcome === "success") === (facts.failureClass === null)],
	["causeCode", validCause],
	["message", (facts) => typeof facts.message === "string"],
	["effectClass", (facts) => EFFECT_CLASSES.includes(facts.effectClass)],
	["transactionState", (facts) => TRANSACTION_STATES.includes(facts.transactionState)],
	["retryable", (facts) => typeof facts.retryable === "boolean"],
	["retryDelayMilliseconds", (facts) => nullableOr(isDelay)(facts.retryDelayMilliseconds)],
	["nextAction", (facts) => nullableOr(nonBlank)(facts.nextAction)],
	["availablePaths", (facts) => Array.isArray(facts.availablePaths) && facts.availablePaths.every(nonBlank)],
	["repairAction", (facts) => nullableOr(nonBlank)(facts.repairAction)],
	["handoff", (facts) => nullableOr(isHandoff)(facts.handoff)],
	["nextAction/handoff", validGuidance],
	["success/transactionState", (facts) => facts.outcome !== "success" || !isUnresolved(facts.transactionState)],
	["retryable/transactionState", (facts) => !isUnresolved(facts.transactionState) || !facts.retryable],
	["result", (facts) => nullableOr(isPlainObject)(facts.result)],
]

function validationIssues(facts: OutcomeFacts): string[] {
	return FIELD_RULES.filter(([, holds]) => !holds(facts)).map(([field]) => field)
}

function redactString(value: string, knownSecretValues: readonly string[]): string {
	let output = value
	for (const secret of knownSecretValues) {
		if (secret.length > 0) output = output.split(secret).join(REDACTED)
	}
	return output
}

// Key-based redaction on every object level plus known-value replacement in every string; the walk is bounded
// so a hostile owner response cannot recurse without limit.
function redactValue(value: unknown, knownSecretValues: readonly string[], depth: number): unknown {
	if (depth > 64) throw new Error("redaction depth exceeded")
	if (typeof value === "string") return redactString(value, knownSecretValues)
	if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecretValues, depth + 1))
	if (isPlainObject(value)) {
		const output: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) output[redactString(key, knownSecretValues)] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(child, knownSecretValues, depth + 1)
		return output
	}
	return value
}

/** The same key and known-value redaction for any text the helper emits outside the envelope (hook output). */
export function redactText(value: string, knownSecretValues: readonly string[]): string {
	return redactString(value, knownSecretValues)
}

/** Every value found under a secret-pattern key anywhere in an owner reply; these become the run's known secret values. */
export function collectSecretValues(value: unknown, depth = 0, found: string[] = []): string[] {
	if (depth > 64) return found
	if (Array.isArray(value)) for (const item of value) collectSecretValues(item, depth + 1, found)
	else if (isPlainObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			if (SECRET_KEY_PATTERN.test(key) && typeof child === "string" && child.length > 0) found.push(child)
			else collectSecretValues(child, depth + 1, found)
		}
	}
	return found
}

function envelopeFrom(facts: OutcomeFacts, knownSecretValues: readonly string[]): Envelope {
	return {
		envelopeVersion: ENVELOPE_VERSION,
		contractVersion: CONTRACT_VERSION,
		commandIdentity: facts.commandIdentity,
		runIdentity: facts.runIdentity,
		outcome: facts.outcome,
		failureClass: facts.failureClass,
		causeCode: facts.causeCode,
		message: redactString(facts.message, knownSecretValues),
		effectClass: facts.effectClass,
		transactionState: facts.transactionState,
		retryable: facts.retryable,
		retryDelayMilliseconds: facts.retryDelayMilliseconds,
		nextAction: facts.nextAction === null ? null : redactString(facts.nextAction, knownSecretValues),
		availablePaths: facts.availablePaths.map((path) => redactString(path, knownSecretValues)),
		repairAction: facts.repairAction === null ? null : redactString(facts.repairAction, knownSecretValues),
		handoff: facts.handoff === null ? null : { reason: redactString(facts.handoff.reason, knownSecretValues), prerequisites: facts.handoff.prerequisites.map((item) => redactString(item, knownSecretValues)) },
		result: facts.result === null ? null : (redactValue(facts.result, knownSecretValues, 0) as Record<string, unknown>),
	}
}

// Terminal fallback: the fixed encoding used when the facts cannot be validated or serialized. It carries the
// identities and, when it is a valid enum value, the transaction state the command actually reached.
function fallbackEnvelope(facts: OutcomeFacts, issues: readonly string[]): Envelope {
	const transactionState = TRANSACTION_STATES.includes(facts.transactionState) ? facts.transactionState : "unknown"
	const commandIdentity = COMMANDS.some((command) => command.identity === facts.commandIdentity) ? facts.commandIdentity : "msb-workflow.help"
	const runIdentity = nonBlank(facts.runIdentity) ? facts.runIdentity : "run-unknown"
	const effectClass = EFFECT_CLASSES.includes(facts.effectClass) ? facts.effectClass : commandDeclaration(commandIdentity).effectClass
	return {
		envelopeVersion: ENVELOPE_VERSION,
		contractVersion: CONTRACT_VERSION,
		commandIdentity,
		runIdentity,
		outcome: "failed",
		failureClass: "internal",
		causeCode: "INTERNAL_RENDER_FAILURE",
		message: `public envelope could not be rendered: ${issues.join(", ")}`,
		effectClass,
		transactionState,
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: null,
		availablePaths: [],
		repairAction: "Inspect the workspace with msb-workflow inspect and report the render failure with the run identity",
		handoff: { reason: "the command outcome could not be rendered as a public envelope", prerequisites: ["Inspect the workspace and session with msb-workflow inspect", "Report the run identity to the helper owner"] },
		result: { station: "render-failed" },
	}
}

function serialize(envelope: Envelope): string {
	const text = JSON.stringify(envelope)
	if (typeof text !== "string") throw new Error("envelope did not serialize")
	return `${text}\n`
}

function humanValue(value: unknown): string {
	if (typeof value === "string") return value
	if (value === null || typeof value === "number" || typeof value === "boolean") return String(value)
	return JSON.stringify(value)
}

function humanSuccess(envelope: Envelope): string {
	const result = envelope.result ?? {}
	// A panel is already prose; print it as is rather than as key/value lines.
	if (typeof result.resumePanel === "string") return `${result.resumePanel}\n`
	const lines: string[] = []
	if (typeof result.station === "string") lines.push(`station: ${result.station}`)
	for (const [key, value] of Object.entries(result)) {
		if (key !== "station") lines.push(`${key}: ${humanValue(value)}`)
	}
	if (lines.length === 0) lines.push(envelope.message)
	if (envelope.nextAction !== null) lines.push(`next: ${envelope.nextAction}`)
	return `${lines.join("\n")}\n`
}

function humanFailure(envelope: Envelope): string {
	const repair = envelope.repairAction ?? (envelope.handoff === null ? `run ${HELP_ACTION}` : envelope.handoff.reason)
	const line = `${CLI_NAME}: ${envelope.causeCode ?? "FAILED"}: ${envelope.message}; repair: ${repair}`.replace(/[\r\n]+/g, " ")
	return `${line}\n`
}

function renderEnvelope(envelope: Envelope, mode: Mode): Rendered {
	const exit = exitFor(envelope.failureClass)
	if (mode === "machine") return { stdout: serialize(envelope), stderr: "", exit }
	if (envelope.outcome === "success") return { stdout: humanSuccess(envelope), stderr: "", exit }
	return { stdout: "", stderr: humanFailure(envelope), exit }
}

/** Every envelope command path returns through here: validate, redact, serialize; fall back to one fixed internal envelope. */
export function renderOutcome(facts: OutcomeFacts, mode: Mode, options: RenderOptions = {}): Rendered {
	const knownSecretValues = options.knownSecretValues ?? []
	const issues = validationIssues(facts)
	if (issues.length === 0) {
		try {
			return renderEnvelope(envelopeFrom(facts, knownSecretValues), mode)
		} catch (error) {
			issues.push(error instanceof Error && error.message.length > 0 ? error.message.slice(0, 80) : "serialization")
		}
	}
	return renderEnvelope(fallbackEnvelope(facts, issues), mode)
}

/** Human rendering of discovery: the same facts as the machine envelope, as prose. */
export function renderDiscoveryHuman(): string {
	const data = discovery()
	const lines = [`${data.name} contract ${data.contractVersion} (generation convention ${data.generationConventionVersion}); machine mode ${data.machineMode}; logtape ${data.logtape}`]
	for (const command of data.commands) lines.push(`${command.identity} [${command.effectClass}]: ${command.argv}`)
	lines.push(`exits: ${Object.entries(data.exitMeanings).map(([code, meaning]) => `${code}=${meaning}`).join(" ")}`)
	lines.push(`binding schema v${data.bindingSchema.schemaVersion} at ${data.bindingSchema.address}`)
	return `${lines.join("\n")}\n`
}
