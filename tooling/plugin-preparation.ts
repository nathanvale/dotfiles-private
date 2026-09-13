import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MANIFEST_RELATIVE_PATH = "tooling/plugin-preparation.json";
const PLUGINS_RELATIVE_PATH = "config/agents/plugins";
const LOCKFILE_NAMES = ["bun.lock", "bun.lockb"] as const;

export type PluginOwnership = "independent-lock" | "no-nested-install" | "root-workspace";

export interface PluginPreparationEntry {
	name: string;
	path: string;
	ownership: PluginOwnership;
	reason: string;
}

export interface PluginPreparationManifest {
	version: 1;
	plugins: PluginPreparationEntry[];
}

const OWNERSHIP_VALUES = ["independent-lock", "no-nested-install", "root-workspace"] as const;

interface CliOptions {
	repoRoot: string;
	bunCommand: string;
	receiptDir?: string;
}

type CommandScope = "root" | "plugin";

interface CommandResult {
	scope: CommandScope;
	plugin?: string;
	cwd: string;
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface ReceiptRecord {
	scope: CommandScope;
	plugin?: string;
	command: string[];
	exitCode: number;
	status: "passed" | "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginOwnership(value: unknown): value is PluginOwnership {
	return OWNERSHIP_VALUES.includes(value as PluginOwnership);
}

function readJson(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeRepoRelativePath(value: string): string {
	return value.split(path.sep).join("/");
}

function pluginRootFor(repoRoot: string, relativePath: string): string {
	return path.resolve(repoRoot, relativePath);
}

function lockfilesFor(pluginRoot: string): string[] {
	return LOCKFILE_NAMES.filter((name) => existsSync(path.join(pluginRoot, name)));
}

function rootWorkspacePaths(repoRoot: string): string[] {
	const manifestPath = path.join(repoRoot, "package.json");
	if (!existsSync(manifestPath)) return [];
	const manifest = readJson(manifestPath);
	if (!isRecord(manifest) || !Array.isArray(manifest.workspaces)) return [];
	return manifest.workspaces.filter((entry): entry is string => typeof entry === "string");
}

function isRootWorkspaceMember(repoRoot: string, relativePath: string): boolean {
	const normalized = normalizeRepoRelativePath(relativePath);
	return rootWorkspacePaths(repoRoot).some((workspace) => {
		if (workspace === normalized) return true;
		if (!workspace.endsWith("/*")) return false;
		const parent = workspace.slice(0, -2);
		const remainder = normalized.startsWith(`${parent}/`) ? normalized.slice(parent.length + 1) : "";
		return remainder.length > 0 && !remainder.includes("/");
	});
}

export function loadPreparationManifest(repoRoot: string): PluginPreparationManifest {
	const value = readJson(path.join(repoRoot, MANIFEST_RELATIVE_PATH));
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.plugins)) {
		throw new Error(`invalid preparation manifest: ${MANIFEST_RELATIVE_PATH}`);
	}

	const plugins: PluginPreparationEntry[] = [];
	for (const entry of value.plugins) {
		if (!isRecord(entry)) throw new Error(`invalid plugin entry in ${MANIFEST_RELATIVE_PATH}`);
		const { name, path: relativePath, ownership, reason } = entry;
		if (
			typeof name !== "string" ||
			typeof relativePath !== "string" ||
			!isPluginOwnership(ownership) ||
			typeof reason !== "string"
		) {
			throw new Error(`invalid plugin entry in ${MANIFEST_RELATIVE_PATH}`);
		}
		plugins.push({ name, path: relativePath, ownership, reason });
	}

	return { version: 1, plugins };
}

function pluginDirectories(repoRoot: string): string[] {
	const pluginsRoot = path.join(repoRoot, PLUGINS_RELATIVE_PATH);
	if (!existsSync(pluginsRoot)) return [];
	return readdirSync(pluginsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => existsSync(path.join(pluginsRoot, name, "package.json")) || lockfilesFor(path.join(pluginsRoot, name)).length > 0)
		.sort();
}

export function validatePluginOwnership(repoRoot: string, manifest: PluginPreparationManifest): string[] {
	const errors: string[] = [];
	const seenNames = new Set<string>();
	const seenPaths = new Set<string>();
	const entriesByPath = new Map<string, PluginPreparationEntry>();

	if (!existsSync(path.join(repoRoot, "package.json"))) errors.push("root package.json is missing");
	if (!existsSync(path.join(repoRoot, PLUGINS_RELATIVE_PATH))) errors.push(`missing ${PLUGINS_RELATIVE_PATH}`);

	for (const entry of manifest.plugins) {
		if (seenNames.has(entry.name)) errors.push(`duplicate plugin name in preparation manifest: ${entry.name}`);
		seenNames.add(entry.name);
		const normalizedPath = normalizeRepoRelativePath(entry.path);
		if (seenPaths.has(normalizedPath)) errors.push(`duplicate plugin path in preparation manifest: ${normalizedPath}`);
		seenPaths.add(normalizedPath);
		entriesByPath.set(normalizedPath, entry);
		errors.push(...validatePluginEntry(repoRoot, entry));
	}

	errors.push(...unclassifiedPluginErrors(repoRoot, entriesByPath));

	return errors;
}

function validatePluginEntry(repoRoot: string, entry: PluginPreparationEntry): string[] {
	const errors: string[] = [];
	const normalizedPath = normalizeRepoRelativePath(entry.path);
	const expectedPrefix = `${PLUGINS_RELATIVE_PATH}/`;
	const segments = normalizedPath.split("/");
	const pluginName = segments.at(-1) ?? "";
	if (path.isAbsolute(entry.path) || !normalizedPath.startsWith(expectedPrefix) || segments.length !== 4) {
		return [`${entry.name}: path must be one direct plugin directory under ${PLUGINS_RELATIVE_PATH}`];
	}
	if (pluginName !== entry.name) errors.push(`${entry.name}: manifest name does not match path ${normalizedPath}`);

	const pluginRoot = pluginRootFor(repoRoot, normalizedPath);
	if (!existsSync(pluginRoot)) return [...errors, `${entry.name}: plugin directory is missing at ${normalizedPath}`];
	if (!existsSync(path.join(pluginRoot, "package.json"))) {
		errors.push(`${entry.name}: package.json is missing at ${normalizedPath}`);
	}
	errors.push(...validateLockOwnership(repoRoot, normalizedPath, pluginRoot, entry));
	if (entry.reason.trim().length === 0) errors.push(`${entry.name}: preparation reason is required`);
	return errors;
}

function validateLockOwnership(
	repoRoot: string,
	relativePath: string,
	pluginRoot: string,
	entry: PluginPreparationEntry,
): string[] {
	const lockfiles = lockfilesFor(pluginRoot);
	if (entry.ownership === "independent-lock") {
		const errors = lockfiles.length === 1 && lockfiles[0] === "bun.lock" ? [] : [`${entry.name}: independent-lock ownership requires exactly bun.lock`];
		if (isRootWorkspaceMember(repoRoot, relativePath)) {
			errors.push(`${entry.name}: independent-lock plugin must not be a root workspace member`);
		}
		return errors;
	}

	const errors = lockfiles.length > 0 ? [`${entry.name}: ${entry.ownership} ownership forbids nested lockfile ${lockfiles.join(", ")}`] : [];
	if (entry.ownership === "root-workspace" && !isRootWorkspaceMember(repoRoot, relativePath)) {
		errors.push(`${entry.name}: root-workspace ownership requires root package.json workspace membership`);
	}
	return errors;
}

function unclassifiedPluginErrors(
	repoRoot: string,
	entriesByPath: ReadonlyMap<string, PluginPreparationEntry>,
): string[] {
	return pluginDirectories(repoRoot)
		.map((name) => `${PLUGINS_RELATIVE_PATH}/${name}`)
		.filter((relativePath) => !entriesByPath.has(relativePath))
		.map((relativePath) => `${path.basename(relativePath)}: plugin directory is unclassified in ${MANIFEST_RELATIVE_PATH}`);
}

function bytesToText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	return value == null ? "" : String(value);
}

function runFrozenInstall(
	bunCommand: string,
	repoRoot: string,
	scope: CommandScope,
	plugin?: string,
): CommandResult {
	const command = [bunCommand, "install", "--frozen-lockfile"];
	try {
		const result = Bun.spawnSync(command, {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			scope,
			...(plugin ? { plugin } : {}),
			cwd: repoRoot,
			command,
			exitCode: result.exitCode,
			stdout: bytesToText(result.stdout),
			stderr: bytesToText(result.stderr),
		};
	} catch (error) {
		return {
			scope,
			...(plugin ? { plugin } : {}),
			cwd: repoRoot,
			command,
			exitCode: 127,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

function receiptStem(record: CommandResult): string {
	return record.scope === "root" ? "root" : `plugin-${record.plugin}`;
}

function prepareReceiptDir(receiptDir: string): void {
	mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
	chmodSync(receiptDir, 0o700);
	const pluginsDir = path.join(receiptDir, "plugins");
	mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
	chmodSync(pluginsDir, 0o700);
}

function writeCommandReceipt(receiptDir: string, result: CommandResult): void {
	const directory = result.scope === "root" ? receiptDir : path.join(receiptDir, "plugins");
	const stem = receiptStem(result);
	writeFileSync(path.join(directory, `${stem}.stdout`), result.stdout, { mode: 0o600 });
	writeFileSync(path.join(directory, `${stem}.stderr`), result.stderr, { mode: 0o600 });
	chmodSync(path.join(directory, `${stem}.stdout`), 0o600);
	chmodSync(path.join(directory, `${stem}.stderr`), 0o600);
}

function emitCommandOutput(result: CommandResult): void {
	const label = result.scope === "root" ? "root" : `plugin:${result.plugin}`;
	if (result.stdout.length > 0) {
		process.stdout.write(`\n[preparation ${label} stdout]\n${result.stdout}`);
		if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
	}
	if (result.stderr.length > 0) {
		process.stderr.write(`\n[preparation ${label} stderr]\n${result.stderr}`);
		if (!result.stderr.endsWith("\n")) process.stderr.write("\n");
	}
}

function writeSummary(receiptDir: string, repoRoot: string, records: ReceiptRecord[], status: string): void {
	const summary = { version: 1, repoRoot, status, records };
	writeFileSync(path.join(receiptDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path.join(receiptDir, "summary.json"), 0o600);
}

function requireOption(argv: string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

function parseOptions(argv: string[]): CliOptions | "help" {
	const options: CliOptions = { repoRoot: path.resolve(import.meta.dir, ".."), bunCommand: "bun" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") return "help";
		if (argument === "--repo-root") {
			options.repoRoot = path.resolve(requireOption(argv, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--bun") {
			options.bunCommand = requireOption(argv, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--receipt-dir") {
			options.receiptDir = path.resolve(requireOption(argv, index, argument));
			index += 1;
			continue;
		}
		throw new Error(`unknown option: ${argument}`);
	}
	return options;
}

function usage(): string {
	return [
		"Usage: bun run tooling/plugin-preparation.ts [options]",
		"",
		"Runs the root frozen install, then each manifest-owned independent plugin install.",
		"",
		"Options:",
		"  --receipt-dir DIR  retain root and nested stdout/stderr separately",
		"  --repo-root DIR    use another checkout (test support)",
		"  --bun COMMAND      use another Bun command (test support)",
	].join("\n");
}

function refusal(receiptDir: string | undefined, repoRoot: string, message: string): number {
	process.stderr.write(`${message}\n`);
	if (receiptDir) {
		writeFileSync(path.join(receiptDir, "validation.stderr"), `${message}\n`, { mode: 0o600 });
		writeSummary(receiptDir, repoRoot, [], "refused");
	}
	return 2;
}

interface PreparationOutcome {
	records: ReceiptRecord[];
	status: "passed" | "failed";
	failureMessage?: string;
}

function executePreparation(options: CliOptions, manifest: PluginPreparationManifest): PreparationOutcome {
	const records: ReceiptRecord[] = [];
	const record = (result: CommandResult): void => {
		records.push({
			scope: result.scope,
			...(result.plugin ? { plugin: result.plugin } : {}),
			command: result.command,
			exitCode: result.exitCode,
			status: result.exitCode === 0 ? "passed" : "failed",
		});
		emitCommandOutput(result);
		if (options.receiptDir) writeCommandReceipt(options.receiptDir, result);
	};

	const rootResult = runFrozenInstall(options.bunCommand, options.repoRoot, "root");
	record(rootResult);
	if (rootResult.exitCode !== 0) {
		return {
			records,
			status: "failed",
			failureMessage: "preparation failed during the root frozen install; nested installs were not started",
		};
	}

	const independentPlugins = manifest.plugins
		.filter((plugin) => plugin.ownership === "independent-lock")
		.sort((left, right) => left.path.localeCompare(right.path));
	for (const entry of independentPlugins) {
		const result = runFrozenInstall(options.bunCommand, pluginRootFor(options.repoRoot, entry.path), "plugin", entry.name);
		record(result);
		if (result.exitCode !== 0) {
			return {
				records,
				status: "failed",
				failureMessage: `preparation failed for ${entry.name}; later plugin installs were not started`,
			};
		}
	}

	return { records, status: "passed" };
}

export function runPreparation(argv: string[] = process.argv.slice(2)): number {
	let options: CliOptions | "help";
	try {
		options = parseOptions(argv);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
		return 2;
	}
	if (options === "help") {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}

	if (options.receiptDir) prepareReceiptDir(options.receiptDir);
	let manifest: PluginPreparationManifest;
	try {
		manifest = loadPreparationManifest(options.repoRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refusal(options.receiptDir, options.repoRoot, `preparation refused: ${message}`);
	}

	const validationErrors = validatePluginOwnership(options.repoRoot, manifest);
	if (validationErrors.length > 0) {
		const message = ["preparation refused: plugin ownership is not classified", ...validationErrors.map((error) => `- ${error}`)].join("\n");
		return refusal(options.receiptDir, options.repoRoot, message);
	}

	const outcome = executePreparation(options, manifest);
	if (options.receiptDir) writeSummary(options.receiptDir, options.repoRoot, outcome.records, outcome.status);
	if (outcome.status === "failed") {
		process.stderr.write(`${outcome.failureMessage}\n`);
		return 1;
	}

	process.stdout.write(`preparation passed: root plus ${outcome.records.length - 1} independent plugin lock(s)\n`);
	return 0;
}

if (import.meta.main) process.exit(runPreparation());
