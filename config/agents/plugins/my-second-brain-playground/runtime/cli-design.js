// @bun
// packages/cli-design-compose/src/main.ts
import { createHash, randomUUID } from "crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile
} from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { parseArgs } from "util";
var TEMPLATE_REVISION = "c829b46853afc699bb3f39fba42412ff557ab9c1";
var TEMPLATE_ROOT = resolve(process.env.BUN_TYPESCRIPT_TEMPLATE_ROOT ?? join(homedir(), "code", "bun-typescript-template"));
var COMPLEX_DEPENDENCIES = {
  "@logtape/logtape": "2.3.1",
  "@logtape/redaction": "2.3.1",
  zod: "4.4.3"
};
var COMPOSE_SCRIPT = "bun run src/cli.ts";
var PROJECT_LOCK = ".cli-design-compose.lock";
var nodeFileSystem = {
  copyTree: async (source, destination, filter) => {
    await cp(source, destination, { filter, recursive: true });
  },
  createDirectory: async (path) => {
    await mkdir(path);
  },
  createTemporaryDirectory: async (prefix) => await mkdtemp(prefix),
  link: async (source, destination) => {
    await link(source, destination);
  },
  lstat: async (path) => await lstat(path).catch(() => {
    return;
  }),
  read: async (path) => await readFile(path),
  removeDirectory: async (path) => {
    await rmdir(path);
  },
  remove: async (path, options) => {
    await rm(path, options);
  },
  rename: async (source, destination) => {
    await rename(source, destination);
  },
  writeExclusive: async (path, bytes) => {
    await writeFile(path, bytes, { flag: "wx" });
  }
};

class ComposeError extends Error {
  causeCode;
  exitCode;
  repairAction;
  constructor(causeCode, message, exitCode, repairAction) {
    super(message);
    this.causeCode = causeCode;
    this.exitCode = exitCode;
    this.repairAction = repairAction;
  }
}
function required(value, name) {
  if (value === undefined || value.trim() === "") {
    throw new ComposeError("USAGE_MISSING_ARGUMENT", `--${name} is required`, 2, "Supply every required compose-existing argument.");
  }
  return value;
}
function parseStarter(value) {
  if (value === "simple" || value === "complex")
    return value;
  throw new ComposeError("USAGE_INVALID_STARTER", `unsupported starter: ${value}`, 2, "Choose --starter simple or --starter complex.");
}
function validateSourcePacket(value) {
  if (isAbsolute(value))
    return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ComposeError("USAGE_INVALID_SOURCE_PACKET", "--source-packet must be an absolute path or HTTP(S) URL", 2, "Supply the canonical project packet as an absolute path or URL.");
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    const query = value.indexOf("?");
    const fragment = value.indexOf("#");
    const hasQuery = query >= 0 && (fragment < 0 || query < fragment);
    if (url.username !== "" || url.password !== "" || hasQuery) {
      throw new ComposeError("USAGE_INVALID_SOURCE_PACKET", "--source-packet HTTP(S) URLs cannot include credentials or query parameters", 2, "Supply a credential-free HTTP(S) URL without a query string.");
    }
    return value;
  }
  throw new ComposeError("USAGE_INVALID_SOURCE_PACKET", "--source-packet must be an absolute path or HTTP(S) URL", 2, "Supply the canonical project packet as an absolute path or URL.");
}
function parseOptions(args) {
  try {
    return parseArgs({
      allowPositionals: false,
      args,
      options: {
        json: { type: "boolean" },
        package: { type: "string" },
        "project-root": { type: "string" },
        "source-packet": { type: "string" },
        starter: { type: "string" }
      },
      strict: true
    }).values;
  } catch (error) {
    throw new ComposeError("USAGE_INVALID_ARGUMENTS", error instanceof Error ? error.message : "invalid compose-existing arguments", 2, "Run cli-design --help and correct the compose-existing options.");
  }
}
function parseInvocation(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return "help";
  }
  if (argv[0] !== "compose-existing") {
    throw new ComposeError("USAGE_UNKNOWN_COMMAND", `unsupported command: ${argv[0] ?? ""}`, 2, "Run cli-design --help and choose compose-existing.");
  }
  const values = parseOptions(argv.slice(1));
  return {
    json: values.json === true,
    packagePath: required(values.package, "package"),
    projectRoot: resolve(required(values["project-root"], "project-root")),
    sourcePacket: validateSourcePacket(required(values["source-packet"], "source-packet")),
    starter: parseStarter(required(values.starter, "starter"))
  };
}
function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || !path.startsWith("..") && !isAbsolute(path);
}
async function ordinaryFile(path, label) {
  const stats = await lstat(path).catch(() => {
    return;
  });
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
    throw new ComposeError("DOMAIN_PROJECT_PRECONDITION", `${label} must be an existing ordinary file`, 3, `Repair ${label} before composing the CLI.`);
  }
}
async function refuseSymlinkPath(root, target, includeTarget) {
  const relativePath = relative(root, target);
  if (relativePath === "")
    return;
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ComposeError("USAGE_PACKAGE_OUTSIDE_PROJECT", "composition paths must stay inside --project-root", 2, "Choose the owning Bun package relative to the project root.");
  }
  const segments = relativePath.split("/");
  if (!includeTarget)
    segments.pop();
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = await lstat(current).catch(() => {
      return;
    });
    if (stats === undefined)
      break;
    if (stats.isSymbolicLink()) {
      throw new ComposeError("DOMAIN_UNSAFE_PACKAGE_PATH", `composition path traverses a symbolic link: ${current}`, 3, "Choose an ordinary package path without symbolic-link ancestors.");
    }
    if (!stats.isDirectory()) {
      throw new ComposeError("DOMAIN_PROJECT_PRECONDITION", `composition path ancestor is not a directory: ${current}`, 3, "Repair the package directory before composing the CLI.");
    }
  }
}
async function resolveOwners(options) {
  const packagePath = resolve(options.projectRoot, options.packagePath);
  if (isAbsolute(options.packagePath) || !isInside(options.projectRoot, packagePath)) {
    throw new ComposeError("USAGE_PACKAGE_OUTSIDE_PROJECT", "--package must be a relative path inside --project-root", 2, "Choose the owning Bun package relative to the project root.");
  }
  await refuseSymlinkPath(options.projectRoot, packagePath, true);
  await ordinaryFile(join(options.projectRoot, "package.json"), "project package.json");
  await ordinaryFile(join(options.projectRoot, "bun.lock"), "project bun.lock");
  await ordinaryFile(join(packagePath, "package.json"), "target package.json");
  await requireWorkspaceMember(options.projectRoot, packagePath);
  return { packagePath };
}
function workspacePatterns(manifest) {
  const declared = manifest.workspaces;
  const patterns = Array.isArray(declared) ? declared : declared === undefined ? [] : record(declared, "project package.json workspaces").packages;
  return Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === "string") : [];
}
async function requireWorkspaceMember(projectRoot, packagePath) {
  const member = relative(projectRoot, packagePath).split("\\").join("/");
  if (member === "")
    return;
  const manifest = await readManifest(join(projectRoot, "package.json"), "project package.json");
  if (workspacePatterns(manifest).some((pattern) => new Bun.Glob(pattern).match(member)))
    return;
  throw new ComposeError("USAGE_PACKAGE_NOT_WORKSPACE_MEMBER", "--package must be . or a declared workspace member of --project-root", 2, "Declare the package under the project workspaces or choose a member package.");
}
function git(...args) {
  const result = Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) {
    throw new ComposeError("INTERNAL_TEMPLATE_REVISION_UNAVAILABLE", `canonical template revision is unavailable: ${TEMPLATE_REVISION}`, 1, "Fetch the pinned bun-typescript-template revision and retry.");
  }
  return result.stdout.toString();
}
function templateFiles(starter) {
  git("cat-file", "-e", `${TEMPLATE_REVISION}^{commit}`);
  const prefix = `starters/${starter}/`;
  const paths = git("ls-tree", "-r", "--name-only", TEMPLATE_REVISION, "--", prefix).trim().split(`
`).filter((path) => path.startsWith(`${prefix}src/`) || path.startsWith(`${prefix}tests/`));
  if (paths.length === 0) {
    throw new ComposeError("INTERNAL_TEMPLATE_SOURCE_MISSING", `no ${starter} starter source exists at the pinned revision`, 1, "Repair the canonical template revision before retrying.");
  }
  return paths.map((path) => {
    const result = Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, "show", `${TEMPLATE_REVISION}:${path}`], { stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) {
      throw new ComposeError("INTERNAL_TEMPLATE_SOURCE_MISSING", `cannot read pinned template source: ${path}`, 1, "Repair the canonical template revision before retrying.");
    }
    return { bytes: result.stdout, relativePath: path.slice(prefix.length) };
  });
}
function record(value, label = "target package.json") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComposeError("SCHEMA_INVALID_PACKAGE", `${label} must contain an object`, 3, `Repair ${label} before retrying.`);
  }
  return value;
}
async function readManifest(path, label) {
  const text = await readFile(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ComposeError("SCHEMA_INVALID_PACKAGE", `${label} must contain valid JSON`, 3, `Repair ${label} before retrying.`);
  }
  return record(parsed, label);
}
function stringRecord(value, label) {
  if (value === undefined)
    return {};
  const values = record(value);
  for (const [name, entry] of Object.entries(values)) {
    if (typeof entry !== "string") {
      throw new ComposeError("SCHEMA_INVALID_PACKAGE", `${label}.${name} must be a string`, 3, "Repair the target package manifest before retrying.");
    }
  }
  return values;
}
var OTHER_DEPENDENCY_SECTIONS = [
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];
function refuseForeignDeclaration(packageJson, name, version) {
  for (const section of OTHER_DEPENDENCY_SECTIONS) {
    if (stringRecord(packageJson[section], section)[name] !== undefined) {
      throw new ComposeError("DOMAIN_DEPENDENCY_CONFLICT", `${name} is already declared under ${section}`, 3, `Reconcile ${name} under dependencies at ${version} before composing.`);
    }
  }
}
function addExactDependencies(packageJson, starter) {
  const dependencies = stringRecord(packageJson.dependencies, "dependencies");
  if (starter === "complex") {
    for (const [name, version] of Object.entries(COMPLEX_DEPENDENCIES)) {
      refuseForeignDeclaration(packageJson, name, version);
      const current = dependencies[name];
      if (current !== undefined && current !== version) {
        throw new ComposeError("DOMAIN_DEPENDENCY_CONFLICT", `${name} is already pinned to ${current}`, 3, `Reconcile ${name} with the required ${version} pin before composing.`);
      }
      dependencies[name] = version;
    }
  }
  if (Object.keys(dependencies).length > 0)
    packageJson.dependencies = dependencies;
}
function addComposeScript(packageJson) {
  const scripts = stringRecord(packageJson.scripts, "scripts");
  const current = scripts["cli:example"];
  if (current !== undefined && current !== COMPOSE_SCRIPT) {
    throw new ComposeError("DOMAIN_SCRIPT_CONFLICT", "target package already owns a different cli:example script", 3, "Rename or reconcile the existing script before composing.");
  }
  scripts["cli:example"] = COMPOSE_SCRIPT;
  packageJson.scripts = scripts;
}
async function updatedPackage(path, starter) {
  const parsed = await readManifest(path, "target package.json");
  addExactDependencies(parsed, starter);
  addComposeScript(parsed);
  return new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}
`);
}
function ignoredStagePath(source) {
  const name = source.split("/").at(-1);
  return name === ".git" || name === "node_modules" || name === ".fallow" || name === PROJECT_LOCK;
}
async function stageProject(projectRoot, fileSystem = nodeFileSystem) {
  const stage = await fileSystem.createTemporaryDirectory(join(tmpdir(), "cli-design-compose-"));
  try {
    await fileSystem.copyTree(projectRoot, stage, (source) => !ignoredStagePath(source));
    return stage;
  } catch (error) {
    try {
      await fileSystem.remove(stage, { force: true, recursive: true });
    } catch {
      throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `staged project cleanup failed; unresolved effects: ${stage}`, 3, "Preserve and inspect the listed path before retrying.");
    }
    throw error;
  }
}
async function regenerateLock(options, updatedManifest) {
  const stage = await stageProject(options.projectRoot);
  let lock;
  let problem;
  try {
    const stagePackage = resolve(stage, options.packagePath, "package.json");
    await writeFile(stagePackage, updatedManifest);
    const result = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], { cwd: stage, stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) {
      throw new ComposeError("DOMAIN_LOCKFILE_UPDATE_REFUSED", "Bun could not generate a compatible lockfile in the isolated stage", 3, "Repair the workspace or dependency constraints, then retry.");
    }
    lock = await readFile(join(stage, "bun.lock"));
  } catch (error) {
    problem = error;
  }
  try {
    await rm(stage, { force: true, recursive: true });
  } catch {
    throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `staged project cleanup failed; unresolved effects: ${stage}`, 3, "Preserve and inspect the listed path before retrying.");
  }
  if (problem !== undefined)
    throw problem;
  if (lock !== undefined)
    return lock;
  throw new Error("lockfile regeneration finished without a result");
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function requireAbsent(path) {
  if (await lstat(path).catch(() => {
    return;
  }) !== undefined) {
    throw new ComposeError("DOMAIN_TARGET_COLLISION", `composition target already exists: ${path}`, 3, "Choose a clean package or reconcile the existing file explicitly.");
  }
}

class TransactionIssue extends Error {
  kind;
  unresolved;
  constructor(kind, message, unresolved = []) {
    super(message);
    this.kind = kind;
    this.unresolved = unresolved;
  }
}
function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
function uniqueSibling(path, kind) {
  return `${path}.cli-design-${randomUUID()}.${kind}`;
}
function sameBytes(left, right) {
  return hash(left) === hash(right);
}
async function ensureDirectory(path, state, fileSystem) {
  const stats = await fileSystem.lstat(path);
  if (stats?.isDirectory() && !stats.isSymbolicLink())
    return;
  if (stats !== undefined) {
    throw new TransactionIssue("collision", `composition directory is not ordinary: ${path}`);
  }
  await ensureDirectory(dirname(path), state, fileSystem);
  try {
    await fileSystem.createDirectory(path);
    state.createdDirectories.push(path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw error;
    const concurrent = await fileSystem.lstat(path);
    if (!concurrent?.isDirectory() || concurrent.isSymbolicLink()) {
      throw new TransactionIssue("collision", `composition directory appeared concurrently: ${path}`);
    }
  }
}
async function removeOwnedPath(path, fileSystem, recursive = false) {
  try {
    await fileSystem.remove(path, { force: true, ...recursive ? { recursive: true } : {} });
    return [];
  } catch {
    return [path];
  }
}
async function restoreCaptured(captured, target, fileSystem) {
  try {
    await fileSystem.link(captured, target);
  } catch {
    return [captured, target];
  }
  return await removeOwnedPath(captured, fileSystem);
}
async function captureExpected(path, expected, fileSystem) {
  const backup = uniqueSibling(path, "backup");
  try {
    await fileSystem.rename(path, backup);
  } catch (error) {
    throw new TransactionIssue(errorCode(error) === "ENOENT" ? "concurrent" : "internal", errorCode(error) === "ENOENT" ? `composition target disappeared concurrently: ${path}` : error instanceof Error ? error.message : `cannot capture ${path}`);
  }
  let current;
  try {
    current = await fileSystem.read(backup);
  } catch (error) {
    const unresolved2 = await restoreCaptured(backup, path, fileSystem);
    throw new TransactionIssue(unresolved2.length === 0 ? "internal" : "partial", error instanceof Error ? error.message : `cannot inspect ${path}`, unresolved2);
  }
  if (sameBytes(current, expected))
    return backup;
  const unresolved = await restoreCaptured(backup, path, fileSystem);
  throw new TransactionIssue(unresolved.length === 0 ? "concurrent" : "partial", `composition target changed concurrently: ${path}`, unresolved);
}
async function cleanupTemporary(temporary, fileSystem) {
  return await removeOwnedPath(temporary, fileSystem);
}
async function writeNewFile(file, state, fileSystem) {
  await ensureDirectory(dirname(file.path), state, fileSystem);
  const temporary = uniqueSibling(file.path, "tmp");
  let temporaryOwned = false;
  let targetClaimAttempted = false;
  let problem;
  try {
    await fileSystem.writeExclusive(temporary, file.bytes);
    temporaryOwned = true;
    targetClaimAttempted = true;
    await fileSystem.link(temporary, file.path);
    state.created.push(file);
  } catch (error) {
    problem = errorCode(error) === "EEXIST" ? new TransactionIssue("collision", targetClaimAttempted ? `composition target appeared concurrently: ${file.path}` : `temporary publication path collided while creating: ${file.path}`) : error;
  }
  const unresolved = temporaryOwned ? await cleanupTemporary(temporary, fileSystem) : [];
  if (unresolved.length > 0) {
    throw new TransactionIssue("partial", `temporary publication file remains: ${temporary}`, unresolved);
  }
  if (problem !== undefined)
    throw problem;
}
function classifyReplacementFailure(error, temporaryOwned, path) {
  if (temporaryOwned || errorCode(error) !== "EEXIST")
    return error;
  return new TransactionIssue("collision", `temporary replacement path collided while replacing: ${path}`);
}
async function recoverReplacementFailure(error, temporaryOwned, backup, path, fileSystem) {
  const problem = classifyReplacementFailure(error, temporaryOwned, path);
  if (backup === undefined)
    return problem;
  const restored = await restoreCaptured(backup, path, fileSystem);
  if (restored.length === 0)
    return problem;
  return new TransactionIssue("partial", errorCode(error) === "EEXIST" ? `composition target appeared during replacement: ${path}` : error instanceof Error ? error.message : `replacement failed for ${path}`, restored);
}
async function replaceFile(file, state, fileSystem) {
  const temporary = uniqueSibling(file.path, "tmp");
  let temporaryOwned = false;
  let backup;
  let problem;
  try {
    await fileSystem.writeExclusive(temporary, file.bytes);
    temporaryOwned = true;
    backup = await captureExpected(file.path, file.original, fileSystem);
    await fileSystem.link(temporary, file.path);
    state.replaced.push({ ...file, backup });
  } catch (error) {
    problem = await recoverReplacementFailure(error, temporaryOwned, backup, file.path, fileSystem);
  }
  const unresolved = temporaryOwned ? await cleanupTemporary(temporary, fileSystem) : [];
  if (unresolved.length > 0) {
    throw new TransactionIssue("partial", `temporary replacement file remains: ${temporary}`, [
      ...unresolved,
      ...problem instanceof TransactionIssue ? problem.unresolved : []
    ]);
  }
  if (problem !== undefined)
    throw problem;
}
async function rollbackCreation(file, fileSystem) {
  const captured = uniqueSibling(file.path, "current");
  try {
    await fileSystem.rename(file.path, captured);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? [] : [file.path];
  }
  const current = await fileSystem.read(captured).catch(() => {
    return;
  });
  if (current !== undefined && sameBytes(current, file.bytes)) {
    return await removeOwnedPath(captured, fileSystem);
  }
  const unresolved = await restoreCaptured(captured, file.path, fileSystem);
  return [...new Set([file.path, ...unresolved])];
}
async function rollbackReplacement(file, fileSystem) {
  const captured = uniqueSibling(file.path, "current");
  try {
    await fileSystem.rename(file.path, captured);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      return [file.path, file.backup];
    return await restoreCaptured(file.backup, file.path, fileSystem);
  }
  const current = await fileSystem.read(captured).catch(() => {
    return;
  });
  if (current === undefined || !sameBytes(current, file.bytes)) {
    const restored2 = await restoreCaptured(captured, file.path, fileSystem);
    return [...new Set([file.path, file.backup, ...restored2])];
  }
  const restored = await restoreCaptured(file.backup, file.path, fileSystem);
  if (restored.length > 0)
    return [...new Set([captured, ...restored])];
  return await removeOwnedPath(captured, fileSystem);
}
async function rollbackPublication(state, fileSystem) {
  const unresolved = [];
  for (const file of state.replaced.toReversed()) {
    unresolved.push(...await rollbackReplacement(file, fileSystem));
  }
  for (const file of state.created.toReversed()) {
    unresolved.push(...await rollbackCreation(file, fileSystem));
  }
  for (const path of state.createdDirectories.toReversed()) {
    try {
      await fileSystem.removeDirectory(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        unresolved.push(path);
    }
  }
  return [...new Set(unresolved)];
}
function publicationError(error, unresolved) {
  const issue = error instanceof TransactionIssue ? error : new TransactionIssue("internal", error instanceof Error ? error.message : "unexpected publish failure");
  const remaining = [...new Set([...issue.unresolved, ...unresolved])];
  if (remaining.length > 0 || issue.kind === "partial") {
    return new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `${issue.message}; unresolved effects: ${remaining.join(", ")}`, 3, "Preserve and inspect the listed paths before retrying.");
  }
  if (issue.kind === "collision") {
    return new ComposeError("DOMAIN_TARGET_COLLISION", `${issue.message}; the host project was restored`, 3, "Inspect the competing file and retry from the new state.");
  }
  if (issue.kind === "concurrent") {
    return new ComposeError("DOMAIN_CONCURRENT_CHANGE", `${issue.message}; the host project was restored`, 3, "Inspect the concurrent edit and retry from the new state.");
  }
  return new ComposeError("INTERNAL_COMPOSE_FAILURE", `${issue.message}; the host project was restored`, 1, "Inspect the project and pinned template before retrying.");
}
async function removeBackups(replaced, fileSystem) {
  const unresolved = [];
  for (const file of replaced) {
    unresolved.push(...await removeOwnedPath(file.backup, fileSystem));
  }
  return unresolved;
}
async function publish(creations, replacements, fileSystem = nodeFileSystem) {
  const state = { created: [], createdDirectories: [], replaced: [] };
  try {
    for (const file of creations)
      await writeNewFile(file, state, fileSystem);
    for (const file of replacements)
      await replaceFile(file, state, fileSystem);
  } catch (error) {
    throw publicationError(error, await rollbackPublication(state, fileSystem));
  }
  const unresolved = await removeBackups(state.replaced, fileSystem);
  if (unresolved.length > 0) {
    throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `composition completed with retained recovery files: ${unresolved.join(", ")}`, 3, "Preserve and inspect the listed paths before retrying.");
  }
}
async function releaseProjectLock(path, token, fileSystem) {
  const current = await fileSystem.read(path).catch(() => {
    return;
  });
  if (current === undefined || !sameBytes(current, token))
    return [path];
  return await removeOwnedPath(path, fileSystem);
}
async function withProjectLock(projectRoot, action, fileSystem = nodeFileSystem) {
  const path = join(projectRoot, PROJECT_LOCK);
  const token = new TextEncoder().encode(randomUUID());
  try {
    await fileSystem.writeExclusive(path, token);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new ComposeError("DOMAIN_PROJECT_BUSY", "another cli-design composition owns the project transaction", 3, `Wait for or recover ${path} before retrying.`);
    }
    throw error;
  }
  let result;
  let problem;
  try {
    result = await action();
  } catch (error) {
    problem = error;
  }
  const unresolved = await releaseProjectLock(path, token, fileSystem);
  if (unresolved.length > 0) {
    throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `project transaction lock could not be released; unresolved effects: ${unresolved.join(", ")}`, 3, "Preserve and inspect the listed path before retrying.");
  }
  if (problem !== undefined)
    throw problem;
  return result;
}
async function composeLocked(options) {
  const { packagePath } = await resolveOwners(options);
  const packageFile = join(packagePath, "package.json");
  const lockFile = join(options.projectRoot, "bun.lock");
  const originalPackage = await readFile(packageFile);
  const originalLock = await readFile(lockFile);
  const sources = templateFiles(options.starter);
  const metadataPath = join(packagePath, ".cli-design-template.json");
  for (const source of sources) {
    const target = join(packagePath, source.relativePath);
    await refuseSymlinkPath(packagePath, target, false);
    await requireAbsent(target);
  }
  await requireAbsent(metadataPath);
  const nextPackage = await updatedPackage(packageFile, options.starter);
  const nextLock = await regenerateLock(options, nextPackage);
  if (hash(await readFile(packageFile)) !== hash(originalPackage)) {
    throw new ComposeError("DOMAIN_CONCURRENT_CHANGE", "target package.json changed during preparation", 3, "Inspect the concurrent edit and retry from the new state.");
  }
  if (hash(await readFile(lockFile)) !== hash(originalLock)) {
    throw new ComposeError("DOMAIN_CONCURRENT_CHANGE", "bun.lock changed during preparation", 3, "Inspect the concurrent edit and retry from the new state.");
  }
  const metadata = new TextEncoder().encode(`${JSON.stringify({
    sourcePacket: options.sourcePacket,
    starter: options.starter,
    templateRevision: TEMPLATE_REVISION
  }, null, 2)}
`);
  await publish([
    ...sources.map((source) => ({
      bytes: source.bytes,
      path: join(packagePath, source.relativePath)
    })),
    { bytes: metadata, path: metadataPath }
  ], [
    { bytes: nextPackage, original: originalPackage, path: packageFile },
    { bytes: nextLock, original: originalLock, path: lockFile }
  ]);
  return {
    package: relative(options.projectRoot, packagePath) || ".",
    projectRoot: options.projectRoot,
    sourcePacket: options.sourcePacket,
    starter: options.starter,
    status: "composed",
    templateRevision: TEMPLATE_REVISION,
    writtenFiles: [...sources.map((source) => source.relativePath), ".cli-design-template.json"].sort()
  };
}
async function compose(options) {
  await ordinaryFile(join(options.projectRoot, "package.json"), "project package.json");
  return await withProjectLock(options.projectRoot, async () => await composeLocked(options));
}
var HELP = `Compose the canonical Bun CLI starter into an existing Bun project.

Usage:
  bun run cli-design compose-existing --project-root PATH --package PATH --starter simple|complex --source-packet PATH_OR_URL [--json]

The package path is relative to the project root. Existing source files,
conflicting scripts and incompatible dependency pins are refused before writes.
`;
function hasJson(argv) {
  return argv.includes("--json");
}
function failure(error, json) {
  const known = error instanceof ComposeError ? error : new ComposeError("INTERNAL_COMPOSE_FAILURE", error instanceof Error ? error.message : "unexpected compose failure", 1, "Inspect the project and pinned template before retrying.");
  if (json) {
    process.stdout.write(`${JSON.stringify({
      causeCode: known.causeCode,
      message: known.message,
      repairAction: known.repairAction,
      status: "refused"
    })}
`);
  } else {
    process.stderr.write(`cli-design: ${known.message}; ${known.repairAction}
`);
  }
  return known.exitCode;
}
async function main(argv) {
  const json = hasJson(argv);
  try {
    const invocation = parseInvocation(argv);
    if (invocation === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(await compose(invocation))}
`);
    return 0;
  } catch (error) {
    return failure(error, json);
  }
}
if (import.meta.main)
  process.exitCode = await main(process.argv.slice(2));
export {
  nodeFileSystem,
  publish,
  stageProject
};
