import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Row V1 companion (GUARD-INTERACTION.md section 6): the guarded copy differs from the legacy suite by exactly the
// committed three-hunk patch (harness path plus hook-text import, fixture hook install, and the `git branch unrelated`
// creation routed around the gate). Regenerating the diff and comparing it to the committed file catches drift on
// either side.
const legacySuite = resolve(import.meta.dir, "../../../vault-note-commits/src/main.test.ts")
const guardedSuite = resolve(import.meta.dir, "guarded-suite.test.ts")
const committedPatch = resolve(import.meta.dir, "guarded-suite.patch")

test("the guarded copy differs from the legacy suite by exactly the committed patch", () => {
	const diff = Bun.spawnSync(["diff", "-u", "--label", "a/packages/vault-note-commits/src/main.test.ts", "--label", "b/packages/vault-steward/tests/legacy/guarded-suite.test.ts", legacySuite, guardedSuite], { stdout: "pipe", stderr: "pipe" })
	expect(diff.exitCode).toBe(1)
	const observed = new TextDecoder().decode(diff.stdout)
	expect(observed).toBe(readFileSync(committedPatch, "utf8"))
	expect(observed.split("\n").filter((line) => line.startsWith("@@")).length).toBe(3)
	expect(observed).toContain('+\twrite(vault, ".git/hooks/reference-transaction", HOOK_TEXT)')
	expect(observed).toContain('+\tgit(vault, "-c", "core.hooksPath=/nonexistent", "branch", "unrelated", initialHead)')
	expect(observed).toContain('+const sourceCommand = resolve(import.meta.dir, "../../src/legacy/main.ts")')
})
