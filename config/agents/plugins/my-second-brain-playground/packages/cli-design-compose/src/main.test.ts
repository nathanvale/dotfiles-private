import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const TEMPLATE_ROOT = resolve(
  process.env.BUN_TYPESCRIPT_TEMPLATE_TEST_ROOT ??
    join(homedir(), "code", "bun-typescript-template"),
);
const TEMPLATE_REVISION = "f428e5fdefd0a93fbf91591fa433fbd7593a7d16";
const roots: string[] = [];

function invoke(
  projectRoot: string,
  packagePath: string,
  starter: string,
  templateRoot = TEMPLATE_ROOT,
) {
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
      env: { ...process.env, BUN_TYPESCRIPT_TEMPLATE_ROOT: templateRoot },
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
  await writeFile(join(root, "biome.json"), '{"linter":{"enabled":true}}\n');
  await writeFile(join(packageRoot, "existing.test.ts"), "export const preserved = true;\n");
  await writeFile(join(root, "unrelated.txt"), "owned sentinel\n");
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

test("the exact pinned canonical template revision is available", () => {
  const result = Bun.spawnSync(
    ["git", "-C", TEMPLATE_ROOT, "cat-file", "-e", `${TEMPLATE_REVISION}^{commit}`],
    { stderr: "pipe", stdout: "pipe" },
  );
  expect(result.exitCode).toBe(0);
});

test("composes the simple starter into a single package and preserves host owners", async () => {
  const project = await fixture(false);
  const beforeLock = await readFile(join(project.root, "bun.lock"));
  const beforeQuality = await readFile(join(project.root, "biome.json"));
  const beforeTest = await readFile(join(project.packageRoot, "existing.test.ts"));
  const beforeSentinel = await readFile(join(project.root, "unrelated.txt"));
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
  expect(await readFile(join(project.root, "biome.json"))).toEqual(beforeQuality);
  expect(await readFile(join(project.packageRoot, "existing.test.ts"))).toEqual(beforeTest);
  expect(await readFile(join(project.root, "unrelated.txt"))).toEqual(beforeSentinel);
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

test("composes complex into a workspace package and updates the owning lock", async () => {
  const project = await fixture(true);
  const beforeWorkspaceManifest = await readFile(join(project.root, "package.json"));
  const beforePackageManifest = JSON.parse(
    await readFile(join(project.packageRoot, "package.json"), "utf8"),
  );
  const beforeLock = await readFile(join(project.root, "bun.lock"), "utf8");
  const beforeQuality = await readFile(join(project.root, "biome.json"));
  const beforeTest = await readFile(join(project.packageRoot, "existing.test.ts"));
  const beforeSentinel = await readFile(join(project.root, "unrelated.txt"));
  const result = invoke(project.root, project.packagePath, "complex");

  expect(result.exitCode).toBe(0);
  const packageJson = JSON.parse(
    await readFile(join(project.packageRoot, "package.json"), "utf8"),
  );
  expect(packageJson).toEqual({
    ...beforePackageManifest,
    dependencies: {
      "@logtape/logtape": "2.3.1",
      "@logtape/redaction": "2.3.1",
      zod: "4.4.3",
    },
    scripts: {
      ...beforePackageManifest.scripts,
      "cli:example": "bun run src/cli.ts",
    },
  });
  const lock = await readFile(join(project.root, "bun.lock"), "utf8");
  expect(lock).not.toBe(beforeLock);
  expect(lock).toContain('"@types/bun": "1.4.0"');
  expect(lock).toContain('"@logtape/logtape": "2.3.1"');
  expect(lock).toContain('"zod": "4.4.3"');
  expect(await readFile(join(project.root, "package.json"))).toEqual(
    beforeWorkspaceManifest,
  );
  expect(await readFile(join(project.root, "biome.json"))).toEqual(beforeQuality);
  expect(await readFile(join(project.packageRoot, "existing.test.ts"))).toEqual(
    beforeTest,
  );
  expect(await readFile(join(project.root, "unrelated.txt"))).toEqual(beforeSentinel);
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

test("refuses a source collision without changing manifest or lock bytes", async () => {
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

test("refuses ambiguous, outside, and symlinked package paths before writes", async () => {
  const project = await fixture(true);
  const outside = await mkdtemp(join(tmpdir(), "cli-compose-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "package.json"), '{"name":"outside"}\n');
  await symlink(outside, join(project.root, "packages", "escape"));
  const beforeLock = await readFile(join(project.root, "bun.lock"));

  for (const [packagePath, causeCode] of [
    ["packages", "DOMAIN_PROJECT_PRECONDITION"],
    ["../outside", "USAGE_PACKAGE_OUTSIDE_PROJECT"],
    ["packages/escape", "DOMAIN_UNSAFE_PACKAGE_PATH"],
  ] as const) {
    const result = invoke(project.root, packagePath, "simple");
    expect(result.exitCode).toBe(packagePath === "../outside" ? 2 : 3);
    expect(JSON.parse(result.stdout).causeCode).toBe(causeCode);
  }
  expect(await readFile(join(project.root, "bun.lock"))).toEqual(beforeLock);
  expect(await Bun.file(join(outside, "src/cli.ts")).exists()).toBe(false);
});

test("refuses script and dependency conflicts before changing owner bytes", async () => {
  for (const kind of ["script", "dependency"] as const) {
    const project = await fixture(false);
    const manifestPath = join(project.packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (kind === "script") manifest.scripts["cli:example"] = "bun run owned.ts";
    else manifest.dependencies = { zod: "4.3.0" };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const beforeManifest = await readFile(manifestPath);
    const beforeLock = await readFile(join(project.root, "bun.lock"));
    const result = invoke(project.root, project.packagePath, "complex");
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).causeCode).toBe(
      kind === "script" ? "DOMAIN_SCRIPT_CONFLICT" : "DOMAIN_DEPENDENCY_CONFLICT",
    );
    expect(await readFile(manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(project.root, "bun.lock"))).toEqual(beforeLock);
  }
});

test("refuses an unavailable pinned template revision before host writes", async () => {
  const project = await fixture(false);
  const emptyRepository = await mkdtemp(join(tmpdir(), "cli-compose-empty-template-"));
  roots.push(emptyRepository);
  expect(Bun.spawnSync(["git", "init", "--quiet", emptyRepository]).exitCode).toBe(0);
  const beforeManifest = await readFile(join(project.packageRoot, "package.json"));
  const beforeLock = await readFile(join(project.root, "bun.lock"));
  const result = invoke(
    project.root,
    project.packagePath,
    "simple",
    emptyRepository,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).causeCode).toBe(
    "INTERNAL_TEMPLATE_REVISION_UNAVAILABLE",
  );
  expect(await readFile(join(project.packageRoot, "package.json"))).toEqual(beforeManifest);
  expect(await readFile(join(project.root, "bun.lock"))).toEqual(beforeLock);
});
