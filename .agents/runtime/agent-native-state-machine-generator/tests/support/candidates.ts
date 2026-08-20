const CANDIDATE_DIR = new URL('../../fixtures/spike-candidates/', import.meta.url)

export async function readCandidate(product: 'vault-git' | 'fallow'): Promise<string> {
	return await Bun.file(new URL(`${product}.state-machine.jsonc`, CANDIDATE_DIR)).text()
}
