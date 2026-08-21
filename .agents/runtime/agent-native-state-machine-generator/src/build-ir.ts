/**
 * Builds the canonical typed IR from an already-validated document.
 *
 * Only ever called after zero diagnostics, so every lookup here is total:
 * validation has already proved the shapes and resolved the references.
 */
import { canonicalize, compareCodepoints } from './canonical.ts'
import type {
	ActionEntry,
	CommandSurface,
	Features,
	RetryRule,
	SpecificationIr,
	SpecMeta,
	StateDefinition,
	TransitionEntry,
} from './ir.ts'
import type { NextSafeActionKind, RetryPosture } from './schema.ts'

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
		flags: (surface.flags ?? {}) as Record<string, readonly string[]>,
		mutations: (surface.mutations ?? {}) as Record<string, string>,
		resultContracts: (surface.result_contracts ??
			{}) as CommandSurface['resultContracts'],
	}

	return {
		specMeta,
		features: irFeatures,
		states,
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
