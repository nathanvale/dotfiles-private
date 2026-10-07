import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const pluginRoot = join(repoRoot, "config/agents/plugins/personal");
// Independent oracle: preserved identities from the pre-migration discovery matrix.
const codexNames = [
	"agent-reliability-guardrails", "apple-reminders", "bestie", "bitbucket", "ci-testbed",
	"classic-cinema", "codex-code-review", "context-advisor", "context-unhobble-audit",
	"design-parity-session", "figma", "gh-account-switch", "heal-skill", "home-assistant-use",
	"imazing-archive", "imessage-reader", "last30days", "mcp-doctor", "notion", "one-password",
	"pattern-referee", "peekaboo", "resume-handoff", "retro-scrum-master", "session-picker",
	"session-recovery", "storybook-matrix", "stream-deck-author", "stream-deck-use", "summarize",
	"teams", "test-design", "test-runner", "timesheets", "vocab-refresh", "work-music", "worktree",
	"xero", "xero-cash-coding",
];
const claudeNames = [
	"bestie", "ci-testbed", "classic-cinema", "codex-code-review", "context-advisor",
	"design-parity-session", "fix-microphone", "gh-account-switch", "home-assistant-use",
	"imazing-archive", "imessage-reader", "last30days", "one-password", "pattern-referee",
	"peekaboo", "resume-handoff", "session-picker", "storybook-matrix", "summarize",
	"test-design", "test-runner", "timesheets", "work-music", "worktree", "xero", "xero-cash-coding",
];
const bundleEntries = [
	"bitbucket/dist/cli.js", "bitbucket/dist/generate-openapi-baseline.js",
	"classic-cinema/dist/list-movies.js", "classic-cinema/dist/check-availability.js",
	"classic-cinema/dist/parse-tickets.js", "classic-cinema/dist/pick-seats.js",
	"classic-cinema/dist/fill-ticket.js", "classic-cinema/dist/heal-skill.js",
	"session-recovery/dist/cli.js", "test-runner/dist/test-runner.js",
	"test-runner/dist/test-runner.benchmark.js", "worktree/dist/worktree.js",
	"xero/dist/quarter-ledger.js",
];
let copiedRoot: string;
let fixtureRoot: string;

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "personal-plugin-copy-"));
	copiedRoot = join(fixtureRoot, "personal");
	cpSync(pluginRoot, copiedRoot, {
		recursive: true,
		filter: (source) => !source.split("/").some((part) => ["node_modules", ".venv", "__pycache__", "var"].includes(part)),
	});
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function copiedProcess(argv: string[]) {
	return Bun.spawnSync(argv, {
		cwd: fixtureRoot,
		env: { ...process.env, XDG_STATE_HOME: join(fixtureRoot, "state") },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
	});
}

test("native manifests preserve the independent per-Harness enabled sets", () => {
	const codex = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
	const claude = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
	expect(codex.skills).toBe("./library/");
	expect(readdirSync(join(pluginRoot, "library")).sort()).toEqual(codexNames);
	expect(claude.skills.map((entry: string) => entry.split("/").at(-1)).sort()).toEqual(claudeNames);
	for (const entry of claude.skills) expect(existsSync(join(pluginRoot, entry, "SKILL.md"))).toBe(true);
	expect(existsSync(join(pluginRoot, "optional/fix-microphone/SKILL.md"))).toBe(true);
	expect(existsSync(join(pluginRoot, "skills"))).toBe(false);
	expect(existsSync(join(repoRoot, "config/agents/skills/personal"))).toBe(false);
});

test("Matt's native installation is absent from the reviewed source registry", () => {
	const topology = JSON.parse(readFileSync(join(repoRoot, "config/agents/skills/topology.json"), "utf8"));
	const lock = JSON.parse(readFileSync(join(repoRoot, "config/agents/skills/.skill-lock.json"), "utf8"));
	expect(topology.personal).toBeUndefined();
	expect(topology.protectedHarness).toBeUndefined();
	expect(Object.keys(topology.thirdParty)).toHaveLength(32);
	expect(Object.keys(lock.skills)).toHaveLength(32);
	for (const entry of Object.values(topology.thirdParty) as { owner: string }[]) {
		expect(entry.owner).not.toBe("mattpocock/skills");
	}
	for (const entry of Object.values(lock.skills) as { source: string }[]) {
		expect(entry.source).not.toBe("mattpocock/skills");
	}
	expect(existsSync(join(repoRoot, "config/agents/skills/third-party/mattpocock"))).toBe(false);
});

for (const entry of bundleEntries) {
	test(`copied plugin runs ${entry} without checkout dependencies`, () => {
		const result = copiedProcess([process.execPath, "--no-install", join(copiedRoot, "library", entry), "--help"]);
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(result.stdout.toString().trim().length).toBeGreaterThan(0);
	});
}

test("copied runner preflight executes a real passing fixture using its bundled runtime", () => {
	writeFileSync(join(fixtureRoot, "copied.test.ts"), 'import { expect, test } from "bun:test"; test("copied fixture", () => expect(2 + 2).toBe(4));\n');
	const wrapper = join(copiedRoot, "library/test-runner/src/test-runner.sh");
	const result = copiedProcess([wrapper, "run", "--cwd", fixtureRoot, "--json", "--", "copied.test.ts"]);
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	const report = JSON.parse(result.stdout.toString());
	expect(report.status).toBe("ok");
	expect(report.data.summary.passed).toBe(1);
});
