import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const FAKE_TOOL = join(import.meta.dir, "fake-tool.ts");

// Independent fixture identities (the pilot facts come from the reviewed proposal).
export const PILOT_ID = "3b6ad4e9ef164d65dc3690580acb4bdbd0a329bf47ee5a128393eedd470d710a";
export const DEVBOX_ID = "1111111111111111111111111111111111111111111111111111111111111111";
export const INFRA_ID = "2222222222222222222222222222222222222222222222222222222222222222";
const IMPOSTER_ID = "9999999999999999999999999999999999999999999999999999999999999999";

export const PS = {
  devboxRunning: `${DEVBOX_ID} devbox-1 running`,
  devboxStopped: `${DEVBOX_ID} devbox-1 exited`,
  infra: `${INFRA_ID} orb-infra running`,
  pilotReplaced: `${IMPOSTER_ID} shepherdr-pilot-main-20261112 running`,
  pilotRunning: `${PILOT_ID} shepherdr-pilot-main-20261112 running`,
  pilotStopped: `${PILOT_ID} shepherdr-pilot-main-20261112 exited`,
};

export function psOutput(...rows: string[]): string {
  return rows.length === 0 ? "" : `${rows.join("\n")}\n`;
}

/** One measured SSH sample: the client address sshd saw, and the transfer rate. */
export interface LinkSample {
  client: string;
  mibPerSecond: number;
  responds?: boolean;
  /** A sample that stops early: the bytes that arrive, then the ssh exit code. */
  transfer?: { bytes: number; exitCode: number };
}

export interface DoctorScenario {
  commit?: string;
  direct?: LinkSample;
  hostname?: string;
  master?: { etime: string; pid: number } | null;
  route?: { default?: string; host?: string | null };
  servers?: string[];
  shared?: LinkSample;
}

export interface Scenario {
  code?: { exit?: number };
  doctor?: DoctorScenario;
  fzf?: { picks?: { exit?: number; key?: string; match?: string }[] };
  opener?: { exit?: number };
  pilotRuntime?: { exit?: number; output?: string };
  ssh?: { exit?: number; logs?: string; ps?: string[]; psExits?: number[]; startExit?: number; unreachableAliases?: string[] };
}

export interface World {
  configPath: string;
  dir: string;
  env: Record<string, string>;
  logPath: string;
}

const worlds: string[] = [];

export async function cleanupWorlds(): Promise<void> {
  await Promise.all(worlds.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
}

export function baseConfig(dir: string) {
  return {
    editor: {
      extensionsDir: join(dir, "isolated", "extensions"),
      userDataDir: join(dir, "isolated", "user-data"),
    },
    hosts: [
      {
        dockerHost: "unix:///Users/server/.orbstack/run/docker.sock",
        dockerPath: "/opt/homebrew/bin/docker",
        id: "mini",
        label: "Mac mini (OrbStack)",
        sshAlias: "mac-mini",
      },
    ],
    targets: [
      {
        board: "https://board.example.test/shepherdr/",
        container: "shepherdr-pilot-main-20261112",
        containerId: PILOT_ID,
        guide: "/workspace/START-HERE.md",
        host: "mini",
        id: "pilot",
        label: "Shepherdr UI pilot",
        role: "ui-pilot",
        serviceLog: "/home/agent/.local/state/pilot-runtime/main-d57a0261/service.log",
        workspaceFolder: "/workspace",
      },
      {
        container: "devbox-1",
        containerId: DEVBOX_ID,
        host: "mini",
        id: "devbox",
        label: "Development box",
        role: "development",
        workspaceFolder: "/workspace",
      },
    ] as Record<string, unknown>[],
    tools: {
      code: join(dir, "bin", "code"),
      fzf: join(dir, "bin", "fzf"),
      opener: join(dir, "bin", "opener"),
      pilotRuntime: join(dir, "bin", "pilotRuntime"),
      ps: join(dir, "bin", "ps"),
      route: join(dir, "bin", "route"),
      ssh: join(dir, "bin", "ssh"),
    } as Record<string, string>,
    version: 1,
  };
}

export async function makeWorld(
  scenario: Scenario,
  edit: (config: ReturnType<typeof baseConfig>) => unknown = (config) => config,
): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), "remote-dev-test-"));
  worlds.push(dir);
  await mkdir(join(dir, "bin"));
  await mkdir(join(dir, "isolated", "user-data"), { recursive: true });
  await mkdir(join(dir, "isolated", "extensions"), { recursive: true });
  for (const tool of ["ssh", "code", "fzf", "opener", "pilotRuntime", "ps", "route"]) {
    const path = join(dir, "bin", tool);
    await writeFile(path, `#!/bin/sh\nFAKE_SCENARIO="${dir}/scenario.json" FAKE_LOG="${dir}/calls.jsonl" exec "${process.execPath}" "${FAKE_TOOL}" ${tool} "$@"\n`);
    await chmod(path, 0o755);
  }
  const scenarioPath = join(dir, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const configPath = join(dir, "targets.json");
  const config = edit(baseConfig(dir));
  if (config !== undefined) await writeFile(configPath, typeof config === "string" ? config : JSON.stringify(config));
  const logPath = join(dir, "calls.jsonl");
  await writeFile(logPath, "");
  return {
    configPath,
    dir,
    env: {
      FAKE_LOG: logPath,
      FAKE_SCENARIO: scenarioPath,
      HOME: dir,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      REMOTE_DEV_CONFIG: configPath,
      SSH_AUTH_SOCK: "/tmp/daily-agent.sock",
      VSCODE_IPC_HOOK_CLI: "/tmp/daily-vscode.sock",
    },
    logPath,
  };
}

export interface Call {
  argv: string[];
  sshAuthSock: string | null;
  stdin: string;
  tool: string;
  vscodeIpcHook: string | null;
}

export async function calls(world: World, tool?: string): Promise<Call[]> {
  const text = await readFile(world.logPath, "utf8");
  const all = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);
  return tool === undefined ? all : all.filter((call) => call.tool === tool);
}

/** Observed (command|outcome|cause) tuples, for catalogue reachability checks. */
export const observedStations = new Set<string>();

export function observeOutput(stdout: string): void {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { result?: { causeCode: string; commandIdentity: string; outcome: string } };
      if (parsed.result !== undefined) {
        const { commandIdentity, outcome, causeCode } = parsed.result;
        observedStations.add(`${commandIdentity}|${outcome}|${causeCode}`);
      }
    } catch {
      // Human output lines are not envelopes.
    }
  }
}

export interface Run {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function run(world: World, args: string[]): Run {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: PACKAGE_ROOT,
    env: world.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  observeOutput(stdout);
  return { exitCode: result.exitCode ?? -1, stderr: result.stderr.toString(), stdout };
}

export function envelopeOf(output: Run): {
  message: string;
  result: Record<string, unknown> & { causeCode: string; data: unknown; outcome: string };
} {
  return JSON.parse(output.stdout);
}

/** Run the CLI on a real pseudo-terminal, as a person would. */
export async function runPty(world: World, args: string[]): Promise<{ exitCode: number; output: string }> {
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: PACKAGE_ROOT,
    env: world.env,
    terminal: {
      cols: 200,
      data(_terminal, data) {
        output += decoder.decode(data, { stream: true });
      },
      rows: 40,
    },
  });
  const exitCode = await child.exited;
  await Bun.sleep(50);
  child.terminal?.close();
  observeOutput(output);
  return { exitCode, output };
}

/** Test-owned list of Docker verbs that would change container or service lifecycle. */
const FORBIDDEN_VERBS = [
  "build", "commit", "compose", "create", "kill", "pause", "prune", "pull",
  "rename", "restart", "rm", "rmi", "run", "start", "stop", "unpause", "update", "up", "down",
];

export async function assertNoLifecycleCommands(world: World): Promise<void> {
  for (const call of await calls(world, "ssh")) {
    const words = (call.argv.at(-1) ?? "").split(" ").map((word) => word.replaceAll("'", ""));
    const verb = words[3];
    if (verb === undefined || FORBIDDEN_VERBS.includes(verb) || !["ps", "exec"].includes(verb)) {
      throw new Error(`Unexpected remote command: ${call.argv.at(-1)}`);
    }
  }
}
