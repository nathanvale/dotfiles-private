/**
 * Contextual Rendering derivation.
 *
 * A Contextual Rendering is a public compatibility identifier that resolves
 * to exactly one canonical action identifier ONLY when its context is
 * supplied. It is never a second action vocabulary and is never persisted as
 * authority, so what derivation publishes is a resolution table rather than a
 * resolved answer: nothing at design time supplies the runtime context that
 * would pick between a rendering's candidates.
 *
 * The ruling this implements (`persisted_contextual_ids`): new durable writes
 * store canonical ids only, legacy contextual ids resolve through stored
 * context without rewrite, and ambiguity fails closed. A rendering naming one
 * canonical id therefore resolves outright; a rendering naming several
 * carries all of them, so a resolver that cannot supply context has no single
 * answer to take and must fail closed rather than choose the first.
 */
import { compareCodepoints } from './canonical.ts'
import type { SpecificationIr } from './ir.ts'
import { type ArtifactRefusal, artifactRefusal } from './refusal.ts'

/**
 * One public compatibility identifier and the canonical ids it can resolve
 * to, in codepoint order.
 *
 * `resolved` carries a canonical id only where the rendering names exactly
 * one, which is the sole case context cannot change. Where it names several,
 * `resolved` is absent and `candidates` holds them: absent means "supply
 * context and resolve", never "no target".
 */
export interface DerivedContextualRendering {
	readonly rendering: string
	readonly candidates: readonly string[]
	readonly resolved?: string
}

export interface ContextualRenderingEmission {
	readonly renderings: readonly DerivedContextualRendering[]
	readonly refusals: readonly ArtifactRefusal[]
}

/**
 * Derives the Contextual Rendering resolution table.
 *
 * Every candidate id is checked against the action catalog here as well as at
 * compile: this emitter publishes ids a consumer will resolve against, and an
 * id absent from the catalog would publish a second vocabulary, which is the
 * one thing a Contextual Rendering must never become.
 *
 * A rendering that collides with a canonical action id is refused. The two
 * namespaces are read by the same resolver, so a public identifier that is
 * also a canonical id makes the resolved answer depend on lookup order.
 */
export function deriveContextualRenderings(
	ir: SpecificationIr,
): ContextualRenderingEmission {
	const catalog = new Set(ir.actions.catalog.map((entry) => entry.id))
	const refusals: ArtifactRefusal[] = []
	const renderings: DerivedContextualRendering[] = []

	for (const rendering of Object.keys(ir.contextualRenderings).sort(
		compareCodepoints,
	)) {
		const declared = ir.contextualRenderings[rendering] ?? []

		if (catalog.has(rendering)) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_contextual_rendering_collides',
					subject: rendering,
					message: `Contextual rendering ${rendering} is also a canonical action id, so a resolver cannot tell which vocabulary the identifier belongs to.`,
				}),
			)
			continue
		}

		// Only ids the catalog declares are published. An undeclared target is
		// dropped rather than emitted: publishing it would put an id outside
		// the canonical vocabulary into the surface a resolver resolves
		// against, which is the second vocabulary a Contextual Rendering must
		// never become.
		//
		// Dropped rather than refused, deliberately. Resolving a rendering's
		// target against the action catalog is the compile seam's rule
		// (`actions.contextual_renderings` in `semantic.ts`), and refusing it
		// again here would make derivation a second owner of one rule. This
		// emitter's own question is narrower: what can a resolver be given.
		//
		// A rendering whose targets all drop out therefore emits no entry at
		// all rather than an entry resolving to nothing. Absent from the table
		// is what a resolver fails closed on; an entry with an empty candidate
		// list would be a published identifier with no answer.
		const candidates = declared
			.filter((target) => catalog.has(target))
			.sort(compareCodepoints)
		if (candidates.length === 0) continue

		const single = candidates.length === 1 ? candidates[0] : undefined
		renderings.push({
			rendering,
			candidates,
			// Resolved only for a single-target rendering. A multi-target one
			// needs the context that design time does not have, and picking
			// among them here would persist an unadmitted choice as authority.
			...(single === undefined ? {} : { resolved: single }),
		})
	}

	return { renderings, refusals }
}
