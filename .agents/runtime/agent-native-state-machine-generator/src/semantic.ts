/**
 * Semantic validation: is a structurally valid candidate safe to admit?
 *
 * These are the rejection causes the specification names. Each check is
 * feature-conditioned where the ruling requires it: a product whose `features`
 * flags disable durable machinery is never asked to supply it.
 */
import {
	compareCodepoints,
	isSupportedInputSchemaVersion,
	SUPPORTED_INPUT_SCHEMA_VERSIONS,
} from './canonical.ts'
import type { Diagnostic } from './diagnostics.ts'
import type { JsoncEntry, JsoncNode } from './jsonc.ts'
import { registeredReaderFor } from './registered-readers.ts'
import {
	BASELINE_EXIT_CODES,
	MUTATION_KINDS,
	NEXT_SAFE_ACTION_KINDS,
	RETRY_POSTURES,
	WRITE_IMPLYING_MUTATIONS,
} from './schema.ts'

/**
 * Mutation kinds that declare an externally meaningful effect, and the full
 * sealed mutation vocabulary. Both are owned by `schema.ts` so validation and
 * emission cannot disagree about which commands imply a write.
 */
const WRITE_MUTATIONS = new Set<string>(WRITE_IMPLYING_MUTATIONS)
const MUTATION_VALUES = new Set<string>(MUTATION_KINDS)

/**
 * How many uncovered key combinations one diagnostic names.
 *
 * Enough to show the shape of what is missing without letting a wide table's
 * key space set the size of the output.
 */
const UNROUTED_SAMPLE_SIZE = 5

/** `result_kind` values the candidates branch on in the retry table. */
const RESULT_KINDS = new Set(['inspection', 'success', 'refusal', 'any_other'])

class Cursor {
	constructor(private readonly root: JsoncNode) {}

	node(path: readonly (string | number)[]): JsoncNode | undefined {
		let current: JsoncNode | undefined = this.root
		for (const step of path) {
			if (current === undefined) return undefined
			if (typeof step === 'number') {
				current = current.kind === 'array' ? current.items[step] : undefined
				continue
			}
			current =
				current.kind === 'object' ? entryOf(current, step)?.value : undefined
		}
		return current
	}

	/** Location of a key itself, so a diagnostic points at the offending key. */
	keyLoc(path: readonly (string | number)[]): JsoncNode['loc'] {
		const parent = this.node(path.slice(0, -1))
		const last = path[path.length - 1]
		if (parent?.kind === 'object' && typeof last === 'string') {
			const entry = entryOf(parent, last)
			if (entry !== undefined) return entry.keyLoc
		}
		return this.node(path)?.loc ?? this.root.loc
	}

	loc(path: readonly (string | number)[]): JsoncNode['loc'] {
		return this.node(path)?.loc ?? this.root.loc
	}

	strings(path: readonly (string | number)[]): string[] {
		const node = this.node(path)
		if (node?.kind !== 'array') return []
		return node.items.flatMap((item) =>
			item.kind === 'string' ? [item.value] : [],
		)
	}

	string(path: readonly (string | number)[]): string | undefined {
		const node = this.node(path)
		return node?.kind === 'string' ? node.value : undefined
	}

	bool(path: readonly (string | number)[]): boolean | undefined {
		const node = this.node(path)
		return node?.kind === 'boolean' ? node.value : undefined
	}

	entries(path: readonly (string | number)[]): readonly JsoncEntry[] {
		const node = this.node(path)
		return node?.kind === 'object' ? node.entries : []
	}

	items(path: readonly (string | number)[]): readonly JsoncNode[] {
		const node = this.node(path)
		return node?.kind === 'array' ? node.items : []
	}

	has(path: readonly (string | number)[]): boolean {
		return this.node(path) !== undefined
	}
}

function entryOf(node: JsoncNode, key: string): JsoncEntry | undefined {
	return node.kind === 'object'
		? node.entries.find((entry) => entry.key === key)
		: undefined
}

/** Shared state threaded through the individual semantic checks. */
interface SemanticCheckScope {
	readonly cursor: Cursor
	readonly report: (
		cause: Diagnostic['cause'],
		message: string,
		path: string,
		location: JsoncNode['loc'],
	) => void
	readonly features: {
		readonly durableOperations: boolean
		readonly livenessEvidence: boolean
		readonly versionCustody: boolean
		readonly remoteAuthority: boolean
		readonly cancellation: string
	}
	/** Every action id the catalog declares; filled by the catalog check. */
	readonly actionIds: Set<string>
}

/**
 * Reports every value a declared list repeats.
 *
 * The location is the list itself, not the repeat: a repeated entry has no
 * distinguishing position a reader could act on, so pointing at the list is
 * what makes the repair obvious.
 */
function reportRepeatedValues(
	report: SemanticCheckScope['report'],
	values: readonly string[],
	describe: (duplicate: string) => string,
	path: string,
	location: JsoncNode['loc'],
): void {
	for (const [index, value] of values.entries()) {
		if (values.indexOf(value) === index) continue
		report('semantic_duplicate_id', describe(value), path, location)
	}
}

/**
 * Reports every item whose id was already claimed by an earlier item, and
 * returns the ids it saw.
 *
 * Unlike a repeated list value, a duplicate id has a position worth naming, so
 * each report points at the offending item rather than at the collection. The
 * caller supplies `seen` when the ids must stay visible to later checks; the
 * action catalog does this so reference checks can resolve against it.
 */
function reportDuplicateIds(
	{ cursor, report }: SemanticCheckScope,
	collection: readonly string[],
	describe: (id: string) => string,
	seen: Set<string> = new Set(),
): Set<string> {
	const path = collection.join('.')
	cursor.items(collection).forEach((_item, index) => {
		const id = cursor.string([...collection, index, 'id'])
		if (id === undefined) return
		if (seen.has(id)) {
			report(
				'semantic_duplicate_id',
				describe(id),
				`${path}[${index}].id`,
				cursor.loc([...collection, index, 'id']),
			)
		}
		seen.add(id)
	})
	return seen
}

/**
 * Runs every semantic check and returns all diagnostics.
 *
 * The checks share a cursor and a report callback rather than each re-walking
 * the tree, and run in a fixed order so identity is established before the
 * reference checks that depend on it.
 */
export function validateSemantics(
	root: JsoncNode,
	sourcePath?: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const cursor = new Cursor(root)

	const report = (
		cause: Diagnostic['cause'],
		message: string,
		path: string,
		location: JsoncNode['loc'],
	): void => {
		diagnostics.push({
			cause,
			stage: 'semantic',
			message,
			path,
			location,
			...(sourcePath === undefined ? {} : { sourcePath }),
		})
	}

	const features = {
		durableOperations: cursor.bool(['features', 'durable_operations']) ?? false,
		livenessEvidence: cursor.bool(['features', 'liveness_evidence']) ?? false,
		versionCustody: cursor.bool(['features', 'version_custody']) ?? false,
		remoteAuthority: cursor.bool(['features', 'remote_authority']) ?? false,
		cancellation:
			cursor.string(['features', 'cancellation']) ?? 'not_supported',
	}

	const scope: SemanticCheckScope = {
		cursor,
		report,
		features,
		actionIds: new Set<string>(),
	}

	// Version custody runs first: if the candidate is written against an Input
	// Schema Version this compiler does not admit, every later check would be
	// judging it against the wrong surface.
	checkInputSchemaVersion(scope)
	if (diagnostics.length > 0) return diagnostics

	checkActionCatalog(scope)
	checkReferences(scope)
	checkTransitionTargets(scope)
	checkRouting(scope)
	checkObservations(scope)
	checkCapabilities(scope)
	checkPauseModes(scope)
	checkCommandSurfaceV2(scope)
	checkStateVocabularies(scope)
	checkRetryPosture(scope)
	checkAuthorityAndSideEffects(scope)
	checkIdentityAndFeatureConditioning(scope)

	return diagnostics
}

/**
 * Input Schema Version custody: exact match against the supported set.
 *
 * Compatibility is never inferred from semantic version ordering, successful
 * parsing, or structural similarity, so no comparison is made beyond set
 * membership. A candidate declaring an unsupported version is refused with no
 * output rather than compiled against a surface it was not written for.
 */
function checkInputSchemaVersion(scope: SemanticCheckScope): void {
	const { cursor, report } = scope
	const path = ['spec_meta', 'input_schema_version'] as const
	const declared = cursor.string([...path])
	// Structural validation already refused a missing or non-string value.
	if (declared === undefined) return
	if (isSupportedInputSchemaVersion(declared)) return

	report(
		'semantic_unsupported_schema_version',
		`Input Schema Version ${JSON.stringify(declared)} is not admitted. The supported versions are ${SUPPORTED_INPUT_SCHEMA_VERSIONS.map((version) => JSON.stringify(version)).join(', ')}, matched exactly.`,
		'spec_meta.input_schema_version',
		cursor.loc([...path]),
	)
}

/** Action identity, per-kind mandatory semantics, and competing Next Safe Actions. */
function checkActionCatalog(scope: SemanticCheckScope): void {
	const { cursor, report, actionIds } = scope
	const catalog = cursor.items(['actions', 'catalog'])
	const declaredKinds = new Set(cursor.strings(['actions', 'kinds']))

	// Identity first, and over every entry that declares an id: an entry whose
	// `kind` is missing still competes for its id, and the per-kind checks below
	// skip it. `actionIds` is threaded in so the reference checks that run after
	// this one resolve against the catalog this call populates.
	reportDuplicateIds(
		scope,
		['actions', 'catalog'],
		(id) =>
			`Duplicate action id ${JSON.stringify(id)}. Every Next Safe Action id must be unique; two entries competing for one id leave the Next Safe Action ambiguous.`,
		actionIds,
	)

	catalog.forEach((_item, index) => {
		const base = ['actions', 'catalog', index] as const
		const id = cursor.string([...base, 'id'])
		const kind = cursor.string([...base, 'kind'])
		if (id === undefined || kind === undefined) return

		if (!declaredKinds.has(kind)) {
			report(
				'semantic_unresolved_reference',
				`Action ${JSON.stringify(id)} uses kind ${JSON.stringify(kind)}, which is not declared in actions.kinds.`,
				`actions.catalog[${index}].kind`,
				cursor.loc([...base, 'kind']),
			)
		}

		// Missing action semantics: each sealed kind carries a mandatory payload.
		if (
			kind === 'none' &&
			cursor.string([...base, 'stop_scope']) === undefined
		) {
			report(
				'semantic_missing_action_semantics',
				`Action ${JSON.stringify(id)} has kind "none" but declares no stop_scope. Stop Scope must state whether the product is domain_terminal or only the current agent is agent_terminal.`,
				`actions.catalog[${index}]`,
				cursor.keyLoc([...base, 'id']),
			)
		}
		if (
			kind === 'needs_human' &&
			cursor.string([...base, 'human_kind']) === undefined
		) {
			report(
				'semantic_missing_action_semantics',
				`Action ${JSON.stringify(id)} has kind "needs_human" but declares no human_kind.`,
				`actions.catalog[${index}]`,
				cursor.keyLoc([...base, 'id']),
			)
		}
		if (kind === 'wait') {
			for (const required of ['condition', 'owner'] as const) {
				if (cursor.string([...base, required]) === undefined) {
					report(
						'semantic_missing_action_semantics',
						`Action ${JSON.stringify(id)} has kind "wait" but declares no ${required}. A wait must name its condition and Progress Owner so healthy work never becomes terminal.`,
						`actions.catalog[${index}]`,
						cursor.keyLoc([...base, 'id']),
					)
				}
			}
		}

		const requiresFeature = cursor.string([...base, 'requires_feature'])
		if (
			requiresFeature !== undefined &&
			!cursor.strings(['features', 'feature_gates']).includes(requiresFeature)
		) {
			report(
				'semantic_unresolved_reference',
				`Action ${JSON.stringify(id)} requires feature gate ${JSON.stringify(requiresFeature)}, which features.feature_gates does not declare.`,
				`actions.catalog[${index}].requires_feature`,
				cursor.loc([...base, 'requires_feature']),
			)
		}

		const externalOwners = cursor.strings(['actions', 'external_owners'])
		const owner = cursor.string([...base, 'owner'])
		if (
			owner !== undefined &&
			externalOwners.length > 0 &&
			!externalOwners.includes(owner)
		) {
			report(
				'semantic_unresolved_reference',
				`Action ${JSON.stringify(id)} names owner ${JSON.stringify(owner)}, which actions.external_owners does not declare.`,
				`actions.catalog[${index}].owner`,
				cursor.loc([...base, 'owner']),
			)
		}
	})

	// A selectable Next Safe Action must exist, and exactly one terminal "none".
	const noneEntries = catalog.flatMap((_item, index) => {
		const kind = cursor.string(['actions', 'catalog', index, 'kind'])
		const stop = cursor.string(['actions', 'catalog', index, 'stop_scope'])
		return kind === 'none' && stop === 'domain_terminal' ? [index] : []
	})
	if (noneEntries.length > 1) {
		const [, ...rest] = noneEntries
		for (const index of rest) {
			report(
				'semantic_competing_actions',
				`More than one action declares kind "none" with stop_scope "domain_terminal". Exactly one action owns the terminal Next Safe Action; competing terminal actions leave ranking undecided.`,
				`actions.catalog[${index}]`,
				cursor.keyLoc(['actions', 'catalog', index, 'id']),
			)
		}
	}
}

/**
 * Builds the blocker-reference check shared by the reference and retry passes.
 * Both resolve against the one `blockers` vocabulary the specification declares.
 */
function blockerResolver(
	cursor: Cursor,
	report: SemanticCheckScope['report'],
): (
	value: string | undefined,
	path: string,
	location: JsoncNode['loc'],
	label: string,
) => void {
	const blockers = new Set(cursor.strings(['blockers']))
	return (value, path, location, label) => {
		if (value === undefined || blockers.has(value)) return
		report(
			'semantic_unresolved_reference',
			`${label} references blocker ${JSON.stringify(value)}, which the blockers vocabulary does not declare.`,
			path,
			location,
		)
	}
}

/** Every cross-reference must resolve into the vocabulary that owns it. */
function checkReferences({
	cursor,
	report,
	actionIds,
}: SemanticCheckScope): void {
	const resolveAction = (
		value: string | undefined,
		path: string,
		location: JsoncNode['loc'],
		label: string,
	): void => {
		if (value === undefined || actionIds.has(value)) return
		report(
			'semantic_unresolved_reference',
			`${label} references action ${JSON.stringify(value)}, which the action catalog does not declare.`,
			path,
			location,
		)
	}
	const resolveBlocker = blockerResolver(cursor, report)

	for (const entry of cursor.entries(['activation', 'cause_to_next_action'])) {
		const path = ['activation', 'cause_to_next_action', entry.key] as const
		if (
			!cursor.strings(['activation', 'restriction_causes']).includes(entry.key)
		) {
			report(
				'semantic_unresolved_reference',
				`activation.cause_to_next_action maps ${JSON.stringify(entry.key)}, which activation.restriction_causes does not declare.`,
				path.join('.'),
				entry.keyLoc,
			)
		}
		resolveAction(
			entry.value.kind === 'string' ? entry.value.value : undefined,
			path.join('.'),
			entry.value.loc,
			'activation.cause_to_next_action',
		)
	}

	for (const entry of cursor.entries(['actions', 'contextual_renderings'])) {
		if (entry.value.kind !== 'array') continue
		entry.value.items.forEach((item, index) => {
			if (item.kind !== 'string') return
			resolveAction(
				item.value,
				`actions.contextual_renderings.${entry.key}[${index}]`,
				item.loc,
				'actions.contextual_renderings',
			)
		})
	}

	resolveBlocker(
		cursor.string(['actions', 'resolution', 'unavailable_projection_blocker']),
		'actions.resolution.unavailable_projection_blocker',
		cursor.loc(['actions', 'resolution', 'unavailable_projection_blocker']),
		'actions.resolution',
	)

	for (const entry of cursor.entries(['authority', 'capability_errors'])) {
		const base = ['authority', 'capability_errors', entry.key] as const
		resolveBlocker(
			cursor.string([...base, 'blocker']),
			`${base.join('.')}.blocker`,
			cursor.loc([...base, 'blocker']),
			'authority.capability_errors',
		)
		resolveAction(
			cursor.string([...base, 'next']),
			`${base.join('.')}.next`,
			cursor.loc([...base, 'next']),
			'authority.capability_errors',
		)
		for (const role of cursor.entries([...base, 'next_by_role'])) {
			resolveAction(
				role.value.kind === 'string' ? role.value.value : undefined,
				`${base.join('.')}.next_by_role.${role.key}`,
				role.value.loc,
				'authority.capability_errors.next_by_role',
			)
		}
	}

	resolveBlocker(
		cursor.string(['authority', 'quarantine', 'blocker']),
		'authority.quarantine.blocker',
		cursor.loc(['authority', 'quarantine', 'blocker']),
		'authority.quarantine',
	)
	resolveAction(
		cursor.string(['authority', 'quarantine', 'next']),
		'authority.quarantine.next',
		cursor.loc(['authority', 'quarantine', 'next']),
		'authority.quarantine',
	)
	cursor
		.items(['authority', 'stale_lease_takeover', 'failure_blockers'])
		.forEach((item, index) => {
			if (item.kind !== 'string') return
			resolveBlocker(
				item.value,
				`authority.stale_lease_takeover.failure_blockers[${index}]`,
				item.loc,
				'authority.stale_lease_takeover',
			)
		})
}

/**
 * Transitions must land on a declared phase of the declared phase state.
 *
 * The phase-bearing state is whichever one `phase_state` names. It is never
 * inferred: a candidate that declares transitions without naming the state
 * they target is refused rather than judged against a state the generator
 * picked for it (Agent Worktree draft gap row 14).
 *
 * Legacy input reaches this check having been given the historical binding by
 * its Registered Reader, so a v1 candidate keeps the frozen `transaction_phase`
 * meaning and no new mapping is invented for it.
 */
function checkTransitionTargets({ cursor, report }: SemanticCheckScope): void {
	const transitions = cursor.items(['transitions'])
	if (transitions.length === 0) return

	// A Registered Reader supplies its version's frozen binding, so legacy
	// input keeps the meaning it was admitted under without declaring a field
	// that did not exist when it was written.
	const reader = registeredReaderFor(
		cursor.string(['spec_meta', 'input_schema_version']) ?? '',
	)
	const declaredName =
		cursor.string(['phase_state']) ?? reader?.frozenPhaseState
	if (declaredName === undefined) {
		report(
			'semantic_missing_phase_state',
			'The candidate declares transitions but no phase_state, so no declared state owns the phases they target.',
			'phase_state',
			cursor.loc(['transitions']),
		)
		return
	}

	// A frozen binding names a state the legacy candidate may not declare. That
	// is the historical behavior - the check was dormant for those candidates -
	// and re-admitting them under a new judgement is not this reader's job.
	if (
		cursor.string(['phase_state']) === undefined &&
		reader !== undefined &&
		!new Set(cursor.entries(['states']).map((entry) => entry.key)).has(
			declaredName,
		)
	)
		return

	const stateNames = new Set(
		cursor.entries(['states']).map((entry) => entry.key),
	)
	if (!stateNames.has(declaredName)) {
		report(
			'semantic_unresolved_reference',
			`phase_state names ${JSON.stringify(declaredName)}, which states does not declare.`,
			'phase_state',
			cursor.loc(['phase_state']),
		)
		return
	}

	const values = new Set(cursor.strings(['states', declaredName, 'values']))
	transitions.forEach((_item, index) => {
		const toPhase = cursor.string(['transitions', index, 'to_phase'])
		if (toPhase !== undefined && !values.has(toPhase)) {
			report(
				'semantic_unresolved_reference',
				`Transition ${index} targets phase ${JSON.stringify(toPhase)}, which states.${declaredName}.values does not declare.`,
				`transitions[${index}].to_phase`,
				cursor.loc(['transitions', index, 'to_phase']),
			)
		}
	})
}

/** State values, their declared subsets, and projection totality. */
function checkStateVocabularies({ cursor, report }: SemanticCheckScope): void {
	for (const stateEntry of cursor.entries(['states'])) {
		const base = ['states', stateEntry.key] as const
		const values = cursor.strings([...base, 'values'])
		const valueSet = new Set(values)

		reportRepeatedValues(
			report,
			values,
			(duplicate) =>
				`State ${JSON.stringify(stateEntry.key)} declares value ${JSON.stringify(duplicate)} more than once.`,
			`states.${stateEntry.key}.values`,
			cursor.loc([...base, 'values']),
		)

		for (const subset of [
			'terminal',
			'human_terminal',
			'absorbing',
			'observation_sourced',
			'durable_subset_excludes',
		] as const) {
			cursor.items([...base, subset]).forEach((item, index) => {
				if (item.kind !== 'string' || valueSet.has(item.value)) return
				report(
					'semantic_unresolved_reference',
					`states.${stateEntry.key}.${subset} names ${JSON.stringify(item.value)}, which is not one of that state's declared values.`,
					`states.${stateEntry.key}.${subset}[${index}]`,
					item.loc,
				)
			})
		}

		// A declared phase-to-state projection must be total over the source phases.
		const projection = cursor.entries([...base, 'projection_from_phase'])
		if (projection.length > 0) {
			// The source phases are the declared phase state's values. Totality
			// is checked against what the product declared it projects from,
			// never against a state found by matching the table's own keys: a
			// table missing a row would then define away the gap it is missing
			// (gap row 14). A candidate that declares no phase state has no
			// source to be total against, and checkTransitionTargets already
			// refuses that when it matters.
			const declaredPhaseState =
				cursor.string(['phase_state']) ??
				registeredReaderFor(
					cursor.string(['spec_meta', 'input_schema_version']) ?? '',
				)?.frozenPhaseState
			const sourcePhases =
				declaredPhaseState === undefined
					? []
					: cursor.strings(['states', declaredPhaseState, 'values'])
			const covered = new Set(projection.map((entry) => entry.key))
			for (const phase of sourcePhases) {
				if (covered.has(phase)) continue
				report(
					'semantic_incomplete_projection',
					`states.${stateEntry.key}.projection_from_phase does not map phase ${JSON.stringify(phase)}. A partial projection would leave that phase without a safe interpretation.`,
					`states.${stateEntry.key}.projection_from_phase`,
					cursor.keyLoc([...base, 'projection_from_phase']),
				)
			}
			for (const entry of projection) {
				if (entry.value.kind !== 'string' || valueSet.has(entry.value.value))
					continue
				report(
					'semantic_unresolved_reference',
					`states.${stateEntry.key}.projection_from_phase maps ${JSON.stringify(entry.key)} to ${JSON.stringify(entry.value.value)}, which is not a declared value of that state.`,
					`states.${stateEntry.key}.projection_from_phase.${entry.key}`,
					entry.value.loc,
				)
			}
		}
	}
}

/** Retry vocabulary, rule resolution, and unsafe default postures. */
function checkRetryPosture({ cursor, report }: SemanticCheckScope): void {
	const resolveBlocker = blockerResolver(cursor, report)

	const retryValues = cursor.strings(['retry_posture', 'values'])
	for (const value of retryValues) {
		if (RETRY_POSTURES.includes(value as (typeof RETRY_POSTURES)[number]))
			continue
		report(
			'semantic_free_text_branch_value',
			`retry_posture.values declares ${JSON.stringify(value)}, which is outside the sealed retry posture vocabulary [${RETRY_POSTURES.join(', ')}].`,
			'retry_posture.values',
			cursor.loc(['retry_posture', 'values']),
		)
	}

	const retryRules = cursor.items(['retry_posture', 'rules'])
	retryRules.forEach((_item, index) => {
		const base = ['retry_posture', 'rules', index] as const
		const then = cursor.string([...base, 'then'])
		if (then !== undefined && !retryValues.includes(then)) {
			report(
				'semantic_unresolved_reference',
				`retry_posture.rules[${index}] resolves to ${JSON.stringify(then)}, which retry_posture.values does not declare.`,
				`retry_posture.rules[${index}].then`,
				cursor.loc([...base, 'then']),
			)
		}
		const when = cursor.entries([...base, 'when'])
		if (when.length === 0) {
			report(
				'semantic_unsafe_retry_declaration',
				`retry_posture.rules[${index}] has an empty condition, so it would match every result and silently outrank later rules.`,
				`retry_posture.rules[${index}].when`,
				cursor.keyLoc([...base, 'when']),
			)
		}
		// Branch values must come from a sealed vocabulary, never free text.
		const resultKind = cursor.string([...base, 'when', 'result_kind'])
		if (resultKind !== undefined && !RESULT_KINDS.has(resultKind)) {
			report(
				'semantic_free_text_branch_value',
				`retry_posture.rules[${index}] branches on result_kind ${JSON.stringify(resultKind)}, which is not one of [${[...RESULT_KINDS].join(', ')}]. Branch values must come from a sealed vocabulary.`,
				`retry_posture.rules[${index}].when.result_kind`,
				cursor.loc([...base, 'when', 'result_kind']),
			)
		}
		resolveBlocker(
			cursor.string([...base, 'when', 'blocker']),
			`retry_posture.rules[${index}].when.blocker`,
			cursor.loc([...base, 'when', 'blocker']),
			`retry_posture.rules[${index}]`,
		)
		const command = cursor.string([...base, 'when', 'command'])
		if (
			command !== undefined &&
			!cursor.strings(['command_surface', 'commands']).includes(command)
		) {
			report(
				'semantic_unresolved_reference',
				`retry_posture.rules[${index}] branches on command ${JSON.stringify(command)}, which command_surface.commands does not declare.`,
				`retry_posture.rules[${index}].when.command`,
				cursor.loc([...base, 'when', 'command']),
			)
		}
	})

	// An effectful surface must not default to same-input-safe retry.
	const writeCommands = cursor
		.entries(['command_surface', 'mutations'])
		.filter(
			(entry) =>
				entry.value.kind === 'string' && WRITE_MUTATIONS.has(entry.value.value),
		)
	if (writeCommands.length > 0) {
		const catchAll = retryRules.findIndex((_item, index) => {
			const when = cursor.entries(['retry_posture', 'rules', index, 'when'])
			const then = cursor.string(['retry_posture', 'rules', index, 'then'])
			const isCatchAll =
				when.length === 1 &&
				when[0]?.key === 'result_kind' &&
				cursor.string([
					'retry_posture',
					'rules',
					index,
					'when',
					'result_kind',
				]) === 'any_other'
			return isCatchAll && then === 'same_input_safe'
		})
		if (catchAll !== -1) {
			// Guarding is per command: one covered command does not vouch for the
			// rest. Every write-effect command needs its own earlier non-safe rule
			// before a catch-all safe posture is legal.
			const guardedCommands = new Set(
				retryRules.flatMap((_item, index) => {
					if (index >= catchAll) return []
					const then = cursor.string(['retry_posture', 'rules', index, 'then'])
					const command = cursor.string([
						'retry_posture',
						'rules',
						index,
						'when',
						'command',
					])
					return then !== 'same_input_safe' && command !== undefined
						? [command]
						: []
				}),
			)
			const unguarded = writeCommands.filter(
				(entry) => !guardedCommands.has(entry.key),
			)
			if (unguarded.length > 0) {
				report(
					'semantic_unsafe_retry_declaration',
					`retry_posture declares a catch-all "same_input_safe" posture while command_surface declares effectful commands [${unguarded
						.map((entry) => entry.key)
						.join(
							', ',
						)}] with no earlier rule constraining them. Retry safety must be derived from durable evidence, never defaulted over an effectful surface.`,
					`retry_posture.rules[${catchAll}]`,
					cursor.keyLoc(['retry_posture', 'rules', catchAll, 'then']),
				)
			}
		}
	}

	cursor.items(['retry_posture', 'never_auto_retry']).forEach((item, index) => {
		if (item.kind !== 'string' || item.value.trim() !== '') return
		report(
			'semantic_unsafe_retry_declaration',
			`retry_posture.never_auto_retry[${index}] is empty, so it names no condition.`,
			`retry_posture.never_auto_retry[${index}]`,
			item.loc,
		)
	})
}

/** Who may write, and what each command and exit actually means. */
function checkAuthorityAndSideEffects({
	cursor,
	report,
	features,
}: SemanticCheckScope): void {
	if (cursor.string(['authority', 'write_authority_owner']) === undefined) {
		report(
			'semantic_missing_authority_semantics',
			`authority.write_authority_owner is required: every product must name who owns permission to write.`,
			'authority.write_authority_owner',
			cursor.keyLoc(['authority']),
		)
	}

	// Feature-conditioned: only a remote-authority product must resolve leases.
	if (
		features.remoteAuthority &&
		!cursor.has(['authority', 'lease_expiry_grants'])
	) {
		report(
			'semantic_missing_authority_semantics',
			`features.remote_authority is true but authority.lease_expiry_grants is absent. A remote-authority product must state what lease expiry grants, so expiry never silently grants takeover.`,
			'authority.lease_expiry_grants',
			cursor.keyLoc(['authority']),
		)
	}

	const commands = cursor.strings(['command_surface', 'commands'])
	const mutationEntries = cursor.entries(['command_surface', 'mutations'])
	for (const entry of mutationEntries) {
		if (!commands.includes(entry.key)) {
			report(
				'semantic_unresolved_reference',
				`command_surface.mutations declares ${JSON.stringify(entry.key)}, which command_surface.commands does not list.`,
				`command_surface.mutations.${entry.key}`,
				entry.keyLoc,
			)
			continue
		}
		if (
			entry.value.kind === 'string' &&
			!MUTATION_VALUES.has(entry.value.value)
		) {
			report(
				'semantic_free_text_branch_value',
				`command_surface.mutations.${entry.key} declares side effect ${JSON.stringify(entry.value.value)}, which is not one of the sealed effect kinds [${[...MUTATION_VALUES].sort().join(', ')}].`,
				`command_surface.mutations.${entry.key}`,
				entry.value.loc,
			)
		}
	}

	for (const entry of cursor.entries(['command_surface', 'flags'])) {
		if (commands.includes(entry.key)) continue
		report(
			'semantic_unresolved_reference',
			`command_surface.flags declares flags for ${JSON.stringify(entry.key)}, which command_surface.commands does not list.`,
			`command_surface.flags.${entry.key}`,
			entry.keyLoc,
		)
	}

	for (const entry of cursor.entries([
		'command_surface',
		'output_modes_overrides',
	])) {
		if (commands.includes(entry.key)) continue
		report(
			'semantic_unresolved_reference',
			`command_surface.output_modes_overrides declares ${JSON.stringify(entry.key)}, which command_surface.commands does not list.`,
			`command_surface.output_modes_overrides.${entry.key}`,
			entry.keyLoc,
		)
	}

	reportRepeatedValues(
		report,
		commands,
		(duplicate) =>
			`command_surface.commands lists ${JSON.stringify(duplicate)} more than once.`,
		'command_surface.commands',
		cursor.loc(['command_surface', 'commands']),
	)

	// Baseline exit meanings must be declared; an undeclared exit is unroutable.
	for (const code of BASELINE_EXIT_CODES) {
		if (cursor.string(['command_surface', 'exit_codes', code]) !== undefined)
			continue
		report(
			'semantic_missing_side_effect_semantics',
			`command_surface.exit_codes does not declare exit ${code}. The baseline success, refusal and invalid-usage exits must each carry a stable meaning.`,
			'command_surface.exit_codes',
			cursor.keyLoc(['command_surface', 'exit_codes']),
		)
	}
}

/** Unique ids, and machinery that agrees with the feature flags in both directions. */
function checkIdentityAndFeatureConditioning(scope: SemanticCheckScope): void {
	const { cursor, report, features } = scope
	reportDuplicateIds(
		scope,
		['invariants'],
		(id) => `Duplicate invariant id ${JSON.stringify(id)}.`,
	)
	reportDuplicateIds(
		scope,
		['unresolved_decisions'],
		(id) => `Duplicate unresolved_decisions id ${JSON.stringify(id)}.`,
	)

	// Feature-conditioning, both directions. A product that disables durable
	// machinery must not declare it; one that enables it must supply it.
	if (!features.durableOperations) {
		if (cursor.entries(['entities']).length > 0) {
			report(
				'semantic_feature_machinery_conflict',
				`features.durable_operations is false but entities declares durable entities. A product that disables durable operations must not inherit durable machinery.`,
				'entities',
				cursor.keyLoc(['entities']),
			)
		}
		if (cursor.strings(['acknowledgement', 'values']).length > 0) {
			report(
				'semantic_feature_machinery_conflict',
				`features.durable_operations is false but acknowledgement.values declares an Acknowledgement vocabulary. There is nothing durable to acknowledge.`,
				'acknowledgement.values',
				cursor.keyLoc(['acknowledgement', 'values']),
			)
		}
		if (cursor.entries(['versioning', 'records']).length > 0) {
			report(
				'semantic_feature_machinery_conflict',
				`features.durable_operations is false but versioning.records declares durable record versions.`,
				'versioning.records',
				cursor.keyLoc(['versioning', 'records']),
			)
		}
	} else if (cursor.strings(['acknowledgement', 'values']).length === 0) {
		report(
			'semantic_feature_machinery_conflict',
			`features.durable_operations is true but acknowledgement.values is empty. A durable product must state how a Logical Operation is acknowledged, or unknown outcomes have no interpretation.`,
			'acknowledgement.values',
			cursor.keyLoc(['acknowledgement', 'values']),
		)
	}

	// Version custody, like the other feature-conditioned sections, must agree
	// with its flag in both directions.
	if (
		!features.versionCustody &&
		cursor.node(['versioning', 'incompatible_run_policy'])?.kind === 'object'
	) {
		report(
			'semantic_feature_machinery_conflict',
			`features.version_custody is false but versioning.incompatible_run_policy declares a refusal policy. A product without version custody must not inherit version machinery.`,
			'versioning.incompatible_run_policy',
			cursor.keyLoc(['versioning', 'incompatible_run_policy']),
		)
	}

	if (
		!features.livenessEvidence &&
		cursor.entries(['waits', 'budgets_ms']).length > 0
	) {
		report(
			'semantic_feature_machinery_conflict',
			`features.liveness_evidence is false but waits.budgets_ms declares deadlines. A product without liveness evidence must not inherit deadline machinery.`,
			'waits.budgets_ms',
			cursor.keyLoc(['waits', 'budgets_ms']),
		)
	}

	for (const entry of cursor.entries(['waits', 'missed_deadline_causes'])) {
		if (cursor.has(['waits', 'budgets_ms', entry.key])) continue
		report(
			'semantic_unresolved_reference',
			`waits.missed_deadline_causes names budget ${JSON.stringify(entry.key)}, which waits.budgets_ms does not declare.`,
			`waits.missed_deadline_causes.${entry.key}`,
			entry.keyLoc,
		)
	}

	// Cancellation must agree with its feature flag in both directions.
	const cancellationEntries = cursor.entries(['cancellation'])
	if (features.cancellation === 'not_supported') {
		for (const entry of cancellationEntries) {
			if (
				entry.value.kind === 'string' &&
				entry.value.value === 'not_supported'
			)
				continue
			report(
				'semantic_feature_machinery_conflict',
				`features.cancellation is "not_supported" but cancellation.${entry.key} declares a lifecycle. An unsupported feature must not carry placeholder machinery.`,
				`cancellation.${entry.key}`,
				entry.keyLoc,
			)
		}
	}

	// Sealed kind vocabulary: actions.kinds itself must not invent a kind.
	cursor.items(['actions', 'kinds']).forEach((item, index) => {
		if (item.kind !== 'string') return
		if (
			NEXT_SAFE_ACTION_KINDS.includes(
				item.value as (typeof NEXT_SAFE_ACTION_KINDS)[number],
			)
		)
			return
		report(
			'semantic_free_text_branch_value',
			`actions.kinds declares ${JSON.stringify(item.value)}, which is outside the sealed Next Safe Action vocabulary [${NEXT_SAFE_ACTION_KINDS.join(', ')}].`,
			`actions.kinds[${index}]`,
			item.loc,
		)
	})

	// A projection that can fail must say how it fails, or it defaults to continuing.
	if (cursor.has(['actions', 'resolution'])) {
		for (const required of [
			'unavailable_projection_retry_safety',
			'unavailable_projection_stop',
		] as const) {
			if (cursor.string(['actions', 'resolution', required]) !== undefined)
				continue
			report(
				'semantic_incomplete_projection',
				`actions.resolution declares a missing-context path but no ${required}. An incomplete projection must deny Authority and stop fail-closed rather than defaulting to a Next Safe Action that continues.`,
				`actions.resolution.${required}`,
				cursor.keyLoc(['actions', 'resolution']),
			)
		}
	}
}

/** The declared kind of one catalog action, or undefined when it is absent. */
function actionKindOf(cursor: Cursor, id: string): string | undefined {
	const index = cursor
		.items(['actions', 'catalog'])
		.findIndex(
			(_item, position) =>
				cursor.string(['actions', 'catalog', position, 'id']) === id,
		)
	return index === -1
		? undefined
		: cursor.string(['actions', 'catalog', index, 'kind'])
}

/**
 * Command-surface v2 surfaces: positional routes, root branches, and the
 * per-branch expectation columns.
 *
 * Each names things declared elsewhere, so each resolves here. A surface that
 * only passes a shape check accepts an action id nothing declares, which is a
 * reference the generator would carry into an artifact unchallenged.
 */
function checkCommandSurfaceV2({
	cursor,
	report,
	actionIds,
}: SemanticCheckScope): void {
	const commands = new Set(cursor.strings(['command_surface', 'commands']))
	const exitCodes = new Set(
		cursor.entries(['command_surface', 'exit_codes']).map((row) => row.key),
	)

	for (const entry of cursor.entries([
		'command_surface',
		'positional_routes',
	])) {
		const base = ['command_surface', 'positional_routes', entry.key] as const
		if (!commands.has(entry.key))
			report(
				'semantic_unresolved_reference',
				`Positional routes are declared for ${JSON.stringify(entry.key)}, which command_surface.commands does not declare.`,
				`command_surface.positional_routes.${entry.key}`,
				cursor.keyLoc([...base]),
			)

		for (const positional of cursor.entries([...base, 'positionals'])) {
			const target = cursor.string([...base, 'positionals', positional.key])
			if (target === undefined || actionIds.has(target)) continue
			report(
				'semantic_unresolved_reference',
				`Positional ${JSON.stringify(positional.key)} of ${JSON.stringify(entry.key)} selects action ${JSON.stringify(target)}, which the action catalog does not declare.`,
				`command_surface.positional_routes.${entry.key}.positionals.${positional.key}`,
				cursor.loc([...base, 'positionals', positional.key]),
			)
		}

		const alias = cursor.string([...base, 'bare_invocation_target'])
		if (alias !== undefined && !actionIds.has(alias))
			report(
				'semantic_unresolved_reference',
				`Bare invocation of ${JSON.stringify(entry.key)} selects action ${JSON.stringify(alias)}, which the action catalog does not declare.`,
				`command_surface.positional_routes.${entry.key}.bare_invocation_target`,
				cursor.loc([...base, 'bare_invocation_target']),
			)
	}

	// Root branches: the exit each rides is declared, the action each names is
	// declared, and no two branches sharing an exit claim the same meaning.
	// Sharing one exit is expected - the crash path and a refusal both ride 1 -
	// but sharing the meaning too leaves an agent one word for two branches.
	const meaningsByExit = new Map<string, Map<string, string>>()
	for (const entry of cursor.entries(['command_surface', 'root_branches'])) {
		const base = ['command_surface', 'root_branches', entry.key] as const
		const exit = cursor.string([...base, 'exit_code'])
		const meaning = cursor.string([...base, 'meaning'])

		const action = cursor.string([...base, 'action'])
		if (action !== undefined && !actionIds.has(action))
			report(
				'semantic_unresolved_reference',
				`Root branch ${JSON.stringify(entry.key)} names action ${JSON.stringify(action)}, which the action catalog does not declare.`,
				`command_surface.root_branches.${entry.key}.action`,
				cursor.loc([...base, 'action']),
			)

		if (exit === undefined || meaning === undefined) continue
		if (!exitCodes.has(exit))
			report(
				'semantic_unresolved_reference',
				`Root branch ${JSON.stringify(entry.key)} rides exit ${JSON.stringify(exit)}, which command_surface.exit_codes does not declare.`,
				`command_surface.root_branches.${entry.key}.exit_code`,
				cursor.loc([...base, 'exit_code']),
			)

		const seen = meaningsByExit.get(exit) ?? new Map<string, string>()
		const first = seen.get(meaning)
		if (first === undefined) {
			seen.set(meaning, entry.key)
			meaningsByExit.set(exit, seen)
			continue
		}
		report(
			'semantic_free_text_branch_value',
			`Root branches ${JSON.stringify(first)} and ${JSON.stringify(entry.key)} both ride exit ${JSON.stringify(exit)} and both mean ${JSON.stringify(meaning)}, so the exit carries one word for two branches.`,
			`command_surface.root_branches.${entry.key}.meaning`,
			cursor.loc([...base, 'meaning']),
		)
	}

	// Expectation columns are keyed by Branch Station id, whose grammar names
	// the command before the branch.
	for (const entry of cursor.entries(['expectation_columns'])) {
		const command = entry.key.split('.')[0] ?? ''
		if (commands.has(command)) continue
		report(
			'semantic_unresolved_reference',
			`Expectation columns are declared for ${JSON.stringify(entry.key)}, whose command ${JSON.stringify(command)} is absent from command_surface.commands.`,
			`expectation_columns.${entry.key}`,
			cursor.keyLoc(['expectation_columns', entry.key]),
		)
	}
}

/**
 * Routing Tables: closed keys, unique complete rows, and declared targets.
 *
 * Every claim a Routing Table makes is checked here rather than left to
 * derivation, because a table that routes ambiguously or leaves a declared
 * combination uncovered would publish an invented route as though it were
 * admitted (ADR 0005).
 */
function checkRouting(scope: SemanticCheckScope): void {
	const { cursor, report, actionIds } = scope
	const commands = new Set(cursor.strings(['command_surface', 'commands']))

	for (const table of cursor.entries(['routing'])) {
		const base = ['routing', table.key] as const
		const targetKind = cursor.string([...base, 'target_kind'])
		const discriminants = cursor.entries([...base, 'discriminants'])
		const declaredFields = new Map<string, ReadonlySet<string>>()
		for (const field of discriminants) {
			declaredFields.set(
				field.key,
				new Set(cursor.strings([...base, 'discriminants', field.key])),
			)
		}

		const rows = cursor.items([...base, 'rows'])
		const seenKeys = new Map<string, number>()

		rows.forEach((_row, index) => {
			const rowPath = [...base, 'rows', index] as const
			const keyEntries = cursor.entries([...rowPath, 'key'])

			// Every discriminant the row names must be one the table declares,
			// carrying a value that discriminant admits.
			for (const entry of keyEntries) {
				const values = declaredFields.get(entry.key)
				if (values === undefined) {
					report(
						'semantic_unresolved_reference',
						`Routing table ${JSON.stringify(table.key)} row ${index} keys on ${JSON.stringify(entry.key)}, which the table does not declare as a discriminant.`,
						`routing.${table.key}.rows[${index}].key.${entry.key}`,
						entry.keyLoc,
					)
					continue
				}
				const value = cursor.string([...rowPath, 'key', entry.key])
				if (value !== undefined && !values.has(value)) {
					report(
						'semantic_free_text_branch_value',
						`Routing table ${JSON.stringify(table.key)} row ${index} sets ${JSON.stringify(entry.key)} to ${JSON.stringify(value)}, which is outside that discriminant's declared values.`,
						`routing.${table.key}.rows[${index}].key.${entry.key}`,
						cursor.loc([...rowPath, 'key', entry.key]),
					)
				}
			}

			// A row missing a declared discriminant has an incomplete key, so
			// it would select for more inputs than it names.
			for (const field of declaredFields.keys()) {
				if (keyEntries.some((entry) => entry.key === field)) continue
				report(
					'semantic_incomplete_projection',
					`Routing table ${JSON.stringify(table.key)} row ${index} omits discriminant ${JSON.stringify(field)}, so its key is incomplete and would select more than one input.`,
					`routing.${table.key}.rows[${index}].key`,
					cursor.loc([...rowPath, 'key']),
				)
			}

			// Two rows sharing a complete key make selection ambiguous.
			const signature = [...declaredFields.keys()]
				.sort(compareCodepoints)
				.map(
					(field) =>
						`${field}=${cursor.string([...rowPath, 'key', field]) ?? ''}`,
				)
				.join('&')
			const first = seenKeys.get(signature)
			if (first === undefined) seenKeys.set(signature, index)
			else {
				report(
					'semantic_competing_actions',
					`Routing table ${JSON.stringify(table.key)} rows ${first} and ${index} share one complete key, so no single route is selected.`,
					`routing.${table.key}.rows[${index}].key`,
					cursor.loc([...rowPath, 'key']),
				)
			}

			// The target resolves under the kind the table declares.
			const target = cursor.string([...rowPath, 'target'])
			if (target === undefined) return
			if (targetKind === 'action' && !actionIds.has(target)) {
				report(
					'semantic_unresolved_reference',
					`Routing table ${JSON.stringify(table.key)} row ${index} targets action ${JSON.stringify(target)}, which the action catalog does not declare.`,
					`routing.${table.key}.rows[${index}].target`,
					cursor.loc([...rowPath, 'target']),
				)
			}
			if (targetKind === 'branch_station') {
				// The command prefix is all this stage can resolve: the derived
				// station catalog does not exist until `buildIr` has run, and
				// this validation runs before it. The prefix check is therefore
				// a partial one by construction, and it must not be read as
				// resolving the target - `doctor.typo_no_such_station` passes it
				// while naming a station no derivation emits.
				//
				// The whole target is checked against the derived catalog by
				// `branch-stations.ts`, which owns that catalog, and refuses
				// with `emit_route_station_unknown`.
				const command = target.split('.')[0] ?? ''
				if (!commands.has(command)) {
					report(
						'semantic_unresolved_reference',
						`Routing table ${JSON.stringify(table.key)} row ${index} targets Branch Station ${JSON.stringify(target)}, whose command is absent from the declared command surface.`,
						`routing.${table.key}.rows[${index}].target`,
						cursor.loc([...rowPath, 'target']),
					)
				}
			}
		})

		// Where the table asks for it, every declared combination must route.
		//
		// Reported as one diagnostic naming the count plus a bounded sample:
		// the key space is the product of the declared vocabularies, so a
		// table with several fields has thousands of uncovered combinations
		// and one diagnostic each would bury the repair in its own evidence.
		// The count is what a reader acts on; the sample shows the shape.
		if (cursor.bool([...base, 'requires_complete_coverage']) !== true) continue
		const fields = [...declaredFields.keys()].sort(compareCodepoints)
		const missing = combinationsOf(fields, declaredFields).filter(
			(combination) => !seenKeys.has(combination),
		)
		if (missing.length === 0) continue
		const sample = missing.slice(0, UNROUTED_SAMPLE_SIZE)
		report(
			'semantic_incomplete_projection',
			`Routing table ${JSON.stringify(table.key)} declares complete coverage but routes no row for ${missing.length} of its declared key combinations, so that evidence selects nothing. First ${sample.length}: ${sample.map((combination) => JSON.stringify(combination)).join(', ')}.`,
			`routing.${table.key}.rows`,
			cursor.loc([...base, 'rows']),
		)
	}
}

/**
 * Every complete key the declared discriminants admit, in the same
 * `field=value` form the row signatures use.
 */
function combinationsOf(
	fields: readonly string[],
	declared: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
	let combinations: readonly string[] = ['']
	for (const field of fields) {
		const values = [...(declared.get(field) ?? [])].sort(compareCodepoints)
		combinations = combinations.flatMap((prefix) =>
			values.map(
				(value) => `${prefix === '' ? '' : `${prefix}&`}${field}=${value}`,
			),
		)
	}
	return combinations
}

/**
 * Observations, Capability Availability, and Pause Mode.
 *
 * Each ruling names a shape the candidate cannot be trusted to keep on its
 * own: an observation that expires into an unnamed cause, a Pause whose
 * release is not human-owned, or a capability whose unavailability routes
 * nowhere would each publish a meaning the ruling settled differently.
 */
/**
 * Observation Expiry and Wake Route resolution (ADR 0002).
 *
 * A declared observation names the cause it expires into and the route a
 * waiting caller wakes through. Both must resolve against declared
 * vocabularies, or an observation would expire into an unnamed cause and
 * a caller would be told to wait for a signal nothing declares.
 */
function checkObservations(scope: SemanticCheckScope): void {
	const { cursor, report } = scope
	const blockers = new Set(cursor.strings(['blockers']))
	// An observation's declared expiry cause and Wake Route must resolve.
	//
	// Deliberately no uniqueness rule across observations. The recorded
	// ruling split two specific causes because those carry distinct
	// lifecycles and repairs, not because any two observations must differ;
	// inferring "two names mean two repairs" would invent product semantics
	// the schema cannot express. Which observations share a cause is
	// candidate-authoring work, settled at admission.
	const wakeRoutes = new Set(cursor.strings(['waits', 'wake_routes']))
	const observations = cursor.entries(['waits', 'observations'])

	// An observation's route must resolve, so the vocabulary it resolves
	// against cannot be optional. Validating membership only when a
	// vocabulary happens to exist would accept any nonempty text from a
	// candidate that declared none, which is the fail-open this check exists
	// to close.
	if (observations.length > 0 && wakeRoutes.size === 0)
		report(
			'semantic_incomplete_projection',
			'The candidate declares observations but no waits.wake_routes, so no declared vocabulary says how a waiting caller is woken.',
			'waits.wake_routes',
			cursor.loc(['waits', 'observations']),
		)

	for (const entry of observations) {
		const base = ['waits', 'observations', entry.key] as const

		const cause = cursor.string([...base, 'missed_deadline_cause'])
		if (cause !== undefined && !blockers.has(cause))
			report(
				'semantic_unresolved_reference',
				`Observation ${JSON.stringify(entry.key)} expires into ${JSON.stringify(cause)}, which the candidate does not declare as a blocker.`,
				`waits.observations.${entry.key}.missed_deadline_cause`,
				cursor.loc([...base, 'missed_deadline_cause']),
			)

		const route = cursor.string([...base, 'wake_route'])
		if (route !== undefined && wakeRoutes.size > 0 && !wakeRoutes.has(route))
			report(
				'semantic_unresolved_reference',
				`Observation ${JSON.stringify(entry.key)} wakes through ${JSON.stringify(route)}, which waits.wake_routes does not declare.`,
				`waits.observations.${entry.key}.wake_route`,
				cursor.loc([...base, 'wake_route']),
			)
	}
}

/**
 * Capability Availability routing.
 *
 * Capability Availability is an installed-surface fact, never Authority.
 * The specification carries no current value, so both routes are checked
 * for every declared capability: whichever a provider later observes, the
 * declared routing already covers it.
 */
function checkCapabilities(scope: SemanticCheckScope): void {
	const { cursor, report, actionIds } = scope
	const blockers = new Set(cursor.strings(['blockers']))
	for (const entry of cursor.entries(['capabilities'])) {
		const base = ['capabilities', entry.key] as const
		// Both routes are checked for every declared capability, never only
		// for one an author wrote a value for. Availability is observed at
		// runtime, so a capability whose routing depended on a design-time
		// boolean could uninstall and route nowhere.
		const blocker = cursor.string([...base, 'unavailable_blocker'])
		const action = cursor.string([...base, 'unavailable_action'])
		if (blocker === undefined || action === undefined) {
			report(
				'semantic_incomplete_projection',
				`Capability ${JSON.stringify(entry.key)} declares no blocker and action to route to when it is unavailable, so its absence selects nothing.`,
				`capabilities.${entry.key}`,
				cursor.keyLoc([...base]),
			)
			continue
		}

		// The route an available capability takes, when the product declares
		// one, must resolve like any other. An absent one is not an error:
		// most capabilities simply permit the work their command already does.
		const availableAction = cursor.string([...base, 'available_action'])
		if (availableAction !== undefined && !actionIds.has(availableAction))
			report(
				'semantic_unresolved_reference',
				`Capability ${JSON.stringify(entry.key)} routes an available capability to action ${JSON.stringify(availableAction)}, which the action catalog does not declare.`,
				`capabilities.${entry.key}.available_action`,
				cursor.loc([...base, 'available_action']),
			)

		if (!blockers.has(blocker))
			report(
				'semantic_unresolved_reference',
				`Capability ${JSON.stringify(entry.key)} routes to blocker ${JSON.stringify(blocker)}, which the candidate does not declare.`,
				`capabilities.${entry.key}.unavailable_blocker`,
				cursor.loc([...base, 'unavailable_blocker']),
			)
		if (!actionIds.has(action)) {
			report(
				'semantic_unresolved_reference',
				`Capability ${JSON.stringify(entry.key)} routes to action ${JSON.stringify(action)}, which the action catalog does not declare.`,
				`capabilities.${entry.key}.unavailable_action`,
				cursor.loc([...base, 'unavailable_action']),
			)
			continue
		}

		// An unavailable capability routes to operator-owned escalation, so
		// the route is human-owned. A product cannot answer an absent
		// capability with work it runs itself.
		const escalationKind = actionKindOf(cursor, action)
		if (escalationKind !== 'needs_human')
			report(
				'semantic_missing_authority_semantics',
				`Capability ${JSON.stringify(entry.key)} is unavailable and routes to ${JSON.stringify(action)}, whose kind is ${JSON.stringify(escalationKind ?? 'undeclared')}. An unavailable capability escalates to its operator, so the route is needs_human.`,
				`capabilities.${entry.key}.unavailable_action`,
				cursor.loc([...base, 'unavailable_action']),
			)
	}
}

/**
 * Pause Mode ownership and release (ADR 0003).
 *
 * A Pause Mode is an externally owned gate whose release is a human-owned
 * act. Its owner must be one the candidate declares, and its release
 * action must be human-owned, so no product can declare a Pause it clears
 * itself.
 */
function checkPauseModes(scope: SemanticCheckScope): void {
	const { cursor, report, actionIds } = scope
	const blockers = new Set(cursor.strings(['blockers']))
	const externalOwners = new Set(cursor.strings(['actions', 'external_owners']))
	for (const entry of cursor.entries(['pause_modes'])) {
		const base = ['pause_modes', entry.key] as const
		const blocker = cursor.string([...base, 'active_blocker'])
		if (blocker !== undefined && !blockers.has(blocker))
			report(
				'semantic_unresolved_reference',
				`Pause Mode ${JSON.stringify(entry.key)} emits blocker ${JSON.stringify(blocker)}, which the candidate does not declare.`,
				`pause_modes.${entry.key}.active_blocker`,
				cursor.loc([...base, 'active_blocker']),
			)

		const owner = cursor.string([...base, 'owner'])
		if (
			owner !== undefined &&
			externalOwners.size > 0 &&
			!externalOwners.has(owner)
		)
			report(
				'semantic_unresolved_reference',
				`Pause Mode ${JSON.stringify(entry.key)} names owner ${JSON.stringify(owner)}, which actions.external_owners does not declare.`,
				`pause_modes.${entry.key}.owner`,
				cursor.loc([...base, 'owner']),
			)

		const release = cursor.string([...base, 'release_action'])
		if (release === undefined) continue
		if (!actionIds.has(release)) {
			report(
				'semantic_unresolved_reference',
				`Pause Mode ${JSON.stringify(entry.key)} releases through ${JSON.stringify(release)}, which the action catalog does not declare.`,
				`pause_modes.${entry.key}.release_action`,
				cursor.loc([...base, 'release_action']),
			)
			continue
		}

		// The release is human-owned: a Pause Mode is an externally owned gate,
		// so the specification may declare a request for release and never an
		// action that clears the gate on the product's own authority.
		const index = cursor
			.items(['actions', 'catalog'])
			.findIndex(
				(_item, position) =>
					cursor.string(['actions', 'catalog', position, 'id']) === release,
			)
		if (index === -1) continue
		const kind = cursor.string(['actions', 'catalog', index, 'kind'])
		if (kind !== 'needs_human') {
			report(
				'semantic_missing_authority_semantics',
				`Pause Mode ${JSON.stringify(entry.key)} releases through ${JSON.stringify(release)}, whose kind is ${JSON.stringify(kind ?? 'undeclared')}. An externally owned gate is released by its owner, so the release action requests release and is needs_human.`,
				`pause_modes.${entry.key}.release_action`,
				cursor.loc([...base, 'release_action']),
			)
			continue
		}

		// Released by THIS gate's declared owner. Membership in
		// external_owners says the owner exists, not that it owns this gate.
		const releaseOwner = cursor.string(['actions', 'catalog', index, 'owner'])
		if (owner === undefined || releaseOwner === undefined) continue
		if (releaseOwner === owner) continue
		report(
			'semantic_missing_authority_semantics',
			`Pause Mode ${JSON.stringify(entry.key)} is owned by ${JSON.stringify(owner)} but releases through an action owned by ${JSON.stringify(releaseOwner)}, so the request would not reach the gate's owner.`,
			`pause_modes.${entry.key}.release_action`,
			cursor.loc([...base, 'release_action']),
		)
	}
}
