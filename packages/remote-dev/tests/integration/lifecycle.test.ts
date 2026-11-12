import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupWorlds, makeWorld, PACKAGE_ROOT, PS, psOutput, type World } from "../support/harness.ts";

afterEach(cleanupWorlds);

async function waitFor(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) throw new Error(`process did not reach ${path}`);
    await Bun.sleep(2);
  }
}

function spawnList(world: World, extra: Record<string, string>, stdin: "ignore" | "pipe" = "ignore") {
  return Bun.spawn([process.execPath, "run", "src/cli.ts", "list", "--json"], {
    cwd: PACKAGE_ROOT,
    env: { ...world.env, ...extra },
    stderr: "pipe",
    stdin,
    stdout: "pipe",
  });
}

async function settle(child: ReturnType<typeof spawnList>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

const RUNNING = { ssh: { ps: [psOutput(PS.pilotRunning)] } };

test("list ignores held-open stdin and finishes after stdout drains", async () => {
  const world = await makeWorld(RUNNING);
  const child = spawnList(world, {}, "pipe");
  const { exitCode, stderr, stdout } = await settle(child);
  (child.stdin as { end(): void }).end();
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).result.commandIdentity).toBe("remote-dev.list");
});

test.each(["SIGINT", "SIGTERM"] as const)("%s after readiness stops output at the 500ms flush deadline", async (signal) => {
  const world = await makeWorld(RUNNING);
  const ready = join(world.dir, "ready");
  const child = spawnList(world, {
    NODE_ENV: "test",
    REMOTE_DEV_TEST_DELAY_MS: "2000",
    REMOTE_DEV_TEST_DIAGNOSTIC_FLUSH_MS: "2000",
    REMOTE_DEV_TEST_READY_PATH: ready,
  });
  await waitFor(ready);
  const started = performance.now();
  child.kill(signal);
  const { exitCode, stderr, stdout } = await settle(child);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(400);
  expect(elapsed).toBeLessThan(900);
  expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test("a repeated termination exits immediately during diagnostic flush", async () => {
  const world = await makeWorld(RUNNING);
  const ready = join(world.dir, "ready");
  const child = spawnList(world, {
    NODE_ENV: "test",
    REMOTE_DEV_TEST_DELAY_MS: "2000",
    REMOTE_DEV_TEST_DIAGNOSTIC_FLUSH_MS: "2000",
    REMOTE_DEV_TEST_READY_PATH: ready,
  });
  await waitFor(ready);
  child.kill("SIGINT");
  await Bun.sleep(30);
  const started = performance.now();
  child.kill("SIGINT");
  const { exitCode, stderr, stdout } = await settle(child);
  expect(performance.now() - started).toBeLessThan(250);
  expect(exitCode).toBe(130);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test.each(["uncaught", "unhandled"] as const)("%s crash makes one silent emergency exit", async (crash) => {
  const world = await makeWorld(RUNNING);
  const ready = join(world.dir, "ready");
  const child = spawnList(world, { NODE_ENV: "test", REMOTE_DEV_TEST_CRASH: crash, REMOTE_DEV_TEST_READY_PATH: ready });
  await waitFor(ready);
  const { exitCode, stderr, stdout } = await settle(child);
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test("consumer disappearance before a large stdout drain exits internal", async () => {
  const world = await makeWorld(RUNNING);
  const child = spawnList(world, { NODE_ENV: "test", REMOTE_DEV_TEST_OUTPUT_BYTES: "4000000" });
  await child.stdout.cancel();
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(stderr).toBe("");
});

test("a live consumer receives the complete large envelope before normal exit", async () => {
  const world = await makeWorld(RUNNING);
  const child = spawnList(world, { NODE_ENV: "test", REMOTE_DEV_TEST_OUTPUT_BYTES: "1000000" });
  const { exitCode, stderr, stdout } = await settle(child);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).result.data.padding).toHaveLength(1_000_000);
});
