import { describe, expect, test } from 'bun:test'
import { ARTIFACT_REFUSAL_CAUSES, DIAGNOSTIC_CAUSES } from '../src/index.ts'
import { NEGATIVE_FIXTURE_CASES } from './support/negative-cases.ts'
import {
	attemptExpectationActionUnknown,
	isUnproducibleRefusalCause,
	REFUSAL_CAUSE_PRODUCERS,
	UNPRODUCIBLE_REFUSAL_CAUSES,
} from './support/refusal-producers.ts'

/**
 * The sealed-cause iteration the package standards demand: iterate each
 * sealed cause list and fail on any member no fixture reaches, so per-cause
 * coverage is checked by the suite rather than by a reviewer's memory.
 *
 * Boundary: this file covers the two per-cause-fixture vocabularies,
 * DIAGNOSTIC_CAUSES (negative fixtures, each proven one by one in
 * compile-negative.test.ts) and ARTIFACT_REFUSAL_CAUSES (producers at the
 * real derivation and reconciliation seams). The generation and drift
 * vocabularies are exercised by generation-mechanics.test.ts.
 */

describe('every sealed diagnostic cause has a registered negative fixture', () => {
	test('the sealed list and the fixture registry are non-empty', () => {
		expect(DIAGNOSTIC_CAUSES.length).toBeGreaterThan(0)
		expect(NEGATIVE_FIXTURE_CASES.length).toBeGreaterThan(0)
	})

	for (const cause of DIAGNOSTIC_CAUSES) {
		test(`${cause} is reached by a negative fixture`, () => {
			const rows = NEGATIVE_FIXTURE_CASES.filter((row) => row.cause === cause)
			expect({ cause, covered: rows.length > 0 }).toEqual({
				cause,
				covered: true,
			})
		})
	}
})

describe('every sealed artifact refusal cause is observed at its real seam', () => {
	test('the producer registry covers the sealed list member for member', () => {
		expect(ARTIFACT_REFUSAL_CAUSES.length).toBeGreaterThan(0)
		const covered = [
			...Object.keys(REFUSAL_CAUSE_PRODUCERS),
			...UNPRODUCIBLE_REFUSAL_CAUSES,
		].sort()
		expect(covered).toEqual([...ARTIFACT_REFUSAL_CAUSES].sort())
	})

	for (const cause of ARTIFACT_REFUSAL_CAUSES) {
		if (isUnproducibleRefusalCause(cause)) continue
		test(`${cause} is raised by its producer`, async () => {
			const observed = await REFUSAL_CAUSE_PRODUCERS[cause]()
			expect(observed.length).toBeGreaterThan(0)
			// Co-firing causes are acceptable here; exactness belongs to the
			// focused per-cause tests. The target must be among the observed
			// refusals, and each observed instance names its subject.
			expect({
				cause,
				reached: observed.some((refusal) => refusal.cause === cause),
			}).toEqual({ cause, reached: true })
			for (const refusal of observed) {
				if (refusal.cause !== cause) continue
				expect(refusal.subject.length).toBeGreaterThan(0)
				expect(refusal.message.length).toBeGreaterThan(0)
			}
		})
	}

	test('every sealed cause has a live producer, none is pinned unproducible', () => {
		// This list was non-empty while `emit_expectation_action_unknown` was
		// believed unreachable. Input Schema v2's routing bindings supply an
		// action target directly, so that guard now has a real producer and
		// the list is empty. A cause added without one belongs here with an
		// argument, not silently skipped.
		expect(UNPRODUCIBLE_REFUSAL_CAUSES).toEqual([])
	})

	test('removing an action from the catalog still refuses one step earlier', async () => {
		// The amendment that used to be the nearest attempt at
		// `emit_expectation_action_unknown`. It still refuses earlier, which
		// is why a second producer was needed to reach the guard: action
		// resolution and the catalog lookup do read the same catalog, and only
		// a routing target bypasses that.
		const observed = await attemptExpectationActionUnknown()
		expect(observed.length).toBeGreaterThan(0)
		expect([...new Set(observed.map((refusal) => refusal.cause))]).toEqual([
			'emit_expectation_column_underivable',
		])
	})
})
