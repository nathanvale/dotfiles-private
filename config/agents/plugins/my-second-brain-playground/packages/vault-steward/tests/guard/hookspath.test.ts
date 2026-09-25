import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, fixture, git, installHook, write } from "../helpers/harness.ts"
import { data, integrate, must, run } from "../helpers/steward.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row B6: core.hooksPath makes Git ignore .git/hooks, so the CLI observes the effective path.

test("B6: core.hooksPath set to a directory without the hook warns HOOKS_PATH_OVERRIDE and GUARD_MISSING, then integrates", () => {
	const f = fixture()
	const other = join(f.root, "other-hooks")
	mkdirSync(other)
	git(f.vault, "config", "core.hooksPath", other)
	const started = run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"])
	expect(started.exitCode).toBe(0)
	expect(started.stderr).toBe("")
	const begun = data(must(started, "SUCCESS_COMPLETED"))
	expect(begun.guard).toMatchObject({ installed: false, selfTest: "missing", hookPath: join(other, "reference-transaction"), hooksPathOverride: other })
	expect(begun.warnings).toEqual([{ code: "HOOKS_PATH_OVERRIDE", detail: `core.hooksPath=${other}` }, { code: "GUARD_MISSING", detail: `${join(other, "reference-transaction")} is absent` }])
	const worktree = (begun.candidate as { worktree: string }).worktree
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	const applied = data(must(integrate(f, worktree), "SUCCESS_COMPLETED"))
	expect((applied.warnings as { code: string }[]).map((warning) => warning.code)).toEqual(["HOOKS_PATH_OVERRIDE", "GUARD_MISSING"])
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test("B6: with the hook copied into the override directory only HOOKS_PATH_OVERRIDE remains and the self-test passes", () => {
	const f = fixture()
	const other = join(f.root, "other-hooks")
	const hookPath = installHook(f.vault, undefined, other)
	git(f.vault, "config", "core.hooksPath", other)
	const begun = data(must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "SUCCESS_COMPLETED"))
	expect(begun.guard).toMatchObject({ installed: true, selfTest: "pass", hookPath, hooksPathOverride: other })
	expect(begun.warnings).toEqual([{ code: "HOOKS_PATH_OVERRIDE", detail: `core.hooksPath=${other}` }])
})
