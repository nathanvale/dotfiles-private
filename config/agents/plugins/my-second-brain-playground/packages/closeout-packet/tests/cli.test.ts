// Contract Core 2.0 controls through the shipped public bin. The independent oracle for every machine envelope is the
// owned contract validator in cli-design-check; expected literals are test-owned.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { causeRuleFor, type CauseCode, validateTargetEnvelope } from "../../cli-design-check/src/successor/contract.ts";
import { REPAIR_FINDINGS, RESOLVE_HOLDS, REVIEW_ORIGINALS } from "./fixtures/expected-guidance.ts";
import type { Fault } from "./fixtures/faults.ts";
import { validExpected, validPacket, writeInputs } from "./fixtures/packets.ts";
import { BIN, binEnv, runBin } from "./fixtures/public-bin.ts";

const INPUTS = writeInputs(validPacket(), validExpected());
const CHECK = ["check", "--packet", INPUTS.packet, "--expected", INPUTS.expected];
afterAll(() => rm(INPUTS.dir, { force: true, recursive: true }));
const scratchRoots: string[] = [];

afterEach(async () => {
  const roots = scratchRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  for (const root of roots) expect(existsSync(root)).toBe(false);
});

const SERIALIZER: Fault = { kind: "serializer" };
const STDOUT_THROW: Fault = { kind: "stdout-throw" };
const HUMAN_EMISSION_REPAIR =
  "The check output could not be emitted.\nRepair: Inspect the check output stream before retrying.\n";

function declaredCommands(): string[] {
  const result = runBin(["--discover", "--json"]);
  return JSON.parse(result.stdout).result.data.commands.map((command: { commandIdentity: string }) => command.commandIdentity);
}

/** One machine run whose single stdout envelope must satisfy the owned contract validator. */
function contractEnvelope(args: string[], fault?: Fault, discovery = false) {
  const result = runBin(args, fault);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const envelope = JSON.parse(result.stdout);
  expect(validateTargetEnvelope(envelope, result.exitCode, declaredCommands(), discovery).findings).toEqual([]);
  return { envelope, exitCode: result.exitCode };
}

async function closedStdoutRun(...args: string[]) {
  const root = await mkdtemp("/tmp/closeout-packet-closed-stdout-");
  scratchRoots.push(root);
  const fault: Fault = { kind: "closed-stdout", ready: join(root, "ready"), release: join(root, "release") };
  const child = Bun.spawn([BIN, ...args], { env: binEnv(fault), stderr: "pipe", stdout: "pipe", stdin: "ignore" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const firstRead = reader.read();
  try {
    for (let attempt = 0; attempt < 5_000 && !existsSync(fault.ready); attempt += 1) await Bun.sleep(1);
    await reader.cancel();
    const observed = await firstRead;
    await writeFile(fault.release, "release");
    const [stderrText, exitCode] = await Promise.all([stderr, child.exited]);
    return { exitCode, stderr: stderrText, stdout: observed.done ? "" : new TextDecoder().decode(observed.value) };
  } finally {
    if (!existsSync(fault.release)) await writeFile(fault.release, "release");
    await child.exited;
  }
}

test("machine check emits one contract-valid 2.0 envelope and no stderr", () => {
  const { envelope, exitCode } = contractEnvelope([...CHECK, "--json"]);
  expect(exitCode).toBe(0);
  expect(envelope).toMatchObject({
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    result: { commandIdentity: "closeout-packet.check", effectClass: "inspect", outcome: "success", transactionState: "unchanged" },
  });
});

test("every machine envelope the shipped bin emits satisfies the owned contract", () => {
  const blocked = writeInputs({ ...validPacket(), unresolved: { holds: [{ owner: "coordinator", releaseCondition: "review PASS" }] } }, validExpected());
  scratchRoots.push(blocked.dir);
  const cases: [string[], Fault | undefined, boolean, number][] = [
    [["--help", "--json"], undefined, false, 0],
    [["--discover", "--json"], undefined, true, 0],
    [["--discover-command", "closeout-packet.check", "--json"], undefined, false, 0],
    [[...CHECK, "--json"], undefined, false, 0],
    [["check", "--packet", blocked.packet, "--expected", blocked.expected, "--json"], undefined, false, 0],
    [["--json"], undefined, false, 2],
    [["check", "--packet", join(INPUTS.dir, "absent.json"), "--expected", INPUTS.expected, "--json"], undefined, false, 3],
    [[...CHECK, "--json"], { kind: "read-errno", code: "EMFILE" }, false, 75],
    [[...CHECK, "--json"], SERIALIZER, false, 1],
  ];
  for (const [args, fault, discovery, exit] of cases) expect(contractEnvelope(args, fault, discovery).exitCode).toBe(exit);
});

test("machine check emits the strict internal fallback after serialization fails", () => {
  const { envelope, exitCode } = contractEnvelope([...CHECK, "--json"], SERIALIZER);
  expect(exitCode).toBe(1);
  expect(Object.keys(envelope).sort()).toEqual(["availablePaths", "contractVersion", "envelopeVersion", "message", "result"]);
  expect(envelope).toMatchObject({
    availablePaths: ["closeout-packet.check", "closeout-packet.command-discovery", "closeout-packet.discovery", "closeout-packet.help"],
    message: "The machine result could not be serialized.",
    result: {
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      commandIdentity: "closeout-packet.check",
      data: null,
      effectClass: "inspect",
      effects: { completed: [], inventoryComplete: true, remaining: [], uncertain: [] },
      exitCode: 1,
      failureClass: "internal",
      handoff: {
        inspect: ["The packet and expected-context files named on the command line.", "The closeout-packet runtime and its Bun version."],
        owner: "operator",
        reason: "The check ran but its machine result could not be serialized; no input or state was changed.",
      },
      outcome: "failed",
      repairAction: "Hand the serialization failure to an operator; nothing was changed.",
      retryable: false,
      transactionState: "unchanged",
    },
  });
  expect(Object.keys(envelope.result).sort()).toEqual([
    "causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "handoff", "outcome",
    "repairAction", "retryable", "runId", "transactionState",
  ]);
  expect(envelope.result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("a machine stdout transport failure emits no replacement envelope and keeps stderr empty", () => {
  const result = runBin([...CHECK, "--json"], STDOUT_THROW);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("a machine check whose real stdout reader closes keeps stderr empty and emits no replacement", async () => {
  const result = await closedStdoutRun(...CHECK, "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("human check reports a repair action on stderr after stdout emission fails", () => {
  const result = runBin(CHECK, STDOUT_THROW);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(HUMAN_EMISSION_REPAIR);
});

test("human help names the supported invocation", () => {
  const result = runBin(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("Usage: closeout-packet check --packet PATH --expected PATH [--json]\n");
});

test("selected-command discovery declares only admitted causes with their guidance arms and the state-derived guidance", () => {
  const { envelope } = contractEnvelope(["--discover-command", "closeout-packet.check", "--json"]);
  const stations = envelope.result.data.stations as { causeCode: string; outcome: string; guidance: Record<string, unknown> }[];
  expect(envelope.result.data.command.commandIdentity).toBe("closeout-packet.check");
  expect(stations.map((station) => `${station.causeCode}|${station.outcome}`).sort()).toEqual([
    "DOMAIN_PRECONDITION_UNMET|refused",
    "INTERNAL_RESULT_UNCHANGED|failed",
    "SCHEMA_INVALID_INPUT|refused",
    "SUCCESS_UNCHANGED|success",
    "SUCCESS_UNCHANGED|success",
    "SUCCESS_UNCHANGED|success",
    "TRANSIENT_NOT_STARTED|refused",
  ]);
  for (const station of stations) {
    const rule = causeRuleFor(station.causeCode as CauseCode);
    expect(rule).toBeDefined();
    expect(Object.keys(station.guidance)).toEqual([rule.guidance === "next" ? "nextAction" : "handoff"]);
  }
  expect(
    stations.filter((station) => station.causeCode === "SUCCESS_UNCHANGED").map((station) => station.guidance.nextAction).sort(),
  ).toEqual([REVIEW_ORIGINALS, REPAIR_FINDINGS, RESOLVE_HOLDS].sort());
});

test("missing command is a focused usage refusal", () => {
  const { envelope, exitCode } = contractEnvelope(["--json"]);
  expect(exitCode).toBe(2);
  expect(envelope.result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", outcome: "refused", transactionState: "unchanged" });
});

test("discovery declares every command identity its public results and available paths use", () => {
  const discovered = declaredCommands();
  expect([...discovered].sort()).toEqual([
    "closeout-packet.check",
    "closeout-packet.command-discovery",
    "closeout-packet.discovery",
    "closeout-packet.dispatch",
    "closeout-packet.help",
  ]);
  const observed = [
    runBin(["--help", "--json"]),
    runBin(["--discover", "--json"]),
    runBin(["--discover-command", "closeout-packet.check", "--json"]),
    runBin([...CHECK, "--json"]),
    runBin(["--json"]),
  ].map((result) => JSON.parse(result.stdout));
  expect(observed.map((envelope) => envelope.result.commandIdentity)).toEqual([
    "closeout-packet.help",
    "closeout-packet.discovery",
    "closeout-packet.command-discovery",
    "closeout-packet.check",
    "closeout-packet.dispatch",
  ]);
  for (const envelope of observed)
    for (const identity of [envelope.result.commandIdentity, ...envelope.availablePaths]) expect(discovered).toContain(identity);
});

test("the strict-checker adapter's serializer fault reaches the shipped runtime's internal station", () => {
  const result = Bun.spawnSync([process.execPath, "tests/fixtures/checker-adapter.ts", ...CHECK, "--checker-fault=serializer", "--json"], {
    cwd: join(import.meta.dir, ".."),
    env: binEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
  const envelope = JSON.parse(result.stdout.toString());
  expect(envelope.result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", outcome: "failed", retryable: false, transactionState: "unchanged", handoff: { owner: "operator" } });
  expect("nextAction" in envelope.result).toBe(false);
});

for (const code of ["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]) {
  test(`an input read failing with ${code} is a retryable transient refusal with a bounded delay`, () => {
    const { envelope, exitCode } = contractEnvelope([...CHECK, "--json"], { kind: "read-errno", code });
    expect(exitCode).toBe(75);
    expect(envelope.result).toMatchObject({
      causeCode: "TRANSIENT_NOT_STARTED",
      data: null,
      failureClass: "transient",
      outcome: "refused",
      retryable: true,
      retryDelayMilliseconds: 1000,
      transactionState: "unchanged",
    });
  });
}

for (const code of ["EACCES", "ENOENT"]) {
  test(`an input read failing with ${code} stays a non-retryable domain refusal`, () => {
    const { envelope, exitCode } = contractEnvelope([...CHECK, "--json"], { kind: "read-errno", code });
    expect(exitCode).toBe(3);
    expect(envelope.result).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", retryable: false });
    expect("retryDelayMilliseconds" in envelope.result).toBe(false);
  });
}
