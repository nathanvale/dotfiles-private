import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, fixture, git, write } from "../helpers/harness.ts"
import { candidate, must, preview, steward, stewardAsync, stewardEnvironment } from "../helpers/steward.ts"

// S5 is a real-process consequence test: the candidate is rebased, another candidate integrates while it is paused
// before its fast-forward, and the first process proves the failed fast-forward before restoring its own commit.
setDefaultTimeout(60_000)
afterEach(cleanupFixtures)

test("S5: a failed fast-forward after rebase restores the original candidate, so its next preview and apply complete", async () => {
	const f = fixture()
	const first = candidate(f, "projects/first/GOAL.md", "# First\n")
	write(f.vault, "README.md", "# Fixture vault\n\nMoved.\n")
	git(f.vault, "add", "--", "README.md")
	git(f.vault, "commit", "-m", "docs: move main")
	const firstPreview = preview(f, first)
	const original = git(first, "rev-parse", "HEAD")
	const second = candidate(f, "projects/second/GOAL.md", "# Second\n")
	const secondPreview = preview(f, second)
	const paused = stewardAsync(f.vault, ["finish", "--apply", "--preview-id", firstPreview, "--worktree", first], { ...stewardEnvironment(f), VAULT_STEWARD_FAULT: "pause=before-ff-merge:1600" })
	await Bun.sleep(400)
	// S5 fault model: a losing legacy reclaimer removed the lock; another candidate may now integrate first.
	rmSync(join(f.vault, ".git", "vault-note-commits.lock"), { recursive: true, force: true })
	expect((await stewardAsync(f.vault, ["finish", "--apply", "--preview-id", secondPreview, "--worktree", second], stewardEnvironment(f))).envelope?.result.causeCode).toBe("SUCCESS_COMPLETED")
	const failed = await paused
	expect(failed.envelope?.result).toMatchObject({ causeCode: "INTERNAL_INTEGRATION_UNPROVED_UNCHANGED", transactionState: "unchanged" })
	expect(git(first, "rev-parse", "HEAD")).toBe(original)
	const retry = preview(f, first)
	expect(must(steward(f.vault, ["finish", "--apply", "--preview-id", retry, "--worktree", first], stewardEnvironment(f)), "SUCCESS_COMPLETED").result.transactionState).toBe("completed")
}, 30_000)
