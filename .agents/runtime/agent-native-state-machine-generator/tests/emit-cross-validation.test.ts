import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	emitFacadeArtifacts,
	type SpecificationIr,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

/**
 * Gates 4 and 5: a deliberately inconsistent IR is refused at emit time, and
 * emitting twice from the same IR is byte-identical.
 *
 * The inconsistency is introduced in the IR rather than in the candidate text
 * on purpose. A candidate that declared a station expecting an undeclared exit
 * code cannot be written — Input Schema v1 has no station section — so the
 * only way to reach this refusal is to hand the emitter an IR whose command
 * surface contradicts what a station would need. That is exactly the
 * generator-defect case the cross-validation exists to stop.
 */

async function vaultGitIr(): Promise<{ ir: SpecificationIr; digest: string }> {
	const compiled = compileSpecificationCandidate(
		await readCandidate('vault-git'),
	)
	if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
	return { ir: compiled.ir, digest: compiled.digest.specificationDigest }
}

describe('cross-validation refuses an inconsistent IR at emit time', () => {
	test('a station cannot expect an exit code its command never declares', async () => {
		const { ir, digest } = await vaultGitIr()

		// Withdraw exit code 2 from the command surface while leaving the flags
		// that make every command reach an invalid-usage branch. Every usage
		// station would now expect an exit the surface no longer declares.
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: {
				...ir.commandSurface,
				exitCodes: { '0': 'success', '1': 'refused_blocked_or_failed' },
			},
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)

		expect(emission.ok).toBe(false)
		if (emission.ok) return
		const causes = new Set(emission.refusals.map((refusal) => refusal.cause))
		expect(causes.has('emit_station_exit_code_undeclared')).toBe(true)
		// Fail-closed: the refusal variant carries no artifacts at all.
		expect('stations' in emission).toBe(false)
		expect('modules' in emission).toBe(false)
	})

	test('the refusal names the offending station and exit code', async () => {
		const { ir, digest } = await vaultGitIr()
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: {
				...ir.commandSurface,
				exitCodes: { '0': 'success', '1': 'refused_blocked_or_failed' },
			},
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)
		expect(emission.ok).toBe(false)
		if (emission.ok) return

		const exitRefusals = emission.refusals.filter(
			(refusal) => refusal.cause === 'emit_station_exit_code_undeclared',
		)
		expect(exitRefusals.length).toBeGreaterThan(0)
		for (const refusal of exitRefusals) {
			expect(refusal.subject).toMatch(/^[a-z-]+\.[a-z_]+:2$/)
			expect(refusal.message).toContain('never declares')
		}
	})

	test('a station cannot expect a result contract the command does not declare', async () => {
		const { ir, digest } = await vaultGitIr()

		// Withdraw every result contract. No station can name one, so each is
		// refused rather than emitted with an invented or absent contract id.
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: { ...ir.commandSurface, resultContracts: {} },
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect(
			emission.refusals.some(
				(refusal) => refusal.cause === 'emit_station_result_contract_mismatch',
			),
		).toBe(true)
	})

	test('a missing baseline exit meaning is refused', async () => {
		const { ir, digest } = await vaultGitIr()
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: {
				...ir.commandSurface,
				exitCodes: { '0': 'success', '1': 'refused', '3': 'other' },
			},
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect(
			emission.refusals.some(
				(refusal) => refusal.cause === 'emit_baseline_exit_missing',
			),
		).toBe(true)
	})

	test('refusals are deterministically ordered', async () => {
		const { ir, digest } = await vaultGitIr()
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: { ...ir.commandSurface, resultContracts: {} },
		}

		const first = emitFacadeArtifacts(inconsistent, digest)
		const second = emitFacadeArtifacts(inconsistent, digest)
		expect(first.ok).toBe(false)
		expect(second.ok).toBe(false)
		expect(JSON.stringify(first.refusals)).toBe(JSON.stringify(second.refusals))
	})
})

describe('emission is deterministic', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} emits byte-identical modules twice from the same IR`, async () => {
			const compiled = compileSpecificationCandidate(
				await readCandidate(product),
			)
			if (!compiled.ok)
				throw new Error(`${product} candidate failed to compile`)
			const digest = compiled.digest.specificationDigest

			const first = emitFacadeArtifacts(compiled.ir, digest)
			const second = emitFacadeArtifacts(compiled.ir, digest)
			expect(first.ok).toBe(true)
			expect(second.ok).toBe(true)
			if (!first.ok || !second.ok) return

			expect(first.modules.length).toBeGreaterThan(0)
			expect(first.modules.map((module) => module.path)).toEqual(
				second.modules.map((module) => module.path),
			)
			for (const [index, module] of first.modules.entries()) {
				const other = second.modules[index]
				// Byte-for-byte, not merely deep-equal: the drift oracle compares
				// regenerated bytes, so whitespace and key order are contract.
				expect({
					path: module.path,
					identical: module.contents === other?.contents,
				}).toEqual({ path: module.path, identical: true })
			}
		})

		test(`${product} emits identical typed values twice`, async () => {
			const compiled = compileSpecificationCandidate(
				await readCandidate(product),
			)
			if (!compiled.ok)
				throw new Error(`${product} candidate failed to compile`)
			const digest = compiled.digest.specificationDigest

			const first = emitFacadeArtifacts(compiled.ir, digest)
			const second = emitFacadeArtifacts(compiled.ir, digest)
			if (!first.ok || !second.ok) throw new Error('emission refused')

			expect(JSON.stringify(first.stations)).toBe(
				JSON.stringify(second.stations),
			)
			expect(JSON.stringify(first.commandContracts)).toBe(
				JSON.stringify(second.commandContracts),
			)
			expect(JSON.stringify(first.expectations)).toBe(
				JSON.stringify(second.expectations),
			)
			expect(first.stationIds).toEqual(second.stationIds)
		})
	}

	test('a cosmetic permutation of the candidate emits identical artifacts', async () => {
		// Comment placement, key order and trailing commas are not meaning. The
		// canonical IR already erases them, so emission must too.
		const { readPermutedCandidate } = await import('./support/candidates.ts')
		const plain = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		const permuted = compileSpecificationCandidate(
			await readPermutedCandidate('vault-git'),
		)
		if (!plain.ok || !permuted.ok)
			throw new Error('candidate failed to compile')

		const a = emitFacadeArtifacts(plain.ir, plain.digest.specificationDigest)
		const b = emitFacadeArtifacts(
			permuted.ir,
			permuted.digest.specificationDigest,
		)
		if (!a.ok || !b.ok) throw new Error('emission refused')

		for (const [index, module] of a.modules.entries()) {
			expect({ path: module.path, contents: module.contents }).toEqual({
				path: module.path,
				contents: b.modules[index]?.contents as string,
			})
		}
	})
})

describe('station derivation refuses a command the facade grammar rejects', () => {
	test('an uppercase command name is refused, not silently emitted', async () => {
		const { ir, digest } = await vaultGitIr()
		// The facade's station id grammar is lowercase-only. A candidate may name
		// a command the grammar cannot express, and emitting it would publish a
		// catalog the facade refuses at projection time instead of at build time.
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: {
				...ir.commandSurface,
				commands: [...ir.commandSurface.commands, 'Begin'],
				mutations: { ...ir.commandSurface.mutations, Begin: 'read' },
			},
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect(
			emission.refusals.some(
				(refusal) =>
					refusal.cause === 'emit_station_id_invalid' &&
					refusal.subject.startsWith('Begin.'),
			),
		).toBe(true)
	})

	test('an underscore command name is refused by the same grammar check', async () => {
		const { ir, digest } = await vaultGitIr()
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: {
				...ir.commandSurface,
				commands: [...ir.commandSurface.commands, '_hidden'],
				mutations: { ...ir.commandSurface.mutations, _hidden: 'read' },
			},
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect(
			emission.refusals.some(
				(refusal) => refusal.cause === 'emit_station_id_invalid',
			),
		).toBe(true)
	})

	test('a duplicate command declaration cannot emit two stations with one id', async () => {
		const { ir, digest } = await vaultGitIr()
		const inconsistent: SpecificationIr = {
			...ir,
			commandSurface: {
				...ir.commandSurface,
				commands: [...ir.commandSurface.commands, 'status'],
			},
		}

		const emission = emitFacadeArtifacts(inconsistent, digest)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect(
			emission.refusals.some(
				(refusal) => refusal.cause === 'emit_station_id_duplicate',
			),
		).toBe(true)
	})
})
