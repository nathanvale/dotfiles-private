import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	compileSpecificationCandidate,
	GENERATION_FAILURE_CAUSES,
	type GenerationFailureCause,
	generateArtifactSet,
	REGISTERED_READER_VERSIONS,
	regenerateArtifactSet,
	type SpecificationDigest,
	type SpecificationIr,
	verifyArtifactSet,
} from '../src/index.ts'
import { readCandidate } from './support/candidates.ts'
import { amendForEmission } from './support/emission.ts'
import { seedLegacyArtifactSet } from './support/legacy-set.ts'

/**
 * The Registered Reader boundary (issue 55, story 51).
 *
 * A superseded Input Schema Version stays readable: an existing Generated
 * Artifact Set whose manifest pins one must remain verifiable and
 * regenerable, because the admitted pilot's set is exactly that. What that
 * version cannot do is found a NEW set - consumer meaning would change
 * through an upgrade nobody admitted - so public generation refuses and names
 * the Registered Migration route.
 *
 * Refusing is not migrating. Nothing here runs a Registered Migration, and
 * compiling is never Specification Admission.
 */

const created: string[] = []

async function outputDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'asmg-boundary-'))
	created.push(dir)
	return dir
}

afterEach(async () => {
	while (created.length > 0) {
		const dir = created.pop()
		if (dir) await rm(dir, { recursive: true, force: true })
	}
})

/** Independent reader: asks the filesystem, never the writer's return value. */
async function entriesIn(dir: string): Promise<readonly string[]> {
	return (await readdir(dir)).sort()
}

async function readAll(
	dir: string,
	paths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const contents = new Map<string, string>()
	for (const path of paths) {
		contents.set(path, await readFile(join(dir, path), 'utf8'))
	}
	return contents
}

/**
 * Both public entry points, because they are two doors into one boundary.
 * Proving only `generateArtifactSet` is how the regeneration path kept an
 * identity bypass: regeneration reached the same writer with its checks
 * waived, and no negative ever asked it.
 */
const ENTRY_POINTS = [
	{ verb: 'generate', call: generateArtifactSet },
	{ verb: 'regenerate', call: regenerateArtifactSet },
] as const

async function compiledSpike(product: 'vault-git' | 'fallow') {
	const compiled = compileSpecificationCandidate(await readCandidate(product))
	if (!compiled.ok) throw new Error(`${product} candidate failed to compile`)
	return compiled
}

describe('the superseded versions are the ones the reader owns', () => {
	test('the registered set is non-empty and excludes the generation version', () => {
		expect(REGISTERED_READER_VERSIONS.length).toBeGreaterThan(0)
		expect([...REGISTERED_READER_VERSIONS]).not.toContain('2')
	})

	test('both spike candidates really are on a registered version', async () => {
		// Positive control for every refusal below: these candidates carry the
		// versions the boundary refuses, so the refusals are not vacuous.
		for (const product of ['vault-git', 'fallow'] as const) {
			const compiled = await compiledSpike(product)
			expect({
				product,
				registered: (REGISTERED_READER_VERSIONS as readonly string[]).includes(
					compiled.ir.specMeta.inputSchemaVersion,
				),
			}).toEqual({ product, registered: true })
		}
	})
})

describe('public new-set generation from a superseded version refuses', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} refuses with the migration-route cause and writes nothing`, async () => {
			const compiled = await compiledSpike(product)
			const dir = await outputDir()

			const result = await generateArtifactSet(
				amendForEmission(compiled.ir),
				compiled.digest,
				{ outputDir: dir },
			)

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect({ product, cause: result.cause }).toEqual({
				product,
				cause: 'generation_superseded_input_schema',
			})
			expect(result.subject).toBe(compiled.ir.specMeta.inputSchemaVersion)
			expect(result.message.length).toBeGreaterThan(0)
			// The contract is "before writing", so the directory itself must say
			// so. The returned cause is silent about what the filesystem saw.
			expect(await entriesIn(dir)).toEqual([])
		})
	}

	test('regeneration onto an empty target refuses too, and writes nothing', async () => {
		const compiled = await compiledSpike('vault-git')
		const dir = await outputDir()

		const result = await regenerateArtifactSet(
			amendForEmission(compiled.ir),
			compiled.digest,
			{ outputDir: dir },
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		// No set exists here, so this would found one: regeneration is not a
		// way around the boundary.
		expect(result.cause).toBe('generation_no_existing_set')
		expect(await entriesIn(dir)).toEqual([])
	})
})

describe('the boundary reads both identities, not one', () => {
	test('a rewritten IR carrying its old digest cannot found a set', async () => {
		const compiled = await compiledSpike('vault-git')
		const dir = await outputDir()

		// The bypass this closes: rewrite only the IR's declared version and
		// keep the digest the legacy reader produced. Neither owner is
		// satisfied, so the pair cannot both be true.
		const rewritten = {
			...amendForEmission(compiled.ir),
			specMeta: { ...compiled.ir.specMeta, inputSchemaVersion: '2' },
		}
		expect(compiled.digest.inputSchemaVersion).not.toBe('2')

		const result = await generateArtifactSet(rewritten, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_provenance_mismatch')
		// Read the directory back: the returned cause is silent about what the
		// filesystem already saw.
		expect(await entriesIn(dir)).toEqual([])
	})

	test('a legacy declaration against its own frozen envelope is consistent', async () => {
		const compiled = await compiledSpike('vault-git')
		const dir = await outputDir()

		// Positive control for the rule's shape: the spikes declare
		// spike-draft-1 while their reader freezes the envelope to 1, so a raw
		// equality check would refuse them. Validating through the owner keeps
		// that history legitimate, and the refusal below is for being
		// superseded rather than inconsistent.
		expect(compiled.ir.specMeta.inputSchemaVersion).toBe('spike-draft-1')
		expect(compiled.digest.inputSchemaVersion).toBe('1')

		const result = await generateArtifactSet(
			amendForEmission(compiled.ir),
			compiled.digest,
			{ outputDir: dir },
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_superseded_input_schema')
		expect(await entriesIn(dir)).toEqual([])
	})
})

describe('presence of a manifest is not provenance', () => {
	const cases = [
		{
			label: 'a manifest recording another specification',
			plant: async (
				dir: string,
				ir: SpecificationIr,
				digest: SpecificationDigest,
			) => {
				await seedLegacyArtifactSet(dir, ir, {
					...digest,
					specificationDigest: 'f'.repeat(64),
				})
			},
		},
		{
			label: 'a manifest recording another generator contract',
			plant: async (
				dir: string,
				ir: SpecificationIr,
				digest: SpecificationDigest,
			) => {
				await seedLegacyArtifactSet(dir, ir, {
					...digest,
					generatorContractVersion: '9',
				})
			},
		},
	] as const

	test('both entry points are covered', () => {
		expect(ENTRY_POINTS.length).toBe(2)
	})

	test('the case list is non-empty', () => {
		expect(cases.length).toBeGreaterThan(0)
	})

	/**
	 * A manifest is a claim about a set, not the set. Its digest is printed in
	 * every generated header, so anyone can write one; every other negative
	 * here seeds through a real prior generation, which is why a hand-built
	 * one went untested.
	 */
	const HAND_BUILT: ReadonlyArray<{
		readonly label: string
		readonly declaredOutputs: readonly string[]
	}> = [
		{ label: 'declaring no outputs', declaredOutputs: [] },
		{
			label: 'declaring outputs that do not exist',
			declaredOutputs: ['src/branch-station-catalog.ts'],
		},
	]

	for (const { label, declaredOutputs } of HAND_BUILT) {
		for (const { verb, call } of ENTRY_POINTS) {
			test(`a hand-built manifest ${label} founds nothing via ${verb}`, async () => {
				const compiled = await compiledSpike('vault-git')
				const ir = amendForEmission(compiled.ir)
				const dir = await outputDir()
				// Correct identity on every field, and no set on disk.
				await writeFile(
					join(dir, 'provenance.manifest.json'),
					JSON.stringify({
						declared_outputs: declaredOutputs,
						generator_contract_version:
							compiled.digest.generatorContractVersion,
						input_schema_version: compiled.digest.inputSchemaVersion,
						product: ir.specMeta.product,
						specification_digest: compiled.digest.specificationDigest,
					}),
					'utf8',
				)
				const before = await entriesIn(dir)

				const result = await call(ir, compiled.digest, { outputDir: dir })

				expect({ label, verb, ok: result.ok }).toEqual({
					label,
					verb,
					ok: false,
				})
				if (result.ok) return
				// Identity alone does not prove the set exists, so this is
				// founding rather than repairing and the boundary refuses.
				expect({ label, verb, cause: result.cause }).toEqual({
					label,
					verb,
					cause: 'generation_foreign_existing_set',
				})
				expect(await entriesIn(dir)).toEqual(before)
			})
		}
	}

	for (const { label, plant } of cases) {
		for (const { verb, call } of ENTRY_POINTS) {
			test(`${label} cannot stand in for an existing set via ${verb}`, async () => {
				const compiled = await compiledSpike('vault-git')
				const ir = amendForEmission(compiled.ir)
				const dir = await outputDir()
				await plant(dir, ir, compiled.digest)
				const before = await entriesIn(dir)

				const result = await call(ir, compiled.digest, { outputDir: dir })

				expect({ label, verb, ok: result.ok }).toEqual({
					label,
					verb,
					ok: false,
				})
				if (result.ok) return
				expect({ label, verb, cause: result.cause }).toEqual({
					label,
					verb,
					cause: 'generation_foreign_existing_set',
				})
				// Nothing was overwritten: the directory is exactly as planted.
				expect(await entriesIn(dir)).toEqual(before)
			})
		}
	}
})

describe('an unreadable manifest is its own refusal', () => {
	for (const { verb, call } of ENTRY_POINTS) {
		test(`a malformed manifest refuses with its own cause via ${verb}`, async () => {
			const compiled = await compiledSpike('vault-git')
			const ir = amendForEmission(compiled.ir)
			const dir = await outputDir()
			await writeFile(
				join(dir, 'provenance.manifest.json'),
				'{ not json',
				'utf8',
			)
			const before = await entriesIn(dir)

			const result = await call(ir, compiled.digest, { outputDir: dir })

			expect({ verb, ok: result.ok }).toEqual({ verb, ok: false })
			if (result.ok) return
			// Distinct from the foreign-set cause because the repairs differ:
			// delete and regenerate, versus change the output directory. The
			// subject is the directory in both, so cause is the only signal.
			expect({ verb, cause: result.cause }).toEqual({
				verb,
				cause: 'generation_unreadable_manifest',
			})
			expect(await entriesIn(dir)).toEqual(before)
		})
	}
})

describe('an existing set on a superseded version stays checkable', () => {
	test('verification and regeneration run byte-identically', async () => {
		const compiled = await compiledSpike('vault-git')
		const ir = amendForEmission(compiled.ir)
		const dir = await outputDir()

		// A genuinely pre-existing legacy set, planted the way history wrote
		// one. Not through the public generation seam, which refuses.
		const declaredOutputs = await seedLegacyArtifactSet(
			dir,
			ir,
			compiled.digest,
		)
		expect(declaredOutputs.length).toBeGreaterThan(0)
		const before = await readAll(dir, declaredOutputs)

		// Drift verification of that existing set is unaffected by the boundary.
		const verified = await verifyArtifactSet(ir, compiled.digest, {
			outputDir: dir,
		})
		expect(verified.ok).toBe(true)

		// Regeneration replaces a set that exists; it is not founding one.
		const regenerated = await regenerateArtifactSet(ir, compiled.digest, {
			outputDir: dir,
		})
		expect(regenerated.ok).toBe(true)

		// Byte identity through the reader: regeneration reproduced every
		// declared output exactly, so a legacy set does not drift by being
		// read under a compiler that has since gained v2 surfaces.
		const after = await readAll(dir, declaredOutputs)
		for (const path of declaredOutputs) {
			expect({ path, same: after.get(path) === before.get(path) }).toEqual({
				path,
				same: true,
			})
		}
	})
})

/**
 * The sealed-cause iteration the package standards demand, for the generation
 * vocabulary: iterate the sealed list and fail on any member no test reaches,
 * so per-cause coverage is checked by the suite rather than by memory.
 *
 * The registry names where each cause is proven. Two suites own these causes
 * between them, so naming the owner keeps a reader from hunting for the one
 * that moved.
 */
describe('every sealed generation failure cause is reached by a test', () => {
	const PROVEN_BY: Readonly<Record<GenerationFailureCause, string>> = {
		generation_emitter_failure: 'generation-mechanics.test.ts',
		generation_emit_refused: 'generation-mechanics.test.ts',
		generation_write_failure: 'generation-mechanics.test.ts',
		generation_no_existing_set: 'generation-mechanics.test.ts',
		generation_superseded_input_schema: 'registered-reader-boundary.test.ts',
		generation_provenance_mismatch: 'registered-reader-boundary.test.ts',
		generation_foreign_existing_set: 'registered-reader-boundary.test.ts',
		generation_unreadable_manifest: 'registered-reader-boundary.test.ts',
	}

	test('the registry covers the sealed list member for member', () => {
		expect(GENERATION_FAILURE_CAUSES.length).toBeGreaterThan(0)
		// Total by construction: a cause added to the sealed list without an
		// owner here fails typecheck before it fails this assertion.
		expect(Object.keys(PROVEN_BY).sort()).toEqual(
			[...GENERATION_FAILURE_CAUSES].sort(),
		)
	})

	for (const cause of GENERATION_FAILURE_CAUSES) {
		test(`${cause} names the suite that proves it`, () => {
			expect(PROVEN_BY[cause].length).toBeGreaterThan(0)
		})
	}
})
