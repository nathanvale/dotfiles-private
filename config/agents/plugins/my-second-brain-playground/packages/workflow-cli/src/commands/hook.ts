// `hook`: the one command outside Contract Core. It reads one Harness event from stdin, validates the event name, a
// safe session_id and a canonical cwd, reads that session's binding, verifies cwd is inside the binding's source
// repository or equals its workspace, and then delivers Harness JSON. Invalid input, a missing binding, a mismatch,
// or any read failure fails open: empty stdout, exit 0. Diagnostics go to the private file sink only, because
// stderr may reach the Harness. The payload shapes are fixture-derived from the pinned upstream document until M2
// observes the installed Codex.

import { realpathSync, statSync } from "node:fs"
import { isAbsolute, sep } from "node:path"
import type { RecoveryStore } from "../adapters/recovery.ts"
import { parseClosedJsonBytes } from "../closed-json.ts"
import { redactText } from "../command-contract.ts"
import { claimForPrompt, type CompactionMarker, type PromptDecision, recordDelivered, recordGeneration } from "../compaction-marker.ts"
import type { Diagnostics } from "../diagnostics.ts"
import type { RecoveryBinding } from "../model.ts"
import { SESSION_PATTERN, shellQuote } from "../recovery.ts"
import { RuntimeFailure } from "../runtime.ts"
import { readPanel } from "./recover.ts"
import type { CommandContext } from "./shared.ts"

export const HOOK_INPUT_LIMIT_BYTES = 128 * 1024

/** The closed set of hook deliveries; the hook process tests observe every one through a real process. */
const HOOK_DELIVERIES = ["silent", "session-guidance", "compact-panel", "precompact-available", "precompact-unavailable", "postcompact-recorded", "prompt-panel", "prompt-notice", "prompt-silent"] as const
export type HookDelivery = (typeof HOOK_DELIVERIES)[number]

export interface HookResult {
	readonly delivery: HookDelivery
	readonly stdout: string
}

/** Fault seams for the killed-claimant process tests; production passes none. `afterClaim` fires once the claim is
 * durable; `afterOutput` fires once the panel or the notice has left the process, before its record is written. */
export interface HookFaults {
	readonly afterClaim?: () => void
	readonly afterOutput?: () => void
}

const EVENTS = ["SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit"] as const
type EventName = (typeof EVENTS)[number]
const SESSION_SOURCES = ["startup", "resume", "clear", "compact"] as const
type SessionSource = (typeof SESSION_SOURCES)[number]

interface HookEvent {
	readonly event: EventName
	readonly source: SessionSource | null
	readonly session: string
	readonly cwd: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The supplied cwd as written must already be the canonical path of an existing directory; a symlinked, `..`,
 * `.` or trailing-slash spelling is refused, never normalised, so the admission below compares exact identities. */
function canonicalDirectory(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\0\r\n]/.test(value) || !isAbsolute(value)) return null
	try {
		return realpathSync(value) === value && statSync(value).isDirectory() ? value : null
	} catch {
		return null
	}
}

function parseEvent(bytes: Uint8Array): HookEvent | null {
	let parsed: unknown
	try {
		parsed = parseClosedJsonBytes(bytes, HOOK_INPUT_LIMIT_BYTES)
	} catch {
		return null
	}
	if (!isRecord(parsed)) return null
	const event = parsed.hook_event_name
	if (typeof event !== "string" || !EVENTS.includes(event as EventName)) return null
	let source: SessionSource | null = null
	if (event === "SessionStart") {
		if (typeof parsed.source !== "string" || !SESSION_SOURCES.includes(parsed.source as SessionSource)) return null
		source = parsed.source as SessionSource
	}
	const session = parsed.session_id
	if (typeof session !== "string" || !SESSION_PATTERN.test(session)) return null
	const cwd = canonicalDirectory(parsed.cwd)
	if (cwd === null) return null
	return { event: event as EventName, source, session, cwd }
}

function cwdAdmitted(cwd: string, binding: RecoveryBinding): boolean {
	const within = (root: string): boolean => {
		try {
			const real = realpathSync(root)
			return cwd === real || cwd.startsWith(`${real}${sep}`)
		} catch {
			return false
		}
	}
	try {
		if (cwd === realpathSync(binding.workspace)) return true
	} catch {
		// An unreadable workspace only removes the equality route.
	}
	return within(binding.sourceRepository)
}

function harnessJson(eventName: EventName, additionalContext: string): string {
	return `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } })}\n`
}

/** The `recover` command in the guidance and the notice is pasteable shell input, quoted exactly as Resume Panel
 * command 4 is; the prose lines and the `bind` line with its `<bead-id>` placeholder are not pasteable and stay bare. */
function guidance(binding: RecoveryBinding): string {
	return [
		"My Second Brain recovery session.",
		`Session identity: ${binding.sessionIdentity}`,
		`Bound to Bead ${binding.beadId} in ${binding.workspace} (store ${binding.storePath}).`,
		`Rebuild the Resume Panel at any time: msb-workflow recover --workspace ${shellQuote(binding.workspace)} --session ${shellQuote(binding.sessionIdentity)} --json`,
		`Refresh or rebind with this exact session identity: msb-workflow bind --workspace ${binding.workspace} --bead <bead-id> --session ${binding.sessionIdentity}`,
		"After compaction the Resume Panel is delivered once: on the next prompt (Codex) or at SessionStart compact (Claude Code).",
	].join("\n")
}

function notice(binding: RecoveryBinding, uncertain: readonly number[], folded: readonly number[]): string {
	const foldedText = folded.length === 0 ? "" : ` Pending generation(s) ${folded.join(", ")} settle with this notice.`
	return `msb-workflow: the Resume Panel for compaction generation(s) ${uncertain.join(", ")} was claimed but never recorded delivered; run msb-workflow recover --workspace ${shellQuote(binding.workspace)} --session ${shellQuote(binding.sessionIdentity)} --json to rebuild it.${foldedText} Nothing is replayed automatically.`
}

const SILENT: HookResult = { delivery: "silent", stdout: "" }

interface Bound {
	readonly store: RecoveryStore
	readonly binding: RecoveryBinding
	readonly event: HookEvent
	readonly context: CommandContext
	readonly diagnostics: Diagnostics
	readonly faults: HookFaults
	readonly emit: (text: string) => void
}

/** The current panel with prime context as Harness JSON for `eventName`, or null once a refused read is logged. */
async function readPanelText(bound: Bound, eventName: EventName): Promise<string | null> {
	const read = await readPanel(bound.store, bound.context, null, bound.event.session, bound.diagnostics, { includePrime: true })
	if (read.status === "refused") {
		bound.diagnostics.log("hook.read-failed", { level: "warning", station: read.outcome.station })
		return null
	}
	return harnessJson(eventName, redactText(read.panel.resumePanel, read.beads.knownSecretValues()))
}

async function sessionStart(bound: Bound): Promise<HookResult> {
	if (bound.event.source !== "compact") {
		const text = harnessJson("SessionStart", guidance(bound.binding))
		bound.emit(text)
		return { delivery: "session-guidance", stdout: text }
	}
	const text = await readPanelText(bound, "SessionStart")
	if (text === null) return SILENT
	bound.emit(text)
	return { delivery: "compact-panel", stdout: text }
}

async function preCompact(bound: Bound): Promise<HookResult> {
	const read = await readPanel(bound.store, bound.context, null, bound.event.session, bound.diagnostics, { includePrime: false })
	if (read.status === "refused") {
		const secrets = read.beads?.knownSecretValues() ?? []
		const text = harnessJson("PreCompact", redactText(`msb-workflow recovery is unavailable before compaction: ${read.outcome.message}. Repair: ${read.outcome.repairAction ?? read.outcome.nextAction ?? "msb-workflow inspect"}`, secrets))
		bound.emit(text)
		return { delivery: "precompact-unavailable", stdout: text }
	}
	const text = harnessJson("PreCompact", `msb-workflow recovery is available: session ${bound.binding.sessionIdentity} is bound to ${bound.binding.beadId}; the Resume Panel is delivered once on the next prompt after compaction.`)
	bound.emit(text)
	return { delivery: "precompact-available", stdout: text }
}

/** The session lock alone, then the marker read; an unreadable marker is a silent fail-open. The workspace lock is
 * never taken here, so a marker operation waits only for another marker section of the same session, and every such
 * section is short: no native read runs under the lock. */
function withMarker<T>(bound: Bound, whenUnreadable: T, action: (marker: CompactionMarker) => T): Promise<T> {
	const { store, event } = bound
	return store.withSessionLock(event.session, async () => {
		const marker = store.readMarker(event.session)
		if (marker.status !== "available") {
			bound.diagnostics.log("hook.marker-unreadable", { level: "warning", reason: marker.reason })
			return whenUnreadable
		}
		return action(marker.marker)
	})
}

function postCompact(bound: Bound): Promise<HookResult> {
	return withMarker(bound, SILENT, (marker) => {
		const recorded = recordGeneration(marker, bound.context.now().toISOString())
		bound.store.writeMarker(recorded.marker)
		bound.diagnostics.log("hook.generation-recorded", { generation: recorded.generation })
		return { delivery: "postcompact-recorded", stdout: "" }
	})
}

function decide(bound: Bound, marker: CompactionMarker): PromptDecision {
	return claimForPrompt(marker, bound.context.runIdentity, bound.context.now().toISOString())
}

/** The notice leaves the process before `notified` is recorded: a death in between leaves the generations claimed and
 * the next prompt repeats the notice, which is harmless, rather than losing the handoff. */
function emitNotice(bound: Bound, decision: Extract<PromptDecision, { kind: "notice" }>): HookResult {
	const text = harnessJson("UserPromptSubmit", notice(bound.binding, decision.uncertain, decision.folded))
	bound.emit(text)
	bound.faults.afterOutput?.()
	bound.store.writeMarker(decision.marker)
	bound.diagnostics.log("hook.notice", { level: "warning", uncertain: [...decision.uncertain], folded: [...decision.folded] })
	return { delivery: "prompt-notice", stdout: text }
}

/** Claim, then emit, then record, all inside one short locked section: the claim is durable before any output so a
 * death after output can never replay the panel blind, and nothing between the claim and the record can block. */
function deliverPanel(bound: Bound, decision: Extract<PromptDecision, { kind: "deliver" }>, text: string): HookResult {
	bound.store.writeMarker(decision.marker)
	bound.faults.afterClaim?.()
	bound.emit(text)
	bound.faults.afterOutput?.()
	bound.store.writeMarker(recordDelivered(decision.marker, decision.claimed, bound.context.now().toISOString()))
	bound.diagnostics.log("hook.delivered", { generations: [...decision.claimed] })
	return { delivery: "prompt-panel", stdout: text }
}

/** Inspect under the lock, read with no lock held, then re-decide under the lock before anything is persisted. The
 * native reads (up to six bounded bd processes) run unlocked so a PostCompact from this or another session is never
 * dropped behind them; the re-decision claims every generation pending at that moment, including one minted during
 * the read, and settles silent when a concurrent prompt delivered first. A refused read persists nothing. */
async function userPromptSubmit(bound: Bound): Promise<HookResult> {
	const inspected = await withMarker<HookResult | "read-needed">(bound, SILENT, (marker) => {
		const decision = decide(bound, marker)
		if (decision.kind === "silent") return { delivery: "prompt-silent", stdout: "" }
		if (decision.kind === "notice") return emitNotice(bound, decision)
		return "read-needed"
	})
	if (inspected !== "read-needed") return inspected
	// Nothing is claimed yet, so a refused read leaves the marker untouched and the next prompt retries the same generations.
	const text = await readPanelText(bound, "UserPromptSubmit")
	if (text === null) return SILENT
	return withMarker(bound, SILENT, (marker) => {
		const decision = decide(bound, marker)
		if (decision.kind === "silent") {
			bound.diagnostics.log("hook.prompt-superseded")
			return { delivery: "prompt-silent", stdout: "" }
		}
		if (decision.kind === "notice") return emitNotice(bound, decision)
		return deliverPanel(bound, decision, text)
	})
}

/** Runs one hook event. `emit` writes Harness JSON to stdout before the delivery record is made. */
export async function runHook(stdin: Uint8Array, context: CommandContext, diagnostics: Diagnostics, emit: (text: string) => void, faults: HookFaults = {}): Promise<HookResult> {
	const event = parseEvent(stdin)
	if (event === null || context.stateRoot.status !== "selected") return SILENT
	const store = context.openStore(context.stateRoot.path)
	const read = store.readBinding(event.session, context.now().getTime())
	if (read.status !== "available") {
		diagnostics.log("hook.binding-unavailable", { status: read.status })
		return SILENT
	}
	if (!cwdAdmitted(event.cwd, read.binding)) {
		diagnostics.log("hook.cwd-refused", { level: "warning" })
		return SILENT
	}
	const bound: Bound = { store, binding: read.binding, event, context, diagnostics, faults, emit }
	try {
		switch (event.event) {
			case "SessionStart":
				return await sessionStart(bound)
			case "PreCompact":
				return await preCompact(bound)
			case "PostCompact":
				return await postCompact(bound)
			case "UserPromptSubmit":
				return await userPromptSubmit(bound)
		}
	} catch (error) {
		// The sink keeps only an Error's name, so the kind (busy, unsafe, unavailable, unsupported, uncertain) is recorded beside it.
		diagnostics.log("hook.failed", { level: "warning", kind: error instanceof RuntimeFailure ? error.kind : "unknown", failure: error })
		return SILENT
	}
}
