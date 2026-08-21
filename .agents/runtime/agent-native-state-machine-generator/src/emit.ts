/**
 * The artifact emitter seam.
 *
 * Every declared output in a Generated Artifact Set comes from exactly one
 * emitter. Stage 2 owns the mechanics — how a set is written, verified and
 * replaced — while each emitter owns the bytes of its own artifacts. Adding a
 * generated contract is therefore adding an emitter to the registry below;
 * it never changes how sets are written or compared.
 *
 * Emitters are pure: identical inputs must produce identical bytes. Anything
 * that varies per run — a clock, a random value, an absolute path — would
 * make regeneration-and-compare report drift that is not drift, and
 * regeneration-and-compare is the only drift oracle this stage has.
 */
import type { SpecificationDigest } from './canonical.ts'
import type { SpecificationIr } from './ir.ts'

/**
 * One artifact's bytes, keyed by its path relative to the output directory.
 * Forward slashes only, so a manifest written on one platform still names the
 * same declared output on another.
 */
export type EmittedArtifacts = ReadonlyMap<string, string>

export interface ArtifactEmitter {
	/** Stable identity, used to attribute a generation error to one emitter. */
	readonly name: string
	readonly emit: (
		ir: SpecificationIr,
		digest: SpecificationDigest,
	) => EmittedArtifacts
}

/** The provenance manifest's declared path. */
export const PROVENANCE_MANIFEST_PATH = 'provenance.manifest.json'

/**
 * The provenance manifest binds one Generated Artifact Set to the admitted
 * input it came from and the generator that produced it.
 *
 * Per the product-owner YAGNI ruling: specification digest plus generator
 * identity plus the declared output set — deliberately no per-file output
 * hashes. Regeneration-and-compare is the drift oracle until it is measured
 * too slow, and a hash list would be a second, weaker oracle to keep in sync.
 */
export interface ProvenanceManifest {
	readonly specification_digest: string
	readonly input_schema_version: string
	readonly generator_contract_version: string
	readonly product: string
	/** Every path this set declares, sorted; the set is replaced as one unit. */
	readonly declared_outputs: readonly string[]
}

/** Deterministic JSON: sorted keys where the shape allows, trailing newline. */
function renderJson(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`
}

/**
 * Builds the manifest last, because it must name the complete declared output
 * set — including its own path.
 */
export function buildProvenanceManifest(
	ir: SpecificationIr,
	digest: SpecificationDigest,
	declaredOutputs: readonly string[],
): string {
	const manifest: ProvenanceManifest = {
		declared_outputs: [...declaredOutputs].sort(),
		generator_contract_version: digest.generatorContractVersion,
		input_schema_version: digest.inputSchemaVersion,
		product: ir.specMeta.product,
		specification_digest: digest.specificationDigest,
	}
	return renderJson(manifest)
}

/**
 * A small deterministic projection of the IR.
 *
 * Stage 2 needs at least one real artifact besides the manifest so the
 * mechanics are exercised against content that actually moves when the
 * specification moves. The semantic tables and typed contracts that consumers
 * will read are stage 3's emitters, added alongside this one.
 */
const specificationSummaryEmitter: ArtifactEmitter = {
	name: 'specification-summary',
	emit: (ir) =>
		new Map([
			[
				'specification-summary.json',
				renderJson({
					actions: ir.actions.catalog.map((action) => ({
						id: action.id,
						kind: action.kind,
					})),
					blockers: ir.blockers,
					commands: ir.commandSurface.commands,
					features: ir.features,
					product: ir.specMeta.product,
					states: ir.states.map((state) => ({
						name: state.name,
						values: state.values,
					})),
				}),
			],
		]),
}

/**
 * The default registry. Order does not affect output — paths are compared as
 * a set — but a stable order keeps a collision error reproducible.
 */
export const DEFAULT_EMITTERS: readonly ArtifactEmitter[] = [
	specificationSummaryEmitter,
]
