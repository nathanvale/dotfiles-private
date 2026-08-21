import { describe, expect, test } from 'bun:test'
import {
	compileSpecificationCandidate,
	GENERATOR_CONTRACT_VERSION,
	INPUT_SCHEMA_VERSION,
	REGISTERED_READER_VERSIONS,
	REGISTERED_READERS,
	registeredReaderFor,
	SUPPORTED_INPUT_SCHEMA_VERSIONS,
} from '../src/index.ts'
import { readCandidate, readNegativeFixture } from './support/candidates.ts'

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
		const result = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)
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
		const result = compileSpecificationCandidate(
			await readCandidate('vault-git'),
		)

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

describe('a compile result names the reader that produced it', () => {
	const cases = [
		{ label: 'vault-git spike', version: 'spike-draft-1' },
		{ label: 'pilot', version: '1' },
		{ label: 'agent-worktree draft', version: '1' },
	] as const

	test('the case list is non-empty', () => {
		expect(cases.length).toBeGreaterThan(0)
	})

	test('legacy input carries its reader name', async () => {
		const sources = [
			[cases[0], await readCandidate('vault-git')],
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
