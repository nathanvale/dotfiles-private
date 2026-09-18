import { afterEach, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { authoredCandidate, begin, cleanupFixtures, finish, fixture, git, installHook } from "../helpers/harness.ts"

afterEach(cleanupFixtures)

// Row B6: core.hooksPath makes Git ignore .git/hooks, so the CLI observes the effective path.

test("B6: core.hooksPath set to a directory without the hook warns HOOKS_PATH_OVERRIDE and GUARD_MISSING, then integrates", () => {
	const f = fixture()
	const other = join(f.root, "other-hooks")
	mkdirSync(other)
	git(f.vault, "config", "core.hooksPath", other)
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.exitCode).toBe(0)
	expect(started.stderr).toBe("")
	expect(started.json).toMatchObject({ ok: true, warnings: ["HOOKS_PATH_OVERRIDE", "GUARD_MISSING"], guard: { installed: false, selfTest: "missing", hookPath: join(other, "reference-transaction") } })
	const worktree = authoredCandidate(f)
	expect(finish(f, worktree).json).toMatchObject({ ok: true, code: "INTEGRATED", warnings: ["HOOKS_PATH_OVERRIDE", "GUARD_MISSING"] })
})

test("B6: with the hook copied into the override directory only HOOKS_PATH_OVERRIDE remains and the self-test passes", () => {
	const f = fixture()
	const other = join(f.root, "other-hooks")
	const hookPath = installHook(f.vault, undefined, other)
	git(f.vault, "config", "core.hooksPath", other)
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.json).toMatchObject({ ok: true, warnings: ["HOOKS_PATH_OVERRIDE"], guard: { installed: true, selfTest: "pass", hookPath } })
})
