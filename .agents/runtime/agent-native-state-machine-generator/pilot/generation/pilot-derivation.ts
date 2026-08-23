/**
 * The pilot's emitter registry and derivation options.
 *
 * The generation pipeline's emitter seam (`GenerationOptions.emitters`) is the
 * designed override point, so the pilot supplies one emitter of its own
 * instead of touching the package registry. It is one emitter, not one per
 * module, for the same reason the package registry is: the whole Generated
 * Artifact Set derives together and refuses together, so no module can
 * publish while a sibling refuses.
 *
 * Emission is not Specification Admission: the pilot candidate stays an
 * unadmitted draft until the product owner admits it explicitly.
 */
import type { ArtifactEmitter, DerivationOptions } from '../../src/index.ts'
import { deriveArtifactSet } from '../../src/index.ts'
import { renderProjectionComposer } from './render-projection-composer.ts'

/**
 * The generated catalog imports its discovery projection from the Handwritten
 * Extension beside the Generated Artifact Root, never from inside it: files
 * inside the root are wholly generator-owned and replaced as one unit.
 */
export const PILOT_DERIVATION_OPTIONS: DerivationOptions = {
	// The pilot's real front door, package-relative. The candidate is on a
	// superseded Input Schema Version and declares no entry, so the consumer
	// that owns the file names it.
	entryScript: 'pilot/cli.ts',
	discoveryImport: {
		symbol: 'projectVaultGitReimaginedCommandDiscoveryTree',
		from: '../../extensions/command-discovery.ts',
	},
}

/** Declared path of the generated Projection Composer selection module. */
export const PILOT_COMPOSER_PATH = 'src/projection-composer.ts'

export const PILOT_EMITTERS: readonly ArtifactEmitter[] = [
	{
		name: 'vault-git-reimagined-pilot-artifact-set',
		emit: (ir, digest) => {
			const derived = deriveArtifactSet(
				ir,
				digest.specificationDigest,
				PILOT_DERIVATION_OPTIONS,
			)
			if (!derived.ok) return { ok: false, refusals: derived.refusals }
			const artifacts = new Map(
				derived.modules.map((module) => [module.path, module.contents]),
			)
			artifacts.set(
				PILOT_COMPOSER_PATH,
				renderProjectionComposer({
					ir,
					digest: digest.specificationDigest,
					rows: derived.expectations,
				}),
			)
			return { ok: true, artifacts }
		},
	},
]
