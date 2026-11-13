import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { baseConfig, calls, cleanupWorlds, envelopeOf, makeWorld, PILOT_ID, PS, psOutput, run, runPty } from "../support/harness.ts";

afterEach(cleanupWorlds);
const RUNNING = psOutput(PS.pilotRunning);
const STOPPED = psOutput(PS.pilotStopped);
function admitted(config: ReturnType<typeof baseConfig>) {
  Object.assign(config.targets[0]!, { allowStart: true, restore: { kind: "shepherdr-pilot", claudeOAuthRef: "op://fixture/existing-claude/credential", shepherdrVersion: "3.1.33" } });
  return config;
}

test("start verifies services before editor dispatch and passes only existing custody coordinates", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } }, admitted);
  const result = run(world, ["start", "pilot", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const recorded = await calls(world);
  expect(recorded.map((x) => x.tool)).toEqual(["ssh", "ssh", "pilotRuntime", "ssh", "code"]);
  expect(recorded[2]?.argv).toEqual(["restore", "--service-log", "/home/agent/.local/state/pilot-runtime/main-d57a0261/service.log", "--ssh", join(world.dir, "bin", "ssh"), "--alias", "mac-mini", "--docker", "/opt/homebrew/bin/docker", "--endpoint", "unix:///Users/server/.orbstack/run/docker.sock", "--container", PILOT_ID, "--version", "3.1.33", "--wrapper", join(world.dir, "code/dotfiles/bin/with-one-password-token"), "--reference", "op://fixture/existing-claude/credential"]);
  expect(recorded[2]?.sshAuthSock).toBe("");
  expect(recorded[2]?.stdin).toBe("");
  expect(envelopeOf(result).result.effects).toEqual({ completed: ["editor-window:pilot"], remaining: [], uncertain: [], inventoryComplete: true });
});

test("stopped start records both container and restored services before editor", async () => {
  const world = await makeWorld({ ssh: { ps: [STOPPED, RUNNING] }, pilotRuntime: { output: JSON.stringify({ status: "ready", attempted: true, started: ["core", "tailscale", "shepherdr"] }) } }, admitted);
  const result = run(world, ["start", "pilot", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(envelopeOf(result).result.effects).toEqual({ completed: ["container-start:pilot", "editor-window:pilot", "services-restore:pilot"], inventoryComplete: true, remaining: [], uncertain: [] });
});

test.each([false, true])("service refusal preserves confirmed container start=%s and never opens editor", async (started) => {
  const world = await makeWorld({ ssh: { ps: started ? [STOPPED, RUNNING] : [RUNNING] }, pilotRuntime: { exit: 1, output: JSON.stringify({ status: "failed", attempted: false, started: [] }) } }, admitted);
  const result = run(world, ["start", "pilot", "--json"]);
  expect(result.exitCode).toBe(started ? 1 : 3);
  expect(envelopeOf(result).result).toMatchObject({ transactionState: started ? "partially-completed" : "unchanged", retryable: false, effects: { completed: started ? ["container-start:pilot"] : [], uncertain: [], remaining: ["editor-window:pilot", "services-restore:pilot"] } });
  expect(await calls(world, "code")).toEqual([]);
});

test.each(["malformed", JSON.stringify({ status: "failed", started: ["core"], attempted: true })])("uncertain service restore stops before editor without retry", async (output) => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] }, pilotRuntime: { exit: 1, output } }, admitted);
  const result = run(world, ["start", "pilot", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(envelopeOf(result).result).toMatchObject({ transactionState: "unknown", retryable: false, effects: { completed: [], remaining: ["editor-window:pilot"], uncertain: ["services-restore:pilot"] } });
  expect(await calls(world, "pilotRuntime")).toHaveLength(1);
  expect(await calls(world, "code")).toEqual([]);
});

test("a failed editor preserves successful service restoration", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] }, pilotRuntime: { output: JSON.stringify({ status: "ready", attempted: true, started: ["shepherdr"] }) }, code: { exit: 1 } }, admitted);
  expect(envelopeOf(run(world, ["start", "pilot", "--json"])).result.effects).toEqual({ completed: ["services-restore:pilot"], inventoryComplete: true, remaining: [], uncertain: ["editor-window:pilot"] });
});

test("the running pilot chooser uses the restore action", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] }, fzf: { picks: [{ match: "\tpilot\t" }, { match: "start\t" }] } }, admitted);
  expect((await runPty(world, ["choose", "--json"])).exitCode).toBe(0);
  expect((await calls(world, "fzf"))[1]?.stdin).toContain("start\tRestore services and open VS Code");
  expect(await calls(world, "pilotRuntime")).toHaveLength(1);
});

test("plain open stays connection-only for a configured service profile", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } }, admitted);
  expect(run(world, ["open", "pilot", "--json"]).exitCode).toBe(0);
  expect(await calls(world, "pilotRuntime")).toEqual([]);
});

test("the reviewed stdin transport delivers a nonsecret sentinel without secret argv or output", async () => {
  const world = await makeWorld({ ssh: { logs: JSON.stringify({ status: "ready", attempted: true, started: ["core"] }) } });
  const p = Bun.spawnSync(["/usr/bin/python3", "resources/pilot-runtime.py", "deliver", "--ssh", join(world.dir, "bin", "ssh"), "--alias", "mac-mini", "--docker", "/opt/homebrew/bin/docker", "--endpoint", "unix:///Users/server/.orbstack/run/docker.sock", "--container", PILOT_ID, "--version", "3.1.33", "--wrapper", "/unused/wrapper", "--reference", "op://fixture/existing/credential"], { cwd: join(import.meta.dir, "../.."), env: world.env, stdin: Buffer.from("NONSECRET_RESTORE_SENTINEL"), stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).not.toContain("NONSECRET_RESTORE_SENTINEL");
  const logged = (await Bun.file(world.logPath).text());
  expect(logged).toContain('"deliveredSentinel":true');
  expect(logged).not.toContain("NONSECRET_RESTORE_SENTINEL");
});
