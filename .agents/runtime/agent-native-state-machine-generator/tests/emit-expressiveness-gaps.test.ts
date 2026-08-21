import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	emitFacadeArtifacts,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

/**
 * Input Schema v1 expressiveness gaps, proved as refusals.
 *
 * Repair cycle 1 removed two inventions: an execution mode no candidate
 * declares, and a blocker chosen arbitrarily from a list with no
 * command mapping. With both gone, neither spike candidate can currently emit
 * a complete artifact set, and the generator says so with sealed causes rather
 * than publishing an inferred meaning as an admitted one.
 *
 * These tests pin the gaps so they cannot be closed silently. When the product
 * owner admits an execution-mode surface and a blocker-to-command mapping at
 * stage 5, these tests fail loudly and are replaced by the positive emission
 * gates they currently stand in for. That failure is the point: it forces the
 * decision back to the owner instead of letting a default paper over it.
 */

async function emit(product: 'vault-git' | 'fallow') {
	const compiled = compileSpecificationCandidate(await readCandidate(product))
	if (!compiled.ok) throw new Error(`${product} candidate failed to compile`)
	return emitFacadeArtifacts(compiled.ir, compiled.digest.specificationDigest)
}

describe('the generator refuses rather than inventing an execution mode', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} write-implying commands are refused, not given a check mode`, async () => {
			const emission = await emit(product)
			expect(emission.ok).toBe(false)
			if (emission.ok) return

			const previewRefusals = emission.refusals.filter(
				(refusal) => refusal.cause === 'emit_write_preview_undeclarable',
			)
			expect(previewRefusals.length).toBeGreaterThan(0)
			for (const refusal of previewRefusals) {
				// The refusal names the command so the owner knows exactly what to
				// admit, and points at the decision rather than a generator internal.
				expect(refusal.message).toContain('execution modes')
				expect(refusal.message).toContain(refusal.subject)
			}
		})
	}

	test('vault-git names every write-implying command it cannot preview', async () => {
		const compiled = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
		const emission = emitFacadeArtifacts(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(emission.ok).toBe(false)
		if (emission.ok) return

		// Oracle: the candidate's own mutation table, read independently.
		const expected = Object.entries(compiled.ir.commandSurface.mutations)
			.filter(([, mutation]) =>
				['remote_write', 'local_write', 'recovery'].includes(mutation),
			)
			.map(([command]) => command)
			.sort()

		const refused = emission.refusals
			.filter((refusal) => refusal.cause === 'emit_write_preview_undeclarable')
			.map((refusal) => refusal.subject)
			.sort()

		expect(refused).toEqual(expected)
	})
})

describe('the generator refuses rather than choosing a blocker arbitrarily', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} refusal stations cannot name an admitted blocker`, async () => {
			const emission = await emit(product)
			expect(emission.ok).toBe(false)
			if (emission.ok) return

			const blockerRefusals = emission.refusals.filter(
				(refusal) =>
					refusal.cause === 'emit_expectation_column_underivable' &&
					refusal.subject.endsWith(':blocker'),
			)
			expect(blockerRefusals.length).toBeGreaterThan(0)
			for (const refusal of blockerRefusals) {
				expect(refusal.subject).toContain('.refused:blocker')
			}
		})
	}

	test('vault-git declares many blockers but no command mapping', async () => {
		// This is the shape of the gap: it is not that blockers are missing, but
		// that v1 has no way to say which blocker refuses which command. Picking
		// `blockers[0]` would publish an arbitrary choice as an admitted meaning.
		const compiled = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
		expect(compiled.ir.blockers.length).toBeGreaterThan(1)
	})

	test('fallow declares no blockers at all', async () => {
		const compiled = compileSpecificationCandidate(
			await readCandidate('fallow'),
		)
		if (!compiled.ok) throw new Error('fallow candidate failed to compile')
		expect(compiled.ir.blockers).toEqual([])
	})
})

describe('refusals stay complete and deterministic', () => {
	test('every refusal carries a sealed cause and a named subject', async () => {
		for (const product of ['vault-git', 'fallow'] as const) {
			const emission = await emit(product)
			expect(emission.ok).toBe(false)
			if (emission.ok) continue
			for (const refusal of emission.refusals) {
				expect(refusal.subject.length).toBeGreaterThan(0)
				expect(refusal.message.length).toBeGreaterThan(0)
			}
		}
	})

	test('the same candidate refuses identically twice', async () => {
		const compiled = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
		const digest = compiled.digest.specificationDigest
		const first = emitFacadeArtifacts(compiled.ir, digest)
		const second = emitFacadeArtifacts(compiled.ir, digest)
		expect(JSON.stringify(first.refusals)).toBe(JSON.stringify(second.refusals))
	})

	test('all derivations run before refusing, so the repair list is complete', async () => {
		// Not first-problem-only: a caller must see every command needing an
		// execution-mode decision in one pass, not discover them one rerun at a
		// time.
		const emission = await emit('vault-git')
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		const causes = new Set(emission.refusals.map((refusal) => refusal.cause))
		expect(causes.size).toBeGreaterThan(1)
	})
})
