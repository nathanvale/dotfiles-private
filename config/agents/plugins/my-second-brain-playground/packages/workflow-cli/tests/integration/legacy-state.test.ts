import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bindingPath, bindSession, createRoot, envelopeOf, removeRoot, resultOf, type Root, runCli } from "../fixtures/harness.ts"

// The preserved Python owner keeps its schema-v2 checkpoints at <root>/my-second-brain-playground/recovery/sessions/
// <session>.json. Ticket #58: the helper never reads, rewrites, or deletes them, and its own bindings live under a
// distinct address. One v2 checkpoint is planted at the legacy address for the very session the helper is asked
// about; its bytes, mode and mtime are the oracle for every row. The field set is the Python owner's CHECKPOINT_KEYS.

const SESSION = "session-1"
const LEGACY_MTIME = new Date("2026-09-16T08:00:00Z")

interface Planted {
	readonly path: string
	readonly bytes: string
}

function plantLegacyCheckpoint(root: Root): Planted {
	const directory = join(root.stateHome, "my-second-brain-playground", "recovery", "sessions")
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const path = join(directory, `${SESSION}.json`)
	const checkpoint = {
		schemaVersion: 2,
		vaultRoot: "/Users/example/vault",
		projectMap: "projects/ledger-workflow/README.md",
		goalPath: "projects/ledger-workflow/GOAL.md",
		evidencePath: "projects/ledger-workflow/proof.md",
		recoveryPath: "docs/agents/recovery.md",
		agentLedgerExecutable: "/Users/example/bin/agent-ledger",
		sessionIdentity: SESSION,
		registerPath: "/Users/example/register.sqlite",
		taskIdentity: "ledger-task-1",
		programIdentity: "ledger-program-1",
		scope: "compaction-recovery",
		observedAt: "2026-09-16T08:00:00Z",
	}
	const bytes = `${JSON.stringify(checkpoint)}\n`
	writeFileSync(path, bytes, { mode: 0o600 })
	utimesSync(path, LEGACY_MTIME, LEGACY_MTIME)
	return { path, bytes }
}

function expectUntouched(planted: Planted): void {
	const stat = statSync(planted.path)
	expect(readFileSync(planted.path, "utf8")).toBe(planted.bytes)
	expect(stat.mode & 0o777).toBe(0o600)
	expect(stat.mtime.getTime()).toBe(LEGACY_MTIME.getTime())
	expect(readdirSync(join(planted.path, ".."))).toEqual([`${SESSION}.json`])
}

let root: Root
let planted: Planted

beforeEach(() => {
	root = createRoot()
	planted = plantLegacyCheckpoint(root)
})

afterEach(() => {
	removeRoot(root)
})

describe("schema-v2 checkpoints at the legacy address are never read, rewritten, or deleted", () => {
	test("recover for the same session refuses binding-absent at the helper's own address and leaves the checkpoint as planted", async () => {
		const run = await runCli(root, ["recover", "--workspace", root.workspace, "--session", SESSION, "--json"])
		expect(run.stderr).toBe("")
		expect(run.exit).toBe(3)
		expect(envelopeOf(run).causeCode).toBe("DOMAIN_BINDING_ABSENT")
		expect(resultOf(run).bindingPath).toBe(bindingPath(root, SESSION))
		expect(run.stdout).not.toContain(planted.path)
		expectUntouched(planted)
	})

	test("inspect names the absent helper binding, never the legacy checkpoint", async () => {
		const run = await runCli(root, ["inspect", "--workspace", root.workspace, "--session", SESSION, "--json"])
		expect(run.stderr).toBe("")
		expect(run.exit).toBe(3)
		expect(envelopeOf(run).causeCode).toBe("DOMAIN_PREREQUISITE_FAILED")
		const binding = (resultOf(run).checks as { name: string; status: string; detail: string }[]).find((check) => check.name === "binding")
		expect(binding?.status).toBe("fail")
		expect(binding?.detail).toBe(`no binding at ${bindingPath(root, SESSION)}`)
		expect(run.stdout).not.toContain(planted.path)
		expectUntouched(planted)
	})

	test("bind and recover succeed beside the checkpoint, writing only the helper's own binding", async () => {
		await bindSession(root, SESSION)
		const run = await runCli(root, ["recover", "--workspace", root.workspace, "--session", SESSION, "--json"])
		expect(run.exit).toBe(0)
		expect(resultOf(run).station).toBe("recovered")
		expect(statSync(bindingPath(root, SESSION)).mode & 0o777).toBe(0o600)
		expect(run.stdout).not.toContain(planted.path)
		expectUntouched(planted)
	})
})
