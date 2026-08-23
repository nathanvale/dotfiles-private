import { describe, expect, test } from 'bun:test'
import { compileSpecificationCandidate } from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'
import { emitAmended } from './support/emission.ts'

/**
 * Gate 2: from the fallow candidate IR, emitted output contains zero
 * durable-machinery surface.
 *
 * The claim is proved absent, not merely unobserved: every rendered module's
 * text is scanned for the vocabulary of the five features fallow does not
 * admit. A stateless product must not receive placeholder durable-operation,
 * liveness, retry, Cancellation or version-custody behavior, so a generator
 * that emitted an empty-but-present durable block would still fail here.
 */

/**
 * Surface that only a durable, live, cancellable or version-custodied product
 * may carry. Drawn from the product vocabulary, so a rename in the emitters
 * that reintroduced the concept under its admitted name is still caught.
 */
const DURABLE_MACHINERY_SURFACE = [
	'logicalOperation',
	'logical_operation',
	'LogicalOperation',
	'acknowledgement',
	'Acknowledgement',
	'attemptId',
	'attempt_id',
	'livenessEvidence',
	'liveness_evidence',
	'gateAvailability',
	'gate_availability',
	'operationProgress',
	'operation_progress',
	'progressOwner',
	'progress_owner',
	'cancellation',
	'Cancellation',
	'versionCustody',
	'version_custody',
	'incompatible_run_version',
	'wakeRoute',
	'wake_route',
	'observationDeadline',
	'observation_deadline',
	'checkpoint',
	'fencing',
	'lease',
] as const

async function emitFallow() {
	const { ir, emission } = await emitAmended('fallow')
	return { compiled: { ir }, emission }
}

describe('fallow emits no durable machinery', () => {
	test('the candidate really does admit none of the durable features', async () => {
		// Guards the proof itself: if fallow ever admitted a durable feature, the
		// omission assertions below would be vacuously true and must be revisited.
		const compiled = compileSpecificationCandidate(
			await readCandidate('fallow'),
		)
		if (!compiled.ok) throw new Error('fallow candidate failed to compile')
		expect(compiled.ir.features).toMatchObject({
			durableOperations: false,
			livenessEvidence: false,
			cancellation: 'not_supported',
			versionCustody: false,
			remoteAuthority: false,
		})
	})

	test('no rendered module mentions durable-machinery surface', async () => {
		const { emission } = await emitFallow()
		expect(emission.modules.length).toBeGreaterThan(0)

		for (const module of emission.modules) {
			for (const term of DURABLE_MACHINERY_SURFACE) {
				expect({
					path: module.path,
					term,
					present: module.contents.includes(term),
				}).toEqual({ path: module.path, term, present: false })
			}
		}
	})

	test('no semantic expectation row carries a durable meaning', async () => {
		const { emission } = await emitFallow()
		expect(emission.expectations.length).toBeGreaterThan(0)

		for (const row of emission.expectations) {
			const serialized = JSON.stringify(row)
			for (const term of DURABLE_MACHINERY_SURFACE) {
				expect({
					station: row.stationId,
					term,
					present: serialized.includes(term),
				}).toEqual({ station: row.stationId, term, present: false })
			}
		}
	})

	test('no emitted command contract declares a durable side effect', async () => {
		const { emission } = await emitFallow()
		for (const [command, contract] of Object.entries(
			emission.commandContracts,
		)) {
			// A stateless product reaches nothing over the network and holds no
			// remote authority, so `network` would be placeholder machinery.
			expect({
				command,
				sideEffects: (contract.sideEffects ?? []).includes('network'),
			}).toEqual({ command, sideEffects: false })
		}
	})

	test('fallow still emits the stations its own command surface implies', async () => {
		// Omission must not be achieved by emitting nothing at all.
		const { compiled, emission } = await emitFallow()
		expect(emission.stations.length).toBeGreaterThan(0)
		const commands = new Set(
			emission.stations.map((derived) => derived.station.command),
		)
		expect([...commands].sort()).toEqual(
			[...compiled.ir.commandSurface.commands].sort(),
		)
	})
})
