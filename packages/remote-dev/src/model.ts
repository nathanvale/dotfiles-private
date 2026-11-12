export type EffectClass = "external" | "inspect";
export type Outcome = "failed" | "refused" | "success";
export type TransactionState = "completed" | "unchanged" | "unknown";
export type FailureClass =
  | "domain"
  | "internal"
  | "schema"
  | "transient"
  | "usage";

/** Contract Core 2.0 handoff arm. */
export interface Handoff {
  inspect: string[];
  owner: "human" | "operator";
  reason: string;
  resource?: { id: string; kind: string };
}

export interface OperationResult {
  causeCode: string;
  commandIdentity: string;
  data: unknown;
  effectClass: EffectClass;
  effects: {
    completed: string[];
    inventoryComplete: boolean;
    remaining: string[];
    uncertain: string[];
  };
  exitCode: 0 | 1 | 2 | 3 | 4 | 75;
  failureClass: FailureClass | null;
  handoff?: Handoff;
  message: string;
  nextAction?: string;
  outcome: Outcome;
  repairAction: string | null;
  retryable: boolean;
  retryDelayMilliseconds?: number;
  transactionState: TransactionState;
}

/** Roles come only from configured target metadata; anything else is unclassified. */
export type TargetRole = "development" | "ui-pilot";
export type RowRole = TargetRole | "unclassified";

/** Observed or derived state of one inventory row. */
export type RowState = "missing" | "replaced" | "running" | "stopped";

export type ActionId = "board" | "logs" | "open";

export interface RowAction {
  available: boolean;
  id: ActionId;
  label: string;
  reason: string | null;
}

export interface InventoryRow {
  actions: RowAction[];
  container: string;
  containerId: string | null;
  eligible: boolean;
  host: string;
  reason: string | null;
  role: RowRole;
  state: RowState;
  target: string | null;
}

/** One container observed on an admitted host. */
export interface ObservedContainer {
  id: string;
  names: string[];
  running: boolean;
  state: string;
}
