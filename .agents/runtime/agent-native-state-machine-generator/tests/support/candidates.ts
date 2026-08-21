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
