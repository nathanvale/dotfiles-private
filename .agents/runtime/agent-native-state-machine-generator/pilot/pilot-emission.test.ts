/**
 * Emission proof for the pilot Specification Candidate.
 *
 * Pins the central stage-4 finding: a meaningful read-only pilot surface
 * compiles AND emits within frozen Input Schema v1, where both spike
 * candidates refuse. Expected values are restated as literals, never derived
 * through the code under test.
 *
 * Green here is not Specification Admission; the candidate stays an
 * unadmitted draft until the product owner admits it.
 */
import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	deriveArtifactSet,
} from '../src/index.ts'
import {
	PILOT_DERIVATION_OPTIONS,
	PILOT_EMITTERS,
} from './generation/pilot-derivation.ts'
import {
	PILOT_CONSTANT_PREFIX,
	PILOT_PRODUCT,
	PILOT_SYMBOL_PREFIX,
	PILOT_TYPE_PREFIX,
} from './generation/pilot-naming.ts'

const CANDIDATE_URL = new URL(
	'./vault-git-reimagined.state-machine.jsonc',
	import.meta.url,
)

/** The complete designed station id list, in codepoint order. */
const EXPECTED_STATION_IDS = [
	'commands.invalid_usage',
	'commands.refused',
	'commands.success',
	'status.invalid_usage',
	'status.no_argument',
	'status.refused',
	'status.success',
] as const

async function compilePilot() {
	const source = await Bun.file(CANDIDATE_URL).text()
	return compileSpecificationCandidate(source, {
		sourcePath: 'pilot/vault-git-reimagined.state-machine.jsonc',
	})
}

describe('the pilot candidate compiles', () => {
	test('with zero diagnostics', async () => {
		const compiled = await compilePilot()
		expect(compiled.diagnostics).toEqual([])
		expect(compiled.ok).toBe(true)
	})

	test('to the same specification digest on repeat runs', async () => {
		const first = await compilePilot()
		const second = await compilePilot()
		if (!first.ok || !second.ok) {
			throw new Error('the pilot candidate failed to compile')
		}
		expect(first.digest.specificationDigest).toBe(
			second.digest.specificationDigest,
		)
	})
})

describe('the pilot candidate emits within frozen Input Schema v1', () => {
	test('the complete artifact set derives with zero refusals', async () => {
		const compiled = await compilePilot()
		if (!compiled.ok) throw new Error('the pilot candidate failed to compile')
		const derived = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
			PILOT_DERIVATION_OPTIONS,
		)
		expect(derived.refusals).toEqual([])
		expect(derived.ok).toBe(true)
		if (!derived.ok) return
		expect(derived.stationIds).toEqual([...EXPECTED_STATION_IDS])
	})

	test('the bare-invocation station binds to the declared status command', async () => {
		const compiled = await compilePilot()
		if (!compiled.ok) throw new Error('the pilot candidate failed to compile')
		const derived = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
			PILOT_DERIVATION_OPTIONS,
		)
		if (!derived.ok) throw new Error('the pilot candidate refused emission')
		const noArgument = derived.stations.find(
			(station) => station.station.id === 'status.no_argument',
		)
		expect(noArgument, 'status.no_argument station missing').toBeDefined()
		expect(noArgument?.station.command).toBe('status')
		expect(noArgument?.noArgumentBehavior).toBe('read_only_dashboard')
	})

	test('load-bearing semantic rows carry their designed meanings', async () => {
		const compiled = await compilePilot()
		if (!compiled.ok) throw new Error('the pilot candidate failed to compile')
		const derived = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
			PILOT_DERIVATION_OPTIONS,
		)
		if (!derived.ok) throw new Error('the pilot candidate refused emission')

		const expectedRows = [
			{
				stationId: 'status.success',
				expectedActionId: 'inspect_status',
				state: 'observed_success',
				cause: 'read_success',
				authority: 'granted',
				retrySafety: 'same_input_safe',
				projectionCompleteness: 'complete',
				nextSafeAction: 'invoke',
			},
			{
				stationId: 'status.refused',
				expectedActionId: 'none',
				state: 'blocked',
				cause: 'refused_projection_unavailable',
				blocker: 'projection_unavailable',
				authority: 'denied',
				retrySafety: 'same_input_safe',
				projectionCompleteness: 'complete',
				nextSafeAction: 'none',
				stopScope: 'agent_terminal',
			},
			{
				stationId: 'status.invalid_usage',
				expectedActionId: 'none',
				state: 'input_refused',
				cause: 'invalid_usage',
				blocker: 'projection_unavailable',
				authority: 'denied',
				retrySafety: 'operator_required',
				projectionCompleteness: 'incomplete',
				nextSafeAction: 'none',
				stopScope: 'agent_terminal',
			},
		] as const
		expect(expectedRows.length).toBeGreaterThan(0)

		for (const expected of expectedRows) {
			const row = derived.expectations.find(
				(candidate) => candidate.stationId === expected.stationId,
			)
			expect(row, `no semantic row for ${expected.stationId}`).toBeDefined()
			expect({ stationId: expected.stationId, ...row }).toEqual(expected)
		}
	})

	test('the pilot emitter adds the generated Projection Composer to the set', async () => {
		const compiled = await compilePilot()
		if (!compiled.ok) throw new Error('the pilot candidate failed to compile')
		expect(PILOT_EMITTERS.length).toBe(1)
		const [emitter] = PILOT_EMITTERS
		if (emitter === undefined) return
		const emitted = emitter.emit(compiled.ir, compiled.digest)
		expect(emitted.ok).toBe(true)
		if (!emitted.ok) return
		expect([...emitted.artifacts.keys()].sort()).toEqual([
			'src/branch-station-catalog.ts',
			'src/command-surface-contract.ts',
			'src/projection-composer.ts',
			'src/semantic-expectations.ts',
		])
	})
})

describe('the generated modules agree with the pilot naming module', () => {
	test('the candidate declares the product the naming constants derive from', async () => {
		const compiled = await compilePilot()
		if (!compiled.ok) throw new Error('the pilot candidate failed to compile')
		expect(compiled.ir.specMeta.product).toBe(PILOT_PRODUCT)
	})

	test('every export name constructed from the naming constants exists', async () => {
		// Widened to a string-keyed record because the proof is runtime
		// reflection over constructed names; the checker still judges every
		// other use of these modules at their static import sites.
		const catalog = (await import(
			'./generated/src/branch-station-catalog.ts'
		)) as Record<string, unknown>
		const contracts = (await import(
			'./generated/src/command-surface-contract.ts'
		)) as Record<string, unknown>
		const expectations = (await import(
			'./generated/src/semantic-expectations.ts'
		)) as Record<string, unknown>
		const composer = (await import(
			'./generated/src/projection-composer.ts'
		)) as Record<string, unknown>

		const cases = [
			{
				module: catalog,
				name: `${PILOT_CONSTANT_PREFIX}_STATION_IDS`,
				kind: 'object',
			},
			{
				module: catalog,
				name: `${PILOT_SYMBOL_PREFIX}BranchStationCatalog`,
				kind: 'object',
			},
			{
				module: catalog,
				name: `find${PILOT_TYPE_PREFIX}BranchStationCatalogDrift`,
				kind: 'function',
			},
			{
				module: catalog,
				name: `project${PILOT_TYPE_PREFIX}StationMap`,
				kind: 'function',
			},
			{
				module: contracts,
				name: `${PILOT_SYMBOL_PREFIX}CommandContracts`,
				kind: 'object',
			},
			{
				module: expectations,
				name: `${PILOT_SYMBOL_PREFIX}SemanticExpectations`,
				kind: 'object',
			},
			{
				module: composer,
				name: `${PILOT_CONSTANT_PREFIX}_PROJECTION_TABLE`,
				kind: 'object',
			},
			{
				module: composer,
				name: `select${PILOT_TYPE_PREFIX}Projection`,
				kind: 'function',
			},
		] as const
		expect(cases.length).toBeGreaterThan(0)
		for (const row of cases) {
			expect(typeof row.module[row.name], row.name).toBe(row.kind)
		}

		expect(
			catalog[`${PILOT_CONSTANT_PREFIX}_STATION_IDS`],
			`${PILOT_CONSTANT_PREFIX}_STATION_IDS`,
		).toEqual([...EXPECTED_STATION_IDS])
	})
})
