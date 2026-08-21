/**
 * The one real-process smoke path the stage 4 gate names, then drift
 * verification clean after the run.
 *
 * The fixture below is a Real Process Fixture: it prepares a declared
 * environment (a workspace whose root carries a .git entry, the one Observed
 * Fact the candidate declares) and invokes the real public CLI as a spawned
 * process. It supplies no expected results; the generated Branch Station and
 * semantic expectation row own those.
 *
 * This is the pilot's only Observed Branch Coverage claim: exactly one
 * station, status.success. Every other station stays Declared Branch
 * Coverage. Nothing here is qualification evidence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	assertStationEnvelope,
	buildStationEvidence,
	runCliProcess,
} from '@side-quest/cli-command-facade/testing'
import {
	compileSpecificationCandidate,
	verifyArtifactSet,
} from '../src/index.ts'
import {
	findVaultGitReimaginedBranchStationCatalogDrift,
	vaultGitReimaginedBranchStationCatalog,
} from './generated/src/branch-station-catalog.ts'
import { vaultGitReimaginedSemanticExpectations } from './generated/src/semantic-expectations.ts'
import { PILOT_EMITTERS } from './generation/pilot-derivation.ts'

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url))
const CANDIDATE_URL = new URL(
	'./vault-git-reimagined.state-machine.jsonc',
	import.meta.url,
)
const GENERATED_DIR = fileURLToPath(new URL('./generated/', import.meta.url))

let workspace = ''

beforeAll(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'vault-git-reimagined-smoke-'))
	await mkdir(join(workspace, '.git'))
})

afterAll(async () => {
	if (workspace !== '') await rm(workspace, { recursive: true, force: true })
})

describe('one real-process smoke path', () => {
	test('the spawned CLI matches the generated status.success expectation', async () => {
		const station = vaultGitReimaginedBranchStationCatalog.find(
			(candidate) => candidate.id === 'status.success',
		)
		expect(station, 'status.success missing from the catalog').toBeDefined()
		if (station === undefined) return

		const result = await runCliProcess({
			label: 'status --json',
			argv: ['bun', CLI_PATH, 'status', '--json'],
			cwd: workspace,
			stdin: '',
		})
		expect(result.timedOut).toBe(false)

		// Throws on any exit-code, envelope-status, contract-id, or error-code
		// mismatch against the generated station.
		const envelope = assertStationEnvelope(station, result)
		const evidence = buildStationEvidence(station, result, envelope)
		expect(evidence.status).toBe('covered')
		expect(evidence.observedExitCode).toBe(0)
		expect(evidence.observedEnvelopeStatus).toBe('ok')
		expect(evidence.observedResultContractId).toBe(
			'vault-git-reimagined.status',
		)

		const drift = findVaultGitReimaginedBranchStationCatalogDrift([evidence])
		expect(drift).toEqual([])

		// The observed State Projection must be the meaning the generated
		// semantic expectation row claims. The literal is the oracle; the join
		// against the generated row proves the two artifacts agree with it.
		const projection = (
			envelope.data as { state_projection?: unknown } | undefined
		)?.state_projection
		expect(projection).toEqual({
			actionId: 'inspect_status',
			state: 'observed_success',
			cause: 'read_success',
			authority: 'granted',
			retrySafety: 'same_input_safe',
			projectionCompleteness: 'complete',
			nextSafeAction: 'invoke',
		})

		const rows = vaultGitReimaginedSemanticExpectations.filter(
			(row) => row.stationId === 'status.success',
		)
		expect(rows.length).toBe(1)
		const [row] = rows
		if (row === undefined) return
		expect(row.expectedActionId).toBe('inspect_status')
		expect(row.state).toBe('observed_success')
		expect(row.cause).toBe('read_success')
		expect(row.authority).toBe('granted')
		expect(row.retrySafety).toBe('same_input_safe')
		expect(row.projectionCompleteness).toBe('complete')
		expect(row.nextSafeAction).toBe('invoke')
	})

	test('drift verification is clean after the run', async () => {
		const source = await Bun.file(CANDIDATE_URL).text()
		const compiled = compileSpecificationCandidate(source, {
			sourcePath: 'pilot/vault-git-reimagined.state-machine.jsonc',
		})
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) return

		const verified = await verifyArtifactSet(compiled.ir, compiled.digest, {
			outputDir: GENERATED_DIR,
			emitters: PILOT_EMITTERS,
		})
		expect(
			verified.ok,
			verified.ok ? '' : JSON.stringify(verified.findings),
		).toBe(true)
		if (!verified.ok) return
		expect(verified.declaredOutputs).toEqual([
			'provenance.manifest.json',
			'src/branch-station-catalog.ts',
			'src/command-surface-contract.ts',
			'src/projection-composer.ts',
			'src/semantic-expectations.ts',
		])
	})
})
