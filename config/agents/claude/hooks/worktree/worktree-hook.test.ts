import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createHook = join(import.meta.dir, "worktree-create.ts");
const removeHook = join(import.meta.dir, "worktree-remove.ts");
const SPAWN_TIMEOUT_MS = 60_000;
// Isolate temp repos from global/system git config (gpgsign, hooksPath,
// templates); explicit `git config` calls inside the repos still apply.
const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

interface HookRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function git(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", [...args], {
		cwd,
		env: gitEnv,
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function runHook(script: string, payload: Record<string, unknown>): HookRun {
	const result = spawnSync(process.execPath, [script], {
		cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
		env: gitEnv,
		input: JSON.stringify(payload),
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS,
		killSignal: "SIGKILL",
		stdio: ["pipe", "pipe", "pipe"],
	});
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/**
 * Seed a repo shaped like a real clone: main, a commit, and an origin default
 * branch, which the runtime's merge evidence and the hook's base ref rely on.
 * The temp root is kept on failure so a red run can be inspected.
 */
function withTempRepo<T>(body: (repo: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "claude-worktree-hook-"));
	const repoPath = join(root, "repo");
	mkdirSync(repoPath);
	const repo = realpathSync(repoPath);
	git(repo, ["init", "--initial-branch=main"]);
	git(repo, ["config", "user.name", "worktree hook test"]);
	git(repo, ["config", "user.email", "worktree-hook@example.test"]);
	git(repo, ["commit", "--allow-empty", "-m", "chore: seed"]);
	git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
	try {
		const value = body(repo);
		rmSync(root, { recursive: true, force: true });
		return value;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message}\nkeptTempRoot=${root}`, { cause: error });
	}
}

function registeredPaths(repo: string): string[] {
	return git(repo, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

function createViaHook(cwd: string, name: string): string {
	const result = runHook(createHook, { cwd, name });
	expect(result.exitCode).toBe(0);
	return result.stdout.trim();
}

describe("Claude Code worktree hooks (public process)", () => {
	test("WorktreeCreate lands the checkout at <repo>/.worktrees/<name> and prints only that path", () => {
		withTempRepo((repo) => {
			const expected = join(repo, ".worktrees", "probe");

			const result = runHook(createHook, { cwd: repo, name: "probe" });

			expect(result).toEqual({ exitCode: 0, stdout: `${expected}\n`, stderr: "" });
			expect(registeredPaths(repo)).toEqual([repo, expected]);
			expect(git(expected, ["branch", "--show-current"]).trim()).toBe("probe");
		});
	});

	test("WorktreeCreate branches from the origin default branch, not the local checkout", () => {
		withTempRepo((repo) => {
			const originHead = git(repo, ["rev-parse", "refs/remotes/origin/main"]).trim();
			git(repo, ["commit", "--allow-empty", "-m", "chore: local-only commit"]);

			const path = createViaHook(repo, "fresh");

			expect(git(path, ["rev-parse", "HEAD"]).trim()).toBe(originHead);
		});
	});

	test("WorktreeCreate works from inside a linked worktree and still lands under the main checkout", () => {
		withTempRepo((repo) => {
			const outer = createViaHook(repo, "outer");

			const result = runHook(createHook, { cwd: outer, name: "inner" });

			expect(result).toEqual({
				exitCode: 0,
				stdout: `${join(repo, ".worktrees", "inner")}\n`,
				stderr: "",
			});
			expect(registeredPaths(repo)).toEqual([
				repo,
				join(repo, ".worktrees", "inner"),
				outer,
			]);
		});
	});

	test("WorktreeCreate reopens an existing checkout of the same name", () => {
		withTempRepo((repo) => {
			const first = createViaHook(repo, "reuse");
			writeFileSync(join(first, "draft.txt"), "keep me\n");

			const result = runHook(createHook, { cwd: repo, name: "reuse" });

			expect(result).toEqual({ exitCode: 0, stdout: `${first}\n`, stderr: "" });
			expect(registeredPaths(repo)).toEqual([repo, first]);
			expect(existsSync(join(first, "draft.txt"))).toBe(true);
		});
	});

	test("WorktreeCreate still finds the runtime when launched through the ~/.claude/hooks symlink", () => {
		withTempRepo((repo) => {
			const linkRoot = mkdtempSync(join(tmpdir(), "claude-hooks-link-"));
			const link = join(linkRoot, "hooks");
			symlinkSync(join(import.meta.dir, ".."), link);
			try {
				const result = runHook(join(link, "worktree", "worktree-create.ts"), {
					cwd: repo,
					name: "via-link",
				});

				expect(result).toEqual({
					exitCode: 0,
					stdout: `${join(repo, ".worktrees", "via-link")}\n`,
					stderr: "",
				});
			} finally {
				rmSync(linkRoot, { recursive: true, force: true });
			}
		});
	});

	test("WorktreeRemove removes a clean registered checkout and its branch", () => {
		withTempRepo((repo) => {
			const path = createViaHook(repo, "clean");

			const result = runHook(removeHook, { cwd: repo, worktree_path: path });

			expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
			expect(registeredPaths(repo)).toEqual([repo]);
			expect(existsSync(path)).toBe(false);
			expect(git(repo, ["branch", "--list", "clean"]).trim()).toBe("");
		});
	});

	test("WorktreeRemove refuses a dirty checkout and preserves its files", () => {
		withTempRepo((repo) => {
			const path = createViaHook(repo, "dirty");
			writeFileSync(join(path, "draft.txt"), "keep me\n");

			const result = runHook(removeHook, { cwd: repo, worktree_path: path });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("dirty");
			expect(existsSync(join(path, "draft.txt"))).toBe(true);
			expect(registeredPaths(repo)).toEqual([repo, path]);
		});
	});

	test("WorktreeRemove refuses a checkout with commits main does not have", () => {
		withTempRepo((repo) => {
			const path = createViaHook(repo, "unmerged");
			git(path, ["config", "user.name", "worktree hook test"]);
			git(path, ["config", "user.email", "worktree-hook@example.test"]);
			git(path, ["commit", "--allow-empty", "-m", "feat: unpushed work"]);

			const result = runHook(removeHook, { cwd: repo, worktree_path: path });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			// The runtime cannot rule out a squash merge in v1, so commits main
			// lacks surface as unreliable evidence and hand off instead of deleting.
			expect(result.stderr).toContain("evidence_unreliable");
			expect(registeredPaths(repo)).toEqual([repo, path]);
			// `+` marks a branch checked out in a linked worktree.
			expect(git(repo, ["branch", "--list", "unmerged"]).trim()).toBe("+ unmerged");
		});
	});

	test("WorktreeRemove refuses a detached checkout and leaves it in place", () => {
		withTempRepo((repo) => {
			const path = join(repo, ".worktrees", "detached");
			git(repo, ["worktree", "add", "--detach", path]);

			const result = runHook(removeHook, { cwd: repo, worktree_path: path });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("detached");
			expect(registeredPaths(repo)).toEqual([repo, path]);
		});
	});

	test("WorktreeRemove refuses a path git does not register", () => {
		withTempRepo((repo) => {
			const result = runHook(removeHook, {
				cwd: repo,
				worktree_path: join(repo, ".worktrees", "ghost"),
			});

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("not a registered worktree");
		});
	});
});
