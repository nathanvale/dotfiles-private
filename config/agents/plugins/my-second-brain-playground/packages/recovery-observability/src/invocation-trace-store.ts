import { randomUUID } from "node:crypto"
import {
	appendFileSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	unlinkSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import {
	MAX_SERIALIZED_RECORD_BYTES,
	type StoredTraceRecord,
	type LifecycleRecord,
	type LifecycleValidationRefusal,
	validateDiagnosticTraceRecord,
	validateLifecycleRecord,
} from "./serialized-values.ts"

export const DEFAULT_TRACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_TRACE_MAX_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_QUERY_TRACE_ENTRIES = 10_000

export interface TraceFilter {
	readonly journey_identity?: string
	readonly invocation_identity?: string
	readonly observed_worker_identity?: string
	readonly ledger_task_identity?: string
}

export interface TraceAnomaly {
	readonly file: string
	readonly line?: number
	readonly code:
		| "duplicate-sequence"
		| "duplicate-delivery"
		| "record-identity-conflict"
		| "invalid-record"
		| "oversized-record"
		| "partial-final-line"
		| "sequence-gap"
		| "unknown-schema"
		| "unreadable-file"
	readonly producer_identity?: string
	readonly expected_sequence?: number
	readonly observed_sequence?: number
}

export interface TraceQueryResult {
	readonly available: boolean
	readonly trace_root: string | null
	readonly records: readonly StoredTraceRecord[]
	readonly anomalies: readonly TraceAnomaly[]
}

export interface TraceCleanupResult {
	readonly available: boolean
	readonly trace_root: string | null
	readonly scanned_files: number
	readonly removed_files: number
	readonly removed_bytes: number
	readonly retained_bytes: number
	readonly scan_truncated: boolean
}

export type TraceAcceptResult =
	| { readonly accepted: true; readonly record: LifecycleRecord }
	| { readonly accepted: false; readonly refusal: LifecycleValidationRefusal | "invocation-mismatch" | "storage-unavailable" }

export interface InvocationTraceStore {
	readonly path: string | null
	accept(input: unknown): TraceAcceptResult
	writeDiagnostic(line: string): boolean
	dispose(): void
}

function configuredStateHome(explicit?: string): string | null {
	const value = explicit ?? process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : "")
	return value && isAbsolute(value) ? resolve(value) : null
}

export function traceRoot(stateHome?: string): string | null {
	const root = configuredStateHome(stateHome)
	return root === null ? null : join(root, "my-second-brain-playground", "recovery-traces")
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) {
		try {
			mkdirSync(path, { mode: 0o700 })
		} catch {
			if (!existsSync(path)) throw new Error("trace directory unavailable")
		}
	}
	const stat = lstatSync(path)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe trace directory")
	chmodSync(path, 0o700)
}

function prepareTraceRoot(stateHome?: string): string {
	const stateRoot = configuredStateHome(stateHome)
	if (stateRoot === null) throw new Error("state home is unavailable")
	if (!existsSync(stateRoot)) mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
	const ownerRoot = join(stateRoot, "my-second-brain-playground")
	ensurePrivateDirectory(ownerRoot)
	const root = join(ownerRoot, "recovery-traces")
	ensurePrivateDirectory(root)
	return root
}

function safeFileName(invocationIdentity: string): string {
	const stem = invocationIdentity.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 96)
	return `${Date.now()}-${stem}-${randomUUID()}.jsonl`
}

export function createInvocationTraceStore(options: {
	readonly invocationIdentity: string
	readonly stateHome?: string
	readonly knownSecretValues?: readonly string[]
}): InvocationTraceStore {
	let descriptor: number | null = null
	let filePath: string | null = null
	let disposed = false
	try {
		const root = prepareTraceRoot(options.stateHome)
		filePath = join(root, safeFileName(options.invocationIdentity))
		descriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
		chmodSync(filePath, 0o600)
	} catch {
		if (descriptor !== null) closeSync(descriptor)
		descriptor = null
		filePath = null
	}

	return {
		get path() {
			return filePath
		},
		accept(input: unknown): TraceAcceptResult {
			if (disposed || descriptor === null) return { accepted: false, refusal: "storage-unavailable" }
			const validated = validateLifecycleRecord(input, { knownSecretValues: options.knownSecretValues })
			if (!validated.accepted) return validated
			if (validated.record.invocation_identity !== options.invocationIdentity) {
				return { accepted: false, refusal: "invocation-mismatch" }
			}
			try {
				if (fstatSync(descriptor).size + Buffer.byteLength(validated.serialized) + 1 > DEFAULT_TRACE_MAX_TOTAL_BYTES) {
					return { accepted: false, refusal: "storage-unavailable" }
				}
				appendFileSync(descriptor, `${validated.serialized}\n`, { encoding: "utf8" })
				return { accepted: true, record: validated.record }
			} catch {
				return { accepted: false, refusal: "storage-unavailable" }
			}
		},
		writeDiagnostic(line: string): boolean {
			if (disposed || descriptor === null || !line.endsWith("\n") || Buffer.byteLength(line) > MAX_SERIALIZED_RECORD_BYTES) return false
			try {
				const parsed: unknown = JSON.parse(line)
				if (!validateDiagnosticTraceRecord(parsed, { knownSecretValues: options.knownSecretValues })) return false
				const serialized = `${JSON.stringify(parsed)}\n`
				if (fstatSync(descriptor).size + Buffer.byteLength(serialized) > DEFAULT_TRACE_MAX_TOTAL_BYTES) return false
				appendFileSync(descriptor, serialized, { encoding: "utf8" })
				return true
			} catch {
				return false
			}
		},
		dispose() {
			if (disposed) return
			disposed = true
			if (descriptor !== null) {
				try {
					closeSync(descriptor)
				} catch {
					// Observability disposal cannot replace the primary operation result.
				}
				descriptor = null
			}
		},
	}
}

function admittedTraceFiles(root: string, maxEntries = Infinity): Array<{ name: string; path: string; mtimeMs: number; size: number }> {
	const files: Array<{ name: string; path: string; mtimeMs: number; size: number }> = []
	for (const name of readdirSync(root).sort().slice(0, maxEntries)) {
		if (!name.endsWith(".jsonl")) continue
		const path = join(root, name)
		try {
			const stat = lstatSync(path)
			if (stat.isFile() && !stat.isSymbolicLink()) files.push({ name, path, mtimeMs: stat.mtimeMs, size: stat.size })
		} catch {
			// A concurrent cleanup may remove an entry after readdir.
		}
	}
	return files
}

function matches(record: LifecycleRecord, filter: TraceFilter): boolean {
	return (
		(filter.journey_identity === undefined || record.journey_identity === filter.journey_identity) &&
		(filter.invocation_identity === undefined || record.invocation_identity === filter.invocation_identity) &&
		(filter.observed_worker_identity === undefined || record.observed_worker_identity === filter.observed_worker_identity) &&
		(filter.ledger_task_identity === undefined || record.ledger_task_identity === filter.ledger_task_identity)
	)
}

function stableRecord(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableRecord).join(",")}]`
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableRecord(item)}`).join(",")}}`
	}
	return JSON.stringify(value)
}

export function queryTraces(options: { readonly stateHome?: string; readonly filter?: TraceFilter } = {}): TraceQueryResult {
	const root = traceRoot(options.stateHome)
	if (root === null || !existsSync(root)) return { available: false, trace_root: root, records: [], anomalies: [] }
	try {
		const stat = lstatSync(root)
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { available: false, trace_root: root, records: [], anomalies: [] }
	} catch {
		return { available: false, trace_root: root, records: [], anomalies: [] }
	}
	const records: StoredTraceRecord[] = []
	const anomalies: TraceAnomaly[] = []
	const deliveries = new Map<string, string>()
	for (const file of admittedTraceFiles(root, MAX_QUERY_TRACE_ENTRIES)) {
		let content: Buffer
		try {
			if (file.size > DEFAULT_TRACE_MAX_TOTAL_BYTES) {
				anomalies.push({ file: file.name, code: "oversized-record" })
				continue
			}
			content = readFileSync(file.path)
		} catch {
			anomalies.push({ file: file.name, code: "unreadable-file" })
			continue
		}
		const complete = content.length === 0 || content[content.length - 1] === 0x0a
		const lines = content.toString("utf8").split("\n")
		if (complete) lines.pop()
		const sequences = new Map<string, number>()
		for (let index = 0; index < lines.length; index += 1) {
			const lineNumber = index + 1
			const line = lines[index] ?? ""
			if (!complete && index === lines.length - 1) {
				anomalies.push({ file: file.name, line: lineNumber, code: "partial-final-line" })
				continue
			}
			if (Buffer.byteLength(`${line}\n`) > MAX_SERIALIZED_RECORD_BYTES) {
				anomalies.push({ file: file.name, line: lineNumber, code: "oversized-record" })
				continue
			}
			let parsed: unknown
			try {
				parsed = JSON.parse(line)
			} catch {
				anomalies.push({ file: file.name, line: lineNumber, code: "invalid-record" })
				continue
			}
			if (typeof parsed === "object" && parsed !== null && (parsed as { schema_version?: unknown }).schema_version !== 1) {
				anomalies.push({ file: file.name, line: lineNumber, code: "unknown-schema" })
				continue
			}
			if (validateDiagnosticTraceRecord(parsed)) {
				if (Object.keys(options.filter ?? {}).length === 0) records.push(parsed)
				continue
			}
			const validated = validateLifecycleRecord(parsed)
			if (!validated.accepted) {
				anomalies.push({ file: file.name, line: lineNumber, code: "invalid-record" })
				continue
			}
			const record = validated.record
			const fingerprint = stableRecord(record)
			const delivered = deliveries.get(record.record_identity)
			if (delivered !== undefined) {
				anomalies.push({ file: file.name, line: lineNumber, code: delivered === fingerprint ? "duplicate-delivery" : "record-identity-conflict" })
				if (delivered === fingerprint) continue
			} else {
				deliveries.set(record.record_identity, fingerprint)
			}
			const previous = sequences.get(record.producer_identity)
			if (previous === undefined && record.producer_sequence !== 0) {
				anomalies.push({
					file: file.name,
					line: lineNumber,
					code: "sequence-gap",
					producer_identity: record.producer_identity,
					expected_sequence: 0,
					observed_sequence: record.producer_sequence,
				})
			} else if (previous !== undefined) {
				if (record.producer_sequence === previous) {
					anomalies.push({
						file: file.name,
						line: lineNumber,
						code: "duplicate-sequence",
						producer_identity: record.producer_identity,
						observed_sequence: record.producer_sequence,
					})
				} else if (record.producer_sequence !== previous + 1) {
					anomalies.push({
						file: file.name,
						line: lineNumber,
						code: "sequence-gap",
						producer_identity: record.producer_identity,
						expected_sequence: previous + 1,
						observed_sequence: record.producer_sequence,
					})
				}
			}
			sequences.set(record.producer_identity, record.producer_sequence)
			records.push(record)
		}
	}
	const selected = new Set(records.filter(record => record.record_type === "lifecycle" && matches(record, options.filter ?? {})))
	const ancestors = new Map<string, LifecycleRecord>()
	for (const record of records) {
		if (record.record_type === "lifecycle" && !ancestors.has(record.record_identity)) ancestors.set(record.record_identity, record)
	}
	for (const record of selected) {
		if (record.record_type !== "lifecycle") continue
		const parent = record.parent_record_identity === undefined ? undefined : ancestors.get(record.parent_record_identity)
		if (parent !== undefined) selected.add(parent)
	}
	const filtered = Object.keys(options.filter ?? {}).length === 0 ? records : records.filter(record => selected.has(record))
	return { available: true, trace_root: root, records: filtered, anomalies }
}

export function cleanupTraces(options: {
	readonly stateHome?: string
	readonly nowMs?: number
	readonly maxAgeMs?: number
	readonly maxTotalBytes?: number
} = {}): TraceCleanupResult {
	const root = traceRoot(options.stateHome)
	const unavailable = { available: false, trace_root: root, scanned_files: 0, removed_files: 0, removed_bytes: 0, retained_bytes: 0, scan_truncated: false }
	if (root === null || !existsSync(root)) return unavailable
	try {
		const stat = lstatSync(root)
		if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable
	} catch {
		return unavailable
	}
	const files = admittedTraceFiles(root)
	const nowMs = options.nowMs ?? Date.now()
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_TRACE_MAX_AGE_MS
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TRACE_MAX_TOTAL_BYTES
	let removedFiles = 0
	let removedBytes = 0
	let retained = files
		.filter((file) => {
			if (nowMs - file.mtimeMs <= maxAgeMs) return true
			try {
				unlinkSync(file.path)
				removedFiles += 1
				removedBytes += file.size
			} catch {
				return true
			}
			return false
		})
		.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
	let retainedBytes = retained.reduce((total, file) => total + file.size, 0)
	while (retainedBytes > maxTotalBytes && retained.length > 0) {
		const file = retained.shift()
		if (!file) break
		try {
			unlinkSync(file.path)
			removedFiles += 1
			removedBytes += file.size
			retainedBytes -= file.size
		} catch {
			// Best effort cleanup preserves the primary result on races or permission failures.
		}
	}
	return {
		available: true,
		trace_root: root,
		scanned_files: files.length,
		removed_files: removedFiles,
		removed_bytes: removedBytes,
		retained_bytes: retainedBytes,
		scan_truncated: false,
	}
}
