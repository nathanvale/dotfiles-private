import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "../..");
const REBUILD = "bun run build:bundle";

test("working xero-history bundle matches its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "xero-history-bundle-"));
  try {
    const output = join(root, "xero-history.js");
    const built = Bun.spawnSync([process.execPath, "build", "--target", "bun", "--minify-whitespace", "src/cli.ts", "--outfile", output], {
      cwd: PACKAGE, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, NODE_ENV: "production" },
    });
    expect(built.exitCode).toBe(0);
    const candidate = await readFile(output);
    const working = await readFile(join(PACKAGE, "dist", "xero-history.js")).catch(() => null);
    if (working === null || !candidate.equals(working)) {
      throw new Error(`Working xero-history bundle is stale or missing. From helper/, run ${REBUILD}.`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
