/**
 * Generation mechanics for one Generated Artifact Set.
 *
 * Three verbs, one rendering path:
 *
 *   generate    — write a complete set plus its provenance manifest, as a unit
 *   verify      — read-only drift check against an isolated regeneration
 *   regenerate  — intentionally replace the complete set, as a unit
 *
 * Every verb renders through the same emitter fan-out. If verification had a
 * second rendering path it would compare the working tree against something
 * other than what generation actually produces, and the drift oracle would be
 * checking the wrong thing.
 *
 * A Generated Artifact Set is disposable output, never a second semantic
 * authority. Anything outside the declared output set — Handwritten
 * Extensions, the Extension Registry, Real Process Fixtures, Proof Adapters,
 * observed evidence — is never written, moved or removed by any verb here.
 */
import type { Dirent } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SpecificationDigest } from './canonical.ts'
import {
	type ArtifactEmitter,
	buildProvenanceManifest,
	DEFAULT_EMITTERS,
	PROVENANCE_MANIFEST_PATH,
} from './emit.ts'
import type { SpecificationIr } from './ir.ts'

export interface GenerationOptions {
	/** Directory that holds the Generated Artifact Set. */
	readonly outputDir: string
	/** Defaults to the package registry; overridden in tests and by stage 3. */
	readonly emitters?: readonly ArtifactEmitter[]
}

/** Sealed causes for a generation that produced nothing. */
export const GENERATION_FAILURE_CAUSES = [
	/** An emitter threw, or two emitters claimed the same declared path. */
	'generation_emitter_failure',
	/** The set could not be written or replaced on disk. */
	'generation_write_failure',
] as const

export type GenerationFailureCause = (typeof GENERATION_FAILURE_CAUSES)[number]

export interface GenerationSuccess {
	readonly ok: true
	/** Every path written, relative to `outputDir`, sorted. */
	readonly declaredOutputs: readonly string[]
	readonly specificationDigest: string
}

export interface GenerationFailure {
	readonly ok: false
	readonly cause: GenerationFailureCause
	readonly message: string
}

export type GenerationResult = GenerationSuccess | GenerationFailure

/** Sealed reasons a declared artifact set is refused as drifted. */
export const DRIFT_REASONS = [
	/** A declared artifact is absent from the working tree. */
	'missing_artifact',
	/** The working tree holds a file the declared output set does not name. */
	'unexpected_artifact',
	/** A declared artifact's bytes differ from its regeneration. */
	'modified_artifact',
	/** The manifest's digest no longer matches the admitted input. */
	'stale_artifact_set',
	/** No provenance manifest, so the set has no admitted origin at all. */
	'missing_manifest',
] as const

export type DriftReason = (typeof DRIFT_REASONS)[number]

export interface DriftFinding {
	readonly reason: DriftReason
	/** The declared output this finding concerns; empty for a whole-set cause. */
	readonly path: string
	readonly message: string
}

export interface VerificationClean {
	readonly ok: true
	readonly declaredOutputs: readonly string[]
}

export interface VerificationDrift {
	readonly ok: false
	/** Stable cause; callers branch on this, never on a message. */
	readonly cause: 'generated_drift'
	readonly findings: readonly DriftFinding[]
}

export type VerificationResult = VerificationClean | VerificationDrift

/**
 * Renders the complete set in memory.
 *
 * Nothing touches the filesystem until every emitter has succeeded, so an
 * emitter failure cannot leave a partial set anywhere.
 */
function renderArtifactSet(
	ir: SpecificationIr,
	digest: SpecificationDigest,
	emitters: readonly ArtifactEmitter[],
):
	| { readonly ok: true; readonly artifacts: Map<string, string> }
	| GenerationFailure {
	const artifacts = new Map<string, string>()

	for (const emitter of emitters) {
		let emitted: ReadonlyMap<string, string>
		try {
			emitted = emitter.emit(ir, digest)
		} catch (error) {
			return {
				ok: false,
				cause: 'generation_emitter_failure',
				message: `emitter "${emitter.name}" failed: ${describe(error)}`,
			}
		}

		for (const [path, contents] of emitted) {
			// One declared path has exactly one owner: a silent overwrite would
			// make the winning emitter depend on registry order.
			if (artifacts.has(path))
				return {
					ok: false,
					cause: 'generation_emitter_failure',
					message: `emitter "${emitter.name}" re-declares the output "${path}"`,
				}
			if (!isSafeRelativePath(path))
				return {
					ok: false,
					cause: 'generation_emitter_failure',
					message: `emitter "${emitter.name}" declared the unsafe output path "${path}"`,
				}
			artifacts.set(path, contents)
		}
	}

	// The manifest names the complete set including itself, so it is built last.
	if (artifacts.has(PROVENANCE_MANIFEST_PATH))
		return {
			ok: false,
			cause: 'generation_emitter_failure',
			message: `an emitter re-declares the provenance manifest "${PROVENANCE_MANIFEST_PATH}"`,
		}
	const declared = [...artifacts.keys(), PROVENANCE_MANIFEST_PATH].sort()
	artifacts.set(
		PROVENANCE_MANIFEST_PATH,
		buildProvenanceManifest(ir, digest, declared),
	)

	return { ok: true, artifacts }
}

/**
 * Refuses any path that could write outside the output directory or depend on
 * platform path separators.
 */
function isSafeRelativePath(path: string): boolean {
	if (path === '' || path.startsWith('/') || path.includes('\\')) return false
	if (/^[A-Za-z]:/.test(path)) return false
	return !path
		.split('/')
		.some((part) => part === '' || part === '.' || part === '..')
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Writes a fully rendered set into a directory that is assumed to be empty. */
async function writeArtifacts(
	dir: string,
	artifacts: ReadonlyMap<string, string>,
): Promise<void> {
	for (const [path, contents] of artifacts) {
		const absolute = join(dir, ...path.split('/'))
		await mkdir(dirname(absolute), { recursive: true })
		await Bun.write(absolute, contents)
	}
}

/**
 * Writes the complete set as one unit.
 *
 * The set is staged in a sibling directory and moved into place, so the output
 * directory never holds a half-written set: readers see the old set or the new
 * one. Staging is a sibling rather than a system temp dir so the final move
 * stays on one filesystem and is therefore atomic.
 */
async function replaceArtifactSet(
	outputDir: string,
	artifacts: ReadonlyMap<string, string>,
	declaredOutputs: readonly string[],
): Promise<GenerationFailure | undefined> {
	const parent = dirname(outputDir)
	let staging: string | undefined
	try {
		await mkdir(parent, { recursive: true })
		staging = await mkdtemp(join(parent, '.asmg-staging-'))
		await writeArtifacts(staging, artifacts)

		await mkdir(outputDir, { recursive: true })
		// Remove only what the previous set declared. Handwritten Extensions,
		// fixtures and proof artifacts that share the directory must survive an
		// intentional regeneration untouched.
		await removeDeclaredOutputs(outputDir, declaredOutputs)

		for (const path of artifacts.keys()) {
			const target = join(outputDir, ...path.split('/'))
			await mkdir(dirname(target), { recursive: true })
			await rename(join(staging, ...path.split('/')), target)
		}
		return undefined
	} catch (error) {
		return {
			ok: false,
			cause: 'generation_write_failure',
			message: `could not replace the artifact set: ${describe(error)}`,
		}
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true })
	}
}

/** Removes exactly the named relative paths, and no directory that still holds other files. */
async function removeDeclaredOutputs(
	dir: string,
	declaredOutputs: readonly string[],
): Promise<void> {
	for (const path of declaredOutputs) {
		await rm(join(dir, ...path.split('/')), { force: true })
	}
}

/** Reads the declared output set of the manifest already on disk, if any. */
async function readExistingManifest(outputDir: string): Promise<
	| {
			readonly present: true
			readonly digest: string
			readonly declaredOutputs: readonly string[]
	  }
	| { readonly present: false }
> {
	const file = Bun.file(join(outputDir, PROVENANCE_MANIFEST_PATH))
	if (!(await file.exists())) return { present: false }
	try {
		const manifest = JSON.parse(await file.text()) as {
			specification_digest?: unknown
			declared_outputs?: unknown
		}
		const outputs = Array.isArray(manifest.declared_outputs)
			? manifest.declared_outputs.filter(
					(entry): entry is string => typeof entry === 'string',
				)
			: []
		return {
			present: true,
			digest:
				typeof manifest.specification_digest === 'string'
					? manifest.specification_digest
					: '',
			declaredOutputs: outputs,
		}
	} catch {
		// An unparsable manifest still declares nothing reliably; treat it as
		// present with no usable digest so verification reports it as drift.
		return { present: true, digest: '', declaredOutputs: [] }
	}
}

/**
 * Writes one complete Generated Artifact Set plus its provenance manifest.
 *
 * Fail-closed: if any emitter fails, nothing is written at all. If the write
 * itself fails, the staged set is discarded rather than partially applied.
 */
export async function generateArtifactSet(
	ir: SpecificationIr,
	digest: SpecificationDigest,
	options: GenerationOptions,
): Promise<GenerationResult> {
	const emitters = options.emitters ?? DEFAULT_EMITTERS
	const rendered = renderArtifactSet(ir, digest, emitters)
	if (!rendered.ok) return rendered

	const declaredOutputs = [...rendered.artifacts.keys()].sort()
	// Replace whatever the directory already declared, so a stale set's
	// artifacts cannot survive alongside the new one.
	const existing = await readExistingManifest(options.outputDir)
	const supersededOutputs = existing.present
		? [...new Set([...existing.declaredOutputs, ...declaredOutputs])]
		: declaredOutputs

	const failure = await replaceArtifactSet(
		options.outputDir,
		rendered.artifacts,
		supersededOutputs,
	)
	if (failure) return failure

	return {
		ok: true,
		declaredOutputs,
		specificationDigest: digest.specificationDigest,
	}
}

/**
 * Intentional regeneration: replaces the complete Generated Artifact Set as
 * one unit.
 *
 * Deliberately a separate verb from verification. A check that could repair
 * what it found would hide drift instead of reporting it, so the repair is
 * always an explicit, separate act.
 */
export async function regenerateArtifactSet(
	ir: SpecificationIr,
	digest: SpecificationDigest,
	options: GenerationOptions,
): Promise<GenerationResult> {
	return await generateArtifactSet(ir, digest, options)
}

/** Lists every file under a directory as forward-slashed relative paths. */
async function listFiles(dir: string): Promise<string[]> {
	const found: string[] = []
	async function walk(current: string, prefix: string): Promise<void> {
		let entries: Dirent[]
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (entry.isDirectory()) await walk(join(current, entry.name), relative)
			else found.push(relative)
		}
	}
	await walk(dir, '')
	return found.sort()
}

/**
 * Read-only drift verification.
 *
 * Regenerates the complete output set in an isolated temp directory and
 * compares every declared artifact against the working tree. The working tree
 * is only ever read: no verb on this path writes, moves or removes anything
 * under `outputDir`, so a failing verification leaves the tree byte-identical.
 */
export async function verifyArtifactSet(
	ir: SpecificationIr,
	digest: SpecificationDigest,
	options: GenerationOptions,
): Promise<VerificationResult> {
	const emitters = options.emitters ?? DEFAULT_EMITTERS
	const rendered = renderArtifactSet(ir, digest, emitters)
	if (!rendered.ok)
		return {
			ok: false,
			cause: 'generated_drift',
			findings: [
				{
					reason: 'stale_artifact_set',
					path: '',
					message: `the artifact set could not be regenerated for comparison: ${rendered.message}`,
				},
			],
		}

	// Isolation: the regeneration lands in a system temp directory, never in
	// the working tree, and is removed before this function returns.
	const isolated = await mkdtemp(join(tmpdir(), 'asmg-verify-'))
	try {
		await writeArtifacts(isolated, rendered.artifacts)

		const expected = new Map<string, string>()
		for (const path of await listFiles(isolated)) {
			expected.set(
				path,
				await Bun.file(join(isolated, ...path.split('/'))).text(),
			)
		}

		const findings: DriftFinding[] = []
		const declaredOutputs = [...expected.keys()].sort()

		const manifest = await readExistingManifest(options.outputDir)
		if (!manifest.present)
			findings.push({
				reason: 'missing_manifest',
				path: PROVENANCE_MANIFEST_PATH,
				message:
					'no provenance manifest: the artifact set on disk has no admitted origin',
			})
		else if (manifest.digest !== digest.specificationDigest)
			findings.push({
				reason: 'stale_artifact_set',
				path: PROVENANCE_MANIFEST_PATH,
				message: `the manifest records specification digest ${manifest.digest || '(unreadable)'}, but the admitted input digests to ${digest.specificationDigest}`,
			})

		// Only the declared output set is inspected. Files the set never named
		// are Handwritten Extensions or proof artifacts, not unexpected output.
		const onDisk = new Set(await listFiles(options.outputDir))
		const claimed = new Set([
			...declaredOutputs,
			...(manifest.present ? manifest.declaredOutputs : []),
		])

		for (const path of declaredOutputs) {
			const absolute = join(options.outputDir, ...path.split('/'))
			if (!onDisk.has(path)) {
				findings.push({
					reason: 'missing_artifact',
					path,
					message: `declared artifact "${path}" is absent from the working tree`,
				})
				continue
			}
			const actual = await Bun.file(absolute).text()
			if (actual !== expected.get(path))
				findings.push({
					reason: 'modified_artifact',
					path,
					message: `declared artifact "${path}" differs from its regeneration`,
				})
		}

		for (const path of [...claimed].sort()) {
			if (!expected.has(path) && onDisk.has(path))
				findings.push({
					reason: 'unexpected_artifact',
					path,
					message: `"${path}" is declared by the manifest on disk but is not part of the regenerated set`,
				})
		}

		if (findings.length > 0)
			return { ok: false, cause: 'generated_drift', findings }
		return { ok: true, declaredOutputs }
	} finally {
		await rm(isolated, { recursive: true, force: true })
	}
}
