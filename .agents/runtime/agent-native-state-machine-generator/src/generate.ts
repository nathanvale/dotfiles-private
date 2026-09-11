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
import {
	type ArtifactEmitter,
	buildProvenanceManifest,
	DEFAULT_EMITTERS,
	type EmissionResult,
	PROVENANCE_MANIFEST_PATH,
} from './artifact-set.ts'
import {
	GENERATOR_CONTRACT_VERSION,
	INPUT_SCHEMA_VERSION,
	type SpecificationDigest,
} from './canonical.ts'
import type { SpecificationIr } from './ir.ts'
import type { ArtifactRefusal } from './refusal.ts'
import {
	isRegisteredReaderVersion,
	registeredReaderFor,
} from './registered-readers.ts'

export interface GenerationOptions {
	/** Directory that holds the Generated Artifact Set. */
	readonly outputDir: string
	/** Defaults to the package registry; overridden in tests and by stage 3. */
	readonly emitters?: readonly ArtifactEmitter[]
}

/**
 * Sealed causes for a generation that produced nothing. Callers branch on
 * `cause`, never on `message`.
 *
 * Adding a cause is a Generator Contract change.
 */
export const GENERATION_FAILURE_CAUSES = [
	/** An emitter threw, or two emitters claimed the same declared path. */
	'generation_emitter_failure',
	/**
	 * An emitter refused to derive its artifacts. Distinct from
	 * `generation_emitter_failure`: nothing malfunctioned, the specification
	 * declares too little to derive a contract without inventing meaning. The
	 * sealed ArtifactRefusalCause list says which, and the repair is the
	 * specification rather than the generator.
	 */
	'generation_emit_refused',
	/** The set could not be written or replaced on disk. */
	'generation_write_failure',
	/** Regeneration found no existing set to replace. */
	'generation_no_existing_set',
	/**
	 * A new Generated Artifact Set was asked for from input on a superseded
	 * Input Schema Version. Founding one would change consumer meaning through
	 * an upgrade no product owner admitted, so the refusal names the Registered
	 * Migration route instead. Verifying or regenerating an existing set on
	 * that version stays supported: the Registered Reader owns it.
	 */
	'generation_superseded_input_schema',
	/**
	 * The compiled IR and the specification digest disagree about which
	 * version identity produced them.
	 *
	 * Distinct from `generation_superseded_input_schema`: that names input the
	 * generator can read but may not found a set from, while this names two
	 * identities a caller supplied together that cannot both be true. A set
	 * founded on them would carry an IR claiming one version and a provenance
	 * manifest recording another, and no consumer could tell which it was
	 * generated against.
	 */
	'generation_provenance_mismatch',
	/**
	 * The output directory already holds a Generated Artifact Set this
	 * compilation does not describe, or a provenance manifest that cannot be
	 * read at all.
	 *
	 * Distinct from the two version causes: those judge the input, while this
	 * judges what is already on disk. Replacing a set whose identity cannot be
	 * confirmed would overwrite another product's output, or a corrupt one, on
	 * the strength of a filename.
	 */
	'generation_foreign_existing_set',
	/**
	 * The provenance manifest in the output directory cannot be read.
	 *
	 * Split from `generation_foreign_existing_set` because the repairs are
	 * opposite: a corrupt manifest is repaired by deleting it and generating
	 * afresh, while a manifest recording another identity means the output
	 * directory is wrong. `subject` is the directory in both, so a caller
	 * branching on cause is the only way to tell them apart.
	 */
	'generation_unreadable_manifest',
	/**
	 * The provenance manifest declares an output path the set may not own: one
	 * that escapes the output directory, depends on platform separators, or
	 * repeats a path already declared.
	 *
	 * Distinct from `generation_foreign_existing_set`, which judges whose set
	 * is on disk. This judges the shape of a path a manifest asks the
	 * generator to write or delete, and the two repairs are unrelated: a
	 * foreign set means the output directory is wrong, while an unsafe
	 * declared output means the manifest is not one this generator wrote.
	 * `subject` is the offending path so a caller repairs it without parsing
	 * `message`.
	 */
	'generation_unsafe_declared_output',
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
	/**
	 * The refusal's named subject: the offending emitter's name, the contested
	 * path for a manifest collision, or the output directory for the
	 * filesystem causes. Branchable context beside `cause`; `message` stays
	 * prose.
	 */
	readonly subject: string
	readonly message: string
	/**
	 * The sealed refusals behind a `generation_emit_refused` cause, so a caller
	 * repairs the specification without parsing `message`. Empty for every other
	 * cause: nothing else in this file refuses on a derived artifact.
	 */
	readonly refusals: readonly ArtifactRefusal[]
}

export type GenerationResult = GenerationSuccess | GenerationFailure

/**
 * Sealed causes a Generated Artifact Set is refused as drifted. Each explains
 * one `generated_drift` refusal; callers branch on the cause, never on a
 * message.
 *
 * Adding a cause is a Generator Contract change.
 */
export const DRIFT_CAUSES = [
	/** A declared artifact is absent from the working tree. */
	'missing_artifact',
	/** The generator-owned output directory holds a file the set does not declare. */
	'unexpected_artifact',
	/** A declared artifact's bytes differ from its regeneration. */
	'modified_artifact',
	/** The manifest's digest no longer matches the admitted input. */
	'stale_artifact_set',
	/** No provenance manifest, so the set has no admitted origin at all. */
	'missing_manifest',
] as const

export type DriftCause = (typeof DRIFT_CAUSES)[number]

/**
 * One reason a Generated Artifact Set is refused as drifted.
 *
 * Follows the package's refusal shape: a sealed `cause` a caller branches on,
 * a `subject` naming what the cause concerns, and a `message` that explains
 * without carrying meaning a caller must parse. The cause vocabulary differs
 * from ArtifactRefusalCause because the two answer different questions - one
 * names why a set on disk disagrees with its regeneration, the other why a set
 * could not be derived at all - but the shape is the same so a caller reads
 * both refusals the same way.
 */
export interface DriftFinding {
	readonly cause: DriftCause
	/** The declared output this finding concerns; empty for a whole-set cause. */
	readonly subject: string
	readonly message: string
}

export interface VerificationClean {
	readonly ok: true
	readonly declaredOutputs: readonly string[]
}

/**
 * The sole sealed cause for a refused Generated Artifact Set. The literal is
 * fixed by the specification, so it is held here rather than spelled inline.
 *
 * Its concept name in CONTEXT.md is Generated Artifact Drift; the token stays
 * `generated_drift` because the specification fixes that exact string.
 *
 * Adding a cause is a Generator Contract change.
 */
export const VERIFICATION_FAILURE_CAUSES = ['generated_drift'] as const

export type VerificationFailureCause =
	(typeof VERIFICATION_FAILURE_CAUSES)[number]

const [DRIFT_CAUSE] = VERIFICATION_FAILURE_CAUSES

export interface VerificationDrift {
	readonly ok: false
	/** Stable cause; callers branch on this, never on a message. */
	readonly cause: VerificationFailureCause
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
		let emitted: EmissionResult
		try {
			emitted = emitter.emit(ir, digest)
		} catch (error) {
			return {
				ok: false,
				cause: 'generation_emitter_failure',
				subject: emitter.name,
				message: `emitter "${emitter.name}" failed: ${describe(error)}`,
				refusals: [],
			}
		}

		// A refusal stops the whole set here, before any path is claimed and long
		// before anything reaches the filesystem. A Generated Artifact Set is
		// replaced as one unit, so a set missing a refused contract has no valid
		// consumer.
		if (!emitted.ok)
			return {
				ok: false,
				cause: 'generation_emit_refused',
				subject: emitter.name,
				message: `emitter "${emitter.name}" refused to derive its artifacts: ${emitted.refusals
					.map((refusal) => `${refusal.cause} (${refusal.subject})`)
					.join(', ')}`,
				refusals: emitted.refusals,
			}

		for (const [path, contents] of emitted.artifacts) {
			// One declared path has exactly one owner: a silent overwrite would
			// make the winning emitter depend on registry order.
			if (artifacts.has(path))
				return {
					ok: false,
					cause: 'generation_emitter_failure',
					subject: emitter.name,
					message: `emitter "${emitter.name}" re-declares the output "${path}"`,
					refusals: [],
				}
			if (!isSafeRelativePath(path))
				return {
					ok: false,
					cause: 'generation_emitter_failure',
					subject: emitter.name,
					message: `emitter "${emitter.name}" declared the unsafe output path "${path}"`,
					refusals: [],
				}
			artifacts.set(path, contents)
		}
	}

	// The manifest names the complete set including itself, so it is built last.
	if (artifacts.has(PROVENANCE_MANIFEST_PATH))
		return {
			ok: false,
			cause: 'generation_emitter_failure',
			subject: PROVENANCE_MANIFEST_PATH,
			message: `an emitter re-declares the provenance manifest "${PROVENANCE_MANIFEST_PATH}"`,
			refusals: [],
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

/**
 * The first declared output a manifest may not own, or undefined.
 *
 * Duplicates count: two entries naming one path make the set's own declared
 * list disagree with itself about what it contains, and a manifest this
 * generator wrote never does that. Reporting the first offender rather than
 * all of them keeps `subject` a single named path, which is what a caller
 * branches to.
 */
function firstUnsafeDeclaredOutput(
	declaredOutputs: readonly string[],
): string | undefined {
	const seen = new Set<string>()
	for (const path of declaredOutputs) {
		if (!isSafeRelativePath(path)) return path
		if (seen.has(path)) return path
		seen.add(path)
	}
	return undefined
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
		const absolute = resolveOutput(dir, path)
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
/**
 * Removes staging siblings stranded by an interrupted earlier run. An
 * abnormal exit between mkdtemp and the finally leaves `.asmg-staging-*`
 * inside the consumer's tree, and survivors accumulate across runs
 * (witnessed under SIGKILL, three of three stage-4 probe runs). Deleting
 * only names carrying the staging prefix is what keeps the sweep from
 * over-deleting; concurrent generation into one output directory is
 * already outside the package's single-writer contract.
 */
async function sweepStaleStagingSiblings(parent: string): Promise<void> {
	for (const entry of await readdir(parent)) {
		if (entry.startsWith('.asmg-staging-')) {
			await rm(join(parent, entry), { recursive: true, force: true })
		}
	}
}

async function replaceArtifactSet(
	outputDir: string,
	artifacts: ReadonlyMap<string, string>,
	supersededOutputs: readonly string[],
): Promise<GenerationFailure | undefined> {
	const parent = dirname(outputDir)
	let staging: string | undefined
	try {
		await mkdir(parent, { recursive: true })
		await sweepStaleStagingSiblings(parent)
		staging = await mkdtemp(join(parent, '.asmg-staging-'))
		await writeArtifacts(staging, artifacts)

		await mkdir(outputDir, { recursive: true })

		// Move the new set into place BEFORE removing anything.
		//
		// Removing first would mean a rename that cannot complete — a target
		// name already occupied by a directory, a permission failure — leaves
		// neither the old set nor the new one on disk. Renaming first makes
		// each declared path go straight from its old bytes to its new bytes,
		// so a failure part-way through leaves a set that is still complete,
		// just partly superseded, rather than a hole where an artifact was.
		for (const path of artifacts.keys()) {
			const target = resolveOutput(outputDir, path)
			await mkdir(dirname(target), { recursive: true })
			await rename(resolveOutput(staging, path), target)
		}

		// Only now remove what the previous set declared and the new one does
		// not: a retired artifact must not linger beside the set that replaced
		// it. Paths the new set just wrote are excluded, or this would delete
		// the artifacts written above.
		await removeSupersededOutputs(
			outputDir,
			supersededOutputs.filter((path) => !artifacts.has(path)),
		)
		return undefined
	} catch (error) {
		return {
			ok: false,
			cause: 'generation_write_failure',
			subject: outputDir,
			message: `could not replace the artifact set: ${describe(error)}`,
			refusals: [],
		}
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true })
	}
}

/** Resolves one forward-slashed declared output path against a directory. */
function resolveOutput(dir: string, path: string): string {
	return join(dir, ...path.split('/'))
}

/**
 * Removes exactly the named relative paths, and nothing else.
 *
 * Re-checks every path even though the manifest read already refused an
 * unsafe one. This is not a guard for a structurally impossible state, which
 * the package standards forbid: the state is reachable today by editing one
 * caller. The paths originate in untrusted input, and this is the only place
 * in the package that deletes a caller-named file, so the check belongs at
 * the boundary that performs the irreversible act as well as at the one that
 * admits the input. A future refactor that reorders or drops the earlier gate
 * then cannot re-open the deletion. An unsafe path here is a defect upstream,
 * so it throws rather than refusing quietly: `replaceArtifactSet` turns it
 * into `generation_write_failure`, and the set on disk is already complete
 * because the rename happened first.
 */
async function removeSupersededOutputs(
	dir: string,
	supersededOutputs: readonly string[],
): Promise<void> {
	for (const path of supersededOutputs) {
		if (!isSafeRelativePath(path))
			throw new Error(
				`refused to remove the superseded output ${JSON.stringify(path)}: it escapes the generated output directory`,
			)
		await rm(resolveOutput(dir, path), { force: true })
	}
}

/**
 * Reads the provenance the manifest on disk records, if any.
 *
 * Carries both version identities, not only the digest and the output list: a
 * caller deciding whether an existing set may be replaced has to know which
 * specification and which generator contract produced it. Presence alone
 * says a file exists, which is not the same claim.
 *
 * `readable` distinguishes a manifest that parsed from one that did not.
 * Verification treats an unparsable manifest as drift, which is right, but
 * generation must not read it as a set worth replacing, so the two callers
 * branch on this rather than sharing one lenient answer.
 *
 * `unsafeDeclaredOutput` names the first declared path this manifest may not
 * own. The manifest is untrusted input - any process can write one, and its
 * digest is printed in every generated header - and its declared outputs
 * reach both a write and a delete. Validating here, where the paths enter the
 * program, is what makes the Generated Artifact Root boundary an invariant of
 * the read rather than a consequence of which gate happens to run first.
 */
async function readExistingManifest(outputDir: string): Promise<
	| {
			readonly present: true
			readonly readable: boolean
			readonly digest: string
			readonly inputSchemaVersion: string
			readonly generatorContractVersion: string
			readonly declaredOutputs: readonly string[]
			readonly unsafeDeclaredOutput: string | undefined
	  }
	| { readonly present: false }
> {
	const file = Bun.file(join(outputDir, PROVENANCE_MANIFEST_PATH))
	if (!(await file.exists())) return { present: false }
	try {
		const manifest = JSON.parse(await file.text()) as {
			specification_digest?: unknown
			input_schema_version?: unknown
			generator_contract_version?: unknown
			declared_outputs?: unknown
		}
		const outputs = Array.isArray(manifest.declared_outputs)
			? manifest.declared_outputs.filter(
					(entry): entry is string => typeof entry === 'string',
				)
			: []
		const text = (value: unknown): string =>
			typeof value === 'string' ? value : ''
		return {
			present: true,
			readable: true,
			digest: text(manifest.specification_digest),
			inputSchemaVersion: text(manifest.input_schema_version),
			generatorContractVersion: text(manifest.generator_contract_version),
			declaredOutputs: outputs,
			unsafeDeclaredOutput: firstUnsafeDeclaredOutput(outputs),
		}
	} catch {
		// An unparsable manifest declares nothing reliably. Verification still
		// sees it as present so it reports drift; generation reads `readable`
		// and refuses rather than replacing a set it cannot identify.
		return {
			present: true,
			readable: false,
			digest: '',
			inputSchemaVersion: '',
			generatorContractVersion: '',
			declaredOutputs: [],
			unsafeDeclaredOutput: undefined,
		}
	}
}

/**
 * Whether every output a manifest declares is actually on disk.
 *
 * A manifest declaring outputs that do not exist describes a set that was
 * never materialised, or one since removed. Either way there is nothing to
 * replace, so the caller is founding rather than repairing.
 *
 * Answers only the materialisation question. It used to return `false` for an
 * unsafe path too, which read as an answer to this question and was in fact
 * the only thing keeping an escaping path out of the delete call: a
 * misleading cause, and protection that would have vanished the moment the
 * gates were reordered. Path safety is now decided at the manifest read, so
 * this states that as a precondition rather than re-deciding it.
 */
async function allOutputsPresent(
	outputDir: string,
	declaredOutputs: readonly string[],
): Promise<boolean> {
	for (const path of declaredOutputs) {
		if (!isSafeRelativePath(path))
			throw new Error(
				`unsafe declared output ${JSON.stringify(path)} reached the materialisation check`,
			)
		if (!(await Bun.file(join(outputDir, path)).exists())) return false
	}
	return true
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
	return await writeArtifactSet(ir, digest, options, false)
}

type ExistingManifest = Awaited<ReturnType<typeof readExistingManifest>>

interface ProvenanceExpectation {
	readonly inputSchemaVersion: string
	readonly generatorContractVersion: string
}

/**
 * The IR and the digest must agree about their own identity.
 *
 * `deriveArtifactSet` and the manifest read the two separately, so a caller
 * that amends one and keeps the other would publish a set whose declared
 * version and recorded provenance disagree. Checking one identity and
 * trusting the other is how a fail-closed gate ends up trusting an input
 * nothing cross-checks.
 */
function checkProvenanceIdentity(
	ir: SpecificationIr,
	digest: SpecificationDigest,
):
	| { readonly expectation: ProvenanceExpectation }
	| { readonly failure: GenerationFailure } {
	const irVersion = ir.specMeta.inputSchemaVersion
	const reader = registeredReaderFor(irVersion)
	const expectedInputSchemaVersion = reader?.frozenEnvelopeVersion ?? irVersion
	const expectedGeneratorContractVersion =
		reader?.frozenGeneratorContractVersion ?? GENERATOR_CONTRACT_VERSION
	if (
		digest.inputSchemaVersion !== expectedInputSchemaVersion ||
		digest.generatorContractVersion !== expectedGeneratorContractVersion
	) {
		return {
			failure: {
				ok: false,
				cause: 'generation_provenance_mismatch',
				subject: irVersion,
				message: `The compiled specification declares Input Schema Version ${JSON.stringify(irVersion)}, whose digest envelope names ${JSON.stringify(expectedInputSchemaVersion)} and Generator Contract Version ${JSON.stringify(expectedGeneratorContractVersion)}, but the supplied digest names ${JSON.stringify(digest.inputSchemaVersion)} and ${JSON.stringify(digest.generatorContractVersion)}. A Generated Artifact Set cannot record two identities.`,
				refusals: [],
			},
		}
	}
	return {
		expectation: {
			inputSchemaVersion: expectedInputSchemaVersion,
			generatorContractVersion: expectedGeneratorContractVersion,
		},
	}
}

/**
 * Before every other judgement about the existing set, and before any write
 * or delete: a declared output this set may not own refuses on its own
 * cause.
 *
 * It runs first because it is the only gate that judges the paths
 * themselves. Leaving it to a later gate is what made the boundary hold by
 * accident: the materialisation check rejects an escaping path as "not
 * present", which reports a misleading cause and stops protecting anything
 * the moment the gates are reordered.
 */
function checkUnsafeDeclaredOutput(
	existing: ExistingManifest,
): GenerationFailure | undefined {
	if (!existing.present || existing.unsafeDeclaredOutput === undefined)
		return undefined
	return {
		ok: false,
		cause: 'generation_unsafe_declared_output',
		subject: existing.unsafeDeclaredOutput,
		message: `The provenance manifest declares the output ${JSON.stringify(existing.unsafeDeclaredOutput)}, which escapes the generated output directory or repeats another declared output. A Generated Artifact Set owns only forward-slashed relative paths inside its own directory, so this manifest was not written by this generator.`,
		refusals: [],
	}
}

/**
 * Identity AND materialisation. A manifest is a claim about a set, not the
 * set: its digest is printed in every generated header, so anyone can write
 * one. Requiring the declared outputs to exist means "this set is already
 * here" is proven by the artifacts rather than asserted by a file that names
 * them.
 */
async function resolveReplacesOwnSet(
	outputDir: string,
	existing: ExistingManifest,
	digest: SpecificationDigest,
	expectation: ProvenanceExpectation,
): Promise<boolean> {
	const identityMatches =
		existing.present &&
		existing.readable &&
		existing.digest === digest.specificationDigest &&
		existing.inputSchemaVersion === expectation.inputSchemaVersion &&
		existing.generatorContractVersion === expectation.generatorContractVersion
	return (
		identityMatches &&
		existing.declaredOutputs.length > 0 &&
		(await allOutputsPresent(outputDir, existing.declaredOutputs))
	)
}

/**
 * Identity is required whenever this compilation did not found what is
 * already there. Repair does not waive it: `repairing` narrows what a
 * caller may do to a set it already owns, and never widens it, so proving
 * the set is not this compilation's is enough on its own.
 */
function checkUnreadableManifest(
	existing: ExistingManifest,
	outputDir: string,
): GenerationFailure | undefined {
	if (!existing.present || existing.readable) return undefined
	return {
		ok: false,
		cause: 'generation_unreadable_manifest',
		subject: outputDir,
		message:
			'The provenance manifest in the output directory cannot be read, so the set it declares cannot be identified. Remove it and generate afresh.',
		refusals: [],
	}
}

function checkForeignExistingSet(
	existing: ExistingManifest,
	replacesOwnSet: boolean,
	outputDir: string,
): GenerationFailure | undefined {
	if (!existing.present || replacesOwnSet) return undefined
	return {
		ok: false,
		cause: 'generation_foreign_existing_set',
		subject: outputDir,
		message:
			'The Generated Artifact Set in the output directory records a different specification or generator identity, or declares outputs that are not present, so this compilation cannot replace it. Check the output directory.',
		refusals: [],
	}
}

/**
 * Founding a NEW set from input the Registered Reader owns would give a
 * consumer v2 meaning it never admitted. The route out is the Registered
 * Migration, which produces an isolated candidate the product owner admits
 * separately.
 *
 * Replacing a set that already exists is not founding one. The admitted
 * pilot's set is pinned on a superseded version, so verifying and
 * regenerating it must keep working; only the first write is refused.
 */
function checkSupersededInputSchema(
	repairing: boolean,
	replacesOwnSet: boolean,
	declaredVersion: string,
): GenerationFailure | undefined {
	if (repairing || replacesOwnSet || !isRegisteredReaderVersion(declaredVersion))
		return undefined
	return {
		ok: false,
		cause: 'generation_superseded_input_schema',
		subject: declaredVersion,
		message: `Input Schema Version ${JSON.stringify(declaredVersion)} is read-only. A new Generated Artifact Set is founded from version ${JSON.stringify(INPUT_SCHEMA_VERSION)}, so migrate the candidate and admit the result before generating.`,
		refusals: [],
	}
}

/**
 * The shared writer behind both verbs.
 *
 * `repairing` is internal and never caller-supplied. It says the caller is
 * restoring a set this compilation already owns, which is why a drifted
 * manifest may be rewritten: on a set whose identity is otherwise proved, a
 * corrupt manifest is drift like any other artifact.
 *
 * It is earned by proven identity, never by presence. A superseded version
 * may repair only a set whose manifest matches its reader evidence, because
 * "an existing legacy set" is a claim about which set is there, and a
 * directory that merely contains a file with the manifest's name proves
 * nothing about that.
 */
async function writeArtifactSet(
	ir: SpecificationIr,
	digest: SpecificationDigest,
	options: GenerationOptions,
	repairing: boolean,
): Promise<GenerationResult> {
	// Before rendering and before any write: the IR and the digest must agree
	// about their own identity.
	const identity = checkProvenanceIdentity(ir, digest)
	if ('failure' in identity) return identity.failure

	const existing = await readExistingManifest(options.outputDir)
	// Presence is not provenance: a corrupt manifest, or one belonging to
	// another product or another specification, says nothing about whether
	// this legacy version may replace it.
	const declaredVersion = ir.specMeta.inputSchemaVersion

	const unsafeOutputFailure = checkUnsafeDeclaredOutput(existing)
	if (unsafeOutputFailure) return unsafeOutputFailure

	const replacesOwnSet = await resolveReplacesOwnSet(
		options.outputDir,
		existing,
		digest,
		identity.expectation,
	)

	const unreadableFailure = checkUnreadableManifest(existing, options.outputDir)
	if (unreadableFailure) return unreadableFailure

	const foreignSetFailure = checkForeignExistingSet(
		existing,
		replacesOwnSet,
		options.outputDir,
	)
	if (foreignSetFailure) return foreignSetFailure

	const supersededVersionFailure = checkSupersededInputSchema(
		repairing,
		replacesOwnSet,
		declaredVersion,
	)
	if (supersededVersionFailure) return supersededVersionFailure

	const emitters = options.emitters ?? DEFAULT_EMITTERS
	const rendered = renderArtifactSet(ir, digest, emitters)
	if (!rendered.ok) return rendered

	const declaredOutputs = [...rendered.artifacts.keys()].sort()
	// Replace whatever the directory already declared, so a stale set's
	// artifacts cannot survive alongside the new one.
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
	// Regeneration is intentional replacement of a set that exists. A target
	// with no provenance manifest has no set to replace, and treating it as an
	// empty one would let a mistyped output directory quietly create a second
	// Generated Artifact Set somewhere nobody is verifying. Creating a fresh
	// target is what generateArtifactSet is for.
	const existing = await readExistingManifest(options.outputDir)
	if (!existing.present)
		return {
			ok: false,
			cause: 'generation_no_existing_set',
			subject: options.outputDir,
			message:
				'no provenance manifest in the output directory: regeneration replaces an existing Generated Artifact Set, so use generation to create one',
			refusals: [],
		}

	// A set exists. Whether this compilation may replace it is decided by the
	// identity checks in `writeArtifactSet`, which repair does not waive: the
	// manifest still has to name this specification and these version
	// identities. Only a current-version set that this compilation owns can
	// have its own drifted manifest rewritten.
	return await writeArtifactSet(ir, digest, options, true)
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
			cause: DRIFT_CAUSE,
			findings: [
				{
					cause: 'stale_artifact_set',
					subject: '',
					message: `the artifact set could not be regenerated for comparison: ${rendered.message}`,
				},
			],
		}

	// Isolation: the regeneration lands in a system temp directory, never in
	// the working tree, and is removed before this function returns.
	//
	// The round-trip through the filesystem is deliberate, not ceremony.
	// Comparing rendered strings against file bytes would skip whatever the
	// filesystem does to content on the way through, and would not prove the
	// rendered set can exist as a directory tree at all — which is exactly
	// what generation will later attempt. Materialising here means
	// verification exercises the same path generation does, and it matches
	// the specification's "regenerating the complete output set in isolation"
	// literally. The cost is one temp directory per verification.
	const isolated = await mkdtemp(join(tmpdir(), 'asmg-verify-'))
	try {
		await writeArtifacts(isolated, rendered.artifacts)

		const expected = new Map<string, string>()
		for (const path of await listFiles(isolated)) {
			expected.set(path, await Bun.file(resolveOutput(isolated, path)).text())
		}

		const findings: DriftFinding[] = []
		const declaredOutputs = [...expected.keys()].sort()

		const manifest = await readExistingManifest(options.outputDir)
		if (!manifest.present)
			findings.push({
				cause: 'missing_manifest',
				subject: PROVENANCE_MANIFEST_PATH,
				message:
					'no provenance manifest: the artifact set on disk has no admitted origin',
			})
		else if (manifest.digest !== digest.specificationDigest)
			findings.push({
				cause: 'stale_artifact_set',
				subject: PROVENANCE_MANIFEST_PATH,
				message: `the manifest records specification digest ${manifest.digest || '(unreadable)'}, but the admitted input digests to ${digest.specificationDigest}`,
			})

		// The output directory is wholly generator-owned: every file inside it
		// belongs to the Generated Artifact Set. Handwritten Extensions, the
		// Extension Registry, Real Process Fixtures and Proof Adapters live
		// outside this directory, which is what lets them survive regeneration
		// without the generator having to guess from a naming convention which
		// files are safe to replace.
		//
		// So anything on disk that the regenerated set does not declare is
		// unexpected, whether or not the manifest ever named it. A stale
		// artifact left behind by a retired emitter and a hand-dropped file are
		// the same refusal: generated output is never a second authority.
		const onDisk = new Set(await listFiles(options.outputDir))

		for (const path of declaredOutputs) {
			const absolute = resolveOutput(options.outputDir, path)
			if (!onDisk.has(path)) {
				findings.push({
					cause: 'missing_artifact',
					subject: path,
					message: `declared artifact "${path}" is absent from the working tree`,
				})
				continue
			}
			const actual = await Bun.file(absolute).text()
			if (actual !== expected.get(path))
				findings.push({
					cause: 'modified_artifact',
					subject: path,
					message: `declared artifact "${path}" differs from its regeneration`,
				})
		}

		for (const path of [...onDisk].sort()) {
			if (!expected.has(path))
				findings.push({
					cause: 'unexpected_artifact',
					subject: path,
					message: `"${path}" is present in the generated output directory but is not part of the regenerated set`,
				})
		}

		if (findings.length > 0) return { ok: false, cause: DRIFT_CAUSE, findings }
		return { ok: true, declaredOutputs }
	} finally {
		await rm(isolated, { recursive: true, force: true })
	}
}
