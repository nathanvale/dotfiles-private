import { describe, expect, test } from 'bun:test'
import {
	COMMAND_FACADE_BASELINE_EXIT_CODES,
	type CommandFacadeContract,
	findCommandFacadeMetadataDrift,
} from '@side-quest/cli-command-facade'
import { BASELINE_EXIT_CODES, deriveCommandContracts } from '../src/index.ts'
import { emitAmended } from './support/emission.ts'

/**
 * Gate 3: the emitted Command Surface Contract honors the write-preview
 * obligation and the baseline exit keys.
 *
 * The oracle is the facade's own `findCommandFacadeMetadataDrift`, which owns
 * the Write Preview Capability rule. Asserting against it rather than against
 * this package's own check means a generator that stopped emitting a preview
 * mode fails here even if its internal refusal logic was removed at the same
 * time.
 */
async function contractsFor(product: 'vault-git' | 'fallow') {
	const { ir } = await emitAmended(product)
	return { compiled: { ir }, emission: deriveCommandContracts(ir) }
}

test('the package baseline exit list is byte-identical to the facade baseline', () => {
	// The schema.ts comment claims this alignment is proved by a test; this is
	// that test (repair S3).
	expect([...BASELINE_EXIT_CODES]).toEqual([
		...COMMAND_FACADE_BASELINE_EXIT_CODES,
	])
})

describe('emitted command contracts satisfy the facade', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} contracts produce no facade metadata drift`, async () => {
			const { emission } = await contractsFor(product)
			expect(emission.refusals).toEqual([])

			const drift = findCommandFacadeMetadataDrift(
				emission.contracts as Record<string, CommandFacadeContract>,
			)
			expect(drift).toEqual([])
		})

		test(`${product} declares every baseline exit meaning`, async () => {
			const { emission } = await contractsFor(product)
			for (const [command, contract] of Object.entries(emission.contracts)) {
				for (const code of COMMAND_FACADE_BASELINE_EXIT_CODES) {
					expect({
						command,
						code,
						declared: code in contract.exitCodes,
					}).toEqual({ command, code, declared: true })
				}
			}
		})

		test(`${product} emits one contract per declared command`, async () => {
			const { compiled, emission } = await contractsFor(product)
			expect(Object.keys(emission.contracts).sort()).toEqual(
				[...compiled.ir.commandSurface.commands].sort(),
			)
		})
	}

	test('the generator never authors a previewExemption reason', async () => {
		// An exemption is a narrow package-owned judgement. A generator that
		// invented one would be authoring product policy, which the spec bans.
		for (const product of ['vault-git', 'fallow'] as const) {
			const { emission } = await contractsFor(product)
			for (const [command, contract] of Object.entries(emission.contracts)) {
				expect({
					product,
					command,
					exemption: contract.previewExemption,
				}).toEqual({ product, command, exemption: undefined })
			}
		}
	})
})
