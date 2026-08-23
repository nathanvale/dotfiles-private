/**
 * Canonicalization and the specification digest.
 *
 * Canonical form is the byte string the digest is taken over. Two candidates
 * that differ only cosmetically — comment placement, key order, trailing
 * commas, insignificant whitespace — must produce identical bytes here.
 */
import { createHash } from 'node:crypto'

/**
 * The Input Schema Version new generation is written against. Bumped when the
 * admitted input surface changes; v2 adds the declared surfaces the recorded
 * rulings need.
 */
export const INPUT_SCHEMA_VERSION = '2'

/**
 * Every Input Schema Version this compiler admits, exact match only.
 *
 * Compatibility is never inferred from semantic version ordering, successful
 * parsing, or structural similarity: `"2.0"` and `"01"` are not `"2"` and
 * `"1"`. Membership is the whole test.
 *
 * `spike-draft-1` and `1` are superseded versions that reach compilation only
 * through the Registered Reader; `2` is the sole version for new generation.
 * Adding a member is a Generator Contract change.
 */
export const SUPPORTED_INPUT_SCHEMA_VERSIONS = [
	'1',
	'2',
	'spike-draft-1',
] as const

export type SupportedInputSchemaVersion =
	(typeof SUPPORTED_INPUT_SCHEMA_VERSIONS)[number]

export function isSupportedInputSchemaVersion(
	version: string,
): version is SupportedInputSchemaVersion {
	return (SUPPORTED_INPUT_SCHEMA_VERSIONS as readonly string[]).includes(
		version,
	)
}

/**
 * Identifies the compiler's own output contract: the IR shape, the
 * canonicalization rules and the diagnostic vocabulary. Bumped when the
 * generator's meaning changes even though the input schema did not.
 *
 * Kept deliberately distinct from INPUT_SCHEMA_VERSION: the spec requires
 * compatibility decisions to name the correct identity, and the two move for
 * different reasons. Input Schema v2 moved the input surface; this moved
 * because the same unit also changed the IR shape, added Registered Readers
 * to canonicalization, and added sealed diagnostic and refusal causes. Either
 * identity can move without the other, which is why neither is derived from
 * the other.
 *
 * A superseded version's envelope keeps the contract version it was digested
 * under; `registered-readers.ts` owns that freeze.
 */
export const GENERATOR_CONTRACT_VERSION = '2'

export interface SpecificationDigest {
	/** SHA-256 over the canonical form, lowercase hex. */
	readonly specificationDigest: string
	readonly inputSchemaVersion: string
	readonly generatorContractVersion: string
	/** The exact bytes hashed; retained so provenance can be re-verified. */
	readonly canonicalForm: string
}

/**
 * Codepoint string order for every comparator whose result reaches emitted
 * bytes, a digest input, or a caller-visible list. `localeCompare` and `Intl`
 * collate through host ICU data, so the same specification could regenerate
 * to different bytes on another machine and the drift oracle would report
 * drift that is not drift.
 */
export function compareCodepoints(a: string, b: string): number {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}

/**
 * Digest text normalization: NFC with LF line endings. Editors and macOS
 * paste paths convert between NFC/NFD and CRLF/LF silently, so without this
 * two candidates a reviewer cannot tell apart would carry different
 * specification identities.
 */
function normalizeText(value: string): string {
	return value.normalize('NFC').replace(/\r\n?/g, '\n')
}

/**
 * Sorts object keys recursively and re-serializes with no insignificant
 * whitespace. Array order is preserved: sequence is meaning in this schema
 * (ordered retry rules, ordered transitions), so it is never normalized away.
 * Every string, keys included, is normalized before it can reach the digest;
 * keys sort by their normalized form because that form is what serializes.
 */
export function canonicalize(value: unknown): unknown {
	if (typeof value === 'string') return normalizeText(value)
	if (Array.isArray(value)) return value.map(canonicalize)
	if (value !== null && typeof value === 'object') {
		const source = value as Record<string, unknown>
		const entries = Object.entries(source)
			.map(([key, entry]) => [normalizeText(key), canonicalize(entry)] as const)
			.sort(([a], [b]) => compareCodepoints(a, b))
		const result: Record<string, unknown> = {}
		for (const [key, entry] of entries) {
			result[key] = entry
		}
		return result
	}
	return value
}

/** Deterministic serialization of an already-canonicalized value. */
function canonicalForm(value: unknown): string {
	return JSON.stringify(canonicalize(value))
}

/**
 * Reads the Input Schema Version the candidate declared.
 *
 * Only a document that never reached validation can miss the field, and it
 * falls back to the current version because it has declared nothing to
 * honor.
 */
function declaredInputSchemaVersion(canonical: unknown): string {
	if (canonical === null || typeof canonical !== 'object')
		return INPUT_SCHEMA_VERSION
	const meta = (canonical as Record<string, unknown>).spec_meta
	if (meta === null || typeof meta !== 'object') return INPUT_SCHEMA_VERSION
	const declared = (meta as Record<string, unknown>).input_schema_version
	return typeof declared === 'string' ? declared : INPUT_SCHEMA_VERSION
}

/**
 * Digests a candidate written against the current Input Schema Version.
 *
 * The stamp is the version the candidate declared, never a constant: a
 * candidate and its Generated Artifact Set must name the same Input Schema
 * Version, and a pinned constant made every candidate claim the compiler's
 * version regardless of its own (worklist row W4).
 *
 * Superseded versions are not digested here. Each one is owned by a
 * Registered Reader in `registered-readers.ts`, which carries its own
 * byte-frozen digest algorithm; a special case for them in this function
 * would hide that seam inside the current path.
 */
export function digestSpecification(
	canonical: unknown,
	overrides: {
		readonly inputSchemaVersion?: string
		readonly generatorContractVersion?: string
	} = {},
): SpecificationDigest {
	const form = canonicalForm(canonical)
	const inputSchemaVersion =
		overrides.inputSchemaVersion ?? declaredInputSchemaVersion(canonical)
	// Both identities are overridable and neither is derived from the other:
	// only a Registered Reader supplies them, and it supplies the pair its
	// version was digested under. A reader that could freeze one but not the
	// other would move an existing set's identity by half.
	const generatorContractVersion =
		overrides.generatorContractVersion ?? GENERATOR_CONTRACT_VERSION
	// The digest binds the versions as well as the content: the same bytes
	// under a different generator contract are not the same specification.
	const envelope = JSON.stringify({
		canonical_form: form,
		generator_contract_version: generatorContractVersion,
		input_schema_version: inputSchemaVersion,
	})
	return {
		specificationDigest: createHash('sha256')
			.update(envelope, 'utf8')
			.digest('hex'),
		inputSchemaVersion,
		generatorContractVersion,
		canonicalForm: form,
	}
}
