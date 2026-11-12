import { CAUSES, effectClassOf, guidanceFor, REASONS, type Reason } from "./branch-station-catalog.ts";
import type {
  ConfiguredHost,
  ConfiguredTarget,
  RemoteDevConfig,
} from "./command-contract.ts";
import type {
  InventoryRow,
  ObservedContainer,
  OperationResult,
  RowAction,
  RowState,
} from "./model.ts";

const EMPTY_EFFECTS = {
  completed: [],
  inventoryComplete: true,
  remaining: [],
  uncertain: [],
};

function effectsFor(state: string, effect: string | undefined) {
  if (effect === undefined) return EMPTY_EFFECTS;
  if (state === "completed") return { ...EMPTY_EFFECTS, completed: [effect] };
  if (state === "unknown") return { ...EMPTY_EFFECTS, uncertain: [effect] };
  return EMPTY_EFFECTS;
}

/** Build a result from the single reason owner; failures always carry null data. */
export function resultFor(
  commandIdentity: string,
  reason: Reason,
  options: { data?: unknown; effect?: string; message?: string; resource?: string } = {},
): OperationResult {
  const detail = REASONS[reason];
  const row = CAUSES[detail.cause];
  return {
    causeCode: detail.cause,
    commandIdentity,
    data: row.outcome === "success" ? (options.data ?? null) : null,
    effectClass: effectClassOf(commandIdentity),
    effects: effectsFor(row.transactionState, options.effect),
    exitCode: row.exitCode,
    failureClass: row.failureClass,
    ...guidanceFor(reason, options.resource),
    message: options.message ?? detail.message,
    outcome: row.outcome,
    repairAction: detail.repairAction,
    retryable: row.retryable,
    ...("retryDelayMilliseconds" in row ? { retryDelayMilliseconds: row.retryDelayMilliseconds } : {}),
    transactionState: row.transactionState,
  };
}

const ID = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATE = /^[a-z]{1,16}$/;

/**
 * Parse `docker ps --format '{{.ID}} {{.Names}} {{.State}}'` output. Rows whose
 * fields are not plainly safe are counted and dropped, never displayed.
 */
export function parseInventory(
  stdout: string,
): { containers: ObservedContainer[]; rejected: number } {
  const containers: ObservedContainer[] = [];
  let rejected = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(" ");
    const [id, names, state] = fields;
    if (fields.length !== 3 || id === undefined || names === undefined || state === undefined) {
      rejected += 1;
      continue;
    }
    const nameList = names.split(",");
    if (!ID.test(id) || !STATE.test(state) || !nameList.every((name) => NAME.test(name))) {
      rejected += 1;
      continue;
    }
    containers.push({ id, names: nameList, running: state === "running", state });
  }
  return { containers, rejected };
}

function stateOf(target: ConfiguredTarget, observed: ObservedContainer | undefined): RowState {
  if (observed === undefined) return "missing";
  if (observed.id !== target.containerId) return "replaced";
  return observed.running ? "running" : "stopped";
}

const STATE_NOTE: Record<Exclude<RowState, "running">, string> = {
  missing: "Container not found on the host; nothing will be started.",
  replaced: "Container identity changed; review before connecting.",
  stopped: "Container is stopped and stays stopped; starting it is a separate decision.",
};

export const STATE_REASON: Record<Exclude<RowState, "running">, Reason> = {
  missing: "target-missing",
  replaced: "target-replaced",
  stopped: "target-stopped",
};

function actionsFor(target: ConfiguredTarget, eligible: boolean): RowAction[] {
  const blocked = eligible ? null : "The target is not running with its configured identity.";
  const resource = (configured: boolean, missing: string) =>
    blocked ?? (configured ? null : missing);
  const action = (id: RowAction["id"], label: string, reason: string | null): RowAction => ({
    available: reason === null,
    id,
    label,
    reason,
  });
  return [
    action("open", "Open VS Code", blocked),
    action("logs", "Read service log", resource(target.serviceLog !== undefined, "No service log is configured.")),
    action("board", "Open task board", resource(target.board !== undefined, "No task board is configured.")),
  ];
}

function findByName(containers: ObservedContainer[], name: string) {
  return containers.find((container) => container.names.includes(name));
}

function targetRow(target: ConfiguredTarget, containers: ObservedContainer[]): InventoryRow {
  const observed = findByName(containers, target.container);
  const state = stateOf(target, observed);
  const eligible = state === "running";
  return {
    actions: actionsFor(target, eligible),
    container: target.container,
    containerId: observed?.id ?? null,
    eligible,
    host: target.host,
    reason: state === "running" ? null : STATE_NOTE[state],
    role: target.role,
    state,
    target: target.id,
  };
}

function unclassifiedRow(host: string, container: ObservedContainer): InventoryRow {
  return {
    actions: [],
    container: container.names[0] ?? container.id.slice(0, 12),
    containerId: container.id,
    eligible: false,
    host,
    reason: "Unclassified container: inspect only; no editor, startup, or agent authority.",
    role: "unclassified",
    state: container.running ? "running" : "stopped",
    target: null,
  };
}

/** Known targets first (config order), then, for --all, every other container by name. */
export function buildRows(
  config: RemoteDevConfig,
  observed: Map<string, ObservedContainer[]>,
  all: boolean,
): InventoryRow[] {
  const rows = config.targets.map((target) =>
    targetRow(target, observed.get(target.host) ?? []),
  );
  if (!all) return rows;
  const extra: InventoryRow[] = [];
  for (const host of config.hosts) {
    const known = new Set(
      config.targets.filter((target) => target.host === host.id).map((target) => target.container),
    );
    for (const container of observed.get(host.id) ?? []) {
      if (container.names.some((name) => known.has(name))) continue;
      extra.push(unclassifiedRow(host.id, container));
    }
  }
  extra.sort((left, right) => left.container.localeCompare(right.container));
  return [...rows, ...extra];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The only remote inventory command: read-only, no names interpolated. */
export function inventoryCommand(host: ConfiguredHost): string {
  return [host.dockerPath, "--host", host.dockerHost, "ps", "--all", "--no-trunc", "--format", "{{.ID}} {{.Names}} {{.State}}"]
    .map(quote)
    .join(" ");
}

/** Read-only log tail addressed by the rechecked container ID, never by name. */
export function logTailCommand(
  host: ConfiguredHost,
  containerId: string,
  path: string,
  lines: number,
): string {
  return [host.dockerPath, "--host", host.dockerHost, "exec", containerId, "tail", "-n", String(lines), path]
    .map(quote)
    .join(" ");
}

export function sshArguments(host: ConfiguredHost, remoteCommand: string): string[] {
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "--",
    host.sshAlias,
    remoteCommand,
  ];
}

function remoteAuthority(host: ConfiguredHost, target: ConfiguredTarget): string {
  const attach = JSON.stringify({
    containerName: `/${target.container}`,
    settings: { host: host.dockerHost },
  });
  return `attached-container%2B${Buffer.from(attach).toString("hex")}@ssh-remote%2B${host.sshAlias}`;
}

function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

/** The single isolated launch policy shared by the desktop entry and the CLI. */
export function editorLaunch(
  config: RemoteDevConfig,
  host: ConfiguredHost,
  target: ConfiguredTarget,
  home: string,
): { args: string[]; requiredDirectories: string[] } {
  // Both the folder and the guide derive from the rechecked target; no local
  // workspace file can redirect the window to another destination.
  const authority = remoteAuthority(host, target);
  const userData = expandHome(config.editor.userDataDir, home);
  const extensions = expandHome(config.editor.extensionsDir, home);
  const guide =
    target.guide === undefined
      ? []
      : ["--file-uri", `vscode-remote://${authority}${target.guide}`];
  return {
    args: [
      "--user-data-dir", userData,
      "--extensions-dir", extensions,
      "--new-window",
      "--folder-uri", `vscode-remote://${authority}${target.workspaceFolder}`,
      ...guide,
    ],
    requiredDirectories: [userData, extensions],
  };
}

/** Environment for the editor: no SSH agent and no route into a daily VS Code instance. */
export function editorEnvironment(base: Record<string, string | undefined>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== "VSCODE_IPC_HOOK_CLI") environment[key] = value;
  }
  environment.SSH_AUTH_SOCK = "";
  return environment;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  // A credential header's value runs to the end of its line, so every cookie
  // pair after the first semicolon is redacted too.
  [/\b((?:set-)?cookie|(?:proxy-)?authorization)(["']?[ \t]*:[ \t]*).*/gi, "$1$2[REDACTED]"],
  [/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/g, "$1[REDACTED]@"],
  [/(https?:\/\/[^\s?#]+)\?[^\s]*/g, "$1?[REDACTED]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [
    /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"',;]+/gi,
    "$1$2[REDACTED]",
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\b(?:gh[opsu]|github_pat|xox[abprs]|tskey)[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
];

const ESC = 0x1b;
const BEL = 0x07;

function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
}

/** Index just past an escape sequence starting at `start` (an ESC). */
function skipEscape(text: string, start: number): number {
  const kind = text[start + 1];
  if (kind === "[") {
    let index = start + 2;
    while (index < text.length && !/[@-~]/.test(text[index] ?? "")) index += 1;
    return index + 1;
  }
  if (kind === "]") {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === BEL) return index + 1;
      if (code === ESC) return index + 2;
      index += 1;
    }
    return index;
  }
  return start + 2;
}

/** Strip terminal control sequences and control characters (keeping tab and newline). */
export function stripControl(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      index = skipEscape(text, index);
      continue;
    }
    if (!isControl(code)) output += text[index];
    index += 1;
  }
  return output;
}

export function redactLog(text: string): string {
  let redacted = stripControl(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
