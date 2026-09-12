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
function crossFieldFindings(value) {
  const rules = [
    [envelopeFieldInvalid("outcome"), outcomeMatchesFailureClass(value)],
    [envelopeFieldInvalid("causeCode"), causeCodeMatchesFailureClass(value)],
    [FINDINGS.ENVELOPE_NEXT_STEP_RULE, nextStepRuleHolds(value)]
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
function exitMeaningFindings(result) {
  if (!isRecord(result.exitMeanings))
    return [];
  const exitMeanings = result.exitMeanings;
  return Object.keys(EXIT_MEANINGS).filter((code) => !hasOwn(exitMeanings, code)).map((code) => discoveryFieldMissing(`exitMeanings.${code}`));
}
function discoveryFindings(value) {
  if (!isRecord(value) || !isRecord(value.result))
    return [discoveryFieldMissing("result")];
  const result = value.result;
  const invalid = (field) => envelopeFieldInvalid(`result.${field}`);
  return unique([...fieldFindings(result, DISCOVERY_FIELD_CHECKS, discoveryFieldMissing, invalid), ...exitMeaningFindings(result)]);
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
  return value === null ? "-" : String(value);
}
function renderRow(row) {
  const verdict = row.passed ? "pass" : "fail";
  const findings = row.findings.join(", ") || "-";
  return `${row.scenario} | ${cell(row.observedExit)} | ${cell(row.expectedExit)} | ${verdict} | ${findings}`;
}
function renderHuman(report) {
  const lines = [
    "scenario | exit | expected | result | findings",
    ...report.rows.map(renderRow),
    `passed ${report.passedCount}/${report.rows.length}`,
    `target unchanged: ${report.targetUnchanged ? "yes" : "no"}`
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
var humanSuccessRule = ({ result, stdoutObject }) => [
  ...when(result.stdout.length === 0, FINDINGS.STDOUT_EMPTY),
  ...when(result.stdout.length > 0 && stdoutObject !== null, FINDINGS.HUMAN_OUTPUT_IS_JSON)
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
var RULES = {
  help: [helpRule, stderrEmptyRule],
  discover: [envelopeRule, discoveryRule, jsonStderrRule],
  "no-arguments": [humanRefusalRule],
  "unknown-option": [humanRefusalRule],
  "unknown-option-json": [
    envelopeRule,
    expecting([
      ["outcome", isRefused],
      ["failureClass", (value) => value === "usage"],
      ["causeCode", (value) => typeof value === "string" && value.startsWith("USAGE_")],
      ["transactionState", isUnchanged]
    ]),
    jsonStderrRule
  ],
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
  "secret-redaction": [envelopeRule, secretRule, jsonStderrRule]
};
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
    ...when(result.observedExit !== spec.expectedExit, FINDINGS.EXIT_MISMATCH)
  ];
  return [...new Set(findings)];
}
function optionalScenario(scenario, argv, expectedExit, secretMarker) {
  if (argv === undefined)
    return [];
  return [{ scenario, argv: [...argv, JSON_FLAG], expectedExit, secretMarker }];
}
function buildScenarios(options) {
  const secretArgs = options.secretMarker === undefined ? undefined : options.secretArgs;
  return [
    { scenario: "help", argv: ["--help"], expectedExit: 0 },
    { scenario: "discover", argv: ["--discover", JSON_FLAG], expectedExit: 0 },
    { scenario: "no-arguments", argv: [], expectedExit: 2 },
    { scenario: "unknown-option", argv: ["--definitely-unknown-option"], expectedExit: 2 },
    { scenario: "unknown-option-json", argv: ["--definitely-unknown-option", JSON_FLAG], expectedExit: 2 },
    { scenario: "success-human", argv: [...options.successArgs], expectedExit: 0 },
    { scenario: "success-json", argv: [...options.successArgs, JSON_FLAG], expectedExit: 0 },
    { scenario: "missing-input", argv: [...options.missingArgs, JSON_FLAG], expectedExit: 3 },
    ...optionalScenario("unauthorized-effect", options.effectArgs, 3),
    ...optionalScenario("secret-redaction", secretArgs, 0, options.secretMarker)
  ];
}

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
  return { done, text: () => Buffer.concat(chunks).toString("utf8") };
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
async function spawnScenario(command, spec, cwd, env, timeoutMs) {
  const started = process.hrtime.bigint();
  const child = spawn(command[0], [...command.slice(1), ...spec.argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stdout = collectStream(child.stdout);
  const stderr = collectStream(child.stderr);
  const outcome = await exitOrKill(child, timeoutMs);
  await withTimeout(Promise.all([stdout.done, stderr.done]), READ_GRACE_MS);
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
  const findings = changed.length === 0 ? [] : [FINDINGS.TARGET_MUTATED, ...changed];
  return { scenario: "target-unchanged", argv: [], expectedExit: null, observedExit: null, passed: changed.length === 0, findings, durationMilliseconds: 0 };
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
  return { targetDirectory: options.cwd, command: [...options.command], rows, passedCount, failedCount: rows.length - passedCount, targetUnchanged: changed.length === 0 };
}

// packages/cli-design-check/src/main.ts
var HELP_TEXT = `usage:
  cli-design-check --cwd <dir> --command "<argv words>" --success-args "<args>" --missing-args "<args>" [--effect-args "<args>"] [--secret-args "<args>" --secret-marker <string>] [--json] [--timeout-ms <n>]
  cli-design-check --help

Run the target CLI through the standard design contract scenario matrix.
Use --json for one machine-readable Contract Core envelope on stdout; in that mode stderr stays empty.
In human mode a usage error or internal error is one line on stderr.
`;
var DEFAULT_TIMEOUT_MS = 15000;
var valueOptions = new Set(["--cwd", "--command", "--success-args", "--missing-args", "--effect-args", "--secret-args", "--secret-marker", "--timeout-ms"]);
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
    timeoutMs: nonNegativeInteger(parsed.timeoutMs)
  };
}
function resolveInvocation(args) {
  const parsed = parseCli(args);
  if (parsed.help)
    return { kind: "help" };
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
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  try {
    return await runAndReport(resolved.options, resolved.json);
  } catch (error) {
    return internalFailure(error, resolved.json);
  }
}
var exitCode = await dispatch(process.argv.slice(2));
process.exit(exitCode);
