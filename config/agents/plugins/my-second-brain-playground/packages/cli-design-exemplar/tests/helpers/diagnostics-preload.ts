import { mock } from "bun:test"
import * as fs from "node:fs"
import { join } from "node:path"
import * as diagnostics from "../../src/diagnostics.ts"

// Test-owned fault/barrier adapter. Imported only by explicit Bun --preload in the O2 process harness.
// Ordinary production main.ts, parser, domain, envelope and diagnostics still run in the child.
const actualOpenDiagnostics = diagnostics.openRunDiagnostics
const mode = process.env.O2_MODE
const writeMode = process.env.O2_WRITE_MODE ?? mode
const control = process.env.O2_CONTROL ?? ""
const fds = new Set<number>()
const originalOpen = fs.openSync
const originalWrite = fs.write
function signalReady(): void { fs.writeFileSync(join(control, `ready-${process.pid}`), "ready\n", { mode: 0o600 }) }
function prepareDestination(path: fs.PathLike): void {
	if (mode === "enospc") throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" })
	if (mode === "existing") fs.writeFileSync(path, "existing bytes\n", { mode: 0o600 })
	if (mode === "final-symlink") fs.symlinkSync(join(control, "sentinel"), path)
	if (mode === "fifo") { const made = Bun.spawnSync(["/usr/bin/mkfifo", String(path)]); if (made.exitCode !== 0) throw new Error("FIFO fixture failed") }
}
const patchedOpen: typeof fs.openSync = (path, flags, permissions) => {
	const selected = String(path).endsWith(".jsonl") && String(path).includes("/repair-lab/diagnostics/")
	if (selected) prepareDestination(path)
	const fd = originalOpen(path, flags, permissions)
	if (selected) {
		fds.add(fd)
		if (mode === "replace") { fs.renameSync(path, `${String(path)}.owned`); fs.symlinkSync(join(control, "sentinel"), path) }
	}
	return fd
}
// This adapter is exactly the positional overload used by the production descriptor sink.
function patchedWrite(fd: number, buffer: Buffer, offset: number, length: number, position: number | null, callback: (error: NodeJS.ErrnoException | null, written: number, buffer: Buffer) => void): void {
	if (!fds.has(fd)) { originalWrite(fd, buffer, offset, length, position, callback); return }
	if (mode === "failure-then-drop" || mode === "drop-then-failure") { callback(new Error("injected diagnostic write failure"), 0, buffer); firstWriteFailed(); return }
	if (writeMode === "stuck" || writeMode === "late") {
		signalReady()
		if (writeMode === "late") setTimeout(() => originalWrite(fd, buffer, offset, length, position, callback), 900)
		return
	}
	if (mode === "barrier") {
		signalReady()
		const timer = setInterval(() => { if (fs.existsSync(join(control, "release"))) { clearInterval(timer); originalWrite(fd, buffer, offset, length, position, callback) } }, 2)
		return
	}
	originalWrite(fd, buffer, offset, length, position, callback)
}
mock.module("node:fs", () => ({ ...fs, openSync: patchedOpen, write: patchedWrite }))

if (mode === "hostile-record" || mode === "byte-flood") {
	mock.module("../../src/diagnostics.ts", () => ({ ...diagnostics, openRunDiagnostics: async (options: Parameters<typeof diagnostics.openRunDiagnostics>[0]) => {
		const opened = await actualOpenDiagnostics(options)
		const log = opened.log.bind(opened)
		return { ...opened, log(event: string, summary: string, properties: Record<string, unknown>) {
			if (mode === "hostile-record") log(event, "x".repeat(64_001), { ...properties, token: process.env.O2_SECRET, text: `free text ${process.env.O2_SECRET}`, encoded: Buffer.from(process.env.O2_SECRET ?? "").toString("base64"), deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: process.env.O2_SECRET } } } } } } } } } })
			else {
				const wide = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field_${String(index).padStart(3, "0")}_${"a".repeat(45)}`, Object.fromEntries(Array.from({ length: 4 }, (_, nested) => [`number_${nested}`, 123456789]))]))
				for (let index = 0; index < 100; index += 1) log(event, summary, wide)
			}
		} }
	} }))
}

if (mode === "signal-ready") {
	mock.module("../../src/diagnostics.ts", () => ({ ...diagnostics, openRunDiagnostics: async (options: Parameters<typeof actualOpenDiagnostics>[0]) => {
		const opened = await actualOpenDiagnostics(options)
		return { ...opened, dispose(): Promise<diagnostics.DiagnosticsStatus> {
			signalReady()
			// Hold the front door immediately before finalization; the real signal handler finalizes its active owner.
			return new Promise(() => { setInterval(() => {}, 1000) })
		} }
	} }))
}

function corruptStatus(status: diagnostics.DiagnosticsStatus): unknown {
	switch (process.env.O2_CORRUPTION) {
		case "timeout-closed": return { ...status, closed: true }
		case "timeout-empty-count": return { ...status, unflushedRecords: 0 }
		case "drops-without-failure": return { ...status, droppedRecords: 1 }
		case "unflushed-without-failure": return { ...status, unflushedRecords: 1 }
		case "unsafe-count": return { ...status, droppedRecords: Number.MAX_SAFE_INTEGER + 1 }
		case "wrong-boolean": return { ...status, closed: "yes" }
		case "relative-path": return { ...status, file: "relative.jsonl" }
		case "nonobject": return "invalid status"
		case "getter": return Object.defineProperty({ ...status }, "droppedRecords", { get() { throw new Error("bad accounting getter") }, enumerable: true })
		case "missing-count": { const { droppedRecords: _omitted, ...rest } = status; return rest }
		default: return { ...status, droppedRecords: -1 }
	}
}
if (mode === "invalid-status") {
	mock.module("../../src/diagnostics.ts", () => ({ ...diagnostics, openRunDiagnostics: async (options: Parameters<typeof actualOpenDiagnostics>[0]) => {
		const opened = await actualOpenDiagnostics(options)
		return { ...opened, async dispose(): Promise<diagnostics.DiagnosticsStatus> {
			// Deliberately violate the typed producer seam only in this named fault adapter.
			return corruptStatus(await opened.dispose()) as diagnostics.DiagnosticsStatus
		} }
	} }))
}

let firstWriteFailed: () => void = () => {}
const writeFailureObserved = new Promise<void>((resolve) => { firstWriteFailed = resolve })
if (mode === "failure-then-drop") {
	mock.module("../../src/diagnostics.ts", () => ({ ...diagnostics, openRunDiagnostics: async (options: Parameters<typeof actualOpenDiagnostics>[0]) => {
		const opened = await actualOpenDiagnostics(options)
		opened.log("diagnostics.first", "first record")
		await writeFailureObserved
		await Promise.resolve()
		return opened
	} }))
}
