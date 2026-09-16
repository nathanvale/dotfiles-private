import { AsyncLocalStorage } from "node:async_hooks"
import { write, writeSync } from "node:fs"
import { configure, dispose, getJsonLinesFormatter, getLogger, type LogRecord, type Sink } from "@logtape/logtape"
import { openDiagnosticFile, type DiagnosticFile } from "./diagnostics-custody.ts"
import { REDACTED, SECRET_KEY_PATTERN } from "./engine.ts"

export interface DiagnosticsStatus {
	file: string | null
	sinkFailure: string | null
	droppedRecords: number | null
	unflushedRecords: number | null
	truncatedRecords: number | null
	countsComplete: boolean | null
	closed: boolean | null
}
export interface RunDiagnostics {
	log(eventKind: string, summary: string, properties?: Record<string, unknown>): void
	setStation(stationId: string): void
	emergency(eventKind: string): void
	dispose(): Promise<DiagnosticsStatus>
}
export type DiagnosticsFault = "sink-throw" | "sink-dispose-throw" | "diagnostics-flood" | null
const RECORD_BYTES = 64_000
const BUFFER_BYTES = 1_000_000
const RUN_BYTES = 1_000_000
const RECORDS = 256
const FLUSH_MS = 500
// Includes retained byte buffers, per-entry bookkeeping and a reserved serialization workspace.
const SERIALIZATION_BYTES = RECORD_BYTES * 8
const ENTRY_BYTES = 256
const formatter = getJsonLinesFormatter({ properties: "flatten" })

interface Projection { value: unknown; truncated: boolean }
function project(value: unknown, depth: number, budget: { nodes: number }): Projection {
	if (budget.nodes-- <= 0 || depth > 8) return { value: "[TRUNCATED]", truncated: true }
	if (typeof value === "string") return { value: REDACTED, truncated: value.length > RECORD_BYTES }
	if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return { value, truncated: false }
	if (typeof value !== "object") return { value: REDACTED, truncated: false }
	return projectObject(value, depth, budget)
}

function projectObject(value: object, depth: number, budget: { nodes: number }): Projection {
	const entries: Record<string, unknown> = {}
	let truncated = false
	let count = 0
	// No getters/toJSON: diagnostics neither execute caller code nor retain caller-owned objects.
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue
		if (++count > 128 || budget.nodes <= 0) { truncated = true; break }
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue
		if (SECRET_KEY_PATTERN.test(key)) { entries[key] = REDACTED; continue }
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		const child = project(descriptor?.value, depth + 1, budget)
		entries[key] = child.value
		truncated ||= child.truncated
	}
	return { value: entries, truncated }
}

function safeFieldNames(value: unknown): string[] { return Array.isArray(value) ? value.slice(0, 128).filter((item): item is string => typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item)) : [] }
function identifier(value: string): string { return /^[a-z][a-z0-9.:-]{0,127}$/.test(value) ? value : "redacted" }
function serialize(record: LogRecord): { bytes: Buffer; truncated: boolean } {
	let bytes = Buffer.from(formatter(record))
	const truncated = bytes.length > RECORD_BYTES || record.properties.truncated === true
	if (bytes.length > RECORD_BYTES) {
		// Remove the entire payload; slicing serialized JSON can expose a prefix or make invalid JSON.
		bytes = Buffer.from(formatter({ ...record, message: ["[TRUNCATED]"], properties: { runIdentity: record.properties.runIdentity, command: record.properties.command, sequence: record.properties.sequence, event_id: record.properties.event_id, event_kind: record.properties.event_kind, truncated: true } }))
	}
	return { bytes, truncated }
}

function writeBytes(fd: number, bytes: Buffer): Promise<void> {
	if (bytes.length === 0) return Promise.resolve()
	return new Promise((resolve, reject) => {
		let offset = 0
		const writeRemaining = (): void => {
			write(fd, bytes, offset, bytes.length - offset, null, (error, written) => {
				if (error !== null) reject(error)
				else if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) reject(new Error("invalid diagnostic write length"))
				else {
					offset += written
					if (offset === bytes.length) resolve()
					else writeRemaining()
				}
			})
		}
		writeRemaining()
	})
}

export function writeBytesSync(fd: number, bytes: Buffer, writer: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number = writeSync): boolean {
	let offset = 0
	try {
		while (offset < bytes.length) {
			const remaining = bytes.length - offset
			const written = writer(fd, bytes, offset, remaining, null)
			if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) return false
			offset += written
		}
		return true
	} catch {
		return false
	}
}

class BoundedQueue {
	private readonly queue: Buffer[] = []
	private retainedBytes = 0
	private admittedBytes = 0
	private pending = 0
	private stopped = false
	private frozen: DiagnosticsStatus | null = null
	private draining: Promise<void> | null = null
	private timer: ReturnType<typeof setTimeout> | null = null
	dropped = 0
	unflushed = 0
	truncated = 0
	failure: string | null = null
	closed = false
	constructor(private readonly file: DiagnosticFile, private readonly fault: DiagnosticsFault) {}

	log(record: LogRecord): void {
		if (this.stopped || this.failure !== null) { if (this.frozen === null) this.dropped += 1; return }
		if (this.queue.length + this.pending >= RECORDS) { this.drop(); return }
		const encoded = serialize(record)
		const cost = encoded.bytes.length + ENTRY_BYTES
		if (this.retainedBytes + cost + SERIALIZATION_BYTES > BUFFER_BYTES || this.admittedBytes + encoded.bytes.length > RUN_BYTES) { this.drop(); return }
		this.truncated += Number(encoded.truncated)
		this.queue.push(encoded.bytes)
		this.retainedBytes += cost
		this.admittedBytes += encoded.bytes.length
		if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 0)
	}

	private drop(): void { this.failure ??= "capacity: admission bound"; this.dropped += 1; this.stopped = true }

	private async drain(): Promise<void> {
		while (this.queue.length > 0 && this.frozen === null) {
			const bytes = this.queue.shift() as Buffer
			this.pending = 1
			try {
				if (this.fault === "sink-throw") throw new Error("injected sink failure")
				await writeBytes(this.file.fd, bytes)
			} catch {
				if (this.frozen === null) { this.failure ??= "flush: write failed"; this.unflushed += 1 + this.queue.length; this.queue.length = 0 }
			} finally {
				this.pending = 0
				this.retainedBytes -= bytes.length + ENTRY_BYTES
			}
		}
	}

	private flush(): Promise<void> {
		this.draining ??= this.drain().finally(() => { this.draining = null })
		return this.draining
	}

	emergency(bytes: Buffer): void {
		if (this.frozen !== null || this.closed || this.pending > 0 || bytes.length > RECORD_BYTES) return
		writeBytesSync(this.file.fd, bytes)
	}

	async finish(): Promise<DiagnosticsStatus> {
		if (this.frozen !== null) return this.frozen
		this.stopped = true
		if (this.timer !== null) clearTimeout(this.timer)
		let timer: ReturnType<typeof setTimeout> | undefined
		const complete = await Promise.race([
			this.flush().then(() => true),
			new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), FLUSH_MS) }),
		])
		clearTimeout(timer)
		if (!complete) { this.failure ??= "timeout: diagnostic flush"; this.unflushed += this.pending + this.queue.length }
		else this.close()
		this.queue.length = 0
		this.frozen = Object.freeze({ file: this.file.file, sinkFailure: this.failure, droppedRecords: this.dropped, unflushedRecords: this.unflushed, truncatedRecords: this.truncated, countsComplete: true, closed: this.closed })
		// A timed-out drain may still settle before exit: close then so the file earns its closure proof and stops
		// reserving a full run allowance. The frozen status above already reported the timeout and stays unchanged.
		if (!complete) void this.flush().then(() => this.close(), () => this.close())
		return this.frozen
	}

	private close(): void {
		try {
			if (this.fault === "sink-dispose-throw") throw new Error("injected dispose failure")
			this.file.close()
			this.closed = true
		} catch { this.failure ??= "dispose: close failed" }
	}
}

async function finishLogTape(milliseconds: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	await Promise.race([dispose().catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds) })])
	clearTimeout(timer)
}

let active: RunDiagnostics | null = null
// Main's signal handler uses the same idempotent, bounded finalization as normal exit.
export async function finishActiveDiagnostics(): Promise<void> { await active?.dispose() }
// Crash handling gets one synchronous, bounded write to the already owned descriptor. It never opens a path,
// waits for disposal, changes domain truth or promises that the operating system persisted the bytes.
export function attemptEmergencyDiagnostics(): void { active?.emergency("process.crash") }

export async function openRunDiagnostics(options: { runIdentity: string; command: string; env: Record<string, string | undefined>; fault: DiagnosticsFault }): Promise<RunDiagnostics> {
	const { runIdentity, command, env, fault } = options
	let sequence = 0
	let stationId: string | null = null
	let queue: BoundedQueue | null = null
	let failure: string | null = null
	let configured = false
	const logger = getLogger(["repair-lab"])
	let finished: Promise<DiagnosticsStatus> | null = null
	const started = performance.now()
	const opened: RunDiagnostics = {
		log(eventKind, summary, properties = {}) {
			if (!configured || finished !== null) return
			sequence += 1
			try {
				const projected = project(properties, 0, { nodes: 1024 })
				const event = identifier(eventKind)
				const safeSummary = `${identifier(command)}: ${event}`
				logger.info(safeSummary, { runIdentity, command: identifier(command), sequence, event_id: `${runIdentity}:${sequence}`, event_kind: event, station_id: stationId, summary: safeSummary, duration_ms: performance.now() - started, sensitive_fields_redacted: safeFieldNames(properties.sensitive_fields_redacted), details: projected.value, truncated: projected.truncated || summary.length > RECORD_BYTES })
			} catch { if (queue !== null) { queue.failure ??= "log: serialization failed"; queue.dropped += 1 } }
		},
		setStation(id) { stationId = identifier(id) },
		emergency(eventKind) {
			if (queue === null || finished !== null) return
			sequence += 1
			const event = identifier(eventKind)
			const bytes = Buffer.from(`${JSON.stringify({ runIdentity, command: identifier(command), sequence, event_id: `${runIdentity}:${sequence}`, event_kind: event, summary: `${identifier(command)}: ${event}`, emergency: true })}\n`)
			queue.emergency(bytes)
		},
		dispose() {
			finished ??= finalize()
			return finished
		},
	}
	async function finalize(): Promise<DiagnosticsStatus> {
		const deadline = performance.now() + FLUSH_MS
		const status = queue === null ? { file: null, sinkFailure: failure, droppedRecords: null, unflushedRecords: null, truncatedRecords: null, countsComplete: null, closed: null } : await queue.finish()
		// LogTape has no external file/disposal resource: the owned queue alone owns descriptor finalization.
		if (configured) await finishLogTape(Math.max(0, deadline - performance.now()))
		if (active === opened) active = null
		return Object.freeze({ ...status, sinkFailure: failure ?? status.sinkFailure })
	}
	try {
		queue = new BoundedQueue(openDiagnosticFile(env, runIdentity), fault)
		// Publish the idempotent finalizer before asynchronous LogTape setup so a signal cannot strand the descriptor.
		active = opened
		const owned = queue
		const meta: Sink = (record) => { if (["warning", "error", "fatal"].includes(record.level)) owned.failure ??= "meta: logging failure" }
		await configure({ sinks: { file: (record) => owned.log(record), meta }, loggers: [{ category: ["repair-lab"], sinks: ["file"], lowestLevel: "debug" }, { category: ["logtape", "meta"], sinks: ["meta"], lowestLevel: "debug" }], contextLocalStorage: new AsyncLocalStorage(), reset: true })
		configured = true
	} catch (error) { failure = queue?.failure ?? (error instanceof Error && error.message === "capacity" ? "capacity: no safe reservation" : "open: private diagnostics unavailable") }
	if (fault === "diagnostics-flood") for (let index = 0; index < RECORDS + 8; index += 1) opened.log("diagnostics.flood", "flood")
	return opened
}
