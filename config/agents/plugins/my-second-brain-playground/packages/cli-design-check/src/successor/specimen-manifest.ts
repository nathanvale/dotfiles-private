// Independent oracle: these literals intentionally do not import production
// finding tables, the exemplar schema, or a target catalogue.

export const SUCCESSOR_ROWS = [
	"help-human",
	"help-json",
	"discover-human",
	"discover-json",
	"no-arguments-human",
	"no-arguments-json",
	"unknown-option-human",
	"unknown-option-json",
	"success-human",
	"success-json",
	"missing-input-json",
	"internal-failure-json",
	"schema-refusal-json",
	"transient-refusal-json",
	"target-unchanged",
] as const

export interface FormatCase {
	name: string
	fixture: "successor-conformant" | "successor-broken" | "successor-specimens"
	mutation: string | null
	observedVersion: string | null
	exit: 0 | 4
	causeCode: "SUCCESS_UNCHANGED" | "SCHEMA_INVALID_INPUT" | "SCHEMA_UNSUPPORTED_CONTRACT"
	finding: string | null
	message: string
	repairAction: string | null
}

const SUCCESS_DISCLOSURE = "Checker report: 15/15 passed; 0 failed; skipped rows: malformed-value-json, large-envelope, unauthorized-effect, secret-redaction; observation exclusions: contents of excluded directories: .git, node_modules, out-of-tree paths, referents of symlink entries, reverted effects, runtime contents of non-regular entries; retained stream custody: none."
const FAILURE_DISCLOSURE = "Checker report: 6/15 passed; 9 failed; skipped rows: malformed-value-json, large-envelope, unauthorized-effect, secret-redaction; observation exclusions: contents of excluded directories: .git, node_modules, out-of-tree paths, referents of symlink entries, reverted effects, runtime contents of non-regular entries; retained stream custody: none."

export const FORMAT_CASES: readonly FormatCase[] = [
	{ name: "format-valid-v2", fixture: "successor-conformant", mutation: null, observedVersion: "2.0.0", exit: 0, causeCode: "SUCCESS_UNCHANGED", finding: null, message: `Target contract 2.0.0 accepted. ${SUCCESS_DISCLOSURE}`, repairAction: null },
	{ name: "format-broken-v2", fixture: "successor-broken", mutation: null, observedVersion: "2.0.0", exit: 4, causeCode: "SCHEMA_INVALID_INPUT", finding: "TARGET_SCHEMA_INVALID:result", message: `Target contract 2.0.0 is broken: TARGET_SCHEMA_INVALID:result. ${FAILURE_DISCLOSURE}`, repairAction: "Repair target 2.0.0 field or correlation TARGET_SCHEMA_INVALID:result, then rerun the checker. Inspect the target's effects separately; do not replay it automatically." },
	{ name: "format-v1-short", fixture: "successor-specimens", mutation: "format-v1-short", observedVersion: "1.0", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "1.0" is unsupported legacy format. ${FAILURE_DISCLOSURE}`, repairAction: "Obtain a conforming 2.0.0 producer; no legacy adapter is available." },
	{ name: "format-v1-full", fixture: "successor-specimens", mutation: "format-v1-full", observedVersion: "1.0.0", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "1.0.0" is unsupported legacy format. ${FAILURE_DISCLOSURE}`, repairAction: "Obtain a conforming 2.0.0 producer; no legacy adapter is available." },
	{ name: "format-v1-later", fixture: "successor-specimens", mutation: "format-v1-later", observedVersion: "1.2.3", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "1.2.3" is unsupported legacy format. ${FAILURE_DISCLOSURE}`, repairAction: "Obtain a conforming 2.0.0 producer; no legacy adapter is available." },
	{ name: "format-v0", fixture: "successor-specimens", mutation: "format-v0", observedVersion: "0.9.0", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "0.9.0" is unsupported legacy format. ${FAILURE_DISCLOSURE}`, repairAction: "Obtain a conforming 2.0.0 producer; no legacy adapter is available." },
	{ name: "format-missing", fixture: "successor-specimens", mutation: "format-missing", observedVersion: null, exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version is missing; observed null. ${FAILURE_DISCLOSURE}`, repairAction: "Supply an explicit supported 2.0.0 document." },
	{ name: "format-malformed", fixture: "successor-specimens", mutation: "format-malformed", observedVersion: "2.0 beta", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "2.0 beta" is malformed. ${FAILURE_DISCLOSURE}`, repairAction: "Supply an explicit supported 2.0.0 document." },
	{ name: "format-unrecognized", fixture: "successor-specimens", mutation: "format-unrecognized", observedVersion: "banana", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "banana" is unrecognized. ${FAILURE_DISCLOSURE}`, repairAction: "Supply an explicit supported 2.0.0 document." },
	{ name: "format-newer", fixture: "successor-specimens", mutation: "format-newer", observedVersion: "2.1.0", exit: 4, causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", finding: "TARGET_CONTRACT_UNSUPPORTED", message: `Target contract version "2.1.0" is newer than supported 2.0.0. ${FAILURE_DISCLOSURE}`, repairAction: "Use a reviewed consumer matching \"2.1.0\", or obtain a conforming 2.0.0 producer." },
]

export interface SemanticCase {
	name: string
	mutations: readonly string[]
	row: (typeof SUCCESSOR_ROWS)[number]
	findings: readonly string[]
}

export const SEMANTIC_CASES: readonly SemanticCase[] = [
	{ name: "machine stdout is one object", mutations: ["stdout-prose"], row: "success-json", findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT"] },
	{ name: "machine stderr is empty", mutations: ["machine-stderr"], row: "success-json", findings: ["STDERR_NOT_EMPTY"] },
	{ name: "required field", mutations: ["field-missing"], row: "success-json", findings: ["TARGET_FIELD_MISSING:result.runId"] },
	{ name: "strict object", mutations: ["field-undeclared"], row: "success-json", findings: ["TARGET_FIELD_UNDECLARED:result.extra"] },
	{ name: "scalar and enum", mutations: ["field-invalid"], row: "success-json", findings: ["TARGET_FIELD_INVALID:message"] },
	{ name: "maximum JSON depth", mutations: ["json-depth"], row: "success-json", findings: ["TARGET_JSON_DEPTH_EXCEEDED"] },
	{ name: "available paths", mutations: ["available-paths"], row: "success-json", findings: ["TARGET_AVAILABLE_PATHS_INVALID"] },
	{ name: "declared command", mutations: ["command-undeclared"], row: "success-json", findings: ["TARGET_COMMAND_UNDECLARED"] },
	{ name: "cause correlation", mutations: ["cause-correlation"], row: "schema-refusal-json", findings: ["TARGET_CAUSE_CORRELATION"] },
	{ name: "observed exit", mutations: ["exit-mismatch"], row: "schema-refusal-json", findings: ["EXIT_MISMATCH"] },
	{ name: "exactly one guidance arm", mutations: ["both-guidance", "neither-guidance"], row: "schema-refusal-json", findings: ["ENVELOPE_NEXT_STEP_RULE"] },
	{ name: "cause guidance", mutations: ["wrong-guidance"], row: "schema-refusal-json", findings: ["TARGET_GUIDANCE_CORRELATION"] },
	{ name: "nonblank next action", mutations: ["blank-next-action"], row: "schema-refusal-json", findings: ["TARGET_FIELD_INVALID:result.nextAction"] },
	{ name: "failure repair action", mutations: ["blank-repair-action"], row: "schema-refusal-json", findings: ["TARGET_FIELD_INVALID:result.repairAction"] },
	{ name: "success repair action", mutations: ["success-repair-action"], row: "success-json", findings: ["TARGET_OUTCOME_DATA_CORRELATION"] },
	{ name: "handoff content", mutations: ["invalid-handoff"], row: "internal-failure-json", findings: ["TARGET_FIELD_INVALID:result.handoff"] },
	{ name: "retryable delay", mutations: ["retry-delay-missing"], row: "transient-refusal-json", findings: ["TARGET_RETRY_CORRELATION"] },
	{ name: "nonretryable delay", mutations: ["nonretry-delay"], row: "schema-refusal-json", findings: ["TARGET_RETRY_CORRELATION"] },
	{ name: "unresolved retry", mutations: ["unresolved-retryable"], row: "internal-failure-json", findings: ["ENVELOPE_UNRESOLVED_RETRYABLE"] },
	{ name: "outcome data", mutations: ["failure-data"], row: "schema-refusal-json", findings: ["TARGET_OUTCOME_DATA_CORRELATION"] },
	{ name: "effect collections", mutations: ["effects-invalid"], row: "success-json", findings: ["TARGET_EFFECTS_INVALID"] },
	{ name: "state and effects", mutations: ["effect-state"], row: "schema-refusal-json", findings: ["TARGET_EFFECT_STATE_CORRELATION"] },
	{ name: "inspect effects", mutations: ["inspect-effects"], row: "success-json", findings: ["TARGET_INSPECT_EFFECT_CORRELATION"] },
	{ name: "success remaining effects", mutations: ["success-remains"], row: "success-json", findings: ["TARGET_SUCCESS_REMAINS"] },
	{ name: "attempted effect", mutations: ["attempted-effect"], row: "internal-failure-json", findings: ["TARGET_ATTEMPTED_EFFECT_INVALID"] },
	{ name: "diagnostics union", mutations: ["diagnostics-invalid"], row: "success-json", findings: ["TARGET_DIAGNOSTICS_INVALID:diagnostics"] },
]

export const PROCESS_EXIT_CASES = [
	{ row: "internal-failure-json", argv: ["internal"], expectedExit: 1, commandIdentity: "fixture.internal", causeCode: "INTERNAL_RESULT_UNCHANGED", outcome: "failed", transactionState: "unchanged", failureClass: "internal", retryable: false, retryDelayMilliseconds: null },
	{ row: "schema-refusal-json", argv: ["schema"], expectedExit: 4, commandIdentity: "fixture.schema", causeCode: "SCHEMA_INVALID_INPUT", outcome: "refused", transactionState: "unchanged", failureClass: "schema", retryable: false, retryDelayMilliseconds: null },
	{ row: "transient-refusal-json", argv: ["transient"], expectedExit: 75, commandIdentity: "fixture.transient", causeCode: "TRANSIENT_NOT_STARTED", outcome: "refused", transactionState: "unchanged", failureClass: "transient", retryable: true, retryDelayMilliseconds: 25 },
] as const

export const CHECKER_COMMANDS = [
	{ commandIdentity: "cli-design-check.discovery", route: ["--discover"], summary: "Describe the checker command and 2.0 contract", effectClass: "inspect" },
	{ commandIdentity: "cli-design-check.dispatch", route: [], summary: "Report invalid checker invocations", effectClass: "inspect" },
	{ commandIdentity: "cli-design-check.help", route: ["--help"], summary: "Show checker help and usage", effectClass: "inspect" },
	{ commandIdentity: "cli-design-check.run", route: [], summary: "Inspect a target CLI through the successor scenario matrix", effectClass: "inspect" },
] as const

// fallow-ignore-next-line code-duplication -- Independent test expectations must not import the production command metadata owner.
const CHECKER_OPTIONS = [
	{ name: "--help", valueName: null, summary: "Show help" },
	{ name: "--discover", valueName: null, summary: "Show command and contract discovery" },
	{ name: "--json", valueName: null, summary: "Emit one machine-readable 2.0 envelope" },
	{ name: "--cwd", valueName: "dir", summary: "Select the target working directory" },
	{ name: "--command", valueName: "argv words", summary: "Select the target CLI command" },
	{ name: "--success-args", valueName: "args", summary: "Set the target success arguments" },
	{ name: "--missing-args", valueName: "args", summary: "Set the target missing-input arguments" },
	{ name: "--internal-args", valueName: "args", summary: "Set the target internal-failure arguments" },
	{ name: "--schema-args", valueName: "args", summary: "Set the target schema-refusal arguments" },
	{ name: "--transient-args", valueName: "args", summary: "Set the target transient-refusal arguments" },
	{ name: "--retain-streams-dir", valueName: "absolute-directory", summary: "Retain raw target streams in an existing private directory" },
	{ name: "--effect-args", valueName: "args", summary: "Set optional authority-refusal arguments" },
	{ name: "--secret-args", valueName: "args", summary: "Set optional secret-redaction arguments" },
	{ name: "--secret-marker", valueName: "string", summary: "Set the secret marker paired with secret arguments" },
	{ name: "--malformed-args", valueName: "args", summary: "Set optional malformed-value arguments" },
	{ name: "--large-args", valueName: "args", summary: "Set optional large-envelope arguments" },
	{ name: "--timeout-ms", valueName: "n", summary: "Set the per-scenario timeout" },
] as const

export const CHECKER_VALUE_OPTIONS = CHECKER_OPTIONS.filter((option) => option.valueName !== null)

export const CHECKER_HELP_DATA = {
	usage: 'cli-design-check --cwd <dir> --command "<argv words>" --success-args "<args>" --missing-args "<args>" --internal-args "<args>" --schema-args "<args>" --transient-args "<args>" [options]',
	summary: "Inspect a target CLI through the strict 2.0.0 design-contract scenario matrix",
	commands: CHECKER_COMMANDS,
	options: CHECKER_OPTIONS,
} as const

export const CHECKER_DISCOVERY_DATA = {
	contractVersion: "2.0.0",
	generationConventionVersion: "2.0.0",
	profile: "simple",
	commands: CHECKER_COMMANDS,
	exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
	signalExits: { "130": "SIGINT", "143": "SIGTERM" },
	effectExclusions: ["retained raw stream files are diagnostic custody, not target domain effects"],
} as const

export const HUMAN_DISCOVERY_CASES = [
	{ name: "prose", mutation: null, findings: [] },
	{ name: "empty", mutation: "human-discovery-empty", findings: ["STDOUT_EMPTY"] },
	{ name: "json", mutation: "human-discovery-json", findings: ["HUMAN_OUTPUT_IS_JSON"] },
	{ name: "stderr", mutation: "human-discovery-stderr", findings: ["STDERR_NOT_EMPTY"] },
] as const

export const RETENTION_CASES = ["not-requested", "private-directory", "unsafe-destination", "post-target-failure", "cleanup-custody-unconfirmed"] as const

export const PUBLIC_BUNDLE_CASES = [
	{ name: "conformant", mutation: null, exit: 0 },
	{ name: "unsupported", mutation: "format-v1-full", exit: 4 },
] as const
