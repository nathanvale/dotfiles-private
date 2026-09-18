import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { authoredCandidate, begin, cleanupFixtures, finish, fixture, git, installHook } from "../helpers/harness.ts"
import { HOOK_TEXT } from "./hook-text.ts"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

afterEach(cleanupFixtures)

// Row V2 and B5 (GUARD-INTERACTION.md section 6) through the alias front door. Expected codes, exits, warnings, and
// streams are literals from the design, never read from the production modules.

test("V2 fixture 1: the final hook passes the self-test and finish integrates with no warnings", () => {
	const f = fixture()
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.json).toMatchObject({ ok: true, code: "CANDIDATE_READY", guard: { installed: true, current: null, selfTest: "pass", hookPath: f.hookPath, branches: [], worktrees: [] } })
	expect(started.json.warnings).toBeUndefined()
	const worktree = started.json.worktree as string
	Bun.write(join(worktree, "projects/demo/GOAL.md"), "# Goal\n\nCompleted.\n")
	const finished = finish(f, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", guard: { installed: true, selfTest: "pass", hookPath: f.hookPath } })
	expect(finished.json.warnings).toBeUndefined()
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	expect(git(f.vault, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
})

test("V2 fixture 2 / B5: a hook denying the completion ref refuses GUARD_INCOMPATIBLE before the checker and the lock", () => {
	const f = fixture()
	const worktree = authoredCandidate(f)
	// Edit the accepted text so every refs/vault-note-commits/* line is denied like a branch creation.
	const hostile = HOOK_TEXT.replace("    refs/heads/main) ;;\n", "    refs/heads/main) ;;\n    refs/vault-note-commits/*)\n      printf 'VAULT_GUARD_BRANCH_CREATE_DENIED %s\\n' \"$ref\" >&2\n      exit 1 ;;\n")
	expect(hostile).not.toBe(HOOK_TEXT)
	installHook(f.vault, hostile)
	const refused = finish(f, worktree)
	expect(refused.exitCode).toBe(1)
	expect(refused.stderr).toBe("")
	expect(refused.json).toMatchObject({
		ok: false,
		command: "finish",
		code: "GUARD_INCOMPATIBLE",
		changedState: "none",
		sideEffects: ["candidate-worktree-preserved"],
		retrySafe: true,
		nextAction: "Repair the installed reference-transaction hook with 'bun run guard:install' in the vault, then rerun finish with the same worktree.",
		worktree,
		guard: { installed: true, selfTest: "incompatible" },
	})
	expect(refused.json.commit).toBeUndefined()
	expect(git(worktree, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(git(worktree, "status", "--porcelain")).not.toBe("")
	expect(existsSync(join(f.vault, ".git", "vault-note-commits.lock"))).toBe(false)
	expect(existsSync(join(f.state, "my-second-brain", "vault-note-commits", "previews"))).toBe(false)
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	// Repairing the hook makes the same worktree finish.
	installHook(f.vault)
	expect(finish(f, worktree).json).toMatchObject({ ok: true, code: "INTEGRATED", guard: { selfTest: "pass" } })
})

test("V2 fixture 3: no hook warns GUARD_MISSING and integration proceeds", () => {
	const f = fixture({ hook: false })
	const worktree = authoredCandidate(f)
	const finished = finish(f, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", warnings: ["GUARD_MISSING"], guard: { installed: false, selfTest: "missing", hookPath: f.hookPath } })
})

test("V2 fixture 4: an installed hook that differs from the vault source warns GUARD_STALE and proceeds", () => {
	const f = fixture({ hookSource: `${HOOK_TEXT}# newer source\n` })
	const worktree = authoredCandidate(f)
	const finished = finish(f, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", warnings: ["GUARD_STALE"], guard: { installed: true, current: false, selfTest: "pass" } })
	const current = fixture({ hookSource: HOOK_TEXT })
	expect(begin(current, ["projects/demo/GOAL.md"]).json).toMatchObject({ ok: true, guard: { current: true, selfTest: "pass" } })
	expect(begin(current, ["projects/demo/GOAL.md"]).json.warnings).toBeUndefined()
})

test("V2 fixture 5: a hook that sleeps 5 s times out at 2 s, warns GUARD_SELFTEST_ERROR, and proceeds in under 5 s", () => {
	// Sleeps only for the self-test probe line so the real Git operations of the fixture stay fast.
	const f = fixture({ hook: "#!/bin/sh\nif grep -q refs/heads/probe-; then sleep 5; fi\nexit 0\n" })
	const worktree = authoredCandidate(f)
	const started = Date.now()
	const finished = finish(f, worktree)
	const elapsed = Date.now() - started
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", warnings: ["GUARD_SELFTEST_ERROR"], guard: { installed: true, selfTest: "error" } })
	expect(elapsed).toBeLessThan(5_000)
}, 20_000)

test("V2 extra: a hook that exits 0 for everything warns GUARD_PROBE_ALLOWED and proceeds", () => {
	const f = fixture({ hook: "#!/bin/sh\nexit 0\n" })
	const worktree = authoredCandidate(f)
	const finished = finish(f, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", warnings: ["GUARD_PROBE_ALLOWED"], guard: { selfTest: "probe-allowed" } })
})

test("V2 extra: a hook whose denial names no known code is a self-test error, not an incompatibility", () => {
	// Denies only the probe line, without the known code, so the real Git operations of the fixture proceed.
	const f = fixture({ hook: "#!/bin/sh\nif grep -q refs/heads/probe-; then echo 'foreign hook says no' >&2; exit 1; fi\nexit 0\n" })
	const worktree = authoredCandidate(f)
	const finished = finish(f, worktree)
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED", warnings: ["GUARD_SELFTEST_ERROR"], guard: { selfTest: "error" } })
})

test("V2 extra: a non-executable hook file is reported as missing", () => {
	const f = fixture()
	Bun.spawnSync(["chmod", "644", f.hookPath])
	const started = begin(f, ["projects/demo/GOAL.md"])
	expect(started.json).toMatchObject({ ok: true, warnings: ["GUARD_MISSING"], guard: { installed: true, selfTest: "missing" } })
})

test("human mode prints warnings to stderr and keeps the legacy summary line", () => {
	const f = fixture({ hook: false })
	const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/legacy/main.ts"), "begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"], {
		cwd: f.vault, stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_STATE_HOME: f.state, GIT_TERMINAL_PROMPT: "0" },
	})
	expect(result.exitCode).toBe(0)
	expect(new TextDecoder().decode(result.stdout)).toBe("CANDIDATE_READY: Edit only the admitted paths in the returned worktree, then run finish.\n")
	expect(new TextDecoder().decode(result.stderr)).toBe(`warning: GUARD_MISSING ${f.hookPath} is absent\n`)
})
