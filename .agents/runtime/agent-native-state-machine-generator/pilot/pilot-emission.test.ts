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

describe('the generated catalog agrees with the pilot naming module', () => {
	test('the predicted export names exist with the predicted station ids', async () => {
		const catalog = await import('./generated/src/branch-station-catalog.ts')
		expect(catalog.VAULT_GIT_REIMAGINED_STATION_IDS).toEqual([
			...EXPECTED_STATION_IDS,
		])
		expect(typeof catalog.findVaultGitReimaginedBranchStationCatalogDrift).toBe(
			'function',
		)
		expect(typeof catalog.projectVaultGitReimaginedStationMap).toBe('function')
	})
})
