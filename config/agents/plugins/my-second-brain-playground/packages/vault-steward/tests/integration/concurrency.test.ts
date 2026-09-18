import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { authoredCandidate, cleanupFixtures, finish, finishAsync, fixture, git } from "../helpers/harness.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row C1: the legacy "simultaneous disjoint finishers" scenario with the gate installed. Either both integrate (the
// second rebased) or one refuses INTEGRATION_BUSY and integrates on retry with the same worktree.

test("C1: simultaneous disjoint finishers both integrate under the gate", async () => {
	const f = fixture()
	const first = authoredCandidate(f, "projects/first/README.md", "# First\n")
	const second = authoredCandidate(f, "projects/second/README.md", "# Second\n")
	const results = await Promise.all([finishAsync(f, first, "docs: add first project"), finishAsync(f, second, "docs: add second project")])
	const codes = results.map((result) => result.json.code as string).sort()
	if (codes.includes("INTEGRATION_BUSY")) {
		const busy = results.find((result) => result.json.code === "INTEGRATION_BUSY")
		expect(busy?.json).toMatchObject({ retrySafe: true, changedState: "partial" })
		expect(finish(f, busy?.json.worktree as string).json).toMatchObject({ ok: true, code: "INTEGRATED" })
	} else {
		expect(codes).toEqual(["INTEGRATED", "INTEGRATED"])
	}
	for (const result of results) expect(result.stderr).toBe("")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("2")
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/vault-note-commits").split("\n")).toHaveLength(2)
}, 30_000)
