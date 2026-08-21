/**
 * The generator-side semantic expectation table.
 *
 * The product owner ruled these fields out of the facade: state, cause,
 * blocker, Authority, retry posture, Projection Completeness and Next Safe
 * Action never become `BranchStation` properties. They live here, in a
 * parallel generator-owned table joined to stations on the existing
 * `expectedActionId` string — the pattern vault-git's own catalog-alignment
 * test already proves by hand, owned by the generator instead.
 *
 * The table carries meanings, never behavior. Nothing here evaluates a
 * predicate, observes a fact, or selects a continuation at runtime; the one
 * product-local Projection Composer keeps sole ownership of that.
 */
import { type EmitRefusal, emitRefusal } from './emit-contract.ts'
import type { DerivedStation } from './emit-stations.ts'
import type { SpecificationIr } from './ir.ts'
import type { NextSafeActionKind, RetryPosture } from './schema.ts'

/**
 * One semantic row: the complete State Projection meaning a Branch Station is
 * expected to produce, excluding anything a real process must observe.
 *
 * `projectionCompleteness` says whether every required observation and meaning
 * is present and current enough to emit a safe State Projection. An incomplete
 * row denies Authority, takes operator-owned retry posture, and stops
 * agent-terminal; it never defaults to continuation.
 */
export interface SemanticExpectationRow {
	/** The Branch Station this row explains. */
	readonly stationId: string
	/** The join key: the station's expected runtime action id. */
	readonly expectedActionId: string
	/** Stable state name the projection reports. */
	readonly state: string
	/** Stable cause the projection reports. */
	readonly cause: string
	/** Declared blocker, absent when nothing blocks. */
	readonly blocker?: string
	/** Current product-owned permission to perform the declared action. */
	readonly authority: 'granted' | 'denied'
	/** Evidence-backed posture for repeating the same logical work. */
	readonly retrySafety: RetryPosture
	/** Whether the projection is safe to emit. */
	readonly projectionCompleteness: 'complete' | 'incomplete'
	/** The sole current directive. */
	readonly nextSafeAction: NextSafeActionKind
	/** The meaning carried by `none`. */
	readonly stopScope?: 'domain_terminal' | 'agent_terminal'
}

export interface ExpectationEmission {
	readonly rows: readonly SemanticExpectationRow[]
	readonly refusals: readonly EmitRefusal[]
}

/**
 * Builds the semantic expectation table for a derived station set.
 *
 * Every station joins to exactly one row. A station whose action id is absent
 * from the specification's action catalog is refused rather than given a
 * best-effort row: an unresolvable continuation is precisely the ambiguity the
 * specification exists to eliminate.
 */
export function buildExpectationTable(
	ir: SpecificationIr,
	stations: readonly DerivedStation[],
): ExpectationEmission {
	const refusals: EmitRefusal[] = []
	const rows: SemanticExpectationRow[] = []
	const catalog = new Map(ir.actions.catalog.map((entry) => [entry.id, entry]))
	const seen = new Set<string>()

	for (const derived of [...stations].sort((a, b) =>
		a.station.id.localeCompare(b.station.id),
	)) {
		const { station, branch, mutation } = derived
		const actionId = station.expectedActionId ?? defaultActionId(branch, ir)

		if (seen.has(station.id)) {
			refusals.push(
				emitRefusal({
					cause: 'emit_expectation_join_ambiguous',
					subject: station.id,
					message: `Branch Station ${station.id} joins more than one semantic expectation row.`,
				}),
			)
			continue
		}
		seen.add(station.id)

		const entry = catalog.get(actionId)
		if (entry === undefined) {
			refusals.push(
				emitRefusal({
					cause: 'emit_expectation_action_unknown',
					subject: `${station.id}:${actionId}`,
					message: `Branch Station ${station.id} expects action ${actionId}, which the action catalog does not declare.`,
				}),
			)
			continue
		}

		const complete = branch !== 'invalid_usage'
		rows.push({
			stationId: station.id,
			expectedActionId: actionId,
			state: stateFor(branch),
			cause: causeFor(branch, ir),
			...(blockerFor(branch, ir) === undefined
				? {}
				: { blocker: blockerFor(branch, ir) as string }),
			authority: branch === 'success' ? 'granted' : 'denied',
			retrySafety: retrySafetyFor(branch, mutation, ir),
			projectionCompleteness: complete ? 'complete' : 'incomplete',
			nextSafeAction: entry.kind,
			...(entry.stopScope === undefined ? {} : { stopScope: entry.stopScope }),
		})
	}

	return { rows, refusals }
}

/**
 * The action id a derived station expects when the specification does not name
 * one per branch. A terminal `none` is the fail-closed choice: it is the only
 * directive that cannot invent a continuation the specification never admitted.
 */
function defaultActionId(branch: string, ir: SpecificationIr): string {
	const kinds = new Set(ir.actions.catalog.map((entry) => entry.id))
	if (branch === 'success') {
		return kinds.has('none') ? 'none' : (ir.actions.catalog[0]?.id ?? 'none')
	}
	return 'none'
}

function stateFor(branch: string): string {
	switch (branch) {
		case 'success':
			return 'observed_success'
		case 'invalid_usage':
			return 'input_refused'
		default:
			return 'blocked'
	}
}

function causeFor(branch: string, _ir: SpecificationIr): string {
	switch (branch) {
		case 'success':
			return 'declared_work_completed'
		case 'invalid_usage':
			return 'invalid_usage_or_input'
		default:
			return 'refused_blocked_or_failed'
	}
}

/**
 * The blocker a branch reports. A success branch has none. A refusal branch
 * takes the specification's first declared blocker when it declares any; a
 * candidate that declares none (a stateless product) carries refusal semantics
 * in its result contract instead, so no blocker is invented for it.
 */
function blockerFor(branch: string, ir: SpecificationIr): string | undefined {
	if (branch === 'success') return undefined
	if (branch === 'invalid_usage') {
		return ir.actions.resolution?.unavailableProjectionBlocker
	}
	return ir.blockers[0]
}

/**
 * Exact Same-Input Retry Safety for a branch.
 *
 * Derived from the specification's declared retry rules where one matches the
 * command's mutation, never from exit status or absent output. An invalid
 * usage never reached runtime state, so repeating it with corrected input is
 * safe; a refusal after a write-implying attempt is not, because the
 * Acknowledgement of its Declared Side Effect is unknown.
 */
function retrySafetyFor(
	branch: string,
	mutation: string,
	ir: SpecificationIr,
): RetryPosture {
	if (branch === 'invalid_usage') return 'same_input_safe'
	if (branch === 'success') return 'same_input_safe'
	const writeImplying =
		mutation === 'remote_write' ||
		mutation === 'local_write' ||
		mutation === 'recovery'
	if (!writeImplying) return 'same_input_safe'
	return ir.retryPosture.values.includes('same_input_unsafe')
		? 'same_input_unsafe'
		: 'operator_required'
}
