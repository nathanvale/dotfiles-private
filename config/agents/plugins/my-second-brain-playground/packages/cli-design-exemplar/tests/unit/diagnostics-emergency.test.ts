import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalOpen = fs.openSync
const originalWrite = fs.write
const originalWriteSync = fs.writeSync
const diagnosticDescriptors = new Set<number>()
let mode: "pending" | "short" | null = null
let releasePending: (() => void) | null = null
let writeStarted: Promise<void> = Promise.resolve()
let markWriteStarted: () => void = () => {}
let synchronousWrites = 0

const patchedOpen: typeof fs.openSync = (path, flags, permissions) => {
	const fd = originalOpen(path, flags, permissions)
	if (String(path).endsWith(".jsonl") && String(path).includes("/repair-lab/diagnostics/")) diagnosticDescriptors.add(fd)
	return fd
}

function patchedWrite(fd: number, buffer: Buffer, offset: number, length: number, position: number | null, callback: (error: NodeJS.ErrnoException | null, written: number, buffer: Buffer) => void): void {
	if (mode === "pending" && diagnosticDescriptors.has(fd) && releasePending === null) {
		releasePending = () => { originalWrite(fd, buffer, offset, length, position, callback) }
		markWriteStarted()
		return
	}
	originalWrite(fd, buffer, offset, length, position, callback)
}

const patchedWriteSync: typeof fs.writeSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number => {
	if (!diagnosticDescriptors.has(fd)) return originalWriteSync(fd, buffer, offset, length, position)
	synchronousWrites += 1
	const selected = mode === "short" && synchronousWrites === 1 ? Math.max(1, Math.floor(length / 2)) : length
	return originalWriteSync(fd, buffer, offset, selected, position)
}) as typeof fs.writeSync

mock.module("node:fs", () => ({ ...fs, openSync: patchedOpen, write: patchedWrite, writeSync: patchedWriteSync }))
const { openRunDiagnostics } = await import("../../src/diagnostics.ts")

const roots: string[] = []
function root(): string {
	const created = realpathSync(mkdtempSync(join(tmpdir(), "repair-lab-emergency-")))
	mkdirSync(join(created, "repair-lab"), { mode: 0o700 })
	roots.push(created)
	return created
}

beforeEach(() => {
	mode = null
	releasePending = null
	synchronousWrites = 0
	writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
})

afterEach(() => {
	for (const created of roots.splice(0)) rmSync(created, { recursive: true, force: true })
})

test("emergency diagnostics skip a descriptor while an asynchronous record write is pending", async () => {
	mode = "pending"
	const base = root()
	const diagnostics = await openRunDiagnostics({ runIdentity: "run-pending", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })
	diagnostics.log("status.completed", "complete")
	await writeStarted
	diagnostics.emergency("process.crash")
	expect(synchronousWrites).toBe(0)
	if (releasePending === null) throw new Error("diagnostic write barrier was not installed")
	releasePending()
	const status = await diagnostics.dispose()
	const lines = readFileSync(status.file as string, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
	expect(lines).toHaveLength(1)
	expect(lines[0]?.event_kind).toBe("status.completed")
})

test("emergency diagnostics retry a short synchronous descriptor write", async () => {
	mode = "short"
	const base = root()
	const diagnostics = await openRunDiagnostics({ runIdentity: "run-short", command: "repair-lab.status", env: { XDG_STATE_HOME: base }, fault: null })
	diagnostics.emergency("process.crash")
	const status = await diagnostics.dispose()
	expect(synchronousWrites).toBe(2)
	const bytes = readFileSync(status.file as string, "utf8")
	expect(bytes.endsWith("\n")).toBe(true)
	expect(JSON.parse(bytes)).toMatchObject({ event_kind: "process.crash", emergency: true })
})
