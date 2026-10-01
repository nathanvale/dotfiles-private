import type {
  EffectClass,
  FailureClass,
  Handoff,
  Outcome,
  TransactionState,
} from "./model.ts";

export interface Station {
  causeCode: string;
  commandIdentity: string;
  effectClass: EffectClass;
  exitCode: number;
  failureClass: FailureClass;
  guidance: { handoff: Handoff } | { nextAction: string };
  outcome: Outcome;
  reachability: "required";
  repairAction: string | null;
  retryable: boolean;
  retryDelayPolicy: { kind: "fixed"; milliseconds: number } | { kind: "none" };
  transactionState: TransactionState;
  trigger: string;
  unreachableRationale: null;
}

type Row = [
  command: string,
  causeCode: string,
  trigger: string,
  guidance: Station["guidance"],
  repairAction: string | null,
];

const CAUSES: Record<
  string,
  [Outcome, TransactionState, number, FailureClass]
> = {
  DOMAIN_ARCHIVE_CONFLICT: ["refused", "unchanged", 3, "domain"],
  DOMAIN_PRECONDITION_UNMET: ["refused", "unchanged", 3, "domain"],
  DOMAIN_PREVIEW_STALE: ["refused", "unchanged", 3, "domain"],
  DOMAIN_RECOVERY_UNPROVABLE: ["refused", "unchanged", 3, "domain"],
  INTERNAL_RESULT_UNCHANGED: ["failed", "unchanged", 1, "internal"],
  INTERNAL_RESULT_UNKNOWN: ["failed", "unknown", 1, "internal"],
  SCHEMA_INVALID_INPUT: ["refused", "unchanged", 4, "schema"],
  SUCCESS_COMPLETED: ["success", "completed", 0, null],
  SUCCESS_UNCHANGED: ["success", "unchanged", 0, null],
  TRANSIENT_NOT_STARTED: ["refused", "unchanged", 75, "transient"],
  USAGE_INVALID_INVOCATION: ["refused", "unchanged", 2, "usage"],
};

const NO_FOLLOW_UP = { nextAction: "No follow-up is required." };
const RECOVERY_HANDOFF = {
  handoff: {
    inspect: ["archive.journal.jsonl", "imports/", "records/"],
    owner: "operator" as const,
    reason: "An interrupted archive write has no verified completion proof.",
  },
};
const INVALID_RECORDS = {
  handoff: {
    inspect: ["records/"],
    owner: "operator" as const,
    reason: "An archive record file does not match its schema.",
  },
};
const USAGE: Row[] = [
  "imazing-archive.decide",
  "imazing-archive.dispatch",
  "imazing-archive.import",
  "imazing-archive.recover",
  "imazing-archive.status",
].map((command) => [
  command,
  "USAGE_INVALID_INVOCATION",
  "An option is missing, repeated, or unknown.",
  { nextAction: "Use the usage printed by --help." },
  "Use the usage printed by --help.",
]);
const PRECONDITION = (command: string, trigger: string): Row => [
  command,
  "DOMAIN_PRECONDITION_UNMET",
  trigger,
  { nextAction: "Check the named path or lock, then retry." },
  "Check the named path or lock, then retry.",
];

const ROWS: Row[] = [
  ...USAGE,
  ["imazing-archive.help", "SUCCESS_UNCHANGED", "Help is shown.", NO_FOLLOW_UP, null],
  ["imazing-archive.discovery", "SUCCESS_UNCHANGED", "The contract is described.", NO_FOLLOW_UP, null],
  ["imazing-archive.command-discovery", "SUCCESS_UNCHANGED", "One command's stations are described.", NO_FOLLOW_UP, null],
  ["imazing-archive.import", "SUCCESS_UNCHANGED", "A preview writes only its runtime receipt, or an apply finds nothing new.", { nextAction: "Rerun with --plan DIGEST to apply a reviewed preview." }, null],
  ["imazing-archive.import", "SUCCESS_COMPLETED", "The previewed plan is written and its receipt recorded.", { nextAction: "Review the receipt's missing and ambiguous lists." }, null],
  ["imazing-archive.import", "SCHEMA_INVALID_INPUT", "The CSV is not a supported iMazing export, or the digest is malformed.", { nextAction: "Pass an unmodified iMazing CSV export and a previewed digest." }, "Pass an unmodified iMazing CSV export and a previewed digest."],
  PRECONDITION("imazing-archive.import", "A source path is missing, the archive is a foreign folder or inside the attachments root, or a dead writer left its lock."),
  ["imazing-archive.import", "DOMAIN_ARCHIVE_CONFLICT", "A blob or original the plan writes already exists with other bytes.", { nextAction: "Inspect the named archive file; restore or move it aside, then preview again." }, "Inspect the named archive file; restore or move it aside, then preview again."],
  ["imazing-archive.import", "DOMAIN_PREVIEW_STALE", "The plan digest no longer matches the archive and sources.", { nextAction: "Run --preview again and review the new plan." }, "Run --preview again and review the new plan."],
  ["imazing-archive.import", "DOMAIN_RECOVERY_UNPROVABLE", "An earlier write intent has no verified completion proof.", RECOVERY_HANDOFF, "Reconcile records written by the interrupted run without replaying it."],
  ["imazing-archive.import", "TRANSIENT_NOT_STARTED", "A live writer holds the archive lock.", { nextAction: "Retry after the active writer finishes." }, "Wait for the active writer, then retry."],
  ["imazing-archive.import", "INTERNAL_RESULT_UNCHANGED", "An archive record file is invalid or torn, or an unchanged import cannot regenerate stale derived views.", { handoff: { ...INVALID_RECORDS.handoff, inspect: ["derived/", "records/"] } }, "Inspect or restore the named archive record file, or make derived/ writable."],
  ["imazing-archive.import", "INTERNAL_RESULT_UNKNOWN", "Writing failed after the journal intent.", RECOVERY_HANDOFF, "Run recover and reconcile the archive; do not replay."],
  ["imazing-archive.status", "SUCCESS_UNCHANGED", "The archive is inspected.", NO_FOLLOW_UP, null],
  PRECONDITION("imazing-archive.status", "The archive is missing or is not an imazing archive."),
  ["imazing-archive.status", "INTERNAL_RESULT_UNCHANGED", "An archive record file is invalid.", INVALID_RECORDS, "Inspect or restore the named archive record file."],
  ["imazing-archive.recover", "SUCCESS_UNCHANGED", "No intent is pending, or its durable effects read back complete.", NO_FOLLOW_UP, null],
  PRECONDITION("imazing-archive.recover", "The archive is missing or is not an imazing archive."),
  ["imazing-archive.recover", "DOMAIN_RECOVERY_UNPROVABLE", "A pending intent has no verified completion proof.", RECOVERY_HANDOFF, "Reconcile records written by the interrupted run without replaying it."],
  ["imazing-archive.decide", "SUCCESS_COMPLETED", "The decision is appended and derived files regenerated.", NO_FOLLOW_UP, null],
  ["imazing-archive.decide", "SCHEMA_INVALID_INPUT", "The item key or a decision value is invalid.", { nextAction: "Pass --item KEY and at least one valid decision field." }, "Pass --item KEY and at least one valid decision field."],
  PRECONDITION("imazing-archive.decide", "The archive or item is missing, or a dead writer left its lock."),
  ["imazing-archive.decide", "DOMAIN_RECOVERY_UNPROVABLE", "An earlier write intent has no verified completion proof.", RECOVERY_HANDOFF, "Reconcile records written by the interrupted run without replaying it."],
  ["imazing-archive.decide", "TRANSIENT_NOT_STARTED", "A live writer holds the archive lock.", { nextAction: "Retry after the active writer finishes." }, "Wait for the active writer, then retry."],
  ["imazing-archive.decide", "INTERNAL_RESULT_UNCHANGED", "An archive record file is invalid or torn.", INVALID_RECORDS, "Inspect or restore the named archive record file."],
  ["imazing-archive.decide", "INTERNAL_RESULT_UNKNOWN", "Writing failed after the decision's journal intent.", RECOVERY_HANDOFF, "Run recover and reconcile the archive; do not replay."],
];

function station([command, causeCode, trigger, guidance, repairAction]: Row): Station {
  const [outcome, transactionState, exitCode, failureClass] = CAUSES[causeCode] ?? [
    "failed",
    "unknown",
    1,
    "internal",
  ];
  const writes = command.endsWith(".import") || command.endsWith(".decide");
  return {
    causeCode,
    commandIdentity: command,
    effectClass: writes ? "repository-local" : "inspect",
    exitCode,
    failureClass,
    guidance,
    outcome,
    reachability: "required",
    repairAction,
    retryDelayPolicy:
      exitCode === 75 ? { kind: "fixed", milliseconds: 1000 } : { kind: "none" },
    retryable: exitCode === 75,
    transactionState,
    trigger,
    unreachableRationale: null,
  };
}

const STATIONS = ROWS.map(station);

export function stationsFor(commandIdentity: string): Station[] {
  return STATIONS.filter((entry) => entry.commandIdentity === commandIdentity);
}
