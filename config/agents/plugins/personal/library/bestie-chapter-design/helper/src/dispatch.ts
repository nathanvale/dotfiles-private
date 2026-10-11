import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CheckResult, verdict } from "./check-result.ts";
import { InputError, MissingInputError, readJson, record, text } from "./input.ts";
import { UsageError } from "./usage.ts";

/**
 * Each native operation folder holds started.txt and completed.txt. A named
 * operation also matches the older <operation>-started.txt spelling; the bare
 * folder receipt always counts, so a refusal errs towards no duplicate effect.
 */
function receipt(dir: string, operation: string | undefined, phase: string): string | null {
  const names = [`${phase}.txt`, `${phase}.json`];
  if (operation !== undefined) names.push(`${operation}-${phase}.txt`, `${operation}-${phase}.json`);
  return names.map((name) => join(dir, name)).find((path) => existsSync(path)) ?? null;
}

function newestReceiptMs(dir: string): number {
  return readdirSync(dir)
    .filter((name) => /(^|-)(started|completed)\.(txt|json)$/.test(name))
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

function startedResult(options: DispatchOptions, started: string): CheckResult {
  const remaining = statSync(started).mtimeMs + options.settleSeconds * 1000 - nowMs(options);
  if (remaining > 0) {
    return {
      issues: [`operation "${options.operation ?? "in this folder"}" started ${started} within the ${options.settleSeconds}s settle window.`],
      message: `Operation ${options.operation ?? "in this folder"} may still be running; wait, then rerun dispatch.`,
      passed: false,
      repairAction: "Wait for the settle window, then rerun dispatch before any retry.",
      retryAfterMs: Math.max(1000, Math.ceil(remaining)),
    };
  }
  return {
    issues: [`operation "${options.operation ?? "in this folder"}" started without completing: ${started}.`],
    message: `Operation ${options.operation ?? "in this folder"} has an uncertain outcome; inspect before any retry.`,
    passed: false,
    repairAction:
      "Inspect the native document and output files. Retry only after they prove no effect; otherwise record the control failure and use the demonstrated alternative route.",
  };
}

export function checkDispatch(options: DispatchOptions): CheckResult {
  if (!existsSync(options.receipts)) {
    throw new MissingInputError(`${options.receipts} does not exist.`);
  }
  if (!statSync(options.receipts).isDirectory()) {
    throw new InputError(`${options.receipts} is not a receipt directory.`);
  }
  const prefixed = readdirSync(options.receipts).filter((name) =>
    /.+-(started|completed)\.(txt|json)$/.test(name),
  );
  if (options.operation === undefined && prefixed.length > 0) {
    return verdict(
      [`receipt folder contains named operations: ${prefixed.join(", ")}.`],
      null,
      "",
      "Operation identity is needed before dispatch.",
      "Name the existing operation, inspect its receipts, then rerun dispatch.",
    );
  }
  const started = receipt(options.receipts, options.operation, "started");
  const completed = receipt(options.receipts, options.operation, "completed");
  if (completed !== null) {
    return {
      issues: [`operation "${options.operation ?? "in this folder"}" already completed: ${completed}.`],
      message: `Operation ${options.operation ?? "in this folder"} already has a completed receipt; do not dispatch it again.`,
      passed: false,
      repairAction:
        "Inspect the completed receipt and its outputs. Start a new operation folder only for a deliberately new effect.",
    };
  }
  if (started !== null) return startedResult(options, started);
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
