import { describe, expect, test } from 'bun:test'
import { compileSpecificationCandidate, type DiagnosticCause } from '../src/index.ts'
import { readNegativeFixture } from './support/candidates.ts'

/**
 * One focused fixture per rejection cause. Each fixture is the minimal valid
 * base document with exactly one rule broken, so a failure here names one
 * cause and one repair.
 */
const CASES: ReadonlyArray<{
	readonly fixture: string
	readonly cause: DiagnosticCause
	readonly path: string
}> = [
	{ fixture: 'syntax-error', cause: 'jsonc_syntax_error', path: '' },
	{ fixture: 'duplicate-key', cause: 'jsonc_duplicate_key', path: '' },
	{ fixture: 'non-data-value', cause: 'jsonc_non_data_value', path: '' },
	{ fixture: 'unknown-key', cause: 'structure_unknown_key', path: 'command_surface.telemetry_endpoint' },
	{
		fixture: 'unresolved-reference',
		cause: 'semantic_unresolved_reference',
		path: 'actions.resolution.unavailable_projection_blocker',
	},
	{ fixture: 'duplicate-id', cause: 'semantic_duplicate_id', path: 'actions.catalog[1].id' },
	{
		fixture: 'free-text-branch-value',
		cause: 'semantic_free_text_branch_value',
		path: 'command_surface.mutations.audit',
	},
	{ fixture: 'missing-action-semantics', cause: 'semantic_missing_action_semantics', path: 'actions.catalog[1]' },
	{ fixture: 'competing-actions', cause: 'semantic_competing_actions', path: 'actions.catalog[2]' },
	{
		fixture: 'missing-authority-semantics',
		cause: 'semantic_missing_authority_semantics',
		path: 'authority.lease_expiry_grants',
	},
	{
		fixture: 'missing-side-effect-semantics',
		cause: 'semantic_missing_side_effect_semantics',
		path: 'command_surface.exit_codes',
	},
	{ fixture: 'unsafe-retry-declaration', cause: 'semantic_unsafe_retry_declaration', path: 'retry_posture.rules[0]' },
	{
		fixture: 'incomplete-projection',
		cause: 'semantic_incomplete_projection',
		path: 'actions.resolution.unavailable_projection_stop',
	},
	{ fixture: 'feature-machinery-conflict', cause: 'semantic_feature_machinery_conflict', path: 'entities' },
]

describe('invalid candidates are refused fail-closed', () => {
	for (const { fixture, cause, path } of CASES) {
		test(`${fixture} reports ${cause} with a source location and no output`, async () => {
			const source = await readNegativeFixture(fixture)

			const result = compileSpecificationCandidate(source, { sourcePath: `${fixture}.jsonc` })

			expect(result.ok).toBe(false)
			// Fail closed: no IR and no digest may accompany a diagnostic.
			expect(result).not.toHaveProperty('ir')
			expect(result).not.toHaveProperty('digest')

			// Exactly one cause, so the fixture is not passing for another reason.
			expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([cause])

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
		const result = compileSpecificationCandidate(await readNegativeFixture('_base'))

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
	})
})
