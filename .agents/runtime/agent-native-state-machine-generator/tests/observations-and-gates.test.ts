import { describe, expect, test } from 'bun:test'
import {
	attemptWindowMs,
	compileSpecificationCandidate,
	type DiagnosticCause,
	isObservationExpired,
	isPollUseful,
	type ObservationBudget,
	type ObservationProgress,
} from '../src/index.ts'

/**
 * Wait semantics (ADR 0002) and the two declared gates (ADR 0003).
 *
 * A candidate declares how long an Attempt may be observed; what that bound
 * anchors to is the ruling's and lives in `observation-budgets.ts`. The
 * expiry binds to one Attempt, a new Attempt gets a fresh bound, and neither
 * polling nor a heartbeat renews one, so a product cannot turn a heartbeat
 * into a renewal by declaring it that way.
 *
 * Capability Availability is an installed-surface fact that routes when it is
 * absent, and a Pause Mode is externally owned, so its release is a request a
 * human answers rather than something the product clears itself.
 */

const V2_DIR = new URL('../fixtures/v2/', import.meta.url)

async function compileV2(name: string) {
	return compileSpecificationCandidate(
		await Bun.file(new URL(`${name}.jsonc`, V2_DIR)).text(),
		{ sourcePath: `${name}.jsonc` },
	)
}

/**
 * Deliberate independent oracle: the ruled budgets restated as literals -
 * five-second poll-after, ten-minute per-Attempt expiry - rather than read
 * back from the fixture the assertions are about.
 */
const RULED_POLL_AFTER_MS = 5000
const RULED_ATTEMPT_EXPIRY_MS = 600000

const BUDGET: ObservationBudget = {
	name: 'work_task',
	pollAfterMs: RULED_POLL_AFTER_MS,
	attemptExpiryMs: RULED_ATTEMPT_EXPIRY_MS,
	wakeRoute: 'caller_reinvocation',
	missedDeadlineCause: 'work_observation_expired',
}

function progress(over: Partial<ObservationProgress>): ObservationProgress {
	return {
		elapsedMs: 0,
		heartbeatObserved: false,
		pollCount: 0,
		...over,
	}
}

const DECLARED_EVIDENCE_REFUSALS: ReadonlyArray<{
	readonly fixture: string
	readonly cause: DiagnosticCause
	readonly claim: string
}> = [
	{
		fixture: 'waits-unknown-expiry-cause',
		cause: 'semantic_unresolved_reference',
		claim: 'an expiry cause no blocker declares lands in an unnamed state',
	},
	{
		fixture: 'waits-no-route-vocabulary',
		cause: 'semantic_incomplete_projection',
		claim: 'observations with no declared route vocabulary accept any text',
	},
	{
		fixture: 'waits-unknown-wake-route',
		cause: 'semantic_unresolved_reference',
		claim: 'a Wake Route absent from the declared vocabulary is a typo',
	},
	{
		fixture: 'capability-unroutable',
		// Structural, not semantic: both routes are now required fields, so a
		// capability declaring neither is refused before semantic validation
		// runs. The old shape made them required only once an author wrote
		// `available: false`, which is why the same fixture used to reach the
		// semantic check.
		cause: 'structure_missing_required',
		claim: 'a capability routing nowhere selects nothing when it is absent',
	},
	{
		fixture: 'capability-unknown-route',
		cause: 'semantic_unresolved_reference',
		claim: 'a capability route to an undeclared action invents a route',
	},
	{
		fixture: 'pause-release-not-human-owned',
		cause: 'semantic_missing_authority_semantics',
		claim: 'a non-human release would clear an externally owned gate',
	},
	{
		fixture: 'pause-unknown-owner',
		cause: 'semantic_unresolved_reference',
		claim: 'a Pause owner absent from external_owners is unnamed',
	},
	{
		fixture: 'pause-release-wrong-owner',
		cause: 'semantic_missing_authority_semantics',
		claim: 'a release owned by another party never reaches this gate owner',
	},
]

/**
 * Deliberately unenforced: whether two observations may share a
 * missed-deadline cause.
 *
 * The recorded ruling split two specific causes because those carry distinct
 * lifecycles and repairs. It did not rule that every pair of observations
 * must differ, and the schema declares no semantic ownership that would let
 * a candidate say which observations belong to distinct lifecycles. Deriving
 * the rule from observation names would infer product meaning, so the
 * distinction stays with candidate authoring and admission.
 */

describe('an observation declares every field a caller needs', () => {
	test('the valid candidate carries both declared observations', async () => {
		const result = await compileV2('declared-surfaces')

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.ir.observations.map((row) => row.name)).toEqual([
			'doctor_task',
			'work_task',
		])
		for (const row of result.ir.observations) {
			// Required by shape, asserted here so the requirement is visible at
			// the boundary rather than only in the schema.
			expect({
				name: row.name,
				hasRoute: (row.wakeRoute ?? '').length > 0,
				hasCause: (row.missedDeadlineCause ?? '').length > 0,
			}).toEqual({ name: row.name, hasRoute: true, hasCause: true })
		}
	})

	test('omitting the Wake Route is refused', async () => {
		const source = (
			await Bun.file(new URL('declared-surfaces.jsonc', V2_DIR)).text()
		).replace('\t\t\t\t"wake_route": "caller_reinvocation",\n', '')

		const result = compileSpecificationCandidate(source)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'structure_missing_required',
		])
	})

	test('omitting the missed-deadline cause is refused', async () => {
		const source = (
			await Bun.file(new URL('declared-surfaces.jsonc', V2_DIR)).text()
		).replace(
			'\t\t\t\t"missed_deadline_cause": "work_observation_expired",\n',
			'',
		)

		const result = compileSpecificationCandidate(source)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'structure_missing_required',
		])
	})
})

describe('an Attempt owns its observation window', () => {
	test('the window is the declared bound, so a new Attempt starts fresh', () => {
		expect(attemptWindowMs(BUDGET)).toBe(RULED_ATTEMPT_EXPIRY_MS)
	})

	test('a fresh Attempt is unexpired however long an earlier one ran', () => {
		// A new Attempt is asked about with its own elapsed time, so an earlier
		// Attempt exhausting its window says nothing about this one. Binding
		// elapsedMs to the right Attempt is the caller's job; nothing here
		// detects evidence mislabelled as another Attempt's.
		const exhausted = progress({ elapsedMs: RULED_ATTEMPT_EXPIRY_MS })
		const fresh = progress({ elapsedMs: 10 })

		expect(isObservationExpired(BUDGET, exhausted)).toBe(true)
		expect(isObservationExpired(BUDGET, fresh)).toBe(false)
	})

	test('a heartbeat never renews the window', () => {
		const expired = progress({ elapsedMs: RULED_ATTEMPT_EXPIRY_MS })

		// Same elapsed time, heartbeat or not: evidence that work advances is
		// not evidence that the observation window reopened.
		expect(isObservationExpired(BUDGET, expired)).toBe(true)
		expect(
			isObservationExpired(BUDGET, { ...expired, heartbeatObserved: true }),
		).toBe(true)
	})

	test('polling never renews the window', () => {
		const expired = progress({ elapsedMs: RULED_ATTEMPT_EXPIRY_MS })

		for (const pollCount of [1, 5, 100]) {
			expect({
				pollCount,
				expired: isObservationExpired(BUDGET, { ...expired, pollCount }),
			}).toEqual({ pollCount, expired: true })
		}
	})

	test('observing again is useful only after poll-after and before expiry', () => {
		expect(isPollUseful(BUDGET, progress({ elapsedMs: 0 }))).toBe(false)
		expect(
			isPollUseful(BUDGET, progress({ elapsedMs: RULED_POLL_AFTER_MS })),
		).toBe(true)
		// Past expiry a poll returns nothing safe, however long since the last.
		expect(
			isPollUseful(BUDGET, progress({ elapsedMs: RULED_ATTEMPT_EXPIRY_MS })),
		).toBe(false)
	})
})

describe('the declared gates carry their ruled meanings', () => {
	test('an unavailable capability routes to an operator-owned escalation', async () => {
		const result = await compileV2('declared-surfaces')
		expect(result.ok).toBe(true)
		if (!result.ok) return

		const capability = result.ir.capabilities[0]
		expect(capability).toBeDefined()
		if (capability === undefined) return
		// No current value is carried: availability is runtime evidence a
		// Liveness Evidence Provider supplies against this binding.
		expect(capability.availabilityEvidence.length).toBeGreaterThan(0)
		expect(capability.unavailableBlocker).toBe('capability_missing')

		// The route lands on a needs_human action, which is what "operator-owned
		// validation escalation" means rather than a retry the product runs.
		const action = result.ir.actions.catalog.find(
			(row) => row.id === capability.unavailableAction,
		)
		expect(action).toBeDefined()
		expect(action?.kind).toBe('needs_human')
	})

	test('a Pause Mode derives a request for release, never a clear', async () => {
		const result = await compileV2('declared-surfaces')
		expect(result.ok).toBe(true)
		if (!result.ok) return

		const pause = result.ir.pauseModes[0]
		expect(pause).toBeDefined()
		if (pause === undefined) return

		const release = result.ir.actions.catalog.find(
			(row) => row.id === pause.releaseAction,
		)
		expect(release).toBeDefined()
		if (release === undefined) return
		// needs_human is the whole point: the gate is externally owned, so the
		// specification can ask its owner and can never clear it itself.
		expect(release.kind).toBe('needs_human')
		expect(release.humanKind).toBe('owner_release')
		expect(pause.owner).toBe('product_owner')
	})
})

describe('an unusable gate or observation declaration is refused', () => {
	test('the refusal registry is non-empty', () => {
		expect(DECLARED_EVIDENCE_REFUSALS.length).toBeGreaterThan(0)
	})

	for (const { fixture, cause, claim } of DECLARED_EVIDENCE_REFUSALS) {
		test(`${fixture}: ${claim}`, async () => {
			const result = await compileV2(fixture)

			expect({ fixture, ok: result.ok }).toEqual({ fixture, ok: false })
			if (result.ok) return
			expect(result).not.toHaveProperty('ir')
			expect(result).not.toHaveProperty('digest')
			expect({
				fixture,
				causes: [...new Set(result.diagnostics.map((item) => item.cause))],
			}).toEqual({ fixture, causes: [cause] })
			expect(result.diagnostics[0]?.location.line).toBeGreaterThan(0)
		})
	}
})
