import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, sep } from "node:path"
import { parseResourceId } from "./command-contract.ts"
import type { DomainFault, EffectId, EgressFault, Faults, JournalRecord, Preview, Resource, WriteFacts } from "./model.ts"

// Real node:fs effects only; fault injection lives here at the boundary it simulates (brief 12, section 6).
// Two adapters exist in practice: the real filesystem under a temp root (tests) and under the harness root.

export const RETRY_DELAY_MS = 25

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

const DOMAIN_FAULT_NAMES = new Set(["effect.write-journal-outcome-unknown", "one-transient-lock", "persistent-lock", "silent-no-op", "throw-internal", "sink-throw", "sink-dispose-throw", "diagnostics-flood"])
const NON_JSON_VARIANTS = new Set(["cycle", "depth65", "date", "undefined", "function", "bigint", "nan", "infinity"])
const SCHEMA_INVALID_VARIANTS = new Set(["non-string-message", "extra-key", "bad-enum", "both-guidance"])
const EFFECT_IDS: readonly EffectId[] = ["effect.update-index", "effect.write-journal", "effect.repair-cache"]

// One token of the fault channel: a domain fault name, a halt-* fault with its effect id, or null when it is neither.
function domainFaultOf(token: string): DomainFault | null {
	if (DOMAIN_FAULT_NAMES.has(token)) return token as DomainFault
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
	admitStatePaths(): void
	readJournal(): JournalRecord[]
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

	function parseJournalBase(record: Record<string, unknown>): Omit<Extract<JournalRecord, { kind: "intent" }>, "kind"> | null {
		const previewId = parseResourceId(record.preview_id)
		if (previewId === null) return null
		if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq)) return null
		if (typeof record.run !== "string" || typeof record.operation !== "string") return null
		if (typeof record.effect !== "string" || !EFFECT_IDS.includes(record.effect as EffectId)) return null
		return { seq: record.seq, run: record.run, effect: record.effect as EffectId, operation: record.operation, preview_id: previewId }
	}

	function parseJournalRecord(value: unknown): JournalRecord | null {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null
		const record = value as Record<string, unknown>
		const base = parseJournalBase(record)
		if (base === null) return null
		if (record.kind === "intent") return { kind: "intent", ...base }
		if (record.kind === "completed" && typeof record.resource_revision === "number") return { kind: "completed", ...base, resource_revision: record.resource_revision }
		if (record.kind === "event" && typeof record.summary === "string") return { kind: "event", ...base, summary: record.summary }
		return null
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

	function writeDurable(path: string, bytes: string, mode: "write" | "append"): void {
		const target = withinRoot(path)
		facts.durableWriteAttempted = true
		if (mode === "write") writeFileSync(target, bytes)
		else appendFileSync(target, bytes)
		const fd = openSync(target, "r")
		try {
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
	}

	function writePreview(preview: Preview): void {
		const previewPath = withinRoot(PREVIEW_STATE)
		mkdirSync(dirname(previewPath), { recursive: true })
		// The preview file is not transaction state (accepted rows 3 and 8): recorded, but not a durable write attempt.
		writeFileSync(previewPath, `${JSON.stringify(preview)}\n`)
	}

	function consumePreview(preview: Preview, runIdentity: string): void {
		writeDurable(withinRoot(PREVIEW_STATE), `${JSON.stringify({ ...preview, consumed: true, consumed_by_run: runIdentity })}\n`, "write")
	}

	function readJournal(): JournalRecord[] {
		const journalPath = withinRoot(JOURNAL_STATE)
		if (!existsSync(journalPath)) return []
		return readFileSync(journalPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				let raw: unknown
				try {
					raw = JSON.parse(line)
				} catch {
					throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "journal does not match the journal schema")
				}
					const record = parseJournalRecord(raw)
					if (record === null) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "journal does not match the journal schema")
					return record
			})
	}

	function appendJournal(record: JournalRecord): void {
		writeDurable(withinRoot(JOURNAL_STATE), `${JSON.stringify(record)}\n`, "append")
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

	function writeJournalEffect(effectId: EffectId, operation: string, previewId: string, runIdentity: string, seq: () => number): boolean {
		const eventLine = `${JSON.stringify({ kind: "event", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, summary: `${operation} recorded` })}\n`
		if (faults.domain !== "silent-no-op") writeDurable(withinRoot(JOURNAL_STATE), eventLine, "append")
		haltIf("halt-after-effect", effectId)
		return readFileSync(withinRoot(JOURNAL_STATE), "utf8").endsWith(eventLine)
	}

	function writeResourceEffect(effectId: EffectId, current: Resource): boolean {
		const next: Resource = effectId === "effect.repair-cache" ? { ...current, status: "healthy", revision: current.revision + 1 } : { ...current, revision: current.revision + 1 }
		const expected = `${JSON.stringify(next)}\n`
		if (faults.domain !== "silent-no-op") writeDurable(withinRoot(RESOURCE_STATE), expected, "write")
		haltIf("halt-after-effect", effectId)
		return readFileSync(withinRoot(RESOURCE_STATE), "utf8") === expected
	}

	// Intent line, effect, read-back, completed line (brief 12, 3.5 step 11). Faults apply at the boundary they simulate.
	function applyEffect(effectId: EffectId, operation: string, previewId: string, runIdentity: string, seq: () => number): "completed" | "unknown" | "not-observed" {
		appendJournal({ kind: "intent", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId })
		facts.intentRecorded.push(effectId)
		if (effectId === "effect.write-journal" && faults.domain === "effect.write-journal-outcome-unknown") return "unknown"
		haltIf("halt-before-effect", effectId)
		const observed = effectId === "effect.write-journal" ? writeJournalEffect(effectId, operation, previewId, runIdentity, seq) : writeResourceEffect(effectId, resourceFromBytes(readFileSync(withinRoot(RESOURCE_STATE), "utf8")))
		if (!observed) return "not-observed"
		const revision = resourceFromBytes(readFileSync(withinRoot(RESOURCE_STATE), "utf8")).revision
		appendJournal({ kind: "completed", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, resource_revision: revision })
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
		admitStatePaths,
		readJournal,
		appendJournal,
		probeStorage,
		applyEffect,
		diagnosticsRoot: () => resolve(root, "diagnostics"),
	}
}
