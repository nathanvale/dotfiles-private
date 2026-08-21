import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
// buildProvenanceManifest is internal on purpose: nothing outside the package
// may assemble a manifest. This seed reaches past the front door because it is
// impersonating the generator's own historical write, not calling the package
// as a consumer would.
import { buildProvenanceManifest } from '../../src/artifact-set.ts'
import {
	DEFAULT_EMITTERS,
	PROVENANCE_MANIFEST_PATH,
	type SpecificationDigest,
	type SpecificationIr,
} from '../../src/index.ts'

/**
 * Test-only seeding of a Generated Artifact Set that already exists on a
 * superseded Input Schema Version.
 *
 * Deliberately NOT in src and deliberately not reachable from the front door.
 * The public generation seam refuses to found a set from input the Registered
 * Reader owns, and that refusal has no caller-facing override, so the only
 * honest way to test "a legacy set that is already there" is to put one there
 * the way history did: write the emitters' own output beside the same
 * provenance manifest the generator builds.
 *
 * Assembly mirrors `renderArtifactSet`: the manifest declares itself among the
 * outputs, so a set seeded here is byte-identical to one the generator wrote
 * before the boundary existed. It supplies no expected results; every
 * assertion belongs to the calling test.
 */
export async function seedLegacyArtifactSet(
	outputDir: string,
	ir: SpecificationIr,
	digest: SpecificationDigest,
): Promise<readonly string[]> {
	const artifacts = new Map<string, string>()
	for (const emitter of DEFAULT_EMITTERS) {
		const emission = emitter.emit(ir, digest)
		if (!emission.ok)
			throw new Error(
				`legacy seed could not emit ${emitter.name}: ${emission.refusals
					.map((refusal) => refusal.cause)
					.join(', ')}`,
			)
		for (const [path, contents] of emission.artifacts) {
			artifacts.set(path, contents)
		}
	}

	const declaredOutputs = [...artifacts.keys(), PROVENANCE_MANIFEST_PATH].sort()
	artifacts.set(
		PROVENANCE_MANIFEST_PATH,
		buildProvenanceManifest(ir, digest, declaredOutputs),
	)

	for (const [path, contents] of artifacts) {
		const absolute = join(outputDir, path)
		await mkdir(dirname(absolute), { recursive: true })
		await writeFile(absolute, contents, 'utf8')
	}

	return declaredOutputs
}
