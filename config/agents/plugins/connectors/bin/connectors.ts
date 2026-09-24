#!/usr/bin/env bun
// Compiled Connectors front door. T1 (Ticket #88) shipped a discovery-only
// skeleton. T2 (Ticket #89 under Spec #87) adds the generic manifest-driven
// command core: list, config validate/show, status, doctor, a minimal schema
// reachability seam for keyless connectors, and a fixture-auth seam proving
// packaged auth-adapter extensibility. `bin/provider-route.ts` remains the
// sole owner of the existing per-Skill auth/list/call launcher every Skill's
// SKILL.md still documents; this file never imports it and never branches
// on a connector's name. All connector-specific behavior lives in a
// schema-validated Connector Manifest (bin/manifest.ts) and a packaged
// adapter registry (bin/adapters/index.ts).
import { existsSync } from "node:fs";
import path from "node:path";
import { ADAPTERS, ADAPTER_IDS } from "./adapters/index.ts";
import { discoverManifests, loadOneManifest, loadRequirementsPins, ManifestError, SELECTOR_VALUE_PATTERN, type ConnectorManifest } from "./manifest.ts";
import { safeEnvironment } from "./safe-environment.ts";
import { ensureMcporter, lockRecovery, repairMcporter } from "./mcporter-custody.ts";
import { downloadAndInstallMise, downloadAndInstallOp } from "./setup/download.ts";
import { installPinnedUv, readValidatedUvSources } from "./setup/uv.ts";
import { stateRoot } from "./private-state.ts";

const CONTRACT_VERSION = "2.0.0";
const PROGRAM = "connectors";

const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" } as const;
const SIGNAL_EXITS = { "130": "SIGINT", "143": "SIGTERM" } as const;
// What this binary does not do yet. Keep honest: only list an exclusion
// once it is actually true, and drop it in the Ticket that stops excluding it.
const EFFECT_EXCLUSIONS = [
	"any real credential value or T5 custody access; fixture-auth only presents a nonsecret reference to a fixture-tested authority",
	"any dependency install on ordinary non-setup runs other than first-use MCPorter bootstrap",
	"any provider write operation",
	"deps, real auth, or run (later Tickets own the complete production flows)",
] as const;

// Exported: each appears in the exported Envelope's public signature.
export type EffectClass = "inspect" | "repository-local";
export type Outcome = "success" | "refused" | "failed";
export type FailureClass = "usage" | "internal" | "domain" | "schema" | "transient" | null;
// INTERNAL_UNEXPECTED_UNCHANGED (not the _UNKNOWN cause), because every command
// here is inspect-only and never attempts an effect: assertEnvelope always runs
// before the one stdout write, so a caught internal failure has zero attempted
// effects, never an uncertain one. Matches the existing Contract Core owner's
// own unchanged/unknown split.
export type CauseCode =
	| "SUCCESS_UNCHANGED"
	| "SUCCESS_BOOTSTRAPPED"
	| "SUCCESS_MCPORTER_REPAIRED"
	| "SUCCESS_MCPORTER_RECOVERED"
	| "DOMAIN_MCPORTER_REPAIR_FAILED"
	| "DOMAIN_MCPORTER_REPAIR_FAILED_AFTER_COMMIT"
	| "DOMAIN_MCPORTER_RECOVERED_REPAIR_FAILED"
	| "INTERNAL_MCPORTER_REPAIR_UNKNOWN"
	| "INTERNAL_MCPORTER_SELECTION_UNKNOWN"
	| "SUCCESS_COMPLETED"
	| "DOMAIN_SETUP_FAILED_UNCHANGED"
	| "DOMAIN_SETUP_FAILED_PARTIAL"
	| "SCHEMA_SETUP_CONFIG_INVALID"
	| "USAGE_SETUP_MALFORMED"
	| "INTERNAL_SETUP_UNKNOWN"
	| "INTERNAL_SETUP_AFTER_COMMIT"
	| "USAGE_UNKNOWN_COMMAND"
	| "USAGE_MALFORMED_ARGUMENTS"
	| "USAGE_CONNECTOR_UNKNOWN"
	| "SCHEMA_VERSION_UNSUPPORTED"
	| "SCHEMA_ADAPTER_UNKNOWN"
	| "SCHEMA_SELECTOR_INVALID"
	| "SCHEMA_MANIFEST_INVALID"
	| "SCHEMA_REQUIREMENTS_INVALID"
	| "DOMAIN_CUSTODY_NOT_SUPPORTED"
	| "DOMAIN_ADAPTER_NOT_DECLARED"
	| "DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE"
	| "DOMAIN_FIXTURE_AUTH_REFUSED"
	| "TRANSIENT_PROVIDER_UNREACHABLE"
	| "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP"
	| "TRANSIENT_PROVIDER_AFTER_RECOVERY"
	| "DOMAIN_MCPORTER_REPAIR_REQUIRED"
	| "DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP"
	| "DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY"
	| "INTERNAL_UNEXPECTED_UNCHANGED"
	| "INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP"
	| "INTERNAL_UNEXPECTED_AFTER_REPAIR";

let bootstrapCompleted = false;
let recoveryCompleted = false;
let repairCompleted = false;
let setupStarted = false;
let setupCompleted: string[] = [];

interface CommandDescriptor {
	readonly commandIdentity: string;
	readonly route: readonly string[];
	readonly effectClass: EffectClass;
	readonly summary: string;
}

// This is the complete command surface. Do not add a route here without also
// implementing it, so discovery never advertises a command this binary
// cannot actually answer. setup/deps/auth/run are later Tickets' work and are
// deliberately absent.
const COMMANDS: readonly CommandDescriptor[] = [
	{ commandIdentity: "connectors.dispatch", route: [], effectClass: "inspect", summary: "Refuse a missing, unknown, or incompatible command selection" },
	{ commandIdentity: "connectors.help", route: ["--help"], effectClass: "inspect", summary: "Show help and usage" },
	{ commandIdentity: "connectors.discovery", route: ["--discover", "--json"], effectClass: "inspect", summary: "Describe the commands and the contract" },
	{ commandIdentity: "connectors.list", route: ["list"], effectClass: "inspect", summary: "List connectors declared by a Connector Manifest" },
	{ commandIdentity: "connectors.setup", route: ["setup"], effectClass: "repository-local", summary: "Explicitly install verified op and plugin-owned mise and pinned uv" },
	{ commandIdentity: "connectors.config.validate", route: ["config", "validate"], effectClass: "inspect", summary: "Validate connector manifests, registries, and packaged requirements" },
	{ commandIdentity: "connectors.config.show", route: ["config", "show"], effectClass: "inspect", summary: "Show resolved nonsecret values and provenance; conflicting repeated selectors refuse" },
	{ commandIdentity: "connectors.status", route: ["status"], effectClass: "inspect", summary: "Report truthful evidence state per connector" },
	{ commandIdentity: "connectors.doctor", route: ["doctor"], effectClass: "inspect", summary: "Local readiness gate for one connector" },
	{ commandIdentity: "connectors.schema", route: ["schema"], effectClass: "repository-local", summary: "Fetch keyless schema, bootstrapping the pinned MCPorter on first use" },
	{ commandIdentity: "connectors.deps.repair.mcporter", route: ["deps", "repair", "mcporter"], effectClass: "repository-local", summary: "Explicitly replace the selected MCPorter with a verified official release" },
	{
		commandIdentity: "connectors.fixtureAuth",
		route: ["fixture-auth"],
		effectClass: "inspect",
		summary: "Attempt a packaged, secret-free fixture auth operation for one connector (fixture-tested proof only, never real credential custody)",
	},
];

// Contract Core 2.0 requires sorted, unique availablePaths, independent of
// COMMANDS' own declaration order (which stays readable/logical instead).
const AVAILABLE_PATHS: readonly string[] = [...new Set(COMMANDS.map((command) => command.commandIdentity))].sort();

export interface Envelope {
	readonly envelopeVersion: 2;
	readonly contractVersion: string;
	readonly message: string;
	readonly availablePaths: readonly string[];
	readonly result: {
		readonly runId: string;
		readonly commandIdentity: string;
		readonly outcome: Outcome;
		readonly failureClass: FailureClass;
		readonly exitCode: number;
		readonly data: Record<string, unknown> | null;
		readonly retryable: boolean;
		readonly repairAction: string | null;
		readonly nextAction: string | null;
		readonly effectClass: EffectClass;
		readonly transactionState: "unchanged" | "completed" | "partially-completed" | "unknown";
		readonly causeCode: CauseCode;
		readonly effects: {
			readonly completed: readonly string[];
			readonly remaining: readonly string[];
			readonly uncertain: readonly string[];
			readonly inventoryComplete: boolean;
		};
	};
	readonly diagnostics?: { readonly detail: string };
}

function runId(): string {
	return `run-${crypto.randomUUID()}`;
}

// Cheap, dependency-free contract check on the value we are about to emit.
// Catches a coding mistake before it ships on stdout, per the accepted
// Spec's own rule to validate the complete final envelope immediately
// before serialization. Split into single-purpose checks so each stays
// trivially simple; assertEnvelope only composes their results.

const ENVELOPE_KEYS = ["envelopeVersion", "contractVersion", "message", "availablePaths", "result", "diagnostics"] as const;
const RESULT_KEYS = ["runId", "commandIdentity", "outcome", "failureClass", "exitCode", "data", "retryable", "repairAction", "nextAction", "effectClass", "transactionState", "causeCode", "effects"] as const;
const EFFECTS_KEYS = ["completed", "remaining", "uncertain", "inventoryComplete"] as const;

// Rejects any key this T1 shape does not declare, so a fabricated envelope
// cannot smuggle an extra field (a station-level key like
// retryDelayMilliseconds that belongs to a different Ticket's shape, for
// example) through as if it were part of this one.
function checkExactKeys(value: object, allowed: readonly string[], label: string): string[] {
	const extra = Object.keys(value).filter((key) => !(allowed as readonly string[]).includes(key));
	return extra.length > 0 ? [`${label} has unexpected key(s): ${extra.join(", ")}`] : [];
}

function checkEnvelopeShape(envelope: Envelope): string[] {
	const problems: string[] = [...checkExactKeys(envelope, ENVELOPE_KEYS, "envelope")];
	if (envelope.envelopeVersion !== 2) problems.push("envelopeVersion must be 2");
	if (envelope.contractVersion !== CONTRACT_VERSION) problems.push(`contractVersion must be exactly "${CONTRACT_VERSION}"`);
	if (typeof envelope.message !== "string" || envelope.message.length === 0) problems.push("message must be a non-empty string");
	return problems;
}

// T1's command surface is fixed and closed, so its canonical, already
// sorted/unique/string constant is the one valid value; no separately
// maintained sortedness/uniqueness/type logic can drift from it.
function checkAvailablePaths(paths: unknown): string[] {
	if (JSON.stringify(paths) !== JSON.stringify(AVAILABLE_PATHS)) {
		return ["availablePaths must exactly equal T1's canonical sorted command list"];
	}
	return [];
}

function checkResultIdentity(result: Envelope["result"]): string[] {
	const problems: string[] = [...checkExactKeys(result, RESULT_KEYS, "result")];
	if (typeof result.runId !== "string" || !result.runId.startsWith("run-")) problems.push("result.runId must be a run- prefixed string");
	if (typeof result.commandIdentity !== "string" || !AVAILABLE_PATHS.includes(result.commandIdentity)) {
		problems.push(`result.commandIdentity must name one of T1's admitted commands, not "${result.commandIdentity}"`);
	}
	if (result.outcome !== "success" && result.outcome !== "refused" && result.outcome !== "failed") problems.push("result.outcome must be success, refused, or failed");
	if (typeof result.exitCode !== "number") problems.push("result.exitCode must be a number");
	if (typeof result.nextAction !== "string" || result.nextAction.length === 0) problems.push("result.nextAction must be a non-empty string; T1 has no handoff concept yet");
	else if (!AVAILABLE_PATHS.includes(result.nextAction)) problems.push(`result.nextAction must name one of T1's admitted commands, not "${result.nextAction}"`);
	return problems;
}

// A value that would silently change shape, or throw, across JSON.stringify
// (Contract Core's actual wire format) is not safe to call "the final
// value": `undefined`/function/symbol vanish without a trace, BigInt throws,
// a cycle throws, and a non-finite number serializes as the string "null",
// none of which is the object we just validated. Only plain JSON values are
// admitted: string, boolean, finite number, null, plain array, plain object.
function isJsonSafeValue(value: unknown, seen: WeakSet<object>): boolean {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (type !== "object") return false; // undefined, function, symbol, bigint
	const obj = value as object;
	if (seen.has(obj)) return false; // cycle
	seen.add(obj);
	if (Array.isArray(obj)) return obj.every((item) => isJsonSafeValue(item, seen));
	const proto = Object.getPrototypeOf(obj);
	if (proto !== Object.prototype && proto !== null) return false; // reject class instances, Date, Map, and similar
	return Object.values(obj).every((item) => isJsonSafeValue(item, seen));
}

function checkDataIsJsonSafe(data: Envelope["result"]["data"]): string[] {
	if (data !== null && !isJsonSafeValue(data, new WeakSet())) {
		return ["result.data must be a plain JSON-safe value (no undefined, function, symbol, bigint, non-finite number, cycle, or non-plain object), so the shipped envelope matches what was validated"];
	}
	return [];
}

// The only diagnostics this T1 shape ever emits, so any other shape (an
// extra key, a different detail string) is fabricated, not merely unusual;
// buildInternalFailureEnvelope is the single producer and reuses this exact
// constant, so the two can never independently drift.
const FIXED_INTERNAL_DIAGNOSTIC_DETAIL = "internal contract validation or serialization failed before output";

function checkDiagnostics(diagnostics: Envelope["diagnostics"]): string[] {
	if (diagnostics === undefined) return [];
	const problems = checkExactKeys(diagnostics, ["detail"], "diagnostics");
	if (diagnostics.detail !== FIXED_INTERNAL_DIAGNOSTIC_DETAIL) {
		problems.push("diagnostics.detail must be T1's one fixed, safe string; no other value, dynamic or otherwise, is admitted");
	}
	return problems;
}

interface CauseRow {
	readonly outcome: Outcome;
	readonly effectClass: EffectClass;
	readonly transactionState: Envelope["result"]["transactionState"];
	readonly failureClass: FailureClass;
	readonly exitCode: number;
	readonly retryable: boolean;
	readonly dataRule: "object" | "null";
	readonly repairActionRule: "null" | "nonempty-string";
}

// The complete, closed set of cause codes this binary may ever emit, each
// pinned to every other field a fabricated envelope could otherwise mismatch
// (a "failed" outcome carrying SUCCESS_UNCHANGED, an unchanged
// transactionState carrying a non-empty completed list, and so on). A later
// Ticket that adds a cause code must add its own row here, never widen an
// existing one.
const ADMITTED_CAUSE_ROWS: Readonly<Record<CauseCode, CauseRow>> = {
	SUCCESS_UNCHANGED: { outcome: "success", effectClass: "inspect", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_BOOTSTRAPPED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_MCPORTER_REPAIRED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_MCPORTER_RECOVERED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_MCPORTER_REPAIR_FAILED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_FAILED_AFTER_COMMIT: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_RECOVERED_REPAIR_FAILED: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_MCPORTER_REPAIR_UNKNOWN: { outcome: "failed", effectClass: "repository-local", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_MCPORTER_SELECTION_UNKNOWN: { outcome: "failed", effectClass: "repository-local", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_COMPLETED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_SETUP_FAILED_UNCHANGED: { outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_SETUP_FAILED_PARTIAL: { outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_SETUP_CONFIG_INVALID: { outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_SETUP_MALFORMED: { outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_SETUP_UNKNOWN: { outcome: "failed", effectClass: "repository-local", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_SETUP_AFTER_COMMIT: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_UNKNOWN_COMMAND: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_MALFORMED_ARGUMENTS: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_CONNECTOR_UNKNOWN: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_VERSION_UNSUPPORTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_ADAPTER_UNKNOWN: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_SELECTOR_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_MANIFEST_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_REQUIREMENTS_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_CUSTODY_NOT_SUPPORTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_ADAPTER_NOT_DECLARED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_FIXTURE_AUTH_REFUSED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	TRANSIENT_PROVIDER_UNREACHABLE: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	TRANSIENT_PROVIDER_AFTER_BOOTSTRAP: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	TRANSIENT_PROVIDER_AFTER_RECOVERY: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_REQUIRED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_UNEXPECTED_UNCHANGED: { outcome: "failed", effectClass: "inspect", transactionState: "unchanged", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_UNEXPECTED_AFTER_REPAIR: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
};

// Scalar fields a cause row pins to one exact value; table-driven so this
// stays a flat comparison, not a chain of individual if statements.
function checkCauseRowScalars(result: Envelope["result"], row: CauseRow, cause: string): string[] {
	const comparisons: ReadonlyArray<readonly [unknown, unknown, string]> = [
		[result.outcome, row.outcome, "outcome"],
		[result.effectClass, row.effectClass, "effectClass"],
		[result.transactionState, row.transactionState, "transactionState"],
		[result.failureClass, row.failureClass, "failureClass"],
		[result.exitCode, row.exitCode, "exitCode"],
		[result.retryable, row.retryable, "retryable"],
	];
	return comparisons.filter(([actual, expected]) => actual !== expected).map(([, expected, label]) => `causeCode ${cause} requires ${label} ${JSON.stringify(expected)}`);
}

function checkCauseRowData(result: Envelope["result"], row: CauseRow, cause: string): string[] {
	if (row.dataRule === "object" && (result.data === null || typeof result.data !== "object")) return [`causeCode ${cause} requires result.data to be an object`];
	if (row.dataRule === "null" && result.data !== null) return [`causeCode ${cause} requires result.data to be null`];
	return [];
}

function checkCauseRowRepairAction(result: Envelope["result"], row: CauseRow, cause: string): string[] {
	if (row.repairActionRule === "null" && result.repairAction !== null) return [`causeCode ${cause} requires result.repairAction to be null`];
	if (row.repairActionRule === "nonempty-string" && !(typeof result.repairAction === "string" && result.repairAction.length > 0)) {
		return [`causeCode ${cause} requires a nonempty string result.repairAction`];
	}
	return [];
}

function checkCauseRow(result: Envelope["result"]): string[] {
	const row = ADMITTED_CAUSE_ROWS[result.causeCode as CauseCode];
	if (!row) return [`result.causeCode ${JSON.stringify(result.causeCode)} is not one of T1's admitted cause rows`];
	const cause = result.causeCode;
	const setupCause = cause === "SUCCESS_COMPLETED" || cause === "DOMAIN_SETUP_FAILED_UNCHANGED" || cause === "DOMAIN_SETUP_FAILED_PARTIAL" || cause === "SCHEMA_SETUP_CONFIG_INVALID" || cause === "USAGE_SETUP_MALFORMED" || cause === "INTERNAL_SETUP_UNKNOWN" || cause === "INTERNAL_SETUP_AFTER_COMMIT";
	return [...(setupCause !== (result.commandIdentity === "connectors.setup") ? ["setup cause and command identity must agree"] : []), ...checkCauseRowScalars(result, row, cause), ...checkCauseRowData(result, row, cause), ...checkCauseRowRepairAction(result, row, cause)];
}

// T1 never attempts an effect, so every envelope's effects are vacuously
// empty and fully inventoried; a fabricated "unchanged" state must not be
// able to smuggle a fake completed/remaining/uncertain entry through.
function checkEffectsEmptyAndComplete(effects: Envelope["result"]["effects"]): string[] {
	const problems: string[] = [...checkExactKeys(effects, EFFECTS_KEYS, "result.effects")];
	for (const key of ["completed", "remaining", "uncertain"] as const) {
		if (!Array.isArray(effects[key])) problems.push(`result.effects.${key} must be an array`);
		else if (key === "completed" ? !["[]", '["mcporter-bootstrap"]', '["mcporter-repair"]', '["mcporter-recovery"]', '["mcporter-recovery","mcporter-repair"]'].includes(JSON.stringify(effects[key])) : key === "uncertain" ? !["[]", '["mcporter-repair"]', '["mcporter-recovery"]'].includes(JSON.stringify(effects[key])) : effects[key].length > 0) problems.push(`result.effects.${key} has an undeclared effect`);
	}
	if (effects.inventoryComplete !== true) problems.push("result.effects.inventoryComplete must be true for T1");
	return problems;
}

function checkSetupEffects(result: Envelope["result"]): string[] {
	if (result.commandIdentity !== "connectors.setup") return checkEffectsEmptyAndComplete(result.effects);
	const effects = result.effects;
	const problems = checkExactKeys(effects, EFFECTS_KEYS, "result.effects");
	const expected = ["op", "mise", "uv"];
	if (!Array.isArray(effects.completed) || !Array.isArray(effects.remaining) || !Array.isArray(effects.uncertain)) return [...problems, "setup effect inventories must be arrays"];
	if (effects.inventoryComplete !== true) problems.push("setup effect inventory must be complete");
	if (JSON.stringify([...effects.completed, ...effects.uncertain, ...effects.remaining]) !== JSON.stringify(expected)) problems.push("setup effects must partition op, mise, uv in order");
	if (result.transactionState === "completed" && effects.remaining.length !== 0) problems.push("completed setup has remaining effects");
	if (result.transactionState === "partially-completed" && (effects.completed.length === 0 || effects.remaining.length === 0)) problems.push("partial setup requires completed and remaining effects");
	if (result.transactionState === "unchanged" && effects.completed.length !== 0) problems.push("unchanged setup has completed effects");
	if (result.transactionState !== "unknown" && effects.uncertain.length !== 0) problems.push("known setup result has uncertain effects");
	return problems;
}

export function assertEnvelope(envelope: Envelope): void {
	const problems = [
		...checkEnvelopeShape(envelope),
		...checkAvailablePaths(envelope.availablePaths),
		...checkResultIdentity(envelope.result),
		...checkCauseRow(envelope.result),
		...checkSetupEffects(envelope.result),
		...(envelope.result.transactionState === "completed" && envelope.result.effects.completed.length === 0 ? ["completed dependency effect requires its receipt"] : []),
		...(envelope.result.transactionState === "unchanged" && envelope.result.effects.completed.length > 0 ? ["unchanged result cannot report a completed effect"] : []),
		...(envelope.result.transactionState === "unknown" && envelope.result.effects.uncertain.length !== 1 ? ["unknown repair requires an uncertain effect"] : []),
		...checkDataIsJsonSafe(envelope.result.data),
		...checkDiagnostics(envelope.diagnostics),
	];
	if (problems.length > 0) throw new Error(`internal contract violation: ${problems.join("; ")}`);
}

// Hand-verified, dependency-free fallback for the one path that must never
// itself depend on assertEnvelope succeeding: if envelope construction or
// validation throws before an output attempt, this is what ships. Record
// durable selection effects before envelope construction can fail.
//
// Deliberately takes no detail from the caught exception: `error.message`
// is arbitrary text this front door does not control, and could echo a
// secret-shaped argv value back through a thrown validation message. This
// fallback's `diagnostics.detail` is always the same fixed, safe string.
function completedSelectionEffects(): string[] {
	if (repairCompleted) return recoveryCompleted ? ["mcporter-recovery", "mcporter-repair"] : ["mcporter-repair"];
	if (bootstrapCompleted) return ["mcporter-bootstrap"];
	if (recoveryCompleted) return ["mcporter-recovery"];
	return [];
}

type FailureProgress = Pick<Envelope["result"], "commandIdentity" | "effectClass" | "transactionState" | "causeCode" | "effects">;

function setupFailureProgress(): FailureProgress {
	const committed = setupCompleted.length === SETUP_EFFECTS.length;
	const uncertain = committed ? [] : [SETUP_EFFECTS[setupCompleted.length]!];
	return {
		commandIdentity: "connectors.setup", effectClass: "repository-local",
		transactionState: committed ? "completed" : "unknown",
		causeCode: committed ? "INTERNAL_SETUP_AFTER_COMMIT" : "INTERNAL_SETUP_UNKNOWN",
		effects: { completed: setupCompleted, remaining: SETUP_EFFECTS.slice(setupCompleted.length + uncertain.length), uncertain, inventoryComplete: true },
	};
}

function selectionFailureProgress(): FailureProgress {
	const completed = completedSelectionEffects();
	return {
		commandIdentity: "connectors.dispatch", effectClass: completed.length > 0 ? "repository-local" : "inspect",
		transactionState: completed.length > 0 ? "completed" : "unchanged",
		causeCode: repairCompleted ? "INTERNAL_UNEXPECTED_AFTER_REPAIR" : bootstrapCompleted || recoveryCompleted ? "INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP" : "INTERNAL_UNEXPECTED_UNCHANGED",
		effects: { completed, remaining: [], uncertain: [], inventoryComplete: true },
	};
}

export function buildInternalFailureEnvelope(): Envelope {
	const progress = setupStarted ? setupFailureProgress() : selectionFailureProgress();
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: `${PROGRAM}: internal error`,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			outcome: "failed",
			failureClass: "internal",
			exitCode: 1,
			data: null,
			retryable: false,
			repairAction: "Report this internal error; the requested command was not completed",
			nextAction: "connectors.help",
			...progress,
		},
		diagnostics: { detail: FIXED_INTERNAL_DIAGNOSTIC_DETAIL },
	};
}

// True once a stdout write has actually been attempted. A pre-drain EPIPE
// (the reader closed the pipe) can throw out of that attempt; once this
// flag is set, the top-level handler must not attempt a second, replacement
// write, matching the accepted Spec's "never emit a replacement after a
// partial stream" rule.
let outputStarted = false;

function writeStdout(text: string): void {
	outputStarted = true;
	process.stdout.write(text);
}

// Sets the process exit code and returns without forcing an exit. Calling
// `process.exit()` immediately after a stdout write races Bun's own async
// flush when stdout is a pipe (never a TTY for this front door) and can
// truncate the very envelope callers rely on; letting the event loop drain
// naturally is the only way this proof-required "stdout drain" holds.
function emit(envelope: Envelope): void {
	assertEnvelope(envelope);
	writeStdout(`${JSON.stringify(envelope)}\n`);
	process.exitCode = envelope.result.exitCode;
}

function discover(): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: "Command discovery completed",
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.discovery",
			outcome: "success",
			failureClass: null,
			exitCode: 0,
			data: {
				contractVersion: CONTRACT_VERSION,
				generationConventionVersion: CONTRACT_VERSION,
				profile: "complex",
				commands: COMMANDS,
				exitMeanings: EXIT_MEANINGS,
				signalExits: SIGNAL_EXITS,
				effectExclusions: EFFECT_EXCLUSIONS,
			},
			retryable: false,
			repairAction: null,
			nextAction: "connectors.help",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "SUCCESS_UNCHANGED",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

function helpText(): string {
	return [
		`${PROGRAM}: Connectors plugin front door`,
		"",
		"Commands:",
		"  --discover --json                              Describe the commands and the contract (machine JSON)",
		"  --help                                          Show this human-readable help",
		"  --help --json                                   Show help as a machine Contract Core envelope",
		"  list                                            List connectors declared by a manifest",
		"  setup                                           Install verified op, mise, and pinned uv explicitly",
		"  config validate [connector]                     Validate manifests, registries, and packaged requirements",
		"  config show <connector> --resolved --json       Show resolved nonsecret configuration and provenance",
		"                                                  Repeated --select names must carry identical values",
		"  status [connector]                              Report truthful evidence state",
		"  doctor <connector>                              Local readiness gate for one connector",
		"  schema <connector>                               Fetch live schema evidence for one keyless connector",
		"  deps repair mcporter                             Explicitly replace selected MCPorter after mismatch",
		"",
		"Examples:",
		`  ${PROGRAM} --discover --json`,
		`  ${PROGRAM} list`,
		`  ${PROGRAM} doctor context7`,
		"",
	].join("\n");
}

function helpEnvelope(): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: `${PROGRAM}: run with --discover --json to see available commands`,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.help",
			outcome: "success",
			failureClass: null,
			exitCode: 0,
			data: { usage: `${PROGRAM} --discover --json`, commands: COMMANDS },
			retryable: false,
			repairAction: null,
			nextAction: "connectors.discovery",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "SUCCESS_UNCHANGED",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

function refuse(message: string): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.dispatch",
			outcome: "refused",
			failureClass: "usage",
			exitCode: 2,
			data: null,
			retryable: false,
			repairAction: `Run ${PROGRAM} --discover --json to see available commands`,
			nextAction: "connectors.help",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "USAGE_UNKNOWN_COMMAND",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

// Resolves the real skills/ directory relative to wherever this compiled
// binary currently is, never to Bun's own installation: import.meta.dir
// inside a --compile executable is a virtual embedded path, not the running
// binary's real location, so process.execPath is the only reliable anchor.
// This is also what makes the "same unchanged binary, isolated bundle"
// extensibility proof possible: copying bin/connectors plus a skills/
// directory elsewhere and running that copy resolves against the copy.
function skillsRoot(): string {
	return path.resolve(path.dirname(process.execPath), "..", "skills");
}

// The plugin root sibling of skillsRoot(): where the packaged, nonsecret
// requirements.json (Spec AC24) lives, resolved the same way and for the
// same reason.
function pluginRoot(): string {
	return path.dirname(skillsRoot());
}

function manifestErrorCause(error: ManifestError): CauseCode {
	switch (error.code) {
		case "manifest-missing":
			return "USAGE_CONNECTOR_UNKNOWN";
		case "schema-version-unsupported":
			return "SCHEMA_VERSION_UNSUPPORTED";
		case "adapter-unknown":
			return "SCHEMA_ADAPTER_UNKNOWN";
		case "selector-invalid":
			return "SCHEMA_SELECTOR_INVALID";
		case "requirements-invalid":
			return "SCHEMA_REQUIREMENTS_INVALID";
		default:
			return "SCHEMA_MANIFEST_INVALID";
	}
}

function emitSuccess(commandIdentity: string, message: string, data: Record<string, unknown>, nextAction: string, bootstrapped = false, recovered = false): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity,
			outcome: "success",
			failureClass: null,
			exitCode: 0,
			data,
			retryable: false,
			repairAction: null,
			nextAction,
			effectClass: bootstrapped || recovered ? "repository-local" : "inspect",
			transactionState: bootstrapped || recovered ? "completed" : "unchanged",
			causeCode: bootstrapped ? "SUCCESS_BOOTSTRAPPED" : recovered ? "SUCCESS_MCPORTER_RECOVERED" : "SUCCESS_UNCHANGED",
			effects: { completed: bootstrapped ? ["mcporter-bootstrap"] : recovered ? ["mcporter-recovery"] : [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

// Composes with ADMITTED_CAUSE_ROWS so every call site's outcome, failure
// class, exit code, and retryability come from the one table, never a second
// hand-typed copy that could drift from it.
function emitRefusal(commandIdentity: string, message: string, causeCode: CauseCode, repairAction: string, nextAction: string, bootstrapped = false, recovered = false): void {
	const row = ADMITTED_CAUSE_ROWS[causeCode];
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity,
			outcome: row.outcome,
			failureClass: row.failureClass,
			exitCode: row.exitCode,
			data: null,
			retryable: row.retryable,
			repairAction,
			nextAction,
			effectClass: bootstrapped || recovered ? "repository-local" : "inspect",
			transactionState: bootstrapped || recovered ? "completed" : "unchanged",
			causeCode,
			effects: { completed: bootstrapped ? ["mcporter-bootstrap"] : recovered ? ["mcporter-recovery"] : [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

function usageMalformed(commandIdentity: string, usage: string): void {
	emitRefusal(commandIdentity, `${PROGRAM}: usage: ${usage}`, "USAGE_MALFORMED_ARGUMENTS", `Run ${PROGRAM} ${usage}`, "connectors.list");
}

function repairFailureEffects(effect: string): string[] {
	if (effect === "unknown") return [];
	if (effect === "recovered-and-completed") return ["mcporter-recovery", "mcporter-repair"];
	return [effect === "recovered" ? "mcporter-recovery" : "mcporter-repair"];
}

function repairFailureAction(cause: string, uncertain: boolean): string {
	if (cause === "selection-lock-failed") return lockRecovery;
	return uncertain ? "Inspect the selected MCPorter state before another repair" : "Inspect the selected MCPorter revision before retrying repair";
}

function emitMcporterRepairFailure(result: Extract<Awaited<ReturnType<typeof repairMcporter>>, { ok: false }>): void {
	if (result.effect === "unchanged") {
		emitRefusal("connectors.deps.repair.mcporter", `${PROGRAM}: MCPorter ${result.cause}`, "DOMAIN_MCPORTER_REPAIR_FAILED", "Retry connectors deps repair mcporter after checking local release availability", "connectors.doctor");
		return;
	}
	const uncertain = result.effect === "unknown";
	const recovered = result.effect === "recovered";
	emit({ envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message: `${PROGRAM}: MCPorter ${result.cause}`, availablePaths: AVAILABLE_PATHS,
		result: { runId: runId(), commandIdentity: "connectors.deps.repair.mcporter", outcome: "failed", failureClass: uncertain ? "internal" : "domain",
			exitCode: uncertain ? 1 : 3, data: null, retryable: false,
			repairAction: repairFailureAction(result.cause, uncertain),
			nextAction: "connectors.doctor", effectClass: "repository-local", transactionState: uncertain ? "unknown" : "completed",
			causeCode: uncertain ? "INTERNAL_MCPORTER_REPAIR_UNKNOWN" : recovered ? "DOMAIN_MCPORTER_RECOVERED_REPAIR_FAILED" : "DOMAIN_MCPORTER_REPAIR_FAILED_AFTER_COMMIT",
			effects: { completed: repairFailureEffects(result.effect), remaining: [], uncertain: uncertain ? ["mcporter-repair"] : [], inventoryComplete: true } } });
}

async function handleMcporterRepair(args: readonly string[]): Promise<void> {
	if (args.length !== 0) {
		usageMalformed("connectors.deps.repair.mcporter", "deps repair mcporter");
		return;
	}
	const result = await repairMcporter(process.env);
	if (!result.ok) {
		recoveryCompleted = result.effect === "recovered" || result.effect === "recovered-and-completed";
		repairCompleted = result.effect === "completed" || result.effect === "recovered-and-completed";
		emitMcporterRepairFailure(result);
		return;
	}
	recoveryCompleted = result.recovered;
	repairCompleted = true;
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: "Selected MCPorter repaired from verified official release",
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(), commandIdentity: "connectors.deps.repair.mcporter", outcome: "success", failureClass: null,
			exitCode: 0, data: { version: "0.14.0" }, retryable: false, repairAction: null,
			nextAction: "connectors.schema", effectClass: "repository-local", transactionState: "completed",
			causeCode: "SUCCESS_MCPORTER_REPAIRED",
			effects: { completed: result.recovered ? ["mcporter-recovery", "mcporter-repair"] : ["mcporter-repair"], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

const SETUP_EFFECTS = ["op", "mise", "uv"] as const;

function emitSetup(causeCode: "SUCCESS_COMPLETED" | "DOMAIN_SETUP_FAILED_UNCHANGED" | "DOMAIN_SETUP_FAILED_PARTIAL" | "SCHEMA_SETUP_CONFIG_INVALID" | "USAGE_SETUP_MALFORMED", completed: string[], message: string): void {
	const row = ADMITTED_CAUSE_ROWS[causeCode];
	emit({
		envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message, availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(), commandIdentity: "connectors.setup", outcome: row.outcome, failureClass: row.failureClass,
			exitCode: row.exitCode, data: row.outcome === "success" ? { installed: SETUP_EFFECTS } : null,
			retryable: false, repairAction: row.outcome === "success" ? null : "Inspect the selected plugin-owned setup state, then run connectors setup again",
			nextAction: row.outcome === "success" ? "connectors.status" : "connectors.setup",
			effectClass: "repository-local", transactionState: row.transactionState, causeCode,
			effects: { completed, remaining: SETUP_EFFECTS.slice(completed.length), uncertain: [], inventoryComplete: true },
		},
	});
}

async function handleSetup(args: readonly string[]): Promise<void> {
	if (args.length !== 0) {
		emitSetup("USAGE_SETUP_MALFORMED", [], "connectors: setup takes no arguments");
		return;
	}
	const root = pluginRoot();
	if (!readValidatedUvSources(path.join(root, "requirements.json"), path.join(root, "config", "mise.toml"), path.join(root, "config", "mise.lock"))) {
		emitSetup("SCHEMA_SETUP_CONFIG_INVALID", [], "connectors: packaged setup configuration is invalid");
		return;
	}
	setupStarted = true;
	const completed: string[] = [];
	setupCompleted = completed;
	const source = process.env.CONNECTORS_TEST_RELEASE_ORIGIN ? { localReleaseOrigin: process.env.CONNECTORS_TEST_RELEASE_ORIGIN } : undefined;
	const op = await downloadAndInstallOp(source);
	if (!op.ok) {
		emitSetup("DOMAIN_SETUP_FAILED_UNCHANGED", completed, `connectors: op setup failed: ${op.reason}`);
		return;
	}
	completed.push("op");
	const mise = await downloadAndInstallMise(source);
	if (!mise.ok) {
		emitSetup("DOMAIN_SETUP_FAILED_PARTIAL", completed, `connectors: mise setup failed: ${mise.reason}`);
		return;
	}
	completed.push("mise");
	const uv = await installPinnedUv(mise.executable, path.join(stateRoot(process.env), "connectors", "setup", "uv"), root);
	if (!uv.ok) {
		emitSetup("DOMAIN_SETUP_FAILED_PARTIAL", completed, `connectors: uv setup failed: ${uv.reason}`);
		return;
	}
	completed.push("uv");
	emitSetup("SUCCESS_COMPLETED", completed, "connectors: verified op, mise, and pinned uv installed");
}

function handleList(): void {
	const discovered = discoverManifests(skillsRoot(), ADAPTER_IDS);
	const connectors = discovered
		.filter((entry): entry is typeof entry & { manifest: ConnectorManifest } => entry.manifest !== null)
		.map((entry) => ({ id: entry.manifest.id, adapter: entry.manifest.adapter, keyless: entry.manifest.adapter === null, requirements: entry.manifest.requirements }));
	const problems = discovered.filter((entry) => entry.error !== null).map((entry) => ({ id: entry.id, code: entry.error?.code, message: entry.error?.message }));
	emitSuccess("connectors.list", `${connectors.length} connector(s) declared by a manifest`, { connectors, problems }, "connectors.config.validate");
}

function handleConfigValidate(args: readonly string[]): void {
	if (args.length > 1) {
		usageMalformed("connectors.config.validate", "config validate [connector]");
		return;
	}
	const root = skillsRoot();
	if (args.length === 0) {
		const discovered = discoverManifests(root, ADAPTER_IDS);
		const problem = discovered.find((entry) => entry.error !== null);
		if (problem?.error) {
			emitRefusal(
				"connectors.config.validate",
				`${PROGRAM}: connector ${problem.id} manifest is invalid: ${problem.error.message}`,
				manifestErrorCause(problem.error),
				"Fix the named manifest or registry, then run config validate again",
				"connectors.list",
			);
			return;
		}
		try {
			loadRequirementsPins(pluginRoot());
		} catch (error) {
			if (error instanceof ManifestError) {
				emitRefusal("connectors.config.validate", `${PROGRAM}: packaged requirements are invalid: ${error.message}`, manifestErrorCause(error), "Fix or remove the malformed requirements.json", "connectors.config.validate");
				return;
			}
			throw error;
		}
		emitSuccess("connectors.config.validate", `${discovered.length} connector configuration(s) valid`, { validated: discovered.map((entry) => entry.id) }, "connectors.list");
		return;
	}
	const id = args[0] ?? "";
	try {
		loadOneManifest(root, id, ADAPTER_IDS);
		loadRequirementsPins(pluginRoot());
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal(
				"connectors.config.validate",
				`${PROGRAM}: connector ${id} configuration is invalid: ${error.message}`,
				manifestErrorCause(error),
				"Fix the named manifest, registry, or requirements file, then run config validate again",
				"connectors.list",
			);
			return;
		}
		throw error;
	}
	emitSuccess("connectors.config.validate", `connector ${id} configuration is valid`, { validated: [id] }, "connectors.config.show");
}

interface ResolvedSelectors {
	readonly values: Record<string, { readonly value: string; readonly source: "packaged-manifest-default" | "invocation-selector" }>;
	readonly problem: string | null;
}

interface SelectorResolution {
	readonly value?: { readonly value: string; readonly source: "invocation-selector" | "packaged-manifest-default" };
	readonly problem?: string;
}

function resolveOneSelector(name: string, declaration: ConnectorManifest["selectors"][string], given: ReadonlyMap<string, string>): SelectorResolution {
	const value = given.get(name);
	if (value === undefined) {
		if (declaration.default !== undefined) return { value: { value: declaration.default, source: "packaged-manifest-default" } };
		return declaration.required ? { problem: `selector ${name} is required; pass --select ${name}=<value>` } : {};
	}
	if (SELECTOR_VALUE_PATTERN.exec(value)?.[0] !== value) return { problem: `selector ${name} must match ${SELECTOR_VALUE_PATTERN.source}` };
	if (declaration.pattern && !new RegExp(declaration.pattern).test(value)) return { problem: `selector ${name} must match ${declaration.pattern}` };
	if (declaration.enum && !declaration.enum.includes(value)) return { problem: `selector ${name} must be one of ${declaration.enum.join(", ")}` };
	return { value: { value, source: "invocation-selector" } };
}

function resolveSelectors(manifest: ConnectorManifest, given: ReadonlyMap<string, string>): ResolvedSelectors {
	const values: ResolvedSelectors["values"] = {};
	for (const [name, declaration] of Object.entries(manifest.selectors)) {
		const resolution = resolveOneSelector(name, declaration, given);
		if (resolution.problem) return { values, problem: resolution.problem };
		if (resolution.value) values[name] = resolution.value;
	}
	for (const name of given.keys()) {
		if (!Object.hasOwn(manifest.selectors, name)) return { values, problem: `connector ${manifest.id} does not declare selector ${name}` };
	}
	return { values, problem: null };
}

interface ParsedConfigShowArgs {
	readonly id: string;
	readonly given: ReadonlyMap<string, string>;
}

// Returns null for any malformed input; the single caller emits the one
// usage refusal, so this stays a pure parser with no envelope side effect.
function consumeSelectToken(rest: readonly string[], index: number, given: Map<string, string>): number | null {
	const value = rest[index + 1];
	const equals = value?.indexOf("=") ?? -1;
	if (!value || equals <= 0) return null;
	const name = value.slice(0, equals);
	const selected = value.slice(equals + 1);
	if (given.has(name) && given.get(name) !== selected) return null;
	given.set(name, selected);
	return index + 1;
}

function parseConfigShowArgs(args: readonly string[]): ParsedConfigShowArgs | null {
	const id = args[0];
	let resolvedFlag = false;
	let jsonFlag = false;
	const given = new Map<string, string>();
	const rest = args.slice(1);
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (token === "--resolved") {
			resolvedFlag = true;
			continue;
		}
		if (token === "--json") {
			jsonFlag = true;
			continue;
		}
		if (token === "--select") {
			const nextIndex = consumeSelectToken(rest, index, given);
			if (nextIndex === null) return null;
			index = nextIndex;
			continue;
		}
		return null;
	}
	if (!id || !resolvedFlag || !jsonFlag) return null;
	return { id, given };
}

function handleConfigShow(args: readonly string[]): void {
	const usage = "config show <connector> --resolved --json [--select name=value ...]";
	const parsedArgs = parseConfigShowArgs(args);
	if (!parsedArgs) {
		usageMalformed("connectors.config.show", usage);
		return;
	}
	const { id, given } = parsedArgs;
	let manifest: ConnectorManifest;
	try {
		manifest = loadOneManifest(skillsRoot(), id, ADAPTER_IDS);
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.config.show", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	const selectors = resolveSelectors(manifest, given);
	if (selectors.problem) {
		emitRefusal("connectors.config.show", `${PROGRAM}: ${selectors.problem}`, "SCHEMA_SELECTOR_INVALID", selectors.problem, "connectors.config.validate");
		return;
	}
	let pins: Readonly<Record<string, string>>;
	try {
		pins = loadRequirementsPins(pluginRoot());
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.config.show", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Fix or remove the malformed requirements.json", "connectors.config.validate");
			return;
		}
		throw error;
	}
	// Dependency version provenance (Spec AC24): a declared requirement pinned
	// in the packaged Requirements Manifest resolves to that accepted version;
	// an unpinned one resolves honestly to "not yet effective", never an
	// invented value. Neither is ever overridable by a selector or setting.
	const dependencies: Record<string, { value: string | null; source: string }> = {};
	for (const name of manifest.requirements) {
		const pinned = pins[name];
		dependencies[`dependency:${name}`] = pinned !== undefined ? { value: pinned, source: "packaged-requirements-pin" } : { value: null, source: "not-yet-effective" };
	}
	// A reference says which nonsecret item was named, not who holds a
	// credential. T5 will add the declared custody mode and its proof.
	const custodyMode = manifest.adapter === null
		? { value: "keyless", source: "packaged-manifest-default" }
		: { value: null, source: "not-yet-effective" };
	const values: Record<string, { value: unknown; source: string }> = {
		connector: { value: manifest.id, source: "invocation" },
		adapter: { value: manifest.adapter ?? "none", source: "packaged-manifest-default" },
		custodyMode,
		transportRegistry: { value: manifest.transportRegistry, source: "packaged-manifest-default" },
		requirements: { value: manifest.requirements, source: "packaged-manifest-default" },
		...dependencies,
		...selectors.values,
	};
	emitSuccess("connectors.config.show", `resolved nonsecret configuration for ${id}`, { connector: id, values }, "connectors.status");
}

// A validated manifest proves only that it is configured (Spec AC21).
// localReady needs a real dependency/route check (MCPorter, op, uv — none
// exist yet) and custodyChecked needs usable custody proof (T5's real
// 1Password/MCPorter custody); neither is ever inferred from manifest
// validity or a packaged adapter's fixture auth attempt (connectors
// fixture-auth is the only command that exercises that attempt), so both
// stay unknown until their owning Ticket lands.
function evidenceFor(): Record<string, unknown> {
	return {
		configured: true,
		localReady: null,
		custodyChecked: null,
		authenticated: false,
		schemaQualified: false,
		liveReadProven: false,
		liveWriteProven: false,
		fixtureTested: null,
	};
}

function handleStatus(args: readonly string[]): void {
	if (args.length > 1) {
		usageMalformed("connectors.status", "status [connector]");
		return;
	}
	try {
		loadRequirementsPins(pluginRoot());
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.status", `${PROGRAM}: packaged requirements are invalid: ${error.message}`, manifestErrorCause(error), "Fix or remove the malformed requirements.json", "connectors.config.validate");
			return;
		}
		throw error;
	}
	const root = skillsRoot();
	if (args.length === 0) {
		const discovered = discoverManifests(root, ADAPTER_IDS);
		const connectors = discovered.filter((entry) => entry.manifest !== null).map((entry) => ({ id: entry.id, evidence: evidenceFor() }));
		const problems = discovered.filter((entry) => entry.error !== null).map((entry) => ({ id: entry.id, code: entry.error?.code, message: entry.error?.message }));
		emitSuccess("connectors.status", `${connectors.length} connector(s) reporting evidence state`, { connectors, problems }, "connectors.doctor");
		return;
	}
	const id = args[0] ?? "";
	try {
		loadOneManifest(root, id, ADAPTER_IDS);
		emitSuccess("connectors.status", `evidence state for ${id}`, { connectors: [{ id, evidence: evidenceFor() }], problems: [] }, "connectors.doctor");
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.status", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
}

// Local readiness gate only (Spec AC21): once a connector's manifest,
// registry, and packaged requirements validate, doctor succeeds. It never
// exercises a connector's adapter — connectors fixture-auth does, so
// doctor's own success can never be mistaken for auth proof.
function handleDoctor(args: readonly string[]): void {
	if (args.length !== 1) {
		usageMalformed("connectors.doctor", "doctor <connector>");
		return;
	}
	const id = args[0] ?? "";
	try {
		loadOneManifest(skillsRoot(), id, ADAPTER_IDS);
		loadRequirementsPins(pluginRoot());
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.doctor", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	emitSuccess("connectors.doctor", `${id} passed its declared local checks`, { connector: id, ...evidenceFor() }, "connectors.status");
}

// The only command that exercises a packaged adapter's auth-shaped
// operation (Spec AC23): the adapter presents the manifest's nonsecret
// reference to an independent fixture authority process and this command
// relays that process's verdict. Fixture-tested only; T5 keeps real
// 1Password/MCPorter custody.
async function handleFixtureAuth(args: readonly string[]): Promise<void> {
	if (args.length !== 1) {
		usageMalformed("connectors.fixtureAuth", "fixture-auth <connector>");
		return;
	}
	const id = args[0] ?? "";
	let manifest: ConnectorManifest;
	try {
		manifest = loadOneManifest(skillsRoot(), id, ADAPTER_IDS);
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.fixtureAuth", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	if (manifest.adapter === null) {
		emitRefusal(
			"connectors.fixtureAuth",
			`${PROGRAM}: ${id} declares no adapter; fixture-auth needs one`,
			"DOMAIN_ADAPTER_NOT_DECLARED",
			"Declare an adapter in the connector manifest, or use a connector that already does",
			"connectors.config.show",
		);
		return;
	}
	// manifest.adapter is already validated against the packaged registry by
	// loadOneManifest/loadManifest, so this lookup can never miss in practice;
	// the optional chain only satisfies the type system's own uncertainty.
	const attempt = await ADAPTERS[manifest.adapter]?.attemptAuth(manifest);
	if (!attempt || attempt.outcome === "refused") {
		const cause: CauseCode = attempt?.cause === "FIXTURE_AUTHORITY_UNAVAILABLE" ? "DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE" : "DOMAIN_FIXTURE_AUTH_REFUSED";
		emitRefusal(
			"connectors.fixtureAuth",
			`${PROGRAM}: ${id} fixture auth was refused: ${attempt?.detail ?? attempt?.cause ?? "unknown"}`,
			cause,
			attempt?.detail ?? "Repair the named defect and retry",
			"connectors.status",
		);
		return;
	}
	emitSuccess("connectors.fixtureAuth", `${id} fixture auth succeeded`, { connector: id, outcome: "success", fixtureTested: true }, "connectors.status");
}

async function handleSchema(args: readonly string[]): Promise<void> {
	if (args.length !== 1) {
		usageMalformed("connectors.schema", "schema <connector>");
		return;
	}
	const id = args[0] ?? "";
	let manifest: ConnectorManifest;
	try {
		manifest = loadOneManifest(skillsRoot(), id, ADAPTER_IDS);
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.schema", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	if (manifest.adapter !== null) {
		emitRefusal(
			"connectors.schema",
			`${PROGRAM}: ${id} needs a declared credential; schema is not yet supported for it`,
			"DOMAIN_CUSTODY_NOT_SUPPORTED",
			"Use doctor to check local readiness; live schema for credentialed connectors is a later Ticket",
			"connectors.doctor",
		);
		return;
	}
	if (!existsSync(manifest.registryPath)) {
		emitRefusal("connectors.schema", `${PROGRAM}: ${id} registry is missing`, "SCHEMA_MANIFEST_INVALID", "Run config validate to see the exact defect", "connectors.config.validate");
		return;
	}
	const registry = JSON.parse(await Bun.file(manifest.registryPath).text()) as { mcpServers?: Record<string, { allowedTools?: readonly string[] }> };
	const server = Object.keys(registry.mcpServers ?? {})[0];
	if (!server) {
		emitRefusal("connectors.schema", `${PROGRAM}: ${id} declares no server`, "SCHEMA_MANIFEST_INVALID", "Fix the registry to declare at least one server", "connectors.config.validate");
		return;
	}
	// Surfaces the already-validated registry's own allow-list, so a caller
	// (and a test) can confirm this reached the connector's real declared
	// tools, not merely an opaque success.
	const allowedTools = registry.mcpServers?.[server]?.allowedTools ?? [];
	await fetchKeylessSchema(id, manifest.registryPath, server, allowedTools);
}

function emitSelectionFailure(selection: Extract<Awaited<ReturnType<typeof ensureMcporter>>, { ok: false }>): void {
	bootstrapCompleted = selection.bootstrapped === true;
	recoveryCompleted = selection.recovered === true;
	if (selection.uncertain) {
		emit({ envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message: `${PROGRAM}: MCPorter recovery outcome requires inspection`, availablePaths: AVAILABLE_PATHS,
			result: { runId: runId(), commandIdentity: "connectors.schema", outcome: "failed", failureClass: "internal", exitCode: 1,
				data: null, retryable: false, repairAction: "Inspect current and previous MCPorter revisions before retrying", nextAction: "connectors.doctor",
				effectClass: "repository-local", transactionState: "unknown", causeCode: "INTERNAL_MCPORTER_SELECTION_UNKNOWN",
				effects: { completed: recoveryCompleted ? ["mcporter-recovery"] : [], remaining: [], uncertain: [recoveryCompleted ? "mcporter-repair" : "mcporter-recovery"], inventoryComplete: true } } });
		return;
	}
	emitRefusal("connectors.schema", `${PROGRAM}: MCPorter ${selection.cause}`, bootstrapCompleted ? "DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP" : recoveryCompleted ? "DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY" : "DOMAIN_MCPORTER_REPAIR_REQUIRED", selection.repair, "connectors.doctor", bootstrapCompleted, recoveryCompleted);
}

async function fetchKeylessSchema(id: string, registryPath: string, server: string, allowedTools: readonly string[]): Promise<void> {
	// Matches bin/provider-route.ts's own guarded MCPorter invocation exactly:
	// a scrubbed environment (only the safe allow-list crosses, plus the
	// keepalive suppression), mcporter resolved only through that same
	// explicit PATH value (never the raw ambient environment/PATH a second,
	// unguarded resolution could pick up), and a forced --no-oauth so this
	// keyless-only command can never fall into an interactive auth prompt.
	const routeEnv: Record<string, string> = { MCPORTER_NO_KEEPALIVE: "*", ...safeEnvironment(process.env) };
	const selection = await ensureMcporter(process.env);
	if (!selection.ok) {
		emitSelectionFailure(selection);
		return;
	}
	bootstrapCompleted = selection.bootstrapped;
	recoveryCompleted = selection.recovered === true;
	const proc = Bun.spawn([selection.binary, "--config", registryPath, "list", server, "--json", "--no-oauth"], { env: routeEnv, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	// Both pipes must drain concurrently: awaiting only stdout+exited while
	// stderr sits unread lets a noisy child fill the OS pipe buffer, block on
	// its own write, and never reach exit. The drained stderr text is
	// deliberately discarded, never echoed into this command's own envelope
	// or stderr.
	const [stdout, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		emitRefusal("connectors.schema", `${PROGRAM}: ${id} schema fetch did not complete`, selection.bootstrapped ? "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP" : recoveryCompleted ? "TRANSIENT_PROVIDER_AFTER_RECOVERY" : "TRANSIENT_PROVIDER_UNREACHABLE", "Retry the schema request", "connectors.doctor", selection.bootstrapped, recoveryCompleted);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = { raw: stdout };
	}
	emitSuccess("connectors.schema", `schema evidence fetched for ${id}`, { connector: id, server, allowedTools, schema: parsed }, "connectors.status", selection.bootstrapped, recoveryCompleted);
}

async function dispatchCommand(args: readonly string[]): Promise<void> {
	if (args[0] === "deps" && args[1] === "repair" && args[2] === "mcporter") {
		await handleMcporterRepair(args.slice(3));
		return;
	}
	if (args[0] === "setup") {
		await handleSetup(args.slice(1));
		return;
	}
	if (args[0] === "list") {
		handleList();
		return;
	}
	if (args[0] === "config" && args[1] === "validate") {
		handleConfigValidate(args.slice(2));
		return;
	}
	if (args[0] === "config" && args[1] === "show") {
		handleConfigShow(args.slice(2));
		return;
	}
	if (args[0] === "status") {
		handleStatus(args.slice(1));
		return;
	}
	if (args[0] === "doctor") {
		handleDoctor(args.slice(1));
		return;
	}
	if (args[0] === "schema") {
		await handleSchema(args.slice(1));
		return;
	}
	if (args[0] === "fixture-auth") {
		await handleFixtureAuth(args.slice(1));
		return;
	}
	// Never echo the caller's raw argv into public output: an argument can
	// carry a secret-shaped value, and machine stdout must stay redacted
	// regardless of what was actually typed. Fixed message only.
	refuse(`${PROGRAM}: unsupported command. Run with --discover --json to see available commands.`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 2 && args[0] === "--discover" && args[1] === "--json") {
		discover();
		return;
	}
	if (args.length === 1 && args[0] === "--help") {
		writeStdout(helpText());
		process.exitCode = 0;
		return;
	}
	if (args.length === 2 && args[0] === "--help" && args[1] === "--json") {
		helpEnvelope();
		return;
	}
	if (args.length === 0) {
		refuse(`${PROGRAM}: no command given. Run with --discover --json to see available commands.`);
		return;
	}
	await dispatchCommand(args);
}

// Guarded so a test can `import` this module (to reach buildInternalFailureEnvelope
// and assertEnvelope directly) without running the CLI against the test runner's
// own argv; Bun sets import.meta.main only for the actual entry invocation.
if (import.meta.main) {
	// A write to a closed reader (the classic pre-drain EPIPE) surfaces as an
	// asynchronous 'error' event on the stream, not a synchronous throw from
	// `.write()` itself; the synchronous try/catch below never sees it. An
	// EventEmitter with no 'error' listener crashes with a raw stack on
	// stderr by default, exactly the forbidden output. Register this before
	// any write is attempted (main() has not run yet), and only for the
	// real entry invocation: importing this module for a unit test must
	// never attach a listener to the test runner's own stdout.
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		// Contract Core permits ending without an envelope on pre-drain
		// EPIPE; never emit a replacement after a partial/failed stream,
		// and never let this reach the runtime's own uncaught-exception
		// reporting. A write that failed did not reliably reach the
		// caller, so exit nonzero regardless of what the in-flight
		// command would otherwise have reported.
		void error;
		process.exitCode = 1;
	});
	// main() is async only because connectors.schema spawns mcporter as a real
	// child process; every other route still resolves synchronously inside it.
	void (async () => {
	try {
		await main();
	} catch {
		process.exitCode = 1;
		if (outputStarted) {
			// A write was already attempted and threw (the classic pre-drain
			// EPIPE: the reader closed the pipe). Contract Core permits ending
			// without an envelope here; stderr stays empty, and attempting a
			// second, replacement write is exactly the forbidden replay after
			// a partial stream.
		} else {
			// Nothing was written yet, so this is a genuine internal failure,
			// not a broken pipe: safe to ship the one bounded fallback
			// envelope. Guard this attempt too, since stdout could still be
			// gone for an unrelated reason; a second failure must never
			// escape to the runtime's own uncaught-exception reporting.
			try {
				const envelope = buildInternalFailureEnvelope();
				writeStdout(`${JSON.stringify(envelope)}\n`);
				process.exitCode = envelope.result.exitCode;
			} catch {
				process.exitCode = 1;
			}
		}
	}
	})();
}
