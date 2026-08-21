/**
 * The structural difference between two Input Schema Versions.
 *
 * Computed from the shapes themselves so no hand-maintained list can drift
 * from what the compiler actually accepts. A surface added to the current
 * shape and forgotten everywhere else still appears here, which is what makes
 * the version-custody guard hold rather than merely agree with a copy of
 * itself.
 *
 * Directional by construction: this reports what the current shape added on
 * top of a frozen one and never rebuilds the frozen shape by subtraction. The
 * frozen surface stays its own owner in `input-schema-v1.ts`.
 *
 * ## Path grammar
 *
 * - `a.b` - field `b` of object `a`.
 * - `a.*.b` - field `b` of a map's value shape; the key is product-named, so
 *   `*` stands for every key rather than naming one.
 * - `a[].b` - field `b` of an array's item shape.
 * - `a|0.b` - field `b` inside union arm 0, indexed because arms have no
 *   names and two arms may differ independently.
 *
 * A path is reported at the point surface was added, so a scalar replaced by
 * an object reports the object's new fields rather than the scalar's path.
 */
import type { Shape } from './schema.ts'

/**
 * Dotted paths present in `current` and absent from `frozen`.
 *
 * Every composite shape the language has is descended: object fields, map
 * values, array items, and union arms. Sorted by codepoint, so a
 * caller-visible list is stable across hosts.
 */
export function addedPaths(frozen: Shape, current: Shape): readonly string[] {
	const added: string[] = []
	collect(frozen, current, '', added)
	return added.sort()
}

function join(prefix: string, segment: string): string {
	return prefix === ''
		? segment
		: `${prefix}${segment.startsWith('[') || segment.startsWith('|') ? '' : '.'}${segment}`
}

function collect(
	frozen: Shape | undefined,
	current: Shape,
	prefix: string,
	added: string[],
): void {
	// A shape the frozen version never had is entirely new; its owner already
	// reported the path, so there is nothing deeper to name.
	if (frozen === undefined) return

	switch (current.t) {
		case 'object': {
			// A scalar replaced by an object adds every key the object carries:
			// the frozen version accepted one value here, and the current one
			// accepts a structure of named fields.
			const frozenFields = frozen.t === 'object' ? frozen.fields : {}
			for (const [key, field] of Object.entries(current.fields)) {
				const path = join(prefix, key)
				const frozenField = frozenFields[key]
				if (frozenField === undefined) {
					added.push(path)
					continue
				}
				collect(frozenField, field, path, added)
			}
			return
		}
		case 'map': {
			// A map's keys are product-named, so the value shape is the same
			// surface in both versions and only its contents can differ.
			if (frozen.t !== 'map') return
			collect(frozen.of, current.of, join(prefix, '*'), added)
			return
		}
		case 'array': {
			if (frozen.t !== 'array') return
			collect(frozen.of, current.of, `${prefix}[]`, added)
			return
		}
		case 'union': {
			// Arms are positional: the language gives them no names, so an arm
			// is compared with the arm at its own index. An arm the frozen
			// version lacks is new surface at the union's own path.
			if (frozen.t !== 'union') return
			current.of.forEach((arm, index) => {
				const frozenArm = frozen.of[index]
				if (frozenArm === undefined) {
					added.push(join(prefix, `|${index}`))
					return
				}
				collect(frozenArm, arm, `${prefix}|${index}`, added)
			})
			return
		}
		case 'string':
		case 'number':
		case 'boolean':
			// A leaf carries no nested surface. A widened `enum` is a value
			// change rather than a new path, and belongs to the version's own
			// validation rather than to this structural delta.
			return
		default: {
			// tsc owns exhaustiveness: a new Shape variant fails to assign here
			// before it can silently go unwalked.
			const _exhausted: never = current
			return
		}
	}
}
