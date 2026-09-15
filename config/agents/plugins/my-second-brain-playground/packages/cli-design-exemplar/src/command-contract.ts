import { z } from "zod"
import type { ParseArgsConfig, ParseArgsOptionsConfig } from "node:util"
import type { EffectClass } from "./model.ts"
import { STATION_ROWS } from "./station-rows.ts"

/** The single owner of the successor's exit and cause vocabulary. */
export const CONTRACT_VERSION = "2.0.0" as const
export const ENVELOPE_VERSION = 2 as const
export const EXIT = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, transient: 75 } as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
export type FailureClass = Exclude<keyof typeof EXIT, "success">
export const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" } as const

export type Outcome = "success" | "refused" | "failed"
export type WireTransactionState = "unchanged" | "completed" | "partially-completed" | "unknown"
type GuidanceArm = "next" | "handoff"
const cause = <C extends FailureClass | null, O extends Outcome, S extends WireTransactionState, R extends boolean, G extends GuidanceArm>(failureClass: C, outcome: O, transactionState: S, retryable: R, guidance: G) => ({ failureClass, outcome, transactionState, retryable, guidance }) as const
const CAUSE_RULES = {
	SUCCESS_UNCHANGED: cause(null, "success", "unchanged", false, "next"),
	SUCCESS_COMPLETED: cause(null, "success", "completed", false, "next"),
	USAGE_INVALID_INVOCATION: cause("usage", "refused", "unchanged", false, "next"),
	USAGE_UNKNOWN_COMMAND: cause("usage", "refused", "unchanged", false, "next"),
	SCHEMA_INVALID_INPUT: cause("schema", "refused", "unchanged", false, "next"),
	SCHEMA_UNSUPPORTED_CONTRACT: cause("schema", "refused", "unchanged", false, "next"),
	DOMAIN_PRECONDITION_UNMET: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_AUTHORITY_REQUIRED: cause("domain", "refused", "unchanged", false, "handoff"),
	TRANSIENT_NOT_STARTED: cause("transient", "refused", "unchanged", true, "next"),
	TRANSIENT_ATTEMPT_UNCHANGED: cause("transient", "failed", "unchanged", true, "next"),
	DOMAIN_DEADLINE_BEFORE_START: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_DEADLINE_UNCHANGED: cause("domain", "failed", "unchanged", false, "next"),
	DOMAIN_DEADLINE_COMPLETED: cause("domain", "failed", "completed", false, "handoff"),
	DOMAIN_DEADLINE_PARTIAL: cause("domain", "failed", "partially-completed", false, "handoff"),
	DOMAIN_DEADLINE_UNKNOWN: cause("domain", "failed", "unknown", false, "handoff"),
	INTERNAL_PREPARATION: cause("internal", "refused", "unchanged", false, "next"),
	INTERNAL_RESULT_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_RESULT_COMPLETED: cause("internal", "failed", "completed", false, "handoff"),
	INTERNAL_RESULT_PARTIAL: cause("internal", "failed", "partially-completed", false, "handoff"),
	INTERNAL_RESULT_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: cause("domain", "failed", "unknown", false, "handoff"),
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_EFFECT_NOT_OBSERVED: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_UNEXPECTED: cause("internal", "failed", "unchanged", false, "handoff"),
	// O1 Candidate A (ticket freeze 2026-09-15): the accepted cause batch minus DOMAIN_JOURNAL_LOCK_HELD (Candidate B).
	DOMAIN_JOURNAL_LIMIT_REACHED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_JOURNAL_LOCK_HELD: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_PRIOR_RUN_PENDING: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_RECOVERY_PARTIAL_HANDOFF: cause("domain", "failed", "partially-completed", false, "handoff"),
} as const
export type WireCauseCode = keyof typeof CAUSE_RULES
export type CauseRule = (typeof CAUSE_RULES)[WireCauseCode]
/** The accepted result-table row of one cause; the station catalogue schema checks every declaration against it. */
export function causeRule(code: WireCauseCode): CauseRule { return CAUSE_RULES[code] }
type RuleQuery = { readonly [Field in keyof CauseRule]?: CauseRule[Field] }
type CausesWhere<Query extends RuleQuery> = { [Code in WireCauseCode]: (typeof CAUSE_RULES)[Code] extends Query ? Code : never }[WireCauseCode]
// A result-schema row names its cause group by the accepted rule fields, so CAUSE_RULES stays the one owner of which
// causes share a row; the same selection is made at the type level so the inferred result type stays literal.
function causesWhere<const Query extends RuleQuery>(query: Query): readonly CausesWhere<Query>[] {
	const fields = Object.entries(query) as [keyof CauseRule, CauseRule[keyof CauseRule]][]
	return (Object.keys(CAUSE_RULES) as WireCauseCode[]).filter((code): code is CausesWhere<Query> => fields.every(([field, value]) => CAUSE_RULES[code][field] === value))
}

// The old engine still owns its decision representation. This alias is input-only
// composition, not an emitted wire vocabulary or a legacy adapter.
export type EngineCauseCode =
	| "USAGE_UNKNOWN_OPTION" | "USAGE_INVALID_ARGUMENTS" | "USAGE_COMMAND_REQUIRED" | "USAGE_UNKNOWN_COMMAND"
	| "DOMAIN_INPUT_MISSING" | "DOMAIN_INPUT_MALFORMED" | "DOMAIN_INPUT_UNREADABLE" | "DOMAIN_PATH_ESCAPE" | "DOMAIN_PREVIEW_STALE" | "DOMAIN_PREVIEW_CONSUMED" | "DOMAIN_PREVIEW_MISSING" | "DOMAIN_AUTHORITY_MISSING" | "DOMAIN_REPAIR_REQUIRED" | "DOMAIN_REPAIR_NOT_REQUIRED" | "DOMAIN_RECOVERY_HANDOFF_REQUIRED" | "SCHEMA_STATE_INVALID"
	| "UNAVAILABLE_STORAGE_BUSY" | "INTERNAL_UNEXPECTED" | "INTERNAL_EFFECT_OUTCOME_UNKNOWN" | "INTERNAL_EFFECT_NOT_OBSERVED" | WireCauseCode
export type CauseCode = EngineCauseCode
export const CAUSE: Readonly<Record<WireCauseCode, FailureClass | null>> = Object.fromEntries(Object.entries(CAUSE_RULES).map(([code, rule]) => [code, rule.failureClass])) as Readonly<Record<WireCauseCode, FailureClass | null>>

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
declare const ingressBrand: unique symbol
export type ResourceId = string & { readonly [ingressBrand]: "ResourceId" }
export type Authorization = string & { readonly [ingressBrand]: "Authorization" }
export function parseResourceId(input: unknown): ResourceId | null { return typeof input === "string" && input.trim().length > 0 ? input as ResourceId : null }
export function mintAuthorization(input: unknown): Authorization | null { return input === "fixture-authority" ? input as Authorization : null }

const CLI_OPTIONS = {
	json: { type: "boolean", valueName: null, summary: "Emit one machine-readable 2.0 envelope" },
	help: { type: "boolean", valueName: null, summary: "Show help" },
	discover: { type: "boolean", valueName: null, summary: "Show command and contract discovery" },
	"discover-command": { type: "string", valueName: "canonical-command-identity", summary: "Describe the possible outcomes of one selected command" },
	state: { type: "string", valueName: "path", summary: "Select a fixture-local state path" },
	preview: { type: "boolean", valueName: null, summary: "Create a preview" },
	apply: { type: "boolean", valueName: null, summary: "Apply a repair preview" },
	"preview-id": { type: "string", valueName: "id", summary: "Select a preview identity" },
	authorize: { type: "string", valueName: "authority", summary: "Supply fixture-local authority" },
	"retry-once": { type: "boolean", valueName: null, summary: "Permit one bounded transient retry" },
	automation: { type: "boolean", valueName: null, summary: "Declare unattended invocation" },
	"include-diagnostics": { type: "boolean", valueName: null, summary: "Include redacted diagnostic fields" },
} as const satisfies Record<string, ParseArgsOptionsConfig[string] & { valueName: string | null; summary: string }>
export type OptionName = keyof typeof CLI_OPTIONS
// Object.fromEntries erases literal keys; this projection preserves each declaration's parser type.
const PARSER_OPTIONS = Object.fromEntries(Object.entries(CLI_OPTIONS).map(([name, { type }]) => [name, { type }])) as { [Name in OptionName]: Pick<(typeof CLI_OPTIONS)[Name], "type"> }
export const PARSE_ARGS_CONFIG = { options: PARSER_OPTIONS, strict: true, allowPositionals: true } as const satisfies ParseArgsConfig

interface RouteShape {
	route: string
	word: string
	allowedOptions: readonly OptionName[]
	requiredOptions: readonly OptionName[]
}
interface CommandShape {
	commandIdentity: `repair-lab.${string}`
	route: readonly string[]
	summary: string
	effectClass: EffectClass
	routes: readonly RouteShape[]
}
function defineCommands<const Commands extends readonly CommandShape[]>(commands: Commands): Commands { return commands }

const COMMAND_DECLARATIONS = defineCommands([
	{ commandIdentity: "repair-lab.dispatch", route: [], effectClass: "inspect", summary: "Refuse missing or incompatible command selection", routes: [{ route: "dispatch", word: "dispatch", allowedOptions: ["json"], requiredOptions: [] }] },
	{ commandIdentity: "repair-lab.help", route: ["--help"], effectClass: "inspect", summary: "Show help and usage", routes: [{ route: "help", word: "help", allowedOptions: ["help", "json"], requiredOptions: ["help"] }] },
	{ commandIdentity: "repair-lab.discovery", route: ["--discover"], effectClass: "inspect", summary: "Describe commands and the contract", routes: [{ route: "discover", word: "discovery", allowedOptions: ["discover", "json"], requiredOptions: ["discover"] }] },
	// B1 (CDS-BC-1): the accepted C0 selected-command discovery built-in; the selector is an option value, never a positional.
	{ commandIdentity: "repair-lab.command-discovery", route: ["--discover-command"], effectClass: "inspect", summary: "Describe the possible outcomes of one selected command", routes: [{ route: "command-discovery", word: "command-discovery", allowedOptions: ["discover-command", "json"], requiredOptions: ["discover-command"] }] },
	{ commandIdentity: "repair-lab.status", route: ["status"], effectClass: "inspect", summary: "Report the resource status", routes: [{ route: "status", word: "status", allowedOptions: ["json"], requiredOptions: [] }] },
	{ commandIdentity: "repair-lab.inspect", route: ["inspect"], effectClass: "inspect", summary: "Inspect the resource and preview readiness", routes: [{ route: "inspect", word: "inspect", allowedOptions: ["json", "state"], requiredOptions: [] }] },
	{ commandIdentity: "repair-lab.inspect-diagnostics", route: ["inspect", "--include-diagnostics"], effectClass: "inspect", summary: "Inspect with redacted diagnostic fields", routes: [{ route: "inspect-diagnostics", word: "inspect", allowedOptions: ["json", "state", "include-diagnostics"], requiredOptions: ["include-diagnostics"] }] },
	{ commandIdentity: "repair-lab.preview", route: ["apply", "--preview"], effectClass: "repository-local", summary: "Write an apply preview without mutating domain state", routes: [{ route: "preview", word: "apply", allowedOptions: ["json", "preview"], requiredOptions: ["preview"] }] },
	{ commandIdentity: "repair-lab.apply", route: ["apply"], effectClass: "repository-local", summary: "Apply a fresh preview with fixture-local authority", routes: [{ route: "apply", word: "apply", allowedOptions: ["json", "preview-id", "authorize", "automation"], requiredOptions: [] }] },
	{ commandIdentity: "repair-lab.repair", route: ["repair"], effectClass: "repository-local", summary: "Preview or apply a repair of the derived index", routes: [
		{ route: "repair-preview", word: "repair", allowedOptions: ["json", "preview"], requiredOptions: ["preview"] },
		{ route: "repair", word: "repair", allowedOptions: ["json", "apply", "preview-id", "authorize", "automation"], requiredOptions: ["apply"] },
	] },
	{ commandIdentity: "repair-lab.repair-retry", route: ["repair", "--retry-once"], effectClass: "repository-local", summary: "Apply a repair with one bounded transient retry", routes: [{ route: "repair-retry", word: "repair", allowedOptions: ["json", "apply", "retry-once", "authorize", "automation"], requiredOptions: ["apply", "retry-once"] }] },
	{ commandIdentity: "repair-lab.recover", route: ["recover"], effectClass: "repository-local", summary: "Read the journal and resource to report recovery state", routes: [{ route: "recover", word: "recover", allowedOptions: ["json"], requiredOptions: [] }] },
])

export type CommandIdentity = (typeof COMMAND_DECLARATIONS)[number]["commandIdentity"]
export type CliRoute = (typeof COMMAND_DECLARATIONS)[number]["routes"][number]["route"]
export type CommandRoute = Exclude<CliRoute, "dispatch" | "help" | "discover" | "command-discovery">
export type CommandSummary = { readonly commandIdentity: CommandIdentity; readonly route: readonly string[]; readonly summary: string; readonly effectClass: (typeof COMMAND_DECLARATIONS)[number]["effectClass"] }
export interface RouteDeclaration { identity: CommandIdentity; effectClass: CommandSummary["effectClass"]; route: CliRoute; word: string; allowedOptions: readonly OptionName[]; requiredOptions: readonly OptionName[] }
export type OptionSummary = { readonly name: string; readonly valueName: string | null; readonly summary: string }
export type HelpData = { readonly usage: string; readonly summary: string; readonly commands: readonly CommandSummary[]; readonly options: readonly OptionSummary[] }
export type DiscoveryData = {
	readonly contractVersion: "2.0.0"
	readonly generationConventionVersion: "2.0.0"
	readonly profile: "complex"
	readonly commands: readonly CommandSummary[]
	readonly exitMeanings: typeof EXIT_MEANINGS
	readonly signalExits: { readonly "130": "SIGINT"; readonly "143": "SIGTERM" }
	readonly effectExclusions: readonly string[]
}

export const COMMANDS: readonly CommandSummary[] = COMMAND_DECLARATIONS.map(({ routes: _routes, ...command }) => command)
const ROUTES: readonly RouteDeclaration[] = COMMAND_DECLARATIONS.flatMap((command) => command.routes.map((route) => ({ identity: command.commandIdentity, effectClass: command.effectClass, ...route })))
export function declarationForRoute(route: CliRoute): RouteDeclaration {
	const declaration = ROUTES.find((candidate) => candidate.route === route)
	if (declaration === undefined) throw new Error(`undeclared CLI route: ${route}`)
	return declaration
}
export function declarationForIdentity(identity: CommandIdentity): CommandSummary {
	const declaration = COMMANDS.find((candidate) => candidate.commandIdentity === identity)
	if (declaration === undefined) throw new Error(`undeclared CLI identity: ${identity}`)
	return declaration
}
const COMMAND_IDENTITIES = COMMAND_DECLARATIONS.map((command) => command.commandIdentity) as [CommandIdentity, ...CommandIdentity[]]
const OPTIONS: readonly OptionSummary[] = Object.entries(CLI_OPTIONS).map(([name, { valueName, summary }]) => ({ name: `--${name}`, valueName, summary }))
export const HELP_DATA: HelpData = { usage: "repair-lab <command> [options] [--json]", summary: "Inspect, preview, apply and repair a fixture-local resource with journal-backed recovery", commands: COMMANDS, options: OPTIONS }
export const HELP_PATH = "repair-lab --help"
export const DISCOVER_PATH = "repair-lab --discover --json"
export const INSPECT_ACTION = "repair-lab inspect"
export function discovery(): DiscoveryData { return { contractVersion: CONTRACT_VERSION, generationConventionVersion: "2.0.0", profile: "complex", commands: COMMANDS, exitMeanings: EXIT_MEANINGS, signalExits: { "130": "SIGINT", "143": "SIGTERM" }, effectExclusions: ["diagnostic file and journal maintenance"] } }

const nonempty = z.string().trim().min(1)
const safeInteger = z.number().int().nonnegative().safe()
const positiveInteger = z.number().int().positive().safe()
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]))
const effectsSchema = z.strictObject({ completed: z.array(nonempty), remaining: z.array(nonempty), uncertain: z.array(nonempty), inventoryComplete: z.boolean() })
const emptyEffectsSchema = z.strictObject({ completed: z.tuple([]), remaining: z.tuple([]), uncertain: z.tuple([]), inventoryComplete: z.literal(true) })
const completedEffectsSchema = z.strictObject({ completed: z.tuple([nonempty]).rest(nonempty), remaining: z.tuple([]), uncertain: z.tuple([]), inventoryComplete: z.literal(true) })
const partialEffectsSchema = z.strictObject({ completed: z.tuple([nonempty]).rest(nonempty), remaining: z.tuple([nonempty]).rest(nonempty), uncertain: z.tuple([]), inventoryComplete: z.literal(true) })
export type HandoffHead = { readonly owner: "human" | "operator"; readonly reason: string; readonly inspect: readonly string[] }
export type Handoff = (HandoffHead & { readonly resource?: never }) | (HandoffHead & { readonly resource: { readonly kind: string; readonly id: string } })
const handoffHead = { owner: z.enum(["human", "operator"]), reason: nonempty, inspect: z.array(nonempty).min(1) }
const handoffSchema: z.ZodType<Handoff> = z.union([
	z.strictObject(handoffHead),
	z.strictObject({ ...handoffHead, resource: z.strictObject({ kind: nonempty, id: nonempty }) }),
])
const availableDiagnostics = z.strictObject({ status: z.literal("available"), file: z.string().startsWith("/").nullable(), sinkFailure: z.enum(["capacity", "setup", "write", "flush-timeout", "close"]).nullable(), droppedRecords: safeInteger, unflushedRecords: safeInteger, truncatedRecords: safeInteger, countsComplete: z.boolean(), closed: z.boolean() })
const trustedDiagnostics = z.strictObject({ file: z.string().startsWith("/").nullable().optional(), sinkFailure: z.enum(["capacity", "setup", "write", "flush-timeout", "close"]).nullable().optional(), droppedRecords: safeInteger.optional(), unflushedRecords: safeInteger.optional(), truncatedRecords: safeInteger.optional(), countsComplete: z.boolean().optional(), closed: z.boolean().optional() })
const diagnosticsSchema = z.union([availableDiagnostics, z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["status-invalid", "status-unavailable"]), trusted: trustedDiagnostics })])
export type Diagnostics = z.infer<typeof diagnosticsSchema>

const baseShape = { runId: nonempty, commandIdentity: z.enum(COMMAND_IDENTITIES), idempotencyKey: nonempty.optional() }
const nextShape = { nextAction: nonempty, handoff: z.never().optional() }
const handoffShape = { handoff: handoffSchema, nextAction: z.never().optional() }
const successShape = { outcome: z.literal("success"), failureClass: z.null(), exitCode: z.literal(0), data: jsonSchema, retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), repairAction: z.null(), ...nextShape }
const refusalShape = { outcome: z.literal("refused"), transactionState: z.literal("unchanged"), data: z.null(), repairAction: nonempty, effects: effectsSchema, attemptedEffect: z.never().optional() }
const failedShape = { outcome: z.literal("failed"), data: z.null(), repairAction: nonempty, attemptedEffect: nonempty.optional() }

const resultSchema = z.union([
	z.strictObject({ ...baseShape, ...successShape, effectClass: z.literal("inspect"), transactionState: z.literal("unchanged"), causeCode: z.literal("SUCCESS_UNCHANGED"), effects: emptyEffectsSchema }),
	z.strictObject({ ...baseShape, ...successShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("unchanged"), causeCode: z.literal("SUCCESS_UNCHANGED"), effects: effectsSchema }),
	z.strictObject({ ...baseShape, ...successShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("completed"), causeCode: z.literal("SUCCESS_COMPLETED"), effects: completedEffectsSchema }),
	z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, effectClass: z.enum(["inspect", "repository-local", "external"]), causeCode: z.enum(["USAGE_INVALID_INVOCATION", "USAGE_UNKNOWN_COMMAND"]), failureClass: z.literal("usage"), exitCode: z.literal(2), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional() }),
	z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, effectClass: z.enum(["inspect", "repository-local", "external"]), causeCode: z.enum(["SCHEMA_INVALID_INPUT", "SCHEMA_UNSUPPORTED_CONTRACT"]), failureClass: z.literal("schema"), exitCode: z.literal(4), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional() }),
	z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, effectClass: z.enum(["inspect", "repository-local", "external"]), causeCode: z.enum(["DOMAIN_PRECONDITION_UNMET", "DOMAIN_DEADLINE_BEFORE_START", "DOMAIN_JOURNAL_LIMIT_REACHED"]), failureClass: z.literal("domain"), exitCode: z.literal(3), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional() }),
	z.strictObject({ ...baseShape, ...refusalShape, ...handoffShape, effectClass: z.enum(["inspect", "repository-local", "external"]), causeCode: z.enum(causesWhere({ failureClass: "domain", outcome: "refused", transactionState: "unchanged", retryable: false, guidance: "handoff" })), failureClass: z.literal("domain"), exitCode: z.literal(3), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional() }),
	z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, effectClass: z.enum(["inspect", "repository-local", "external"]), causeCode: z.literal("INTERNAL_PREPARATION"), failureClass: z.literal("internal"), exitCode: z.literal(1), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional() }),
	z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, effectClass: z.enum(["repository-local", "external"]), causeCode: z.literal("TRANSIENT_NOT_STARTED"), failureClass: z.literal("transient"), exitCode: z.literal(75), retryable: z.literal(true), retryDelayMilliseconds: positiveInteger }),
	z.strictObject({ ...baseShape, ...failedShape, ...nextShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("unchanged"), causeCode: z.literal("TRANSIENT_ATTEMPT_UNCHANGED"), failureClass: z.literal("transient"), exitCode: z.literal(75), retryable: z.literal(true), retryDelayMilliseconds: positiveInteger, effects: effectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...nextShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("unchanged"), causeCode: z.literal("DOMAIN_DEADLINE_UNCHANGED"), failureClass: z.literal("domain"), exitCode: z.literal(3), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: effectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["inspect", "repository-local", "external"]), transactionState: z.literal("unchanged"), causeCode: z.enum(["INTERNAL_RESULT_UNCHANGED", "INTERNAL_UNEXPECTED"]), failureClass: z.literal("internal"), exitCode: z.literal(1), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: effectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("completed"), causeCode: z.literal("DOMAIN_DEADLINE_COMPLETED"), failureClass: z.literal("domain"), exitCode: z.literal(3), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: completedEffectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("completed"), causeCode: z.literal("INTERNAL_RESULT_COMPLETED"), failureClass: z.literal("internal"), exitCode: z.literal(1), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: completedEffectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("partially-completed"), causeCode: z.enum(["DOMAIN_DEADLINE_PARTIAL", "DOMAIN_RECOVERY_PARTIAL_HANDOFF"]), failureClass: z.literal("domain"), exitCode: z.literal(3), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: partialEffectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("partially-completed"), causeCode: z.literal("INTERNAL_RESULT_PARTIAL"), failureClass: z.literal("internal"), exitCode: z.literal(1), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: partialEffectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("unknown"), causeCode: z.enum(["INTERNAL_RESULT_UNKNOWN", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "INTERNAL_EFFECT_NOT_OBSERVED"]), failureClass: z.literal("internal"), exitCode: z.literal(1), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: effectsSchema }),
	z.strictObject({ ...baseShape, ...failedShape, ...handoffShape, effectClass: z.enum(["repository-local", "external"]), transactionState: z.literal("unknown"), causeCode: z.enum(["DOMAIN_DEADLINE_UNKNOWN", "DOMAIN_RECOVERY_HANDOFF_REQUIRED"]), failureClass: z.literal("domain"), exitCode: z.literal(3), retryable: z.literal(false), retryDelayMilliseconds: z.never().optional(), effects: effectsSchema }),
]).superRefine((result, context) => {
	const collections = [result.effects.completed, result.effects.remaining, result.effects.uncertain]
	const all = collections.flat()
	if (!collections.every(sortedUnique) || new Set(all).size !== all.length) context.addIssue({ code: "custom", message: "effects must be sorted, unique, and disjoint" })
	if (!validStateEffects(result)) context.addIssue({ code: "custom", message: "transaction effects disagree" })
	if (result.effectClass === "inspect" && (result.transactionState !== "unchanged" || !result.effects.inventoryComplete || all.length !== 0)) context.addIssue({ code: "custom", message: "inspect results are unchanged with an empty complete inventory" })
	if (result.outcome === "success" && result.effects.remaining.length !== 0) context.addIssue({ code: "custom", message: "success cannot have remaining effects" })
	if ("attemptedEffect" in result && result.attemptedEffect !== undefined && !all.includes(result.attemptedEffect)) context.addIssue({ code: "custom", message: "attempted effect must be observed" })
})
export type ContractResult = z.infer<typeof resultSchema>
export type Effects = ContractResult["effects"]
export type WireResult = { readonly runId: string; readonly commandIdentity: CommandIdentity; readonly outcome: Outcome; readonly effectClass: "inspect" | "repository-local" | "external"; readonly transactionState: WireTransactionState; readonly causeCode: WireCauseCode; readonly failureClass: FailureClass | null; readonly exitCode: ExitCode; readonly data: JsonValue; readonly retryable: boolean; readonly retryDelayMilliseconds?: number | undefined; readonly repairAction: string | null; readonly effects: Effects; readonly nextAction?: string | undefined; readonly handoff?: Handoff | undefined; readonly idempotencyKey?: string | undefined; readonly attemptedEffect?: string | undefined }

function sortedUnique(values: readonly string[]): boolean { return new Set(values).size === values.length && values.every((value, index) => index === 0 || (values.at(index - 1) ?? "") < value) }
function validStateEffects(result: { transactionState: WireTransactionState; effects: Effects }): boolean {
	const { effects } = result
	switch (result.transactionState) {
		case "unchanged": return effects.inventoryComplete && effects.completed.length === 0 && effects.uncertain.length === 0
		case "completed": return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length === 0 && effects.uncertain.length === 0
		case "partially-completed": return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length > 0 && effects.uncertain.length === 0
		case "unknown": return !effects.inventoryComplete || effects.uncertain.length > 0
	}
}

export const MachineEnvelopeSchema = z.strictObject({
	envelopeVersion: z.literal(2),
	contractVersion: z.literal("2.0.0"),
	message: nonempty,
	availablePaths: z.array(nonempty).superRefine((paths, context) => {
		if (!sortedUnique(paths) || !paths.every((path) => COMMANDS.some((command) => command.commandIdentity === path))) context.addIssue({ code: "custom", message: "paths must be canonical, sorted, and unique" })
	}),
	result: resultSchema,
	diagnostics: diagnosticsSchema.optional(),
})
export type EnvelopeV2 = z.infer<typeof MachineEnvelopeSchema>

export function parseMachineEnvelope(input: unknown): { ok: true; value: EnvelopeV2 } | { ok: false; issues: string[] } {
	const parsed = MachineEnvelopeSchema.safeParse(input)
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) }
}
export function exitFor(failureClass: FailureClass | null): ExitCode { return EXIT[failureClass ?? "success"] }
export function isSafeJson(input: unknown, maximumDepth = 64): input is JsonValue {
	const seen = new Set<object>()
	const visit = (value: unknown, depth: number): boolean => {
		if (depth > maximumDepth) return false
		if (value === null || typeof value === "string" || typeof value === "boolean") return true
		if (typeof value === "number") return Number.isFinite(value)
		if (typeof value !== "object" || value instanceof Date || seen.has(value)) return false
		seen.add(value)
		const valid = Array.isArray(value) ? value.every((item) => visit(item, depth + 1)) : Object.getPrototypeOf(value) === Object.prototype && Object.values(value as Record<string, unknown>).every((item) => visit(item, depth + 1))
		seen.delete(value)
		return valid
	}
	return visit(input, 0)
}

export type StationGuidance = "next-action" | "handoff"
export interface StationRow { commandIdentity: CommandIdentity; outcome: Outcome; causeCode: WireCauseCode; effectClass: EffectClass; transactionState: WireTransactionState; retryable: boolean; retryDelayMilliseconds: number | null; guidance: StationGuidance; repairAction: boolean; exit: ExitCode; fixtureLabel: string | null }
// A finite union derived from the one production declaration table (CDS-BC-1 type lock): an unhandled StationId
// switch arm is a compiler error, and no second hand-maintained identity vocabulary exists.
export type StationId = import("./station-rows.ts").DefinedStationId
export const STATIONS: readonly StationRow[] = STATION_ROWS
