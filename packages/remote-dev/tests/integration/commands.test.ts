import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertNoLifecycleCommands,
  calls,
  cleanupWorlds,
  DEVBOX_ID,
  envelopeOf,
  INFRA_ID,
  makeWorld,
  observeOutput,
  observedStations,
  PACKAGE_ROOT,
  PILOT_ID,
  PS,
  psOutput,
  run,
  runPty,
} from "../support/harness.ts";

afterEach(cleanupWorlds);

// Independent oracles copied from the reviewed desktop-entry proposal.
const AUTHORITY =
  "attached-container%2B7b22636f6e7461696e65724e616d65223a222f7368657068657264722d70696c6f742d6d61696e2d3230323631313132222c2273657474696e6773223a7b22686f7374223a22756e69783a2f2f2f55736572732f7365727665722f2e6f7262737461636b2f72756e2f646f636b65722e736f636b227d7d@ssh-remote%2Bmac-mini";
const INVENTORY_SSH_ARGV = [
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ForwardAgent=no",
  "-o", "ClearAllForwardings=yes",
  "--",
  "mac-mini",
  "'/opt/homebrew/bin/docker' '--host' 'unix:///Users/server/.orbstack/run/docker.sock' 'ps' '--all' '--no-trunc' '--format' '{{.ID}} {{.Names}} {{.State}}'",
];


// Independent oracle: each product condition, the Contract Core cause it sits under, and its exact message.
const REASON = {
  DOMAIN_CONFIG_MISSING: ["DOMAIN_CONFIG_MISSING", "No remote-dev targets file was found. Nothing was inspected."],
  DOMAIN_ACTION_UNCONFIGURED: ["DOMAIN_PRECONDITION_UNMET", "That action is not configured for this target. Nothing was launched."],
  DOMAIN_EDITOR_PROFILE_MISSING: ["DOMAIN_AUTHORITY_REQUIRED", "The isolated VS Code environment is missing, so nothing was opened."],
  DOMAIN_HOST_COMMAND_FAILED: ["INTERNAL_RESULT_UNCHANGED", "The remote inspection command failed. Nothing was started."],
  DOMAIN_TARGET_MISSING: ["DOMAIN_AUTHORITY_REQUIRED", "The target's container was not found. Nothing was started."],
  DOMAIN_TARGET_REPLACED: ["DOMAIN_AUTHORITY_REQUIRED", "The target's container was replaced (identity changed). Nothing was opened."],
  DOMAIN_TARGET_STOPPED: ["DOMAIN_AUTHORITY_REQUIRED", "The target is stopped. Nothing was started."],
  DOMAIN_TARGET_UNKNOWN: ["DOMAIN_PRECONDITION_UNMET", "That is not a configured development target. Nothing was launched."],
  DOMAIN_TOOL_UNAVAILABLE: ["DOMAIN_PRECONDITION_UNMET", "A required local tool is unavailable. Nothing was launched."],
  INTERNAL_LAUNCH_UNCONFIRMED: ["INTERNAL_RESULT_UNKNOWN", "The launcher exited unsuccessfully; a window may or may not have opened."],
  SCHEMA_INVALID_CONFIG: ["SCHEMA_CONFIG_INVALID", "The remote-dev targets file is invalid. Nothing was inspected."],
  TRANSIENT_HOST_UNREACHABLE: ["TRANSIENT_ATTEMPT_UNCHANGED", "The host could not be reached. Nothing was inspected or started."],
} as const;

function reasonOf(envelope: { message: string; result: { causeCode: string } }): readonly [string, string] {
  return [envelope.result.causeCode, envelope.message];
}

const RUNNING = psOutput(PS.pilotRunning, PS.devboxStopped, PS.infra);

test("human help names every public command, option, and the explicit start boundary", async () => {
  const world = await makeWorld({});
  const help = run(world, ["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stderr).toBe("");
  for (const fragment of ["choose", "list [--all]", "open TARGET", "start TARGET", "logs TARGET", "board TARGET", "--lines N", "--json", "Other actions never start containers.", "No command creates, restarts"]) {
    expect(help.stdout).toContain(fragment);
  }
  const noArgs = run(world, []);
  expect(noArgs).toMatchObject({ exitCode: 0, stderr: "", stdout: help.stdout });
  const machine = envelopeOf(run(world, ["--json"]));
  expect(machine.result).toMatchObject({ causeCode: "SUCCESS_UNCHANGED", commandIdentity: "remote-dev.help" });
  expect((machine.result.data as { options: unknown }).options).toEqual([
    { name: "--all", value: null },
    { name: "--json", value: null },
    { name: "--lines", value: "N" },
  ]);
  expect(await calls(world)).toEqual([]);
});

test("discovery reports the profile, exits, and the explicit effect exclusions", async () => {
  const world = await makeWorld({});
  const output = run(world, ["--discover", "--json"]);
  expect(output.exitCode).toBe(0);
  const data = envelopeOf(output).result.data as Record<string, unknown>;
  expect(data.profile).toBe("complex");
  expect(data.exitMeanings).toEqual({ "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" });
  expect((data.commands as { commandIdentity: string; effectClass: string }[]).map((c) => `${c.commandIdentity}:${c.effectClass}`)).toEqual([
    "remote-dev.help:inspect",
    "remote-dev.discovery:inspect",
    "remote-dev.command-discovery:inspect",
    "remote-dev.dispatch:inspect",
    "remote-dev.list:inspect",
    "remote-dev.open:external",
    "remote-dev.start:external",
    "remote-dev.logs:inspect",
    "remote-dev.board:external",
    "remote-dev.choose:external",
  ]);
  expect(data.effectExclusions).toEqual([
    "Only start and the chooser start action may start an opted-in exact existing container; other actions never start containers.",
    "No command creates, restarts, rebuilds, replaces, stops, removes, or prunes containers or services.",
    "External effects are starting an opted-in existing container and opening VS Code or a browser window; diagnostics are not domain effects.",
  ]);
  const start = run(world, ["--discover-command", "remote-dev.start", "--json"]);
  expect(start.exitCode).toBe(0);
  expect(envelopeOf(start).result.data).toMatchObject({ command: { commandIdentity: "remote-dev.start", effectClass: "external", route: ["start"] } });
  const unknown = run(world, ["--discover-command", "remote-dev.restart", "--json"]);
  expect(unknown.exitCode).toBe(2);
  expect(envelopeOf(unknown).result.causeCode).toBe("USAGE_INVALID_INVOCATION");
});

test("list shows known targets first with host, identity, role, and state kept separate", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const output = run(world, ["list", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
  const data = envelopeOf(output).result.data as { rows: Record<string, unknown>[]; view: string };
  expect(data.view).toBe("known");
  expect(data.rows.map((row) => [row.host, row.target, row.container, row.containerId, row.role, row.state, row.eligible])).toEqual([
    ["mini", "pilot", "shepherdr-pilot-main-20261112", PILOT_ID, "ui-pilot", "running", true],
    ["mini", "devbox", "devbox-1", DEVBOX_ID, "development", "stopped", false],
  ]);
  expect(data.rows[0]?.actions).toEqual([
    { available: true, id: "open", label: "Open VS Code", reason: null },
    { available: true, id: "logs", label: "Read service log", reason: null },
    { available: true, id: "board", label: "Open task board", reason: null },
  ]);
  const ssh = await calls(world, "ssh");
  expect(ssh.map((call) => call.argv)).toEqual([INVENTORY_SSH_ARGV]);
  expect(ssh[0]?.sshAuthSock).toBe("");
  await assertNoLifecycleCommands(world);
});

test("list --all appends unclassified containers as inspect-only rows", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const output = run(world, ["list", "--all", "--json"]);
  const rows = (envelopeOf(output).result.data as { rows: Record<string, unknown>[] }).rows;
  expect(rows.map((row) => `${row.target}|${row.container}|${row.role}|${row.state}|${row.eligible}`)).toEqual([
    "pilot|shepherdr-pilot-main-20261112|ui-pilot|running|true",
    "devbox|devbox-1|development|stopped|false",
    `null|orb-infra|unclassified|running|false`,
  ]);
  expect(rows[2]?.actions).toEqual([]);
  expect(rows[2]?.containerId).toBe(INFRA_ID);
});

test("human list prints a table and never claims coordinator readiness", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const output = run(world, ["list"]);
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toContain("HOST  TARGET  ROLE         STATE    CONTAINER");
  expect(output.stdout).toContain("mini  pilot   ui-pilot     running  shepherdr-pilot-main-20261112 (3b6ad4e9ef16)");
  expect(output.stdout).toContain("devbox: Container is stopped and stays stopped");
  expect(output.stdout.toLowerCase()).not.toContain("coordinator");
});

test("unsafe container names and control sequences are dropped, never rendered or executed", async () => {
  const world = await makeWorld({
    ssh: {
      ps: [psOutput(PS.pilotRunning, `${INFRA_ID} $(touch${" "}pwned) running`, `${DEVBOX_ID} evil\u001b]0;title\u0007 running`)],
    },
  });
  const output = run(world, ["list", "--all", "--json"]);
  expect(output.exitCode).toBe(0);
  const data = envelopeOf(output).result.data as { rejectedRows: number; rows: { container: string }[] };
  expect(data.rejectedRows).toBe(2);
  expect(data.rows.map((row) => row.container)).toEqual(["shepherdr-pilot-main-20261112", "devbox-1"]);
  expect(output.stdout).not.toContain("\u001b");
  expect(await Bun.file(join(world.dir, "pwned")).exists()).toBe(false);
  const human = run(world, ["list", "--all"]);
  expect(human.stdout).not.toContain("\u001b");
  expect(human.stdout).not.toContain("touch");
});

test("an empty inventory lists no rows and launches nothing", async () => {
  const world = await makeWorld({ ssh: { ps: [""] } }, (config) => ({ ...config, targets: [] }));
  const output = run(world, ["list", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(envelopeOf(output).message).toBe("No development targets found. Nothing was started.");
  expect((envelopeOf(output).result.data as { rows: unknown[] }).rows).toEqual([]);
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh"]);
});

test("an unreachable host is a bounded transient failure with nothing started", async () => {
  const world = await makeWorld({ ssh: { exit: 255 } });
  const output = run(world, ["list", "--json"]);
  expect(output.exitCode).toBe(75);
  expect(output.stderr).toBe("");
  expect(envelopeOf(output).result).toMatchObject({
    causeCode: "TRANSIENT_ATTEMPT_UNCHANGED",
    data: null,
    outcome: "failed",
    retryable: true,
    retryDelayMilliseconds: 5000,
    transactionState: "unchanged",
  });
  const human = run(world, ["open", "pilot"]);
  expect(human.exitCode).toBe(75);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("could not be reached");
  expect(await calls(world, "code")).toEqual([]);
});

test("a failing remote inspection command is reported, not retried or repaired", async () => {
  const world = await makeWorld({ ssh: { exit: 1 } });
  const output = run(world, ["list", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(reasonOf(envelopeOf(output))).toEqual(REASON.DOMAIN_HOST_COMMAND_FAILED);
  expect(envelopeOf(output).result).toMatchObject({ outcome: "failed", retryable: false, transactionState: "unchanged" });
  expect(await calls(world, "ssh")).toHaveLength(1);
});

test("missing and invalid configuration refuse before any remote call", async () => {
  const missing = await makeWorld({}, () => undefined);
  const absent = run(missing, ["list", "--json"]);
  expect(absent.exitCode).toBe(3);
  expect(envelopeOf(absent).result.causeCode).toBe("DOMAIN_CONFIG_MISSING");

  const tokenBoard = await makeWorld({}, (config) => {
    (config.targets[0] as Record<string, unknown>).board = "https://board.example.test/?token=abc";
    return config;
  });
  const invalid = run(tokenBoard, ["list", "--json"]);
  expect(invalid.exitCode).toBe(4);
  expect(reasonOf(envelopeOf(invalid))).toEqual(REASON.SCHEMA_INVALID_CONFIG);
  expect(invalid.stdout).not.toContain("abc");

  const broken = await makeWorld({}, () => "{not json");
  expect(run(broken, ["open", "pilot", "--json"]).exitCode).toBe(4);
  expect([...(await calls(missing)), ...(await calls(tokenBoard)), ...(await calls(broken))]).toEqual([]);
});

test("open rechecks the pilot, then launches the isolated editor with the guide", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const output = run(world, ["open", "pilot", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
  expect(envelopeOf(output).result).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
    effects: { completed: ["editor-window:pilot"], inventoryComplete: true, remaining: [], uncertain: [] },
    transactionState: "completed",
  });
  const code = await calls(world, "code");
  expect(code.map((call) => call.argv)).toEqual([
    [
      "--user-data-dir", join(world.dir, "isolated", "user-data"),
      "--extensions-dir", join(world.dir, "isolated", "extensions"),
      "--new-window",
      "--folder-uri", `vscode-remote://${AUTHORITY}/workspace`,
      "--file-uri", `vscode-remote://${AUTHORITY}/workspace/START-HERE.md`,
    ],
  ]);
  expect(code[0]?.sshAuthSock).toBe("");
  expect(code[0]?.vscodeIpcHook).toBeNull();
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "code"]);
  await assertNoLifecycleCommands(world);
});

test("a local workspace file cannot redirect open away from the verified target", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } }, (config) => {
    (config.targets[0] as Record<string, unknown>).workspaceFile = "~/isolated/Unrelated.code-workspace";
    return config;
  });
  await Bun.write(join(world.dir, "isolated", "Unrelated.code-workspace"), "{}");
  const output = run(world, ["open", "pilot", "--json"]);
  expect(output.exitCode).toBe(4);
  expect(reasonOf(envelopeOf(output))).toEqual(REASON.SCHEMA_INVALID_CONFIG);
  expect(await calls(world)).toEqual([]);
});

test.each([
  ["stopped", psOutput(PS.pilotStopped), "DOMAIN_TARGET_STOPPED"],
  ["replaced", psOutput(PS.pilotReplaced), "DOMAIN_TARGET_REPLACED"],
  ["missing", psOutput(PS.infra), "DOMAIN_TARGET_MISSING"],
] as const)("open refuses a %s pilot and launches nothing", async (_name, ps, cause) => {
  const world = await makeWorld({ ssh: { ps: [ps] } });
  const output = run(world, ["open", "pilot", "--json"]);
  expect(output.exitCode).toBe(3);
  expect(reasonOf(envelopeOf(output))).toEqual(REASON[cause]);
  expect(envelopeOf(output).result).toMatchObject({ outcome: "refused", transactionState: "unchanged" });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh"]);
  await assertNoLifecycleCommands(world);
});

test("open refuses unknown targets and rejects unsafe target text before any remote call", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const unknown = run(world, ["open", "orb-infra", "--json"]);
  expect(unknown.exitCode).toBe(3);
  expect(reasonOf(envelopeOf(unknown))).toEqual(REASON.DOMAIN_TARGET_UNKNOWN);
  const unsafe = run(world, ["open", "pilot;touch x", "--json"]);
  expect(unsafe.exitCode).toBe(4);
  expect(envelopeOf(unsafe).result.causeCode).toBe("SCHEMA_INVALID_INPUT");
  expect(await calls(world)).toEqual([]);
});

test("open refuses when the isolated profile is missing instead of using a fresh profile", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  await rm(join(world.dir, "isolated", "user-data"), { recursive: true });
  const output = run(world, ["open", "pilot", "--json"]);
  expect(output.exitCode).toBe(3);
  expect(reasonOf(envelopeOf(output))).toEqual(REASON.DOMAIN_EDITOR_PROFILE_MISSING);
  await Bun.write(join(world.dir, "isolated", "user-data"), "not a directory");
  expect(reasonOf(envelopeOf(run(world, ["open", "pilot", "--json"])))).toEqual(REASON.DOMAIN_EDITOR_PROFILE_MISSING);
  expect(await calls(world, "code")).toEqual([]);
});

test("an unsuccessful editor launcher is reported as unconfirmed, not success", async () => {
  const world = await makeWorld({ code: { exit: 1 }, ssh: { ps: [RUNNING] } });
  const output = run(world, ["open", "pilot", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(envelopeOf(output).result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    effects: { completed: [], uncertain: ["editor-window:pilot"] },
    retryable: false,
    transactionState: "unknown",
  });
  expect(await calls(world, "code")).toHaveLength(1);
});

test("a missing editor or ssh executable refuses without a launch", async () => {
  const noCode = await makeWorld({ ssh: { ps: [RUNNING] } }, (config) => {
    config.tools.code = join(config.editor.userDataDir, "no-such-code");
    return config;
  });
  expect(reasonOf(envelopeOf(run(noCode, ["open", "pilot", "--json"])))).toEqual(REASON.DOMAIN_TOOL_UNAVAILABLE);
  const noSsh = await makeWorld({}, (config) => {
    config.tools.ssh = "/nonexistent/ssh";
    return config;
  });
  const output = run(noSsh, ["list", "--json"]);
  expect(output.exitCode).toBe(3);
  expect(reasonOf(envelopeOf(output))).toEqual(REASON.DOMAIN_TOOL_UNAVAILABLE);
});

test("logs reads the native service log by container ID and redacts secrets and control sequences", async () => {
  const log = [
    "service started on :8080",
    "auth token=abc123456789secret",
    "callback https://board.example.test/cb?code=xyz&state=1",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
    "Cookie: a=first; sid=secondCredentialValue",
    "Set-Cookie: sid=secondCredentialValue; Path=/; HttpOnly",
    '{"cookie": "a=first; sid=secondCredentialValue"}',
    "remote https://user:hunter2@example.test/repo.git",
    "\u001b[31mred\u001b[0m and \u001b]0;title\u0007 done",
    "",
  ].join("\n");
  const world = await makeWorld({ ssh: { logs: log, ps: [RUNNING] } });
  const output = run(world, ["logs", "pilot", "--lines", "50", "--json"]);
  expect(output.exitCode).toBe(0);
  const human = run(world, ["logs", "pilot"]);
  expect(human.stdout).toContain("native service log (secrets redacted)");
  const leaks = ["hunter2", "secondCredentialValue"].flatMap((secret) =>
    [
      ["human", human.stdout],
      ["json", output.stdout],
    ]
      .filter(([, stream]) => stream?.includes(secret))
      .map(([name]) => `${name}:${secret}`),
  );
  expect(leaks).toEqual([]);
  const data = envelopeOf(output).result.data as Record<string, unknown>;
  expect(data.source).toBe("native-service-log");
  expect(data.text).toBe(
    [
      "service started on :8080",
      "auth token=[REDACTED]",
      "callback https://board.example.test/cb?[REDACTED]",
      "Authorization: [REDACTED]",
      "Cookie: [REDACTED]",
      "Set-Cookie: [REDACTED]",
      '{"cookie": [REDACTED]',
      "remote https://[REDACTED]@example.test/repo.git",
      "red and  done",
      "",
    ].join("\n"),
  );
  const tail = (lines: number) =>
    `'/opt/homebrew/bin/docker' '--host' 'unix:///Users/server/.orbstack/run/docker.sock' 'exec' '${PILOT_ID}' 'tail' '-n' '${lines}' '/home/agent/.local/state/pilot-runtime/main-d57a0261/service.log'`;
  const ssh = await calls(world, "ssh");
  expect(ssh.map((call) => call.argv.at(-1))).toEqual([
    INVENTORY_SSH_ARGV.at(-1),
    tail(50),
    INVENTORY_SSH_ARGV.at(-1),
    tail(200),
  ]);
  await assertNoLifecycleCommands(world);
});

test("logs and board explain unconfigured resources and reject bad line counts", async () => {
  const world = await makeWorld({ ssh: { ps: [psOutput(PS.pilotRunning, PS.devboxRunning)] } });
  const logs = run(world, ["logs", "devbox", "--json"]);
  expect(logs.exitCode).toBe(3);
  expect(reasonOf(envelopeOf(logs))).toEqual(REASON.DOMAIN_ACTION_UNCONFIGURED);
  const board = run(world, ["board", "devbox", "--json"]);
  expect(reasonOf(envelopeOf(board))).toEqual(REASON.DOMAIN_ACTION_UNCONFIGURED);
  const lines = run(world, ["logs", "pilot", "--lines", "0", "--json"]);
  expect(lines.exitCode).toBe(4);
  expect(envelopeOf(lines).result.causeCode).toBe("SCHEMA_INVALID_INPUT");
  expect(await calls(world, "opener")).toEqual([]);
});

test.each([
  ["stopped", psOutput(PS.pilotStopped), "DOMAIN_TARGET_STOPPED"],
  ["replaced", psOutput(PS.pilotReplaced), "DOMAIN_TARGET_REPLACED"],
  ["missing", "", "DOMAIN_TARGET_MISSING"],
] as const)("logs and board refuse a %s pilot", async (_name, ps, cause) => {
  const world = await makeWorld({ ssh: { ps: [ps] } });
  for (const command of ["logs", "board"]) {
    const output = run(world, [command, "pilot", "--json"]);
    expect(output.exitCode).toBe(3);
    expect(reasonOf(envelopeOf(output))).toEqual(REASON[cause]);
  }
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "ssh"]);
});

test("logs, board, and their sources report unknown, unsafe, and failing inputs", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  for (const command of ["logs", "board"]) {
    expect(reasonOf(envelopeOf(run(world, [command, "nope", "--json"])))).toEqual(REASON.DOMAIN_TARGET_UNKNOWN);
    expect(envelopeOf(run(world, [command, "../x", "--json"])).result.causeCode).toBe("SCHEMA_INVALID_INPUT");
  }
  const down = await makeWorld({ ssh: { exit: 255 } });
  const failing = await makeWorld({ ssh: { exit: 2 } });
  const unconfigured = await makeWorld({}, () => undefined);
  const invalid = await makeWorld({}, () => "[]");
  const noSsh = await makeWorld({}, (config) => {
    config.tools.ssh = "/nonexistent/ssh";
    return config;
  });
  const expected = [
    [down, "TRANSIENT_HOST_UNREACHABLE"],
    [failing, "DOMAIN_HOST_COMMAND_FAILED"],
    [unconfigured, "DOMAIN_CONFIG_MISSING"],
    [invalid, "SCHEMA_INVALID_CONFIG"],
    [noSsh, "DOMAIN_TOOL_UNAVAILABLE"],
  ] as const;
  for (const [source, cause] of expected) {
    for (const command of ["logs", "board", "open"]) {
      expect(reasonOf(envelopeOf(run(source, [command, "pilot", "--json"])))).toEqual(REASON[cause]);
    }
  }
});

test("board opens only the configured https board through the opener", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const output = run(world, ["board", "pilot", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(envelopeOf(output).result).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
    effects: { completed: ["browser-window:pilot"] },
  });
  expect((await calls(world, "opener")).map((call) => call.argv)).toEqual([["https://board.example.test/shepherdr/"]]);
  const failing = await makeWorld({ opener: { exit: 1 }, ssh: { ps: [RUNNING] } });
  expect(reasonOf(envelopeOf(run(failing, ["board", "pilot", "--json"])))).toEqual(REASON.INTERNAL_LAUNCH_UNCONFIRMED);
  const missing = await makeWorld({ ssh: { ps: [RUNNING] } }, (config) => {
    config.tools.opener = "/nonexistent/open";
    return config;
  });
  expect(reasonOf(envelopeOf(run(missing, ["board", "pilot", "--json"])))).toEqual(REASON.DOMAIN_TOOL_UNAVAILABLE);
});

test("non-TTY invocation refuses the chooser immediately even with stdin held open", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  for (const args of [["choose"], ["choose", "--json"]]) {
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, "../.."),
      env: world.env,
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    });
    const started = performance.now();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    child.stdin.end();
    observeOutput(stdout);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(exitCode).toBe(2);
    expect(`${stdout}${stderr}`).toContain("needs an interactive terminal");
  }
  expect(await calls(world)).toEqual([]);
});

test("unknown commands and extra arguments are usage refusals", async () => {
  const world = await makeWorld({});
  for (const args of [["restart", "pilot"], ["list", "extra"], ["open"], ["start"], ["start", "pilot", "extra"], ["open", "pilot", "extra"], ["choose", "x"]]) {
    const output = run(world, [...args, "--json"]);
    expect(output.exitCode).toBe(2);
    expect(envelopeOf(output).result.causeCode).toBe("USAGE_INVALID_INVOCATION");
  }
  expect(await calls(world)).toEqual([]);
});

function lastEnvelope(output: string) {
  const line = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);
  if (line === undefined) throw new Error(`no envelope in: ${output}`);
  return JSON.parse(line) as { message: string; result: Record<string, unknown> & { causeCode: string } };
}

const PILOT_ROW = "\tmini\tpilot\t";

test("chooser: type-to-select the pilot, choose Open VS Code, and dispatch through the shared recheck", async () => {
  const world = await makeWorld({
    fzf: { picks: [{ match: PILOT_ROW }, { match: "open\t" }] },
    ssh: { ps: [RUNNING] },
  });
  const { exitCode, output } = await runPty(world, ["choose", "--json"]);
  expect(exitCode).toBe(0);
  expect(lastEnvelope(output).result).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
    commandIdentity: "remote-dev.choose",
    effects: { completed: ["editor-window:pilot"] },
  });
  const fzf = await calls(world, "fzf");
  expect(fzf[0]?.stdin.split("\n").filter((line) => line !== "").map((line) => line.split("\t").slice(1, 5).join("|"))).toEqual([
    "mini|pilot|ui-pilot|running",
    "mini|devbox|development|stopped",
  ]);
  expect(fzf[0]?.argv).toContain("Type to filter · ↑/↓ move · Enter choose · Esc cancel · Ctrl-A known/all containers");
  expect(fzf[1]?.stdin).toBe("open\tOpen VS Code\nlogs\tRead service log\nboard\tOpen task board\n");
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "fzf", "fzf", "ssh", "code"]);
  await assertNoLifecycleCommands(world);
});

test.each([
  ["the target list", [{ exit: 130 }], ["ssh", "fzf"]],
  ["the action menu", [{ match: PILOT_ROW }, { exit: 130 }], ["ssh", "fzf", "fzf"]],
] as const)("chooser: Escape in %s cancels with nothing launched", async (_where, picks, tools) => {
  const world = await makeWorld({ fzf: { picks: [...picks] }, ssh: { ps: [RUNNING] } });
  const json = await runPty(world, ["choose", "--json"]);
  expect(json.exitCode).toBe(0);
  expect(lastEnvelope(json.output)).toMatchObject({
    message: "Cancelled. Nothing was launched or started.",
    result: { causeCode: "SUCCESS_UNCHANGED", transactionState: "unchanged" },
  });
  expect((await calls(world)).map((call) => call.tool)).toEqual([...tools]);
});

test("chooser: human cancellation explains that nothing happened", async () => {
  const world = await makeWorld({ fzf: { picks: [{ exit: 130 }] }, ssh: { ps: [RUNNING] } });
  const { exitCode, output } = await runPty(world, ["choose"]);
  expect(exitCode).toBe(0);
  expect(output).toContain("Cancelled. Nothing was launched or started.");
});

test("chooser: a stopped target is explained and stays stopped", async () => {
  const world = await makeWorld({ fzf: { picks: [{ match: "\tdevbox\t" }] }, ssh: { ps: [RUNNING] } });
  const { exitCode, output } = await runPty(world, ["choose", "--json"]);
  expect(exitCode).toBe(3);
  expect(lastEnvelope(output)).toMatchObject({
    message: "The target is stopped. Nothing was started.",
    result: { causeCode: "DOMAIN_AUTHORITY_REQUIRED", outcome: "refused" },
  });
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh", "fzf"]);
  await assertNoLifecycleCommands(world);
});

test("chooser: a target replaced after listing is refused at the dispatch recheck", async () => {
  const world = await makeWorld({
    fzf: { picks: [{ match: PILOT_ROW }, { match: "open\t" }] },
    ssh: { ps: [RUNNING, psOutput(PS.pilotReplaced)] },
  });
  const { exitCode, output } = await runPty(world, ["choose", "--json"]);
  expect(exitCode).toBe(3);
  expect(reasonOf(lastEnvelope(output))).toEqual(REASON.DOMAIN_TARGET_REPLACED);
  expect(await calls(world, "code")).toEqual([]);
});

test("chooser: Ctrl-A shows all containers, and unclassified rows stay inspect-only", async () => {
  const world = await makeWorld({
    fzf: { picks: [{ key: "ctrl-a", match: PILOT_ROW }, { match: "orb-infra" }] },
    ssh: { ps: [RUNNING] },
  });
  const { exitCode, output } = await runPty(world, ["choose", "--json"]);
  expect(exitCode).toBe(3);
  expect(reasonOf(lastEnvelope(output))).toEqual([
    "DOMAIN_PRECONDITION_UNMET",
    "orb-infra is unclassified: inspect only. Nothing was launched.",
  ]);
  const fzf = await calls(world, "fzf");
  expect(fzf[0]?.stdin).not.toContain("orb-infra");
  expect(fzf[1]?.stdin).toContain("\tmini\t-\tunclassified\trunning\torb-infra");
  expect(await calls(world, "code")).toEqual([]);
});

test("chooser: Read logs dispatches the same redacted log action", async () => {
  const world = await makeWorld({
    fzf: { picks: [{ match: PILOT_ROW }, { match: "logs\t" }] },
    ssh: { logs: "ready password=letmein\n", ps: [RUNNING] },
  });
  const { exitCode, output } = await runPty(world, ["choose"]);
  expect(exitCode).toBe(0);
  expect(output).toContain("ready password=[REDACTED]");
  expect(output).not.toContain("letmein");
});

test("chooser: unavailable actions are explained instead of offered", async () => {
  const world = await makeWorld(
    { fzf: { picks: [{ match: PILOT_ROW }, { exit: 130 }] }, ssh: { ps: [RUNNING] } },
    (config) => {
      delete (config.targets[0] as Record<string, unknown>).board;
      return config;
    },
  );
  await runPty(world, ["choose", "--json"]);
  const menu = (await calls(world, "fzf"))[1];
  expect(menu?.stdin).toBe("open\tOpen VS Code\nlogs\tRead service log\n");
  expect(menu?.argv).toContain(
    "↑/↓ move · Enter run · Esc cancel (nothing is launched)\nNot available: Open task board: No task board is configured.",
  );
});

test("chooser: empty inventory, missing fzf, and missing config end without a launch", async () => {
  const empty = await makeWorld({ ssh: { ps: [""] } }, (config) => ({ ...config, targets: [] }));
  const emptyRun = await runPty(empty, ["choose", "--json"]);
  expect(emptyRun.exitCode).toBe(0);
  expect(lastEnvelope(emptyRun.output).message).toContain("No development targets are configured.");
  expect((await calls(empty)).map((call) => call.tool)).toEqual(["ssh"]);

  const noFzf = await makeWorld({ ssh: { ps: [RUNNING] } }, (config) => {
    config.tools.fzf = "/nonexistent/fzf";
    return config;
  });
  const noFzfRun = await runPty(noFzf, ["choose", "--json"]);
  expect(noFzfRun.exitCode).toBe(3);
  expect(reasonOf(lastEnvelope(noFzfRun.output))).toEqual(REASON.DOMAIN_TOOL_UNAVAILABLE);

  const noConfig = await makeWorld({}, () => undefined);
  const noConfigRun = await runPty(noConfig, ["choose", "--json"]);
  expect(noConfigRun.exitCode).toBe(3);
  expect(lastEnvelope(noConfigRun.output).result.causeCode).toBe("DOMAIN_CONFIG_MISSING");
  expect([...(await calls(noFzf, "code")), ...(await calls(noConfig))]).toEqual([]);
});

test("chooser: source failures and an unconfirmed launch are reported, never retried", async () => {
  const pickPilotOpen = { picks: [{ match: PILOT_ROW }, { match: "open\t" }] };
  const cases = [
    [await makeWorld({ ssh: { exit: 255 } }), REASON.TRANSIENT_HOST_UNREACHABLE, 75],
    [await makeWorld({ ssh: { exit: 2 } }), REASON.DOMAIN_HOST_COMMAND_FAILED, 1],
    [await makeWorld({}, () => "{}"), REASON.SCHEMA_INVALID_CONFIG, 4],
    [await makeWorld({ code: { exit: 1 }, fzf: pickPilotOpen, ssh: { ps: [RUNNING] } }), REASON.INTERNAL_LAUNCH_UNCONFIRMED, 1],
  ] as const;
  for (const [world, reason, exit] of cases) {
    const { exitCode, output } = await runPty(world, ["choose", "--json"]);
    expect(exitCode).toBe(exit);
    expect(reasonOf(lastEnvelope(output))).toEqual(reason);
    expect((await calls(world, "code")).length).toBeLessThanOrEqual(1);
  }
});

function runDesktopEntry(world: Awaited<ReturnType<typeof makeWorld>>) {
  const bunDirectory = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
  return Bun.spawnSync(["/bin/sh", join(PACKAGE_ROOT, "desktop", "Remote Development.command")], {
    env: {
      ...world.env,
      PATH: `${bunDirectory}:${world.env.PATH}`,
      REMOTE_DEV_CLI: join(PACKAGE_ROOT, "bin", "remote-dev"),
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
}

test("desktop entry opens the pilot through the same isolated launch policy", async () => {
  const world = await makeWorld({ ssh: { ps: [RUNNING] } });
  const result = runDesktopEntry(world);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Opened pilot in the isolated VS Code environment.");
  const [code] = await calls(world, "code");
  expect(code?.argv.at(-1)).toBe(`vscode-remote://${AUTHORITY}/workspace/START-HERE.md`);
  expect(code?.sshAuthSock).toBe("");
});

test("desktop entry shows a visible failure, starts nothing, and never blocks without input", async () => {
  const world = await makeWorld({ ssh: { ps: [psOutput(PS.pilotStopped)] } });
  const started = performance.now();
  const result = runDesktopEntry(world);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("The target is stopped. Nothing was started.");
  expect(result.stdout.toString()).toContain("Nothing was started. Press Return to close this window.");
  expect((await calls(world)).map((call) => call.tool)).toEqual(["ssh"]);
});

test.each([false, true])("chooser: started container retains its completed effect when editor recheck fails (dispatch %s)", async (editorDispatched) => {
  const world = await makeWorld({
    code: { exit: 1 },
    fzf: { picks: [{ match: PILOT_ROW }, { match: "start\t" }] },
    ssh: { ps: [psOutput(PS.pilotStopped), psOutput(PS.pilotStopped), RUNNING, editorDispatched ? RUNNING : psOutput(PS.pilotReplaced)] },
  }, (config) => { config.targets[0]!.allowStart = true; return config; });
  const output = await runPty(world, ["choose", "--json"]);
  expect(output.exitCode).toBe(1);
  expect(lastEnvelope(output.output).result).toMatchObject({
    causeCode: editorDispatched ? "INTERNAL_RESULT_UNKNOWN" : "INTERNAL_RESULT_PARTIAL",
    effects: { completed: ["container-start:pilot"] },
    transactionState: editorDispatched ? "unknown" : "partially-completed",
  });
});

test("every required station was observed and no undeclared station appeared", async () => {
  const { stationsFor } = await import("../../src/branch-station-catalog.ts");
  for (const command of ["remote-dev.list", "remote-dev.open", "remote-dev.logs", "remote-dev.board", "remote-dev.choose"]) {
    const declared = stationsFor(command);
    const declaredKeys = new Set(declared.map((station) => `${command}|${station.outcome}|${station.causeCode}`));
    const observed = [...observedStations].filter((key) => key.startsWith(`${command}|`));
    expect(observed.filter((key) => !declaredKeys.has(key))).toEqual([]);
    const required = declared.filter((station) => station.reachability === "required");
    expect(required.length).toBeGreaterThan(0);
    expect(
      required.map((station) => `${command}|${station.outcome}|${station.causeCode}`).filter((key) => !observedStations.has(key)),
    ).toEqual([]);
  }
});
