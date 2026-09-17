import { AsyncLocalStorage } from "node:async_hooks"
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs"
import type { Stats } from "node:fs"
import { isAbsolute, join, sep } from "node:path"
import { configureSync, getConfig, getJsonLinesFormatter, getLogger, type LogLevel, type LogRecord, type ScopedConfig, type Sink, withConfigSync } from "@logtape/logtape"
import { redactByField } from "@logtape/redaction"

// Diagnostics Module: LogTape 2.3.1 records correlated by runIdentity, redacted at the sink by key pattern and by
// known value, written to one of two sinks. The private file sink (machine mode and `hook`) is a bounded 0600 JSON
// Lines file under the supplied private state root; the stderr sink (human mode) emits warning-level records only,
// so an ordinary run keeps Contract Core's one-line stderr rule. The root is supplied already selected and validated;
// this module never reads the environment, never substitutes another root, and never creates the root itself.
// Nothing here throws into the command; a failure is classified by stage and errno code, never by message.

export type DiagnosticsSink = "file" | "stderr"

export interface DiagnosticsContext {
	readonly runIdentity: string
	readonly commandIdentity: string
	/** The validated private state root. An unusable value is a contained open failure, never a fallback. */
	readonly stateHome: string
	/** Known secret values, or a provider read at every write so values learned later in the run are still redacted. */
	readonly knownSecretValues?: readonly string[] | (() => readonly string[]) | undefined
	readonly sink?: DiagnosticsSink | undefined
	/** The stderr writer for the stderr sink; production passes process.stderr.write. */
	readonly writeStderr?: ((line: string) => void) | undefined
}

export interface DiagnosticsStatus {
	readonly file: string | null
	readonly written: number
	readonly dropped: number
	readonly refused: number
	readonly failure: string | null
	readonly closed: boolean
}

export interface Diagnostics {
	log(eventKind: string, properties?: Readonly<Record<string, unknown>>): void
	setStation(stationId: string): void
	flush(): void
	dispose(): DiagnosticsStatus
}

const LOG_CATEGORY = ["msb-workflow"] as const
const META_CATEGORY = ["logtape", "meta"] as const
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i
const REDACTED = "[REDACTED]"
const MAX_RECORD_BYTES = 4096
const MAX_RECORDS_PER_RUN = 512
const MAX_RETAINED_RUN_FILES = 64
const MAX_REDACTION_DEPTH = 20
const LEVELS: readonly LogLevel[] = ["debug", "info", "warning", "error"]
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { trace: 0, debug: 1, info: 2, warning: 3, error: 4, fatal: 5 }
// Identity keys plus the keys the flattened JSON Lines formatter owns: a caller value there would overwrite the record.
const RESERVED_KEYS: readonly string[] = ["runIdentity", "commandIdentity", "sequence", "eventKind", "level", "message", "logger", "@timestamp"]
const CORRELATION_KEYS = ["stationId", "beadId", "generation"] as const

type SinkOutcome = "none" | "written" | "oversized" | "unserializable" | "failed"

const encoder = new TextEncoder()
const formatLine = getJsonLinesFormatter({ properties: "flatten" })

function isIdentity(value: unknown): value is string {
	return typeof value === "string" && IDENTITY_PATTERN.test(value)
}

function isLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && LEVELS.includes(value as LogLevel)
}

function codedError(code: string): Error {
	return Object.assign(new Error(code), { code })
}

function classify(stage: string, error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code
	if (typeof code === "string" && code.length > 0) return `${stage}: ${code}`
	return `${stage}: ${error instanceof Error ? error.name : "UNKNOWN"}`
}

const DIAGNOSTICS_SEGMENTS = ["my-second-brain-playground", "workflow-cli", "diagnostics"] as const

function isOwned(stat: Stats): boolean {
	return typeof process.geteuid !== "function" || stat.uid === process.geteuid()
}

/** A real directory the effective user owns, or null when the path is absent; any other entry is a coded refusal. */
function ownedDirectory(path: string): Stats | null {
	let existing: Stats
	try {
		existing = lstatSync(path)
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null
		throw error
	}
	if (existing.isSymbolicLink()) throw codedError("ELOOP")
	if (!existing.isDirectory()) throw codedError("ENOTDIR")
	if (!isOwned(existing)) throw codedError("EOWNER")
	return existing
}

// The root must already be a real, owned directory; it is never created, corrected or replaced (its mode is the
// operator's: a shared XDG state home is commonly 0755). Each descendant is validated before the next is entered and
// created 0700 when absent. A pre-existing descendant with a broader mode is refused, never corrected: the Runtime
// Module refuses the same ancestor for the binding write, and a directory the helper did not create 0700 may be
// shared with another owner (the Python owner's schema-v2 state lives under the same first segment).
function ensureDirectory(stateHome: string): string {
	if (stateHome.length === 0 || !isAbsolute(stateHome)) throw codedError("ROOT_UNSAFE")
	let root: Stats | null
	try {
		root = ownedDirectory(stateHome)
	} catch {
		throw codedError("ROOT_UNSAFE")
	}
	if (root === null) throw codedError("ROOT_UNSAFE")
	let current = stateHome
	for (const segment of DIAGNOSTICS_SEGMENTS) {
		current = `${current}${sep}${segment}`
		const existing = ownedDirectory(current)
		if (existing === null) mkdirSync(current, { mode: 0o700 })
		else if ((existing.mode & 0o777) !== 0o700) throw codedError("EMODE")
	}
	return current
}

function modifiedAt(path: string): number {
	try {
		return statSync(path).mtimeMs
	} catch {
		return 0
	}
}

// Retention is best effort: the newest run files win, and a pruning failure never becomes a diagnostics failure.
function pruneRunFiles(directory: string): void {
	let entries: Array<{ name: string; mtime: number }>
	try {
		entries = readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => ({ name, mtime: modifiedAt(join(directory, name)) }))
	} catch {
		return
	}
	entries.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name))
	const excess = entries.length - (MAX_RETAINED_RUN_FILES - 1)
	for (const entry of entries.slice(0, Math.max(0, excess))) {
		try {
			unlinkSync(join(directory, entry.name))
		} catch {
			// The next run retries pruning.
		}
	}
}

function openRunFile(stateHome: string, runIdentity: string): { file: string; fd: number } {
	const directory = ensureDirectory(stateHome)
	pruneRunFiles(directory)
	const file = join(directory, `${runIdentity}.jsonl`)
	const fd = openSync(file, "wx", 0o600)
	try {
		if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
	} catch (error) {
		closeSync(fd)
		throw error
	}
	return { file, fd }
}

function replaceSecrets(text: string, secrets: readonly string[]): string {
	let result = text
	for (const secret of secrets) result = result.replaceAll(secret, REDACTED)
	return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

// Known secret values are replaced before the key-based layer; an Error keeps only its name so no message or stack is
// recorded; a cycle or an over-deep value is refused rather than partially copied.
function redactKnownValues(value: unknown, secrets: readonly string[], ancestors: readonly object[]): unknown {
	if (typeof value === "string") return replaceSecrets(value, secrets)
	if (value instanceof Error) return { name: value.name }
	if (!Array.isArray(value) && !isPlainObject(value)) return value
	if (ancestors.includes(value) || ancestors.length >= MAX_REDACTION_DEPTH) throw codedError("UNSERIALIZABLE")
	const next = [...ancestors, value]
	if (Array.isArray(value)) return value.map((item) => redactKnownValues(item, secrets, next))
	const result: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) result[key] = redactKnownValues(item, secrets, next)
	return result
}

function ensureGlobalConfiguration(): void {
	// Initialize only an unconfigured process; never reset another owner's LogTape configuration.
	if (getConfig() !== null) return
	configureSync({
		sinks: {},
		loggers: [{ category: [...META_CATEGORY], lowestLevel: null }],
		contextLocalStorage: new AsyncLocalStorage(),
	})
}

function splitLevel(properties: Readonly<Record<string, unknown>>): { level: LogLevel; own: Record<string, unknown> } {
	const { level, ...own } = properties
	return { level: isLevel(level) ? level : "info", own }
}

/** Where a run's lines go: a private file descriptor, or the caller's stderr writer. */
interface LineTarget {
	readonly file: string | null
	readonly lowestLevel: LogLevel
	write(line: string): void
	flush(): void
	close(): void
}

function fileTarget(stateHome: string, runIdentity: string): LineTarget {
	const opened = openRunFile(stateHome, runIdentity)
	return {
		file: opened.file,
		lowestLevel: "debug",
		write: (line) => {
			writeSync(opened.fd, line)
		},
		flush: () => fsyncSync(opened.fd),
		close: () => {
			fsyncSync(opened.fd)
			closeSync(opened.fd)
		},
	}
}

function stderrTarget(write: (line: string) => void): LineTarget {
	return { file: null, lowestLevel: "warning", write, flush: () => undefined, close: () => undefined }
}

class DiagnosticsRun {
	private target: LineTarget | null = null
	private written = 0
	private dropped = 0
	private refused = 0
	private failure: string | null = null
	private sequence = 0
	private stationId: string | null = null
	private status: DiagnosticsStatus | null = null
	private outcome: SinkOutcome = "none"
	private readonly scopedConfig: ScopedConfig<"diagnostics" | "meta", string>

	constructor(
		private readonly runIdentity: string,
		private readonly commandIdentity: string,
		private readonly secrets: () => readonly string[],
	) {
		const redacting = redactByField((record) => this.write(record), { fieldPatterns: [SECRET_KEY_PATTERN], action: () => REDACTED }) as Sink
		const diagnostics: Sink = (record) => {
			try {
				const known = secrets()
				redacting({ ...record, message: redactKnownValues(record.message, known, []) as readonly unknown[], properties: redactKnownValues(record.properties, known, []) as Record<string, unknown> })
			} catch {
				this.outcome = "unserializable"
			}
		}
		const meta: Sink = (record) => {
			if (this.failure === null && typeof record.rawMessage === "string") this.failure = `meta: ${record.rawMessage.slice(0, 80)}`
		}
		this.scopedConfig = {
			sinks: { diagnostics, meta },
			loggers: [
				{ category: [...LOG_CATEGORY], sinks: ["diagnostics"], lowestLevel: "debug", parentSinks: "override" },
				{ category: [...META_CATEGORY], sinks: ["meta"], lowestLevel: "warning", parentSinks: "override" },
			],
		}
	}

	open(context: DiagnosticsContext): void {
		try {
			if (!isIdentity(this.runIdentity) || !isIdentity(this.commandIdentity)) throw codedError("IDENTITY_INVALID")
			this.target = context.sink === "stderr" ? stderrTarget(context.writeStderr ?? ((line) => process.stderr.write(line))) : fileTarget(context.stateHome, this.runIdentity)
		} catch (error) {
			this.fail("open", error)
		}
	}

	log(eventKind: string, properties: Readonly<Record<string, unknown>>): void {
		if (this.status !== null) return
		this.sequence += 1
		if (this.target === null || this.written >= MAX_RECORDS_PER_RUN) {
			this.dropped += 1
			return
		}
		if (!isIdentity(eventKind)) {
			this.refuse({ reason: "event-kind" })
			return
		}
		const { level, own } = splitLevel(properties)
		const outcome = this.emit(level, eventKind, own)
		if (outcome === "oversized" || outcome === "unserializable") this.refuse({ reason: outcome, refusedEventKind: eventKind })
		else if (outcome !== "written") this.dropped += 1
	}

	setStation(stationId: string): void {
		if (typeof stationId === "string" && stationId.length > 0) this.stationId = stationId
	}

	flush(): void {
		if (this.status !== null || this.target === null) return
		try {
			this.target.flush()
		} catch (error) {
			this.fail("flush", error)
		}
	}

	dispose(): DiagnosticsStatus {
		if (this.status !== null) return this.status
		let closed = true
		const file = this.target?.file ?? null
		if (this.target !== null) {
			if (this.dropped > 0) {
				this.sequence += 1
				this.emit("warning", "diagnostics.truncated", { droppedRecords: this.dropped })
			}
			try {
				this.target.close()
			} catch (error) {
				this.fail("dispose", error)
				closed = false
			}
			this.target = null
		}
		this.status = { file, written: this.written, dropped: this.dropped, refused: this.refused, failure: this.failure, closed }
		return this.status
	}

	private fail(stage: string, error: unknown): void {
		if (this.failure === null) this.failure = classify(stage, error)
	}

	private refuse(marker: Record<string, unknown>): void {
		this.refused += 1
		this.emit("warning", "diagnostics.refused", marker)
	}

	private correlate(eventKind: string, own: Record<string, unknown>): Record<string, unknown> {
		const properties: Record<string, unknown> = { runIdentity: this.runIdentity, commandIdentity: this.commandIdentity, sequence: this.sequence, eventKind }
		const stationId = typeof own.stationId === "string" && own.stationId.length > 0 ? own.stationId : this.stationId
		if (stationId !== null) properties.stationId = stationId
		for (const key of ["beadId", "generation"] as const) {
			const value = own[key]
			if ((typeof value === "string" && value.length > 0) || typeof value === "number") properties[key] = value
		}
		for (const [key, value] of Object.entries(own)) {
			if (!RESERVED_KEYS.includes(key) && !CORRELATION_KEYS.includes(key as (typeof CORRELATION_KEYS)[number])) properties[key] = value
		}
		return properties
	}

	// One scoped LogTape configuration per record keeps this run's sinks private to this run and leaves any other
	// LogTape owner in the process untouched; a routing or configuration failure is a classified drop.
	private emit(level: LogLevel, eventKind: string, own: Record<string, unknown>): SinkOutcome {
		const properties = this.correlate(eventKind, own)
		this.outcome = "none"
		try {
			ensureGlobalConfiguration()
			withConfigSync(this.scopedConfig, () => {
				getLogger(LOG_CATEGORY).emit({ level, message: [eventKind], rawMessage: eventKind, timestamp: Date.now(), properties })
			})
		} catch (error) {
			this.fail("log", error)
			this.outcome = "failed"
		}
		return this.outcome
	}

	private write(record: LogRecord): void {
		const target = this.target
		if (target === null) return
		// The stderr sink keeps ordinary runs quiet: a record below its level is accepted, not written, not dropped.
		if (LEVEL_RANK[record.level] < LEVEL_RANK[target.lowestLevel]) {
			this.outcome = "written"
			return
		}
		let line: string
		try {
			line = replaceSecrets(formatLine(record), this.secrets())
		} catch {
			this.outcome = "unserializable"
			return
		}
		if (encoder.encode(line).byteLength > MAX_RECORD_BYTES) {
			this.outcome = "oversized"
			return
		}
		try {
			target.write(line)
			this.written += 1
			this.outcome = "written"
		} catch (error) {
			this.fail("write", error)
			this.outcome = "failed"
		}
	}
}

function contained<T>(fallback: T, action: () => T): T {
	try {
		return action()
	} catch {
		return fallback
	}
}

export function openDiagnostics(context: DiagnosticsContext): Diagnostics {
	const provider = context.knownSecretValues
	const secrets = (): readonly string[] => (typeof provider === "function" ? provider() : (provider ?? [])).filter((secret) => typeof secret === "string" && secret.length > 0)
	const run = new DiagnosticsRun(context.runIdentity, context.commandIdentity, secrets)
	run.open(context)
	const disposedFallback: DiagnosticsStatus = { file: null, written: 0, dropped: 0, refused: 0, failure: "dispose: UNKNOWN", closed: false }
	return {
		log: (eventKind, properties = {}) => contained(undefined, () => run.log(eventKind, properties)),
		setStation: (stationId) => contained(undefined, () => run.setStation(stationId)),
		flush: () => contained(undefined, () => run.flush()),
		dispose: () => contained(disposedFallback, () => run.dispose()),
	}
}
