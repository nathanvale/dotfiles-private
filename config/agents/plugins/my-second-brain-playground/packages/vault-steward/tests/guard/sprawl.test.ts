import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, type Fixture, fixture, git, gitResult, write } from "../helpers/harness.ts"
import { candidate, data, integrate, must, run } from "../helpers/steward.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row V3 plus the hook-invisible rows D7, R3, H3 (GUARD-INTERACTION.md section 6) through begin and the apply. Sprawl
// never blocks (invariant I7); the inspect form of V3 lives in steward-guard.test.ts.

function straySetup(f: Fixture): string {
	git(f.vault, "-c", "core.hooksPath=/nonexistent", "branch", "stray", f.initialHead)
	const foreign = join(f.root, "foreign-worktree")
	git(f.vault, "-c", "core.hooksPath=/nonexistent", "worktree", "add", "--detach", foreign, f.initialHead)
	return foreign
}

const codes = (warnings: unknown): string[] => (warnings as { code: string }[]).map((warning) => warning.code)

test("V3: a stray branch and a foreign worktree are warned on begin and apply, which still integrate", () => {
	const f = fixture()
	const foreign = straySetup(f)
	const started = run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"])
	expect(started.exitCode).toBe(0)
	expect(started.stderr).toBe("")
	const begun = data(must(started, "SUCCESS_COMPLETED"))
	expect(codes(begun.warnings)).toEqual(["BRANCH_SPRAWL_PRESENT", "FOREIGN_WORKTREE_PRESENT"])
	expect(begun.guard).toMatchObject({ selfTest: "pass", branches: ["refs/heads/stray"], worktrees: [foreign] })
	const worktree = (begun.candidate as { worktree: string }).worktree
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	const applied = integrate(f, worktree)
	expect(applied.exitCode).toBe(0)
	expect(applied.stderr).toBe("")
	const done = data(must(applied, "SUCCESS_COMPLETED"))
	expect(codes(done.warnings)).toEqual(["BRANCH_SPRAWL_PRESENT", "FOREIGN_WORKTREE_PRESENT"])
	expect(done.guard).toMatchObject({ selfTest: "pass", branches: ["refs/heads/stray"], worktrees: [foreign] })
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test("V3: another Vault Steward candidate of the same vault is not a foreign worktree", () => {
	const f = fixture()
	const first = candidate(f, "projects/first/README.md", null)
	const begun = data(must(run(f, ["begin", "--vault", f.vault, "--path", "projects/second/README.md"]), "SUCCESS_COMPLETED"))
	expect(begun.warnings).toEqual([])
	expect(begun.guard).toMatchObject({ worktrees: [] })
	expect((begun.candidate as { worktree: string }).worktree).not.toBe(first)
})

test("D7: git branch -c is hook-invisible and shows up only as BRANCH_SPRAWL_PRESENT", () => {
	const f = fixture()
	const copied = gitResult(f.vault, ["branch", "-c", "main", "copy"])
	expect(copied.exitCode).toBe(0)
	expect(copied.stderr).not.toContain("VAULT_GUARD_BRANCH_CREATE_DENIED")
	const begun = data(must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "SUCCESS_COMPLETED"))
	expect(codes(begun.warnings)).toEqual(["BRANCH_SPRAWL_PRESENT"])
	expect(begun.guard).toMatchObject({ branches: ["refs/heads/copy"] })
})

// R3: a renamed main leaves no refs/heads/main. begin and preview refuse DOMAIN_CANONICAL_NOT_MAIN before the
// self-test, so the hook (replaced by a marker after the rename) is never spawned.
test("R3: git branch -m main renamed leaves no main, and begin refuses without a self-test spawn", () => {
	const f = fixture()
	const renamed = gitResult(f.vault, ["branch", "-m", "main", "renamed-main"])
	expect(renamed.exitCode).toBe(0)
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/renamed-main")
	const marker = join(f.root, "hook-ran")
	write(f.vault, ".git/hooks/reference-transaction", `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 0\n`)
	const started = run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"])
	expect(started.exitCode).toBe(3)
	expect(started.stderr).toBe("")
	expect(started.envelope?.result).toMatchObject({ commandIdentity: "vault-steward.begin", causeCode: "DOMAIN_CANONICAL_NOT_MAIN", transactionState: "unchanged", data: null })
	expect(existsSync(marker)).toBe(false)
})

test("R3 through preview: a candidate whose vault lost main is refused without a self-test spawn", () => {
	const f = fixture()
	const worktree = candidate(f)
	git(f.vault, "branch", "-m", "main", "renamed-main")
	const marker = join(f.root, "hook-ran")
	write(f.vault, ".git/hooks/reference-transaction", `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 0\n`)
	const previewed = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])
	expect(previewed.exitCode).toBe(3)
	expect(previewed.stderr).toBe("")
	expect(previewed.envelope?.result.causeCode).toBe("DOMAIN_CANONICAL_NOT_MAIN")
	expect(existsSync(marker)).toBe(false)
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
