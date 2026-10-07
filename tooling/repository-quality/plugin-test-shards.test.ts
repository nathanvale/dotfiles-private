import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The repository-checks workflow runs plugin tests as matrix legs, so
// `check:core` runs tooling/plugin-test-shards.ts to keep that matrix equal to
// what `test:plugins` discovers. Each case runs the real guard as a process in
// a fixture repository: it copies the guard and its discovery owner, writes
// plugin manifests and a workflow matrix, and reads the exit and output.

const repoRoot = path.resolve(import.meta.dir, "../..");
const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Leg = [plugin: string, shard: number, shards: number];

function fixtureRepository(plugins: readonly string[], legs: readonly Leg[]): string {
	const root = mkdtempSync(path.join(tmpdir(), "plugin-test-shards-"));
	fixtureRoots.push(root);
	mkdirSync(path.join(root, "tooling"));
	for (const file of ["plugin-tests.ts", "plugin-test-shards.ts"]) {
		copyFileSync(path.join(repoRoot, "tooling", file), path.join(root, "tooling", file));
	}
	for (const plugin of plugins) {
		const pluginRoot = path.join(root, "config/agents/plugins", plugin);
		mkdirSync(pluginRoot, { recursive: true });
		writeFileSync(
			path.join(pluginRoot, "package.json"),
			JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit" } }),
		);
	}
	const include = legs.map(([plugin, shard, shards]) => `          - { plugin: ${plugin}, shard: ${shard}, shards: ${shards} }`);
	mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
	writeFileSync(
		path.join(root, ".github/workflows/repository-checks.yml"),
		["jobs:", "  plugin-tests:", "    strategy:", "      matrix:", "        include:", ...include, ""].join("\n"),
	);
	return root;
}

function runGuard(root: string): { exit: number; output: string } {
	const result = Bun.spawnSync([process.execPath, path.join(root, "tooling/plugin-test-shards.ts")], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exit: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

const COMPLETE: Leg[] = [
	["alpha", 1, 1],
	["beta", 1, 2],
	["beta", 2, 2],
];

test("a matrix with every discovered plugin's shards exactly once passes", () => {
	const { exit, output } = runGuard(fixtureRepository(["alpha", "beta"], COMPLETE));

	expect(output).toContain("PASS: 3 plugin shard leg(s) cover 2 plugin(s)");
	expect(exit).toBe(0);
});

test.each([
	{
		name: "a missing shard leg",
		plugins: ["alpha", "beta"],
		legs: COMPLETE.slice(0, 2),
		error: "beta: matrix shards are [1] but 2 shard(s) need exactly [1, 2]",
	},
	{
		name: "a duplicate shard leg",
		plugins: ["alpha", "beta"],
		legs: [...COMPLETE.slice(0, 2), ["beta", 1, 2] as Leg],
		error: "beta: matrix shards are [1, 1] but 2 shard(s) need exactly [1, 2]",
	},
	{
		name: "a new tested plugin without a leg",
		plugins: ["alpha", "beta", "gamma"],
		legs: COMPLETE,
		error: "gamma: test:plugins runs its tests but the workflow matrix has no leg for it",
	},
])("$name fails the guard and names the gap", ({ plugins, legs, error }) => {
	const { exit, output } = runGuard(fixtureRepository(plugins, legs));

	expect(output).toContain(error);
	expect(exit).toBe(1);
});
