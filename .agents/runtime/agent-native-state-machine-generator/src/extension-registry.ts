/**
 * The Extension Registry contract.
 *
 * An Extension Registry is the exhaustive binding from each declared Extension
 * Point to exactly one Handwritten Extension. Reconciliation checks the four
 * reachable causes the product owner admitted: missing, extra, stale and
 * orphaned. Wildcard and fallback bindings are compile-time schema refusals,
 * not reconciliation outcomes, and a signature mismatch is the type checker's
 * job  -  so none of the three appears here.
 *
 * Reconciliation is a pure function over declared-versus-registered inputs. It
 * reads no filesystem, imports no product module, and executes no extension.
 *
 * It is a deliberately separate seam from `deriveArtifactSet`. An Extension
 * Registry is reconciled against the product's real bindings, which the
 * generator cannot see from a Specification Candidate alone; folding it into
 * artifact emission would make emission appear to prove something it never
 * observed. A caller reconciles the registry with its own inputs.
 */
import {
	type ArtifactRefusal,
	artifactRefusal,
	sortRefusals,
} from './refusal.ts'

/**
 * The six feature-conditioned Handwritten Extension kinds the specification
 * permits. Nothing outside this list may bind, which is what keeps the seam
 * from becoming a generic policy hook. A Handwritten Extension fulfils one
 * declared Extension Point without adding or ranking state-machine meanings.
 */
export const EXTENSION_POINT_KINDS = [
	'fact_provider',
	'input_binder',
	'effect_executor',
	'liveness_evidence_provider',
	'real_process_fixture',
	'proof_adapter',
] as const

export type ExtensionPointKind = (typeof EXTENSION_POINT_KINDS)[number]

/**
 * One declared Extension Point: a stable specification-owned identity and
 * typed seam for named product-specific behavior or proof that the
 * specification cannot derive mechanically.
 */
export interface DeclaredExtensionPoint {
	readonly id: string
	readonly kind: ExtensionPointKind
	/** The specification revision that declared this point. */
	readonly specificationRevision: string
}

/** One Handwritten Extension bound to an Extension Point id. */
export interface RegisteredExtension {
	readonly extensionPointId: string
	/** The specification revision this binding was authored against. */
	readonly specificationRevision: string
}

export interface RegistryReconciliation {
	readonly reconciled: boolean
	readonly refusals: readonly ArtifactRefusal[]
}

/**
 * Reconciles declared Extension Points against registered Handwritten
 * Extensions.
 *
 * The four causes are distinct and each names its own repair:
 *
 * - `missing`   -  a declared point has no binding; author the extension.
 * - `extra`     -  a binding names a point the specification never declared.
 * - `stale`     -  a binding was authored against an older specification
 *                revision, so its meaning may no longer be the admitted one.
 * - `orphaned`  -  a binding survives for a point the specification withdrew.
 *
 * `extra` and `orphaned` differ by intent, not by shape: extra means the point
 * was never declared at this revision, orphaned means it was declared at the
 * binding's own revision and has since been withdrawn. Keeping them apart lets
 * a repair distinguish a typo from a deliberate removal.
 */
export function reconcileExtensionRegistry(input: {
	readonly declared: readonly DeclaredExtensionPoint[]
	readonly registered: readonly RegisteredExtension[]
	/** The revision the current Admitted State-Machine Specification carries. */
	readonly currentRevision: string
}): RegistryReconciliation {
	const refusals: ArtifactRefusal[] = []
	const declaredById = new Map(input.declared.map((point) => [point.id, point]))
	const registeredById = new Map(
		input.registered.map((binding) => [binding.extensionPointId, binding]),
	)

	for (const point of input.declared) {
		if (!registeredById.has(point.id)) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_registry_binding_missing',
					subject: point.id,
					message: `Extension Point ${point.id} is declared but no Handwritten Extension is bound to it.`,
				}),
			)
		}
	}

	for (const binding of input.registered) {
		const point = declaredById.get(binding.extensionPointId)
		if (point === undefined) {
			// A binding authored against the current revision for an undeclared
			// point is a typo or an invention; one authored against an older
			// revision is the residue of a point that was withdrawn.
			const cause =
				binding.specificationRevision === input.currentRevision
					? 'emit_registry_binding_extra'
					: 'emit_registry_binding_orphaned'
			refusals.push(
				artifactRefusal({
					cause,
					subject: binding.extensionPointId,
					message:
						cause === 'emit_registry_binding_extra'
							? `Handwritten Extension binds ${binding.extensionPointId}, which the specification never declared.`
							: `Handwritten Extension binds ${binding.extensionPointId}, an Extension Point the specification withdrew.`,
				}),
			)
			continue
		}
		if (binding.specificationRevision !== input.currentRevision) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_registry_binding_stale',
					subject: binding.extensionPointId,
					message: `Handwritten Extension for ${binding.extensionPointId} was authored against specification revision ${binding.specificationRevision}, not the admitted ${input.currentRevision}.`,
				}),
			)
		}
	}

	const sorted = sortRefusals(refusals)
	return { reconciled: sorted.length === 0, refusals: sorted }
}
