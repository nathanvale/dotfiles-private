/**
 * Builds the canonical typed IR from an already-validated document.
 *
 * Only ever called after zero diagnostics, so every lookup here is total:
 * validation has already proved the shapes and resolved the references.
 */
import { canonicalize, compareCodepoints } from './canonical.ts'
import type {
	ActionEntry,
	CapabilityAvailability,
	CommandSurface,
	ExpectationColumns,
	Features,
	ObservationBudget,
	PauseMode,
	PositionalRoute,
	RetryRule,
	RootBranch,
	RoutingRow,
	RoutingTable,
	SpecificationIr,
	SpecMeta,
	StateDefinition,
	TransitionEntry,
} from './ir.ts'
import type {
	ChangedState,
	ExecutionMode,
	NextSafeActionKind,
	ResultChannel,
	RetryPosture,
	RouteTargetKind,
	RoutingRole,
} from './schema.ts'

/** A parsed JSON object. Validation has already proved each field's shape. */
type Doc = Record<string, JsonValue>

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue }

function optional(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: []
}

/**
 * Builds the v2 declared surfaces.
 *
 * Map-keyed surfaces become sorted arrays keyed by name: the map key is the
 * product's identifier for the row, and sorting by codepoint keeps a
 * caller-visible list stable across hosts. Routing rows keep their declared
 * order, which is reading order only - a complete key selects exactly one row,
 * so order carries no precedence.
 */
function namedEntries(value: unknown): readonly (readonly [string, Doc])[] {
	if (value === null || typeof value !== 'object') return []
	return Object.entries(value as Doc)
		.map(([name, raw]) => [name, (raw ?? {}) as Doc] as const)
		.sort(([a], [b]) => compareCodepoints(a, b))
}

function buildRouting(value: unknown): readonly RoutingTable[] {
	return namedEntries(value).map(([name, raw]) => ({
		name,
		role: raw.role as RoutingRole,
		targetKind: raw.target_kind as RouteTargetKind,
		discriminants: canonicalize(
			raw.discriminants ?? {},
		) as RoutingTable['discriminants'],
		requiresCompleteCoverage: raw.requires_complete_coverage === true,
		rows: (Array.isArray(raw.rows) ? (raw.rows as Doc[]) : []).map((row) => ({
			key: canonicalize(row.key ?? {}) as RoutingRow['key'],
			target: row.target as string,
			...defined('blocker', optional(row.blocker)),
			...defined('retrySafety', row.retry_safety as RetryPosture | undefined),
			...defined('humanKind', optional(row.human_kind)),
		})),
	}))
}

function buildPositionalRoutes(value: unknown): readonly PositionalRoute[] {
	return namedEntries(value).map(([command, raw]) => ({
		command,
		positionals: canonicalize(
			raw.positionals ?? {},
		) as PositionalRoute['positionals'],
		...defined('bareAlias', optional(raw.bare_alias)),
	}))
}

function buildCapabilities(value: unknown): readonly CapabilityAvailability[] {
	return namedEntries(value).map(([name, raw]) => ({
		name,
		available: raw.available === true,
		...defined('unavailableBlocker', optional(raw.unavailable_blocker)),
		...defined('unavailableAction', optional(raw.unavailable_action)),
	}))
}

function buildPauseModes(value: unknown): readonly PauseMode[] {
	return namedEntries(value).map(([name, raw]) => ({
		name,
		owner: raw.owner as string,
		activeBlocker: raw.active_blocker as string,
		releaseAction: raw.release_action as string,
	}))
}

function buildObservations(value: unknown): readonly ObservationBudget[] {
	return namedEntries(value).map(([name, raw]) => ({
		name,
		pollAfterMs: raw.poll_after_ms as number,
		attemptExpiryMs: raw.attempt_expiry_ms as number,
		...defined('wakeRoute', optional(raw.wake_route)),
		...defined('missedDeadlineCause', optional(raw.missed_deadline_cause)),
	}))
}

function buildRootBranches(value: unknown): readonly RootBranch[] {
	return namedEntries(value).map(([name, raw]) => ({
		name,
		exitCode: raw.exit_code as string,
		meaning: raw.meaning as string,
		...defined('action', optional(raw.action)),
	}))
}

function buildExpectationColumns(
	value: unknown,
): readonly ExpectationColumns[] {
	return namedEntries(value).map(([name, raw]) => ({
		name,
		...defined('changedState', raw.changed_state as ChangedState | undefined),
		...defined('channel', raw.channel as ResultChannel | undefined),
	}))
}

/**
 * Contextual renderings normalize to a list of canonical ids: v1 permits a
 * bare string for a single target, and one shape downstream beats two.
 */
function buildContextualRenderings(
	value: unknown,
): Readonly<Record<string, readonly string[]>> {
	const renderings: Record<string, readonly string[]> = {}
	if (value === null || typeof value !== 'object') return renderings
	for (const [rendering, targets] of Object.entries(value as Doc).sort(
		([a], [b]) => compareCodepoints(a, b),
	)) {
		renderings[rendering] =
			typeof targets === 'string' ? [targets] : strings(targets)
	}
	return renderings
}

export function buildIr(document: unknown): SpecificationIr {
	const doc = document as Doc
	const meta = doc.spec_meta as Doc
	const features = doc.features as Doc
	const surface = doc.command_surface as Doc

	const specMeta: SpecMeta = {
		product: meta.product as string,
		inputSchemaVersion: meta.input_schema_version as string,
		...defined(
			'productSpecificationRevision',
			optional(meta.product_specification_revision),
		),
		...defined(
			'stateMachineDefinitionVersion',
			optional(meta.state_machine_definition_version),
		),
		...defined(
			'publicResultSchemaVersion',
			optional(meta.public_result_schema_version),
		),
		...defined(
			'activationResultSchemaVersion',
			optional(meta.activation_result_schema_version),
		),
	}

	const irFeatures: Features = {
		durableOperations: features.durable_operations === true,
		livenessEvidence: features.liveness_evidence === true,
		cancellation: features.cancellation as Features['cancellation'],
		versionCustody: features.version_custody === true,
		remoteAuthority: features.remote_authority === true,
		featureGates: strings(features.feature_gates),
	}

	const states: StateDefinition[] = Object.entries((doc.states ?? {}) as Doc)
		.map(([name, raw]) => {
			const state = raw as Doc
			return {
				name,
				values: strings(state.values),
				terminal: strings(state.terminal),
				humanTerminal: strings(state.human_terminal),
				absorbing: strings(state.absorbing),
				observationSourced: strings(state.observation_sourced),
				phases: strings(state.phases),
				checkpoints: strings(state.checkpoints),
				...defined(
					'projectionFromPhase',
					state.projection_from_phase as Record<string, string> | undefined,
				),
				...defined('role', optional(state.role)),
			}
		})
		.sort((a, b) => compareCodepoints(a.name, b.name))

	const transitions: TransitionEntry[] = ((doc.transitions ?? []) as Doc[]).map(
		(raw) => ({
			event: raw.event as string,
			toPhase: raw.to_phase as string,
			driver: raw.driver as string,
			...defined('via', optional(raw.via)),
		}),
	)

	const catalog: ActionEntry[] = (
		((doc.actions as Doc).catalog ?? []) as Doc[]
	).map((raw) => ({
		id: raw.id as string,
		kind: raw.kind as NextSafeActionKind,
		requiresContext: strings(raw.requires_context),
		...defined('humanKind', optional(raw.human_kind)),
		...defined(
			'stopScope',
			optional(raw.stop_scope) as ActionEntry['stopScope'],
		),
		...defined('owner', optional(raw.owner)),
		...defined('condition', optional(raw.condition)),
		...defined('inputContract', optional(raw.input_contract)),
		...defined('requiresFeature', optional(raw.requires_feature)),
		...defined('note', optional(raw.note)),
	}))

	const resolution = (doc.actions as Doc).resolution as Doc | undefined
	const retry = doc.retry_posture as Doc

	const rules: RetryRule[] = ((retry.rules ?? []) as Doc[]).map((raw) => ({
		when: canonicalize(raw.when) as RetryRule['when'],
		// "then" is the retry rule's declared outcome field in Input Schema v1.
		// biome-ignore lint/suspicious/noThenProperty: schema field name, not a thenable
		then: raw.then as RetryPosture,
	}))

	const commandSurface: CommandSurface = {
		commands: strings(surface.commands),
		exitCodes: (surface.exit_codes ?? {}) as Record<string, string>,
		globalFlags: strings(surface.global_flags),
		outputModesDefault: strings(surface.output_modes_default),
		outputModesOverrides: (surface.output_modes_overrides ?? {}) as Record<
			string,
			readonly string[]
		>,
		noArgumentBehavior: surface.no_argument_behavior as string,
		...defined(
			'bareInvocationCommand',
			optional(surface.bare_invocation_command),
		),
		...defined(
			'entryScript',
			optional((surface.entry as Doc | undefined)?.script),
		),
		executionModes: (surface.execution_modes ?? {}) as Record<
			string,
			readonly ExecutionMode[]
		>,
		previewExemptions: Object.fromEntries(
			namedEntries(surface.preview_exemptions).map(([command, raw]) => [
				command,
				raw.reason as string,
			]),
		),
		rootBranches: buildRootBranches(surface.root_branches),
		positionalRoutes: buildPositionalRoutes(surface.positional_routes),
		flags: (surface.flags ?? {}) as Record<string, readonly string[]>,
		mutations: (surface.mutations ?? {}) as Record<string, string>,
		resultContracts: (surface.result_contracts ??
			{}) as CommandSurface['resultContracts'],
	}

	return {
		specMeta,
		features: irFeatures,
		states,
		...defined('phaseState', optional(doc.phase_state)),
		transitions,
		blockers: strings(doc.blockers),
		actions: {
			kinds: strings(
				(doc.actions as Doc).kinds,
			) as readonly NextSafeActionKind[],
			catalog,
			...defined(
				'resolution',
				resolution === undefined
					? undefined
					: {
							...defined(
								'missingContext',
								optional(resolution.missing_context),
							),
							...defined(
								'unavailableProjectionBlocker',
								optional(resolution.unavailable_projection_blocker),
							),
							...defined(
								'unavailableProjectionRetrySafety',
								optional(resolution.unavailable_projection_retry_safety) as
									| RetryPosture
									| undefined,
							),
							...defined(
								'unavailableProjectionStop',
								optional(resolution.unavailable_projection_stop) as
									| 'domain_terminal'
									| 'agent_terminal'
									| undefined,
							),
						},
			),
		},
		retryPosture: {
			values: strings(retry.values) as readonly RetryPosture[],
			rules,
			neverAutoRetry: strings(retry.never_auto_retry),
		},
		routing: buildRouting(doc.routing),
		capabilities: buildCapabilities(doc.capabilities),
		pauseModes: buildPauseModes(doc.pause_modes),
		observations: buildObservations(
			(doc.waits as Doc | undefined)?.observations,
		),
		expectationColumns: buildExpectationColumns(doc.expectation_columns),
		contextualRenderings: buildContextualRenderings(
			(doc.actions as Doc).contextual_renderings,
		),
		commandSurface,
		entityNames: Object.keys((doc.entities ?? {}) as Doc).sort(),
		invariantIds: ((doc.invariants ?? []) as Doc[]).map(
			(raw) => raw.id as string,
		),
		unresolvedDecisionIds: ((doc.unresolved_decisions ?? []) as Doc[]).map(
			(raw) => raw.id as string,
		),
		canonical: canonicalize(document),
	}
}

/** Omits a key entirely when undefined, so the IR has no `key: undefined` noise. */
function defined<K extends string, V>(
	key: K,
	value: V | undefined,
): Record<K, V> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}
