import { describe, expect, test } from 'bun:test'
import { compileSpecificationCandidate } from '../src/index.ts'
import { readNegativeFixture } from './support/candidates.ts'
import { NEGATIVE_FIXTURE_CASES } from './support/negative-cases.ts'

/**
 * Every registered negative fixture really produces its one cause. The
 * registry itself lives in tests/support/negative-cases.ts, where the
 * sealed-cause-coverage suite holds it complete against DIAGNOSTIC_CAUSES.
 */
describe('invalid candidates are refused fail-closed', () => {
	test('the fixture registry is non-empty', () => {
		expect(NEGATIVE_FIXTURE_CASES.length).toBeGreaterThan(0)
	})

	for (const { fixture, cause, path } of NEGATIVE_FIXTURE_CASES) {
		test(`${fixture} reports ${cause} with a source location and no output`, async () => {
			const source = await readNegativeFixture(fixture)

			const result = compileSpecificationCandidate(source, {
				sourcePath: `${fixture}.jsonc`,
			})

			expect(result.ok).toBe(false)
			// Fail closed: no IR and no digest may accompany a diagnostic.
			expect(result).not.toHaveProperty('ir')
			expect(result).not.toHaveProperty('digest')

			// Exactly one cause, so the fixture is not passing for another reason.
			expect([
				...new Set(result.diagnostics.map((item) => item.cause)),
			]).toEqual([cause])

			const diagnostic = result.diagnostics[0]
			expect(diagnostic).toBeDefined()
			if (diagnostic === undefined) return
			expect(diagnostic.path).toBe(path)
			expect(diagnostic.sourcePath).toBe(`${fixture}.jsonc`)
			expect(diagnostic.location.line).toBeGreaterThan(0)
			expect(diagnostic.location.column).toBeGreaterThan(0)
			// The reported position must actually point inside the source text.
			expect(diagnostic.location.offset).toBeLessThan(source.length)
			expect(diagnostic.message.length).toBeGreaterThan(0)
		})
	}

	test('the base fixture every negative case derives from is itself valid', async () => {
		const result = compileSpecificationCandidate(
			await readNegativeFixture('_base'),
		)

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
	})
})
