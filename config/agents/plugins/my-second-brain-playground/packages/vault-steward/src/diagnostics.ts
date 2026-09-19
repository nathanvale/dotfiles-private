// LogTape 2.3.1 diagnostics for the Vault Steward CLI (CLI-BRIEF.md section 3): one private JSONL file per process run
// under the custody owner, `@logtape/redaction` redactByField at the sink for secret-shaped keys, bounded records and
// flush, and a truthful status block for the envelope. Diagnostic loss never changes the domain result. The alias front
// door never opens this module. Derived from the exemplar's diagnostics.ts (bounded queue and emergency write).
import { AsyncLocalStorage } from "node:async_hooks"
import { write, writeSync } from "node:fs"
import { configure, dispose, getJsonLinesFormatter, getLogger, type LogRecord, type Sink } from "@logtape/logtape"
import { redactByField } from "@logtape/redaction"
import { type DiagnosticFile, openDiagnosticFile } from "./diagnostics-custody.ts"

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i
const REDACTED = "[REDACTED]"
const CATEGORY = ["vault-steward"] as const

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
	log(eventKind: string, properties?: Record<string, unknown>): void
	setStation(stationId: string): void
	emergency(eventKind: string): void
	dispose(): Promise<DiagnosticsStatus>
}
const RECORD_BYTES = 64_000
const BUFFER_BYTES = 1_000_000
const RUN_BYTES = 1_000_000
const RECORDS = 256
const FLUSH_MS = 500
const SERIALIZATION_BYTES = RECORD_BYTES * 8
const ENTRY_BYTES = 256
const formatter = getJsonLinesFormatter({ properties: "flatten" })

// Diagnostics carry paths, refs, commit subjects and codes agents need; only secret-shaped keys are redacted (at the
// sink, by redactByField) and environment values copied into a record are never strings of the caller's environment.
function identifier(value: string): string {
	return /^[a-z][a-z0-9.:_-]{0,127}$/.test(value) ? value : "redacted"
}

function serialize(record: LogRecord): { bytes: Buffer; truncated: boolean } {
	let bytes = Buffer.from(formatter(record))
	const truncated = bytes.length > RECORD_BYTES
	if (truncated) {
		// Remove the entire payload; slicing serialized JSON can expose a prefix or make invalid JSON.
		bytes = Buffer.from(formatter({ ...record, message: ["[TRUNCATED]"], properties: { runId: record.properties.runId, command: record.properties.command, sequence: record.properties.sequence, event_kind: record.properties.event_kind, truncated: true } }))
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

export function writeBytesSync(fd: number, bytes: Buffer): boolean {
	let offset = 0
	try {
		while (offset < bytes.length) {
			const remaining = bytes.length - offset
			const written = writeSync(fd, bytes, offset, remaining, null)
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
	constructor(private readonly file: DiagnosticFile) {}

	log(record: LogRecord): void {
		if (this.stopped || this.failure !== null) {
			if (this.frozen === null) this.dropped += 1
			return
		}
		if (this.queue.length + this.pending >= RECORDS) {
			this.drop()
			return
		}
		const encoded = serialize(record)
		const cost = encoded.bytes.length + ENTRY_BYTES
		if (this.retainedBytes + cost + SERIALIZATION_BYTES > BUFFER_BYTES || this.admittedBytes + encoded.bytes.length > RUN_BYTES) {
			this.drop()
			return
		}
		this.truncated += Number(encoded.truncated)
		this.queue.push(encoded.bytes)
		this.retainedBytes += cost
		this.admittedBytes += encoded.bytes.length
		if (this.timer === null)
			this.timer = setTimeout(() => {
				this.timer = null
				void this.flush()
			}, 0)
	}

	private drop(): void {
		this.failure ??= "capacity"
		this.dropped += 1
		this.stopped = true
	}

	private async drain(): Promise<void> {
		while (this.queue.length > 0 && this.frozen === null) {
			const bytes = this.queue.shift() as Buffer
			this.pending = 1
			try {
				await writeBytes(this.file.fd, bytes)
			} catch {
				if (this.frozen === null) {
					this.failure ??= "write"
					this.unflushed += 1 + this.queue.length
					this.queue.length = 0
				}
			} finally {
				this.pending = 0
				this.retainedBytes -= bytes.length + ENTRY_BYTES
			}
		}
	}

	private flush(): Promise<void> {
		this.draining ??= this.drain().finally(() => {
			this.draining = null
		})
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
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), FLUSH_MS)
			}),
		])
		clearTimeout(timer)
		if (!complete) {
			this.failure ??= "flush-timeout"
			this.unflushed += this.pending + this.queue.length
		} else this.close()
		this.queue.length = 0
		this.frozen = Object.freeze({ file: this.file.file, sinkFailure: this.failure, droppedRecords: this.dropped, unflushedRecords: this.unflushed, truncatedRecords: this.truncated, countsComplete: true, closed: this.closed })
		if (!complete)
			void this.flush().then(
				() => this.close(),
				() => this.close(),
			)
		return this.frozen
	}

	private close(): void {
		try {
			this.file.close()
			this.closed = true
		} catch {
			this.failure ??= "close"
		}
	}
}

async function finishLogTape(milliseconds: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	await Promise.race([
		dispose().catch(() => {}),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, milliseconds)
		}),
	])
	clearTimeout(timer)
}

let active: RunDiagnostics | null = null
// The signal handler uses the same idempotent, bounded finalization as normal exit.
export async function finishActiveDiagnostics(): Promise<void> {
	await active?.dispose()
}
// Crash handling gets one synchronous, bounded write to the already owned descriptor.
export function attemptEmergencyDiagnostics(): void {
	active?.emergency("process.crash")
}

export async function openRunDiagnostics(options: { runId: string; command: string; env: Record<string, string | undefined> }): Promise<RunDiagnostics> {
	const { runId, command, env } = options
	let sequence = 0
	let stationId: string | null = null
	let queue: BoundedQueue | null = null
	let failure: string | null = null
	let configured = false
	const logger = getLogger([...CATEGORY])
	let finished: Promise<DiagnosticsStatus> | null = null
	const started = performance.now()
	const opened: RunDiagnostics = {
		log(eventKind, properties = {}) {
			if (!configured || finished !== null) return
			sequence += 1
			try {
				const event = identifier(eventKind)
				logger.info(`${identifier(command)}: ${event}`, { runId, command: identifier(command), sequence, event_kind: event, station_id: stationId, duration_ms: performance.now() - started, ...properties })
			} catch {
				if (queue !== null) {
					queue.failure ??= "write"
					queue.dropped += 1
				}
			}
		},
		setStation(id) {
			stationId = id
		},
		emergency(eventKind) {
			if (queue === null || finished !== null) return
			sequence += 1
			const event = identifier(eventKind)
			queue.emergency(Buffer.from(`${JSON.stringify({ runId, command: identifier(command), sequence, event_kind: event, emergency: true })}\n`))
		},
		dispose() {
			finished ??= finalize()
			return finished
		},
	}
	async function finalize(): Promise<DiagnosticsStatus> {
		const deadline = performance.now() + FLUSH_MS
		const status = queue === null ? { file: null, sinkFailure: failure, droppedRecords: null, unflushedRecords: null, truncatedRecords: null, countsComplete: null, closed: null } : await queue.finish()
		if (configured) await finishLogTape(Math.max(0, deadline - performance.now()))
		if (active === opened) active = null
		return Object.freeze({ ...status, sinkFailure: failure ?? status.sinkFailure })
	}
	try {
		queue = new BoundedQueue(openDiagnosticFile(env, runId))
		active = opened
		const owned = queue
		const file: Sink = redactByField((record) => owned.log(record), { fieldPatterns: [SECRET_KEY_PATTERN], action: () => REDACTED })
		const meta: Sink = (record) => {
			if (["warning", "error", "fatal"].includes(record.level)) owned.failure ??= "write"
		}
		await configure({ sinks: { file, meta }, loggers: [{ category: [...CATEGORY], sinks: ["file"], lowestLevel: "debug" }, { category: ["logtape", "meta"], sinks: ["meta"], lowestLevel: "debug" }], contextLocalStorage: new AsyncLocalStorage(), reset: true })
		configured = true
	} catch (error) {
		failure = queue?.failure ?? (error instanceof Error && error.message === "capacity" ? "capacity" : "setup")
	}
	return opened
}
