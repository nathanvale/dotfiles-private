/**
 * Structural validation: does the parsed tree match Input Schema v1?
 *
 * Collects every structural problem rather than stopping at the first, so an
 * author repairing a candidate sees the whole structural picture in one run.
 */
import { type Diagnostic, diagnostic } from './diagnostics.ts'
import type { JsoncNode } from './jsonc.ts'
import { type Shape, SPECIFICATION_SHAPE } from './schema.ts'

/**
 * `shape` is the surface the declared Input Schema Version accepts. A
 * Registered Reader supplies its version's frozen surface; input on the
 * current version is validated against the current shape. Passing the shape in
 * is what keeps a legacy candidate from declaring a v2 field and still being
 * read as its own version.
 */
export function validateStructure(
	root: JsoncNode,
	sourcePath?: string,
	shape: Shape = SPECIFICATION_SHAPE,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	walk(root, shape, '', diagnostics, sourcePath)
	return diagnostics
}

function push(
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
	cause:
		| 'structure_missing_required'
		| 'structure_unknown_key'
		| 'structure_type_mismatch'
		| 'structure_value_not_permitted',
	message: string,
	path: string,
	node: {
		readonly line: number
		readonly column: number
		readonly offset: number
	},
): void {
	diagnostics.push(
		diagnostic({
			cause,
			stage: 'structural',
			message,
			path,
			location: node,
			...(sourcePath === undefined ? {} : { sourcePath }),
		}),
	)
}

/** Union members are tried silently; only a total failure is reported. */
function matches(node: JsoncNode, shape: Shape): boolean {
	const probe: Diagnostic[] = []
	walk(node, shape, '', probe, undefined)
	return probe.length === 0
}

function walk(
	node: JsoncNode,
	shape: Shape,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	switch (shape.t) {
		case 'union':
			walkUnion(node, shape, path, diagnostics, sourcePath)
			return
		case 'string':
			walkString(node, shape, path, diagnostics, sourcePath)
			return
		case 'number':
			walkNumber(node, path, diagnostics, sourcePath)
			return
		case 'boolean':
			walkBoolean(node, path, diagnostics, sourcePath)
			return
		case 'array':
			walkArray(node, shape, path, diagnostics, sourcePath)
			return
		case 'map':
			walkMap(node, shape, path, diagnostics, sourcePath)
			return
		case 'object':
			walkObject(node, shape, path, diagnostics, sourcePath)
			return
	}
	// A new Shape variant must add its own case: without this check it would
	// fall through and validate nothing while the build stayed green.
	const _exhausted: never = shape
}

function walkUnion(
	node: JsoncNode,
	shape: Extract<Shape, { t: 'union' }>,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	const winner = shape.of.find((candidate) => matches(node, candidate))
	if (winner !== undefined) return
	push(
		diagnostics,
		sourcePath,
		'structure_type_mismatch',
		`Value at ${path || '<root>'} does not match any permitted shape for this field.`,
		path,
		node.loc,
	)
}

function walkString(
	node: JsoncNode,
	shape: Extract<Shape, { t: 'string' }>,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	if (node.kind !== 'string') {
		push(
			diagnostics,
			sourcePath,
			'structure_type_mismatch',
			`Expected a string at ${path}; found ${node.kind}.`,
			path,
			node.loc,
		)
		return
	}
	if (shape.nonEmpty === true && node.value.trim() === '') {
		push(
			diagnostics,
			sourcePath,
			'structure_value_not_permitted',
			`Value at ${path} must not be empty.`,
			path,
			node.loc,
		)
		return
	}
	if (shape.enum !== undefined && !shape.enum.includes(node.value)) {
		push(
			diagnostics,
			sourcePath,
			'structure_value_not_permitted',
			`Value ${JSON.stringify(node.value)} at ${path} is not in the sealed vocabulary [${shape.enum.join(', ')}].`,
			path,
			node.loc,
		)
	}
}

function walkNumber(
	node: JsoncNode,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	if (node.kind === 'number') return
	push(
		diagnostics,
		sourcePath,
		'structure_type_mismatch',
		`Expected a number at ${path}; found ${node.kind}.`,
		path,
		node.loc,
	)
}

function walkBoolean(
	node: JsoncNode,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	if (node.kind === 'boolean') return
	push(
		diagnostics,
		sourcePath,
		'structure_type_mismatch',
		`Expected a boolean at ${path}; found ${node.kind}.`,
		path,
		node.loc,
	)
}

function walkArray(
	node: JsoncNode,
	shape: Extract<Shape, { t: 'array' }>,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	if (node.kind !== 'array') {
		push(
			diagnostics,
			sourcePath,
			'structure_type_mismatch',
			`Expected an array at ${path}; found ${node.kind}.`,
			path,
			node.loc,
		)
		return
	}
	node.items.forEach((item, index) => {
		walk(item, shape.of, `${path}[${index}]`, diagnostics, sourcePath)
	})
}

function walkMap(
	node: JsoncNode,
	shape: Extract<Shape, { t: 'map' }>,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	if (node.kind !== 'object') {
		push(
			diagnostics,
			sourcePath,
			'structure_type_mismatch',
			`Expected an object at ${path}; found ${node.kind}.`,
			path,
			node.loc,
		)
		return
	}
	for (const entry of node.entries) {
		walk(entry.value, shape.of, join(path, entry.key), diagnostics, sourcePath)
	}
}

function walkObject(
	node: JsoncNode,
	shape: Extract<Shape, { t: 'object' }>,
	path: string,
	diagnostics: Diagnostic[],
	sourcePath: string | undefined,
): void {
	if (node.kind !== 'object') {
		push(
			diagnostics,
			sourcePath,
			'structure_type_mismatch',
			`Expected an object at ${path || '<root>'}; found ${node.kind}.`,
			path,
			node.loc,
		)
		return
	}
	const present = new Set<string>()
	for (const entry of node.entries) {
		present.add(entry.key)
		const field = shape.fields[entry.key]
		if (field === undefined) {
			push(
				diagnostics,
				sourcePath,
				'structure_unknown_key',
				`Unknown key ${JSON.stringify(entry.key)} at ${path || '<root>'}. Input Schema v1 admits only the keys the admitted candidates use.`,
				join(path, entry.key),
				entry.keyLoc,
			)
			continue
		}
		walk(entry.value, field, join(path, entry.key), diagnostics, sourcePath)
	}
	for (const key of shape.required) {
		if (!present.has(key)) {
			push(
				diagnostics,
				sourcePath,
				'structure_missing_required',
				`Missing required key ${JSON.stringify(key)} at ${path || '<root>'}.`,
				join(path, key),
				node.loc,
			)
		}
	}
}

function join(path: string, key: string): string {
	return path === '' ? key : `${path}.${key}`
}
