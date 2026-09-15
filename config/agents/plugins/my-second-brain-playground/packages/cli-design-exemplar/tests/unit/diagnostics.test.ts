import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getLogger } from "@logtape/logtape"
import { openRunDiagnostics } from "../../src/diagnostics.ts"

// Diagnostics adapter (CDS-PE-2; brief 12, 8.2): permissions, deferred non-blocking flush, bounded queue, stage-classified
// sink failures, meta capture and field redaction, each observed on a real temp directory.

const roots: string[] = []
function root(): string {
	const created = realpathSync(mkdtempSync(join(tmpdir(), "repair-lab-diag-")))
	roots.push(created)
	return created
}
afterEach(() => {
	for (const created of roots.splice(0)) rmSync(created, { recursive: true, force: true })
})

function records(file: string): Array<Record<string, unknown>> {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe("diagnostics adapter", () => {
	test("creates a 0700 directory and a 0600 per-run file; log() is deferred to the next tick", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-1", command: "repair-lab.status", root: base, fault: null })
		const file = join(base, "diagnostics", "run-1.jsonl")
		expect(statSync(join(base, "diagnostics")).mode & 0o777).toBe(0o700)
		expect(statSync(file).mode & 0o777).toBe(0o600)
		diagnostics.log("a.started", "first")
		expect(readFileSync(file, "utf8")).toBe("")
		await tick()
		expect(records(file).map((record) => record.event_kind)).toEqual(["a.started"])
		diagnostics.setStation("repair-lab.healthy")
		diagnostics.log("a.completed", "second", { token: "SECRET-VALUE" })
		const status = await diagnostics.dispose()
		expect(status).toEqual({ file, sinkFailure: null, droppedRecords: 0 })
		const lines = records(file)
		expect(lines.map((record) => [record.sequence, record.event_id, record.station_id])).toEqual([
			[1, "run-1:1", null],
			[2, "run-1:2", "repair-lab.healthy"],
		])
		expect(lines[1]?.token).toBe("[REDACTED]")
		expect(readFileSync(file, "utf8").includes("SECRET-VALUE")).toBe(false)
	})
	test("a throwing sink is recorded at flush, never thrown into the caller", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-2", command: "repair-lab.status", root: base, fault: "sink-throw" })
		expect(() => diagnostics.log("a", "a")).not.toThrow()
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("flush: injected sink failure")
		expect(status.file).toBe(join(base, "diagnostics", "run-2.jsonl"))
	})
	test("a throwing disposal is recorded as dispose: and records already flushed stay written", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-3", command: "repair-lab.status", root: base, fault: "sink-dispose-throw" })
		diagnostics.log("a", "a")
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("dispose: injected dispose failure")
		expect(records(status.file)).toHaveLength(1)
	})
	test("an unwritable diagnostics path is recorded as open: and the run continues without a file", async () => {
		const base = root()
		writeFileSync(join(base, "diagnostics"), "not a directory\n")
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-4", command: "repair-lab.status", root: base, fault: null })
		diagnostics.log("a", "a")
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("open: diagnostics path is not a directory")
		expect(existsSync(join(base, "diagnostics", "run-4.jsonl"))).toBe(false)
	})
	test("a reused real directory at 0755 or 0777 is corrected to 0700 before the 0600 run file opens (PR 184, 4003813536)", async () => {
		for (const broad of [0o755, 0o777]) {
			const base = root()
			mkdirSync(join(base, "diagnostics"), { mode: broad })
			chmodSync(join(base, "diagnostics"), broad)
			expect(statSync(join(base, "diagnostics")).mode & 0o777).toBe(broad)
			const diagnostics = await openRunDiagnostics({ runIdentity: `run-${broad.toString(8)}`, command: "repair-lab.status", root: base, fault: null })
			const file = join(base, "diagnostics", `run-${broad.toString(8)}.jsonl`)
			expect(statSync(join(base, "diagnostics")).mode & 0o777).toBe(0o700)
			expect(statSync(file).mode & 0o777).toBe(0o600)
			diagnostics.log("a", "a")
			const status = await diagnostics.dispose()
			expect(status).toEqual({ file, sinkFailure: null, droppedRecords: 0 })
			expect(records(file)).toHaveLength(1)
		}
	})
	test("an existing directory is reused and a pre-existing file for the same run is refused as open:", async () => {
		const base = root()
		mkdirSync(join(base, "diagnostics"), { mode: 0o700 })
		writeFileSync(join(base, "diagnostics", "run-5.jsonl"), "")
		const status = await (await openRunDiagnostics({ runIdentity: "run-5", command: "repair-lab.status", root: base, fault: null })).dispose()
		expect(status.sinkFailure?.startsWith("open: ")).toBe(true)
	})
	test("the queue is bounded at 256: a flood drops the rest, and disposal appends one truncation record", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-6", command: "repair-lab.status", root: base, fault: "diagnostics-flood" })
		const status = await diagnostics.dispose()
		expect(status.droppedRecords).toBe(8)
		const lines = records(status.file)
		expect(lines).toHaveLength(257)
		expect(lines[256]?.event_kind).toBe("diagnostics.truncated")
	})
	test("a fatal LogTape meta record is captured as the sink status when nothing earlier failed", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-7", command: "repair-lab.status", root: base, fault: null })
		getLogger(["logtape", "meta"]).fatal("meta failure observed")
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("meta: meta failure observed")
	})
})
