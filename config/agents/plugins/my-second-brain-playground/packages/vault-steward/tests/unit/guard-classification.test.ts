import { expect, test } from "bun:test"
import { classifyAllowRun, classifyProbeRun, foreignWorktrees, sprawlBranches } from "../../src/guard.ts"
import type { SpawnOutcome } from "../../src/runtime.ts"

// The self-test classification is a pure function of (exit code, stderr) (GUARD-INTERACTION.md section 3). Expected
// values are literals from that table.

function outcome(overrides: Partial<SpawnOutcome>): SpawnOutcome {
	return { exitCode: 0, timedOut: false, spawnError: null, stdout: "", stderr: "", ...overrides }
}

const refs = ["refs/vault-note-commits/vnc-1", "refs/heads/main"]

test("run A: exit 0 continues; exit 1 naming a Vault Steward ref is incompatible; others are errors", () => {
	expect(classifyAllowRun(outcome({ exitCode: 0 }), refs)).toEqual({ selfTest: "continue" })
	expect(classifyAllowRun(outcome({ exitCode: 1, stderr: "VAULT_GUARD_BRANCH_CREATE_DENIED refs/vault-note-commits/vnc-1\n" }), refs)).toEqual({ selfTest: "incompatible", ref: "refs/vault-note-commits/vnc-1" })
	expect(classifyAllowRun(outcome({ exitCode: 1, stderr: "VAULT_GUARD_BRANCH_CREATE_DENIED refs/heads/main\n" }), refs)).toEqual({ selfTest: "incompatible", ref: "refs/heads/main" })
	expect(classifyAllowRun(outcome({ exitCode: 1, stderr: "some other hook\n" }), refs)).toEqual({ selfTest: "error", detail: "unexpected exit 1" })
	expect(classifyAllowRun(outcome({ exitCode: 128 }), refs)).toEqual({ selfTest: "error", detail: "unexpected exit 128" })
	expect(classifyAllowRun(outcome({ exitCode: null, timedOut: true }), refs)).toEqual({ selfTest: "error", detail: "timed out after 2000 ms" })
	expect(classifyAllowRun(outcome({ exitCode: null, spawnError: "ENOENT" }), refs)).toEqual({ selfTest: "error", detail: "spawn failed: ENOENT" })
})

test("run B: a denied probe passes; exit 0 is probe-allowed (carrying any fail-open line); others are errors", () => {
	const probe = "refs/heads/probe-vnc-1"
	expect(classifyProbeRun(outcome({ exitCode: 1, stderr: `VAULT_GUARD_BRANCH_CREATE_DENIED ${probe}\nThis vault is main-only.\n` }), probe)).toEqual({ selfTest: "pass" })
	expect(classifyProbeRun(outcome({ exitCode: 0 }), probe)).toEqual({ selfTest: "probe-allowed", detail: "refs/heads/probe-vnc-1 was not denied (exit 0)" })
	expect(classifyProbeRun(outcome({ exitCode: 0, stderr: "VAULT_GUARD_FAIL_OPEN git not found on PATH; gate skipped\n" }), probe)).toEqual({
		selfTest: "probe-allowed",
		detail: "refs/heads/probe-vnc-1 was not denied (exit 0); VAULT_GUARD_FAIL_OPEN git not found on PATH; gate skipped",
	})
	expect(classifyProbeRun(outcome({ exitCode: 1, stderr: "denied by a foreign hook\n" }), probe)).toEqual({ selfTest: "error", detail: "unexpected exit 1" })
	expect(classifyProbeRun(outcome({ exitCode: 1, stderr: "VAULT_GUARD_BRANCH_CREATE_DENIED refs/heads/other\n" }), probe)).toEqual({ selfTest: "error", detail: "unexpected exit 1" })
	expect(classifyProbeRun(outcome({ exitCode: null, timedOut: true }), probe)).toEqual({ selfTest: "error", detail: "timed out after 2000 ms" })
})

test("sprawl is every head other than main; foreign worktrees exclude the vault and its candidates", () => {
	expect(sprawlBranches(["refs/heads/main", "", "refs/heads/stray", "refs/heads/codex/x"])).toEqual(["refs/heads/stray", "refs/heads/codex/x"])
	expect(sprawlBranches(["refs/heads/main"])).toEqual([])
	const candidates = "/state/my-second-brain/vault-note-commits/abcd"
	expect(foreignWorktrees(["/vault", `${candidates}/vnc-1`, "/elsewhere/wt", `${candidates}-other/vnc-2`], "/vault", candidates)).toEqual(["/elsewhere/wt", `${candidates}-other/vnc-2`])
})
