import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { doctorMapFromDiscovery, runDoctor as runDoctorInRuntime } from "../src/doctor.ts";
import type { RepoDiscovery } from "../src/discovery.ts";
import {
	createFileStore,
	resolveAgentWorktreeStoreRoot as resolveStoreRoot,
} from "../src/store.ts";
import {
	createTestStateHome,
	fakeGitRunner,
	mainRepoGitOutputs,
	realAgentWorktreeStoreEntryCount,
} from "./support.ts";

let testState: Awaited<ReturnType<typeof createTestStateHome>>;

beforeAll(async () => {
	testState = await createTestStateHome();
});

afterAll(async () => {
	try {
		expect(await realAgentWorktreeStoreEntryCount()).toBe(
			testState.realStoreEntryCount,
		);
	} finally {
		await testState.cleanup();
	}
});

function runDoctor(
	options: Parameters<typeof runDoctorInRuntime>[0],
) {
	return runDoctorInRuntime({ ...options, env: testState.env });
}

function resolveAgentWorktreeStoreRoot(root: string): string {
	return resolveStoreRoot(root, testState.env);
}

describe("agent-worktree doctor", () => {
	test("returns a blocked map when git root cannot be read", async () => {
		const map = await runDoctor({
			cwd: "/not-a-repo",
			run: async () => ({
				ok: false,
				stdout: "",
				stderr: "not a git repository",
				code: 128,
			}),
		});

		expect(map.status).toBe("blocked");
		expect(map.mutationReadiness).toBe("blocked");
		expect(map.nextActions).toContain("handoff");
		expect(map.repo.strayWorktreeCount).toBeUndefined();
		expect(
			map.checks.find((check) => check.id === "stray_worktrees")?.status,
		).toBe("unknown");
	});

	test("keeps worktree list failures as unknown readable data", () => {
		const discovery = {
			requestedRoot: "/repo",
			gitRoot: "/repo",
			isolation: "main",
			mainOwnerRoot: "/repo",
			worktrees: [],
			linkedWorktrees: [],
			staleDirs: [],
			storeRoot: "/state/agent-worktree/repo-hash",
			issues: [
				{
					code: "worktree_list_failed",
					status: "unknown",
					summary: "Git worktree list failed.",
				},
			],
		} satisfies RepoDiscovery;

		const map = doctorMapFromDiscovery(discovery);

		expect(map.status).toBe("unknown");
		expect(map.mutationReadiness).toBe("unknown");
		expect(map.checks.some((check) => check.id === "worktrees")).toBe(true);
	});

	test("keeps discovery issue checks legible without overloading repo", () => {
		const discovery = {
			requestedRoot: "/repo",
			gitRoot: "/repo",
			isolation: "main",
			mainOwnerRoot: "/repo",
			worktrees: [],
			linkedWorktrees: [],
			staleDirs: [],
			storeRoot: "/state/agent-worktree/repo-hash",
			issues: [
				{
					code: "current_branch_failed",
					status: "unknown",
					summary: "Current branch could not be resolved.",
				},
				{
					code: "default_branch_unknown",
					status: "warn",
					summary: "Default branch could not be inferred.",
				},
				{
					code: "stale_dir_scan_failed",
					status: "warn",
					summary: "Stale worktree dirs could not be scanned.",
				},
			],
		} satisfies RepoDiscovery;

		const map = doctorMapFromDiscovery(discovery);
		const issueCheckIds = map.checks
			.filter((check) => check.owner === "discovery")
			.map((check) => check.id);

		expect(issueCheckIds).toContain("current_branch");
		expect(issueCheckIds).toContain("default_branch");
		expect(issueCheckIds).toContain("stale_dirs");
		expect(issueCheckIds.filter((id) => id === "repo")).toHaveLength(1);
	});

	test("keeps failed isolation detection readable in the doctor map", async () => {
		const outputs: Record<string, string> = {
			...mainRepoGitOutputs("/repo"),
			["git status --porcelain"]: "",
			["git rev-parse --is-shallow-repository"]: "false\n",
			["git merge-base --is-ancestor main main"]: "",
			["git rev-list --left-right --count main...main"]: "0 0\n",
		};
		delete outputs["git rev-parse --git-common-dir"];

		const map = await runDoctor({
			cwd: "/repo",
			run: fakeGitRunner(outputs),
		});

		expect(map.status).toBe("unknown");
		expect(map.repo.isolation).toBeUndefined();
		expect(
			map.checks.some(
				(check) =>
					check.owner === "discovery" &&
					check.summary === "Git isolation could not be classified.",
			),
		).toBe(true);
	});

	test("reports dirty linked worktrees as mutation blockers", async () => {
		const outputs = {
			["git rev-parse --show-toplevel"]: "/repo\n",
			["git worktree list --porcelain"]: `worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo/.worktrees/feat-x
HEAD def
branch refs/heads/feat/x
`,
			["git branch --show-current"]: "feat/x\n",
			["git symbolic-ref --short refs/remotes/origin/HEAD"]: "origin/main\n",
			["git rev-parse --is-shallow-repository"]: "false\n",
			["git merge-base --is-ancestor main main"]: "",
			["git rev-list --left-right --count main...main"]: "0 0\n",
			["git merge-base --is-ancestor feat/x main"]: "",
			["git rev-list --left-right --count main...feat/x"]: "1 0\n",
		};
		const map = await runDoctor({
			cwd: "/repo/.worktrees/feat-x",
			run: async (args, options) => {
				if (args.join(" ") === "git status --porcelain") {
					return {
						ok: true,
						stdout: options.cwd.endsWith("feat-x") ? " M file.txt\n" : "",
						stderr: "",
						code: 0,
					};
				}
				return fakeGitRunner(outputs)(args, options);
			},
		});

		expect(map.status).toBe("blocked");
		expect(map.mutationReadiness).toBe("blocked");
		expect(
			map.checks.find((check) => check.id === "mutations")?.blockers,
		).toContain("feat/x:dirty");
	});

	test("warns with the stray paths when a linked worktree lives outside .worktrees", () => {
		const stray = {
			path: "/repo/.claude/worktrees/feat-z",
			branch: "feat/z",
			isMain: false,
			detached: false,
			prunable: false,
		};
		const discovery = {
			requestedRoot: "/repo",
			gitRoot: "/repo",
			isolation: "main",
			mainOwnerRoot: "/repo",
			worktrees: [
				{ path: "/repo", branch: "main", isMain: true, detached: false, prunable: false },
				stray,
			],
			linkedWorktrees: [stray],
			staleDirs: [],
			defaultBranch: "main",
			storeRoot: "/state/agent-worktree/repo-hash",
			issues: [],
		} satisfies RepoDiscovery;

		const map = doctorMapFromDiscovery(discovery);
		const check = map.checks.find((entry) => entry.id === "stray_worktrees");

		expect(map.status).toBe("warn");
		expect(map.mutationReadiness).toBe("ready");
		expect(map.repo.strayWorktreeCount).toBe(1);
		expect(check?.status).toBe("warn");
		expect(check?.summary).toBe(
			"1 linked worktree lives outside .worktrees: /repo/.claude/worktrees/feat-z",
		);
	});

	test("keeps stray worktrees unknown when the worktree list could not be read", () => {
		const discovery = {
			requestedRoot: "/repo",
			gitRoot: "/repo",
			isolation: "main",
			mainOwnerRoot: "/repo",
			worktrees: [],
			linkedWorktrees: [],
			staleDirs: [],
			storeRoot: "/state/agent-worktree/repo-hash",
			issues: [
				{
					code: "worktree_list_failed",
					status: "unknown",
					summary: "Git worktree list failed.",
				},
			],
		} satisfies RepoDiscovery;

		const map = doctorMapFromDiscovery(discovery);
		const check = map.checks.find(
			(entry) => entry.id === "stray_worktrees",
		);

		expect(check?.status).toBe("unknown");
		expect(check?.summary).toBe(
			"Stray worktrees unknown until the worktree list can be read.",
		);
		expect(map.repo.strayWorktreeCount).toBeUndefined();
	});

	test("keeps stray worktrees unknown when the main owner root is unavailable", () => {
		const linked = {
			path: "/elsewhere/feat-x",
			branch: "feat/x",
			isMain: false,
			detached: false,
			prunable: false,
		};
		const discovery = {
			requestedRoot: "/repo",
			gitRoot: "/repo",
			worktrees: [linked],
			linkedWorktrees: [linked],
			staleDirs: [],
			issues: [],
		} satisfies RepoDiscovery;

		const map = doctorMapFromDiscovery(discovery);
		const check = map.checks.find((entry) => entry.id === "stray_worktrees");

		expect(map.repo.strayWorktreeCount).toBeUndefined();
		expect(check?.status).toBe("unknown");
		expect(check?.summary).toBe(
			"Stray worktrees unknown until the main owner root can be resolved.",
		);
	});

	test("reports ok when every linked worktree lives under .worktrees", () => {
		const owned = {
			path: "/repo/.worktrees/feat-x",
			branch: "feat/x",
			isMain: false,
			detached: false,
			prunable: false,
		};
		const discovery = {
			requestedRoot: "/repo",
			gitRoot: "/repo",
			isolation: "main",
			mainOwnerRoot: "/repo",
			worktrees: [
				{ path: "/repo", branch: "main", isMain: true, detached: false, prunable: false },
				owned,
			],
			linkedWorktrees: [owned],
			staleDirs: [],
			defaultBranch: "main",
			storeRoot: "/state/agent-worktree/repo-hash",
			issues: [],
		} satisfies RepoDiscovery;

		const map = doctorMapFromDiscovery(discovery);

		expect(map.repo.strayWorktreeCount).toBe(0);
		expect(
			map.checks.find((entry) => entry.id === "stray_worktrees")?.status,
		).toBe("ok");
	});

	test("warns when durable records exceed retention threshold", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-worktree-retention-"));
		const store = createFileStore(resolveAgentWorktreeStoreRoot(root));
		await store.writeRun({
			runId: "old-run",
			command: "refresh",
			status: "completed",
			changedState: "complete",
			steps: [],
			events: [],
			createdAtMs: 1,
		});

		const map = await runDoctor({
			cwd: root,
			now: () => 31 * 24 * 60 * 60 * 1000,
			run: fakeGitRunner({
				["git rev-parse --show-toplevel"]: `${root}\n`,
				["git worktree list --porcelain"]: `worktree ${root}
HEAD abc
branch refs/heads/main
`,
				["git branch --show-current"]: "main\n",
				["git symbolic-ref --short refs/remotes/origin/HEAD"]: "origin/main\n",
				["git status --porcelain"]: "",
				["git rev-parse --is-shallow-repository"]: "false\n",
				["git merge-base --is-ancestor main main"]: "",
				["git rev-list --left-right --count main...main"]: "0 0\n",
			}),
		});

		expect(map.checks.find((check) => check.id === "store")?.status).toBe(
			"warn",
		);
	});
});
