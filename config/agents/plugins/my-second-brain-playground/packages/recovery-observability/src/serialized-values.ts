export const MAX_SERIALIZED_RECORD_BYTES = 4 * 1024
const TRACE_SCHEMA_VERSION = 1 as const

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/
const pluginVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const sha256Pattern = /^[a-f0-9]{64}$/
const encoder = new TextEncoder()

const harnessKinds = ["codex", "claude-code", "command", "unknown"] as const
const operations = ["hook", "bind", "recover", "write", "schema", "help", "usage", "cleanup"] as const
const phases = [
	"invocation",
	"validation",
	"checkpoint-read",
	"checkpoint-write",
	"lock",
	"response-available",
	"cleanup",
	"terminal",
] as const
const outcomes = [
	"started",
	"accepted",
	"succeeded",
	"refused",
	"busy",
	"conflict",
	"unavailable",
	"uncertain",
	"failed",
	"cancelled",
	"signalled",
	"deadline-exceeded",
] as const
const refusalCodes = [
	"CHECKPOINT_BUSY",
	"CHECKPOINT_OWNERSHIP_CONFLICT",
	"CHECKPOINT_WRITE_FAILED",
	"CHECKPOINT_WRITE_UNCERTAIN",
	"INVALID_CHECKPOINT",
	"INVALID_USAGE",
	"RECOVERY_CONTEXT_UNAVAILABLE",
	"STORAGE_UNAVAILABLE",
	"TRACE_RECORD_INVALID",
	"TRACE_RECORD_OVERSIZED",
] as const
export const diagnosticEvents = ["buffer-truncated", "cleanup-failure", "observer-failure", "storage-unavailable"] as const
export const diagnosticLevels = ["trace", "debug", "info", "warning", "error", "fatal"] as const
export type DiagnosticEvent = (typeof diagnosticEvents)[number]
export type DiagnosticLevel = (typeof diagnosticLevels)[number]

const workerIdentitySources = ["hook-payload", "supervisor"] as const

export type HarnessKind = (typeof harnessKinds)[number]
export type RecoveryOperation = (typeof operations)[number]
export type RecoveryPhase = (typeof phases)[number]
export type RecoveryOutcome = (typeof outcomes)[number]
export type RecoveryRefusalCode = (typeof refusalCodes)[number]
export type WorkerIdentitySource = (typeof workerIdentitySources)[number]

export interface SourceEvidence {
	recovery_source_sha256?: string
	observer_source_sha256?: string
}

export interface InstallEvidence {
	plugin_version?: string
	runtime_sha256?: string
}

export interface LifecycleRecord {
	readonly schema_version: 1
	readonly record_type: "lifecycle"
	readonly record_identity: string
	readonly journey_identity: string
	readonly invocation_identity: string
	readonly producer_identity: string
	readonly producer_sequence: number
	readonly parent_record_identity?: string
	readonly observed_worker_identity?: string
	readonly observed_worker_identity_source?: WorkerIdentitySource
	readonly inherited_parent_identity?: string
	readonly ledger_task_identity?: string
	readonly harness_kind: HarnessKind
	readonly operation: RecoveryOperation
	readonly phase: RecoveryPhase
	readonly occurred_at: string
	readonly duration_ms?: number
	readonly outcome: RecoveryOutcome
	readonly refusal_code?: RecoveryRefusalCode
	readonly source_evidence?: Readonly<SourceEvidence>
	readonly install_evidence?: Readonly<InstallEvidence>
}

export interface DiagnosticProperties {
	readonly dropped_records?: number
}

export interface DiagnosticTraceRecord {
	readonly schema_version: 1
	readonly record_type: "diagnostic"
	readonly category: "my-second-brain-playground/recovery"
	readonly level: DiagnosticLevel
	readonly event: DiagnosticEvent
	readonly occurred_at: string
	readonly properties: Readonly<DiagnosticProperties>
}

export type StoredTraceRecord = LifecycleRecord | DiagnosticTraceRecord

export type LifecycleValidationRefusal =
	| "invalid-record"
	| "unknown-field"
	| "invalid-value"
	| "known-secret"
	| "oversized-record"

export type LifecycleValidationResult =
	| { readonly accepted: true; readonly record: LifecycleRecord; readonly serialized: string }
	| { readonly accepted: false; readonly refusal: LifecycleValidationRefusal }

const recordKeys = new Set([
	"schema_version",
	"record_type",
	"record_identity",
	"journey_identity",
	"invocation_identity",
	"producer_identity",
	"producer_sequence",
	"parent_record_identity",
	"observed_worker_identity",
	"observed_worker_identity_source",
	"inherited_parent_identity",
	"ledger_task_identity",
	"harness_kind",
	"operation",
	"phase",
	"occurred_at",
	"duration_ms",
	"outcome",
	"refusal_code",
	"source_evidence",
	"install_evidence",
])
const sourceEvidenceKeys = new Set(["recovery_source_sha256", "observer_source_sha256"])
const installEvidenceKeys = new Set(["plugin_version", "runtime_sha256"])
const diagnosticPropertyKeys = new Set(["dropped_records"])
const diagnosticKeys = new Set(["schema_version", "record_type", "category", "level", "event", "occurred_at", "properties"])

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key))
}

function isMember<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
	return typeof value === "string" && values.includes(value)
}

export function isRecoveryIdentity(value: unknown): value is string {
	return typeof value === "string" && identityPattern.test(value)
}

export function isPluginVersion(value: unknown): value is string {
	return typeof value === "string" && value.length <= 128 && pluginVersionPattern.exec(value)?.[0] === value
}

function validIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false
	const timestamp = Date.parse(value)
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function validSourceEvidence(value: unknown): value is SourceEvidence {
	if (!isObject(value) || !hasOnlyKeys(value, sourceEvidenceKeys) || Object.keys(value).length === 0) return false
	return [value.recovery_source_sha256, value.observer_source_sha256].every(
		(item) => item === undefined || (typeof item === "string" && sha256Pattern.test(item)),
	)
}

function validInstallEvidence(value: unknown): value is InstallEvidence {
	if (!isObject(value) || !hasOnlyKeys(value, installEvidenceKeys) || Object.keys(value).length === 0) return false
	if (value.runtime_sha256 !== undefined && (typeof value.runtime_sha256 !== "string" || !sha256Pattern.test(value.runtime_sha256))) {
		return false
	}
	return value.plugin_version === undefined || isPluginVersion(value.plugin_version)
}

function containsKnownSecret(value: unknown, secrets: readonly string[]): boolean {
	if (typeof value === "string") return secrets.some((secret) => secret.length > 0 && value.includes(secret))
	if (!isObject(value)) return false
	return Object.values(value).some((nested) => containsKnownSecret(nested, secrets))
}

function freezeRecord(record: LifecycleRecord): LifecycleRecord {
	if (record.source_evidence) Object.freeze(record.source_evidence)
	if (record.install_evidence) Object.freeze(record.install_evidence)
	return Object.freeze(record)
}

function projectRecord(input: Record<string, unknown>): LifecycleRecord {
	return {
		schema_version: 1,
		record_type: "lifecycle",
		record_identity: input.record_identity as string,
		journey_identity: input.journey_identity as string,
		invocation_identity: input.invocation_identity as string,
		producer_identity: input.producer_identity as string,
		producer_sequence: input.producer_sequence as number,
		...(input.parent_record_identity === undefined ? {} : { parent_record_identity: input.parent_record_identity as string }),
		...(input.observed_worker_identity === undefined ? {} : { observed_worker_identity: input.observed_worker_identity as string }),
		...(input.observed_worker_identity_source === undefined
			? {}
			: { observed_worker_identity_source: input.observed_worker_identity_source as WorkerIdentitySource }),
		...(input.inherited_parent_identity === undefined ? {} : { inherited_parent_identity: input.inherited_parent_identity as string }),
		...(input.ledger_task_identity === undefined ? {} : { ledger_task_identity: input.ledger_task_identity as string }),
		harness_kind: input.harness_kind as HarnessKind,
		operation: input.operation as RecoveryOperation,
		phase: input.phase as RecoveryPhase,
		occurred_at: input.occurred_at as string,
		...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms as number }),
		outcome: input.outcome as RecoveryOutcome,
		...(input.refusal_code === undefined ? {} : { refusal_code: input.refusal_code as RecoveryRefusalCode }),
		...(input.source_evidence === undefined ? {} : { source_evidence: { ...(input.source_evidence as SourceEvidence) } }),
		...(input.install_evidence === undefined ? {} : { install_evidence: { ...(input.install_evidence as InstallEvidence) } }),
	}
}

function validLifecycleIdentities(input: Record<string, unknown>): boolean {
	const required = [input.record_identity, input.journey_identity, input.invocation_identity, input.producer_identity]
	if (!required.every(isRecoveryIdentity)) return false
	const optional = [input.parent_record_identity, input.observed_worker_identity, input.inherited_parent_identity, input.ledger_task_identity]
	if (optional.some((value) => value !== undefined && !isRecoveryIdentity(value))) return false
	const workerIdentityPair = input.observed_worker_identity === undefined === (input.observed_worker_identity_source === undefined)
	return workerIdentityPair && (
		input.observed_worker_identity_source === undefined ||
		isMember(workerIdentitySources, input.observed_worker_identity_source)
	)
}

function validLifecycleNumbers(input: Record<string, unknown>): boolean {
	if (!Number.isSafeInteger(input.producer_sequence) || (input.producer_sequence as number) < 0) return false
	return input.duration_ms === undefined || (
		typeof input.duration_ms === "number" &&
		Number.isFinite(input.duration_ms) &&
		input.duration_ms >= 0
	)
}

function validLifecycleKinds(input: Record<string, unknown>): boolean {
	return (
		isMember(harnessKinds, input.harness_kind) &&
		isMember(operations, input.operation) &&
		isMember(phases, input.phase) &&
		validIsoTimestamp(input.occurred_at) &&
		isMember(outcomes, input.outcome)
	)
}

function validLifecycleOutcome(input: Record<string, unknown>): boolean {
	const refusalPair = input.outcome === "refused" ? input.refusal_code !== undefined : input.refusal_code === undefined
	return refusalPair && (input.refusal_code === undefined || isMember(refusalCodes, input.refusal_code))
}

function validLifecycleEvidence(input: Record<string, unknown>): boolean {
	return (
		(input.source_evidence === undefined || validSourceEvidence(input.source_evidence)) &&
		(input.install_evidence === undefined || validInstallEvidence(input.install_evidence))
	)
}

function validLifecycleValues(input: Record<string, unknown>): boolean {
	return (
		input.schema_version === TRACE_SCHEMA_VERSION &&
		input.record_type === "lifecycle" &&
		validLifecycleIdentities(input) &&
		validLifecycleNumbers(input) &&
		validLifecycleKinds(input) &&
		validLifecycleOutcome(input) &&
		validLifecycleEvidence(input)
	)
}

export function validateLifecycleRecord(
	input: unknown,
	options: { readonly knownSecretValues?: readonly string[] } = {},
): LifecycleValidationResult {
	if (!isObject(input)) return { accepted: false, refusal: "invalid-record" }
	if (!hasOnlyKeys(input, recordKeys)) return { accepted: false, refusal: "unknown-field" }
	if (!validLifecycleValues(input)) {
		return { accepted: false, refusal: "invalid-value" }
	}
	if (containsKnownSecret(input, options.knownSecretValues ?? [])) {
		return { accepted: false, refusal: "known-secret" }
	}
	const projected = projectRecord(input)
	let serialized: string
	try {
		serialized = JSON.stringify(projected)
	} catch {
		return { accepted: false, refusal: "invalid-record" }
	}
	if (encoder.encode(`${serialized}\n`).byteLength > MAX_SERIALIZED_RECORD_BYTES) {
		return { accepted: false, refusal: "oversized-record" }
	}
	return { accepted: true, record: freezeRecord(projected), serialized }
}

function validDiagnosticCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function projectDiagnosticProperties(input: Readonly<Record<string, unknown>>): DiagnosticProperties {
	return validDiagnosticCounter(input.dropped_records) ? { dropped_records: input.dropped_records } : {}
}

export function validateDiagnosticTraceRecord(
	input: unknown,
	options: { readonly knownSecretValues?: readonly string[] } = {},
): input is DiagnosticTraceRecord {
	if (!isObject(input) || !hasOnlyKeys(input, diagnosticKeys)) return false
	if (
		input.schema_version !== 1 ||
		input.record_type !== "diagnostic" ||
		input.category !== "my-second-brain-playground/recovery" ||
		!isMember(diagnosticLevels, input.level) ||
		!isMember(diagnosticEvents, input.event) ||
		!validIsoTimestamp(input.occurred_at) ||
		!isObject(input.properties) ||
		!hasOnlyKeys(input.properties, diagnosticPropertyKeys) ||
		!Object.values(input.properties).every(validDiagnosticCounter)
	) {
		return false
	}
	try {
		const serialized = `${JSON.stringify(input)}\n`
		if ((options.knownSecretValues ?? []).some((secret) => secret.length > 0 && serialized.includes(secret))) return false
		return encoder.encode(serialized).byteLength <= MAX_SERIALIZED_RECORD_BYTES
	} catch {
		return false
	}
}
