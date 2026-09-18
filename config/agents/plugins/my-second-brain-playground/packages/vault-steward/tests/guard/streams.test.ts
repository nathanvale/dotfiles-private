import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { authoredCandidate, begin, cleanupFixtures, finish, fixture, git, installHook, write } from "../helpers/harness.ts"
import { HOOK_TEXT } from "./hook-text.ts"

afterEach(cleanupFixtures)

// Row V4: every station reachable through the guard rows keeps stderr empty in machine mode, and receipt-present retries
// never spawn the hook (the marker hook records any execution).

test("V4: stderr is empty on every guard station reached with --json", () => {
	const observed: string[] = []
	const clean = fixture()
	const cleanWorktree = authoredCandidate(clean)
	observed.push(begin(clean, ["projects/other.md"]).stderr, finish(clean, cleanWorktree).stderr)
	const missing = fixture({ hook: false })
	observed.push(begin(missing, ["projects/demo/GOAL.md"]).stderr)
	const hostile = fixture()
	const hostileWorktree = authoredCandidate(hostile)
	installHook(hostile.vault, HOOK_TEXT.replace("    refs/heads/main) ;;\n", "    refs/heads/main) ;;\n    refs/vault-note-commits/*)\n      printf 'VAULT_GUARD_BRANCH_CREATE_DENIED %s\\n' \"$ref\" >&2\n      exit 1 ;;\n"))
	const refused = finish(hostile, hostileWorktree)
	expect(refused.json.code).toBe("GUARD_INCOMPATIBLE")
	observed.push(refused.stderr)
	const sprawl = fixture()
	git(sprawl.vault, "-c", "core.hooksPath=/nonexistent", "branch", "stray", sprawl.initialHead)
	const sprawlWorktree = authoredCandidate(sprawl)
	const sprawled = finish(sprawl, sprawlWorktree)
	expect(sprawled.json.warnings).toEqual(["BRANCH_SPRAWL_PRESENT"])
	observed.push(sprawled.stderr)
	const probeAllowed = fixture({ hook: "#!/bin/sh\nexit 0\n" })
	observed.push(begin(probeAllowed, ["projects/demo/GOAL.md"]).stderr)
	expect(observed).toEqual(["", "", "", "", "", ""])
})

test("V4: receipt-present retries of finish make no hook spawn", () => {
	const f = fixture()
	const integrated = authoredCandidate(f)
	expect(finish(f, integrated).json.code).toBe("INTEGRATED")
	const unchanged = begin(f, ["projects/demo/GOAL.md"]).json.worktree as string
	expect(finish(f, unchanged).json.code).toBe("NO_CHANGES")
	const marker = join(f.root, "hook-ran")
	write(f.vault, ".git/hooks/reference-transaction", `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 0\n`)
	for (const worktree of [integrated, unchanged]) {
		const retried = finish(f, worktree)
		expect(retried.exitCode).toBe(0)
		expect(retried.stderr).toBe("")
		expect(retried.json).toMatchObject({ ok: true, code: "ALREADY_COMPLETED", sideEffects: [] })
		expect(retried.json.guard).toBeUndefined()
	}
	expect(existsSync(marker)).toBe(false)
})

test("V4: a first NO_CHANGES completion does run the self-test because it writes the completion ref", () => {
	const f = fixture()
	const worktree = begin(f, ["projects/demo/GOAL.md"]).json.worktree as string
	const finished = finish(f, worktree)
	expect(finished.json).toMatchObject({ ok: true, code: "NO_CHANGES", guard: { selfTest: "pass" } })
	expect(git(f.vault, "rev-parse", `refs/vault-note-commits/${finished.json.runId as string}`)).toBe(f.initialHead)
})
