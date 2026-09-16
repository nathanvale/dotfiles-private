import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
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
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const TEMPLATE_REVISION = "7f6d95017e051c23e978f5d7f7542732b799dfdc";
const TEMPLATE_ROOT = resolve(
  process.env.BUN_TYPESCRIPT_TEMPLATE_ROOT ??
    join(homedir(), "code", "bun-typescript-template"),
);
const COMPLEX_DEPENDENCIES = {
  "@logtape/logtape": "2.3.1",
  "@logtape/redaction": "2.3.1",
  zod: "4.4.3",
} as const;
const COMPOSE_SCRIPT = "bun run src/cli.ts";
const PROJECT_LOCK = ".cli-design-compose.lock";

type Starter = "complex" | "simple";

interface ComposeOptions {
  json: boolean;
  packagePath: string;
  projectRoot: string;
  sourcePacket: string;
  starter: Starter;
}

interface PlannedFile {
  bytes: Uint8Array;
  relativePath: string;
}

export interface FileSystemAdapter {
  copyTree(source: string, destination: string, filter: (source: string) => boolean): Promise<void>;
  createDirectory(path: string): Promise<void>;
  createTemporaryDirectory(prefix: string): Promise<string>;
  link(source: string, destination: string): Promise<void>;
  lstat(path: string): Promise<Stats | undefined>;
  read(path: string): Promise<Uint8Array>;
  removeDirectory(path: string): Promise<void>;
  remove(path: string, options: { force: boolean; recursive?: boolean }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
}

export const nodeFileSystem: FileSystemAdapter = {
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
  lstat: async (path) => await lstat(path).catch(() => undefined),
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
  },
};

class ComposeError extends Error {
  constructor(
    readonly causeCode: string,
    message: string,
    readonly exitCode: 1 | 2 | 3,
    readonly repairAction: string,
    readonly unresolvedEffects: string[] = [],
  ) {
    super(message);
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new ComposeError(
      "USAGE_MISSING_ARGUMENT",
      `--${name} is required`,
      2,
      "Supply every required compose-existing argument.",
    );
  }
  return value;
}

function parseStarter(value: string): Starter {
  if (value === "simple" || value === "complex") return value;
  throw new ComposeError(
    "USAGE_INVALID_STARTER",
    `unsupported starter: ${value}`,
    2,
    "Choose --starter simple or --starter complex.",
  );
}

function validateSourcePacket(value: string): string {
  if (isAbsolute(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The refusal below owns invalid URL and relative path inputs.
    throw new ComposeError(
      "USAGE_INVALID_SOURCE_PACKET",
      "--source-packet must be an absolute path or HTTP(S) URL",
      2,
      "Supply the canonical project packet as an absolute path or URL.",
    );
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    const query = value.indexOf("?");
    const fragment = value.indexOf("#");
    const hasQuery = query >= 0 && (fragment < 0 || query < fragment);
    if (url.username !== "" || url.password !== "" || hasQuery) {
      throw new ComposeError(
        "USAGE_INVALID_SOURCE_PACKET",
        "--source-packet HTTP(S) URLs cannot include credentials or query parameters",
        2,
        "Supply a credential-free HTTP(S) URL without a query string.",
      );
    }
    return value;
  }
  throw new ComposeError(
    "USAGE_INVALID_SOURCE_PACKET",
    "--source-packet must be an absolute path or HTTP(S) URL",
    2,
    "Supply the canonical project packet as an absolute path or URL.",
  );
}

function parseOptions(args: string[]) {
  try {
    return parseArgs({
      allowPositionals: false,
      args,
      options: {
        json: { type: "boolean" },
        package: { type: "string" },
        "project-root": { type: "string" },
        "source-packet": { type: "string" },
        starter: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    throw new ComposeError(
      "USAGE_INVALID_ARGUMENTS",
      error instanceof Error ? error.message : "invalid compose-existing arguments",
      2,
      "Run cli-design --help and correct the compose-existing options.",
    );
  }
}

function parseInvocation(argv: string[]): ComposeOptions | "help" {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return "help";
  }
  if (argv[0] !== "compose-existing") {
    throw new ComposeError(
      "USAGE_UNKNOWN_COMMAND",
      `unsupported command: ${argv[0] ?? ""}`,
      2,
      "Run cli-design --help and choose compose-existing.",
    );
  }
  const values = parseOptions(argv.slice(1));
  return {
    json: values.json === true,
    packagePath: required(values.package, "package"),
    projectRoot: resolve(required(values["project-root"], "project-root")),
    sourcePacket: validateSourcePacket(
      required(values["source-packet"], "source-packet"),
    ),
    starter: parseStarter(required(values.starter, "starter")),
  };
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function ordinaryFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
    throw new ComposeError(
      "DOMAIN_PROJECT_PRECONDITION",
      `${label} must be an existing ordinary file`,
      3,
      `Repair ${label} before composing the CLI.`,
    );
  }
}

async function refuseSymlinkPath(
  root: string,
  target: string,
  includeTarget: boolean,
): Promise<void> {
  const relativePath = relative(root, target);
  if (relativePath === "") return;
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ComposeError(
      "USAGE_PACKAGE_OUTSIDE_PROJECT",
      "composition paths must stay inside --project-root",
      2,
      "Choose the owning Bun package relative to the project root.",
    );
  }
  const segments = relativePath.split("/");
  if (!includeTarget) segments.pop();
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = await lstat(current).catch(() => undefined);
    if (stats === undefined) break;
    if (stats.isSymbolicLink()) {
      throw new ComposeError(
        "DOMAIN_UNSAFE_PACKAGE_PATH",
        `composition path traverses a symbolic link: ${current}`,
        3,
        "Choose an ordinary package path without symbolic-link ancestors.",
      );
    }
    if (!stats.isDirectory()) {
      throw new ComposeError(
        "DOMAIN_PROJECT_PRECONDITION",
        `composition path ancestor is not a directory: ${current}`,
        3,
        "Repair the package directory before composing the CLI.",
      );
    }
  }
}

// Project-root validation happens before the transaction lock is claimed. A lexical
// resolve deliberately preserves the caller's supplied physical path so that a
// symlinked root, including --package ., cannot gain write authority.
async function refuseSymlinkProjectRoot(projectRoot: string): Promise<void> {
  const absolute = resolve(projectRoot);
  const parsed = parse(absolute);
  const segments = relative(parsed.root, absolute).split(/[\\/]/).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = await lstat(current).catch(() => undefined);
    if (stats?.isSymbolicLink()) {
      throw new ComposeError(
        "DOMAIN_UNSAFE_PROJECT_PATH",
        `project root traverses a symbolic link: ${current}`,
        3,
        "Choose an ordinary project root without symbolic-link ancestors.",
      );
    }
    if (stats !== undefined && !stats.isDirectory()) {
      throw new ComposeError(
        "DOMAIN_PROJECT_PRECONDITION",
        `project root ancestor is not a directory: ${current}`,
        3,
        "Repair the project root before composing the CLI.",
      );
    }
  }
}

async function resolveOwners(options: ComposeOptions) {
  const packagePath = resolve(options.projectRoot, options.packagePath);
  if (isAbsolute(options.packagePath) || !isInside(options.projectRoot, packagePath)) {
    throw new ComposeError(
      "USAGE_PACKAGE_OUTSIDE_PROJECT",
      "--package must be a relative path inside --project-root",
      2,
      "Choose the owning Bun package relative to the project root.",
    );
  }
  await refuseSymlinkPath(options.projectRoot, packagePath, true);
  await ordinaryFile(join(options.projectRoot, "package.json"), "project package.json");
  await ordinaryFile(join(options.projectRoot, "bun.lock"), "project bun.lock");
  await ordinaryFile(join(packagePath, "package.json"), "target package.json");
  await requireWorkspaceMember(options.projectRoot, packagePath);
  return { packagePath };
}

function workspacePatterns(manifest: Record<string, unknown>): string[] {
  const declared = manifest.workspaces;
  const patterns = Array.isArray(declared)
    ? declared
    : declared === undefined
      ? []
      : record(declared, "project package.json workspaces").packages;
  return Array.isArray(patterns)
    ? patterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
}

// Bun regenerates the lock from the root workspace only, so an undeclared nested
// package would report composed while its pins never reach bun.lock.
async function requireWorkspaceMember(projectRoot: string, packagePath: string): Promise<void> {
  const member = relative(projectRoot, packagePath).split("\\").join("/");
  if (member === "") return;
  const manifest = await readManifest(join(projectRoot, "package.json"), "project package.json");
  if (workspacePatterns(manifest).some((pattern) => new Bun.Glob(pattern).match(member))) return;
  throw new ComposeError(
    "USAGE_PACKAGE_NOT_WORKSPACE_MEMBER",
    "--package must be . or a declared workspace member of --project-root",
    2,
    "Declare the package under the project workspaces or choose a member package.",
  );
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new ComposeError(
      "INTERNAL_TEMPLATE_REVISION_UNAVAILABLE",
      `canonical template revision is unavailable: ${TEMPLATE_REVISION}`,
      1,
      "Fetch the pinned bun-typescript-template revision and retry.",
    );
  }
  return result.stdout.toString();
}

function templateFiles(starter: Starter): PlannedFile[] {
  git("cat-file", "-e", `${TEMPLATE_REVISION}^{commit}`);
  const prefix = `starters/${starter}/`;
  const paths = git("ls-tree", "-r", "--name-only", TEMPLATE_REVISION, "--", prefix)
    .trim()
    .split("\n")
    .filter((path) => path.startsWith(`${prefix}src/`) || path.startsWith(`${prefix}tests/`));
  if (paths.length === 0) {
    throw new ComposeError(
      "INTERNAL_TEMPLATE_SOURCE_MISSING",
      `no ${starter} starter source exists at the pinned revision`,
      1,
      "Repair the canonical template revision before retrying.",
    );
  }
  return paths.map((path) => {
    const result = Bun.spawnSync(
      ["git", "-C", TEMPLATE_ROOT, "show", `${TEMPLATE_REVISION}:${path}`],
      { stderr: "pipe", stdout: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new ComposeError(
        "INTERNAL_TEMPLATE_SOURCE_MISSING",
        `cannot read pinned template source: ${path}`,
        1,
        "Repair the canonical template revision before retrying.",
      );
    }
    return { bytes: result.stdout, relativePath: path.slice(prefix.length) };
  });
}

function record(value: unknown, label = "target package.json"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComposeError(
      "SCHEMA_INVALID_PACKAGE",
      `${label} must contain an object`,
      3,
      `Repair ${label} before retrying.`,
    );
  }
  return value as Record<string, unknown>;
}

async function readManifest(path: string, label: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ComposeError(
      "SCHEMA_INVALID_PACKAGE",
      `${label} must contain valid JSON`,
      3,
      `Repair ${label} before retrying.`,
    );
  }
  return record(parsed, label);
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const values = record(value);
  for (const [name, entry] of Object.entries(values)) {
    if (typeof entry !== "string") {
      throw new ComposeError(
        "SCHEMA_INVALID_PACKAGE",
        `${label}.${name} must be a string`,
        3,
        "Repair the target package manifest before retrying.",
      );
    }
  }
  return values as Record<string, string>;
}

const OTHER_DEPENDENCY_SECTIONS = [
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function refuseForeignDeclaration(
  packageJson: Record<string, unknown>,
  name: string,
  version: string,
): void {
  for (const section of OTHER_DEPENDENCY_SECTIONS) {
    if (stringRecord(packageJson[section], section)[name] !== undefined) {
      throw new ComposeError(
        "DOMAIN_DEPENDENCY_CONFLICT",
        `${name} is already declared under ${section}`,
        3,
        `Reconcile ${name} under dependencies at ${version} before composing.`,
      );
    }
  }
}

function addExactDependencies(
  packageJson: Record<string, unknown>,
  starter: Starter,
): void {
  const dependencies = stringRecord(packageJson.dependencies, "dependencies");
  if (starter === "complex") {
    for (const [name, version] of Object.entries(COMPLEX_DEPENDENCIES)) {
      refuseForeignDeclaration(packageJson, name, version);
      const current = dependencies[name];
      if (current !== undefined && current !== version) {
        throw new ComposeError(
          "DOMAIN_DEPENDENCY_CONFLICT",
          `${name} is already pinned to ${current}`,
          3,
          `Reconcile ${name} with the required ${version} pin before composing.`,
        );
      }
      dependencies[name] = version;
    }
  }
  if (Object.keys(dependencies).length > 0) packageJson.dependencies = dependencies;
}

function addComposeScript(packageJson: Record<string, unknown>): void {
  const scripts = stringRecord(packageJson.scripts, "scripts");
  const current = scripts["cli:example"];
  if (current !== undefined && current !== COMPOSE_SCRIPT) {
    throw new ComposeError(
      "DOMAIN_SCRIPT_CONFLICT",
      "target package already owns a different cli:example script",
      3,
      "Rename or reconcile the existing script before composing.",
    );
  }
  scripts["cli:example"] = COMPOSE_SCRIPT;
  packageJson.scripts = scripts;
}

async function updatedPackage(path: string, starter: Starter): Promise<Uint8Array> {
  const parsed = await readManifest(path, "target package.json");
  addExactDependencies(parsed, starter);
  addComposeScript(parsed);
  return new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`);
}

function ignoredStagePath(source: string): boolean {
  const name = source.split("/").at(-1);
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".fallow" ||
    name === PROJECT_LOCK
  );
}

export async function stageProject(
  projectRoot: string,
  fileSystem: FileSystemAdapter = nodeFileSystem,
): Promise<string> {
  const stage = await fileSystem.createTemporaryDirectory(join(tmpdir(), "cli-design-compose-"));
  try {
    await fileSystem.copyTree(projectRoot, stage, (source) => !ignoredStagePath(source));
    return stage;
  } catch (error) {
    try {
      await fileSystem.remove(stage, { force: true, recursive: true });
    } catch {
      throw new ComposeError(
        "DOMAIN_PARTIAL_COMPOSITION",
        `staged project cleanup failed; unresolved effects: ${stage}`,
        3,
        "Preserve and inspect the listed path before retrying.",
        [stage],
      );
    }
    throw error;
  }
}

async function regenerateLock(
  options: ComposeOptions,
  updatedManifest: Uint8Array,
): Promise<Uint8Array> {
  const stage = await stageProject(options.projectRoot);
  let lock: Uint8Array | undefined;
  let problem: unknown;
  try {
    const stagePackage = resolve(stage, options.packagePath, "package.json");
    await writeFile(stagePackage, updatedManifest);
    const result = Bun.spawnSync(
      [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
      { cwd: stage, stderr: "pipe", stdout: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new ComposeError(
        "DOMAIN_LOCKFILE_UPDATE_REFUSED",
        "Bun could not generate a compatible lockfile in the isolated stage",
        3,
        "Repair the workspace or dependency constraints, then retry.",
      );
    }
    lock = await readFile(join(stage, "bun.lock"));
  } catch (error) {
    problem = error;
  }
  try {
    await rm(stage, { force: true, recursive: true });
  } catch {
    throw new ComposeError(
      "DOMAIN_PARTIAL_COMPOSITION",
      `staged project cleanup failed; unresolved effects: ${stage}`,
      3,
      "Preserve and inspect the listed path before retrying.",
      [stage],
    );
  }
  if (problem !== undefined) throw problem;
  if (lock !== undefined) return lock;
  throw new Error("lockfile regeneration finished without a result");
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface LockInputSnapshot {
  bytes: Uint8Array;
  path: string;
}

export async function snapshotLockInputs(projectRoot: string): Promise<LockInputSnapshot[]> {
  const rootManifestPath = join(projectRoot, "package.json");
  const rootManifest = await readManifest(rootManifestPath, "project package.json");
  const paths = new Set([rootManifestPath, join(projectRoot, "bun.lock")]);
  for (const pattern of workspacePatterns(rootManifest)) {
    const manifestPattern = `${pattern.replace(/\/$/, "")}/package.json`;
    for await (const path of new Bun.Glob(manifestPattern).scan({
      cwd: projectRoot,
      onlyFiles: true,
    })) {
      paths.add(join(projectRoot, path));
    }
  }
  return await Promise.all(
    [...paths]
      .sort()
      .map(async (path) => ({ bytes: await readFile(path), path })),
  );
}

function snapshotBytes(inputs: LockInputSnapshot[], path: string): Uint8Array {
  const input = inputs.find((candidate) => candidate.path === path);
  if (input === undefined) throw new Error(`missing lock input snapshot: ${path}`);
  return input.bytes;
}

export async function requireUnchangedLockInputs(
  projectRoot: string,
  inputs: LockInputSnapshot[],
): Promise<void> {
  let currentInputs: LockInputSnapshot[];
  try {
    currentInputs = await snapshotLockInputs(projectRoot);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    throw new ComposeError(
      "DOMAIN_CONCURRENT_CHANGE",
      "workspace lock input disappeared during preparation",
      3,
      "Inspect the concurrent edit and retry from the new state.",
    );
  }
  if (
    currentInputs.length !== inputs.length ||
    currentInputs.some((input, index) => input.path !== inputs[index]?.path)
  ) {
    throw new ComposeError(
      "DOMAIN_CONCURRENT_CHANGE",
      "workspace lock input set changed during preparation",
      3,
      "Inspect the concurrent edit and retry from the new state.",
    );
  }
  for (const [index, input] of inputs.entries()) {
    if (sameBytes(currentInputs[index]?.bytes ?? new Uint8Array(), input.bytes)) continue;
    throw new ComposeError(
      "DOMAIN_CONCURRENT_CHANGE",
      `workspace lock input changed during preparation: ${relative(projectRoot, input.path)}`,
      3,
      "Inspect the concurrent edit and retry from the new state.",
    );
  }
}

async function requireAbsent(path: string): Promise<void> {
  if ((await lstat(path).catch(() => undefined)) !== undefined) {
    throw new ComposeError(
      "DOMAIN_TARGET_COLLISION",
      `composition target already exists: ${path}`,
      3,
      "Choose a clean package or reconcile the existing file explicitly.",
    );
  }
}

interface Creation {
  bytes: Uint8Array;
  path: string;
}

export interface Replacement extends Creation {
  original: Uint8Array;
}

export type { Creation };

type TransactionIssueKind = "collision" | "concurrent" | "internal" | "partial";

class TransactionIssue extends Error {
  constructor(
    readonly kind: TransactionIssueKind,
    message: string,
    readonly unresolved: string[] = [],
  ) {
    super(message);
  }
}

type PublishedCreation = Creation;

interface PublishedReplacement extends Replacement {
  backup: string;
}

interface PublicationState {
  created: PublishedCreation[];
  createdDirectories: string[];
  replaced: PublishedReplacement[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function uniqueSibling(path: string, kind: "backup" | "current" | "tmp"): string {
  return `${path}.cli-design-${randomUUID()}.${kind}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return hash(left) === hash(right);
}

async function ensureDirectory(
  path: string,
  state: PublicationState,
  fileSystem: FileSystemAdapter,
): Promise<void> {
  const stats = await fileSystem.lstat(path);
  if (stats?.isDirectory() && !stats.isSymbolicLink()) return;
  if (stats !== undefined) {
    throw new TransactionIssue("collision", `composition directory is not ordinary: ${path}`);
  }
  await ensureDirectory(dirname(path), state, fileSystem);
  try {
    await fileSystem.createDirectory(path);
    state.createdDirectories.push(path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const concurrent = await fileSystem.lstat(path);
    if (!concurrent?.isDirectory() || concurrent.isSymbolicLink()) {
      throw new TransactionIssue("collision", `composition directory appeared concurrently: ${path}`);
    }
  }
}

async function removeOwnedPath(
  path: string,
  fileSystem: FileSystemAdapter,
  recursive = false,
): Promise<string[]> {
  try {
    await fileSystem.remove(path, { force: true, ...(recursive ? { recursive: true } : {}) });
    return [];
  } catch {
    return [path];
  }
}

async function restoreCaptured(
  captured: string,
  target: string,
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  try {
    await fileSystem.link(captured, target);
  } catch {
    return [captured, target];
  }
  return await removeOwnedPath(captured, fileSystem);
}

async function captureExpected(
  path: string,
  expected: Uint8Array,
  fileSystem: FileSystemAdapter,
): Promise<string> {
  const backup = uniqueSibling(path, "backup");
  try {
    await fileSystem.rename(path, backup);
  } catch (error) {
    throw new TransactionIssue(
      errorCode(error) === "ENOENT" ? "concurrent" : "internal",
      errorCode(error) === "ENOENT"
        ? `composition target disappeared concurrently: ${path}`
        : error instanceof Error
          ? error.message
          : `cannot capture ${path}`,
    );
  }
  let current: Uint8Array;
  try {
    current = await fileSystem.read(backup);
  } catch (error) {
    const unresolved = await restoreCaptured(backup, path, fileSystem);
    throw new TransactionIssue(
      unresolved.length === 0 ? "internal" : "partial",
      error instanceof Error ? error.message : `cannot inspect ${path}`,
      unresolved,
    );
  }
  if (sameBytes(current, expected)) return backup;
  const unresolved = await restoreCaptured(backup, path, fileSystem);
  throw new TransactionIssue(
    unresolved.length === 0 ? "concurrent" : "partial",
    `composition target changed concurrently: ${path}`,
    unresolved,
  );
}

async function cleanupTemporary(
  temporary: string,
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  return await removeOwnedPath(temporary, fileSystem);
}

async function writeNewFile(
  file: Creation,
  state: PublicationState,
  fileSystem: FileSystemAdapter,
): Promise<void> {
  await ensureDirectory(dirname(file.path), state, fileSystem);
  const temporary = uniqueSibling(file.path, "tmp");
  let temporaryOwned = false;
  let targetClaimAttempted = false;
  let problem: unknown;
  try {
    await fileSystem.writeExclusive(temporary, file.bytes);
    temporaryOwned = true;
    targetClaimAttempted = true;
    await fileSystem.link(temporary, file.path);
    state.created.push(file);
  } catch (error) {
    problem =
      errorCode(error) === "EEXIST"
        ? new TransactionIssue(
            "collision",
            targetClaimAttempted
              ? `composition target appeared concurrently: ${file.path}`
              : `temporary publication path collided while creating: ${file.path}`,
          )
        : error;
  }
  const unresolved = temporaryOwned ? await cleanupTemporary(temporary, fileSystem) : [];
  if (unresolved.length > 0) {
    throw new TransactionIssue("partial", `temporary publication file remains: ${temporary}`, unresolved);
  }
  if (problem !== undefined) throw problem;
}

function classifyReplacementFailure(
  error: unknown,
  temporaryOwned: boolean,
  path: string,
): unknown {
  if (temporaryOwned || errorCode(error) !== "EEXIST") return error;
  return new TransactionIssue(
    "collision",
    `temporary replacement path collided while replacing: ${path}`,
  );
}

async function recoverReplacementFailure(
  error: unknown,
  temporaryOwned: boolean,
  backup: string | undefined,
  path: string,
  fileSystem: FileSystemAdapter,
): Promise<unknown> {
  const problem = classifyReplacementFailure(error, temporaryOwned, path);
  if (backup === undefined) return problem;
  const restored = await restoreCaptured(backup, path, fileSystem);
  if (restored.length === 0) return problem;
  return new TransactionIssue(
    "partial",
    errorCode(error) === "EEXIST"
      ? `composition target appeared during replacement: ${path}`
      : error instanceof Error
        ? error.message
        : `replacement failed for ${path}`,
    restored,
  );
}

async function replaceFile(
  file: Replacement,
  state: PublicationState,
  fileSystem: FileSystemAdapter,
): Promise<void> {
  const temporary = uniqueSibling(file.path, "tmp");
  let temporaryOwned = false;
  let backup: string | undefined;
  let problem: unknown;
  try {
    await fileSystem.writeExclusive(temporary, file.bytes);
    temporaryOwned = true;
    backup = await captureExpected(file.path, file.original, fileSystem);
    await fileSystem.link(temporary, file.path);
    state.replaced.push({ ...file, backup });
  } catch (error) {
    problem = await recoverReplacementFailure(
      error,
      temporaryOwned,
      backup,
      file.path,
      fileSystem,
    );
  }
  const unresolved = temporaryOwned ? await cleanupTemporary(temporary, fileSystem) : [];
  if (unresolved.length > 0) {
    throw new TransactionIssue("partial", `temporary replacement file remains: ${temporary}`, [
      ...unresolved,
      ...(problem instanceof TransactionIssue ? problem.unresolved : []),
    ]);
  }
  if (problem !== undefined) throw problem;
}

async function rollbackCreation(
  file: PublishedCreation,
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  const captured = uniqueSibling(file.path, "current");
  try {
    await fileSystem.rename(file.path, captured);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? [] : [file.path];
  }
  const current = await fileSystem.read(captured).catch(() => undefined);
  if (current !== undefined && sameBytes(current, file.bytes)) {
    return await removeOwnedPath(captured, fileSystem);
  }
  const unresolved = await restoreCaptured(captured, file.path, fileSystem);
  return [...new Set([file.path, ...unresolved])];
}

async function rollbackReplacement(
  file: PublishedReplacement,
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  const captured = uniqueSibling(file.path, "current");
  try {
    await fileSystem.rename(file.path, captured);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return [file.path, file.backup];
    // The published replacement is no longer ours. Do not recreate the original
    // because a concurrent owner may have intentionally removed it; retain the
    // backup as recovery evidence and surface the unresolved concurrent effect.
    return [file.path, file.backup];
  }
  const current = await fileSystem.read(captured).catch(() => undefined);
  if (current === undefined || !sameBytes(current, file.bytes)) {
    const restored = await restoreCaptured(captured, file.path, fileSystem);
    return [...new Set([file.path, file.backup, ...restored])];
  }
  const restored = await restoreCaptured(file.backup, file.path, fileSystem);
  if (restored.length > 0) return [...new Set([captured, ...restored])];
  return await removeOwnedPath(captured, fileSystem);
}

async function rollbackPublication(
  state: PublicationState,
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const file of state.replaced.toReversed()) {
    unresolved.push(...(await rollbackReplacement(file, fileSystem)));
  }
  for (const file of state.created.toReversed()) {
    unresolved.push(...(await rollbackCreation(file, fileSystem)));
  }
  for (const path of state.createdDirectories.toReversed()) {
    try {
      await fileSystem.removeDirectory(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") unresolved.push(path);
    }
  }
  return [...new Set(unresolved)];
}

function publicationError(error: unknown, unresolved: string[]): ComposeError {
  const inherited = error instanceof ComposeError ? error.unresolvedEffects : [];
  const issue =
    error instanceof TransactionIssue
      ? error
      : new TransactionIssue(
          "internal",
          error instanceof Error ? error.message : "unexpected publish failure",
        );
  const remaining = [...new Set([...inherited, ...issue.unresolved, ...unresolved])];
  if (remaining.length > 0 || issue.kind === "partial") {
    return new ComposeError(
      "DOMAIN_PARTIAL_COMPOSITION",
      `${issue.message}; unresolved effects: ${remaining.join(", ")}`,
      3,
      "Preserve and inspect the listed paths before retrying.",
      remaining,
    );
  }
  if (error instanceof ComposeError) {
    return new ComposeError(
      error.causeCode,
      `${error.message}; the host project was restored`,
      error.exitCode,
      error.repairAction,
    );
  }
  if (issue.kind === "collision") {
    return new ComposeError(
      "DOMAIN_TARGET_COLLISION",
      `${issue.message}; the host project was restored`,
      3,
      "Inspect the competing file and retry from the new state.",
    );
  }
  if (issue.kind === "concurrent") {
    return new ComposeError(
      "DOMAIN_CONCURRENT_CHANGE",
      `${issue.message}; the host project was restored`,
      3,
      "Inspect the concurrent edit and retry from the new state.",
    );
  }
  return new ComposeError(
    "INTERNAL_COMPOSE_FAILURE",
    `${issue.message}; the host project was restored`,
    1,
    "Inspect the project and pinned template before retrying.",
  );
}

async function removeBackups(
  replaced: PublishedReplacement[],
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const file of replaced) {
    unresolved.push(...(await removeOwnedPath(file.backup, fileSystem)));
  }
  return unresolved;
}

// The commit phase uses exclusive creation and captures every replacement before
// publication. Rollback only removes bytes this run can still prove it owns.
export async function publish(
  creations: Creation[],
  replacements: Replacement[],
  fileSystem: FileSystemAdapter = nodeFileSystem,
  confirmPublishedState: () => Promise<void> = async () => {},
): Promise<void> {
  const state: PublicationState = { created: [], createdDirectories: [], replaced: [] };
  try {
    for (const file of creations) await writeNewFile(file, state, fileSystem);
    for (const file of replacements) await replaceFile(file, state, fileSystem);
    await confirmPublishedState();
  } catch (error) {
    throw publicationError(error, await rollbackPublication(state, fileSystem));
  }
  const unresolved = await removeBackups(state.replaced, fileSystem);
  if (unresolved.length > 0) {
    throw new ComposeError(
      "DOMAIN_PARTIAL_COMPOSITION",
      `composition completed with retained recovery files: ${unresolved.join(", ")}`,
      3,
      "Preserve and inspect the listed paths before retrying.",
      unresolved,
    );
  }
}

async function releaseProjectLock(
  path: string,
  token: Uint8Array,
  fileSystem: FileSystemAdapter,
): Promise<string[]> {
  // Spec axis: rename atomically transfers only our observed lock into a private
  // capture. A later owner can claim path while we inspect the capture, and link
  // restoration then refuses to overwrite that owner's replacement.
  const captured = uniqueSibling(path, "current");
  try {
    await fileSystem.rename(path, captured);
  } catch {
    return [path];
  }
  const current = await fileSystem.read(captured).catch(() => undefined);
  if (current === undefined) return [path, captured];
  if (sameBytes(current, token)) return await removeOwnedPath(captured, fileSystem);
  const unresolved = await restoreCaptured(captured, path, fileSystem);
  return [...new Set([path, ...unresolved])];
}

export async function withProjectLock<T>(
  projectRoot: string,
  action: () => Promise<T>,
  fileSystem: FileSystemAdapter = nodeFileSystem,
): Promise<T> {
  const path = join(projectRoot, PROJECT_LOCK);
  const token = new TextEncoder().encode(randomUUID());
  try {
    await fileSystem.writeExclusive(path, token);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new ComposeError(
        "DOMAIN_PROJECT_BUSY",
        "another cli-design composition owns the project transaction",
        3,
        `Wait for or recover ${path} before retrying.`,
      );
    }
    throw error;
  }
  let result: T | undefined;
  let problem: unknown;
  try {
    result = await action();
  } catch (error) {
    problem = error;
  }
  const unresolved = await releaseProjectLock(path, token, fileSystem);
  if (unresolved.length > 0) {
    const actionMessage = problem instanceof Error ? `${problem.message}; ` : "";
    const actionUnresolved = problem instanceof ComposeError ? problem.unresolvedEffects : [];
    const remaining = [...new Set([...actionUnresolved, ...unresolved])];
    throw new ComposeError(
      "DOMAIN_PARTIAL_COMPOSITION",
      `${actionMessage}project transaction lock could not be released; unresolved effects: ${remaining.join(", ")}`,
      3,
      "Preserve and inspect the listed path before retrying.",
      remaining,
    );
  }
  if (problem !== undefined) throw problem;
  return result as T;
}

async function composeLocked(options: ComposeOptions) {
  const { packagePath } = await resolveOwners(options);
  const packageFile = join(packagePath, "package.json");
  const lockFile = join(options.projectRoot, "bun.lock");
  const lockInputs = await snapshotLockInputs(options.projectRoot);
  const originalPackage = snapshotBytes(lockInputs, packageFile);
  const originalLock = snapshotBytes(lockInputs, lockFile);
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
  await requireUnchangedLockInputs(options.projectRoot, lockInputs);
  const publishedLockInputs = lockInputs.map((input) => ({
    ...input,
    bytes:
      input.path === packageFile
        ? nextPackage
        : input.path === lockFile
          ? nextLock
          : input.bytes,
  }));

  const metadata = new TextEncoder().encode(
    `${JSON.stringify(
      {
        sourcePacket: options.sourcePacket,
        starter: options.starter,
        templateRevision: TEMPLATE_REVISION,
      },
      null,
      2,
    )}\n`,
  );
  await publish(
    [
      ...sources.map((source) => ({
        bytes: source.bytes,
        path: join(packagePath, source.relativePath),
      })),
      { bytes: metadata, path: metadataPath },
    ],
    [
      { bytes: nextPackage, original: originalPackage, path: packageFile },
      { bytes: nextLock, original: originalLock, path: lockFile },
    ],
    nodeFileSystem,
    async () => await requireUnchangedLockInputs(options.projectRoot, publishedLockInputs),
  );

  return {
    package: relative(options.projectRoot, packagePath) || ".",
    projectRoot: options.projectRoot,
    sourcePacket: options.sourcePacket,
    starter: options.starter,
    status: "composed",
    templateRevision: TEMPLATE_REVISION,
    writtenFiles: [...sources.map((source) => source.relativePath), ".cli-design-template.json"].sort(),
  };
}

async function compose(options: ComposeOptions) {
  await refuseSymlinkProjectRoot(options.projectRoot);
  await ordinaryFile(join(options.projectRoot, "package.json"), "project package.json");
  return await withProjectLock(options.projectRoot, async () => await composeLocked(options));
}

const HELP = `Compose the canonical Bun CLI starter into an existing Bun project.

Usage:
  bun run cli-design compose-existing --project-root PATH --package PATH --starter simple|complex --source-packet PATH_OR_URL [--json]

The package path is relative to the project root. Existing source files,
conflicting scripts and incompatible dependency pins are refused before writes.
`;

function hasJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function failure(error: unknown, json: boolean): number {
  const known =
    error instanceof ComposeError
      ? error
      : new ComposeError(
          "INTERNAL_COMPOSE_FAILURE",
          error instanceof Error ? error.message : "unexpected compose failure",
          1,
          "Inspect the project and pinned template before retrying.",
        );
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        causeCode: known.causeCode,
        message: known.message,
        repairAction: known.repairAction,
        status: "refused",
      })}\n`,
    );
  } else {
    process.stderr.write(`cli-design: ${known.message}; ${known.repairAction}\n`);
  }
  return known.exitCode;
}

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  try {
    const invocation = parseInvocation(argv);
    if (invocation === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(await compose(invocation))}\n`);
    return 0;
  } catch (error) {
    return failure(error, json);
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
