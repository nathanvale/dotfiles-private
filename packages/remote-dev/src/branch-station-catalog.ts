import type {
  EffectClass,
  FailureClass,
  Handoff,
  Outcome,
  TransactionState,
} from "./model.ts";

/** Contract Core cause rows used by remote-dev (a subset of the closed 2.0 vocabulary). */
interface CauseRow {
  exitCode: 0 | 1 | 2 | 3 | 4 | 75;
  failureClass: FailureClass | null;
  guidance: "handoff" | "next";
  outcome: Outcome;
  retryDelayMilliseconds?: number;
  retryable: boolean;
  transactionState: TransactionState;
}

export const CAUSES = {
  DOMAIN_AUTHORITY_REQUIRED: { exitCode: 3, failureClass: "domain", guidance: "handoff", outcome: "refused", retryable: false, transactionState: "unchanged" },
  DOMAIN_CONFIG_MISSING: { exitCode: 3, failureClass: "domain", guidance: "next", outcome: "refused", retryable: false, transactionState: "unchanged" },
  DOMAIN_PRECONDITION_UNMET: { exitCode: 3, failureClass: "domain", guidance: "next", outcome: "refused", retryable: false, transactionState: "unchanged" },
  INTERNAL_RESULT_UNCHANGED: { exitCode: 1, failureClass: "internal", guidance: "handoff", outcome: "failed", retryable: false, transactionState: "unchanged" },
  INTERNAL_RESULT_PARTIAL: { exitCode: 1, failureClass: "internal", guidance: "handoff", outcome: "failed", retryable: false, transactionState: "partially-completed" },
  INTERNAL_RESULT_UNKNOWN: { exitCode: 1, failureClass: "internal", guidance: "handoff", outcome: "failed", retryable: false, transactionState: "unknown" },
  SCHEMA_CONFIG_INVALID: { exitCode: 4, failureClass: "schema", guidance: "next", outcome: "refused", retryable: false, transactionState: "unchanged" },
  SCHEMA_INVALID_INPUT: { exitCode: 4, failureClass: "schema", guidance: "next", outcome: "refused", retryable: false, transactionState: "unchanged" },
  SUCCESS_COMPLETED: { exitCode: 0, failureClass: null, guidance: "next", outcome: "success", retryable: false, transactionState: "completed" },
  SUCCESS_UNCHANGED: { exitCode: 0, failureClass: null, guidance: "next", outcome: "success", retryable: false, transactionState: "unchanged" },
  TRANSIENT_ATTEMPT_UNCHANGED: { exitCode: 75, failureClass: "transient", guidance: "next", outcome: "failed", retryDelayMilliseconds: 5_000, retryable: true, transactionState: "unchanged" },
  USAGE_INVALID_INVOCATION: { exitCode: 2, failureClass: "usage", guidance: "next", outcome: "refused", retryable: false, transactionState: "unchanged" },
} as const satisfies Record<string, CauseRow>;

export type CauseCode = keyof typeof CAUSES;

interface ReasonRow {
  cause: CauseCode;
  guidance: string;
  inspect?: string[];
  message: string;
  repairAction: string | null;
  trigger: string;
}

const NO_FOLLOW_UP = "No follow-up is required.";

/**
 * The single owner of every remote-dev condition. Each reason sits under one
 * Contract Core cause and carries its own message and guidance.
 */
export const REASONS = {
  "services-blocked": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Inspect retained service state and the existing credential owner. No agent or task will be started.",
    message: "Pilot restoration is blocked. VS Code was not opened; existing services were left alone.",
    repairAction: "Inspect retained state and run with-one-password-token check if Core needs authentication.",
    trigger: "Service restoration refused before a service start attempt.",
  },
  "services-incomplete": {
    cause: "INTERNAL_RESULT_PARTIAL",
    guidance: "The container was started, but restoration is blocked. Inspect state before continuing; nothing is stopped or retried automatically.",
    message: "The container started, but services could not be restored. VS Code was not opened.",
    repairAction: "Inspect retained state and the existing credential owner before another start command.",
    trigger: "Confirmed container startup was followed by a service precondition refusal.",
  },
  "services-unconfirmed": {
    cause: "INTERNAL_RESULT_UNKNOWN",
    guidance: "Inspect native Core, Tailscale and Shepherdr status and logs before any retry. Started services are left running.",
    message: "Pilot service restoration could not be confirmed. VS Code was not opened.",
    repairAction: "Inspect service status and retained restore logs before deciding whether to retry.",
    trigger: "A service restore attempt failed or its result could not be verified.",
  },
  "start-not-allowed": {
    cause: "DOMAIN_AUTHORITY_REQUIRED",
    guidance: "Review this existing target and explicitly set allowStart to true before using remote-dev start.",
    inspect: ["the target's allowStart setting"],
    message: "This target is not opted in to start. Nothing was started or opened.",
    repairAction: "Explicitly opt this exact target in to start, or use open for a running target.",
    trigger: "The configured target does not have allowStart set to true.",
  },
  "start-state-unsupported": {
    cause: "DOMAIN_AUTHORITY_REQUIRED",
    guidance: "Inspect the container's native Docker state. Only exited or created containers can be started here; running targets can be opened.",
    inspect: ["docker ps --all on the configured host engine"],
    message: "The target's native state does not permit start. Nothing was started or opened.",
    repairAction: "Inspect the container state through its owner before trying again.",
    trigger: "The exact container is neither running, exited nor created.",
  },
  "start-unconfirmed": {
    cause: "INTERNAL_RESULT_UNKNOWN",
    guidance: "Inspect the exact configured container on its host engine before any retry. VS Code was not launched; remote-dev will not stop or retry the container.",
    inspect: ["remote-dev list", "the exact configured containerId on its host engine"],
    message: "The container start could not be confirmed. It may be running; VS Code was not opened.",
    repairAction: "Inspect the exact container state before deciding whether to retry.",
    trigger: "Start dispatch failed or exact running identity could not be read back after dispatch.",
  },
  "started-open-incomplete": {
    cause: "INTERNAL_RESULT_PARTIAL",
    guidance: "The confirmed startup remains in effect. Inspect the target and isolated editor prerequisites, then use remote-dev open when ready.",
    inspect: ["remote-dev list", "editor.userDataDir", "editor.extensionsDir", "the configured code executable"],
    message: "Startup was confirmed, but VS Code was not opened. Running services were left alone.",
    repairAction: "Inspect the target and editor prerequisites, then open the running target.",
    trigger: "The start was confirmed, then the editor's prelaunch recheck or prerequisites failed.",
  },
  "started-launch-unconfirmed": {
    cause: "INTERNAL_RESULT_UNKNOWN",
    guidance: "The confirmed startup remains in effect. Inspect existing VS Code windows before using remote-dev open; remote-dev will not retry or stop the container.",
    inspect: ["open VS Code windows", "remote-dev list"],
    message: "Startup was confirmed; the VS Code launch could not be confirmed. Running services were left alone.",
    repairAction: "Inspect open windows and the target before opening it again.",
    trigger: "The start was confirmed, then the editor launcher exited unsuccessfully or timed out.",
  },
  "action-unconfigured": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Add the resource (serviceLog or board) to this target's configuration, or pick another action.",
    message: "That action is not configured for this target. Nothing was launched.",
    repairAction: "Configure the resource for this target first.",
    trigger: "The target has no configured resource for the action.",
  },
  cancelled: {
    cause: "SUCCESS_UNCHANGED",
    guidance: NO_FOLLOW_UP,
    message: "Cancelled. Nothing was launched or started.",
    repairAction: null,
    trigger: "The person pressed Escape in the chooser.",
  },
  "config-invalid": {
    cause: "SCHEMA_CONFIG_INVALID",
    guidance: "Repair the targets file against the documented version 1 schema.",
    message: "The remote-dev targets file is invalid. Nothing was inspected.",
    repairAction: "Repair the targets file.",
    trigger: "The targets file is not valid version 1 configuration.",
  },
  "config-missing": {
    cause: "DOMAIN_CONFIG_MISSING",
    guidance: "Create the targets file (see packages/remote-dev/README.md) or set REMOTE_DEV_CONFIG.",
    message: "No remote-dev targets file was found. Nothing was inspected.",
    repairAction: "Create the targets file, then retry.",
    trigger: "The configured targets file does not exist.",
  },
  "editor-profile-missing": {
    cause: "DOMAIN_AUTHORITY_REQUIRED",
    guidance: "Restore the isolated VS Code user-data or extensions directory; never fall back to the daily profile.",
    inspect: ["editor.userDataDir", "editor.extensionsDir"],
    message: "The isolated VS Code environment is missing, so nothing was opened.",
    repairAction: "Restore the isolated editor directories named in the config.",
    trigger: "An isolated editor user-data or extensions directory is absent.",
  },
  "host-command-failed": {
    cause: "INTERNAL_RESULT_UNCHANGED",
    guidance: "Inspect the host's Docker engine or the requested file read-only; do not start or change containers to repair it.",
    inspect: ["docker ps --all on the host", "the configured serviceLog path"],
    message: "The remote inspection command failed. Nothing was started.",
    repairAction: "Inspect the host engine or resource, then retry.",
    trigger: "The read-only remote Docker command exited non-zero.",
  },
  "host-unreachable": {
    cause: "TRANSIENT_ATTEMPT_UNCHANGED",
    guidance: "Check the network route to the host, then retry. remote-dev never changes authentication.",
    message: "The host could not be reached. Nothing was inspected or started.",
    repairAction: "Restore the SSH route to the host, then retry.",
    trigger: "SSH could not connect to the admitted host.",
  },
  inspected: {
    cause: "SUCCESS_UNCHANGED",
    guidance: NO_FOLLOW_UP,
    message: "Inspected; nothing was changed.",
    repairAction: null,
    trigger: "Inspection completed.",
  },
  "install-from-worktree": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Relink ~/.local/bin/remote-dev to the main checkout with the repair command, then run remote-dev doctor again.",
    message: "Cause install-from-worktree. The installed remote-dev runs from a git worktree, so it changes when that branch changes.",
    repairAction: "Land remote-dev on the main checkout, then relink ~/.local/bin/remote-dev to it.",
    trigger: "~/.local/bin/remote-dev resolves into a linked git worktree.",
  },
  "link-degraded": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Stop the shared SSH link with the repair command; open sessions keep running and new connections get a fresh link. Then run remote-dev doctor again.",
    message: "Cause link-degraded. The shared SSH link moves data at under half the rate of a direct connection.",
    repairAction: "Stop the shared SSH link with ssh -O stop.",
    trigger: "The shared link and a direct connection leave from the same address, but the shared link moves under half the direct rate.",
  },
  "link-unresponsive": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Stop the shared SSH link with the repair command; open sessions keep running and new connections get a fresh link. Then run remote-dev doctor again.",
    message: "Cause link-unresponsive. The shared SSH link could not complete a test transfer, but a direct connection did.",
    repairAction: "Stop the shared SSH link with ssh -O stop.",
    trigger: "The sample through the shared link times out, exits non-zero or arrives short while the direct sample completes.",
  },
  "link-stale-route": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Stop the shared SSH link with the repair command; open sessions keep running and new connections get a fresh link. Then run remote-dev doctor again.",
    message: "Cause link-stale-route. The shared SSH link leaves from an address this Mac no longer uses for the host.",
    repairAction: "Stop the shared SSH link with ssh -O stop.",
    trigger: "sshd sees the shared link and a new direct connection arrive from different client addresses.",
  },
  "network-no-route": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Join the host's network, or connect the VPN that reaches it, then run remote-dev doctor again.",
    message: "Cause network-no-route. This Mac has no route to the host.",
    repairAction: "Join the host's network or connect the VPN that reaches it.",
    trigger: "route -n get finds no route to the host's address.",
  },
  "input-invalid": {
    cause: "SCHEMA_INVALID_INPUT",
    guidance: "Pass a target id of letters, digits, dot, dash or underscore, and --lines 1 to 1000.",
    message: "The command input is invalid. Nothing was inspected.",
    repairAction: "Repair the input and retry.",
    trigger: "A target id or option value failed validation.",
  },
  "launch-unconfirmed": {
    cause: "INTERNAL_RESULT_UNKNOWN",
    guidance: "Check whether a window opened before retrying; the launcher did not confirm success.",
    inspect: ["open VS Code or browser windows"],
    message: "The launcher exited unsuccessfully; a window may or may not have opened.",
    repairAction: "Inspect open windows, then retry once if nothing opened.",
    trigger: "The local launcher exited non-zero or timed out.",
  },
  "editor-dispatched": {
    cause: "SUCCESS_COMPLETED",
    guidance: "Verify the file and integrated terminal in the target window. If it remains disconnected, run Developer: Reload Window there; reopening the same folder can focus the disconnected window even with --new-window.",
    message: "Editor launch request sent; attachment was not verified.",
    repairAction: null,
    trigger: "The isolated editor CLI exited zero; native attachment remains unverified.",
  },
  launched: {
    cause: "SUCCESS_COMPLETED",
    guidance: NO_FOLLOW_UP,
    message: "Launched.",
    repairAction: null,
    trigger: "The rechecked target was eligible and the launcher succeeded.",
  },
  "needs-tty": {
    cause: "USAGE_INVALID_INVOCATION",
    guidance: "Use remote-dev list --json and remote-dev open TARGET --json from scripts and agents.",
    message: "The chooser needs an interactive terminal; nothing was launched.",
    repairAction: "Run in a terminal, or use the explicit noninteractive commands.",
    trigger: "The chooser was requested without a TTY.",
  },
  "target-missing": {
    cause: "DOMAIN_AUTHORITY_REQUIRED",
    guidance: "The configured container no longer exists. Creating or replacing it needs a separate decision.",
    inspect: ["remote-dev list --all"],
    message: "The target's container was not found. Nothing was started.",
    repairAction: "Decide separately whether to recreate it and update the config.",
    trigger: "No container on the host has the configured name.",
  },
  "target-replaced": {
    cause: "DOMAIN_AUTHORITY_REQUIRED",
    guidance: "A different container now has this name. Review it and update the configured identity before connecting.",
    inspect: ["remote-dev list --all", "the configured containerId"],
    message: "The target's container was replaced (identity changed). Nothing was opened.",
    repairAction: "Review the replacement, then update the configured containerId.",
    trigger: "The named container's ID differs from the configured identity.",
  },
  "target-stopped": {
    cause: "DOMAIN_AUTHORITY_REQUIRED",
    guidance: "This action leaves the container stopped. If allowStart is true, use remote-dev start TARGET for an exited or created container. Otherwise starting needs a separate decision; services remain under their existing owner.",
    inspect: ["remote-dev list"],
    message: "The target is stopped. Nothing was started.",
    repairAction: "Use remote-dev start TARGET only for an explicitly opted-in target; otherwise decide separately whether to allow start.",
    trigger: "The configured container exists but is not running.",
  },
  "target-unknown": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Run remote-dev list to see configured targets; unclassified containers are inspect-only.",
    message: "That is not a configured development target. Nothing was launched.",
    repairAction: "Choose a configured target.",
    trigger: "The selection is not a configured target.",
  },
  "tool-unavailable": {
    cause: "DOMAIN_PRECONDITION_UNMET",
    guidance: "Make the configured ssh, code, fzf or opener path executable through its owner; remote-dev never installs tools.",
    message: "A required local tool is unavailable. Nothing was launched.",
    repairAction: "Make the configured tool path executable, then retry.",
    trigger: "A configured local executable (ssh, code, fzf, opener) is absent.",
  },
  usage: {
    cause: "USAGE_INVALID_INVOCATION",
    guidance: "Run remote-dev --help.",
    message: "Unknown command or option. Run remote-dev --help.",
    repairAction: "Use a documented command.",
    trigger: "The argv does not match a public route.",
  },
} as const satisfies Record<string, ReasonRow>;

export type Reason = keyof typeof REASONS;

/** Guidance arm for one reason, shaped as Contract Core requires. */
export function guidanceFor(reason: Reason, resourceId?: string): { handoff: Handoff } | { nextAction: string } {
  const row: ReasonRow = REASONS[reason];
  if (CAUSES[row.cause].guidance === "next") return { nextAction: row.guidance };
  return {
    handoff: {
      inspect: row.inspect ?? ["remote-dev list"],
      owner: "operator",
      reason: row.guidance,
      ...(resourceId === undefined ? {} : { resource: { id: resourceId, kind: "remote-dev-target" } }),
    },
  };
}

const SOURCE: Reason[] = ["config-invalid", "config-missing", "host-command-failed", "host-unreachable", "tool-unavailable"];
const TARGET: Reason[] = ["input-invalid", "target-missing", "target-replaced", "target-stopped", "target-unknown"];
const START: Reason[] = ["services-blocked", "services-incomplete", "services-unconfirmed", "start-not-allowed", "start-state-unsupported", "start-unconfirmed", "started-open-incomplete", "started-launch-unconfirmed"];

const COMMAND_REASONS: Record<string, Reason[]> = {
  "remote-dev.board": [...SOURCE, ...TARGET, "action-unconfigured", "launch-unconfirmed", "launched"],
  "remote-dev.choose": [
    ...SOURCE,
    ...START,
    "action-unconfigured",
    "cancelled",
    "editor-dispatched",
    "editor-profile-missing",
    "inspected",
    "launch-unconfirmed",
    "launched",
    "needs-tty",
    "target-missing",
    "target-replaced",
    "target-stopped",
    "target-unknown",
  ],
  "remote-dev.command-discovery": ["inspected"],
  "remote-dev.discovery": ["inspected"],
  "remote-dev.dispatch": ["usage"],
  "remote-dev.doctor": [...SOURCE, ...TARGET, "inspected", "install-from-worktree", "link-degraded", "link-stale-route", "link-unresponsive", "network-no-route"],
  "remote-dev.help": ["inspected"],
  "remote-dev.list": [...SOURCE, "inspected"],
  "remote-dev.logs": [...SOURCE, ...TARGET, "action-unconfigured", "inspected"],
  "remote-dev.open": [...SOURCE, ...TARGET, "editor-dispatched", "editor-profile-missing", "launch-unconfirmed"],
  "remote-dev.start": [...SOURCE, ...TARGET, ...START, "editor-dispatched", "editor-profile-missing", "launch-unconfirmed"],
};

const EFFECT_CLASS: Record<string, EffectClass> = {
  "remote-dev.board": "external",
  "remote-dev.choose": "external",
  "remote-dev.open": "external",
  "remote-dev.start": "external",
};

export function effectClassOf(commandIdentity: string): EffectClass {
  return EFFECT_CLASS[commandIdentity] ?? "inspect";
}

export interface Station {
  causeCode: CauseCode;
  commandIdentity: string;
  effectClass: EffectClass;
  exitCode: number;
  failureClass: FailureClass | null;
  guidance: "handoff" | "next";
  outcome: Outcome;
  reachability: "required";
  reasons: { message: string; reason: Reason; trigger: string }[];
  retryable: boolean;
  retryDelayPolicy: { kind: "fixed"; milliseconds: number } | { kind: "none" };
  transactionState: TransactionState;
  unreachableRationale: null;
}

export function reasonsFor(commandIdentity: string): Reason[] {
  return [...(COMMAND_REASONS[commandIdentity] ?? [])].sort();
}

export function stationsFor(commandIdentity: string): Station[] {
  const byCause = new Map<CauseCode, Reason[]>();
  for (const reason of reasonsFor(commandIdentity)) {
    const cause = REASONS[reason].cause;
    byCause.set(cause, [...(byCause.get(cause) ?? []), reason]);
  }
  return [...byCause.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([causeCode, reasons]) => {
      const row: CauseRow = CAUSES[causeCode];
      return {
        causeCode,
        commandIdentity,
        effectClass: effectClassOf(commandIdentity),
        exitCode: row.exitCode,
        failureClass: row.failureClass,
        guidance: row.guidance,
        outcome: row.outcome,
        reachability: "required",
        reasons: reasons.map((reason) => ({ message: REASONS[reason].message, reason, trigger: REASONS[reason].trigger })),
        retryable: row.retryable,
        retryDelayPolicy:
          row.retryDelayMilliseconds === undefined
            ? { kind: "none" }
            : { kind: "fixed", milliseconds: row.retryDelayMilliseconds },
        transactionState: row.transactionState,
        unreachableRationale: null,
      };
    });
}
