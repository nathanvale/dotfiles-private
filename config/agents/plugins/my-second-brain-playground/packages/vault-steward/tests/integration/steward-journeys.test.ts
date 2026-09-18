import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, type Fixture, fixture, git, lockFiles, write } from "../helpers/harness.ts"
import { data, must, steward, stewardAsync, stewardEnvironment } from "../helpers/steward.ts"

// The Vault Steward CLI 2.0 journeys through real child processes: preview and apply binding (CONTRACT.md 3.8), the
// no-changes plan, receipts, two-process safety for apply and recover (one effect, the other refuses), the crash
// boundary between the fast-forward and the receipt (3.9) resolved by inspect then recover, and the alias sharing
// one run store with the 2.0 front door.

setDefaultTimeout(60_000)
afterEach(cleanupFixtures)

const run = (f: Fixture, args: string[], extra: Record<string, string> = {}) => steward(f.vault, args, stewardEnvironment(f, extra))

function candidate(f: Fixture, path = "projects/demo/GOAL.md", contents = "# Goal\n\nCompleted.\n"): string {
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", path]), "SUCCESS_COMPLETED")
	const worktree = (started.result.data as { candidate: { worktree: string } }).candidate.worktree
	write(worktree, path, contents)
	return worktree
}

function preview(f: Fixture, worktree: string): string {
	return data(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"])).previewId as string
}

test("preview binds the apply: a stale candidate, a superseded id, and a moved main each refuse before any effect", () => {
	const f = fixture()
	const worktree = candidate(f)
	const first = preview(f, worktree)
	expect(first).toMatch(/^preview-vnc-[a-f0-9]{32}-[a-f0-9]{12}-[a-f0-9]{12}$/)
	const previewData = data(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"]))
	expect(previewData.previewId).toBe(first)
	expect(previewData.plan as Record<string, unknown>).toEqual({ kind: "integrate", observedMain: f.initialHead, rebase: false, expectedEffects: ["completion.receipt", "completion.ref", "main.fast-forward"] })
	// main moves: the apply under the lock refuses stale and leaves the preview unconsumed
	write(f.vault, "README.md", "# Fixture vault\n\nMoved.\n")
	git(f.vault, "add", "--", "README.md")
	git(f.vault, "commit", "-m", "docs: main moves")
	const stale = run(f, ["finish", "--apply", "--preview-id", first, "--worktree", worktree])
	expect(stale.exitCode).toBe(3)
	expect(stale.envelope?.message).toMatch(/^DOMAIN_PREVIEW_STALE: main moved from/)
	expect(stale.envelope?.result.nextAction).toBe("vault-steward.finish-preview")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	// a new preview plans the rebase and supersedes the old id
	const second = preview(f, worktree)
	expect(second).not.toBe(first)
	const superseded = run(f, ["finish", "--apply", "--preview-id", first, "--worktree", worktree])
	expect(superseded.envelope?.message).toMatch(/^DOMAIN_PREVIEW_STALE: preview .* supersedes/)
	const applied = must(run(f, ["finish", "--apply", "--preview-id", second, "--worktree", worktree]), "SUCCESS_COMPLETED")
	expect((applied.result.data as { integration: { kind: string } }).integration.kind).toBe("integrate")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("2")
	expect(existsSync(worktree)).toBe(false)
	expect(existsSync(join(f.state, "my-second-brain", "vault-note-commits", "previews"))).toBe(true)
})

test("a no-changes plan applies as the NO_CHANGES completion and the receipt short-circuits every later command", () => {
	const f = fixture()
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "SUCCESS_COMPLETED")
	const worktree = (started.result.data as { candidate: { worktree: string } }).candidate.worktree
	const previewed = must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: nothing"]), "SUCCESS_COMPLETED")
	expect(previewed.result.effects.completed).toEqual(["preview.record"])
	const plan = (previewed.result.data as { plan: { kind: string; expectedEffects: string[] }; previewId: string })
	expect(plan.plan).toMatchObject({ kind: "no-changes", expectedEffects: ["completion.receipt", "completion.ref"] })
	expect(plan.previewId.endsWith("-none")).toBe(true)
	const applied = must(run(f, ["finish", "--apply", "--preview-id", plan.previewId, "--worktree", worktree]), "SUCCESS_COMPLETED")
	expect(applied.result.effects.completed).toEqual(["completion.receipt", "completion.ref"])
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(git(f.vault, "rev-parse", `refs/vault-note-commits/${applied.result.idempotencyKey as string}`)).toBe(f.initialHead)
	for (const args of [["finish", "--preview", "--worktree", worktree, "--message", "x"], ["finish", "--apply", "--preview-id", plan.previewId, "--worktree", worktree], ["recover", "--worktree", worktree]]) {
		const again = must(run(f, args), "SUCCESS_UNCHANGED")
		expect((again.result.data as { completion: { originalCode: string } }).completion.originalCode).toBe("NO_CHANGES")
		expect(again.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
	}
	const inspected = must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED")
	expect((inspected.result.data as { recovery: { state: string } }).recovery.state).toBe("completed")
})

test("two applies of one preview produce exactly one integration; the other refuses busy", async () => {
	const f = fixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const env = stewardEnvironment(f)
	const [first, second] = await Promise.all([
		stewardAsync(f.vault, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { ...env, VAULT_STEWARD_FAULT: "pause=after-lock:3500" }),
		(async () => {
			await Bun.sleep(300)
			return stewardAsync(f.vault, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], env)
		})(),
	])
	expect(first.envelope?.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(second.envelope?.result.causeCode).toBe("TRANSIENT_NOT_STARTED")
	expect(second.envelope?.message).toMatch(/^TRANSIENT_INTEGRATION_BUSY/)
	expect(second.envelope?.result.retryDelayMilliseconds).toBe(2000)
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	// the retry after the lock is released sees the receipt, never a second effect
	const retried = must(run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree]), "SUCCESS_UNCHANGED")
	expect(retried.result.effects.completed).toEqual([])
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/vault-note-commits").split("\n")).toHaveLength(1)
})

test("a second apply that starts after consumption refuses consumed while the first completes", async () => {
	const f = fixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const env = stewardEnvironment(f)
	const first = stewardAsync(f.vault, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { ...env, VAULT_STEWARD_FAULT: "pause=after-consume:2500" })
	await Bun.sleep(600)
	// bindPreview runs outside the lock: the consumed record is visible before the lock is released
	const second = run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree])
	expect(second.envelope?.result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET")
	expect(second.envelope?.message).toMatch(/^DOMAIN_PREVIEW_CONSUMED/)
	expect((await first).envelope?.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test("a crash between the fast-forward and the receipt is recoverable: inspect reports it, recover records it once", async () => {
	const f = fixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const crashed = run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { VAULT_STEWARD_FAULT: "halt=after-ff-merge" })
	expect(crashed.signal).toBe("SIGKILL")
	expect(crashed.stdout).toBe("")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	const inspected = must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED")
	const view = inspected.result.data as { recovery: { state: string; nextCommand: string }; main: { containsCandidateCommit: boolean }; preview: { consumed: boolean }; receipt: { present: boolean }; lock: { held: boolean; live: boolean } }
	expect(view.recovery).toEqual({ state: "recoverable", nextCommand: `vault-steward recover --worktree ${worktree} --json` })
	expect(view.main.containsCandidateCommit).toBe(true)
	expect(view.preview.consumed).toBe(true)
	expect(view.receipt.present).toBe(false)
	expect(view.lock).toMatchObject({ held: true, live: false })
	expect(inspected.result.nextAction).toBe("vault-steward.recover")
	// two recovers: one records, the other refuses busy or sees the receipt; never a second ref value
	const env = stewardEnvironment(f)
	const [first, second] = await Promise.all([
		stewardAsync(f.vault, ["recover", "--worktree", worktree], { ...env, VAULT_STEWARD_FAULT: "pause=before-receipt:3500" }),
		(async () => {
			await Bun.sleep(300)
			return stewardAsync(f.vault, ["recover", "--worktree", worktree], env)
		})(),
	])
	expect(first.envelope?.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(first.envelope?.result.effects.completed).toEqual(["completion.receipt", "completion.ref"])
	expect(second.envelope?.result.causeCode).toBe("TRANSIENT_NOT_STARTED")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	const commit = git(f.vault, "rev-parse", "main")
	expect(git(f.vault, "rev-parse", `refs/vault-note-commits/${first.envelope?.result.idempotencyKey as string}`)).toBe(commit)
	expect(must(run(f, ["recover", "--worktree", worktree]), "SUCCESS_UNCHANGED").result.effects.completed).toEqual([])
	expect(must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED").result.nextAction).toBe("vault-steward.inspect")
})

test("a crash before the receipt with the ref written recovers as INTEGRATED and prunes the preview", () => {
	const f = fixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const crashed = run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { VAULT_STEWARD_FAULT: "halt=before-receipt" })
	expect(crashed.signal).toBe("SIGKILL")
	const runId = JSON.parse(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), "vault-note-commit.json"), "utf8")).runId as string
	expect(git(f.vault, "rev-parse", `refs/vault-note-commits/${runId}`)).toBe(git(f.vault, "rev-parse", "main"))
	const recovered = must(run(f, ["recover", "--worktree", worktree]), "SUCCESS_COMPLETED")
	expect((recovered.result.data as { completion: { commit: string } }).completion.commit).toBe(git(f.vault, "rev-parse", "main"))
	expect(existsSync(join(f.state, "my-second-brain", "vault-note-commits", "previews", `${runId}.json`))).toBe(false)
	expect(existsSync(worktree)).toBe(false)
})

test("recover never replays: a candidate whose commit is not on main hands off to a human", () => {
	const f = fixture()
	const worktree = candidate(f)
	preview(f, worktree)
	const refused = run(f, ["recover", "--worktree", worktree])
	expect(refused.exitCode).toBe(3)
	expect(refused.envelope?.result.causeCode).toBe("DOMAIN_AUTHORITY_REQUIRED")
	expect(refused.envelope?.result.handoff).toMatchObject({ owner: "human", inspect: [`vault-steward inspect --worktree ${worktree} --json`], resource: { kind: "candidate-worktree", id: worktree } })
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(git(f.vault, "for-each-ref", "refs/vault-note-commits")).toBe("")
})

test("the alias and the 2.0 front door share one run store: a candidate begun by one finishes through the other", () => {
	const f = fixture()
	const worktree = candidate(f)
	const alias = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/legacy/main.ts"), "finish", "--worktree", worktree, "--message", "docs: alias finish", "--json"], { cwd: f.vault, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...stewardEnvironment(f), GIT_TERMINAL_PROMPT: "0" } })
	const legacy = JSON.parse(new TextDecoder().decode(alias.stdout)) as { code: string; commit: string }
	expect(legacy.code).toBe("INTEGRATED")
	const again = must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "x"]), "SUCCESS_UNCHANGED")
	expect((again.result.data as { completion: { originalCode: string; commit: string } }).completion).toMatchObject({ originalCode: "INTEGRATED", commit: legacy.commit })
})

test("the self-test and inspect never take a Git lock: the lock-file set is unchanged around an inspect during a held lock", () => {
	const f = fixture()
	const worktree = candidate(f)
	const lock = join(f.vault, ".git", "vault-note-commits.lock")
	Bun.spawnSync(["mkdir", "-p", lock])
	write(lock, "owner.json", `${JSON.stringify({ schemaVersion: 1, runId: "another", pid: process.pid })}\n`)
	write(f.vault, ".git/refs/heads/main.lock", "")
	const before = lockFiles(f.vault)
	const started = Date.now()
	const inspected = must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED")
	const elapsed = Date.now() - started
	const after = lockFiles(f.vault)
	Bun.spawnSync(["rm", join(f.vault, ".git/refs/heads/main.lock")])
	expect((inspected.result.data as { guard: { selfTest: string }; lock: { held: boolean; live: boolean } })).toMatchObject({ guard: { selfTest: "pass" }, lock: { held: true, live: true } })
	expect(elapsed).toBeLessThan(2_000)
	expect(after).toEqual(before)
})
