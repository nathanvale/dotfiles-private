import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type BeadsPin, createBeadsReader } from "../../src/adapters/beads.ts"

// The Beads source gate at the Adapter seam, as literals (independent oracle): the pin is the exact path and SHA-256,
// decided before any spawn; an absent Bead is exactly the observed `bd show` error value and nothing else. The
// fixture bd's digest is an input here, never an expectation.

const FIXTURE_BD = resolve(import.meta.dir, "../fixtures/checker/bd")
const BEAD = "lkr-fixture"
const ABSENT = "no issues found matching the provided IDs"

const digestOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

let privateRoot: string
let workspace: string

beforeEach(() => {
	privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "msb-beads-unit-")))
	workspace = join(privateRoot, "workspace")
	mkdirSync(join(workspace, ".beads"), { recursive: true, mode: 0o700 })
})

afterEach(() => {
	rmSync(privateRoot, { recursive: true, force: true })
})

const reader = (executable: string, pin: BeadsPin) => createBeadsReader({ executable, workspace, cwd: workspace, pin })
const fixturePin = (): BeadsPin => ({ executable: FIXTURE_BD, sha256: digestOf(FIXTURE_BD) })

describe("the executable pin", () => {
	test("the pinned path with the pinned digest verifies and reports that digest", async () => {
		const read = await reader(FIXTURE_BD, fixturePin()).verifyStore(false)
		expect(read.status).toBe("verified")
		if (read.status !== "verified") return
		expect(read.store.executableDigest).toBe(digestOf(FIXTURE_BD))
		expect(read.store.version).toBe("1.2.2@6c124203e771")
	})

	test("a path other than the accepted one refuses, even with the accepted digest", async () => {
		const read = await reader(FIXTURE_BD, { executable: "/opt/not-bd", sha256: digestOf(FIXTURE_BD) }).verifyStore(false)
		expect(read).toEqual({ status: "executable-invalid", reason: `bd executable ${FIXTURE_BD} is not the accepted /opt/not-bd` })
	})

	test("the accepted path with another digest refuses and names both digests", async () => {
		const read = await reader(FIXTURE_BD, { executable: FIXTURE_BD, sha256: "0".repeat(64) }).verifyStore(false)
		expect(read.status).toBe("executable-invalid")
		if (read.status !== "executable-invalid") return
		expect(read.reason).toBe(`bd executable ${FIXTURE_BD} hashes ${digestOf(FIXTURE_BD)}, not the accepted ${"0".repeat(64)}`)
	})

	test("a digest mismatch refuses before the executable is spawned", async () => {
		const sentinel = join(privateRoot, "spawned")
		const executable = join(privateRoot, "bd-sentinel")
		writeFileSync(executable, `#!/bin/sh\n: > "${sentinel}"\necho 'bd version 1.2.2 (6c124203e: 6c124203e771)'\n`, { mode: 0o700 })
		const refused = await reader(executable, { executable, sha256: "0".repeat(64) }).verifyStore(false)
		expect(refused.status).toBe("executable-invalid")
		expect(existsSync(sentinel)).toBe(false)
		// The same script under its own digest is spawned: the sentinel proves the refusal above stopped the spawn.
		await reader(executable, { executable, sha256: digestOf(executable) }).verifyStore(false)
		expect(existsSync(sentinel)).toBe(true)
	})
})

describe("readPrime", () => {
	test("spawns prime in the pinned binary's read-only form and returns its additionalContext", async () => {
		const recorded = join(privateRoot, "argv")
		const executable = join(privateRoot, "bd-recorder")
		// The recorder writes one argument per line, then replays the hook envelope; its digest is an input, never an expectation.
		writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${recorded}"\necho '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"recorded prime"}}'\n`, { mode: 0o700 })
		const prime = await reader(executable, { executable, sha256: digestOf(executable) }).readPrime()
		expect(prime).toBe("recorded prime")
		// The exact argv as a literal (independent oracle): --readonly is the bd 1.2.2 global flag that blocks write operations.
		expect(readFileSync(recorded, "utf8").trimEnd().split("\n")).toEqual(["prime", "--readonly", "--hook-json"])
	})
})

describe("readBead classification of a JSON error value", () => {
	const steer = (error: string): void => {
		writeFileSync(join(workspace, ".beads", "fixture.json"), `${JSON.stringify({ showError: { [BEAD]: error } })}\n`)
	}

	test.each([
		["the observed absent-issue value", ABSENT],
		["the observed value with surrounding whitespace", ` ${ABSENT} \n`],
	])("%s is a missing Bead", async (_label, error) => {
		steer(error)
		const read = await reader(FIXTURE_BD, fixturePin()).readBead(BEAD)
		expect(read.status).toBe("missing")
	})

	test.each([
		["a missing database", "database does not exist"],
		["a differently cased absent-issue value", "No Issues Found Matching The Provided IDs"],
		["an issue-not-found phrasing bd 1.2.2 was never observed to emit", `issue ${BEAD} not found`],
		["a missing store", "no_beads_directory"],
		["contention", "database is locked by another process"],
	])("%s is unavailable, never a missing Bead", async (_label, error) => {
		steer(error)
		const read = await reader(FIXTURE_BD, fixturePin()).readBead(BEAD)
		expect(read).toEqual({ status: "unavailable", reason: `bd show: ${error}` })
	})
})
