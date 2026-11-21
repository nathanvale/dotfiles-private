import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureTransfer, runProgram } from "../../src/runtime.ts";

const owned: string[] = [];

afterEach(async () => {
  for (const dir of owned.splice(0)) {
    const pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The descendant already exited.
      }
    }
    await rm(dir, { force: true, recursive: true });
  }
});

/** A shell that prints `first`, then leaves a descendant holding stdout open for 8 seconds. */
async function holder(first: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "remote-dev-runtime-"));
  owned.push(dir);
  return ["-c", `${first} /bin/sleep 8 & echo $! > "$1"; wait`, "sh", join(dir, "pid")];
}

// Independent oracle: the descendant holds the pipe for 8 s, the timeout is 200 ms, the bound is 3 s.
const BOUND_MS = 3000;

test("runProgram returns at its timeout even when a descendant holds stdout open", async () => {
  const started = performance.now();
  const result = await runProgram("/bin/sh", await holder(""), { captureStderr: true, timeoutMs: 200 });
  expect(result).toEqual({ kind: "timeout" });
  expect(performance.now() - started).toBeLessThan(BOUND_MS);
});

test("measureTransfer returns at its timeout even when a descendant holds stdout open", async () => {
  const started = performance.now();
  const result = await measureTransfer("/bin/sh", await holder('echo "mark 192.168.1.104 1 2 3"; printf abc;'), {
    environment: { PATH: "/usr/bin:/bin" },
    marker: "mark ",
    timeoutMs: 200,
  });
  expect(result).toEqual({ kind: "timeout" });
  expect(performance.now() - started).toBeLessThan(BOUND_MS);
});

test("measureTransfer skips shell preamble, reads the marker line and counts only the body", async () => {
  const result = await measureTransfer("/bin/sh", ["-c", 'echo "Last login"; echo "mark 10.0.0.1 5 6 7"; printf abcde; exit 3'], {
    environment: { PATH: "/usr/bin:/bin" },
    marker: "mark ",
    timeoutMs: 5000,
  });
  expect(result).toMatchObject({ bytes: 5, exitCode: 3, header: "10.0.0.1 5 6 7", kind: "measured" });
});

test("a missing program is reported as missing, not as a timeout", async () => {
  expect(await runProgram("/nonexistent/remote-dev-tool", [], { timeoutMs: 200 })).toEqual({ kind: "missing" });
});
