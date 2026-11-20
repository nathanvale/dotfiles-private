import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Reason } from "./branch-station-catalog.ts";
import type { ConfiguredHost, ConfiguredTarget, RemoteDevConfig } from "./command-contract.ts";
import { resultFor, serverListCommand } from "./engine.ts";
import type { OperationResult } from "./model.ts";
import { type Environment, recheck, remote, stringEnvironment, toolPath } from "./operations.ts";
import { homeOf, measureTransfer, runProgram, type Transfer } from "./runtime.ts";

export type CheckId = "container" | "editor-server" | "host" | "install" | "link" | "network";

export interface Check {
  detail: string;
  id: CheckId;
  status: "note" | "ok";
}

interface Probe {
  command: string;
  config: RemoteDevConfig;
  environment: Environment;
  home: string;
  host: ConfiguredHost;
  target: ConfiguredTarget;
}

type Found = { checks: Check[]; ok: true } | { ok: false; result: OperationResult };

const SAMPLE_BYTES = 8 * 1024 * 1024;
const SAMPLE_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;
/** A shared link moving under this fraction of the direct rate is degraded. */
const DEGRADED_RATIO = 0.5;
const MIB = 1024 * 1024;

const ok = (...checks: Check[]): Found => ({ checks, ok: true });

function refuse(probe: Probe, reason: Reason, message: string, repairAction?: string, nextAction?: string): Found {
  return { ok: false, result: resultFor(probe.command, reason, { message, nextAction, repairAction, resource: probe.target.id }) };
}

function fail(probe: Probe, reason: Reason): Found {
  return { ok: false, result: resultFor(probe.command, reason, { resource: probe.target.id }) };
}

async function local(probe: Probe, tool: "code" | "ps" | "route" | "ssh", args: string[], captureStderr = false) {
  return runProgram(toolPath(probe.config, tool, probe.home), args, {
    captureStderr,
    environment: stringEnvironment(probe.environment),
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
}

function routeInterface(output: string): string | null {
  return /interface:\s*(\S+)/.exec(output)?.[1] ?? null;
}

async function network(probe: Probe): Promise<Found> {
  const alias = probe.host.sshAlias;
  const resolved = await local(probe, "ssh", ["-G", alias]);
  if (resolved.kind === "missing") return fail(probe, "tool-unavailable");
  const hostname = resolved.kind === "exited" ? /^hostname ([A-Za-z0-9.:-]{1,253})$/m.exec(resolved.stdout)?.[1] : undefined;
  if (hostname === undefined) return fail(probe, "host-unreachable");
  const toHost = await local(probe, "route", ["-n", "get", hostname]);
  if (toHost.kind === "missing") return fail(probe, "tool-unavailable");
  const hostInterface = toHost.kind === "exited" && toHost.exitCode === 0 ? routeInterface(toHost.stdout) : null;
  if (hostInterface === null) {
    return refuse(probe, "network-no-route", `Cause network-no-route. This Mac has no route to ${hostname} (${alias}).`);
  }
  const toDefault = await local(probe, "route", ["-n", "get", "default"]);
  const defaultInterface = toDefault.kind === "exited" ? routeInterface(toDefault.stdout) : null;
  const tunnel = defaultInterface !== null && defaultInterface !== hostInterface ? `; the default route uses ${defaultInterface}` : "";
  return ok({ detail: `${alias} (${hostname}) is reached through ${hostInterface}${tunnel}.`, id: "network", status: "ok" });
}

/** Age from ps etime ([[dd-]hh:]mm:ss), rounded for people. */
function age(etime: string): string {
  const parts = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (parts === null) return "age unknown";
  const [days, hours, minutes] = [Number(parts[1] ?? 0), Number(parts[2] ?? 0), Number(parts[3])];
  if (days > 0) return `${days}d ${hours}h old`;
  if (hours > 0) return `${hours}h ${minutes}m old`;
  return `${minutes}m old`;
}

interface Sample {
  client: string;
  rate: number;
}

function sampleArguments(alias: string, direct: boolean): string[] {
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", direct ? "ControlPath=none" : "ControlMaster=no",
    "--",
    alias,
    `echo "$SSH_CONNECTION"; head -c ${SAMPLE_BYTES} /dev/zero`,
  ];
}

function sampleOf(transfer: Transfer): Sample | Reason {
  if (transfer.kind === "missing") return "tool-unavailable";
  const client = transfer.header.split(" ")[0] ?? "";
  if (client === "") return "host-unreachable";
  return { client, rate: transfer.bytes / MIB / (Math.max(transfer.milliseconds, 1) / 1000) };
}

async function measure(probe: Probe, direct: boolean): Promise<Sample | Reason> {
  const program = toolPath(probe.config, "ssh", probe.home);
  const environment = { ...stringEnvironment(probe.environment), SSH_AUTH_SOCK: "" };
  return sampleOf(await measureTransfer(program, sampleArguments(probe.host.sshAlias, direct), { environment, timeoutMs: SAMPLE_TIMEOUT_MS }));
}

async function master(probe: Probe): Promise<{ age: string; pid: number } | null> {
  const checked = await local(probe, "ssh", ["-O", "check", probe.host.sshAlias], true);
  if (checked.kind !== "exited" || checked.exitCode !== 0) return null;
  const pid = Number(/pid=(\d+)/.exec(checked.stderr)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const elapsed = await local(probe, "ps", ["-o", "etime=", "-p", String(pid)]);
  return { age: elapsed.kind === "exited" ? age(elapsed.stdout) : "age unknown", pid };
}

const rate = (sample: Sample) => `${sample.rate.toFixed(1)} MiB/s`;

async function link(probe: Probe): Promise<Found> {
  const alias = probe.host.sshAlias;
  const shared = await master(probe);
  const through = await measure(probe, false);
  if (typeof through === "string") return fail(probe, through);
  const direct = await measure(probe, true);
  if (typeof direct === "string") return fail(probe, direct);
  if (shared === null) {
    return ok({ detail: `No shared SSH link is open; new connections go direct from ${direct.client} at ${rate(direct)}.`, id: "link", status: "ok" });
  }
  const repair = `ssh -O stop ${alias}`;
  const next = `Run ${repair}. Open sessions keep running; new connections get a fresh link. Then run remote-dev doctor ${probe.target.id} and remote-dev open ${probe.target.id}.`;
  const described = `The shared SSH link to ${alias} (pid ${shared.pid}, ${shared.age})`;
  if (through.client !== direct.client) {
    return refuse(
      probe,
      "link-stale-route",
      `Cause link-stale-route. ${described} still leaves from ${through.client}, but new connections leave from ${direct.client}. It moved ${rate(through)}; a direct connection moved ${rate(direct)}.`,
      repair,
      next,
    );
  }
  if (through.rate < direct.rate * DEGRADED_RATIO) {
    return refuse(
      probe,
      "link-degraded",
      `Cause link-degraded. ${described} moved ${rate(through)}; a direct connection from the same address moved ${rate(direct)}.`,
      repair,
      next,
    );
  }
  return ok({ detail: `${described} leaves from ${through.client} and moved ${rate(through)} (direct ${rate(direct)}).`, id: "link", status: "ok" });
}

interface Resolved {
  containerId: string;
}

async function hostAndContainer(probe: Probe, resolved: Resolved): Promise<Found> {
  const found = await recheck(probe.config, probe.target.id, probe.environment);
  if (!found.ok) return fail(probe, found.reason);
  resolved.containerId = found.value.container.id;
  return ok(
    { detail: `Docker on ${probe.host.id} answered through ${probe.host.sshAlias}.`, id: "host", status: "ok" },
    { detail: `${probe.target.container} (${found.value.container.id.slice(0, 12)}) is running with its configured identity.`, id: "container", status: "ok" },
  );
}

async function editorServer(probe: Probe, resolved: Resolved): Promise<Found> {
  const version = await local(probe, "code", ["--version"]);
  if (version.kind === "missing") return fail(probe, "tool-unavailable");
  const [release, commit] = version.kind === "exited" ? version.stdout.split("\n") : [];
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) {
    return ok({ detail: "Could not read the local VS Code commit, so the container's server was not checked.", id: "editor-server", status: "note" });
  }
  const listed = await remote(probe.config, probe.host, serverListCommand(probe.host, resolved.containerId), probe.environment);
  if (!listed.ok) return fail(probe, listed.reason);
  const lines = listed.value.split("\n");
  const short = commit.slice(0, 8);
  if (lines.includes(`ready ${commit}`)) {
    return ok({ detail: `The VS Code ${release} server (${short}) is installed in the container.`, id: "editor-server", status: "ok" });
  }
  const partial = lines.filter((line) => line.startsWith(`partial ${commit}_`)).map((line) => line.slice("partial ".length));
  const leftover = partial.length === 0 ? "" : ` An earlier upload stopped part way and left ${partial.join(", ")}; VS Code starts a fresh folder.`;
  return ok({
    detail: `The VS Code ${release} server (${short}) is not in the container yet; VS Code uploads it on the next open.${leftover}`,
    id: "editor-server",
    status: "note",
  });
}

async function checkoutOf(path: string): Promise<{ gitEntry: string; root: string } | null> {
  for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
    const entry = join(directory, ".git");
    if ((await stat(entry).catch(() => null)) !== null) return { gitEntry: entry, root: directory };
  }
  return null;
}

async function install(probe: Probe): Promise<Found> {
  const link = join(probe.home, ".local", "bin", "remote-dev");
  if ((await lstat(link).catch(() => null)) === null) {
    return ok({ detail: `remote-dev is not installed at ${link}.`, id: "install", status: "note" });
  }
  const installed = await realpath(link).catch(() => null);
  const checkout = installed === null ? null : await checkoutOf(installed);
  if (installed === null || checkout === null) {
    return ok({ detail: `${link} does not resolve into a git checkout.`, id: "install", status: "note" });
  }
  if ((await stat(checkout.gitEntry)).isDirectory()) {
    return ok({ detail: `Installed from the main checkout at ${checkout.root}.`, id: "install", status: "ok" });
  }
  const gitdir = /^gitdir: (.+)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(await readFile(checkout.gitEntry, "utf8"))?.[1];
  const main = gitdir === undefined ? null : join(gitdir, relative(checkout.root, installed));
  const repair = main === null ? undefined : `ln -sfn '${main}' '${link}'`;
  return refuse(
    probe,
    "install-from-worktree",
    `Cause install-from-worktree. ${link} runs from the worktree at ${checkout.root}, so it changes whenever that branch changes.`,
    repair,
    repair === undefined ? undefined : `Run ${repair}, then run remote-dev doctor ${probe.target.id} again.`,
  );
}

/** Check each step of the route to a target in order; the first failure names its cause and repair. */
export async function doctor(
  command: string,
  config: RemoteDevConfig,
  targetId: string,
  environment: Environment,
): Promise<OperationResult> {
  const target = config.targets.find((candidate) => candidate.id === targetId);
  const host = config.hosts.find((candidate) => candidate.id === target?.host);
  if (target === undefined || host === undefined) return resultFor(command, "target-unknown");
  const probe: Probe = { command, config, environment, home: homeOf(environment), host, target };
  const resolved: Resolved = { containerId: target.containerId };
  const steps: ((probe: Probe, resolved: Resolved) => Promise<Found>)[] = [network, link, hostAndContainer, editorServer, install];
  const checks: Check[] = [];
  for (const step of steps) {
    const found = await step(probe, resolved);
    if (!found.ok) return found.result;
    checks.push(...found.checks);
  }
  const notes = checks.filter((check) => check.status === "note").length;
  return resultFor(command, "inspected", {
    data: { checks, target: targetId },
    message:
      notes === 0
        ? `Every step to ${targetId} is healthy. Nothing was changed.`
        : `Every step to ${targetId} works, with ${notes} note${notes === 1 ? "" : "s"}. Nothing was changed.`,
  });
}
