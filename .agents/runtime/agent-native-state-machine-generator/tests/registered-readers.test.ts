import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
	compileSpecificationCandidate,
	GENERATOR_CONTRACT_VERSION,
	INPUT_SCHEMA_VERSION,
	REGISTERED_READER_VERSIONS,
	REGISTERED_READERS,
	registeredReaderFor,
	SUPPORTED_INPUT_SCHEMA_VERSIONS,
} from '../src/index.ts'
import {
	readFrozenV1Exemplar,
	readNegativeFixture,
} from './support/candidates.ts'

/**
 * The Registered Readers' own contract (issue 55, stories 51 and 52).
 *
 * A reader owns one superseded Input Schema Version: its byte-frozen
 * canonicalization, its digest algorithm, and the historical version its
 * envelope stamps. That frozen stamp is asserted here, as the reader's
 * contract, and nowhere else - the current path stamps the declared version
 * exactly, which version-custody.test.ts holds.
 */

const DRAFT_URL = new URL(
	'../fixtures/draft-candidates/agent-worktree.state-machine.jsonc',
	import.meta.url,
)
const PILOT_URL = new URL(
	'../pilot/vault-git-reimagined.state-machine.jsonc',
	import.meta.url,
)

/**
 * Deliberate independent oracle: the frozen stamp restated as a literal.
 * Both superseded versions were digested under an envelope stamping "1"
 * before either reader existed, and that is what freezing preserves.
 */
const FROZEN_ENVELOPE_VERSION = '1'

describe('every superseded version has exactly one reader', () => {
	test('the registry covers the sealed list member for member', () => {
		expect(REGISTERED_READER_VERSIONS.length).toBeGreaterThan(0)
		expect(Object.keys(REGISTERED_READERS).sort()).toEqual(
			[...REGISTERED_READER_VERSIONS].sort(),
		)
	})

	test('every registered version is also a supported version', () => {
		for (const version of REGISTERED_READER_VERSIONS) {
			expect({
				version,
				supported: (
					SUPPORTED_INPUT_SCHEMA_VERSIONS as readonly string[]
				).includes(version),
			}).toEqual({ version, supported: true })
		}
	})

	test('each reader names itself and the one version it owns', () => {
		for (const version of REGISTERED_READER_VERSIONS) {
			const reader = REGISTERED_READERS[version]
			expect({ version, owns: reader.version }).toEqual({
				version,
				owns: version,
			})
			expect(reader.name.length).toBeGreaterThan(0)
		}
	})

	test('the current version has no reader', () => {
		expect(registeredReaderFor('2')).toBeUndefined()
	})

	test('reader names are distinct, so provenance identifies one reader', () => {
		const names = REGISTERED_READER_VERSIONS.map(
			(version) => REGISTERED_READERS[version].name,
		)
		expect([...new Set(names)].length).toBe(names.length)
	})
})

describe("a reader's envelope stamp is frozen at its historical value", () => {
	for (const version of REGISTERED_READER_VERSIONS) {
		test(`${version} freezes its stamp rather than following the declaration`, () => {
			const reader = REGISTERED_READERS[version]
			expect({ version, frozen: reader.frozenEnvelopeVersion }).toEqual({
				version,
				frozen: FROZEN_ENVELOPE_VERSION,
			})
		})
	}

	test('the spike candidate digests under the frozen stamp, not its declaration', async () => {
		// The frozen v1 exemplar, not the live vault-git candidate: this asserts
		// what a superseded version's reader does, and the live candidate is on
		// the current version whose envelope is not frozen.
		const result = compileSpecificationCandidate(await readFrozenV1Exemplar())
		expect(result.ok).toBe(true)
		if (!result.ok) return

		// Positive control: this candidate really declares something other than
		// the frozen stamp, so the freeze below is observable rather than a
		// coincidence of the two values agreeing.
		expect(result.ir.specMeta.inputSchemaVersion).toBe('spike-draft-1')
		expect(result.digest.inputSchemaVersion).toBe(FROZEN_ENVELOPE_VERSION)
	})
})

describe('the two version identities are independent', () => {
	/**
	 * Deliberate independent oracle: the frozen pair restated as literals. The
	 * historical envelope stamped input schema version 1 AND generator
	 * contract version 1, so a reader freezes both halves.
	 */
	const FROZEN_GENERATOR_CONTRACT_VERSION = '1'

	test('each reader freezes the generator contract version too', () => {
		expect(REGISTERED_READER_VERSIONS.length).toBeGreaterThan(0)
		for (const version of REGISTERED_READER_VERSIONS) {
			expect({
				version,
				frozen: REGISTERED_READERS[version].frozenGeneratorContractVersion,
			}).toEqual({ version, frozen: FROZEN_GENERATOR_CONTRACT_VERSION })
		}
	})

	test('the current contract version has moved past the frozen one', () => {
		// Positive control for every freeze assertion here: if the two were
		// equal, a reader inheriting the global would look correctly frozen
		// while freezing nothing. That coincidence is what this unit fixed.
		expect(GENERATOR_CONTRACT_VERSION).not.toBe(
			FROZEN_GENERATOR_CONTRACT_VERSION,
		)
	})

	test('a v2 candidate carries the current contract version', async () => {
		const result = compileSpecificationCandidate(
			(await readNegativeFixture('_base')).replace(
				'"input_schema_version": "1"',
				'"input_schema_version": "2"',
			),
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.registeredReader).toBeUndefined()
		// Both identities are the current ones on the current path.
		expect(result.digest.inputSchemaVersion).toBe('2')
		expect(result.digest.generatorContractVersion).toBe(
			GENERATOR_CONTRACT_VERSION,
		)
	})

	test('a legacy candidate carries the frozen pair, not the current one', async () => {
		const result = compileSpecificationCandidate(await readFrozenV1Exemplar())

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.registeredReader).toBe(
			REGISTERED_READERS['spike-draft-1'].name,
		)
		// Neither half is inherited from the current globals: the reader owns
		// its envelope end to end, so its digest is reproducible from the
		// reader alone.
		expect(result.digest.inputSchemaVersion).toBe(FROZEN_ENVELOPE_VERSION)
		expect(result.digest.generatorContractVersion).toBe(
			FROZEN_GENERATOR_CONTRACT_VERSION,
		)
	})

	test('the identities move for different reasons, so neither derives the other', () => {
		// The current pair differs in both members from the frozen pair, and
		// the schema identity is not the contract identity: a compiler could
		// change its output contract without touching the input surface, and
		// this unit did both, which is why the two are separate constants.
		expect(INPUT_SCHEMA_VERSION).toBe('2')
		expect(GENERATOR_CONTRACT_VERSION).toBe('2')
		for (const version of REGISTERED_READER_VERSIONS) {
			const reader = REGISTERED_READERS[version]
			expect({
				version,
				sameSource:
					reader.frozenEnvelopeVersion === INPUT_SCHEMA_VERSION ||
					reader.frozenGeneratorContractVersion === GENERATOR_CONTRACT_VERSION,
			}).toEqual({ version, sameSource: false })
		}
	})
})

describe('a reader owns the algorithm, not only the stamps', () => {
	/**
	 * Deliberate independent oracle: a digest envelope recomputed here from
	 * first principles, with this file's own sorting and hashing, over bytes
	 * the reader never sees. Recomputing through `canonical.ts` would prove the
	 * current path agrees with itself, which is precisely the coincidence that
	 * let a reader look frozen while freezing nothing.
	 */
	function independentV1Digest(value: unknown): string {
		function sortValue(node: unknown): unknown {
			if (typeof node === 'string') return node.normalize('NFC')
			if (Array.isArray(node)) return node.map(sortValue)
			if (node !== null && typeof node === 'object') {
				const out: Record<string, unknown> = {}
				for (const key of Object.keys({ ...node }).sort()) {
					out[key] = sortValue((node as Record<string, unknown>)[key])
				}
				return out
			}
			return node
		}
		const form = JSON.stringify(sortValue(value))
		return createHash('sha256')
			.update(
				JSON.stringify({
					canonical_form: form,
					generator_contract_version: '1',
					input_schema_version: '1',
				}),
				'utf8',
			)
			.digest('hex')
	}

	test('each reader reproduces a digest computed outside this package', () => {
		// A document with keys deliberately out of order and a decomposed
		// character, so key sorting and NFC normalization both have to fire for
		// the two computations to agree. A reader that stopped canonicalizing
		// would still return a digest; it would not return this one.
		const document = {
			zeta: 'last',
			alpha: { nested_b: 2, nested_a: 1 },
			cafe: 'cafe\u0301',
			list: [3, 1, 2],
		}
		const expected = independentV1Digest(document)

		expect(REGISTERED_READER_VERSIONS.length).toBeGreaterThan(0)
		for (const version of REGISTERED_READER_VERSIONS) {
			const reader = REGISTERED_READERS[version]
			expect({
				version,
				digest: reader.digest(document).specificationDigest,
			}).toEqual({ version, digest: expected })
		}
	})

	test('the frozen envelope carries no current global', () => {
		// The claim this module rests on: a reader's envelope is reproducible
		// from the reader alone. Were the reader delegating to the current
		// canonicalizer, its contract version would track
		// GENERATOR_CONTRACT_VERSION, and a bump would move every admitted
		// identity by half.
		//
		// Positive control: the current contract version really has moved past
		// the frozen one, so this asserts a freeze rather than two constants
		// that happen to agree.
		expect(GENERATOR_CONTRACT_VERSION).not.toBe('1')
		for (const version of REGISTERED_READER_VERSIONS) {
			const stamped = REGISTERED_READERS[version].digest({ k: 'v' })
			expect({
				version,
				input: stamped.inputSchemaVersion,
				contract: stamped.generatorContractVersion,
			}).toEqual({ version, input: '1', contract: '1' })
		}
	})
})

describe('a compile result names the reader that produced it', () => {
	const cases = [
		{ label: 'frozen vault-git v1 exemplar', version: 'spike-draft-1' },
		{ label: 'pilot', version: '1' },
		{ label: 'agent-worktree draft', version: '1' },
	] as const

	test('the case list is non-empty', () => {
		expect(cases.length).toBeGreaterThan(0)
	})

	test('legacy input carries its reader name', async () => {
		const sources = [
			[cases[0], await readFrozenV1Exemplar()],
			[cases[1], await Bun.file(PILOT_URL).text()],
			[cases[2], await Bun.file(DRAFT_URL).text()],
		] as const

		for (const [row, source] of sources) {
			const result = compileSpecificationCandidate(source)
			expect({ label: row.label, ok: result.ok }).toEqual({
				label: row.label,
				ok: true,
			})
			if (!result.ok) continue
			expect({ label: row.label, reader: result.registeredReader }).toEqual({
				label: row.label,
				reader: REGISTERED_READERS[row.version].name,
			})
		}
	})

	test('current-version input carries no reader name', async () => {
		const result = compileSpecificationCandidate(
			(await readNegativeFixture('_base')).replace(
				/"input_schema_version"\s*:\s*"[^"]*"/,
				'"input_schema_version": "2"',
			),
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.registeredReader).toBeUndefined()
	})
})
