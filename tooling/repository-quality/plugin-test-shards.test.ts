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

type Leg = [plugin: string, shard: number | string, shards: number];
type Scripts = Record<string, string>;

const SCRIPTS = { test: "bun test $PLUGIN_TEST_SHARD", typecheck: "tsc --noEmit" };

function fixtureRepository(plugins: Record<string, Scripts>, legs: readonly Leg[]): string {
	const root = mkdtempSync(path.join(tmpdir(), "plugin-test-shards-"));
	fixtureRoots.push(root);
	mkdirSync(path.join(root, "tooling"));
	for (const file of ["plugin-tests.ts", "plugin-test-shards.ts"]) {
		copyFileSync(path.join(repoRoot, "tooling", file), path.join(root, "tooling", file));
	}
	for (const [plugin, scripts] of Object.entries(plugins)) {
		const pluginRoot = path.join(root, "config/agents/plugins", plugin);
		mkdirSync(pluginRoot, { recursive: true });
		writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ scripts }));
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
const PLUGINS = { alpha: SCRIPTS, beta: SCRIPTS };

test("a matrix with every discovered plugin's shards exactly once passes", () => {
	const { exit, output } = runGuard(fixtureRepository(PLUGINS, COMPLETE));

	expect(output).toContain("PASS: 3 plugin shard leg(s) cover 2 plugin(s)");
	expect(exit).toBe(0);
});

test.each([
	"bun test $PLUGIN_TEST_SHARD",
	"bun test ${PLUGIN_TEST_SHARD}",
	'bun test "$PLUGIN_TEST_SHARD"',
	'bun test "${PLUGIN_TEST_SHARD}"',
	"bun run build && bun test packages/example/tests $PLUGIN_TEST_SHARD",
	"bun test $PLUGIN_TEST_SHARD packages/example/tests",
	"bun run build; bun test $PLUGIN_TEST_SHARD",
	"bun test $PLUGIN_TEST_SHARD && echo done",
	"bun\ttest\t$PLUGIN_TEST_SHARD",
])("a shard argument in %s passes the guard", (script) => {
	const plugins = { ...PLUGINS, beta: { ...SCRIPTS, test: script } };
	const { exit, output } = runGuard(fixtureRepository(plugins, COMPLETE));

	expect(output).toContain("PASS: 3 plugin shard leg(s) cover 2 plugin(s)");
	expect(exit).toBe(0);
});

test.each([
	"echo $PLUGIN_TEST_SHARD && bun test",
	'bun test; echo "$PLUGIN_TEST_SHARD"',
	"bun test && echo $PLUGIN_TEST_SHARD",
	"bun test || echo $PLUGIN_TEST_SHARD",
	"bun test | echo $PLUGIN_TEST_SHARD",
	"bun test & echo $PLUGIN_TEST_SHARD",
	"bun test\necho $PLUGIN_TEST_SHARD",
	"echo bun test $PLUGIN_TEST_SHARD",
	"bun test prefix$PLUGIN_TEST_SHARD",
	"bun test $PLUGIN_TEST_SHARD_SUFFIX",
	"bun test '$PLUGIN_TEST_SHARD'",
	"bun test \\$PLUGIN_TEST_SHARD",
])("a shard variable outside a bun test argument in %s fails the guard", (script) => {
	const plugins = { ...PLUGINS, beta: { ...SCRIPTS, test: script } };
	const { exit, output } = runGuard(fixtureRepository(plugins, COMPLETE));

	expect(output).toContain("beta: its 2 matrix shards each run the whole suite because scripts.test does not pass on $PLUGIN_TEST_SHARD");
	expect(exit).toBe(1);
});

test.each([
	{
		name: "a missing shard leg",
		plugins: PLUGINS,
		legs: COMPLETE.slice(0, 2),
		error: "beta: matrix shards are [1] but 2 shard(s) need exactly [1, 2]",
	},
	{
		name: "a duplicate shard leg",
		plugins: PLUGINS,
		legs: [...COMPLETE.slice(0, 2), ["beta", 1, 2] as Leg],
		error: "beta: matrix shards are [1, 1] but 2 shard(s) need exactly [1, 2]",
	},
	{
		name: "a new tested plugin without a leg",
		plugins: { ...PLUGINS, gamma: SCRIPTS },
		legs: COMPLETE,
		error: "gamma: test:plugins runs its tests but the workflow matrix has no leg for it",
	},
	{
		name: "a leg for a plugin test:plugins does not discover",
		plugins: PLUGINS,
		legs: [...COMPLETE, ["gamma", 1, 1] as Leg],
		error: "gamma: the workflow matrix runs it but test:plugins does not discover it",
	},
	{
		name: "legs that disagree on the shard count",
		plugins: PLUGINS,
		legs: [...COMPLETE.slice(0, 2), ["beta", 2, 3] as Leg],
		error: "beta: matrix legs disagree on the shard count (2, 3)",
	},
	{
		name: "a malformed leg",
		plugins: PLUGINS,
		legs: [...COMPLETE, ["beta", "one", 2] as Leg],
		error: 'matrix leg {"plugin":"beta","shard":"one","shards":2} needs a string plugin and integer shard and shards',
	},
	{
		name: "a tested plugin without a typecheck script",
		plugins: { ...PLUGINS, alpha: { test: SCRIPTS.test } },
		legs: COMPLETE,
		error: "alpha: the workflow typechecks every matrix plugin, so it must declare scripts.typecheck",
	},
	{
		name: "a sharded plugin whose test script drops the shard variable",
		plugins: { ...PLUGINS, beta: { ...SCRIPTS, test: "bun test" } },
		legs: COMPLETE,
		error: "beta: its 2 matrix shards each run the whole suite because scripts.test does not pass on $PLUGIN_TEST_SHARD",
	},
])("$name fails the guard and names the gap", ({ plugins, legs, error }) => {
	const { exit, output } = runGuard(fixtureRepository(plugins, legs));

	expect(output).toContain(error);
	expect(exit).toBe(1);
});
