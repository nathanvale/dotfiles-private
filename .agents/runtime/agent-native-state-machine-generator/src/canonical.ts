/**
 * Canonicalization and the specification digest.
 *
 * Canonical form is the byte string the digest is taken over. Two candidates
 * that differ only cosmetically — comment placement, key order, trailing
 * commas, insignificant whitespace — must produce identical bytes here.
 */
import { createHash } from 'node:crypto'

/**
 * Identifies the schema the candidate is written against. Bumped when the
 * admitted input surface changes.
 */
export const INPUT_SCHEMA_VERSION = '1'

/**
 * Identifies the compiler's own output contract: the IR shape, the
 * canonicalization rules and the diagnostic vocabulary. Bumped when the
 * generator's meaning changes even though the input schema did not.
 *
 * Kept deliberately distinct from INPUT_SCHEMA_VERSION: the spec requires
 * compatibility decisions to name the correct identity. Migration machinery
 * between versions is deferred (stage 1 scope).
 */
export const GENERATOR_CONTRACT_VERSION = '1'

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

export function digestSpecification(canonical: unknown): SpecificationDigest {
	const form = canonicalForm(canonical)
	// The digest binds the versions as well as the content: the same bytes
	// under a different generator contract are not the same specification.
	const envelope = JSON.stringify({
		canonical_form: form,
		generator_contract_version: GENERATOR_CONTRACT_VERSION,
		input_schema_version: INPUT_SCHEMA_VERSION,
	})
	return {
		specificationDigest: createHash('sha256')
			.update(envelope, 'utf8')
			.digest('hex'),
		inputSchemaVersion: INPUT_SCHEMA_VERSION,
		generatorContractVersion: GENERATOR_CONTRACT_VERSION,
		canonicalForm: form,
	}
}
