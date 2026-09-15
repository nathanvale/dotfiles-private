import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Invariant: config/agents/plugins/* keep their own lockfiles and are not root
// workspace members, so `bun run --filter '*' test` never reaches
// them. Every plugin that carries tests must therefore either be a root
// workspace member (only `proof` is today) or declare `scripts.test`, so
// `tooling/plugin-tests.ts` can bridge it into `bun run check`.

const repoRoot = path.resolve(import.meta.dir, "../..");
const pluginsRoot = path.join(repoRoot, "config/agents/plugins");
const claudeMarketplaceRelativePath = ".claude-plugin/marketplace.json";
const codexMarketplaceRelativePath = ".agents/plugins/marketplace.json";
const claudePluginManifestRelativePath = ".claude-plugin/plugin.json";
const codexPluginManifestRelativePath = ".codex-plugin/plugin.json";

type MarketplaceEntry = {
	name?: unknown;
	source?: unknown;
	version?: unknown;
};

type MarketplaceManifest = {
	name?: unknown;
	plugins?: unknown;
};

type PluginManifest = {
	name?: unknown;
	version?: unknown;
};

type LoadedMarketplace = {
	entries: Map<string, MarketplaceEntry>;
	label: string;
};

type LoadedPluginManifest = {
	label: string;
	manifest: PluginManifest;
};

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function displayPluginPath(root: string, filePath: string): string {
	const relative = path.relative(root, filePath).split(path.sep).join(path.posix.sep);
	return path.posix.join("config/agents/plugins", relative);
}

function marketplaceEntries(
	manifest: MarketplaceManifest,
	manifestPath: string,
	violations: string[],
): Map<string, MarketplaceEntry> {
	const entries = new Map<string, MarketplaceEntry>();
	if (!Array.isArray(manifest.plugins)) {
		violations.push(`${manifestPath}: plugins must be an array`);
		return entries;
	}

	for (const candidate of manifest.plugins) {
		if (typeof candidate !== "object" || candidate === null) {
			violations.push(`${manifestPath}: every plugin entry must be an object`);
			continue;
		}
		const entry = candidate as MarketplaceEntry;
		if (typeof entry.name !== "string" || entry.name.length === 0) {
			violations.push(`${manifestPath}: every plugin entry must declare a non-empty name`);
			continue;
		}
		if (entries.has(entry.name)) {
			violations.push(`${manifestPath}: duplicate plugin entry "${entry.name}"`);
			continue;
		}
		entries.set(entry.name, entry);
	}

	return entries;
}

function loadMarketplace(root: string, relativePath: string, violations: string[]): LoadedMarketplace {
	const filePath = path.join(root, relativePath);
	const label = displayPluginPath(root, filePath);
	const manifest = readJson<MarketplaceManifest>(filePath);
	if (manifest.name !== "personal") {
		violations.push(`${label}: marketplace name must be "personal", got ${JSON.stringify(manifest.name)}`);
	}
	return { entries: marketplaceEntries(manifest, label, violations), label };
}

function discoverPluginNames(
	root: string,
	claudeEntries: Map<string, MarketplaceEntry>,
	codexEntries: Map<string, MarketplaceEntry>,
): string[] {
	const pluginNames = new Set([...claudeEntries.keys(), ...codexEntries.keys()]);
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pluginRoot = path.join(root, entry.name);
		if (
			existsSync(path.join(pluginRoot, claudePluginManifestRelativePath)) ||
			existsSync(path.join(pluginRoot, codexPluginManifestRelativePath))
		) {
			pluginNames.add(entry.name);
		}
	}
	return [...pluginNames].sort();
}

function validateCatalogPresence(
	pluginName: string,
	claude: LoadedMarketplace,
	codex: LoadedMarketplace,
	violations: string[],
): void {
	if (!claude.entries.has(pluginName)) {
		violations.push(`${claude.label}: add plugin "${pluginName}" to match ${codex.label}`);
	}
	if (!codex.entries.has(pluginName)) {
		violations.push(`${codex.label}: add plugin "${pluginName}" to match ${claude.label}`);
	}
}

function isCodexLocalSource(source: unknown, pluginName: string): boolean {
	return (
		typeof source === "object" &&
		source !== null &&
		"source" in source &&
		source.source === "local" &&
		"path" in source &&
		source.path === `./${pluginName}`
	);
}

function validateMarketplaceSources(
	pluginName: string,
	claude: LoadedMarketplace,
	codex: LoadedMarketplace,
	violations: string[],
): void {
	if (claude.entries.get(pluginName)?.source !== `./${pluginName}`) {
		violations.push(`${claude.label}: plugin "${pluginName}" source must be "./${pluginName}"`);
	}
	if (!isCodexLocalSource(codex.entries.get(pluginName)?.source, pluginName)) {
		violations.push(`${codex.label}: plugin "${pluginName}" source must be local path "./${pluginName}"`);
	}
}

function loadPluginManifests(root: string, pluginName: string, violations: string[]): LoadedPluginManifest[] {
	const manifests: LoadedPluginManifest[] = [];
	for (const relativePath of [claudePluginManifestRelativePath, codexPluginManifestRelativePath]) {
		const filePath = path.join(root, pluginName, relativePath);
		const label = displayPluginPath(root, filePath);
		if (!existsSync(filePath)) {
			violations.push(`${label}: add this counterpart manifest for plugin "${pluginName}"`);
			continue;
		}
		manifests.push({ label, manifest: readJson<PluginManifest>(filePath) });
	}
	return manifests;
}

function validatePluginManifestNames(
	pluginName: string,
	manifests: LoadedPluginManifest[],
	violations: string[],
): void {
	for (const { label, manifest } of manifests) {
		if (manifest.name !== pluginName) {
			violations.push(`${label}: plugin name must be "${pluginName}", got ${JSON.stringify(manifest.name)}`);
		}
	}
}

function validatePluginVersions(
	pluginName: string,
	claude: LoadedMarketplace,
	codex: LoadedMarketplace,
	manifests: LoadedPluginManifest[],
	violations: string[],
): void {
	const versions: [string, unknown][] = [
		[claude.label, claude.entries.get(pluginName)?.version],
		[codex.label, codex.entries.get(pluginName)?.version],
		...manifests.map(({ label, manifest }): [string, unknown] => [label, manifest.version]),
	];
	const versionValues = new Set(versions.map(([, version]) => version));
	if (versionValues.size === 1 && typeof versions[0]?.[1] === "string") return;
	violations.push(
		`${pluginName}: version mismatch: ${versions
			.map(([label, version]) => `${label}=${JSON.stringify(version)}`)
			.join(", ")}`,
	);
}

function pluginMarketplaceViolations(root: string): string[] {
	const violations: string[] = [];
	const claude = loadMarketplace(root, claudeMarketplaceRelativePath, violations);
	const codex = loadMarketplace(root, codexMarketplaceRelativePath, violations);

	for (const pluginName of discoverPluginNames(root, claude.entries, codex.entries)) {
		validateCatalogPresence(pluginName, claude, codex, violations);
		validateMarketplaceSources(pluginName, claude, codex, violations);
		const manifests = loadPluginManifests(root, pluginName, violations);
		validatePluginManifestNames(pluginName, manifests, violations);
		validatePluginVersions(pluginName, claude, codex, manifests, violations);
	}

	return violations;
}

function isTestFile(filename: string): boolean {
	return /\.test\.(ts|tsx|js|mjs|cjs)$/.test(filename) || /^test_.*\.py$/.test(filename);
}

function hasTestFiles(dir: string): boolean {
	for (const relative of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
		const segments = relative.split(path.sep);
		if (segments.includes("node_modules") || segments.includes("fixtures")) continue;
		if (isTestFile(segments[segments.length - 1] ?? "")) return true;
	}
	return false;
}

function listWorkspaceMembers(rootManifest: { workspaces: string[] }): Set<string> {
	const members = new Set<string>();
	for (const entry of rootManifest.workspaces) {
		if (!entry.endsWith("/*")) {
			members.add(entry);
			continue;
		}
		const parent = entry.slice(0, -"/*".length);
		for (const child of readdirSync(path.join(repoRoot, parent), { withFileTypes: true })) {
			if (child.isDirectory()) members.add(`${parent}/${child.name}`);
		}
	}
	return members;
}

function violationForDirectory(dir: string, label: string, isWorkspaceMember: boolean): string | null {
	if (!hasTestFiles(dir)) return null;
	if (isWorkspaceMember) return null;
	const manifestPath = path.join(dir, "package.json");
	if (!existsSync(manifestPath)) return `${label}: has tests but no package.json`;
	const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
	if (typeof scripts.test === "string") return null;
	return `${label}: has tests but package.json declares no scripts.test`;
}

test("every plugin with tests is a workspace member or declares scripts.test", () => {
	const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
	const workspaceMembers = listWorkspaceMembers(rootManifest);

	const pluginNames = readdirSync(pluginsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

	const violations = pluginNames
		.map((name) =>
			violationForDirectory(
				path.join(pluginsRoot, name),
				name,
				workspaceMembers.has(`config/agents/plugins/${name}`),
			),
		)
		.filter((violation): violation is string => violation !== null);

	expect(violations.join("\n")).toBe("");
});

test("personal plugin marketplace entries and native manifests agree", () => {
	expect(pluginMarketplaceViolations(pluginsRoot).join("\n")).toBe("");
});

test("a plugin version mismatch names every disagreeing manifest", () => {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "plugin-marketplace-version-negative-"));
	try {
		mkdirSync(path.join(tempDir, ".claude-plugin"), { recursive: true });
		mkdirSync(path.join(tempDir, ".agents", "plugins"), { recursive: true });
		mkdirSync(path.join(tempDir, "fixture", ".claude-plugin"), { recursive: true });
		mkdirSync(path.join(tempDir, "fixture", ".codex-plugin"), { recursive: true });
		writeFileSync(
			path.join(tempDir, claudeMarketplaceRelativePath),
			JSON.stringify({
				name: "personal",
				plugins: [{ name: "fixture", version: "1.0.0", source: "./fixture" }],
			}),
		);
		writeFileSync(
			path.join(tempDir, codexMarketplaceRelativePath),
			JSON.stringify({
				name: "personal",
				plugins: [
					{ name: "fixture", version: "2.0.0", source: { source: "local", path: "./fixture" } },
				],
			}),
		);
		writeFileSync(
			path.join(tempDir, "fixture", claudePluginManifestRelativePath),
			JSON.stringify({ name: "fixture", version: "1.0.0" }),
		);
		writeFileSync(
			path.join(tempDir, "fixture", codexPluginManifestRelativePath),
			JSON.stringify({ name: "fixture", version: "1.0.0" }),
		);

		expect(pluginMarketplaceViolations(tempDir)).toEqual([
			'fixture: version mismatch: config/agents/plugins/.claude-plugin/marketplace.json="1.0.0", config/agents/plugins/.agents/plugins/marketplace.json="2.0.0", config/agents/plugins/fixture/.claude-plugin/plugin.json="1.0.0", config/agents/plugins/fixture/.codex-plugin/plugin.json="1.0.0"',
		]);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("a one-marketplace plugin names the counterpart entry and manifest to add", () => {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "plugin-marketplace-counterpart-negative-"));
	try {
		mkdirSync(path.join(tempDir, ".claude-plugin"), { recursive: true });
		mkdirSync(path.join(tempDir, ".agents", "plugins"), { recursive: true });
		mkdirSync(path.join(tempDir, "fixture", ".claude-plugin"), { recursive: true });
		writeFileSync(
			path.join(tempDir, claudeMarketplaceRelativePath),
			JSON.stringify({
				name: "personal",
				plugins: [{ name: "fixture", version: "1.0.0", source: "./fixture" }],
			}),
		);
		writeFileSync(
			path.join(tempDir, codexMarketplaceRelativePath),
			JSON.stringify({ name: "personal", plugins: [] }),
		);
		writeFileSync(
			path.join(tempDir, "fixture", claudePluginManifestRelativePath),
			JSON.stringify({ name: "fixture", version: "1.0.0" }),
		);

		const violations = pluginMarketplaceViolations(tempDir);

		expect(violations).toContain(
			'config/agents/plugins/.agents/plugins/marketplace.json: add plugin "fixture" to match config/agents/plugins/.claude-plugin/marketplace.json',
		);
		expect(violations).toContain(
			'config/agents/plugins/fixture/.codex-plugin/plugin.json: add this counterpart manifest for plugin "fixture"',
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("a plugin directory with tests and no test script is reported as a violation", () => {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "plugin-tests-negative-"));
	try {
		mkdirSync(path.join(tempDir, "src"), { recursive: true });
		writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
		writeFileSync(path.join(tempDir, "src", "main.test.ts"), "");

		const violation = violationForDirectory(tempDir, "fixture", false);

		expect(violation).toBe("fixture: has tests but package.json declares no scripts.test");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
