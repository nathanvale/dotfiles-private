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

	test('emit_expectation_action_unknown stays unreachable by plain IR amendment (pinned)', async () => {
		// The catalog lookup and the action resolution read the same
		// `ir.actions.catalog`, so a resolved action id is always found again;
		// the guard behind this cause cannot fire through the derivation seam.
		// The nearest amendment is refused one step earlier, and the
		// member-for-member check above holds the unproducible list to exactly
		// this cause. A src repair that makes the lookup missable must register
		// a real producer and remove this pin.
		expect(UNPRODUCIBLE_REFUSAL_CAUSES).toEqual([
			'emit_expectation_action_unknown',
		])
		const observed = await attemptExpectationActionUnknown()
		expect(observed.length).toBeGreaterThan(0)
		expect([...new Set(observed.map((refusal) => refusal.cause))]).toEqual([
			'emit_expectation_column_underivable',
		])
	})
})
