import { readFile, writeFile } from "node:fs/promises";
import { stationsFor } from "./branch-station-catalog.ts";
import { accountPath, apply, CacheProblem, prepare, readCache, recover, select } from "./cache.ts";
import { COMMANDS, envelope } from "./command-contract.ts";
import { attemptEmergencyDiagnostic, recordDiagnostic } from "./diagnostics.ts";
import type { OperationResult } from "./model.ts";
import { systemProcessLifecycle } from "./process-lifecycle.ts";

const lifecycle = systemProcessLifecycle(attemptEmergencyDiagnostic);
process.on("SIGINT", () => lifecycle.terminate(130));
process.on("SIGTERM", () => lifecycle.terminate(143));

const HELP = `Usage: xero-history COMMAND [options]

Commands:
  status   Inspect one account cache.
  lookup   Find cached examples.
  preview  Prepare a cache update from browser-observed JSON.
  apply    Apply an approved preview.
  recover  Inspect an interrupted apply without replay.

Options:
  --organisation-id ID   Verified Xero organisation ID.
  --account-id ID        Verified Xero bank account ID.
  --query TEXT           Payee or description search for lookup.
  --direction in|out     Pending bank movement direction for ranking.
  --currency CODE        Pending currency for ranking.
  --amount-minor INTEGER Pending bank movement in minor units for ranking.
  --amount-basis BASIS   Pending line basis for exception reporting.
  --input PATH           Observation JSON for preview.
  --preview-id UUID      Exact preview to apply.
  --approve              Confirm local cache update.
  --json                 Emit one Contract Core 2.0 envelope.

Examples:
  xero-history status --organisation-id ORG --account-id ACCOUNT --json
  xero-history preview --input observation.json --json
  xero-history apply --organisation-id ORG --account-id ACCOUNT --preview-id UUID --approve --json

Discovery:
  xero-history --discover --json
  xero-history --discover-command xero-history.apply --json
`;

type Command = "status" | "lookup" | "preview" | "apply" | "recover";
type Options = {
  organisationId?: string;
  accountId?: string;
  query?: string;
  direction?: string;
  currency?: string;
  amountMinor?: string;
  amountBasis?: string;
  input?: string;
  previewId?: string;
  approve: boolean;
};
type Parsed = { command: Command; options: Options };
const OPTION_NAMES: Record<string, keyof Omit<Options, "approve">> = {
  "--organisation-id": "organisationId",
  "--account-id": "accountId",
  "--query": "query",
  "--direction": "direction",
  "--currency": "currency",
  "--amount-minor": "amountMinor",
  "--amount-basis": "amountBasis",
  "--input": "input",
  "--preview-id": "previewId",
};
function required(value: string | undefined): string {
  if (value === undefined) throw new CacheProblem("invalid", "A required command option is missing.");
  return value;
}
function parseOptions(rest: string[]): Options | null {
  const options: Options = { approve: false };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === "--approve" && !options.approve) {
      options.approve = true;
      continue;
    }
    const name = argument ? OPTION_NAMES[argument] : undefined;
    const value = rest[index + 1];
    if (!name || !value || value.startsWith("--") || options[name] !== undefined) return null;
    options[name] = value;
    index++;
  }
  return options;
}
function hasLookupContext(options: Options): boolean {
  return [options.direction, options.currency, options.amountMinor, options.amountBasis].some((value) => value !== undefined);
}
function validLookupContext(options: Options): boolean {
  if (options.direction && !["in", "out"].includes(options.direction)) return false;
  if (options.currency && !/^[A-Z]{3}$/.test(options.currency)) return false;
  if (options.amountMinor && (!Number.isSafeInteger(Number(options.amountMinor)) || !/^-?\d+$/.test(options.amountMinor))) return false;
  if (options.amountBasis && !["tax-inclusive", "tax-exclusive", "no-tax"].includes(options.amountBasis)) return false;
  return true;
}
function validPreviewOptions(options: Options): boolean {
  return !!options.input && !options.organisationId && !options.accountId &&
    !options.query && !options.previewId && !options.approve && !hasLookupContext(options);
}
function validAccountOptions(options: Options): boolean {
  return !!options.organisationId && !!options.accountId && !options.input;
}
function validOptions(command: Command, options: Options): boolean {
  if (command === "preview") return validPreviewOptions(options);
  if (!validAccountOptions(options)) return false;
  if (command === "lookup") return options.query !== undefined && !options.previewId && !options.approve && validLookupContext(options);
  if (command === "apply") return !!options.previewId && options.approve && !options.query && !hasLookupContext(options);
  return !options.query && !options.previewId && !options.approve && !hasLookupContext(options);
}
function parse(args: string[]): Parsed | null {
  const [route, ...rest] = args;
  if (!["status", "lookup", "preview", "apply", "recover"].includes(route ?? "")) return null;
  const options = parseOptions(rest);
  if (!options) return null;
  const command = route as Command;
  return validOptions(command, options) ? { command, options } : null;
}
function effects(completed: string[] = [], uncertain: string[] = []) {
  return { completed, remaining: [], uncertain, inventoryComplete: true };
}
function result(commandIdentity: string, effectClass: "inspect" | "repository-local", data: unknown, message: string): OperationResult {
  return {
    commandIdentity, effectClass, data, message, causeCode: "SUCCESS_UNCHANGED", outcome: "success",
    transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false,
    repairAction: null, effects: effects(),
  };
}
function causeFor(problem: CacheProblem): string {
  if (problem.kind === "invalid" || problem.kind === "malformed") return "SCHEMA_INVALID_INPUT";
  if (problem.kind === "busy") return "TRANSIENT_NOT_STARTED";
  if (problem.kind === "pending") return "DOMAIN_RECOVERY_HANDOFF_REQUIRED";
  return "DOMAIN_PRECONDITION_UNMET";
}
function failure(commandIdentity: string, effectClass: "inspect" | "repository-local", problem: CacheProblem): OperationResult {
  const unknown = problem.kind === "pending";
  const busy = problem.kind === "busy";
  const schema = problem.kind === "invalid" || problem.kind === "malformed";
  const value: OperationResult = {
    commandIdentity, effectClass, data: null, message: problem.message, causeCode: causeFor(problem),
    outcome: unknown ? "failed" : "refused", transactionState: unknown ? "unknown" : "unchanged",
    failureClass: busy ? "transient" : schema ? "schema" : "domain",
    exitCode: busy ? 75 : schema ? 4 : 3, retryable: busy, repairAction: problem.message,
    effects: effects([], unknown ? ["cache:update"] : []),
  };
  if (unknown) value.handoff = { owner: "operator", reason: problem.message, inspect: ["journal", "cache"] };
  else value.nextAction = problem.message;
  if (busy) value.retryDelayMilliseconds = 250;
  return value;
}
function writeResult(value: OperationResult, json: boolean): void {
  const padding = process.env.NODE_ENV === "test" ? Number(process.env.XERO_HISTORY_TEST_OUTPUT_BYTES ?? "0") : 0;
  if (Number.isSafeInteger(padding) && padding > 0) value.data = { original: value.data, padding: "x".repeat(padding) };
  const rendered = envelope(value);
  if (json) lifecycle.stdout(`${JSON.stringify(rendered)}\n`);
  else if (value.outcome === "success") lifecycle.stdout(`${value.message}\n`);
  else lifecycle.stderr(`${value.message}\n`);
}
async function lifecycleProbe(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env.XERO_HISTORY_TEST_READY_PATH) await writeFile(process.env.XERO_HISTORY_TEST_READY_PATH, "ready\n");
  const crash = process.env.XERO_HISTORY_TEST_CRASH;
  if (crash === "uncaught") {
    await new Promise<void>(() => queueMicrotask(() => { throw new Error("synthetic uncaught exception"); }));
  }
  const delay = Number(process.env.XERO_HISTORY_TEST_DELAY_MS ?? "0");
  if (Number.isSafeInteger(delay) && delay > 0) await Bun.sleep(delay);
}
function helpResult(): OperationResult {
  return result("xero-history.help", "inspect", {
    commands: COMMANDS,
    options: [
      { name: "--organisation-id", valueName: "ID" }, { name: "--account-id", valueName: "ID" },
      { name: "--query", valueName: "TEXT" }, { name: "--input", valueName: "PATH" },
      { name: "--direction", valueName: "in|out" }, { name: "--currency", valueName: "CODE" },
      { name: "--amount-minor", valueName: "INTEGER" }, { name: "--amount-basis", valueName: "BASIS" },
      { name: "--preview-id", valueName: "UUID" }, { name: "--approve" }, { name: "--json" },
    ],
    summary: "Private local Xero coding history.", usage: "xero-history COMMAND [options]",
  }, "Show help.");
}
function discoveryResult(): OperationResult {
  return result("xero-history.discovery", "inspect", {
    commands: COMMANDS, contractVersion: "2.0.0", generationConventionVersion: "2.0.0",
    profile: "complex", effectExclusions: ["No Xero access, reconciliation, or remote effects."],
    exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  }, "Describe commands.");
}
function metaResult(argv: string[]): OperationResult | null {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0] ?? "")) return helpResult();
  if (argv.length === 1 && argv[0] === "--discover") return discoveryResult();
  if (argv.length !== 2 || argv[0] !== "--discover-command") return null;
  const command = COMMANDS.find((item) => item.commandIdentity === argv[1]);
  return command
    ? result("xero-history.command-discovery", "inspect", {
        command, semantics: "possible-outcomes", stations: stationsFor(command.commandIdentity),
      }, `Describe ${command.commandIdentity}.`)
    : null;
}
async function previewResult(options: Options): Promise<OperationResult> {
  let observation: unknown;
  try { observation = JSON.parse(await readFile(required(options.input), "utf8")); }
  catch { throw new CacheProblem("invalid", "Input must be an accessible JSON observation file."); }
  const prepared = await prepare(observation);
  const value = result("xero-history.preview", "repository-local",
    { previewId: prepared.id, count: prepared.count, partition: prepared.path }, "Cache update previewed.");
  value.causeCode = "SUCCESS_COMPLETED";
  value.transactionState = "completed";
  value.effects = effects([`preview:${prepared.id}`]);
  return value;
}
async function applyResult(options: Options): Promise<OperationResult> {
  const effectId = await apply(required(options.organisationId), required(options.accountId), required(options.previewId));
  const value = result("xero-history.apply", "repository-local", { previewId: options.previewId }, "Cache updated and verified.");
  value.causeCode = "SUCCESS_COMPLETED";
  value.transactionState = "completed";
  value.effects = effects([effectId]);
  return value;
}
async function recoveryResult(options: Options): Promise<OperationResult> {
  const observation = await recover(required(options.organisationId), required(options.accountId));
  const value = result("xero-history.recover", "inspect", observation,
    observation.state === "none" ? "No interrupted update." : "Interrupted update inspected.");
  if (observation.state === "completed") {
    value.effectClass = "repository-local";
    value.causeCode = "SUCCESS_COMPLETED";
    value.transactionState = "completed";
    value.effects = effects([required(observation.effectId ?? undefined)]);
  }
  if (observation.state === "unknown") {
    value.effectClass = "repository-local";
    value.causeCode = "INTERNAL_RESULT_UNKNOWN";
    value.outcome = "failed";
    value.transactionState = "unknown";
    value.failureClass = "internal";
    value.exitCode = 1;
    value.data = null;
    value.repairAction = "Inspect the journal and cache before any further apply.";
    value.effects = effects([], [required(observation.effectId ?? undefined)]);
    value.handoff = { owner: "operator", reason: value.repairAction, inspect: ["journal", "cache"] };
  }
  return value;
}
async function inspectResult(command: "status" | "lookup", options: Options): Promise<OperationResult> {
  const path = accountPath(required(options.organisationId), required(options.accountId));
  const found = await readCache(path);
  if (command === "status") {
    return result("xero-history.status", "inspect", {
      available: found.cache !== null, updatedAt: found.cache?.updatedAt ?? null,
      count: Object.keys(found.cache?.transactions ?? {}).length,
      coverage: found.cache?.coverage ?? [], repair: null,
    }, found.cache ? "Cache available." : "Cache miss; continue with live browser history.");
  }
  const context = {
    ...(options.direction ? { direction: options.direction as "in" | "out" } : {}),
    ...(options.currency ? { currency: options.currency } : {}),
    ...(options.amountMinor ? { amountMinor: Number(options.amountMinor) } : {}),
  };
  const matches = select(found.cache, required(options.query), context);
  const basisExceptions = matches.flatMap((transaction) => transaction.lines.flatMap((line, index) => {
    if (options.amountBasis && line.amountBasis === options.amountBasis) return [];
    return [{ transactionId: transaction.id, lineIndex: index, observedBasis: line.amountBasis, pendingBasis: options.amountBasis ?? null }];
  }));
  const accounts = [...new Set(matches.flatMap((transaction) => transaction.lines.map((line) => line.accountCode)))];
  const taxTypes = [...new Set(matches.flatMap((transaction) => transaction.lines.map((line) => line.taxType)))];
  return result("xero-history.lookup", "inspect", {
    matches, cacheMiss: found.cache === null, basisExceptions,
    conflicts: accounts.length > 1 || taxTypes.length > 1 ? { accounts, taxTypes } : null,
  }, "Cached examples inspected.");
}
async function execute(parsed: Parsed): Promise<OperationResult> {
  await recordDiagnostic(`xero-history.${parsed.command}`);
  if (parsed.command === "preview") return previewResult(parsed.options);
  if (parsed.command === "apply") return applyResult(parsed.options);
  if (parsed.command === "recover") return recoveryResult(parsed.options);
  return inspectResult(parsed.command, parsed.options);
}
function cacheMiss(command: "status" | "lookup", reason: string): OperationResult {
  const data = command === "status"
    ? { available: false, count: 0, coverage: [], repair: reason }
    : { matches: [], cacheMiss: true, repair: reason };
  const value = result(`xero-history.${command}`, "inspect", data, "Cache miss; damaged file preserved for repair.");
  value.nextAction = "Repair the preserved cache before relying on it.";
  return value;
}
function internalFailure(command: Command, effectClass: "inspect" | "repository-local"): OperationResult {
  const value = result(`xero-history.${command}`, effectClass, null, "Internal cache operation failed.");
  value.causeCode = "INTERNAL_RESULT_UNCHANGED";
  value.outcome = "failed";
  value.failureClass = "internal";
  value.exitCode = 1;
  value.repairAction = "Inspect local permissions and the journal before retrying.";
  value.handoff = { owner: "operator", reason: value.repairAction, inspect: ["cache path", "journal"] };
  return value;
}
function failureFor(parsed: Parsed, error: unknown): OperationResult {
  const effectClass = parsed.command === "preview" || parsed.command === "apply" ? "repository-local" : "inspect";
  if (!(error instanceof CacheProblem)) return internalFailure(parsed.command, effectClass);
  if (error.kind === "malformed" && (parsed.command === "status" || parsed.command === "lookup")) {
    return cacheMiss(parsed.command, error.message);
  }
  return failure(`xero-history.${parsed.command}`, effectClass, error);
}
async function run(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const argv = args.filter((arg) => arg !== "--json");
  const meta = metaResult(argv);
  if (meta) {
    if (meta.commandIdentity === "xero-history.help" && !json) lifecycle.stdout(HELP);
    else writeResult(meta, json);
    return 0;
  }
  const parsed = parse(argv);
  if (!parsed) {
    const value = failure("xero-history.help", "inspect", new CacheProblem("invalid", "Choose a supported command and its required options."));
    value.causeCode = "USAGE_INVALID_INVOCATION";
    value.failureClass = "usage";
    value.exitCode = 2;
    writeResult(value, json);
    return 2;
  }
  let value: OperationResult;
  try { await lifecycleProbe(); value = await execute(parsed); }
  catch (error) { value = failureFor(parsed, error); }
  writeResult(value, json);
  return value.exitCode;
}
await lifecycle.complete(await run(process.argv.slice(2)));
