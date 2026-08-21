import { describe, expect, test } from 'bun:test'
import {
	COMMAND_FACADE_BASELINE_EXIT_CODES,
	type CommandFacadeContract,
	findCommandFacadeMetadataDrift,
} from '@side-quest/cli-command-facade'
import {
	compileSpecificationCandidate,
	deriveCommandContracts,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

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
	const compiled = compileSpecificationCandidate(await readCandidate(product))
	if (!compiled.ok) throw new Error(`${product} candidate failed to compile`)
	const emission = deriveCommandContracts(compiled.ir)
	return { compiled, emission }
}

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

	test('a write-implying command offers a check or dry_run preview path', async () => {
		const { compiled, emission } = await contractsFor('vault-git')
		const writeImplying = Object.entries(
			compiled.ir.commandSurface.mutations,
		).filter(([, mutation]) =>
			['remote_write', 'local_write', 'recovery'].includes(mutation),
		)

		expect(writeImplying.length).toBeGreaterThan(0)
		for (const [command] of writeImplying) {
			const contract = emission.contracts[command]
			const modes = contract?.executionModes ?? []
			expect({
				command,
				previews: modes.includes('check') || modes.includes('dry_run'),
			}).toEqual({ command, previews: true })
		}
	})

	test('a write-implying command declares an escalating side effect', async () => {
		const { compiled, emission } = await contractsFor('vault-git')
		for (const [command, mutation] of Object.entries(
			compiled.ir.commandSurface.mutations,
		)) {
			if (!['remote_write', 'local_write', 'recovery'].includes(mutation))
				continue
			const sideEffects = emission.contracts[command]?.sideEffects ?? []
			expect({
				command,
				honest:
					sideEffects.includes('write') || sideEffects.includes('destructive'),
			}).toEqual({ command, honest: true })
		}
	})

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
