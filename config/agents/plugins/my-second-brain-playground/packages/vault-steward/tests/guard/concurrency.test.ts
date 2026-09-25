import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, fixture, git, gitResult, lockFiles, write } from "../helpers/harness.ts"
import { candidate, data, must, preview, run, stewardAsync, stewardEnvironment, waitForOwner } from "../helpers/steward.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Rows C2 and C3 (GUARD-INTERACTION.md section 6). C3 uses begin as the self-testing command that never takes the
// integration lock; the inspect form lives in steward-journeys.test.ts.

test("C2: a branch creation attempted while an apply holds the lock is denied and the apply completes", async () => {
	const f = fixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const release = join(f.root, "apply-release")
	// The holder pauses inside the lock after publishing its owner record; that record is the ordering witness.
	const holder = stewardAsync(f.vault, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { ...stewardEnvironment(f), VAULT_STEWARD_FAULT: `barrier=lock-held:${release}` })
	await waitForOwner(join(f.vault, ".git", "vault-note-commits.lock", "owner.json"))
	const denied = gitResult(f.vault, ["checkout", "-b", "x"])
	expect(denied.exitCode).toBe(128)
	expect(denied.stderr).toContain("VAULT_GUARD_BRANCH_CREATE_DENIED refs/heads/x")
	writeFileSync(release, "release\n")
	const applied = await holder
	expect(applied.exitCode).toBe(0)
	expect(applied.stderr).toBe("")
	expect(data(must(applied, "SUCCESS_COMPLETED")).guard).toMatchObject({ selfTest: "pass", branches: [] })
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
}, 20_000)

test("C3: begin's self-test completes quickly while another process holds the integration lock, without touching Git locks", () => {
	const f = fixture()
	const lock = join(f.vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock)
	write(lock, "owner.json", `${JSON.stringify({ schemaVersion: 1, runId: "another", pid: process.pid })}\n`)
	// A held main.lock proves the self-test needs no ref lock (Unit 0 row L1).
	write(f.vault, ".git/refs/heads/main.lock", "")
	const before = lockFiles(f.vault)
	expect(before.some((path) => path.endsWith("refs/heads/main.lock"))).toBe(true)
	const started = Date.now()
	const observed = run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"])
	const elapsed = Date.now() - started
	const after = lockFiles(f.vault)
	rmSync(join(f.vault, ".git/refs/heads/main.lock"))
	expect(data(must(observed, "SUCCESS_COMPLETED")).guard).toMatchObject({ selfTest: "pass" })
	expect(elapsed).toBeLessThan(2_000)
	// L1 method: the Git lock-file set is identical before and after, and the held integration lock is intact.
	expect(after).toEqual(before)
	expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain('"runId":"another"')
})
