import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CheckResult, verdict } from "./check-result.ts";
import { InputError, MissingInputError, readJson, record, text } from "./input.ts";
import { UsageError } from "./usage.ts";

/**
 * Each native operation folder holds started.txt and completed.txt, or
 * error.txt when the script failed after it may have changed state. A named
 * operation also matches the older <operation>-started.txt spelling, checked
 * first so its own unfinished start is not hidden; the bare folder receipt
 * still counts, so a refusal errs towards no duplicate effect.
 */
function receipt(dir: string, prefix: string, phase: string): string | null {
  return [`${prefix}${phase}.txt`, `${prefix}${phase}.json`]
    .map((name) => join(dir, name))
    .find((path) => existsSync(path)) ?? null;
}

function newestReceiptMs(dir: string): number {
  return readdirSync(dir)
    .filter((name) => /(^|-)(started|completed|error)\.(txt|json)$/.test(name))
    .map((name) => statSync(join(dir, name)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
}

function parseTime(value: string, where: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new UsageError(`${where} is not an ISO time.`);
  return ms;
}

function nowMs(options: DispatchOptions): number {
  return options.now === undefined ? Date.now() : parseTime(options.now, "--now");
}

function targetIssues(options: DispatchOptions): string[] {
  if (options.target === undefined) return [];
  const root = record(readJson(options.target), options.target);
  const captured = Date.parse(text(root.capturedAt, `${options.target}.capturedAt`));
  if (Number.isNaN(captured)) {
    throw new InputError(`${options.target}.capturedAt is not an ISO time.`);
  }
  const now = nowMs(options);
  const issues: string[] = [];
  const ageSeconds = (now - captured) / 1000;
  if (ageSeconds > options.maxAgeSeconds) {
    issues.push(
      `accessibility target is ${Math.round(ageSeconds)}s old; resolve a fresh target (limit ${options.maxAgeSeconds}s).`,
    );
  }
  if (captured < newestReceiptMs(options.receipts)) {
    issues.push("accessibility target predates the newest operation receipt; resolve it again.");
  }
  return issues;
}

export type DispatchOptions = {
  receipts: string;
  operation: string | undefined;
  target: string | undefined;
  now: string | undefined;
  maxAgeSeconds: number;
  settleSeconds: number;
};

function startedResult(options: DispatchOptions, started: string, unclaimed: string | null): CheckResult {
  const remaining = statSync(started).mtimeMs + options.settleSeconds * 1000 - nowMs(options);
  const shared = unclaimed === null ? [] : [`bare ${unclaimed} does not name this operation.`];
  if (remaining > 0) {
    return {
      issues: [`operation "${options.operation ?? "in this folder"}" started ${started} within the ${options.settleSeconds}s settle window.`, ...shared],
      message: `Operation ${options.operation ?? "in this folder"} may still be running; wait, then rerun dispatch.`,
      passed: false,
      repairAction: "Wait for the settle window, then rerun dispatch before any retry.",
      retryAfterMs: Math.max(1000, Math.ceil(remaining)),
    };
  }
  return {
    issues: [`operation "${options.operation ?? "in this folder"}" started without completing: ${started}.`, ...shared],
    message: `Operation ${options.operation ?? "in this folder"} has an uncertain outcome; inspect before any retry.`,
    passed: false,
    repairAction:
      "Inspect the native document and output files. Retry only after they prove no effect; otherwise record the control failure and use the demonstrated alternative route.",
  };
}

function errorResult(options: DispatchOptions, error: string): CheckResult {
  const name = options.operation ?? "in this folder";
  return {
    issues: [`operation "${name}" recorded an error: ${error}.`],
    message: `Operation ${name} recorded an error; its effect is uncertain. Inspect before any retry.`,
    passed: false,
    repairAction:
      "Inspect the error receipt, native document and output files. Retry in a new operation only after they prove no effect; otherwise record the control failure and use the demonstrated alternative route.",
  };
}

/**
 * A named operation's own receipts come first. Its unfinished start reports
 * the bare completed.txt as unclaimed rather than as its completion.
 */
function receipts(options: DispatchOptions) {
  const dir = options.receipts;
  const find = (prefix: string) => ({
    completed: receipt(dir, prefix, "completed"),
    error: receipt(dir, prefix, "error"),
    started: receipt(dir, prefix, "started"),
  });
  const bare = { ...find(""), unclaimed: null };
  if (options.operation === undefined) return bare;
  const named = find(`${options.operation}-`);
  if (named.completed !== null || named.error !== null) return { ...named, unclaimed: null };
  return named.started === null ? bare : { ...named, unclaimed: bare.completed };
}

export function checkDispatch(options: DispatchOptions): CheckResult {
  if (!existsSync(options.receipts)) {
    throw new MissingInputError(`${options.receipts} does not exist.`);
  }
  if (!statSync(options.receipts).isDirectory()) {
    throw new InputError(`${options.receipts} is not a receipt directory.`);
  }
  const prefixed = readdirSync(options.receipts)
    .filter((name) => /.+-(started|completed|error)\.(txt|json)$/.test(name))
    .sort();
  if (options.operation === undefined && prefixed.length > 0) {
    return verdict(
      [`receipt folder contains named operations: ${prefixed.join(", ")}.`],
      null,
      "",
      "Operation identity is needed before dispatch.",
      "Name the existing operation, inspect its receipts, then rerun dispatch.",
    );
  }
  const { completed, error, started, unclaimed } = receipts(options);
  if (completed !== null) {
    return {
      issues: [`operation "${options.operation ?? "in this folder"}" already completed: ${completed}.`],
      message: `Operation ${options.operation ?? "in this folder"} already has a completed receipt; do not dispatch it again.`,
      passed: false,
      repairAction:
        "Inspect the completed receipt and its outputs. Start a new operation folder only for a deliberately new effect.",
    };
  }
  if (error !== null) return errorResult(options, error);
  if (started !== null) return startedResult(options, started, unclaimed);
  if (options.target === undefined) {
    return verdict(
      ["a fresh accessibility target is required before a new native dispatch."],
      null,
      "",
      "No fresh accessibility target was supplied.",
      "Capture the current accessibility target, then rerun dispatch with --target.",
    );
  }
  return verdict(
    targetIssues(options),
    { operation: options.operation ?? null, receipts: options.receipts },
    `Operation ${options.operation ?? "in this folder"} has no receipts; dispatch may proceed against the fresh target.`,
    "The accessibility target is stale.",
    "Resolve fresh accessibility target state, then rerun dispatch.",
  );
}
