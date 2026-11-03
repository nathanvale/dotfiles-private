import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validExpected, validPacket, writeInputs } from "./fixtures/packets.ts";

const ROOT = resolve(import.meta.dir, "..");
const INPUTS = writeInputs(validPacket(), validExpected());
const CHECK = ["check", "--packet", INPUTS.packet, "--expected", INPUTS.expected];
afterAll(() => rm(INPUTS.dir, { force: true, recursive: true }));
const scratchRoots: string[] = [];

function invokeProcess(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function invoke(...args: string[]) {
  return invokeProcess([process.execPath, "run", "src/cli.ts", ...args]);
}

function invokeWithPreload(preload: string, ...args: string[]) {
  return invokeProcess([
    process.execPath,
    "run",
    "--preload",
    preload,
    "src/cli.ts",
    ...args,
  ]);
}

async function serializerFailurePreload(): Promise<string> {
  const root = await mkdtemp("/tmp/simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "serializer-failure.ts");
  await writeFile(
    preload,
    `const stringify = JSON.stringify;
JSON.stringify = (...args) => {
  const [value] = args;
  if (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    typeof value.result === "object" &&
    value.result !== null &&
    "outcome" in value.result &&
    value.result.outcome === "success"
  ) {
    JSON.stringify = stringify;
    throw new Error("fixture serializer failure");
  }
  return stringify(...args);
};
`,
  );
  return preload;
}

async function outputFailurePreload(): Promise<string> {
  const root = await mkdtemp("/tmp/simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "output-failure.ts");
  await writeFile(
    preload,
    `const write = process.stdout.write.bind(process.stdout);
let failed = false;
process.stdout.write = (chunk, ...args) => {
  if (!failed) {
    failed = true;
    throw new Error("fixture stdout failure");
  }
  return write(chunk, ...args);
};
`,
  );
  return preload;
}

type ClosedStdoutPreload = {
  preload: string;
  ready: string;
  release: string;
};

async function closedStdoutPreload(): Promise<ClosedStdoutPreload> {
  const root = await mkdtemp("/tmp/simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "closed-stdout.ts");
  const ready = join(root, "ready");
  const release = join(root, "release");
  await writeFile(
    preload,
    `import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const readyPath = ${JSON.stringify(ready)};
const releasePath = ${JSON.stringify(release)};
await writeFile(readyPath, "ready");
while (!existsSync(releasePath)) await Bun.sleep(1);
`,
  );
  return { preload, ready, release };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function invokeWithClosedStdoutReader(
  fixture: ClosedStdoutPreload,
  ...args: string[]
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--preload",
      fixture.preload,
      "src/cli.ts",
      ...args,
    ],
    {
      cwd: ROOT,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const stdoutReader = child.stdout.getReader();
  const stdoutRead = stdoutReader.read();
  try {
    await waitForFile(fixture.ready);
    await stdoutReader.cancel();
    const stdoutResult = await stdoutRead;
    await writeFile(fixture.release, "release");
    const [stderrText, exitCode] = await Promise.all([stderr, child.exited]);
    return {
      exitCode,
      stderr: stderrText,
      stdout: stdoutResult.done
        ? ""
        : new TextDecoder().decode(stdoutResult.value),
    };
  } finally {
    if (!existsSync(fixture.release)) {
      await writeFile(fixture.release, "release");
    }
    await stdoutReader.cancel();
    await child.exited;
  }
}

afterEach(async () => {
  const roots = scratchRoots.splice(0);
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true })),
  );
  for (const root of roots) expect(existsSync(root)).toBe(false);
});

test("machine check emits one 2.0 envelope and no stderr", () => {
  const result = invoke(...CHECK, "--json");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    result: {
      commandIdentity: "closeout-packet.check",
      effectClass: "inspect",
      outcome: "success",
      transactionState: "unchanged",
    },
  });
});

test("machine check emits a strict internal fallback after serialization fails", async () => {
  const result = invokeWithPreload(
    await serializerFailurePreload(),
    ...CHECK,
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const envelope = JSON.parse(result.stdout);
  expect(Object.keys(envelope).sort()).toEqual([
    "availablePaths",
    "contractVersion",
    "envelopeVersion",
    "message",
    "result",
  ]);
  expect(envelope).toMatchObject({
    availablePaths: [
      "closeout-packet.check",
      "closeout-packet.command-discovery",
      "closeout-packet.discovery",
      "closeout-packet.help",
    ],
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    message: "The machine result could not be serialized.",
    result: {
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      commandIdentity: "closeout-packet.check",
      data: null,
      effectClass: "inspect",
      effects: {
        completed: [],
        inventoryComplete: true,
        remaining: [],
        uncertain: [],
      },
      exitCode: 1,
      failureClass: "internal",
      handoff: {
        inspect: [
          "The packet and expected-context files named on the command line.",
          "The closeout-packet runtime and its Bun version.",
        ],
        owner: "operator",
        reason:
          "The check ran but its machine result could not be serialized; no input or state was changed.",
      },
      outcome: "failed",
      repairAction:
        "Hand the serialization failure to an operator; nothing was changed.",
      retryable: false,
      transactionState: "unchanged",
    },
  });
  expect(Object.keys(envelope.result).sort()).toEqual([
    "causeCode",
    "commandIdentity",
    "data",
    "effectClass",
    "effects",
    "exitCode",
    "failureClass",
    "handoff",
    "outcome",
    "repairAction",
    "retryable",
    "runId",
    "transactionState",
  ]);
  expect(envelope.result.runId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("machine check emits a distinct internal fallback after stdout emission fails", async () => {
  const result = invokeWithPreload(
    await outputFailurePreload(),
    ...CHECK,
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    message: "The check output could not be emitted.",
    result: {
      causeCode: "INTERNAL_RESULT_EMISSION",
      nextAction: "Inspect the check output and retry closeout-packet check.",
      outcome: "failed",
      repairAction: "Inspect the check output stream before retrying.",
    },
  });
});

test("machine check reports repair guidance after a real stdout reader closes", async () => {
  const result = await invokeWithClosedStdoutReader(
    await closedStdoutPreload(),
    ...CHECK,
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "The check output could not be emitted.\n" +
      "Repair: Inspect the check output stream before retrying.\n",
  );
  expect(result.stderr).not.toContain("EPIPE");
  expect(result.stderr).not.toContain("Bun v");
});

test("human check reports a repair action after stdout emission fails", async () => {
  const result = invokeWithPreload(await outputFailurePreload(), ...CHECK);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "The check output could not be emitted.\n" +
      "Repair: Inspect the check output stream before retrying.\n",
  );
});

test("human help names the supported invocation", () => {
  const result = invoke("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("Usage: closeout-packet check --packet PATH --expected PATH [--json]\n");
});

test("selected-command discovery describes the check stations", () => {
  const result = invoke("--discover-command", "closeout-packet.check", "--json");
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result.data.command.commandIdentity).toBe("closeout-packet.check");
  expect(
    envelope.result.data.stations
      .map((station: { causeCode: string; outcome: string }) =>
        [station.causeCode, station.outcome].join("|"),
      )
      .sort(),
  ).toEqual([
    "DOMAIN_PRECONDITION_UNMET|refused",
    "INTERNAL_RESULT_EMISSION|failed",
    "INTERNAL_RESULT_UNCHANGED|failed",
    "SCHEMA_INVALID_INPUT|refused",
    "SUCCESS_UNCHANGED|success",
    "TRANSIENT_NOT_STARTED|refused",
  ]);
  expect(
    envelope.result.data.stations.find(
      (station: { causeCode: string }) =>
        station.causeCode === "INTERNAL_RESULT_EMISSION",
    ),
  ).toMatchObject({
    guidance: {
      nextAction: "Inspect the check output and retry closeout-packet check.",
    },
    repairAction: "Inspect the check output stream before retrying.",
    trigger: "The check output cannot be emitted.",
  });
});

test("missing command is a focused usage refusal", () => {
  const result = invoke("--json");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    result: {
      causeCode: "USAGE_INVALID_INVOCATION",
      outcome: "refused",
      transactionState: "unchanged",
    },
  });
});

test("discovery declares every command identity its public results and available paths use", () => {
  const discovered = JSON.parse(invoke("--discover", "--json").stdout).result.data.commands.map(
    (command: { commandIdentity: string }) => command.commandIdentity,
  );
  expect([...discovered].sort()).toEqual([
    "closeout-packet.check",
    "closeout-packet.command-discovery",
    "closeout-packet.discovery",
    "closeout-packet.dispatch",
    "closeout-packet.help",
  ]);
  const observed = [
    invoke("--help", "--json"),
    invoke("--discover", "--json"),
    invoke("--discover-command", "closeout-packet.check", "--json"),
    invoke(...CHECK, "--json"),
    invoke("--json"),
  ].map((result) => JSON.parse(result.stdout));
  expect(observed.map((envelope) => envelope.result.commandIdentity)).toEqual([
    "closeout-packet.help",
    "closeout-packet.discovery",
    "closeout-packet.command-discovery",
    "closeout-packet.check",
    "closeout-packet.dispatch",
  ]);
  for (const envelope of observed) {
    for (const identity of [envelope.result.commandIdentity, ...envelope.availablePaths]) {
      expect(discovered).toContain(identity);
    }
  }
});

test("the checker adapter's serializer fault reaches the real internal station", () => {
  const result = invokeProcess([process.execPath, "tests/fixtures/checker-adapter.ts", ...CHECK, "--checker-fault=serializer", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", outcome: "failed", retryable: false, transactionState: "unchanged", handoff: { owner: "operator" } });
  expect("nextAction" in JSON.parse(result.stdout).result).toBe(false);
});

for (const code of ["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]) {
  test(`an input read failing with ${code} is a retryable transient refusal with a bounded delay`, () => {
    const result = invokeProcess([process.execPath, "tests/fixtures/checker-adapter.ts", ...CHECK, `--checker-fault=read-errno:${code}`, "--json"]);
    expect(result.exitCode).toBe(75);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
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
    const result = invokeProcess([process.execPath, "tests/fixtures/checker-adapter.ts", ...CHECK, `--checker-fault=read-errno:${code}`, "--json"]);
    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", retryable: false });
    expect("retryDelayMilliseconds" in envelope.result).toBe(false);
  });
}
