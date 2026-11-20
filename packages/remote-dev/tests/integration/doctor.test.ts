import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  calls,
  cleanupWorlds,
  type DoctorScenario,
  envelopeOf,
  makeWorld,
  observedStations,
  PS,
  psOutput,
  run,
  type World,
} from "../support/harness.ts";

afterEach(cleanupWorlds);

const RUNNING = psOutput(PS.pilotRunning);
const MIB = 1024 * 1024;

interface Recorded {
  direct: { client: string };
  editor: { commit: string };
  master: { client: string; etime: string; pid: number };
  route: { default: string; host: string };
  servers: string[];
  sshConfig: { hostname: string };
  transfer: { bytes: number; directSeconds: number; sharedSeconds: number };
}

async function recordedFault(): Promise<DoctorScenario> {
  const recorded = JSON.parse(
    await readFile(join(import.meta.dir, "../fixtures/stale-link-20261121.json"), "utf8"),
  ) as Recorded;
  const rate = (seconds: number) => recorded.transfer.bytes / seconds / MIB;
  return {
    commit: recorded.editor.commit,
    direct: { client: recorded.direct.client, mibPerSecond: rate(recorded.transfer.directSeconds) },
    hostname: recorded.sshConfig.hostname,
    master: { etime: recorded.master.etime, pid: recorded.master.pid },
    route: recorded.route,
    servers: recorded.servers,
    shared: { client: recorded.master.client, mibPerSecond: rate(recorded.transfer.sharedSeconds) },
  };
}

async function doctorWorld(doctor: DoctorScenario, ssh: Record<string, unknown> = { ps: [RUNNING] }): Promise<World> {
  return makeWorld({ doctor, ssh });
}

function result(world: World, target = "pilot") {
  const output = run(world, ["doctor", target, "--json"]);
  return { output, result: envelopeOf(output).result };
}

/** Doctor is read-only: it never stops a link or changes a container. */
async function assertReadOnly(world: World): Promise<void> {
  const forbidden = /'(build|create|kill|pause|prune|restart|rm|run|start|stop|unpause|update)'/;
  for (const call of await calls(world, "ssh")) {
    expect(call.argv.some((word) => word === "stop" || word === "exit" || word === "cancel")).toBe(false);
    expect(forbidden.test(call.argv.at(-1) ?? "")).toBe(false);
  }
}

test("replayed 21 November fault: a shared link still on WireGuard after coming home names link-stale-route", async () => {
  const world = await doctorWorld(await recordedFault());
  const { output, result: found } = result(world);
  expect(output.exitCode).toBe(3);
  expect(output.stderr).toBe("");
  expect(found).toMatchObject({
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    commandIdentity: "remote-dev.doctor",
    data: null,
    outcome: "refused",
    repairAction: "ssh -O stop mac-mini",
    transactionState: "unchanged",
  });
  const message = envelopeOf(output).message;
  for (const fragment of ["Cause link-stale-route.", "pid 79434", "15h 33m old", "from 192.168.2.2", "from 192.168.1.104"]) {
    expect(message).toContain(fragment);
  }
  expect(found.nextAction).toContain("ssh -O stop mac-mini");
  expect(found.nextAction).toContain("remote-dev doctor pilot");
  await assertReadOnly(world);
});

test("a shared link on the right route that moves under half the direct rate names link-degraded", async () => {
  const world = await doctorWorld({
    direct: { client: "192.168.1.104", mibPerSecond: 31 },
    shared: { client: "192.168.1.104", mibPerSecond: 5 },
  });
  const { output, result: found } = result(world);
  expect(output.exitCode).toBe(3);
  expect(found).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET", repairAction: "ssh -O stop mac-mini" });
  expect(envelopeOf(output).message).toContain("Cause link-degraded.");
  await assertReadOnly(world);
});

test("no route from this Mac to the host names network-no-route before any SSH sample", async () => {
  const world = await doctorWorld({ route: { host: null } });
  const { output, result: found } = result(world);
  expect(output.exitCode).toBe(3);
  expect(found).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET" });
  expect(envelopeOf(output).message).toContain("Cause network-no-route.");
  expect((await calls(world, "ssh")).map((call) => call.argv.at(-1) ?? "").filter((command) => command.includes("SSH_CONNECTION"))).toEqual([]);
});

test("an unreachable host is the transient station, and a stopped target keeps its existing refusal", async () => {
  const unreachable = await doctorWorld({}, { exit: 255 });
  expect(result(unreachable).result).toMatchObject({ causeCode: "TRANSIENT_ATTEMPT_UNCHANGED", retryable: true });
  const stopped = await doctorWorld({}, { ps: [psOutput(PS.pilotStopped)] });
  expect(result(stopped).result).toMatchObject({ causeCode: "DOMAIN_AUTHORITY_REQUIRED", outcome: "refused" });
  const failing = await doctorWorld({}, { ps: [RUNNING], psExits: [1] });
  expect(result(failing).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED" });
  await assertReadOnly(stopped);
});

test("a healthy route reports every step in order and notes a missing or half-uploaded VS Code server", async () => {
  const world = await doctorWorld({
    servers: ["partial 8a14f0cc1b08d531eb83255ea3764ae22aa932b5_1795215793849", "ready c4453f8ea430795f941c1b2ff6c9321135a74a02"],
  });
  const { output, result: found } = result(world);
  expect(output.exitCode).toBe(0);
  expect(found.causeCode).toBe("SUCCESS_UNCHANGED");
  const checks = (found.data as { checks: { detail: string; id: string; status: string }[] }).checks;
  expect(checks.map((check) => `${check.id}:${check.status}`)).toEqual([
    "network:ok",
    "link:ok",
    "host:ok",
    "container:ok",
    "editor-server:note",
    "install:note",
  ]);
  const server = checks.find((check) => check.id === "editor-server")?.detail ?? "";
  expect(server).toContain("8a14f0cc");
  expect(server).toContain("8a14f0cc1b08d531eb83255ea3764ae22aa932b5_1795215793849");
  const ready = await doctorWorld({ servers: ["ready 8a14f0cc1b08d531eb83255ea3764ae22aa932b5"] });
  const readyChecks = (result(ready).result.data as { checks: { id: string; status: string }[] }).checks;
  expect(readyChecks.find((check) => check.id === "editor-server")?.status).toBe("ok");
  await assertReadOnly(world);
});

async function installInto(world: World, gitEntry: "directory" | "worktree-file"): Promise<string> {
  const main = join(world.dir, "code", "dotfiles");
  const root = gitEntry === "directory" ? main : join(main, ".worktrees", "remote-dev-x");
  await mkdir(join(root, "packages", "remote-dev", "bin"), { recursive: true });
  await writeFile(join(root, "packages", "remote-dev", "bin", "remote-dev"), "#!/bin/sh\n");
  if (gitEntry === "directory") await mkdir(join(main, ".git"), { recursive: true });
  else await writeFile(join(root, ".git"), `gitdir: ${main}/.git/worktrees/remote-dev-x\n`);
  await mkdir(join(world.dir, ".local", "bin"), { recursive: true });
  await symlink(join(root, "packages", "remote-dev", "bin", "remote-dev"), join(world.dir, ".local", "bin", "remote-dev"));
  return main;
}

test("an install that runs from a git worktree names install-from-worktree with the relink command", async () => {
  const world = await doctorWorld({ servers: ["ready 8a14f0cc1b08d531eb83255ea3764ae22aa932b5"] });
  const main = await installInto(world, "worktree-file");
  const { output, result: found } = result(world);
  expect(output.exitCode).toBe(3);
  expect(envelopeOf(output).message).toContain("Cause install-from-worktree.");
  expect(found.repairAction).toBe(
    `ln -sfn '${main}/packages/remote-dev/bin/remote-dev' '${world.dir}/.local/bin/remote-dev'`,
  );
  const onMain = await doctorWorld({ servers: ["ready 8a14f0cc1b08d531eb83255ea3764ae22aa932b5"] });
  await installInto(onMain, "directory");
  const checks = (result(onMain).result.data as { checks: { id: string; status: string }[] }).checks;
  expect(checks.find((check) => check.id === "install")?.status).toBe("ok");
});

test("doctor validates its target and configuration like the other target commands", async () => {
  const world = await doctorWorld({});
  expect(result(world, "nope").result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
  expect(run(world, ["doctor", "bad;target", "--json"]).exitCode).toBe(4);
  const missing = await makeWorld({}, () => undefined);
  expect(result(missing).result.causeCode).toBe("DOMAIN_CONFIG_MISSING");
  const invalid = await makeWorld({}, () => "{");
  expect(result(invalid).result.causeCode).toBe("SCHEMA_CONFIG_INVALID");
  const noArgs = run(world, ["doctor", "--json"]);
  expect(noArgs.exitCode).toBe(2);
});

test("human doctor output lists each step on success and the cause on stderr on failure", async () => {
  const world = await doctorWorld({ servers: ["ready 8a14f0cc1b08d531eb83255ea3764ae22aa932b5"] });
  const healthy = run(world, ["doctor", "pilot"]);
  expect(healthy.exitCode).toBe(0);
  for (const step of ["network", "link", "host", "container", "editor-server", "install"]) {
    expect(healthy.stdout).toContain(step);
  }
  const broken = await doctorWorld(await recordedFault());
  const failed = run(broken, ["doctor", "pilot"]);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("Cause link-stale-route.");
  expect(failed.stderr).toContain("ssh -O stop mac-mini");
});

test("every doctor station was observed and no undeclared station appeared", async () => {
  const { stationsFor } = await import("../../src/branch-station-catalog.ts");
  const command = "remote-dev.doctor";
  const declared = stationsFor(command);
  const keys = new Set(declared.map((station) => `${command}|${station.outcome}|${station.causeCode}`));
  // Independent oracle: the eight stations doctor can reach.
  expect([...keys].sort()).toEqual([
    "remote-dev.doctor|failed|INTERNAL_RESULT_UNCHANGED",
    "remote-dev.doctor|failed|TRANSIENT_ATTEMPT_UNCHANGED",
    "remote-dev.doctor|refused|DOMAIN_AUTHORITY_REQUIRED",
    "remote-dev.doctor|refused|DOMAIN_CONFIG_MISSING",
    "remote-dev.doctor|refused|DOMAIN_PRECONDITION_UNMET",
    "remote-dev.doctor|refused|SCHEMA_CONFIG_INVALID",
    "remote-dev.doctor|refused|SCHEMA_INVALID_INPUT",
    "remote-dev.doctor|success|SUCCESS_UNCHANGED",
  ]);
  const observed = [...observedStations].filter((key) => key.startsWith(`${command}|`));
  expect(observed.filter((key) => !keys.has(key))).toEqual([]);
  expect([...keys].filter((key) => !observedStations.has(key))).toEqual([]);
});
