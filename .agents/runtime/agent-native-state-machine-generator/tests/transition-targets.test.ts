import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	REGISTERED_READERS,
} from '../src/index.ts'
import { readCandidate, readNegativeFixture } from './support/candidates.ts'

/**
 * Transition targets validate against the DECLARED phase state (Agent
 * Worktree draft gap row 14).
 *
 * The check used to read `states.transaction_phase.values` literally, so a
 * product whose phase state carried any other name got no target checking at
 * all. The repair is a declaration, not a smarter guess: `phase_state` names
 * the owning state, and a candidate that declares transitions without it is
 * refused rather than judged against a state the generator chose for it.
 *
 * Legacy input keeps its historical binding through its Registered Reader, so
 * no new judgement is imposed on candidates nobody can re-admit.
 */

const V2_META =
	'"spec_meta": { "product": "base", "input_schema_version": "2" }'

/**
 * The base fixture on the current Input Schema Version, so these cases
 * exercise the declaration rather than a reader's frozen binding.
 */
async function v2Base(): Promise<string> {
	return (await readNegativeFixture('_base')).replace(
		/"spec_meta":\s*\{[^}]*\}/,
		V2_META,
	)
}

interface Amendment {
	readonly transitions?: string
	readonly states?: string
	readonly phaseState?: string
}

async function candidate({
	transitions,
	states,
	phaseState,
}: Amendment): Promise<string> {
	let source = await v2Base()
	if (transitions !== undefined)
		source = source.replace('"transitions": []', transitions)
	if (states !== undefined)
		source = source.replace(
			'"run_status": { "values": ["ok", "blocked"], "terminal": ["ok", "blocked"] },',
			states,
		)
	if (phaseState !== undefined)
		source = source.replace(
			'"transitions"',
			`"phase_state": ${JSON.stringify(phaseState)},\n\t"transitions"`,
		)
	return source
}

const ONE_TRANSITION =
	'"transitions": [{ "event": "finished", "to_phase": "ok", "driver": "command" }]'

describe('the declared phase state owns transition targets', () => {
	test('a target the declared state declares is accepted', async () => {
		const source = await candidate({
			transitions: ONE_TRANSITION,
			phaseState: 'run_status',
		})
		// Positive control: no state here is named transaction_phase, so this
		// proves the declaration is what carries the check.
		expect(source).not.toContain('transaction_phase')

		const result = compileSpecificationCandidate(source)

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
	})

	test('a target the declared state does not declare is refused', async () => {
		const source = await candidate({
			transitions:
				'"transitions": [{ "event": "finished", "to_phase": "nowhere", "driver": "command" }]',
			phaseState: 'run_status',
		})

		const result = compileSpecificationCandidate(source, {
			sourcePath: 'transition-target.jsonc',
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'semantic_unresolved_reference',
		])
		const diagnostic = result.diagnostics[0]
		expect(diagnostic).toBeDefined()
		if (diagnostic === undefined) return
		expect(diagnostic.path).toBe('transitions[0].to_phase')
		expect(diagnostic.message).toContain('run_status')
	})

	test('a differently named declared state carries the check', async () => {
		const source = await candidate({
			transitions:
				'"transitions": [{ "event": "finished", "to_phase": "settled", "driver": "command" }]',
			states:
				'"lifecycle_phase": { "values": ["settled", "pending"], "terminal": ["settled"] },',
			phaseState: 'lifecycle_phase',
		})

		const result = compileSpecificationCandidate(source)

		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
	})
})

describe('an unusable declaration fails closed', () => {
	test('transitions with no declaration are refused, not guessed', async () => {
		const source = await candidate({ transitions: ONE_TRANSITION })
		expect(source).not.toContain('phase_state')

		const result = compileSpecificationCandidate(source, {
			sourcePath: 'missing-phase-state.jsonc',
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'semantic_missing_phase_state',
		])
		expect(result.diagnostics[0]?.path).toBe('phase_state')
	})

	test('a declaration naming an undeclared state is refused', async () => {
		const source = await candidate({
			transitions: ONE_TRANSITION,
			phaseState: 'no_such_state',
		})

		const result = compileSpecificationCandidate(source)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'semantic_unresolved_reference',
		])
		expect(result.diagnostics[0]?.path).toBe('phase_state')
	})

	/**
	 * The ambiguity boundary the removed inference could not reach. Two states
	 * both declare every target, so coverage cannot choose between them; the
	 * declaration decides and the other state is irrelevant.
	 */
	test('two states covering every target are resolved by the declaration', async () => {
		const both =
			'"run_status": { "values": ["ok", "blocked"], "terminal": ["ok", "blocked"] },\n\t\t"mirror_status": { "values": ["ok", "blocked"], "terminal": ["ok", "blocked"] },'
		const first = await candidate({
			transitions: ONE_TRANSITION,
			states: both,
			phaseState: 'run_status',
		})
		const second = await candidate({
			transitions: ONE_TRANSITION,
			states: both,
			phaseState: 'mirror_status',
		})

		for (const [label, source] of [
			['run_status', first],
			['mirror_status', second],
		] as const) {
			const result = compileSpecificationCandidate(source)
			expect({ label, ok: result.ok }).toEqual({ label, ok: true })
		}
	})

	/**
	 * Zero overlap: no state declares the target. Coverage inference would have
	 * picked a state anyway; the declaration makes the refusal name the state
	 * the product chose.
	 */
	test('a target no state declares is refused against the declared owner', async () => {
		const source = await candidate({
			transitions:
				'"transitions": [{ "event": "finished", "to_phase": "unheard_of", "driver": "command" }]',
			states:
				'"run_status": { "values": ["ok"], "terminal": ["ok"] },\n\t\t"other_status": { "values": ["done"], "terminal": ["done"] },',
			phaseState: 'other_status',
		})

		const result = compileSpecificationCandidate(source)

		expect(result.ok).toBe(false)
		if (result.ok) return
		const diagnostic = result.diagnostics[0]
		expect(diagnostic?.cause).toBe('semantic_unresolved_reference')
		// Named against the declared owner, never against the state that
		// happened to cover the most targets.
		expect(diagnostic?.message).toContain('other_status')
		expect(diagnostic?.message).not.toContain('run_status')
	})
})

describe('legacy input keeps its frozen binding', () => {
	test('the vault-git spike still compiles under its reader', async () => {
		const source = await readCandidate('vault-git')
		// Positive control: the frozen binding names the state this candidate
		// declares, and the candidate declares no phase_state of its own.
		expect(source).toContain('"transaction_phase"')
		expect(source).not.toContain('"phase_state"')

		const result = compileSpecificationCandidate(source)
		expect(result.diagnostics).toEqual([])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.registeredReader).toBe(
			REGISTERED_READERS['spike-draft-1'].name,
		)
	})

	test('a bad target in that candidate is still refused', async () => {
		const source = (await readCandidate('vault-git')).replace(
			'{ "event": "lease_won", "to_phase": "leased", "driver": "command" }',
			'{ "event": "lease_won", "to_phase": "not_a_phase", "driver": "command" }',
		)

		const result = compileSpecificationCandidate(source)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(
			result.diagnostics.some(
				(item) =>
					item.cause === 'semantic_unresolved_reference' &&
					item.path.endsWith('.to_phase'),
			),
		).toBe(true)
	})

	test('the frozen binding is the historical state name', () => {
		for (const version of ['1', 'spike-draft-1'] as const) {
			expect({
				version,
				frozen: REGISTERED_READERS[version].frozenPhaseState,
			}).toEqual({ version, frozen: 'transaction_phase' })
		}
	})
})
