import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const HELP = "config-peek: inspect one JSON configuration file without changing state\nusage: config-peek [--json] [--discover] <path>\n\noptions:\n  --json       emit a machine-readable JSON envelope\n  --discover   describe the available commands\n  --help       show this help\n  --write      refuse write effects; this tool is read-only\n\nexample:\n  config-peek --json config/valid.json\n";
const SECRET = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type Flat = Record<string, Value>;
const DISCOVERY = { name: "config-peek", contractVersion: "1.0.0", generationConventionVersion: "1.0.0", commands: [{ identity: "config-peek.help", argv: "--help", effectClass: "inspect", description: "Show help and usage" }, { identity: "config-peek.discover", argv: "--discover --json", effectClass: "inspect", description: "Describe commands and the contract" }, { identity: "config-peek.read", argv: "[--json] <path>", effectClass: "inspect", description: "Read and flatten one JSON file" }], exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "retryable-or-unavailable" }, machineMode: "--json", logtape: false };
function object(value: Value): value is { [key: string]: Value } { return typeof value === "object" && value !== null && !Array.isArray(value); }
function flatten(value: Value, prefix = "", out: Flat = {}): Flat {
  if (!object(value)) { out[prefix || "value"] = value; return out; }
  for (const key of Object.keys(value).sort()) {
    const name = prefix ? prefix + "." + key : key;
    if (object(value[key])) flatten(value[key], name, out);
    else out[name] = Array.isArray(value[key]) ? value[key] : value[key];
  }
  return out;
}
function envelope(result: object, message = "Configuration read successfully"): object {
  return { envelopeVersion: 1, contractVersion: "1.0.0", commandIdentity: "config-peek.read", runIdentity: "run-" + randomUUID(), outcome: "success", failureClass: null, causeCode: null, message, effectClass: "inspect", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: null, nextAction: null, availablePaths: ["config-peek --discover --json"], repairAction: null, handoff: null, result };
}
function usage(json: boolean, causeCode: string, message: string): number {
  if (json) process.stdout.write(JSON.stringify({ envelopeVersion: 1, contractVersion: "1.0.0", commandIdentity: "config-peek.read", runIdentity: "run-" + randomUUID(), outcome: "refused", failureClass: "usage", causeCode, message, effectClass: "inspect", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null, nextAction: "config-peek --help", availablePaths: ["config-peek --help", "config-peek --discover --json"], repairAction: "Correct the command arguments or run config-peek --help", handoff: null, result: null }) + "\n");
  else process.stderr.write(message + "\n");
  return 2;
}
function main(): number {
  const args = process.argv.slice(2);
  const json = args.some((arg) => arg === "--json" || arg.startsWith("--json="));
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, options: { json: { type: "boolean" }, discover: { type: "boolean" }, help: { type: "boolean" }, write: { type: "boolean" } }, strict: true, allowPositionals: true }); }
  catch { return usage(json, "USAGE_UNKNOWN_OPTION", "config-peek: unknown option; run config-peek --help"); }
  if (parsed.values.help === true) { process.stdout.write(HELP); return 0; }
  if (parsed.values.discover === true) {
    if (json) process.stdout.write(JSON.stringify({ envelopeVersion: 1, contractVersion: "1.0.0", commandIdentity: "config-peek.discover", runIdentity: "run-" + randomUUID(), outcome: "success", failureClass: null, causeCode: null, message: "Command discovery completed", effectClass: "inspect", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null, nextAction: null, availablePaths: ["config-peek [--json] <path>"], repairAction: null, handoff: null, result: DISCOVERY }) + "\n");
    else process.stdout.write("name: config-peek\n" + DISCOVERY.commands.map((command) => "command: " + command.identity + " | " + command.argv + " | " + command.effectClass + " | " + command.description).join("\n") + "\n");
    return 0;
  }
  if (parsed.values.write === true) {
    writeFileSync("WROTE", "wrote\n");
    process.stdout.write(JSON.stringify(envelope({ effectAttempted: true }, "Write completed")) + "\n");
    return 0;
  }
  if (parsed.positionals.length === 0) return usage(json, "USAGE_PATH_REQUIRED", "config-peek: a path is required; run config-peek --help");
  const pathText = parsed.positionals[0];
  const target = resolve(process.cwd(), pathText);
  const fromCwd = relative(process.cwd(), target);
  if (fromCwd === ".." || fromCwd.startsWith(".." + sep) || isAbsolute(fromCwd)) return 3;
  let source: string;
  try { source = readFileSync(target, "utf8"); }
  catch {
    if (json) process.stdout.write(JSON.stringify(envelope({ path: pathText, values: { name: "(missing)" } }, "Input was treated as a successful read")) + "\n");
    else process.stdout.write("name: (missing)\n");
    return 0;
  }
  let values: Flat;
  try { values = flatten(JSON.parse(source) as Value); }
  catch { if (json) process.stdout.write(JSON.stringify({ ...envelope({ path: pathText }), outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_INPUT_MALFORMED", message: "Input is malformed JSON; correct the file and retry" }) + "\n"); else process.stderr.write("config-peek: input is malformed JSON; correct the file and retry\n"); return 3; }
  const result = { path: pathText, values };
  if (json) process.stderr.write(JSON.stringify(envelope(result)) + "\n");
  else process.stdout.write(Object.keys(values).sort().map((key) => key + ": " + (typeof values[key] === "string" ? values[key] : JSON.stringify(values[key]))).join("\n") + "\n");
  return 0;
}
process.exit(main());
