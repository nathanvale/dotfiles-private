import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	deriveArtifactSet,
} from '../src/index.ts'

/**
 * Agent Worktree draft-candidate pinning (schema insurance, issue 55).
 *
 * The draft at fixtures/draft-candidates/ is UNADMITTED and is never schema
 * surface: Input Schema v1 stays frozen as the union of the two spike
 * candidates. These tests pin the draft's exact observed outcome - it
 * compiles cleanly, and derivation refuses with a fixed gap inventory - in
 * the expressiveness-gaps idiom. A later schema change that closes or opens
 * any gap fails loudly here and forces the decision back to the product
 * owner instead of letting a default paper over it. The gap-by-gap evidence
 * lives in receipts/agent-worktree-draft-gaps.md at the worktree root.
 */

const DRAFT_URL = new URL(
	'../fixtures/draft-candidates/agent-worktree.state-machine.jsonc',
	import.meta.url,
)

async function compileDraft() {
	const compiled = compileSpecificationCandidate(
		await Bun.file(DRAFT_URL).text(),
	)
	if (!compiled.ok) throw new Error('agent-worktree draft failed to compile')
	return compiled
}

async function deriveDraft() {
	const compiled = await compileDraft()
	return deriveArtifactSet(compiled.ir, compiled.digest.specificationDigest)
}

/**
 * Deliberate independent oracle: the public command list restated as a
 * literal (agent-worktree model.ts AGENT_WORKTREE_COMMANDS), never read back
 * from the IR the derivation itself consumed.
 */
const DRAFT_COMMANDS = [
	'attach',
	'check',
	'clean',
	'commands',
	'create',
	'delete',
	'doctor',
	'handoff',
	'inspect',
	'list',
	'recover',
	'refresh',
	'status',
] as const

/**
 * Deliberate independent oracle: the write-implying commands restated as a
 * literal rather than recomputed through isWriteImplyingMutation - it is the
 * same predicate the derivation branches on, and f(x) === f(x) proves
 * nothing.
 */
const WRITE_IMPLYING_COMMANDS = [
	'attach',
	'create',
	'delete',
	'refresh',
] as const

describe('the agent-worktree draft compiles under frozen Input Schema v1', () => {
	test('with zero diagnostics and a stable digest across two runs', async () => {
		const source = await Bun.file(DRAFT_URL).text()
		const first = compileSpecificationCandidate(source)
		const second = compileSpecificationCandidate(source)

		expect(first.diagnostics).toEqual([])
		expect(first.ok && second.ok).toBe(true)
		if (!first.ok || !second.ok) return
		expect(second.digest.specificationDigest).toBe(
			first.digest.specificationDigest,
		)
	})
})

describe('derivation refuses with exactly the pinned gap inventory', () => {
	test('the sealed refusal causes and their counts are pinned', async () => {
		const emission = await deriveDraft()
		expect(emission.ok).toBe(false)
		if (emission.ok) return
		// Fail closed: the failure variant carries no artifact fields.
		expect(emission).not.toHaveProperty('stations')
		expect(emission).not.toHaveProperty('modules')

		const counts: Record<string, number> = {}
		for (const refusal of emission.refusals) {
			counts[refusal.cause] = (counts[refusal.cause] ?? 0) + 1
		}
		// The pinned outcome observed on 2026-08-21: 13 commands times three
		// underivable columns (refused blocker, invalid-usage blocker, success
		// action binding), plus the bare-invocation binding gap, plus one
		// write-preview refusal per write-implying command. Any drift means a
		// schema gap opened or closed and the product owner must rule on it.
		expect(counts).toEqual({
			emit_expectation_column_underivable: 40,
			emit_write_preview_undeclarable: 4,
		})
	})

	test('every write-implying command is refused by name, none invented', async () => {
		const emission = await deriveDraft()
		expect(emission.ok).toBe(false)
		if (emission.ok) return

		const refused = emission.refusals
			.filter((refusal) => refusal.cause === 'emit_write_preview_undeclarable')
			.map((refusal) => refusal.subject)
			.sort()
		expect(refused).toEqual([...WRITE_IMPLYING_COMMANDS])
	})

	test('the bare-invocation binding gap fires for the declared help behavior', async () => {
		const emission = await deriveDraft()
		expect(emission.ok).toBe(false)
		if (emission.ok) return

		const bare = emission.refusals.filter(
			(refusal) => refusal.subject === 'no_argument_behavior:help',
		)
		expect(bare.length).toBe(1)
		const refusal = bare[0]
		expect(refusal).toBeDefined()
		if (refusal === undefined) return
		expect(refusal.cause).toBe('emit_expectation_column_underivable')
		expect(refusal.message.length).toBeGreaterThan(0)
	})

	test('every command hits the blocker-mapping and action-binding gaps', async () => {
		const emission = await deriveDraft()
		expect(emission.ok).toBe(false)
		if (emission.ok) return

		expect(DRAFT_COMMANDS.length).toBe(13)
		expect(emission.refusals.length).toBeGreaterThan(0)
		const subjects = new Set(
			emission.refusals
				.filter(
					(refusal) => refusal.cause === 'emit_expectation_column_underivable',
				)
				.map((refusal) => refusal.subject),
		)
		for (const command of DRAFT_COMMANDS) {
			for (const subject of [
				`${command}.refused:blocker`,
				`${command}.invalid_usage:blocker`,
				`${command}.success:expectedActionId`,
			]) {
				// Labelled comparison so a failure names the exact missing row.
				expect({ subject, present: subjects.has(subject) }).toEqual({
					subject,
					present: true,
				})
			}
		}
	})

	test('the draft refuses identically across two derivations', async () => {
		const first = await deriveDraft()
		const second = await deriveDraft()
		expect(first.ok).toBe(false)
		expect(JSON.stringify(first.refusals)).toBe(JSON.stringify(second.refusals))
	})
})
