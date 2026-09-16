import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  nodeFileSystem,
  publish,
  requireUnchangedLockInputs,
  snapshotLockInputs,
  stageProject,
  withProjectLock,
  type Creation,
  type FileSystemAdapter,
  type Replacement,
} from "./main";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const TEMPLATE_ROOT = resolve(
  process.env.BUN_TYPESCRIPT_TEMPLATE_TEST_ROOT ??
    join(homedir(), "code", "bun-typescript-template"),
);
// Independent oracle: this test-owned revision must not be imported from the
// composer, so a changed production pin makes the public composition checks RED.
const TEMPLATE_REVISION = "7f6d95017e051c23e978f5d7f7542732b799dfdc";
const DEFAULT_SOURCE_PACKET = "https://example.test/vault/projects/example/";
const CONCURRENT_WORKSPACE_MANIFEST =
  '{"name":"concurrent","private":true,"dependencies":{"zod":"4.4.3"}}\n';
const roots: string[] = [];
const FIXTURE_SIMPLE_CLI = [
  "const result = {",
  '  contractVersion: "2.0.0",',
  '  result: { commandIdentity: "example.status", outcome: "success" },',
  "};",
  "process.stdout.write(`${JSON.stringify(result)}\\n`);",
  "",
].join("\n");
const FIXTURE_COMPLEX_CLI = FIXTURE_SIMPLE_CLI;
const templateAvailable =
  process.env.BUN_TYPESCRIPT_TEMPLATE_TEST_ROOT !== undefined ||
  Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, "cat-file", "-e", `${TEMPLATE_REVISION}^{commit}`])
    .exitCode === 0;
const templateTest = templateAvailable ? test : test.skip;

function invoke(
  projectRoot: string,
  packagePath: string,
  starter: string,
  templateRoot = TEMPLATE_ROOT,
  extraArgs: string[] = [],
  sourcePacket = DEFAULT_SOURCE_PACKET,
  environment: Record<string, string | undefined> = {},
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
      sourcePacket,
      "--json",
      ...extraArgs,
    ],
    {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...environment, BUN_TYPESCRIPT_TEMPLATE_ROOT: templateRoot },
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

async function invokeAsync(
  projectRoot: string,
  packagePath: string,
  starter: string,
  templateRoot = TEMPLATE_ROOT,
  extraArgs: string[] = [],
  sourcePacket = DEFAULT_SOURCE_PACKET,
  environment: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn(
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
      sourcePacket,
      "--json",
      ...extraArgs,
    ],
    {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...environment, BUN_TYPESCRIPT_TEMPLATE_ROOT: templateRoot },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

interface ProjectFixture {
  packagePath: string;
  packageRoot: string;
  root: string;
  templateRoot: string;
}

function invokeFixture(
  project: ProjectFixture,
  starter: string,
  extraArgs: string[] = [],
  sourcePacket = DEFAULT_SOURCE_PACKET,
) {
  return invoke(
    project.root,
    project.packagePath,
    starter,
    project.templateRoot,
    extraArgs,
    sourcePacket,
    { PATH: `${join(project.templateRoot, "bin")}:${process.env.PATH ?? ""}` },
  );
}

async function invokeFixtureAsync(
  project: ProjectFixture,
  starter: string,
  extraArgs: string[] = [],
  sourcePacket = DEFAULT_SOURCE_PACKET,
  environment: Record<string, string | undefined> = {},
) {
  return await invokeAsync(
    project.root,
    project.packagePath,
    starter,
    project.templateRoot,
    extraArgs,
    sourcePacket,
    {
      PATH: `${join(project.templateRoot, "bin")}:${process.env.PATH ?? ""}`,
      ...environment,
    },
  );
}

function fileSystemWith(overrides: Partial<FileSystemAdapter>): FileSystemAdapter {
  return { ...nodeFileSystem, ...overrides };
}

async function rejected(action: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as unknown as Record<string, unknown>;
  }
  throw new Error("expected action to reject");
}

async function transactionArtifacts(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }))
    .filter((path) => path.includes(".cli-design-"))
    .sort();
}

async function templateFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-template-fixture-"));
  roots.push(root);
  const files = {
    "starters/simple/src/cli.ts": FIXTURE_SIMPLE_CLI,
    "starters/complex/src/cli.ts": FIXTURE_COMPLEX_CLI,
    "starters/complex/tests/catalog/catalog.test.ts": 'import { test } from "bun:test";\ntest("fixture", () => {});\n',
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    await mkdir(dirname(join(root, ".fixture-objects", path)), { recursive: true });
    await writeFile(join(root, ".fixture-objects", path), bytes);
  }
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(
    join(root, "bin", "git"),
    `#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const revision = "${TEMPLATE_REVISION}";
const root = dirname(import.meta.dir);
const args = process.argv.slice(2);
const command = args[0] === "-C" ? args[2] : args[0];
const rest = args.slice(args[0] === "-C" ? 3 : 1);
const paths = {
  complex: ["starters/complex/src/cli.ts", "starters/complex/tests/catalog/catalog.test.ts"],
  simple: ["starters/simple/src/cli.ts"],
};
if (command === "cat-file" && rest.at(-1) === revision + "^{commit}") process.exit(0);
if (command === "ls-tree") {
  const prefix = rest.at(-1);
  const starter = prefix === "starters/simple/" ? "simple" : prefix === "starters/complex/" ? "complex" : undefined;
  if (starter === undefined) process.exit(1);
  process.stdout.write(paths[starter].join("\\n") + "\\n");
  process.exit(0);
}
if (command === "show") {
  const specifier = rest.at(-1);
  const separator = specifier?.indexOf(":") ?? -1;
  if (separator < 0 || specifier?.slice(0, separator) !== revision) process.exit(1);
  process.stdout.write(await readFile(join(root, ".fixture-objects", specifier.slice(separator + 1))));
  process.exit(0);
}
process.exit(1);
`,
  );
  await chmod(join(root, "bin", "git"), 0o755);
  return root;
}

async function publicationMutationPreload(path: string, bytes: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-publication-mutation-"));
  roots.push(root);
  const preload = join(root, "preload.ts");
  const target = JSON.stringify(path);
  const mutation = JSON.stringify(bytes);
  await writeFile(
    preload,
    `const target = ${target};
const mutation = ${mutation};

Bun.plugin({
  name: "cli-compose-publication-mutation",
  setup(build) {
    build.onLoad({ filter: new RegExp("runtime/cli-design\\\\.js$") }, async (args) => {
      const source = await Bun.file(args.path).text();
      const needle = \`for (const file of creations)\n      await writeNewFile(file, state, fileSystem);\`;
      const replacement = \`let mutationInjected = false;\n    for (const file of creations) {\n      await writeNewFile(file, state, fileSystem);\n      if (!mutationInjected) {\n        mutationInjected = true;\n        await Bun.write(\${JSON.stringify(target)}, \${JSON.stringify(mutation)});\n      }\n    }\`;
      if (!source.includes(needle)) throw new Error("publication timing seam was not found");
      return { contents: source.replace(needle, replacement) };
    });
  },
});
`,
  );
  return preload;
}

async function fixture(workspace: boolean): Promise<ProjectFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cli-compose-test-")));
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
    await mkdir(join(root, "packages", "sibling"), { recursive: true });
    await writeFile(
      join(root, "packages", "sibling", "package.json"),
      '{"name":"sibling","private":true}\n',
    );
  }
  await writeFile(join(root, "biome.json"), '{"linter":{"enabled":true}}\n');
  await writeFile(join(root, "README.md"), "host README\n");
  await writeFile(join(packageRoot, "existing.test.ts"), "export const preserved = true;\n");
  await writeFile(join(root, "unrelated.txt"), "owned sentinel\n");
  const install = Bun.spawnSync(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    { cwd: root, stderr: "pipe", stdout: "pipe" },
  );
  expect(install.exitCode).toBe(0);
  return { packagePath, packageRoot, root, templateRoot: await templateFixture() };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Every path under root with its file digest or symlink target; a refusal must leave it unchanged.
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const key = relative(root, path);
    if (entry.isSymbolicLink()) tree[key] = `symlink:${await readlink(path)}`;
    else if (entry.isFile()) tree[key] = digest(await readFile(path));
    else if (entry.isDirectory()) tree[key] = "directory";
  }
  return tree;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

templateTest("the exact pinned canonical template revision is available", () => {
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
  const result = invokeFixture(project, "simple");

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
  const result = invokeFixture(project, "complex");

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

for (const [label, packagePath] of [
  ["a changed sibling manifest", "packages/sibling/package.json"],
  ["a newly appearing sibling manifest", "packages/late/package.json"],
] as const) {
  test(`the public compose process refuses ${label} after publication begins`, async () => {
    const project = await fixture(true);
    const target = join(project.root, packagePath);
    const originalSibling = await readFile(join(project.root, "packages", "sibling", "package.json"));
    const beforeTree = await snapshotTree(project.root);
    const preload = await publicationMutationPreload(target, CONCURRENT_WORKSPACE_MANIFEST);
    const result = await invokeFixtureAsync(project, "complex", [], DEFAULT_SOURCE_PACKET, {
      BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ""} --preload=${preload}`.trim(),
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      causeCode: "DOMAIN_CONCURRENT_CHANGE",
      status: "refused",
    });
    expect(await readFile(target, "utf8")).toBe(CONCURRENT_WORKSPACE_MANIFEST);
    expect(await Bun.file(join(project.packageRoot, "src", "cli.ts")).exists()).toBe(false);
    expect(await Bun.file(join(project.packageRoot, ".cli-design-template.json")).exists()).toBe(
      false,
    );
    await writeFile(join(project.root, "packages", "sibling", "package.json"), originalSibling);
    if (target !== join(project.root, "packages", "sibling", "package.json")) {
      await rm(dirname(target), { force: true, recursive: true });
    }
    expect(await snapshotTree(project.root)).toEqual(beforeTree);
    const install = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: project.root, stderr: "pipe", stdout: "pipe" },
    );
    expect(install.exitCode).toBe(0);
  });
}

test("refuses a sibling workspace manifest changed after staging", async () => {
  const project = await fixture(true);
  const siblingPath = join(project.root, "packages", "sibling", "package.json");
  const siblingBefore = await readFile(siblingPath, "utf8");
  const siblingAfter = '{"name":"sibling","private":true,"dependencies":{"zod":"4.4.3"}}\n';
  const inputs = await snapshotLockInputs(project.root);
  const stage = await stageProject(project.root);
  roots.push(stage);
  expect(await readFile(join(stage, "packages", "sibling", "package.json"), "utf8")).toBe(
    siblingBefore,
  );
  await writeFile(siblingPath, siblingAfter);
  expect(await readFile(siblingPath, "utf8")).toBe(siblingAfter);
  const error = await rejected(async () => await requireUnchangedLockInputs(project.root, inputs));
  expect(error.causeCode).toBe("DOMAIN_CONCURRENT_CHANGE");
  expect(String(error.message)).toContain("packages/sibling/package.json");

  const currentInputs = await snapshotLockInputs(project.root);
  const latePackage = join(project.root, "packages", "late", "package.json");
  await mkdir(dirname(latePackage), { recursive: true });
  await writeFile(latePackage, '{"name":"late","private":true}\n');
  const lateError = await rejected(
    async () => await requireUnchangedLockInputs(project.root, currentInputs),
  );
  expect(lateError.causeCode).toBe("DOMAIN_CONCURRENT_CHANGE");
  expect(String(lateError.message)).toContain("workspace lock input set changed");
});

test("refuses a source collision without changing manifest or lock bytes", async () => {
  const project = await fixture(false);
  await mkdir(join(project.packageRoot, "src"));
  await writeFile(join(project.packageRoot, "src/cli.ts"), "owned bytes\n");
  const packageBefore = await readFile(join(project.packageRoot, "package.json"));
  const lockBefore = await readFile(join(project.root, "bun.lock"));
  const treeBefore = await snapshotTree(project.root);
  const result = invokeFixture(project, "complex");

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    causeCode: "DOMAIN_TARGET_COLLISION",
    status: "refused",
  });
  expect(await readFile(join(project.packageRoot, "src/cli.ts"), "utf8")).toBe("owned bytes\n");
  expect(digest(await readFile(join(project.packageRoot, "package.json")))).toBe(digest(packageBefore));
  expect(digest(await readFile(join(project.root, "bun.lock")))).toBe(digest(lockBefore));
  expect(await snapshotTree(project.root)).toEqual(treeBefore);
});

test("refuses ambiguous, outside, and symlinked package paths before writes", async () => {
  const project = await fixture(true);
  const outside = await mkdtemp(join(tmpdir(), "cli-compose-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "package.json"), '{"name":"outside"}\n');
  await symlink(outside, join(project.root, "packages", "escape"));
  await mkdir(join(project.root, "tools", "hidden"), { recursive: true });
  await writeFile(
    join(project.root, "tools", "hidden", "package.json"),
    '{"name":"hidden","private":true}\n',
  );
  const beforeLock = await readFile(join(project.root, "bun.lock"));
  const treeBefore = await snapshotTree(project.root);

  for (const [packagePath, causeCode, exitCode] of [
    ["packages", "DOMAIN_PROJECT_PRECONDITION", 3],
    ["../outside", "USAGE_PACKAGE_OUTSIDE_PROJECT", 2],
    ["packages/escape", "DOMAIN_UNSAFE_PACKAGE_PATH", 3],
    ["tools/hidden", "USAGE_PACKAGE_NOT_WORKSPACE_MEMBER", 2],
  ] as const) {
    const result = invoke(project.root, packagePath, "simple", project.templateRoot);
    expect(result.exitCode).toBe(exitCode);
    expect(JSON.parse(result.stdout).causeCode).toBe(causeCode);
  }
  expect(await readFile(join(project.root, "bun.lock"))).toEqual(beforeLock);
  expect(await Bun.file(join(outside, "src/cli.ts")).exists()).toBe(false);
  expect(await snapshotTree(project.root)).toEqual(treeBefore);
});

test("refuses malformed arguments as usage errors before host writes", async () => {
  const project = await fixture(false);
  const treeBefore = await snapshotTree(project.root);
  for (const extraArgs of [["--bogus"], ["stray-positional"]]) {
    const result = invokeFixture(project, "simple", extraArgs);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      causeCode: "USAGE_INVALID_ARGUMENTS",
      status: "refused",
    });
  }
  expect(await snapshotTree(project.root)).toEqual(treeBefore);
});

test("refuses credential-bearing and query source URLs without leaking their bytes", async () => {
  const marker = "source-packet-secret-marker";
  for (const sourcePacket of [
    `https://${marker}@example.test/project`,
    `https://reader:${marker}@example.test/project`,
    `https://example.test/project?token=${marker}`,
    "https://example.test/project?",
  ]) {
    const project = await fixture(false);
    const treeBefore = await snapshotTree(project.root);
    const readmeBefore = await readFile(join(project.root, "README.md"));
    const result = invokeFixture(project, "simple", [], sourcePacket);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      causeCode: "USAGE_INVALID_SOURCE_PACKET",
      status: "refused",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sourcePacket);
    expect(await Bun.file(join(project.packageRoot, ".cli-design-template.json")).exists()).toBe(
      false,
    );
    expect(await readFile(join(project.root, "README.md"))).toEqual(readmeBefore);
    expect((await readFile(join(project.root, "README.md"), "utf8"))).not.toContain(marker);
    expect(await snapshotTree(project.root)).toEqual(treeBefore);
  }
});

test("preserves an ordinary source URL byte-for-byte", async () => {
  const project = await fixture(false);
  const sourcePacket = "https://Example.test:443/vault/a%2Fb#Reviewed-Source";
  const result = invokeFixture(project, "simple", [], sourcePacket);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).sourcePacket).toBe(sourcePacket);
  const metadata = JSON.parse(
    await readFile(join(project.packageRoot, ".cli-design-template.json"), "utf8"),
  );
  expect(metadata.sourcePacket).toBe(sourcePacket);
});

test("refuses a malformed target manifest as a schema error before host writes", async () => {
  const project = await fixture(false);
  await writeFile(join(project.packageRoot, "package.json"), '{"name": "host",\n');
  const treeBefore = await snapshotTree(project.root);
  const result = invokeFixture(project, "simple");
  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    causeCode: "SCHEMA_INVALID_PACKAGE",
    status: "refused",
  });
  expect(await snapshotTree(project.root)).toEqual(treeBefore);
});

test("refuses script and dependency conflicts before changing owner bytes", async () => {
  for (const kind of ["script", "dependency", "devDependency"] as const) {
    const project = await fixture(false);
    const manifestPath = join(project.packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (kind === "script") manifest.scripts["cli:example"] = "bun run owned.ts";
    else if (kind === "dependency") manifest.dependencies = { zod: "4.3.0" };
    else manifest.devDependencies = { ...manifest.devDependencies, zod: "4.4.3" };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const beforeManifest = await readFile(manifestPath);
    const beforeLock = await readFile(join(project.root, "bun.lock"));
    const treeBefore = await snapshotTree(project.root);
    const result = invokeFixture(project, "complex");
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).causeCode).toBe(
      kind === "script" ? "DOMAIN_SCRIPT_CONFLICT" : "DOMAIN_DEPENDENCY_CONFLICT",
    );
    if (kind === "devDependency") {
      expect(JSON.parse(result.stdout).message).toBe("zod is already declared under devDependencies");
    }
    expect(await readFile(manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(project.root, "bun.lock"))).toEqual(beforeLock);
    expect(await snapshotTree(project.root)).toEqual(treeBefore);
  }
});

test("refuses a second project transaction without disturbing its lock", async () => {
  const project = await fixture(false);
  const lockPath = join(project.root, ".cli-design-compose.lock");
  await writeFile(lockPath, "first owner\n", { flag: "wx" });
  const treeBefore = await snapshotTree(project.root);
  const result = invokeFixture(project, "simple");

  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    causeCode: "DOMAIN_PROJECT_BUSY",
    status: "refused",
  });
  expect(await snapshotTree(project.root)).toEqual(treeBefore);
});

test("atomically releases only its owned project lock when a later owner races", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const lockPath = join(root, ".cli-design-compose.lock");
  const laterOwner = new TextEncoder().encode("later owner\n");
  let released = false;
  const fileSystem = fileSystemWith({
    rename: async (source, destination) => {
      await nodeFileSystem.rename(source, destination);
      if (source === lockPath && destination.endsWith(".current")) {
        released = true;
        await writeFile(lockPath, Buffer.from(laterOwner), { flag: "wx" });
      }
    },
  });

  const result = await withProjectLock(root, async () => "finished", fileSystem);
  expect(released).toBe(true);
  expect(result).toBe("finished");
  expect(await readFile(lockPath)).toEqual(Buffer.from(laterOwner));
  const artifacts = await transactionArtifacts(root);
  expect(artifacts).toEqual([".cli-design-compose.lock"]);
});

test("unions action recovery effects with project-lock release residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const target = join(root, "created.ts");
  const fileSystem = fileSystemWith({
    link: async () => {
      throw new Error("injected publication failure");
    },
    remove: async () => {
      throw new Error("injected cleanup failure");
    },
  });

  const error = await rejected(
    async () =>
      await withProjectLock(
        root,
        async () =>
          await publish(
            [{ bytes: new TextEncoder().encode("generated\n"), path: target }],
            [],
            fileSystem,
          ),
        fileSystem,
      ),
  );
  expect(error.causeCode).toBe("DOMAIN_PARTIAL_COMPOSITION");
  expect(String(error.message)).toContain("temporary publication file remains");
  expect(String(error.message)).toContain("project transaction lock could not be released");
  expect(String(error.message)).toContain("created.ts.cli-design-");
  expect(String(error.message)).toContain(".cli-design-compose.lock.cli-design-");
});

test("claims new publication paths without clobbering a concurrent file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const directory = join(root, "owned");
  const target = join(directory, "created.ts");
  const competing = new TextEncoder().encode("concurrent owner\n");
  await mkdir(directory);
  const fileSystem = fileSystemWith({
    link: async (source, destination) => {
      if (destination === target) await writeFile(target, competing, { flag: "wx" });
      await nodeFileSystem.link(source, destination);
    },
  });

  const error = await rejected(
    async () => await publish([{ bytes: new TextEncoder().encode("generated\n"), path: target }], [], fileSystem),
  );
  expect(error.causeCode).toBe("DOMAIN_TARGET_COLLISION");
  expect(await readFile(target, "utf8")).toBe("concurrent owner\n");
  expect(await transactionArtifacts(root)).toEqual([]);
});

test("does not remove a colliding temporary file it did not create", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const target = join(root, "created.ts");
  let temporary: string | undefined;
  const fileSystem = fileSystemWith({
    writeExclusive: async (path, bytes) => {
      temporary = path;
      await writeFile(path, "competing temporary owner\n", { flag: "wx" });
      await nodeFileSystem.writeExclusive(path, bytes);
    },
  });

  const error = await rejected(
    async () => await publish([{ bytes: new TextEncoder().encode("generated\n"), path: target }], [], fileSystem),
  );
  expect(error.causeCode).toBe("DOMAIN_TARGET_COLLISION");
  expect(temporary).toBeDefined();
  expect(await readFile(temporary as string, "utf8")).toBe("competing temporary owner\n");
  expect(await Bun.file(target).exists()).toBe(false);
});

test("captures and restores a concurrently changed replacement without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const target = join(root, "package.json");
  const original = new TextEncoder().encode("original\n");
  const competing = new TextEncoder().encode("concurrent owner\n");
  await writeFile(target, original);
  let injected = false;
  const fileSystem = fileSystemWith({
    rename: async (source, destination) => {
      if (!injected && source === target && destination.endsWith(".backup")) {
        injected = true;
        await writeFile(target, competing);
      }
      await nodeFileSystem.rename(source, destination);
    },
  });

  const error = await rejected(
    async () =>
      await publish(
        [],
        [{ bytes: new TextEncoder().encode("generated\n"), original, path: target }],
        fileSystem,
      ),
  );
  expect(error.causeCode).toBe("DOMAIN_CONCURRENT_CHANGE");
  expect(await readFile(target, "utf8")).toBe("concurrent owner\n");
  expect(await transactionArtifacts(root)).toEqual([]);
});

test("retains a backup and reports a lost replacement during rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "bun.lock");
  const packageOriginal = new TextEncoder().encode("package original\n");
  const lockOriginal = new TextEncoder().encode("lock original\n");
  const packageGenerated = new TextEncoder().encode("package generated\n");
  const competing = new TextEncoder().encode("concurrent package owner\n");
  await writeFile(packagePath, packageOriginal);
  await writeFile(lockPath, lockOriginal);
  let failed = false;
  const fileSystem = fileSystemWith({
    link: async (source, destination) => {
      if (!failed && destination === lockPath) {
        failed = true;
        await rm(packagePath);
        throw new Error("injected lock publication failure");
      }
      await nodeFileSystem.link(source, destination);
    },
  });
  const replacements: Replacement[] = [
    { bytes: packageGenerated, original: packageOriginal, path: packagePath },
    { bytes: new TextEncoder().encode("lock generated\n"), original: lockOriginal, path: lockPath },
  ];

  const error = await rejected(async () => await publish([], replacements, fileSystem));
  expect(error.causeCode).toBe("DOMAIN_PARTIAL_COMPOSITION");
  expect(String(error.message)).toContain("unresolved effects");
  expect(await Bun.file(packagePath).exists()).toBe(false);
  expect(await readFile(lockPath, "utf8")).toBe("lock original\n");
  const artifacts = await transactionArtifacts(root);
  expect(artifacts).toHaveLength(1);
  expect(await readFile(join(root, artifacts[0] as string), "utf8")).toBe("package original\n");
});

test("refuses a symlinked project root before creating its lock for package dot", async () => {
  const project = await fixture(false);
  const alias = join(dirname(project.root), `${project.root.split("/").at(-1)}-link`);
  await symlink(project.root, alias);
  roots.push(alias);
  const result = invoke(alias, ".", "simple", project.templateRoot);

  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    causeCode: "DOMAIN_UNSAFE_PROJECT_PATH",
    status: "refused",
  });
  expect(await Bun.file(join(project.root, ".cli-design-compose.lock")).exists()).toBe(false);
});

test("removes temporary files and newly created directories after publication failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  const target = join(root, "new", "nested", "created.ts");
  const fileSystem = fileSystemWith({
    link: async () => {
      throw new Error("injected publication failure");
    },
  });
  const creation: Creation = { bytes: new TextEncoder().encode("generated\n"), path: target };

  const error = await rejected(async () => await publish([creation], [], fileSystem));
  expect(error.causeCode).toBe("INTERNAL_COMPOSE_FAILURE");
  expect(await Bun.file(join(root, "new")).exists()).toBe(false);
  expect(await transactionArtifacts(root)).toEqual([]);
});

test("removes a partially copied stage when project staging fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  let stage: string | undefined;
  const fileSystem = fileSystemWith({
    copyTree: async (_source, destination) => {
      stage = destination;
      await writeFile(join(destination, "partial-copy"), "partial bytes\n");
      throw new Error("injected copy failure");
    },
  });

  await rejected(async () => await stageProject(root, fileSystem));
  expect(stage).toBeDefined();
  expect(await Bun.file(stage as string).exists()).toBe(false);
});

test("reports a partially copied stage when its cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-compose-transaction-"));
  roots.push(root);
  let stage: string | undefined;
  const fileSystem = fileSystemWith({
    copyTree: async (_source, destination) => {
      stage = destination;
      await writeFile(join(destination, "partial-copy"), "partial bytes\n");
      throw new Error("injected copy failure");
    },
    remove: async () => {
      throw new Error("injected cleanup failure");
    },
  });

  const error = await rejected(async () => await stageProject(root, fileSystem));
  expect(error.causeCode).toBe("DOMAIN_PARTIAL_COMPOSITION");
  expect(String(error.message)).toContain(stage as string);
  expect((await lstat(stage as string)).isDirectory()).toBe(true);
  await rm(stage as string, { force: true, recursive: true });
});

test.skipIf(process.getuid?.() === 0)(
  "restores the host project when a commit-phase write fails after earlier writes",
  async () => {
    const project = await fixture(false);
    // Complex sources write src/ first, then tests/; a read-only tests/ directory fails the later mkdir.
    const testsRoot = join(project.packageRoot, "tests");
    await mkdir(testsRoot, { mode: 0o500 });
    const treeBefore = await snapshotTree(project.root);
    const result = invokeFixture(project, "complex");
    await chmod(testsRoot, 0o700);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      causeCode: "INTERNAL_COMPOSE_FAILURE",
      status: "refused",
    });
    expect(JSON.parse(result.stdout).message).toContain("the host project was restored");
    expect(await Bun.file(join(project.packageRoot, "src/cli.ts")).exists()).toBe(false);
    expect(await Bun.file(join(project.packageRoot, ".cli-design-template.json")).exists()).toBe(false);
    expect(await snapshotTree(project.root)).toEqual(treeBefore);
  },
);

test("composes committed fixture bytes when its working tree drifts", async () => {
  const project = await fixture(false);
  const drift = "// working tree drift\n";
  await writeFile(join(project.templateRoot, "starters", "simple", "src", "cli.ts"), drift);

  const result = invokeFixture(project, "simple");
  expect(result.exitCode).toBe(0);
  const composed = await readFile(join(project.packageRoot, "src", "cli.ts"), "utf8");
  expect(composed).not.toBe(drift);
  expect(composed).toBe(FIXTURE_SIMPLE_CLI);
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
