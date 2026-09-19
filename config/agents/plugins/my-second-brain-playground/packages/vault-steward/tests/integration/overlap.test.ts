import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { authoredCandidate, cleanupFixtures, finish, fixture, git } from "../helpers/harness.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row K1: two candidates touching one path with the gate installed; the second stops for semantic resolution.

test("K1: candidates touching the same path stop for semantic resolution with the candidate preserved", () => {
	const f = fixture()
	const first = authoredCandidate(f, "projects/demo/GOAL.md", "# Goal\n\nFirst answer.\n")
	const second = authoredCandidate(f, "projects/demo/GOAL.md", "# Goal\n\nSecond answer.\n")
	expect(finish(f, first, "docs: record first answer").json).toMatchObject({ ok: true, code: "INTEGRATED" })
	const blocked = finish(f, second, "docs: record second answer")
	expect(blocked.exitCode).toBe(1)
	expect(blocked.stderr).toBe("")
	expect(blocked.json).toMatchObject({
		ok: false,
		code: "SEMANTIC_OVERLAP",
		changedState: "partial",
		sideEffects: ["candidate-commit-preserved"],
		retrySafe: false,
		nextAction: "Resolve the concurrent changes to projects/demo/GOAL.md with Nathan.",
		worktree: second,
		guard: { selfTest: "pass" },
	})
	expect(existsSync(second)).toBe(true)
	expect(readFileSync(join(f.vault, "projects/demo/GOAL.md"), "utf8")).toContain("First answer")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})
