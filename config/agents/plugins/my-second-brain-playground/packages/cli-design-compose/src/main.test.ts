import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const TEMPLATE_ROOT = resolve(
  process.env.BUN_TYPESCRIPT_TEMPLATE_TEST_ROOT ??
    join(homedir(), "code", "bun-typescript-template"),
);
const TEMPLATE_REVISION = "20c9f188f6bf82260b108e3899c951a4b6b1ae27";
const roots: string[] = [];

function templateAvailable(): boolean {
  if (!existsSync(TEMPLATE_ROOT)) return false;
  return (
    Bun.spawnSync(
      ["git", "-C", TEMPLATE_ROOT, "cat-file", "-e", `${TEMPLATE_REVISION}^{commit}`],
      { stderr: "ignore", stdout: "ignore" },
    ).exitCode === 0
  );
}

const integrationTest = templateAvailable() ? test : test.skip;

function invoke(projectRoot: string, packagePath: string, starter: string) {
  const result = Bun.spawnSync(
    [
      join(PLUGIN_ROOT, "bin", "cli-design"),
      "compose-existing",
      "--project-root",
      projectRoot,
      "--package",
      packagePath,
      "--starter",
      starter,
      "--source-packet",
      "https://example.test/vault/projects/example/",
      "--json",
    ],
    {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, BUN_TYPESCRIPT_TEMPLATE_ROOT: TEMPLATE_ROOT },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

async function fixture(workspace: boolean) {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-test-"));
  roots.push(root);
  const packagePath = workspace ? "packages/tool" : ".";
  const packageRoot = resolve(root, packagePath);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "host",
      private: true,
      devDependencies: { "@types/bun": "1.4.0" },
      scripts: { existing: "bun test existing.test.ts" },
      ...(workspace ? { workspaces: ["packages/*"] } : {}),
    })}\n`,
  );
  if (workspace) {
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "tool", private: true, scripts: { existing: "bun test" } })}\n`,
    );
  }
  const install = Bun.spawnSync(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    { cwd: root, stderr: "pipe", stdout: "pipe" },
  );
  expect(install.exitCode).toBe(0);
  return { packagePath, packageRoot, root };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

integrationTest("composes the simple starter into a single package and preserves host owners", async () => {
  const project = await fixture(false);
  const beforeLock = await readFile(join(project.root, "bun.lock"));
  const result = invoke(project.root, project.packagePath, "simple");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    package: ".",
    starter: "simple",
    status: "composed",
    templateRevision: TEMPLATE_REVISION,
  });
  const packageJson = JSON.parse(
    await readFile(join(project.packageRoot, "package.json"), "utf8"),
  );
  expect(packageJson.scripts.existing).toBe("bun test existing.test.ts");
  expect(packageJson.scripts["cli:example"]).toBe("bun run src/cli.ts");
  expect(await Bun.file(join(project.packageRoot, "src/cli.ts")).exists()).toBe(true);
  expect(await Bun.file(join(project.root, "bun.lock")).exists()).toBe(true);
  expect(digest(await readFile(join(project.root, "bun.lock")))).toBe(digest(beforeLock));
  const invocation = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    { cwd: project.packageRoot, stderr: "pipe", stdout: "pipe" },
  );
  expect(invocation.exitCode).toBe(0);
  expect(invocation.stderr.toString()).toBe("");
  expect(JSON.parse(invocation.stdout.toString())).toMatchObject({
    contractVersion: "2.0.0",
    result: { commandIdentity: "example.status", outcome: "success" },
  });
});

integrationTest("composes complex into a workspace package and updates the owning lock", async () => {
  const project = await fixture(true);
  const result = invoke(project.root, project.packagePath, "complex");

  expect(result.exitCode).toBe(0);
  const packageJson = JSON.parse(
    await readFile(join(project.packageRoot, "package.json"), "utf8"),
  );
  expect(packageJson.scripts.existing).toBe("bun test");
  expect(packageJson.dependencies).toEqual({
    "@logtape/logtape": "2.3.1",
    "@logtape/redaction": "2.3.1",
    zod: "4.4.3",
  });
  const lock = await readFile(join(project.root, "bun.lock"), "utf8");
  expect(lock).toContain('"@logtape/logtape": "2.3.1"');
  expect(lock).toContain('"zod": "4.4.3"');
  expect(await Bun.file(join(project.packageRoot, "tests/catalog/catalog.test.ts")).exists()).toBe(true);
  const install = Bun.spawnSync(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: project.root, stderr: "pipe", stdout: "pipe" },
  );
  expect(install.exitCode).toBe(0);
  const invocation = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    { cwd: project.packageRoot, stderr: "pipe", stdout: "pipe" },
  );
  expect(invocation.exitCode).toBe(0);
  expect(invocation.stderr.toString()).toBe("");
  expect(JSON.parse(invocation.stdout.toString())).toMatchObject({
    contractVersion: "2.0.0",
    result: { commandIdentity: "example.status", outcome: "success" },
  });
});

integrationTest("refuses a source collision without changing manifest or lock bytes", async () => {
  const project = await fixture(false);
  await mkdir(join(project.packageRoot, "src"));
  await writeFile(join(project.packageRoot, "src/cli.ts"), "owned bytes\n");
  const packageBefore = await readFile(join(project.packageRoot, "package.json"));
  const lockBefore = await readFile(join(project.root, "bun.lock"));
  const result = invoke(project.root, project.packagePath, "complex");

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    causeCode: "DOMAIN_TARGET_COLLISION",
    status: "refused",
  });
  expect(await readFile(join(project.packageRoot, "src/cli.ts"), "utf8")).toBe("owned bytes\n");
  expect(digest(await readFile(join(project.packageRoot, "package.json")))).toBe(digest(packageBefore));
  expect(digest(await readFile(join(project.root, "bun.lock")))).toBe(digest(lockBefore));
});
