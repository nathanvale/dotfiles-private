import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "../..");
async function withRoot(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xero-history-lifecycle-")));
  try { await run(root); } finally { await rm(root, { force: true, recursive: true }); }
}
function spawnStatus(root: string, extraEnv: Record<string, string> = {}, stdin: "ignore" | "pipe" = "ignore") {
  return Bun.spawn([process.execPath, "run", "src/cli.ts", "status", "--organisation-id", "synthetic-org", "--account-id", "synthetic-account", "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root, NODE_ENV: "test", ...extraEnv },
    stdin, stdout: "pipe", stderr: "pipe",
  });
}
async function marker(path: string) {
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(path).exists()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(path).exists()).toBe(true);
}
test("held-open stdin cannot hold a read-only command open", async () => {
  await withRoot(async (root) => {
    const child = spawnStatus(root, {}, "pipe");
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).result.commandIdentity).toBe("xero-history.status");
    if (!child.stdin) throw new Error("Synthetic child lost its piped stdin.");
    child.stdin.end();
  });
});
test.each(["SIGINT", "SIGTERM"] as const)("%s stops before output at the bounded flush deadline", async (signal) => {
  await withRoot(async (root) => {
    const ready = join(root, "ready");
    const child = spawnStatus(root, {
      XERO_HISTORY_TEST_READY_PATH: ready, XERO_HISTORY_TEST_DELAY_MS: "2000",
      XERO_HISTORY_TEST_DIAGNOSTIC_FLUSH_MS: "2000",
    });
    await marker(ready);
    child.kill(signal);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(signal === "SIGINT" ? 130 : 143);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
test("a live consumer receives a complete large envelope", async () => {
  await withRoot(async (root) => {
    const child = spawnStatus(root, { XERO_HISTORY_TEST_OUTPUT_BYTES: "1100000" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).result.data.padding).toHaveLength(1_100_000);
  });
});
test("a vanished consumer produces no replacement envelope on stderr", async () => {
  await withRoot(async (root) => {
    const child = spawnStatus(root, { XERO_HISTORY_TEST_OUTPUT_BYTES: "4000000" });
    await child.stdout.cancel();
    const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1);
    expect(stderr).toBe("");
  });
});
test("an uncaught crash exits without a machine envelope", async () => {
  await withRoot(async (root) => {
    const ready = join(root, "ready");
    const child = spawnStatus(root, { XERO_HISTORY_TEST_READY_PATH: ready, XERO_HISTORY_TEST_CRASH: "uncaught" });
    await marker(ready);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
