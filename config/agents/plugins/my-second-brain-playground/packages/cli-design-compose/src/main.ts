import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const TEMPLATE_REVISION = "6e328f4cfc14ffeeaf7291209ccbf91c6ec46bf5";
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

class ComposeError extends Error {
  constructor(
    readonly causeCode: string,
    message: string,
    readonly exitCode: 1 | 2 | 3,
    readonly repairAction: string,
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
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return value;
  } catch {
    // The refusal below owns invalid URL and relative path inputs.
  }
  throw new ComposeError(
    "USAGE_INVALID_SOURCE_PACKET",
    "--source-packet must be an absolute path or HTTP(S) URL",
    2,
    "Supply the canonical project packet as an absolute path or URL.",
  );
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
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv.slice(1),
    options: {
      json: { type: "boolean" },
      package: { type: "string" },
      "project-root": { type: "string" },
      "source-packet": { type: "string" },
      starter: { type: "string" },
    },
    strict: true,
  });
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
  return { packagePath };
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

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComposeError(
      "SCHEMA_INVALID_PACKAGE",
      "target package.json must contain an object",
      3,
      "Repair the target package manifest before retrying.",
    );
  }
  return value as Record<string, unknown>;
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

function addExactDependencies(
  packageJson: Record<string, unknown>,
  starter: Starter,
): void {
  const dependencies = stringRecord(packageJson.dependencies, "dependencies");
  if (starter === "complex") {
    for (const [name, version] of Object.entries(COMPLEX_DEPENDENCIES)) {
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
  const parsed = record(JSON.parse(await readFile(path, "utf8")));
  addExactDependencies(parsed, starter);
  addComposeScript(parsed);
  return new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`);
}

function ignoredStagePath(source: string): boolean {
  const name = source.split("/").at(-1);
  return name === ".git" || name === "node_modules" || name === ".fallow";
}

async function stageProject(projectRoot: string): Promise<string> {
  const stage = await mkdtemp(join(tmpdir(), "cli-design-compose-"));
  await cp(projectRoot, stage, {
    filter: (source) => !ignoredStagePath(source),
    recursive: true,
  });
  return stage;
}

async function regenerateLock(
  options: ComposeOptions,
  updatedManifest: Uint8Array,
): Promise<Uint8Array> {
  const stage = await stageProject(options.projectRoot);
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
    return await readFile(join(stage, "bun.lock"));
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.cli-design-${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

async function replaceFile(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.cli-design-${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

async function compose(options: ComposeOptions) {
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
    throw new ComposeError(
      "DOMAIN_CONCURRENT_CHANGE",
      "target package.json changed during preparation",
      3,
      "Inspect the concurrent edit and retry from the new state.",
    );
  }
  if (hash(await readFile(lockFile)) !== hash(originalLock)) {
    throw new ComposeError(
      "DOMAIN_CONCURRENT_CHANGE",
      "bun.lock changed during preparation",
      3,
      "Inspect the concurrent edit and retry from the new state.",
    );
  }

  for (const source of sources) {
    await writeNewFile(join(packagePath, source.relativePath), source.bytes);
  }
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
  await writeNewFile(metadataPath, metadata);
  await replaceFile(packageFile, nextPackage);
  await replaceFile(lockFile, nextLock);

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

process.exitCode = await main(process.argv.slice(2));
