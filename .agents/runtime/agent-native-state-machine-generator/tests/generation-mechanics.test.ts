import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EMITTERS } from '../src/emit.ts'
import type { ArtifactEmitter } from '../src/index.ts'
import {
	compileSpecificationCandidate,
	generateArtifactSet,
	regenerateArtifactSet,
	verifyArtifactSet,
} from '../src/index.ts'
import { readCandidate, readNegativeFixture } from './support/candidates.ts'

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

async function compile(product: 'vault-git' | 'fallow') {
	const result = compileSpecificationCandidate(await readCandidate(product), {
		sourcePath: `${product}.state-machine.jsonc`,
	})
	if (!result.ok) throw new Error('fixture candidate must compile')
	return result
}

describe('generating a Generated Artifact Set', () => {
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
		await rm(join(dir, 'specification-summary.json'))

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generated_drift')
		expect(result.findings.map((finding) => finding.reason)).toContain(
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
				{
					name: 'retired',
					emit: () => new Map([['retired-contract.json', '{}\n']]),
				},
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
			(finding) => finding.reason === 'unexpected_artifact',
		)
		expect(unexpected.map((finding) => finding.path)).toContain(
			'retired-contract.json',
		)
	})

	test('refuses a hand-edited artifact', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		const target = join(dir, 'specification-summary.json')
		await Bun.write(target, `${await Bun.file(target).text()}// hand edit\n`)

		const result = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: dir,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.findings.map((finding) => finding.reason)).toContain(
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
		expect(result.findings.map((finding) => finding.reason)).toContain(
			'stale_artifact_set',
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
		expect(result.findings.map((finding) => finding.reason)).toContain(
			'missing_manifest',
		)
	})

	test('leaves the working tree byte-identical after a failing verification', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })
		const target = join(dir, 'specification-summary.json')
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
	test('replaces the complete set and leaves non-declared files untouched', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		await generateArtifactSet(compiled.ir, compiled.digest, { outputDir: dir })

		// A Handwritten Extension and a proof artifact sharing the directory.
		await Bun.write(
			join(dir, 'handwritten-extension.ts'),
			'export const fact = 1\n',
		)
		await mkdir(join(dir, 'proof'), { recursive: true })
		await Bun.write(join(dir, 'proof', 'evidence.json'), '{"observed":true}\n')
		// Drift both declared artifacts.
		await Bun.write(join(dir, 'specification-summary.json'), 'stale\n')
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
		expect(await Bun.file(join(dir, 'handwritten-extension.ts')).text()).toBe(
			'export const fact = 1\n',
		)
		expect(await Bun.file(join(dir, 'proof', 'evidence.json')).text()).toBe(
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
				{
					name: 'retired',
					emit: () => new Map([['retired-contract.json', '{}\n']]),
				},
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
			emitters: [
				{
					name: 'escaping',
					emit: () => new Map([['../escaped.json', '{}\n']]),
				},
			],
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.cause).toBe('generation_emitter_failure')
		expect([...(await snapshot(dir)).keys()]).toEqual([])
	})

	test('two emitters declaring one path is refused, not silently resolved', async () => {
		const dir = await outputDir()
		const compiled = await compile('vault-git')
		const collide = (name: string) => ({
			name,
			emit: () => new Map([['contested.json', `{"from":"${name}"}\n`]]),
		})

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
