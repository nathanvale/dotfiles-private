const CANDIDATE_DIR = new URL(
	'../../fixtures/spike-candidates/',
	import.meta.url,
)
const PERMUTED_DIR = new URL('../../fixtures/permuted/', import.meta.url)

export async function readCandidate(
	product: 'vault-git' | 'fallow',
): Promise<string> {
	return await Bun.file(
		new URL(`${product}.state-machine.jsonc`, CANDIDATE_DIR),
	).text()
}

/**
 * The frozen Input Schema v1 exemplar: the vault-git candidate's bytes as they
 * stood at commit a7fd5c6, before it was re-authored against Input Schema v2.
 *
 * It is not a third product. It is the subject for every claim about what v1
 * input does, which the live vault-git candidate can no longer carry: a live
 * v1-era candidate compiled through its Registered Reader, holding the
 * `f22e836b..` identity that `version-custody.test.ts` pins. Its bytes are
 * frozen history and never track the live candidate; changing them invalidates
 * that pin, which is evidence about admitted history rather than a value the
 * suite may refresh.
 */
export async function readFrozenV1Exemplar(): Promise<string> {
	return await Bun.file(
		new URL('vault-git.v1-frozen.state-machine.jsonc', CANDIDATE_DIR),
	).text()
}

/** A hand-authored cosmetic permutation: reordered keys, moved comments, trailing commas. */
export async function readPermutedCandidate(
	product: 'vault-git',
): Promise<string> {
	return await Bun.file(
		new URL(`${product}.permuted.state-machine.jsonc`, PERMUTED_DIR),
	).text()
}

const NEGATIVE_DIR = new URL('../../fixtures/negative/', import.meta.url)

/** One invalid fixture per rejection cause; `_base` is the valid control. */
export async function readNegativeFixture(name: string): Promise<string> {
	return await Bun.file(new URL(`${name}.jsonc`, NEGATIVE_DIR)).text()
}
