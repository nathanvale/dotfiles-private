import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	type DiagnosticCause,
	EXECUTION_MODES,
	type SpecificationIr,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'

/**
 * Input Schema v2 declared surfaces (issue 55 stage-5 charter).
 *
 * One test per charter row the coverage matrix marks implement: the candidate
 * declares the surface, the compiler admits it, and the IR carries what was
 * declared. Every expected value is restated here as a literal rather than
 * read back through the builder under test.
 *
 * Surfacing, never inventing: each row asserts the shape a recorded ruling
 * names, and none of them gives the surface a value on a product's behalf.
 * This fixture is synthetic and describes no real product; compiling it is
 * never Specification Admission.
 */

const V2_URL = new URL(
	'../fixtures/v2/declared-surfaces.jsonc',
	import.meta.url,
)

async function v2Ir(): Promise<SpecificationIr> {
	const result = compileSpecificationCandidate(await Bun.file(V2_URL).text(), {
		sourcePath: 'declared-surfaces.jsonc',
	})
	if (!result.ok)
		throw new Error(
			`v2 fixture failed to compile: ${result.diagnostics
				.map((item) => `${item.cause}@${item.path}`)
				.join(', ')}`,
		)
	return result.ir
}

describe('the v2 fixture compiles on the current Input Schema Version', () => {
	test('it declares version 2 and takes no Registered Reader', async () => {
		const result = compileSpecificationCandidate(await Bun.file(V2_URL).text())

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.ir.specMeta.inputSchemaVersion).toBe('2')
		expect(result.registeredReader).toBeUndefined()
	})

	test('compiling twice is byte-identical', async () => {
		const source = await Bun.file(V2_URL).text()
		const first = compileSpecificationCandidate(source)
		const second = compileSpecificationCandidate(source)

		expect(first.ok && second.ok).toBe(true)
		if (!first.ok || !second.ok) return
		expect(second.digest.canonicalForm).toBe(first.digest.canonicalForm)
		expect(second.digest.specificationDigest).toBe(
			first.digest.specificationDigest,
		)
	})
})

describe('S1: contextual renderings reach the IR', () => {
	test('each rendering carries its canonical ids, a bare string normalized', async () => {
		const ir = await v2Ir()

		// A single target declared as a bare string becomes a one-item list, so
		// a consumer reads one shape rather than two.
		expect(ir.contextualRenderings).toEqual({
			inspect: ['inspect_work', 'run_doctor'],
			repair: ['escalate_to_operator'],
		})
	})
})

describe('S2: wait semantics reach the IR', () => {
	test('poll-after, per-Attempt expiry and Wake Route are carried per observation', async () => {
		const ir = await v2Ir()

		expect(ir.observations).toEqual([
			{
				name: 'doctor_task',
				pollAfterMs: 5000,
				attemptExpiryMs: 600000,
				wakeRoute: 'caller_reinvocation',
				missedDeadlineCause: 'doctor_observation_expired',
			},
			{
				name: 'work_task',
				pollAfterMs: 5000,
				attemptExpiryMs: 600000,
				wakeRoute: 'caller_reinvocation',
				missedDeadlineCause: 'work_observation_expired',
			},
		])
	})
})

describe('S3, S6, S8, S12: Routing Tables reach the IR', () => {
	test('every declared table is carried, sorted by name', async () => {
		const ir = await v2Ir()

		expect(ir.routing.map((table) => table.name)).toEqual([
			'blockers',
			'doctor_findings',
			'facts',
			'station_actions',
		])
	})

	test('a Finding-plus-evidence key selects exactly one action', async () => {
		const ir = await v2Ir()
		const doctor = ir.routing.find((table) => table.name === 'doctor_findings')

		expect(doctor).toBeDefined()
		if (doctor === undefined) return
		expect(doctor.targetKind).toBe('action')
		// The closed key space the ruling names, declared rather than implied
		// by whichever rows happen to exist.
		expect(doctor.discriminants).toEqual({
			evidence: ['confirmed', 'unreadable'],
			finding: ['work_missing', 'work_stale'],
		})
		expect(doctor.rows[0]).toEqual({
			key: { evidence: 'confirmed', finding: 'work_missing' },
			target: 'run_doctor',
			retrySafety: 'same_input_safe',
		})
	})

	test('a blocker row carries its action and posture, and a per-row handoff kind', async () => {
		const ir = await v2Ir()
		const blockers = ir.routing.find((table) => table.name === 'blockers')

		expect(blockers).toBeDefined()
		if (blockers === undefined) return
		// Keyed on what a station holds; the blocker is the row's answer, so
		// which blocker refuses which command is declared rather than shared.
		expect(blockers.role).toBe('station_blocker')
		expect(blockers.rows.length).toBe(4)
		expect(blockers.rows[0]).toEqual({
			key: { branch: 'refused', command: 'doctor' },
			blocker: 'work_unavailable',
			target: 'wait_for_work',
			retrySafety: 'same_input_safe',
		})
		// Different commands declare different blockers, which is the whole
		// point of the mapping.
		expect(blockers.rows.map((row) => row.blocker)).toEqual([
			'work_unavailable',
			'work_unavailable',
			'capability_missing',
			'owner_pause_active',
		])
	})

	test('fact-to-branch selection carries Branch Station targets', async () => {
		const ir = await v2Ir()
		const facts = ir.routing.find((table) => table.name === 'facts')

		expect(facts).toBeDefined()
		if (facts === undefined) return
		expect(facts.targetKind).toBe('branch_station')
		expect(facts.rows).toEqual([
			{ key: { work_present: 'yes' }, target: 'doctor.success' },
			{ key: { work_present: 'no' }, target: 'doctor.refused' },
		])
	})

	test('a row omitting the optional columns carries neither', async () => {
		const ir = await v2Ir()
		const facts = ir.routing.find((table) => table.name === 'facts')
		const row = facts?.rows[0]

		expect(row).toBeDefined()
		if (row === undefined) return
		// Absent, not defaulted: a row that declares no posture inherits none.
		expect(row).not.toHaveProperty('retrySafety')
		expect(row).not.toHaveProperty('humanKind')
	})

	test('S12: activation positional routing is a command-surface fact', async () => {
		const ir = await v2Ir()

		// Declared on the command surface rather than as a generic evidence
		// table: how a command parses is not what observed evidence means.
		expect(ir.commandSurface.positionalRoutes).toEqual([
			{
				command: 'audit',
				positionals: { inspect: 'inspect_work', repair: 'run_doctor' },
				bareAlias: 'inspect_work',
			},
		])
	})
})

describe('S4: Capability Availability and Pause Mode reach the IR', () => {
	test('an unavailable capability carries where it routes', async () => {
		const ir = await v2Ir()

		expect(ir.capabilities).toEqual([
			{
				name: 'content_repair',
				available: false,
				unavailableBlocker: 'capability_missing',
				unavailableAction: 'escalate_to_operator',
			},
		])
	})

	test('a Pause Mode carries its owner, blocker and human-owned release', async () => {
		const ir = await v2Ir()

		expect(ir.pauseModes).toEqual([
			{
				name: 'owner_pause',
				owner: 'product_owner',
				activeBlocker: 'owner_pause_active',
				releaseAction: 'request_owner_pause_release',
			},
		])
	})
})

describe('S5, S7, S9, S10, S11: the command surface reaches the IR', () => {
	test('execution modes and a declared preview exemption are carried', async () => {
		const ir = await v2Ir()

		expect(ir.commandSurface.executionModes).toEqual({
			doctor: ['normal', 'check'],
			audit: ['normal'],
			repair: ['normal', 'check'],
			purge: ['normal'],
		})
		expect(ir.commandSurface.previewExemptions).toEqual({
			purge: 'purge is irreversible by design and has no meaningful preview',
		})
	})

	test('the declared modes come from the sealed vocabulary', async () => {
		const ir = await v2Ir()
		const declared = Object.values(ir.commandSurface.executionModes).flat()

		expect(declared.length).toBeGreaterThan(0)
		for (const mode of declared) {
			expect({
				mode,
				sealed: (EXECUTION_MODES as readonly string[]).includes(mode),
			}).toEqual({ mode, sealed: true })
		}
	})

	test('bare invocation binds to a declared command', async () => {
		const ir = await v2Ir()

		expect(ir.commandSurface.bareInvocationCommand).toBe('doctor')
		// The binding names a real command rather than relying on a naming
		// convention that matches nothing on a differently named product.
		expect(ir.commandSurface.commands).toContain('doctor')
	})

	test('the entry script is carried', async () => {
		const ir = await v2Ir()

		expect(ir.commandSurface.entryScript).toBe('src/cli.ts')
	})

	test('root branches carry distinct declared exit-1 meanings', async () => {
		const ir = await v2Ir()

		expect(ir.commandSurface.rootBranches).toEqual([
			{
				name: 'crash',
				exitCode: '1',
				meaning: 'unexpected_failure',
				action: 'escalate_to_operator',
			},
			{ name: 'root_help', exitCode: '0', meaning: 'usable_evidence' },
			{ name: 'unknown_command', exitCode: '2', meaning: 'invalid_usage' },
		])
	})

	test('the crash branch declares a meaning the command exits do not', async () => {
		const ir = await v2Ir()
		const crash = ir.commandSurface.rootBranches.find(
			(branch) => branch.name === 'crash',
		)

		expect(crash).toBeDefined()
		if (crash === undefined) return
		// The whole point of S11: exit 1 already means "blocked" for a command,
		// so the crash path riding exit 1 needs its own declared meaning rather
		// than silently borrowing that one.
		expect(ir.commandSurface.exitCodes['1']).toBe('blocked')
		expect(crash.meaning).not.toBe(ir.commandSurface.exitCodes['1'])
	})
})

describe('S14: changed_state and channel reach the IR', () => {
	test('each declared branch carries both columns, sorted by name', async () => {
		const ir = await v2Ir()

		expect(ir.expectationColumns).toEqual([
			{ name: 'audit.success', changedState: 'partial', channel: 'both' },
			{ name: 'doctor.refused', changedState: 'unknown', channel: 'stderr' },
			{ name: 'doctor.success', changedState: 'none', channel: 'stdout' },
		])
	})
})

describe('the v2 surfaces stay absent for v1 input', () => {
	test('a v1 candidate carries every new surface empty, and none invented', async () => {
		const result = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		const { ir } = result
		// Positive control: this candidate really is v1-era input, so the
		// emptiness below is the absence of a declaration rather than a fixture
		// that simply had nothing to carry.
		expect(ir.specMeta.inputSchemaVersion).toBe('spike-draft-1')

		expect(ir.routing).toEqual([])
		expect(ir.capabilities).toEqual([])
		expect(ir.pauseModes).toEqual([])
		expect(ir.observations).toEqual([])
		expect(ir.expectationColumns).toEqual([])
		expect(ir.commandSurface.executionModes).toEqual({})
		expect(ir.commandSurface.previewExemptions).toEqual({})
		expect(ir.commandSurface.rootBranches).toEqual([])
		expect(ir.commandSurface).not.toHaveProperty('bareInvocationCommand')
		expect(ir.commandSurface).not.toHaveProperty('entryScript')
	})

	test('v1 contextual renderings still reach the IR', async () => {
		const result = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		// S1 is carriage of a surface v1 already declared, so this one is
		// populated for legacy input where the other v2 rows are empty.
		expect(Object.keys(result.ir.contextualRenderings).length).toBeGreaterThan(
			0,
		)
	})
})

describe('every new IR list is codepoint-ordered', () => {
	test('named surfaces sort by name, so a caller-visible list is stable', async () => {
		const ir = await v2Ir()
		const lists = [
			['capabilities', ir.capabilities.map((row) => row.name)],
			['pauseModes', ir.pauseModes.map((row) => row.name)],
			['observations', ir.observations.map((row) => row.name)],
			['expectationColumns', ir.expectationColumns.map((row) => row.name)],
			['rootBranches', ir.commandSurface.rootBranches.map((row) => row.name)],
			['routing', ir.routing.map((table) => table.name)],
		] as const

		expect(lists.length).toBeGreaterThan(0)
		for (const [label, names] of lists) {
			// Bare sort() is codepoint order, and is deliberately not the
			// comparator the builder used: comparing a list against its own
			// comparator would prove nothing about the order chosen.
			expect({ label, names: [...names] }).toEqual({
				label,
				names: [...names].sort(),
			})
		}
	})
})

/**
 * The command-surface v2 declarations resolve what they name.
 *
 * A surface that passes only a shape check accepts an action id nothing
 * declares, and the generator would carry that reference into an artifact
 * unchallenged. These were declared and structurally checked but not
 * resolved, which is the half of gate check 6 an earlier handback overstated.
 */
describe('a v2 command-surface declaration resolves its references', () => {
	const REFUSALS: ReadonlyArray<{
		readonly fixture: string
		readonly cause: DiagnosticCause
		readonly claim: string
	}> = [
		{
			fixture: 'positional-unknown-action',
			cause: 'semantic_unresolved_reference',
			claim: 'a positional selecting an undeclared action',
		},
		{
			fixture: 'positional-unknown-bare-alias',
			cause: 'semantic_unresolved_reference',
			claim: 'a bare alias selecting an undeclared action',
		},
		{
			fixture: 'root-branch-unknown-action',
			cause: 'semantic_unresolved_reference',
			claim: 'a root branch naming an undeclared action',
		},
		{
			fixture: 'root-branch-shared-meaning',
			cause: 'semantic_free_text_branch_value',
			claim: 'two branches on one exit claiming the same meaning',
		},
		{
			fixture: 'expectation-columns-unknown-command',
			cause: 'semantic_unresolved_reference',
			claim: 'expectation columns for a command that does not exist',
		},
		{
			fixture: 'capability-escalation-not-human',
			cause: 'semantic_missing_authority_semantics',
			claim: 'an unavailable capability escalating to non-human work',
		},
	]

	test('the refusal registry is non-empty', () => {
		expect(REFUSALS.length).toBeGreaterThan(0)
	})

	for (const { fixture, cause, claim } of REFUSALS) {
		test(`${fixture}: ${claim}`, async () => {
			const result = compileSpecificationCandidate(
				await Bun.file(
					new URL(`../fixtures/v2/${fixture}.jsonc`, import.meta.url),
				).text(),
				{ sourcePath: `${fixture}.jsonc` },
			)

			expect({ fixture, ok: result.ok }).toEqual({ fixture, ok: false })
			if (result.ok) return
			expect(result).not.toHaveProperty('ir')
			expect(result).not.toHaveProperty('digest')
			expect({
				fixture,
				causes: [...new Set(result.diagnostics.map((item) => item.cause))],
			}).toEqual({ fixture, causes: [cause] })
			expect(result.diagnostics[0]?.location.line).toBeGreaterThan(0)
		})
	}

	test('an undeclared root exit code is refused by the sealed enum', async () => {
		const result = compileSpecificationCandidate(
			await Bun.file(
				new URL(
					'../fixtures/v2/root-branch-undeclared-exit.jsonc',
					import.meta.url,
				),
			).text(),
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		// Stronger than the semantic check: exit codes are a sealed vocabulary,
		// so an exit outside it never reaches the reference check at all.
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'structure_value_not_permitted',
		])
	})

	test('the capability escalation rule is the compiler', async () => {
		const ir = await v2Ir()
		const capability = ir.capabilities[0]
		expect(capability).toBeDefined()
		if (capability === undefined) return

		// Deliberately not asserting the fixture's own chosen action is
		// needs_human: that would prove the fixture author's choice. The
		// property under test is that the compiler refuses any other kind,
		// which the capability-escalation-not-human fixture above holds.
		expect(capability.available).toBe(false)
		expect(capability.unavailableAction).toBeDefined()
	})
})
