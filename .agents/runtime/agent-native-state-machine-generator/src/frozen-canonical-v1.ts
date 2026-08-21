/**
 * The canonicalization and digest envelope frozen at Input Schema v1.
 *
 * This module exists to break a coupling. A Registered Reader promises that a
 * superseded version's identity is reproducible from the reader alone, and
 * that promise is only kept if the reader owns the bytes it hashes. Calling
 * the current `canonical.ts` and overriding two version stamps freezes the
 * stamps and inherits everything that actually determines the bytes: the text
 * normalization, the key comparator, the serialization, and the envelope
 * layout. Under that arrangement a change to the current canonicalizer moves
 * every historical identity, including the admitted pilot's.
 *
 * The bodies below are deliberate local copies rather than imports from
 * `canonical.ts`, for exactly the reason `input-schema-v1.ts` copies the v1
 * shape vocabularies: an import would re-couple the frozen path to the current
 * one, which is the coupling this module exists to break. They are expected to
 * read as duplicates of today's current path, because v1 and v2 canonicalize
 * identically today. Divergence is the point: when the current path changes,
 * this one must not, and only separate bodies can hold that line.
 *
 * Nothing here is ever edited to track a change in `canonical.ts`. These bytes
 * are evidence about admitted history: a candidate digested under them keeps
 * its identity. A change that cannot reproduce that evidence escalates to the
 * product owner with the observed digests rather than being relabelled.
 */
import { createHash } from 'node:crypto'
import type { SpecificationDigest } from './canonical.ts'

/**
 * Codepoint string order, frozen. The current path documents why collation
 * must not come from host ICU data; this copy exists so that reasoning cannot
 * be revised out from under an admitted identity.
 */
function compareCodepointsV1(a: string, b: string): number {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}

/** Digest text normalization frozen at v1: NFC with LF line endings. */
function normalizeTextV1(value: string): string {
	return value.normalize('NFC').replace(/\r\n?/g, '\n')
}

/**
 * Recursive key sorting and re-serialization, frozen at v1. Array order is
 * preserved because sequence is meaning in this schema.
 */
function canonicalizeV1(value: unknown): unknown {
	if (typeof value === 'string') return normalizeTextV1(value)
	if (Array.isArray(value)) return value.map(canonicalizeV1)
	if (value !== null && typeof value === 'object') {
		const source: Record<string, unknown> = { ...value }
		const entries = Object.entries(source)
			.map(
				([key, entry]) =>
					[normalizeTextV1(key), canonicalizeV1(entry)] as const,
			)
			.sort(([a], [b]) => compareCodepointsV1(a, b))
		const result: Record<string, unknown> = {}
		for (const [key, entry] of entries) {
			result[key] = entry
		}
		return result
	}
	return value
}

/**
 * The v1 digest envelope, frozen: its field names, its field order, and the
 * hash taken over it. Both version identities are supplied by the reader that
 * owns them; neither is read from a current global, so no current constant can
 * reach a historical digest.
 */
export function digestSpecificationFrozenV1(
	canonical: unknown,
	identities: {
		readonly inputSchemaVersion: string
		readonly generatorContractVersion: string
	},
): SpecificationDigest {
	const form = JSON.stringify(canonicalizeV1(canonical))
	const envelope = JSON.stringify({
		canonical_form: form,
		generator_contract_version: identities.generatorContractVersion,
		input_schema_version: identities.inputSchemaVersion,
	})
	return {
		specificationDigest: createHash('sha256')
			.update(envelope, 'utf8')
			.digest('hex'),
		inputSchemaVersion: identities.inputSchemaVersion,
		generatorContractVersion: identities.generatorContractVersion,
		canonicalForm: form,
	}
}
