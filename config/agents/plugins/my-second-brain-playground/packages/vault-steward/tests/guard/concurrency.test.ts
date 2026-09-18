import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { authoredCandidate, begin, cleanupFixtures, finishAsync, fixture, git, gitResult, lockFiles, write } from "../helpers/harness.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Rows C2 and C3 (GUARD-INTERACTION.md section 6) through the alias. C3 uses begin as the self-testing command that
// never takes the integration lock; the 2.0 inspect command joins this row in the next unit.

test("C2: a branch creation attempted while a finish holds the lock is denied and the finish completes", async () => {
	const f = fixture()
	const worktree = authoredCandidate(f)
	// post-merge runs inside the locked integration, after the fast-forward: sleeping there widens the window.
	write(f.vault, ".git/hooks/post-merge", "#!/bin/sh\nsleep 1.5\n")
	chmodSync(join(f.vault, ".git/hooks/post-merge"), 0o700)
	const finishing = finishAsync(f, worktree, "docs: complete goal")
	await Bun.sleep(700)
	const denied = gitResult(f.vault, ["checkout", "-b", "x"])
	expect(denied.exitCode).toBe(128)
	expect(denied.stderr).toContain("VAULT_GUARD_BRANCH_CREATE_DENIED refs/heads/x")
	const finished = await finishing
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", guard: { selfTest: "pass", branches: [] } })
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
}, 20_000)

test("C3: the self-test completes quickly while another process holds the integration lock, without touching Git locks", () => {
	const f = fixture()
	const lock = join(f.vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock)
	write(lock, "owner.json", `${JSON.stringify({ schemaVersion: 1, runId: "another", pid: process.pid })}\n`)
	// A held main.lock proves the self-test needs no ref lock (Unit 0 row L1).
	write(f.vault, ".git/refs/heads/main.lock", "")
	const before = lockFiles(f.vault)
	expect(before.some((path) => path.endsWith("refs/heads/main.lock"))).toBe(true)
	const started = Date.now()
	const observed = begin(f, ["projects/demo/GOAL.md"])
	const elapsed = Date.now() - started
	const after = lockFiles(f.vault)
	rmSync(join(f.vault, ".git/refs/heads/main.lock"))
	expect(observed.exitCode).toBe(0)
	expect(observed.json).toMatchObject({ ok: true, code: "CANDIDATE_READY", guard: { selfTest: "pass" } })
	expect(elapsed).toBeLessThan(1_000)
	// L1 method: the Git lock-file set is identical before and after, and the held integration lock is intact.
	expect(after).toEqual(before)
	expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain('"runId":"another"')
})
