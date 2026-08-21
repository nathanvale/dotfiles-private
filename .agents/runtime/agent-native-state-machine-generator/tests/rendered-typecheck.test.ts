import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitAmended } from './support/emission.ts'

/**
 * Gate 1, compile-time half: the rendered catalog really does satisfy the
 * facade types under `tsc`.
 *
 * Asserting on the emitted values proves the shape this package built; it does
 * not prove that the *text* this package writes into a consumer compiles. Only
 * running the type checker over the rendered source proves that, so the
 * rendered module is written to a scratch directory under the system temp
 * dir, outside any repository, and checked there. The scratch directory links
 * this package's node_modules, so the facade package name and the workspace's
 * type packages resolve exactly as they do for a consumer, and nothing is
 * written into a consumer or into this repository.
 */

/** Scratch file name, assembled so it is never a resolvable import. */
const SCRATCH_BASENAME = ['__emit', 'scratch', 'ts'].join('.')

async function renderVaultGitCatalog(): Promise<string> {
	const { emission } = await emitAmended('vault-git')
	const catalog = emission.modules.find((module) =>
		module.path.endsWith('branch-station-catalog.ts'),
	)
	if (!catalog) throw new Error('no rendered catalog module')
	return catalog.contents
}

describe('the rendered catalog satisfies the facade types under tsc', () => {
	test('const satisfies readonly BranchStation[] type-checks', async () => {
		const contents = await renderVaultGitCatalog()
		const packageRoot = new URL('..', import.meta.url).pathname
		// The whole scratch directory is removed in `finally`; a crash strands it
		// under the system temp dir, never inside a repository.
		const dir = await mkdtemp(join(tmpdir(), 'asmg-rendered-typecheck-'))
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
			await writeFile(join(dir, SCRATCH_BASENAME), checkable, 'utf8')
			// The package's module tree, linked rather than copied, so the facade
			// resolves through its real package.json exports. `rm` removes the
			// link itself, never the linked tree.
			await symlink(
				join(packageRoot, 'node_modules'),
				join(dir, 'node_modules'),
			)
			// The package tsconfig's compiler options verbatim; only the input
			// file set is overridden to exactly the scratch module.
			await writeFile(
				join(dir, 'tsconfig.json'),
				`${JSON.stringify(
					{
						extends: join(packageRoot, 'tsconfig.json'),
						include: [],
						files: [`./${SCRATCH_BASENAME}`],
					},
					null,
					'\t',
				)}\n`,
				'utf8',
			)

			const result = Bun.spawnSync(
				['bunx', 'tsc', '--noEmit', '-p', join(dir, 'tsconfig.json')],
				{ cwd: packageRoot },
			)
			const output = `${result.stdout.toString()}${result.stderr.toString()}`
			expect({ exitCode: result.exitCode, output }).toEqual({
				exitCode: 0,
				output: '',
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
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
