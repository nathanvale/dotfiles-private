/**
 * The generator-side semantic expectation table.
 *
 * The product owner ruled these fields out of the facade: state, cause,
 * blocker, Authority, retry posture, Projection Completeness and Next Safe
 * Action never become `BranchStation` properties. They live here, in a
 * parallel generator-owned table joined to stations on the existing
 * `expectedActionId` string - the pattern vault-git's own catalog-alignment
 * test already proves by hand, owned by the generator instead.
 *
 * Every value is resolved from something the candidate declares. Where Input
 * Schema v1 declares nothing that can supply a required column, the row is
 * refused rather than filled with a default: a hardcoded default published as
 * a semantic row would masquerade as an admitted meaning.
 *
 * The table carries meanings, never behavior. Nothing here evaluates a
 * predicate, observes a fact, or selects a continuation at runtime; the one
 * product-local Projection Composer keeps sole ownership of that.
 */

import { type DerivedStation, sortStations } from './branch-stations.ts'
import { BRANCH_FACTS, resolveRetryPosture } from './derivation-facts.ts'
import type { RoutingRow, RoutingTable, SpecificationIr } from './ir.ts'
import { type ArtifactRefusal, artifactRefusal } from './refusal.ts'
import type {
	BranchKind,
	NextSafeActionKind,
	RetryPosture,
	RoutingRole,
} from './schema.ts'

/**
 * One semantic row: the complete State Projection meaning a Branch Station is
 * expected to produce, excluding anything a real process must observe.
 *
 * An incomplete projection denies Authority, takes operator-owned retry
 * posture, and stops agent-terminal. That triple is the spec's, not a
 * derivation choice, and `assertIncompleteProjection` enforces it on every row
 * before emission.
 */
export interface SemanticExpectationRow {
	readonly stationId: string
	/** The join key: the station's expected runtime action id. */
	readonly expectedActionId: string
	readonly state: string
	/**
	 * The product's own word for what this exit means, taken from the
	 * candidate's declared exit codes.
	 *
	 * Deliberately not named `cause`: that word is the sealed refusal and
	 * diagnostic discriminant everywhere else in the package, and one name for
	 * two meanings made a row's product wording look branchable.
	 */
	readonly exitMeaning: string
	readonly blocker?: string
	readonly authority: 'granted' | 'denied'
	readonly retrySafety: RetryPosture
	readonly projectionCompleteness: 'complete' | 'incomplete'
	readonly nextSafeAction: NextSafeActionKind
	readonly stopScope?: 'domain_terminal' | 'agent_terminal'
}

export interface ExpectationEmission {
	readonly rows: readonly SemanticExpectationRow[]
	readonly refusals: readonly ArtifactRefusal[]
}

/** The `result_kind` a branch presents to the declared retry rule table. */
const BRANCH_RESULT_KIND: Readonly<Record<BranchKind, string>> = {
	success: 'success',
	refused: 'refusal',
	invalid_usage: 'refusal',
}

/**
 * Builds the semantic expectation table for a derived station set.
 *
 * Every station joins to exactly one row, or its row is refused. The join is
 * exact by construction: stations arrive with unique ids and each contributes
 * at most one row, so no ambiguity guard is needed here.
 */
export function buildExpectationTable(
	ir: SpecificationIr,
	stations: readonly DerivedStation[],
): ExpectationEmission {
	const refusals: ArtifactRefusal[] = []
	const rows: SemanticExpectationRow[] = []
	const catalog = new Map(ir.actions.catalog.map((entry) => [entry.id, entry]))
	const resolution = ir.actions.resolution

	for (const derived of sortStations(stations)) {
		const { station, branch } = derived
		const facts = BRANCH_FACTS[branch]
		const incomplete = facts.projectionCompleteness === 'incomplete'

		// An incomplete projection has one admitted meaning, and the candidate
		// declares it under `actions.resolution`. Without that declaration the
		// generator has nothing to publish and must not invent the triple.
		if (incomplete && resolution?.unavailableProjectionBlocker === undefined) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_expectation_column_underivable',
					subject: `${station.id}:blocker`,
					message: `Branch Station ${station.id} projects incompletely, but the candidate declares no actions.resolution.unavailable_projection_blocker to name why.`,
				}),
			)
			continue
		}

		const selected = incomplete
			? undefined
			: blockerRowFor(branch, ir, station.command)

		if (selected !== undefined && 'ambiguous' in selected) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_expectation_column_underivable',
					subject: `${station.id}:blocker`,
					message: `Branch Station ${station.id} matches more than one declared station_blocker row, so no single admitted refusal cause can be named.`,
				}),
			)
			continue
		}

		// The selected row carries the blocker AND what that blocker routes
		// to, so a mapping's action and posture are taken from the same match
		// rather than resolved separately from a blocker name.
		const routedAction =
			selected !== undefined && 'row' in selected
				? selected.row.target
				: undefined
		const routedPosture =
			selected !== undefined && 'row' in selected
				? selected.row.retrySafety
				: undefined

		const blocker = incomplete
			? resolution?.unavailableProjectionBlocker
			: selected === undefined
				? undefined
				: 'row' in selected
					? selected.row.blocker
					: selected.fallbackBlocker

		if (branch === 'refused' && blocker === undefined) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_expectation_column_underivable',
					subject: `${station.id}:blocker`,
					message: `Branch Station ${station.id} is a refusal, but no declared station_blocker mapping selects for it and the candidate declares no single blocker, so no admitted refusal cause can be named.`,
				}),
			)
			continue
		}

		const retrySafety = incomplete
			? // The spec fixes the incomplete-projection posture as operator-owned.
				// A candidate that also declares it must agree; a disagreement is a
				// specification defect rather than something to silently resolve.
				(resolution?.unavailableProjectionRetrySafety ?? 'operator_required')
			: // A declared route's posture is the admitted answer for that
				// route; the rule table answers only where no route selected.
				(routedPosture ??
				resolveRetryPosture(ir, {
					command: station.command,
					resultKind: BRANCH_RESULT_KIND[branch],
					...(blocker === undefined ? {} : { blocker }),
					state: facts.state,
				}))

		if (retrySafety === undefined) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_retry_posture_unresolved',
					subject: station.id,
					message: `No declared retry_posture rule matches Branch Station ${station.id} (command ${station.command}, result_kind ${BRANCH_RESULT_KIND[branch]}); Exact Same-Input Retry Safety cannot be derived from exit status or prose.`,
				}),
			)
			continue
		}

		const action = routedAction ?? resolveAction(ir, derived, incomplete)
		if (action === undefined) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_expectation_column_underivable',
					subject: `${station.id}:expectedActionId`,
					message: `Branch Station ${station.id} has no declared action: the candidate's action catalog names no entry this branch can reach, and Input Schema v1 has no per-station action binding.`,
				}),
			)
			continue
		}

		const entry = catalog.get(action)
		if (entry === undefined) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_expectation_action_unknown',
					subject: `${station.id}:${action}`,
					message: `Branch Station ${station.id} expects action ${action}, which the action catalog does not declare.`,
				}),
			)
			continue
		}

		const stopScope = incomplete
			? // Agent-terminal by the spec: an incomplete projection stops the
				// current agent and never claims the product itself is finished.
				(resolution?.unavailableProjectionStop ?? 'agent_terminal')
			: entry.stopScope

		const row: SemanticExpectationRow = {
			stationId: station.id,
			expectedActionId: action,
			state: facts.state,
			exitMeaning: exitMeaningFor(branch, ir),
			...(blocker === undefined ? {} : { blocker }),
			authority: facts.authority,
			retrySafety,
			projectionCompleteness: facts.projectionCompleteness,
			nextSafeAction: entry.kind,
			...(stopScope === undefined ? {} : { stopScope }),
		}

		const violation = assertIncompleteProjection(row)
		if (violation) {
			refusals.push(violation)
			continue
		}
		rows.push(row)
	}

	return { rows, refusals }
}

/**
 * The spec's incomplete-projection rule, enforced on the emitted row.
 *
 * "Make an incomplete or stale projection deny Authority, use operator-owned
 * retry posture, and stop with agent-terminal `none`. Never default to
 * continuation." Checking the finished row rather than trusting the
 * derivation means a future change to any input cannot quietly publish a
 * continuation-shaped incomplete projection.
 */
function assertIncompleteProjection(
	row: SemanticExpectationRow,
): ArtifactRefusal | undefined {
	if (row.projectionCompleteness !== 'incomplete') return undefined
	const problems: string[] = []
	if (row.authority !== 'denied') problems.push('grants Authority')
	if (row.retrySafety !== 'operator_required') {
		problems.push(`declares retry posture ${row.retrySafety}`)
	}
	if (row.nextSafeAction !== 'none') {
		problems.push(`continues with ${row.nextSafeAction}`)
	}
	if (row.stopScope !== 'agent_terminal') {
		problems.push(`stops ${row.stopScope ?? 'without a scope'}`)
	}
	if (problems.length === 0) return undefined
	return artifactRefusal({
		cause: 'emit_expectation_column_underivable',
		subject: row.stationId,
		message: `Branch Station ${row.stationId} projects incompletely but ${problems.join(', ')}; an incomplete projection must deny Authority, use operator-owned retry posture, and stop agent-terminal none.`,
	})
}

/**
 * The action id a branch expects.
 *
 * An incomplete projection resolves to the sealed terminal `none`: it is the
 * only directive that cannot invent a continuation the candidate never
 * admitted. Other branches take the single catalog entry whose declared
 * `requires_feature` and context needs this branch can satisfy, and otherwise
 * report that no admitted action covers them.
 */
function resolveAction(
	ir: SpecificationIr,
	derived: DerivedStation,
	incomplete: boolean,
): string | undefined {
	const ids = new Set(ir.actions.catalog.map((entry) => entry.id))
	if (incomplete) return ids.has('none') ? 'none' : undefined

	// A refusal stops unless the candidate declares an action for its blocker.
	// v1 has no blocker-to-action binding, so a refusal terminates rather than
	// claiming a continuation the specification never named.
	if (derived.branch === 'refused') return ids.has('none') ? 'none' : undefined

	// A declared station-action binding is the admitted answer, and it is a
	// separate claim from fact-to-branch selection: reaching a station says
	// which branch happened, never what that station's Next Safe Action is
	// (gap rows 4 and 5 are two bindings, not one).
	const bound = selectRoutingRow(ir, 'station_action', {
		branch: derived.branch,
		command: derived.station.command,
	})
	if (bound !== undefined && 'ambiguous' in bound) return undefined
	if (bound !== undefined) return bound.row.target

	// No binding declared: v1's naming convention, which matches nothing on a
	// product whose actions are named differently, and which is exactly the
	// gap the declaration closes.
	const match = ir.actions.catalog.find(
		(entry) =>
			entry.kind === 'invoke' &&
			entry.requiresContext.length === 0 &&
			entry.requiresFeature === undefined &&
			entry.id.endsWith(`_${derived.station.command}`),
	)
	if (match) return match.id
	return ids.has('none') ? 'none' : undefined
}

function exitMeaningFor(branch: BranchKind, ir: SpecificationIr): string {
	const declared = ir.commandSurface.exitCodes[
		String(BRANCH_FACTS[branch].exitCode)
	] as string | undefined
	// The candidate names each exit's meaning; using it keeps the row's
	// wording the product's own rather than a generator-invented synonym.
	return declared ?? branch
}

/**
 * What a declared `station_blocker` mapping says about this station.
 *
 * Returns the selected row so the caller takes the blocker AND the action and
 * posture that blocker routes to from one complete match, rather than reading
 * a blocker name out of a key and resolving the action somewhere else.
 */
function blockerRowFor(
	branch: BranchKind,
	ir: SpecificationIr,
	command: string,
):
	| { readonly row: RoutingRow }
	| { readonly ambiguous: true }
	| { readonly fallbackBlocker: string }
	| undefined {
	if (branch !== 'refused') return undefined

	const selected = selectRoutingRow(ir, 'station_blocker', {
		branch,
		command,
	})
	if (selected !== undefined) return selected

	// No declared mapping selects. v1's fallback answers only when the
	// candidate leaves no choice to make.
	const only = ir.blockers.length === 1 ? ir.blockers[0] : undefined
	return only === undefined ? undefined : { fallbackBlocker: only }
}

/**
 * The one routing row that selects for this station, under a declared role.
 *
 * The table is chosen by the role the product declared, never by its name or
 * by which discriminants it happens to carry: a Finding table mentioning a
 * blocker is not a blocker-to-action mapping.
 *
 * Every declared discriminant is evaluated. A discriminant naming a fact this
 * station cannot supply makes the row ineligible rather than being skipped,
 * so a row never selects on a key that was only partly read. More than one
 * eligible row is ambiguity, which the caller refuses; there is no
 * first-match-wins and no general-versus-specific fallback, both of which
 * would let an ineligible row win by being listed first or last.
 */
function selectRoutingRow(
	ir: SpecificationIr,
	role: RoutingRole,
	facts: Readonly<Record<string, string | undefined>>,
): { readonly row: RoutingRow } | { readonly ambiguous: true } | undefined {
	const tables = ir.routing.filter((table) => table.role === role)
	const eligible: RoutingRow[] = []
	for (const table of tables) {
		for (const row of table.rows) {
			if (matchesEveryDiscriminant(table, row, facts)) eligible.push(row)
		}
	}
	if (eligible.length > 1) return { ambiguous: true }
	const row = eligible[0]
	return row === undefined ? undefined : { row }
}

/**
 * Whether one row's complete key holds for the facts a station carries.
 *
 * Reads the table's declared discriminants rather than the row's own keys, so
 * a row that omits one is judged on the full key the table declares. An
 * unsupplied fact fails the row: derivation cannot evaluate it, so the row
 * cannot be known to apply.
 */
function matchesEveryDiscriminant(
	table: RoutingTable,
	row: RoutingRow,
	facts: Readonly<Record<string, string | undefined>>,
): boolean {
	for (const discriminant of Object.keys(table.discriminants)) {
		const required = row.key[discriminant]
		if (required === undefined) return false
		const held = facts[discriminant]
		if (held === undefined || held !== required) return false
	}
	return true
}
