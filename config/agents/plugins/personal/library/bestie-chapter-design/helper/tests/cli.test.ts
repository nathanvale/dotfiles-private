import { afterEach, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanup, put, run, scratch } from "./fixtures.ts";

const ROOT = resolve(import.meta.dir, "..");

afterEach(cleanup);

function human(...args: string[]) {
  const entry = process.env.BESTIE_CHECK_ENTRY ?? join(ROOT, "src/cli.ts");
  const result = Bun.spawnSync([process.execPath, "run", entry, ...args], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}

// Independent oracle: the public command identities, restated deliberately.
const IDENTITIES = [
  "bestie-chapter-check.baseline",
  "bestie-chapter-check.book",
  "bestie-chapter-check.copy",
  "bestie-chapter-check.dispatch",
  "bestie-chapter-check.geometry",
  "bestie-chapter-check.handback",
  "bestie-chapter-check.protected",
  "bestie-chapter-check.story",
];

test("human help names usage and every command", () => {
  const result = human("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage: bestie-chapter-check <command>");
  for (const name of ["baseline", "book", "protected", "copy", "story", "geometry", "dispatch", "handback"]) {
    expect(result.stdout).toContain(`  ${name}  `);
  }
});

test("machine discovery reports the simple profile, eight checks and their envelope identities", () => {
  const result = run("--discover");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const data = result.envelope.result.data as { profile: string; commands: { commandIdentity: string; effectClass: string }[] };
  expect(data.profile).toBe("simple");
  expect(data.commands.map((c) => c.commandIdentity).sort()).toEqual(
    [
      ...IDENTITIES,
      "bestie-chapter-check.command-discovery",
      "bestie-chapter-check.discovery",
      "bestie-chapter-check.help",
      "bestie-chapter-check.invocation",
    ].sort(),
  );
  expect(data.commands.every((c) => c.effectClass === "inspect")).toBe(true);
});

test("selected-command discovery lists the transient station only for dispatch", () => {
  for (const identity of IDENTITIES) {
    const result = run("--discover-command", identity);
    expect(result.exitCode).toBe(0);
    const causes = (result.envelope.result.data as { stations: { causeCode: string }[] }).stations.map((s) => s.causeCode);
    expect(causes).toContain("DOMAIN_CHECK_FAILED");
    expect(causes.includes("TRANSIENT_NOT_STARTED")).toBe(identity === "bestie-chapter-check.dispatch");
  }
});

test("unknown command is a usage refusal with one stderr line in human mode", () => {
  const machine = run("frobnicate");
  expect(machine.exitCode).toBe(2);
  expect(machine.envelope.result.causeCode).toBe("USAGE_UNKNOWN_COMMAND");
  const plain = human("--definitely-unknown-option");
  expect(plain.exitCode).toBe(2);
  expect(plain.stdout).toBe("");
  expect(plain.stderr.trimEnd().split("\n")).toHaveLength(1);
});

test("a missing required option is a usage refusal", () => {
  const result = run("copy", "--input", "/tmp/whatever.json");
  expect(result.exitCode).toBe(2);
  expect(result.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
  expect(result.envelope.message).toContain("--current is required");
});

test("an absent input file is a domain precondition refusal", () => {
  const result = run("handback", "--record", "/nonexistent/bestie/handback.json");
  expect(result.exitCode).toBe(3);
  expect(result.envelope.result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
  expect(result.envelope.result.data).toBeNull();
});

test("malformed JSON input is a schema refusal", () => {
  const dir = scratch();
  const result = run("handback", "--record", put(dir, "handback.json", "{not json"));
  expect(result.exitCode).toBe(4);
  expect(result.envelope.result.causeCode).toBe("SCHEMA_INVALID_INPUT");
});

test("an unreadable input file is an internal failure with an operator handoff", () => {
  const dir = scratch();
  const path = put(dir, "handback.json", "{}");
  chmodSync(path, 0o000);
  const result = run("handback", "--record", path);
  chmodSync(path, 0o600);
  expect(result.exitCode).toBe(1);
  expect(result.envelope.result.causeCode).toBe("INTERNAL_UNEXPECTED");
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"handoff"');
});

test("held-open non-TTY stdin never blocks a check", async () => {
  const dir = scratch();
  const target = put(dir, "target.json", { capturedAt: new Date().toISOString() });
  const entry = process.env.BESTIE_CHECK_ENTRY ?? join(ROOT, "src/cli.ts");
  const child = Bun.spawn([process.execPath, "run", entry, "dispatch", "--receipts", dir, "--operation", "apply", "--target", target, "--json"], {
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => "hung")]);
  child.stdin.end();
  expect(exit).toBe(0);
});
