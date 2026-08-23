import { describe, expect, test } from 'bun:test'
import {
	type ChangedState,
	compileSpecificationCandidate,
	deriveArtifactSet,
	type ResultChannel,
} from '../src/index.ts'
import { readCandidate, readFrozenV1Exemplar } from './support/candidates.ts'

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

describe('S4: capability gates and Pause Modes reach a consumer', () => {
	test('a capability emits its evidence binding and both routes', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('capability-gates.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// EMITS with counts: the declared capability reaches the module with
		// its Extension Point binding and its unavailable route.
		expect(ir.capabilities.length).toBe(1)
		expect(rendered.contents).toContain('"content_repair": {')
		expect(rendered.contents).toContain(
			'availabilityEvidence: "vault_git.content_repair_installed",',
		)
		expect(rendered.contents).toContain(
			'unavailableBlocker: "capability_missing",',
		)
		expect(rendered.contents).toContain(
			'unavailableAction: "escalate_to_operator",',
		)
	})

	test('no current availability value is emitted anywhere', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// The headline of the remodel: a candidate cannot author whether a
		// capability is installed, so nothing in the IR or the emitted set
		// carries that value. It is observed at runtime and stays outside the
		// Generated Artifact Set.
		for (const capability of ir.capabilities) {
			expect(capability).not.toHaveProperty('available')
		}

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('capability-gates.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return
		// Positive control: the module really does mention availability, so
		// the absent token below is the value being gone rather than the
		// whole subject being absent.
		expect(rendered.contents).toContain('availabilityEvidence:')

		// Scoped to the declared gate table. The selector below it does return
		// `available: true/false`, which is a route computed from evidence a
		// provider supplied - the opposite of an authored declaration, and the
		// thing this remodel exists to make possible.
		const lines = rendered.contents.split('\n')
		const start = lines.findIndex((line) =>
			line.includes('surfacesCapabilityGates = {'),
		)
		const end = lines.findIndex(
			(line, index) => index > start && line === '} as const',
		)
		expect(start).toBeGreaterThan(-1)
		expect(end).toBeGreaterThan(start)
		const table = lines.slice(start, end).join('\n')
		expect(table).toContain('availabilityEvidence:')
		expect(table).not.toContain('available: false')
		expect(table).not.toContain('available: true')
	})

	test('the emitted selector routes on supplied evidence, both ways', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('capability-gates.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// Evidence in, route out: the selector takes an observed value rather
		// than reading one out of the specification.
		expect(rendered.contents).toContain(
			'export function selectSurfacesCapabilityRoute(',
		)
		expect(rendered.contents).toContain('evidence: SurfacesCapabilityEvidence,')
		expect(rendered.contents).toContain('if (evidence.installed) {')
		expect(rendered.contents).toContain('blocker: gate.unavailableBlocker,')
	})

	test('routing is complete whatever the runtime observes', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Under the old model routing was required only for a capability the
		// author wrote `available: false` for, so one declared available could
		// uninstall at runtime and route nowhere. Both routes are now required
		// of every declared capability, whatever a provider later observes.
		for (const capability of compiled.ir.capabilities) {
			expect({
				name: capability.name,
				blocker: capability.unavailableBlocker.length > 0,
				action: capability.unavailableAction.length > 0,
			}).toEqual({ name: capability.name, blocker: true, action: true })
		}

		// A capability declaring no routing is refused before semantic
		// validation, because both routes are required fields.
		const source = await Bun.file(
			new URL('../fixtures/v2/capability-unroutable.jsonc', import.meta.url),
		).text()
		const refused = compileSpecificationCandidate(source, {
			sourcePath: 'capability-unroutable.jsonc',
		})
		expect(refused.ok).toBe(false)
		if (refused.ok) return
		expect([...new Set(refused.diagnostics.map((item) => item.cause))]).toEqual(
			['structure_missing_required'],
		)
	})

	test('a Pause Mode emits its owner and a request for release', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('pause-modes.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		expect(ir.pauseModes.length).toBe(1)
		expect(rendered.contents).toContain('"owner_pause": {')
		expect(rendered.contents).toContain('owner: "product_owner",')
		expect(rendered.contents).toContain('activeBlocker: "owner_pause_active",')
		// Requests release; never clears the Pause. The declared action is
		// human-owned, which compile validation holds.
		expect(rendered.contents).toContain(
			'releaseAction: "request_owner_pause_release",',
		)
		const release = ir.actions.catalog.find(
			(entry) => entry.id === ir.pauseModes[0]?.releaseAction,
		)
		expect(release?.kind).toBe('needs_human')
	})

	test('a product declaring neither gate emits neither module', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const without = deriveArtifactSet(
			{ ...compiled.ir, capabilities: [], pauseModes: [] },
			compiled.digest.specificationDigest,
		)
		expect(without.ok).toBe(true)
		if (!without.ok) return
		for (const name of ['capability-gates.ts', 'pause-modes.ts']) {
			expect({
				name,
				emitted: without.modules.some((module) => module.path.endsWith(name)),
			}).toEqual({ name, emitted: false })
		}
	})
})

describe('S3: Finding routing reaches a consumer', () => {
	test('the declared Doctor routing matrix emits every complete row', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('action-routing.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// EMITS with counts: the Finding x evidence key space is 2 x 2 and the
		// table claims complete coverage, so all four rows must be published.
		const findings = ir.routing.find(
			(table) => table.name === 'doctor_findings',
		)
		expect(findings).toBeDefined()
		expect(findings?.requiresCompleteCoverage).toBe(true)
		expect(findings?.rows.length).toBe(4)

		// Independent oracle: the routing matrix restated as literals.
		expect(rendered.contents).toContain('"doctor_findings": {')
		expect(rendered.contents).toContain(
			'key: { "evidence": "confirmed", "finding": "work_missing" },',
		)
		expect(rendered.contents).toContain('action: "run_doctor",')
		expect(rendered.contents).toContain(
			'key: { "evidence": "confirmed", "finding": "work_stale" },',
		)
		expect(rendered.contents).toContain('action: "inspect_work",')
	})

	test('G9: a human-owned route carries its declared handoff kind', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('action-routing.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// Both unreadable-evidence rows in the Doctor matrix escalate and both
		// name the handoff kind. Emitting the action without the handoff kind
		// would leave a caller knowing to escalate but not to whom.
		//
		// Scoped to the doctor_findings block: a sibling table declares its
		// own human-owned route, and counting the whole file would let one
		// table's rows stand in for another's.
		const lines = rendered.contents.split('\n')
		const start = lines.findIndex((line) =>
			line.includes('"doctor_findings": {'),
		)
		expect(start).toBeGreaterThan(-1)
		const nextTable = lines.findIndex(
			(line, index) => index > start && /^\t"/.test(line),
		)
		const block = lines.slice(start, nextTable === -1 ? undefined : nextTable)
		expect(
			block.filter((line) => line.includes('humanKind: "operator_handoff",'))
				.length,
		).toBe(2)
		expect(
			block.filter((line) => line.includes('retrySafety: "operator_required",'))
				.length,
		).toBe(2)
		expect(
			block.filter((line) => line.includes('retrySafety: "same_input_safe",'))
				.length,
		).toBe(2)
	})

	test('an advisory table is published as declared data, not as a binding', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// doctor_findings is declared advisory: derivation binds no station
		// from it. Publishing it as data is not the same as reading it as a
		// binding, and this holds the difference - no expectation row takes
		// its blocker or action from this table.
		const findings = ir.routing.find(
			(table) => table.name === 'doctor_findings',
		)
		expect(findings?.role).toBe('advisory')

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('action-routing.ts'),
		)
		expect(rendered?.contents).toContain('"doctor_findings": {')

		// The advisory table routes work_stale/confirmed to inspect_work. No
		// station's expected action comes from it: doctor's success action is
		// bound by the separate station_actions table to run_doctor.
		const doctorSuccess = emission.expectations.find(
			(row) => row.stationId === 'doctor.success',
		)
		expect(doctorSuccess?.expectedActionId).toBe('run_doctor')
	})
})

describe('S8: the fact_branch table selects a Branch Station', () => {
	test('every declared row emits the station it selects', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('fact-branch-routing.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// EMITS with counts: one declared fact_branch table with both rows.
		const declared = ir.routing.filter((table) => table.role === 'fact_branch')
		expect(declared.length).toBe(1)
		expect(declared[0]?.rows.length).toBe(2)
		const lines = rendered.contents.split('\n')
		expect(lines.filter((line) => line.includes('station:')).length).toBe(2)

		// Independent oracle: the declared pairs restated as literals.
		expect(rendered.contents).toContain(
			'{ key: { "work_present": "yes" }, station: "doctor.success" },',
		)
		expect(rendered.contents).toContain(
			'{ key: { "work_present": "no" }, station: "doctor.refused" },',
		)
	})

	test('every selected station exists in the derived catalog', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('fact-branch-routing.ts'),
		)
		expect(rendered).toBeDefined()

		// The A2 check makes this true by refusing at derivation, so a
		// published table can never name a station that will not exist.
		const derived = new Set(emission.stationIds)
		expect(derived.has('doctor.success')).toBe(true)
		expect(derived.has('doctor.refused')).toBe(true)
	})

	test('a table is read by its declared role, never by its shape', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Positive control: as declared, the fact_branch table is published.
		const asDeclared = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(asDeclared.ok).toBe(true)
		if (!asDeclared.ok) return
		expect(
			asDeclared.modules.some((module) =>
				module.path.endsWith('fact-branch-routing.ts'),
			),
		).toBe(true)

		// Demoted to advisory and nothing else changed: same discriminants,
		// same rows, same targets, same station-shaped ids. If derivation read
		// the table's shape rather than its declared role, this would still
		// publish. It must not.
		const demoted = deriveArtifactSet(
			{
				...compiled.ir,
				routing: compiled.ir.routing.map((table) =>
					table.role === 'fact_branch'
						? { ...table, role: 'advisory' as const }
						: table,
				),
			},
			compiled.digest.specificationDigest,
		)
		expect(demoted.ok).toBe(true)
		if (!demoted.ok) return
		expect(
			demoted.modules.some((module) =>
				module.path.endsWith('fact-branch-routing.ts'),
			),
		).toBe(false)
	})
})

describe('S12: activation positional routing reaches a consumer', () => {
	test('every declared positional token emits its canonical action', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('positional-routes.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// EMITS with counts: one routed command carrying two positional tokens
		// plus its bare alias.
		expect(ir.commandSurface.positionalRoutes.length).toBe(1)
		const route = ir.commandSurface.positionalRoutes[0]
		expect(Object.keys(route?.positionals ?? {}).length).toBe(2)

		// Independent oracle: the declared pairs restated as literals.
		expect(rendered.contents).toContain('"audit": {')
		expect(rendered.contents).toContain('"inspect": "inspect_work",')
		expect(rendered.contents).toContain('"repair": "run_doctor",')
		expect(rendered.contents).toContain('bareInvocationTarget: "inspect_work",')
	})

	test('every emitted target is a canonical action the catalog declares', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// A positional token is a public spelling, never a second action
		// vocabulary: everything it selects is already canonical.
		const canonical = new Set(ir.actions.catalog.map((entry) => entry.id))
		const targets = ir.commandSurface.positionalRoutes.flatMap((route) => [
			...Object.values(route.positionals),
			...(route.bareInvocationTarget === undefined
				? []
				: [route.bareInvocationTarget]),
		])
		expect(targets.length).toBeGreaterThan(0)
		for (const target of targets) {
			expect({ target, canonical: canonical.has(target) }).toEqual({
				target,
				canonical: true,
			})
		}
	})

	test('a product declaring no positional routes emits no module', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const without = deriveArtifactSet(
			{
				...compiled.ir,
				commandSurface: {
					...compiled.ir.commandSurface,
					positionalRoutes: [],
				},
			},
			compiled.digest.specificationDigest,
		)
		expect(without.ok).toBe(true)
		if (!without.ok) return
		expect(
			without.modules.some((module) =>
				module.path.endsWith('positional-routes.ts'),
			),
		).toBe(false)
	})
})

describe('S10 and S11: root branches and their distinct exit meanings', () => {
	test('every declared root branch is emitted with its exit and meaning', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('root-branches.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// EMITS with counts: all three declared front-door branches reach the
		// module. Asserting the module exists would pass with an empty table.
		expect(ir.commandSurface.rootBranches.length).toBe(3)
		const lines = rendered.contents.split('\n')
		expect(lines.filter((line) => line.includes('exitCode:')).length).toBe(3)
		expect(lines.filter((line) => line.includes('meaning:')).length).toBe(3)

		// Independent oracle: the declared triples restated as literals.
		expect(rendered.contents).toContain('"root_help": {')
		expect(rendered.contents).toContain('"unknown_command": {')
		expect(rendered.contents).toContain('"crash": {')
		expect(rendered.contents).toContain('meaning: "unexpected_failure",')
		// Declared only on the crash branch, so an absent action stays absent
		// rather than becoming the terminal one.
		expect(lines.filter((line) => line.includes('action:')).length).toBe(1)
		expect(rendered.contents).toContain('action: "escalate_to_operator",')
	})

	test('S11: an exit shared by two branches still carries two meanings', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// The crash path rides exit 1, and so does a command refusal. The
		// headline requirement is that exit 1 is not one word for two
		// branches: the root branch declares its own meaning, distinct from
		// any refusal's exit meaning on the same exit.
		const crash = ir.commandSurface.rootBranches.find(
			(branch) => branch.name === 'crash',
		)
		expect(crash).toBeDefined()
		expect(crash?.exitCode).toBe('1')

		const refusalMeanings = new Set(
			emission.expectations
				.filter((row) => row.stationId.endsWith('.refused'))
				.map((row) => row.exitMeaning),
		)
		expect(refusalMeanings.size).toBeGreaterThan(0)
		// A refusal and the crash both ride 1 and mean different things.
		expect(refusalMeanings.has(crash?.meaning ?? '')).toBe(false)
	})

	test('root branches are not emitted as Branch Stations', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// A station names the command that owns it and that command must be in
		// discovery. A root branch is reached before a command is selected, so
		// emitting one as a station would mean inventing a pseudo-command.
		for (const name of ['root_help', 'unknown_command', 'crash']) {
			expect({ name, isStation: emission.stationIds.includes(name) }).toEqual({
				name,
				isStation: false,
			})
		}
		for (const id of emission.stationIds) {
			expect({ id, hasCommand: id.includes('.') }).toEqual({
				id,
				hasCommand: true,
			})
		}
	})

	test('a product declaring no root branches emits no module', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const without = deriveArtifactSet(
			{
				...compiled.ir,
				commandSurface: { ...compiled.ir.commandSurface, rootBranches: [] },
			},
			compiled.digest.specificationDigest,
		)
		expect(without.ok).toBe(true)
		if (!without.ok) return
		expect(
			without.modules.some((module) =>
				module.path.endsWith('root-branches.ts'),
			),
		).toBe(false)
	})
})

describe('S2: declared wait semantics reach a consumer', () => {
	test('every declared observation is emitted with its bounds', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('observation-budgets.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// EMITS with counts: both declared observations reach the module, each
		// with its own missed-deadline cause. Asserting the module merely
		// exists would pass with an empty table.
		expect(ir.observations.length).toBe(2)
		const lines = rendered.contents.split('\n')
		expect(lines.filter((line) => line.includes('pollAfterMs:')).length).toBe(2)
		expect(
			lines.filter((line) => line.includes('attemptExpiryMs:')).length,
		).toBe(2)

		// Independent oracle: the declared values restated as literals.
		expect(rendered.contents).toContain('"work_task": {')
		expect(rendered.contents).toContain('"doctor_task": {')
		expect(rendered.contents).toContain('pollAfterMs: 5000,')
		expect(rendered.contents).toContain('attemptExpiryMs: 600000,')
		expect(rendered.contents).toContain(
			'missedDeadlineCause: "work_observation_expired",',
		)
		expect(rendered.contents).toContain(
			'missedDeadlineCause: "doctor_observation_expired",',
		)
		expect(rendered.contents).toContain('wakeRoute: "caller_reinvocation",')
	})

	test('the emitted bound is the declared one, not a generator default', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Positive control against a hardcoded number: a different declared
		// bound emits a different value.
		const moved = deriveArtifactSet(
			{
				...compiled.ir,
				observations: compiled.ir.observations.map((entry) => ({
					...entry,
					attemptExpiryMs: 123456,
				})),
			},
			compiled.digest.specificationDigest,
		)
		expect(moved.ok).toBe(true)
		if (!moved.ok) return

		const rendered = moved.modules.find((module) =>
			module.path.endsWith('observation-budgets.ts'),
		)
		expect(rendered?.contents).toContain('attemptExpiryMs: 123456,')
		expect(rendered?.contents).not.toContain('attemptExpiryMs: 600000,')
	})

	test('a product declaring no observations emits no wait surface', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const without = deriveArtifactSet(
			{ ...compiled.ir, observations: [] },
			compiled.digest.specificationDigest,
		)
		expect(without.ok).toBe(true)
		if (!without.ok) return
		expect(
			without.modules.some((module) =>
				module.path.endsWith('observation-budgets.ts'),
			),
		).toBe(false)
	})
})

describe('S1: contextual renderings reach a consumer', () => {
	test('a single-target rendering resolves and a multi-target one withholds', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// Independent oracle: what the fixture declares, restated as literals.
		// `inspect` names two canonical ids, `repair` names one.
		expect(emission.contextualRenderings.length).toBe(2)
		expect(emission.contextualRenderings).toEqual([
			{
				rendering: 'inspect',
				candidates: ['inspect_work', 'run_doctor'],
			},
			{
				rendering: 'repair',
				candidates: ['escalate_to_operator'],
				resolved: 'escalate_to_operator',
			},
		])

		// The headline claim: a rendering with more than one candidate carries
		// no resolved id. Picking one here would persist an unadmitted choice
		// as authority; ambiguity fails closed at resolution instead.
		const inspect = emission.contextualRenderings.find(
			(entry) => entry.rendering === 'inspect',
		)
		expect(inspect?.resolved).toBeUndefined()
		expect(inspect?.candidates.length).toBe(2)
	})

	test('every published candidate is a canonical action the catalog declares', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// A rendering is never a second action vocabulary: everything it can
		// resolve to must already be canonical.
		const canonical = new Set(ir.actions.catalog.map((entry) => entry.id))
		const published = emission.contextualRenderings.flatMap(
			(entry) => entry.candidates,
		)
		expect(published.length).toBeGreaterThan(0)
		for (const id of published) {
			expect({ id, canonical: canonical.has(id) }).toEqual({
				id,
				canonical: true,
			})
		}
	})

	test('an undeclared target is dropped, not published', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// One rendering keeps a declared target beside an undeclared one, and
		// one names only an undeclared target. The first must publish exactly
		// the declared id; the second must not appear at all.
		const withUnknown = deriveArtifactSet(
			{
				...compiled.ir,
				contextualRenderings: {
					...compiled.ir.contextualRenderings,
					partly_known: ['run_doctor', 'no_such_canonical_action'],
					wholly_unknown: ['no_such_canonical_action'],
				},
			},
			compiled.digest.specificationDigest,
		)
		expect(withUnknown.ok).toBe(true)
		if (!withUnknown.ok) return

		const partly = withUnknown.contextualRenderings.find(
			(entry) => entry.rendering === 'partly_known',
		)
		// The undeclared id is gone and the declared one remains, which also
		// makes the rendering single-target and therefore resolvable.
		expect(partly).toEqual({
			rendering: 'partly_known',
			candidates: ['run_doctor'],
			resolved: 'run_doctor',
		})

		expect(
			withUnknown.contextualRenderings.some(
				(entry) => entry.rendering === 'wholly_unknown',
			),
		).toBe(false)

		// Positive control: the token really would appear if it were published,
		// so its absence below is the filter working rather than a token no
		// emitter ever produces.
		const rendered = withUnknown.modules.find((module) =>
			module.path.endsWith('contextual-renderings.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return
		expect(rendered.contents).toContain('"partly_known": {')
		expect(rendered.contents).toContain('"run_doctor"')
		expect(rendered.contents).not.toContain('no_such_canonical_action')
	})

	test('the table reaches a rendered module', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('contextual-renderings.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		expect(rendered.contents).toContain('"repair": {')
		expect(rendered.contents).toContain('resolved: "escalate_to_operator",')
		// The ambiguous rendering renders its candidates and no resolved id.
		expect(rendered.contents).toContain(
			'candidates: ["inspect_work", "run_doctor"],',
		)
		const lines = rendered.contents.split('\n')
		expect(lines.filter((line) => line.includes('resolved:')).length).toBe(1)
	})

	test('a product declaring no renderings emits no module', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Positive control: the module really is emitted as declared, so the
		// absence below is the empty case and not a broken path.
		const asDeclared = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(asDeclared.ok).toBe(true)
		if (!asDeclared.ok) return
		expect(
			asDeclared.modules.some((module) =>
				module.path.endsWith('contextual-renderings.ts'),
			),
		).toBe(true)

		const without = deriveArtifactSet(
			{ ...compiled.ir, contextualRenderings: {} },
			compiled.digest.specificationDigest,
		)
		expect(without.ok).toBe(true)
		if (!without.ok) return
		expect(without.contextualRenderings.length).toBe(0)
		expect(
			without.modules.some((module) =>
				module.path.endsWith('contextual-renderings.ts'),
			),
		).toBe(false)
	})
})

describe('S13: the retryable projection reaches an emitter', () => {
	test('a bound row projects, an unbound row withholds', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// Independent oracle: the three outcomes restated as literals. `true`
		// where a declared station_action binding names a safe repeat of this
		// same invocation; `false` where a binding exists and a conjunct
		// genuinely fails; absent where nothing declares the binding at all.
		const expected: Readonly<Record<string, boolean | undefined>> = {
			'audit.refused': undefined,
			'audit.success': true,
			'doctor.no_argument': true,
			'doctor.refused': undefined,
			'doctor.success': true,
			'purge.refused': undefined,
			'purge.success': false,
			'repair.refused': undefined,
			'repair.success': false,
		}

		// EMITS with counts: the projection is not uniformly one value, which
		// a hardcoded default would be. Three true, two false, four withheld.
		const rows = emission.expectations
		expect(rows.length).toBe(9)
		expect(rows.filter((row) => row.retryable === true).length).toBe(3)
		expect(rows.filter((row) => row.retryable === false).length).toBe(2)
		expect(rows.filter((row) => row.retryable === undefined).length).toBe(4)

		for (const row of rows) {
			expect({ station: row.stationId, retryable: row.retryable }).toEqual({
				station: row.stationId,
				retryable: expected[row.stationId],
			})
		}
	})

	test('a false projection is a decided negative, not missing evidence', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// purge.success is bound and safe-postured nowhere: its action is the
		// terminal `none`, so a repeat is not this same invocation. repair
		// .success is bound but declares same_input_unsafe. Both are genuine
		// negatives that a withheld projection would have hidden.
		const purge = emission.expectations.find(
			(row) => row.stationId === 'purge.success',
		)
		const repair = emission.expectations.find(
			(row) => row.stationId === 'repair.success',
		)
		expect({
			purge: purge?.retryable,
			purgePosture: purge?.retrySafety,
			repair: repair?.retryable,
			repairPosture: repair?.retrySafety,
		}).toEqual({
			purge: false,
			purgePosture: 'operator_required',
			repair: false,
			repairPosture: 'same_input_unsafe',
		})
	})

	test('the projection reaches the rendered module', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('semantic-expectations.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		const lines = rendered.contents.split('\n')
		// Five rendered values for the five settled rows, and no line for the
		// four withheld ones.
		expect(lines.filter((line) => line.includes('retryable:')).length).toBe(5)
		expect(rendered.contents).toContain('retryable: true,')
		expect(rendered.contents).toContain('retryable: false,')
	})

	test('a durable-operations product withholds the projection entirely', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(V2_URL).text(),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		// Positive control: the fixture settles five rows as it stands, so the
		// zero below is the durable-operations rule firing rather than a
		// fixture that never projected anything.
		const asDeclared = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(asDeclared.ok).toBe(true)
		if (!asDeclared.ok) return
		expect(
			asDeclared.expectations.filter((row) => row.retryable !== undefined)
				.length,
		).toBe(5)

		// A repeat under durable operations may mint a new Logical Operation,
		// which no design-time specification decides.
		const durable = deriveArtifactSet(
			{
				...compiled.ir,
				features: { ...compiled.ir.features, durableOperations: true },
			},
			compiled.digest.specificationDigest,
		)
		expect(durable.ok).toBe(true)
		if (!durable.ok) return
		expect(
			durable.expectations.filter((row) => row.retryable !== undefined).length,
		).toBe(0)
	})
})

describe('S14: declared expectation columns reach the emitted table', () => {
	test('a declared station carries its columns and an undeclared one does not', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// Independent oracle: what the fixture declares, restated here rather
		// than read back out of the IR the emitter also read.
		const declared: Readonly<
			Record<string, { changedState: ChangedState; channel: ResultChannel }>
		> = {
			'audit.success': { changedState: 'partial', channel: 'both' },
			'doctor.refused': { changedState: 'unknown', channel: 'stderr' },
			'doctor.success': { changedState: 'none', channel: 'stdout' },
		}

		// EMITS, with counts: three stations carry columns out of nine rows.
		// Asserting "no refusals" would pass with zero columns emitted.
		expect(emission.expectations.length).toBe(9)
		const carrying = emission.expectations.filter(
			(row) => row.changedState !== undefined || row.channel !== undefined,
		)
		expect(carrying.length).toBe(3)
		expect(carrying.map((row) => row.stationId).sort()).toEqual(
			Object.keys(declared).sort(),
		)
		for (const row of carrying) {
			expect({
				station: row.stationId,
				changedState: row.changedState,
				channel: row.channel,
			}).toEqual({ station: row.stationId, ...declared[row.stationId] })
		}

		// The negative half: a station the candidate declared no columns for
		// gets none, rather than a default standing in for a declaration.
		const undeclaredRows = emission.expectations.filter(
			(row) => declared[row.stationId] === undefined,
		)
		expect(undeclaredRows.length).toBe(6)
		for (const row of undeclaredRows) {
			expect({
				station: row.stationId,
				changedState: row.changedState,
				channel: row.channel,
			}).toEqual({
				station: row.stationId,
				changedState: undefined,
				channel: undefined,
			})
		}

		// Positive control that the IR really carried three declarations, so
		// the count above is a binding and not an empty coincidence.
		expect(ir.expectationColumns.length).toBe(3)
	})

	test('the columns reach the rendered module a real process asserts against', async () => {
		const { emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		const rendered = emission.modules.find((module) =>
			module.path.endsWith('semantic-expectations.ts'),
		)
		expect(rendered).toBeDefined()
		if (rendered === undefined) return

		// A row carried in memory but never rendered leaves a real process with
		// nothing generated to assert against, which is the gap this row closes.
		const lines = rendered.contents.split('\n')
		expect(lines.filter((line) => line.includes('changedState:')).length).toBe(
			3,
		)
		expect(lines.filter((line) => line.includes('channel:')).length).toBe(3)
		expect(rendered.contents).toContain('changedState: "partial"')
		expect(rendered.contents).toContain('channel: "stderr"')
	})
})

describe('a Branch Station route resolves against the derived catalog', () => {
	const SUFFIX_URL = new URL(
		'../fixtures/v2/route-station-suffix-unknown.jsonc',
		import.meta.url,
	)

	test('a target whose branch suffix names no derived station refuses', async () => {
		const compiled = compileSpecificationCandidate(
			await Bun.file(SUFFIX_URL).text(),
			{ sourcePath: 'route-station-suffix-unknown.jsonc' },
		)

		// Positive control on the prefix: the fixture's command really is
		// declared, so this refusal cannot be the undeclared-command check
		// firing under another name. Compilation succeeds precisely because
		// every check available before the IR exists is satisfied.
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return
		expect(compiled.ir.commandSurface.commands).toContain('doctor')

		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		// Fail closed: a refused derivation publishes no artifacts at all.
		expect(emission).not.toHaveProperty('stations')
		expect(emission).not.toHaveProperty('modules')
		expect(
			emission.refusals.filter(
				(refusal) => refusal.cause === 'emit_route_station_unknown',
			),
		).toEqual([
			{
				cause: 'emit_route_station_unknown',
				subject: 'facts:doctor.typo_no_such_station',
				message:
					'Routing table facts targets Branch Station doctor.typo_no_such_station, which the derived catalog does not contain.',
			},
		])
	})

	test('every branch_station route in the valid fixture names a derived station', async () => {
		const { ir, emission } = await deriveV2()
		expect(emission.ok).toBe(true)
		if (!emission.ok) return

		// The positive control the refusal above needs: this fixture declares
		// branch_station routes and they all resolve, so the check discriminates
		// rather than refusing every route it sees.
		const targets = ir.routing
			.filter((table) => table.targetKind === 'branch_station')
			.flatMap((table) => table.rows.map((row) => row.target))
		expect(targets.length).toBeGreaterThan(0)

		const derived = new Set(emission.stationIds)
		for (const target of targets) {
			expect({ target, derived: derived.has(target) }).toEqual({
				target,
				derived: true,
			})
		}
	})
})

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
	test('the frozen v1 exemplar refuses without the declared surfaces', async () => {
		// The subject is v1 input, so it is the frozen v1 exemplar. The live
		// vault-git candidate declares these surfaces now, which is the change
		// this row must stay blind to.
		const compiled = compileSpecificationCandidate(await readFrozenV1Exemplar())
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

describe("the accepted candidate's own reserved blocker gap", () => {
	test('unamended derivation refuses on exactly the two reserved stations', async () => {
		// The pin the emission harness cites. Its supply exists only because
		// these two stations have no declared blocker, and a supply is only
		// honest while the gap it fills is exactly this wide.
		//
		// Deliberate independent oracle: the cause and the two subjects are
		// restated as literals. Reading them back from `ir.routing` would
		// compute expected and actual from the same source and prove nothing.
		// They are justified by the candidate's own bytes: `activation` is a
		// declared discriminant value with no row, and `commands` is a declared
		// command the discriminant list omits.
		//
		// No amendment: this is the accepted candidate exactly as it compiles,
		// so the refusals are the candidate's own and not the harness's.
		const compiled = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)

		expect(emission.ok).toBe(false)
		if (emission.ok) return
		// Exactly, not merely present: a `toContain` here would stay green if
		// the gap widened to a third station, which is the regression this pin
		// exists to catch.
		expect([...new Set(emission.refusals.map((row) => row.cause))]).toEqual([
			'emit_expectation_column_underivable',
		])
		expect(emission.refusals.map((row) => row.subject).sort()).toEqual([
			'activation.refused:blocker',
			'commands.refused:blocker',
		])
	})
})
