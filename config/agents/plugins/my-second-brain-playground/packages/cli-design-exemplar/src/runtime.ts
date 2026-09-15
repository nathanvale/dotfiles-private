import { createHash } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, sep } from "node:path"
import { acquireJournalLock } from "./journal-lock.ts"
import { parseResourceId } from "./command-contract.ts"
import { DOMAIN_FAULT_NAMES, type DomainFault, type EffectId, type EgressFault, type Faults, type JournalEntry, type JournalRecord, type JournalScan, type Preview, type Resource, type WriteFacts } from "./model.ts"

// Real node:fs effects only; fault injection lives here at the boundary it simulates (brief 12, section 6).
// Two adapters exist in practice: the real filesystem under a temp root (tests) and under the harness root.

export const RETRY_DELAY_MS = 25

// Journal revision 2 (O1 Candidate A, ticket freeze 2026-09-15): one strict LF-terminated JSON frame per line carrying
// the payload's byte length and SHA-256, and three finite bounds. A payload is one strict record; a framed line
// includes its LF; the scan bound is the most journal bytes any command reads. Nothing rotates or prunes the journal.
const JOURNAL_VERSION = 2
const JOURNAL_PAYLOAD_BOUND_BYTES = 64_000
const JOURNAL_LINE_BOUND_BYTES = 512_000
export const JOURNAL_SCAN_BOUND_BYTES = 10_000_000
const SHA256_HEX = /^[0-9a-f]{64}$/
const FRAME_KEYS = "journalVersion,payload,payloadBytes,payloadSha256"
const LF = 0x0a

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

export class RuntimeRefusal extends Error {
	constructor(
		readonly causeCode: "DOMAIN_INPUT_MISSING" | "DOMAIN_INPUT_MALFORMED" | "DOMAIN_INPUT_UNREADABLE" | "DOMAIN_PATH_ESCAPE" | "SCHEMA_STATE_INVALID" | "USAGE_INVALID_ARGUMENTS",
		message: string,
	) {
		super(message)
	}
}

export class TransientLock extends Error {}

export interface ReadResult<T> {
	value: T
	bytes: string
}

const NON_JSON_VARIANTS = new Set(["cycle", "depth65", "date", "undefined", "function", "bigint", "nan", "infinity"])
const SCHEMA_INVALID_VARIANTS = new Set(["non-string-message", "extra-key", "bad-enum", "both-guidance"])
const EFFECT_IDS: readonly EffectId[] = ["effect.update-index", "effect.write-journal", "effect.repair-cache"]

const READ_BACK_FAIL_PREFIX = "readback-fail:"

function isEffectId(value: string): value is EffectId {
	return (EFFECT_IDS as readonly string[]).includes(value)
}

// One token of the fault channel: a domain fault name, an effect-bound fault (halt-* or readback-fail) with its effect
// id, or null when it is neither.
function domainFaultOf(token: string): DomainFault | null {
	if ((DOMAIN_FAULT_NAMES as readonly string[]).includes(token)) return token as DomainFault
	// readback-fail binds the entire remainder after its prefix to one effect id; a known id followed by more syntax
	// is not that id, so it never truncates to an accepted fault.
	if (token.startsWith(READ_BACK_FAIL_PREFIX)) {
		const effectId = token.slice(READ_BACK_FAIL_PREFIX.length)
		return isEffectId(effectId) ? { kind: "readback-fail", effectId } : null
	}
	const [name, argument] = token.split(":", 2) as [string, string | undefined]
	if ((name === "halt-before-effect" || name === "halt-after-effect") && argument !== undefined && EFFECT_IDS.includes(argument as EffectId)) return { kind: name, effectId: argument as EffectId }
	return null
}

function egressFaultOf(token: string): EgressFault | null {
	const [name, argument] = token.split(":", 2) as [string, string | undefined]
	if (argument === undefined) return null
	if (name === "egress-non-json" && NON_JSON_VARIANTS.has(argument)) return { kind: "egress-non-json", variant: argument as Extract<EgressFault, { kind: "egress-non-json" }>["variant"] }
	if (name === "egress-schema-invalid" && SCHEMA_INVALID_VARIANTS.has(argument)) return { kind: "egress-schema-invalid", variant: argument as Extract<EgressFault, { kind: "egress-schema-invalid" }>["variant"] }
	return null
}

// At most one fault per family; a second of the same family rejects the whole value.
function parseOneFault(token: string, faults: Faults): boolean {
	const domain = domainFaultOf(token)
	if (domain !== null) {
		if (faults.domain !== null) return false
		faults.domain = domain
		return true
	}
	const egress = egressFaultOf(token)
	if (egress === null || faults.egress !== null) return false
	faults.egress = egress
	return true
}

// Closed fault channel: at most one domain fault and at most one egress fault, joined with "+" (brief 12, 3.1).
export function parseFaults(value: string | undefined): Faults | null {
	const faults: Faults = { domain: null, egress: null }
	if (value === undefined || value === "") return faults
	const tokens = value.split("+")
	const seen = new Set<string>()
	for (const token of tokens) {
		if (seen.has(token) || !parseOneFault(token, faults)) return null
		seen.add(token)
	}
	return faults
}

export function resolveRoot(env: Record<string, string | undefined>, cwd: string): string | null {
	const configured = env.REPAIR_LAB_ROOT
	if (configured === undefined) return cwd
	if (!isAbsolute(configured)) return null
	try {
		return lstatSync(configured).isDirectory() ? configured : null
	} catch {
		return null
	}
}

export interface Runtime {
	root: string
	faults: Faults
	facts: WriteFacts
	withinRoot(argument: string): string
	readResource(path?: string): ReadResult<Resource>
	readRawState(path: string): ReadResult<unknown>
	readPreview(): Preview | null
	writePreview(preview: Preview): void
	consumePreview(preview: Preview, runIdentity: string): void
	acquireJournalLock(run: string): () => void
	admitStatePaths(): void
	readJournal(): JournalScan
	appendJournal(record: JournalRecord): void
	probeStorage(attempt: number): void
	applyEffect(effectId: EffectId, operation: string, previewId: string, runIdentity: string, seq: () => number): "completed" | "unknown" | "not-observed"
	diagnosticsRoot(): string
}

function componentBoundary(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(root + sep)
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined
	const code = (error as { code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

const schemaRefusal = (message: string): RuntimeRefusal => new RuntimeRefusal("SCHEMA_STATE_INVALID", message)
const isHex64 = (value: unknown): value is string => typeof value === "string" && SHA256_HEX.test(value)
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

// Strict record parsing: exactly the keys of one record kind, each of the right shape.
type JournalBase = Omit<Extract<JournalRecord, { kind: "intent" }>, "kind" | "before_sha256" | "expected_after_sha256">
const BASE_KEYS = ["kind", "seq", "run", "effect", "operation", "preview_id"]
const RECORD_KEYS: Readonly<Record<JournalRecord["kind"], readonly string[]>> = {
	intent: [...BASE_KEYS, "before_sha256", "expected_after_sha256"].sort(),
	completed: [...BASE_KEYS, "resource_revision", "observed_after_sha256"].sort(),
	event: [...BASE_KEYS, "summary"].sort(),
}

function parseJournalBase(record: Record<string, unknown>): JournalBase | null {
	const previewId = parseResourceId(record.preview_id)
	if (previewId === null) return null
	if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq)) return null
	if (typeof record.run !== "string" || typeof record.operation !== "string") return null
	if (typeof record.effect !== "string" || !isEffectId(record.effect)) return null
	return { seq: record.seq, run: record.run, effect: record.effect, operation: record.operation, preview_id: previewId }
}

function parseJournalRecord(value: unknown): JournalRecord | null {
	if (!isPlainObject(value)) return null
	const record = value
	const base = parseJournalBase(record)
	const kind = record.kind
	if (base === null || (kind !== "intent" && kind !== "completed" && kind !== "event")) return null
	if (Object.keys(record).sort().join(",") !== RECORD_KEYS[kind].join(",")) return null
	if (kind === "intent") {
		const before = record.before_sha256
		if ((before !== null && !isHex64(before)) || !isHex64(record.expected_after_sha256)) return null
		return { kind, ...base, before_sha256: before, expected_after_sha256: record.expected_after_sha256 }
	}
	if (kind === "completed") {
		if (typeof record.resource_revision !== "number" || !isHex64(record.observed_after_sha256)) return null
		return { kind, ...base, resource_revision: record.resource_revision, observed_after_sha256: record.observed_after_sha256 }
	}
	return typeof record.summary === "string" ? { kind, ...base, summary: record.summary } : null
}

// One framed line, validated in the frozen order: frame shape and version literal, byte length, SHA-256 over the
// decoded payload bytes, then the strict record. An object without journalVersion is an unversioned journal.
function parseFrameShape(line: string): { payloadBytes: number; payloadSha256: string; payload: string } {
	let raw: unknown
	try {
		raw = JSON.parse(line)
	} catch {
		throw schemaRefusal("journal line is not a strict journal revision 2 frame")
	}
	if (!isPlainObject(raw)) throw schemaRefusal("journal line is not a strict journal revision 2 frame")
	if (!("journalVersion" in raw)) throw schemaRefusal("journal is unversioned; journal revision 2 frames are required and no migration is performed")
	const { journalVersion, payloadBytes, payloadSha256, payload } = raw
	if (Object.keys(raw).sort().join(",") !== FRAME_KEYS || journalVersion !== JOURNAL_VERSION || typeof payloadBytes !== "number" || !Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || !isHex64(payloadSha256) || typeof payload !== "string") {
		throw schemaRefusal("journal line is not a strict journal revision 2 frame")
	}
	return { payloadBytes, payloadSha256, payload }
}

function parseFrame(line: string): JournalEntry {
	const { payloadBytes, payloadSha256, payload } = parseFrameShape(line)
	if (payloadBytes > JOURNAL_PAYLOAD_BOUND_BYTES) throw schemaRefusal(`journal frame payload exceeds the ${JOURNAL_PAYLOAD_BOUND_BYTES.toLocaleString("en-US")}-byte bound`)
	if (Buffer.byteLength(payload, "utf8") !== payloadBytes) throw schemaRefusal("journal frame payloadBytes disagrees with its payload")
	if (sha256Hex(payload) !== payloadSha256) throw schemaRefusal("journal frame payloadSha256 disagrees with its payload")
	let raw: unknown
	try {
		raw = JSON.parse(payload)
	} catch {
		throw schemaRefusal("journal frame payload is not a strict journal record")
	}
	const record = parseJournalRecord(raw)
	if (record === null) throw schemaRefusal("journal frame payload is not a strict journal record")
	return { record, payloadSha256 }
}

function frameLine(record: JournalRecord): string {
	const payload = JSON.stringify(record)
	const payloadBytes = Buffer.byteLength(payload, "utf8")
	if (payloadBytes > JOURNAL_PAYLOAD_BOUND_BYTES) throw new Error(`journal record exceeds the ${JOURNAL_PAYLOAD_BOUND_BYTES}-byte payload bound`)
	return `${JSON.stringify({ journalVersion: JOURNAL_VERSION, payloadBytes, payloadSha256: sha256Hex(payload), payload })}\n`
}

// Every terminated line inside the scanned bytes is one frame; a nonempty remainder is a torn tail unless the scan
// stopped at its bound, in which case the remainder was merely cut. A line or fragment over the line bound is corrupt.
function scanJournalBytes(bytes: Buffer, exceedsScanBound: boolean): JournalScan {
	const entries: JournalEntry[] = []
	let start = 0
	for (let cursor = bytes.indexOf(LF, start); cursor !== -1; cursor = bytes.indexOf(LF, start)) {
		if (cursor + 1 - start > JOURNAL_LINE_BOUND_BYTES) throw schemaRefusal(`journal line exceeds the ${JOURNAL_LINE_BOUND_BYTES.toLocaleString("en-US")}-byte framed-line bound`)
		entries.push(parseFrame(bytes.toString("utf8", start, cursor)))
		start = cursor + 1
	}
	const remainder = bytes.length - start
	if (remainder >= JOURNAL_LINE_BOUND_BYTES) throw schemaRefusal(`journal line exceeds the ${JOURNAL_LINE_BOUND_BYTES.toLocaleString("en-US")}-byte framed-line bound`)
	return { entries, torn: remainder > 0 && !exceedsScanBound, exceedsScanBound }
}

// Reads at most one byte past the scan bound so an over-bound journal is recognised without loading it whole.
function readBounded(path: string): { bytes: Buffer; exceedsScanBound: boolean } {
	const fd = openSync(path, "r")
	try {
		const buffer = Buffer.allocUnsafe(JOURNAL_SCAN_BOUND_BYTES + 1)
		let length = 0
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null)
			if (read === 0) break
			length += read
		}
		const exceedsScanBound = length > JOURNAL_SCAN_BOUND_BYTES
		return { bytes: buffer.subarray(0, Math.min(length, JOURNAL_SCAN_BOUND_BYTES)), exceedsScanBound }
	} finally {
		closeSync(fd)
	}
}

export function createRuntime(root: string, faults: Faults): Runtime {
	const canonicalRoot = realpathSync(root)
	const facts: WriteFacts = { durableWriteAttempted: false, intentRecorded: [], completed: [], remaining: [] }
	let transientLocksLeft = faults.domain === "one-transient-lock" ? 1 : faults.domain === "persistent-lock" ? Number.POSITIVE_INFINITY : 0
	// Internal state paths pass the same containment predicate immediately before every read and write (PR 184,
	// thread 4003813337): a pre-existing final-component symlink at any of them is DOMAIN_PATH_ESCAPE, never followed.
	const PREVIEW_STATE = "state/preview.json"
	const JOURNAL_STATE = "state/journal.jsonl"
	const RESOURCE_STATE = "state/resource.json"

	// Exact containment predicate (brief 12, 3.1): lexical rejection first, then a symlink walk of every existing
	// component below the root, then canonical equality-or-component-boundary; only then may the target be opened.
	function withinRoot(argument: string): string {
		const lexical = resolve(root, argument)
		if (!componentBoundary(lexical, root)) throw new RuntimeRefusal("DOMAIN_PATH_ESCAPE", "state path must remain inside the fixture root")
		let probe = lexical
		const components: string[] = []
		while (probe !== root && componentBoundary(probe, root)) {
			components.unshift(probe)
			probe = dirname(probe)
		}
		let deepestExistingDirectory = root
		for (const component of components) {
			let stat: ReturnType<typeof lstatSync>
			try {
				stat = lstatSync(component)
			} catch {
				break
			}
			if (stat.isSymbolicLink()) throw new RuntimeRefusal("DOMAIN_PATH_ESCAPE", "state path must remain inside the fixture root")
			if (!stat.isDirectory()) break
			deepestExistingDirectory = component
		}
		const canonical = realpathSync(deepestExistingDirectory)
		if (!componentBoundary(canonical, canonicalRoot)) throw new RuntimeRefusal("DOMAIN_PATH_ESCAPE", "state path must remain inside the fixture root")
		return lexical
	}

	function readRawState(path: string): ReadResult<unknown> {
		const target = withinRoot(path)
		let bytes: string
		try {
			bytes = readFileSync(target, "utf8")
		} catch (error) {
			const code = errorCode(error)
			if (code === "ENOENT") throw new RuntimeRefusal("DOMAIN_INPUT_MISSING", "state file is missing")
			if (code === "EACCES" || code === "EPERM" || code === "EISDIR") throw new RuntimeRefusal("DOMAIN_INPUT_UNREADABLE", "state file is not readable")
			throw error
		}
		try {
			return { value: JSON.parse(bytes) as unknown, bytes }
		} catch (error) {
			if (error instanceof SyntaxError) throw new RuntimeRefusal("DOMAIN_INPUT_MALFORMED", "state file is malformed JSON")
			throw error
		}
	}

	function parseResource(value: unknown): Resource | null {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null
		const record = value as Record<string, unknown>
		const resource = parseResourceId(record.resource)
		if (resource === null || typeof record.revision !== "number" || (record.status !== "healthy" && record.status !== "index-missing") || typeof record.version !== "number") return null
		return { ...record, resource, revision: record.revision, status: record.status, version: record.version }
	}

	function parsePreview(value: unknown): Preview | null {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null
		const record = value as Record<string, unknown>
		const previewId = parseResourceId(record.preview_id)
		if (previewId === null || (record.kind !== "apply" && record.kind !== "repair") || typeof record.resource_revision !== "number" || !Array.isArray(record.expected_effect_ids) || typeof record.consumed !== "boolean" || (record.consumed_by_run !== undefined && typeof record.consumed_by_run !== "string")) return null
		const expectedEffects = record.expected_effect_ids.filter((effect): effect is EffectId => typeof effect === "string" && EFFECT_IDS.includes(effect as EffectId))
		if (expectedEffects.length !== record.expected_effect_ids.length) return null
		return { preview_id: previewId, kind: record.kind, resource_revision: record.resource_revision, expected_effect_ids: expectedEffects, consumed: record.consumed, ...(record.consumed_by_run === undefined ? {} : { consumed_by_run: record.consumed_by_run }) }
	}

	const defaultResourcePath = RESOURCE_STATE
	function readResource(path: string = defaultResourcePath): ReadResult<Resource> {
		const raw = readRawState(path)
		const resource = parseResource(raw.value)
		if (resource === null) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "resource does not match the resource schema")
		return { value: resource, bytes: raw.bytes }
	}

	function readPreview(): Preview | null {
		const previewPath = withinRoot(PREVIEW_STATE)
		if (!existsSync(previewPath)) return null
		let raw: unknown
		try {
			raw = JSON.parse(readFileSync(previewPath, "utf8"))
		} catch {
			throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "preview does not match the preview schema")
		}
		const preview = parsePreview(raw)
		if (preview === null) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "preview does not match the preview schema")
		return preview
	}

	function fsyncPath(target: string): void {
		const fd = openSync(target, "r")
		try {
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
	}

	function writeDurable(path: string, bytes: string, mode: "write" | "append"): void {
		const target = withinRoot(path)
		facts.durableWriteAttempted = true
		if (mode === "write") writeFileSync(target, bytes)
		else appendFileSync(target, bytes)
		fsyncPath(target)
	}

	function writePreview(preview: Preview): void {
		const previewPath = withinRoot(PREVIEW_STATE)
		mkdirSync(dirname(previewPath), { recursive: true })
		// The preview file is not transaction state (accepted rows 3 and 8): recorded, but not a durable write attempt.
		writeFileSync(previewPath, `${JSON.stringify(preview)}\n`)
	}

	// Atomic consumption (O1 Candidate A): the consumed preview is written exclusively to a run-named temp file, fsynced,
	// renamed over the preview, then fsynced again, so the preview is always either its pre-consumption or its consumed
	// bytes. This is process and filesystem scope only: no directory fsync and no power-loss claim. The journal lock covers this operation.
	function consumePreview(preview: Preview, runIdentity: string): void {
		const target = withinRoot(PREVIEW_STATE)
		const temporary = withinRoot(`${PREVIEW_STATE}.tmp-${runIdentity}`)
		facts.durableWriteAttempted = true
		writeFileSync(temporary, `${JSON.stringify({ ...preview, consumed: true, consumed_by_run: runIdentity })}\n`, { flag: "wx" })
		fsyncPath(temporary)
		renameSync(temporary, target)
		fsyncPath(target)
	}

	function readJournal(): JournalScan {
		const journalPath = withinRoot(JOURNAL_STATE)
		if (!existsSync(journalPath)) return { entries: [], torn: false, exceedsScanBound: false }
		const { bytes, exceedsScanBound } = readBounded(journalPath)
		return scanJournalBytes(bytes, exceedsScanBound)
	}

	function appendJournal(record: JournalRecord): void {
		writeDurable(withinRoot(JOURNAL_STATE), frameLine(record), "append")
	}

	// Every state path an effect plan will touch is admitted before the first durable write, so a symlinked journal or
	// resource refuses while the preview is still unconsumed; each later access still re-checks its own path.
	function admitStatePaths(): void {
		withinRoot(PREVIEW_STATE)
		withinRoot(JOURNAL_STATE)
		withinRoot(RESOURCE_STATE)
	}

	function probeStorage(attempt: number): void {
		if (transientLocksLeft > 0) {
			transientLocksLeft -= 1
			throw new TransientLock(`storage busy on attempt ${attempt}`)
		}
	}

	function haltIf(kind: "halt-before-effect" | "halt-after-effect", effectId: EffectId): void {
		const fault = faults.domain
		if (typeof fault === "object" && fault !== null && fault.kind === kind && fault.effectId === effectId) process.kill(process.pid, "SIGKILL")
	}

	// The read-back that follows a successful durable write fails as an ordinary exception: the write may have landed,
	// so the caller's W2 path (durable write attempted, outcome not established) is the only truthful station.
	function readBackFailIf(effectId: EffectId): void {
		const fault = faults.domain
		if (typeof fault === "object" && fault !== null && fault.kind === "readback-fail" && fault.effectId === effectId) throw new Error(`injected read-back failure after the durable write of ${effectId}`)
	}

	function resourceFromBytes(bytes: string): Resource {
		let raw: unknown
		try {
			raw = JSON.parse(bytes)
		} catch {
			throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "resource does not match the resource schema")
		}
		const resource = parseResource(raw)
		if (resource === null) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "resource does not match the resource schema")
		return resource
	}

	// The observation tuple an intent records before its effect, and the effect itself: the exact bytes the effect must
	// produce are fixed here so recovery can classify the effect from independently observed bytes.
	interface PlannedEffect {
		beforeSha256: string | null
		expectedAfterSha256: string
		perform(): boolean
	}

	function planJournalEffect(effectId: EffectId, operation: string, previewId: string, runIdentity: string, eventSeq: number): PlannedEffect {
		const eventRecord: JournalRecord = { kind: "event", seq: eventSeq, run: runIdentity, effect: effectId, operation, preview_id: previewId, summary: `${operation} recorded` }
		const eventLine = frameLine(eventRecord)
		return {
			beforeSha256: null,
			expectedAfterSha256: sha256Hex(JSON.stringify(eventRecord)),
			perform: () => {
				if (faults.domain !== "silent-no-op") writeDurable(withinRoot(JOURNAL_STATE), eventLine, "append")
				haltIf("halt-after-effect", effectId)
				readBackFailIf(effectId)
				return readFileSync(withinRoot(JOURNAL_STATE), "utf8").endsWith(eventLine)
			},
		}
	}

	function planResourceEffect(effectId: EffectId): PlannedEffect {
		const before = readFileSync(withinRoot(RESOURCE_STATE), "utf8")
		const current = resourceFromBytes(before)
		const next: Resource = effectId === "effect.repair-cache" ? { ...current, status: "healthy", revision: current.revision + 1 } : { ...current, revision: current.revision + 1 }
		const expected = `${JSON.stringify(next)}\n`
		return {
			beforeSha256: sha256Hex(before),
			expectedAfterSha256: sha256Hex(expected),
			perform: () => {
				if (faults.domain !== "silent-no-op") writeDurable(withinRoot(RESOURCE_STATE), expected, "write")
				haltIf("halt-after-effect", effectId)
				readBackFailIf(effectId)
				return readFileSync(withinRoot(RESOURCE_STATE), "utf8") === expected
			},
		}
	}

	// Intent frame, effect, read-back, completed frame (brief 12, 3.5 step 11). Faults apply at the boundary they simulate.
	function applyEffect(effectId: EffectId, operation: string, previewId: string, runIdentity: string, seq: () => number): "completed" | "unknown" | "not-observed" {
		const intentSeq = seq()
		const planned = effectId === "effect.write-journal" ? planJournalEffect(effectId, operation, previewId, runIdentity, seq()) : planResourceEffect(effectId)
		appendJournal({ kind: "intent", seq: intentSeq, run: runIdentity, effect: effectId, operation, preview_id: previewId, before_sha256: planned.beforeSha256, expected_after_sha256: planned.expectedAfterSha256 })
		facts.intentRecorded.push(effectId)
		if (effectId === "effect.write-journal" && faults.domain === "effect.write-journal-outcome-unknown") return "unknown"
		haltIf("halt-before-effect", effectId)
		if (!planned.perform()) return "not-observed"
		const revision = resourceFromBytes(readFileSync(withinRoot(RESOURCE_STATE), "utf8")).revision
		appendJournal({ kind: "completed", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, resource_revision: revision, observed_after_sha256: planned.expectedAfterSha256 })
		facts.completed.push(effectId)
		return "completed"
	}

	return {
		root,
		faults,
		facts,
		withinRoot,
		readResource,
		readRawState,
		readPreview,
		writePreview,
		consumePreview,
		acquireJournalLock: (run) => acquireJournalLock(withinRoot("state"), run, faults.domain === "journal-contention" ? withinRoot("receipts/journal-barrier") : null),
		admitStatePaths,
		readJournal,
		appendJournal,
		probeStorage,
		applyEffect,
		diagnosticsRoot: () => resolve(root, "diagnostics"),
	}
}
