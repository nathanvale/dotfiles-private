import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Replacement } from "./main.ts";

export interface TemplateFile {
  bytes: Uint8Array;
  relativePath: string;
}

export interface ExistingCli {
  entryPoint: string;
  entryBytes: Uint8Array;
  commandOwner: string;
  contractOwner: string;
  packageRoot: string;
  metadataPath: string;
  metadata: Record<string, unknown>;
  originalMetadata: Uint8Array;
  originalCommands: Uint8Array;
}

export class CliIntegrationError extends Error {
  constructor(readonly causeCode: string, message: string, readonly repairAction: string) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "The CLI did not expose a supported command declaration.", "Repair its help, discovery and registration owner before extending it.");
  return value as Record<string, unknown>;
}

export function inventoryClis(source: string, root: string): string[] {
  const javascript = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  const script = `const { inventoryApplicationClis } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(await inventoryApplicationClis(${JSON.stringify(root)})));`;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  if (child.exitCode !== 0) throw new CliIntegrationError("DOMAIN_CLI_INVENTORY_UNAVAILABLE", "The repository CLI inventory could not be established.", "Repair unsupported or unsafe entry paths before composing; no fallback CLI was created.");
  const entries: unknown = JSON.parse(child.stdout.toString());
  if (!Array.isArray(entries) || !entries.every((entry: unknown) => typeof entry === "string")) throw new CliIntegrationError("DOMAIN_CLI_INVENTORY_UNAVAILABLE", "The CLI inventory returned an invalid result.", "Repair the canonical template inventory before composing.");
  return entries as string[];
}

async function ordinary(path: string): Promise<Uint8Array> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing CLI has no supported ordinary registration owner.", "Expose its existing command registration through the cli-design maintenance route; preserve its entry point.");
  return await readFile(path);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function unsupportedRegistration(): CliIntegrationError {
  return new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing CLI has no supported registration declaration.", "Integrate through that CLI's existing owner using cli-design maintenance, then retry. No second CLI is created.");
}

function registrationDocument(bytes: Uint8Array): Record<string, unknown> {
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw unsupportedRegistration(); }
}

// Admit named imports followed by one explicitly typed array initializer. Bun's
// parser, rather than a bracket regex, locates its end even inside nested code,
// comments and strings. Bound the work and hand other declarations to maintenance.
function registrationArray(source: string): { end: number; contractImport: string } {
  const header = /^(?:\s|import (?:type )?\{[\w\s,]+\} from ["'][^"'\r\n]+["'];)*export const commands: (?:readonly )?CommandDefinition\[\] = \[/u.exec(source);
  const contract = /^import type \{\s*CommandDefinition\s*\} from ["'](\.[^"'\r\n]+\.ts)["'];/mu.exec(header?.[0] ?? "");
  if (header === null || contract?.[1] === undefined || source.length > 65_536) throw unsupportedRegistration();
  const parser = new Bun.Transpiler({ loader: "ts" });
  let candidates = 0;
  for (let end = source.indexOf("]", header[0].length); end !== -1 && candidates < 256; end = source.indexOf("]", end + 1)) {
    candidates += 1;
    try {
      parser.transformSync(source.slice(0, end + 1));
      return { end, contractImport: contract[1] };
    } catch { /* This bracket belongs to a nested expression or literal. */ }
  }
  throw unsupportedRegistration();
}

async function readRegistration(owner: string, entryPoint: string, metadataPath: string): Promise<ExistingCli> {
  const originalMetadata = await ordinary(metadataPath);
  const metadata = registrationDocument(originalMetadata);
  if (metadata.registrationVersion !== 1 || typeof metadata.commandOwner !== "string" || typeof metadata.entryPoint !== "string" || resolve(owner, metadata.entryPoint) !== entryPoint) throw unsupportedRegistration();
  const commandOwner = resolve(owner, metadata.commandOwner);
  if (!inside(owner, commandOwner)) throw unsupportedRegistration();
  const originalCommands = await ordinary(commandOwner);
  const declaration = registrationArray(new TextDecoder().decode(originalCommands));
  const contractOwner = resolve(dirname(commandOwner), declaration.contractImport);
  if (!inside(owner, contractOwner)) throw unsupportedRegistration();
  await ordinary(contractOwner);
  const scanner = new Bun.Transpiler({ loader: "ts" });
  const entryBytes = await ordinary(entryPoint);
  const imports = scanner.scan(new TextDecoder().decode(entryBytes)).imports;
  if (!imports.some((item) => item.path.startsWith(".") && resolve(dirname(entryPoint), item.path.replace(/\.ts$/, "") + ".ts") === commandOwner)) throw unsupportedRegistration();
  return { entryPoint, entryBytes, commandOwner, contractOwner, packageRoot: owner, metadataPath, metadata, originalMetadata, originalCommands };
}

export async function existingCli(root: string, entries: string[]): Promise<ExistingCli | null> {
  if (entries.length === 0) return null;
  if (entries.length > 1) throw new CliIntegrationError("DOMAIN_MULTIPLE_APPLICATION_CLIS", `The repository already has multiple application CLIs: ${entries.join(", ")}`, "Reconcile the repository entry points before adding commands; composition does not consolidate or create another CLI.");
  const entryPoint = resolve(root, entries[0] ?? "");
  let owner = dirname(entryPoint);
  while (inside(root, owner)) {
    const metadataPath = join(owner, ".cli-design-template.json");
    if (await lstat(metadataPath).catch(() => undefined)) return await readRegistration(owner, entryPoint, metadataPath);
    if (owner === root) break;
    owner = dirname(owner);
  }
  throw unsupportedRegistration();
}

export function extensionFiles(files: TemplateFile[], packagePath: string, existing: ExistingCli, starter: string): TemplateFile[] {
  if (existing.metadata.starter === "simple" && starter === "complex") throw new CliIntegrationError("DOMAIN_CLI_PROFILE_CONFLICT", "The selected commands require a complex CLI, but the existing CLI is simple.", "Upgrade the existing CLI's profile and qualify it before adding mutating commands.");
  if (!inside(existing.packageRoot, packagePath)) throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The selected module package lies outside the existing CLI's configured ownership scope.", "Integrate through the existing CLI package or its declared workspace interface before retrying.");
  const directory = `src/domains/composed-${starter}`;
  const sharedOwner = existing.contractOwner;
  return files.filter((file) => file.relativePath.startsWith("src/") && !["src/cli.ts", "src/commands-contract.ts", "src/process-lifecycle.ts", "src/diagnostics.ts", "src/diagnostics-custody.ts"].includes(file.relativePath)).map((file) => {
    const relativePath = `${directory}/${file.relativePath.slice(4)}`;
    const parent = dirname(join(packagePath, relativePath));
    let sharedImport = relative(parent, sharedOwner).split("\\").join("/");
    if (!sharedImport.startsWith(".")) sharedImport = `./${sharedImport}`;
    let diagnosticImport = relative(parent, join(dirname(existing.commandOwner), "diagnostics.ts")).split("\\").join("/");
    if (!diagnosticImport.startsWith(".")) diagnosticImport = `./${diagnosticImport}`;
    const text = new TextDecoder().decode(file.bytes).replace(/(["'])(?:\.\/|\.\.\/)commands-contract\.ts\1/g, JSON.stringify(sharedImport)).replace(/(["'])(?:\.\/|\.\.\/)diagnostics\.ts\1/g, JSON.stringify(diagnosticImport));
    return { relativePath, bytes: new TextEncoder().encode(text) };
  });
}

export async function extendBoundaryOwner(existing: ExistingCli, packagePath: string, files: TemplateFile[], starter: string, policy: string): Promise<Replacement[]> {
  const path = join(existing.packageRoot, ".fallowrc.json");
  if (!(await lstat(path).catch(() => undefined))) return [];
  const original = await ordinary(path);
  let config: Record<string, unknown>;
  try { config = record(JSON.parse(new TextDecoder().decode(original))); }
  catch { throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing boundary configuration requires a scoped manual edit.", "Preserve its configuration owner and integrate the selected domain zones through cli-design maintenance."); }
  if (config.boundaries === undefined) return [];
  const targetZones = record(config.boundaries).zones;
  const sourceZones = record(record(JSON.parse(policy)).boundaries).zones;
  if (!Array.isArray(targetZones) || !Array.isArray(sourceZones)) throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing boundary zones do not have a supported declaration.", "Reconcile its existing configuration owner before adding domain modules.");
  let changed = false;
  for (const file of files.filter((item) => item.relativePath.startsWith("src/"))) {
    const sourcePath = `src/${file.relativePath.slice(`src/domains/composed-${starter}/`.length)}`;
    const sourceZone = sourceZones.map(record).find((zone) => Array.isArray(zone.patterns) && zone.patterns.some((pattern: unknown) => typeof pattern === "string" && new Bun.Glob(pattern).match(sourcePath)));
    const target = sourceZone === undefined ? undefined : targetZones.map(record).find((zone) => zone.name === sourceZone.name);
    if (target === undefined || !Array.isArray(target.patterns)) throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", `No compatible boundary owner exists for ${file.relativePath}.`, "Map the selected domain files through the existing boundary configuration before retrying.");
    const mappedPath = relative(existing.packageRoot, join(packagePath, file.relativePath)).split("\\").join("/");
    if (!target.patterns.some((pattern: unknown) => typeof pattern === "string" && new Bun.Glob(pattern).match(mappedPath))) {
      target.patterns.push(mappedPath);
      changed = true;
    }
  }
  if (!changed) return [];
  return [{ path, original, bytes: await formatBoundaryOwner(existing, path, config) }];
}

async function formatBoundaryOwner(existing: ExistingCli, path: string, config: Record<string, unknown>): Promise<Uint8Array> {
  const manifestPath = join(existing.packageRoot, "package.json");
  const manifest = record(JSON.parse(new TextDecoder().decode(await ordinary(manifestPath))));
  if (record(manifest.scripts)["format:check"] !== "biome format .") throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The boundary configuration has no supported formatting owner.", "Format the scoped boundary delta through the host's existing owner using cli-design maintenance.");
  try {
    const formatter = createRequire(manifestPath).resolve("@biomejs/biome/bin/biome");
    const child = Bun.spawnSync([process.execPath, formatter, "format", "--stdin-file-path", path], { cwd: existing.packageRoot, stdin: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`), stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error("formatter refused the planned boundary delta");
    return new Uint8Array(child.stdout);
  } catch {
    throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The host formatter could not format the scoped boundary delta.", "Restore its local formatter or integrate the delta through cli-design maintenance before retrying.");
  }
}

export function extendRegistration(existing: ExistingCli, packagePath: string, starter: string): Uint8Array {
  const imported = join(packagePath, "src/domains", `composed-${starter}`, "commands.ts");
  let route = relative(dirname(existing.commandOwner), imported).split("\\").join("/");
  if (!route.startsWith(".")) route = `./${route}`;
  const binding = starter === "complex" ? "composedComplexCommands" : "composedSimpleCommands";
  const source = new TextDecoder().decode(existing.originalCommands);
  const { end } = registrationArray(source);
  const importedSource = `import { commands as ${binding} } from ${JSON.stringify(route)};\n`;
  const append = (separator: string) => `${importedSource}${source.slice(0, end).trimEnd()}\n${separator}  ...${binding},\n${source.slice(end)}`;
  const parser = new Bun.Transpiler({ loader: "ts" });
  try {
    const extended = append("");
    parser.transformSync(extended);
    return new TextEncoder().encode(extended);
  } catch {
    const extended = append(",");
    try { parser.transformSync(extended); }
    catch { throw unsupportedRegistration(); }
    return new TextEncoder().encode(extended);
  }
}

export async function checkStagedCompilation(stage: string, projectRoot: string, existing: ExistingCli): Promise<void> {
  const packageRoot = join(stage, relative(projectRoot, existing.packageRoot));
  const config = join(packageRoot, "tsconfig.json");
  await ordinary(config);
  // Resolve only a local compiler installed in the isolated stage. Never run an
  // arbitrary host script, whose typecheck name could hide repository effects.
  const compiler = Bun.which("tsc", { PATH: [join(packageRoot, "node_modules/.bin"), join(stage, "node_modules/.bin")].join(":") });
  if (compiler === null) throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The existing CLI has no local compiler for staged validation.", "Install its local TypeScript compiler and provide a package tsconfig.json, or integrate through cli-design maintenance.");
  const child = Bun.spawnSync([compiler, "--noEmit", "--noCheck", "false", "--incremental", "false", "--composite", "false", "--listFiles", "-p", config], { cwd: packageRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const checkedFiles = new Set(child.stdout.toString().split(/\r?\n/u).map((path) => resolve(packageRoot, path)));
  const requiredFiles = [existing.entryPoint, existing.commandOwner].map((path) => join(stage, relative(projectRoot, path)));
  if (child.exitCode !== 0 || !requiredFiles.every((path) => checkedFiles.has(path))) throw new CliIntegrationError("DOMAIN_EXISTING_CLI_UNSUPPORTED", "The composed CLI does not pass its staged TypeScript check.", "Reconcile the selected commands with the host types and compiler configuration through cli-design maintenance before retrying.");
}

export function discoverCommands(root: string, entryPoint: string): { identities: string[]; routes: string[] } {
  const child = Bun.spawnSync([process.execPath, entryPoint, "--discover", "--json"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0 || child.stderr.length > 0) throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "The existing CLI could not expose its command discovery.", "Repair command discovery before extending the CLI; the repository remains unchanged.");
  const value = record(JSON.parse(child.stdout.toString()));
  const commands = record(record(value.result).data).commands;
  if (!Array.isArray(commands) || commands.length === 0) throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "The CLI has no discoverable commands.", "Declare its existing and selected commands in the shared registration owner.");
  const identities: string[] = [];
  const routes: string[] = [];
  const declaredRoutes: string[][] = [];
  for (const item of commands) {
    const command = record(item);
    if (typeof command.commandIdentity !== "string" || !Array.isArray(command.route) || !command.route.every((token: unknown) => typeof token === "string")) throw new CliIntegrationError("DOMAIN_CLI_DISCOVERY_INVALID", "A command has no supported identity or route.", "Repair the existing typed command declaration.");
    const route = JSON.stringify(command.route);
    const dispatch = command.commandIdentity.endsWith(".dispatch") && command.effectClass === "inspect" && command.route.length === 0;
    if (identities.includes(command.commandIdentity) || (!dispatch && declaredRoutes.some((existing) => routesOverlap(existing, command.route as string[])))) throw new CliIntegrationError("DOMAIN_COMMAND_ROUTE_CONFLICT", "The selected commands collide with an existing command identity or route.", "Choose distinct commands through the existing CLI owner before composing.");
    identities.push(command.commandIdentity);
    if (!dispatch) declaredRoutes.push(command.route as string[]);
    routes.push(route);
  }
  return { identities, routes };
}

function routesOverlap(left: string[], right: string[]): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.every((token, index) => token === longer[index]);
}
