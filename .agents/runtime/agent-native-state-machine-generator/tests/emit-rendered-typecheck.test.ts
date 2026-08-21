import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import {
	compileSpecificationCandidate,
	emitFacadeArtifacts,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

/**
 * Gate 1, compile-time half: the rendered catalog really does satisfy the
 * facade types under `tsc`.
 *
 * Asserting on the emitted values proves the shape this package built; it does
 * not prove that the *text* this package writes into a consumer compiles. Only
 * running the type checker over the rendered source proves that, so the
 * rendered modules are written to a scratch directory and checked there. The
 * scratch directory is outside any repository, and nothing is written into a
 * consumer.
 */

async function renderVaultGitCatalog(): Promise<string> {
	const compiled = compileSpecificationCandidate(
		await readCandidate('vault-git'),
	)
	if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
	const emission = emitFacadeArtifacts(
		compiled.ir,
		compiled.digest.specificationDigest,
	)
	if (!emission.ok) throw new Error('vault-git emission refused')
	const catalog = emission.modules.find((module) =>
		module.path.endsWith('branch-station-catalog.ts'),
	)
	if (!catalog) throw new Error('no rendered catalog module')
	return catalog.contents
}

describe('the rendered catalog satisfies the facade types under tsc', () => {
	test('const satisfies readonly BranchStation[] type-checks', async () => {
		const contents = await renderVaultGitCatalog()
		// Checked inside the package so the facade package name and the
		// workspace's type packages resolve exactly as they do for a consumer.
		// The file name is scratch-only and removed in `finally`; it is never a
		// declared artifact and never committed.
		const file = new URL('./__emit-scratch.ts', import.meta.url).pathname
		try {
			// The rendered catalog imports a consumer discovery module that does not
			// exist here. Only that one import specifier is rewritten; every line
			// carrying emitted station data is checked exactly as rendered, and the
			// facade import is left untouched so the real types judge the catalog.
			const checkable = contents
				.replace(
					/^import \{ project.*\n/m,
					'const projectDiscovery = () => ({ commands: {} })\n',
				)
				.replace(/project\w*CommandDiscoveryTree\(\)/g, 'projectDiscovery()')
			await writeFile(file, checkable, 'utf8')

			const result = Bun.spawnSync(
				['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.emit-scratch.json'],
				{ cwd: new URL('..', import.meta.url).pathname },
			)
			const output = `${result.stdout.toString()}${result.stderr.toString()}`
			expect({ exitCode: result.exitCode, output }).toEqual({
				exitCode: 0,
				output: '',
			})
		} finally {
			await rm(file, { force: true })
		}
	}, 120_000)

	test('the rendered catalog exports exactly one station array', async () => {
		// The auditor-skill constraint: exactly one station-array export per file.
		// The `_STATION_IDS` tuple is an array of ids, not of stations, so the
		// count is taken on the `satisfies readonly BranchStation[]` annotation
		// that makes an export a station array.
		const contents = await renderVaultGitCatalog()
		const stationArrays = contents.match(
			/\] as const satisfies readonly BranchStation\[\]/g,
		)
		expect(stationArrays?.length).toBe(1)
	})

	test('the rendered catalog emits contract_id and never data.contract', async () => {
		const contents = await renderVaultGitCatalog()
		expect(contents).toContain('expectedResultContractId')
		// The legacy branch must never be produced.
		expect(contents).not.toContain('data.contract')
	})

	test('the rendered catalog carries both thin consumer wrappers', async () => {
		const contents = await renderVaultGitCatalog()
		expect(contents).toContain('BranchStationCatalogDrift(')
		expect(contents).toContain('StationMap(')
		expect(contents).toContain('_STATION_IDS = [')
	})
})
