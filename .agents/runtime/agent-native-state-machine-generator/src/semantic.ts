/**
 * Semantic validation: is a structurally valid candidate safe to admit?
 *
 * These are the rejection causes the specification names. Each check is
 * feature-conditioned where the ruling requires it: a product whose `features`
 * flags disable durable machinery is never asked to supply it.
 */
import type { Diagnostic } from './diagnostics.ts'
import type { JsoncEntry, JsoncNode } from './jsonc.ts'
import { NEXT_SAFE_ACTION_KINDS, RETRY_POSTURES } from './schema.ts'

/** Mutation kinds that declare an externally meaningful effect. */
const WRITE_MUTATIONS = new Set(['remote_write', 'local_write', 'recovery'])
/** Every mutation value the two candidates use; a sealed branch vocabulary. */
const MUTATION_VALUES = new Set([...WRITE_MUTATIONS, 'read', 'preview'])

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

	checkActionCatalog(scope)
	checkReferences(scope)
	checkStateVocabularies(scope)
	checkRetryPosture(scope)
	checkAuthorityAndSideEffects(scope)
	checkIdentityAndFeatureConditioning(scope)

	return diagnostics
}

/** Action identity, per-kind mandatory semantics, and competing Next Safe Actions. */
function checkActionCatalog({
	cursor,
	report,
	actionIds,
}: SemanticCheckScope): void {
	const catalog = cursor.items(['actions', 'catalog'])
	const declaredKinds = new Set(cursor.strings(['actions', 'kinds']))

	catalog.forEach((_item, index) => {
		const base = ['actions', 'catalog', index] as const
		const id = cursor.string([...base, 'id'])
		const kind = cursor.string([...base, 'kind'])
		if (id === undefined || kind === undefined) return

		if (actionIds.has(id)) {
			report(
				'semantic_duplicate_id',
				`Duplicate action id ${JSON.stringify(id)}. Every Next Safe Action id must be unique; two entries competing for one id leave the Next Safe Action ambiguous.`,
				`actions.catalog[${index}].id`,
				cursor.loc([...base, 'id']),
			)
		}
		actionIds.add(id)

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

	// Transitions must land on a declared phase of a declared state.
	const phaseValues = new Set(
		cursor.strings(['states', 'transaction_phase', 'values']),
	)
	if (phaseValues.size > 0) {
		cursor.items(['transitions']).forEach((_item, index) => {
			const toPhase = cursor.string(['transitions', index, 'to_phase'])
			if (toPhase !== undefined && !phaseValues.has(toPhase)) {
				report(
					'semantic_unresolved_reference',
					`Transition ${index} targets phase ${JSON.stringify(toPhase)}, which states.transaction_phase.values does not declare.`,
					`transitions[${index}].to_phase`,
					cursor.loc(['transitions', index, 'to_phase']),
				)
			}
		})
	}
}

/** State values, their declared subsets, and projection totality. */
function checkStateVocabularies({ cursor, report }: SemanticCheckScope): void {
	for (const stateEntry of cursor.entries(['states'])) {
		const base = ['states', stateEntry.key] as const
		const values = cursor.strings([...base, 'values'])
		const valueSet = new Set(values)

		const duplicates = values.filter(
			(value, index) => values.indexOf(value) !== index,
		)
		for (const duplicate of duplicates) {
			report(
				'semantic_duplicate_id',
				`State ${JSON.stringify(stateEntry.key)} declares value ${JSON.stringify(duplicate)} more than once.`,
				`states.${stateEntry.key}.values`,
				cursor.loc([...base, 'values']),
			)
		}

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

		// A declared phase→state projection must be total over the source phases.
		const projection = cursor.entries([...base, 'projection_from_phase'])
		if (projection.length > 0) {
			const sourcePhases = cursor.strings([
				'states',
				'transaction_phase',
				'values',
			])
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

	const duplicateCommands = commands.filter(
		(value, index) => commands.indexOf(value) !== index,
	)
	for (const duplicate of duplicateCommands) {
		report(
			'semantic_duplicate_id',
			`command_surface.commands lists ${JSON.stringify(duplicate)} more than once.`,
			'command_surface.commands',
			cursor.loc(['command_surface', 'commands']),
		)
	}

	// Baseline exit meanings must be declared; an undeclared exit is unroutable.
	for (const code of ['0', '1', '2'] as const) {
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
function checkIdentityAndFeatureConditioning({
	cursor,
	report,
	features,
}: SemanticCheckScope): void {
	const seenInvariants = new Set<string>()
	cursor.items(['invariants']).forEach((_item, index) => {
		const id = cursor.string(['invariants', index, 'id'])
		if (id === undefined) return
		if (seenInvariants.has(id)) {
			report(
				'semantic_duplicate_id',
				`Duplicate invariant id ${JSON.stringify(id)}.`,
				`invariants[${index}].id`,
				cursor.loc(['invariants', index, 'id']),
			)
		}
		seenInvariants.add(id)
	})

	const seenDecisions = new Set<string>()
	cursor.items(['unresolved_decisions']).forEach((_item, index) => {
		const id = cursor.string(['unresolved_decisions', index, 'id'])
		if (id === undefined) return
		if (seenDecisions.has(id)) {
			report(
				'semantic_duplicate_id',
				`Duplicate unresolved_decisions id ${JSON.stringify(id)}.`,
				`unresolved_decisions[${index}].id`,
				cursor.loc(['unresolved_decisions', index, 'id']),
			)
		}
		seenDecisions.add(id)
	})

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
