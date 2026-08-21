import { describe, expect, test } from 'bun:test'
import { compileSpecificationCandidate } from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

describe('positive candidates compile through the public API', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} validates and produces an IR plus digest`, async () => {
			const result = compileSpecificationCandidate(
				await readCandidate(product),
				{
					sourcePath: `${product}.state-machine.jsonc`,
				},
			)

			expect(result.diagnostics).toEqual([])
			expect(result.ok).toBe(true)
			if (!result.ok) return
			expect(result.ir.specMeta.product).toBe(product)
			expect(result.digest.specificationDigest).toMatch(/^[0-9a-f]{64}$/)
		})
	}
})
