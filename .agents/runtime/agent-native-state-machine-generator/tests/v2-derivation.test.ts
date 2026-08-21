import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	deriveArtifactSet,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

/**
 * The declared v2 surfaces reach derivation, not just the IR.
 *
 * A surface that is declared, validated, IR-carried and canonicalized but
 * never consulted closes no gap: derivation would go on refusing the same
 * columns it refused under v1. These prove the columns are derived FROM the
 * declaration, and that v1 input still refuses because it declares none of
 * it.
 *
 * Emission is not Specification Admission. The fixture is synthetic and
 * describes no real product.
 */

const V2_URL = new URL(
	'../fixtures/v2/declared-surfaces.jsonc',
	import.meta.url,
)

async function deriveV2() {
	const compiled = compileSpecificationCandidate(await Bun.file(V2_URL).text())
	if (!compiled.ok)
		throw new Error(
			`v2 fixture failed to compile: ${compiled.diagnostics
				.map((item) => item.cause)
				.join(', ')}`,
		)
	return {
		ir: compiled.ir,
		emission: deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		),
	}
}

describe('a v2 candidate derives a complete artifact set', () => {
	test('derivation emits rather than refusing', async () => {
		const { emission } = await deriveV2()

		// The headline claim: under v1 this same shape refused its blocker and
		// bare-invocation columns. Asserting "no refusals" alone would pass if
		// derivation emitted nothing at all, so the station count is asserted
		// too.
		expect(emission.ok).toBe(true)
		if (!emission.ok) return
		expect(emission.stations.length).toBeGreaterThan(0)
		expect(emission.expectations.length).toBeGreaterThan(0)
	})

	test('a refused station takes its blocker from the declared mapping', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// Independent oracle: what the fixture's station_blocker table declares
		// per command, restated here rather than recomputed from the IR.
		const declared: Readonly<Record<string, string>> = {
			'audit.refused': 'work_unavailable',
			'doctor.refused': 'work_unavailable',
			'purge.refused': 'owner_pause_active',
			'repair.refused': 'capability_missing',
		}
		const refused = emission.expectations.filter((row) =>
			row.stationId.endsWith('.refused'),
		)
		expect(refused.length).toBe(Object.keys(declared).length)
		for (const row of refused) {
			// Different commands take different blockers, so a station reading
			// one shared cause would fail here.
			expect({ station: row.stationId, blocker: row.blocker }).toEqual({
				station: row.stationId,
				blocker: declared[row.stationId],
			})
		}
	})

	test('the bare-invocation station binds to the declared command', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// The fixture declares bare_invocation_command "doctor", and the v1
		// convention would have looked for a command literally named "help".
		const bare = emission.stations.filter(
			(derived) => derived.noArgumentBehavior !== undefined,
		)
		expect(bare.length).toBe(1)
		expect(bare[0]?.station.command).toBe('doctor')
	})
})

describe('a table is selected by declared role, never by shape', () => {
	test('an advisory table declaring blockers cannot bind a station', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(
				new URL(
					'../fixtures/v2/derivation-no-station-blocker-role.jsonc',
					import.meta.url,
				),
			).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Positive control: a blocker-shaped route really is still declared, so
		// a derivation selecting by target kind and discriminant presence would
		// have consumed it. Only the declared role changed.
		const advisory = compiled.ir.routing.filter(
			(table) => table.role === 'advisory',
		)
		expect(advisory.length).toBeGreaterThan(0)
		expect(
			compiled.ir.routing.some((table) => table.role === 'station_blocker'),
		).toBe(false)

		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect([...new Set(emission.refusals.map((row) => row.cause))]).toEqual([
			'emit_expectation_column_underivable',
		])
	})

	test('a discriminant the station cannot supply makes every row ineligible', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(
				new URL(
					'../fixtures/v2/derivation-unsupplied-discriminant.jsonc',
					import.meta.url,
				),
			).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Positive control: the rows do carry the extra key, so they would match
		// on command and branch alone. Only the discriminant naming a fact no
		// Branch Station holds keeps them out.
		const table = compiled.ir.routing.find(
			(row) => row.role === 'station_blocker',
		)
		expect(table).toBeDefined()
		expect(Object.keys(table?.discriminants ?? {})).toContain('evidence')

		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)

		// Ineligible, never skipped: a row selecting on a key derivation could
		// only partly read would bind a station on evidence nobody supplied.
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		expect([...new Set(emission.refusals.map((row) => row.cause))]).toEqual([
			'emit_expectation_column_underivable',
		])
	})

	test('two rows selecting for one station are refused at compile', async () => {
		const result = compileSpecificationCandidate(
			await Bun.file(
				new URL(
					'../fixtures/v2/derivation-ambiguous-station-blocker.jsonc',
					import.meta.url,
				),
			).text(),
		)

		// Refused before derivation rather than at it: two rows sharing one
		// complete key is already an unroutable table, so the ambiguity never
		// reaches station binding.
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'semantic_competing_actions',
		])
	})
})

describe('a success station takes its action from the declared binding', () => {
	test('the bound action wins over any id-suffix convention', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// Positive control on the command the convention cannot reach: no
		// catalog id ends in `_audit`, `_repair` or `_purge`, so under the v1
		// suffix rule those three success rows would all fall back to `none`.
		// Their bound actions below are therefore the declaration answering,
		// not the convention. (`run_doctor` does end in `_doctor`, so doctor
		// alone cannot distinguish the two and is not the control.)
		const ids = ir.actions.catalog.map((row) => row.id)
		for (const command of ['audit', 'repair', 'purge']) {
			expect({
				command,
				matchedBySuffix: ids.some((id) => id.endsWith(`_${command}`)),
			}).toEqual({ command, matchedBySuffix: false })
		}

		const success = new Map(
			emission.expectations
				.filter((row) => row.stationId.endsWith('.success'))
				.map((row) => [row.stationId, row.expectedActionId]),
		)
		// Independent oracle: the fixture's station_actions rows restated.
		expect(Object.fromEntries(success)).toEqual({
			'audit.success': 'inspect_work',
			'doctor.success': 'run_doctor',
			'purge.success': 'none',
			'repair.success': 'run_doctor',
		})
	})

	test('binding a station is a separate claim from selecting a branch', async () => {
		const { ir } = await deriveV2()

		// G4 and G5 are two bindings. A fact table says which station is
		// reached; a station_action table says what that station's Next Safe
		// Action is. One standing in for the other is the substitution the gap
		// rows name.
		const roles = ir.routing.map((table) => table.role)
		expect(roles).toContain('fact_branch')
		expect(roles).toContain('station_action')
		const facts = ir.routing.find((table) => table.role === 'fact_branch')
		const actions = ir.routing.find((table) => table.role === 'station_action')
		expect(facts?.targetKind).toBe('branch_station')
		expect(actions?.targetKind).toBe('action')
	})
})

describe('the Write Preview obligation reads what the candidate declared', () => {
	test('a declared check mode and a declared exemption both satisfy it', async () => {
		const { ir, emission } = await deriveV2()

		// Positive control: two write-implying commands really are declared, so
		// the obligation is exercised rather than vacuously satisfied by a
		// surface of reads.
		const writes = Object.entries(ir.commandSurface.mutations)
			.filter(([, mutation]) => mutation === 'local_write')
			.map(([command]) => command)
			.sort()
		expect(writes).toEqual(['purge', 'repair'])
		// repair satisfies it with a check mode, purge with an exemption.
		expect(ir.commandSurface.executionModes.repair).toContain('check')
		expect(ir.commandSurface.previewExemptions.purge).toBeDefined()
		expect(emission.ok).toBe(true)
	})

	test('a write-implying command declaring neither is refused', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(
				new URL(
					'../fixtures/v2/derivation-write-preview-undeclarable.jsonc',
					import.meta.url,
				),
			).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)

		expect(emission.ok).toBe(false)
		if (emission.ok) return
		const preview = emission.refusals.filter(
			(row) => row.cause === 'emit_write_preview_undeclarable',
		)
		expect(preview.map((row) => row.subject)).toEqual(['repair'])
	})
})

describe('v1 input still refuses the columns it always refused', () => {
	test('the vault-git spike refuses without the declared surfaces', async () => {
		const compiled = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)

		// Positive control: this candidate declares none of the v2 surfaces, so
		// the fallbacks are what it still runs on. A change that made v1 derive
		// from a default rather than refusing would show up here.
		expect(compiled.ir.routing).toEqual([])
		expect(compiled.ir.commandSurface).not.toHaveProperty(
			'bareInvocationCommand',
		)
		expect(emission.ok).toBe(false)
	})
})
