// The one owner of the Vault Steward CLI wire contract: command identities, routes and options, the closed Contract
// Core 2.0 cause vocabulary with its exit map, discovery data, and the strict machine envelope schema validated
// immediately before every write (CONTRACT.md 3.1 to 3.6; contract-core.md).
import type { ParseArgsConfig, ParseArgsOptionsConfig } from "node:util"
import { z } from "zod"
import { STATION_ROWS } from "./station-rows.ts"

export const CONTRACT_VERSION = "2.0.0" as const
export const ENVELOPE_VERSION = 2 as const
export const EXIT = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, transient: 75 } as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
export type FailureClass = Exclude<keyof typeof EXIT, "success">
export const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" } as const
export const RETRY_DELAY_MS = 2_000

export type Outcome = "success" | "refused" | "failed"
export type WireTransactionState = "unchanged" | "completed" | "partially-completed" | "unknown"
export type EffectClass = "inspect" | "repository-local"
type GuidanceArm = "next" | "handoff"
const cause = <C extends FailureClass | null, O extends Outcome, S extends WireTransactionState, R extends boolean, G extends GuidanceArm>(failureClass: C, outcome: O, transactionState: S, retryable: R, guidance: G) =>
	({ failureClass, outcome, transactionState, retryable, guidance }) as const

// The closed wire vocabulary: the Contract Core 2.0 core rows every 2.0 CLI shares plus the Vault Steward product
// causes of CONTRACT.md 3.3, each under its class prefix with the row it implies (Stage Manager decision on
// REPORT-2B deviation 1: agents match on causeCode, never on message text). The strict checker accepts the product
// rows through its additive CAUSE_RULES extension in packages/cli-design-check.
const CAUSE_RULES = {
	SUCCESS_UNCHANGED: cause(null, "success", "unchanged", false, "next"),
	SUCCESS_COMPLETED: cause(null, "success", "completed", false, "next"),
	USAGE_INVALID_INVOCATION: cause("usage", "refused", "unchanged", false, "next"),
	USAGE_UNKNOWN_COMMAND: cause("usage", "refused", "unchanged", false, "next"),
	SCHEMA_INVALID_INPUT: cause("schema", "refused", "unchanged", false, "next"),
	SCHEMA_CONFIG_INVALID: cause("schema", "refused", "unchanged", false, "next"),
	SCHEMA_MANIFEST_INVALID: cause("schema", "refused", "unchanged", false, "handoff"),
	SCHEMA_RECEIPT_INVALID: cause("schema", "refused", "unchanged", false, "handoff"),
	SCHEMA_PREVIEW_INVALID: cause("schema", "refused", "unchanged", false, "handoff"),
	DOMAIN_CONFIG_MISSING: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_VAULT_NOT_FOUND: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANONICAL_NOT_MAIN: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_PATH_REFUSED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANDIDATE_NOT_FOUND: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANDIDATE_INVALID: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_PATH_SET_MISMATCH: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CHECK_FAILED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_FORMAT_FAILED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_GUARD_INCOMPATIBLE: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_CANONICAL_NOT_READY: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_MAIN_DIVERGED: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_SEMANTIC_OVERLAP: cause("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_PREVIEW_NOT_FOUND: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_PREVIEW_CONSUMED: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_PREVIEW_STALE: cause("domain", "refused", "unchanged", false, "next"),
	DOMAIN_REBASE_CONFLICT: cause("domain", "failed", "unchanged", false, "handoff"),
	DOMAIN_REBASED_CHECK_FAILED: cause("domain", "failed", "unchanged", false, "next"),
	DOMAIN_RECOVERY_UNPROVABLE: cause("domain", "refused", "unchanged", false, "handoff"),
	TRANSIENT_INTEGRATION_BUSY: cause("transient", "refused", "unchanged", true, "next"),
	INTERNAL_GIT_FAILED_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_GIT_FAILED_PARTIAL: cause("internal", "failed", "partially-completed", false, "handoff"),
	INTERNAL_GIT_FAILED_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_INTEGRATION_UNPROVED: cause("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_INTEGRATION_UNPROVED_UNCHANGED: cause("internal", "failed", "unchanged", false, "next"),
	INTERNAL_COMPLETION_RECORD_FAILED: cause("internal", "failed", "partially-completed", false, "next"),
	INTERNAL_UNEXPECTED_UNCHANGED: cause("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_UNEXPECTED_UNKNOWN: cause("internal", "failed", "unknown", false, "handoff"),
} as const
export type WireCauseCode = keyof typeof CAUSE_RULES
export type CauseRule = (typeof CAUSE_RULES)[WireCauseCode]
export function causeRule(code: WireCauseCode): CauseRule {
	return CAUSE_RULES[code]
}
export const WIRE_CAUSES = Object.keys(CAUSE_RULES) as readonly WireCauseCode[]
type RuleQuery = { readonly [Field in keyof CauseRule]?: CauseRule[Field] }
// A result-schema row names its cause group by the rule fields, so CAUSE_RULES stays the one owner of which causes share a row.
function causesWhere(query: RuleQuery): [WireCauseCode, ...WireCauseCode[]] {
	const fields = Object.entries(query) as [keyof CauseRule, CauseRule[keyof CauseRule]][]
	const codes = WIRE_CAUSES.filter((code) => fields.every(([field, value]) => CAUSE_RULES[code][field] === value))
	const [first, ...rest] = codes
	if (first === undefined) throw new Error(`no cause matches ${JSON.stringify(query)}`)
	return [first, ...rest]
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

const CLI_OPTIONS = {
	json: { type: "boolean", valueName: null, summary: "Emit one machine-readable 2.0 envelope" },
	help: { type: "boolean", valueName: null, summary: "Show help" },
	discover: { type: "boolean", valueName: null, summary: "Show command and contract discovery" },
	"discover-command": { type: "string", valueName: "identity", summary: "Describe the possible outcomes of one selected command" },
	vault: { type: "string", valueName: "path", summary: "Select the vault checkout (default: the configured vault)" },
	path: { type: "string", multiple: true, valueName: "relative-path", summary: "Admit one vault-relative path (repeatable)" },
	preview: { type: "boolean", valueName: null, summary: "Plan without performing the domain change" },
	apply: { type: "boolean", valueName: null, summary: "Apply an unconsumed finish preview" },
	"preview-id": { type: "string", valueName: "id", summary: "Select the preview to apply" },
	worktree: { type: "string", valueName: "path", summary: "Select the candidate worktree returned by begin" },
	message: { type: "string", valueName: "subject", summary: "Set the one-line commit subject" },
} as const satisfies Record<string, ParseArgsOptionsConfig[string] & { valueName: string | null; summary: string }>
export type OptionName = keyof typeof CLI_OPTIONS
const PARSER_OPTIONS = Object.fromEntries(Object.entries(CLI_OPTIONS).map(([name, option]) => [name, { type: option.type, ...("multiple" in option ? { multiple: option.multiple } : {}) }])) as {
	[Name in OptionName]: Pick<(typeof CLI_OPTIONS)[Name], "type"> & ((typeof CLI_OPTIONS)[Name] extends { multiple: true } ? { multiple: true } : object)
}
export const PARSE_ARGS_CONFIG = { options: PARSER_OPTIONS, strict: true, allowPositionals: true } as const satisfies ParseArgsConfig

interface RouteShape {
	route: string
	word: string
	allowedOptions: readonly OptionName[]
	requiredOptions: readonly OptionName[]
}
interface CommandShape {
	commandIdentity: `vault-steward.${string}`
	route: readonly string[]
	summary: string
	effectClass: EffectClass
	routes: readonly RouteShape[]
}
function defineCommands<const Commands extends readonly CommandShape[]>(commands: Commands): Commands {
	return commands
}

// CLI-BRIEF.md section 1: the nine identities and nothing more.
const COMMAND_DECLARATIONS = defineCommands([
	{ commandIdentity: "vault-steward.dispatch", route: [], effectClass: "inspect", summary: "Refuse a missing, unknown, or incompatible command selection", routes: [{ route: "dispatch", word: "dispatch", allowedOptions: ["json"], requiredOptions: [] }] },
	{ commandIdentity: "vault-steward.help", route: ["--help"], effectClass: "inspect", summary: "Show help and usage", routes: [{ route: "help", word: "help", allowedOptions: ["help", "json"], requiredOptions: ["help"] }] },
	{ commandIdentity: "vault-steward.discovery", route: ["--discover"], effectClass: "inspect", summary: "Describe the commands and the contract", routes: [{ route: "discover", word: "discovery", allowedOptions: ["discover", "json"], requiredOptions: ["discover"] }] },
	{ commandIdentity: "vault-steward.command-discovery", route: ["--discover-command"], effectClass: "inspect", summary: "Describe the possible outcomes of one selected command", routes: [{ route: "command-discovery", word: "command-discovery", allowedOptions: ["discover-command", "json"], requiredOptions: ["discover-command"] }] },
	{ commandIdentity: "vault-steward.begin", route: ["begin"], effectClass: "repository-local", summary: "Create a detached candidate worktree for the admitted paths", routes: [{ route: "begin", word: "begin", allowedOptions: ["json", "vault", "path", "preview"], requiredOptions: ["path"] }] },
	{ commandIdentity: "vault-steward.finish-preview", route: ["finish", "--preview"], effectClass: "repository-local", summary: "Validate the candidate, create its commit, and record the integration plan", routes: [{ route: "finish-preview", word: "finish", allowedOptions: ["json", "preview", "worktree", "message"], requiredOptions: ["preview", "worktree", "message"] }] },
	{ commandIdentity: "vault-steward.finish-apply", route: ["finish", "--apply"], effectClass: "repository-local", summary: "Integrate an unconsumed preview into canonical main under the lock", routes: [{ route: "finish-apply", word: "finish", allowedOptions: ["json", "apply", "preview-id", "worktree"], requiredOptions: ["apply", "preview-id", "worktree"] }] },
	{ commandIdentity: "vault-steward.inspect", route: ["inspect"], effectClass: "inspect", summary: "Report the candidate's recovery state without writing", routes: [{ route: "inspect", word: "inspect", allowedOptions: ["json", "worktree"], requiredOptions: ["worktree"] }] },
	{ commandIdentity: "vault-steward.recover", route: ["recover"], effectClass: "repository-local", summary: "Record completion evidence Git already proves; never replay the fast-forward", routes: [{ route: "recover", word: "recover", allowedOptions: ["json", "worktree"], requiredOptions: ["worktree"] }] },
])

export type CommandIdentity = (typeof COMMAND_DECLARATIONS)[number]["commandIdentity"]
export type CliRoute = (typeof COMMAND_DECLARATIONS)[number]["routes"][number]["route"]
export type CommandRoute = Exclude<CliRoute, "dispatch" | "help" | "discover" | "command-discovery">
export type CommandSummary = { readonly commandIdentity: CommandIdentity; readonly route: readonly string[]; readonly summary: string; readonly effectClass: EffectClass }
export interface RouteDeclaration {
	identity: CommandIdentity
	effectClass: EffectClass
	route: CliRoute
	word: string
	allowedOptions: readonly OptionName[]
	requiredOptions: readonly OptionName[]
}
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
export function isCommandIdentity(value: unknown): value is CommandIdentity {
	return typeof value === "string" && (COMMAND_IDENTITIES as readonly string[]).includes(value)
}
const OPTIONS: readonly OptionSummary[] = Object.entries(CLI_OPTIONS).map(([name, { valueName, summary }]) => ({ name: `--${name}`, valueName, summary }))
export const HELP_DATA: HelpData = {
	usage: "vault-steward <command> [options] [--json]",
	summary: "Commit declared vault notes onto canonical main through a private candidate worktree with checks, one commit, fast-forward integration, and a durable receipt",
	commands: COMMANDS,
	options: OPTIONS,
}
// CONTRACT.md 3.4: permanent effect exclusions published by discovery.
const EFFECT_EXCLUSIONS: readonly string[] = [
	"remote sync (push, fetch, publish)",
	"candidate worktree removal after the receipt",
	"candidate rebase inside the private candidate worktree",
	"diagnostics custody and retention",
	"candidate worktree file edits by the caller",
	"checker-owned side effects inside the candidate",
]
export function discovery(): DiscoveryData {
	return { contractVersion: CONTRACT_VERSION, generationConventionVersion: "2.0.0", profile: "complex", commands: COMMANDS, exitMeanings: EXIT_MEANINGS, signalExits: { "130": "SIGINT", "143": "SIGTERM" }, effectExclusions: EFFECT_EXCLUSIONS }
}

// ---------------------------------------------------------------------------------------------------------------------
// Strict envelope schema

const nonempty = z.string().trim().min(1)
const safeInteger = z.number().int().nonnegative().safe()
const positiveInteger = z.number().int().positive().safe()
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]))
const effectsSchema = z.strictObject({ completed: z.array(nonempty), remaining: z.array(nonempty), uncertain: z.array(nonempty), inventoryComplete: z.boolean() })
export type HandoffHead = { readonly owner: "human" | "operator"; readonly reason: string; readonly inspect: readonly string[] }
export type Handoff = (HandoffHead & { readonly resource?: never }) | (HandoffHead & { readonly resource: { readonly kind: string; readonly id: string } })
const handoffHead = { owner: z.enum(["human", "operator"]), reason: nonempty, inspect: z.array(nonempty).min(1) }
const handoffSchema: z.ZodType<Handoff> = z.union([z.strictObject(handoffHead), z.strictObject({ ...handoffHead, resource: z.strictObject({ kind: nonempty, id: nonempty }) })])
const sinkFailure = z.enum(["capacity", "setup", "write", "flush-timeout", "close"]).nullable()
const availableDiagnostics = z.strictObject({ status: z.literal("available"), file: z.string().startsWith("/").nullable(), sinkFailure, droppedRecords: safeInteger, unflushedRecords: safeInteger, truncatedRecords: safeInteger, countsComplete: z.boolean(), closed: z.boolean() })
const trustedDiagnostics = z.strictObject({ file: z.string().startsWith("/").nullable().optional(), sinkFailure: sinkFailure.optional(), droppedRecords: safeInteger.optional(), unflushedRecords: safeInteger.optional(), truncatedRecords: safeInteger.optional(), countsComplete: z.boolean().optional(), closed: z.boolean().optional() })
const diagnosticsSchema = z.union([availableDiagnostics, z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["status-invalid", "status-unavailable"]), trusted: trustedDiagnostics })])
export type Diagnostics = z.infer<typeof diagnosticsSchema>

const baseShape = { runId: nonempty, commandIdentity: z.enum(COMMAND_IDENTITIES), idempotencyKey: nonempty.optional() }
const nextShape = { nextAction: nonempty, handoff: z.never().optional() }
const handoffShape = { handoff: handoffSchema, nextAction: z.never().optional() }
const noRetry = { retryable: z.literal(false), retryDelayMilliseconds: z.never().optional() }
const successShape = { outcome: z.literal("success"), failureClass: z.null(), exitCode: z.literal(0), data: jsonSchema, ...noRetry, repairAction: z.null(), ...nextShape }
const refusalShape = { outcome: z.literal("refused"), transactionState: z.literal("unchanged"), data: z.null(), repairAction: nonempty, effects: effectsSchema, attemptedEffect: z.never().optional() }

const failedBase = { outcome: z.literal("failed"), data: z.null(), repairAction: nonempty, effects: effectsSchema, attemptedEffect: nonempty.optional(), ...noRetry }
const anyClass = z.enum(["inspect", "repository-local"])
const refusedNext = (failureClass: FailureClass, exitCode: ExitCode) =>
	z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, ...noRetry, effectClass: anyClass, causeCode: z.enum(causesWhere({ failureClass, outcome: "refused", guidance: "next", retryable: false })), failureClass: z.literal(failureClass), exitCode: z.literal(exitCode) })
const refusedHandoff = (failureClass: FailureClass, exitCode: ExitCode) =>
	z.strictObject({ ...baseShape, ...refusalShape, ...handoffShape, ...noRetry, effectClass: anyClass, causeCode: z.enum(causesWhere({ failureClass, outcome: "refused", guidance: "handoff" })), failureClass: z.literal(failureClass), exitCode: z.literal(exitCode) })
const failedRow = (failureClass: FailureClass, exitCode: ExitCode, transactionState: WireTransactionState, guidance: "next" | "handoff") =>
	z.strictObject({ ...baseShape, ...failedBase, ...(guidance === "handoff" ? handoffShape : nextShape), effectClass: anyClass, transactionState: z.literal(transactionState), causeCode: z.enum(causesWhere({ failureClass, outcome: "failed", transactionState, guidance })), failureClass: z.literal(failureClass), exitCode: z.literal(exitCode) })

const resultSchema = z
	.union([
		z.strictObject({ ...baseShape, ...successShape, effectClass: anyClass, transactionState: z.literal("unchanged"), causeCode: z.literal("SUCCESS_UNCHANGED"), effects: effectsSchema }),
		z.strictObject({ ...baseShape, ...successShape, effectClass: z.literal("repository-local"), transactionState: z.literal("completed"), causeCode: z.literal("SUCCESS_COMPLETED"), effects: effectsSchema }),
		refusedNext("usage", 2),
		refusedNext("schema", 4),
		refusedHandoff("schema", 4),
		refusedNext("domain", 3),
		refusedHandoff("domain", 3),
		z.strictObject({ ...baseShape, ...refusalShape, ...nextShape, effectClass: z.literal("repository-local"), causeCode: z.literal("TRANSIENT_INTEGRATION_BUSY"), failureClass: z.literal("transient"), exitCode: z.literal(75), retryable: z.literal(true), retryDelayMilliseconds: positiveInteger }),
		failedRow("domain", 3, "unchanged", "handoff"),
		failedRow("domain", 3, "unchanged", "next"),
		failedRow("internal", 1, "unchanged", "handoff"),
		failedRow("internal", 1, "unchanged", "next"),
		failedRow("internal", 1, "partially-completed", "handoff"),
		failedRow("internal", 1, "partially-completed", "next"),
		failedRow("internal", 1, "unknown", "handoff"),
	])
	.superRefine((result, context) => {
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

export function sortedUnique(values: readonly string[]): boolean {
	return new Set(values).size === values.length && values.every((value, index) => index === 0 || (values.at(index - 1) ?? "") < value)
}
function validStateEffects(result: { transactionState: WireTransactionState; effects: Effects }): boolean {
	const { effects } = result
	switch (result.transactionState) {
		case "unchanged":
			return effects.inventoryComplete && effects.completed.length === 0 && effects.uncertain.length === 0
		case "completed":
			return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length === 0 && effects.uncertain.length === 0
		case "partially-completed":
			return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length > 0 && effects.uncertain.length === 0
		case "unknown":
			return !effects.inventoryComplete || effects.uncertain.length > 0
	}
}

export const MachineEnvelopeSchema = z.strictObject({
	envelopeVersion: z.literal(2),
	contractVersion: z.literal("2.0.0"),
	message: nonempty,
	availablePaths: z.array(nonempty).superRefine((paths, context) => {
		if (!sortedUnique(paths) || !paths.every(isCommandIdentity)) context.addIssue({ code: "custom", message: "paths must be canonical, sorted, and unique" })
	}),
	result: resultSchema,
	diagnostics: diagnosticsSchema.optional(),
})
export type EnvelopeV2 = z.infer<typeof MachineEnvelopeSchema>

export function exitFor(failureClass: FailureClass | null): ExitCode {
	return EXIT[failureClass ?? "success"]
}

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

// One declared Branch Station: the possible outcome tuple of one command with its accepted signature and every
// next-action identity it may emit.
export interface StationRow {
	commandIdentity: CommandIdentity
	outcome: Outcome
	causeCode: WireCauseCode
	effectClass: EffectClass
	transactionState: WireTransactionState
	retryable: boolean
	retryDelayMilliseconds: number | null
	guidance: "next-action" | "handoff"
	exit: ExitCode
	nextActions: readonly string[]
	reachability: "required" | "declared-unreachable"
	unreachableRationale: string | null
}
export type StationId = import("./station-rows.ts").DefinedStationId
export const STATIONS: readonly StationRow[] = STATION_ROWS
