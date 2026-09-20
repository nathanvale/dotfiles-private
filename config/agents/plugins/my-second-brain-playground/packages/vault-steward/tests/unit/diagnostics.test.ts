import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRunDiagnostics } from "../../src/diagnostics.ts"

// Diagnostics custody in-process: one private JSONL per run under the XDG state root, secret-shaped keys redacted at
// the sink by @logtape/redaction, a truthful status block, and unavailable custody that never throws.

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("a run writes a 0600 JSONL file in a 0700 directory, redacts secret keys, and reports a closed status", async () => {
	// Custody refuses symlinked ancestors (/var -> /private/var), so the root is the real path.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-steward-diag-")))
	roots.push(root)
	const diagnostics = await openRunDiagnostics({ runId: "run-test-1", command: "vault-steward.inspect", env: { HOME: root, XDG_STATE_HOME: join(root, "state") } })
	diagnostics.log("command.start", { route: "inspect", api_key: "MARKER_SECRET_VALUE", nested: { password: "MARKER_SECRET_VALUE", ref: "refs/heads/main" } })
	diagnostics.setStation('["vault-steward.inspect","success","SUCCESS_UNCHANGED"]')
	const status = await diagnostics.dispose()
	const directory = join(root, "state", "vault-steward", "diagnostics")
	expect(status).toMatchObject({ file: join(directory, "run-test-1.jsonl"), sinkFailure: null, droppedRecords: 0, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: true })
	expect(statSync(directory).mode & 0o777).toBe(0o700)
	expect(statSync(status.file as string).mode & 0o777).toBe(0o600)
	const text = readFileSync(status.file as string, "utf8")
	expect(text).not.toContain("MARKER_SECRET_VALUE")
	expect(text).toContain("[REDACTED]")
	expect(text).toContain("refs/heads/main")
	expect(text.trim().split("\n").every((line) => JSON.parse(line).runId === "run-test-1")).toBe(true)
	expect(readdirSync(directory).some((name) => name.startsWith("run-test-1.jsonl.closed-"))).toBe(true)
})

test("unavailable custody is disclosed instead of thrown", async () => {
	const diagnostics = await openRunDiagnostics({ runId: "run-test-2", command: "vault-steward.inspect", env: { HOME: "relative-home" } })
	diagnostics.log("command.start")
	const status = await diagnostics.dispose()
	expect(status.file).toBeNull()
	expect(status.sinkFailure).toBe("setup")
	expect(status.countsComplete).toBeNull()
})
