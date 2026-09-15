import { AsyncLocalStorage } from "node:async_hooks"
import { chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs"
import { join } from "node:path"
import { getFileSink } from "@logtape/file"
import { configure, dispose, getJsonLinesFormatter, getLogger, type LogRecord, type Sink } from "@logtape/logtape"
import { redactByField } from "@logtape/redaction"
import { REDACTED, SECRET_KEY_PATTERN } from "./engine.ts"

// Diagnostics isolated from truth (CDS-PE-2; brief 12, section 8.2): per-run JSON Lines at <root>/diagnostics/<runIdentity>.jsonl,
// 0700 directory and 0600 file, an owned bounded non-blocking queue in front of a redacted file sink, a captured meta sink,
// and a final status the envelope reports as result.diagnostics. Nothing in this path can throw into the command.

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
	dispose(): Promise<DiagnosticsStatus>
}

export type DiagnosticsFault = "sink-throw" | "sink-dispose-throw" | "diagnostics-flood" | null

const QUEUE_CAP = 256

function classify(error: unknown): string {
	if (error instanceof Error) return error.name === "Error" ? error.message.slice(0, 60) || "Error" : error.name
	return typeof error
}

class BoundedQueue {
	private readonly queue: LogRecord[] = []
	private timer: ReturnType<typeof setTimeout> | null = null
	dropped = 0
	unflushed = 0
	truncated = 0
	failure: string | null = null
	closed = false
	constructor(private readonly inner: Sink) {}

	log(record: LogRecord): void {
		if (this.failure !== null) {
			this.unflushed += 1
			return
		}
		if (this.queue.length >= QUEUE_CAP) {
			this.dropped += 1
			return
		}
		this.queue.push(record)
		if (this.timer === null) this.timer = setTimeout(() => this.flush(), 0)
	}

	flush(): void {
		this.timer = null
		while (this.queue.length > 0) {
			const record = this.queue.shift() as LogRecord
			try {
				this.inner(record)
				} catch (error) {
					this.failure = `flush: ${classify(error)}`
					this.unflushed += 1 + this.queue.length
					this.queue.length = 0
				return
			}
		}
	}

	async dispose(): Promise<void> {
		if (this.timer !== null) clearTimeout(this.timer)
		this.flush()
		try {
			const disposable = this.inner as Sink & { [Symbol.dispose]?: () => void }
			disposable[Symbol.dispose]?.()
			this.closed = true
		} catch (error) {
			if (this.failure === null) this.failure = `dispose: ${classify(error)}`
		}
	}
}

function openDiagnosticsFile(root: string, runIdentity: string): string {
	const directory = join(root, "diagnostics")
	try {
		const existing = lstatSync(directory)
		if (!existing.isDirectory()) throw new Error("diagnostics path is not a directory")
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error
		mkdirSync(directory, { mode: 0o700 })
	}
	// 0700 is unconditional (CDS-PE-2; PR 184, thread 4003813536): a reused real directory is corrected before the run
	// file opens, not only one created by this invocation.
	if ((statSync(directory).mode & 0o777) !== 0o700) chmodSync(directory, 0o700)
	const file = join(directory, `${runIdentity}.jsonl`)
	const fd = openSync(file, "wx", 0o600)
	try {
		if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
	} finally {
		closeSync(fd)
	}
	if (lstatSync(file).isSymbolicLink()) throw new Error("diagnostics file is a symlink")
	return file
}

export async function openRunDiagnostics(options: { runIdentity: string; command: string; root: string; fault: DiagnosticsFault }): Promise<RunDiagnostics> {
	const { runIdentity, command, root, fault } = options
	let sequence = 0
	let stationId: string | null = null
	let queue: BoundedQueue | null = null
	let status: string | null = null
	let configured = false
	let verifiedFile: string | null = null

	try {
		const file = openDiagnosticsFile(root, runIdentity)
		verifiedFile = file
		const fileSink = getFileSink(file, { formatter: getJsonLinesFormatter({ properties: "flatten" }), bufferSize: 0 })
		const faulty: Sink = (record) => {
			if (fault === "sink-throw") throw new Error("injected sink failure")
			fileSink(record)
		}
		const disposing = Object.assign(faulty, {
			[Symbol.dispose]: () => {
				if (fault === "sink-dispose-throw") throw new Error("injected dispose failure")
				;(fileSink as Sink & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
			},
		})
		const redacted = redactByField(disposing, { fieldPatterns: [SECRET_KEY_PATTERN], action: () => REDACTED })
		queue = new BoundedQueue(redacted)
		const owned = queue
		const metaCapture: Sink = (record) => {
			if (status === null && (record.level === "warning" || record.level === "error" || record.level === "fatal")) status = `meta: ${String(record.message.map(String).join("")).slice(0, 80)}`
		}
		try {
			await configure({
				sinks: { file: (record) => owned.log(record), meta: metaCapture },
				loggers: [
					{ category: ["repair-lab"], sinks: ["file"], lowestLevel: "debug" },
					{ category: ["logtape", "meta"], sinks: ["meta"], lowestLevel: "debug" },
				],
				contextLocalStorage: new AsyncLocalStorage(),
				reset: true,
			})
			configured = true
		} catch (error) {
			status = `configure: ${classify(error)}`
		}
	} catch (error) {
		status = `open: ${classify(error)}`
	}

	const logger = getLogger(["repair-lab"])

	function log(eventKind: string, summary: string, properties: Record<string, unknown> = {}): void {
		sequence += 1
		const record = { runIdentity, command, sequence, event_id: `${runIdentity}:${sequence}`, event_kind: eventKind, station_id: stationId, summary, sensitive_fields_redacted: [] as string[], ...properties }
		if (!configured) return
		try {
			logger.info(summary, record)
		} catch (error) {
			if (status === null) status = `log: ${classify(error)}`
		}
	}

	if (fault === "diagnostics-flood") {
		for (let flood = 0; flood < QUEUE_CAP + 8; flood += 1) log("diagnostics.flood", `flood record ${flood}`)
	}

	return {
		log,
		setStation: (id) => {
			stationId = id
		},
		async dispose(): Promise<DiagnosticsStatus> {
			if (queue !== null) {
				queue.flush()
				if (queue.dropped > 0) {
					log("diagnostics.truncated", `${queue.dropped} records dropped at the bound`)
					queue.flush()
				}
				await queue.dispose()
			}
			try {
				if (configured) await dispose()
			} catch (error) {
				if (status === null) status = `logtape-dispose: ${classify(error)}`
			}
			const sinkFailure = status ?? queue?.failure ?? null
				return { file: verifiedFile, sinkFailure, droppedRecords: queue?.dropped ?? null, unflushedRecords: queue?.unflushed ?? null, truncatedRecords: queue?.truncated ?? null, countsComplete: queue === null ? null : true, closed: queue?.closed ?? null }
		},
	}
}
