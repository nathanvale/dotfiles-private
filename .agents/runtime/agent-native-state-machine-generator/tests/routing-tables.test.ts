import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	type DiagnosticCause,
	deriveArtifactSet,
	projectRetryable,
	RETRY_POSTURES,
	type RetryableEvidence,
	ROUTE_TARGET_KINDS,
	ROUTING_ROLES,
} from '../src/index.ts'

/**
 * Routing Tables state routes; they never leave one to be inferred.
 *
 * A table declares what it selects (a canonical action, or a Branch Station,
 * which are different meanings), the closed key space it selects on, and
 * whether every declared combination must route. Validation holds all of it,
 * so an ambiguous, incomplete, or out-of-vocabulary route is refused at
 * compile rather than resolved by a default at derivation.
 *
 * The values here are synthetic. Where a ruling names a closed evidence set
 * whose real values have no authoritative owner yet, the schema carries the
 * declaration and the values wait for candidate authoring and admission.
 */

const V2_DIR = new URL('../fixtures/v2/', import.meta.url)

async function compileV2(name: string) {
	return compileSpecificationCandidate(
		await Bun.file(new URL(`${name}.jsonc`, V2_DIR)).text(),
		{ sourcePath: `${name}.jsonc` },
	)
}

/**
 * One fixture per refused routing claim, each the valid v2 candidate with
 * exactly one rule broken so a failure names one repair.
 */
const ROUTING_REFUSALS: ReadonlyArray<{
	readonly fixture: string
	readonly cause: DiagnosticCause
	readonly claim: string
}> = [
	{
		fixture: 'routing-duplicate-key',
		cause: 'semantic_competing_actions',
		claim: 'two rows sharing one complete key select no single route',
	},
	{
		fixture: 'routing-incomplete-key',
		cause: 'semantic_incomplete_projection',
		claim: 'a row omitting a declared discriminant selects too widely',
	},
	{
		fixture: 'routing-incomplete-coverage',
		cause: 'semantic_incomplete_projection',
		claim: 'a required combination that routes nowhere selects nothing',
	},
	{
		fixture: 'routing-unknown-discriminant-field',
		cause: 'semantic_unresolved_reference',
		claim: 'a key on an undeclared discriminant widens the closed key space',
	},
	{
		fixture: 'routing-unknown-discriminant-value',
		cause: 'semantic_free_text_branch_value',
		claim: 'a value outside a discriminant vocabulary is not an admitted key',
	},
	{
		fixture: 'routing-fact-targets-action',
		cause: 'semantic_unresolved_reference',
		claim:
			'a Branch Station route targeting an action replaces branch with action',
	},
	{
		fixture: 'routing-unknown-branch-station',
		cause: 'semantic_unresolved_reference',
		claim: 'a Branch Station whose command is undeclared cannot exist',
	},
	{
		fixture: 'routing-unknown-action',
		cause: 'semantic_unresolved_reference',
		claim: 'an action route targeting an undeclared action invents a route',
	},
]

describe('a declared Routing Table compiles', () => {
	test('the valid v2 candidate routes cleanly', async () => {
		const result = await compileV2('declared-surfaces')

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
	})

	test('the target kinds are a sealed pair, action and Branch Station', () => {
		expect([...ROUTE_TARGET_KINDS].sort()).toEqual(['action', 'branch_station'])
	})

	test('every declared role is one the sealed vocabulary names', async () => {
		const result = await compileV2('declared-surfaces')
		expect(result.ok).toBe(true)
		if (!result.ok) return

		// Iterating the exported constant rather than naming one member: a
		// role added to the vocabulary without a home here fails this.
		expect(ROUTING_ROLES.length).toBeGreaterThan(0)
		for (const table of result.ir.routing) {
			expect({
				table: table.name,
				sealed: (ROUTING_ROLES as readonly string[]).includes(table.role),
			}).toEqual({ table: table.name, sealed: true })
		}
	})

	test('each sealed role has a named disposition at derivation', async () => {
		// Three roles bind: station_blocker supplies a refused station's
		// blocker, station_action binds a success station, and fact_branch
		// emits its own selection table. `advisory` binds nothing by
		// definition - a product declares it precisely so derivation reads no
		// station meaning from it.
		const BINDING = ['fact_branch', 'station_action', 'station_blocker']
		const BINDS_NOTHING = ['advisory']
		expect([...BINDING, ...BINDS_NOTHING].sort()).toEqual(
			[...ROUTING_ROLES].sort(),
		)

		// Held against the real emission rather than two hand-kept lists: the
		// fixture declares a fact_branch table and an advisory one, and only
		// the first reaches a module.
		const compiled = await compileV2('declared-surfaces')
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return
		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const declaredRoles = new Set(
			compiled.ir.routing.map((table) => table.role),
		)
		expect(declaredRoles.has('fact_branch')).toBe(true)
		expect(declaredRoles.has('advisory')).toBe(true)
		expect(
			emission.modules.some((module) =>
				module.path.endsWith('fact-branch-routing.ts'),
			),
		).toBe(true)
	})

	test('each table declares its target kind and closed discriminants', async () => {
		const result = await compileV2('declared-surfaces')
		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.ir.routing.length).toBeGreaterThan(0)
		for (const table of result.ir.routing) {
			expect({
				table: table.name,
				kind: (ROUTE_TARGET_KINDS as readonly string[]).includes(
					table.targetKind,
				),
				closed: Object.keys(table.discriminants).length > 0,
			}).toEqual({ table: table.name, kind: true, closed: true })
		}
	})

	test('fact-to-branch selection targets Branch Stations, not actions', async () => {
		const result = await compileV2('declared-surfaces')
		expect(result.ok).toBe(true)
		if (!result.ok) return

		const facts = result.ir.routing.find((table) => table.name === 'facts')
		expect(facts).toBeDefined()
		if (facts === undefined) return
		// The distinction gap row 5 names: a station is selected independently
		// of whatever Next Safe Action follows it.
		expect(facts.targetKind).toBe('branch_station')
		expect(facts.rows.map((row) => row.target)).toEqual([
			'doctor.success',
			'doctor.refused',
		])
		const actionIds = new Set(result.ir.actions.catalog.map((row) => row.id))
		for (const row of facts.rows) {
			expect({
				target: row.target,
				isAction: actionIds.has(row.target),
			}).toEqual({ target: row.target, isAction: false })
		}
	})

	test('a table requiring complete coverage routes every declared combination', async () => {
		const result = await compileV2('declared-surfaces')
		expect(result.ok).toBe(true)
		if (!result.ok) return

		const doctor = result.ir.routing.find(
			(table) => table.name === 'doctor_findings',
		)
		expect(doctor).toBeDefined()
		if (doctor === undefined) return
		expect(doctor.requiresCompleteCoverage).toBe(true)

		// Independent oracle: the Cartesian product recomputed here from the
		// declared vocabularies, not read back from the rows under test.
		const expected = Object.values(doctor.discriminants).reduce(
			(total, values) => total * values.length,
			1,
		)
		expect(doctor.rows.length).toBe(expected)
	})
})

describe('an unroutable declaration is refused', () => {
	test('the refusal registry is non-empty', () => {
		expect(ROUTING_REFUSALS.length).toBeGreaterThan(0)
	})

	for (const { fixture, cause, claim } of ROUTING_REFUSALS) {
		test(`${fixture}: ${claim}`, async () => {
			const result = await compileV2(fixture)

			expect({ fixture, ok: result.ok }).toEqual({ fixture, ok: false })
			if (result.ok) return
			// Fail closed: a refused route publishes no IR and no digest.
			expect(result).not.toHaveProperty('ir')
			expect(result).not.toHaveProperty('digest')
			// Exactly one cause, so the fixture is not refusing for another reason.
			expect({
				fixture,
				causes: [...new Set(result.diagnostics.map((item) => item.cause))],
			}).toEqual({ fixture, causes: [cause] })

			const diagnostic = result.diagnostics[0]
			expect(diagnostic).toBeDefined()
			if (diagnostic === undefined) return
			expect(diagnostic.path.startsWith('routing.')).toBe(true)
			expect(diagnostic.location.line).toBeGreaterThan(0)
			expect(diagnostic.sourcePath).toBe(`${fixture}.jsonc`)
		})
	}
})

describe('the retryable projection is fixed, not declared', () => {
	/**
	 * Every conjunct ADR 0006 rules, all satisfied. Restated here as a literal
	 * rather than built by a helper the predicate also uses.
	 */
	const IMMEDIATELY_USEFUL: RetryableEvidence = {
		posture: 'same_input_safe',
		projectionCompleteness: 'complete',
		sameInvocationAsNextSafeAction: true,
		normalizedInputUnchanged: true,
		logicalOperationUnchanged: true,
		noPrerequisite: true,
	}

	test('an immediately useful identical safe invocation is retryable', () => {
		expect(projectRetryable(IMMEDIATELY_USEFUL)).toBe(true)
	})

	/**
	 * One case per conjunct, each falsified alone with the other three still
	 * satisfied, so a passing case cannot be carried by a sibling failure.
	 * Combining them would prove only that some conjunct is load-bearing.
	 */
	const CONJUNCTS = [
		{
			conjunct: 'sameInvocationAsNextSafeAction',
			why: 'the next safe action is a different public invocation',
			evidence: {
				...IMMEDIATELY_USEFUL,
				sameInvocationAsNextSafeAction: false,
			},
		},
		{
			conjunct: 'normalizedInputUnchanged',
			why: 'a repeat would carry different normalized input',
			evidence: { ...IMMEDIATELY_USEFUL, normalizedInputUnchanged: false },
		},
		{
			conjunct: 'logicalOperationUnchanged',
			why: 'a repeat would mint a new Logical Operation',
			evidence: { ...IMMEDIATELY_USEFUL, logicalOperationUnchanged: false },
		},
		{
			conjunct: 'noPrerequisite',
			why: 'a human, input, repair, or wait must happen first',
			evidence: { ...IMMEDIATELY_USEFUL, noPrerequisite: false },
		},
	] as const

	test('the conjunct list covers every ruled condition', () => {
		expect(CONJUNCTS.length).toBe(4)
	})

	for (const { conjunct, why, evidence } of CONJUNCTS) {
		test(`${conjunct} false alone forces retryable false: ${why}`, () => {
			// Safe to repeat, and useless to repeat. Exact Same-Input Retry
			// Safety is still same_input_safe in every one of these.
			expect({ conjunct, posture: evidence.posture }).toEqual({
				conjunct,
				posture: 'same_input_safe',
			})
			expect({ conjunct, retryable: projectRetryable(evidence) }).toEqual({
				conjunct,
				retryable: false,
			})
		})
	}

	test('an unsafe posture is never retryable, however useful', () => {
		expect(RETRY_POSTURES.length).toBeGreaterThan(0)
		for (const posture of RETRY_POSTURES) {
			const retryable = projectRetryable({ ...IMMEDIATELY_USEFUL, posture })
			expect({ posture, retryable }).toEqual({
				posture,
				retryable: posture === 'same_input_safe',
			})
		}
	})

	test('an incomplete projection is never retryable, whatever the posture', () => {
		for (const posture of RETRY_POSTURES) {
			expect({
				posture,
				retryable: projectRetryable({
					...IMMEDIATELY_USEFUL,
					posture,
					projectionCompleteness: 'incomplete',
				}),
			}).toEqual({ posture, retryable: false })
		}
	})

	test('a candidate cannot declare the projection at all', async () => {
		const source = (
			await Bun.file(new URL('declared-surfaces.jsonc', V2_DIR)).text()
		).replace(
			'"never_auto_retry": [],',
			'"never_auto_retry": [],\n\t\t"retryable_projection": { "operator_required": true },',
		)

		const result = compileSpecificationCandidate(source)

		// The mapping is ruled truth (ADR 0006), so product input has no way to
		// say operator_required is retryable.
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'structure_unknown_key',
		])
	})
})
