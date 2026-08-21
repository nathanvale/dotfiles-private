import { describe, expect, test } from 'bun:test'
import { INPUT_SCHEMA_V1_SHAPE } from '../src/input-schema-v1.ts'
import type { Shape } from '../src/schema.ts'
import { addedPaths } from '../src/schema-difference.ts'

/**
 * The version-custody delta sees every route by which surface can be added.
 *
 * These perturb the SHAPES rather than the declared path list: a guard that
 * only compares two hand-kept lists proves they agree with each other, which
 * is not the claim. Each case adds one field through a different composite
 * shape and asserts the delta names it, so "a forgotten surface fails loudly"
 * is a demonstrated property rather than a header comment.
 */

const leaf: Shape = { t: 'string' }

function objectOf(fields: Record<string, Shape>): Shape {
	return { t: 'object', fields, required: [] }
}

describe('the delta reports surface added through every composite shape', () => {
	test('a new object field', () => {
		const frozen = objectOf({ kept: leaf })
		const current = objectOf({ kept: leaf, added: leaf })

		expect(addedPaths(frozen, current)).toEqual(['added'])
	})

	test('a new field nested under an object field', () => {
		const frozen = objectOf({ outer: objectOf({ kept: leaf }) })
		const current = objectOf({ outer: objectOf({ kept: leaf, added: leaf }) })

		expect(addedPaths(frozen, current)).toEqual(['outer.added'])
	})

	test('a new field under a map value', () => {
		const frozen = objectOf({
			states: { t: 'map', of: objectOf({ kept: leaf }) },
		})
		const current = objectOf({
			states: { t: 'map', of: objectOf({ kept: leaf, added: leaf }) },
		})

		// The key is product-named, so the path stands for every key rather
		// than naming one.
		expect(addedPaths(frozen, current)).toEqual(['states.*.added'])
	})

	test('a new field under an array item', () => {
		const frozen = objectOf({
			transitions: { t: 'array', of: objectOf({ kept: leaf }) },
		})
		const current = objectOf({
			transitions: { t: 'array', of: objectOf({ kept: leaf, added: leaf }) },
		})

		expect(addedPaths(frozen, current)).toEqual(['transitions[].added'])
	})

	test('a new field inside a union arm', () => {
		const frozen = objectOf({
			policy: { t: 'union', of: [leaf, objectOf({ kept: leaf })] },
		})
		const current = objectOf({
			policy: { t: 'union', of: [leaf, objectOf({ kept: leaf, added: leaf })] },
		})

		expect(addedPaths(frozen, current)).toEqual(['policy|1.added'])
	})

	test('a whole new union arm', () => {
		const frozen = objectOf({ policy: { t: 'union', of: [leaf] } })
		const current = objectOf({
			policy: { t: 'union', of: [leaf, objectOf({ added: leaf })] },
		})

		expect(addedPaths(frozen, current)).toEqual(['policy|1'])
	})

	test('a scalar replaced by an object carrying new keys', () => {
		const frozen = objectOf({ entry: leaf })
		const current = objectOf({ entry: objectOf({ script: leaf, note: leaf }) })

		// The frozen version accepted one value here; the current one accepts a
		// structure, so every key it carries is added surface.
		expect(addedPaths(frozen, current)).toEqual(['entry.note', 'entry.script'])
	})

	test('a map value replaced by a deeper map still reports its new field', () => {
		const frozen = objectOf({
			budgets: { t: 'map', of: { t: 'array', of: objectOf({ kept: leaf }) } },
		})
		const current = objectOf({
			budgets: {
				t: 'map',
				of: { t: 'array', of: objectOf({ kept: leaf, added: leaf }) },
			},
		})

		expect(addedPaths(frozen, current)).toEqual(['budgets.*[].added'])
	})
})

describe('the delta reports nothing when nothing was added', () => {
	test('identical shapes differ nowhere', () => {
		expect(addedPaths(INPUT_SCHEMA_V1_SHAPE, INPUT_SCHEMA_V1_SHAPE)).toEqual([])
	})

	test('a removed field is not reported as added', () => {
		const frozen = objectOf({ kept: leaf, dropped: leaf })
		const current = objectOf({ kept: leaf })

		// Directional: this answers what the current shape added, and a
		// removal is a different question the guard does not ask.
		expect(addedPaths(frozen, current)).toEqual([])
	})

	test('a widened enum is a value change, not a new path', () => {
		const frozen = objectOf({ mode: { t: 'string', enum: ['a'] } })
		const current = objectOf({ mode: { t: 'string', enum: ['a', 'b'] } })

		// Deliberately uncovered here: a leaf carries no nested surface, so a
		// widened vocabulary belongs to the version's own validation rather
		// than to this structural delta.
		expect(addedPaths(frozen, current)).toEqual([])
	})
})
