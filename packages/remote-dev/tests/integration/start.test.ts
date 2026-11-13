import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  baseConfig, calls, cleanupWorlds, envelopeOf, makeWorld, observedStations, PILOT_ID, PS, psOutput, run, runPty,
} from "../support/harness.ts";

afterEach(cleanupWorlds);

function optIn(config: ReturnType<typeof baseConfig>) {
  config.targets[0]!.allowStart = true;
  return config;
}

const STOPPED = psOutput(PS.pilotStopped);
const RUNNING = psOutput(PS.pilotRunning);
// Independent literal oracle: host engine and full container ID are the mutation authority.
const START = `'/opt/homebrew/bin/docker' '--host' 'unix:///Users/server/.orbstack/run/docker.sock' 'start' '${PILOT_ID}'`;

test("start accepts an opted-in exact stopped container, starts once by full ID and opens isolated VS Code", async () => {
  const world = await makeWorld({ ssh: { ps: [STOPPED, RUNNING] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
  expect(envelopeOf(output).result).toMatchObject({
    commandIdentity: "remote-dev.start", causeCode: "SUCCESS_COMPLETED", transactionState: "completed",
    effects: { completed: ["container-start:pilot", "editor-window:pilot"], inventoryComplete: true, remaining: [], uncertain: [] },
  });
  const recorded = await calls(world);
  expect(recorded.map((call) => call.tool)).toEqual(["ssh", "ssh", "ssh", "ssh", "code"]);
  expect(recorded.filter((call) => call.argv.at(-1) === START)).toHaveLength(1);
  const start = recorded[1]!;
  expect(start.argv.slice(0, -1)).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "--", "mac-mini"]);
  expect(start.sshAuthSock).toBe("");
  expect(recorded.at(-1)).toMatchObject({ sshAuthSock: "", vscodeIpcHook: null });
  expect(recorded.at(-1)?.argv).toContain(join(world.dir, "isolated", "user-data"));
  expect(recorded.filter((call) => call.tool === "ssh").map((call) => call.argv.at(-1)?.split(" ")[3])).toEqual(["'ps'", "'start'", "'ps'", "'ps'"]);
});

test("start skips mutation for an opted-in running container", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(envelopeOf(output).result.effects).toEqual({ completed: ["editor-window:pilot"], inventoryComplete: true, remaining: [], uncertain: [] });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "ssh", "code"]);
  expect((await calls(world, "ssh")).some((call) => call.argv.at(-1) === START)).toBe(false);
});

test.each(["exited", "created"])("start admits raw Docker %s state", async (state) => {
  const world = await makeWorld({ ssh: { ps: [STOPPED.replace("exited", state), RUNNING] } }, optIn);
  expect(run(world, ["start", "pilot", "--json"]).exitCode).toBe(0);
  expect((await calls(world, "ssh")).filter((call) => call.argv.at(-1) === START)).toHaveLength(1);
});

test.each(["paused", "restarting", "removing", "dead", "unknown"])("start refuses raw Docker %s state without mutation", async (state) => {
  const world = await makeWorld({ ssh: { ps: [STOPPED.replace("exited", state)] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(3);
  expect(envelopeOf(output).result).toMatchObject({ causeCode: "DOMAIN_AUTHORITY_REQUIRED", transactionState: "unchanged" });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh"]);
});

test("start refuses omitted opt-in, false opt-in, unknown and unsafe targets before inspection", async () => {
  for (const value of [undefined, false]) {
    const world = await makeWorld({ ssh: { ps: [STOPPED] } }, (config) => {
      if (value !== undefined) config.targets[0]!.allowStart = value;
      return config;
    });
    expect(run(world, ["start", "pilot", "--json"]).exitCode).toBe(3);
    expect(run(world, ["start", "orb-infra", "--json"]).exitCode).toBe(3);
    expect(run(world, ["start", "pilot;touch x", "--json"]).exitCode).toBe(4);
    expect(await calls(world)).toEqual([]);
  }
});

test.each(["", psOutput(PS.pilotReplaced), STOPPED.replace("shepherdr-pilot-main-20261112", "other-name")])("start refuses missing or replaced identity before mutation (%s)", async (inventory) => {
  const world = await makeWorld({ ssh: { ps: [inventory] } }, optIn);
  expect(run(world, ["start", "pilot", "--json"]).exitCode).toBe(3);
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh"]);
});

test("start checks isolated editor directories and executable before mutation", async () => {
  const missingDir = await makeWorld({ ssh: { ps: [STOPPED] } }, optIn);
  await rm(join(missingDir.dir, "isolated", "user-data"), { recursive: true });
  expect(run(missingDir, ["start", "pilot", "--json"]).exitCode).toBe(3);
  const missingCode = await makeWorld({ ssh: { ps: [STOPPED] } }, (config) => {
    optIn(config); config.tools.code = "/nonexistent/code"; return config;
  });
  expect(run(missingCode, ["start", "pilot", "--json"]).exitCode).toBe(3);
  for (const world of [missingDir, missingCode]) {
    expect((await calls(world, "ssh")).some((call) => call.argv.at(-1) === START)).toBe(false);
    expect(await calls(world, "code")).toEqual([]);
  }
});

test.each([255, 1])("start dispatch failure %s is unknown, never retryable and never opens the editor", async (startExit) => {
  const world = await makeWorld({ ssh: { ps: [STOPPED], startExit } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(envelopeOf(output).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNKNOWN", transactionState: "unknown", retryable: false,
    effects: { completed: [], inventoryComplete: true, remaining: ["editor-window:pilot"], uncertain: ["container-start:pilot"] } });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "ssh"]);
});

test.each([STOPPED, "", psOutput(PS.pilotReplaced)])("start requires exact running identity after dispatch (%s)", async (after) => {
  const world = await makeWorld({ ssh: { ps: [STOPPED, after] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(envelopeOf(output).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNKNOWN", transactionState: "unknown", retryable: false,
    effects: { completed: [], remaining: ["editor-window:pilot"], uncertain: ["container-start:pilot"] } });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "ssh", "ssh"]);
});

test("start preserves confirmed start when editor dispatch fails", async () => {
  const world = await makeWorld({ code: { exit: 1 }, ssh: { ps: [STOPPED, RUNNING] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(envelopeOf(output).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNKNOWN", transactionState: "unknown", retryable: false,
    effects: { completed: ["container-start:pilot"], inventoryComplete: true, remaining: [], uncertain: ["editor-window:pilot"] } });
  expect((await calls(world, "code"))).toHaveLength(1);
});

test("start preserves confirmed start as partial if the editor recheck refuses", async () => {
  const world = await makeWorld({ ssh: { ps: [STOPPED, RUNNING, psOutput(PS.pilotReplaced)] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(envelopeOf(output).result).toMatchObject({ causeCode: "INTERNAL_RESULT_PARTIAL", transactionState: "partially-completed", retryable: false,
    effects: { completed: ["container-start:pilot"], inventoryComplete: true, remaining: ["editor-window:pilot"], uncertain: [] } });
  expect(await calls(world, "code")).toEqual([]);
});

test("chooser offers start for an opted-in stopped target and uses the same transition", async () => {
  const world = await makeWorld({ fzf: { picks: [{ match: "\tpilot\t" }, { match: "start\t" }] }, ssh: { ps: [STOPPED, STOPPED, RUNNING] } }, optIn);
  const output = await runPty(world, ["--json"]);
  expect(output.exitCode).toBe(0);
  expect((await calls(world, "fzf"))[1]?.stdin).toBe("start\tStart and open VS Code\n");
  expect((await calls(world, "ssh")).filter((call) => call.argv.at(-1) === START)).toHaveLength(1);
});

test("chooser cancellation on the start menu never mutates", async () => {
  const world = await makeWorld({ fzf: { picks: [{ match: "\tpilot\t" }, { exit: 130 }] }, ssh: { ps: [STOPPED] } }, optIn);
  const output = await runPty(world, ["--json"]);
  expect(output.exitCode).toBe(0);
  expect(output.output).toContain("Cancelled. Nothing was launched or started.");
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "fzf", "fzf"]);
});

test("start rejects invalid config and unavailable source prerequisites before mutation", async () => {
  const cases = [
    [await makeWorld({}, () => undefined), 3, "DOMAIN_CONFIG_MISSING"],
    [await makeWorld({}, () => "{}"), 4, "SCHEMA_CONFIG_INVALID"],
    [await makeWorld({ ssh: { exit: 255 } }, optIn), 75, "TRANSIENT_ATTEMPT_UNCHANGED"],
    [await makeWorld({ ssh: { exit: 2 } }, optIn), 1, "INTERNAL_RESULT_UNCHANGED"],
    [await makeWorld({}, (config) => { optIn(config); config.tools.ssh = "/nonexistent/ssh"; return config; }), 3, "DOMAIN_PRECONDITION_UNMET"],
    [await makeWorld({}, (config) => { config.targets[0]!.allowStart = "true"; return config; }), 4, "SCHEMA_CONFIG_INVALID"],
  ] as const;
  for (const [world, exitCode, causeCode] of cases) {
    const output = run(world, ["start", "pilot", "--json"]);
    expect(output.exitCode).toBe(exitCode);
    expect(envelopeOf(output).result.causeCode).toBe(causeCode);
    expect((await calls(world, "ssh")).some((call) => call.argv.at(-1) === START)).toBe(false);
    expect(await calls(world, "code")).toEqual([]);
  }
});

test("a failed poststart inspection is unknown, without mutation retries or editor dispatch", async () => {
  const world = await makeWorld({ ssh: { ps: [STOPPED], psExits: [0, 255] } }, optIn);
  const output = run(world, ["start", "pilot", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(envelopeOf(output).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNKNOWN", retryable: false, transactionState: "unknown",
    effects: { completed: [], inventoryComplete: true, remaining: ["editor-window:pilot"], uncertain: ["container-start:pilot"] } });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "ssh", "ssh"]);
});

test("all start stations are observed through the public process seam", async () => {
  const { stationsFor } = await import("../../src/branch-station-catalog.ts");
  const declared = stationsFor("remote-dev.start");
  expect(declared).toHaveLength(10);
  const keys = declared.map((station) => `remote-dev.start|${station.outcome}|${station.causeCode}`);
  const observed = [...observedStations].filter((key) => key.startsWith("remote-dev.start|"));
  expect(observed.sort()).toEqual(keys.sort());
});
