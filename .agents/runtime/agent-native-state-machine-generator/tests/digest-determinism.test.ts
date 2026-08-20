import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	GENERATOR_CONTRACT_VERSION,
	INPUT_SCHEMA_VERSION,
} from '../src/index.ts'
import { readCandidate, readPermutedCandidate } from './support/candidates.ts'

describe('specification digest', () => {
	test('is identical across repeated runs of the same candidate', async () => {
		const source = await readCandidate('vault-git')

		const first = compileSpecificationCandidate(source)
		const second = compileSpecificationCandidate(source)

		expect(first.ok && second.ok).toBe(true)
		if (!first.ok || !second.ok) return
		expect(second.digest.specificationDigest).toBe(
			first.digest.specificationDigest,
		)
		expect(second.digest.canonicalForm).toBe(first.digest.canonicalForm)
	})

	test('is identical for a cosmetically permuted copy', async () => {
		const original = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		const permuted = compileSpecificationCandidate(
			await readPermutedCandidate('vault-git'),
		)

		expect(permuted.diagnostics).toEqual([])
		expect(original.ok && permuted.ok).toBe(true)
		if (!original.ok || !permuted.ok) return

		// Reordered keys, relocated comments and added trailing commas are
		// cosmetic: the canonical bytes and therefore the digest must not move.
		expect(permuted.digest.canonicalForm).toBe(original.digest.canonicalForm)
		expect(permuted.digest.specificationDigest).toBe(
			original.digest.specificationDigest,
		)
	})

	test('differs when a meaning actually changes', async () => {
		const source = await readCandidate('vault-git')
		const original = compileSpecificationCandidate(source)
		// Renaming a declared blocker is a semantic change, not a cosmetic one.
		const changed = compileSpecificationCandidate(
			source.replace('"offline_mode"', '"offline_mode_2"'),
		)

		expect(original.ok && changed.ok).toBe(true)
		if (!original.ok || !changed.ok) return
		expect(changed.digest.specificationDigest).not.toBe(
			original.digest.specificationDigest,
		)
	})

	test('envelope distinguishes input schema version from generator contract version', async () => {
		const result = compileSpecificationCandidate(await readCandidate('fallow'))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.digest.inputSchemaVersion).toBe(INPUT_SCHEMA_VERSION)
		expect(result.digest.generatorContractVersion).toBe(
			GENERATOR_CONTRACT_VERSION,
		)
	})
})
