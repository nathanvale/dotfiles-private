import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { authoredCandidate, begin, cleanupFixtures, finish, fixture, git, gitResult, write } from "../helpers/harness.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row V3 plus the hook-invisible rows D7, R3, H3 (GUARD-INTERACTION.md section 6). Sprawl never blocks (invariant I7).

function straySetup(f: ReturnType<typeof fixture>): string {
	git(f.vault, "-c", "core.hooksPath=/nonexistent", "branch", "stray", f.initialHead)
	const foreign = join(f.root, "foreign-worktree")
	git(f.vault, "-c", "core.hooksPath=/nonexistent", "worktree", "add", "--detach", foreign, f.initialHead)
	return foreign
}

test("V3: a stray branch and a foreign worktree are warned on begin and finish, which still integrate", () => {
	const f = fixture()
	const foreign = straySetup(f)
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.exitCode).toBe(0)
	expect(started.stderr).toBe("")
	expect(started.json).toMatchObject({
		ok: true,
		code: "CANDIDATE_READY",
		warnings: ["BRANCH_SPRAWL_PRESENT", "FOREIGN_WORKTREE_PRESENT"],
		guard: { selfTest: "pass", branches: ["refs/heads/stray"], worktrees: [foreign] },
	})
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	const finished = finish(f, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({
		ok: true,
		code: "INTEGRATED",
		warnings: ["BRANCH_SPRAWL_PRESENT", "FOREIGN_WORKTREE_PRESENT"],
		guard: { selfTest: "pass", branches: ["refs/heads/stray"], worktrees: [foreign] },
	})
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test("V3: another Vault Steward candidate of the same vault is not a foreign worktree", () => {
	const f = fixture()
	const first = begin(f, ["projects/first/README.md"])
	const second = begin(f, ["projects/second/README.md"])
	expect(second.json.warnings).toBeUndefined()
	expect(second.json).toMatchObject({ guard: { worktrees: [] } })
	expect(first.json.worktree).not.toBe(second.json.worktree)
})

test("D7: git branch -c is hook-invisible and shows up only as BRANCH_SPRAWL_PRESENT", () => {
	const f = fixture()
	const copied = gitResult(f.vault, ["branch", "-c", "main", "copy"])
	expect(copied.exitCode).toBe(0)
	expect(copied.stderr).not.toContain("VAULT_GUARD_BRANCH_CREATE_DENIED")
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.json).toMatchObject({ ok: true, warnings: ["BRANCH_SPRAWL_PRESENT"], guard: { branches: ["refs/heads/copy"] } })
})

test("R3: git branch -m main renamed leaves no main, and begin refuses NOT_CANONICAL_MAIN", () => {
	const f = fixture()
	const renamed = gitResult(f.vault, ["branch", "-m", "main", "renamed-main"])
	expect(renamed.exitCode).toBe(0)
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/renamed-main")
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.exitCode).toBe(1)
	expect(started.stderr).toBe("")
	expect(started.json).toMatchObject({ ok: false, command: "begin", code: "NOT_CANONICAL_MAIN", changedState: "none" })
	expect(started.json.guard).toBeUndefined()
})

test("R3 through finish: a candidate whose vault lost main is refused without a self-test spawn", () => {
	const f = fixture()
	const worktree = authoredCandidate(f)
	git(f.vault, "branch", "-m", "main", "renamed-main")
	const marker = join(f.root, "hook-ran")
	write(f.vault, ".git/hooks/reference-transaction", `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 0\n`)
	const finished = finish(f, worktree)
	expect(finished.exitCode).toBe(1)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: false, code: "CANONICAL_NOT_READY", guard: { selfTest: "skipped" } })
	expect(Bun.file(marker).size).toBe(0)
})

test("H3: checkout --orphan then commit is denied by Git itself (recorded, not a CLI path)", () => {
	const f = fixture()
	const orphan = gitResult(f.vault, ["checkout", "--orphan", "fresh"])
	expect(orphan.exitCode).toBe(0)
	const committed = gitResult(f.vault, ["commit", "--allow-empty", "-m", "orphan"])
	expect(committed.exitCode).not.toBe(0)
	expect(committed.stderr).toContain("VAULT_GUARD_BRANCH_CREATE_DENIED refs/heads/fresh")
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
})
