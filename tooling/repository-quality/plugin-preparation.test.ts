import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPreparationManifest, validatePluginOwnership } from "../plugin-preparation";

const repoRoot = path.resolve(import.meta.dir, "../..");

test("the preparation manifest classifies every plugin and its lock owner", () => {
	const manifest = loadPreparationManifest(repoRoot);
	expect(validatePluginOwnership(repoRoot, manifest)).toEqual([]);
});

test("a nested lock without a manifest owner is a repository-quality violation", () => {
	const fixture = mkdtempSync(path.join(os.tmpdir(), "plugin-preparation-ownership-"));
	try {
		const pluginRoot = path.join(fixture, "config/agents/plugins/unknown");
		mkdirSync(pluginRoot, { recursive: true });
		writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ workspaces: [] }));
		writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "unknown" }));
		writeFileSync(path.join(pluginRoot, "bun.lock"), "{}\n");

		const errors = validatePluginOwnership(fixture, { version: 1, plugins: [] });
		expect(errors).toContain("unknown: plugin directory is unclassified in tooling/plugin-preparation.json");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("declared lock ownership rejects a forbidden or missing nested lock before checks", () => {
	const fixture = mkdtempSync(path.join(os.tmpdir(), "plugin-preparation-lock-"));
	try {
		const independentRoot = path.join(fixture, "config/agents/plugins/independent");
		const noNestedRoot = path.join(fixture, "config/agents/plugins/no-nested");
		mkdirSync(independentRoot, { recursive: true });
		mkdirSync(noNestedRoot, { recursive: true });
		writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ workspaces: [] }));
		writeFileSync(path.join(independentRoot, "package.json"), JSON.stringify({ name: "independent" }));
		writeFileSync(path.join(noNestedRoot, "package.json"), JSON.stringify({ name: "no-nested" }));
		writeFileSync(path.join(noNestedRoot, "bun.lock"), "{}\n");

		const errors = validatePluginOwnership(fixture, {
			version: 1,
			plugins: [
				{
					name: "independent",
					path: "config/agents/plugins/independent",
					ownership: "independent-lock",
					reason: "fixture",
				},
				{
					name: "no-nested",
					path: "config/agents/plugins/no-nested",
					ownership: "no-nested-install",
					reason: "fixture",
				},
			],
		});
		expect(errors).toContain("independent: independent-lock ownership requires exactly bun.lock");
		expect(errors).toContain("no-nested: no-nested-install ownership forbids nested lockfile bun.lock");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
