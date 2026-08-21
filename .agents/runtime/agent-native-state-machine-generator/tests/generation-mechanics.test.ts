import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactEmitter } from '../src/index.ts'
import {
	ARTIFACT_REFUSAL_CAUSES,
	compileSpecificationCandidate,
	DEFAULT_EMITTERS,
	generateArtifactSet,
	regenerateArtifactSet,
	verifyArtifactSet,
} from '../src/index.ts'
import { readCandidate, readNegativeFixture } from './support/candidates.ts'
import { emitAmended } from './support/emission.ts'

/**
 * The package registry as tests see it. Held here so a test that adds or
 * retires an emitter is explicit about what the baseline declared.
 */
const DEFAULT_TEST_EMITTERS: readonly ArtifactEmitter[] = DEFAULT_EMITTERS

const created: string[] = []

async function outputDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'asmg-gen-'))
	created.push(dir)
	return dir
}

afterEach(async () => {
	while (created.length > 0) {
		const dir = created.pop()
		if (dir) await rm(dir, { recursive: true, force: true })
	}
})

/** Independent reader: walks the real directory rather than trusting the writer. */
async function snapshot(dir: string): Promise<ReadonlyMap<string, string>> {
	const entries = new Map<string, string>()
	async function walk(current: string, prefix: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const absolute = join(current, entry.name)
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (entry.isDirectory()) await walk(absolute, relative)
			else entries.set(relative, await Bun.file(absolute).text())
		}
	}
	await walk(dir, '')
	return entries
}

/**
 * A compiled candidate whose IR can actually generate.
 *
 * The raw candidates cannot: both refuse emission on the three sealed
 * expressiveness refusals that Input Schema v1 cannot satisfy
 * (`emit_write_preview_undeclarable`, `emit_expectation_column_underivable`,
 * and the unbound no-argument binding), which is the correct recorded
 * consequence and is pinned by `expressiveness-gaps.test.ts`. The
 * amendment is IR-side only, standing in for what a stage-5 admitted surface
 * will declare, so every emitter under test runs exactly as it will in
 * production.
 *
 * The digest stays the real one from the unamended source: the manifest binds
 * a set to the admitted input it came from, not to a test amendment.
 */
async function compile(product: 'vault-git' | 'fallow') {
	const result = compileSpecificationCandidate(await readCandidate(product), {
		sourcePath: `${product}.state-machine.jsonc`,
	})
	if (!result.ok) throw new Error('fixture candidate must compile')
	const { ir } = await emitAmended(product)
	return { ...result, ir }
}

/**
 * A declared output every generated set carries, used by drift tests that need
 * some artifact to perturb. Named once so a change to the set's shape lands in
 * one place rather than in every drift case.
 */
const A_DECLARED_ARTIFACT = 'src/branch-station-catalog.ts'

/** A stub emitter that succeeds with the given declared outputs. */
function emitting(
	name: string,
	artifacts: Readonly<Record<string, string>>,
): ArtifactEmitter {
	return {
		name,
		emit: () => ({ ok: true, artifacts: new Map(Object.entries(artifacts)) }),
	}
}

describe('generating a Generated Artifact Set', () => {
	test('sweeps a stale staging sibling, and only that sibling, before staging', async () => {
		const parent = await outputDir()
		const dir = join(parent, 'generated')
		const staleStaging = join(parent, '.asmg-staging-stranded')
		const survivor = join(parent, 'unrelated-sibling')
		await mkdir(staleStaging, { recursive: true })
		await Bun.write(join(staleStaging, 'leftover.txt'), 'stranded bytes')
		await mkdir(survivor, { recursive: true })
		await Bun.write(join(survivor, 'keep.txt'), 'must survive')
		const compiled = await compile('vault-git')

		const result = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(true)
		// Both halves in one test: the planted stale staging sibling must be
		// deleted, and the non-matching sibling must survive with its bytes.
		// A sweep that deletes siblings can over-delete; only a planted
		// survivor holds that boundary.
		const siblings = await readdir(parent)
		expect(siblings.includes('.asmg-staging-stranded')).toBe(false)
		expect(siblings.includes('unrelated-sibling')).toBe(true)
		expect(await Bun.file(join(survivor, 'keep.txt')).text()).toBe(
			'must survive',
		)
	})

	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} writes a complete set plus one provenance manifest`, async () => {
			const dir = await outputDir()
			const compiled = await compile(product)

			const result = await generateArtifactSet(compiled.ir, compiled.digest, {
				outputDir: dir,
			})

			expect(result.ok).toBe(true)
			if (!result.ok) return

			const written = await snapshot(dir)
			// Every declared artifact is on disk, and nothing else is.
			expect([...written.keys()].sort()).toEqual(
				[...result.declaredOutputs].sort(),
			)
			expect(written.has('provenance.manifest.json')).toBe(true)

			const manifest = JSON.parse(
				written.get('provenance.manifest.json') as string,
			)
			expect(manifest.specification_digest).toBe(
				compiled.digest.specificationDigest,
			)
			expect(manifest.input_schema_version).toBe(
				compiled.digest.inputSchemaVersion,
			)
			expect(manifest.generator_contract_version).toBe(
				compiled.digest.generatorContractVersion,
			)
			expect(manifest.declared_outputs).toEqual(
				[...result.declaredOutputs].sort(),
			)
			// YAGNI ruling: digest and generator identity only, no per-file hashes.
			expect(JSON.stringify(manifest)).not.toContain('output_hashes')
		})
	}

	test('repeat generation is byte-identical', async () => {
		const compiled = await compile('vault-git')
		const first = await outputDir()
		const second = await outputDir()

		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: first,
		})
		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: second,
		})

		expect(await snapshot(second)).toEqual(await snapshot(first))
	})

	test('leaves no artifact behind when an emitter fails mid-generation', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')

		const result = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [
				{
					name: 'exploding',
					emit: () => {
						throw new Error('emitter failure')
					},
				},
			],
		})

		expect(result.ok).toBe(false)
		// Fail closed: the directory must not hold a partial set.
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})
})

describe('verifying a Generated Artifact Set for drift', () => {
	test('accepts a set that matches its regeneration', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(true)
	})

	test('refuses a missing declared artifact', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		await rm(join(dir, A_DECLARED_ARTIFACT))

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generated_drift')
		expect(result.findings.map((finding) => finding.cause)).toContain(
			'missing_artifact',
		)
	})

	test('refuses an unexpected extra artifact inside the declared set', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			// A set generated with an extra emitter, then verified against a
			// registry that no longer declares that output.
			emitters: [
				...DEFAULT_TEST_EMITTERS,
				emitting('retired', { 'retired-contract.json': '{}\n' }),
			],
		})

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: DEFAULT_TEST_EMITTERS,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generated_drift')
		const unexpected = result.findings.filter(
			(finding) => finding.cause === 'unexpected_artifact',
		)
		expect(unexpected.map((finding) => finding.subject)).toContain(
			'retired-contract.json',
		)
	})

	test('refuses a hand-edited artifact', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		const target = join(dir, A_DECLARED_ARTIFACT)
		await Bun.write(target, `${await Bun.file(target).text()}// hand edit\n`)

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.findings.map((finding) => finding.cause)).toContain(
			'modified_artifact',
		)
	})

	test('refuses a stale set whose manifest digest no longer matches the input', async () => {
		const dir = await outputDir()
		const original = await compile('vault-git')
		await generateArtifactSet(original.ir, original.digest, { outputDir: dir })

		// The admitted input moved on; the set on disk still records the old digest.
		const changed = compileSpecificationCandidate(
			(await readCandidate('vault-git')).replace(
				'"offline_mode"',
				'"offline_mode_renamed"',
			),
		)
		expect(changed.ok).toBe(true)
		if (!changed.ok) return

		const result = await verifyArtifactSet(changed.ir, changed.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.findings.map((finding) => finding.cause)).toContain(
			'stale_artifact_set',
		)
	})

	test('accepts Handwritten Extensions living outside the output directory', async () => {
		const root = await outputDir()
		const dir = join(root, 'generated')
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		// Handwritten Extensions, fixtures and proof artifacts live OUTSIDE the
		// generator-owned output directory, as siblings of it. That placement
		// is what lets them survive regeneration without the generator having
		// to infer from a naming convention which files it may replace.
		await Bun.write(join(root, 'my-fact-provider.ts'), 'export const f = 1\n')
		await mkdir(join(root, 'proof'), { recursive: true })
		await Bun.write(join(root, 'proof', 'evidence.json'), '{"observed":true}\n')

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result).toMatchObject({ ok: true })
	})

	test('refuses an undeclared file dropped inside the output directory', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		// The output directory is wholly generator-owned, so a file the set
		// does not declare is refused even though no manifest ever named it.
		await Bun.write(join(dir, 'orphan.json'), '{"hand":"dropped"}\n')

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generated_drift')
		const unexpected = result.findings.filter(
			(finding) => finding.cause === 'unexpected_artifact',
		)
		expect(unexpected.map((finding) => finding.subject)).toContain(
			'orphan.json',
		)
	})

	test('refuses a set with no provenance manifest at all', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		await rm(join(dir, 'provenance.manifest.json'))

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.findings.map((finding) => finding.cause)).toContain(
			'missing_manifest',
		)
	})

	test('leaves the working tree byte-identical after a failing verification', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		const target = join(dir, A_DECLARED_ARTIFACT)
		await Bun.write(target, 'hand written garbage\n')
		// Plant a file the set never declared, alongside the drifted artifact.
		await Bun.write(
			join(dir, 'handwritten-extension.ts'),
			'export const x = 1\n',
		)

		const before = await snapshot(dir)
		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})
		const after = await snapshot(dir)

		expect(result.ok).toBe(false)
		// Verification is read-only: a check must never repair what it found.
		expect(after).toEqual(before)
	})
})

describe('regenerating a Generated Artifact Set', () => {
	test('replaces the complete set and leaves files outside it untouched', async () => {
		const root = await outputDir()
		const dir = join(root, 'generated')
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		// A Handwritten Extension and a proof artifact, as siblings of the
		// generator-owned output directory.
		await Bun.write(
			join(root, 'handwritten-extension.ts'),
			'export const fact = 1\n',
		)
		await mkdir(join(root, 'proof'), { recursive: true })
		await Bun.write(join(root, 'proof', 'evidence.json'), '{"observed":true}\n')
		// Drift both declared artifacts.
		await Bun.write(join(dir, A_DECLARED_ARTIFACT), 'stale\n')
		await Bun.write(join(dir, 'provenance.manifest.json'), '{}\n')

		const result = await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(true)
		// The full set is restored as one unit...
		expect(
			await verifyArtifactSet(compiled.ir, compiled.digest, { outputDir: dir }),
		).toMatchObject({ ok: true })
		// ...and nothing outside the declared set was written, moved or removed.
		expect(await Bun.file(join(root, 'handwritten-extension.ts')).text()).toBe(
			'export const fact = 1\n',
		)
		expect(await Bun.file(join(root, 'proof', 'evidence.json')).text()).toBe(
			'{"observed":true}\n',
		)
	})

	test('drops an output the generator no longer declares', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [
				...DEFAULT_TEST_EMITTERS,
				emitting('retired', { 'retired-contract.json': '{}\n' }),
			],
		})

		await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: DEFAULT_TEST_EMITTERS,
		})

		// The set is replaced as one unit: a retired artifact does not linger.
		expect(await Bun.file(join(dir, 'retired-contract.json')).exists()).toBe(
			false,
		)
		expect(
			await verifyArtifactSet(compiled.ir, compiled.digest, { outputDir: dir }),
		).toMatchObject({ ok: true })
	})

	test('leaves the existing set intact when a new declared path cannot be written', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		const before = await snapshot(dir)

		// A declared path whose rename cannot complete: a non-empty directory
		// already occupies the target name. This reaches the filesystem, unlike
		// an emitter that throws before any write happens.
		await mkdir(join(dir, 'blocked.json'), { recursive: true })
		await Bun.write(join(dir, 'blocked.json', 'occupant.txt'), 'x\n')

		const result = await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [
				...DEFAULT_TEST_EMITTERS,
				emitting('blocked', { 'blocked.json': '{}\n' }),
			],
		})

		expect(result.ok).toBe(false)
		// Fail closed: a replacement that cannot finish must not destroy the
		// set it was replacing. Every previously declared artifact survives
		// with its original bytes.
		for (const [path, contents] of before) {
			expect(await Bun.file(join(dir, path)).text()).toBe(contents)
		}
	})

	test('leaves an existing set intact when regeneration fails', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		const before = await snapshot(dir)

		const result = await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [
				{
					name: 'exploding',
					emit: () => {
						throw new Error('emitter failure')
					},
				},
			],
		})

		expect(result.ok).toBe(false)
		// Fail closed: the previous complete set survives rather than being
		// half-replaced by a set that could not be rendered.
		expect(await snapshot(dir)).toEqual(before)
	})
})

describe('fail-closed across the compile seam', () => {
	test('a compile failure yields no IR to generate from, so no set is written', async () => {
		const dir = await outputDir()
		const invalid = compileSpecificationCandidate(
			await readNegativeFixture('unresolved-reference'),
		)

		expect(invalid.ok).toBe(false)
		if (invalid.ok) return
		expect(invalid.diagnostics.length).toBeGreaterThan(0)

		// The failure variant carries no `ir` and no `digest`, so generation is
		// unreachable by construction rather than by a caller remembering to
		// check. Nothing was written for the rejected candidate.
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})

	test('an unsafe declared output path is refused before anything is written', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')

		const result = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [emitting('escaping', { '../escaped.json': '{}\n' })],
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_emitter_failure')
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})

	test('two emitters declaring one path is refused, not silently resolved', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		const collide = (name: string) =>
			emitting(name, { 'contested.json': `{"from":"${name}"}\n` })

		const result = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [collide('first'), collide('second')],
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_emitter_failure')
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})
})

describe('regeneration is distinct from generation', () => {
	test('refuses a target that holds no existing set to replace', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')

		const result = await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_no_existing_set')
		// Nothing was created: regeneration replaces, it does not establish.
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})

	test('generation establishes a fresh target that regeneration then replaces', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')

		const created = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})
		expect(created.ok).toBe(true)

		const replaced = await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})
		expect(replaced.ok).toBe(true)
		expect(
			await verifyArtifactSet(compiled.ir, compiled.digest, { outputDir: dir }),
		).toMatchObject({ ok: true })
	})
})

describe('the fallow candidate across every lane', () => {
	/**
	 * Fallow is the mostly stateless product: it declares no durable
	 * operations, no liveness evidence, no version custody and no
	 * cancellation. Under feature-conditioning, none of that machinery may
	 * reach its Generated Artifact Set.
	 */
	test('verification accepts, then refuses drift, on a fallow set', async () => {
		const dir = await outputDir()
		const compiled = await compile('fallow')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		expect(
			await verifyArtifactSet(compiled.ir, compiled.digest, { outputDir: dir }),
		).toMatchObject({ ok: true })

		await Bun.write(join(dir, A_DECLARED_ARTIFACT), 'hand edited\n')
		const drifted = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(drifted.ok).toBe(false)
		if (drifted.ok) return
		expect(drifted.cause).toBe('generated_drift')
		expect(drifted.findings.map((finding) => finding.cause)).toContain(
			'modified_artifact',
		)
	})

	test('regeneration replaces a fallow set as one unit', async () => {
		const dir = await outputDir()
		const compiled = await compile('fallow')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		await Bun.write(join(dir, A_DECLARED_ARTIFACT), 'stale\n')

		const result = await regenerateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(true)
		expect(
			await verifyArtifactSet(compiled.ir, compiled.digest, { outputDir: dir }),
		).toMatchObject({ ok: true })
	})

	test('a fallow set carries no durable-work machinery', async () => {
		const dir = await outputDir()
		const compiled = await compile('fallow')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		const written = await snapshot(dir)

		// The whole Generated Artifact Set is scanned, not one artifact. A
		// stateless product's output must contain no durable-operation,
		// liveness, retry, Cancellation or version-custody surface anywhere:
		// the omission is structural, so no artifact gets an exemption.
		expect(written.size).toBeGreaterThan(1)
		const generated = [...written.values()].join('\n')

		for (const absent of [
			'logical_operation',
			'logicalOperation',
			'acknowledgement',
			'heartbeat',
			'liveness',
			'cancellation',
			'operation_progress',
			'progress_owner',
			'incompatible_run_version',
			'attempt',
			'retry_posture',
		]) {
			expect(generated).not.toContain(absent)
		}
	})

	test('repeat generation of a fallow set is byte-identical', async () => {
		const compiled = await compile('fallow')
		const first = await outputDir()
		const second = await outputDir()

		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: first,
		})
		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: second,
		})

		expect(await snapshot(second)).toEqual(await snapshot(first))
	})
})

/**
 * The consolidation gate: the real emitters reach generation and verification.
 *
 * Until stage 3's derivation was wired into the emitter registry, generation
 * wrote a placeholder summary while the station catalog, Command Surface
 * Contract and expectation table were reachable only by calling the derivation
 * directly. These cases cross `src/index.ts` exactly as a consumer does, so a
 * regression that unwires the seam fails here rather than in a unit test that
 * calls the derivation itself.
 */
describe('the real Generated Artifact Set reaches generation and verification', () => {
	test('generate writes every derived contract, and verify accepts it', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')

		const result = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return

		// The declared set is the real one: every consumer-facing contract, plus
		// the manifest that binds them to the admitted input.
		expect([...result.declaredOutputs].sort()).toEqual([
			'provenance.manifest.json',
			'src/branch-station-catalog.ts',
			'src/command-surface-contract.ts',
			'src/semantic-expectations.ts',
		])

		// Read back independently: the bytes are on disk, not merely promised.
		const written = await snapshot(dir)
		expect([...written.keys()].sort()).toEqual([...result.declaredOutputs])
		expect(written.get('src/branch-station-catalog.ts')).toContain(
			'BranchStation',
		)
		expect(written.get('src/command-surface-contract.ts')).toContain(
			'CommandFacadeContract',
		)

		// Verification is clean immediately after generation: the drift oracle
		// agrees with what generation just wrote.
		const verified = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})
		expect(verified.ok).toBe(true)
	})

	test('corrupting one derived contract makes verification refuse it', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		const target = join(dir, 'src/command-surface-contract.ts')
		const original = await Bun.file(target).text()
		await Bun.write(target, `${original}\n// hand edited\n`)

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generated_drift')
		expect(
			result.findings
				.filter((finding) => finding.cause === 'modified_artifact')
				.map((finding) => finding.subject),
		).toContain('src/command-surface-contract.ts')

		// Verification is read-only: the hand edit is still there, unrepaired.
		expect(await Bun.file(target).text()).toBe(`${original}\n// hand edited\n`)
	})

	test('generating the real set twice is byte-identical', async () => {
		const compiled = await compile('vault-git')
		const first = await outputDir()
		const second = await outputDir()

		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: first,
		})
		await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: second,
		})

		const a = await snapshot(first)
		expect(a.size).toBe(4)
		expect(await snapshot(second)).toEqual(a)
	})
})

describe('an emit refusal fails generation closed', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`the unamended ${product} candidate writes nothing and refuses`, async () => {
			const dir = await outputDir()
			// The raw compiled IR, deliberately NOT amended: Input Schema v1
			// cannot express what the derivation needs, so emission refuses.
			const compiled = compileSpecificationCandidate(
				await readCandidate(product),
			)
			if (!compiled.ok) throw new Error('fixture candidate must compile')

			const result = await generateArtifactSet(compiled.ir, compiled.digest, {
				outputDir: dir,
			})

			expect(result.ok).toBe(false)
			if (result.ok) return

			// A typed refusal, branchable on sealed causes rather than on prose.
			expect(result.cause).toBe('generation_emit_refused')
			expect(result.refusals.length).toBeGreaterThan(0)
			for (const refusal of result.refusals) {
				expect(ARTIFACT_REFUSAL_CAUSES).toContain(refusal.cause)
			}

			// Fail closed: not one byte reached the output directory, so no
			// partial Generated Artifact Set can be mistaken for a usable one.
			expect([...(await snapshot(dir)).keys()]).toEqual([])
		})
	}

	test('a refusing emitter stops the set even beside emitters that succeed', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')

		const result = await generateArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
			emitters: [
				emitting('willing', { 'willing.json': '{}\n' }),
				{
					name: 'refusing',
					emit: () => ({
						ok: false,
						refusals: [
							{
								cause: 'emit_result_contract_undeclared' as const,
								subject: 'some-command',
								message: 'the candidate declares no result contract',
							},
						],
					}),
				},
			],
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_emit_refused')
		// The failure names its subject: the refusing emitter, not prose to
		// parse out of message (repair S2).
		expect(result.subject).toBe('refusing')
		expect(result.refusals.map((refusal) => refusal.cause)).toEqual([
			'emit_result_contract_undeclared',
		])
		// The willing emitter's artifact is not on disk either: the set is
		// replaced as one unit, so a partial set is never written.
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})
})
