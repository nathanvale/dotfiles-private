import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
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

const ACCEPTANCE = join(import.meta.dir, "../../acceptance");
const RUNNING = psOutput(PS.pilotRunning);
const READY = "ready 8a14f0cc1b08d531eb83255ea3764ae22aa932b5";

type Install = "absent" | "main-checkout" | "worktree";

interface Fault {
  cause: string;
  expect: { cause: string; exitCode: number; messageIncludes: string[]; repairAction: string };
  observed: {
    container: "running" | "stopped";
    directConnection: { clientAddress: string; mibPerSecond: number };
    editor: { commit: string; servers: string[] };
    install: Install;
    route: { default: string; host: string | null };
    sharedLink: { clientAddress: string; etime: string; mibPerSecond?: number; pid: number; responds?: boolean } | null;
    sshConfig: { alias: string; hostname: string };
  };
  target: string;
}

interface CauseRecord {
  detect: string;
  detects: string;
  faults: string[];
  name: string;
  repair: string;
}

async function faultFiles(): Promise<string[]> {
  return (await readdir(join(ACCEPTANCE, "faults"))).filter((name) => name.endsWith(".json")).sort();
}

async function readFault(name: string): Promise<Fault> {
  return JSON.parse(await readFile(join(ACCEPTANCE, "faults", name), "utf8")) as Fault;
}

function scenarioOf(observed: Fault["observed"]): DoctorScenario {
  const shared = observed.sharedLink;
  return {
    commit: observed.editor.commit,
    direct: { client: observed.directConnection.clientAddress, mibPerSecond: observed.directConnection.mibPerSecond },
    hostname: observed.sshConfig.hostname,
    master: shared === null ? null : { etime: shared.etime, pid: shared.pid },
    route: observed.route,
    servers: observed.editor.servers,
    ...(shared === null
      ? {}
      : { shared: { client: shared.clientAddress, mibPerSecond: shared.mibPerSecond ?? 1, responds: shared.responds ?? true } }),
  };
}

/** Lay out ~/.local/bin/remote-dev as the fault describes; returns the main checkout. */
async function install(world: World, kind: Install): Promise<string> {
  const main = join(world.dir, "code", "dotfiles");
  if (kind === "absent") return main;
  const root = kind === "main-checkout" ? main : join(main, ".worktrees", "remote-dev-x");
  await mkdir(join(root, "packages", "remote-dev", "bin"), { recursive: true });
  await writeFile(join(root, "packages", "remote-dev", "bin", "remote-dev"), "#!/bin/sh\n");
  if (kind === "main-checkout") await mkdir(join(main, ".git"), { recursive: true });
  else await writeFile(join(root, ".git"), `gitdir: ${main}/.git/worktrees/remote-dev-x\n`);
  await mkdir(join(world.dir, ".local", "bin"), { recursive: true });
  await symlink(join(root, "packages", "remote-dev", "bin", "remote-dev"), join(world.dir, ".local", "bin", "remote-dev"));
  return main;
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
  const recorded = await calls(world, "ssh");
  expect(recorded.length).toBeGreaterThan(0);
  for (const call of recorded) {
    expect(call.argv.some((word) => word === "stop" || word === "exit" || word === "cancel")).toBe(false);
    expect(forbidden.test(call.argv.at(-1) ?? "")).toBe(false);
  }
}

test("every named cause is a plain record with at least one replayable fault, and every fault is claimed once", async () => {
  const causes = JSON.parse(await readFile(join(ACCEPTANCE, "causes.json"), "utf8")) as CauseRecord[];
  // Independent oracle: doctor's own named causes.
  expect(causes.map((cause) => cause.name).sort()).toEqual([
    "install-from-worktree",
    "link-degraded",
    "link-stale-route",
    "link-unresponsive",
    "network-no-route",
  ]);
  for (const cause of causes) {
    for (const field of [cause.detects, cause.detect, cause.repair]) expect(field.length).toBeGreaterThan(0);
    expect(cause.faults.length).toBeGreaterThan(0);
    for (const fault of cause.faults) expect((await readFault(fault.replace("faults/", ""))).expect.cause).toBe(cause.name);
  }
  const claimed = causes.flatMap((cause) => cause.faults.map((fault) => fault.replace("faults/", ""))).sort();
  expect(claimed).toEqual(await faultFiles());
});

for (const name of await faultFiles()) {
  test(`replayed fault ${name} names its cause and exact repair without changing anything`, async () => {
    const fault = await readFault(name);
    const world = await doctorWorld(scenarioOf(fault.observed), {
      ps: [psOutput(fault.observed.container === "running" ? PS.pilotRunning : PS.pilotStopped)],
    });
    const main = await install(world, fault.observed.install);
    const { output, result: found } = result(world, fault.target);
    expect(output.exitCode).toBe(fault.expect.exitCode);
    expect(output.stderr).toBe("");
    expect(found).toMatchObject({
      commandIdentity: "remote-dev.doctor",
      data: null,
      outcome: "refused",
      repairAction: fault.expect.repairAction.replace("{main}", main).replace("{home}", world.dir),
      transactionState: "unchanged",
    });
    const message = envelopeOf(output).message;
    expect(message.startsWith(`Cause ${fault.expect.cause}.`)).toBe(true);
    for (const fragment of fault.expect.messageIncludes) expect(message).toContain(fragment);
    await assertReadOnly(world);
  });
}

test("link guidance says ssh -O stop keeps open sessions, so an agent can apply it", async () => {
  const fault = await readFault("link-degraded-20261121.json");
  const world = await doctorWorld(scenarioOf(fault.observed));
  const { result: found } = result(world);
  expect(found.nextAction).toContain("ssh -O stop mac-mini");
  expect(found.nextAction).toContain("open sessions keep running");
  expect(found.nextAction).toContain("remote-dev doctor pilot");
  expect(found.nextAction).toContain("remote-dev open pilot");
});

test("no route from this Mac to the host is reported before any SSH sample", async () => {
  const world = await doctorWorld(scenarioOf((await readFault("network-no-route.json")).observed));
  result(world);
  const sampled = (await calls(world, "ssh")).filter((call) => (call.argv.at(-1) ?? "").includes("SSH_CONNECTION"));
  expect(sampled).toEqual([]);
});

test("an unreachable host is the transient station, and a stopped or failing target keeps its existing refusal", async () => {
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
  await assertReadOnly(world);
});

test("an installed server and a main-checkout install are both ok", async () => {
  const world = await doctorWorld({ servers: [READY] });
  await install(world, "main-checkout");
  const checks = (result(world).result.data as { checks: { id: string; status: string }[] }).checks;
  expect(checks.find((check) => check.id === "editor-server")?.status).toBe("ok");
  expect(checks.find((check) => check.id === "install")?.status).toBe("ok");
});

test("no shared link is healthy: both samples go direct", async () => {
  const world = await doctorWorld({ master: null, servers: [READY] });
  const checks = (result(world).result.data as { checks: { detail: string; id: string }[] }).checks;
  expect(checks.find((check) => check.id === "link")?.detail).toContain("No shared SSH link is open");
});

test("doctor validates its target and configuration like the other target commands", async () => {
  const world = await doctorWorld({});
  expect(result(world, "nope").result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
  expect(run(world, ["doctor", "bad;target", "--json"]).exitCode).toBe(4);
  const missing = await makeWorld({}, () => undefined);
  expect(result(missing).result.causeCode).toBe("DOMAIN_CONFIG_MISSING");
  const invalid = await makeWorld({}, () => "{");
  expect(result(invalid).result.causeCode).toBe("SCHEMA_CONFIG_INVALID");
  expect(run(world, ["doctor", "--json"]).exitCode).toBe(2);
});

test("human doctor output lists each step on success and the cause on stderr on failure", async () => {
  const world = await doctorWorld({ servers: [READY] });
  const healthy = run(world, ["doctor", "pilot"]);
  expect(healthy.exitCode).toBe(0);
  for (const step of ["network", "link", "host", "container", "editor-server", "install"]) {
    expect(healthy.stdout).toContain(step);
  }
  const broken = await doctorWorld(scenarioOf((await readFault("link-degraded-20261121.json")).observed));
  const failed = run(broken, ["doctor", "pilot"]);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("Cause link-degraded.");
  expect(failed.stderr).toContain("ssh -O stop mac-mini");
});

test("every doctor station was observed and no undeclared station appeared", async () => {
  const { stationsFor } = await import("../../src/branch-station-catalog.ts");
  const command = "remote-dev.doctor";
  const keys = new Set(stationsFor(command).map((station) => `${command}|${station.outcome}|${station.causeCode}`));
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
