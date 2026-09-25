import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { cleanupFixtures, fixture, git } from "../helpers/harness.ts"
import { candidate, data, must, preview, run, stewardAsync, stewardEnvironment } from "../helpers/steward.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row C1: two disjoint candidates previewed against the same main and applied at once. Exactly one integrates; the
// other refuses busy (lock held) or stale (main moved) before any effect, and its next preview plans the rebase.

test("C1: simultaneous disjoint applies converge: one integrates, the other re-previews with a rebase and integrates", async () => {
	const f = fixture()
	const first = candidate(f, "projects/first/README.md", "# First\n")
	const second = candidate(f, "projects/second/README.md", "# Second\n")
	const firstId = preview(f, first, "docs: add first project")
	const secondId = preview(f, second, "docs: add second project")
	const env = stewardEnvironment(f)
	const results = await Promise.all([
		stewardAsync(f.vault, ["finish", "--apply", "--preview-id", firstId, "--worktree", first], env),
		stewardAsync(f.vault, ["finish", "--apply", "--preview-id", secondId, "--worktree", second], env),
	])
	for (const result of results) expect(result.stderr).toBe("")
	const causes = results.map((result) => result.envelope?.result.causeCode)
	expect(causes.filter((cause) => cause === "SUCCESS_COMPLETED")).toHaveLength(1)
	const loser = causes.findIndex((cause) => cause !== "SUCCESS_COMPLETED")
	expect(["TRANSIENT_INTEGRATION_BUSY", "DOMAIN_PREVIEW_STALE"]).toContain(causes[loser] as string)
	expect(results[loser]?.envelope?.result.effects.completed).toEqual([])
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	const worktree = loser === 0 ? first : second
	const previewed = data(must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: retry"]), "SUCCESS_COMPLETED"))
	expect((previewed.plan as { rebase: boolean }).rebase).toBe(true)
	must(run(f, ["finish", "--apply", "--preview-id", previewed.previewId as string, "--worktree", worktree]), "SUCCESS_COMPLETED")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("2")
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/vault-note-commits").split("\n")).toHaveLength(2)
}, 30_000)
