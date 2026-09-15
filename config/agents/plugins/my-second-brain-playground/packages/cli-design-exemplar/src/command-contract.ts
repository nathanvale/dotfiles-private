import { z } from "zod"
import type { ParseArgsConfig, ParseArgsOptionsConfig } from "node:util"
import type { EffectClass, Guidance, TransactionState } from "./model.ts"
import { STATION_ROWS } from "./station-rows.ts"

// The only place a number meets its exit name, a cause meets its class, an argv route meets its identity,
// and a tuple meets its declared fields (brief 12, section 6). Tests enumerate this domain but never read
// expected values from it (independent oracle rule).

export const CONTRACT_VERSION = "1.0.0" as const
export const ENVELOPE_VERSION = 1 as const
const MACHINE_MODE = "--json" as const

// The parser consumes this declaration directly, so option names, kinds and inferred parsed values share one owner.
export const CLI_OPTIONS = {
	json: { type: "boolean" },
	help: { type: "boolean" },
	discover: { type: "boolean" },
	preview: { type: "boolean" },
	apply: { type: "boolean" },
	automation: { type: "boolean" },
	"retry-once": { type: "boolean" },
	"include-diagnostics": { type: "boolean" },
	state: { type: "string" },
	"preview-id": { type: "string" },
	authorize: { type: "string" },
} as const satisfies ParseArgsOptionsConfig
export type OptionName = keyof typeof CLI_OPTIONS

export const PARSE_ARGS_CONFIG = {
	options: CLI_OPTIONS,
	strict: true,
	allowPositionals: true,
} as const satisfies ParseArgsConfig

const FAILURE_CLASSES = ["usage", "domain", "schema", "internal", "unavailable"] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

export const EXIT: Readonly<Record<FailureClass | "success", number>> = {
	success: 0,
	internal: 1,
	usage: 2,
	domain: 3,
	schema: 4,
	unavailable: 75,
}

export const EXIT_MEANINGS = {
	"0": "success",
	"1": "internal",
	"2": "usage",
	"3": "domain",
	"4": "schema",
	"75": "retryable-or-unavailable",
} as const

export const CAUSE = {
	USAGE_UNKNOWN_OPTION: "usage",
	USAGE_INVALID_ARGUMENTS: "usage",
	USAGE_COMMAND_REQUIRED: "usage",
	USAGE_UNKNOWN_COMMAND: "usage",
	DOMAIN_INPUT_MISSING: "domain",
	DOMAIN_INPUT_MALFORMED: "domain",
	DOMAIN_INPUT_UNREADABLE: "domain",
	DOMAIN_PATH_ESCAPE: "domain",
	DOMAIN_PREVIEW_STALE: "domain",
	DOMAIN_PREVIEW_CONSUMED: "domain",
	DOMAIN_PREVIEW_MISSING: "domain",
	DOMAIN_AUTHORITY_MISSING: "domain",
	DOMAIN_REPAIR_REQUIRED: "domain",
	DOMAIN_REPAIR_NOT_REQUIRED: "domain",
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: "domain",
	SCHEMA_STATE_INVALID: "schema",
	UNAVAILABLE_STORAGE_BUSY: "unavailable",
	INTERNAL_UNEXPECTED: "internal",
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: "internal",
	INTERNAL_EFFECT_NOT_OBSERVED: "internal",
	// Accepted T4 D6-c amendment (PE revision 3): the egress fallback causes.
	INTERNAL_PREPARATION: "internal",
	INTERNAL_RESULT_UNCHANGED: "internal",
	INTERNAL_RESULT_COMPLETED: "internal",
	INTERNAL_RESULT_UNKNOWN: "internal",
} as const satisfies Record<string, FailureClass>
export type CauseCode = keyof typeof CAUSE

export type CommandEffectClass = Exclude<EffectClass, "external">

interface RouteShape {
	route: string
	word: string
	allowedOptions: readonly OptionName[]
	requiredOptions: readonly OptionName[]
}

interface CommandShape {
	identity: `repair-lab.${string}`
	argv: string
	effectClass: CommandEffectClass
	description: string
	routes: readonly RouteShape[]
}

function defineCommands<const Commands extends readonly CommandShape[]>(commands: Commands): Commands {
	return commands
}

// One structured command and route declaration owns discovery metadata and every admitted argv shape.
const COMMAND_DECLARATIONS = defineCommands([
	{ identity: "repair-lab.help", argv: "--help", effectClass: "inspect", description: "Show help and usage", routes: [{ route: "help", word: "help", allowedOptions: ["help", "json"], requiredOptions: ["help"] }] },
	{ identity: "repair-lab.discover", argv: "--discover --json", effectClass: "inspect", description: "Describe commands and the contract", routes: [{ route: "discover", word: "discover", allowedOptions: ["discover", "json"], requiredOptions: ["discover"] }] },
	{ identity: "repair-lab.status", argv: "status [--json]", effectClass: "inspect", description: "Report the resource status", routes: [{ route: "status", word: "status", allowedOptions: ["json"], requiredOptions: [] }] },
	{ identity: "repair-lab.inspect", argv: "inspect [--state <path>] [--json]", effectClass: "inspect", description: "Inspect the resource and preview readiness", routes: [{ route: "inspect", word: "inspect", allowedOptions: ["json", "state"], requiredOptions: [] }] },
	{ identity: "repair-lab.inspect-diagnostics", argv: "inspect --include-diagnostics [--json]", effectClass: "inspect", description: "Inspect with redacted diagnostic fields", routes: [{ route: "inspect-diagnostics", word: "inspect", allowedOptions: ["json", "state", "include-diagnostics"], requiredOptions: ["include-diagnostics"] }] },
	{ identity: "repair-lab.preview", argv: "apply --preview [--json]", effectClass: "repository-local", description: "Write an apply preview without mutating state", routes: [{ route: "preview", word: "apply", allowedOptions: ["json", "preview"], requiredOptions: ["preview"] }] },
	{ identity: "repair-lab.apply", argv: "apply --preview-id <id> --authorize fixture-authority [--json]", effectClass: "repository-local", description: "Apply a fresh preview with fixture-local authority", routes: [{ route: "apply", word: "apply", allowedOptions: ["json", "preview-id", "authorize", "automation"], requiredOptions: [] }] },
	{
		identity: "repair-lab.repair",
		argv: "repair --preview | repair --apply --preview-id <id> --authorize fixture-authority [--json]",
		effectClass: "repository-local",
		description: "Preview or apply a repair of the derived index",
		routes: [
			{ route: "repair-preview", word: "repair", allowedOptions: ["json", "preview"], requiredOptions: ["preview"] },
			{ route: "repair", word: "repair", allowedOptions: ["json", "apply", "preview-id", "authorize", "automation"], requiredOptions: ["apply"] },
		],
	},
	{ identity: "repair-lab.repair-retry", argv: "repair --apply --retry-once --authorize fixture-authority [--json]", effectClass: "repository-local", description: "Apply a repair with one bounded transient retry", routes: [{ route: "repair-retry", word: "repair", allowedOptions: ["json", "apply", "retry-once", "authorize", "automation"], requiredOptions: ["apply", "retry-once"] }] },
	{ identity: "repair-lab.recover", argv: "recover [--json]", effectClass: "repository-local", description: "Read the journal and resource to report recovery state", routes: [{ route: "recover", word: "recover", allowedOptions: ["json"], requiredOptions: [] }] },
])

export type CommandIdentity = (typeof COMMAND_DECLARATIONS)[number]["identity"]
export type CliRoute = (typeof COMMAND_DECLARATIONS)[number]["routes"][number]["route"]
export type CommandRoute = Exclude<CliRoute, "help" | "discover">

export interface CommandDeclaration {
	identity: CommandIdentity
	argv: string
	effectClass: CommandEffectClass
	description: string
}

export interface RouteDeclaration {
	identity: CommandIdentity
	effectClass: CommandEffectClass
	route: CliRoute
	word: string
	allowedOptions: readonly OptionName[]
	requiredOptions: readonly OptionName[]
}

export const COMMANDS: readonly CommandDeclaration[] = COMMAND_DECLARATIONS.map(({ routes: _routes, ...command }) => command)
export const ROUTES: readonly RouteDeclaration[] = COMMAND_DECLARATIONS.flatMap((command) => command.routes.map((route) => ({ identity: command.identity, effectClass: command.effectClass, ...route })))

export function declarationForRoute(route: CliRoute): RouteDeclaration {
	const declaration = ROUTES.find((candidate) => candidate.route === route)
	if (declaration === undefined) throw new Error(`undeclared CLI route: ${route}`)
	return declaration
}

const COMMAND_IDENTITIES = COMMANDS.map((command) => command.identity)
const CauseCodeSchema = z.custom<CauseCode>((value) => typeof value === "string" && Object.hasOwn(CAUSE, value))

export const HELP_PATH = "repair-lab --help"
export const DISCOVER_PATH = "repair-lab --discover --json"
export const INSPECT_ACTION = "repair-lab inspect"
export const RECOVER_ACTION = "repair-lab recover"

// The fixture's required-handoff literal, owned here so the egress fallback can emit it from a recorded fact. The
// reason is the fixture's sentence; the prerequisites name the actual remaining effects (brief 12, 8.1).
const HANDOFF_REASON = "The fixture cannot prove whether the remaining effect committed."

export function handoffFor(remainingEffectIds: readonly string[]): { reason: string; prerequisites: string[] } {
	return {
		reason: HANDOFF_REASON,
		prerequisites: ["Inspect state/journal.jsonl and state/resource.json by hand", ...remainingEffectIds.map((effectId) => `Confirm whether ${effectId} committed`), "Reset the fixture from its snapshot before any new apply"],
	}
}

export type Outcome = "success" | "refused" | "failed" | "unknown"

export interface StationRow {
	commandIdentity: CommandIdentity
	outcome: Outcome
	causeCode: CauseCode | null
	effectClass: EffectClass
	transactionState: TransactionState
	retryable: boolean
	retryDelayMilliseconds: number | null
	guidance: Guidance["kind"]
	repairAction: boolean
	exit: number
	fixtureLabel: string | null
}

export type StationId = `${CommandIdentity}|${Outcome}|${CauseCode | "null"}`

// STATIONS is the typed readonly table this contract owns (CDS-PE-4); its rows live in the catalogue leaf.
export const STATIONS: readonly StationRow[] = STATION_ROWS

export interface MachineEnvelope {
	envelopeVersion: typeof ENVELOPE_VERSION
	contractVersion: typeof CONTRACT_VERSION
	commandIdentity: CommandIdentity
	runIdentity: string
	outcome: Outcome
	failureClass: FailureClass | null
	causeCode: CauseCode | null
	message: string
	effectClass: EffectClass | "external"
	transactionState: TransactionState | "partially-completed" | "rolled-back"
	retryable: boolean
	retryDelayMilliseconds: number | null
	nextAction: string | null
	availablePaths: string[]
	repairAction: string | null
	handoff: { reason: string; prerequisites: string[] } | null
	result: Record<string, unknown> | null
}

// Strict 17 fields plus the admitted cross-field checks (CDS-PE-1; brief 12, 7.2 stage 1). commandIdentity and causeCode
// are closed over this exemplar's own finite owners (PR 184, thread 4003822444); the generic 1.0 checker stays open.
export const MachineEnvelopeSchema = z
	.strictObject({
		envelopeVersion: z.literal(ENVELOPE_VERSION),
		contractVersion: z.literal(CONTRACT_VERSION),
		commandIdentity: z.enum(COMMAND_IDENTITIES),
		runIdentity: z.string().min(1),
		outcome: z.enum(["success", "refused", "failed", "unknown"]),
		failureClass: z.enum(FAILURE_CLASSES).nullable(),
		causeCode: CauseCodeSchema.nullable(),
		message: z.string(),
		effectClass: z.enum(["inspect", "repository-local", "external"]),
		transactionState: z.enum(["unchanged", "completed", "partially-completed", "rolled-back", "unknown"]),
		retryable: z.boolean(),
		retryDelayMilliseconds: z.number().nonnegative().finite().nullable(),
		nextAction: z.string().nullable(),
		availablePaths: z.array(z.string()),
		repairAction: z.string().nullable(),
		handoff: z.strictObject({ reason: z.string().min(1), prerequisites: z.array(z.string()) }).nullable(),
		result: z.record(z.string(), z.unknown()).nullable(),
	})
	.refine((value) => (value.outcome === "success") === (value.failureClass === null), { message: "outcome and failureClass disagree" })
	.refine((value) => (value.failureClass === null ? value.causeCode === null : value.causeCode?.startsWith(`${value.failureClass.toUpperCase()}_`) === true), {
		message: "causeCode does not match failureClass",
	})
	.refine((value) => value.nextAction === null || value.handoff === null, { message: "next-step rule: never both nextAction and handoff" })
	.refine((value) => value.outcome === "success" || (value.nextAction !== null) !== (value.handoff !== null), { message: "next-step rule: exactly one of nextAction or handoff" })
	.refine((value) => value.outcome !== "success" || (value.transactionState !== "unknown" && value.transactionState !== "partially-completed"), { message: "success never unresolved" })
	.refine((value) => (value.transactionState !== "unknown" && value.transactionState !== "partially-completed") || value.retryable === false, { message: "unresolved is not retryable" })
	.refine((value) => value.nextAction === null || value.nextAction.trim().length > 0, { message: "nextAction blank" })
	.refine((value) => value.repairAction === null || value.repairAction.trim().length > 0, { message: "repairAction blank" })

export function discovery(): Record<string, unknown> {
	return {
		name: "repair-lab",
		contractVersion: CONTRACT_VERSION,
		generationConventionVersion: "1.0.0",
		commands: COMMANDS.map((command) => ({ ...command })),
		exitMeanings: { ...EXIT_MEANINGS },
		machineMode: MACHINE_MODE,
		logtape: true,
	}
}

export function exitFor(failureClass: FailureClass | null): number {
	return failureClass === null ? EXIT.success : EXIT[failureClass]
}
