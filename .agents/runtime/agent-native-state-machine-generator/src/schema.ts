/**
 * Input Schema v1.
 *
 * Product-owner ruling (dotfiles issue 55, 2026-08-21): the schema is
 * the union of what the two spike candidates actually use, and nothing more.
 * Every shape below was derived mechanically from those two files. Do not add
 * surface that neither candidate exercises.
 */

/** Declarative shape language. Deliberately tiny; it only has to cover v1. */
export type Shape =
	| {
			readonly t: 'string'
			readonly enum?: readonly string[]
			readonly nonEmpty?: boolean
	  }
	| { readonly t: 'number' }
	| { readonly t: 'boolean' }
	| { readonly t: 'array'; readonly of: Shape }
	/** Fixed key set. Unlisted keys are refused as `structure_unknown_key`. */
	| {
			readonly t: 'object'
			readonly fields: Readonly<Record<string, Shape>>
			readonly required: readonly string[]
	  }
	/** Product-named keys (entities, states, budgets); only values are shaped. */
	| { readonly t: 'map'; readonly of: Shape }
	/** First shape that matches wins; used for the few genuinely union fields. */
	| { readonly t: 'union'; readonly of: readonly Shape[] }

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
export const NEXT_SAFE_ACTION_KINDS = [
	'invoke',
	'wait',
	'needs_input',
	'needs_human',
	'none',
] as const
export type NextSafeActionKind = (typeof NEXT_SAFE_ACTION_KINDS)[number]

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
export const RETRY_POSTURES = [
	'same_input_safe',
	'same_input_unsafe',
	'operator_required',
] as const
export type RetryPosture = (typeof RETRY_POSTURES)[number]

const STOP_SCOPES = ['domain_terminal', 'agent_terminal'] as const

/**
 * How one invocation of a command treats its Declared Side Effect: a normal
 * attempt, or a non-mutating check or dry run.
 *
 * Byte-identical to the facade's `COMMAND_FACADE_EXECUTION_MODES`; the
 * alignment is proved by a test, not by trust.
 */
export const EXECUTION_MODES = ['normal', 'check', 'dry_run'] as const

export type ExecutionMode = (typeof EXECUTION_MODES)[number]

/**
 * What a branch changed, as the Agent Worktree evidence pivots recovery on.
 * `unknown` is a declared outcome rather than a missing value: a caller that
 * cannot tell must not assume nothing happened.
 *
 * A member belongs here when a real process can be observed to have left the
 * world in that state and a caller's repair differs because of it. Adding one
 * is a Generator Contract change: an emitted expectation row carries the
 * value verbatim, so a new member changes what a consumer must handle.
 */
export const CHANGED_STATES = [
	'none',
	'partial',
	'complete',
	'unknown',
] as const

export type ChangedState = (typeof CHANGED_STATES)[number]

/**
 * The stream a declared result arrives on. Sealed so a candidate cannot name
 * a channel the proof harness has no way to observe.
 *
 * A member belongs here when a Real Process Fixture can actually read it back
 * off a live process. Adding one is a Generator Contract change: the value
 * reaches an emitted expectation row that a real process is asserted against,
 * so a channel nothing can observe would publish an unprovable expectation.
 */
export const RESULT_CHANNELS = ['stdout', 'stderr', 'both', 'none'] as const

export type ResultChannel = (typeof RESULT_CHANNELS)[number]

/**
 * The exit meanings every command surface must declare: success, refusal or
 * runtime failure, and invalid usage. One owner because two consumers ask
 * different questions of the same list - semantic validation refuses a
 * candidate that omits one, and derivation refuses to publish a Command
 * Surface Contract missing one - and a second copy would let the compiler
 * accept an exit the emitter then rejects.
 *
 * Byte-identical to the facade's `COMMAND_FACADE_BASELINE_EXIT_CODES`; the
 * alignment is proved by a test, not by trust.
 */
export const BASELINE_EXIT_CODES = ['0', '1', '2'] as const

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

/**
 * What a Routing Table row selects.
 *
 * A route to an `action` names a canonical Next Safe Action. A route to a
 * `branch_station` names a declared public branch, which is a different
 * meaning: fact-to-branch selection and success-station binding choose a
 * station independently of what the Next Safe Action then is, and collapsing
 * the two would silently replace a branch with an action (Agent Worktree gap
 * rows 4 and 5).
 */
export const ROUTE_TARGET_KINDS = ['action', 'branch_station'] as const

export type RouteTargetKind = (typeof ROUTE_TARGET_KINDS)[number]

/**
 * What a Routing Table is for, declared rather than inferred.
 *
 * Derivation selects a table by this role and never by the table's name, its
 * key names, or which discriminants it happens to declare: a Finding table
 * that mentions a blocker is not a blocker-to-action mapping, and reading it
 * as one would consume an unrelated declaration as station meaning.
 *
 * `station_blocker` supplies a refused Branch Station's blocker with the
 * action and posture that blocker routes to. Its rows key on facts a station
 * holds (its command and branch) and name the blocker as the row's declared
 * `blocker` output, because the blocker is what the station is asking for
 * rather than something it can supply. `fact_branch` selects which
 * Branch Station a fact reaches, and is emitted as its own selection table.
 * `station_action` binds a station to its expected action; it stays separate
 * from `fact_branch` because reaching a branch does not say what that
 * branch's Next Safe Action is.
 *
 * `advisory` binds nothing. A table declared advisory is published as
 * declared data where its target kind allows, but derivation reads no station
 * meaning out of it: that is what lets a product declare a routing table the
 * generator has no binding for without it being read as one it does.
 * Publishing a table is not consuming it as a binding.
 *
 * A member belongs here when derivation has a distinct, named use for the
 * table beyond publishing it. Adding one is a Generator Contract change,
 * because a role is what authorizes derivation to read a table a particular
 * way.
 */
export const ROUTING_ROLES = [
	'advisory',
	'fact_branch',
	'station_action',
	'station_blocker',
] as const

export type RoutingRole = (typeof ROUTING_ROLES)[number]

/**
 * One Routing Table row: a complete key and the single target it selects.
 *
 * `key` carries exactly the discriminants the table declares, each holding a
 * value from that discriminant's closed vocabulary. A key the table does not
 * cover selects nothing rather than falling through to a default, so an agent
 * never infers a route the product did not declare.
 *
 * `target` is read under the table's declared target kind. The optional
 * columns carry the meanings the rulings attach to a route: the retry posture
 * it takes, and the handoff kind a human-owned route names. Both stay optional
 * because a row declaring neither inherits nothing and invents nothing.
 */
const routingRowShape = obj(
	{
		key: strMap,
		target: { t: 'string', nonEmpty: true },
		/**
		 * The blocker this route reports, for a role whose output includes
		 * one. Declared beside the target rather than hidden in the key: a
		 * station asks which blocker refuses it, so the blocker is an answer
		 * and never a fact the station already holds.
		 */
		blocker: str,
		retry_safety: { t: 'string', enum: RETRY_POSTURES },
		human_kind: str,
		note: str,
	},
	['key', 'target'],
)

/**
 * A named Routing Table: its target kind, its closed discriminant
 * vocabularies, and its rows.
 *
 * `discriminants` is the closed key space (ADR 0005): each declared
 * discriminant lists every value it admits, so the table states what a
 * complete key is rather than leaving it to whichever rows happen to exist.
 * `requires_complete_coverage` asks validation to prove every combination of
 * those values is routed, which is what makes unknown or missing evidence a
 * refusal instead of a silent gap.
 *
 * The product declares the vocabularies. Where a ruling names a closed
 * evidence set but no authoritative list exists yet, the schema can carry it
 * and the values wait for candidate authoring and admission.
 */
const routingTableShape: Shape = obj(
	{
		role: { t: 'string', enum: ROUTING_ROLES },
		target_kind: { t: 'string', enum: ROUTE_TARGET_KINDS },
		discriminants: { t: 'map', of: strArray },
		requires_complete_coverage: bool,
		rows: { t: 'array', of: routingRowShape },
		note: str,
	},
	['role', 'target_kind', 'discriminants', 'rows'],
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

/**
 * Every surface Input Schema v2 added, as dotted paths into the document.
 *
 * The declared intent of what v2 introduced. It is not the authority on its
 * own: `schema-difference.ts` computes the same set from the shapes, and a
 * test holds the two equal, so a surface added to the shape and forgotten
 * here fails loudly instead of passing because two hand-kept copies agree.
 *
 * Legacy meaning is never reverse-engineered from this list. Each superseded
 * version owns its own frozen shape (`input-schema-v1.ts`); this says what
 * the current version added on top, never what an older one lacks. Adding a
 * member is a Generator Contract change.
 */
export const V2_ONLY_SURFACE_PATHS = [
	'capabilities',
	'command_surface.bare_invocation_command',
	'command_surface.entry',
	'command_surface.positional_routes',
	'command_surface.execution_modes',
	'command_surface.preview_exemptions',
	'command_surface.root_branches',
	'expectation_columns',
	'pause_modes',
	'phase_state',
	'routing',
	'waits.observations',
	'waits.wake_routes',
] as const

export type V2OnlySurfacePath = (typeof V2_ONLY_SURFACE_PATHS)[number]

/** The whole Input Schema v2 document: the surface new generation is written against. */
export const SPECIFICATION_SHAPE: Shape = obj(
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

		/**
		 * The declared state whose values `transitions[].to_phase` names.
		 *
		 * Input Schema v2 surface. The phase-bearing state used to be found by
		 * the literal name `transaction_phase`, so a product naming it anything
		 * else got no target checking at all. The product declares it here; the
		 * generator never infers which state it is, because choosing one would
		 * publish an invented meaning as though it were admitted.
		 */
		phase_state: { t: 'string', nonEmpty: true },

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

		/**
		 * Input Schema v2 surface. Named Routing Tables: Finding-plus-evidence
		 * routing (ADR 0005), blocker-to-action mappings, fact-to-branch
		 * selection, and activation cause routing all state the same thing -
		 * a complete key selects exactly one canonical action - so they share
		 * one declared shape rather than four near-copies.
		 */
		routing: { t: 'map', of: routingTableShape },

		/**
		 * Input Schema v2 surface (ADR 0003). A declared capability, the
		 * evidence that observes whether it is installed, and both routes.
		 *
		 * Capability Availability is an installed-surface fact, never Authority:
		 * an available capability grants no permission, and an unavailable one
		 * routes to the declared escalation rather than silently disabling a
		 * command.
		 *
		 * Deliberately no `available` boolean. Whether a capability is
		 * installed is current runtime evidence, and a candidate-authored
		 * boolean would put it in a design-time specification that is admitted
		 * once and read for as long as it stands. It also decided too much:
		 * routing was required only for a capability the author wrote
		 * `false` for, so a capability declared `true` could uninstall at
		 * runtime and route nowhere.
		 *
		 * `availability_evidence` names the Extension Point whose Liveness
		 * Evidence Provider observes the capability. The provider supplies the
		 * observed value at runtime and never renews Authority; the generated
		 * Projection Composer consumes it as independent evidence rather than
		 * becoming a second action owner.
		 *
		 * Both routes are required because neither is conditional on a value
		 * the specification holds: at admission time the capability may be
		 * installed or not, and a complete specification says what happens
		 * either way.
		 */
		capabilities: {
			t: 'map',
			of: obj(
				{
					availability_evidence: { t: 'string', nonEmpty: true },
					available_action: str,
					unavailable_blocker: str,
					unavailable_action: str,
					note: str,
				},
				['availability_evidence', 'unavailable_blocker', 'unavailable_action'],
			),
		},

		/**
		 * Input Schema v2 surface (ADR 0003). An externally owned gate that
		 * suspends otherwise permitted work until its owner releases it.
		 *
		 * The release is human-owned: the product declares the blocker an
		 * active Pause Mode emits and the action that requests release, and
		 * never a route that clears the pause on the product's own authority.
		 */
		pause_modes: {
			t: 'map',
			of: obj(
				{
					owner: { t: 'string', nonEmpty: true },
					active_blocker: { t: 'string', nonEmpty: true },
					release_action: { t: 'string', nonEmpty: true },
					note: str,
				},
				['owner', 'active_blocker', 'release_action'],
			),
		},

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

		/**
		 * Input Schema v2 surface. Per-branch expectation columns a real
		 * process must be able to assert against: what the branch changed, and
		 * which channel carried its result.
		 *
		 * `changed_state` is the pivot recovery turns on, so a partial mutation
		 * is distinguishable from none and from a complete one rather than
		 * being inferred from an exit code.
		 */
		expectation_columns: {
			t: 'map',
			of: obj(
				{
					changed_state: { t: 'string', enum: CHANGED_STATES },
					channel: { t: 'string', enum: RESULT_CHANNELS },
					note: str,
				},
				[],
			),
		},

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
				/**
				 * Input Schema v2 surface. The Wake Routes this product declares,
				 * so an observation's route resolves against a named vocabulary
				 * rather than being free text a typo passes.
				 */
				wake_routes: strArray,
				/**
				 * Input Schema v2 surface (ADR 0002). One row per declared wait:
				 * how long before observing again is useful, when a single
				 * Attempt's observation stops supporting a safe State
				 * Projection, and the Wake Route that carries the caller back.
				 *
				 * Every field is required. An observation without a Wake Route
				 * leaves a caller busy-polling, and one without a missed-deadline
				 * cause expires into an unnamed state; both are the gaps that
				 * made the budgets a naming convention rather than a contract.
				 *
				 * The Attempt anchor is not declared here and cannot be: the
				 * expiry binds to one Attempt, a new Attempt gets a fresh bound,
				 * and neither polling nor a heartbeat renews one. That rule is
				 * ADR 0002's, owned by `observation-budgets.ts`, so a candidate
				 * can set the bound but never reinterpret what it anchors to.
				 */
				observations: {
					t: 'map',
					of: obj(
						{
							poll_after_ms: num,
							attempt_expiry_ms: num,
							wake_route: { t: 'string', nonEmpty: true },
							missed_deadline_cause: { t: 'string', nonEmpty: true },
							note: str,
						},
						[
							'poll_after_ms',
							'attempt_expiry_ms',
							'wake_route',
							'missed_deadline_cause',
						],
					),
				},
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
				/**
				 * Input Schema v2 surface. The command bare invocation
				 * dispatches to. v1 named the behavior but never its owner, so
				 * derivation had to match a command by naming convention.
				 */
				bare_invocation_command: { t: 'string', nonEmpty: true },
				/**
				 * Input Schema v2 surface. Commands whose subcommand arrives as
				 * a positional argument, with the action each positional
				 * selects and the action a bare invocation of that command
				 * aliases to.
				 *
				 * Command-surface routing, not evidence routing: activation
				 * declares positional actions, an explicit `activation inspect`,
				 * and the bare `activation` inspect alias, and all three are
				 * facts about how the command parses rather than about what
				 * observed evidence means.
				 */
				positional_routes: {
					t: 'map',
					of: obj(
						{
							positionals: { t: 'map', of: { t: 'string', nonEmpty: true } },
							bare_invocation_target: { t: 'string', nonEmpty: true },
							note: str,
						},
						['positionals'],
					),
				},
				/**
				 * Input Schema v2 surface. The real public entry point, so the
				 * generated Command Surface Contract states a path that exists
				 * on disk rather than one a convention implied.
				 */
				entry: obj({ script: { t: 'string', nonEmpty: true }, note: str }, [
					'script',
				]),
				/**
				 * Input Schema v2 surface. Per-command Execution Modes, and the
				 * product owner's reason when a write-implying command owes no
				 * non-mutating mode.
				 *
				 * Byte-aligned with the facade's own vocabulary; the generator
				 * refuses rather than inventing either half.
				 */
				execution_modes: {
					t: 'map',
					of: { t: 'array', of: { t: 'string', enum: EXECUTION_MODES } },
				},
				preview_exemptions: {
					t: 'map',
					of: obj({ reason: { t: 'string', nonEmpty: true } }, ['reason']),
				},
				/**
				 * Input Schema v2 surface. Public branches the front door owns
				 * rather than any one command: root help, an unknown command,
				 * and the crash path. Each declares the exit code it rides and
				 * what that exit means, so a declared exit-1 meaning is never
				 * shared by two branches that mean different things.
				 */
				root_branches: {
					t: 'map',
					of: obj(
						{
							exit_code: { t: 'string', enum: BASELINE_EXIT_CODES },
							meaning: { t: 'string', nonEmpty: true },
							action: str,
							note: str,
						},
						['exit_code', 'meaning'],
					),
				},
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

/**
 * Mutation kinds that declare an externally meaningful effect.
 *
 * The single sealed owner of "write-implying". Structural validation, station
 * derivation, Command Surface Contract emission, and retry-posture resolution
 * all read this list; a second copy would let two stages disagree about
 * whether a command owes the Write Preview Capability obligation.
 */
export const WRITE_IMPLYING_MUTATIONS = [
	'remote_write',
	'local_write',
	'recovery',
] as const

export type WriteImplyingMutation = (typeof WRITE_IMPLYING_MUTATIONS)[number]

/** Every mutation value the two candidates use; a sealed branch vocabulary. */
export const MUTATION_KINDS = [
	...WRITE_IMPLYING_MUTATIONS,
	'read',
	'preview',
] as const

type MutationKind = (typeof MUTATION_KINDS)[number]

export function isWriteImplyingMutation(
	mutation: string,
): mutation is WriteImplyingMutation {
	return (WRITE_IMPLYING_MUTATIONS as readonly string[]).includes(mutation)
}

/**
 * The public branches one command reaches. Sealed so a branch cannot be added
 * without deciding its exit code, envelope status, and semantic row together.
 */
const BRANCH_KINDS = ['success', 'refused', 'invalid_usage'] as const

export type BranchKind = (typeof BRANCH_KINDS)[number]
