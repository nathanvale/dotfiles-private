/**
 * Input Schema v1: the accepted document surface, frozen.
 *
 * Recovered verbatim from the pre-v2 compiler at fixed point 518053f and owned
 * here so it stays put. A Registered Reader validates its version's input
 * against this shape, which is what stops a candidate claiming v1 from
 * declaring a v2 surface and still receiving v1's frozen digest envelope.
 *
 * Frozen means directional: v2 is built by extending this contract, and this
 * contract is never rebuilt by subtracting from v2. Subtraction would let a
 * change to a shared field's enum, requiredness, or nested shape silently move
 * what v1 accepts while adding no v2 key at all.
 *
 * The vocabularies below are deliberate local copies rather than imports from
 * `schema.ts`: an import would re-couple this frozen surface to the current
 * one, which is the coupling this module exists to break. `Shape` itself is
 * imported because it is the shape language, not a version's contract.
 */
// fallow-ignore-file code-duplication -- deliberate frozen copy of schema.ts vocabularies; importing schema.ts here would re-couple the frozen v1 surface (see file header)
import type { Shape } from './schema.ts'

const str: Shape = { t: 'string' }
const bool: Shape = { t: 'boolean' }
const num: Shape = { t: 'number' }
const strArray: Shape = { t: 'array', of: str }
const strMap: Shape = { t: 'map', of: str }

function obj(
	fields: Record<string, Shape>,
	required: readonly string[] = [],
): Shape {
	return { t: 'object', fields, required }
}

/** `invoke`/`wait`/`needs_input`/`needs_human`/`none` is sealed by the spec. */
const NEXT_SAFE_ACTION_KINDS = [
	'invoke',
	'wait',
	'needs_input',
	'needs_human',
	'none',
] as const

/**
 * Sealed read-only no-argument behaviors. The spec permits help, get-started
 * guidance, a read-only dashboard, or a repair path, and never a default
 * write; these are the candidates' values under those four categories.
 */
const NO_ARGUMENT_BEHAVIORS = [
	'help',
	'get_started_guidance',
	'read_only_dashboard',
	'read_only_restricted_status_dashboard',
	'repair_path',
] as const

/** The three-value retry posture vocabulary both candidates use. */
const RETRY_POSTURES = [
	'same_input_safe',
	'same_input_unsafe',
	'operator_required',
] as const

const STOP_SCOPES = ['domain_terminal', 'agent_terminal'] as const

/** Feature-conditioned sections keyed by the `features` flag that enables them. */
const CANCELLATION_FEATURE_VALUES = [
	'not_supported',
	'partial',
	'supported',
] as const

const identityShape = obj({
	field: str,
	fields: strArray,
	pattern: str,
})

const entityShape = obj({
	identity: identityShape,
	fencing: obj({ field: str, owner: str }),
	revision: obj({ field: str, rule: str }),
	schema_version: num,
	logical_operation: obj({ field: str }),
	attempt: obj({ field: str, increment_only_by: str }),
	launch_attempt: obj({
		field: str,
		range: { t: 'array', of: num },
		creates_attempt: bool,
	}),
	launch_generation: obj({ field: str, pattern: str }),
	generation_chain: obj({ ref: str, advance: str }),
	grants_authority: bool,
	bindings: strArray,
	roles: strArray,
	delivery: str,
	storage: str,
	record: str,
})

const stateShape = obj(
	{
		values: strArray,
		terminal: strArray,
		human_terminal: strArray,
		absorbing: strArray,
		durable_subset_excludes: strArray,
		observation_sourced: strArray,
		phases: strArray,
		checkpoints: strArray,
		legal_pairings: { t: 'map', of: strArray },
		state_field_requirements: { t: 'map', of: strMap },
		projection_from_phase: strMap,
		role: str,
	},
	['values'],
)

const actionEntryShape = obj(
	{
		id: { t: 'string', nonEmpty: true },
		kind: { t: 'string', enum: NEXT_SAFE_ACTION_KINDS },
		human_kind: str,
		stop_scope: { t: 'string', enum: STOP_SCOPES },
		owner: str,
		condition: str,
		input_contract: str,
		requires_context: strArray,
		requires_feature: str,
		note: str,
	},
	['id', 'kind'],
)

const retryRuleShape = obj(
	{
		when: obj({
			state_in: strArray,
			blocker: str,
			activation_cause_in: strArray,
			doctor_task_terminal_in: strArray,
			result_kind: str,
			command: str,
		}),
		// "then" is the retry rule's declared outcome field in Input Schema v1.
		// biome-ignore lint/suspicious/noThenProperty: schema field name, not a thenable
		then: { t: 'string', enum: RETRY_POSTURES },
	},
	['when', 'then'],
)

/** The whole Input Schema v1 document. */

/** The frozen v1 document surface. */
export const INPUT_SCHEMA_V1_SHAPE: Shape = obj(
	{
		spec_meta: obj(
			{
				product: { t: 'string', nonEmpty: true },
				input_schema_version: { t: 'string', nonEmpty: true },
				product_specification_revision: str,
				state_machine_definition_version: str,
				public_result_schema_version: str,
				activation_result_schema_version: str,
			},
			['product', 'input_schema_version'],
		),

		features: obj(
			{
				durable_operations: bool,
				liveness_evidence: bool,
				cancellation: { t: 'string', enum: CANCELLATION_FEATURE_VALUES },
				version_custody: bool,
				remote_authority: bool,
				feature_gates: strArray,
			},
			[
				'durable_operations',
				'liveness_evidence',
				'cancellation',
				'version_custody',
				'remote_authority',
				'feature_gates',
			],
		),

		entities: { t: 'map', of: entityShape },
		states: { t: 'map', of: stateShape },

		transitions: {
			t: 'array',
			of: obj({ event: str, to_phase: str, driver: str, via: str, note: str }, [
				'event',
				'to_phase',
				'driver',
			]),
		},

		task_refinement_rules: obj(
			{
				allowed: {
					t: 'array',
					of: obj({ from: str, to: str, driver: str }, ['from', 'to']),
				},
				forbidden: {
					t: 'array',
					of: obj({ from: str, to: str, reason: str }, ['from', 'to']),
				},
			},
			['allowed', 'forbidden'],
		),

		monotonic_constraints: {
			t: 'array',
			of: obj(
				{ entity: str, field: str, rule: str, latched_by: str, state: str },
				['entity', 'field', 'rule'],
			),
		},

		invariants: {
			t: 'array',
			of: obj(
				{ id: { t: 'string', nonEmpty: true }, holds: str, consequence: str },
				['id', 'holds'],
			),
		},

		blockers: strArray,

		activation: obj({
			restriction_causes: strArray,
			stopped_actions: strArray,
			configuration_fields: strArray,
			cause_to_next_action: strMap,
		}),

		actions: obj(
			{
				kinds: {
					t: 'array',
					of: { t: 'string', enum: NEXT_SAFE_ACTION_KINDS },
				},
				needs_human_kinds: strArray,
				external_owners: strArray,
				catalog: { t: 'array', of: actionEntryShape },
				contextual_renderings: {
					t: 'map',
					of: { t: 'union', of: [strArray, str] },
				},
				resolution: obj({
					missing_context: str,
					unavailable_projection_blocker: str,
					unavailable_projection_retry_safety: {
						t: 'string',
						enum: RETRY_POSTURES,
					},
					unavailable_projection_stop: { t: 'string', enum: STOP_SCOPES },
				}),
			},
			['kinds', 'catalog'],
		),

		selectors: strMap,

		retry_posture: obj(
			{
				values: { t: 'array', of: { t: 'string', enum: RETRY_POSTURES } },
				rules: { t: 'array', of: retryRuleShape },
				never_auto_retry: strArray,
				per_hint_field: str,
			},
			['values', 'rules', 'never_auto_retry'],
		),

		acknowledgement: obj(
			{
				values: strArray,
				cas_results: strArray,
				proof_carrier: str,
				unknown_policy: str,
				publication: obj({ phases: strArray, append_failure_means: str }),
			},
			['values', 'unknown_policy'],
		),

		waits: obj(
			{
				wake_route: str,
				budgets_ms: { t: 'map', of: num },
				missed_deadline_causes: strMap,
			},
			['wake_route', 'budgets_ms', 'missed_deadline_causes'],
		),

		cancellation: {
			t: 'map',
			of: {
				t: 'union',
				of: [
					str,
					obj({
						decisions: strArray,
						defer_changes_state: bool,
						durable_record: bool,
						cause: str,
						next: str,
						internal_checkpoint_predicate: bool,
						public_surface: bool,
					}),
				],
			},
		},

		authority: obj(
			{
				write_authority_owner: { t: 'string', nonEmpty: true },
				scope: str,
				lease_expiry_grants: str,
				stale_lease_takeover: obj({
					kind: str,
					requires: strArray,
					failure_blockers: strArray,
				}),
				capability_errors: {
					t: 'map',
					of: obj({ blocker: str, next: str, next_by_role: strMap }),
				},
				quarantine: obj({ on: strArray, blocker: str, next: str }),
			},
			['write_authority_owner'],
		),

		command_surface: obj(
			{
				commands: { t: 'array', of: { t: 'string', nonEmpty: true } },
				exit_codes: strMap,
				global_flags: strArray,
				output_modes_default: strArray,
				output_modes_overrides: { t: 'map', of: strArray },
				no_argument_behavior: { t: 'string', enum: NO_ARGUMENT_BEHAVIORS },
				flags: { t: 'map', of: strArray },
				activation_actions: strArray,
				repair_actions: strArray,
				mutations: strMap,
				result_contracts: {
					t: 'map',
					of: obj({ id: str, version: num }, ['id', 'version']),
				},
			},
			[
				'commands',
				'exit_codes',
				'output_modes_default',
				'output_modes_overrides',
				'no_argument_behavior',
				'mutations',
				'result_contracts',
			],
		),

		versioning: obj(
			{
				records: { t: 'map', of: num },
				read_compatibility: {
					t: 'map',
					of: { t: 'union', of: [strArray, str] },
				},
				incompatible_run_policy: {
					t: 'union',
					of: [
						obj(
							{
								blocker: str,
								authority: str,
								retry: { t: 'string', enum: RETRY_POSTURES },
								stop: { t: 'string', enum: STOP_SCOPES },
							},
							['blocker', 'authority', 'retry', 'stop'],
						),
						str,
					],
				},
			},
			['records', 'incompatible_run_policy'],
		),

		unresolved_decisions: {
			t: 'array',
			of: obj(
				{
					id: { t: 'string', nonEmpty: true },
					question: str,
					drafted_resolution: str,
				},
				['id', 'question'],
			),
		},
	},
	[
		'spec_meta',
		'features',
		'entities',
		'states',
		'transitions',
		'invariants',
		'blockers',
		'actions',
		'retry_posture',
		'acknowledgement',
		'waits',
		'cancellation',
		'authority',
		'command_surface',
		'versioning',
	],
)
