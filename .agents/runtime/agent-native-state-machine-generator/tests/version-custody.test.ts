import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	SUPPORTED_INPUT_SCHEMA_VERSIONS,
} from '../src/index.ts'
import {
	readCandidate,
	readFrozenV1Exemplar,
	readNegativeFixture,
} from './support/candidates.ts'

/**
 * Input Schema Version custody (issue 55, stories 51 and 52).
 *
 * Two claims live here. First, compatibility is exact match against the
 * supported set: a candidate declaring anything else is refused fail-closed,
 * with no inference from ordering, successful parsing, or similarity.
 * Second, the digest envelope carries the version the candidate DECLARED,
 * never a constant the compiler pinned - the defect worklist row W4 names.
 *
 * Compiling is not Specification Admission. Nothing here admits a candidate.
 */

const PILOT_URL = new URL(
	'../pilot/vault-git-reimagined.state-machine.jsonc',
	import.meta.url,
)
const DRAFT_URL = new URL(
	'../fixtures/draft-candidates/agent-worktree.state-machine.jsonc',
	import.meta.url,
)

/**
 * Deliberate independent oracle: the charter-pinned digests restated as
 * literals. Recomputing them through the digest function under test would
 * prove f(x) === f(x) and nothing about byte identity.
 *
 * Every row here is frozen history and none of them move. Pilot, fallow and
 * draft are candidates on a superseded Input Schema Version, and the
 * Registered Reader's canonicalization is byte-frozen, so each digests
 * exactly as it always did.
 *
 * The `vault-git` row is the frozen v1 exemplar, not the live vault-git
 * candidate. Those were the same file until the candidate was re-authored
 * against Input Schema v2; the exemplar holds its pre-re-authoring bytes, so
 * this pin still asserts the same v1 identity it always asserted, through the
 * same Registered Reader. A pinned identity is evidence about admitted
 * history, so the evidence stays fixed and the subject names what the
 * evidence is actually about.
 *
 * The live v2 candidate is deliberately absent. It is unadmitted, and an
 * unadmitted candidate's digest is not history to pin: it gets an identity
 * here only if its own Specification Admission gives it one. Pinning it now
 * would assert as settled exactly the thing admission decides.
 */
const PINNED_DIGESTS = {
	pilot: 'af827747fde4d30b29919fadcf55b2d3b19c3c0b6646493fc325c49664b3e99a',
	'vault-git':
		'f22e836bcfc9bb9f623b9d2f7915bd0d8ed81c0506ed0803b01b537b74b5142f',
	fallow: 'c26764f0957c51ae4a799e51766d44d5f40378b35a9c2b210b422c9a4d4a0a63',
	// Re-pinned 2026-09-22: the draft's record storage moved from the
	// checkout-local .agent-worktree/ to the XDG state home (dotfiles PR #65).
	draft: 'f38e2cf43130c6bf45e053e9f244206e74e589197925a8b870717f7403e5c638',
} as const

/**
 * Deliberate independent oracle: the version each candidate declares, read
 * from the fixture text by a regex rather than through the compiler that is
 * under test.
 */
function declaredVersionOf(source: string): string | undefined {
	return /"input_schema_version"\s*:\s*"([^"]*)"/.exec(source)?.[1]
}

async function sourceFor(name: keyof typeof PINNED_DIGESTS): Promise<string> {
	if (name === 'pilot') return await Bun.file(PILOT_URL).text()
	if (name === 'draft') return await Bun.file(DRAFT_URL).text()
	if (name === 'vault-git') return await readFrozenV1Exemplar()
	return await readCandidate(name)
}

describe('the supported Input Schema Version set is exact-match', () => {
	test('the sealed set is non-empty and carries no duplicates', () => {
		expect(SUPPORTED_INPUT_SCHEMA_VERSIONS.length).toBeGreaterThan(0)
		expect([...new Set(SUPPORTED_INPUT_SCHEMA_VERSIONS)].sort()).toEqual(
			[...SUPPORTED_INPUT_SCHEMA_VERSIONS].sort(),
		)
	})

	test('an unsupported declared version is refused with no output', async () => {
		const source = await readNegativeFixture('unsupported-schema-version')

		const result = compileSpecificationCandidate(source, {
			sourcePath: 'unsupported-schema-version.jsonc',
		})

		expect(result.ok).toBe(false)
		// Fail closed: a refused version publishes neither IR nor digest.
		expect(result).not.toHaveProperty('ir')
		expect(result).not.toHaveProperty('digest')
		expect([...new Set(result.diagnostics.map((item) => item.cause))]).toEqual([
			'semantic_unsupported_schema_version',
		])

		const diagnostic = result.diagnostics[0]
		expect(diagnostic).toBeDefined()
		if (diagnostic === undefined) return
		expect(diagnostic.path).toBe('spec_meta.input_schema_version')
		expect(diagnostic.location.line).toBeGreaterThan(0)
	})

	test('no unsupported version is admitted by ordering or similarity', async () => {
		const base = await readNegativeFixture('_base')
		// Each row pins the cause it must refuse with, not merely that it
		// refuses. The empty string refuses on the nonEmpty shape constraint
		// rather than on set membership, so asserting `ok === false` alone
		// would keep that row green even if exact-set checking were deleted.
		const TRAPS = [
			{ version: '2.0', cause: 'semantic_unsupported_schema_version' },
			{ version: '01', cause: 'semantic_unsupported_schema_version' },
			{ version: '3', cause: 'semantic_unsupported_schema_version' },
			{
				version: 'spike-draft-2',
				cause: 'semantic_unsupported_schema_version',
			},
			{ version: '', cause: 'structure_value_not_permitted' },
		] as const

		expect(TRAPS.length).toBeGreaterThan(0)
		for (const { version, cause } of TRAPS) {
			const source = base.replace(
				/"input_schema_version"\s*:\s*"[^"]*"/,
				`"input_schema_version": ${JSON.stringify(version)}`,
			)
			const result = compileSpecificationCandidate(source)
			expect({ version, ok: result.ok }).toEqual({ version, ok: false })
			if (result.ok) continue
			expect({
				version,
				causes: [...new Set(result.diagnostics.map((item) => item.cause))],
			}).toEqual({ version, causes: [cause] })
		}
	})

	test('every supported version compiles when nothing else is wrong', async () => {
		const base = await readNegativeFixture('_base')
		expect(SUPPORTED_INPUT_SCHEMA_VERSIONS.length).toBeGreaterThan(0)
		for (const version of SUPPORTED_INPUT_SCHEMA_VERSIONS) {
			const source = base.replace(
				/"input_schema_version"\s*:\s*"[^"]*"/,
				`"input_schema_version": ${JSON.stringify(version)}`,
			)
			const result = compileSpecificationCandidate(source)
			expect({ version, ok: result.ok }).toEqual({ version, ok: true })
		}
	})
})

describe('the digest envelope stamps the declared version, not a constant', () => {
	test('the current path stamps exactly what the candidate declares', async () => {
		const source = (await readNegativeFixture('_base')).replace(
			/"input_schema_version"\s*:\s*"[^"]*"/,
			'"input_schema_version": "2"',
		)
		// Positive control: the fixture really does declare "2", so the stamp
		// assertion below cannot pass because no candidate reached it.
		expect(declaredVersionOf(source)).toBe('2')

		const result = compileSpecificationCandidate(source)
		expect(result.ok).toBe(true)
		if (!result.ok) return

		// W4 at full strength: the stamp is the validated declared version, and
		// the current path holds no constant and no special case. A superseded
		// version never reaches here - its Registered Reader owns it, and that
		// reader's frozen stamp is asserted as its own contract in
		// registered-readers.test.ts.
		expect(result.registeredReader).toBeUndefined()
		expect(result.digest.inputSchemaVersion).toBe('2')
		// The IR and the digest envelope must never disagree about identity.
		expect(result.ir.specMeta.inputSchemaVersion).toBe('2')
	})

	test('the IR always carries the declared version verbatim', async () => {
		for (const name of ['pilot', 'vault-git', 'fallow', 'draft'] as const) {
			const source = await sourceFor(name)
			const declared = declaredVersionOf(source)
			expect(declared).toBeDefined()
			if (declared === undefined) continue

			const result = compileSpecificationCandidate(source)
			expect({ name, ok: result.ok }).toEqual({ name, ok: true })
			if (!result.ok) continue
			// The IR reports what the candidate said even for a superseded
			// version, so a reader can tell v1 input from v2 input.
			expect({ name, declared: result.ir.specMeta.inputSchemaVersion }).toEqual(
				{ name, declared },
			)
		}
	})

	test('two v2 candidates differing only in declared version differ in digest', async () => {
		const base = await readNegativeFixture('_base')
		const asTwo = compileSpecificationCandidate(
			base.replace(
				/"input_schema_version"\s*:\s*"[^"]*"/,
				'"input_schema_version": "2"',
			),
		)
		const asOne = compileSpecificationCandidate(base)

		expect(asOne.ok && asTwo.ok).toBe(true)
		if (!asOne.ok || !asTwo.ok) return
		// A version change is a specification identity change; the envelope
		// binds the version, so the same bytes under two versions differ.
		expect(asTwo.digest.specificationDigest).not.toBe(
			asOne.digest.specificationDigest,
		)
	})
})

describe('the pinned candidates keep byte-identical digests', () => {
	for (const [name, digest] of Object.entries(PINNED_DIGESTS)) {
		test(`${name} reproduces its recorded digest`, async () => {
			const source = await sourceFor(name as keyof typeof PINNED_DIGESTS)
			const result = compileSpecificationCandidate(source)

			expect(result.ok).toBe(true)
			if (!result.ok) return
			expect({ name, digest: result.digest.specificationDigest }).toEqual({
				name,
				digest,
			})
		})
	}
})
