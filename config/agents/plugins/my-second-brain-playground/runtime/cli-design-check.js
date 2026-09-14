// @bun
// packages/cli-design-check/src/main.ts
import { statSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "util";

// packages/cli-design-check/src/render.ts
import { randomUUID } from "crypto";

// packages/cli-design-check/src/contract.ts
var ENVELOPE_VERSION = 1;
var CONTRACT_VERSION = "1.0.0";
var GENERATION_CONVENTION_VERSION = "1.0.0";
var MACHINE_MODE = "--json";
var REDACTED = "[REDACTED]";
var EXIT_MEANINGS = {
  "0": "success",
  "1": "internal",
  "2": "usage",
  "3": "domain",
  "4": "schema",
  "75": "unavailable"
};
var OUTCOMES = ["success", "refused", "failed", "unknown"];
var FAILURE_OUTCOMES = OUTCOMES.filter((outcome) => outcome !== "success");
var FAILURE_CLASSES = ["usage", "domain", "schema", "internal", "unavailable"];
var EFFECT_CLASSES = ["inspect", "repository-local", "external"];
var TRANSACTION_STATES = ["unchanged", "completed", "partially-completed", "rolled-back", "unknown"];
var SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
var CAUSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
var FINDINGS = {
  EXIT_MISMATCH: "EXIT_MISMATCH",
  STDOUT_NOT_EMPTY: "STDOUT_NOT_EMPTY",
  STDOUT_EMPTY: "STDOUT_EMPTY",
  STDERR_NOT_EMPTY: "STDERR_NOT_EMPTY",
  STDERR_NOT_ONE_LINE: "STDERR_NOT_ONE_LINE",
  STDOUT_NOT_SINGLE_JSON_OBJECT: "STDOUT_NOT_SINGLE_JSON_OBJECT",
  JSON_ON_STDERR: "JSON_ON_STDERR",
  PROMPTED_OR_HUNG: "PROMPTED_OR_HUNG",
  TARGET_MUTATED: "TARGET_MUTATED",
  HUMAN_OUTPUT_IS_JSON: "HUMAN_OUTPUT_IS_JSON",
  HELP_MISSING_USAGE: "HELP_MISSING_USAGE",
  ENVELOPE_NEXT_STEP_RULE: "ENVELOPE_NEXT_STEP_RULE",
  ENVELOPE_SUCCESS_UNRESOLVED: "ENVELOPE_SUCCESS_UNRESOLVED",
  ENVELOPE_UNRESOLVED_RETRYABLE: "ENVELOPE_UNRESOLVED_RETRYABLE",
  DISCOVERY_FIELD_UNDECLARED: "DISCOVERY_FIELD_UNDECLARED",
  LARGE_ENVELOPE_BELOW_THRESHOLD: "LARGE_ENVELOPE_BELOW_THRESHOLD",
  SECRET_MARKER_LEAKED: "SECRET_MARKER_LEAKED",
  SECRET_KEY_NOT_REDACTED: "SECRET_KEY_NOT_REDACTED"
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var isString = (value) => typeof value === "string";
var isBoolean = (value) => typeof value === "boolean";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var isNonNegativeNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var isStringArray = (value) => Array.isArray(value) && value.every(isString);
var isPresent = (value) => value !== null && value !== undefined;
var equals = (expected) => (value) => value === expected;
var oneOf = (allowed) => (value) => allowed.includes(value);
var nullable = (accept) => (value) => value === null || accept(value);
var isValidFailureClass = nullable(oneOf(FAILURE_CLASSES));
var isHandoff = (value) => isRecord(value) && isString(value.reason) && isStringArray(value.prerequisites);
function hasOwn(value, field) {
  return Object.hasOwn(value, field);
}
function unique(findings) {
  return [...new Set(findings)];
}
function envelopeFieldMissing(field) {
  return `ENVELOPE_FIELD_MISSING:${field}`;
}
function envelopeFieldInvalid(field) {
  return `ENVELOPE_FIELD_INVALID:${field}`;
}
function discoveryFieldMissing(field) {
  return `DISCOVERY_FIELD_MISSING:${field}`;
}
function fieldFinding(record, check, missing, invalid) {
  const [field, accept] = check;
  if (!hasOwn(record, field))
    return [missing(field)];
  return accept(record[field]) ? [] : [invalid(field)];
}
function fieldFindings(record, checks, missing, invalid) {
  return checks.flatMap((check) => fieldFinding(record, check, missing, invalid));
}
var ENVELOPE_FIELD_CHECKS = [
  ["envelopeVersion", equals(ENVELOPE_VERSION)],
  ["contractVersion", equals(CONTRACT_VERSION)],
  ["commandIdentity", isNonEmptyString],
  ["runIdentity", isNonEmptyString],
  ["outcome", oneOf(OUTCOMES)],
  ["failureClass", isValidFailureClass],
  ["causeCode", nullable((value) => typeof value === "string" && CAUSE_CODE_PATTERN.test(value))],
  ["message", isString],
  ["effectClass", oneOf(EFFECT_CLASSES)],
  ["transactionState", oneOf(TRANSACTION_STATES)],
  ["retryable", isBoolean],
  ["retryDelayMilliseconds", nullable(isNonNegativeNumber)],
  ["nextAction", nullable(isString)],
  ["availablePaths", isStringArray],
  ["repairAction", nullable(isString)],
  ["handoff", nullable(isHandoff)],
  ["result", nullable(isRecord)]
];
var EXIT_FOR_MEANING = new Map(Object.entries(EXIT_MEANINGS).map(([code, meaning]) => [meaning, Number(code)]));
function isCauseCode(value, failureClass) {
  if (failureClass === null)
    return value === null;
  return typeof value === "string" && CAUSE_CODE_PATTERN.test(value) && value.startsWith(`${failureClass.toUpperCase()}_`);
}
function outcomeMatchesFailureClass(value) {
  if (!hasOwn(value, "outcome") || !hasOwn(value, "failureClass"))
    return true;
  return value.outcome === "success" === (value.failureClass === null);
}
function causeCodeMatchesFailureClass(value) {
  if (!hasOwn(value, "causeCode") || !isValidFailureClass(value.failureClass))
    return true;
  return isCauseCode(value.causeCode, value.failureClass);
}
function nextStepRuleHolds(value) {
  if (!FAILURE_OUTCOMES.includes(value.outcome))
    return true;
  return isPresent(value.nextAction) !== isPresent(value.handoff);
}
var isUnresolvedState = (value) => value === "partially-completed" || value === "unknown";
function successIsResolved(value) {
  return value.outcome !== "success" || !isUnresolvedState(value.transactionState);
}
function unresolvedIsNotRetryable(value) {
  return !isUnresolvedState(value.transactionState) || value.retryable === false;
}
var isNonBlankString = (value) => typeof value === "string" && value.trim().length > 0;
var isAbsentOrNonBlank = (value) => !isPresent(value) || isNonBlankString(value);
function handoffReasonIsNonBlank(value) {
  return !isRecord(value.handoff) || isNonBlankString(value.handoff.reason);
}
function crossFieldFindings(value) {
  const rules = [
    [envelopeFieldInvalid("outcome"), outcomeMatchesFailureClass(value)],
    [envelopeFieldInvalid("causeCode"), causeCodeMatchesFailureClass(value)],
    [FINDINGS.ENVELOPE_NEXT_STEP_RULE, nextStepRuleHolds(value)],
    [FINDINGS.ENVELOPE_SUCCESS_UNRESOLVED, successIsResolved(value)],
    [FINDINGS.ENVELOPE_UNRESOLVED_RETRYABLE, unresolvedIsNotRetryable(value)],
    [envelopeFieldInvalid("nextAction"), isAbsentOrNonBlank(value.nextAction)],
    [envelopeFieldInvalid("repairAction"), isAbsentOrNonBlank(value.repairAction)],
    [envelopeFieldInvalid("handoff.reason"), handoffReasonIsNonBlank(value)]
  ];
  return rules.filter(([, holds]) => !holds).map(([finding]) => finding);
}
function exitAlignmentFindings(value, observedExit) {
  if (observedExit === undefined || !isValidFailureClass(value.failureClass))
    return [];
  const expectedExit = EXIT_FOR_MEANING.get(value.failureClass ?? "success");
  return expectedExit === observedExit ? [] : [envelopeFieldInvalid("failureClass")];
}
function envelopeFindings(value, observedExit) {
  if (!isRecord(value))
    return [];
  return unique([
    ...fieldFindings(value, ENVELOPE_FIELD_CHECKS, envelopeFieldMissing, envelopeFieldInvalid),
    ...crossFieldFindings(value),
    ...exitAlignmentFindings(value, observedExit)
  ]);
}
var COMMAND_FIELD_CHECKS = [
  ["identity", isString],
  ["argv", isString],
  ["effectClass", oneOf(EFFECT_CLASSES)],
  ["description", isString]
];
var acceptsCommandFields = (command) => COMMAND_FIELD_CHECKS.every(([field, accept]) => accept(command[field]));
var isCommand = (value) => isRecord(value) && acceptsCommandFields(value);
var isCommandList = (value) => Array.isArray(value) && value.length > 0 && value.every(isCommand);
var DISCOVERY_FIELD_CHECKS = [
  ["name", isString],
  ["contractVersion", equals(CONTRACT_VERSION)],
  ["generationConventionVersion", equals(GENERATION_CONVENTION_VERSION)],
  ["machineMode", equals(MACHINE_MODE)],
  ["commands", isCommandList],
  ["exitMeanings", isRecord],
  ["logtape", isBoolean]
];
var JUDGED_EXIT_MEANINGS = Object.entries(EXIT_MEANINGS).filter(([code]) => code !== "75");
function exitMeaningFindings(result) {
  if (!isRecord(result.exitMeanings))
    return [];
  const exitMeanings = result.exitMeanings;
  const missing = Object.keys(EXIT_MEANINGS).filter((code) => !hasOwn(exitMeanings, code)).map((code) => discoveryFieldMissing(`exitMeanings.${code}`));
  const invalid = JUDGED_EXIT_MEANINGS.filter(([code, meaning]) => hasOwn(exitMeanings, code) && exitMeanings[code] !== meaning).map(([code]) => envelopeFieldInvalid(`result.exitMeanings.${code}`));
  const unavailable = hasOwn(exitMeanings, "75") && !isNonEmptyString(exitMeanings["75"]) ? [envelopeFieldInvalid("result.exitMeanings.75")] : [];
  const undeclared = Object.keys(exitMeanings).filter((code) => !hasOwn(EXIT_MEANINGS, code)).map((code) => `${FINDINGS.DISCOVERY_FIELD_UNDECLARED}:exitMeanings.${code}`);
  return [...missing, ...invalid, ...unavailable, ...undeclared];
}
function discoveryFindings(value) {
  if (!isRecord(value) || !isRecord(value.result))
    return [discoveryFieldMissing("result")];
  const result = value.result;
  const invalid = (field) => envelopeFieldInvalid(`result.${field}`);
  return unique([...fieldFindings(result, DISCOVERY_FIELD_CHECKS, discoveryFieldMissing, invalid), ...exitMeaningFindings(result)]);
}
var SUFFIXED_CODES = [FINDINGS.DISCOVERY_FIELD_UNDECLARED, FINDINGS.SECRET_MARKER_LEAKED, FINDINGS.SECRET_KEY_NOT_REDACTED];
function allFindingCodes() {
  const envelopeFields = ENVELOPE_FIELD_CHECKS.map(([field]) => field);
  const discoveryFields = DISCOVERY_FIELD_CHECKS.map(([field]) => field);
  const exitCodes = Object.keys(EXIT_MEANINGS);
  return unique([
    ...Object.values(FINDINGS).filter((code) => !SUFFIXED_CODES.includes(code)),
    ...envelopeFields.map(envelopeFieldMissing),
    ...envelopeFields.map(envelopeFieldInvalid),
    envelopeFieldInvalid("handoff.reason"),
    ...discoveryFields.map((field) => envelopeFieldInvalid(`result.${field}`)),
    ...exitCodes.map((code) => envelopeFieldInvalid(`result.exitMeanings.${code}`)),
    discoveryFieldMissing("result"),
    ...discoveryFields.map(discoveryFieldMissing),
    ...exitCodes.map((code) => discoveryFieldMissing(`exitMeanings.${code}`)),
    `${FINDINGS.DISCOVERY_FIELD_UNDECLARED}:exitMeanings.<key>`,
    `${FINDINGS.SECRET_MARKER_LEAKED}:stdout`,
    `${FINDINGS.SECRET_MARKER_LEAKED}:stderr`,
    `${FINDINGS.SECRET_KEY_NOT_REDACTED}:<path>`
  ]);
}

// packages/cli-design-check/src/render.ts
function stringify(envelope) {
  return `${JSON.stringify(envelope)}
`;
}
function baseEnvelope() {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    contractVersion: CONTRACT_VERSION,
    commandIdentity: "cli-design-check.run",
    runIdentity: `run-${randomUUID()}`,
    effectClass: "inspect",
    transactionState: "unchanged",
    retryable: false,
    retryDelayMilliseconds: null,
    availablePaths: [],
    handoff: null
  };
}
function cell(value) {
  if (value === null)
    return "-";
  return typeof value === "number" ? String(value) : value.join("|");
}
function renderRow(row) {
  const verdict = row.passed ? "pass" : "fail";
  const findings = row.findings.join(", ") || "-";
  return `${row.scenario} | ${cell(row.observedExit)} | ${cell(row.expectedExit)} | ${verdict} | ${findings}`;
}
function list(values) {
  return values.join(", ") || "-";
}
function renderHuman(report) {
  const observation = report.targetObservation;
  const lines = [
    "scenario | exit | expected | result | findings",
    ...report.rows.map(renderRow),
    `passed ${report.passedCount}/${report.rows.length}`,
    `target unchanged: ${report.targetUnchanged ? "yes" : "no"}`,
    `skipped scenarios: ${list(report.skippedScenarios)}`,
    `unproved findings: ${list(report.findingCoverage.unproved)}`,
    `unjudged: ${list(report.unjudged)}`,
    `target root: ${observation.root}`,
    `target hashed regular files: ${observation.hashedRegularFiles.length}`,
    `target excluded directories: ${list(observation.excludedDirectories)}`,
    `target excluded entry kinds: ${list(observation.excludedEntryKinds)}`,
    `target not observed: ${list(observation.notObserved)}`,
    `target changed paths: ${list(observation.changedPaths)}`
  ];
  return `${lines.join(`
`)}
`;
}
function verdictFields(firstFailure) {
  if (firstFailure === undefined)
    return { outcome: "success", failureClass: null, causeCode: null, nextAction: null, repairAction: null };
  return {
    outcome: "refused",
    failureClass: "domain",
    causeCode: "DOMAIN_CONTRACT_VIOLATION",
    nextAction: `inspect scenario "${firstFailure.scenario}"`,
    repairAction: `${firstFailure.scenario} failed: ${firstFailure.findings[0]}`
  };
}
function renderJson(report) {
  return stringify({
    ...baseEnvelope(),
    ...verdictFields(report.rows.find((row) => !row.passed)),
    message: `passed ${report.passedCount}/${report.rows.length} scenarios`,
    result: report
  });
}
function renderHelp(usage) {
  return stringify({
    ...baseEnvelope(),
    outcome: "success",
    failureClass: null,
    causeCode: null,
    message: "cli-design-check usage",
    nextAction: null,
    repairAction: null,
    result: { usage }
  });
}
function renderUsageError(message) {
  return stringify({
    ...baseEnvelope(),
    outcome: "refused",
    failureClass: "usage",
    causeCode: "USAGE_INVALID_ARGUMENTS",
    message,
    nextAction: "run cli-design-check --help",
    repairAction: "Correct the arguments and retry.",
    result: null
  });
}
function renderInternalError(message) {
  return stringify({
    ...baseEnvelope(),
    outcome: "failed",
    failureClass: "internal",
    causeCode: "INTERNAL_UNEXPECTED",
    message,
    nextAction: "inspect message, then retry",
    repairAction: "Inspect the error and retry.",
    result: null
  });
}

// packages/cli-design-check/src/runner.ts
import { spawn } from "child_process";
import { createHash } from "crypto";
import { readdir } from "fs/promises";
import { join, relative } from "path";

// packages/cli-design-check/src/scenario-rules.ts
var JSON_FLAG = "--json";
function isOneNonEmptyLine(text) {
  const withoutTrailingNewlines = text.replace(/(?:\r\n|\n|\r)+$/g, "");
  return withoutTrailingNewlines.length > 0 && !/[\r\n]/.test(withoutTrailingNewlines);
}
function when(failed, finding) {
  return failed ? [finding] : [];
}
function parseSingleJsonObject(text) {
  if (text.trim() === "")
    return null;
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
function secretMarkerLeaked(stream) {
  return `${FINDINGS.SECRET_MARKER_LEAKED}:${stream}`;
}
function secretKeyEntryFindings(path, key, child) {
  if (SECRET_KEY_PATTERN.test(key) && child !== REDACTED)
    return [`${FINDINGS.SECRET_KEY_NOT_REDACTED}:${path}`];
  return secretKeyFindings(child, `${path}.`);
}
function secretKeyFindings(value, prefix = "") {
  if (!isRecord(value) && !Array.isArray(value))
    return [];
  return Object.entries(value).flatMap(([key, child]) => secretKeyEntryFindings(`${prefix}${key}`, key, child));
}
var helpRule = ({ result }) => [
  ...when(result.stdout.length === 0, FINDINGS.STDOUT_EMPTY),
  ...when(result.stdout.length > 0 && !/usage/i.test(result.stdout), FINDINGS.HELP_MISSING_USAGE)
];
var humanRefusalRule = ({ result }) => [
  ...when(result.stdout.length !== 0, FINDINGS.STDOUT_NOT_EMPTY),
  ...when(!isOneNonEmptyLine(result.stderr), FINDINGS.STDERR_NOT_ONE_LINE)
];
function isJsonStructure(text) {
  if (text.trim() === "")
    return false;
  try {
    const value = JSON.parse(text);
    return isRecord(value) || Array.isArray(value);
  } catch {
    return false;
  }
}
var humanSuccessRule = ({ result }) => [
  ...when(result.stdout.length === 0, FINDINGS.STDOUT_EMPTY),
  ...when(isJsonStructure(result.stdout), FINDINGS.HUMAN_OUTPUT_IS_JSON)
];
var stderrEmptyRule = ({ result }) => when(result.stderr.length !== 0, FINDINGS.STDERR_NOT_EMPTY);
var jsonStderrRule = ({ result, stderrObject }) => [
  ...when(result.stderr.length !== 0, FINDINGS.STDERR_NOT_EMPTY),
  ...when(stderrObject !== null, FINDINGS.JSON_ON_STDERR)
];
var envelopeRule = ({ result, stdoutObject }) => {
  if (stdoutObject === null)
    return [FINDINGS.STDOUT_NOT_SINGLE_JSON_OBJECT];
  return envelopeFindings(stdoutObject, result.observedExit ?? undefined);
};
var discoveryRule = ({ stdoutObject }) => stdoutObject === null ? [] : discoveryFindings(stdoutObject);
var LARGE_ENVELOPE_THRESHOLD_BYTES = 1024 * 1024;
var largeEnvelopeRule = ({ result, stdoutObject }) => when(stdoutObject !== null && Buffer.byteLength(result.stdout, "utf8") < LARGE_ENVELOPE_THRESHOLD_BYTES, FINDINGS.LARGE_ENVELOPE_BELOW_THRESHOLD);
function expecting(expectations) {
  return ({ stdoutObject }) => {
    if (stdoutObject === null)
      return [];
    return expectations.filter(([field, accept]) => !accept(stdoutObject[field])).map(([field]) => envelopeFieldInvalid(field));
  };
}
var secretRule = ({ spec, result, stdoutObject }) => {
  const marker = spec.secretMarker ?? "";
  return [
    ...secretKeyFindings(stdoutObject?.result),
    ...when(marker !== "" && result.stdout.includes(marker), secretMarkerLeaked("stdout")),
    ...when(marker !== "" && result.stderr.includes(marker), secretMarkerLeaked("stderr"))
  ];
};
var isUnchanged = (value) => value === "unchanged";
var isFalse = (value) => value === false;
var isDomain = (value) => value === "domain";
var isRefused = (value) => value === "refused";
var usageRefusalRules = [
  envelopeRule,
  expecting([
    ["outcome", isRefused],
    ["failureClass", (value) => value === "usage"],
    ["causeCode", (value) => typeof value === "string" && value.startsWith("USAGE_")],
    ["transactionState", isUnchanged]
  ]),
  jsonStderrRule
];
var RULES = {
  help: [helpRule, stderrEmptyRule],
  "help-json": [envelopeRule, jsonStderrRule],
  discover: [envelopeRule, discoveryRule, jsonStderrRule],
  "no-arguments": [humanRefusalRule],
  "no-arguments-json": usageRefusalRules,
  "unknown-option": [humanRefusalRule],
  "unknown-option-json": usageRefusalRules,
  "success-human": [humanSuccessRule, stderrEmptyRule],
  "success-json": [
    envelopeRule,
    expecting([
      ["outcome", (value) => value === "success"],
      ["failureClass", (value) => value === null],
      ["transactionState", isUnchanged]
    ]),
    jsonStderrRule
  ],
  "missing-input": [
    envelopeRule,
    expecting([
      ["outcome", (value) => value === "refused" || value === "failed"],
      ["failureClass", isDomain],
      ["retryable", isFalse],
      ["transactionState", isUnchanged],
      ["repairAction", (value) => typeof value === "string" && value.length > 0]
    ]),
    jsonStderrRule
  ],
  "malformed-value-json": [
    envelopeRule,
    expecting([
      ["outcome", (value) => value === "refused" || value === "failed"],
      ["failureClass", (value) => value === "domain" || value === "schema"],
      ["retryable", isFalse],
      ["transactionState", isUnchanged],
      ["repairAction", (value) => typeof value === "string" && value.length > 0]
    ]),
    jsonStderrRule
  ],
  "unauthorized-effect": [
    envelopeRule,
    expecting([
      ["outcome", isRefused],
      ["failureClass", isDomain],
      ["transactionState", isUnchanged],
      ["retryable", isFalse]
    ]),
    jsonStderrRule
  ],
  "secret-redaction": [envelopeRule, secretRule, jsonStderrRule],
  "large-envelope": [envelopeRule, largeEnvelopeRule, jsonStderrRule]
};
function exitAccepted(expectedExit, observedExit) {
  return typeof expectedExit === "number" ? observedExit === expectedExit : observedExit !== null && expectedExit.includes(observedExit);
}
function scenarioFindings(spec, result) {
  const observation = {
    spec,
    result,
    stdoutObject: parseSingleJsonObject(result.stdout),
    stderrObject: parseSingleJsonObject(result.stderr)
  };
  const rules = RULES[spec.scenario] ?? [];
  const findings = [
    ...when(result.timedOut, FINDINGS.PROMPTED_OR_HUNG),
    ...rules.flatMap((rule) => rule(observation)),
    ...when(!exitAccepted(spec.expectedExit, result.observedExit), FINDINGS.EXIT_MISMATCH)
  ];
  return [...new Set(findings)];
}
function optionalRows(options) {
  const secretArgs = options.secretMarker === undefined ? undefined : options.secretArgs;
  return [
    { scenario: "malformed-value-json", argv: options.malformedArgs, expectedExit: [3, 4] },
    { scenario: "large-envelope", argv: options.largeArgs, expectedExit: 0 },
    { scenario: "unauthorized-effect", argv: options.effectArgs, expectedExit: 3 },
    { scenario: "secret-redaction", argv: secretArgs, expectedExit: 0, secretMarker: options.secretMarker }
  ];
}
function optionalScenario(row) {
  if (row.argv === undefined)
    return [];
  return [{ scenario: row.scenario, argv: [...row.argv, JSON_FLAG], expectedExit: row.expectedExit, secretMarker: row.secretMarker }];
}
function skippedScenarios(options) {
  return optionalRows(options).filter((row) => row.argv === undefined).map((row) => row.scenario);
}
function buildScenarios(options) {
  return [
    { scenario: "help", argv: ["--help"], expectedExit: 0 },
    { scenario: "help-json", argv: [JSON_FLAG, "--help"], expectedExit: 0 },
    { scenario: "discover", argv: ["--discover", JSON_FLAG], expectedExit: 0 },
    { scenario: "no-arguments", argv: [], expectedExit: 2 },
    { scenario: "no-arguments-json", argv: [JSON_FLAG], expectedExit: 2 },
    { scenario: "unknown-option", argv: ["--definitely-unknown-option"], expectedExit: 2 },
    { scenario: "unknown-option-json", argv: ["--definitely-unknown-option", JSON_FLAG], expectedExit: 2 },
    { scenario: "success-human", argv: [...options.successArgs], expectedExit: 0 },
    { scenario: "success-json", argv: [...options.successArgs, JSON_FLAG], expectedExit: 0 },
    { scenario: "missing-input", argv: [...options.missingArgs, JSON_FLAG], expectedExit: 3 },
    ...optionalRows(options).flatMap(optionalScenario)
  ];
}

// packages/cli-design-check/src/specimen-manifest.ts
var SPECIMEN_MANIFEST = [
  {
    rule: "O-01",
    code: "STDOUT_NOT_SINGLE_JSON_OBJECT",
    specimen: "S01",
    proof: "process",
    row: "help-json",
    mutation: "prose on `--help --json`",
    findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT"]
  },
  {
    rule: "O-16",
    code: "STDOUT_NOT_SINGLE_JSON_OBJECT",
    specimen: "S19",
    proof: "process",
    row: "no-arguments-json",
    mutation: "bare `--json` answers with a human one-liner on stderr and nothing on stdout",
    findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT", "STDERR_NOT_EMPTY"]
  },
  {
    rule: "O-12",
    code: "ENVELOPE_FIELD_INVALID:outcome",
    specimen: "S15",
    proof: "process",
    row: "malformed-value-json",
    mutation: "malformed input is treated as a success: success envelope, null repairAction, exit 0",
    findings: ["ENVELOPE_FIELD_INVALID:outcome", "ENVELOPE_FIELD_INVALID:failureClass", "ENVELOPE_FIELD_INVALID:repairAction", "EXIT_MISMATCH"]
  },
  {
    rule: "O-10",
    code: "ENVELOPE_FIELD_INVALID:failureClass",
    specimen: "S13",
    proof: "process",
    row: "malformed-value-json",
    mutation: "declares failureClass schema (cause SCHEMA_INPUT_MALFORMED) while exiting 3",
    findings: ["ENVELOPE_FIELD_INVALID:failureClass"]
  },
  {
    rule: "O-12",
    code: "malformed-value-json accepts schema with exit 4",
    specimen: "C14",
    proof: "process",
    row: "malformed-value-json",
    mutation: "declares failureClass schema (cause SCHEMA_INPUT_MALFORMED) and exits 4: the oracle's other aligned pairing",
    findings: [],
    passes: {},
    observedExit: 4
  },
  {
    rule: "O-12",
    code: "ENVELOPE_FIELD_INVALID:failureClass",
    specimen: "C15",
    proof: "process",
    row: "malformed-value-json",
    mutation: "keeps failureClass domain but exits 4 (misaligned; exit 4 alone is not accepted)",
    findings: ["ENVELOPE_FIELD_INVALID:failureClass"],
    observedExit: 4
  },
  {
    rule: "O-03",
    code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.0",
    specimen: "S02",
    proof: "process",
    row: "discover",
    mutation: 'exitMeanings "0" is "banana"',
    findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.0"]
  },
  {
    rule: "O-04",
    code: "DISCOVERY_FIELD_UNDECLARED:exitMeanings.<key>",
    specimen: "S03",
    proof: "process",
    row: "discover",
    mutation: 'exitMeanings gains an undeclared key "99"',
    findings: ["DISCOVERY_FIELD_UNDECLARED:exitMeanings.99"]
  },
  {
    rule: "O-05",
    code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.75",
    specimen: "S04",
    proof: "process",
    row: "discover",
    mutation: 'exitMeanings "75" is the empty string',
    findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.75"]
  },
  {
    rule: "O-06",
    code: "ENVELOPE_SUCCESS_UNRESOLVED",
    specimen: "S05",
    proof: "process",
    row: "discover",
    mutation: "the success discovery envelope carries transactionState unknown",
    findings: ["ENVELOPE_SUCCESS_UNRESOLVED"]
  },
  {
    rule: "O-07",
    code: "ENVELOPE_UNRESOLVED_RETRYABLE",
    specimen: "U01",
    proof: "unit",
    row: "help-json",
    mutation: "a refusal reports partially-completed yet retryable true",
    findings: ["ENVELOPE_UNRESOLVED_RETRYABLE"],
    unit: { base: "refusal", set: { transactionState: "partially-completed", retryable: true }, observedExit: 3 }
  },
  {
    rule: "O-07",
    code: "ENVELOPE_UNRESOLVED_RETRYABLE",
    specimen: "S06",
    proof: "process",
    row: "missing-input",
    mutation: "the missing-input refusal reports transactionState unknown yet retryable true",
    findings: ["ENVELOPE_UNRESOLVED_RETRYABLE", "ENVELOPE_FIELD_INVALID:retryable", "ENVELOPE_FIELD_INVALID:transactionState"],
    attributableOnly: true
  },
  {
    rule: "O-08",
    code: "ENVELOPE_FIELD_INVALID:nextAction",
    specimen: "S07",
    proof: "process",
    row: "missing-input",
    mutation: "the refusal's nextAction is the empty string",
    findings: ["ENVELOPE_FIELD_INVALID:nextAction"]
  },
  {
    rule: "O-08",
    code: "ENVELOPE_FIELD_INVALID:repairAction",
    specimen: "S08",
    proof: "process",
    row: "missing-input",
    mutation: "the refusal's repairAction is the empty string",
    findings: ["ENVELOPE_FIELD_INVALID:repairAction"]
  },
  {
    rule: "O-08",
    code: "ENVELOPE_FIELD_INVALID:handoff.reason",
    specimen: "S09",
    proof: "process",
    row: "success-json",
    mutation: "the success carries a handoff whose reason is the empty string",
    findings: ["ENVELOPE_FIELD_INVALID:handoff.reason"]
  },
  {
    rule: "O-08",
    code: "ENVELOPE_FIELD_INVALID:nextAction",
    specimen: "S10",
    proof: "process",
    row: "success-json",
    mutation: "the success's nextAction is the empty string",
    findings: ["ENVELOPE_FIELD_INVALID:nextAction"]
  },
  {
    rule: "O-09",
    code: "ENVELOPE_NEXT_STEP_RULE",
    specimen: "S11",
    proof: "process",
    row: "missing-input",
    mutation: "the refusal carries both a nextAction and a handoff",
    findings: ["ENVELOPE_NEXT_STEP_RULE"]
  },
  {
    rule: "O-09",
    code: "ENVELOPE_NEXT_STEP_RULE",
    specimen: "S12",
    proof: "process",
    row: "missing-input",
    mutation: "the refusal carries neither a nextAction nor a handoff",
    findings: ["ENVELOPE_NEXT_STEP_RULE"]
  },
  {
    rule: "O-13",
    code: "STDOUT_NOT_SINGLE_JSON_OBJECT",
    specimen: "S16",
    proof: "process",
    row: "large-envelope",
    mutation: "a forced exit with status 0 immediately after writing the 2 MiB envelope (the tail never reaches the pipe)",
    findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT"],
    environmentSensitive: true
  },
  {
    rule: "O-13",
    code: "LARGE_ENVELOPE_BELOW_THRESHOLD",
    specimen: "C01",
    proof: "process",
    row: "large-envelope",
    mutation: "the declared large result is a short string",
    findings: ["LARGE_ENVELOPE_BELOW_THRESHOLD"]
  },
  {
    rule: "O-15",
    code: "targetObservation.notObserved",
    specimen: "S17",
    proof: "process",
    row: "target-unchanged",
    mutation: "the success-json row writes a file outside --cwd (in the OS temp directory)",
    findings: [],
    passes: { field: "notObserved", names: "out-of-tree paths" },
    effects: [{ kind: "file", path: "<tmpdir>/cli-design-specimen-S17.txt", content: `written outside the target root
` }],
    cleanup: ["<tmpdir>/cli-design-specimen-S17.txt"]
  },
  {
    rule: "O-15",
    code: "targetObservation.excludedEntryKinds",
    specimen: "S18",
    proof: "process",
    row: "target-unchanged",
    mutation: "the success-json row creates a symlink inside --cwd",
    findings: [],
    passes: { field: "excludedEntryKinds", names: "symlink" },
    effects: [{ kind: "symlink", path: "<target>/config/specimen-link.json", target: "valid.json" }],
    cleanup: ["<target>/config/specimen-link.json"]
  },
  {
    rule: "O-17",
    code: "HUMAN_OUTPUT_IS_JSON",
    specimen: "S20",
    proof: "process",
    row: "success-human",
    mutation: "human success output is a top-level JSON array",
    findings: ["HUMAN_OUTPUT_IS_JSON"]
  },
  {
    rule: "O-17",
    code: "HUMAN_OUTPUT_IS_JSON",
    specimen: "U03",
    proof: "unit",
    row: "success-human",
    mutation: "human success output is a bare number, which stays legal prose",
    findings: [],
    unit: { base: "success", stdout: `42
`, observedExit: 0 }
  },
  {
    rule: "O-17",
    code: "HUMAN_OUTPUT_IS_JSON",
    specimen: "U04",
    proof: "unit",
    row: "success-human",
    mutation: "human success output is a quoted string, which stays legal prose",
    findings: [],
    unit: { base: "success", stdout: `"demo"
`, observedExit: 0 }
  },
  { rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02a", proof: "unit", row: "help-json", mutation: "internal failure aligned with exit 1", findings: [], unit: { base: "refusal", set: { outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED" }, observedExit: 1 } },
  { rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02b", proof: "unit", row: "help-json", mutation: "internal failure with exit 3", findings: ["ENVELOPE_FIELD_INVALID:failureClass"], unit: { base: "refusal", set: { outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED" }, observedExit: 3 } },
  { rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02c", proof: "unit", row: "help-json", mutation: "schema refusal aligned with exit 4", findings: [], unit: { base: "refusal", set: { failureClass: "schema", causeCode: "SCHEMA_INPUT_INVALID" }, observedExit: 4 } },
  { rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02d", proof: "unit", row: "help-json", mutation: "unavailable failure aligned with exit 75", findings: [], unit: { base: "refusal", set: { outcome: "failed", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY" }, observedExit: 75 } },
  { rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02e", proof: "unit", row: "help-json", mutation: "unavailable failure with exit 3", findings: ["ENVELOPE_FIELD_INVALID:failureClass"], unit: { base: "refusal", set: { outcome: "failed", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY" }, observedExit: 3 } },
  { rule: "coverage", code: "STDOUT_NOT_EMPTY", specimen: "C02", proof: "process", row: "no-arguments", mutation: "the human refusal also prints a line on stdout", findings: ["STDOUT_NOT_EMPTY"] },
  { rule: "coverage", code: "STDOUT_EMPTY", specimen: "C03", proof: "process", row: "success-human", mutation: "human success prints nothing", findings: ["STDOUT_EMPTY"] },
  { rule: "coverage", code: "STDERR_NOT_ONE_LINE", specimen: "C04", proof: "process", row: "no-arguments", mutation: "the human refusal prints two stderr lines", findings: ["STDERR_NOT_ONE_LINE"] },
  { rule: "coverage", code: "JSON_ON_STDERR", specimen: "C05", proof: "process", row: "success-json", mutation: "the success envelope is also written to stderr", findings: ["STDERR_NOT_EMPTY", "JSON_ON_STDERR"] },
  { rule: "coverage", code: "PROMPTED_OR_HUNG", specimen: "C06", proof: "process", row: "no-arguments", mutation: "the human refusal never exits", findings: ["PROMPTED_OR_HUNG", "EXIT_MISMATCH"], timeoutMs: 1000 },
  { rule: "coverage", code: "TARGET_MUTATED", specimen: "C07", proof: "process", row: "target-unchanged", mutation: "the success-json row writes SPECIMEN_WROTE inside --cwd", findings: ["TARGET_MUTATED"], changedPaths: ["SPECIMEN_WROTE"], effects: [{ kind: "file", path: "<target>/SPECIMEN_WROTE", content: `written inside the target root
` }], cleanup: ["<target>/SPECIMEN_WROTE"] },
  { rule: "coverage", code: "HELP_MISSING_USAGE", specimen: "C08", proof: "process", row: "help", mutation: "help text has no usage line", findings: ["HELP_MISSING_USAGE"] },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:retryDelayMilliseconds", specimen: "C09", proof: "process", row: "success-json", mutation: "the success envelope has no retryDelayMilliseconds field", findings: ["ENVELOPE_FIELD_MISSING:retryDelayMilliseconds"] },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.75", specimen: "C10", proof: "process", row: "discover", mutation: 'exitMeanings has no "75" key', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.75"] },
  { rule: "coverage", code: "SECRET_MARKER_LEAKED:stdout", specimen: "C11", proof: "process", row: "secret-redaction", mutation: "the secret marker appears in the envelope message", findings: ["SECRET_MARKER_LEAKED:stdout"] },
  { rule: "coverage", code: "SECRET_KEY_NOT_REDACTED:<path>", specimen: "C12", proof: "process", row: "secret-redaction", mutation: "result.values.apiToken is a plain value instead of [REDACTED]", findings: ["SECRET_KEY_NOT_REDACTED:values.apiToken"] },
  { rule: "coverage", code: "STDERR_NOT_EMPTY", specimen: "C13", proof: "process", row: "help", mutation: "help also prints a diagnostic on stderr", findings: ["STDERR_NOT_EMPTY"] },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:envelopeVersion", specimen: "U05", proof: "unit", row: "help-json", mutation: "envelopeVersion absent", findings: ["ENVELOPE_FIELD_MISSING:envelopeVersion"], unit: { base: "success", remove: ["envelopeVersion"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:contractVersion", specimen: "U06", proof: "unit", row: "help-json", mutation: "contractVersion absent", findings: ["ENVELOPE_FIELD_MISSING:contractVersion"], unit: { base: "success", remove: ["contractVersion"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:commandIdentity", specimen: "U07", proof: "unit", row: "help-json", mutation: "commandIdentity absent", findings: ["ENVELOPE_FIELD_MISSING:commandIdentity"], unit: { base: "success", remove: ["commandIdentity"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:runIdentity", specimen: "U08", proof: "unit", row: "help-json", mutation: "runIdentity absent", findings: ["ENVELOPE_FIELD_MISSING:runIdentity"], unit: { base: "success", remove: ["runIdentity"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:outcome", specimen: "U09", proof: "unit", row: "help-json", mutation: "outcome absent", findings: ["ENVELOPE_FIELD_MISSING:outcome"], unit: { base: "success", remove: ["outcome"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:failureClass", specimen: "U10", proof: "unit", row: "help-json", mutation: "failureClass absent", findings: ["ENVELOPE_FIELD_MISSING:failureClass"], unit: { base: "success", remove: ["failureClass"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:causeCode", specimen: "U11", proof: "unit", row: "help-json", mutation: "causeCode absent", findings: ["ENVELOPE_FIELD_MISSING:causeCode"], unit: { base: "success", remove: ["causeCode"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:message", specimen: "U12", proof: "unit", row: "help-json", mutation: "message absent", findings: ["ENVELOPE_FIELD_MISSING:message"], unit: { base: "success", remove: ["message"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:effectClass", specimen: "U13", proof: "unit", row: "help-json", mutation: "effectClass absent", findings: ["ENVELOPE_FIELD_MISSING:effectClass"], unit: { base: "success", remove: ["effectClass"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:transactionState", specimen: "U14", proof: "unit", row: "help-json", mutation: "transactionState absent", findings: ["ENVELOPE_FIELD_MISSING:transactionState"], unit: { base: "success", remove: ["transactionState"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:retryable", specimen: "U15", proof: "unit", row: "help-json", mutation: "retryable absent", findings: ["ENVELOPE_FIELD_MISSING:retryable"], unit: { base: "success", remove: ["retryable"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:nextAction", specimen: "U16", proof: "unit", row: "help-json", mutation: "nextAction absent", findings: ["ENVELOPE_FIELD_MISSING:nextAction"], unit: { base: "success", remove: ["nextAction"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:availablePaths", specimen: "U17", proof: "unit", row: "help-json", mutation: "availablePaths absent", findings: ["ENVELOPE_FIELD_MISSING:availablePaths"], unit: { base: "success", remove: ["availablePaths"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:repairAction", specimen: "U18", proof: "unit", row: "help-json", mutation: "repairAction absent", findings: ["ENVELOPE_FIELD_MISSING:repairAction"], unit: { base: "success", remove: ["repairAction"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:handoff", specimen: "U19", proof: "unit", row: "help-json", mutation: "handoff absent", findings: ["ENVELOPE_FIELD_MISSING:handoff"], unit: { base: "success", remove: ["handoff"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_MISSING:result", specimen: "U20", proof: "unit", row: "help-json", mutation: "result absent", findings: ["ENVELOPE_FIELD_MISSING:result"], unit: { base: "success", remove: ["result"], observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:envelopeVersion", specimen: "U21", proof: "unit", row: "help-json", mutation: "envelopeVersion is 2", findings: ["ENVELOPE_FIELD_INVALID:envelopeVersion"], unit: { base: "success", set: { envelopeVersion: 2 }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:contractVersion", specimen: "U22", proof: "unit", row: "help-json", mutation: 'contractVersion is "2.0.0"', findings: ["ENVELOPE_FIELD_INVALID:contractVersion"], unit: { base: "success", set: { contractVersion: "2.0.0" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:commandIdentity", specimen: "U23", proof: "unit", row: "help-json", mutation: "commandIdentity is empty", findings: ["ENVELOPE_FIELD_INVALID:commandIdentity"], unit: { base: "success", set: { commandIdentity: "" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:runIdentity", specimen: "U24", proof: "unit", row: "help-json", mutation: "runIdentity is empty", findings: ["ENVELOPE_FIELD_INVALID:runIdentity"], unit: { base: "success", set: { runIdentity: "" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:causeCode", specimen: "U25", proof: "unit", row: "help-json", mutation: "causeCode is lowercase", findings: ["ENVELOPE_FIELD_INVALID:causeCode"], unit: { base: "refusal", set: { causeCode: "domain_input_missing" }, observedExit: 3 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:message", specimen: "U26", proof: "unit", row: "help-json", mutation: "message is a number", findings: ["ENVELOPE_FIELD_INVALID:message"], unit: { base: "success", set: { message: 42 }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:effectClass", specimen: "U27", proof: "unit", row: "help-json", mutation: 'effectClass is "cosmic"', findings: ["ENVELOPE_FIELD_INVALID:effectClass"], unit: { base: "success", set: { effectClass: "cosmic" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:retryDelayMilliseconds", specimen: "U28", proof: "unit", row: "help-json", mutation: "retryDelayMilliseconds is negative", findings: ["ENVELOPE_FIELD_INVALID:retryDelayMilliseconds"], unit: { base: "success", set: { retryDelayMilliseconds: -1 }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:availablePaths", specimen: "U29", proof: "unit", row: "help-json", mutation: "availablePaths is a string", findings: ["ENVELOPE_FIELD_INVALID:availablePaths"], unit: { base: "success", set: { availablePaths: "config-peek --help" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:handoff", specimen: "U30", proof: "unit", row: "help-json", mutation: "handoff is a string", findings: ["ENVELOPE_FIELD_INVALID:handoff"], unit: { base: "success", set: { handoff: "ask the operator" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result", specimen: "U31", proof: "unit", row: "help-json", mutation: "result is an array", findings: ["ENVELOPE_FIELD_INVALID:result"], unit: { base: "success", set: { result: [] }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.name", specimen: "U32", proof: "unit", row: "discover", mutation: "discovery name is a number", findings: ["ENVELOPE_FIELD_INVALID:result.name"], unit: { base: "discovery", set: { "result.name": 42 }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.contractVersion", specimen: "U33", proof: "unit", row: "discover", mutation: 'discovery contractVersion is "2.0.0"', findings: ["ENVELOPE_FIELD_INVALID:result.contractVersion"], unit: { base: "discovery", set: { "result.contractVersion": "2.0.0" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.generationConventionVersion", specimen: "U34", proof: "unit", row: "discover", mutation: 'generationConventionVersion is "2.0.0"', findings: ["ENVELOPE_FIELD_INVALID:result.generationConventionVersion"], unit: { base: "discovery", set: { "result.generationConventionVersion": "2.0.0" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.machineMode", specimen: "U35", proof: "unit", row: "discover", mutation: 'machineMode is "--machine"', findings: ["ENVELOPE_FIELD_INVALID:result.machineMode"], unit: { base: "discovery", set: { "result.machineMode": "--machine" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.commands", specimen: "U36", proof: "unit", row: "discover", mutation: "commands is empty", findings: ["ENVELOPE_FIELD_INVALID:result.commands"], unit: { base: "discovery", set: { "result.commands": [] }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings", specimen: "U37", proof: "unit", row: "discover", mutation: "exitMeanings is a string", findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings"], unit: { base: "discovery", set: { "result.exitMeanings": "0 success" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.logtape", specimen: "U38", proof: "unit", row: "discover", mutation: 'logtape is "yes"', findings: ["ENVELOPE_FIELD_INVALID:result.logtape"], unit: { base: "discovery", set: { "result.logtape": "yes" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.1", specimen: "U39", proof: "unit", row: "discover", mutation: 'exitMeanings "1" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.1"], unit: { base: "discovery", set: { "result.exitMeanings.1": "banana" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.2", specimen: "U40", proof: "unit", row: "discover", mutation: 'exitMeanings "2" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.2"], unit: { base: "discovery", set: { "result.exitMeanings.2": "banana" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.3", specimen: "U41", proof: "unit", row: "discover", mutation: 'exitMeanings "3" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.3"], unit: { base: "discovery", set: { "result.exitMeanings.3": "banana" }, observedExit: 0 } },
  { rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.4", specimen: "U42", proof: "unit", row: "discover", mutation: 'exitMeanings "4" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.4"], unit: { base: "discovery", set: { "result.exitMeanings.4": "banana" }, observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:result", specimen: "U43", proof: "unit", row: "discover", mutation: "the discovery envelope has a null result", findings: ["DISCOVERY_FIELD_MISSING:result"], unit: { base: "discovery", set: { result: null }, observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:name", specimen: "U44", proof: "unit", row: "discover", mutation: "discovery name absent", findings: ["DISCOVERY_FIELD_MISSING:name"], unit: { base: "discovery", remove: ["result.name"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:contractVersion", specimen: "U45", proof: "unit", row: "discover", mutation: "discovery contractVersion absent", findings: ["DISCOVERY_FIELD_MISSING:contractVersion"], unit: { base: "discovery", remove: ["result.contractVersion"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:generationConventionVersion", specimen: "U46", proof: "unit", row: "discover", mutation: "generationConventionVersion absent", findings: ["DISCOVERY_FIELD_MISSING:generationConventionVersion"], unit: { base: "discovery", remove: ["result.generationConventionVersion"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:machineMode", specimen: "U47", proof: "unit", row: "discover", mutation: "machineMode absent", findings: ["DISCOVERY_FIELD_MISSING:machineMode"], unit: { base: "discovery", remove: ["result.machineMode"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:commands", specimen: "U48", proof: "unit", row: "discover", mutation: "commands absent", findings: ["DISCOVERY_FIELD_MISSING:commands"], unit: { base: "discovery", remove: ["result.commands"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings", specimen: "U49", proof: "unit", row: "discover", mutation: "exitMeanings absent", findings: ["DISCOVERY_FIELD_MISSING:exitMeanings"], unit: { base: "discovery", remove: ["result.exitMeanings"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:logtape", specimen: "U50", proof: "unit", row: "discover", mutation: "logtape absent", findings: ["DISCOVERY_FIELD_MISSING:logtape"], unit: { base: "discovery", remove: ["result.logtape"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.0", specimen: "U51", proof: "unit", row: "discover", mutation: 'exitMeanings "0" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.0"], unit: { base: "discovery", remove: ["result.exitMeanings.0"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.1", specimen: "U52", proof: "unit", row: "discover", mutation: 'exitMeanings "1" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.1"], unit: { base: "discovery", remove: ["result.exitMeanings.1"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.2", specimen: "U53", proof: "unit", row: "discover", mutation: 'exitMeanings "2" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.2"], unit: { base: "discovery", remove: ["result.exitMeanings.2"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.3", specimen: "U54", proof: "unit", row: "discover", mutation: 'exitMeanings "3" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.3"], unit: { base: "discovery", remove: ["result.exitMeanings.3"], observedExit: 0 } },
  { rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.4", specimen: "U55", proof: "unit", row: "discover", mutation: 'exitMeanings "4" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.4"], unit: { base: "discovery", remove: ["result.exitMeanings.4"], observedExit: 0 } },
  { rule: "coverage", code: "SECRET_MARKER_LEAKED:stderr", specimen: "U56", proof: "unit", row: "secret-redaction", mutation: "the secret marker appears on stderr", findings: ["SECRET_MARKER_LEAKED:stderr", "STDERR_NOT_EMPTY"], unit: { base: "success", stderr: `warning: CHECK_FIXTURE_SECRET_MARKER
`, secretMarker: "CHECK_FIXTURE_SECRET_MARKER", observedExit: 0 } }
];

// packages/cli-design-check/src/runner.ts
var TIMED_OUT = Symbol("timed-out");
var KILL_GRACE_MS = 500;
var READ_GRACE_MS = 500;
var SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
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
async function entryFiles(directory, entry) {
  const filePath = join(directory, entry.name);
  if (entry.isDirectory())
    return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listFiles(filePath);
  return entry.isFile() ? [filePath] : [];
}
async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }))
    files.push(...await entryFiles(directory, entry));
  return files;
}
async function snapshotDirectory(directory) {
  const snapshots = [];
  for (const filePath of await listFiles(directory)) {
    const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    snapshots.push({ relativePath: relative(directory, filePath).split("\\").join("/"), sha256 });
  }
  return snapshots.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
async function spawnScenario(command, spec, cwd, env, timeoutMs) {
  const started = process.hrtime.bigint();
  const child = spawn(command[0], [...command.slice(1), ...spec.argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stdout = collectStream(child.stdout);
  const stderr = collectStream(child.stderr);
  const outcome = await exitOrKill(child, timeoutMs);
  await drainStreams(child, [stdout, stderr]);
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    observedExit: outcome.observedExit,
    timedOut: outcome.timedOut,
    durationMilliseconds: Number(process.hrtime.bigint() - started) / 1e6
  };
}
function changedPaths(before, after) {
  const beforeMap = new Map(before.map((file) => [file.relativePath, file.sha256]));
  const afterMap = new Map(after.map((file) => [file.relativePath, file.sha256]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((path) => beforeMap.get(path) !== afterMap.get(path)).sort();
}
function scenarioRow(spec, result) {
  const findings = scenarioFindings(spec, result);
  return {
    scenario: spec.scenario,
    argv: spec.argv,
    expectedExit: spec.expectedExit,
    observedExit: result.observedExit,
    passed: findings.length === 0,
    findings,
    durationMilliseconds: result.durationMilliseconds
  };
}
function targetRow(changed) {
  const findings = changed.length === 0 ? [] : [FINDINGS.TARGET_MUTATED];
  return { scenario: "target-unchanged", argv: [], expectedExit: null, observedExit: null, passed: changed.length === 0, findings, durationMilliseconds: 0 };
}
var EXCLUDED_ENTRY_KINDS = ["symlink", "socket", "fifo", "block-device", "character-device"];
var NOT_OBSERVED = ["out-of-tree paths", "reverted effects", "mode changes", "empty directories", "writes inside excluded directories"];
function targetObservation(root, before, changed) {
  return {
    root,
    hashedRegularFiles: before,
    excludedDirectories: [...SKIPPED_DIRECTORIES].sort(),
    excludedEntryKinds: [...EXCLUDED_ENTRY_KINDS],
    notObserved: [...NOT_OBSERVED],
    changedPaths: changed
  };
}
var UNJUDGED = ["exitMeanings.75"];
function unprovedFindingCodes() {
  const proved = new Set(SPECIMEN_MANIFEST.flatMap((entry) => [entry.code, ...entry.findings]));
  return allFindingCodes().filter((code) => !proved.has(code));
}
async function runMatrix(options) {
  const before = await snapshotDirectory(options.cwd);
  const env = childEnvironment();
  const rows = [];
  for (const spec of buildScenarios(options)) {
    rows.push(scenarioRow(spec, await spawnScenario(options.command, spec, options.cwd, env, options.timeoutMs)));
  }
  const changed = changedPaths(before, await snapshotDirectory(options.cwd));
  rows.push(targetRow(changed));
  const passedCount = rows.filter((row) => row.passed).length;
  return {
    targetDirectory: options.cwd,
    command: [...options.command],
    rows,
    passedCount,
    failedCount: rows.length - passedCount,
    targetUnchanged: changed.length === 0,
    targetObservation: targetObservation(options.cwd, before, changed),
    skippedScenarios: skippedScenarios(options),
    findingCoverage: { unproved: unprovedFindingCodes() },
    unjudged: [...UNJUDGED]
  };
}

// packages/cli-design-check/src/main.ts
var HELP_TEXT = `usage:
  cli-design-check --cwd <dir> --command "<argv words>" --success-args "<args>" --missing-args "<args>" [--effect-args "<args>"] [--secret-args "<args>" --secret-marker <string>] [--malformed-args "<args>"] [--large-args "<args>"] [--json] [--timeout-ms <n>]
  cli-design-check --help

Run the target CLI through the standard design contract scenario matrix.
Use --json for one machine-readable Contract Core envelope on stdout; in that mode stderr stays empty.
In human mode a usage error or internal error is one line on stderr.
`;
var DEFAULT_TIMEOUT_MS = 15000;
var valueOptions = new Set(["--cwd", "--command", "--success-args", "--missing-args", "--effect-args", "--secret-args", "--secret-marker", "--malformed-args", "--large-args", "--timeout-ms"]);
function hasJsonFlag(args) {
  for (let index = 0;index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json")
      return true;
    if (token !== undefined && valueOptions.has(token))
      index += 1;
  }
  return false;
}
function oneLine(value) {
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
    options: {
      help: { type: "boolean" },
      json: { type: "boolean" },
      cwd: { type: "string" },
      command: { type: "string" },
      "success-args": { type: "string" },
      "missing-args": { type: "string" },
      "effect-args": { type: "string" },
      "secret-args": { type: "string" },
      "secret-marker": { type: "string" },
      "malformed-args": { type: "string" },
      "large-args": { type: "string" },
      "timeout-ms": { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });
  const options = values;
  return {
    help: options.help === true,
    json: options.json === true,
    cwd: stringOption(options, "cwd"),
    command: stringOption(options, "command"),
    successArgs: stringOption(options, "success-args"),
    missingArgs: stringOption(options, "missing-args"),
    effectArgs: stringOption(options, "effect-args"),
    secretArgs: stringOption(options, "secret-args"),
    secretMarker: stringOption(options, "secret-marker"),
    malformedArgs: stringOption(options, "malformed-args"),
    largeArgs: stringOption(options, "large-args"),
    timeoutMs: stringOption(options, "timeout-ms")
  };
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
  return directory;
}
function nonNegativeInteger(value) {
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
  return {
    cwd: existingDirectory(required(parsed.cwd, "cwd")),
    command,
    successArgs: splitWords(required(parsed.successArgs, "success-args")),
    missingArgs: splitWords(required(parsed.missingArgs, "missing-args")),
    effectArgs: optionalWords(parsed.effectArgs),
    secretArgs: optionalWords(parsed.secretArgs),
    secretMarker: parsed.secretMarker,
    malformedArgs: optionalWords(parsed.malformedArgs),
    largeArgs: optionalWords(parsed.largeArgs),
    timeoutMs: nonNegativeInteger(parsed.timeoutMs)
  };
}
function resolveInvocation(args) {
  const parsed = parseCli(args);
  if (parsed.help)
    return { kind: "help", json: parsed.json };
  return { kind: "run", json: parsed.json, options: matrixOptions(parsed) };
}
function usageFailure(error, json) {
  const cause = oneLine(error);
  if (json)
    process.stdout.write(renderUsageError(cause));
  else
    process.stderr.write(`cli-design-check: ${cause}; run cli-design-check --help
`);
  return 2;
}
function internalFailure(error, json) {
  const cause = oneLine(error);
  if (json)
    process.stdout.write(renderInternalError(cause));
  else
    process.stderr.write(`cli-design-check: internal error: ${cause}
`);
  return 1;
}
async function runAndReport(options, json) {
  const report = await runMatrix(options);
  process.stdout.write(json ? renderJson(report) : renderHuman(report));
  return report.failedCount === 0 ? 0 : 3;
}
async function dispatch(args) {
  let resolved;
  try {
    resolved = resolveInvocation(args);
  } catch (error) {
    return usageFailure(error, hasJsonFlag(args));
  }
  if (resolved.kind === "help") {
    process.stdout.write(resolved.json ? renderHelp(HELP_TEXT) : HELP_TEXT);
    return 0;
  }
  try {
    return await runAndReport(resolved.options, resolved.json);
  } catch (error) {
    return internalFailure(error, resolved.json);
  }
}
var exitCode = await dispatch(process.argv.slice(2));
process.exitCode = exitCode;
