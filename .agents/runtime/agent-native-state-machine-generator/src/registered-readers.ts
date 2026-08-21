/**
 * Registered Readers: the only route by which input written against a
 * superseded Input Schema Version is compiled.
 *
 * The current compiler owns exactly one Input Schema Version. Every
 * superseded version it still admits is owned by a Registered Reader named
 * here, and a version with no reader fails closed - there is no lenient path
 * and no inference from ordering or similarity.
 *
 * A reader's contract is byte freezing. It owns its version's
 * canonicalization and its digest algorithm, including the historical Input
 * Schema Version its envelope stamps, so a specification's identity does not
 * move when this compiler gains a surface that version never used. That
 * frozen stamp is the reader's own contract and lives here rather than as a
 * special case inside `canonical.ts`, which stamps the declared version
 * exactly for the version it owns.
 *
 * Ownership is the whole algorithm, not the stamps alone. The bytes a digest
 * is taken over are decided by text normalization, key ordering,
 * serialization and envelope layout; a reader that called the current
 * canonicalizer and overrode only its two version fields would freeze the
 * stamps while inheriting all four. `frozen-canonical-v1.ts` holds the v1-era
 * bodies so a reader's envelope is reproducible from the reader alone.
 *
 * Reading is not admission, and a reader never migrates. Founding a new
 * Generated Artifact Set from a version a reader owns is refused by
 * `generate.ts`; the route forward is a Registered Migration, whose output is
 * an isolated candidate the product owner admits separately.
 */
import type { SpecificationDigest } from './canonical.ts'
import { digestSpecificationFrozenV1 } from './frozen-canonical-v1.ts'
import { INPUT_SCHEMA_V1_SHAPE } from './input-schema-v1.ts'
import type { Shape } from './schema.ts'

/**
 * The superseded Input Schema Versions this compiler still admits. Adding a
 * member is a Generator Contract change, and each member must have a reader
 * in REGISTERED_READERS below; the Record type keeps the two in step.
 */
export const REGISTERED_READER_VERSIONS = ['1', 'spike-draft-1'] as const

export type RegisteredReaderVersion =
	(typeof REGISTERED_READER_VERSIONS)[number]

export function isRegisteredReaderVersion(
	version: string,
): version is RegisteredReaderVersion {
	return (REGISTERED_READER_VERSIONS as readonly string[]).includes(version)
}

/**
 * One reader for one superseded Input Schema Version.
 *
 * `name` is provenance: a compile result names the reader that produced it,
 * so a caller can tell legacy input from current input without re-reading the
 * candidate.
 */
export interface RegisteredReader {
	readonly name: string
	readonly version: RegisteredReaderVersion
	/**
	 * The Input Schema Version this reader's digest envelope stamps. Frozen at
	 * the value the version carried when it was current, which is what keeps
	 * an existing Generated Artifact Set's identity stable.
	 */
	readonly frozenEnvelopeVersion: string
	/**
	 * The Generator Contract Version this reader's envelope stamps, frozen
	 * beside the input schema version.
	 *
	 * Both halves or neither: an envelope reproducible only when the current
	 * global happens to match would freeze one identity and inherit the other,
	 * and every historical digest would move the next time the generator's own
	 * contract moved. A reader's envelope is reproducible from the reader
	 * alone.
	 */
	readonly frozenGeneratorContractVersion: string
	/**
	 * The state this version bound transitions to, before `phase_state` made
	 * the binding a declaration.
	 *
	 * Frozen, not inferred: a legacy candidate keeps exactly the meaning it
	 * had, and a legacy candidate whose phase state carried another name keeps
	 * having no target checking, which is the historical behavior rather than
	 * a new judgement imposed on input nobody can re-admit.
	 */
	readonly frozenPhaseState: string
	/**
	 * The document surface this version accepted, owned by
	 * `input-schema-v1.ts` and frozen there.
	 *
	 * The reader owns the accepted surface, not only the digest: a candidate
	 * claiming this version and declaring a v2 field is refused as an unknown
	 * key at the structural stage, so it cannot take on v2 meaning while
	 * receiving this version's frozen envelope.
	 */
	readonly acceptedShape: Shape
	readonly digest: (canonical: unknown) => SpecificationDigest
}

/**
 * Both superseded versions were digested under an envelope stamping "1", so
 * both readers freeze that value. They stay separate entries because they are
 * separate declared versions: a future reader may freeze a different stamp,
 * and collapsing them now would hide that.
 */
function frozenAtVersionOne(
	name: string,
	version: RegisteredReaderVersion,
): RegisteredReader {
	const frozenEnvelopeVersion = '1'
	// The generator contract these versions were digested under, before this
	// unit changed the IR shape, canonicalization, and the sealed vocabularies.
	const frozenGeneratorContractVersion = '1'
	return {
		name,
		version,
		frozenEnvelopeVersion,
		frozenGeneratorContractVersion,
		// The state name transition targets were validated against before
		// `phase_state` existed. Only one product ever declared it.
		frozenPhaseState: 'transaction_phase',
		acceptedShape: INPUT_SCHEMA_V1_SHAPE,
		// The frozen canonicalizer, not the current one with two stamps
		// overridden. Overriding stamps freezes the stamps and inherits the
		// bytes; `frozen-canonical-v1.ts` owns the normalization, comparator,
		// serialization and envelope layout this version was digested under, so
		// no change to the current path can move an admitted identity.
		digest: (canonical) =>
			digestSpecificationFrozenV1(canonical, {
				generatorContractVersion: frozenGeneratorContractVersion,
				inputSchemaVersion: frozenEnvelopeVersion,
			}),
	}
}

/**
 * The exhaustive binding from each superseded version to its reader. Total by
 * type: a version added to REGISTERED_READER_VERSIONS without a reader fails
 * typecheck before it fails a test.
 */
export const REGISTERED_READERS: Readonly<
	Record<RegisteredReaderVersion, RegisteredReader>
> = {
	'1': frozenAtVersionOne('input-schema-v1', '1'),
	'spike-draft-1': frozenAtVersionOne(
		'input-schema-spike-draft-1',
		'spike-draft-1',
	),
}

/** The reader owning a version, or undefined when the current path owns it. */
export function registeredReaderFor(
	version: string,
): RegisteredReader | undefined {
	return isRegisteredReaderVersion(version)
		? REGISTERED_READERS[version]
		: undefined
}
