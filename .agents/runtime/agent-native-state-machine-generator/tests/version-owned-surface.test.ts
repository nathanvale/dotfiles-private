import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	REGISTERED_READER_VERSIONS,
	REGISTERED_READERS,
	V2_ONLY_SURFACE_PATHS,
} from '../src/index.ts'
import { INPUT_SCHEMA_V1_SHAPE } from '../src/input-schema-v1.ts'
import { SPECIFICATION_SHAPE } from '../src/schema.ts'
import { addedPaths } from '../src/schema-difference.ts'
import { readNegativeFixture } from './support/candidates.ts'

/**
 * Each Input Schema Version owns the surface it accepts.
 *
 * A Registered Reader freezes more than a digest: it owns the document shape
 * its version accepted. Without that, a candidate could claim a superseded
 * version, declare a surface that version never had, and still be digested
 * under the older version's frozen envelope - taking on v2 meaning while
 * paying v1's identity.
 *
 * Ownership is directional. v1's shape is preserved as its own contract and v2
 * extends it; v1 is never rebuilt by subtracting from v2, because a change to
 * a shared field's enum or requiredness would then move what v1 accepts while
 * adding no v2 key at all.
 */

/**
 * A v2-only path expressed as the smallest document fragment declaring it.
 * Values are shape-valid, so a rejection is about the path's version and not
 * about a malformed value.
 */
const V2_ONLY_FRAGMENTS: Readonly<Record<string, string>> = {
	capabilities: '"capabilities": { "cap": { "available": true } },',
	'command_surface.bare_invocation_command':
		'"bare_invocation_command": "doctor",',
	'command_surface.entry': '"entry": { "script": "src/cli.ts" },',
	'command_surface.positional_routes':
		'"positional_routes": { "doctor": { "positionals": { "inspect": "run-doctor" } } },',
	'command_surface.execution_modes':
		'"execution_modes": { "doctor": ["normal"] },',
	'command_surface.preview_exemptions':
		'"preview_exemptions": { "doctor": { "reason": "reads only" } },',
	'command_surface.root_branches':
		'"root_branches": { "root_help": { "exit_code": "0", "meaning": "usable_evidence" } },',
	expectation_columns:
		'"expectation_columns": { "doctor.success": { "changed_state": "none" } },',
	pause_modes:
		'"pause_modes": { "hold": { "owner": "o", "active_blocker": "b", "release_action": "a" } },',
	phase_state: '"phase_state": "run_status",',
	routing:
		'"routing": { "facts": { "role": "advisory", "target_kind": "action", "discriminants": { "f": ["v"] }, "rows": [{ "key": { "f": "v" }, "target": "run-doctor" }] } },',
	'waits.wake_routes': '"wake_routes": ["caller_reinvocation"],',
	'waits.observations':
		'"observations": { "task": { "poll_after_ms": 1, "attempt_expiry_ms": 2, "wake_route": "caller_reinvocation", "missed_deadline_cause": "task_expired" } },',
}

/** Injects a fragment at the right nesting depth for its path. */
async function v1WithFragment(path: string): Promise<string> {
	const base = await readNegativeFixture('_base')
	const fragment = V2_ONLY_FRAGMENTS[path]
	if (fragment === undefined)
		throw new Error(`no fragment registered for v2-only path ${path}`)

	if (path.startsWith('command_surface.'))
		return base.replace(
			'"commands": ["doctor", "audit"],',
			`${fragment}\n\t\t"commands": ["doctor", "audit"],`,
		)
	if (path.startsWith('retry_posture.'))
		return base.replace(
			'"never_auto_retry": [],',
			`"never_auto_retry": [],\n\t\t${fragment}`,
		)
	if (path.startsWith('waits.'))
		return base.replace(
			'"waits": { "wake_route": "caller_reinvocation", "budgets_ms": {}, "missed_deadline_causes": {} },',
			`"waits": { "wake_route": "caller_reinvocation", "budgets_ms": {}, "missed_deadline_causes": {}, ${fragment.replace(/,$/, '')} },`,
		)
	return base.replace('"transitions": [],', `${fragment}\n\t"transitions": [],`)
}

describe('the v2-only surface set has one owner', () => {
	test('the declared list matches the shapes it claims to describe', () => {
		expect(V2_ONLY_SURFACE_PATHS.length).toBeGreaterThan(0)
		// The real guard: the paths computed from the frozen v1 shape against
		// the current one. Comparing the declared list only against the test
		// fixtures would prove two hand-kept copies agree, and a surface added
		// to SPECIFICATION_SHAPE and forgotten in both would pass.
		const declared: readonly string[] = V2_ONLY_SURFACE_PATHS
		expect([...declared].sort()).toEqual(
			[...addedPaths(INPUT_SCHEMA_V1_SHAPE, SPECIFICATION_SHAPE)].sort(),
		)
	})

	test('every declared path has custody coverage', () => {
		expect(Object.keys(V2_ONLY_FRAGMENTS).sort()).toEqual(
			[...V2_ONLY_SURFACE_PATHS].sort(),
		)
	})
})

describe('legacy input cannot declare a v2 surface', () => {
	for (const path of V2_ONLY_SURFACE_PATHS) {
		test(`${path} is refused on v1 input, before any output`, async () => {
			const source = await v1WithFragment(path)
			// Positive control: the fixture really is on a superseded version,
			// so the refusal is about version ownership rather than a value the
			// current shape would reject too.
			expect(source).toContain('"input_schema_version": "1"')

			const result = compileSpecificationCandidate(source, {
				sourcePath: 'legacy-with-v2.jsonc',
			})

			expect({ path, ok: result.ok }).toEqual({ path, ok: false })
			if (result.ok) return
			// Fail closed at the structural stage: no IR and no digest, so the
			// candidate never receives the frozen v1 envelope.
			expect(result).not.toHaveProperty('ir')
			expect(result).not.toHaveProperty('digest')
			expect({
				path,
				causes: [...new Set(result.diagnostics.map((item) => item.cause))],
			}).toEqual({ path, causes: ['structure_unknown_key'] })
			expect(result.diagnostics[0]?.location.line).toBeGreaterThan(0)
		})
	}

	for (const path of V2_ONLY_SURFACE_PATHS) {
		test(`${path} is accepted on v2 input`, async () => {
			// The mirror of the refusal loop: each path is refused for its
			// version, not because the compiler cannot read it at all. Testing
			// one path here would leave the other twelve claimed but unshown.
			const source = (await v1WithFragment(path)).replace(
				'"input_schema_version": "1"',
				'"input_schema_version": "2"',
			)

			const result = compileSpecificationCandidate(source, {
				sourcePath: 'v2-with-surface.jsonc',
			})

			// Some fragments need sibling declarations to be semantically whole
			// (a routed action must exist, an observation needs its vocabulary).
			// Structural acceptance is the claim under test, so a semantic
			// diagnostic still proves the path was admitted for this version.
			const structural = result.ok
				? []
				: result.diagnostics.filter((item) =>
						item.cause.startsWith('structure_'),
					)
			expect({
				path,
				structural: structural.map((item) => item.cause),
			}).toEqual({ path, structural: [] })
		})
	}
})

describe('v1-derived IR carries every v2 surface absent', () => {
	test('a clean v1 candidate carries no v2 surface value', async () => {
		const result = compileSpecificationCandidate(
			await readNegativeFixture('_base'),
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		const { ir } = result
		expect(result.registeredReader).toBe(REGISTERED_READERS['1'].name)

		expect(ir).not.toHaveProperty('phaseState')
		expect(ir.routing).toEqual([])
		expect(ir.capabilities).toEqual([])
		expect(ir.pauseModes).toEqual([])
		expect(ir.observations).toEqual([])
		expect(ir.expectationColumns).toEqual([])
		expect(ir.commandSurface.executionModes).toEqual({})
		expect(ir.commandSurface.previewExemptions).toEqual({})
		expect(ir.commandSurface.rootBranches).toEqual([])
		expect(ir.commandSurface.positionalRoutes).toEqual([])
	})
})

describe('every reader owns a frozen accepted shape', () => {
	test('each registered version binds one', () => {
		expect(REGISTERED_READER_VERSIONS.length).toBeGreaterThan(0)
		for (const version of REGISTERED_READER_VERSIONS) {
			expect({
				version,
				owns:
					REGISTERED_READERS[version].acceptedShape === INPUT_SCHEMA_V1_SHAPE,
			}).toEqual({ version, owns: true })
		}
	})

	test('the frozen shape declares none of the v2-only top-level paths', () => {
		expect(INPUT_SCHEMA_V1_SHAPE.t).toBe('object')
		if (INPUT_SCHEMA_V1_SHAPE.t !== 'object') return
		const topLevel = V2_ONLY_SURFACE_PATHS.filter((path) => !path.includes('.'))
		expect(topLevel.length).toBeGreaterThan(0)
		for (const path of topLevel) {
			expect({ path, declared: path in INPUT_SCHEMA_V1_SHAPE.fields }).toEqual({
				path,
				declared: false,
			})
		}
	})
})
