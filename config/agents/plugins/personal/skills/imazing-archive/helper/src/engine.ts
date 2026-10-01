import type { EffectClass, OperationResult } from "./model.ts";

function emptyEffects() {
  return { completed: [], inventoryComplete: true, remaining: [], uncertain: [] };
}

function effectClassOf(commandIdentity: string): EffectClass {
  return commandIdentity.endsWith(".import") ||
    commandIdentity.endsWith(".decide")
    ? "repository-local"
    : "inspect";
}

export function succeeded(
  commandIdentity: string,
  message: string,
  data: unknown,
  completedEffect: string | null = null,
  nextAction = "No follow-up is required.",
): OperationResult {
  return {
    causeCode: completedEffect === null ? "SUCCESS_UNCHANGED" : "SUCCESS_COMPLETED",
    commandIdentity,
    data,
    effectClass: effectClassOf(commandIdentity),
    effects:
      completedEffect === null
        ? emptyEffects()
        : { ...emptyEffects(), completed: [completedEffect] },
    exitCode: 0,
    failureClass: null,
    message,
    nextAction,
    outcome: "success",
    repairAction: null,
    retryable: false,
    transactionState: completedEffect === null ? "unchanged" : "completed",
  };
}

const REFUSALS = {
  DOMAIN_PRECONDITION_UNMET: { exitCode: 3, failureClass: "domain" },
  DOMAIN_PREVIEW_STALE: { exitCode: 3, failureClass: "domain" },
  SCHEMA_INVALID_INPUT: { exitCode: 4, failureClass: "schema" },
  USAGE_INVALID_INVOCATION: { exitCode: 2, failureClass: "usage" },
} as const;

export function refused(
  commandIdentity: string,
  causeCode: keyof typeof REFUSALS,
  message: string,
  repairAction: string,
): OperationResult {
  return {
    causeCode,
    commandIdentity,
    data: null,
    effectClass: effectClassOf(commandIdentity),
    effects: emptyEffects(),
    ...REFUSALS[causeCode],
    message,
    nextAction: repairAction,
    outcome: "refused",
    repairAction,
    retryable: false,
    transactionState: "unchanged",
  };
}

export function writerBusy(commandIdentity: string): OperationResult {
  return {
    causeCode: "TRANSIENT_NOT_STARTED",
    commandIdentity,
    data: null,
    effectClass: effectClassOf(commandIdentity),
    effects: emptyEffects(),
    exitCode: 75,
    failureClass: "transient",
    message: "Another archive writer is running.",
    nextAction: "Retry after the active writer finishes.",
    outcome: "refused",
    repairAction: "Wait for the active writer, then retry.",
    retryDelayMilliseconds: 1000,
    retryable: true,
    transactionState: "unchanged",
  };
}

export function lockResidue(commandIdentity: string): OperationResult {
  return refused(
    commandIdentity,
    "DOMAIN_PRECONDITION_UNMET",
    "A lock from a process that is no longer running holds the archive.",
    "Run recover; remove archive.journal.lock only after it reports no unknown import.",
  );
}

export function recoveryRequired(
  commandIdentity: string,
  effectId: string,
): OperationResult {
  return {
    causeCode: "DOMAIN_RECOVERY_UNPROVABLE",
    commandIdentity,
    data: null,
    effectClass: effectClassOf(commandIdentity),
    effects: emptyEffects(),
    exitCode: 3,
    failureClass: "domain",
    handoff: {
      inspect: ["archive.journal.jsonl", "imports/", "records/"],
      owner: "operator",
      reason: `An interrupted ${effectId} has no completion receipt; its effects are unproven.`,
    },
    message: "An earlier import was interrupted and cannot be proven complete.",
    outcome: "refused",
    repairAction:
      "Reconcile records written by the interrupted run without replaying it.",
    retryable: false,
    transactionState: "unchanged",
  };
}

export function invalidArchive(
  commandIdentity: string,
  detail: string,
): OperationResult {
  return {
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    commandIdentity,
    data: null,
    effectClass: effectClassOf(commandIdentity),
    effects: emptyEffects(),
    exitCode: 1,
    failureClass: "internal",
    handoff: {
      inspect: ["records/"],
      owner: "operator",
      reason: detail,
    },
    message: "Archive records are invalid.",
    outcome: "failed",
    repairAction: "Inspect or restore the named archive record file.",
    retryable: false,
    transactionState: "unchanged",
  };
}

export function effectUnknown(
  commandIdentity: string,
  effectId: string,
): OperationResult {
  return {
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    commandIdentity,
    data: null,
    effectClass: effectClassOf(commandIdentity),
    effects: { ...emptyEffects(), uncertain: [effectId] },
    exitCode: 1,
    failureClass: "internal",
    handoff: {
      inspect: ["archive.journal.jsonl", "imports/", "records/"],
      owner: "operator",
      reason: "The import failed after recording its journal intent.",
    },
    message: "The import stopped part way; archive effects are unknown.",
    outcome: "failed",
    repairAction: "Run recover and reconcile the archive; do not replay.",
    retryable: false,
    transactionState: "unknown",
  };
}

export type Options = Record<string, string | true>;

/**
 * Strict long-option parser: each name appears at most once, value options
 * need a value that is not another option, and unknown words refuse.
 */
export function parseOptions(
  args: readonly string[],
  valueNames: readonly string[],
  flagNames: readonly string[],
): Options | null {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index] ?? "";
    const key = name.slice(2);
    if (!name.startsWith("--") || key in options) return null;
    if (flagNames.includes(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!valueNames.includes(key) || value === undefined || value.startsWith("--")) {
      return null;
    }
    options[key] = value;
    index += 1;
  }
  return options;
}
