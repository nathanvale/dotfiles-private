import { join } from "node:path";
import { restoreServices, type ServiceRestore } from "./service-restore.ts";
import { rememberLaunch } from "./recents.ts";
import type { Reason } from "./branch-station-catalog.ts";
import type {
  ConfiguredHost,
  ConfiguredTarget,
  RemoteDevConfig,
} from "./command-contract.ts";
import {
  buildRows,
  editorEnvironment,
  editorLaunch,
  inventoryCommand,
  logTailCommand,
  parseInventory,
  redactLog,
  resultFor,
  STATE_REASON,
  sshArguments,
  startCommand,
} from "./engine.ts";
import type { ObservedContainer, OperationResult } from "./model.ts";
import {
  configPath,
  directoriesExist,
  executableExists,
  homeOf,
  loadConfig,
  runProgram,
} from "./runtime.ts";

const DEFAULT_TOOLS = {
  code: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  fzf: "fzf",
  opener: "/usr/bin/open",
  pilotRuntime: join(import.meta.dir, "../resources/pilot-runtime.py"),
  ps: "/bin/ps",
  route: "/sbin/route",
  ssh: "/usr/bin/ssh",
};
const REMOTE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 60_000;

export type Environment = Record<string, string | undefined>;

export function toolPath(config: RemoteDevConfig, tool: keyof typeof DEFAULT_TOOLS, home: string): string {
  const configured = config.tools?.[tool];
  if (configured === undefined) return DEFAULT_TOOLS[tool];
  return configured.startsWith("~/") ? `${home}/${configured.slice(2)}` : configured;
}

export type Step<T> = { reason: Reason; ok: false } | { ok: true; value: T };

export async function readConfig(environment: Environment): Promise<Step<RemoteDevConfig>> {
  const loaded = await loadConfig(configPath(environment));
  if (loaded.kind === "missing") return { reason: "config-missing", ok: false };
  if (loaded.kind === "invalid") return { reason: "config-invalid", ok: false };
  return { ok: true, value: loaded.config };
}

export async function remote(
  config: RemoteDevConfig,
  host: ConfiguredHost,
  command: string,
  environment: Environment,
  sshOptions: string[] = [],
): Promise<Step<string>> {
  const result = await runProgram(toolPath(config, "ssh", homeOf(environment)), sshArguments(host, command, sshOptions), {
    environment: { ...stringEnvironment(environment), SSH_AUTH_SOCK: "" },
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
  if (result.kind === "missing") return { reason: "tool-unavailable", ok: false };
  if (result.kind === "timeout" || result.exitCode === 255) {
    return { reason: "host-unreachable", ok: false };
  }
  if (result.exitCode !== 0) return { reason: "host-command-failed", ok: false };
  return { ok: true, value: result.stdout };
}

export function stringEnvironment(environment: Environment): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) copy[key] = value;
  }
  return copy;
}

async function observeHost(
  config: RemoteDevConfig,
  host: ConfiguredHost,
  environment: Environment,
  sshOptions: string[] = [],
): Promise<Step<{ containers: ObservedContainer[]; rejected: number }>> {
  const output = await remote(config, host, inventoryCommand(host), environment, sshOptions);
  if (!output.ok) return output;
  return { ok: true, value: parseInventory(output.value) };
}

export interface Inventory {
  data: {
    hosts: { id: string; label: string }[];
    rejectedRows: number;
    rows: ReturnType<typeof buildRows>;
    view: "all" | "known";
  };
}

export async function inventory(
  config: RemoteDevConfig,
  all: boolean,
  environment: Environment,
): Promise<Step<Inventory>> {
  const observed = new Map<string, ObservedContainer[]>();
  let rejected = 0;
  for (const host of config.hosts) {
    const step = await observeHost(config, host, environment);
    if (!step.ok) return step;
    observed.set(host.id, step.value.containers);
    rejected += step.value.rejected;
  }
  return {
    ok: true,
    value: {
      data: {
        hosts: config.hosts.map((host) => ({ id: host.id, label: host.label })),
        rejectedRows: rejected,
        rows: buildRows(config, observed, all),
        view: all ? "all" : "known",
      },
    },
  };
}

export interface Resolved {
  container: ObservedContainer;
  host: ConfiguredHost;
  target: ConfiguredTarget;
}

/**
 * Point-in-time guard: rediscover the host and require the configured
 * container identity to be present and running immediately before dispatch.
 */
export async function recheck(
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
  requireRunning = true,
  sshOptions: string[] = [],
): Promise<Step<Resolved>> {
  const target = config.targets.find((candidate) => candidate.id === targetId);
  const host = config.hosts.find((candidate) => candidate.id === target?.host);
  if (target === undefined || host === undefined) return { reason: "target-unknown", ok: false };
  const observed = await observeHost(config, host, environment, sshOptions);
  if (!observed.ok) return observed;
  const [row] = buildRows(
    { ...config, targets: [target] },
    new Map([[host.id, observed.value.containers]]),
    false,
  );
  const container = observed.value.containers.find((candidate) => candidate.id === target.containerId);
  if (row === undefined || row.state === "missing" || row.state === "replaced" || container === undefined || (requireRunning && row.state !== "running")) {
    const state = row?.state ?? "missing";
    return { reason: state === "running" ? "target-missing" : STATE_REASON[state], ok: false };
  }
  return { ok: true, value: { container, host, target } };
}

function describe(resolved: Resolved) {
  return {
    container: resolved.target.container,
    containerId: resolved.container.id,
    host: resolved.host.id,
    role: resolved.target.role,
    target: resolved.target.id,
  };
}

async function launch(
  command: string,
  program: string,
  args: string[],
  environment: Record<string, string>,
  effect: string,
): Promise<OperationResult | null> {
  const launched = await runProgram(program, args, { environment, timeoutMs: LAUNCH_TIMEOUT_MS });
  if (launched.kind === "missing") return resultFor(command, "tool-unavailable");
  if (launched.kind === "timeout" || launched.exitCode !== 0) {
    return resultFor(command, "launch-unconfirmed", { effect });
  }
  return null;
}

export async function openTarget(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
): Promise<OperationResult> {
  const resolved = await recheck(config, targetId, environment);
  if (!resolved.ok) return resultFor(command, resolved.reason, { resource: targetId });
  const home = homeOf(environment);
  const plan = editorLaunch(config, resolved.value.host, resolved.value.target, home);
  if (!(await directoriesExist(plan.requiredDirectories))) {
    return resultFor(command, "editor-profile-missing");
  }
  const effect = `editor-window:${targetId}`;
  const failure = await launch(
    command,
    toolPath(config, "code", home),
    plan.args,
    editorEnvironment(environment),
    effect,
  );
  if (failure !== null) return failure;
  await rememberLaunch(resolved.value.target, environment);
  return resultFor(command, "editor-dispatched", {
    data: { ...describe(resolved.value), editor: "isolated-vscode" },
    effect,
    message: `Sent ${targetId} to the isolated VS Code launcher. Attachment was not verified. If disconnected, run Developer: Reload Window in that target window. Closing VS Code leaves the container running.`,
  });
}

type RunningTransition = { ok: true; started: boolean } | { ok: false; result: OperationResult };

function startUnconfirmed(command: string, targetId: string): OperationResult {
  return resultFor(command, "start-unconfirmed", {
    effects: { completed: [], inventoryComplete: true, remaining: [`editor-window:${targetId}`], uncertain: [`container-start:${targetId}`] },
    resource: targetId,
  });
}

/** Admit one exact existing target and perform at most one native start dispatch. */
async function ensureRunning(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
): Promise<RunningTransition> {
  const refuse = (reason: Reason): RunningTransition => ({ ok: false, result: resultFor(command, reason, { resource: targetId }) });
  const target = config.targets.find((candidate) => candidate.id === targetId);
  if (target === undefined) return refuse("target-unknown");
  if (target.allowStart !== true) return refuse("start-not-allowed");
  const resolved = await recheck(config, targetId, environment, false);
  if (!resolved.ok) return refuse(resolved.reason);
  const { host, container } = resolved.value;
  if (!["running", "exited", "created"].includes(container.state)) return refuse("start-state-unsupported");
  const home = homeOf(environment);
  if (!(await directoriesExist(editorLaunch(config, host, target, home).requiredDirectories))) return refuse("editor-profile-missing");
  if (!(await executableExists(toolPath(config, "code", home)))) return refuse("tool-unavailable");
  if (target.restore !== undefined && !(await executableExists(toolPath(config, "pilotRuntime", home)))) return refuse("tool-unavailable");
  if (container.running) return { ok: true, started: false };
  // A dispatched mutation cannot use remote()'s inspection-only unchanged/retryable failures.
  const started = await runProgram(toolPath(config, "ssh", home), sshArguments(host, startCommand(host, container.id)), {
    environment: { ...stringEnvironment(environment), SSH_AUTH_SOCK: "" },
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
  if (started.kind === "missing") return refuse("tool-unavailable");
  if (started.kind !== "exited" || started.exitCode !== 0) return { ok: false, result: startUnconfirmed(command, targetId) };
  const confirmed = await recheck(config, targetId, environment);
  if (!confirmed.ok) return { ok: false, result: startUnconfirmed(command, targetId) };
  return { ok: true, started: true };
}

/** Explicit lifecycle entry: ensure running, then reuse the isolated editor policy. */
export async function startTarget(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
): Promise<OperationResult> {
  const transition = await ensureRunning(command, config, targetId, environment);
  if (!transition.ok) return transition.result;
  const completed = transition.started ? [`container-start:${targetId}`] : [];
  const failure = await restoreTarget(command, config, targetId, environment, completed);
  if (failure !== null) return failure;
  const opened = await openTarget(command, config, targetId, environment);
  const result = finishOpen(command, targetId, completed, opened);
  return result.outcome === "success" && config.targets.some((target) => target.id === targetId && target.restore !== undefined)
    ? { ...result, message: `Core, Tailscale and Shepherdr are ready. ${result.message}` }
    : result;
}

async function restoreTarget(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
  completed: string[],
): Promise<OperationResult | null> {
  const target = config.targets.find((candidate) => candidate.id === targetId);
  const host = config.hosts.find((candidate) => candidate.id === target?.host);
  if (target?.restore === undefined || host === undefined) return null;
  const home = homeOf(environment);
  const checked = await recheck(config, targetId, environment);
  if (!checked.ok) return finishOpen(command, targetId, completed, resultFor(command, checked.reason));
  const restored = await restoreServices(toolPath(config, "pilotRuntime", home), [
    "restore", "--service-log", target.serviceLog ?? "", "--ssh", toolPath(config, "ssh", home), "--alias", host.sshAlias,
    "--docker", host.dockerPath, "--endpoint", host.dockerHost, "--container", target.containerId,
    "--version", target.restore.shepherdrVersion, "--core-version", target.restore.coreVersion, "--wrapper", join(home, "code/dotfiles/bin/with-one-password-token"),
    "--reference", target.restore.claudeOAuthRef,
    ...(target.restore.credentialJobs === undefined ? [] : ["--credential-manifest", target.restore.credentialJobs.manifest, "--credential-manifest-sha256", target.restore.credentialJobs.sha256]),
  ], { HOME: home, PATH: environment.PATH ?? "/usr/bin:/bin", SSH_AUTH_SOCK: "" }, target.restore.credentialJobs !== undefined);
  completed.push(...restored.effects.completed.map((effect) => `credential-${effect}:${targetId}`));
  const credentialUncertain = restored.effects.uncertain.map((effect) => `credential-${effect}:${targetId}`);
  if (!restored.ok) return restoreFailure(command, targetId, completed, credentialUncertain, restored);
  if (restored.changed) completed.push(`services-restore:${targetId}`);
  return null;
}

function restoreFailure(command: string, targetId: string, completed: string[], credentialUncertain: string[], restored: Extract<ServiceRestore, { ok: false }>): OperationResult {
  const runtime = `services-restore:${targetId}`;
  const uncertain = [...credentialUncertain, ...(restored.attempted ? [runtime] : [])].sort();
  const blockedReason = completed.length > 0 ? "services-incomplete" : "services-blocked";
  return resultFor(command, uncertain.length > 0 ? "services-unconfirmed" : blockedReason, {
    effects: { completed: completed.sort(), inventoryComplete: restored.effects.inventoryComplete, remaining: [`editor-window:${targetId}`, ...(uncertain.length > 0 ? [] : [runtime])].sort(), uncertain },
    resource: targetId,
  });
}

function finishOpen(command: string, targetId: string, completed: string[], opened: OperationResult): OperationResult {
  if (completed.length === 0) return opened;
  const effects = [...completed, ...opened.effects.completed].sort();
  if (opened.outcome === "success") return { ...opened, effects: { ...opened.effects, completed: effects } };
  const uncertain = opened.effects.uncertain;
  return resultFor(command, uncertain.length > 0 ? "started-launch-unconfirmed" : "started-open-incomplete", {
    effects: { completed: effects, inventoryComplete: true, remaining: uncertain.length > 0 ? [] : [`editor-window:${targetId}`], uncertain },
    resource: targetId,
  });
}

export async function readLogs(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  lines: number,
  environment: Environment,
): Promise<OperationResult> {
  const resolved = await recheck(config, targetId, environment);
  if (!resolved.ok) return resultFor(command, resolved.reason, { resource: targetId });
  const { host, target, container } = resolved.value;
  if (target.serviceLog === undefined) return resultFor(command, "action-unconfigured");
  const output = await remote(config, host, logTailCommand(host, container.id, target.serviceLog, lines), environment);
  if (!output.ok) return resultFor(command, output.reason);
  return resultFor(command, "inspected", {
    data: {
      ...describe(resolved.value),
      lines,
      path: target.serviceLog,
      source: "native-service-log",
      text: redactLog(output.value),
    },
    message: `Last ${lines} lines of the ${targetId} native service log (secrets redacted).`,
  });
}

export async function openBoard(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
): Promise<OperationResult> {
  const resolved = await recheck(config, targetId, environment);
  if (!resolved.ok) return resultFor(command, resolved.reason, { resource: targetId });
  const board = resolved.value.target.board;
  if (board === undefined) return resultFor(command, "action-unconfigured");
  const effect = `browser-window:${targetId}`;
  const failure = await launch(
    command,
    toolPath(config, "opener", homeOf(environment)),
    [board],
    stringEnvironment(environment),
    effect,
  );
  if (failure !== null) return failure;
  return resultFor(command, "launched", {
    data: { ...describe(resolved.value), url: board },
    effect,
    message: `Opened the ${targetId} task board. Its availability was not checked; a running page does not prove an agent is running.`,
  });
}
