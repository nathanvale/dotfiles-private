import { afterEach, describe, expect, test } from 'bun:test'
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises'
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

/**
 * Independent deep reader: every file under a directory with its bytes.
 *
 * `entriesIn` is one level and names only, which is enough for a directory
 * that must stay empty. A refusal that must leave an existing set untouched
 * needs contents, because a file deleted and re-created empty has the same
 * name.
 */
async function filesUnder(dir: string): Promise<ReadonlyMap<string, string>> {
	const found = new Map<string, string>()
	async function walk(current: string, prefix: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const absolute = join(current, entry.name)
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (entry.isDirectory()) await walk(absolute, relative)
			else found.set(relative, await readFile(absolute, 'utf8'))
		}
	}
	await walk(dir, '')
	return found
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

/**
 * A genuinely compiled Input Schema v2 candidate: its IR and its digest come
 * from one compilation, so the pair carries one identity and may found a set.
 */
async function compiledV2(): Promise<{
	readonly ir: SpecificationIr
	readonly digest: SpecificationDigest
}> {
	const source = await Bun.file(
		new URL('../fixtures/v2/declared-surfaces.jsonc', import.meta.url),
	).text()
	const compiled = compileSpecificationCandidate(source)
	if (!compiled.ok) throw new Error('v2 fixture failed to compile')
	return { ir: compiled.ir, digest: compiled.digest }
}

/** The observed failure cause, or a marker naming the unexpected success. */
function causeOf(result: {
	readonly ok: boolean
	readonly cause?: GenerationFailureCause
}): GenerationFailureCause {
	if (result.ok || result.cause === undefined) {
		throw new Error('generation succeeded where a refusal was expected')
	}
	return result.cause
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

/**
 * A provenance manifest is untrusted input.
 *
 * Any process can write one: the specification digest is printed in every
 * generated header, so identity is a claim the file makes about itself rather
 * than evidence anyone checked. Its `declared_outputs` then reach a delete
 * call, which means an unsafe path there is an instruction to remove a file
 * outside the Generated Artifact Set.
 *
 * Generation never overwrites, merges, moves or deletes anything outside the
 * set it owns. Holding that requires validating each declared path where it is
 * read, not relying on a later gate that happens to reject the same input for
 * another reason: a materialisation check reports "not fully present", which
 * both names the wrong cause and stops protecting the moment the gates are
 * reordered.
 */
describe('a manifest cannot declare an output outside the set', () => {
	/**
	 * Each planted manifest carries one legitimate in-set path beside the
	 * offending one. Refusing the whole manifest is what keeps the legitimate
	 * entry from being processed on its own, so the survivor is evidence about
	 * the refusal rather than decoration.
	 */
	const UNSAFE_OUTPUTS: ReadonlyArray<{
		readonly label: string
		readonly offending: string
	}> = [
		{ label: 'a parent-escaping path', offending: '../victim.txt' },
		{
			label: 'a path escaping through a subdirectory',
			offending: 'src/../../victim.txt',
		},
		{ label: 'an absolute path', offending: '/etc/victim.txt' },
		{ label: 'a bare parent segment', offending: '..' },
		{ label: 'a backslash-separated path', offending: '..\\victim.txt' },
		{ label: 'a drive-letter path', offending: 'C:/victim.txt' },
		{ label: 'a current-directory segment', offending: './victim.txt' },
	]

	test('the case list is non-empty', () => {
		expect(UNSAFE_OUTPUTS.length).toBeGreaterThan(0)
	})

	for (const { label, offending } of UNSAFE_OUTPUTS) {
		for (const { verb, call } of ENTRY_POINTS) {
			test(`${label} refuses before any delete via ${verb}`, async () => {
				const compiled = await compiledSpike('vault-git')
				const ir = amendForEmission(compiled.ir)
				const root = await outputDir()
				const dir = join(root, 'out')
				await mkdir(dir, { recursive: true })

				// A real set, so identity and materialisation both genuinely
				// hold and the manifest read is the only gate left standing.
				const declared = await seedLegacyArtifactSet(dir, ir, compiled.digest)

				// The sibling the offending path aims at, outside the set.
				const victim = join(root, 'victim.txt')
				await writeFile(victim, 'do not delete me', 'utf8')

				const manifestPath = join(dir, 'provenance.manifest.json')
				const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
					declared_outputs: string[]
				}
				await writeFile(
					manifestPath,
					JSON.stringify({
						...manifest,
						declared_outputs: [...manifest.declared_outputs, offending],
					}),
					'utf8',
				)

				const before = await filesUnder(dir)

				const result = await call(ir, compiled.digest, { outputDir: dir })

				expect({ label, verb, ok: result.ok }).toEqual({
					label,
					verb,
					ok: false,
				})
				if (result.ok) return
				// Not `generation_foreign_existing_set`: an attacker-shaped path
				// and a set belonging to another product are different failures
				// with different repairs, and a caller branches on cause.
				expect({ label, verb, cause: result.cause }).toEqual({
					label,
					verb,
					cause: 'generation_unsafe_declared_output',
				})
				// The refusal names the offending path, so a reader repairs the
				// manifest without parsing prose.
				expect({ label, verb, subject: result.subject }).toEqual({
					label,
					verb,
					subject: offending,
				})

				// Byte-identical, read back independently: existence alone would
				// pass against a file deleted and re-created empty.
				expect({ label, verb, victim: await readFile(victim, 'utf8') }).toEqual(
					{ label, verb, victim: 'do not delete me' },
				)
				expect({ label, verb, after: await filesUnder(dir) }).toEqual({
					label,
					verb,
					after: before,
				})
				expect(declared.length).toBeGreaterThan(0)
			})
		}
	}

	for (const { verb, call } of ENTRY_POINTS) {
		test(`a duplicate declared output refuses via ${verb}`, async () => {
			const compiled = await compiledSpike('vault-git')
			const ir = amendForEmission(compiled.ir)
			const dir = await outputDir()
			await seedLegacyArtifactSet(dir, ir, compiled.digest)

			const manifestPath = join(dir, 'provenance.manifest.json')
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
				declared_outputs: string[]
			}
			const [repeated] = manifest.declared_outputs
			if (repeated === undefined) throw new Error('seed declared no outputs')
			await writeFile(
				manifestPath,
				JSON.stringify({
					...manifest,
					declared_outputs: [...manifest.declared_outputs, repeated],
				}),
				'utf8',
			)

			const before = await filesUnder(dir)

			const result = await call(ir, compiled.digest, { outputDir: dir })

			expect({ verb, ok: result.ok }).toEqual({ verb, ok: false })
			if (result.ok) return
			expect({ verb, cause: result.cause }).toEqual({
				verb,
				cause: 'generation_unsafe_declared_output',
			})
			expect({ verb, subject: result.subject }).toEqual({
				verb,
				subject: repeated,
			})
			expect({ verb, after: await filesUnder(dir) }).toEqual({
				verb,
				after: before,
			})
		})
	}

	/**
	 * Positive control for the survival assertions above.
	 *
	 * Without it those assertions could pass because this path never deletes
	 * anything at all, rather than because the unsafe entry was refused. A
	 * superseded output the new set does not declare must still be removed, so
	 * the fixture plants both what must go and what must stay.
	 */
	test('a safe superseded output is still deleted, and its sibling survives', async () => {
		const compiled = await compiledSpike('vault-git')
		const ir = amendForEmission(compiled.ir)
		const root = await outputDir()
		const dir = join(root, 'out')
		await mkdir(dir, { recursive: true })
		await seedLegacyArtifactSet(dir, ir, compiled.digest)

		const victim = join(root, 'victim.txt')
		await writeFile(victim, 'do not delete me', 'utf8')

		// A retired artifact: declared by the manifest, present on disk, and
		// not part of what this compilation renders.
		const retired = 'src/retired-artifact.ts'
		await writeFile(join(dir, retired), '// retired\n', 'utf8')
		const manifestPath = join(dir, 'provenance.manifest.json')
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			declared_outputs: string[]
		}
		await writeFile(
			manifestPath,
			JSON.stringify({
				...manifest,
				declared_outputs: [...manifest.declared_outputs, retired],
			}),
			'utf8',
		)

		const result = await regenerateArtifactSet(ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(true)
		// Deleted: the sweep genuinely reaches the filesystem here.
		expect(await entriesIn(join(dir, 'src'))).not.toContain(
			'retired-artifact.ts',
		)
		// Survived: byte-identical, outside the set.
		expect(await readFile(victim, 'utf8')).toBe('do not delete me')
	})
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
	/**
	 * One producer per sealed generation cause, each running the real verbs
	 * against a real directory. The previous registry mapped each cause to the
	 * NAME of the suite that proved it and asserted the string was non-empty,
	 * which is a claim about a filename rather than about reachability: a
	 * cause whose producer was deleted would keep passing.
	 *
	 * The Record type keeps this total, so a cause added to the sealed list
	 * without a producer fails typecheck before it fails the suite.
	 */
	const PRODUCERS: Readonly<
		Record<GenerationFailureCause, () => Promise<GenerationFailureCause>>
	> = {
		// A v1 candidate cannot found a new set.
		generation_superseded_input_schema: async () => {
			const compiled = await compiledSpike('vault-git')
			const result = await generateArtifactSet(compiled.ir, compiled.digest, {
				outputDir: await outputDir(),
			})
			return causeOf(result)
		},
		// Regeneration with nothing on disk to replace.
		generation_no_existing_set: async () => {
			const { ir, digest } = await compiledV2()
			const result = await regenerateArtifactSet(ir, digest, {
				outputDir: await outputDir(),
			})
			return causeOf(result)
		},
		// The IR and the digest disagree about which identity produced them.
		generation_provenance_mismatch: async () => {
			const { ir } = await compiledV2()
			const foreign = await compiledSpike('vault-git')
			const result = await generateArtifactSet(ir, foreign.digest, {
				outputDir: await outputDir(),
			})
			return causeOf(result)
		},
		// A set on disk this compilation does not describe.
		generation_foreign_existing_set: async () => {
			const dir = await outputDir()
			const spike = await compiledSpike('vault-git')
			await seedLegacyArtifactSet(dir, amendForEmission(spike.ir), spike.digest)
			const { ir, digest } = await compiledV2()
			const result = await regenerateArtifactSet(ir, digest, {
				outputDir: dir,
			})
			return causeOf(result)
		},
		// A manifest whose bytes cannot be parsed.
		generation_unreadable_manifest: async () => {
			const dir = await outputDir()
			const { ir, digest } = await compiledV2()
			await generateArtifactSet(ir, digest, { outputDir: dir })
			await writeFile(join(dir, 'provenance.manifest.json'), 'not json', 'utf8')
			const result = await regenerateArtifactSet(ir, digest, {
				outputDir: dir,
			})
			return causeOf(result)
		},
		// A manifest declaring an output outside the set.
		generation_unsafe_declared_output: async () => {
			const dir = await outputDir()
			const { ir, digest } = await compiledV2()
			await generateArtifactSet(ir, digest, { outputDir: dir })
			const manifestPath = join(dir, 'provenance.manifest.json')
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
				declared_outputs: string[]
			}
			manifest.declared_outputs = [
				...manifest.declared_outputs,
				'../escaped.txt',
			]
			await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
			const result = await regenerateArtifactSet(ir, digest, {
				outputDir: dir,
			})
			return causeOf(result)
		},
		// An emitter that throws.
		generation_emitter_failure: async () => {
			const { ir, digest } = await compiledV2()
			const result = await generateArtifactSet(ir, digest, {
				outputDir: await outputDir(),
				emitters: [
					{
						name: 'throwing-emitter',
						emit: () => {
							throw new Error('emitter probe')
						},
					},
				],
			})
			return causeOf(result)
		},
		// An emitter that refuses because the specification declares too little.
		generation_emit_refused: async () => {
			const { ir, digest } = await compiledV2()
			const result = await generateArtifactSet(
				{ ...ir, blockers: [], routing: [] },
				digest,
				{ outputDir: await outputDir() },
			)
			return causeOf(result)
		},
		// The set could not be written: the output path is a file, not a
		// directory, so staging cannot create anything beneath it.
		generation_write_failure: async () => {
			const dir = await outputDir()
			const blocked = join(dir, 'blocked')
			await writeFile(blocked, 'not a directory', 'utf8')
			const { ir, digest } = await compiledV2()
			const result = await generateArtifactSet(ir, digest, {
				outputDir: join(blocked, 'set'),
			})
			return causeOf(result)
		},
	}

	test('no generation refusal message carries an absolute path', async () => {
		// The package rule: `message` is the human half of a contract, so a
		// reader must not be able to tell which directory raised it. The
		// output directory is a caller-supplied absolute path under mkdtemp
		// here, which is exactly what must not appear.
		expect(GENERATION_FAILURE_CAUSES.length).toBeGreaterThan(0)
		const dir = await outputDir()
		const { ir, digest } = await compiledV2()
		const refused = await regenerateArtifactSet(ir, digest, {
			outputDir: dir,
		})
		expect(refused.ok).toBe(false)
		if (refused.ok) return
		// Positive control: the directory really is an absolute path, so the
		// absence below is the message being clean rather than the path being
		// empty.
		expect(dir.startsWith('/')).toBe(true)
		expect(refused.message).not.toContain(dir)
		expect(refused.message.length).toBeGreaterThan(0)
	})

	test('the registry covers the sealed list member for member', () => {
		expect(GENERATION_FAILURE_CAUSES.length).toBeGreaterThan(0)
		// Total by construction: a cause added to the sealed list without a
		// producer here fails typecheck before it fails this assertion.
		expect(Object.keys(PRODUCERS).sort()).toEqual(
			[...GENERATION_FAILURE_CAUSES].sort(),
		)
	})

	for (const cause of GENERATION_FAILURE_CAUSES) {
		test(`${cause} is raised by its producer`, async () => {
			// Live reachability: the producer runs a real verb and the cause it
			// observed is compared to the cause it claims. A guard deleted in
			// src fails here rather than in a reviewer's memory.
			expect({ cause, observed: await PRODUCERS[cause]() }).toEqual({
				cause,
				observed: cause,
			})
		})
	}
})
