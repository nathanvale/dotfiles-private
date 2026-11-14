// @bun
// config/agents/plugins/my-second-brain-playground/packages/cli-design-compose/src/repository-cli.ts
import { lstat, readFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, isAbsolute, join, relative, resolve } from "path";

class CliIntegrationError extends Error {
  causeCode;
  repairAction;
  constructor(causeCode, message, repairAction) {
    super(message);
    this.causeCode = causeCode;
    this.repairAction = repairAction;
  }
}
function record(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "The CLI did not expose a supported command declaration.", "Repair its help, discovery and registration owner before extending it.");
  return value;
}
function inventoryClis(source, root) {
  const javascript = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  const script = `const { inventoryApplicationClis } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(await inventoryApplicationClis(${JSON.stringify(root)})));`;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  if (child.exitCode !== 0)
    throw new CliIntegrationError("DOMAIN_CLI_INVENTORY_UNAVAILABLE", "The repository CLI inventory could not be established.", "Repair unsupported or unsafe entry paths before composing; no fallback CLI was created.");
  const entries = JSON.parse(child.stdout.toString());
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string"))
    throw new CliIntegrationError("DOMAIN_CLI_INVENTORY_UNAVAILABLE", "The CLI inventory returned an invalid result.", "Repair the canonical template inventory before composing.");
  return entries;
}
async function ordinary(path) {
  const info = await lstat(path).catch(() => {
    return;
  });
  if (info === undefined || !info.isFile() || info.isSymbolicLink())
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing CLI has no supported ordinary registration owner.", "Expose its existing command registration through the cli-design maintenance route; preserve its entry point.");
  return await readFile(path);
}
function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || !path.startsWith("..") && !isAbsolute(path);
}
function unsupportedRegistration() {
  return new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing CLI has no supported registration declaration.", "Integrate through that CLI's existing owner using cli-design maintenance, then retry. No second CLI is created.");
}
function registrationDocument(bytes) {
  try {
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw unsupportedRegistration();
  }
}
async function readRegistration(owner, entryPoint, metadataPath) {
  const originalMetadata = await ordinary(metadataPath);
  const metadata = registrationDocument(originalMetadata);
  if (metadata.registrationVersion !== 1 || typeof metadata.commandOwner !== "string" || typeof metadata.entryPoint !== "string" || resolve(owner, metadata.entryPoint) !== entryPoint)
    throw unsupportedRegistration();
  const commandOwner = resolve(owner, metadata.commandOwner);
  if (!inside(owner, commandOwner))
    throw unsupportedRegistration();
  const originalCommands = await ordinary(commandOwner);
  const scanner = new Bun.Transpiler({ loader: "ts" });
  if (!scanner.scan(new TextDecoder().decode(originalCommands)).exports.includes("commands"))
    throw unsupportedRegistration();
  const entryBytes = await ordinary(entryPoint);
  const imports = scanner.scan(new TextDecoder().decode(entryBytes)).imports;
  if (!imports.some((item) => item.path.startsWith(".") && resolve(dirname(entryPoint), item.path.replace(/\.ts$/, "") + ".ts") === commandOwner))
    throw unsupportedRegistration();
  return { entryPoint, entryBytes, commandOwner, packageRoot: owner, metadataPath, metadata, originalMetadata, originalCommands };
}
async function existingCli(root, entries) {
  if (entries.length === 0)
    return null;
  if (entries.length > 1)
    throw new CliIntegrationError("DOMAIN_MULTIPLE_APPLICATION_CLIS", `The repository already has multiple application CLIs: ${entries.join(", ")}`, "Reconcile the repository entry points before adding commands; composition does not consolidate or create another CLI.");
  const entryPoint = resolve(root, entries[0] ?? "");
  let owner = dirname(entryPoint);
  while (inside(root, owner)) {
    const metadataPath = join(owner, ".cli-design-template.json");
    if (await lstat(metadataPath).catch(() => {
      return;
    }))
      return await readRegistration(owner, entryPoint, metadataPath);
    if (owner === root)
      break;
    owner = dirname(owner);
  }
  throw unsupportedRegistration();
}
function extensionFiles(files, packagePath, existing, starter) {
  if (existing.metadata.starter === "simple" && starter === "complex")
    throw new CliIntegrationError("DOMAIN_CLI_PROFILE_CONFLICT", "The selected commands require a complex CLI, but the existing CLI is simple.", "Upgrade the existing CLI's profile and qualify it before adding mutating commands.");
  if (!inside(existing.packageRoot, packagePath))
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The selected module package lies outside the existing CLI's configured ownership scope.", "Integrate through the existing CLI package or its declared workspace interface before retrying.");
  const directory = `src/domains/composed-${starter}`;
  const sharedOwner = join(dirname(existing.commandOwner), "commands-contract.ts");
  return files.filter((file) => file.relativePath.startsWith("src/") && !["src/cli.ts", "src/commands-contract.ts", "src/process-lifecycle.ts", "src/diagnostics.ts", "src/diagnostics-custody.ts"].includes(file.relativePath)).map((file) => {
    const relativePath = `${directory}/${file.relativePath.slice(4)}`;
    const parent = dirname(join(packagePath, relativePath));
    let sharedImport = relative(parent, sharedOwner).split("\\").join("/");
    if (!sharedImport.startsWith("."))
      sharedImport = `./${sharedImport}`;
    let diagnosticImport = relative(parent, join(dirname(existing.commandOwner), "diagnostics.ts")).split("\\").join("/");
    if (!diagnosticImport.startsWith("."))
      diagnosticImport = `./${diagnosticImport}`;
    const text = new TextDecoder().decode(file.bytes).replace(/(["'])(?:\.\/|\.\.\/)commands-contract\.ts\1/g, JSON.stringify(sharedImport)).replace(/(["'])(?:\.\/|\.\.\/)diagnostics\.ts\1/g, JSON.stringify(diagnosticImport));
    return { relativePath, bytes: new TextEncoder().encode(text) };
  });
}
async function extendBoundaryOwner(existing, packagePath, files, starter, policy) {
  const path = join(existing.packageRoot, ".fallowrc.json");
  if (!await lstat(path).catch(() => {
    return;
  }))
    return [];
  const original = await ordinary(path);
  let config;
  try {
    config = record(JSON.parse(new TextDecoder().decode(original)));
  } catch {
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing boundary configuration requires a scoped manual edit.", "Preserve its configuration owner and integrate the selected domain zones through cli-design maintenance.");
  }
  if (config.boundaries === undefined)
    return [];
  const targetZones = record(config.boundaries).zones;
  const sourceZones = record(record(JSON.parse(policy)).boundaries).zones;
  if (!Array.isArray(targetZones) || !Array.isArray(sourceZones))
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing boundary zones do not have a supported declaration.", "Reconcile its existing configuration owner before adding domain modules.");
  let changed = false;
  for (const file of files.filter((item) => item.relativePath.startsWith("src/"))) {
    const sourcePath = `src/${file.relativePath.slice(`src/domains/composed-${starter}/`.length)}`;
    const sourceZone = sourceZones.map(record).find((zone) => Array.isArray(zone.patterns) && zone.patterns.some((pattern) => typeof pattern === "string" && new Bun.Glob(pattern).match(sourcePath)));
    const target = sourceZone === undefined ? undefined : targetZones.map(record).find((zone) => zone.name === sourceZone.name);
    if (target === undefined || !Array.isArray(target.patterns))
      throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", `No compatible boundary owner exists for ${file.relativePath}.`, "Map the selected domain files through the existing boundary configuration before retrying.");
    const mappedPath = relative(existing.packageRoot, join(packagePath, file.relativePath)).split("\\").join("/");
    if (!target.patterns.some((pattern) => typeof pattern === "string" && new Bun.Glob(pattern).match(mappedPath))) {
      target.patterns.push(mappedPath);
      changed = true;
    }
  }
  if (!changed)
    return [];
  return [{ path, original, bytes: await formatBoundaryOwner(existing, path, config) }];
}
async function formatBoundaryOwner(existing, path, config) {
  const manifestPath = join(existing.packageRoot, "package.json");
  const manifest = record(JSON.parse(new TextDecoder().decode(await ordinary(manifestPath))));
  if (record(manifest.scripts)["format:check"] !== "biome format .")
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The boundary configuration has no supported formatting owner.", "Format the scoped boundary delta through the host's existing owner using cli-design maintenance.");
  try {
    const formatter = createRequire(manifestPath).resolve("@biomejs/biome/bin/biome");
    const child = Bun.spawnSync([process.execPath, formatter, "format", "--stdin-file-path", path], { cwd: existing.packageRoot, stdin: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}
`), stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0)
      throw new Error("formatter refused the planned boundary delta");
    return new Uint8Array(child.stdout);
  } catch {
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The host formatter could not format the scoped boundary delta.", "Restore its local formatter or integrate the delta through cli-design maintenance before retrying.");
  }
}
function extendRegistration(existing, packagePath, starter) {
  const imported = join(packagePath, "src/domains", `composed-${starter}`, "commands.ts");
  let route = relative(dirname(existing.commandOwner), imported).split("\\").join("/");
  if (!route.startsWith("."))
    route = `./${route}`;
  const binding = starter === "complex" ? "composedComplexCommands" : "composedSimpleCommands";
  return new TextEncoder().encode(`${new TextDecoder().decode(existing.originalCommands)}
import { commands as ${binding} } from ${JSON.stringify(route)};
commands.push(...${binding});
`);
}
function discoverCommands(root, entryPoint) {
  const child = Bun.spawnSync([process.execPath, entryPoint, "--discover", "--json"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0 || child.stderr.length > 0)
    throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "The existing CLI could not expose its command discovery.", "Repair command discovery before extending the CLI; the repository remains unchanged.");
  const value = record(JSON.parse(child.stdout.toString()));
  const commands = record(record(value.result).data).commands;
  if (!Array.isArray(commands) || commands.length === 0)
    throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "The CLI has no discoverable commands.", "Declare its existing and selected commands in the shared registration owner.");
  const identities = [];
  const routes = [];
  const declaredRoutes = [];
  for (const item of commands) {
    const command = record(item);
    if (typeof command.commandIdentity !== "string" || !Array.isArray(command.route) || !command.route.every((token) => typeof token === "string"))
      throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "A command has no supported identity or route.", "Repair the existing typed command declaration.");
    const route = JSON.stringify(command.route);
    const dispatch = command.commandIdentity.endsWith(".dispatch") && command.effectClass === "inspect" && command.route.length === 0;
    if (identities.includes(command.commandIdentity) || !dispatch && declaredRoutes.some((existing) => routesOverlap(existing, command.route)))
      throw new CliIntegrationError("DOMAIN_COMMAND_ROUTE_CONFLICT", "The selected commands collide with an existing command identity or route.", "Choose distinct commands through the existing CLI owner before composing.");
    identities.push(command.commandIdentity);
    if (!dispatch)
      declaredRoutes.push(command.route);
    routes.push(route);
  }
  return { identities, routes };
}
function routesOverlap(left, right) {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.every((token, index) => token === longer[index]);
}

// config/agents/plugins/my-second-brain-playground/packages/cli-design-compose/src/main.ts
import { createHash, randomUUID } from "crypto";
import {
  cp,
  link,
  lstat as lstat2,
  mkdir,
  mkdtemp,
  readFile as readFile2,
  rename,
  rm,
  rmdir,
  writeFile
} from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join2, parse, relative as relative2, resolve as resolve2 } from "path";
import { parseArgs } from "util";
var TEMPLATE_REVISION = "f035455f2cac8e283aedd72c27c960b1e62b829c";
var TEMPLATE_ROOT = resolve2(process.env.BUN_TYPESCRIPT_TEMPLATE_ROOT ?? join2(homedir(), "code", "bun-typescript-template"));
var COMPLEX_DEPENDENCIES = {
  "@logtape/logtape": "2.4.2",
  "@logtape/redaction": "2.4.2",
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
  lstat: async (path) => await lstat2(path).catch(() => {
    return;
  }),
  read: async (path) => await readFile2(path),
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
  unresolvedEffects;
  constructor(causeCode, message, exitCode, repairAction, unresolvedEffects = []) {
    super(message);
    this.causeCode = causeCode;
    this.exitCode = exitCode;
    this.repairAction = repairAction;
    this.unresolvedEffects = unresolvedEffects;
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
  if (isAbsolute2(value))
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
    projectRoot: resolve2(required(values["project-root"], "project-root")),
    sourcePacket: validateSourcePacket(required(values["source-packet"], "source-packet")),
    starter: parseStarter(required(values.starter, "starter"))
  };
}
function isInside(root, target) {
  const path = relative2(root, target);
  return path === "" || !path.startsWith("..") && !isAbsolute2(path);
}
async function ordinaryFile(path, label) {
  const stats = await lstat2(path).catch(() => {
    return;
  });
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
    throw new ComposeError("DOMAIN_PROJECT_PRECONDITION", `${label} must be an existing ordinary file`, 3, `Repair ${label} before composing the CLI.`);
  }
}
async function refuseSymlinkPath(root, target, includeTarget) {
  const relativePath = relative2(root, target);
  if (relativePath === "")
    return;
  if (relativePath.startsWith("..") || isAbsolute2(relativePath)) {
    throw new ComposeError("USAGE_PACKAGE_OUTSIDE_PROJECT", "composition paths must stay inside --project-root", 2, "Choose the owning Bun package relative to the project root.");
  }
  const segments = relativePath.split("/");
  if (!includeTarget)
    segments.pop();
  let current = root;
  for (const segment of segments) {
    current = join2(current, segment);
    const stats = await lstat2(current).catch(() => {
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
async function refuseSymlinkProjectRoot(projectRoot) {
  const absolute = resolve2(projectRoot);
  const parsed = parse(absolute);
  const segments = relative2(parsed.root, absolute).split(/[\\/]/).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join2(current, segment);
    const stats = await lstat2(current).catch(() => {
      return;
    });
    if (stats?.isSymbolicLink()) {
      throw new ComposeError("DOMAIN_UNSAFE_PROJECT_PATH", `project root traverses a symbolic link: ${current}`, 3, "Choose an ordinary project root without symbolic-link ancestors.");
    }
    if (stats !== undefined && !stats.isDirectory()) {
      throw new ComposeError("DOMAIN_PROJECT_PRECONDITION", `project root ancestor is not a directory: ${current}`, 3, "Repair the project root before composing the CLI.");
    }
  }
}
async function resolveOwners(options) {
  const packagePath = resolve2(options.projectRoot, options.packagePath);
  if (isAbsolute2(options.packagePath) || !isInside(options.projectRoot, packagePath)) {
    throw new ComposeError("USAGE_PACKAGE_OUTSIDE_PROJECT", "--package must be a relative path inside --project-root", 2, "Choose the owning Bun package relative to the project root.");
  }
  await refuseSymlinkPath(options.projectRoot, packagePath, true);
  await ordinaryFile(join2(options.projectRoot, "package.json"), "project package.json");
  await ordinaryFile(join2(options.projectRoot, "bun.lock"), "project bun.lock");
  await ordinaryFile(join2(packagePath, "package.json"), "target package.json");
  await requireWorkspaceMember(options.projectRoot, packagePath);
  return { packagePath };
}
function workspacePatterns(manifest) {
  const declared = manifest.workspaces;
  const patterns = Array.isArray(declared) ? declared : declared === undefined ? [] : record2(declared, "project package.json workspaces").packages;
  return Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === "string") : [];
}
async function requireWorkspaceMember(projectRoot, packagePath) {
  const member = relative2(projectRoot, packagePath).split("\\").join("/");
  if (member === "")
    return;
  const manifest = await readManifest(join2(projectRoot, "package.json"), "project package.json");
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
  const sharedPrefix = "starters/shared/";
  const paths = [prefix, sharedPrefix].flatMap((sourcePrefix) => git("ls-tree", "-r", "--name-only", TEMPLATE_REVISION, "--", sourcePrefix).trim().split(`
`).filter((path) => path.startsWith(`${sourcePrefix}src/`) || path.startsWith(`${sourcePrefix}tests/`)));
  if (paths.length === 0) {
    throw new ComposeError("INTERNAL_TEMPLATE_SOURCE_MISSING", `no ${starter} starter source exists at the pinned revision`, 1, "Repair the canonical template revision before retrying.");
  }
  return paths.map((path) => {
    const result = Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, "show", `${TEMPLATE_REVISION}:${path}`], { stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) {
      throw new ComposeError("INTERNAL_TEMPLATE_SOURCE_MISSING", `cannot read pinned template source: ${path}`, 1, "Repair the canonical template revision before retrying.");
    }
    return { bytes: result.stdout, relativePath: path.slice(path.startsWith(sharedPrefix) ? sharedPrefix.length : prefix.length) };
  });
}
function record2(value, label = "target package.json") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComposeError("SCHEMA_INVALID_PACKAGE", `${label} must contain an object`, 3, `Repair ${label} before retrying.`);
  }
  return value;
}
async function readManifest(path, label) {
  const text = await readFile2(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ComposeError("SCHEMA_INVALID_PACKAGE", `${label} must contain valid JSON`, 3, `Repair ${label} before retrying.`);
  }
  return record2(parsed, label);
}
function stringRecord(value, label) {
  if (value === undefined)
    return {};
  const values = record2(value);
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
async function updatedPackage(path, starter, reuseExisting = false) {
  const parsed = await readManifest(path, "target package.json");
  addExactDependencies(parsed, starter);
  if (!reuseExisting)
    addComposeScript(parsed);
  return new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}
`);
}
function ignoredStagePath(source) {
  const name = source.split("/").at(-1);
  return name === ".git" || name === "node_modules" || name === ".fallow" || name === ".worktrees" || name === PROJECT_LOCK;
}
async function stageProject(projectRoot, fileSystem = nodeFileSystem) {
  const stage = await fileSystem.createTemporaryDirectory(join2(tmpdir(), "cli-design-compose-"));
  try {
    await fileSystem.copyTree(projectRoot, stage, (source) => !ignoredStagePath(source));
    return stage;
  } catch (error) {
    try {
      await fileSystem.remove(stage, { force: true, recursive: true });
    } catch {
      throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `staged project cleanup failed; unresolved effects: ${stage}`, 3, "Preserve and inspect the listed path before retrying.", [stage]);
    }
    throw error;
  }
}
async function regenerateLock(options, updatedManifest, creations = [], replacements = [], existing = null) {
  const stage = await stageProject(options.projectRoot);
  let lock;
  let problem;
  try {
    const stagePackage = resolve2(stage, options.packagePath, "package.json");
    await writeFile(stagePackage, updatedManifest);
    for (const file of [...creations, ...replacements]) {
      const target = join2(stage, relative2(options.projectRoot, file.path));
      await mkdir(dirname2(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    const result = Bun.spawnSync([process.execPath, "install", ...existing === null ? ["--lockfile-only"] : [], "--ignore-scripts"], { cwd: stage, stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) {
      throw new ComposeError("DOMAIN_LOCKFILE_UPDATE_REFUSED", "Bun could not generate a compatible lockfile in the isolated stage", 3, "Repair the workspace or dependency constraints, then retry.");
    }
    if (existing !== null) {
      const before = discoverCommands(options.projectRoot, existing.entryPoint);
      const after = discoverCommands(stage, join2(stage, relative2(options.projectRoot, existing.entryPoint)));
      if (!before.identities.every((identity) => after.identities.includes(identity)) || !before.routes.every((route) => after.routes.includes(route)) || after.identities.length <= before.identities.length)
        throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "Composition did not preserve existing commands and expose the added commands.", "Repair the existing registration owner before retrying.");
    }
    lock = await readFile2(join2(stage, "bun.lock"));
  } catch (error) {
    problem = error;
  }
  try {
    await rm(stage, { force: true, recursive: true });
  } catch {
    throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `staged project cleanup failed; unresolved effects: ${stage}`, 3, "Preserve and inspect the listed path before retrying.", [stage]);
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
async function snapshotLockInputs(projectRoot) {
  const rootManifestPath = join2(projectRoot, "package.json");
  const rootManifest = await readManifest(rootManifestPath, "project package.json");
  const paths = new Set([rootManifestPath, join2(projectRoot, "bun.lock")]);
  for (const pattern of workspacePatterns(rootManifest)) {
    const manifestPattern = `${pattern.replace(/\/$/, "")}/package.json`;
    for await (const path of new Bun.Glob(manifestPattern).scan({
      cwd: projectRoot,
      onlyFiles: true
    })) {
      paths.add(join2(projectRoot, path));
    }
  }
  return await Promise.all([...paths].sort().map(async (path) => ({ bytes: await readFile2(path), path })));
}
function snapshotBytes(inputs, path) {
  const input = inputs.find((candidate) => candidate.path === path);
  if (input === undefined)
    throw new Error(`missing lock input snapshot: ${path}`);
  return input.bytes;
}
async function requireUnchangedLockInputs(projectRoot, inputs) {
  let currentInputs;
  try {
    currentInputs = await snapshotLockInputs(projectRoot);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      throw error;
    throw new ComposeError("DOMAIN_CONCURRENT_CHANGE", "workspace lock input disappeared during preparation", 3, "Inspect the concurrent edit and retry from the new state.");
  }
  if (currentInputs.length !== inputs.length || currentInputs.some((input, index) => input.path !== inputs[index]?.path)) {
    throw new ComposeError("DOMAIN_CONCURRENT_CHANGE", "workspace lock input set changed during preparation", 3, "Inspect the concurrent edit and retry from the new state.");
  }
  for (const [index, input] of inputs.entries()) {
    if (sameBytes(currentInputs[index]?.bytes ?? new Uint8Array, input.bytes))
      continue;
    throw new ComposeError("DOMAIN_CONCURRENT_CHANGE", `workspace lock input changed during preparation: ${relative2(projectRoot, input.path)}`, 3, "Inspect the concurrent edit and retry from the new state.");
  }
}
async function requireAbsent(path) {
  if (await lstat2(path).catch(() => {
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
  await ensureDirectory(dirname2(path), state, fileSystem);
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
  await ensureDirectory(dirname2(file.path), state, fileSystem);
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
    return [file.path, file.backup];
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
  if (error instanceof CliIntegrationError)
    error = new ComposeError(error.causeCode, error.message, 3, error.repairAction);
  const inherited = error instanceof ComposeError ? error.unresolvedEffects : [];
  const issue = error instanceof TransactionIssue ? error : new TransactionIssue("internal", error instanceof Error ? error.message : "unexpected publish failure");
  const remaining = [...new Set([...inherited, ...issue.unresolved, ...unresolved])];
  if (remaining.length > 0 || issue.kind === "partial") {
    return new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `${issue.message}; unresolved effects: ${remaining.join(", ")}`, 3, "Preserve and inspect the listed paths before retrying.", remaining);
  }
  if (error instanceof ComposeError) {
    return new ComposeError(error.causeCode, `${error.message}; the host project was restored`, error.exitCode, error.repairAction);
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
async function publish(creations, replacements, fileSystem = nodeFileSystem, confirmPublishedState = async () => {}) {
  const state = { created: [], createdDirectories: [], replaced: [] };
  try {
    for (const file of creations)
      await writeNewFile(file, state, fileSystem);
    for (const file of replacements)
      await replaceFile(file, state, fileSystem);
    await confirmPublishedState();
  } catch (error) {
    throw publicationError(error, await rollbackPublication(state, fileSystem));
  }
  const unresolved = await removeBackups(state.replaced, fileSystem);
  if (unresolved.length > 0) {
    throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `composition completed with retained recovery files: ${unresolved.join(", ")}`, 3, "Preserve and inspect the listed paths before retrying.", unresolved);
  }
}
async function releaseProjectLock(path, token, fileSystem) {
  const captured = uniqueSibling(path, "current");
  try {
    await fileSystem.rename(path, captured);
  } catch {
    return [path];
  }
  const current = await fileSystem.read(captured).catch(() => {
    return;
  });
  if (current === undefined)
    return [path, captured];
  if (sameBytes(current, token))
    return await removeOwnedPath(captured, fileSystem);
  const unresolved = await restoreCaptured(captured, path, fileSystem);
  return [...new Set([path, ...unresolved])];
}
async function withProjectLock(projectRoot, action, fileSystem = nodeFileSystem) {
  const path = join2(projectRoot, PROJECT_LOCK);
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
    const actionMessage = problem instanceof Error ? `${problem.message}; ` : "";
    const actionUnresolved = problem instanceof ComposeError ? problem.unresolvedEffects : [];
    const remaining = [...new Set([...actionUnresolved, ...unresolved])];
    throw new ComposeError("DOMAIN_PARTIAL_COMPOSITION", `${actionMessage}project transaction lock could not be released; unresolved effects: ${remaining.join(", ")}`, 3, "Preserve and inspect the listed path before retrying.", remaining);
  }
  if (problem !== undefined)
    throw problem;
  return result;
}
async function verifyPublishedCli(projectRoot, source, current) {
  if (current !== null && !sameBytes(await readFile2(current.entryPoint), current.entryBytes))
    throw new ComposeError("DOMAIN_CONCURRENT_CHANGE", "The existing CLI entry point changed during composition.", 3, "Inspect the concurrent edit and retry from the new state.");
  const entries = inventoryClis(source, projectRoot);
  const originalPreserved = current === null || resolve2(projectRoot, entries[0] ?? "") === current.entryPoint;
  if (entries.length !== 1 || !originalPreserved)
    throw new CliIntegrationError("DOMAIN_MULTIPLE_APPLICATION_CLIS", "Composition would expose a second application CLI.", "Preserve one existing entry point and reconcile the conflict before retrying.");
}
async function validateIntegrationPaths(projectRoot, packagePath, sources, metadataPath, currentCli) {
  for (const source of sources) {
    const target = join2(packagePath, source.relativePath);
    await refuseSymlinkPath(packagePath, target, false);
    await requireAbsent(target);
  }
  if (currentCli === null)
    await requireAbsent(metadataPath);
  else {
    await refuseSymlinkPath(projectRoot, currentCli.commandOwner, false);
    await refuseSymlinkPath(projectRoot, metadataPath, false);
  }
}
async function composeLocked(options) {
  const { packagePath } = await resolveOwners(options);
  const packageFile = join2(packagePath, "package.json");
  const lockFile = join2(options.projectRoot, "bun.lock");
  const lockInputs = await snapshotLockInputs(options.projectRoot);
  const originalPackage = snapshotBytes(lockInputs, packageFile);
  const originalLock = snapshotBytes(lockInputs, lockFile);
  const inventorySource = git("show", `${TEMPLATE_REVISION}:src/cli-inventory.ts`);
  const entryPoints = inventoryClis(inventorySource, options.projectRoot);
  const currentCli = await existingCli(options.projectRoot, entryPoints);
  const canonicalSources = templateFiles(options.starter);
  const sources = currentCli === null ? canonicalSources : extensionFiles(canonicalSources, packagePath, currentCli, options.starter);
  const metadataPath = currentCli?.metadataPath ?? join2(packagePath, ".cli-design-template.json");
  await validateIntegrationPaths(options.projectRoot, packagePath, sources, metadataPath, currentCli);
  const creations = sources.map((source) => ({ bytes: source.bytes, path: join2(packagePath, source.relativePath) }));
  if (currentCli !== null) {
    const testPath = join2(packagePath, "tests/integration", `composed-${options.starter}.test.ts`);
    await refuseSymlinkPath(options.projectRoot, testPath, false);
    await requireAbsent(testPath);
    const relativeEntry = relative2(dirname2(testPath), currentCli.entryPoint).split("\\").join("/").split("/").map((part) => encodeURIComponent(part)).join("/");
    const testSource = git("show", `${TEMPLATE_REVISION}:starters/${options.starter}/composition-tests/commands.test.ts`).replaceAll('"__CLI_ENTRY_POINT__"', JSON.stringify(relativeEntry));
    creations.push({ path: testPath, bytes: new TextEncoder().encode(testSource) });
  }
  const registration = currentCli === null ? [] : [{ path: currentCli.commandOwner, original: currentCli.originalCommands, bytes: extendRegistration(currentCli, packagePath, options.starter) }];
  if (currentCli !== null)
    registration.push(...await extendBoundaryOwner(currentCli, packagePath, sources, options.starter, git("show", `${TEMPLATE_REVISION}:profiles/static-admission/${options.starter}/.fallowrc.json`)));
  const nextPackage = await updatedPackage(packageFile, options.starter, currentCli !== null);
  const nextLock = await regenerateLock(options, nextPackage, creations, registration, currentCli);
  await requireUnchangedLockInputs(options.projectRoot, lockInputs);
  const publishedLockInputs = lockInputs.map((input) => ({
    ...input,
    bytes: input.path === packageFile ? nextPackage : input.path === lockFile ? nextLock : input.bytes
  }));
  const metadata = new TextEncoder().encode(`${JSON.stringify(currentCli === null ? {
    sourcePacket: options.sourcePacket,
    starter: options.starter,
    templateRevision: TEMPLATE_REVISION,
    specRevision: "4",
    entryPoint: "src/cli.ts",
    commandOwner: "src/commands.ts",
    registrationVersion: 1
  } : { ...currentCli.metadata, extensions: [...Array.isArray(currentCli.metadata.extensions) ? currentCli.metadata.extensions : [], { sourcePacket: options.sourcePacket, starter: options.starter, templateRevision: TEMPLATE_REVISION, specRevision: "4", commandModule: relative2(currentCli.packageRoot, join2(packagePath, "src/domains", `composed-${options.starter}`, "commands.ts")) }] }, null, 2)}
`);
  await publish([...creations, ...currentCli === null ? [{ bytes: metadata, path: metadataPath }] : []], [
    ...registration,
    ...currentCli === null ? [] : [{ bytes: metadata, original: currentCli.originalMetadata, path: metadataPath }],
    { bytes: nextPackage, original: originalPackage, path: packageFile },
    { bytes: nextLock, original: originalLock, path: lockFile }
  ], nodeFileSystem, async () => {
    await requireUnchangedLockInputs(options.projectRoot, publishedLockInputs);
    await verifyPublishedCli(options.projectRoot, inventorySource, currentCli);
  });
  return {
    package: relative2(options.projectRoot, packagePath) || ".",
    projectRoot: options.projectRoot,
    sourcePacket: options.sourcePacket,
    starter: options.starter,
    status: "composed",
    templateRevision: TEMPLATE_REVISION,
    entryPoint: currentCli === null ? relative2(options.projectRoot, join2(packagePath, "src/cli.ts")) : relative2(options.projectRoot, currentCli.entryPoint),
    integration: currentCli === null ? "created" : "extended",
    writtenFiles: [...creations.map((file) => relative2(options.projectRoot, file.path)), ...registration.map((file) => relative2(options.projectRoot, file.path)), relative2(options.projectRoot, metadataPath)].sort()
  };
}
async function compose(options) {
  await refuseSymlinkProjectRoot(options.projectRoot);
  await ordinaryFile(join2(options.projectRoot, "package.json"), "project package.json");
  return await withProjectLock(options.projectRoot, async () => await composeLocked(options));
}
var HELP = `Compose the canonical Bun CLI starter into an existing Bun project.

Usage:
  bun run cli-design compose-existing --project-root PATH --package PATH --starter simple|complex --source-packet PATH_OR_URL [--json]

The package path is relative to the project root. An existing supported CLI receives
new commands through its current registration owner. Unsupported integrations,
command collisions and multiple existing CLIs refuse without creating another CLI.
Existing source, scripts, configuration and unrelated behavior are preserved.
`;
function hasJson(argv) {
  return argv.includes("--json");
}
function failure(error, json) {
  if (error instanceof CliIntegrationError)
    error = new ComposeError(error.causeCode, error.message, 3, error.repairAction);
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
  requireUnchangedLockInputs,
  snapshotLockInputs,
  stageProject,
  withProjectLock
};
