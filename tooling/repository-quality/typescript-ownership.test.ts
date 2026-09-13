import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The public child-process proof below is primary; this static import keeps the
// executable guard visible to repository dead-code analysis as its owner.
import "./typescript-ownership";

type GuardReport = {
	status: string;
	violations: string[];
	inventory_paths: string[];
};

type GuardResult = {
	report: GuardReport;
	stdout: string;
	stderr: string;
	exit: number;
};

const repoRoot = path.resolve(import.meta.dir, "../..");
const guardPath = path.join(repoRoot, "tooling/repository-quality/typescript-ownership.ts");
const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runSync(root: string, args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`fixture git command failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}

async function runGuard(root: string): Promise<GuardResult> {
	const child = Bun.spawn([process.execPath, guardPath, "--repo-root", root], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const report = JSON.parse(stdout) as GuardReport;
	return { report, stdout, stderr, exit };
}

function createFixture(withExcludedDirectory = false): string {
	const root = mkdtempSync(path.join(tmpdir(), "typescript-ownership-guard-"));
	fixtureRoots.push(root);
	mkdirSync(path.join(root, "tooling"), { recursive: true });
	mkdirSync(path.join(root, "tooling", "repository-quality"), { recursive: true });
	mkdirSync(path.join(root, "bin"), { recursive: true });
	if (withExcludedDirectory) mkdirSync(path.join(root, "tooling", "generated"), { recursive: true });
	writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ workspaces: [], scripts: { "temporary-script": "bun run bin/temporary-script.ts" } }),
	);
	writeFileSync(
		path.join(root, "tsconfig.json"),
		JSON.stringify({ include: ["tooling/**/*.ts"], exclude: [withExcludedDirectory ? "tooling/generated" : "node_modules"] }),
	);
	writeFileSync(path.join(root, "tooling", "root-owned.ts"), "export const rootOwned = true;\n");
	if (withExcludedDirectory) {
		writeFileSync(path.join(root, "tooling", "generated", "excluded.ts"), "export const excluded = true;\n");
	}
	writeFileSync(
		path.join(root, "tooling", "repository-quality", "typescript-ownership.manifest.json"),
		JSON.stringify({ version: 1, entries: [] }, null, 2),
	);
	runSync(root, ["init", "-q"]);
	runSync(root, ["add", "--", "package.json", "tsconfig.json", "tooling"]);
	return root;
}

function writeManualEntry(root: string, entry: Record<string, string>): void {
	const manifestPath = path.join(root, "tooling", "repository-quality", "typescript-ownership.manifest.json");
	writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [entry] }, null, 2));
	runSync(root, ["add", "--", manifestPath]);
}

test("the public guard accepts the current exact-path non-workspace inventory", async () => {
	const result = await runGuard(repoRoot);

	expect(result.exit).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.report.status).toBe("pass");
	expect(result.report.violations).toEqual([]);
	expect(result.report.inventory_paths).toContain("bin/teams/lib/lines.ts");
	expect(result.report.inventory_paths).toContain("config/agents/skills/personal/imessage-reader/scripts/query-imessage.ts");
});

test("the public guard rejects an unclassified file, then accepts an exact named owner", async () => {
	const root = createFixture();
	const unclassifiedPath = path.join(root, "bin", "temporary-script.ts");
	writeFileSync(unclassifiedPath, "export const temporaryScript = true;\n");
	runSync(root, ["add", "--", unclassifiedPath]);

	const red = await runGuard(root);
	expect(red.exit).toBe(1);
	expect(red.report.status).toBe("fail");
	expect(red.report.violations).toContain("bin/temporary-script.ts: no TypeScript proof owner; add one exact manifest row");

	writeManualEntry(root, {
		path: "bin/temporary-script.ts",
		owner: "named-command",
		qualification: "separate-qualification",
		qualification_name: "temporary-script-command",
		command: "bun run bin/temporary-script.ts",
		source: "fixture/package.json#scripts.temporary-script",
	});
	const green = await runGuard(root);
	expect(green.exit).toBe(0);
	expect(green.report.status).toBe("pass");
	expect(green.report.violations).toEqual([]);
	expect(green.report.inventory_paths).toEqual(["bin/temporary-script.ts"]);
});

test("the public guard rejects a wildcard exemption", async () => {
	const root = createFixture();
	const unclassifiedPath = path.join(root, "bin", "temporary-script.ts");
	writeFileSync(unclassifiedPath, "export const temporaryScript = true;\n");
	writeManualEntry(root, {
		path: "bin/*.ts",
		owner: "unverified-runtime",
		qualification: "separate-qualification",
		qualification_name: "forbidden-wildcard",
		reason: "fixture wildcard",
	});
	runSync(root, ["add", "--", unclassifiedPath]);

	const result = await runGuard(root);
	expect(result.exit).toBe(1);
	expect(result.report.status).toBe("fail");
	expect(result.report.violations.join("\n")).toContain("path must be one exact tracked TypeScript-relative path");
});

test("the fixture root tsconfig is an explicit compiler owner", async () => {
	const root = createFixture();
	const result = await runGuard(root);

	expect(result.exit).toBe(0);
	expect(result.report.status).toBe("pass");
	expect(result.report.inventory_paths).toEqual([]);
	expect(readFileSync(path.join(root, "tooling", "root-owned.ts"), "utf8")).toContain("rootOwned");
});

test("the public guard rejects TypeScript in a no-nested-install plugin without compiler proof", async () => {
	const root = createFixture();
	const pluginRoot = path.join(root, "config", "agents", "plugins", "no-nested");
	mkdirSync(pluginRoot, { recursive: true });
	writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "no-nested-plugin" }));
	writeFileSync(path.join(pluginRoot, "plugin.ts"), "export const pluginOwned = true;\n");
	writeFileSync(
		path.join(root, "tooling", "plugin-preparation.json"),
		JSON.stringify(
			{
				version: 1,
				plugins: [
					{
						name: "no-nested",
						path: "config/agents/plugins/no-nested",
						ownership: "no-nested-install",
						reason: "fixture",
					},
				],
			},
			null,
		2,
		),
	);
	runSync(root, ["add", "--", "config/agents/plugins/no-nested", "tooling/plugin-preparation.json"]);

	const withoutCompilerContract = await runGuard(root);
	expect(withoutCompilerContract.exit).toBe(1);
	expect(withoutCompilerContract.report.status).toBe("fail");
	expect(withoutCompilerContract.report.violations).toContain(
		"config/agents/plugins/no-nested/plugin.ts: config/agents/plugins/no-nested must expose package.json, tsconfig.json, and a non-empty scripts.typecheck",
	);

	writeFileSync(path.join(pluginRoot, "tsconfig.json"), JSON.stringify({ include: ["plugin.ts"] }));
	writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "no-nested-plugin", scripts: { typecheck: "   " } }));
	const withEmptyTypecheck = await runGuard(root);
	expect(withEmptyTypecheck.exit).toBe(1);
	expect(withEmptyTypecheck.report.status).toBe("fail");
	expect(withEmptyTypecheck.report.violations).toContain(
		"config/agents/plugins/no-nested/plugin.ts: config/agents/plugins/no-nested must expose package.json, tsconfig.json, and a non-empty scripts.typecheck",
	);

	writeFileSync(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "no-nested-plugin", scripts: { typecheck: "tsc --noEmit -p tsconfig.json" } }),
	);
	const withCompilerContract = await runGuard(root);
	expect(withCompilerContract.exit).toBe(0);
	expect(withCompilerContract.report.status).toBe("pass");
	expect(withCompilerContract.report.violations).toEqual([]);
});

test("the public guard requires an exact owner for descendants of a root tsconfig directory exclude", async () => {
	const root = createFixture(true);

	const red = await runGuard(root);
	expect(red.exit).toBe(1);
	expect(red.report.status).toBe("fail");
	expect(red.report.violations).toContain("tooling/generated/excluded.ts: no TypeScript proof owner; add one exact manifest row");

	writeManualEntry(root, {
		path: "tooling/generated/excluded.ts",
		owner: "unverified-runtime",
		qualification: "separate-qualification",
		qualification_name: "fixture-generated-exclusion",
		reason: "fixture directory is deliberately excluded from root tsconfig and remains outside ordinary compiler proof.",
	});
	const green = await runGuard(root);
	expect(green.exit).toBe(0);
	expect(green.report.status).toBe("pass");
	expect(green.report.violations).toEqual([]);
	expect(green.report.inventory_paths).toContain("tooling/generated/excluded.ts");
});
