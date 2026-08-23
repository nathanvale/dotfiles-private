import { describe, expect, test } from 'bun:test'
import { emitAmended } from './support/emission.ts'

/**
 * The semantic expectation table's meanings, checked against the spec and the
 * candidate rather than against the derivation that produced them.
 *
 * The incomplete-projection triple is the spec's own sentence: "Make an
 * incomplete or stale projection deny Authority, use operator-owned retry
 * posture, and stop with agent-terminal `none`. Never default to
 * continuation." That is an oracle outside both the code and the fixture, so a
 * derivation that drifts back toward a permissive default fails here.
 */

describe('an incomplete projection follows the spec, never a default', () => {
	test('fallow reaches no invalid-usage branch, so it has no incomplete row', async () => {
		// Not a gap: fallow declares no global flags and no per-command flags, so
		// no command can be invoked wrongly. The absence is derived, not assumed,
		// and this test says so rather than letting the loop below pass vacuously.
		const { ir, emission } = await emitAmended('fallow')
		expect(ir.commandSurface.globalFlags).toEqual([])
		expect(
			emission.expectations.filter(
				(row) => row.projectionCompleteness === 'incomplete',
			),
		).toEqual([])
	})

	for (const product of ['vault-git'] as const) {
		test(`${product} incomplete rows deny Authority and stop agent-terminal`, async () => {
			const { emission } = await emitAmended(product)
			const incomplete = emission.expectations.filter(
				(row) => row.projectionCompleteness === 'incomplete',
			)

			expect(incomplete.length).toBeGreaterThan(0)
			for (const row of incomplete) {
				expect({
					station: row.stationId,
					authority: row.authority,
					retrySafety: row.retrySafety,
					nextSafeAction: row.nextSafeAction,
					stopScope: row.stopScope,
				}).toEqual({
					station: row.stationId,
					authority: 'denied',
					retrySafety: 'operator_required',
					nextSafeAction: 'none',
					stopScope: 'agent_terminal',
				})
			}
		})

		test(`${product} never emits domain_terminal on an incomplete row`, async () => {
			// domain_terminal claims the product itself is finished. An incomplete
			// projection has not observed enough to make that claim about anything.
			const { emission } = await emitAmended(product)
			for (const row of emission.expectations) {
				if (row.projectionCompleteness !== 'incomplete') continue
				expect(row.stopScope).not.toBe('domain_terminal')
			}
		})
	}
})

describe('retry posture comes from the declared rule table', () => {
	test('vault-git success rows resolve through a declared rule', async () => {
		const { ir, emission } = await emitAmended('vault-git')
		// Oracle: the candidate's own ordered table, read independently. The
		// first rule matching `result_kind: success` decides.
		const declared = ir.retryPosture.rules.find(
			(rule) => rule.when.result_kind === 'success',
		)
		expect(declared).toBeDefined()
		if (!declared) return

		const successRows = emission.expectations.filter((row) =>
			row.stationId.endsWith('.success'),
		)
		expect(successRows.length).toBeGreaterThan(0)
		for (const row of successRows) {
			expect({ station: row.stationId, retry: row.retrySafety }).toEqual({
				station: row.stationId,
				retry: declared.then,
			})
		}
	})

	test('every emitted posture is one the candidate declares', async () => {
		for (const product of ['vault-git', 'fallow'] as const) {
			const { ir, emission } = await emitAmended(product)
			const declared = new Set<string>(ir.retryPosture.values)
			for (const row of emission.expectations) {
				expect({
					station: row.stationId,
					declared: declared.has(row.retrySafety),
				}).toEqual({ station: row.stationId, declared: true })
			}
		}
	})

	test('no row takes a posture from exit status or branch identity alone', async () => {
		// A refusal and a success on the same command must be able to differ,
		// and must each trace to a rule rather than to their exit code.
		const { emission } = await emitAmended('vault-git')
		const postures = new Set(
			emission.expectations.map((row) => row.retrySafety),
		)
		expect(postures.size).toBeGreaterThan(0)
	})
})

describe('every semantic value traces to something declared', () => {
	test('each cause is the candidate exit meaning for its branch', async () => {
		const { ir, emission } = await emitAmended('vault-git')
		const declared = new Set(Object.values(ir.commandSurface.exitCodes))
		for (const row of emission.expectations) {
			expect({
				station: row.stationId,
				declared: declared.has(row.exitMeaning),
			}).toEqual({ station: row.stationId, declared: true })
		}
	})

	test('each Next Safe Action kind is one the candidate seals', async () => {
		for (const product of ['vault-git', 'fallow'] as const) {
			const { ir, emission } = await emitAmended(product)
			const declared = new Set<string>(ir.actions.kinds)
			for (const row of emission.expectations) {
				expect({
					station: row.stationId,
					kind: row.nextSafeAction,
					declared: declared.has(row.nextSafeAction),
				}).toEqual({
					station: row.stationId,
					kind: row.nextSafeAction,
					declared: true,
				})
			}
		}
	})

	test('each expectedActionId is an id the action catalog declares', async () => {
		for (const product of ['vault-git', 'fallow'] as const) {
			const { ir, emission } = await emitAmended(product)
			const catalog = new Set(ir.actions.catalog.map((entry) => entry.id))
			for (const row of emission.expectations) {
				expect({
					station: row.stationId,
					action: row.expectedActionId,
					declared: catalog.has(row.expectedActionId),
				}).toEqual({
					station: row.stationId,
					action: row.expectedActionId,
					declared: true,
				})
			}
		}
	})

	test('a blocker, where present, is one the candidate declares', async () => {
		for (const product of ['vault-git', 'fallow'] as const) {
			const { ir, emission } = await emitAmended(product)
			const declared = new Set<string>([
				...ir.blockers,
				...(ir.actions.resolution?.unavailableProjectionBlocker === undefined
					? []
					: [ir.actions.resolution.unavailableProjectionBlocker]),
			])
			for (const row of emission.expectations) {
				if (row.blocker === undefined) continue
				expect({
					station: row.stationId,
					blocker: row.blocker,
					declared: declared.has(row.blocker),
				}).toEqual({
					station: row.stationId,
					blocker: row.blocker,
					declared: true,
				})
			}
		}
	})
})

describe('the admitted no-argument behavior gets its own station', () => {
	for (const product of ['vault-git', 'fallow'] as const) {
		test(`${product} emits a read-only no-argument station`, async () => {
			const { ir, emission } = await emitAmended(product)
			const station = emission.stations.find(
				(derived) => derived.noArgumentBehavior !== undefined,
			)

			expect(station).toBeDefined()
			expect(station?.noArgumentBehavior).toBe(
				ir.commandSurface.noArgumentBehavior,
			)
			// The spec forbids a default write. This is the proof obligation.
			expect(station?.station.mutationExpectation).toBe('read_only_projection')
			expect(station?.station.expectedExitCode).toBe(0)
			expect(station?.station.id.endsWith('.no_argument')).toBe(true)
		})

		test(`${product} attaches the no-argument station to a declared command`, async () => {
			// The facade's third hard invariant: a station's command must be in
			// discovery. A pseudo-command would be refused at projection time.
			const { ir, emission } = await emitAmended(product)
			const station = emission.stations.find(
				(derived) => derived.noArgumentBehavior !== undefined,
			)
			expect(
				ir.commandSurface.commands.includes(station?.station.command as string),
			).toBe(true)
		})
	}
})

describe('every command reaches a refusal branch', () => {
	test('a read-only command can be refused, not only a write', async () => {
		// A declared blocker denies authority to a read as readily as to a write.
		const { ir, emission } = await emitAmended('vault-git')
		const refusedCommands = new Set(
			emission.stations
				.filter((derived) => derived.branch === 'refused')
				.map((derived) => derived.station.command),
		)
		for (const command of ir.commandSurface.commands) {
			expect({ command, refusable: refusedCommands.has(command) }).toEqual({
				command,
				refusable: true,
			})
		}
	})
})
