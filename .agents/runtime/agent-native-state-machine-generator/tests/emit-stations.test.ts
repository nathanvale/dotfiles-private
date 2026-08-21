import { describe, expect, test } from 'bun:test'
import {
	type BranchStation,
	findBranchStationCatalogDrift,
} from '@side-quest/cli-command-facade'
import {
	compileSpecificationCandidate,
	emitFacadeArtifacts,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

/**
 * Gate 1: from the vault-git candidate IR, emitted stations pass the three
 * hard invariants and every station joins exactly one semantic row.
 *
 * The oracle is the facade's own `findBranchStationCatalogDrift`, not this
 * package's derivation code. It re-checks the id grammar, the
 * `id.split(".")[0] === command` rule and command membership in discovery
 * independently, so a derivation that quietly stopped enforcing one of them
 * fails here rather than passing its own reflection.
 */
async function emitVaultGit() {
	const compiled = compileSpecificationCandidate(
		await readCandidate('vault-git'),
	)
	if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
	const emission = emitFacadeArtifacts(
		compiled.ir,
		compiled.digest.specificationDigest,
	)
	if (!emission.ok) {
		throw new Error(
			`vault-git emission refused: ${emission.refusals
				.map((refusal) => `${refusal.cause}@${refusal.subject}`)
				.join(', ')}`,
		)
	}
	return { compiled, emission }
}

describe('vault-git stations satisfy the facade contract', () => {
	test('the facade finds no catalog drift in the emitted stations', async () => {
		const { compiled, emission } = await emitVaultGit()
		const catalog = emission.stations.map((derived) => derived.station)

		// Discovery built from the specification's own command list, read
		// independently of the derivation that produced the stations.
		const discovery = {
			commands: Object.fromEntries(
				compiled.ir.commandSurface.commands.map((command) => [
					command,
					{
						script: `src/cli.ts ${command}`,
						summary: `${command} summary`,
						json: true,
						mutation: 'read',
						audience: 'agent',
						usage: [command],
						flags: {},
						exit_codes: {},
					},
				]),
			),
		}

		expect(findBranchStationCatalogDrift({ discovery, catalog })).toEqual([])
	})

	test('every station id follows the grammar and names its own command', async () => {
		const { emission } = await emitVaultGit()
		expect(emission.stations.length).toBeGreaterThan(0)

		for (const { station } of emission.stations) {
			expect({
				id: station.id,
				matchesGrammar: /^[a-z][a-z0-9:-]*\.[a-z][a-z0-9_:-]*$/.test(
					station.id,
				),
			}).toEqual({ id: station.id, matchesGrammar: true })
			expect(station.id.split('.')[0]).toBe(station.command)
		}
	})

	test('every station command is a command discovery declares', async () => {
		const { compiled, emission } = await emitVaultGit()
		const declared = new Set(compiled.ir.commandSurface.commands)
		for (const { station } of emission.stations) {
			expect({ id: station.id, known: declared.has(station.command) }).toEqual({
				id: station.id,
				known: true,
			})
		}
	})

	test('station ids are unique and canonically sorted', async () => {
		const { emission } = await emitVaultGit()
		const ids = emission.stationIds
		expect(new Set(ids).size).toBe(ids.length)
		expect([...ids]).toEqual([...ids].sort())
	})

	test('the expectation table joins every station to exactly one row', async () => {
		const { emission } = await emitVaultGit()
		const rowsByStation = new Map<string, number>()
		for (const row of emission.expectations) {
			rowsByStation.set(
				row.stationId,
				(rowsByStation.get(row.stationId) ?? 0) + 1,
			)
		}

		expect(emission.stations.length).toBeGreaterThan(0)
		for (const { station } of emission.stations) {
			expect({ id: station.id, rows: rowsByStation.get(station.id) }).toEqual({
				id: station.id,
				rows: 1,
			})
		}
		// No orphan rows either: the join is exact in both directions.
		expect(emission.expectations.length).toBe(emission.stations.length)
	})

	test('no station expects an exit code its command never declares', async () => {
		const { compiled, emission } = await emitVaultGit()
		const declared = new Set(
			Object.keys(compiled.ir.commandSurface.exitCodes).map((code) =>
				Number.parseInt(code, 10),
			),
		)
		for (const { station } of emission.stations) {
			if (station.expectedExitCode === undefined) continue
			expect({
				id: station.id,
				declared: declared.has(station.expectedExitCode),
			}).toEqual({ id: station.id, declared: true })
		}
	})

	test('no station expects a result contract the specification never declares', async () => {
		const { compiled, emission } = await emitVaultGit()
		const declared = new Set(
			Object.values(compiled.ir.commandSurface.resultContracts).map(
				(contract) => contract.id,
			),
		)
		for (const { station } of emission.stations) {
			if (station.expectedResultContractId === undefined) continue
			expect({
				id: station.id,
				declared: declared.has(station.expectedResultContractId),
			}).toEqual({ id: station.id, declared: true })
		}
	})

	test('emitted stations are assignable to the facade BranchStation type', async () => {
		const { emission } = await emitVaultGit()
		// The compile-time claim is proved by `bun run typecheck` over this
		// annotation; the runtime assertion keeps the test honest about arity.
		const catalog: readonly BranchStation[] = emission.stations.map(
			(derived) => derived.station,
		)
		expect(catalog.length).toBe(emission.stations.length)
	})
})
