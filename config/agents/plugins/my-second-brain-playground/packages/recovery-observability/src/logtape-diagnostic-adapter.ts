import { AsyncLocalStorage } from "node:async_hooks"
import { configureSync, getConfig, getLogger, withConfigSync, type LogLevel, type LogRecord, type Sink } from "@logtape/logtape"
import { redactByField } from "@logtape/redaction"
import type { TraceAcceptResult } from "./invocation-trace-store.ts"
import { diagnosticEvents, diagnosticLevels, type DiagnosticEvent, projectDiagnosticProperties, validateDiagnosticTraceRecord, validateLifecycleRecord } from "./serialized-values.ts"

const RECOVERY_LOG_CATEGORY = ["my-second-brain-playground", "recovery"] as const
const DIAGNOSTIC_BUFFER_LIMIT = 250

const sensitiveFieldPatterns = [
	/api[-_]?key/i,
	/authorization/i,
	/cookie/i,
	/credential/i,
	/passcode|passphrase|password/i,
	/private[-_]?key/i,
	/secret/i,
	/token/i,
]

export type DiagnosticMode = "quiet" | "default" | "verbose" | "debug"
export type { DiagnosticEvent } from "./serialized-values.ts"

export interface DiagnosticInput {
	readonly level: LogLevel
	readonly event: DiagnosticEvent
	readonly timestamp?: number
	readonly properties?: Readonly<Record<string, unknown>>
}

export interface RecoveryDiagnosticAdapter {
	accept(input: unknown): TraceAcceptResult
	diagnostic(input: DiagnosticInput): void
	flush(): void
	dispose(): void
}

function diagnosticRecord(input: DiagnosticInput): LogRecord {
	return {
		category: RECOVERY_LOG_CATEGORY,
		level: input.level,
		message: [input.event],
		rawMessage: input.event,
		timestamp: input.timestamp ?? Date.now(),
		properties: { ...projectDiagnosticProperties(input.properties ?? {}) },
	}
}

function severity(level: LogLevel): number {
	return diagnosticLevels.indexOf(level)
}

export function createRecoveryDiagnosticAdapter(options: {
	readonly writeDiagnostic: (line: string) => void
	readonly retainLifecycle: (record: unknown) => TraceAcceptResult
	readonly disposeOutput?: () => void
	readonly mode?: DiagnosticMode | undefined
	readonly knownSecretValues?: readonly string[] | undefined
}): RecoveryDiagnosticAdapter {
	const mode = options.mode ?? "default"
	const secrets = options.knownSecretValues ?? []
	let disposed = false
	let triggered = false
	let dropped = 0
	let buffer: LogRecord[] = []
	let lifecycleResult: TraceAcceptResult = { accepted: false, refusal: "storage-unavailable" }

	const rawDiagnosticSink: Sink = (record) => {
		try {
			const diagnostic = {
				schema_version: 1,
				record_type: "diagnostic",
				category: record.category.join("/"),
				level: record.level,
				event: record.rawMessage,
				occurred_at: new Date(record.timestamp).toISOString(),
				properties: record.properties,
			}
			if (!validateDiagnosticTraceRecord(diagnostic, { knownSecretValues: secrets })) return
			options.writeDiagnostic(`${JSON.stringify(diagnostic)}\n`)
		} catch {
			// Diagnostic failure is contained at the consumer-owned seam.
		}
	}
	const diagnosticSink = redactByField(rawDiagnosticSink, {
		fieldPatterns: sensitiveFieldPatterns,
		action: () => "[REDACTED]",
	}) as Sink

	const rawLifecycleSink: Sink = (record) => {
		try {
			lifecycleResult = options.retainLifecycle(record.properties.lifecycle_record)
		} catch {
			lifecycleResult = { accepted: false, refusal: "storage-unavailable" }
			// Retention failure is contained at the consumer-owned seam.
		}
	}
	const lifecycleSink = redactByField(rawLifecycleSink, {
		fieldPatterns: sensitiveFieldPatterns,
		action: () => "[REDACTED]",
	}) as Sink

	function emit(record: LogRecord): void {
		if (disposed) return
		try {
			diagnosticSink(record)
		} catch {
			// A decorated sink remains best effort even if its implementation changes.
		}
	}

	function truncationRecord(timestamp: number): LogRecord {
		return diagnosticRecord(
			{ level: "warning", event: "buffer-truncated", timestamp, properties: { dropped_records: dropped } },
		)
	}

	function emitBuffer(timestamp = Date.now()): void {
		if (dropped > 0) emit(truncationRecord(timestamp))
		for (const record of buffer) emit(record)
		buffer = []
		dropped = 0
	}

	const bufferingSink: Sink = (record) => {
		if (mode === "quiet") return
		if (mode === "debug" || (mode === "verbose" && severity(record.level) >= severity("info")) || triggered) {
			emit(record)
			return
		}
		if (severity(record.level) >= severity("error")) {
			triggered = true
			emitBuffer(record.timestamp)
			emit(record)
			return
		}
		buffer.push(record)
		if (buffer.length > DIAGNOSTIC_BUFFER_LIMIT) {
			buffer.shift()
			dropped += 1
		}
	}

	function logDiagnostic(record: LogRecord): void {
		try {
			// Initialize only an unconfigured process; never reset another logger owner.
			if (getConfig() === null) {
				configureSync({
					sinks: {},
					loggers: [{ category: ["logtape", "meta"], lowestLevel: null }],
					contextLocalStorage: new AsyncLocalStorage(),
				})
			}
			withConfigSync({
				sinks: { recovery: bufferingSink },
				loggers: [{ category: [...RECOVERY_LOG_CATEGORY], sinks: ["recovery"], lowestLevel: "trace", parentSinks: "override" }],
			}, () => getLogger(RECOVERY_LOG_CATEGORY).emit(record))
		} catch {
			// Logging setup and routing cannot change the recovery command outcome.
		}
	}

	return {
		accept(input: unknown): TraceAcceptResult {
			if (disposed) return { accepted: false, refusal: "storage-unavailable" }
			const validated = validateLifecycleRecord(input, { knownSecretValues: secrets })
			if (!validated.accepted) return validated
			try {
				lifecycleResult = { accepted: false, refusal: "storage-unavailable" }
				lifecycleSink({
					category: RECOVERY_LOG_CATEGORY,
					level: validated.record.outcome === "failed" ? "error" : "info",
					message: [validated.record.phase],
					rawMessage: validated.record.phase,
					timestamp: Date.parse(validated.record.occurred_at),
					properties: { lifecycle_record: validated.record },
				})
				return lifecycleResult
			} catch {
				return { accepted: false, refusal: "storage-unavailable" }
			}
		},
		diagnostic(input: DiagnosticInput) {
			if (disposed || !diagnosticEvents.includes(input.event) || !diagnosticLevels.includes(input.level)) return
			logDiagnostic(diagnosticRecord(input))
		},
		flush() {
			if (disposed) return
			emitBuffer()
		},
		dispose() {
			if (disposed) return
			disposed = true
			buffer = []
			dropped = 0
			try {
				options.disposeOutput?.()
			} catch {
				// Disposal is best effort and idempotent.
			}
		},
	}
}
