import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, type Fixture, fixture, git, gitResult } from "../helpers/harness.ts"
import { candidate, data, must, run } from "../helpers/steward.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Rows B1 to B4: every local bypass of the gate leaves a branch that the CLI names in guard.branches, warns about, and
// still integrates past.

function expectWarnedIntegration(f: Fixture, branch: string): void {
	const worktree = candidate(f)
	const previewed = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])
	expect(previewed.stderr).toBe("")
	expect(data(must(previewed, "SUCCESS_COMPLETED"))).toMatchObject({ guard: { selfTest: "pass", branches: [branch] }, warnings: [{ code: "BRANCH_SPRAWL_PRESENT", detail: branch }] })
	const applied = run(f, ["finish", "--apply", "--preview-id", data(previewed).previewId as string, "--worktree", worktree])
	expect(applied.exitCode).toBe(0)
	expect(applied.stderr).toBe("")
	expect(data(must(applied, "SUCCESS_COMPLETED")).warnings).toEqual([{ code: "BRANCH_SPRAWL_PRESENT", detail: branch }])
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
}

test("B1: core.hooksPath pointing at an empty directory bypasses the gate; the apply warns and integrates", () => {
	const f = fixture()
	const empty = join(f.root, "empty-hooks")
	mkdirSync(empty)
	const created = gitResult(f.vault, ["-c", `core.hooksPath=${empty}`, "checkout", "-b", "x"])
	expect(created.exitCode).toBe(0)
	git(f.vault, "-c", `core.hooksPath=${empty}`, "checkout", "main")
	expectWarnedIntegration(f, "refs/heads/x")
})

test("B2: GIT_DIR pointed at the vault from elsewhere with a hooksPath override creates a branch; the apply warns", () => {
	const f = fixture()
	const created = gitResult(f.root, ["-c", "core.hooksPath=/nonexistent", "branch", "elsewhere", f.initialHead], { GIT_DIR: join(f.vault, ".git") })
	expect(created.exitCode).toBe(0)
	expectWarnedIntegration(f, "refs/heads/elsewhere")
})

test("B3: a direct write of .git/refs/heads/x is invisible to the hook; the apply warns", () => {
	const f = fixture()
	writeFileSync(join(f.vault, ".git", "refs", "heads", "direct"), `${f.initialHead}\n`)
	expectWarnedIntegration(f, "refs/heads/direct")
})

test("B4: an edited packed-refs file adding a head is invisible to the hook; the apply warns", () => {
	const f = fixture()
	git(f.vault, "pack-refs", "--all")
	const packed = join(f.vault, ".git", "packed-refs")
	writeFileSync(packed, `${readFileSync(packed, "utf8")}${f.initialHead} refs/heads/packed\n`)
	expect(git(f.vault, "rev-parse", "refs/heads/packed")).toBe(f.initialHead)
	expectWarnedIntegration(f, "refs/heads/packed")
})
