import { describe, expect, test } from 'bun:test'
import { compileSpecificationCandidate } from '../src/index.ts'
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

	test('digests NFC and NFD spellings of one visible string identically', async () => {
		const source = await readCandidate('fallow')
		// U+00E9 precomposed against U+0065 U+0301 decomposed: the same visible
		// text in two forms an editor or filesystem can silently convert between.
		const nfc = source.replace(
			'observability metadata',
			'observability caf\u00e9 metadata',
		)
		const nfd = source.replace(
			'observability metadata',
			'observability cafe\u0301 metadata',
		)
		expect(nfc).not.toBe(nfd)
		expect(nfd.includes('\u0301')).toBe(true)

		const first = compileSpecificationCandidate(nfc)
		const second = compileSpecificationCandidate(nfd)
		expect(first.ok && second.ok).toBe(true)
		if (!first.ok || !second.ok) return
		// Positive control: the mutated value genuinely reached the digest input.
		expect(first.digest.canonicalForm.includes('caf\u00e9')).toBe(true)
		expect(second.digest.canonicalForm).toBe(first.digest.canonicalForm)
		expect(second.digest.specificationDigest).toBe(
			first.digest.specificationDigest,
		)
	})

	test('digests CRLF and LF line endings inside one value identically', async () => {
		const source = await readCandidate('fallow')
		const crlf = source.replace(
			'observability metadata',
			'observability\\r\\nmetadata',
		)
		const lf = source.replace(
			'observability metadata',
			'observability\\nmetadata',
		)

		const first = compileSpecificationCandidate(crlf)
		const second = compileSpecificationCandidate(lf)
		expect(first.ok && second.ok).toBe(true)
		if (!first.ok || !second.ok) return
		// Positive controls: the embedded line break reached the digest input as
		// LF, and no carriage return survived into the serialized form.
		expect(
			first.digest.canonicalForm.includes('observability\\nmetadata'),
		).toBe(true)
		expect(first.digest.canonicalForm.includes('\\r')).toBe(false)
		expect(second.digest.canonicalForm).toBe(first.digest.canonicalForm)
		expect(second.digest.specificationDigest).toBe(
			first.digest.specificationDigest,
		)
	})

	test('envelope carries the pinned schema and contract versions', async () => {
		const result = compileSpecificationCandidate(await readCandidate('fallow'))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		// Deliberate independent oracle: the pinned version literals restated, not
		// the exported constants the envelope is stamped from. Asserting the
		// imports back would move with any version bump and prove nothing.
		expect(result.digest.inputSchemaVersion).toBe('1')
		expect(result.digest.generatorContractVersion).toBe('1')
	})
})
