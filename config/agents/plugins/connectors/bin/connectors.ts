#!/usr/bin/env bun
// Compiled Connectors front door. T1 (Ticket #88) shipped a discovery-only
// skeleton. T2 (Ticket #89 under Spec #87) adds the generic manifest-driven
// command core: list, config validate/show, status, doctor, a minimal schema
// reachability seam for keyless connectors, and a fixture-auth seam proving
// packaged auth-adapter extensibility. T6 (Ticket #93) adds auth and run
// through a packaged adapter's prepare step, and credentialed schema through
// its prepareSchema step. T5 (Ticket #92) adds an adapter execute step for
// multi-call semantics and closed adapter internal roles of this same
// executable. `bin/provider-route.ts` remains the shared route-selection
// owner for direct Skills and adapter-owned Provider plans; this file never
// imports it or branches on a connector's name. Connector-specific behavior
// lives in a schema-validated Connector Manifest (bin/manifest.ts) and a packaged
// adapter registry (bin/adapters/index.ts).
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterAction, AdapterRefusal, AdapterRefusalKind, CustodyResolution, Executed, ExecutionCapabilities, InternalRole, LocalEffect, LoginOption, Prepared, RecordedEffect, Recovery, SchemaRequest, WritePhase } from "./adapters/contract.ts";
import { ADAPTERS, ADAPTER_IDS } from "./adapters/index.ts";
import { type DiscoveredManifest, discoverManifests, loadOneManifest, loadRequirementsPins, ManifestError, SELECTOR_VALUE_PATTERN, type ConnectorManifest } from "./manifest.ts";
import { INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment, validInternalContext } from "./safe-environment.ts";
import { ensureMcporter, lockRecovery, releaseInterruptedSelection } from "./mcporter-custody.ts";
import { type KeylessDataRoot, ownKeylessDataRoot } from "./provider-route.ts";
import { DEPENDENCY_TOOLS, dependencyStatus, isDependencyTool, REQUIREMENTS_REVISION, type DependencyTool } from "./dependency-status.ts";
import { applyDeps, PREVIEW_ID, previewDeps, type ApplyResult, type DepsRequest } from "./deps-repair.ts";
import { downloadAndInstallMise, downloadAndInstallOp } from "./setup/download.ts";
import { installPinnedUv, readValidatedUvSources } from "./setup/uv.ts";
import { stateRoot } from "./private-state.ts";
import { observeEvidence } from "./evidence-state.ts";
import { retainFixtureObservation, retainObservation } from "./evidence-record.ts";

const CONTRACT_VERSION = "2.0.0";
const PROGRAM = "connectors";

const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" } as const;
const SIGNAL_EXITS = { "130": "SIGINT", "143": "SIGTERM" } as const;
// What this binary does not do yet. Keep honest: only list an exclusion
// once it is actually true, and drop it in the Ticket that stops excluding it.
const EFFECT_EXCLUSIONS = [
	"any credential value read by the front-door process; a 1Password-custody credential is read only by this executable started in its adapter's internal custody or Provider role, fixture-auth only presents a nonsecret reference to a fixture-tested authority, and an OAuth grant stays inside MCPorter's per-account vault",
	"any dependency install on ordinary non-setup runs other than first-use MCPorter bootstrap",
	"any provider write without a recorded preview and a durable write receipt, and any retry or replay of a write whose effect is unknown",
	"auth or run for a connector whose packaged adapter has no prepare step, schema for one with no prepareSchema step, run --preview or --apply and recover for one with no write or recovery step, and auth logout for every connector",
] as const;

// The closed auth verb vocabulary (Spec AC19). Each connector's adapter
// decides which verbs it supports; the rest refuse through the catalogue.
const AUTH_VERBS = new Set(["configure", "status", "check", "login", "repair", "logout"]);

// Exported: each appears in the exported Envelope's public signature.
export type EffectClass = "inspect" | "repository-local" | "external";
export type Outcome = "success" | "refused" | "failed";
export type FailureClass = "usage" | "internal" | "domain" | "schema" | "transient" | null;
// A caught internal failure reports INTERNAL_UNEXPECTED_UNCHANGED only when no
// effect was attempted. MCPorter bootstrap or recovery progress, explicit
// setup progress, and explicit deps repair progress select their own
// completed or unknown causes, so the
// fallback never claims an unchanged result after an attempted effect.
export type CauseCode =
	| "SUCCESS_UNCHANGED"
	| "SUCCESS_BOOTSTRAPPED"
	| "SUCCESS_MCPORTER_RECOVERED"
	| "INTERNAL_MCPORTER_SELECTION_UNKNOWN"
	| "SUCCESS_COMPLETED"
	| "DOMAIN_SETUP_FAILED_UNCHANGED"
	| "DOMAIN_SETUP_FAILED_PARTIAL"
	| "SCHEMA_SETUP_CONFIG_INVALID"
	| "USAGE_SETUP_MALFORMED"
	| "INTERNAL_SETUP_UNKNOWN"
	| "INTERNAL_SETUP_AFTER_COMMIT"
	| "SUCCESS_DEPS_REPAIR_PREVIEWED"
	| "SUCCESS_DEPS_REPAIRED"
	| "DOMAIN_DEPS_REPAIR_PREREQUISITE"
	| "DOMAIN_DEPS_STATE_INVALID"
	| "DOMAIN_DEPS_PREVIEW_INVALID"
	| "DOMAIN_DEPS_PREVIEW_STALE"
	| "DOMAIN_DEPS_PREVIEW_CONSUMED"
	| "DOMAIN_DEPS_APPLY_LOCKED"
	| "DOMAIN_DEPS_REPAIR_FAILED_RECORDED"
	| "DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN"
	| "INTERNAL_DEPS_REPAIR_UNKNOWN"
	| "INTERNAL_DEPS_REPAIR_AFTER_EFFECT"
	| "INTERNAL_DEPS_PREVIEW_AFTER_RECORD"
	| "SUCCESS_DEPS_UPDATE_PREVIEWED"
	| "SUCCESS_DEPS_UPDATED"
	| "DOMAIN_DEPS_REVISION_NOT_ADMITTED"
	| "DOMAIN_DEPS_UPDATE_FAILED_RECORDED"
	| "DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN"
	| "INTERNAL_DEPS_UPDATE_UNKNOWN"
	| "INTERNAL_DEPS_UPDATE_PARTIAL"
	| "INTERNAL_DEPS_UPDATE_AFTER_EFFECT"
	| "USAGE_UNKNOWN_COMMAND"
	| "USAGE_MALFORMED_ARGUMENTS"
	| "USAGE_CONNECTOR_UNKNOWN"
	| "USAGE_DEPENDENCY_UNKNOWN"
	| "SCHEMA_VERSION_UNSUPPORTED"
	| "SCHEMA_ADAPTER_UNKNOWN"
	| "SCHEMA_SELECTOR_INVALID"
	| "SCHEMA_MANIFEST_INVALID"
	| "SCHEMA_REQUIREMENTS_INVALID"
	| "DOMAIN_CUSTODY_NOT_SUPPORTED"
	| "DOMAIN_ADAPTER_NOT_DECLARED"
	| "DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE"
	| "DOMAIN_FIXTURE_AUTH_REFUSED"
	| "SUCCESS_FIXTURE_OBSERVED"
	| "TRANSIENT_PROVIDER_UNREACHABLE"
	| "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP"
	| "TRANSIENT_PROVIDER_AFTER_RECOVERY"
	| "TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT"
	| "SUCCESS_AFTER_ACCOUNT_EFFECT"
	| "SUCCESS_READ_OBSERVED"
	| "DOMAIN_PROVIDER_CALL_FAILED"
	| "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT"
	| "DOMAIN_MCPORTER_REPAIR_REQUIRED"
	| "DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP"
	| "DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY"
	| "INTERNAL_UNEXPECTED_UNCHANGED"
	| "INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP"
	| "SUCCESS_AUTH_LOGIN"
	| "DOMAIN_AUTH_LOGIN_UNKNOWN"
	| "DOMAIN_AUTH_VERB_UNSUPPORTED"
	| "DOMAIN_ATTENDED_REQUIRED"
	| "DOMAIN_CLIENT_MODE_NOT_ADMITTED"
	| "USAGE_OPERATION_UNKNOWN"
	| "USAGE_ADAPTER_REFUSED"
	| "DOMAIN_ADAPTER_REFUSED"
	| "SCHEMA_ADAPTER_REFUSED"
	| "DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION"
	| "SUCCESS_RUN_RECORDED"
	| "SUCCESS_RUN_APPLIED"
	| "DOMAIN_RUN_EFFECT_UNKNOWN"
	| "DOMAIN_RUN_FAILED_RECORDED";

let bootstrapCompleted = false;
let recoveryCompleted = false;
let setupStarted = false;
let setupCompleted: string[] = [];
// Explicit deps repair progress: the command, its durable effects, and the
// one effect an interrupted attempt leaves uncertain.
let depsProgress: { commandIdentity: string; completed: readonly string[]; uncertain: string | null; remaining: readonly string[] } | null = null;

// The deepest input a station's decision may depend on, in ascending depth;
// interruption marks a station reached only after an unexpected failure.
type Reachability = "arguments" | "packaged-files" | "plugin-state" | "dependency-selection" | "dependency-install" | "provider" | "attended-terminal" | "interruption";

// One argv element of a command's structured input schema. Elements sharing
// a position may appear in any order among themselves; positions ascend.
interface InputValue {
	readonly type: "string" | "json-object";
	readonly pattern?: string;
	readonly enum?: readonly string[];
	// The command identity that reports admissible values.
	readonly source?: string;
}
interface InputElement {
	readonly position: number;
	readonly kind: "word" | "positional" | "option";
	readonly token?: string;
	readonly name?: string;
	readonly value?: InputValue;
	readonly required: boolean;
	readonly repeatable: boolean;
	readonly onlyWhen?: string;
}

interface CommandDescriptor {
	readonly commandIdentity: string;
	readonly route: readonly string[];
	readonly effectClass: EffectClass;
	readonly summary: string;
	readonly usage: string;
	readonly input: readonly InputElement[];
	// The deepest input this command's success may depend on.
	readonly reaches: Reachability;
	// Every cause this command may emit (Spec AC19). assertEnvelope refuses
	// any other, and --discover-command describes these, never live state.
	readonly stations: readonly CauseCode[];
}

const word = (position: number, token: string): InputElement => ({ position, kind: "word", token, required: true, repeatable: false });
const positional = (position: number, name: string, value: InputValue, required = true): InputElement => ({ position, kind: "positional", name, value, required, repeatable: false });
const option = (position: number, token: string, value: InputValue | null, required: boolean, extra: { repeatable?: boolean; onlyWhen?: string } = {}): InputElement => ({ position, kind: "option", token, ...(value ? { value } : {}), required, repeatable: extra.repeatable ?? false, ...(extra.onlyWhen ? { onlyWhen: extra.onlyWhen } : {}) });
const words = (...tokens: string[]): InputElement[] => tokens.map((token, position) => word(position, token));
// A requirements revision names content, never a channel such as latest.
const REVISION_SHAPE = /^sha256:[0-9a-f]{64}$/;
const IDENTITY_SHAPE = /^connectors(\.[A-Za-z]+){1,3}$/;
const CONNECTOR_VALUE: InputValue = { type: "string", source: "connectors.list" };
const JSON_OBJECT: InputValue = { type: "json-object" };
const TOOL_VALUE: InputValue = { type: "string", enum: DEPENDENCY_TOOLS };
const REVISION_VALUE: InputValue = { type: "string", pattern: REVISION_SHAPE.source, source: "connectors.deps.status" };
const connectorAt = (position: number, required = true): InputElement => positional(position, "connector", CONNECTOR_VALUE, required);
const selectAt = (position: number): InputElement => option(position, "--select", { type: "string", pattern: "^[^=]+=", source: "connectors.config.show" }, false, { repeatable: true });
const depsInput = (verb: "repair" | "update", phase: "--preview" | "--apply"): InputElement[] => [
	...words("deps", verb),
	verb === "repair" ? positional(2, "tool", TOOL_VALUE) : positional(2, "revision", REVISION_VALUE),
	phase === "--preview" ? option(3, "--preview", null, true) : option(3, "--apply", { type: "string", pattern: PREVIEW_ID.source, source: `connectors.deps.${verb}.preview` }, true),
];
const runInput = (write: "--preview" | "--apply" | null): InputElement[] => [
	word(0, "run"),
	connectorAt(1),
	selectAt(2),
	positional(3, "operation", { type: "string", source: "connectors.schema" }),
	option(4, "--input", JSON_OBJECT, write !== null),
	...(write === "--preview" ? [option(4, "--preview", null, true)] : write === "--apply" ? [option(4, "--apply", { type: "string", source: "connectors.run.preview" }, true)] : []),
];
const recoverInput = (tail: readonly InputElement[]): InputElement[] => [word(0, "recover"), connectorAt(1), selectAt(2), ...tail];
const RUN_ID_VALUE: InputValue = { type: "string", source: "connectors.recover" };

// Station families shared by several commands.
const MANIFEST_REFUSALS: readonly CauseCode[] = ["USAGE_CONNECTOR_UNKNOWN", "SCHEMA_VERSION_UNSUPPORTED", "SCHEMA_ADAPTER_UNKNOWN", "SCHEMA_SELECTOR_INVALID", "SCHEMA_MANIFEST_INVALID", "SCHEMA_REQUIREMENTS_INVALID"];
const LOCAL_INSPECTION: readonly CauseCode[] = ["SUCCESS_UNCHANGED", "USAGE_MALFORMED_ARGUMENTS", ...MANIFEST_REFUSALS];
const SELECTED_SUCCESS: readonly CauseCode[] = ["SUCCESS_UNCHANGED", "SUCCESS_BOOTSTRAPPED", "SUCCESS_MCPORTER_RECOVERED"];
const SELECTION_FAILURES: readonly CauseCode[] = ["INTERNAL_MCPORTER_SELECTION_UNKNOWN", "DOMAIN_MCPORTER_REPAIR_REQUIRED", "DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP", "DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY"];
const SELECTED_TRANSIENT: readonly CauseCode[] = ["TRANSIENT_PROVIDER_UNREACHABLE", "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP", "TRANSIENT_PROVIDER_AFTER_RECOVERY"];
const PROVIDER_CALL_FAILURES: readonly CauseCode[] = ["DOMAIN_PROVIDER_CALL_FAILED", "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT"];
const ADAPTER_READ: readonly CauseCode[] = [...SELECTED_TRANSIENT, ...PROVIDER_CALL_FAILURES, "SUCCESS_AFTER_ACCOUNT_EFFECT", "TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT", "SUCCESS_READ_OBSERVED"];
const REFUSAL_CAUSE: Readonly<Record<AdapterRefusalKind, CauseCode>> = {
	usage: "USAGE_ADAPTER_REFUSED",
	domain: "DOMAIN_ADAPTER_REFUSED",
	schema: "SCHEMA_ADAPTER_REFUSED",
	"verb-unsupported": "DOMAIN_AUTH_VERB_UNSUPPORTED",
	"operation-unknown": "USAGE_OPERATION_UNKNOWN",
	"client-mode-not-admitted": "DOMAIN_CLIENT_MODE_NOT_ADMITTED",
};
// An adapter's custody resolution refuses only an invalid selection, adapter
// state, or packaged configuration; config show reports it through these.
const CUSTODY_REFUSALS: readonly CauseCode[] = [REFUSAL_CAUSE.usage, REFUSAL_CAUSE.domain, REFUSAL_CAUSE.schema];
// Every command routed through a packaged adapter: manifest, selector, and
// adapter refusals, MCPorter selection, and an inspected or executed success.
// schema answers a null adapter through its keyless route, so only the
// commands that require an adapter can refuse one as undeclared.
const ADAPTER_OUTCOMES: readonly CauseCode[] = [...Object.values(REFUSAL_CAUSE), "DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION", ...SELECTION_FAILURES, ...SELECTED_SUCCESS];
const ADAPTER_BASE: readonly CauseCode[] = [...MANIFEST_REFUSALS, "DOMAIN_ADAPTER_NOT_DECLARED", ...ADAPTER_OUTCOMES];
const DEPS_PREVIEW: readonly CauseCode[] = ["USAGE_MALFORMED_ARGUMENTS", "SUCCESS_UNCHANGED", "DOMAIN_DEPS_REPAIR_PREREQUISITE", "DOMAIN_DEPS_STATE_INVALID", "INTERNAL_DEPS_PREVIEW_AFTER_RECORD"];
const DEPS_APPLY: readonly CauseCode[] = ["USAGE_MALFORMED_ARGUMENTS", "DOMAIN_DEPS_PREVIEW_INVALID", "DOMAIN_DEPS_PREVIEW_STALE", "DOMAIN_DEPS_PREVIEW_CONSUMED", "DOMAIN_DEPS_APPLY_LOCKED", "DOMAIN_DEPS_STATE_INVALID"];

// This is the complete command surface. Do not add a route here without also
// implementing it, so discovery never advertises a command this binary
// cannot actually answer. auth and run reach only connectors whose packaged
// adapter has a prepare step, and schema reaches a credentialed connector only
// through a prepareSchema step; every other connector refuses through the
// catalogue.
const AUTH_USAGE = "auth <verb> <connector> [--select name=value ...] [--input <json-object> after configure | --no-browser --reset after login]";
const RUN_USAGE = "run <connector> [--select name=value ...] <operation> [--input <json-object>] [--preview | --apply <previewId>]";
const RECOVER_USAGE = "recover <connector> [--select name=value ...] [--run <runId> [--adjudicate --input <json-object>] | --run <runId|previewId> --unlock]";
const SCHEMA_USAGE = "schema <connector> [--select name=value ...]";
const STATUS_USAGE = "status [connector [--select name=value ...]]";

const COMMANDS: readonly CommandDescriptor[] = [
	{ commandIdentity: "connectors.dispatch", route: [], effectClass: "inspect", summary: "Refuse a missing, unknown, or incompatible command selection", usage: "<command> [arguments]", input: [positional(0, "command", { type: "string", source: "connectors.discovery" })], reaches: "arguments", stations: ["USAGE_UNKNOWN_COMMAND", "INTERNAL_UNEXPECTED_UNCHANGED", "INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP"] },
	{ commandIdentity: "connectors.help", route: ["--help"], effectClass: "inspect", summary: "Show help and usage", usage: "--help [--json]", input: [word(0, "--help"), option(1, "--json", null, false)], reaches: "arguments", stations: ["SUCCESS_UNCHANGED"] },
	{ commandIdentity: "connectors.discovery", route: ["--discover", "--json"], effectClass: "inspect", summary: "Describe the commands and the contract", usage: "--discover --json", input: [word(0, "--discover"), option(1, "--json", null, true)], reaches: "arguments", stations: ["SUCCESS_UNCHANGED"] },
	{ commandIdentity: "connectors.discovery.command", route: ["--discover-command", "--json"], effectClass: "inspect", summary: "Describe one command's route, usage, effect class, and possible stations; never runs it or observes live state", usage: "--discover-command <identity> --json", input: [word(0, "--discover-command"), positional(1, "identity", { type: "string", pattern: IDENTITY_SHAPE.source, source: "connectors.discovery" }), option(2, "--json", null, true)], reaches: "arguments", stations: ["SUCCESS_UNCHANGED", "USAGE_MALFORMED_ARGUMENTS", "USAGE_UNKNOWN_COMMAND"] },
	{ commandIdentity: "connectors.list", route: ["list"], effectClass: "inspect", summary: "List connectors declared by a Connector Manifest", usage: "list", input: words("list"), reaches: "packaged-files", stations: ["SUCCESS_UNCHANGED", "USAGE_MALFORMED_ARGUMENTS"] },
	{
		commandIdentity: "connectors.setup",
		route: ["setup"],
		effectClass: "repository-local",
		summary: "Explicitly install verified op and plugin-owned mise and pinned uv",
		usage: "setup",
		input: words("setup"),
		reaches: "dependency-install",
		stations: ["SUCCESS_COMPLETED", "DOMAIN_SETUP_FAILED_UNCHANGED", "DOMAIN_SETUP_FAILED_PARTIAL", "SCHEMA_SETUP_CONFIG_INVALID", "USAGE_SETUP_MALFORMED", "INTERNAL_SETUP_UNKNOWN", "INTERNAL_SETUP_AFTER_COMMIT"],
	},
	{ commandIdentity: "connectors.config.validate", route: ["config", "validate"], effectClass: "inspect", summary: "Validate connector manifests, registries, and packaged requirements", usage: "config validate [connector]", input: [...words("config", "validate"), connectorAt(2, false)], reaches: "packaged-files", stations: LOCAL_INSPECTION },
	{ commandIdentity: "connectors.config.show", route: ["config", "show"], effectClass: "inspect", summary: "Show resolved nonsecret values and provenance; conflicting repeated selectors refuse", usage: "config show <connector> --resolved --json [--select name=value ...]", input: [...words("config", "show"), connectorAt(2), option(3, "--resolved", null, true), option(3, "--json", null, true), selectAt(3)], reaches: "plugin-state", stations: [...LOCAL_INSPECTION, ...CUSTODY_REFUSALS] },
	{ commandIdentity: "connectors.status", route: ["status"], effectClass: "inspect", summary: "Report each connector's eight evidence states from this invocation's local checks; never contacts a Provider, reads a credential, or promotes a fixture or local check to a live state", usage: STATUS_USAGE, input: [word(0, "status"), connectorAt(1, false), selectAt(2)], reaches: "plugin-state", stations: LOCAL_INSPECTION },
	{ commandIdentity: "connectors.doctor", route: ["doctor"], effectClass: "inspect", summary: "Local readiness report for one connector", usage: "doctor <connector>", input: [word(0, "doctor"), connectorAt(1)], reaches: "plugin-state", stations: LOCAL_INSPECTION },
	{
		commandIdentity: "connectors.schema",
		route: ["schema"],
		effectClass: "repository-local",
		summary: "Fetch live schema for a keyless connector, or a credentialed one through its packaged adapter; bootstraps the pinned MCPorter on first use",
		usage: SCHEMA_USAGE,
		input: [word(0, "schema"), connectorAt(1), selectAt(2)],
		reaches: "provider",
		stations: ["USAGE_MALFORMED_ARGUMENTS", "DOMAIN_CUSTODY_NOT_SUPPORTED", ...MANIFEST_REFUSALS, ...ADAPTER_OUTCOMES, ...ADAPTER_READ],
	},
	{ commandIdentity: "connectors.deps.status", route: ["deps", "status"], effectClass: "inspect", summary: "Report each declared dependency's required version, verified plugin-owned selection, and one repair route; never installs or searches PATH", usage: "deps status [tool]", input: [...words("deps", "status"), positional(2, "tool", TOOL_VALUE, false)], reaches: "plugin-state", stations: ["SUCCESS_UNCHANGED", "USAGE_MALFORMED_ARGUMENTS", "USAGE_DEPENDENCY_UNKNOWN"] },
	{
		commandIdentity: "connectors.deps.repair.preview",
		route: ["deps", "repair", "--preview"],
		effectClass: "repository-local",
		summary: "Record the exact repair of one declared dependency against its observed selection; installs nothing",
		usage: "deps repair <tool> --preview",
		input: depsInput("repair", "--preview"),
		reaches: "plugin-state",
		stations: [...DEPS_PREVIEW, "USAGE_DEPENDENCY_UNKNOWN", "SUCCESS_DEPS_REPAIR_PREVIEWED"],
	},
	{
		commandIdentity: "connectors.deps.repair.apply",
		route: ["deps", "repair", "--apply"],
		effectClass: "external",
		summary: "Apply one current repair preview at most once: a durable receipt first, then one verified install of the declared version",
		usage: "deps repair <tool> --apply <previewId>",
		input: depsInput("repair", "--apply"),
		reaches: "dependency-install",
		stations: [...DEPS_APPLY, "USAGE_DEPENDENCY_UNKNOWN", "SUCCESS_DEPS_REPAIRED", "DOMAIN_DEPS_REPAIR_FAILED_RECORDED", "DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN", "INTERNAL_DEPS_REPAIR_UNKNOWN", "INTERNAL_DEPS_REPAIR_AFTER_EFFECT"],
	},
	{
		commandIdentity: "connectors.deps.update.preview",
		route: ["deps", "update", "--preview"],
		effectClass: "repository-local",
		summary: "Record the exact convergence of every present plugin-owned selection to the one requirements revision packaged in this build; installs nothing and never follows an upstream latest",
		usage: "deps update <revision> --preview",
		input: depsInput("update", "--preview"),
		reaches: "plugin-state",
		stations: [...DEPS_PREVIEW, "DOMAIN_DEPS_REVISION_NOT_ADMITTED", "SUCCESS_DEPS_UPDATE_PREVIEWED"],
	},
	{
		commandIdentity: "connectors.deps.update.apply",
		route: ["deps", "update", "--apply"],
		effectClass: "external",
		summary: "Apply one current update preview at most once: a durable receipt first, then one verified install per planned tool in order, stopping at the first failure",
		usage: "deps update <revision> --apply <previewId>",
		input: depsInput("update", "--apply"),
		reaches: "dependency-install",
		stations: [...DEPS_APPLY, "DOMAIN_DEPS_REVISION_NOT_ADMITTED", "SUCCESS_DEPS_UPDATED", "DOMAIN_DEPS_UPDATE_FAILED_RECORDED", "DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN", "INTERNAL_DEPS_UPDATE_UNKNOWN", "INTERNAL_DEPS_UPDATE_PARTIAL", "INTERNAL_DEPS_UPDATE_AFTER_EFFECT"],
	},
	{
		commandIdentity: "connectors.fixtureAuth",
		route: ["fixture-auth"],
		effectClass: "repository-local",
		summary: "Attempt a packaged, secret-free fixture auth operation for one connector and retain its fixture-tested observation for status (fixture-tested proof only, never real credential custody or a live state)",
		usage: "fixture-auth <connector>",
		input: [word(0, "fixture-auth"), connectorAt(1)],
		reaches: "plugin-state",
		stations: [...LOCAL_INSPECTION, "DOMAIN_ADAPTER_NOT_DECLARED", "DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE", "DOMAIN_FIXTURE_AUTH_REFUSED", "SUCCESS_FIXTURE_OBSERVED"],
	},
	{
		commandIdentity: "connectors.auth",
		route: ["auth"],
		effectClass: "external",
		summary: "Inspect or perform one connector's declared auth verb through its packaged adapter; configure alone takes --input <json-object> of nonsecret stored configuration, status inspects that configuration only, and login is attended only and alone takes --no-browser and --reset",
		usage: AUTH_USAGE,
		input: [
			word(0, "auth"),
			positional(1, "verb", { type: "string", enum: [...AUTH_VERBS] }),
			connectorAt(2),
			selectAt(3),
			option(3, "--input", JSON_OBJECT, false, { onlyWhen: "verb=configure" }),
			option(3, "--no-browser", null, false, { onlyWhen: "verb=login" }),
			option(3, "--reset", null, false, { onlyWhen: "verb=login" }),
		],
		reaches: "provider",
		stations: ["USAGE_MALFORMED_ARGUMENTS", ...ADAPTER_BASE, "SUCCESS_RUN_RECORDED", "DOMAIN_ATTENDED_REQUIRED", "SUCCESS_AUTH_LOGIN", "DOMAIN_AUTH_LOGIN_UNKNOWN"],
	},
	{
		commandIdentity: "connectors.run",
		route: ["run"],
		effectClass: "repository-local",
		summary: "Run one declared read operation for a connector through its packaged adapter and the selected MCPorter",
		usage: "run <connector> [--select name=value ...] <operation> [--input <json-object>]",
		input: runInput(null),
		reaches: "provider",
		stations: ["USAGE_MALFORMED_ARGUMENTS", ...ADAPTER_BASE, ...ADAPTER_READ],
	},
	{
		commandIdentity: "connectors.run.preview",
		route: ["run", "--preview"],
		effectClass: "repository-local",
		summary: "Record a durable preview of one declared write through the connector's packaged adapter; nothing is sent",
		usage: "run <connector> [--select name=value ...] <write-operation> --input <json-object> --preview",
		input: runInput("--preview"),
		reaches: "provider",
		stations: [...ADAPTER_BASE, ...PROVIDER_CALL_FAILURES, "SUCCESS_RUN_RECORDED"],
	},
	{
		commandIdentity: "connectors.run.apply",
		route: ["run", "--apply"],
		effectClass: "external",
		summary: "Apply one recorded preview with its identical input: a durable receipt first, then at most one Provider write",
		usage: "run <connector> [--select name=value ...] <write-operation> --input <json-object> --apply <previewId>",
		input: runInput("--apply"),
		reaches: "provider",
		stations: [...ADAPTER_BASE, ...PROVIDER_CALL_FAILURES, "SUCCESS_RUN_APPLIED", "DOMAIN_RUN_EFFECT_UNKNOWN", "DOMAIN_RUN_FAILED_RECORDED"],
	},
	{ commandIdentity: "connectors.recover", route: ["recover"], effectClass: "inspect", summary: "List a connector's open write receipts, or show one with --run", usage: "recover <connector> [--select name=value ...] [--run <runId>]", input: recoverInput([option(3, "--run", RUN_ID_VALUE, false)]), reaches: "plugin-state", stations: ["USAGE_MALFORMED_ARGUMENTS", ...ADAPTER_BASE] },
	{
		commandIdentity: "connectors.recover.adjudicate",
		route: ["recover", "--adjudicate"],
		effectClass: "repository-local",
		summary: "Settle one open write receipt on read-back evidence, with the write's identical input",
		usage: "recover <connector> [--select name=value ...] --run <runId> --adjudicate --input <json-object>",
		input: recoverInput([option(3, "--run", RUN_ID_VALUE, true), option(4, "--adjudicate", null, true), option(5, "--input", JSON_OBJECT, true)]),
		reaches: "provider",
		stations: [...ADAPTER_BASE, ...PROVIDER_CALL_FAILURES, "SUCCESS_RUN_RECORDED"],
	},
	{
		commandIdentity: "connectors.recover.unlock",
		route: ["recover", "--unlock"],
		effectClass: "repository-local",
		summary: "Release the write lock a receipt (by runId) or a preview (by previewId) left behind once its holder has exited",
		usage: "recover <connector> [--select name=value ...] --run <runId|previewId> --unlock",
		input: recoverInput([option(3, "--run", RUN_ID_VALUE, true), option(4, "--unlock", null, true)]),
		reaches: "plugin-state",
		stations: [...ADAPTER_BASE, "SUCCESS_RUN_RECORDED"],
	},
];

// Contract Core 2.0 requires sorted, unique availablePaths, independent of
// COMMANDS' own declaration order (which stays readable/logical instead).
const AVAILABLE_PATHS: readonly string[] = [...new Set(COMMANDS.map((command) => command.commandIdentity))].sort();
// Generic discovery and help list each command without its stations; the
// command-scoped route carries those.
const COMMAND_SUMMARIES = COMMANDS.map(({ commandIdentity, route, effectClass, summary }) => ({ commandIdentity, route, effectClass, summary }));

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
	SUCCESS_MCPORTER_RECOVERED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	INTERNAL_MCPORTER_SELECTION_UNKNOWN: { outcome: "failed", effectClass: "repository-local", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_COMPLETED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_SETUP_FAILED_UNCHANGED: { outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_SETUP_FAILED_PARTIAL: { outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_SETUP_CONFIG_INVALID: { outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_SETUP_MALFORMED: { outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_SETUP_UNKNOWN: { outcome: "failed", effectClass: "repository-local", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_SETUP_AFTER_COMMIT: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_DEPS_REPAIR_PREVIEWED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_DEPS_REPAIRED: { outcome: "success", effectClass: "external", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_DEPS_REPAIR_PREREQUISITE: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_STATE_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_PREVIEW_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_PREVIEW_STALE: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_PREVIEW_CONSUMED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_APPLY_LOCKED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_REPAIR_FAILED_RECORDED: { outcome: "failed", effectClass: "external", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN: { outcome: "failed", effectClass: "external", transactionState: "unknown", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	INTERNAL_DEPS_REPAIR_UNKNOWN: { outcome: "failed", effectClass: "external", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_DEPS_REPAIR_AFTER_EFFECT: { outcome: "failed", effectClass: "external", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_DEPS_PREVIEW_AFTER_RECORD: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_DEPS_UPDATE_PREVIEWED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_DEPS_UPDATED: { outcome: "success", effectClass: "external", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_DEPS_REVISION_NOT_ADMITTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_UPDATE_FAILED_RECORDED: { outcome: "failed", effectClass: "external", transactionState: "partially-completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN: { outcome: "failed", effectClass: "external", transactionState: "unknown", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	INTERNAL_DEPS_UPDATE_UNKNOWN: { outcome: "failed", effectClass: "external", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_DEPS_UPDATE_PARTIAL: { outcome: "failed", effectClass: "external", transactionState: "partially-completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_DEPS_UPDATE_AFTER_EFFECT: { outcome: "failed", effectClass: "external", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_UNKNOWN_COMMAND: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_MALFORMED_ARGUMENTS: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_CONNECTOR_UNKNOWN: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	USAGE_DEPENDENCY_UNKNOWN: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_VERSION_UNSUPPORTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_ADAPTER_UNKNOWN: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_SELECTOR_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_MANIFEST_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SCHEMA_REQUIREMENTS_INVALID: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_CUSTODY_NOT_SUPPORTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_ADAPTER_NOT_DECLARED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_FIXTURE_AUTH_REFUSED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_FIXTURE_OBSERVED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	TRANSIENT_PROVIDER_UNREACHABLE: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	TRANSIENT_PROVIDER_AFTER_BOOTSTRAP: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	TRANSIENT_PROVIDER_AFTER_RECOVERY: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "transient", exitCode: 75, retryable: true, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_AFTER_ACCOUNT_EFFECT: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_READ_OBSERVED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_PROVIDER_CALL_FAILED: { outcome: "failed", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_REQUIRED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_UNEXPECTED_UNCHANGED: { outcome: "failed", effectClass: "inspect", transactionState: "unchanged", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	SUCCESS_AUTH_LOGIN: { outcome: "success", effectClass: "external", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	DOMAIN_AUTH_LOGIN_UNKNOWN: { outcome: "failed", effectClass: "external", transactionState: "unknown", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_AUTH_VERB_UNSUPPORTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_ATTENDED_REQUIRED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_CLIENT_MODE_NOT_ADMITTED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	USAGE_OPERATION_UNKNOWN: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	USAGE_ADAPTER_REFUSED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_ADAPTER_REFUSED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	SCHEMA_ADAPTER_REFUSED: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION: { outcome: "refused", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	SUCCESS_RUN_RECORDED: { outcome: "success", effectClass: "repository-local", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	SUCCESS_RUN_APPLIED: { outcome: "success", effectClass: "external", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	// A write that may have reached the Provider is not an internal defect:
	// like DOMAIN_AUTH_LOGIN_UNKNOWN, it is a domain failure with an unknown state.
	DOMAIN_RUN_EFFECT_UNKNOWN: { outcome: "failed", effectClass: "external", transactionState: "unknown", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
	DOMAIN_RUN_FAILED_RECORDED: { outcome: "failed", effectClass: "repository-local", transactionState: "completed", failureClass: "domain", exitCode: 3, retryable: false, dataRule: "object", repairActionRule: "nonempty-string" },
};

// What triggers each cause and the deepest input it may depend on; "command"
// defers to the declaring command's own reach. Retry policy, effect evidence,
// and recovery derive from ADMITTED_CAUSE_ROWS, so no second copy can drift.
const STATION_SEMANTICS: Readonly<Record<CauseCode, { readonly reachability: Reachability | "command"; readonly trigger: string }>> = {
	SUCCESS_UNCHANGED: { reachability: "command", trigger: "the command completed without changing any state" },
	SUCCESS_BOOTSTRAPPED: { reachability: "command", trigger: "the command completed after first-use bootstrap of the pinned MCPorter" },
	SUCCESS_MCPORTER_RECOVERED: { reachability: "command", trigger: "the command completed after recovering an interrupted MCPorter selection" },
	INTERNAL_MCPORTER_SELECTION_UNKNOWN: { reachability: "dependency-install", trigger: "an MCPorter selection change stopped where its effect cannot be confirmed" },
	SUCCESS_COMPLETED: { reachability: "command", trigger: "every setup install was verified and selected" },
	DOMAIN_SETUP_FAILED_UNCHANGED: { reachability: "dependency-install", trigger: "the first setup install failed before selecting anything" },
	DOMAIN_SETUP_FAILED_PARTIAL: { reachability: "dependency-install", trigger: "a later setup install failed after earlier ones were selected" },
	SCHEMA_SETUP_CONFIG_INVALID: { reachability: "packaged-files", trigger: "the packaged setup requirements or mise configuration failed validation" },
	USAGE_SETUP_MALFORMED: { reachability: "arguments", trigger: "setup was given arguments" },
	INTERNAL_SETUP_UNKNOWN: { reachability: "interruption", trigger: "an unexpected failure stopped setup during an install" },
	INTERNAL_SETUP_AFTER_COMMIT: { reachability: "interruption", trigger: "an unexpected failure followed a completed setup" },
	SUCCESS_DEPS_REPAIR_PREVIEWED: { reachability: "command", trigger: "the exact repair was recorded as a preview; nothing was installed" },
	SUCCESS_DEPS_REPAIRED: { reachability: "command", trigger: "the previewed repair was installed and verified after its receipt" },
	DOMAIN_DEPS_REPAIR_PREREQUISITE: { reachability: "plugin-state", trigger: "the observed selection needs another route before this one" },
	DOMAIN_DEPS_STATE_INVALID: { reachability: "plugin-state", trigger: "plugin-owned dependency state is not private or cannot record an apply receipt" },
	DOMAIN_DEPS_PREVIEW_INVALID: { reachability: "plugin-state", trigger: "the preview is absent, unreadable, or for another request" },
	DOMAIN_DEPS_PREVIEW_STALE: { reachability: "plugin-state", trigger: "the observed dependency selection changed after the preview was recorded" },
	DOMAIN_DEPS_PREVIEW_CONSUMED: { reachability: "plugin-state", trigger: "the preview was already applied" },
	DOMAIN_DEPS_APPLY_LOCKED: { reachability: "plugin-state", trigger: "another apply holds the dependency lock" },
	DOMAIN_DEPS_REPAIR_FAILED_RECORDED: { reachability: "dependency-install", trigger: "the repair install failed after its receipt; the previous selection stays" },
	DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN: { reachability: "dependency-install", trigger: "a repair install stopped where its effect cannot be confirmed" },
	INTERNAL_DEPS_REPAIR_UNKNOWN: { reachability: "interruption", trigger: "an unexpected failure stopped the repair during its install" },
	INTERNAL_DEPS_REPAIR_AFTER_EFFECT: { reachability: "interruption", trigger: "an unexpected failure followed recorded repair effects" },
	INTERNAL_DEPS_PREVIEW_AFTER_RECORD: { reachability: "interruption", trigger: "an unexpected failure followed a recorded preview" },
	SUCCESS_DEPS_UPDATE_PREVIEWED: { reachability: "command", trigger: "the exact update was recorded as a preview; nothing was installed" },
	SUCCESS_DEPS_UPDATED: { reachability: "command", trigger: "every planned dependency update was installed and verified after its receipt" },
	DOMAIN_DEPS_REVISION_NOT_ADMITTED: { reachability: "arguments", trigger: "the requested requirements revision is not the one this build packages" },
	DOMAIN_DEPS_UPDATE_FAILED_RECORDED: { reachability: "dependency-install", trigger: "a planned update failed after its receipt; later updates were not started" },
	DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN: { reachability: "dependency-install", trigger: "an update install stopped where its effect cannot be confirmed" },
	INTERNAL_DEPS_UPDATE_UNKNOWN: { reachability: "interruption", trigger: "an unexpected failure stopped the update during an install" },
	INTERNAL_DEPS_UPDATE_PARTIAL: { reachability: "interruption", trigger: "an unexpected failure stopped the update after some planned updates completed and before the rest started" },
	INTERNAL_DEPS_UPDATE_AFTER_EFFECT: { reachability: "interruption", trigger: "an unexpected failure followed every planned update" },
	USAGE_UNKNOWN_COMMAND: { reachability: "arguments", trigger: "no declared command matches the request" },
	USAGE_MALFORMED_ARGUMENTS: { reachability: "arguments", trigger: "the arguments do not match the command's input schema" },
	USAGE_CONNECTOR_UNKNOWN: { reachability: "packaged-files", trigger: "no packaged Connector Manifest has that connector name" },
	USAGE_DEPENDENCY_UNKNOWN: { reachability: "arguments", trigger: "the tool is not a declared dependency" },
	SCHEMA_VERSION_UNSUPPORTED: { reachability: "packaged-files", trigger: "a Connector Manifest declares an unsupported schema version" },
	SCHEMA_ADAPTER_UNKNOWN: { reachability: "packaged-files", trigger: "a Connector Manifest names an adapter this build does not package" },
	SCHEMA_SELECTOR_INVALID: { reachability: "packaged-files", trigger: "a selector declaration or given selector value is invalid" },
	SCHEMA_MANIFEST_INVALID: { reachability: "packaged-files", trigger: "a Connector Manifest or its transport registry failed validation" },
	SCHEMA_REQUIREMENTS_INVALID: { reachability: "packaged-files", trigger: "the packaged requirements failed validation" },
	DOMAIN_CUSTODY_NOT_SUPPORTED: { reachability: "packaged-files", trigger: "the connector needs a credential and its adapter has no schema step" },
	DOMAIN_ADAPTER_NOT_DECLARED: { reachability: "packaged-files", trigger: "the connector declares no packaged adapter for this command" },
	DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE: { reachability: "packaged-files", trigger: "no packaged fixture authority exists for the connector" },
	DOMAIN_FIXTURE_AUTH_REFUSED: { reachability: "packaged-files", trigger: "the packaged fixture authority refused the operation" },
	SUCCESS_FIXTURE_OBSERVED: { reachability: "plugin-state", trigger: "the packaged fixture authority accepted the operation and its fixture-tested observation was retained" },
	TRANSIENT_PROVIDER_UNREACHABLE: { reachability: "provider", trigger: "the Provider was unreachable, so no request reached it" },
	TRANSIENT_PROVIDER_AFTER_BOOTSTRAP: { reachability: "provider", trigger: "the Provider was unreachable after first-use MCPorter bootstrap" },
	TRANSIENT_PROVIDER_AFTER_RECOVERY: { reachability: "provider", trigger: "the Provider was unreachable after MCPorter selection recovery" },
	TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT: { reachability: "provider", trigger: "the Provider was unreachable after account effects, or after MCPorter changed its vault file in an owned Connectors root" },
	SUCCESS_AFTER_ACCOUNT_EFFECT: { reachability: "command", trigger: "the read completed after account effects, or after MCPorter changed its vault file in an owned Connectors root" },
	SUCCESS_READ_OBSERVED: { reachability: "provider", trigger: "the read completed on an admitted hosted route and its evidence observation was retained" },
	DOMAIN_PROVIDER_CALL_FAILED: { reachability: "provider", trigger: "the Provider answered the call with a failure" },
	DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT: { reachability: "provider", trigger: "the Provider answered with a failure after local effects were recorded" },
	DOMAIN_MCPORTER_REPAIR_REQUIRED: { reachability: "dependency-selection", trigger: "the selected MCPorter is missing, damaged, or not the pinned version" },
	DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP: { reachability: "dependency-install", trigger: "the MCPorter bootstrapped on first use failed verification" },
	DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY: { reachability: "dependency-install", trigger: "the recovered MCPorter selection failed verification" },
	INTERNAL_UNEXPECTED_UNCHANGED: { reachability: "interruption", trigger: "an unexpected failure occurred before any effect" },
	INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP: { reachability: "interruption", trigger: "an unexpected failure followed an MCPorter bootstrap or recovery" },
	SUCCESS_AUTH_LOGIN: { reachability: "attended-terminal", trigger: "the attended login completed and its grant was stored" },
	DOMAIN_AUTH_LOGIN_UNKNOWN: { reachability: "attended-terminal", trigger: "the attended login ended where a grant may or may not have been stored" },
	DOMAIN_AUTH_VERB_UNSUPPORTED: { reachability: "packaged-files", trigger: "the connector's adapter does not support that auth verb" },
	DOMAIN_ATTENDED_REQUIRED: { reachability: "attended-terminal", trigger: "login needs an attended terminal and none is available to this process" },
	DOMAIN_CLIENT_MODE_NOT_ADMITTED: { reachability: "packaged-files", trigger: "the declared client mode is reserved and not admitted" },
	USAGE_OPERATION_UNKNOWN: { reachability: "packaged-files", trigger: "the connector declares no operation with that name" },
	USAGE_ADAPTER_REFUSED: { reachability: "plugin-state", trigger: "the adapter refused the request input" },
	DOMAIN_ADAPTER_REFUSED: { reachability: "plugin-state", trigger: "the adapter refused the request in the connector's current state" },
	SCHEMA_ADAPTER_REFUSED: { reachability: "plugin-state", trigger: "the adapter found its stored or packaged configuration invalid" },
	DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION: { reachability: "dependency-install", trigger: "the adapter refused after MCPorter selection or account effects completed" },
	SUCCESS_RUN_RECORDED: { reachability: "command", trigger: "the command recorded its durable record without a Provider write" },
	SUCCESS_RUN_APPLIED: { reachability: "provider", trigger: "the Provider confirmed the one previewed write after its receipt was recorded" },
	DOMAIN_RUN_EFFECT_UNKNOWN: { reachability: "provider", trigger: "the write may have reached the Provider but its effect was not confirmed" },
	DOMAIN_RUN_FAILED_RECORDED: { reachability: "provider", trigger: "the Provider rejected the write and its receipt records no change" },
};

// The effect lists a station may populate; every inventory is complete.
const EFFECT_EVIDENCE: Readonly<Record<CauseRow["transactionState"], readonly string[]>> = {
	unchanged: [],
	completed: ["completed"],
	"partially-completed": ["completed", "remaining"],
	unknown: ["completed", "remaining", "uncertain"],
};

// Partial and unknown effects need inspection before any later attempt; only
// a retryable row retries the same invocation. This build declares no retry
// delay.
function recoveryKind(row: CauseRow, reachability: Reachability): string {
	if (row.outcome === "success") return "none";
	if (row.transactionState === "unknown" || row.transactionState === "partially-completed") return "inspect-effects";
	if (row.retryable) return "retry";
	return reachability === "attended-terminal" ? "attended-handoff" : "repair";
}

function describeStation(command: CommandDescriptor, causeCode: CauseCode) {
	const row = ADMITTED_CAUSE_ROWS[causeCode];
	const { trigger, reachability: declared } = STATION_SEMANTICS[causeCode];
	const reachability = declared === "command" ? command.reaches : declared;
	const { outcome, failureClass, exitCode, effectClass, transactionState, retryable } = row;
	return {
		causeCode, trigger, reachability, outcome, failureClass, exitCode, effectClass, transactionState,
		effectEvidence: { mayPopulate: EFFECT_EVIDENCE[transactionState], inventoryComplete: true },
		retryable,
		retry: { policy: retryable ? "same-invocation" : "not-retryable" },
		recovery: { kind: recoveryKind(row, reachability), repairAction: row.repairActionRule === "nonempty-string" },
	};
}

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

const REPAIR_PREVIEW = "connectors.deps.repair.preview";
const REPAIR_APPLY = "connectors.deps.repair.apply";
const UPDATE_PREVIEW = "connectors.deps.update.preview";
const UPDATE_APPLY = "connectors.deps.update.apply";

// A command emits only its own declared stations.
const STATIONS: ReadonlyMap<string, readonly CauseCode[]> = new Map(COMMANDS.map((command) => [command.commandIdentity, command.stations]));

function checkCauseCommand(cause: CauseCode, commandIdentity: string): string[] {
	return STATIONS.get(commandIdentity)?.includes(cause) ? [] : [`${cause} is not a declared station of ${commandIdentity}`];
}

// Recorded effects: the custody registration auth configure publishes, then
// the journaled-write effects, in the one order an inventory may list them.
const WRITE_EFFECT_ORDER: readonly string[] = ["custody-registration", "write-preview", "write-receipt", "provider-write", "write-adjudication", "write-unlock"];
const NO_WRITE_EFFECTS = { completed: [], uncertain: [] } as const;

// Each journaled-write station: its cause and command identity, and the exact
// write effects it reports. Every other envelope reports none.
const WRITE_STATIONS: Readonly<Record<string, { readonly completed: readonly string[]; readonly uncertain: readonly string[] }>> = {
	"SUCCESS_RUN_RECORDED connectors.auth": { completed: ["custody-registration"], uncertain: [] },
	"SUCCESS_RUN_RECORDED connectors.run.preview": { completed: ["write-preview"], uncertain: [] },
	"SUCCESS_RUN_RECORDED connectors.recover.adjudicate": { completed: ["write-adjudication"], uncertain: [] },
	"SUCCESS_RUN_RECORDED connectors.recover.unlock": { completed: ["write-unlock"], uncertain: [] },
	"SUCCESS_RUN_APPLIED connectors.run.apply": { completed: ["write-receipt", "provider-write"], uncertain: [] },
	"DOMAIN_RUN_EFFECT_UNKNOWN connectors.run.apply": { completed: ["write-receipt"], uncertain: ["provider-write"] },
	"DOMAIN_RUN_FAILED_RECORDED connectors.run.apply": { completed: ["write-receipt"], uncertain: [] },
};
const WRITE_CAUSES: ReadonlySet<CauseCode> = new Set(["SUCCESS_RUN_RECORDED", "SUCCESS_RUN_APPLIED", "DOMAIN_RUN_EFFECT_UNKNOWN", "DOMAIN_RUN_FAILED_RECORDED"]);

const writeEffects = (effects: unknown): string => JSON.stringify(Array.isArray(effects) ? effects.filter((effect) => WRITE_EFFECT_ORDER.includes(effect as string)) : []);

function checkWriteStation(result: Envelope["result"]): string[] {
	const station = WRITE_STATIONS[`${result.causeCode} ${result.commandIdentity}`];
	if (WRITE_CAUSES.has(result.causeCode) && !station) return ["write cause and command identity must agree"];
	const expected = station ?? NO_WRITE_EFFECTS;
	const matches = writeEffects(result.effects.completed) === JSON.stringify(expected.completed) && writeEffects(result.effects.uncertain) === JSON.stringify(expected.uncertain);
	return matches ? [] : [`${result.causeCode} under ${result.commandIdentity} reports the wrong write effects`];
}

function checkCauseRow(result: Envelope["result"]): string[] {
	const row = ADMITTED_CAUSE_ROWS[result.causeCode as CauseCode];
	if (!row) return [`result.causeCode ${JSON.stringify(result.causeCode)} is not one of T1's admitted cause rows`];
	const cause = result.causeCode;
	return [...checkCauseCommand(cause, result.commandIdentity), ...checkWriteStation(result), ...checkCauseRowScalars(result, row, cause), ...checkCauseRowData(result, row, cause), ...checkCauseRowRepairAction(result, row, cause)];
}

// T1 never attempts an effect, so every envelope's effects are vacuously
// empty and fully inventoried; a fabricated "unchanged" state must not be
// able to smuggle a fake completed/remaining/uncertain entry through.
// Admitted selection inventories, as exact serialized lists. account-grant is
// the attended login's grant, held by MCPorter in the account vault.
const ADMITTED_EFFECTS: Readonly<Record<"selection" | "remaining" | "uncertain", readonly string[]>> = {
	selection: ["[]", '["mcporter-bootstrap"]', '["mcporter-recovery"]'],
	remaining: ["[]"],
	uncertain: ["[]", '["mcporter-repair"]', '["mcporter-recovery"]', '["account-grant"]', '["provider-write"]'],
};

// A completed inventory is one selection inventory followed by connector
// account effects, the retained evidence observation of a hosted read, and
// then journaled-write effects, each at most once and in this order.
const ACCOUNT_EFFECT_ORDER: readonly string[] = ["account-vault", "mcporter-vault-file", "account-grant"] satisfies readonly (LocalEffect | "account-grant")[];
const EVIDENCE_OBSERVATION = "evidence-observation";
const CONNECTOR_EFFECT_ORDER: readonly string[] = [...ACCOUNT_EFFECT_ORDER, EVIDENCE_OBSERVATION, ...WRITE_EFFECT_ORDER];

function isAdmittedCompleted(completed: readonly unknown[]): boolean {
	const split = completed.findIndex((effect) => CONNECTOR_EFFECT_ORDER.includes(effect as string));
	const selection = split < 0 ? completed : completed.slice(0, split);
	const positions = split < 0 ? [] : completed.slice(split).map((effect) => CONNECTOR_EFFECT_ORDER.indexOf(effect as string));
	return ADMITTED_EFFECTS.selection.includes(JSON.stringify(selection)) && positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!));
}

function checkEffectsEmptyAndComplete(effects: Envelope["result"]["effects"]): string[] {
	const problems: string[] = [...checkExactKeys(effects, EFFECTS_KEYS, "result.effects")];
	for (const key of ["completed", "remaining", "uncertain"] as const) {
		if (!Array.isArray(effects[key])) problems.push(`result.effects.${key} must be an array`);
		else if (key === "completed" ? !isAdmittedCompleted(effects[key]) : !ADMITTED_EFFECTS[key].includes(JSON.stringify(effects[key]))) problems.push(`result.effects.${key} has an undeclared effect`);
	}
	if (effects.inventoryComplete !== true) problems.push("result.effects.inventoryComplete must be true for T1");
	return problems;
}

// A deps repair inventory: the preview alone, or the receipt followed by
// that apply's MCPorter recovery and at most one tool repair, in this order.
const DEPS_REPAIR_TAIL: readonly string[] = ["mcporter-recovery", "mcporter-repair", "op-repair", "mise-repair", "uv-repair"];
const DEPS_TOOL_REPAIRS: readonly string[] = DEPS_REPAIR_TAIL.slice(1);
const DEPS_RECEIPTED: ReadonlySet<CauseCode> = new Set(["SUCCESS_DEPS_REPAIRED", "DOMAIN_DEPS_REPAIR_FAILED_RECORDED", "DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN", "INTERNAL_DEPS_REPAIR_UNKNOWN", "INTERNAL_DEPS_REPAIR_AFTER_EFFECT"]);

function depsCompletedAdmitted(cause: CauseCode, completed: readonly unknown[]): boolean {
	if (cause === "SUCCESS_DEPS_REPAIR_PREVIEWED" || cause === "INTERNAL_DEPS_PREVIEW_AFTER_RECORD") return JSON.stringify(completed) === '["deps-repair-preview"]';
	if (!DEPS_RECEIPTED.has(cause)) return completed.length === 0;
	if (completed[0] !== "deps-repair-receipt") return false;
	const positions = completed.slice(1).map((effect) => DEPS_REPAIR_TAIL.indexOf(effect as string));
	if (!positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))) return false;
	if (positions.filter((position) => position > 0).length > 1) return false;
	return cause !== "SUCCESS_DEPS_REPAIRED" || DEPS_TOOL_REPAIRS.includes(completed.at(-1) as string);
}

function checkDepsRepairEffects(result: Envelope["result"]): string[] {
	const effects = result.effects;
	const problems = checkExactKeys(effects, EFFECTS_KEYS, "result.effects");
	if (!Array.isArray(effects.completed) || !Array.isArray(effects.remaining) || !Array.isArray(effects.uncertain)) return [...problems, "deps repair effect inventories must be arrays"];
	if (effects.inventoryComplete !== true || effects.remaining.length !== 0) problems.push("deps repair inventory must be complete with nothing remaining");
	if (!depsCompletedAdmitted(result.causeCode, effects.completed)) problems.push("deps repair completed effects are not admitted for this cause");
	const unknown = result.transactionState === "unknown";
	const uncertainAdmitted = unknown ? effects.uncertain.length === 1 && DEPS_TOOL_REPAIRS.includes(effects.uncertain[0] as string) && JSON.stringify(effects.completed) === '["deps-repair-receipt"]' : effects.uncertain.length === 0;
	if (!uncertainAdmitted) problems.push("deps repair uncertain effects are not admitted");
	return problems;
}

// A deps update inventory: the preview alone, or the receipt, then the
// planned tool updates partitioned in order into completed (with any
// MCPorter recovery before its update), at most one uncertain, and remaining.
const DEPS_UPDATE_TAIL: readonly string[] = ["mcporter-recovery", "mcporter-update", "op-update", "mise-update", "uv-update"];
const DEPS_UPDATE_RECEIPTED: ReadonlySet<CauseCode> = new Set(["SUCCESS_DEPS_UPDATED", "DOMAIN_DEPS_UPDATE_FAILED_RECORDED", "DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN", "INTERNAL_DEPS_UPDATE_UNKNOWN", "INTERNAL_DEPS_UPDATE_PARTIAL", "INTERNAL_DEPS_UPDATE_AFTER_EFFECT"]);

function depsUpdateOrdered(effects: Envelope["result"]["effects"]): boolean {
	if (effects.completed[0] !== "deps-update-receipt" || effects.uncertain.length > 1) return false;
	const positions = [...effects.completed.slice(1), ...effects.uncertain, ...effects.remaining].map((effect) => DEPS_UPDATE_TAIL.indexOf(effect as string));
	return positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)) && !effects.uncertain.includes("mcporter-recovery") && !effects.remaining.includes("mcporter-recovery");
}

function depsUpdateStateAdmitted(state: string, effects: Envelope["result"]["effects"]): boolean {
	if (state === "completed") return effects.remaining.length === 0 && effects.uncertain.length === 0;
	if (state === "partially-completed") return effects.remaining.length > 0 && effects.uncertain.length === 0;
	return state === "unknown" && effects.uncertain.length === 1;
}

function checkDepsUpdateEffects(result: Envelope["result"]): string[] {
	const effects = result.effects;
	const problems = checkExactKeys(effects, EFFECTS_KEYS, "result.effects");
	if (!Array.isArray(effects.completed) || !Array.isArray(effects.remaining) || !Array.isArray(effects.uncertain)) return [...problems, "deps update effect inventories must be arrays"];
	if (effects.inventoryComplete !== true) problems.push("deps update inventory must be complete");
	const preview = result.causeCode === "SUCCESS_DEPS_UPDATE_PREVIEWED" || result.causeCode === "INTERNAL_DEPS_PREVIEW_AFTER_RECORD";
	if (preview) {
		if (JSON.stringify([effects.completed, effects.remaining, effects.uncertain]) !== '[["deps-update-preview"],[],[]]') problems.push("deps update preview records only its preview");
	} else if (!DEPS_UPDATE_RECEIPTED.has(result.causeCode)) {
		if (effects.completed.length + effects.remaining.length + effects.uncertain.length !== 0) problems.push("deps update refusal reports no effect");
	} else if (!depsUpdateOrdered(effects) || !depsUpdateStateAdmitted(result.transactionState, effects)) problems.push("deps update effects are not admitted for this cause");
	return problems;
}

// Setup and explicit deps repair and update own their inventories; every other command
// reports the shared selection, account, and journaled-write inventory.
function checkCommandEffects(result: Envelope["result"]): string[] {
	if (result.commandIdentity === REPAIR_PREVIEW || result.commandIdentity === REPAIR_APPLY) return checkDepsRepairEffects(result);
	if (result.commandIdentity === UPDATE_PREVIEW || result.commandIdentity === UPDATE_APPLY) return checkDepsUpdateEffects(result);
	if (result.commandIdentity === "connectors.setup") return checkSetupEffects(result);
	return checkEffectsEmptyAndComplete(result.effects);
}

function checkSetupEffects(result: Envelope["result"]): string[] {
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
		...checkCommandEffects(envelope.result),
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

function depsCrashCause(progress: NonNullable<typeof depsProgress>): CauseCode {
	if (progress.commandIdentity === REPAIR_PREVIEW || progress.commandIdentity === UPDATE_PREVIEW) return "INTERNAL_DEPS_PREVIEW_AFTER_RECORD";
	if (progress.commandIdentity === REPAIR_APPLY) return progress.uncertain ? "INTERNAL_DEPS_REPAIR_UNKNOWN" : "INTERNAL_DEPS_REPAIR_AFTER_EFFECT";
	if (progress.uncertain) return "INTERNAL_DEPS_UPDATE_UNKNOWN";
	return progress.remaining.length > 0 ? "INTERNAL_DEPS_UPDATE_PARTIAL" : "INTERNAL_DEPS_UPDATE_AFTER_EFFECT";
}

function depsFailureProgress(progress: NonNullable<typeof depsProgress>): FailureProgress {
	const causeCode = depsCrashCause(progress);
	const row = ADMITTED_CAUSE_ROWS[causeCode];
	// Repair reports no remaining effects; update names each unachieved one.
	const remaining = progress.commandIdentity === UPDATE_APPLY ? [...progress.remaining] : [];
	return {
		commandIdentity: progress.commandIdentity, effectClass: row.effectClass, transactionState: row.transactionState, causeCode,
		effects: { completed: [...progress.completed], remaining, uncertain: progress.uncertain ? [progress.uncertain] : [], inventoryComplete: true },
	};
}

function selectionFailureProgress(): FailureProgress {
	const completed = completedSelectionEffects();
	return {
		commandIdentity: "connectors.dispatch", effectClass: completed.length > 0 ? "repository-local" : "inspect",
		transactionState: completed.length > 0 ? "completed" : "unchanged",
		causeCode: bootstrapCompleted || recoveryCompleted ? "INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP" : "INTERNAL_UNEXPECTED_UNCHANGED",
		effects: { completed, remaining: [], uncertain: [], inventoryComplete: true },
	};
}

export function buildInternalFailureEnvelope(): Envelope {
	const progress = setupStarted ? setupFailureProgress() : depsProgress ? depsFailureProgress(depsProgress) : selectionFailureProgress();
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

// Contract Core bounded stop (Spec #87 AC16): the first SIGINT or SIGTERM
// stops new work, releases this process's MCPorter staging and selection
// lock, and exits 130 or 143. Before output both streams stay empty; after
// output, a bounded flush lets the written stream drain. A repeated signal
// exits at once. SIGNAL_EXITS is the one owner of both the exits and discovery.
const SIGNAL_FLUSH_MS = 1_000;
let stopping = false;

function stopOnSignal(exitCode: number): void {
	if (stopping) process.exit(exitCode);
	stopping = true;
	releaseInterruptedSelection();
	if (!outputStarted) process.exit(exitCode);
	setTimeout(() => process.exit(exitCode), SIGNAL_FLUSH_MS);
	process.stdout.write("", () => process.exit(exitCode));
}

// Internal roles are children whose parent owns their lifecycle; only the
// front door installs the stop.
function installSignalStop(): void {
	for (const [exitCode, signal] of Object.entries(SIGNAL_EXITS)) process.on(signal, () => stopOnSignal(Number(exitCode)));
}

function writeStdout(text: string): void {
	// No output follows a signal: nothing new starts, and nothing replaces
	// what an earlier write already sent.
	if (stopping) return;
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
				commands: COMMAND_SUMMARIES,
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

const DISCOVER_COMMAND_USAGE = "--discover-command <identity> --json";
const DISCOVERY_SCOPE = "possible stations declared by this build; not live state, authorization, or proof";

// Describes one declared command from COMMANDS and ADMITTED_CAUSE_ROWS alone:
// it runs nothing, reads no state or credential, and never echoes the
// requested identity.
function discoverCommand(args: readonly string[]): void {
	const identity = "connectors.discovery.command";
	const [requested, json] = args;
	if (args.length !== 2 || json !== "--json" || requested === undefined || !IDENTITY_SHAPE.test(requested)) {
		emitRefusal(identity, `${PROGRAM}: usage: ${DISCOVER_COMMAND_USAGE}`, "USAGE_MALFORMED_ARGUMENTS", `Run ${PROGRAM} ${DISCOVER_COMMAND_USAGE} with an identity from ${PROGRAM} --discover --json`, "connectors.discovery");
		return;
	}
	const command = COMMANDS.find((candidate) => candidate.commandIdentity === requested);
	if (!command) {
		emitRefusal(identity, `${PROGRAM}: no declared command has that identity`, "USAGE_UNKNOWN_COMMAND", `Run ${PROGRAM} --discover --json to see the declared command identities`, "connectors.discovery");
		return;
	}
	const stations = [...command.stations].sort().map((causeCode) => describeStation(command, causeCode));
	const exitMeanings = Object.fromEntries(Object.entries(EXIT_MEANINGS).filter(([code]) => stations.some((station) => String(station.exitCode) === code)));
	const { commandIdentity, route, effectClass, summary, usage, input } = command;
	// The catalogue shares value objects between rows, and assertEnvelope
	// reads a repeated reference as a cycle, so the data is a plain copy.
	const data = JSON.parse(JSON.stringify({ command: { commandIdentity, route, effectClass, summary, usage, input }, stations, exitMeanings, scope: DISCOVERY_SCOPE })) as Record<string, unknown>;
	emitSuccess(identity, `Declared stations of ${commandIdentity}`, data, "connectors.discovery");
}

function helpText(): string {
	return [
		`${PROGRAM}: Connectors plugin front door`,
		"",
		"Commands:",
		"  --discover --json                              Describe the commands and the contract (machine JSON)",
		"  --discover-command <identity> --json           Describe one command's usage, effect class, and possible stations",
		"  --help                                          Show this human-readable help",
		"  --help --json                                   Show help as a machine Contract Core envelope",
		"  list                                            List connectors declared by a manifest",
		"  setup                                           Install verified op, mise, and pinned uv explicitly",
		"  config validate [connector]                     Validate manifests, registries, and packaged requirements",
		"  config show <connector> --resolved --json       Show resolved nonsecret configuration and provenance",
		"                                                  Repeated --select names must carry identical values",
		"  status [connector [--select name=value ...]]    Report eight evidence states from local checks and retained hosted reads",
		"  doctor <connector>                              Report one connector's locally observed evidence",
		"  schema <connector> [--select name=value ...]     Fetch live schema; a credentialed connector reads through its adapter",
		"  deps status [tool]                               Report required and selected dependency versions; changes nothing",
		"  deps repair <tool> --preview                     Record the exact repair of one dependency; installs nothing",
		"  deps repair <tool> --apply <previewId>           Apply that current preview once: receipt first, then one verified install",
		"  deps update <revision> --preview                 Record converging present dependencies to this build's requirements revision",
		"  deps update <revision> --apply <previewId>       Apply that current update preview once, in order, stopping at a failure",
		"  auth <verb> <connector> [--select name=value]    Run one declared auth verb; login needs your terminal",
		"  auth configure <connector> [--select name=value ...] --input <json-object>",
		"                                                  Record nonsecret credential references once, such as 1Password item IDs",
		"  auth status <connector> [--select name=value ...]",
		"                                                  Inspect that stored configuration; reads no credential",
		"  auth login <connector> [--select name=value ...] [--no-browser] [--reset]",
		"                                                  Print the consent URL instead of opening a browser; clear the cached grant first",
		"  run <connector> [--select name=value] <operation> [--input <json-object>]",
		"                                                  Run one declared read operation through MCPorter",
		"  run <connector> [--select name=value] <write-operation> --input <json-object> --preview",
		"                                                  Record a durable preview of one write; nothing is sent",
		"  run <connector> [--select name=value] <write-operation> --input <json-object> --apply <previewId>",
		"                                                  Apply that preview with the identical input, at most once",
		"  recover <connector> [--select name=value] [--run <runId> [--adjudicate --input <json-object>]]",
		"                                                  List open write receipts, show one, or settle it on read-back",
		"  recover <connector> [--select name=value] --run <runId|previewId> --unlock",
		"                                                  Release the lock a receipt or preview left behind once its holder exited",
		"",
		"Examples:",
		`  ${PROGRAM} --discover --json`,
		`  ${PROGRAM} list`,
		`  ${PROGRAM} doctor context7`,
		`  ${PROGRAM} schema canva --select account=work`,
		`  ${PROGRAM} run canva --select account=work search-designs --input '{"query":"poster"}'`,
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
			data: { usage: `${PROGRAM} --discover --json`, commands: COMMAND_SUMMARIES },
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

// Inspection only: an unhealthy selection is a successful report naming its
// one repair route, never a repair.
function handleDepsStatus(args: readonly string[]): void {
	if (args.length > 1) {
		usageMalformed("connectors.deps.status", "deps status [tool]");
		return;
	}
	const [tool] = args;
	if (tool !== undefined && !isDependencyTool(tool)) {
		emitRefusal("connectors.deps.status", `${PROGRAM}: undeclared dependency`, "USAGE_DEPENDENCY_UNKNOWN", `Run ${PROGRAM} deps status [${DEPENDENCY_TOOLS.join("|")}]`, "connectors.deps.status");
		return;
	}
	const dependencies = dependencyStatus(process.env, tool === undefined ? DEPENDENCY_TOOLS : [tool]);
	const pending = dependencies.find((entry) => entry.repair !== null);
	const message = pending ? "Dependency status reported; a dependency is not ready" : "Dependency status reported; every dependency is ready";
	emitSuccess("connectors.deps.status", message, { requirementsRevision: REQUIREMENTS_REVISION, dependencies }, pending?.repair?.commandIdentity ?? "connectors.status");
}

type DepsIdentity = typeof REPAIR_PREVIEW | typeof REPAIR_APPLY | typeof UPDATE_PREVIEW | typeof UPDATE_APPLY;
const DEPS_REPAIR_USAGE = "deps repair <tool> --preview | deps repair <tool> --apply <previewId>";
const DEPS_UPDATE_USAGE = "deps update <revision> --preview | deps update <revision> --apply <previewId>";
function emitDeps(commandIdentity: DepsIdentity, causeCode: CauseCode, message: string, fields: { data: Record<string, unknown> | null; repairAction: string | null; nextAction: string; completed?: readonly string[]; uncertain?: string | null; remaining?: readonly string[] }): void {
	const row = ADMITTED_CAUSE_ROWS[causeCode];
	emit({
		envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message, availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(), commandIdentity, outcome: row.outcome, failureClass: row.failureClass, exitCode: row.exitCode,
			data: fields.data, retryable: false, repairAction: fields.repairAction, nextAction: fields.nextAction,
			effectClass: row.effectClass, transactionState: row.transactionState, causeCode,
			effects: { completed: [...(fields.completed ?? [])], remaining: [...(fields.remaining ?? [])], uncertain: fields.uncertain ? [fields.uncertain] : [], inventoryComplete: true },
		},
	});
}

// What differs between a repair and an update at the front door: identities,
// names, and routes. The plan, lock, receipt, and attempts are shared.
interface DepsCommand {
	readonly request: DepsRequest;
	readonly preview: DepsIdentity;
	readonly apply: DepsIdentity;
	readonly subject: string;
	readonly previewCommand: string;
	readonly previewEffect: string;
}

const repairCommand = (tool: DependencyTool): DepsCommand => ({ request: { kind: "repair", tool }, preview: REPAIR_PREVIEW, apply: REPAIR_APPLY, subject: `${tool} repair`, previewCommand: `${PROGRAM} deps repair ${tool} --preview`, previewEffect: "deps-repair-preview" });
const updateCommand = (revision: string): DepsCommand => ({ request: { kind: "update", revision }, preview: UPDATE_PREVIEW, apply: UPDATE_APPLY, subject: "dependency update", previewCommand: `${PROGRAM} deps update ${revision} --preview`, previewEffect: "deps-update-preview" });

// The preview result's public data: repair names its tool and version, update
// its admitted revision.
function previewData(command: DepsCommand, observed: unknown[]): Record<string, unknown> {
	const { request } = command;
	return request.kind === "repair" ? { tool: request.tool, required: (observed[0] as { required: string }).required, observed } : { revision: request.revision, observed };
}

const stateRepair = (command: DepsCommand): string => `Inspect the plugin-owned XDG state root, then run ${command.previewCommand} again`;

function handleDepsPreview(command: DepsCommand): void {
	const identity = command.preview;
	const preview = previewDeps(process.env, command.request);
	if (preview.kind === "prerequisite") {
		emitDeps(identity, "DOMAIN_DEPS_REPAIR_PREREQUISITE", `${PROGRAM}: ${command.subject} needs another route first`, { data: null, repairAction: preview.repairAction, nextAction: preview.nextAction });
		return;
	}
	if (preview.kind === "state-invalid") {
		emitDeps(identity, "DOMAIN_DEPS_STATE_INVALID", `${PROGRAM}: plugin-owned deps state is not private`, { data: null, repairAction: stateRepair(command), nextAction: "connectors.deps.status" });
		return;
	}
	if (preview.kind === "ready") {
		emitSuccess(identity, command.request.kind === "repair" ? `${command.request.tool} is ready; nothing to repair` : "Every present dependency matches this revision; nothing to update", { ...previewData(command, preview.observed), plannedEffects: [] }, "connectors.deps.status");
		return;
	}
	depsProgress = { commandIdentity: identity, completed: [command.previewEffect], uncertain: null, remaining: [] };
	const { previewId, observed, plannedEffects } = preview;
	const apply = command.request.kind === "repair" ? `${PROGRAM} deps repair ${command.request.tool} --apply ${previewId}` : `${PROGRAM} deps update ${command.request.revision} --apply ${previewId}`;
	emitDeps(identity, command.request.kind === "repair" ? "SUCCESS_DEPS_REPAIR_PREVIEWED" : "SUCCESS_DEPS_UPDATE_PREVIEWED", `${command.subject} previewed; nothing is installed until apply`, {
		data: { previewId, ...previewData(command, observed), plannedEffects, apply },
		repairAction: null, nextAction: command.apply, completed: [command.previewEffect],
	});
}

const depsStatusCommand = (command: DepsCommand): string => (command.request.kind === "repair" ? `${PROGRAM} deps status ${command.request.tool}` : `${PROGRAM} deps status`);

function applyRefusal(command: DepsCommand, cause: Extract<ApplyResult, { kind: "refused" }>["cause"]): { cause: CauseCode; message: string; repair: string; next: string } {
	const { kind } = command.request;
	if (cause === "invalid") return { cause: "DOMAIN_DEPS_PREVIEW_INVALID", message: `no ${kind} preview with that id for this ${kind === "repair" ? "tool" : "revision"}`, repair: `Run ${command.previewCommand} to record a preview for this ${kind === "repair" ? "tool" : "revision"}`, next: command.preview };
	if (cause === "stale") return { cause: "DOMAIN_DEPS_PREVIEW_STALE", message: "the selection changed since this preview", repair: `Run ${command.previewCommand} again`, next: command.preview };
	if (cause === "state-invalid") return { cause: "DOMAIN_DEPS_STATE_INVALID", message: `plugin-owned deps state could not record this ${kind} receipt; nothing was attempted`, repair: stateRepair(command), next: "connectors.deps.status" };
	if (cause === "consumed") return { cause: "DOMAIN_DEPS_PREVIEW_CONSUMED", message: "this preview was already claimed by an apply", repair: `Run ${depsStatusCommand(command)}; preview a new ${kind} only if it is still not ready`, next: "connectors.deps.status" };
	return { cause: "DOMAIN_DEPS_APPLY_LOCKED", message: `the deps ${kind} lock is unavailable`, repair: lockRecovery, next: "connectors.deps.status" };
}

const APPLY_CAUSES: Readonly<Record<DepsRequest["kind"], Readonly<Record<"completed" | "failed" | "unknown", CauseCode>>>> = {
	repair: { completed: "SUCCESS_DEPS_REPAIRED", failed: "DOMAIN_DEPS_REPAIR_FAILED_RECORDED", unknown: "DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN" },
	update: { completed: "SUCCESS_DEPS_UPDATED", failed: "DOMAIN_DEPS_UPDATE_FAILED_RECORDED", unknown: "DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN" },
};

async function handleDepsApply(command: DepsCommand, previewId: string): Promise<void> {
	const identity = command.apply;
	const result = await applyDeps(process.env, previewId, command.request, pluginRoot(), (completed, uncertain, remaining) => {
		depsProgress = { commandIdentity: identity, completed, uncertain, remaining };
	});
	if (result.kind === "refused") {
		const refusal = applyRefusal(command, result.cause);
		emitDeps(identity, refusal.cause, `${PROGRAM}: ${refusal.message}`, { data: null, repairAction: refusal.repair, nextAction: refusal.next });
		return;
	}
	const { request } = command;
	const data = request.kind === "repair" ? { previewId, tool: request.tool } : { previewId, revision: request.revision };
	// Repair's inventory reports no remaining effects; update names each one.
	const remaining = request.kind === "update" ? result.remaining : [];
	const cause = APPLY_CAUSES[request.kind][result.kind];
	if (result.kind === "completed") {
		emitDeps(identity, cause, request.kind === "repair" ? `${request.tool} repaired to its declared version` : `Dependencies converged to requirements revision ${request.revision}`, { data, repairAction: null, nextAction: "connectors.deps.status", completed: result.completed });
		return;
	}
	const unknown = result.kind === "unknown";
	emitDeps(identity, cause, `${PROGRAM}: ${command.subject} ${unknown ? "outcome is unknown" : "failed"}; this preview is never reapplied`, {
		data, repairAction: unknown && result.lockFailed ? lockRecovery : `Inspect ${depsStatusCommand(command)}, then preview a new ${request.kind} if it is still not ready`, nextAction: "connectors.deps.status",
		completed: result.completed, uncertain: unknown ? result.uncertain : null, remaining,
	});
}

// deps repair <tool> --preview, or deps repair <tool> --apply <previewId>.
// Shape, tool, and preview id are checked before any state is read.
async function handleDepsRepair(args: readonly string[]): Promise<void> {
	const identity = args.includes("--apply") ? REPAIR_APPLY : REPAIR_PREVIEW;
	const [tool, flag, previewId] = args;
	// The unpreviewed repair is retired: a bare tool names its one preview.
	if (args.length === 1 && tool !== undefined && isDependencyTool(tool)) {
		emitRefusal(identity, `${PROGRAM}: deps repair needs --preview, then --apply <previewId>`, "USAGE_MALFORMED_ARGUMENTS", `Run ${PROGRAM} deps repair ${tool} --preview`, REPAIR_PREVIEW);
		return;
	}
	const shaped = identity === REPAIR_PREVIEW ? args.length === 2 && flag === "--preview" : args.length === 3 && flag === "--apply" && previewId !== undefined && PREVIEW_ID.test(previewId);
	if (!shaped || tool === undefined) {
		usageMalformed(identity, DEPS_REPAIR_USAGE);
		return;
	}
	if (!isDependencyTool(tool)) {
		emitRefusal(identity, `${PROGRAM}: undeclared dependency`, "USAGE_DEPENDENCY_UNKNOWN", `Run ${PROGRAM} deps repair [${DEPENDENCY_TOOLS.join("|")}] --preview`, "connectors.deps.status");
		return;
	}
	if (identity === REPAIR_PREVIEW) handleDepsPreview(repairCommand(tool));
	else await handleDepsApply(repairCommand(tool), previewId!);
}

// deps update <revision> --preview, or deps update <revision> --apply
// <previewId>. Only the requirements revision packaged in this build is
// admitted; the check precedes any state read, and the input is never echoed.
async function handleDepsUpdate(args: readonly string[]): Promise<void> {
	const identity = args.includes("--apply") ? UPDATE_APPLY : UPDATE_PREVIEW;
	const [revision, flag, previewId] = args;
	const shaped = identity === UPDATE_PREVIEW ? args.length === 2 && flag === "--preview" : args.length === 3 && flag === "--apply" && previewId !== undefined && PREVIEW_ID.test(previewId);
	if (!shaped || revision === undefined || !REVISION_SHAPE.test(revision)) {
		emitRefusal(identity, `${PROGRAM}: usage: ${DEPS_UPDATE_USAGE}`, "USAGE_MALFORMED_ARGUMENTS", `Run ${PROGRAM} deps status to read the admitted requirements revision, then ${PROGRAM} deps update <revision> --preview`, "connectors.deps.status");
		return;
	}
	if (revision !== REQUIREMENTS_REVISION) {
		emitRefusal(identity, `${PROGRAM}: requirements revision is not admitted by this build`, "DOMAIN_DEPS_REVISION_NOT_ADMITTED", `This build admits only requirements revision ${REQUIREMENTS_REVISION}; another revision needs a deliberate Connectors plugin update`, "connectors.deps.status");
		return;
	}
	if (identity === UPDATE_PREVIEW) handleDepsPreview(updateCommand(revision));
	else await handleDepsApply(updateCommand(revision), previewId!);
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

// Each discovered manifest that failed to load, as list and status report it.
function manifestProblems(discovered: readonly DiscoveredManifest[]): { id: string; code: string | undefined; message: string | undefined }[] {
	return discovered.filter((entry) => entry.error !== null).map((entry) => ({ id: entry.id, code: entry.error?.code, message: entry.error?.message }));
}

function handleList(args: readonly string[]): void {
	if (args.length !== 0) {
		usageMalformed("connectors.list", "list");
		return;
	}
	const discovered = discoverManifests(skillsRoot(), ADAPTER_IDS);
	const connectors = discovered
		.filter((entry): entry is typeof entry & { manifest: ConnectorManifest } => entry.manifest !== null)
		.map((entry) => ({ id: entry.manifest.id, adapter: entry.manifest.adapter, keyless: entry.manifest.adapter === null, requirements: entry.manifest.requirements }));
	const problems = manifestProblems(discovered);
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

type ResolvedEntry = { readonly value: unknown; readonly source: string; readonly [detail: string]: unknown };

// Custody provenance (Spec AC24) comes from the connector's own packaged
// adapter, which alone knows its custody state; a manifest's credential
// reference only names a nonsecret item and never makes a mode effective.
// An adapter without resolveCustody reports nothing effective.
function resolvedCustody(manifest: ConnectorManifest, selectors: ResolvedSelectors["values"]): { kind: "resolved"; mode: ResolvedEntry; subject: ResolvedEntry } | Extract<CustodyResolution, { kind: "refused" }> {
	if (manifest.adapter === null) return { kind: "resolved", mode: { value: "keyless", source: "packaged-manifest-default" }, subject: { value: null, source: "not-applicable" } };
	const resolve = ADAPTERS[manifest.adapter]?.resolveCustody;
	// A fresh object per entry: the envelope's JSON-safety check refuses a
	// value reached twice.
	const unresolved = (): ResolvedEntry => ({ value: null, source: "not-yet-effective" });
	if (!resolve) return { kind: "resolved", mode: unresolved(), subject: unresolved() };
	const values = Object.fromEntries(Object.entries(selectors).map(([name, entry]) => [name, entry.value]));
	const resolution = resolve({ manifest, selectors: values, skillsRoot: skillsRoot(), env: process.env });
	if (resolution.kind === "refused") return resolution;
	const { effective, notYetEffective, subject } = resolution;
	const pending = notYetEffective ? { notYetEffective: { value: notYetEffective.mode, source: notYetEffective.source } } : {};
	return {
		kind: "resolved",
		mode: effective ? { value: effective.mode, source: effective.source, ...pending } : { ...unresolved(), ...pending },
		subject: subject ? { value: subject.value, selector: subject.selector, source: subject.source } : { value: null, source: "not-applicable" },
	};
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
	const custody = resolvedCustody(manifest, selectors.values);
	if (custody.kind === "refused") {
		const { connectorCause, repair } = custody.refusal;
		emitAdapterEnvelope({ commandIdentity: "connectors.config.show" }, REFUSAL_CAUSE[custody.refusal.kind], `${PROGRAM}: ${id} could not resolve its custody (${connectorCause})`, { connector: id, connectorCause }, repair, { completed: [], uncertain: [] }, "connectors.auth");
		return;
	}
	const values: Record<string, { value: unknown; source: string }> = {
		connector: { value: manifest.id, source: "invocation" },
		adapter: { value: manifest.adapter ?? "none", source: "packaged-manifest-default" },
		custodyMode: custody.mode,
		"custody:subject": custody.subject,
		transportRegistry: { value: manifest.transportRegistry, source: "packaged-manifest-default" },
		requirements: { value: manifest.requirements, source: "packaged-manifest-default" },
		...dependencies,
		...selectors.values,
	};
	emitSuccess("connectors.config.show", `resolved nonsecret configuration for ${id}`, { connector: id, values }, "connectors.status");
}

// Evidence rows (Spec AC21) come from checks this invocation performs
// locally; bin/evidence-state.ts owns the vocabulary. A required selector
// that was not supplied leaves selection-bound evidence unobserved rather
// than refusing, since status can report an unready connector; a supplied
// selector that is invalid or undeclared refuses. Custody is resolved only
// through the adapter's own metadata-only resolveCustody.
function evidenceRow(manifest: ConnectorManifest, given: ReadonlyMap<string, string>, observedAt: string): { selection: ResolvedSelectors["values"]; evidence: Record<string, unknown> } | { problem: string } {
	const optional = Object.fromEntries(Object.entries(manifest.selectors).map(([name, declaration]) => [name, { ...declaration, required: false }]));
	const selectors = resolveSelectors({ ...manifest, selectors: optional }, given);
	if (selectors.problem) return { problem: selectors.problem };
	const selectionResolved = Object.entries(manifest.selectors).every(([name, declaration]) => !declaration.required || Object.hasOwn(selectors.values, name));
	const adapter = manifest.adapter === null ? undefined : ADAPTERS[manifest.adapter];
	const values = Object.fromEntries(Object.entries(selectors.values).map(([name, entry]) => [name, entry.value]));
	const custody = selectionResolved && adapter?.resolveCustody ? adapter.resolveCustody({ manifest, selectors: values, skillsRoot: skillsRoot(), env: process.env }) : null;
	return { selection: selectors.values, evidence: observeEvidence({ manifest, adapter, selectionResolved, selectors: values, custody, env: process.env, observedAt }) };
}

function parseStatusArgs(args: readonly string[]): { id: string | null; given: Map<string, string> } | null {
	const given = new Map<string, string>();
	if (args.length === 0) return { id: null, given };
	const id = args[0] ?? "";
	if (id.startsWith("--")) return null;
	const rest = args.slice(1);
	return consumeSelections(rest, given) === rest.length ? { id, given } : null;
}

function handleStatus(args: readonly string[]): void {
	const parsed = parseStatusArgs(args);
	if (!parsed) {
		usageMalformed("connectors.status", STATUS_USAGE);
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
	const observedAt = new Date().toISOString();
	if (parsed.id === null) {
		const discovered = discoverManifests(root, ADAPTER_IDS);
		const connectors = discovered.flatMap((entry) => {
			if (entry.manifest === null) return [];
			const row = evidenceRow(entry.manifest, parsed.given, observedAt);
			return "problem" in row ? [] : [{ id: entry.id, ...row }];
		});
		// No selection is supplied here, and a manifest's packaged defaults are
		// validated with it, so evidenceRow reports no problem for a loaded one.
		const problems = manifestProblems(discovered);
		emitSuccess("connectors.status", `${connectors.length} connector(s) reporting evidence state`, { connectors, problems }, "connectors.doctor");
		return;
	}
	const id = parsed.id;
	let manifest: ConnectorManifest;
	try {
		manifest = loadOneManifest(root, id, ADAPTER_IDS);
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.status", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	const row = evidenceRow(manifest, parsed.given, observedAt);
	if ("problem" in row) {
		emitRefusal("connectors.status", `${PROGRAM}: ${row.problem}`, "SCHEMA_SELECTOR_INVALID", row.problem, "connectors.config.validate");
		return;
	}
	emitSuccess("connectors.status", `evidence state for ${id}`, { connectors: [{ id, ...row }], problems: [] }, "connectors.doctor");
}

// Local readiness report (Spec AC21): after a connector's manifest,
// registry, and packaged requirements validate, doctor reports the same
// locally observed evidence as status. It never exercises a connector's
// adapter, contacts a Provider, or reads a credential, so its success never
// stands for custody, authentication, or live proof.
function handleDoctor(args: readonly string[]): void {
	if (args.length !== 1) {
		usageMalformed("connectors.doctor", "doctor <connector>");
		return;
	}
	const id = args[0] ?? "";
	let manifest: ConnectorManifest;
	try {
		manifest = loadOneManifest(skillsRoot(), id, ADAPTER_IDS);
		loadRequirementsPins(pluginRoot());
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.doctor", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	// doctor takes no selection, and packaged defaults always resolve, so a
	// selector problem cannot arise here.
	const row = evidenceRow(manifest, new Map(), new Date().toISOString());
	const evidence = "problem" in row ? {} : row.evidence;
	emitSuccess("connectors.doctor", `${id} declared configuration validated; evidence reports local readiness`, { connector: id, ...evidence }, "connectors.status");
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
	const attempt = await ADAPTERS[manifest.adapter]?.attemptAuth?.(manifest);
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
	emitFixtureSuccess(manifest);
}

// A fixture success is retained for status as fixtureTested only (Spec AC21).
// The record is a declared local effect; one that could not be kept is
// reported in data and claims no effect.
function emitFixtureSuccess(manifest: ConnectorManifest): void {
	const id = manifest.id;
	const message = `${id} fixture auth succeeded`;
	const data = { connector: id, outcome: "success", fixtureTested: true };
	const retained = retainFixtureObservation(manifest, process.env, new Date());
	if (retained.kind === "not-retained") {
		emitSuccess("connectors.fixtureAuth", message, { ...data, observation: { state: "fixtureTested", retained: false, cause: retained.reason } }, "connectors.status");
		return;
	}
	const observation = { state: "fixtureTested", retained: true, observedAt: retained.observedAt, validUntil: retained.validUntil };
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.fixtureAuth",
			outcome: "success",
			failureClass: null,
			exitCode: 0,
			data: { ...data, observation },
			retryable: false,
			repairAction: null,
			nextAction: "connectors.status",
			effectClass: "repository-local",
			transactionState: "completed",
			causeCode: "SUCCESS_FIXTURE_OBSERVED",
			effects: { completed: [EVIDENCE_OBSERVATION], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

// A keyless connector fetches schema directly. A connector with a packaged
// adapter reads it through the adapter transport, like run, with its
// declared selectors.
async function handleSchema(args: readonly string[]): Promise<void> {
	const command = parseSchemaArgs(args);
	if (!command) {
		usageMalformed("connectors.schema", SCHEMA_USAGE);
		return;
	}
	let manifest: ConnectorManifest;
	try {
		manifest = loadOneManifest(skillsRoot(), command.id, ADAPTER_IDS);
	} catch (error) {
		if (error instanceof ManifestError) {
			emitRefusal("connectors.schema", `${PROGRAM}: ${error.message}`, manifestErrorCause(error), "Run config validate to see the exact defect", "connectors.config.validate");
			return;
		}
		throw error;
	}
	if (manifest.adapter !== null) {
		await runAdapterCommand(command, manifest);
		return;
	}
	// Keyless schema selects nothing, so it takes no selector, as before.
	if (command.given.size > 0) {
		usageMalformed("connectors.schema", SCHEMA_USAGE);
		return;
	}
	await handleKeylessSchema(command.id, manifest);
}

async function handleKeylessSchema(id: string, manifest: ConnectorManifest): Promise<void> {
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

function emitSelectionFailure(selection: Extract<Awaited<ReturnType<typeof ensureMcporter>>, { ok: false }>, commandIdentity = "connectors.schema"): void {
	bootstrapCompleted = selection.bootstrapped === true;
	recoveryCompleted = selection.recovered === true;
	if (selection.uncertain) {
		emit({ envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message: `${PROGRAM}: MCPorter recovery outcome requires inspection`, availablePaths: AVAILABLE_PATHS,
			result: { runId: runId(), commandIdentity, outcome: "failed", failureClass: "internal", exitCode: 1,
				data: null, retryable: false, repairAction: selection.cause === "selection-lock-failed" ? selection.repair : "Inspect current and previous MCPorter revisions before retrying", nextAction: "connectors.doctor",
				effectClass: "repository-local", transactionState: "unknown", causeCode: "INTERNAL_MCPORTER_SELECTION_UNKNOWN",
				effects: { completed: recoveryCompleted ? ["mcporter-recovery"] : [], remaining: [], uncertain: [recoveryCompleted ? "mcporter-repair" : "mcporter-recovery"], inventoryComplete: true } } });
		return;
	}
	// A first-use refusal has no selection for the repair preview to replace.
	const nextAction = selection.firstUse === "retry" ? commandIdentity : selection.firstUse === "handoff" || selection.cause === "state-invalid" ? "connectors.doctor" : "connectors.deps.repair.preview";
	emitRefusal(commandIdentity, `${PROGRAM}: MCPorter ${selection.cause}`, bootstrapCompleted ? "DOMAIN_MCPORTER_REPAIR_AFTER_BOOTSTRAP" : recoveryCompleted ? "DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY" : "DOMAIN_MCPORTER_REPAIR_REQUIRED", selection.repair, nextAction, bootstrapCompleted, recoveryCompleted);
}

// Runs MCPorter with stdin closed. Both pipes must drain concurrently:
// awaiting only stdout+exited while stderr sits unread lets a noisy child fill
// the OS pipe buffer, block on its own write, and never reach exit. The
// drained stderr text is deliberately discarded, never echoed into this
// command's own envelope or stderr.
async function runDrained(argv: readonly string[], env: Record<string, string>): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { stdout, exitCode };
}

// The transient provider cause after this invocation's MCPorter selection.
function transientCause(): CauseCode {
	return bootstrapCompleted ? "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP" : recoveryCompleted ? "TRANSIENT_PROVIDER_AFTER_RECOVERY" : "TRANSIENT_PROVIDER_UNREACHABLE";
}

async function fetchKeylessSchema(id: string, registryPath: string, server: string, allowedTools: readonly string[]): Promise<void> {
	// Matches bin/provider-route.ts's own guarded MCPorter invocation exactly:
	// a scrubbed environment (only the safe allow-list crosses, plus the
	// keepalive suppression), mcporter resolved only through that same
	// explicit PATH value (never the raw ambient environment/PATH a second,
	// unguarded resolution could pick up), and a forced --no-oauth so this
	// keyless-only command can never fall into an interactive auth prompt.
	const routeEnv: Record<string, string> = { MCPORTER_NO_KEEPALIVE: "*", ...safeEnvironment(process.env) };
	// The keyless root is configuration: it refuses before any MCPorter
	// selection, bootstrap, or child.
	const dataRoot = ownKeylessDataRoot(process.env);
	if (dataRoot === null) {
		emitSelectionFailure(KEYLESS_ROOT_INVALID);
		return;
	}
	const selection = await ensureMcporter(process.env);
	if (!selection.ok) {
		emitSelectionFailure(selection);
		return;
	}
	bootstrapCompleted = selection.bootstrapped;
	recoveryCompleted = selection.recovered === true;
	const before = dataRoot.vaultStamp();
	const { stdout, exitCode } = await runDrained([selection.binary, "--config", registryPath, "list", server, "--json", "--no-oauth"], { ...routeEnv, ...dataRoot.env });
	const effects = { completed: [...completedSelectionEffects(), ...vaultChange(dataRoot, before)], uncertain: [] };
	if (exitCode !== 0) {
		// Every generic failure stays transient, as before; readCause only adds
		// the observed vault change to it.
		emitAdapterEnvelope({ commandIdentity: "connectors.schema" }, readCause(effects.completed, "offline"), `${PROGRAM}: ${id} schema fetch did not complete`, null, "Retry the schema request", effects, "connectors.doctor");
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = { raw: stdout };
	}
	emitAdapterEnvelope({ commandIdentity: "connectors.schema" }, readSuccessCause(effects.completed), `schema evidence fetched for ${id}`, { connector: id, server, allowedTools, schema: parsed }, null, effects, "connectors.status");
}

// An invalid keyless root is invalid MCPorter state: the same refusal as an
// invalid selection root, reached before selection.
const KEYLESS_ROOT_INVALID: SelectionFailure = { ok: false, cause: "state-invalid", repair: "The keyless MCPorter data root under the Connectors state root is not a private directory you own; move that entry aside, then retry" };

// MCPorter's own vault file in the keyless root, observed on disk.
function vaultChange(dataRoot: KeylessDataRoot, before: string | null): LocalEffect[] {
	return dataRoot.vaultStamp() === before ? [] : ["mcporter-vault-file"];
}

// Packaged adapter auth, run, and schema (Spec AC19, AC20). The core parses, loads the
// manifest, resolves selectors, asks the adapter for a plan, selects the
// verified MCPorter, lets the adapter commit its own state, then runs the plan.
// It never names a connector, and no refusal here echoes caller input.

// schema is the core's own action: an adapter answers it through
// prepareSchema, never through prepare.
// write and recover are the core's journaled-write actions: an adapter
// answers them through prepareWrite and prepareRecover.
type CommandAction =
	| AdapterAction
	| { readonly kind: "schema" }
	| { readonly kind: "write"; readonly operation: string; readonly input: Readonly<Record<string, unknown>> | null; readonly phase: WritePhase }
	| { readonly kind: "recover"; readonly runId: string | null; readonly recovery: Recovery };

type AdapterCommandIdentity = "connectors.auth" | "connectors.run" | "connectors.run.preview" | "connectors.run.apply" | "connectors.schema" | "connectors.recover" | "connectors.recover.adjudicate" | "connectors.recover.unlock";

interface AdapterCommand {
	readonly commandIdentity: AdapterCommandIdentity;
	readonly id: string;
	readonly given: ReadonlyMap<string, string>;
	readonly action: CommandAction;
}

type TransportPlan = Extract<Prepared, { kind: "transport" }>;



// Returns the index of the first token after the leading --select pairs, or
// null for a malformed or conflicting selection.
function consumeSelections(rest: readonly string[], given: Map<string, string>): number | null {
	let index = 0;
	while (rest[index] === "--select") {
		const valueIndex = consumeSelectToken(rest, index, given);
		if (valueIndex === null) return null;
		index = valueIndex + 1;
	}
	return index;
}

// The closed login options, accepted in any order among the selectors after
// `auth login` only; --input <json-object>, at most once, after
// `auth configure` only. Anything else, --json included, is malformed.
const LOGIN_OPTIONS: ReadonlyMap<string, LoginOption> = new Map([["--no-browser", "no-browser"], ["--reset", "reset"]]);
const LOGIN_OPTION_ORDER: readonly LoginOption[] = ["no-browser", "reset"];

interface AuthOptions {
	readonly login: Set<LoginOption>;
	input: Readonly<Record<string, unknown>> | null;
}

// The count of verb-only option tokens at rest[index]: 0 when none is
// there, null when one is malformed or repeated.
function consumeAuthOption(verb: string, rest: readonly string[], index: number, options: AuthOptions): number | null {
	const token = rest[index] ?? "";
	const option = verb === "login" ? LOGIN_OPTIONS.get(token) : undefined;
	if (option) {
		options.login.add(option);
		return 1;
	}
	if (verb !== "configure" || token !== "--input") return 0;
	if (options.input !== null) return null;
	options.input = parseInputObject(rest[index + 1]);
	return options.input === null ? null : 2;
}

function parseAuthArgs(args: readonly string[]): AdapterCommand | null {
	const [verb, id, ...rest] = args;
	if (!verb || !AUTH_VERBS.has(verb) || !id) return null;
	const given = new Map<string, string>();
	const options: AuthOptions = { login: new Set(), input: null };
	let index = 0;
	while (index < rest.length) {
		const consumed = consumeAuthOption(verb, rest, index, options);
		if (consumed === null) return null;
		const at = consumed > 0 ? consumed : consumeSelections(rest.slice(index), given);
		if (!at) return null;
		index += at;
	}
	return { commandIdentity: "connectors.auth", id, given, action: { kind: "auth", verb, loginOptions: LOGIN_OPTION_ORDER.filter((name) => options.login.has(name)), input: options.input } };
}

// A login repair repeats the caller's login options, which are closed names
// and never values.
function loginFlags(command: AdapterCommand): string {
	return command.action.kind === "auth" ? command.action.loginOptions.map((option) => ` --${option}`).join("") : "";
}

function parseSchemaArgs(args: readonly string[]): AdapterCommand | null {
	const [id, ...rest] = args;
	const given = new Map<string, string>();
	if (!id || consumeSelections(rest, given) !== rest.length) return null;
	return { commandIdentity: "connectors.schema", id, given, action: { kind: "schema" } };
}

function parseInputObject(text: string | undefined): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text ?? "");
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

interface RunOptions {
	readonly input: Readonly<Record<string, unknown>> | null;
	readonly phase: WritePhase | null;
}

// The options after a run operation, in any order: --input <json-object>, and
// at most one of --preview or --apply <previewId>, each at most once.
function parseRunOptions(after: readonly string[]): RunOptions | null {
	let input: Readonly<Record<string, unknown>> | null = null;
	let phase: WritePhase | null = null;
	let index = 0;
	while (index < after.length) {
		const token = after[index];
		const value = after[index + 1];
		if (token === "--preview" && phase === null) {
			phase = { kind: "preview" };
			index += 1;
		} else if (token === "--input" && input === null) {
			input = parseInputObject(value);
			if (input === null) return null;
			index += 2;
		} else if (token === "--apply" && phase === null && value !== undefined && !value.startsWith("-")) {
			phase = { kind: "apply", previewId: value };
			index += 2;
		} else {
			return null;
		}
	}
	return { input, phase };
}

function parseRunArgs(args: readonly string[]): AdapterCommand | null {
	const [id, ...rest] = args;
	const given = new Map<string, string>();
	const at = consumeSelections(rest, given);
	const operation = at === null ? undefined : rest[at];
	if (!id || at === null || !operation || operation.startsWith("-")) return null;
	const options = parseRunOptions(rest.slice(at + 1));
	if (options === null) return null;
	const { input, phase } = options;
	if (phase === null) return { commandIdentity: "connectors.run", id, given, action: { kind: "run", operation, input } };
	return { commandIdentity: phase.kind === "preview" ? "connectors.run.preview" : "connectors.run.apply", id, given, action: { kind: "write", operation, input, phase } };
}

const RECOVERY_IDENTITY: Readonly<Record<Recovery["kind"], AdapterCommandIdentity>> = { inspect: "connectors.recover", adjudicate: "connectors.recover.adjudicate", unlock: "connectors.recover.unlock" };

function parseRecovery(tail: readonly string[]): Recovery | null {
	if (tail.length === 0) return { kind: "inspect" };
	if (tail.length === 1 && tail[0] === "--unlock") return { kind: "unlock" };
	const input = tail.length === 3 && tail[0] === "--adjudicate" && tail[1] === "--input" ? parseInputObject(tail[2]) : null;
	return input === null ? null : { kind: "adjudicate", input };
}

// Without --run, recover lists; --run names one receipt, and only with it
// may --adjudicate or --unlock follow.
function parseRecoverArgs(args: readonly string[]): AdapterCommand | null {
	const [id, ...rest] = args;
	const given = new Map<string, string>();
	const at = consumeSelections(rest, given);
	if (!id || at === null) return null;
	const [flag, runId, ...tail] = rest.slice(at);
	if (flag === undefined) return { commandIdentity: "connectors.recover", id, given, action: { kind: "recover", runId: null, recovery: { kind: "inspect" } } };
	const recovery = flag === "--run" && runId !== undefined && !runId.startsWith("-") ? parseRecovery(tail) : null;
	return recovery === null || runId === undefined ? null : { commandIdentity: RECOVERY_IDENTITY[recovery.kind], id, given, action: { kind: "recover", runId, recovery } };
}

function emitAdapterEnvelope(command: { readonly commandIdentity: string }, causeCode: CauseCode, message: string, data: Record<string, unknown> | null, repairAction: string | null, effects: { completed: string[]; uncertain: string[] }, nextAction?: string): void {
	const row = ADMITTED_CAUSE_ROWS[causeCode];
	emit({
		envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message, availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(), commandIdentity: command.commandIdentity, outcome: row.outcome, failureClass: row.failureClass,
			exitCode: row.exitCode, data, retryable: row.retryable, repairAction,
			nextAction: nextAction ?? (row.outcome === "success" ? "connectors.status" : "connectors.help"),
			effectClass: row.effectClass, transactionState: row.transactionState, causeCode,
			effects: { completed: effects.completed, remaining: [], uncertain: effects.uncertain, inventoryComplete: true },
		},
	});
}

// After a MCPorter bootstrap or recovery, or a local effect the adapter's
// commit caused, a refusal still reports that completed effect.
function emitAdapterRefusal(command: AdapterCommand, refusal: AdapterRefusal, local: readonly LocalEffect[] = []): void {
	const completed = [...completedSelectionEffects(), ...local];
	const causeCode = completed.length > 0 ? "DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION" : REFUSAL_CAUSE[refusal.kind];
	emitAdapterEnvelope(command, causeCode, `${PROGRAM}: ${command.id} refused the request (${refusal.connectorCause})`, { connector: command.id, connectorCause: refusal.connectorCause }, refusal.repair, { completed, uncertain: [] });
}

function loadAdapterManifest(command: AdapterCommand): ConnectorManifest | null {
	try {
		return loadOneManifest(skillsRoot(), command.id, ADAPTER_IDS);
	} catch (error) {
		if (!(error instanceof ManifestError)) throw error;
		emitRefusal(command.commandIdentity, `${PROGRAM}: the connector manifest could not be loaded (${error.code})`, manifestErrorCause(error), "Run connectors list, then config validate for the connector", "connectors.list");
		return null;
	}
}

function prepareThroughAdapter(command: AdapterCommand, manifest: ConnectorManifest): Prepared | null {
	const adapter = manifest.adapter === null ? undefined : ADAPTERS[manifest.adapter];
	if (!adapter) {
		emitRefusal(command.commandIdentity, `${PROGRAM}: ${command.id} declares no packaged adapter`, "DOMAIN_ADAPTER_NOT_DECLARED", "Use a connector whose manifest declares a packaged adapter", "connectors.list");
		return null;
	}
	if (command.action.kind === "schema" && !adapter.prepareSchema) {
		emitRefusal("connectors.schema", `${PROGRAM}: ${command.id} needs a declared credential; its packaged adapter has no schema step`, "DOMAIN_CUSTODY_NOT_SUPPORTED", "Use doctor to check local readiness; this connector's adapter does not read live schema", "connectors.doctor");
		return null;
	}
	const selectors = resolveSelectors(manifest, command.given);
	if (selectors.problem) {
		const required = Object.entries(manifest.selectors).filter(([, declaration]) => declaration.required && declaration.default === undefined).map(([name]) => name);
		emitRefusal(command.commandIdentity, `${PROGRAM}: the selectors for ${command.id} do not match its manifest`, "SCHEMA_SELECTOR_INVALID", `Run connectors config show ${command.id} --resolved --json${selectPlaceholders(required)} to see its declared selectors`, "connectors.config.show");
		return null;
	}
	const values = Object.fromEntries(Object.entries(selectors.values).map(([name, entry]) => [name, entry.value]));
	return prepareAction(adapter, command.action, { manifest, selectors: values, skillsRoot: skillsRoot(), env: process.env });
}

// An adapter without journaled writes refuses them through the catalogue.
const NO_WRITES: Prepared = { kind: "refused", refusal: { kind: "domain", connectorCause: "adapter-has-no-writes", repair: "Use a connector whose packaged adapter supports preview, apply, and recover" } };

function prepareAction(adapter: Adapter, action: CommandAction, request: SchemaRequest): Prepared {
	if (action.kind === "write") return adapter.prepareWrite ? adapter.prepareWrite({ ...request, operation: action.operation, input: action.input, phase: action.phase }) : NO_WRITES;
	if (action.kind === "recover") return adapter.prepareRecover ? adapter.prepareRecover({ ...request, runId: action.runId, recovery: action.recovery }) : NO_WRITES;
	if (action.kind === "schema" && adapter.prepareSchema) return adapter.prepareSchema(request);
	if (action.kind === "schema" || !adapter.prepare) {
		const kind = action.kind === "auth" ? "verb-unsupported" : "operation-unknown";
		return { kind: "refused", refusal: { kind, connectorCause: "adapter-has-no-prepare", repair: "Use a connector whose packaged adapter supports auth and run" } };
	}
	return adapter.prepare({ ...request, action });
}

// Attended login writes MCPorter's browser prompts to the user's terminal, so
// stdout keeps exactly one envelope. Without a terminal it refuses.
function openTerminal(): number | null {
	if (!process.stdin.isTTY) return null;
	try {
		return openSync("/dev/tty", "r+");
	} catch {
		return null;
	}
}

type ReadFailure = "offline" | "unclassified" | null;

// A read reports the selection effect, then what commit created, then what
// the adapter observed MCPorter change in its state.
function readCause(completed: readonly string[], failure: ReadFailure): CauseCode {
	if (failure === null) return readSuccessCause(completed);
	if (failure === "unclassified") return completed.length > 0 ? "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT" : "DOMAIN_PROVIDER_CALL_FAILED";
	return bootstrapCompleted || recoveryCompleted ? transientCause() : completed.length > 0 ? "TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT" : "TRANSIENT_PROVIDER_UNREACHABLE";
}

function readSuccessCause(completed: readonly string[]): CauseCode {
	if (bootstrapCompleted) return "SUCCESS_BOOTSTRAPPED";
	if (recoveryCompleted) return "SUCCESS_MCPORTER_RECOVERED";
	if (completed.some((effect) => ACCOUNT_EFFECT_ORDER.includes(effect))) return "SUCCESS_AFTER_ACCOUNT_EFFECT";
	return completed.includes(EVIDENCE_OBSERVATION) ? "SUCCESS_READ_OBSERVED" : "SUCCESS_UNCHANGED";
}

// MCPorter 0.14.0's `call --output json` failure prints one JSON object whose
// issue.kind is one of auth, http, stdio-exit, offline, or other. Only a
// positively offline issue is retryable. Every other kind, and output that
// does not parse, fails closed until a live station qualifies a finer mapping.
// Only that one key is read; no MCPorter text reaches the envelope.
function readFailure(stdout: string): ReadFailure {
	try {
		const issue: unknown = (JSON.parse(stdout) as { issue?: unknown } | null)?.issue;
		return typeof issue === "object" && issue !== null && (issue as { kind?: unknown }).kind === "offline" ? "offline" : "unclassified";
	} catch {
		return "unclassified";
	}
}

// A repair command names selectors, never a value, so it stays runnable
// without echoing an account or tenant back. Names come from the caller only
// after resolveSelectors admitted them, or from the manifest itself.
function selectPlaceholders(names: Iterable<string>): string {
	return [...names].map((name) => ` --select ${name}=<value>`).join("");
}

function selectFlags(command: AdapterCommand): string {
	return selectPlaceholders(command.given.keys());
}

// After a keyless read succeeds, its hosted observation is retained for
// status (Spec AC21). The retained record is a declared local effect; a
// record that could not be kept is reported in data and claims no effect. A
// plan without a hostedRead, or an origin the record owner does not admit,
// retains nothing and reports nothing.
function retainRead(command: AdapterCommand, plan: TransportPlan, manifest: ConnectorManifest, completed: string[]): Record<string, unknown> {
	if (!plan.hostedRead || (command.action.kind !== "schema" && command.action.kind !== "run")) return {};
	const kind = command.action.kind === "run" ? "read" : "schema";
	const selectors = resolveSelectors(manifest, command.given);
	const values = Object.fromEntries(Object.entries(selectors.values).map(([name, entry]) => [name, entry.value]));
	const operation = command.action.kind === "run" ? command.action.operation : null;
	const retained = retainObservation({ manifest, kind, operation, hostedRead: plan.hostedRead, selectors: values, env: process.env, observedAt: new Date() });
	if (retained.kind === "not-admitted") return {};
	const state = kind === "schema" ? "schemaQualified" : "liveReadProven";
	if (retained.kind === "not-retained") return { observation: { state, retained: false, cause: retained.reason } };
	completed.push(EVIDENCE_OBSERVATION);
	return { observation: { state, retained: true, observedAt: retained.observedAt, validUntil: retained.validUntil } };
}

async function runRead(command: AdapterCommand, plan: TransportPlan, manifest: ConnectorManifest, binary: string, local: readonly LocalEffect[]): Promise<void> {
	const { stdout, exitCode } = await runDrained([binary, ...plan.argv], { ...plan.env });
	const completed: string[] = [...completedSelectionEffects(), ...local, ...plan.settle()];
	const effects = { completed, uncertain: [] };
	if (exitCode !== 0) {
		const failure = readFailure(stdout);
		emitAdapterEnvelope(command, readCause(completed, failure), `${PROGRAM}: ${command.id} provider call did not complete`, null, readRepair(command, failure), effects, "connectors.auth");
		return;
	}
	let result: unknown;
	try {
		result = JSON.parse(stdout);
	} catch {
		result = { raw: stdout };
	}
	const observation = retainRead(command, plan, manifest, completed);
	if (command.action.kind !== "run") {
		emitAdapterEnvelope(command, readCause(completed, null), `schema evidence fetched for ${command.id}`, { connector: command.id, ...plan.data, schema: result, ...observation }, null, effects);
		return;
	}
	emitAdapterEnvelope(command, readCause(completed, null), `${command.id} ${command.action.operation} completed`, { connector: command.id, operation: command.action.operation, ...plan.data, result, ...observation }, null, effects);
}

function readRepair(command: AdapterCommand, failure: ReadFailure): string {
	const selectors = selectFlags(command);
	const request = command.action.kind === "run" ? "run" : "schema request";
	if (failure === "offline") return `Retry the ${request}; if it keeps failing, run connectors auth status ${command.id}${selectors}`;
	const correction = command.action.kind === "run" ? "correct the operation or its --input before running again" : `run connectors auth status ${command.id}${selectors} before retrying`;
	return `If the grant expired, run connectors auth login ${command.id}${selectors} yourself in a terminal; otherwise ${correction}`;
}

async function runAttendedLogin(command: AdapterCommand, plan: TransportPlan, binary: string, terminal: number, local: readonly LocalEffect[]): Promise<void> {
	const proc = Bun.spawn([binary, ...plan.argv], { env: { ...plan.env }, stdin: terminal, stdout: terminal, stderr: terminal });
	const exitCode = await proc.exited;
	// MCPorter may write its vault file whether or not consent completed.
	const completed = [...completedSelectionEffects(), ...local, ...plan.settle()];
	const data = { connector: command.id, verb: "login", ...plan.data };
	if (exitCode === 0) {
		emitAdapterEnvelope(command, "SUCCESS_AUTH_LOGIN", `${PROGRAM}: ${command.id} attended login completed`, data, null, { completed: [...completed, "account-grant"], uncertain: [] });
		return;
	}
	emitAdapterEnvelope(command, "DOMAIN_AUTH_LOGIN_UNKNOWN", `${PROGRAM}: ${command.id} attended login did not complete`, data, `Run connectors auth status ${command.id}${selectFlags(command)} to inspect the account vault before retrying login`, { completed, uncertain: ["account-grant"] });
}

async function runTransport(command: AdapterCommand, plan: TransportPlan, manifest: ConnectorManifest, terminal: number | null): Promise<void> {
	const routed = keylessTransport(plan);
	if (routed === null) {
		emitSelectionFailure(KEYLESS_ROOT_INVALID, command.commandIdentity);
		return;
	}
	const selection = await ensureMcporter(process.env);
	if (!selection.ok) {
		emitSelectionFailure(selection, command.commandIdentity);
		return;
	}
	bootstrapCompleted = selection.bootstrapped;
	recoveryCompleted = selection.recovered === true;
	const committed = routed.commit();
	if (committed.refusal) {
		emitAdapterRefusal(command, committed.refusal, committed.completed);
		return;
	}
	if (terminal === null) await runRead(command, routed, manifest, selection.binary, committed.completed);
	else await runAttendedLogin(command, routed, selection.binary, terminal, committed.completed);
}

// An adapter that owns an MCPorter vault names its data root in the plan
// (Canva's per-account vault). The shared route never passes one through, so
// every other transport plan is keyless and runs in the owned keyless root,
// with MCPorter's vault-file change there settled as an observed effect.
// It runs before MCPorter selection; an adapter's own commit still runs
// after it. null when that root is invalid.
function keylessTransport(plan: TransportPlan): TransportPlan | null {
	if (plan.env.XDG_DATA_HOME !== undefined) return plan;
	const dataRoot = ownKeylessDataRoot(process.env);
	if (dataRoot === null) return null;
	const before = dataRoot.vaultStamp();
	return { ...plan, env: { ...plan.env, ...dataRoot.env }, settle: () => [...plan.settle(), ...vaultChange(dataRoot, before)] };
}

async function handleAdapterCommand(command: AdapterCommand | null, usage: string, commandIdentity: AdapterCommand["commandIdentity"]): Promise<void> {
	if (!command) {
		usageMalformed(commandIdentity, usage);
		return;
	}
	const manifest = loadAdapterManifest(command);
	if (manifest) await runAdapterCommand(command, manifest);
}

async function runAdapterCommand(command: AdapterCommand, manifest: ConnectorManifest): Promise<void> {
	const prepared = prepareThroughAdapter(command, manifest);
	if (!prepared) return;
	if (prepared.kind === "refused") {
		emitAdapterRefusal(command, prepared.refusal);
		return;
	}
	if (prepared.kind === "inspected") {
		emitSuccess(command.commandIdentity, `${command.id} inspection completed`, { connector: command.id, ...prepared.data }, "connectors.status");
		return;
	}
	if (prepared.kind === "execute") {
		await runExecution(command, manifest, prepared);
		return;
	}
	// A journaled write answers only with an execute plan, whose outcome names
	// its effects; any other plan is an adapter defect, reported before any effect.
	if (command.action.kind === "write" || command.action.kind === "recover") throw new Error("adapter planned a journaled write without an execute step");
	// Only an auth verb may reach browser consent; any other attended plan is
	// an adapter defect, reported as an internal failure before any effect.
	if (prepared.effect === "attended-login" && command.action.kind !== "auth") throw new Error("adapter planned attended login outside auth");
	const terminal = prepared.effect === "attended-login" ? openTerminal() : null;
	if (prepared.effect === "attended-login" && terminal === null) {
		emitAdapterEnvelope(command, "DOMAIN_ATTENDED_REQUIRED", `${PROGRAM}: ${command.id} login needs an attended terminal`, { connector: command.id }, `Run connectors auth login ${command.id}${selectFlags(command)}${loginFlags(command)} yourself in a terminal; an agent cannot complete browser consent`, { completed: [], uncertain: [] });
		return;
	}
	try {
		await runTransport(command, prepared, manifest, terminal);
	} finally {
		if (terminal !== null) closeSync(terminal);
	}
}

type Selection = Awaited<ReturnType<typeof ensureMcporter>>;
type SelectionFailure = Extract<Selection, { ok: false }>;

// The capabilities an execute step receives. MCPorter is selected lazily and
// at most once, so a step that never needs it (a custody check) bootstraps
// nothing; a failed selection is remembered for the core to render.
function executionCapabilities(manifest: ConnectorManifest, failure: { value: SelectionFailure | null }): ExecutionCapabilities {
	let selected: Promise<string | null> | undefined;
	const select = async (): Promise<string | null> => {
		const selection = await ensureMcporter(process.env);
		if (!selection.ok) {
			failure.value = selection;
			return null;
		}
		bootstrapCompleted = selection.bootstrapped;
		recoveryCompleted = selection.recovered === true;
		return selection.binary;
	};
	return {
		selectMcporter: () => (selected ??= select()),
		internalCommand: (role) => [process.execPath, "__internal", manifest.adapter ?? "", role],
	};
}

// The command after a recorded effect: apply follows a preview, and a custody
// check follows a published registration.
const RECORDED_NEXT: Partial<Readonly<Record<RecordedEffect, string>>> = { "write-preview": "connectors.run.apply", "custody-registration": "connectors.auth" };

// An execute step owns no connector account effect: its inventory is this
// invocation's MCPorter selection effect, then the journaled-write effects its
// outcome names.
function emitExecuted(command: AdapterCommand, executed: Executed): void {
	const completed = completedSelectionEffects();
	const data = (extra: Record<string, unknown>) => ({ connector: command.id, ...extra });
	switch (executed.kind) {
		case "refused":
			emitAdapterRefusal(command, executed.refusal);
			return;
		case "failed":
			emitAdapterEnvelope(command, completed.length > 0 ? "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT" : "DOMAIN_PROVIDER_CALL_FAILED", `${PROGRAM}: ${command.id} provider call did not complete (${executed.connectorCause})`, null, executed.repair, { completed, uncertain: [] }, "connectors.auth");
			return;
		case "success":
			emitAdapterEnvelope(command, readSuccessCause([]), `${command.id}${operationLabel(command)} completed`, data(executed.data), null, { completed, uncertain: [] });
			return;
		case "recorded":
			emitAdapterEnvelope(command, "SUCCESS_RUN_RECORDED", `${command.id}${operationLabel(command)} recorded ${executed.effect}`, data(executed.data), null, { completed: [...completed, executed.effect], uncertain: [] }, RECORDED_NEXT[executed.effect]);
			return;
		case "applied":
			emitAdapterEnvelope(command, "SUCCESS_RUN_APPLIED", `${command.id}${operationLabel(command)} applied`, data(executed.data), null, { completed: [...completed, "write-receipt", "provider-write"], uncertain: [] });
			return;
		case "effect-unknown":
			emitAdapterEnvelope(command, "DOMAIN_RUN_EFFECT_UNKNOWN", `${PROGRAM}: ${command.id}${operationLabel(command)} may have reached the Provider; its effect is unknown`, data(executed.data), executed.repair, { completed: [...completed, "write-receipt"], uncertain: ["provider-write"] }, "connectors.recover");
			return;
		case "failed-after-record":
			emitAdapterEnvelope(command, "DOMAIN_RUN_FAILED_RECORDED", `${PROGRAM}: ${command.id}${operationLabel(command)} did not change the Provider (${executed.connectorCause})`, data({ connectorCause: executed.connectorCause, ...executed.data }), executed.repair, { completed: [...completed, "write-receipt"], uncertain: [] }, "connectors.recover");
	}
}

// The adapter admitted the operation before any effect, so naming it echoes
// no caller value it did not declare.
function operationLabel(command: AdapterCommand): string {
	return command.action.kind === "run" || command.action.kind === "write" ? ` ${command.action.operation}` : "";
}

async function runExecution(command: AdapterCommand, manifest: ConnectorManifest, prepared: Extract<Prepared, { kind: "execute" }>): Promise<void> {
	const failure: { value: SelectionFailure | null } = { value: null };
	const executed = await prepared.execute(executionCapabilities(manifest, failure));
	// Nothing was sent without a selected binary, so the selection failure is
	// the whole answer and the adapter's own result is not reported. An
	// outcome naming a journal or Provider effect contradicts that.
	if (failure.value) {
		if (executed.kind !== "success" && executed.kind !== "refused" && executed.kind !== "failed") throw new Error("an execute step reported an effect without a selected MCPorter");
		emitSelectionFailure(failure.value, command.commandIdentity);
		return;
	}
	emitExecuted(command, executed);
}

// The one entry into an adapter's internal role. It is reachable only with a
// valid internal invocation context and a role the packaged adapter
// registered; anything else is an ordinary unknown command. The context is a
// guard against accidental and agent-documented use, not a security boundary
// against the same local user.
function internalRole(args: readonly string[]): InternalRole | null {
	const [marker, adapterId = "", roleName = ""] = args;
	if (marker !== "__internal" || !validInternalContext(process.env[INTERNAL_INVOCATION_CONTEXT_ENV])) return null;
	const roles = Object.hasOwn(ADAPTERS, adapterId) ? ADAPTERS[adapterId]?.internalRoles : undefined;
	return roles && Object.hasOwn(roles, roleName) ? (roles[roleName] ?? null) : null;
}

const UNSUPPORTED_COMMAND = `${PROGRAM}: unsupported command. Run with --discover --json to see available commands.`;

async function dispatchDeps(args: readonly string[]): Promise<void> {
	if (args[0] === "status") handleDepsStatus(args.slice(1));
	else if (args[0] === "repair") await handleDepsRepair(args.slice(1));
	else if (args[0] === "update") await handleDepsUpdate(args.slice(1));
	else refuse(UNSUPPORTED_COMMAND);
}

async function dispatchCommand(args: readonly string[]): Promise<void> {
	if (args[0] === "auth") {
		await handleAdapterCommand(parseAuthArgs(args.slice(1)), AUTH_USAGE, "connectors.auth");
		return;
	}
	if (args[0] === "run") {
		await handleAdapterCommand(parseRunArgs(args.slice(1)), RUN_USAGE, "connectors.run");
		return;
	}
	if (args[0] === "recover") {
		await handleAdapterCommand(parseRecoverArgs(args.slice(1)), RECOVER_USAGE, "connectors.recover");
		return;
	}
	if (args[0] === "deps") {
		await dispatchDeps(args.slice(1));
		return;
	}
	if (args[0] === "setup") {
		await handleSetup(args.slice(1));
		return;
	}
	if (args[0] === "list") {
		handleList(args.slice(1));
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
	refuse(UNSUPPORTED_COMMAND);
}

// The one line an internal role that throws writes: a fixed nonsecret cause,
// never the thrown text, which may carry a credential or a path.
const INTERNAL_ROLE_FAILURE = "connectors-internal-role:error:unhandled\n";

// An internal role never emits an envelope, even when it fails: stdout
// belongs to its own protocol, and stderr carries only the fixed cause.
async function runInternalRole(role: InternalRole, argv: readonly string[]): Promise<void> {
	outputStarted = true;
	try {
		await role.run(argv);
	} catch {
		process.stderr.write(INTERNAL_ROLE_FAILURE);
		process.exitCode = 1;
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const role = internalRole(args);
	if (role) {
		await runInternalRole(role, args.slice(3));
		return;
	}
	installSignalStop();
	if (args.length === 2 && args[0] === "--discover" && args[1] === "--json") {
		discover();
		return;
	}
	if (args[0] === "--discover-command") {
		discoverCommand(args.slice(1));
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
