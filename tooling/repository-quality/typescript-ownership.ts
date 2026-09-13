import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MANIFEST_RELATIVE_PATH = "tooling/repository-quality/typescript-ownership.manifest.json";
const ROOT_CONFIG_RELATIVE_PATH = "tsconfig.json";
const TYPESCRIPT_SUFFIXES = [".ts", ".tsx", ".mts", ".cts"] as const;
const MANUAL_OWNERS = ["named-command", "test-owner-only", "unverified-runtime"] as const;
const QUALIFICATIONS = ["ordinary-root-contract", "separate-qualification"] as const;

type ManualOwner = (typeof MANUAL_OWNERS)[number];
type Qualification = (typeof QUALIFICATIONS)[number];

type ManualEntry = {
	path: string;
	owner: ManualOwner;
	qualification: Qualification;
	qualification_name: string;
	command?: string;
	source?: string;
	reason?: string;
};

type Classification = {
	owner: string;
	detail: string;
};

type Manifest = {
	entries: ManualEntry[];
	errors: string[];
};

type GuardReport = {
	schema_version: 1;
	status: "pass" | "fail";
	tracked_typescript_files: number;
	manual_entries: number;
	inventory_paths: string[];
	violations: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function textFrom(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	return value == null ? "" : String(value);
}

function normalizeRepoRelativePath(value: string): string {
	return value.split(path.sep).join("/");
}

function isTypeScriptPath(value: string): boolean {
	return TYPESCRIPT_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function isExactRelativePath(value: string): boolean {
	return (
		value.length > 0 &&
		!path.isAbsolute(value) &&
		value === path.posix.normalize(value) &&
		!value.split("/").includes("..") &&
		["?", "*", "[", "]", "{", "}"].every((character) => !value.includes(character))
	);
}

function trackedTypeScriptFiles(repoRoot: string): string[] {
	const result = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${textFrom(result.stderr).trim()}`);
	}
	return textFrom(result.stdout)
		.split("\0")
		.filter((relativePath) => relativePath.length > 0)
		.map(normalizeRepoRelativePath)
		.filter(isTypeScriptPath)
		.sort();
}

function isManualOwner(value: unknown): value is ManualOwner {
	return MANUAL_OWNERS.includes(value as ManualOwner);
}

function isQualification(value: unknown): value is Qualification {
	return QUALIFICATIONS.includes(value as Qualification);
}

function hasText(value: string | undefined): value is string {
	return value !== undefined && value.trim().length > 0;
}

function metadataErrors(prefix: string, owner: ManualOwner, command: string | undefined, source: string | undefined, reason: string | undefined): string[] {
	if (owner === "unverified-runtime") {
		return hasText(reason) ? [] : [`${prefix}: unverified-runtime requires a concrete reason`];
	}
	return hasText(command) && hasText(source) ? [] : [`${prefix}: named command owners require command and source`];
}

function parseManualEntry(rawEntry: unknown, index: number, tracked: ReadonlySet<string>): { entry?: ManualEntry; errors: string[] } {
	const prefix = `${MANIFEST_RELATIVE_PATH} entry ${index}`;
	if (!isRecord(rawEntry)) return { errors: [`${prefix}: entry must be an object`] };
	const entryPath = rawEntry.path;
	if (typeof entryPath !== "string" || !isExactRelativePath(entryPath) || !isTypeScriptPath(entryPath)) {
		return { errors: [`${prefix}: path must be one exact tracked TypeScript-relative path`] };
	}
	const owner = rawEntry.owner;
	if (!isManualOwner(owner)) return { errors: [`${prefix}: owner must be one of ${MANUAL_OWNERS.join(", ")}`] };
	const qualification = rawEntry.qualification;
	if (!isQualification(qualification)) {
		return { errors: [`${prefix}: qualification must name ordinary-root-contract or separate-qualification`] };
	}
	const qualificationName = rawEntry.qualification_name;
	if (typeof qualificationName !== "string" || qualificationName.trim().length === 0) {
		return { errors: [`${prefix}: qualification_name is required`] };
	}

	const command = typeof rawEntry.command === "string" ? rawEntry.command : undefined;
	const source = typeof rawEntry.source === "string" ? rawEntry.source : undefined;
	const reason = typeof rawEntry.reason === "string" ? rawEntry.reason : undefined;
	const errors = [
		...(tracked.has(entryPath) ? [] : [`${prefix}: path is not a tracked TypeScript file: ${entryPath}`]),
		...metadataErrors(prefix, owner, command, source, reason),
	];
	if (errors.length > 0) return { errors };
	return {
		entry: {
			path: entryPath,
			owner,
			qualification,
			qualification_name: qualificationName,
			...(command === undefined ? {} : { command }),
			...(source === undefined ? {} : { source }),
			...(reason === undefined ? {} : { reason }),
		},
		errors: [],
	};
}

function duplicateManifestErrors(entries: ReadonlyArray<ManualEntry>): string[] {
	const seen = new Set<string>();
	return entries.flatMap((entry) => {
		if (seen.has(entry.path)) return [`${MANIFEST_RELATIVE_PATH}: duplicate exact path: ${entry.path}`];
		seen.add(entry.path);
		return [];
	});
}

function readManifest(repoRoot: string, tracked: ReadonlySet<string>): Manifest {
	const value = readJson(path.join(repoRoot, MANIFEST_RELATIVE_PATH));
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
		throw new Error(`invalid TypeScript ownership manifest: ${MANIFEST_RELATIVE_PATH}`);
	}
	const parsed = value.entries.map((entry, index) => parseManualEntry(entry, index, tracked));
	const entries = parsed.flatMap((result) => (result.entry === undefined ? [] : [result.entry]));
	const errors = parsed.flatMap((result) => result.errors);
	return { entries, errors: [...errors, ...duplicateManifestErrors(entries)] };
}

function tsconfigPatternMatches(repoRoot: string, pattern: string, relativePath: string): boolean {
	const normalizedPattern = normalizeRepoRelativePath(pattern);
	if (new Bun.Glob(normalizedPattern).match(relativePath)) return true;
	if (["*", "?", "[", "{"].some((character) => normalizedPattern.includes(character))) return false;
	const patternPath = path.join(repoRoot, normalizedPattern);
	return existsSync(patternPath) && statSync(patternPath).isDirectory() && relativePath.startsWith(`${normalizedPattern}/`);
}

function rootTsconfigOwner(repoRoot: string, relativePath: string): Classification | undefined {
	const configPath = path.join(repoRoot, ROOT_CONFIG_RELATIVE_PATH);
	if (!existsSync(configPath)) return undefined;
	const config = readJson(configPath);
	if (!isRecord(config) || !Array.isArray(config.include)) return undefined;
	const includes = config.include.filter((pattern): pattern is string => typeof pattern === "string");
	const excludes = Array.isArray(config.exclude)
		? config.exclude.filter((pattern): pattern is string => typeof pattern === "string")
		: [];
	if (!includes.some((pattern) => tsconfigPatternMatches(repoRoot, pattern, relativePath))) return undefined;
	if (excludes.some((pattern) => tsconfigPatternMatches(repoRoot, pattern, relativePath))) return undefined;
	return { owner: "root-tsconfig", detail: ROOT_CONFIG_RELATIVE_PATH };
}

function workspaceRoots(repoRoot: string): string[] {
	const packagePath = path.join(repoRoot, "package.json");
	if (!existsSync(packagePath)) return [];
	const packageJson = readJson(packagePath);
	if (!isRecord(packageJson) || !Array.isArray(packageJson.workspaces)) return [];
	const roots: string[] = [];
	for (const workspace of packageJson.workspaces) {
		if (typeof workspace !== "string") continue;
		const normalized = normalizeRepoRelativePath(workspace);
		if (!normalized.endsWith("/*")) {
			roots.push(normalized);
			continue;
		}
		const parent = normalized.slice(0, -2);
		const parentPath = path.join(repoRoot, parent);
		if (!existsSync(parentPath)) continue;
		for (const child of readdirSync(parentPath, { withFileTypes: true })) {
			if (child.isDirectory()) roots.push(`${parent}/${child.name}`);
		}
	}
	return roots.sort();
}

function pluginRoots(repoRoot: string): string[] {
	const manifestPath = path.join(repoRoot, "tooling/plugin-preparation.json");
	if (!existsSync(manifestPath)) return [];
	const value = readJson(manifestPath);
	if (!isRecord(value) || !Array.isArray(value.plugins)) return [];
	return value.plugins
		.filter(isRecord)
		.map((entry) => entry.path)
		.filter((entry): entry is string => typeof entry === "string")
		.map(normalizeRepoRelativePath)
		.sort();
}

function pathBelongsTo(relativePath: string, root: string): boolean {
	return relativePath === root || relativePath.startsWith(`${root}/`);
}

function packageHasTypecheck(repoRoot: string, root: string): boolean {
	const packagePath = path.join(repoRoot, root, "package.json");
	const configPath = path.join(repoRoot, root, "tsconfig.json");
	if (!existsSync(packagePath) || !existsSync(configPath)) return false;
	const packageJson = readJson(packagePath);
	if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) return false;
	return typeof packageJson.scripts.typecheck === "string" && packageJson.scripts.typecheck.trim().length > 0;
}

function registeredOwner(repoRoot: string, relativePath: string, roots: ReadonlyArray<string>, owner: string): Classification | undefined {
	// A registered workspace or independent plugin is an ownership boundary,
	// not a claim that directory membership typechecks every file. The root
	// project gets a compiler owner only from its explicit tsconfig include set;
	// package-level workspace and plugin checks remain their own proof owners.
	const root = roots.find((candidate) => pathBelongsTo(relativePath, candidate));
	if (root === undefined) return undefined;
	if (owner === "registered-workspace" && !packageHasTypecheck(repoRoot, root)) {
		return {
			owner: "invalid-registered-workspace",
			detail: `${root} must expose package.json, tsconfig.json, and a non-empty scripts.typecheck`,
		};
	}
	if (owner === "independent-plugin" && !packageHasTypecheck(repoRoot, root)) {
		return {
			owner: "invalid-independent-plugin",
			detail: `${root} must expose package.json, tsconfig.json, and a non-empty scripts.typecheck`,
		};
	}
	return { owner, detail: root };
}

function classificationFor(
	repoRoot: string,
	relativePath: string,
	workspacePathList: ReadonlyArray<string>,
	pluginPathList: ReadonlyArray<string>,
): Classification | undefined {
	return (
		rootTsconfigOwner(repoRoot, relativePath) ??
		registeredOwner(repoRoot, relativePath, workspacePathList, "registered-workspace") ??
		registeredOwner(repoRoot, relativePath, pluginPathList, "independent-plugin")
	);
}

type ScanResult = {
	inventoryPaths: string[];
	violations: string[];
};

function scanTrackedFiles(
	repoRoot: string,
	tracked: ReadonlyArray<string>,
	manualByPath: ReadonlyMap<string, ManualEntry>,
	workspacePathList: ReadonlyArray<string>,
	pluginPathList: ReadonlyArray<string>,
): ScanResult {
	const inventoryPaths: string[] = [];
	const violations: string[] = [];

	for (const relativePath of tracked) {
		const classification = classificationFor(repoRoot, relativePath, workspacePathList, pluginPathList);
		const manualEntry = manualByPath.get(relativePath);
		if (classification?.owner.startsWith("invalid-")) {
			violations.push(`${relativePath}: ${classification.detail}`);
			continue;
		}
		if (classification !== undefined) {
			if (manualEntry !== undefined) {
				violations.push(`${relativePath}: manual row is unnecessary; owned by ${classification.owner} (${classification.detail})`);
			}
			continue;
		}
		if (manualEntry === undefined) {
			violations.push(`${relativePath}: no TypeScript proof owner; add one exact manifest row`);
			continue;
		}
		inventoryPaths.push(relativePath);
	}
	return { inventoryPaths, violations };
}

function staleManifestRows(
	repoRoot: string,
	entries: ReadonlyArray<ManualEntry>,
	tracked: ReadonlySet<string>,
	inventoryPaths: ReadonlyArray<string>,
	workspacePathList: ReadonlyArray<string>,
	pluginPathList: ReadonlyArray<string>,
): string[] {
	return entries.flatMap((entry) => {
		if (!tracked.has(entry.path) || inventoryPaths.includes(entry.path)) return [];
		if (classificationFor(repoRoot, entry.path, workspacePathList, pluginPathList) !== undefined) return [];
		return [`${entry.path}: manifest row was not reached by the tracked-file inventory`];
	});
}

function runGuard(repoRoot: string): GuardReport {
	const tracked = trackedTypeScriptFiles(repoRoot);
	const trackedSet = new Set(tracked);
	const manifest = readManifest(repoRoot, trackedSet);
	const manualByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
	const workspacePathList = workspaceRoots(repoRoot);
	const pluginPathList = pluginRoots(repoRoot);
	const scan = scanTrackedFiles(repoRoot, tracked, manualByPath, workspacePathList, pluginPathList);
	const violations = [...manifest.errors, ...scan.violations];
	violations.push(...staleManifestRows(repoRoot, manifest.entries, trackedSet, scan.inventoryPaths, workspacePathList, pluginPathList));

	return {
		schema_version: 1,
		status: violations.length === 0 ? "pass" : "fail",
		tracked_typescript_files: tracked.length,
		manual_entries: manifest.entries.length,
		inventory_paths: scan.inventoryPaths.sort(),
		violations: [...new Set(violations)].sort(),
	};
}

function parseRepoRoot(argv: readonly string[]): string {
	let repoRoot = path.resolve(import.meta.dir, "../..");
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--repo-root") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error("--repo-root requires a value");
			repoRoot = path.resolve(value);
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			process.stdout.write("usage: bun tooling/repository-quality/typescript-ownership.ts [--repo-root PATH]\n");
			process.exit(0);
		}
		throw new Error(`unknown option: ${argument}`);
	}
	return repoRoot;
}

if (import.meta.main) {
	try {
		const report = runGuard(parseRepoRoot(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(report)}\n`);
		process.exitCode = report.status === "pass" ? 0 : 1;
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "operational-failure", error: error instanceof Error ? error.message : String(error) })}\n`);
		process.exitCode = 2;
	}
}
