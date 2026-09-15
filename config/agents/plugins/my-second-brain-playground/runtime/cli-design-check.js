// @bun
// packages/cli-design-check/src/successor/main.ts
import { realpathSync, statSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "util";

// packages/cli-design-check/src/successor/contract.ts
var CHECKER_CONTRACT_VERSION = "2.0.0";
var CHECKER_ENVELOPE_VERSION = 2;
var SUCCESSOR_FINDINGS = {
  STDOUT_NOT_SINGLE_JSON_OBJECT: "STDOUT_NOT_SINGLE_JSON_OBJECT",
  STDOUT_EMPTY: "STDOUT_EMPTY",
  STDERR_NOT_EMPTY: "STDERR_NOT_EMPTY",
  HUMAN_OUTPUT_IS_JSON: "HUMAN_OUTPUT_IS_JSON",
  TARGET_JSON_DEPTH_EXCEEDED: "TARGET_JSON_DEPTH_EXCEEDED",
  TARGET_AVAILABLE_PATHS_INVALID: "TARGET_AVAILABLE_PATHS_INVALID",
  TARGET_COMMAND_UNDECLARED: "TARGET_COMMAND_UNDECLARED",
  TARGET_CAUSE_CORRELATION: "TARGET_CAUSE_CORRELATION",
  EXIT_MISMATCH: "EXIT_MISMATCH",
  ENVELOPE_NEXT_STEP_RULE: "ENVELOPE_NEXT_STEP_RULE",
  TARGET_GUIDANCE_CORRELATION: "TARGET_GUIDANCE_CORRELATION",
  TARGET_RETRY_CORRELATION: "TARGET_RETRY_CORRELATION",
  ENVELOPE_UNRESOLVED_RETRYABLE: "ENVELOPE_UNRESOLVED_RETRYABLE",
  TARGET_OUTCOME_DATA_CORRELATION: "TARGET_OUTCOME_DATA_CORRELATION",
  TARGET_EFFECTS_INVALID: "TARGET_EFFECTS_INVALID",
  TARGET_EFFECT_STATE_CORRELATION: "TARGET_EFFECT_STATE_CORRELATION",
  TARGET_INSPECT_EFFECT_CORRELATION: "TARGET_INSPECT_EFFECT_CORRELATION",
  TARGET_SUCCESS_REMAINS: "TARGET_SUCCESS_REMAINS",
  TARGET_ATTEMPTED_EFFECT_INVALID: "TARGET_ATTEMPTED_EFFECT_INVALID"
};
var CHECKER_EXIT = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, transient: 75 };
var cause = (failureClass, outcome, state, retryable, guidance) => ({
  failureClass,
  outcome,
  state,
  retryable,
  guidance,
  exit: failureClass === null ? CHECKER_EXIT.success : CHECKER_EXIT[failureClass]
});
var CAUSE_RULES = {
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
  INTERNAL_UNEXPECTED: cause("internal", "failed", "unchanged", false, "handoff")
};
function causeRuleFor(causeCode) {
  return CAUSE_RULES[causeCode];
}
function checkerExitMeanings() {
  return Object.fromEntries(Object.entries(CHECKER_EXIT).map(([meaning, exit]) => [String(exit), meaning]));
}
var TOP_KEYS = ["availablePaths", "contractVersion", "diagnostics", "envelopeVersion", "message", "result"];
var RESULT_KEYS = ["attemptedEffect", "causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "handoff", "idempotencyKey", "nextAction", "outcome", "repairAction", "retryable", "retryDelayMilliseconds", "runId", "transactionState"];
var EFFECT_KEYS = ["completed", "inventoryComplete", "remaining", "uncertain"];
var HANDOFF_KEYS = ["inspect", "owner", "reason", "resource"];
var AVAILABLE_DIAGNOSTIC_KEYS = ["closed", "countsComplete", "droppedRecords", "file", "sinkFailure", "status", "truncatedRecords", "unflushedRecords"];
var UNAVAILABLE_DIAGNOSTIC_KEYS = ["reason", "status", "trusted"];
var TRUSTED_DIAGNOSTIC_KEYS = ["closed", "countsComplete", "droppedRecords", "file", "sinkFailure", "truncatedRecords", "unflushedRecords"];
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isNonblank = (value) => typeof value === "string" && value.trim().length > 0;
var isSafeNonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
var isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
var isStringArray = (value) => Array.isArray(value) && value.every(isNonblank);
var isFailureClass = (value) => ["usage", "domain", "schema", "internal", "transient"].includes(value);
var hasOwn = (value, key) => Object.hasOwn(value, key);
var fieldMissing = (path) => `TARGET_FIELD_MISSING:${path}`;
var fieldInvalid = (path) => `TARGET_FIELD_INVALID:${path}`;
var fieldUndeclared = (path) => `TARGET_FIELD_UNDECLARED:${path}`;
function firstMissing(value, keys, path) {
  const missing = keys.find((key) => !hasOwn(value, key));
  return missing === undefined ? null : fieldMissing(`${path}${missing}`);
}
function firstUndeclared(value, keys, path) {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  return extra === undefined ? null : fieldUndeclared(`${path}${extra}`);
}
function safeObservedVersion(value) {
  if (!isRecord(value) || typeof value.contractVersion !== "string")
    return null;
  return [...value.contractVersion].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("").slice(0, 128);
}
function exceedsDepth(value, maximumDepth = 64) {
  const visit = (candidate, depth) => {
    if (depth > maximumDepth)
      return true;
    if (Array.isArray(candidate))
      return candidate.some((entry) => visit(entry, depth + 1));
    if (isRecord(candidate))
      return Object.values(candidate).some((entry) => visit(entry, depth + 1));
    return false;
  };
  return visit(value, 0);
}
function sortedUnique(values) {
  return new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1] < value);
}
function basicTopFinding(value) {
  return firstMissing(value, ["envelopeVersion", "contractVersion", "message", "availablePaths", "result"], "") ?? firstUndeclared(value, TOP_KEYS, "") ?? (value.envelopeVersion === CHECKER_ENVELOPE_VERSION ? null : fieldInvalid("envelopeVersion")) ?? (isNonblank(value.message) ? null : fieldInvalid("message")) ?? (isStringArray(value.availablePaths) ? null : fieldInvalid("availablePaths"));
}
function firstInvalidField(checks) {
  const invalid = checks.find((check) => !check.valid(check.value));
  return invalid === undefined ? null : fieldInvalid(invalid.path);
}
function basicResultFinding(result) {
  const required = ["runId", "commandIdentity", "outcome", "effectClass", "transactionState", "causeCode", "failureClass", "exitCode", "data", "retryable", "repairAction", "effects"];
  const shapeFinding = firstMissing(result, required, "result.") ?? firstUndeclared(result, RESULT_KEYS, "result.");
  if (shapeFinding !== null)
    return shapeFinding;
  const fieldFinding = firstInvalidField([
    { path: "result.runId", value: result.runId, valid: isNonblank },
    { path: "result.commandIdentity", value: result.commandIdentity, valid: isNonblank },
    { path: "result.outcome", value: result.outcome, valid: (value) => ["success", "refused", "failed"].includes(String(value)) },
    { path: "result.effectClass", value: result.effectClass, valid: (value) => ["inspect", "repository-local", "external"].includes(String(value)) },
    { path: "result.transactionState", value: result.transactionState, valid: (value) => ["unchanged", "completed", "partially-completed", "unknown"].includes(String(value)) },
    { path: "result.causeCode", value: result.causeCode, valid: isNonblank },
    { path: "result.failureClass", value: result.failureClass, valid: (value) => value === null || isFailureClass(value) },
    { path: "result.retryable", value: result.retryable, valid: (value) => typeof value === "boolean" },
    { path: "result.exitCode", value: result.exitCode, valid: (value) => [0, 1, 2, 3, 4, 75].includes(value) }
  ]);
  if (fieldFinding !== null)
    return fieldFinding;
  if (hasOwn(result, "idempotencyKey") && !isNonblank(result.idempotencyKey))
    return fieldInvalid("result.idempotencyKey");
  if (hasOwn(result, "attemptedEffect") && !isNonblank(result.attemptedEffect))
    return fieldInvalid("result.attemptedEffect");
  return null;
}
function effectsFinding(result) {
  if (!isRecord(result.effects))
    return fieldInvalid("result.effects");
  const effects = result.effects;
  const shapeFinding = firstMissing(effects, EFFECT_KEYS, "result.effects.") ?? firstUndeclared(effects, EFFECT_KEYS, "result.effects.");
  if (shapeFinding !== null)
    return shapeFinding;
  if (!isStringArray(effects.completed) || !isStringArray(effects.remaining) || !isStringArray(effects.uncertain) || typeof effects.inventoryComplete !== "boolean")
    return fieldInvalid("result.effects");
  const collections = [effects.completed, effects.remaining, effects.uncertain];
  const all = collections.flat();
  if (!collections.every(sortedUnique) || new Set(all).size !== all.length)
    return SUCCESSOR_FINDINGS.TARGET_EFFECTS_INVALID;
  return null;
}
function stateEffectsHold(result) {
  const effects = result.effects;
  if (result.transactionState === "unchanged")
    return effects.inventoryComplete && effects.completed.length === 0 && effects.uncertain.length === 0;
  if (result.transactionState === "completed")
    return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length === 0 && effects.uncertain.length === 0;
  if (result.transactionState === "partially-completed")
    return effects.inventoryComplete && effects.completed.length > 0 && effects.remaining.length > 0 && effects.uncertain.length === 0;
  return !effects.inventoryComplete || effects.uncertain.length > 0;
}
function effectCorrelationFinding(result) {
  const effects = result.effects;
  const all = [...effects.completed, ...effects.remaining, ...effects.uncertain];
  if (!stateEffectsHold(result))
    return SUCCESSOR_FINDINGS.TARGET_EFFECT_STATE_CORRELATION;
  if (result.effectClass === "inspect" && (result.transactionState !== "unchanged" || !effects.inventoryComplete || all.length !== 0))
    return SUCCESSOR_FINDINGS.TARGET_INSPECT_EFFECT_CORRELATION;
  if (result.outcome === "success" && effects.remaining.length !== 0)
    return SUCCESSOR_FINDINGS.TARGET_SUCCESS_REMAINS;
  if (hasOwn(result, "attemptedEffect") && (result.outcome !== "failed" || !isNonblank(result.attemptedEffect) || !all.includes(result.attemptedEffect)))
    return SUCCESSOR_FINDINGS.TARGET_ATTEMPTED_EFFECT_INVALID;
  return null;
}
function handoffValid(value) {
  if (!isRecord(value) || firstUndeclared(value, HANDOFF_KEYS, "") !== null)
    return false;
  if (!["human", "operator"].includes(value.owner) || !isNonblank(value.reason) || !isStringArray(value.inspect) || value.inspect.length === 0)
    return false;
  if (!hasOwn(value, "resource"))
    return true;
  return isRecord(value.resource) && Object.keys(value.resource).sort().join(",") === "id,kind" && isNonblank(value.resource.id) && isNonblank(value.resource.kind);
}
function guidanceFinding(result, rule) {
  const hasNext = hasOwn(result, "nextAction");
  const hasHandoff = hasOwn(result, "handoff");
  if (hasNext === hasHandoff)
    return SUCCESSOR_FINDINGS.ENVELOPE_NEXT_STEP_RULE;
  if (hasNext && !isNonblank(result.nextAction))
    return fieldInvalid("result.nextAction");
  if (hasHandoff && !handoffValid(result.handoff))
    return fieldInvalid("result.handoff");
  if (rule.guidance === "next" !== hasNext)
    return SUCCESSOR_FINDINGS.TARGET_GUIDANCE_CORRELATION;
  return null;
}
function retryFinding(result) {
  if ((result.transactionState === "partially-completed" || result.transactionState === "unknown") && result.retryable === true)
    return SUCCESSOR_FINDINGS.ENVELOPE_UNRESOLVED_RETRYABLE;
  const hasDelay = hasOwn(result, "retryDelayMilliseconds");
  if (result.retryable === true)
    return hasDelay && isPositiveInteger(result.retryDelayMilliseconds) ? null : SUCCESSOR_FINDINGS.TARGET_RETRY_CORRELATION;
  return hasDelay ? SUCCESSOR_FINDINGS.TARGET_RETRY_CORRELATION : null;
}
function causeFinding(result, observedExit) {
  const rule = typeof result.causeCode === "string" && result.causeCode in CAUSE_RULES ? CAUSE_RULES[result.causeCode] : undefined;
  if (rule === undefined)
    return fieldInvalid("result.causeCode");
  if (rule.failureClass !== result.failureClass || rule.outcome !== result.outcome || rule.state !== result.transactionState || rule.retryable !== result.retryable || rule.exit !== result.exitCode)
    return SUCCESSOR_FINDINGS.TARGET_CAUSE_CORRELATION;
  if (observedExit !== rule.exit)
    return SUCCESSOR_FINDINGS.EXIT_MISMATCH;
  return guidanceFinding(result, rule);
}
function outcomeFinding(result) {
  if (result.outcome === "success")
    return result.failureClass === null && result.repairAction === null ? null : SUCCESSOR_FINDINGS.TARGET_OUTCOME_DATA_CORRELATION;
  if (result.data !== null)
    return SUCCESSOR_FINDINGS.TARGET_OUTCOME_DATA_CORRELATION;
  return isNonblank(result.repairAction) ? null : fieldInvalid("result.repairAction");
}
var validDiagnosticFile = (value) => value === null || typeof value === "string" && value.startsWith("/");
var validSinkFailure = (value) => value === null || ["capacity", "setup", "write", "flush-timeout", "close"].includes(String(value));
var validBoolean = (value) => typeof value === "boolean";
function diagnosticFieldChecks(value) {
  return [
    { path: "file", value: value.file, valid: validDiagnosticFile },
    { path: "sinkFailure", value: value.sinkFailure, valid: validSinkFailure },
    { path: "droppedRecords", value: value.droppedRecords, valid: isSafeNonnegativeInteger },
    { path: "unflushedRecords", value: value.unflushedRecords, valid: isSafeNonnegativeInteger },
    { path: "truncatedRecords", value: value.truncatedRecords, valid: isSafeNonnegativeInteger },
    { path: "countsComplete", value: value.countsComplete, valid: validBoolean },
    { path: "closed", value: value.closed, valid: validBoolean }
  ];
}
function availableDiagnosticsValid(value) {
  const shapeFinding = firstMissing(value, AVAILABLE_DIAGNOSTIC_KEYS, "") ?? firstUndeclared(value, AVAILABLE_DIAGNOSTIC_KEYS, "");
  return shapeFinding === null && firstInvalidField(diagnosticFieldChecks(value)) === null;
}
function trustedDiagnosticsValid(value) {
  if (firstUndeclared(value, TRUSTED_DIAGNOSTIC_KEYS, "") !== null)
    return false;
  return diagnosticFieldChecks(value).filter((check) => hasOwn(value, check.path)).every((check) => check.valid(check.value));
}
function diagnosticsFinding(value) {
  if (value === undefined)
    return null;
  if (!isRecord(value))
    return "TARGET_DIAGNOSTICS_INVALID:diagnostics";
  if (value.status === "available")
    return availableDiagnosticsValid(value) ? null : "TARGET_DIAGNOSTICS_INVALID:diagnostics";
  if (value.status !== "unavailable" || firstMissing(value, UNAVAILABLE_DIAGNOSTIC_KEYS, "") !== null || firstUndeclared(value, UNAVAILABLE_DIAGNOSTIC_KEYS, "") !== null)
    return "TARGET_DIAGNOSTICS_INVALID:diagnostics";
  if (!["status-invalid", "status-unavailable"].includes(String(value.reason)) || !isRecord(value.trusted))
    return "TARGET_DIAGNOSTICS_INVALID:diagnostics";
  return trustedDiagnosticsValid(value.trusted) ? null : "TARGET_DIAGNOSTICS_INVALID:diagnostics";
}
function commandSummaryValid(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "commandIdentity,effectClass,route,summary")
    return false;
  const finding = firstInvalidField([
    { path: "commandIdentity", value: value.commandIdentity, valid: isNonblank },
    { path: "effectClass", value: value.effectClass, valid: (entry) => ["inspect", "repository-local", "external"].includes(String(entry)) },
    { path: "route", value: value.route, valid: (entry) => Array.isArray(entry) && entry.every((token) => typeof token === "string") },
    { path: "summary", value: value.summary, valid: isNonblank }
  ]);
  return finding === null;
}
function exactObject(value, expected) {
  return isRecord(value) && JSON.stringify(value) === JSON.stringify(expected);
}
function discoveryCommands(result) {
  if (!isRecord(result.data))
    return { finding: fieldInvalid("result.data"), commands: [] };
  const data = result.data;
  const dataKeys = ["contractVersion", "generationConventionVersion", "profile", "commands", "exitMeanings", "signalExits", "effectExclusions"];
  const dataShape = firstMissing(data, dataKeys, "result.data.") ?? firstUndeclared(data, dataKeys, "result.data.");
  if (dataShape !== null)
    return { finding: dataShape, commands: [] };
  const metadataFinding = firstInvalidField([
    { path: "result.data.contractVersion", value: data.contractVersion, valid: (value) => value === CHECKER_CONTRACT_VERSION },
    { path: "result.data.generationConventionVersion", value: data.generationConventionVersion, valid: (value) => value === CHECKER_CONTRACT_VERSION },
    { path: "result.data.profile", value: data.profile, valid: (value) => ["simple", "complex"].includes(String(value)) }
  ]);
  if (metadataFinding !== null)
    return { finding: metadataFinding, commands: [] };
  if (!Array.isArray(data.commands) || data.commands.length === 0)
    return { finding: fieldInvalid("result.data.commands"), commands: [] };
  if (!data.commands.every(commandSummaryValid))
    return { finding: fieldInvalid("result.data.commands"), commands: [] };
  const commands = data.commands.map((entry) => entry.commandIdentity);
  if (new Set(commands).size !== commands.length)
    return { finding: fieldInvalid("result.data.commands"), commands: [] };
  const exitMeanings = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" };
  if (!exactObject(data.exitMeanings, exitMeanings))
    return { finding: fieldInvalid("result.data.exitMeanings"), commands: [] };
  if (!exactObject(data.signalExits, { "130": "SIGINT", "143": "SIGTERM" }))
    return { finding: fieldInvalid("result.data.signalExits"), commands: [] };
  if (!isStringArray(data.effectExclusions))
    return { finding: fieldInvalid("result.data.effectExclusions"), commands: [] };
  return { finding: null, commands };
}
function validateSupported(value, observedExit, declaredCommands, discovery) {
  const version = CHECKER_CONTRACT_VERSION;
  if (exceedsDepth(value))
    return { observedContractVersion: version, findings: [SUCCESSOR_FINDINGS.TARGET_JSON_DEPTH_EXCEEDED], declaredCommands: [] };
  const topFinding = basicTopFinding(value);
  if (topFinding !== null)
    return { observedContractVersion: version, findings: [topFinding], declaredCommands: [] };
  if (!isRecord(value.result))
    return { observedContractVersion: version, findings: ["TARGET_SCHEMA_INVALID:result"], declaredCommands: [] };
  const result = value.result;
  const structural = basicResultFinding(result) ?? effectsFinding(result);
  if (structural !== null)
    return { observedContractVersion: version, findings: [structural], declaredCommands: [] };
  const semantic = retryFinding(result) ?? causeFinding(result, observedExit) ?? outcomeFinding(result) ?? effectCorrelationFinding(result) ?? diagnosticsFinding(value.diagnostics);
  if (semantic !== null)
    return { observedContractVersion: version, findings: [semantic], declaredCommands: [] };
  if (!sortedUnique(value.availablePaths))
    return { observedContractVersion: version, findings: [SUCCESSOR_FINDINGS.TARGET_AVAILABLE_PATHS_INVALID], declaredCommands: [] };
  if (declaredCommands !== undefined && ![result.commandIdentity, ...value.availablePaths].every((identity) => declaredCommands.includes(identity)))
    return { observedContractVersion: version, findings: [SUCCESSOR_FINDINGS.TARGET_COMMAND_UNDECLARED], declaredCommands: [] };
  if (!discovery)
    return { observedContractVersion: version, findings: [], declaredCommands: [] };
  const declared = discoveryCommands(result);
  return { observedContractVersion: version, findings: declared.finding === null ? [] : [declared.finding], declaredCommands: declared.commands };
}
function validateTargetEnvelope(value, observedExit, declaredCommands, discovery = false) {
  const observedContractVersion = safeObservedVersion(value);
  if (!isRecord(value))
    return { observedContractVersion, findings: [SUCCESSOR_FINDINGS.STDOUT_NOT_SINGLE_JSON_OBJECT], declaredCommands: [] };
  if (observedContractVersion !== CHECKER_CONTRACT_VERSION)
    return { observedContractVersion, findings: ["TARGET_CONTRACT_UNSUPPORTED"], declaredCommands: [] };
  return validateSupported(value, observedExit, declaredCommands, discovery);
}

// packages/cli-design-check/src/successor/command-contract.ts
var CHECKER_IDENTITIES = {
  discovery: "cli-design-check.discovery",
  dispatch: "cli-design-check.dispatch",
  help: "cli-design-check.help",
  run: "cli-design-check.run"
};
var SUMMARY = "Inspect a target CLI through the strict 2.0.0 design-contract scenario matrix";
var USAGE = 'cli-design-check --cwd <dir> --command "<argv words>" --success-args "<args>" --missing-args "<args>" --internal-args "<args>" --schema-args "<args>" --transient-args "<args>" [options]';
var COMMANDS = [
  { commandIdentity: CHECKER_IDENTITIES.discovery, route: ["--discover"], summary: "Describe the checker command and 2.0 contract", effectClass: "inspect" },
  { commandIdentity: CHECKER_IDENTITIES.dispatch, route: [], summary: "Report invalid checker invocations", effectClass: "inspect" },
  { commandIdentity: CHECKER_IDENTITIES.help, route: ["--help"], summary: "Show checker help and usage", effectClass: "inspect" },
  { commandIdentity: CHECKER_IDENTITIES.run, route: [], summary: "Inspect a target CLI through the successor scenario matrix", effectClass: "inspect" }
];
var OPTION_DESCRIPTORS = [
  { key: "help", name: "--help", type: "boolean", valueName: null, summary: "Show help" },
  { key: "discover", name: "--discover", type: "boolean", valueName: null, summary: "Show command and contract discovery" },
  { key: "json", name: "--json", type: "boolean", valueName: null, summary: "Emit one machine-readable 2.0 envelope" },
  { key: "cwd", name: "--cwd", type: "string", valueName: "dir", summary: "Select the target working directory" },
  { key: "command", name: "--command", type: "string", valueName: "argv words", summary: "Select the target CLI command" },
  { key: "success-args", name: "--success-args", type: "string", valueName: "args", summary: "Set the target success arguments" },
  { key: "missing-args", name: "--missing-args", type: "string", valueName: "args", summary: "Set the target missing-input arguments" },
  { key: "internal-args", name: "--internal-args", type: "string", valueName: "args", summary: "Set the target internal-failure arguments" },
  { key: "schema-args", name: "--schema-args", type: "string", valueName: "args", summary: "Set the target schema-refusal arguments" },
  { key: "transient-args", name: "--transient-args", type: "string", valueName: "args", summary: "Set the target transient-refusal arguments" },
  { key: "retain-streams-dir", name: "--retain-streams-dir", type: "string", valueName: "absolute-directory", summary: "Retain raw target streams in an existing private directory" },
  { key: "effect-args", name: "--effect-args", type: "string", valueName: "args", summary: "Set optional authority-refusal arguments" },
  { key: "secret-args", name: "--secret-args", type: "string", valueName: "args", summary: "Set optional secret-redaction arguments" },
  { key: "secret-marker", name: "--secret-marker", type: "string", valueName: "string", summary: "Set the secret marker paired with secret arguments" },
  { key: "malformed-args", name: "--malformed-args", type: "string", valueName: "args", summary: "Set optional malformed-value arguments" },
  { key: "large-args", name: "--large-args", type: "string", valueName: "args", summary: "Set optional large-envelope arguments" },
  { key: "timeout-ms", name: "--timeout-ms", type: "string", valueName: "n", summary: "Set the per-scenario timeout" }
];
var OPTIONS = OPTION_DESCRIPTORS.map(({ name, valueName, summary }) => ({ name, valueName, summary }));
function checkerParseArgsOptions() {
  return Object.fromEntries(OPTION_DESCRIPTORS.map(({ key, type }) => [key, { type }]));
}
function checkerOptionTakesValue(token) {
  return OPTION_DESCRIPTORS.some((option) => option.name === token && option.type === "string");
}
var CHECKER_AVAILABLE_PATHS = COMMANDS.map((command) => command.commandIdentity);
var CHECKER_HELP_DATA = {
  usage: USAGE,
  summary: SUMMARY,
  commands: COMMANDS,
  options: OPTIONS
};
var CHECKER_DISCOVERY_DATA = {
  contractVersion: CHECKER_CONTRACT_VERSION,
  generationConventionVersion: CHECKER_CONTRACT_VERSION,
  profile: "simple",
  commands: COMMANDS,
  exitMeanings: checkerExitMeanings(),
  signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  effectExclusions: ["retained raw stream files are diagnostic custody, not target domain effects"]
};
function renderCheckerHelpHuman() {
  return `${SUMMARY}

usage:
  ${USAGE}

example:
  cli-design-check --discover --json
`;
}
function renderCheckerDiscoveryHuman() {
  const commands = COMMANDS.map((command) => `command: ${command.commandIdentity}
  route: ${command.route.join(" ") || "<root>"}
  effect: ${command.effectClass}
  summary: ${command.summary}`);
  const exits = Object.entries(CHECKER_DISCOVERY_DATA.exitMeanings).map(([exit, meaning]) => `exit ${exit}: ${meaning}`);
  const signals = Object.entries(CHECKER_DISCOVERY_DATA.signalExits).map(([exit, signal]) => `signal ${exit}: ${signal}`);
  const exclusions = CHECKER_DISCOVERY_DATA.effectExclusions.map((exclusion) => `effect exclusion: ${exclusion}`);
  return `${[SUMMARY, `contract version: ${CHECKER_CONTRACT_VERSION}`, "profile: simple", ...commands, ...exits, ...signals, ...exclusions].join(`
`)}
`;
}

// packages/cli-design-check/src/successor/render.ts
var EMPTY_EFFECTS = { completed: [], remaining: [], uncertain: [], inventoryComplete: true };
function stringify(value) {
  return `${JSON.stringify(value)}
`;
}
function resultEnvelope(runId, commandIdentity, message, data, verdict) {
  const rule = causeRuleFor(verdict.causeCode);
  if (rule.guidance !== verdict.guidance.kind)
    throw new Error(`guidance does not match ${verdict.causeCode}`);
  if (rule.retryable !== (verdict.retryDelayMilliseconds !== undefined))
    throw new Error(`retry delay does not match ${verdict.causeCode}`);
  return stringify({
    envelopeVersion: CHECKER_ENVELOPE_VERSION,
    contractVersion: CHECKER_CONTRACT_VERSION,
    message,
    availablePaths: CHECKER_AVAILABLE_PATHS,
    result: {
      runId,
      commandIdentity,
      outcome: rule.outcome,
      effectClass: "inspect",
      transactionState: rule.state,
      causeCode: verdict.causeCode,
      failureClass: rule.failureClass,
      exitCode: rule.exit,
      data: rule.outcome === "success" ? data : null,
      retryable: rule.retryable,
      ...verdict.retryDelayMilliseconds === undefined ? {} : { retryDelayMilliseconds: verdict.retryDelayMilliseconds },
      repairAction: verdict.repairAction,
      effects: EMPTY_EFFECTS,
      ...verdict.guidance.kind === "next" ? { nextAction: verdict.guidance.nextAction } : { handoff: verdict.guidance.handoff }
    }
  });
}
function cell(value) {
  return value === null ? "-" : String(value);
}
function renderRow(row) {
  const custody = row.streamCustody === null ? "-" : `${row.streamCustody.stdoutPath},${row.streamCustody.stderrPath}`;
  return `${row.scenario} | ${cell(row.observedExit)} | ${cell(row.expectedExit)} | ${row.passed ? "pass" : "fail"} | ${row.findings.join(", ") || "-"} | ${cell(row.observedContractVersion)} | ${custody}`;
}
function renderHuman(report) {
  const lines = [
    "scenario | exit | expected | result | findings | version | retained streams",
    ...report.rows.map(renderRow),
    `passed ${report.passedCount}/${report.rows.length}`,
    `target unchanged: ${report.targetUnchanged ? "yes" : "no"}`,
    `retention requested: ${report.retention.requested ? "yes" : "no"}`,
    `skipped rows: ${report.skippedRows.length === 0 ? "none" : report.skippedRows.join(", ")}`,
    `observation exclusions: ${report.observationExclusions.length === 0 ? "none" : report.observationExclusions.join(", ")}`
  ];
  return `${lines.join(`
`)}
`;
}
function retainedPaths(report) {
  return report.rows.flatMap((row) => row.streamCustody === null ? [] : [row.streamCustody.stdoutPath, row.streamCustody.stderrPath]);
}
function reportDisclosure(report) {
  const custody = retainedPaths(report);
  return `Checker report: ${report.passedCount}/${report.rows.length} passed; ${report.failedCount} failed; skipped rows: ${report.skippedRows.length === 0 ? "none" : report.skippedRows.join(", ")}; observation exclusions: ${report.observationExclusions.length === 0 ? "none" : report.observationExclusions.join(", ")}; retained stream custody: ${custody.length === 0 ? "none" : custody.join(", ")}.`;
}
function semanticVersionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null)
    return null;
  return [BigInt(match[1] ?? ""), BigInt(match[2] ?? ""), BigInt(match[3] ?? "")];
}
function supportedVersionParts() {
  const parts = semanticVersionParts(CHECKER_CONTRACT_VERSION);
  if (parts === null)
    throw new Error(`checker contract version ${CHECKER_CONTRACT_VERSION} is not semantic`);
  return parts;
}
var SUPPORTED_VERSION_PARTS = supportedVersionParts();
function compareToSupportedVersion(value) {
  const observed = semanticVersionParts(value);
  if (observed === null)
    return null;
  for (const [index, part] of observed.entries()) {
    const expected = SUPPORTED_VERSION_PARTS[index];
    if (part < expected)
      return -1;
    if (part > expected)
      return 1;
  }
  return 0;
}
function unsupportedGuidance(observedVersion) {
  if (observedVersion === null)
    return { message: "Target contract version is missing; observed null.", repairAction: "Supply an explicit supported 2.0.0 document." };
  const rendered = JSON.stringify(observedVersion);
  const comparison = compareToSupportedVersion(observedVersion);
  if (observedVersion === "1.0" || comparison === -1)
    return { message: `Target contract version ${rendered} is unsupported legacy format.`, repairAction: "Obtain a conforming 2.0.0 producer; no legacy adapter is available." };
  if (comparison === 1)
    return { message: `Target contract version ${rendered} is newer than supported 2.0.0.`, repairAction: `Use a reviewed consumer matching ${rendered}, or obtain a conforming 2.0.0 producer.` };
  if (/\d/.test(observedVersion))
    return { message: `Target contract version ${rendered} is malformed.`, repairAction: "Supply an explicit supported 2.0.0 document." };
  return { message: `Target contract version ${rendered} is unrecognized.`, repairAction: "Supply an explicit supported 2.0.0 document." };
}
function reportVerdict(report) {
  const disclosure = reportDisclosure(report);
  if (report.failedCount === 0) {
    return {
      message: `Target contract 2.0.0 accepted. ${disclosure}`,
      causeCode: "SUCCESS_UNCHANGED",
      repairAction: null,
      guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run }
    };
  }
  const first = report.rows.find((row) => !row.passed);
  const finding = first?.findings[0] ?? "unknown finding";
  if (finding === "TARGET_CONTRACT_UNSUPPORTED") {
    const guidance = unsupportedGuidance(first?.observedContractVersion ?? null);
    return {
      message: `${guidance.message} ${disclosure}`,
      causeCode: "SCHEMA_UNSUPPORTED_CONTRACT",
      repairAction: guidance.repairAction,
      guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run }
    };
  }
  return {
    message: `Target contract 2.0.0 is broken: ${finding}. ${disclosure}`,
    causeCode: "SCHEMA_INVALID_INPUT",
    repairAction: `Repair target 2.0.0 field or correlation ${finding}, then rerun the checker. Inspect the target's effects separately; do not replay it automatically.`,
    guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run }
  };
}
function renderJson(report) {
  const verdict = reportVerdict(report);
  const exit = causeRuleFor(verdict.causeCode).exit;
  return { text: resultEnvelope(report.runIdentity, CHECKER_IDENTITIES.run, verdict.message, report, verdict), exit };
}
function renderUsageError(message) {
  return resultEnvelope("run-cli-design-check-usage", CHECKER_IDENTITIES.dispatch, message, null, {
    causeCode: "USAGE_INVALID_INVOCATION",
    repairAction: "Correct the invocation using cli-design-check --help.",
    guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.help }
  });
}
function renderHelp() {
  return resultEnvelope("run-cli-design-check-help", CHECKER_IDENTITIES.help, "Describe the successor checker invocation.", CHECKER_HELP_DATA, {
    causeCode: "SUCCESS_UNCHANGED",
    repairAction: null,
    guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run }
  });
}
function renderDiscovery() {
  return resultEnvelope("run-cli-design-check-discovery", CHECKER_IDENTITIES.discovery, "Describe the checker command and 2.0 contract.", CHECKER_DISCOVERY_DATA, {
    causeCode: "SUCCESS_UNCHANGED",
    repairAction: null,
    guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run }
  });
}
function renderInternalError(message) {
  return resultEnvelope("run-cli-design-check-internal", CHECKER_IDENTITIES.run, message, null, {
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    repairAction: "Inspect the checker failure without replaying the target.",
    guidance: { kind: "handoff", handoff: { owner: "operator", reason: "Checker result production failed after target execution.", inspect: [CHECKER_IDENTITIES.run] } }
  });
}

// packages/cli-design-check/src/successor/runner.ts
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { lstatSync } from "fs";
import { lstat, open, readlink, readdir, unlink } from "fs/promises";
import { isAbsolute, join, relative } from "path";

// packages/cli-design-check/src/successor/scenario-rules.ts
var JSON_FLAG = "--json";
var LARGE_ENVELOPE_THRESHOLD_BYTES = 1024 * 1024;
var REDACTED = "[REDACTED]";
var SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
function parseSingleJsonRecord(text) {
  if (text.trim() === "")
    return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function parsesAsObjectOrArray(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}
function oneLine(text) {
  const trimmed = text.replace(/(?:\r\n|\n|\r)+$/g, "");
  return trimmed.length > 0 && !/[\r\n]/.test(trimmed);
}
function humanFindings(spec, result) {
  if (result.stderr !== "" && spec.kind !== "human-refusal")
    return [SUCCESSOR_FINDINGS.STDERR_NOT_EMPTY];
  if (spec.kind === "human-refusal") {
    if (result.stdout !== "")
      return ["STDOUT_NOT_EMPTY"];
    return oneLine(result.stderr) ? [] : ["STDERR_NOT_ONE_LINE"];
  }
  if (result.stdout === "")
    return [SUCCESSOR_FINDINGS.STDOUT_EMPTY];
  if (spec.kind === "human-help" && !/usage/i.test(result.stdout))
    return ["HELP_MISSING_USAGE"];
  if ((spec.kind === "human-discovery" || spec.kind === "human-success") && parsesAsObjectOrArray(result.stdout))
    return [SUCCESSOR_FINDINGS.HUMAN_OUTPUT_IS_JSON];
  return [];
}
function secretKeyFindings(value, prefix = "") {
  if (typeof value !== "object" || value === null)
    return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = `${prefix}${key}`;
    if (SECRET_KEY_PATTERN.test(key) && child !== REDACTED)
      return [`SECRET_KEY_NOT_REDACTED:${path}`];
    return secretKeyFindings(child, `${path}.`);
  });
}
function optionalFindings(spec, result, parsed) {
  const findings = [];
  if (spec.largeEnvelope === true && parsed !== null && Buffer.byteLength(result.stdout, "utf8") < LARGE_ENVELOPE_THRESHOLD_BYTES)
    findings.push("LARGE_ENVELOPE_BELOW_THRESHOLD");
  if (spec.secretMarker !== undefined) {
    findings.push(...secretKeyFindings(parsed));
    if (result.stdout.includes(spec.secretMarker))
      findings.push("SECRET_MARKER_LEAKED:stdout");
    if (result.stderr.includes(spec.secretMarker))
      findings.push("SECRET_MARKER_LEAKED:stderr");
  }
  return findings;
}
function exitAccepted(expected, observed) {
  return typeof expected === "number" ? observed === expected : observed !== null && expected.includes(observed);
}
function analyzeScenario(spec, result, declaredCommands) {
  if (result.timedOut)
    return { findings: ["PROMPTED_OR_HUNG"], observedContractVersion: null, declaredCommands: [] };
  if (spec.kind !== "machine") {
    const findings = humanFindings(spec, result);
    if (findings.length === 0 && !exitAccepted(spec.expectedExit, result.observedExit))
      findings.push(SUCCESSOR_FINDINGS.EXIT_MISMATCH);
    return { findings, observedContractVersion: null, declaredCommands: [] };
  }
  const parsed = parseSingleJsonRecord(result.stdout);
  const optional = optionalFindings(spec, result, parsed);
  if (result.stderr !== "")
    return { findings: [...new Set([SUCCESSOR_FINDINGS.STDERR_NOT_EMPTY, ...optional])], observedContractVersion: null, declaredCommands: [] };
  if (parsed === null)
    return { findings: [...new Set([SUCCESSOR_FINDINGS.STDOUT_NOT_SINGLE_JSON_OBJECT, ...optional])], observedContractVersion: null, declaredCommands: [] };
  const validation = validateTargetEnvelope(parsed, result.observedExit, declaredCommands, spec.discovery === true);
  return { ...validation, findings: [...new Set([...validation.findings, ...optional])] };
}
function optionalRows(options) {
  const secretArgs = options.secretMarker === undefined ? undefined : options.secretArgs;
  return [
    { scenario: "malformed-value-json", argv: options.malformedArgs, expectedExit: [3, 4] },
    { scenario: "large-envelope", argv: options.largeArgs, expectedExit: 0, largeEnvelope: true },
    { scenario: "unauthorized-effect", argv: options.effectArgs, expectedExit: 3 },
    { scenario: "secret-redaction", argv: secretArgs, expectedExit: 0, secretMarker: options.secretMarker }
  ];
}
function optionalScenario(row) {
  if (row.argv === undefined)
    return [];
  return [{ scenario: row.scenario, argv: [...row.argv, JSON_FLAG], expectedExit: row.expectedExit, kind: "machine", largeEnvelope: row.largeEnvelope, secretMarker: row.secretMarker }];
}
function skippedSuccessorScenarios(options) {
  return optionalRows(options).filter((row) => row.argv === undefined).map((row) => row.scenario);
}
function buildSuccessorScenarios(options) {
  return [
    { scenario: "help-human", argv: ["--help"], expectedExit: 0, kind: "human-help" },
    { scenario: "help-json", argv: ["--help", JSON_FLAG], expectedExit: 0, kind: "machine" },
    { scenario: "discover-human", argv: ["--discover"], expectedExit: 0, kind: "human-discovery" },
    { scenario: "discover-json", argv: ["--discover", JSON_FLAG], expectedExit: 0, kind: "machine", discovery: true },
    { scenario: "no-arguments-human", argv: [], expectedExit: 2, kind: "human-refusal" },
    { scenario: "no-arguments-json", argv: [JSON_FLAG], expectedExit: 2, kind: "machine" },
    { scenario: "unknown-option-human", argv: ["--definitely-unknown-option"], expectedExit: 2, kind: "human-refusal" },
    { scenario: "unknown-option-json", argv: ["--definitely-unknown-option", JSON_FLAG], expectedExit: 2, kind: "machine" },
    { scenario: "success-human", argv: [...options.successArgs], expectedExit: 0, kind: "human-success" },
    { scenario: "success-json", argv: [...options.successArgs, JSON_FLAG], expectedExit: 0, kind: "machine" },
    { scenario: "missing-input-json", argv: [...options.missingArgs, JSON_FLAG], expectedExit: 3, kind: "machine" },
    ...optionalRows(options).flatMap(optionalScenario),
    { scenario: "internal-failure-json", argv: [...options.internalArgs, JSON_FLAG], expectedExit: 1, kind: "machine" },
    { scenario: "schema-refusal-json", argv: [...options.schemaArgs, JSON_FLAG], expectedExit: 4, kind: "machine" },
    { scenario: "transient-refusal-json", argv: [...options.transientArgs, JSON_FLAG], expectedExit: 75, kind: "machine" }
  ];
}

// packages/cli-design-check/src/successor/runner.ts
var TIMED_OUT = Symbol("timed-out");
var KILL_GRACE_MS = 500;
var READ_GRACE_MS = 500;
var SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
var OBSERVATION_EXCLUSIONS = [
  "contents of excluded directories: .git, node_modules",
  "out-of-tree paths",
  "referents of symlink entries",
  "reverted effects",
  "runtime contents of non-regular entries"
];

class StreamRetentionError extends Error {
  constructor(scenario, remainingPaths) {
    super(remainingPaths.length === 0 ? `could not retain streams for ${scenario}; no retained artifact remains` : `could not retain streams for ${scenario}; retained raw stream custody remains at ${remainingPaths.join(", ")}`);
  }
}
function childEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "CI" && value !== undefined)
      env[key] = value;
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}
function entryKind(stat) {
  if (stat.isFile())
    return "file";
  if (stat.isDirectory())
    return "directory";
  if (stat.isSymbolicLink())
    return "symlink";
  if (stat.isFIFO())
    return "fifo";
  if (stat.isSocket())
    return "socket";
  if (stat.isBlockDevice())
    return "block-device";
  if (stat.isCharacterDevice())
    return "character-device";
  return "unknown";
}
function relativePath(root, path) {
  const pathFromRoot = relative(root, path).split("\\").join("/");
  return pathFromRoot === "" ? "." : pathFromRoot;
}
async function snapshotEntry(root, path) {
  const stat = await lstat(path);
  const kind = entryKind(stat);
  const entry = { relativePath: relativePath(root, path), kind, mode: stat.mode & 4095 };
  if (kind === "file") {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  } else if (kind === "symlink") {
    entry.linkTarget = await readlink(path);
  }
  if (kind !== "directory" || path !== root && SKIPPED_DIRECTORIES.has(path.split("/").at(-1)))
    return [entry];
  const descendants = [];
  for (const name of (await readdir(path)).sort())
    descendants.push(...await snapshotEntry(root, join(path, name)));
  return [entry, ...descendants];
}
async function snapshotDirectory(directory) {
  return (await snapshotEntry(directory, directory)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function collectStream(stream) {
  const chunks = [];
  const done = (async () => {
    try {
      for await (const chunk of stream)
        chunks.push(Buffer.from(chunk));
    } catch {}
  })();
  return { done, text: () => Buffer.concat(chunks).toString("utf8"), close: () => stream.destroy() };
}
function exitPromise(child) {
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  exited.catch(() => {
    return;
  });
  return exited;
}
function signalGroup(child, signal) {
  const pid = child.pid;
  if (pid === undefined)
    return;
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}
async function exitOrKill(child, timeoutMs) {
  const exited = exitPromise(child);
  const first = await withTimeout(exited, timeoutMs);
  if (first !== TIMED_OUT)
    return { observedExit: first, timedOut: false };
  signalGroup(child, "SIGTERM");
  const afterTerm = await withTimeout(exited, KILL_GRACE_MS);
  if (afterTerm === TIMED_OUT)
    signalGroup(child, "SIGKILL");
  await withTimeout(exited, KILL_GRACE_MS);
  return { observedExit: null, timedOut: true };
}
async function drainStreams(child, collectors) {
  const drained = Promise.all(collectors.map(({ done }) => done));
  if (await withTimeout(drained, READ_GRACE_MS) !== TIMED_OUT)
    return;
  signalGroup(child, "SIGTERM");
  if (await withTimeout(drained, KILL_GRACE_MS) !== TIMED_OUT)
    return;
  signalGroup(child, "SIGKILL");
  if (await withTimeout(drained, KILL_GRACE_MS) !== TIMED_OUT)
    return;
  for (const collector of collectors)
    collector.close();
  await withTimeout(drained, KILL_GRACE_MS);
}
async function spawnScenario(command, spec, cwd, timeoutMs) {
  const started = process.hrtime.bigint();
  const child = spawn(command[0], [...command.slice(1), ...spec.argv], { cwd, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stdout = collectStream(child.stdout);
  const stderr = collectStream(child.stderr);
  const outcome = await exitOrKill(child, timeoutMs);
  await drainStreams(child, [stdout, stderr]);
  return { stdout: stdout.text(), stderr: stderr.text(), observedExit: outcome.observedExit, timedOut: outcome.timedOut, durationMilliseconds: Number(process.hrtime.bigint() - started) / 1e6 };
}
function changedPaths(before, after) {
  const beforeMap = new Map(before.map((entry) => [entry.relativePath, JSON.stringify(entry)]));
  const afterMap = new Map(after.map((entry) => [entry.relativePath, JSON.stringify(entry)]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((path) => beforeMap.get(path) !== afterMap.get(path)).sort();
}
async function writeExclusive(path, content, createdPaths) {
  const handle = await open(path, "wx", 384);
  createdPaths.push(path);
  try {
    await handle.chmod(384);
    await handle.writeFile(content, "utf8");
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {
      return;
    });
    await unlink(path).catch(() => {
      return;
    });
    throw error;
  }
}
function isMissingPathError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function unconfirmedCustodyPaths(paths) {
  const unconfirmed = await Promise.all(paths.map(async (path) => {
    try {
      await lstat(path);
      return path;
    } catch (error) {
      return isMissingPathError(error) ? null : path;
    }
  }));
  return unconfirmed.filter((path) => path !== null);
}
async function cleanupRetainedPaths(paths) {
  await Promise.all(paths.map((path) => unlink(path).catch(() => {
    return;
  })));
  return unconfirmedCustodyPaths(paths);
}
async function retainStreams(directory, runIdentity, scenario, result) {
  const stdoutPath = join(directory, `${runIdentity}.${scenario}.stdout.txt`);
  const stderrPath = join(directory, `${runIdentity}.${scenario}.stderr.txt`);
  const createdPaths = [];
  try {
    await writeExclusive(stdoutPath, result.stdout, createdPaths);
    await writeExclusive(stderrPath, result.stderr, createdPaths);
    return { stdoutPath, stderrPath };
  } catch {
    throw new StreamRetentionError(scenario, await cleanupRetainedPaths(createdPaths));
  }
}
function targetRow(changed) {
  const findings = changed.length === 0 ? [] : ["TARGET_MUTATED"];
  return { scenario: "target-unchanged", argv: [], expectedExit: null, observedExit: null, observedContractVersion: null, passed: findings.length === 0, findings, durationMilliseconds: 0, streamCustody: null };
}
function validateRetentionDirectory(directory) {
  if (!isAbsolute(directory))
    throw new Error("--retain-streams-dir must be an absolute directory");
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    throw new Error("--retain-streams-dir must already exist");
  }
  const owner = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 511) !== 448)
    throw new Error("--retain-streams-dir must be a non-symlinked, current-user-owned 0700 directory");
  return directory;
}
async function runSuccessorMatrix(options) {
  const runIdentity = `run-${randomUUID()}`;
  const before = await snapshotDirectory(options.cwd);
  const rows = [];
  let declaredCommands;
  for (const spec of buildSuccessorScenarios(options)) {
    const result = await spawnScenario(options.command, spec, options.cwd, options.timeoutMs);
    const streamCustody = options.retainStreamsDirectory === undefined ? null : await retainStreams(options.retainStreamsDirectory, runIdentity, spec.scenario, result);
    const analysis = analyzeScenario(spec, result, declaredCommands);
    if (spec.discovery === true && analysis.findings.length === 0)
      declaredCommands = analysis.declaredCommands;
    rows.push({ scenario: spec.scenario, argv: spec.argv, expectedExit: spec.expectedExit, observedExit: result.observedExit, observedContractVersion: analysis.observedContractVersion, passed: analysis.findings.length === 0, findings: analysis.findings, durationMilliseconds: result.durationMilliseconds, streamCustody });
  }
  const changed = changedPaths(before, await snapshotDirectory(options.cwd));
  rows.push(targetRow(changed));
  const passedCount = rows.filter((row) => row.passed).length;
  return { runIdentity, targetDirectory: options.cwd, command: [...options.command], rows, passedCount, failedCount: rows.length - passedCount, targetUnchanged: changed.length === 0, changedPaths: changed, retention: { requested: options.retainStreamsDirectory !== undefined, directory: options.retainStreamsDirectory ?? null }, skippedRows: skippedSuccessorScenarios(options), observationExclusions: [...OBSERVATION_EXCLUSIONS] };
}

// packages/cli-design-check/src/successor/main.ts
var DEFAULT_TIMEOUT_MS = 15000;
function hasJsonFlag(args) {
  for (let index = 0;index < args.length; index += 1) {
    const token = args[index];
    if (token === "--")
      return false;
    if (token === "--json")
      return true;
    if (token !== undefined && checkerOptionTakesValue(token))
      index += 1;
  }
  return false;
}
function oneLine2(value) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, " ").trim() || "unknown error";
}
function splitWords(value) {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
function optionalWords(value) {
  return value === undefined ? undefined : splitWords(value);
}
function stringOption(options, name) {
  const value = options[name];
  if (value === undefined)
    return;
  if (typeof value !== "string")
    throw new Error(`--${name} must be supplied once with one string value`);
  return value;
}
function parseCli(args) {
  const { values } = parseArgs({
    args,
    options: checkerParseArgsOptions(),
    strict: true,
    allowPositionals: false
  });
  const options = values;
  return {
    help: options.help === true,
    discover: options.discover === true,
    json: options.json === true,
    cwd: stringOption(options, "cwd"),
    command: stringOption(options, "command"),
    successArgs: stringOption(options, "success-args"),
    missingArgs: stringOption(options, "missing-args"),
    internalArgs: stringOption(options, "internal-args"),
    schemaArgs: stringOption(options, "schema-args"),
    transientArgs: stringOption(options, "transient-args"),
    retainStreamsDirectory: stringOption(options, "retain-streams-dir"),
    effectArgs: stringOption(options, "effect-args"),
    secretArgs: stringOption(options, "secret-args"),
    secretMarker: stringOption(options, "secret-marker"),
    malformedArgs: stringOption(options, "malformed-args"),
    largeArgs: stringOption(options, "large-args"),
    timeoutMs: stringOption(options, "timeout-ms")
  };
}
function hasCommandOptions(parsed) {
  return [parsed.cwd, parsed.command, parsed.successArgs, parsed.missingArgs, parsed.internalArgs, parsed.schemaArgs, parsed.transientArgs, parsed.retainStreamsDirectory, parsed.effectArgs, parsed.secretArgs, parsed.secretMarker, parsed.malformedArgs, parsed.largeArgs, parsed.timeoutMs].some((value) => value !== undefined);
}
function required(value, name) {
  if (value === undefined)
    throw new Error(`missing required option --${name}`);
  return value;
}
function existingDirectory(value) {
  const directory = resolve(process.cwd(), value);
  try {
    if (!statSync(directory).isDirectory())
      throw new Error("not a directory");
  } catch {
    throw new Error(`--cwd must be an existing directory: ${value}`);
  }
  return realpathSync(directory);
}
function nonnegativeInteger(value) {
  if (value === undefined)
    return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value))
    throw new Error("--timeout-ms must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error("--timeout-ms must be a non-negative integer");
  return parsed;
}
function matrixOptions(parsed) {
  const command = splitWords(required(parsed.command, "command"));
  if (command.length === 0)
    throw new Error("--command must contain at least one word");
  if (parsed.secretArgs === undefined !== (parsed.secretMarker === undefined))
    throw new Error("--secret-args and --secret-marker must be supplied together");
  const retainStreamsDirectory = parsed.retainStreamsDirectory === undefined ? undefined : validateRetentionDirectory(parsed.retainStreamsDirectory);
  return {
    cwd: existingDirectory(required(parsed.cwd, "cwd")),
    command,
    successArgs: splitWords(required(parsed.successArgs, "success-args")),
    missingArgs: splitWords(required(parsed.missingArgs, "missing-args")),
    internalArgs: splitWords(required(parsed.internalArgs, "internal-args")),
    schemaArgs: splitWords(required(parsed.schemaArgs, "schema-args")),
    transientArgs: splitWords(required(parsed.transientArgs, "transient-args")),
    effectArgs: optionalWords(parsed.effectArgs),
    secretArgs: optionalWords(parsed.secretArgs),
    secretMarker: parsed.secretMarker,
    malformedArgs: optionalWords(parsed.malformedArgs),
    largeArgs: optionalWords(parsed.largeArgs),
    timeoutMs: nonnegativeInteger(parsed.timeoutMs),
    ...retainStreamsDirectory === undefined ? {} : { retainStreamsDirectory }
  };
}
function resolveInvocation(args) {
  const parsed = parseCli(args);
  if (parsed.help && parsed.discover)
    throw new Error("--help and --discover are mutually exclusive");
  if ((parsed.help || parsed.discover) && hasCommandOptions(parsed))
    throw new Error("built-in options cannot be combined with checker command options");
  if (parsed.help)
    return { kind: "help", json: parsed.json };
  if (parsed.discover)
    return { kind: "discovery", json: parsed.json };
  return { kind: "run", json: parsed.json, options: matrixOptions(parsed) };
}
function usageFailure(error, json) {
  const cause2 = oneLine2(error);
  if (json)
    process.stdout.write(renderUsageError(cause2));
  else
    process.stderr.write(`cli-design-check: ${cause2}; run cli-design-check --help
`);
  return 2;
}
function internalFailure(error, json) {
  const cause2 = oneLine2(error);
  if (json)
    process.stdout.write(renderInternalError(cause2));
  else
    process.stderr.write(`cli-design-check: internal error: ${cause2}
`);
  return 1;
}
async function runAndReport(options, json) {
  const report = await runSuccessorMatrix(options);
  if (!json) {
    process.stdout.write(renderHuman(report));
    return report.failedCount === 0 ? 0 : 4;
  }
  const rendered = renderJson(report);
  process.stdout.write(rendered.text);
  return rendered.exit;
}
async function dispatch(args) {
  let resolved;
  try {
    resolved = resolveInvocation(args);
  } catch (error) {
    return usageFailure(error, hasJsonFlag(args));
  }
  if (resolved.kind === "help") {
    process.stdout.write(resolved.json ? renderHelp() : renderCheckerHelpHuman());
    return 0;
  }
  if (resolved.kind === "discovery") {
    process.stdout.write(resolved.json ? renderDiscovery() : renderCheckerDiscoveryHuman());
    return 0;
  }
  try {
    return await runAndReport(resolved.options, resolved.json);
  } catch (error) {
    return internalFailure(error, resolved.json);
  }
}
process.exitCode = await dispatch(process.argv.slice(2));
