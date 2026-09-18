import { afterEach, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { authoredCandidate, cleanupFixtures, finish, fixture, git, runAlias, write } from "../helpers/harness.ts"

afterEach(cleanupFixtures)

// Hazard H1 (CONTRACT.md 4.2 A4): a crash between the fast-forward and the receipt used to leave a candidate that every
// retry refused as SEMANTIC_OVERLAP. The fault: a post-merge hook plants a file where the receipts directory must be
// created, so the completion record fails after main has advanced.
function plantReceiptsFault(vault: string, state: string): string {
	const receipts = join(state, "my-second-brain", "vault-note-commits", "receipts")
	write(vault, ".git/hooks/post-merge", '#!/bin/sh\n/bin/mkdir -p "$(dirname "$FAULT_RECEIPTS")"\n/usr/bin/touch "$FAULT_RECEIPTS"\n')
	Bun.spawnSync(["chmod", "700", join(vault, ".git/hooks/post-merge")])
	return receipts
}

test("a retry after a completion-record crash records INTEGRATED instead of refusing SEMANTIC_OVERLAP", () => {
	const f = fixture()
	const worktree = authoredCandidate(f)
	const receipts = plantReceiptsFault(f.vault, f.state)
	const crashed = runAlias(f.vault, ["finish", "--worktree", worktree, "--message", "docs: complete goal"], { XDG_STATE_HOME: f.state, FAULT_RECEIPTS: receipts })
	expect(crashed.exitCode).toBe(1)
	expect(crashed.stderr).toBe("")
	expect(crashed.json).toMatchObject({ ok: false, code: "COMPLETION_RECORD_FAILED", retrySafe: false, changedState: "partial", sideEffects: ["candidate-commit-preserved"] })
	const commit = crashed.json.commit as string
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(commit)
	expect(existsSync(worktree)).toBe(true)
	expect(existsSync(join(f.vault, ".git", "vault-note-commits.lock"))).toBe(false)

	rmSync(receipts)
	rmSync(join(f.vault, ".git/hooks/post-merge"))
	const recovered = finish(f, worktree, "docs: complete goal")
	expect(recovered.exitCode).toBe(0)
	expect(recovered.stderr).toBe("")
	expect(recovered.json).toMatchObject({
		ok: true,
		code: "INTEGRATED",
		commit,
		changedState: "complete",
		sideEffects: ["canonical-main-fast-forwarded", "completion-reference-written", "completion-receipt-written", "candidate-worktree-removed"],
		guard: { selfTest: "pass" },
	})
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	expect(git(f.vault, "rev-parse", `refs/vault-note-commits/${recovered.json.runId as string}`)).toBe(commit)
	expect(existsSync(worktree)).toBe(false)
	expect(finish(f, worktree).json).toMatchObject({ ok: true, code: "ALREADY_COMPLETED", originalCode: "INTEGRATED", commit })
})

test("the same recovery holds after a rebase moved the candidate commit before the crash", () => {
	const f = fixture()
	const worktree = authoredCandidate(f, "projects/demo/GOAL.md")
	write(f.vault, "README.md", "# Fixture vault\n\nMoved on.\n")
	git(f.vault, "add", "--", "README.md")
	git(f.vault, "commit", "-m", "docs: main moves first")
	const movedMain = git(f.vault, "rev-parse", "HEAD")
	const receipts = plantReceiptsFault(f.vault, f.state)
	const crashed = runAlias(f.vault, ["finish", "--worktree", worktree, "--message", "docs: complete goal"], { XDG_STATE_HOME: f.state, FAULT_RECEIPTS: receipts })
	expect(crashed.json).toMatchObject({ ok: false, code: "COMPLETION_RECORD_FAILED" })
	const rebased = crashed.json.commit as string
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(rebased)
	expect(git(f.vault, "rev-parse", `${rebased}^`)).toBe(movedMain)

	rmSync(receipts)
	rmSync(join(f.vault, ".git/hooks/post-merge"))
	const recovered = finish(f, worktree, "docs: complete goal")
	expect(recovered.json).toMatchObject({ ok: true, code: "INTEGRATED", commit: rebased })
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("2")
})

test("a committed candidate that main does not contain is still validated, not recorded", () => {
	const f = fixture()
	const started = runAlias(f.vault, ["begin", "--vault", f.vault, "--path", "BROKEN"], { XDG_STATE_HOME: f.state })
	const worktree = started.json.worktree as string
	write(worktree, "BROKEN", "fail\n")
	git(worktree, "add", "--", "BROKEN")
	git(worktree, "commit", "-m", "docs: candidate created outside helper")
	expect(finish(f, worktree).json).toMatchObject({ ok: false, code: "CHECK_FAILED" })
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
})
