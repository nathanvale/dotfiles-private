import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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
	// O1 Candidate A scan facts: a torn tail or an over-bound scan, and a post-consumption refusal witness.
	torn: boolean
	exceedsScanBound: boolean
	refuseAfterConsume: boolean
}

// The fake's byte convention: a resource serializes as JSON.stringify without a newline; digests are the test's own.
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")
const resourceDigest = (resource: Resource): string => digest(JSON.stringify(resource))
const eventPayload = (kind: string, seq: number, run: string, previewId: string): string => JSON.stringify({ kind: "event", seq, run, effect: J, operation: kind, preview_id: previewId, summary: "event" })

function fake(overrides: Partial<State>): Runtime & { state: State } {
	const state: State = { resource: { resource: "demo", revision: 4, status: "healthy", version: 1 }, preview: null, journal: [], busy: 0, domain: null, torn: false, exceedsScanBound: false, refuseAfterConsume: false, ...overrides }
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
		acquireJournalLock: () => () => {},
		admitStatePaths: () => {},
		readJournal: () => ({ entries: state.journal.map((record) => ({ record, payloadSha256: digest(JSON.stringify(record)) })), torn: state.torn, exceedsScanBound: state.exceedsScanBound }),
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
			if (state.refuseAfterConsume) throw new RuntimeRefusal("SCHEMA_STATE_INVALID", "resource does not match the resource schema")
			const current = resource()
			const intentSeq = seq()
			const next: Resource = effectId === R ? { ...current, status: "healthy", revision: current.revision + 1 } : { ...current, revision: current.revision + 1 }
			const eventSeq = effectId === J ? seq() : 0
			const expectedAfter = effectId === J ? digest(eventPayload(operation, eventSeq, runIdentity, previewId)) : resourceDigest(next)
			state.journal.push({ kind: "intent", seq: intentSeq, run: runIdentity, effect: effectId, operation, preview_id: previewId, before_sha256: effectId === J ? null : resourceDigest(current), expected_after_sha256: expectedAfter })
			facts.intentRecorded.push(effectId)
			if (effectId === J && state.domain === "effect.write-journal-outcome-unknown") return "unknown"
			if (state.domain === "silent-no-op") return "not-observed"
			if (effectId === J) state.journal.push({ kind: "event", seq: eventSeq, run: runIdentity, effect: effectId, operation, preview_id: previewId, summary: "event" })
			else state.resource = next
			state.journal.push({ kind: "completed", seq: seq(), run: runIdentity, effect: effectId, operation, preview_id: previewId, resource_revision: resource().revision, observed_after_sha256: expectedAfter })
			facts.completed.push(effectId)
			return "completed"
		},
		diagnosticsRoot: () => "/fake/diagnostics",
	}
}

// Test-authored frames of one run's records under the fake's byte convention (independent of the engine's classifier).
const REV4: Resource = { resource: "demo", revision: 4, status: "healthy", version: 1 }
const REV5: Resource = { resource: "demo", revision: 5, status: "healthy", version: 1 }
const intentOf = (effect: EffectId, seq: number, run: string, previewId: string, kind: "apply" | "repair", before: Resource, after: Resource): JournalRecord => (effect === J ? { kind: "intent", seq, run, effect, operation: kind, preview_id: previewId, before_sha256: null, expected_after_sha256: digest(eventPayload(kind, seq + 1, run, previewId)) } : { kind: "intent", seq, run, effect, operation: kind, preview_id: previewId, before_sha256: resourceDigest(before), expected_after_sha256: resourceDigest(after) })
const completedOf = (effect: EffectId, seq: number, run: string, previewId: string, kind: "apply" | "repair", after: Resource): JournalRecord => ({ kind: "completed", seq, run, effect, operation: kind, preview_id: previewId, resource_revision: after.revision, observed_after_sha256: effect === J ? digest(eventPayload(kind, seq - 1, run, previewId)) : resourceDigest(after) })
const eventOf = (seq: number, run: string, previewId: string, kind: "apply" | "repair"): JournalRecord => ({ kind: "event", seq, run, effect: J, operation: kind, preview_id: previewId, summary: "event" })

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
		// Row 11 under D3: the second effect's event frame is torn, so it is uncertain from the valid prefix.
		["row 11 handoff", () => decide(fake({ resource: REV5, preview: { ...applyPreview("preview-partial-revision-4"), consumed: true, consumed_by_run: "run-fixture" }, journal: [intentOf(U, 1, "run-fixture", "preview-partial-revision-4", "apply", REV4, REV5), completedOf(U, 2, "run-fixture", "preview-partial-revision-4", "apply", REV5), intentOf(J, 3, "run-fixture", "preview-partial-revision-4", "apply", REV5, REV5)], torn: true }), request("recover"), RUN), "unknown|DOMAIN_RECOVERY_HANDOFF_REQUIRED|unknown|false|null|handoff"],
		// O1 Candidate A rows: known partial completion, the scan bound and the prior-run refusal.
		["partial handoff", () => decide(fake({ resource: REV5, preview: { ...applyPreview("preview-partial-revision-4"), consumed: true, consumed_by_run: "run-fixture" }, journal: [intentOf(U, 1, "run-fixture", "preview-partial-revision-4", "apply", REV4, REV5), intentOf(J, 3, "run-fixture", "preview-partial-revision-4", "apply", REV5, REV5)] }), request("recover"), RUN), "failed|DOMAIN_RECOVERY_PARTIAL_HANDOFF|partially-completed|false|null|handoff"],
		["journal limit on apply", () => decide(fake({ preview: applyPreview(), exceedsScanBound: true }), authorized("apply", "preview-healthy-revision-4"), RUN), "refused|DOMAIN_JOURNAL_LIMIT_REACHED|unchanged|false|null|next-action"],
		["journal limit on preview", () => decide(fake({ exceedsScanBound: true }), request("preview"), RUN), "refused|DOMAIN_JOURNAL_LIMIT_REACHED|unchanged|false|null|next-action"],
		["prior run pending on preview", () => decide(fake({ resource: REV5, preview: { ...applyPreview("preview-partial-revision-4"), consumed: true, consumed_by_run: "run-fixture" }, journal: [intentOf(U, 1, "run-fixture", "preview-partial-revision-4", "apply", REV4, REV5)] }), request("preview"), RUN), "refused|DOMAIN_PRIOR_RUN_PENDING|unchanged|false|null|handoff"],
		["torn tail blocks a writer as schema", () => decide(fake({ preview: applyPreview(), torn: true }), authorized("apply", "preview-healthy-revision-4"), RUN), "refused|SCHEMA_STATE_INVALID|unchanged|false|null|next-action"],
		["torn tail is tolerated by status", () => decide(fake({ torn: true }), request("status"), RUN), "success|null|unchanged|true|null|next-action"],
		["post-consumption RuntimeRefusal is W2", () => decide(fake({ preview: applyPreview(), refuseAfterConsume: true }), authorized("apply", "preview-healthy-revision-4"), RUN), "failed|INTERNAL_EFFECT_OUTCOME_UNKNOWN|unknown|false|null|next-action"],
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

describe("recover scoping and observation (F2, O1 A6)", () => {
	const P4 = "preview-healthy-revision-4"
	const P5 = "preview-healthy-revision-5"
	const REV6: Resource = { resource: "demo", revision: 6, status: "healthy", version: 1 }
	test("records of an earlier preview or another run never satisfy the consumed preview's plan", () => {
		const earlier: JournalRecord[] = [
			completedOf(U, 2, "run-a", P4, "apply", REV5),
			completedOf(J, 5, "run-a", P4, "apply", REV5),
			intentOf(U, 1, "run-b", P5, "apply", REV5, REV6),
			completedOf(U, 2, "run-b", P5, "apply", REV6),
			intentOf(J, 3, "run-b", P5, "apply", REV6, REV6),
		]
		const preview = { ...applyPreview(P5, 5), consumed: true, consumed_by_run: "run-b" }
		// run-b's first effect is at its expected bytes and its second has an intent but no event under a complete scan.
		const decision = decide(fake({ resource: REV6, preview, journal: earlier }), request("recover"), RUN)
		expect(decision.causeCode).toBe("DOMAIN_RECOVERY_PARTIAL_HANDOFF")
		expect(decision.completedEffectIds).toEqual([U])
		expect(decision.remainingEffectIds).toEqual([J])
		// A consumed preview whose run left no frames at all, under a complete scan, was never applied.
		const foreignRun = decide(fake({ preview: { ...applyPreview(), consumed: true, consumed_by_run: "run-c" }, journal: earlier }), request("recover"), RUN)
		expect(foreignRun.result?.result).toBe("nothing-pending")
		expect(foreignRun.result?.not_applied_effect_ids).toEqual([U, J])
		expect(foreignRun.result?.consumed_preview_id).toBe(P4)
	})
	test("an unconsumed or absent preview is nothing pending", () => {
		expect(decide(fake({ preview: applyPreview() }), request("recover"), RUN).result?.result).toBe("nothing-pending")
		expect(decide(fake({}), request("recover"), RUN).result?.result).toBe("nothing-pending")
	})
	test("bookkeeping never establishes an effect: resource bytes and the event frame do", () => {
		const consumed = { ...applyPreview(), consumed: true, consumed_by_run: "run-bound" }
		const frames = (event: boolean): JournalRecord[] => [intentOf(U, 1, "run-bound", P4, "apply", REV4, REV5), completedOf(U, 2, "run-bound", P4, "apply", REV5), intentOf(J, 3, "run-bound", P4, "apply", REV5, REV5), ...(event ? [eventOf(4, "run-bound", P4, "apply")] : []), completedOf(J, 5, "run-bound", P4, "apply", REV5)]
		const established = decide(fake({ resource: REV5, preview: consumed, journal: frames(true) }), request("recover"), RUN)
		expect(established.result?.result).toBe("nothing-pending")
		expect(established.result?.observed_completed_effect_ids).toEqual([U, J])
		const claimedOnly = decide(fake({ resource: REV5, preview: consumed, journal: frames(false) }), request("recover"), RUN)
		expect(claimedOnly.causeCode).toBe("DOMAIN_RECOVERY_PARTIAL_HANDOFF")
		expect(claimedOnly.completedEffectIds).toEqual([U])
		expect(claimedOnly.remainingEffectIds).toEqual([J])
		const preImage = decide(fake({ resource: REV4, preview: consumed, journal: frames(false) }), request("recover"), RUN)
		expect(preImage.result?.result).toBe("nothing-pending")
		expect(preImage.result?.not_applied_effect_ids).toEqual([U, J])
		const neither = decide(fake({ resource: REV6, preview: consumed, journal: frames(true) }), request("recover"), RUN)
		expect(neither.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(neither.completedEffectIds).toEqual([J])
		expect(neither.remainingEffectIds).toEqual([U])
		const duplicated = decide(fake({ resource: REV5, preview: consumed, journal: [...frames(true), intentOf(U, 9, "run-bound", P4, "apply", REV4, REV5)] }), request("recover"), RUN)
		expect(duplicated.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(duplicated.remainingEffectIds).toEqual([U])
	})
	test("an incomplete scan hands off with an incomplete inventory; a torn tail keeps the prefix's proof", () => {
		const consumed = { ...applyPreview(), consumed: true, consumed_by_run: "run-bound" }
		const overBound = decide(fake({ resource: REV5, preview: consumed, journal: [intentOf(U, 1, "run-bound", P4, "apply", REV4, REV5)], exceedsScanBound: true }), request("recover"), RUN)
		expect(overBound.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(overBound.inventoryComplete).toBe(false)
		expect(overBound.completedEffectIds).toEqual([U])
		expect(overBound.remainingEffectIds).toEqual([J])
		const tornBookkeeping = decide(fake({ resource: REV5, preview: consumed, journal: [intentOf(U, 1, "run-bound", P4, "apply", REV4, REV5), intentOf(J, 3, "run-bound", P4, "apply", REV5, REV5), eventOf(4, "run-bound", P4, "apply")], torn: true }), request("recover"), RUN)
		expect(tornBookkeeping.result?.result).toBe("nothing-pending")
		expect(tornBookkeeping.inventoryComplete).toBe(true)
		const tornBeforeIntent = decide(fake({ resource: REV5, preview: consumed, journal: [intentOf(U, 1, "run-bound", P4, "apply", REV4, REV5)], torn: true }), request("recover"), RUN)
		expect(tornBeforeIntent.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(tornBeforeIntent.inventoryComplete).toBe(true)
		expect(tornBeforeIntent.remainingEffectIds).toEqual([J])
	})
	test("prior-run pending follows authority and precedes preview identity binding; a resolved plan does not block", () => {
		const unresolved = { ...applyPreview("preview-partial-revision-4"), consumed: true, consumed_by_run: "run-fixture" }
		const journal = [intentOf(U, 1, "run-fixture", "preview-partial-revision-4", "apply", REV4, REV5)]
		expect(decide(fake({ resource: REV5, preview: unresolved, journal }), request("apply", { previewId: resourceId("other") }), RUN).causeCode).toBe("DOMAIN_AUTHORITY_MISSING")
		expect(decide(fake({ resource: REV5, preview: unresolved, journal }), authorized("apply", "other"), RUN).causeCode).toBe("DOMAIN_PRIOR_RUN_PENDING")
		expect(decide(fake({ resource: REV5, preview: unresolved, journal }), authorized("repair-retry"), RUN).causeCode).toBe("DOMAIN_PRIOR_RUN_PENDING")
		expect(decide(fake({ resource: REV5, preview: unresolved, journal }), request("repair-preview"), RUN).causeCode).toBe("DOMAIN_PRIOR_RUN_PENDING")
		const resolved = fake({ resource: REV4, preview: unresolved, journal })
		expect(decide(resolved, request("preview"), RUN).domainOutcome).toBe("success")
		expect(resolved.state.preview?.consumed).toBe(false)
		expect(decide(fake({ resource: REV5, preview: { ...applyPreview(), consumed: true, consumed_by_run: "run-fixture" }, journal: [] }), authorized("apply", "preview-healthy-revision-4"), RUN).causeCode).toBe("DOMAIN_PREVIEW_CONSUMED")
	})
})

describe("facts and redaction", () => {
	test("factsOf carries the decision's outcome, state, effect ids and guidance", () => {
		const decision = decide(fake({ preview: applyPreview("preview-partial-revision-4"), domain: "effect.write-journal-outcome-unknown" }), authorized("apply", "preview-partial-revision-4"), RUN)
		expect(factsOf(decision, RUN)).toEqual({ commandIdentity: "repair-lab.apply", runIdentity: RUN, domainOutcome: "unknown", effectClass: "repository-local", transactionState: "unknown", completedEffectIds: [U], remainingEffectIds: [J], inventoryComplete: true, stationLabel: "repair-lab.partial-unknown", guidance: { kind: "next-action", target: "repair-lab recover" } })
	})
	test("redactJson replaces secret-like keys at any depth and reports them", () => {
		const redacted: string[] = []
		const output = redactJson({ ok: 1, diagnostic_token: "x", nested: { api_key: "y", list: [{ password: "z" }, 2] } }, redacted)
		expect(output).toEqual({ ok: 1, diagnostic_token: "[REDACTED]", nested: { api_key: "[REDACTED]", list: [{ password: "[REDACTED]" }, 2] } })
		expect(redacted).toEqual(["diagnostic_token", "api_key", "password"])
		expect(FIXTURE_AUTHORITY).toBe("fixture-authority")
	})
})
