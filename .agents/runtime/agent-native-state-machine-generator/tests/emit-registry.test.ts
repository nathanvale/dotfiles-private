import { describe, expect, test } from 'bun:test'
import {
	type DeclaredExtensionPoint,
	type RegisteredExtension,
	reconcileExtensionRegistry,
} from '../src/index.ts'

/**
 * Gate 3: the four-cause Extension Registry suite. Missing, extra, stale and
 * orphaned are each refused, and a complete registry reconciles cleanly.
 *
 * Wildcard and fallback bindings are absent by design: the product owner ruled
 * them compile-time schema refusals, so they never reach reconciliation. A
 * signature mismatch is the type checker's job.
 */

const REVISION = 'rev-2'
const OLDER = 'rev-1'

const factProvider: DeclaredExtensionPoint = {
	id: 'vault_git.remote_lease_state',
	kind: 'fact_provider',
	specificationRevision: REVISION,
}
const proofAdapter: DeclaredExtensionPoint = {
	id: 'vault_git.publication_evidence',
	kind: 'proof_adapter',
	specificationRevision: REVISION,
}

function bind(id: string, revision = REVISION): RegisteredExtension {
	return { extensionPointId: id, specificationRevision: revision }
}

describe('Extension Registry reconciliation refuses each reachable cause', () => {
	test('a complete registry reconciles cleanly', () => {
		const result = reconcileExtensionRegistry({
			declared: [factProvider, proofAdapter],
			registered: [bind(factProvider.id), bind(proofAdapter.id)],
			currentRevision: REVISION,
		})

		expect(result.refusals).toEqual([])
		expect(result.reconciled).toBe(true)
	})

	test('missing: a declared Extension Point with no binding is refused', () => {
		const result = reconcileExtensionRegistry({
			declared: [factProvider, proofAdapter],
			registered: [bind(factProvider.id)],
			currentRevision: REVISION,
		})

		expect(result.reconciled).toBe(false)
		expect(result.refusals.map((refusal) => refusal.cause)).toEqual([
			'emit_registry_binding_missing',
		])
		expect(result.refusals[0]?.subject).toBe(proofAdapter.id)
	})

	test('extra: a binding for a never-declared point is refused', () => {
		const result = reconcileExtensionRegistry({
			declared: [factProvider],
			registered: [bind(factProvider.id), bind('vault_git.invented_point')],
			currentRevision: REVISION,
		})

		expect(result.reconciled).toBe(false)
		expect(result.refusals.map((refusal) => refusal.cause)).toEqual([
			'emit_registry_binding_extra',
		])
		expect(result.refusals[0]?.subject).toBe('vault_git.invented_point')
	})

	test('stale: a binding authored against an older revision is refused', () => {
		const result = reconcileExtensionRegistry({
			declared: [factProvider],
			registered: [bind(factProvider.id, OLDER)],
			currentRevision: REVISION,
		})

		expect(result.reconciled).toBe(false)
		expect(result.refusals.map((refusal) => refusal.cause)).toEqual([
			'emit_registry_binding_stale',
		])
		expect(result.refusals[0]?.subject).toBe(factProvider.id)
	})

	test('orphaned: a binding survives a withdrawn Extension Point', () => {
		// The point was declared at the binding's own revision and has since been
		// withdrawn from the specification, which is what separates orphaned from
		// a same-revision typo.
		const result = reconcileExtensionRegistry({
			declared: [factProvider],
			registered: [
				bind(factProvider.id),
				bind('vault_git.withdrawn_point', OLDER),
			],
			currentRevision: REVISION,
		})

		expect(result.reconciled).toBe(false)
		expect(result.refusals.map((refusal) => refusal.cause)).toEqual([
			'emit_registry_binding_orphaned',
		])
		expect(result.refusals[0]?.subject).toBe('vault_git.withdrawn_point')
	})

	test('all four causes surface together, deterministically ordered', () => {
		const result = reconcileExtensionRegistry({
			declared: [factProvider, proofAdapter],
			registered: [
				bind(factProvider.id, OLDER),
				bind('vault_git.invented_point'),
				bind('vault_git.withdrawn_point', OLDER),
			],
			currentRevision: REVISION,
		})

		expect(result.reconciled).toBe(false)
		expect(result.refusals.map((refusal) => refusal.cause)).toEqual([
			'emit_registry_binding_extra',
			'emit_registry_binding_missing',
			'emit_registry_binding_orphaned',
			'emit_registry_binding_stale',
		])
	})

	test('an empty specification with an empty registry reconciles', () => {
		const result = reconcileExtensionRegistry({
			declared: [],
			registered: [],
			currentRevision: REVISION,
		})
		expect(result).toEqual({ reconciled: true, refusals: [] })
	})
})
