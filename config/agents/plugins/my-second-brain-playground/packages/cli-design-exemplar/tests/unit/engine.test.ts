import { describe, expect, test } from "bun:test"
import { mintAuthorization, parseResourceId, type Authorization, type ResourceId } from "../../src/command-contract.ts"
import { type Decision, decide, factsOf, FIXTURE_AUTHORITY, redactJson, type Request } from "../../src/engine.ts"
import type { EffectId, Faults, JournalRecord, Preview, Resource } from "../../src/model.ts"
import { type Runtime, RuntimeRefusal, TransientLock } from "../../src/runtime.ts"

// Engine decision tables over an in-memory Runtime fake (brief 12, 8.1): retry predicate per resulting state, refusal
// precedence per 3.5 step, recover scoping (F2) and redaction. Expected values are literals from the fixture and the
// brief, never read from the engine (independent oracle).

const U: EffectId = "effect.update-index"
const J: EffectId = "effect.write-journal"
const R: EffectId = "effect.repair-cache"
const RUN = "run-unit"

function resourceId(value: string): ResourceId {
	const parsed = parseResourceId(value)
	if (parsed === null) throw new Error(`invalid fixture resource id: ${value}`)
	return parsed
}

function authorization(value: string): Authorization {
	const parsed = mintAuthorization(value)
	if (parsed === null) throw new Error(`invalid fixture authority: ${value}`)
	return parsed
}

interface State {
	resource: Resource | RuntimeRefusal
	preview: Preview | null
	journal: JournalRecord[]
	busy: number
	domain: Faults["domain"]
}

function fake(overrides: Partial<State>): Runtime & { state: State } {
	const state: State = { resource: { resource: "demo", revision: 4, status: "healthy", version: 1 }, preview: null, journal: [], busy: 0, domain: null, ...overrides }
	const facts = { durableWriteAttempted: false, intentRecorded: [] as EffectId[], completed: [] as EffectId[], remaining: [] as EffectId[] }
	const resource = (): Resource => {
		if (state.resource instanceof RuntimeRefusal) throw state.resource
		return state.resource
	}
	return {
		state,
		root: "/fake",
		faults: { domain: state.domain, egress: null },
		facts,
		withinRoot: (argument) => argument,
		readResource: () => ({ value: resource(), bytes: JSON.stringify(resource()) }),
		readRawState: () => ({ value: resource(), bytes: JSON.stringify(resource()) }),
		readPreview: () => state.preview,
		writePreview: (preview) => {
			state.preview = preview
		},
		consumePreview: (preview, runIdentity) => {
			facts.durableWriteAttempted = true
			state.preview = { ...preview, consumed: true, consumed_by_run: runIdentity }
		},
		admitStatePaths: () => {},
		readJournal: () => state.journal,
		appendJournal: (record) => {
			facts.durableWriteAttempted = true
			state.journal.push(record)
		},
		probeStorage: (attempt) => {
			if (state.busy > 0) {
				state.busy -= 1
				throw new TransientLock(`busy ${attempt}`)
			}
		},
		applyEffect: (effectId, operation, previewId, runIdentity, seq) => {
			state.journal.push({ kind: "intent", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId })
			facts.intentRecorded.push(effectId)
			if (effectId === J && state.domain === "effect.write-journal-outcome-unknown") return "unknown"
			if (state.domain === "silent-no-op") return "not-observed"
			const current = resource()
			if (effectId === J) state.journal.push({ kind: "event", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, summary: "event" })
			else state.resource = effectId === R ? { ...current, status: "healthy", revision: current.revision + 1 } : { ...current, revision: current.revision + 1 }
			state.journal.push({ kind: "completed", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, resource_revision: resource().revision })
			facts.completed.push(effectId)
			return "completed"
		},
		diagnosticsRoot: () => "/fake/diagnostics",
	}
}

function request(route: Request["route"], overrides: Partial<Request> = {}): Request {
	return { route, statePath: undefined, previewId: undefined, authority: undefined, automation: false, includeDiagnostics: false, ...overrides }
}

const applyPreview = (id = "preview-healthy-revision-4", revision = 4, plan: EffectId[] = [U, J]): Preview => ({ preview_id: id, kind: "apply", resource_revision: revision, expected_effect_ids: plan, consumed: false })
const repairPreview = (revision = 4, plan: EffectId[] = [R, J]): Preview => ({ preview_id: "repair-preview-missing-index", kind: "repair", resource_revision: revision, expected_effect_ids: plan, consumed: false })
const indexMissing: Resource = { resource: "demo", revision: 4, status: "index-missing", version: 1 }
const authorized = (route: Request["route"], previewId?: string): Request => request(route, { authority: authorization(FIXTURE_AUTHORITY), ...(previewId === undefined ? {} : { previewId: resourceId(previewId) }) })

function signature(decision: Decision): string {
	return `${decision.domainOutcome}|${decision.causeCode ?? "null"}|${decision.transactionState}|${decision.retryable}|${decision.retryDelayMilliseconds ?? "null"}|${decision.guidance.kind}`
}

describe("outward retry predicate per resulting state (B2)", () => {
	const rows: Array<[string, () => Decision, string]> = [
		["row 1 status", () => decide(fake({}), request("status"), RUN), "success|null|unchanged|true|null|next-action"],
		["row 2 inspect", () => decide(fake({}), request("inspect"), RUN), "success|null|unchanged|true|null|next-action"],
		["row 3 preview", () => decide(fake({}), request("preview"), RUN), "success|null|unchanged|false|null|next-action"],
		["row 4 apply", () => decide(fake({ preview: applyPreview() }), authorized("apply", "preview-healthy-revision-4"), RUN), "success|null|completed|false|null|next-action"],
		["row 5 stale", () => decide(fake({ resource: { resource: "demo", revision: 5, status: "healthy", version: 1 }, preview: applyPreview("preview-stale-revision-4") }), authorized("apply", "preview-stale-revision-4"), RUN), "refused|DOMAIN_PREVIEW_STALE|unchanged|false|null|next-action"],
		["row 6 partial", () => decide(fake({ preview: applyPreview("preview-partial-revision-4"), domain: "effect.write-journal-outcome-unknown" }), authorized("apply", "preview-partial-revision-4"), RUN), "unknown|INTERNAL_EFFECT_OUTCOME_UNKNOWN|unknown|false|null|next-action"],
		["row 7 automation", () => decide(fake({}), request("apply", { automation: true }), RUN), "refused|DOMAIN_AUTHORITY_MISSING|unchanged|false|null|next-action"],
		["row 8 repair preview", () => decide(fake({ resource: indexMissing }), request("repair-preview"), RUN), "refused|DOMAIN_REPAIR_REQUIRED|unchanged|false|null|next-action"],
		["row 9 repair", () => decide(fake({ resource: indexMissing, preview: repairPreview() }), authorized("repair", "repair-preview-missing-index"), RUN), "success|null|completed|false|null|next-action"],
		["row 10 retry", () => decide(fake({ resource: indexMissing, preview: repairPreview(), busy: 1 }), authorized("repair-retry"), RUN), "success|null|completed|false|null|next-action"],
		["row 11 handoff", () => decide(fake({ resource: { resource: "demo", revision: 5, status: "healthy", version: 1 }, preview: { ...applyPreview("preview-partial-revision-4"), consumed: true, consumed_by_run: "run-fixture" }, journal: [{ kind: "intent", seq: 1, run: "run-fixture", effect: U, operation: "apply", preview_id: "preview-partial-revision-4" }, { kind: "completed", seq: 2, run: "run-fixture", effect: U, operation: "apply", preview_id: "preview-partial-revision-4", resource_revision: 5 }, { kind: "intent", seq: 3, run: "run-fixture", effect: J, operation: "apply", preview_id: "preview-partial-revision-4" }] }), request("recover"), RUN), "unknown|DOMAIN_RECOVERY_HANDOFF_REQUIRED|unknown|false|null|handoff"],
		["row 12 hostile", () => decide(fake({ resource: new RuntimeRefusal("DOMAIN_PATH_ESCAPE", "escape") }), request("inspect", { statePath: resourceId("../../outside-root-sentinel") }), RUN), "refused|DOMAIN_PATH_ESCAPE|unchanged|false|null|next-action"],
		["row 13 redacted inspect", () => decide(fake({ resource: { resource: "demo", revision: 4, status: "healthy", version: 1, diagnostic_token: "CDS_QI_SECRET_MARKER_REPAIR_LAB" } }), request("inspect-diagnostics", { includeDiagnostics: true }), RUN), "success|null|unchanged|true|null|next-action"],
		["busy without --retry-once", () => decide(fake({ resource: indexMissing, preview: repairPreview(), busy: 1 }), authorized("repair", "repair-preview-missing-index"), RUN), "refused|UNAVAILABLE_STORAGE_BUSY|unchanged|true|25|next-action"],
		["persistent lock with --retry-once", () => decide(fake({ resource: indexMissing, preview: repairPreview(), busy: 2 }), authorized("repair-retry"), RUN), "refused|UNAVAILABLE_STORAGE_BUSY|unchanged|true|25|next-action"],
		["silent no-op", () => decide(fake({ preview: applyPreview(), domain: "silent-no-op" }), authorized("apply", "preview-healthy-revision-4"), RUN), "failed|INTERNAL_EFFECT_NOT_OBSERVED|unknown|false|null|next-action"],
		["recover nothing pending", () => decide(fake({}), request("recover"), RUN), "success|null|unchanged|true|null|next-action"],
		["W1 throw-internal", () => decide(fake({ preview: applyPreview(), domain: "throw-internal" }), authorized("apply", "preview-healthy-revision-4"), RUN), "failed|INTERNAL_UNEXPECTED|unchanged|false|null|next-action"],
	]
	for (const [name, run, expected] of rows) {
		test(name, () => {
			expect(signature(run())).toBe(expected)
		})
	}
	test("row 10 completes after exactly one retry and the second busy probe is not retried again", () => {
		const runtime = fake({ resource: indexMissing, preview: repairPreview(), busy: 1 })
		const decision = decide(runtime, authorized("repair-retry"), RUN)
		expect(decision.result?.retry_count).toBe(1)
		expect(decision.events).toEqual(["repair.started", "repair.transient-refused", "repair.retry-permitted", `${R}.completed`, `${J}.completed`, "repair.completed"])
		expect(runtime.state.busy).toBe(0)
	})
})

describe("refusal precedence (3.5)", () => {
	test("authority (2) precedes preview presence (3): no preview and no authority is DOMAIN_AUTHORITY_MISSING", () => {
		expect(decide(fake({}), request("apply", { previewId: resourceId("x") }), RUN).causeCode).toBe("DOMAIN_AUTHORITY_MISSING")
		expect(decide(fake({}), authorized("apply", "x"), RUN).causeCode).toBe("DOMAIN_PREVIEW_MISSING")
	})
	test("identity binding (4) precedes consumption (5): a mismatched id on a consumed preview is DOMAIN_PREVIEW_MISSING", () => {
		const consumed = { ...applyPreview(), consumed: true, consumed_by_run: "run-x" }
		expect(decide(fake({ preview: consumed }), authorized("apply", "other"), RUN).result?.reason).toBe("mismatch")
		expect(decide(fake({ preview: consumed }), authorized("apply", "preview-healthy-revision-4"), RUN).causeCode).toBe("DOMAIN_PREVIEW_CONSUMED")
	})
	test("consumption (5) precedes staleness (6), staleness precedes route agreement (7)", () => {
		const staleConsumed = { ...applyPreview("preview-stale-revision-4"), consumed: true, consumed_by_run: "run-x" }
		const atFive: Resource = { resource: "demo", revision: 5, status: "healthy", version: 1 }
		expect(decide(fake({ resource: atFive, preview: staleConsumed }), authorized("apply", "preview-stale-revision-4"), RUN).causeCode).toBe("DOMAIN_PREVIEW_CONSUMED")
		expect(decide(fake({ resource: { ...atFive, status: "index-missing" }, preview: applyPreview("preview-stale-revision-4") }), authorized("repair", "preview-stale-revision-4"), RUN).causeCode).toBe("DOMAIN_PREVIEW_STALE")
		expect(decide(fake({ resource: indexMissing, preview: applyPreview() }), authorized("repair", "preview-healthy-revision-4"), RUN).result?.reason).toBe("mismatch")
	})
	test("precondition (8): a repair route with a healthy resource is DOMAIN_REPAIR_NOT_REQUIRED before the storage probe", () => {
		expect(decide(fake({ preview: repairPreview(), busy: 1 }), authorized("repair", "repair-preview-missing-index"), RUN).causeCode).toBe("DOMAIN_REPAIR_NOT_REQUIRED")
		expect(decide(fake({ preview: repairPreview() }), authorized("repair-retry"), RUN).causeCode).toBe("DOMAIN_REPAIR_NOT_REQUIRED")
	})
	test("storage probe (9) precedes expected-effect binding (10) (F6); binding refuses before consumption", () => {
		const runtime = fake({ preview: applyPreview("preview-healthy-revision-4", 4, [U]), busy: 1 })
		expect(decide(runtime, authorized("apply", "preview-healthy-revision-4"), RUN).causeCode).toBe("UNAVAILABLE_STORAGE_BUSY")
		const bound = fake({ preview: applyPreview("preview-healthy-revision-4", 4, [U]) })
		const decision = decide(bound, authorized("apply", "preview-healthy-revision-4"), RUN)
		expect(decision.causeCode).toBe("DOMAIN_PREVIEW_MISSING")
		expect(bound.state.preview?.consumed).toBe(false)
		expect(bound.state.journal).toEqual([])
	})
	test("repair-retry binds by content (B1): an apply-kind preview is a mismatch, a repair preview with the retry plan is bound", () => {
		expect(decide(fake({ resource: indexMissing, preview: applyPreview() }), authorized("repair-retry"), RUN).result?.reason).toBe("mismatch")
		expect(decide(fake({ resource: indexMissing, preview: repairPreview() }), authorized("repair-retry"), RUN).domainOutcome).toBe("success")
	})
	test("ordinary apply and repair reject an omitted preview identity as a mismatch", () => {
		const apply = fake({ preview: applyPreview() })
		expect(decide(apply, authorized("apply"), RUN).result?.reason).toBe("mismatch")
		expect(apply.state.preview?.consumed).toBe(false)
		const repair = fake({ resource: indexMissing, preview: repairPreview() })
		expect(decide(repair, authorized("repair"), RUN).result?.reason).toBe("mismatch")
		expect(repair.state.preview?.consumed).toBe(false)
	})
})

describe("recover scoping (F2)", () => {
	test("completed records of an earlier preview or another run never satisfy the consumed preview's plan", () => {
		const earlier: JournalRecord[] = [
			{ kind: "completed", seq: 2, run: "run-a", effect: U, operation: "apply", preview_id: "preview-healthy-revision-4", resource_revision: 5 },
			{ kind: "completed", seq: 5, run: "run-a", effect: J, operation: "apply", preview_id: "preview-healthy-revision-4", resource_revision: 5 },
			{ kind: "intent", seq: 1, run: "run-b", effect: U, operation: "apply", preview_id: "preview-healthy-revision-5" },
			{ kind: "completed", seq: 2, run: "run-b", effect: U, operation: "apply", preview_id: "preview-healthy-revision-5", resource_revision: 6 },
			{ kind: "intent", seq: 3, run: "run-b", effect: J, operation: "apply", preview_id: "preview-healthy-revision-5" },
		]
		const preview = { ...applyPreview("preview-healthy-revision-5", 5), consumed: true, consumed_by_run: "run-b" }
		const decision = decide(fake({ resource: { resource: "demo", revision: 6, status: "healthy", version: 1 }, preview, journal: earlier }), request("recover"), RUN)
		expect(decision.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(decision.completedEffectIds).toEqual([U])
		expect(decision.remainingEffectIds).toEqual([J])
		const foreignRun = decide(fake({ preview: { ...applyPreview(), consumed: true, consumed_by_run: "run-c" }, journal: earlier }), request("recover"), RUN)
		expect(foreignRun.remainingEffectIds).toEqual([U, J])
	})
	test("an unconsumed or absent preview is nothing pending", () => {
		expect(decide(fake({ preview: applyPreview() }), request("recover"), RUN).result?.result).toBe("nothing-pending")
		expect(decide(fake({}), request("recover"), RUN).result?.result).toBe("nothing-pending")
	})
	test("journal completions are established only when resource revision and repair status agree", () => {
		const completed = (kind: "apply" | "repair", revision: number): JournalRecord[] => {
			const previewId = kind === "apply" ? "preview-healthy-revision-4" : "repair-preview-missing-index"
			const plan = kind === "apply" ? [U, J] : [R, J]
			return plan.map((effect, index) => ({ kind: "completed", seq: index + 1, run: "run-bound", effect, operation: kind, preview_id: previewId, resource_revision: revision }))
		}
		const applyPreviewConsumed = { ...applyPreview(), consumed: true, consumed_by_run: "run-bound" }
		const applyAgrees = decide(fake({ resource: { resource: "demo", revision: 5, status: "healthy", version: 1 }, preview: applyPreviewConsumed, journal: completed("apply", 5) }), request("recover"), RUN)
		expect(applyAgrees.result?.result).toBe("nothing-pending")
		const applyDisagrees = decide(fake({ resource: { resource: "demo", revision: 4, status: "healthy", version: 1 }, preview: applyPreviewConsumed, journal: completed("apply", 5) }), request("recover"), RUN)
		expect(applyDisagrees.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(applyDisagrees.completedEffectIds).toEqual([])
		expect(applyDisagrees.remainingEffectIds).toEqual([U, J])
		const repairPreviewConsumed = { ...repairPreview(), consumed: true, consumed_by_run: "run-bound" }
		const repairDisagrees = decide(fake({ resource: { resource: "demo", revision: 5, status: "index-missing", version: 1 }, preview: repairPreviewConsumed, journal: completed("repair", 5) }), request("recover"), RUN)
		expect(repairDisagrees.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(repairDisagrees.completedEffectIds).toEqual([])
		expect(repairDisagrees.remainingEffectIds).toEqual([R, J])
	})
})

describe("facts and redaction", () => {
	test("factsOf carries the decision's outcome, state, effect ids and guidance", () => {
		const decision = decide(fake({ preview: applyPreview("preview-partial-revision-4"), domain: "effect.write-journal-outcome-unknown" }), authorized("apply", "preview-partial-revision-4"), RUN)
		expect(factsOf(decision, RUN)).toEqual({ commandIdentity: "repair-lab.apply", runIdentity: RUN, domainOutcome: "unknown", effectClass: "repository-local", transactionState: "unknown", completedEffectIds: [U], remainingEffectIds: [J], stationLabel: "repair-lab.partial-unknown", guidance: { kind: "next-action", target: "repair-lab recover" } })
	})
	test("redactJson replaces secret-like keys at any depth and reports them", () => {
		const redacted: string[] = []
		const output = redactJson({ ok: 1, diagnostic_token: "x", nested: { api_key: "y", list: [{ password: "z" }, 2] } }, redacted)
		expect(output).toEqual({ ok: 1, diagnostic_token: "[REDACTED]", nested: { api_key: "[REDACTED]", list: [{ password: "[REDACTED]" }, 2] } })
		expect(redacted).toEqual(["diagnostic_token", "api_key", "password"])
		expect(FIXTURE_AUTHORITY).toBe("fixture-authority")
	})
})
