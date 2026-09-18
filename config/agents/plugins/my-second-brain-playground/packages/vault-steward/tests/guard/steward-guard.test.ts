import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, type Fixture, fixture, git, installHook, write } from "../helpers/harness.ts"
import { data, must, steward, stewardEnvironment } from "../helpers/steward.ts"
import { HOOK_TEXT } from "./hook-text.ts"

// The 2.0 forms of rows V2 and V4 (GUARD-INTERACTION.md section 6) through finish --preview, finish --apply, inspect
// and recover: guard status and warnings in data, DOMAIN_GUARD_INCOMPATIBLE (reason) before the candidate commit and
// before the lock, empty stderr on every machine path, and no hook spawn on receipt-present retries.

setDefaultTimeout(60_000)
afterEach(cleanupFixtures)

const run = (f: Fixture, args: string[]) => steward(f.vault, args, stewardEnvironment(f))
const HOSTILE = HOOK_TEXT.replace("    refs/heads/main) ;;\n", "    refs/heads/main) ;;\n    refs/vault-note-commits/*)\n      printf 'VAULT_GUARD_BRANCH_CREATE_DENIED %s\\n' \"$ref\" >&2\n      exit 1 ;;\n")

function candidate(f: Fixture): string {
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "SUCCESS_COMPLETED")
	const worktree = (started.result.data as { candidate: { worktree: string } }).candidate.worktree
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	return worktree
}

test("V2 fixture 1: preview and apply report guard.selfTest pass with no warnings", () => {
	const f = fixture()
	const worktree = candidate(f)
	const previewed = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])
	expect(previewed.stderr).toBe("")
	expect(data(previewed).guard).toMatchObject({ installed: true, executable: true, hookPath: f.hookPath, current: null, selfTest: "pass", hooksPathOverride: null, branches: [], worktrees: [] })
	expect(data(previewed).warnings).toEqual([])
	const applied = run(f, ["finish", "--apply", "--preview-id", data(previewed).previewId as string, "--worktree", worktree])
	expect(applied.stderr).toBe("")
	expect(data(applied).guard).toMatchObject({ selfTest: "pass" })
	expect(data(applied).warnings).toEqual([])
})

test("V2 fixture 2 / B5: a hook denying the completion ref refuses preview before the commit and apply before the lock", () => {
	const f = fixture()
	const worktree = candidate(f)
	installHook(f.vault, HOSTILE)
	const previewed = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])
	expect(previewed.exitCode).toBe(3)
	expect(previewed.stderr).toBe("")
	expect(previewed.envelope?.result).toMatchObject({ causeCode: "DOMAIN_GUARD_INCOMPATIBLE", transactionState: "unchanged", effects: { completed: [], remaining: ["candidate.commit", "preview.record"], uncertain: [], inventoryComplete: true }, nextAction: "vault-steward.inspect", repairAction: "Run 'bun run guard:install' in the vault, then rerun the same command." })
	expect(previewed.envelope?.message).toMatch(/denied ref: refs\/vault-note-commits\//)
	expect(git(worktree, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(git(worktree, "status", "--porcelain")).not.toBe("")
	expect(existsSync(join(f.state, "my-second-brain", "vault-note-commits", "previews"))).toBe(false)
	installHook(f.vault)
	const id = data(must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"]), "SUCCESS_COMPLETED")).previewId as string
	installHook(f.vault, HOSTILE)
	const applied = run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree])
	expect(applied.exitCode).toBe(3)
	expect(applied.stderr).toBe("")
	expect(applied.envelope?.result.causeCode).toBe("DOMAIN_GUARD_INCOMPATIBLE")
	expect(applied.envelope?.result.effects).toEqual({ completed: [], remaining: ["completion.receipt", "completion.ref", "main.fast-forward"], uncertain: [], inventoryComplete: true })
	expect(existsSync(join(f.vault, ".git", "vault-note-commits.lock"))).toBe(false)
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	installHook(f.vault)
	must(run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree]), "SUCCESS_COMPLETED")
})

test("V2 fixtures 3 to 5 and the probe-allowed hook are warnings with detail on begin, never refusals", () => {
	const missing = fixture({ hook: false })
	expect(data(must(run(missing, ["begin", "--vault", missing.vault, "--path", "a.md", "--preview"]), "SUCCESS_UNCHANGED"))).toMatchObject({ guard: { installed: false, selfTest: "missing" }, warnings: [{ code: "GUARD_MISSING", detail: `${missing.hookPath} is absent` }] })
	const stale = fixture({ hookSource: `${HOOK_TEXT}# newer\n` })
	expect(data(must(run(stale, ["begin", "--vault", stale.vault, "--path", "a.md", "--preview"]), "SUCCESS_UNCHANGED"))).toMatchObject({ guard: { current: false, selfTest: "pass" }, warnings: [{ code: "GUARD_STALE" }] })
	const slow = fixture({ hook: "#!/bin/sh\nif grep -q refs/heads/probe-; then sleep 5; fi\nexit 0\n" })
	const started = Date.now()
	expect(data(must(run(slow, ["begin", "--vault", slow.vault, "--path", "a.md", "--preview"]), "SUCCESS_UNCHANGED"))).toMatchObject({ guard: { selfTest: "error" }, warnings: [{ code: "GUARD_SELFTEST_ERROR", detail: "timed out after 2000 ms" }] })
	expect(Date.now() - started).toBeLessThan(5_000)
	const permissive = fixture({ hook: "#!/bin/sh\nexit 0\n" })
	expect(data(must(run(permissive, ["begin", "--vault", permissive.vault, "--path", "a.md", "--preview"]), "SUCCESS_UNCHANGED"))).toMatchObject({ guard: { selfTest: "probe-allowed" }, warnings: [{ code: "GUARD_PROBE_ALLOWED" }] })
})

test("V3 in 2.0 form: sprawl and a foreign worktree are warnings on inspect and the apply still integrates", () => {
	const f = fixture()
	git(f.vault, "-c", "core.hooksPath=/nonexistent", "branch", "stray", f.initialHead)
	const foreign = join(f.root, "foreign")
	git(f.vault, "-c", "core.hooksPath=/nonexistent", "worktree", "add", "--detach", foreign, f.initialHead)
	const worktree = candidate(f)
	const inspected = data(must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED"))
	expect(inspected.guard).toMatchObject({ branches: ["refs/heads/stray"], worktrees: [foreign] })
	expect((inspected.warnings as { code: string }[]).map((warning) => warning.code)).toEqual(["BRANCH_SPRAWL_PRESENT", "FOREIGN_WORKTREE_PRESENT"])
	const id = data(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])).previewId as string
	must(run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree]), "SUCCESS_COMPLETED")
})

test("V4: receipt-present retries of preview, apply, recover and inspect never spawn the hook", () => {
	const f = fixture()
	const worktree = candidate(f)
	const id = data(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])).previewId as string
	must(run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree]), "SUCCESS_COMPLETED")
	const marker = join(f.root, "hook-ran")
	write(f.vault, ".git/hooks/reference-transaction", `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 0\n`)
	for (const args of [["finish", "--preview", "--worktree", worktree, "--message", "x"], ["finish", "--apply", "--preview-id", id, "--worktree", worktree], ["recover", "--worktree", worktree], ["inspect", "--worktree", worktree]]) {
		const retried = run(f, args)
		expect(retried.stderr, args.join(" ")).toBe("")
		expect(retried.envelope?.result.causeCode, args.join(" ")).toBe("SUCCESS_UNCHANGED")
	}
	expect((data(run(f, ["inspect", "--worktree", worktree])).guard as unknown) === null).toBe(true)
	expect(existsSync(marker)).toBe(false)
})

test("human mode prints warnings to stderr and one refusal line; machine mode keeps stderr empty", () => {
	const f = fixture({ hook: false })
	const worktree = candidate(f)
	const human = steward(f.vault, ["inspect", "--worktree", worktree], stewardEnvironment(f), false)
	expect(human.exitCode).toBe(0)
	expect(human.stderr).toBe(`warning: GUARD_MISSING ${f.hookPath} is absent\n`)
	expect(human.stdout.startsWith("SUCCESS_UNCHANGED: Recovery state not-started")).toBe(true)
	const refusal = steward(f.vault, ["finish", "--preview", "--worktree", join(f.root, "absent"), "--message", "x"], stewardEnvironment(f), false)
	expect(refusal.exitCode).toBe(3)
	expect(refusal.stdout).toBe("")
	expect(refusal.stderr.split("\n").filter(Boolean)).toHaveLength(1)
	expect(refusal.stderr.startsWith("DOMAIN_CANDIDATE_NOT_FOUND: No candidate worktree exists")).toBe(true)
	const machine = run(f, ["finish", "--preview", "--worktree", join(f.root, "absent"), "--message", "x"])
	expect(machine.stderr).toBe("")
})
