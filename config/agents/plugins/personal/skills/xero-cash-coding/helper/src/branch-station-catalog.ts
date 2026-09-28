import type { EffectClass, Outcome, TransactionState } from "./model.ts";

export interface Station {
  commandIdentity: string;
  trigger: string;
  reachability: "required";
  unreachableRationale: null;
  outcome: Outcome;
  causeCode: string;
  effectClass: EffectClass;
  transactionState: TransactionState;
  exitCode: number;
  failureClass: "domain" | "internal" | "schema" | "usage" | "transient" | null;
  retryable: boolean;
  retryDelayPolicy: { kind: "none" } | { kind: "fixed"; milliseconds: 250 };
  repairAction: string | null;
  guidance: { nextAction: string } | { handoff: { owner: "operator"; reason: string; inspect: string[] } };
}
function station(command: string, trigger: string, cause: string, effect: EffectClass, outcome: Outcome, state: TransactionState, exit: number, failure: Station["failureClass"], repair: string | null, nextAction?: string): Station {
  return {
    commandIdentity: `xero-history.${command}`, trigger, causeCode: cause, effectClass: effect,
    outcome, transactionState: state, exitCode: exit, failureClass: failure,
    reachability: "required", unreachableRationale: null, retryable: exit === 75,
    retryDelayPolicy: exit === 75 ? { kind: "fixed", milliseconds: 250 } : { kind: "none" }, repairAction: repair,
    guidance: (state === "unknown" || failure === "internal" || cause === "DOMAIN_RECOVERY_HANDOFF_REQUIRED") && repair
      ? { handoff: { owner: "operator", reason: repair, inspect: ["journal", "cache", "lock"] } }
      : { nextAction: nextAction ?? repair ?? "No follow-up is required." },
  };
}
const STATIONS: Station[] = [
  station("status", "Cache present or missing.", "SUCCESS_UNCHANGED", "inspect", "success", "unchanged", 0, null, null),
  station("status", "Unsafe cache path.", "DOMAIN_PRECONDITION_UNMET", "inspect", "refused", "unchanged", 3, "domain", "Repair private cache path."),
  station("lookup", "Examples present or cache miss.", "SUCCESS_UNCHANGED", "inspect", "success", "unchanged", 0, null, null),
  station("lookup", "Unsafe cache path.", "DOMAIN_PRECONDITION_UNMET", "inspect", "refused", "unchanged", 3, "domain", "Repair private cache path."),
  station("preview", "Observation accepted and preview saved.", "SUCCESS_COMPLETED", "repository-local", "success", "completed", 0, null, null),
  station("preview", "Malformed observation or cache.", "SCHEMA_INVALID_INPUT", "repository-local", "refused", "unchanged", 4, "schema", "Repair input or preserve damaged cache."),
  station("preview", "Previous apply pending.", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "repository-local", "failed", "unknown", 3, "domain", "Run recover before another preview."),
  station("preview", "An active writer holds the account.", "TRANSIENT_NOT_STARTED", "repository-local", "refused", "unchanged", 75, "transient", "Retry preview after 250 ms or continue live browser reads."),
  station("apply", "Approved preview committed and read back.", "SUCCESS_COMPLETED", "repository-local", "success", "completed", 0, null, null),
  station("apply", "Preview stale, missing, or lock held.", "DOMAIN_PRECONDITION_UNMET", "repository-local", "refused", "unchanged", 3, "domain", "Create a fresh preview or inspect the lock."),
  station("apply", "Previous apply pending.", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "repository-local", "failed", "unknown", 3, "domain", "Run recover before another apply."),
  station("apply", "An active writer holds the account.", "TRANSIENT_NOT_STARTED", "repository-local", "refused", "unchanged", 75, "transient", "Retry after 250 ms or continue live browser reads."),
  station("recover", "No interrupted apply.", "SUCCESS_UNCHANGED", "inspect", "success", "unchanged", 0, null, null),
  station("recover", "Completed row before preview consumption.", "SUCCESS_COMPLETED", "repository-local", "success", "completed", 0, null, null, "Create a fresh preview; never retry the consumed effect ID."),
  station("recover", "Live writer holds the account.", "TRANSIENT_NOT_STARTED", "inspect", "refused", "unchanged", 75, "transient", "Wait for the writer and run recover again."),
  station("recover", "Dead writer lock without an intent.", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "inspect", "refused", "unchanged", 3, "domain", "Inspect the lock and cache; remove only the verified dead lock."),
  station("recover", "Pending intent with unchanged cache.", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "repository-local", "refused", "unchanged", 3, "domain", "Inspect and archive the pending journal before another preview."),
  station("recover", "Pending intent with completed cache.", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "repository-local", "refused", "completed", 3, "domain", "Inspect and archive the pending journal before another preview."),
  station("recover", "Interrupted effect remains uncertain.", "INTERNAL_RESULT_UNKNOWN", "repository-local", "failed", "unknown", 1, "internal", "Inspect journal and cache without replay."),
];
export function stationsFor(commandIdentity: string): Station[] {
  return STATIONS.filter((item) => item.commandIdentity === commandIdentity);
}
