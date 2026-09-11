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
import {
	BRANCH_FACTS,
	projectRetryable,
	resolveRetryPosture,
} from './derivation-facts.ts'
import type {
	ActionEntry,
	ExpectationColumns,
	RoutingRow,
	RoutingTable,
	SpecificationIr,
} from './ir.ts'
import { type ArtifactRefusal, artifactRefusal } from './refusal.ts'
import type {
	BranchKind,
	ChangedState,
	NextSafeActionKind,
	ResultChannel,
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
	/**
	 * What the branch changed, and where its result arrives. Present only on
	 * stations the candidate declares columns for.
	 *
	 * Absent means undeclared, never "nothing changed": `changed_state` has a
	 * declared `unknown` value for the case a caller cannot tell, so a missing
	 * column would otherwise publish `none` as though it were observed. A
	 * product asserts these against a real process only where it admitted
	 * them.
	 */
	readonly changedState?: ChangedState
	readonly channel?: ResultChannel
	/**
	 * The facade's one-way `retryable` projection for this row (ADR 0006).
	 *
	 * Present only where the compiled specification settles every conjunct
	 * `projectRetryable` requires. Absent means the specification does not
	 * settle them, never "false": a consumer must not read an absent
	 * projection as a decided negative, and `retrySafety` remains what
	 * decides safety either way. Nothing reads this back as evidence.
	 */
	readonly retryable?: boolean
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

/** Facts held across one station's row derivation. */
interface StationContext {
	readonly ir: SpecificationIr
	readonly derived: DerivedStation
	readonly facts: (typeof BRANCH_FACTS)[BranchKind]
	readonly incomplete: boolean
}

/** Either a finished row, or the refusal that station produced. */
type RowOutcome =
	| { readonly row: SemanticExpectationRow }
	| { readonly refusal: ArtifactRefusal }

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
	// Keyed by the Branch Station id the candidate declared, so a column
	// reaches a row only where the specification named that exact station.
	// Nothing is inferred from the command, the branch, or the key's shape.
	const declaredColumns = new Map(
		ir.expectationColumns.map((entry) => [entry.name, entry]),
	)

	for (const derived of sortStations(stations)) {
		const outcome = buildRowForStation(ir, derived, catalog, declaredColumns)
		if ('refusal' in outcome) refusals.push(outcome.refusal)
		else rows.push(outcome.row)
	}

	return { rows, refusals }
}

/** Resolves one station to its expectation row, or the refusal that blocks it. */
function buildRowForStation(
	ir: SpecificationIr,
	derived: DerivedStation,
	catalog: ReadonlyMap<string, ActionEntry>,
	declaredColumns: ReadonlyMap<string, ExpectationColumns>,
): RowOutcome {
	const { station, branch } = derived
	const facts = BRANCH_FACTS[branch]
	const ctx: StationContext = {
		ir,
		derived,
		facts,
		incomplete: facts.projectionCompleteness === 'incomplete',
	}

	const declarationRefusal = checkIncompleteResolutionDeclared(ctx)
	if (declarationRefusal !== undefined) return { refusal: declarationRefusal }

	const blockerOutcome = resolveStationBlocker(ctx)
	if ('refusal' in blockerOutcome) return blockerOutcome
	const { blocker, routedAction, routedPosture } = blockerOutcome.value

	const retrySafety = resolveStationRetrySafety(ctx, routedPosture, blocker)
	if (retrySafety === undefined) {
		return {
			refusal: artifactRefusal({
				cause: 'emit_retry_posture_unresolved',
				subject: station.id,
				message: `No declared retry_posture rule matches Branch Station ${station.id} (command ${station.command}, result_kind ${BRANCH_RESULT_KIND[branch]}); Exact Same-Input Retry Safety cannot be derived from exit status or prose.`,
			}),
		}
	}

	const action = routedAction ?? resolveAction(ir, derived, ctx.incomplete)
	if (action === undefined) {
		return {
			refusal: artifactRefusal({
				cause: 'emit_expectation_column_underivable',
				subject: `${station.id}:expectedActionId`,
				message: `Branch Station ${station.id} has no declared action: the candidate's action catalog names no entry this branch can reach, and Input Schema v1 has no per-station action binding.`,
			}),
		}
	}

	const entry = catalog.get(action)
	if (entry === undefined) {
		return {
			refusal: artifactRefusal({
				cause: 'emit_expectation_action_unknown',
				subject: `${station.id}:${action}`,
				message: `Branch Station ${station.id} expects action ${action}, which the action catalog does not declare.`,
			}),
		}
	}

	const stopScope = ctx.incomplete
		? // Agent-terminal by the spec: an incomplete projection stops the
			// current agent and never claims the product itself is finished.
			(ir.actions.resolution?.unavailableProjectionStop ?? 'agent_terminal')
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
		...columnsFor(declaredColumns.get(station.id)),
	}

	const violation = assertIncompleteProjection(row)
	if (violation) return { refusal: violation }

	// Whether a declared station_action binding chose this action, asked at
	// the same seam that resolution uses, so the projection below reads a
	// declaration rather than re-deriving one.
	const stationAction = selectRoutingRow(ir, 'station_action', {
		branch,
		command: station.command,
	})
	const retryable = retryableFor({
		row,
		boundByStationAction: stationAction !== undefined && 'row' in stationAction,
		entry,
		ir,
	})
	return { row: retryable === undefined ? row : { ...row, retryable } }
}

/**
 * An incomplete projection has one admitted meaning, and the candidate
 * declares it under `actions.resolution`. Without that declaration the
 * generator has nothing to publish and must not invent the triple.
 */
function checkIncompleteResolutionDeclared(
	ctx: StationContext,
): ArtifactRefusal | undefined {
	if (!ctx.incomplete) return undefined
	if (ctx.ir.actions.resolution?.unavailableProjectionBlocker !== undefined)
		return undefined
	return artifactRefusal({
		cause: 'emit_expectation_column_underivable',
		subject: `${ctx.derived.station.id}:blocker`,
		message: `Branch Station ${ctx.derived.station.id} projects incompletely, but the candidate declares no actions.resolution.unavailable_projection_blocker to name why.`,
	})
}

interface StationBlockerResolution {
	readonly blocker: string | undefined
	readonly routedAction: string | undefined
	readonly routedPosture: RetryPosture | undefined
}

/**
 * The selected row carries the blocker AND what that blocker routes to, so a
 * mapping's action and posture are taken from the same match rather than
 * resolved separately from a blocker name.
 */
function resolveStationBlocker(
	ctx: StationContext,
):
	| { readonly value: StationBlockerResolution }
	| { readonly refusal: ArtifactRefusal } {
	const { ir, derived, incomplete } = ctx
	const { station, branch } = derived
	const resolution = ir.actions.resolution
	const selected = incomplete
		? undefined
		: blockerRowFor(branch, ir, station.command)

	if (selected !== undefined && 'ambiguous' in selected) {
		return {
			refusal: artifactRefusal({
				cause: 'emit_expectation_column_underivable',
				subject: `${station.id}:blocker`,
				message: `Branch Station ${station.id} matches more than one declared station_blocker row, so no single admitted refusal cause can be named.`,
			}),
		}
	}

	const routedAction =
		selected !== undefined && 'row' in selected ? selected.row.target : undefined
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
		return {
			refusal: artifactRefusal({
				cause: 'emit_expectation_column_underivable',
				subject: `${station.id}:blocker`,
				message: `Branch Station ${station.id} is a refusal, but no declared station_blocker mapping selects for it and the candidate declares no single blocker, so no admitted refusal cause can be named.`,
			}),
		}
	}

	return { value: { blocker, routedAction, routedPosture } }
}

function resolveStationRetrySafety(
	{ ir, derived, facts, incomplete }: StationContext,
	routedPosture: RetryPosture | undefined,
	blocker: string | undefined,
): RetryPosture | undefined {
	if (incomplete) {
		// The spec fixes the incomplete-projection posture as operator-owned. A
		// candidate that also declares it must agree; a disagreement is a
		// specification defect rather than something to silently resolve.
		return ir.actions.resolution?.unavailableProjectionRetrySafety ?? 'operator_required'
	}
	// A declared route's posture is the admitted answer for that route; the
	// rule table answers only where no route selected.
	return (
		routedPosture ??
		resolveRetryPosture(ir, {
			command: derived.station.command,
			resultKind: BRANCH_RESULT_KIND[derived.branch],
			...(blocker === undefined ? {} : { blocker }),
			state: facts.state,
		})
	)
}

/**
 * The `retryable` projection for one finished row, where the specification
 * settles every conjunct ADR 0006 requires (S13).
 *
 * `sameInvocationAsNextSafeAction` is the conjunct that decides whether this
 * can be answered at all. It asks whether the canonical Next Safe Action IS
 * this station's own public invocation, and only a declared `station_action`
 * binding says so: the action catalog carries no action-to-command binding,
 * and `owner` is the Progress Owner, not the invoking command. Matching an
 * action id against the command's spelling would be the naming-convention
 * inference this package has already been bitten by.
 *
 * The remaining conjuncts, once a binding exists:
 *
 * - `posture` and `projectionCompleteness` are already on the row.
 * - `noPrerequisite`: the action declares no required context and no feature
 *   gate, so nothing must happen before repeating it.
 * - `normalizedInputUnchanged`: a station IS one public invocation with one
 *   normalized input, so repeating that station carries the same input by
 *   construction.
 * - `logicalOperationUnchanged`: settled only where the product declares no
 *   durable operations, so no Logical Operation exists for a repeat to
 *   change. A durable-operations product mints identity at runtime, which no
 *   design-time specification decides.
 *
 * Withheld, never false, wherever a conjunct is unsettled. `false` is a
 * decided negative: it says the specification ruled this not retryable.
 * Publishing that from missing evidence is the same fail-open the predicate
 * exists to prevent, read from the other side.
 */
function retryableFor(input: {
	readonly row: SemanticExpectationRow
	readonly boundByStationAction: boolean
	readonly entry: ActionEntry
	readonly ir: SpecificationIr
}): boolean | undefined {
	const { row, boundByStationAction, entry, ir } = input

	// A repeat under durable operations may or may not carry the same Logical
	// Operation; the specification carries no surface that decides it.
	if (ir.features.durableOperations) return undefined

	// Without a declared station_action binding nothing says the Next Safe
	// Action is this same invocation, so the conjunction has no honest answer.
	if (!boundByStationAction) return undefined

	return projectRetryable({
		posture: row.retrySafety,
		projectionCompleteness: row.projectionCompleteness,
		sameInvocationAsNextSafeAction: true,
		normalizedInputUnchanged: true,
		logicalOperationUnchanged: true,
		noPrerequisite:
			entry.requiresContext.length === 0 && entry.requiresFeature === undefined,
	})
}

/**
 * The declared per-station columns, spread onto a row.
 *
 * Each column is emitted only when the candidate declared that column for
 * that exact station. An undeclared column is omitted rather than defaulted:
 * `changed_state` has a declared `unknown` member for "the caller cannot
 * tell", so filling an absent column with `none` would publish a claim the
 * specification never made.
 */
function columnsFor(declared: ExpectationColumns | undefined): {
	readonly changedState?: ChangedState
	readonly channel?: ResultChannel
} {
	if (declared === undefined) return {}
	return {
		...(declared.changedState === undefined
			? {}
			: { changedState: declared.changedState }),
		...(declared.channel === undefined ? {} : { channel: declared.channel }),
	}
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
