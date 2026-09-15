import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, sep } from "node:path"
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
const NON_JSON_VARIANTS = new Set(["cycle", "date", "undefined", "function", "bigint", "nan"])
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
	const PREVIEW = "state/preview.json"
	const JOURNAL = "state/journal.jsonl"
	const RESOURCE = "state/resource.json"

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

	function isResource(value: unknown): value is Resource {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false
		const record = value as Record<string, unknown>
		return typeof record.resource === "string" && typeof record.revision === "number" && (record.status === "healthy" || record.status === "index-missing") && typeof record.version === "number"
	}

	function readResource(path = RESOURCE): ReadResult<Resource> {
		const raw = readRawState(path)
		if (!isResource(raw.value)) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "resource does not match the resource schema")
		return { value: raw.value, bytes: raw.bytes }
	}

	function readPreview(): Preview | null {
		const previewPath = withinRoot(PREVIEW)
		if (!existsSync(previewPath)) return null
		return JSON.parse(readFileSync(previewPath, "utf8")) as Preview
	}

	function writeDurable(path: string, bytes: string, mode: "write" | "append"): void {
		facts.durableWriteAttempted = true
		if (mode === "write") writeFileSync(path, bytes)
		else appendFileSync(path, bytes)
		const fd = openSync(path, "r")
		try {
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
	}

	function writePreview(preview: Preview): void {
		const previewPath = withinRoot(PREVIEW)
		mkdirSync(dirname(previewPath), { recursive: true })
		// The preview file is not transaction state (accepted rows 3 and 8): recorded, but not a durable write attempt.
		writeFileSync(previewPath, `${JSON.stringify(preview)}\n`)
	}

	function consumePreview(preview: Preview, runIdentity: string): void {
		writeDurable(withinRoot(PREVIEW), `${JSON.stringify({ ...preview, consumed: true, consumed_by_run: runIdentity })}\n`, "write")
	}

	function readJournal(): JournalRecord[] {
		const journalPath = withinRoot(JOURNAL)
		if (!existsSync(journalPath)) return []
		return readFileSync(journalPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as JournalRecord)
	}

	function appendJournal(record: JournalRecord): void {
		writeDurable(withinRoot(JOURNAL), `${JSON.stringify(record)}\n`, "append")
	}

	// Every state path an effect plan will touch is admitted before the first durable write, so a symlinked journal or
	// resource refuses while the preview is still unconsumed; each later access still re-checks its own path.
	function admitStatePaths(): void {
		withinRoot(PREVIEW)
		withinRoot(JOURNAL)
		withinRoot(RESOURCE)
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

	// Intent line, effect, read-back, completed line (brief 12, 3.5 step 11). Faults apply at the boundary they simulate.
	function applyEffect(effectId: EffectId, operation: string, previewId: string, runIdentity: string, seq: () => number): "completed" | "unknown" | "not-observed" {
		appendJournal({ kind: "intent", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId })
		facts.intentRecorded.push(effectId)
		if (effectId === "effect.write-journal" && faults.domain === "effect.write-journal-outcome-unknown") return "unknown"
		haltIf("halt-before-effect", effectId)
		const before = readFileSync(withinRoot(RESOURCE), "utf8")
		const current = JSON.parse(before) as Resource
		let expected: string
		if (effectId === "effect.write-journal") {
			const eventLine = `${JSON.stringify({ kind: "event", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, summary: `${operation} recorded` })}\n`
			if (faults.domain !== "silent-no-op") writeDurable(withinRoot(JOURNAL), eventLine, "append")
			haltIf("halt-after-effect", effectId)
			const journal = readFileSync(withinRoot(JOURNAL), "utf8")
			if (!journal.endsWith(eventLine)) return "not-observed"
			expected = journal
		} else {
			const next: Resource = effectId === "effect.repair-cache" ? { ...current, status: "healthy", revision: current.revision + 1 } : { ...current, revision: current.revision + 1 }
			expected = `${JSON.stringify(next)}\n`
			if (faults.domain !== "silent-no-op") writeDurable(withinRoot(RESOURCE), expected, "write")
			haltIf("halt-after-effect", effectId)
			const after = readFileSync(withinRoot(RESOURCE), "utf8")
			if (after !== expected) return "not-observed"
		}
		const revision = (JSON.parse(readFileSync(withinRoot(RESOURCE), "utf8")) as Resource).revision
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
