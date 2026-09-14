import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const CONTRACT_VERSION = "1.0.0";
const HELP_PATH = "config-peek --help";
const DISCOVER_PATH = "config-peek --discover --json";
const SECRET_KEY = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
const HELP_TEXT = "config-peek: inspect one JSON configuration file without changing state\nusage: config-peek [--json] [--discover] <path>\n\noptions:\n  --json       emit a machine-readable JSON envelope\n  --discover   describe the available commands\n  --help       show this help\n  --write      refuse write effects; this tool is read-only\n\nexample:\n  config-peek --json config/valid.json\n";
type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type FlatValues = Record<string, JsonValue>;
type FailureClass = "usage" | "domain" | "schema" | "internal" | "unavailable" | null;
type Envelope = { envelopeVersion: 1; contractVersion: string; commandIdentity: string; runIdentity: string; outcome: "success" | "refused" | "failed" | "unknown"; failureClass: FailureClass; causeCode: string | null; message: string; effectClass: "inspect" | "repository-local" | "external"; transactionState: "unchanged" | "completed" | "partially-completed" | "rolled-back" | "unknown"; retryable: boolean; retryDelayMilliseconds: number | null; nextAction: string | null; availablePaths: string[]; repairAction: string | null; handoff: { reason: string; prerequisites: string[] } | null; result: object | null };
type EnvelopeOptions = { effectClass?: Envelope["effectClass"]; transactionState?: Envelope["transactionState"]; retryable?: boolean; retryDelayMilliseconds?: number | null; nextAction?: string | null; availablePaths?: string[]; repairAction?: string | null; handoff?: Envelope["handoff"]; result?: object | null };
type ReadResult = { kind: "ok"; values: FlatValues } | { kind: "missing" } | { kind: "malformed" } | { kind: "unreadable" };
// --large inflates the success result to 2 MiB in process (the checker threshold is 1 MiB) so a large envelope drain is observable without a committed file.
const LARGE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DISCOVERY = { name: "config-peek", contractVersion: CONTRACT_VERSION, generationConventionVersion: "1.0.0", commands: [{ identity: "config-peek.help", argv: "--help", effectClass: "inspect", description: "Show help and usage" }, { identity: "config-peek.discover", argv: "--discover --json", effectClass: "inspect", description: "Describe commands and the contract" }, { identity: "config-peek.read", argv: "[--json] <path>", effectClass: "inspect", description: "Read and flatten one JSON file" }], exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "retryable-or-unavailable" }, machineMode: "--json", logtape: false };

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function redactValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isObject(value)) return value;
  const output: JsonObject = {};
  for (const key of Object.keys(value)) output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(value[key]);
  return output;
}
function flattenObject(value: JsonObject, prefix: string, output: FlatValues): void {
  for (const key of Object.keys(value).sort()) {
    const name = prefix ? prefix + "." + key : key;
    const child = value[key];
    if (SECRET_KEY.test(key)) output[name] = "[REDACTED]";
    else if (isObject(child)) flattenObject(child, name, output);
    else output[name] = redactValue(child);
  }
}
function flattenConfig(value: JsonValue): FlatValues {
  const output: FlatValues = {};
  if (isObject(value)) flattenObject(value, "", output);
  else output.value = redactValue(value);
  const sorted: FlatValues = {};
  for (const key of Object.keys(output).sort()) sorted[key] = output[key];
  return sorted;
}
function formatValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null";
}
function humanValues(values: FlatValues): string {
  const lines = Object.keys(values).sort().map((key) => key + ": " + formatValue(values[key]));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
function discoveryText(): string {
  const lines = ["name: " + DISCOVERY.name, "contractVersion: " + DISCOVERY.contractVersion, "generationConventionVersion: " + DISCOVERY.generationConventionVersion];
  for (const command of DISCOVERY.commands) lines.push("command: " + command.identity + " | " + command.argv + " | " + command.effectClass + " | " + command.description);
  for (const [code, meaning] of Object.entries(DISCOVERY.exitMeanings)) lines.push("exit " + code + ": " + meaning);
  lines.push("machineMode: " + DISCOVERY.machineMode, "logtape: false");
  return lines.join("\n") + "\n";
}
function makeEnvelope(commandIdentity: string, outcome: Envelope["outcome"], failureClass: FailureClass, causeCode: string | null, message: string, options: EnvelopeOptions = {}): Envelope {
  return { envelopeVersion: 1, contractVersion: CONTRACT_VERSION, commandIdentity, runIdentity: "run-" + randomUUID(), outcome, failureClass, causeCode, message, effectClass: options.effectClass ?? "inspect", transactionState: options.transactionState ?? "unchanged", retryable: options.retryable ?? false, retryDelayMilliseconds: options.retryDelayMilliseconds ?? null, nextAction: options.nextAction ?? null, availablePaths: options.availablePaths ?? [], repairAction: options.repairAction ?? null, handoff: options.handoff ?? null, result: options.result ?? null };
}
function emitJson(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope) + "\n");
}
function finishFailure(exitCode: number, jsonMode: boolean, envelope: Envelope, humanLine: string): number {
  if (jsonMode) emitJson(envelope);
  else process.stderr.write(humanLine + "\n");
  return exitCode;
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
function readInput(target: string): ReadResult {
  let source: string;
  try {
    source = readFileSync(target, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    return { kind: "ok", values: flattenConfig(JSON.parse(source) as JsonValue) };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "malformed" };
    throw error;
  }
}
function insideCurrentDirectory(pathText: string): string | null {
  const cwd = process.cwd();
  const target = resolve(cwd, pathText);
  const fromCwd = relative(cwd, target);
  return fromCwd === ".." || fromCwd.startsWith(".." + sep) || isAbsolute(fromCwd) ? null : target;
}
function commandIdentity(args: string[]): string {
  return args.includes("--help") ? "config-peek.help" : args.includes("--discover") ? "config-peek.discover" : "config-peek.read";
}
function usageFailure(jsonMode: boolean, identity: string, causeCode: string, message: string, humanLine: string): number {
  return finishFailure(2, jsonMode, makeEnvelope(identity, "refused", "usage", causeCode, message, { nextAction: HELP_PATH, availablePaths: [HELP_PATH, DISCOVER_PATH], repairAction: "Correct the command arguments or run config-peek --help" }), humanLine);
}
function domainFailure(jsonMode: boolean, pathText: string, causeCode: string, message: string, repairAction: string, humanLine: string): number {
  return finishFailure(3, jsonMode, makeEnvelope("config-peek.read", "refused", "domain", causeCode, message, { nextAction: HELP_PATH, availablePaths: [HELP_PATH, DISCOVER_PATH], repairAction, result: { path: pathText } }), humanLine);
}
function internalFailure(jsonMode: boolean, identity: string): number {
  return finishFailure(1, jsonMode, makeEnvelope(identity, "failed", "internal", "INTERNAL_UNEXPECTED", "Unexpected internal error", { transactionState: "unknown" }), "config-peek: internal error");
}

function main(): number {
  const rawArgs = process.argv.slice(2);
  const jsonMode = rawArgs.some((arg) => arg === "--json" || arg.startsWith("--json="));
  const identity = commandIdentity(rawArgs);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: rawArgs, options: { json: { type: "boolean" }, discover: { type: "boolean" }, help: { type: "boolean" }, write: { type: "boolean" }, large: { type: "boolean" } }, strict: true, allowPositionals: true });
  } catch {
    return usageFailure(jsonMode, identity, "USAGE_UNKNOWN_OPTION", "Unknown option; run config-peek --help", "config-peek: unknown option; run config-peek --help");
  }
  try {
    if (parsed.values.help === true) {
      if (jsonMode) emitJson(makeEnvelope("config-peek.help", "success", null, null, "Help completed", { availablePaths: [DISCOVER_PATH], result: { usage: "config-peek [--json] [--discover] <path>", example: "config-peek --json config/valid.json" } }));
      else process.stdout.write(HELP_TEXT);
      return 0;
    }
    if (parsed.values.write === true) {
      return finishFailure(3, jsonMode, makeEnvelope("config-peek.read", "refused", "domain", "DOMAIN_EFFECT_NOT_AVAILABLE", "Write effects are not available; this tool is read-only", { effectClass: "repository-local", nextAction: HELP_PATH, availablePaths: [HELP_PATH, DISCOVER_PATH], repairAction: "Remove --write; this tool is read-only", result: { effectAttempted: false } }), "config-peek: write effects are not available; this tool is read-only");
    }
    if (parsed.values.discover === true) {
      if (jsonMode) emitJson(makeEnvelope("config-peek.discover", "success", null, null, "Command discovery completed", { availablePaths: ["config-peek [--json] <path>"], result: DISCOVERY }));
      else process.stdout.write(discoveryText());
      return 0;
    }
    if (parsed.positionals.length === 0) return usageFailure(jsonMode, "config-peek.read", "USAGE_PATH_REQUIRED", "A path is required; run config-peek --help", "config-peek: a path is required; run config-peek --help");
    if (parsed.positionals.length !== 1) return usageFailure(jsonMode, "config-peek.read", "USAGE_TOO_MANY_PATHS", "Supply one path; run config-peek --help", "config-peek: one path is required; run config-peek --help");
    const pathText = parsed.positionals[0];
    const target = insideCurrentDirectory(pathText);
    if (target === null) return domainFailure(jsonMode, pathText, "DOMAIN_PATH_ESCAPE", "Path resolves outside the current directory", "Provide a path inside the current directory", "config-peek: path must stay inside the current directory");
    const input = readInput(target);
    if (input.kind === "missing") return domainFailure(jsonMode, pathText, "DOMAIN_INPUT_MISSING", "Input file is missing; provide a readable JSON file", "Provide a readable JSON file inside the current directory", "config-peek: input file is missing; provide a readable JSON file");
    if (input.kind === "malformed") return domainFailure(jsonMode, pathText, "DOMAIN_INPUT_MALFORMED", "Input is malformed JSON; correct the file and retry", "Correct the JSON bytes and retry; no file is changed by the CLI", "config-peek: input is malformed JSON; correct the file and retry");
    if (input.kind === "unreadable") return domainFailure(jsonMode, pathText, "DOMAIN_INPUT_UNREADABLE", "Input file is not readable; provide a readable JSON file", "Provide a readable JSON file inside the current directory", "config-peek: input file is not readable; provide a readable JSON file");
    if (jsonMode) emitJson(makeEnvelope("config-peek.read", "success", null, null, "Configuration read successfully", { retryable: true, availablePaths: [DISCOVER_PATH], result: { path: pathText, values: input.values, ...(parsed.values.large === true ? { largePayload: "x".repeat(LARGE_PAYLOAD_BYTES) } : {}) } }));
    else process.stdout.write(humanValues(input.values));
    return 0;
  } catch {
    return internalFailure(jsonMode, identity);
  }
}
process.exitCode = main();
