import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, fixture, git } from "../helpers/harness.ts"
import { candidate, integrate, must, run } from "../helpers/steward.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row K1: two candidates touching one path with the gate installed; the second stops for semantic resolution with a
// human handoff, its worktree preserved and main untouched.

test("K1: candidates touching the same path stop for semantic resolution with the candidate preserved", () => {
	const f = fixture()
	const first = candidate(f, "projects/demo/GOAL.md", "# Goal\n\nFirst answer.\n")
	const second = candidate(f, "projects/demo/GOAL.md", "# Goal\n\nSecond answer.\n")
	must(integrate(f, first, "docs: record first answer"), "SUCCESS_COMPLETED")
	const blocked = run(f, ["finish", "--preview", "--worktree", second, "--message", "docs: record second answer"])
	expect(blocked.exitCode).toBe(3)
	expect(blocked.stderr).toBe("")
	expect(blocked.envelope?.result).toMatchObject({ outcome: "refused", causeCode: "DOMAIN_SEMANTIC_OVERLAP", transactionState: "unchanged", handoff: { owner: "human", resource: { kind: "candidate-worktree", id: second } } })
	expect(blocked.envelope?.message).toContain("overlapping paths: projects/demo/GOAL.md")
	expect(existsSync(second)).toBe(true)
	expect(readFileSync(join(second, "projects/demo/GOAL.md"), "utf8")).toContain("Second answer")
	expect(readFileSync(join(f.vault, "projects/demo/GOAL.md"), "utf8")).toContain("First answer")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})
