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
	mkdirSync(join(created, "repair-lab"), { mode: 0o700 })
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
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-1", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })
		const file = join(base, "repair-lab", "diagnostics", "run-1.jsonl")
		expect(statSync(join(base, "repair-lab", "diagnostics")).mode & 0o777).toBe(0o700)
		expect(statSync(file).mode & 0o777).toBe(0o600)
		diagnostics.log("a.started", "first")
		expect(readFileSync(file, "utf8")).toBe("")
		await tick()
		expect(records(file).map((record) => record.event_kind)).toEqual(["a.started"])
		diagnostics.setStation("repair-lab.healthy")
		diagnostics.log("a.completed", "second", { token: "SECRET-VALUE", password: 7832661, credential: { numeric: 193715 } })
		const status = await diagnostics.dispose()
		expect(status).toEqual({ file, sinkFailure: null, droppedRecords: 0, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: true })
		const lines = records(file)
		expect(lines.map((record) => [record.sequence, record.event_id, record.station_id])).toEqual([
			[1, "run-1:1", null],
			[2, "run-1:2", "repair-lab.healthy"],
		])
		expect((lines[1]?.details as Record<string, unknown>).token).toBe("[REDACTED]")
		expect(readFileSync(file, "utf8").includes("SECRET-VALUE")).toBe(false)
		expect(readFileSync(file, "utf8")).not.toContain("7832661")
		expect(readFileSync(file, "utf8")).not.toContain("193715")
	})
	test("a throwing sink is recorded at flush, never thrown into the caller", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-2", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: "sink-throw" })
		expect(() => diagnostics.log("a", "a")).not.toThrow()
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("flush: write failed")
		expect(status.file).toBe(join(base, "repair-lab", "diagnostics", "run-2.jsonl"))
		expect(status).toEqual({ file: join(base, "repair-lab", "diagnostics", "run-2.jsonl"), sinkFailure: "flush: write failed", droppedRecords: 0, unflushedRecords: 1, truncatedRecords: 0, countsComplete: true, closed: true })
	})
	test("a throwing disposal is recorded as dispose: and records already flushed stay written", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-3", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: "sink-dispose-throw" })
		diagnostics.log("a", "a")
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("dispose: close failed")
		expect(status.closed).toBe(false)
		if (status.file === null) throw new Error("opened diagnostics file was lost")
		expect(records(status.file)).toHaveLength(1)
	})
	test("an unwritable diagnostics path is recorded as open: and the run continues without a file", async () => {
		const base = root()
		writeFileSync(join(base, "repair-lab", "diagnostics"), "not a directory\n")
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-4", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })
		diagnostics.log("a", "a")
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("open: private diagnostics unavailable")
		expect(existsSync(join(base, "repair-lab", "diagnostics", "run-4.jsonl"))).toBe(false)
	})
	test("a reused real directory at 0755 or 0777 is corrected to 0700 before the 0600 run file opens (PR 184, 4003813536)", async () => {
		for (const broad of [0o755, 0o777]) {
			const base = root()
			mkdirSync(join(base, "repair-lab", "diagnostics"), { mode: broad })
			chmodSync(join(base, "repair-lab", "diagnostics"), broad)
			expect(statSync(join(base, "repair-lab", "diagnostics")).mode & 0o777).toBe(broad)
			const diagnostics = await openRunDiagnostics({ runIdentity: `run-${broad.toString(8)}`, command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })
			const file = join(base, "repair-lab", "diagnostics", `run-${broad.toString(8)}.jsonl`)
			expect(statSync(join(base, "repair-lab", "diagnostics")).mode & 0o777).toBe(0o700)
			expect(statSync(file).mode & 0o777).toBe(0o600)
			diagnostics.log("a", "a")
			const status = await diagnostics.dispose()
			expect(status).toEqual({ file, sinkFailure: null, droppedRecords: 0, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: true })
			expect(records(file)).toHaveLength(1)
		}
	})
	test("an existing directory is reused and a pre-existing file for the same run is refused as open:", async () => {
		const base = root()
		mkdirSync(join(base, "repair-lab", "diagnostics"), { mode: 0o700 })
		writeFileSync(join(base, "repair-lab", "diagnostics", "run-5.jsonl"), "")
		const status = await (await openRunDiagnostics({ runIdentity: "run-5", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })).dispose()
		expect(status.sinkFailure?.startsWith("open: ")).toBe(true)
	})
	test("the queue is bounded at 256: a flood drops the rest, and status discloses loss without admission after the bound", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-6", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: "diagnostics-flood" })
		const status = await diagnostics.dispose()
		expect(status.droppedRecords).toBe(8)
		expect(status.unflushedRecords).toBe(0)
		expect(status.truncatedRecords).toBe(0)
		expect(status.countsComplete).toBe(true)
		if (status.file === null) throw new Error("opened diagnostics file was lost")
		const lines = records(status.file)
		expect(lines).toHaveLength(256)
		expect(lines[255]?.event_kind).toBe("diagnostics.flood")
	})
	test("a fatal LogTape meta record is captured as the sink status when nothing earlier failed", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-7", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })
		getLogger(["logtape", "meta"]).fatal("meta failure observed")
		const status = await diagnostics.dispose()
		expect(status.sinkFailure).toBe("meta: logging failure")
	})
})

describe("O2 record and run admission", () => {
	test("an oversized serialized record is replaced by a valid bounded marked record", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "serialized", command: "repair-lab.inspect", env: { XDG_STATE_HOME: base }, fault: null })
		// All numeric payload: independently constructed to exceed 64,001 serialized bytes without secret text.
		const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`group_${index}`, Object.fromEntries(Array.from({ length: 10 }, (_, child) => [`value_${child}_${"a".repeat(54)}`, 1.234567890123456e+100]))]))
		diagnostics.log("inspect.completed", "ready", wide)
		const status = await diagnostics.dispose()
		expect(status.truncatedRecords).toBe(1)
		const file = status.file as string
		expect(statSync(file).size).toBeLessThanOrEqual(64_000)
		expect(records(file)).toHaveLength(1)
		expect(records(file)[0]?.truncated).toBe(true)
		expect(records(file)[0]?.details).toBeUndefined()
	})
	test("the run byte limit also applies across separately flushed batches", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "run-cap", command: "repair-lab.inspect", env: { XDG_STATE_HOME: base }, fault: null })
		const payload = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`group_${index}_${"a".repeat(40)}`, Object.fromEntries(Array.from({ length: 4 }, (_, child) => [`value_${child}`, 1234567890123]))]))
		for (let batch = 0; batch < 20; batch += 1) {
			for (let index = 0; index < 10; index += 1) diagnostics.log("inspect.completed", "ready", payload)
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		const status = await diagnostics.dispose()
		expect(status.droppedRecords).toBeGreaterThan(0)
		expect(statSync(status.file as string).size).toBeGreaterThan(900_000)
		expect(statSync(status.file as string).size).toBeLessThanOrEqual(1_000_000)
	})
	test("status is immutable and logging after disposal cannot alter it or append bytes", async () => {
		const base = root()
		const diagnostics = await openRunDiagnostics({ runIdentity: "frozen", command: "repair-lab.inspect", env: { XDG_STATE_HOME: base }, fault: null })
		diagnostics.log("inspect.completed", "done")
		const status = await diagnostics.dispose()
		const bytes = readFileSync(status.file as string, "utf8")
		diagnostics.log("inspect.completed", "late")
		expect(await diagnostics.dispose()).toEqual(status)
		expect(Object.isFrozen(status)).toBe(true)
		expect(readFileSync(status.file as string, "utf8")).toBe(bytes)
	})
})
