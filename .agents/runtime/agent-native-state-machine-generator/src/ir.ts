/**
 * Canonical typed intermediate representation.
 *
 * The IR is the compiler's output contract for stage 1. It is produced only
 * when zero diagnostics were raised, so every reference it holds is resolved
 * and every vocabulary it names is sealed.
 */
import type {
	ChangedState,
	ExecutionMode,
	NextSafeActionKind,
	ResultChannel,
	RetryPosture,
	RouteTargetKind,
	RoutingRole,
} from './schema.ts'

/**
 * One Routing Table row: a complete key selecting exactly one canonical
 * action. A key no row covers selects nothing.
 */
export interface RoutingRow {
	readonly key: Readonly<Record<string, string>>
	/** Read under the owning table's `targetKind`. */
	readonly target: string
	/** The blocker this route reports, where its role declares one. */
	readonly blocker?: string
	readonly retrySafety?: RetryPosture
	readonly humanKind?: string
}

/**
 * A named Routing Table: what its rows select, the closed key space they
 * select on, and whether every declared combination must route.
 */
export interface RoutingTable {
	readonly name: string
	/** What derivation may use this table for, declared by the product. */
	readonly role: RoutingRole
	readonly targetKind: RouteTargetKind
	readonly discriminants: Readonly<Record<string, readonly string[]>>
	readonly requiresCompleteCoverage: boolean
	readonly rows: readonly RoutingRow[]
}

/** A command whose subcommand arrives positionally. */
export interface PositionalRoute {
	readonly command: string
	readonly positionals: Readonly<Record<string, string>>
	readonly bareInvocationTarget?: string
}

/**
 * A declared capability, the evidence that observes it, and both routes.
 *
 * Carries no current value. Whether the capability is installed is runtime
 * evidence a Liveness Evidence Provider supplies against
 * `availabilityEvidence`; the specification declares only what is true either
 * way, so routing is complete rather than conditional on an authored boolean.
 */
export interface CapabilityAvailability {
	readonly name: string
	/** Extension Point id of the provider that observes this capability. */
	readonly availabilityEvidence: string
	/** Where an available capability routes, when the product declares one. */
	readonly availableAction?: string
	readonly unavailableBlocker: string
	readonly unavailableAction: string
}

/** An externally owned gate; its release is human-owned. */
export interface PauseMode {
	readonly name: string
	readonly owner: string
	readonly activeBlocker: string
	readonly releaseAction: string
}

/** One declared wait: when to observe again, and when an Attempt's evidence expires. */
export interface ObservationBudget {
	readonly name: string
	readonly pollAfterMs: number
	readonly attemptExpiryMs: number
	readonly wakeRoute?: string
	readonly missedDeadlineCause?: string
}

/** A public branch the front door owns rather than any one command. */
export interface RootBranch {
	readonly name: string
	readonly exitCode: string
	readonly meaning: string
	readonly action?: string
}

/** Per-branch columns a real process asserts against. */
export interface ExpectationColumns {
	readonly name: string
	readonly changedState?: ChangedState
	readonly channel?: ResultChannel
}

export interface SpecMeta {
	readonly product: string
	readonly inputSchemaVersion: string
	readonly productSpecificationRevision?: string
	readonly stateMachineDefinitionVersion?: string
	readonly publicResultSchemaVersion?: string
	readonly activationResultSchemaVersion?: string
}

export interface Features {
	readonly durableOperations: boolean
	readonly livenessEvidence: boolean
	readonly cancellation: 'not_supported' | 'partial' | 'supported'
	readonly versionCustody: boolean
	readonly remoteAuthority: boolean
	readonly featureGates: readonly string[]
}

export interface ActionEntry {
	readonly id: string
	readonly kind: NextSafeActionKind
	readonly humanKind?: string
	readonly stopScope?: 'domain_terminal' | 'agent_terminal'
	readonly owner?: string
	readonly condition?: string
	readonly inputContract?: string
	readonly requiresContext: readonly string[]
	readonly requiresFeature?: string
	readonly note?: string
}

export interface StateDefinition {
	readonly name: string
	readonly values: readonly string[]
	readonly terminal: readonly string[]
	readonly humanTerminal: readonly string[]
	readonly absorbing: readonly string[]
	readonly observationSourced: readonly string[]
	readonly phases: readonly string[]
	readonly checkpoints: readonly string[]
	readonly projectionFromPhase?: Readonly<Record<string, string>>
	readonly role?: string
}

export interface TransitionEntry {
	readonly event: string
	readonly toPhase: string
	readonly driver: string
	readonly via?: string
}

export interface RetryRule {
	readonly when: Readonly<Record<string, string | readonly string[]>>
	readonly then: RetryPosture
}

export interface CommandSurface {
	readonly commands: readonly string[]
	readonly exitCodes: Readonly<Record<string, string>>
	readonly globalFlags: readonly string[]
	readonly outputModesDefault: readonly string[]
	readonly outputModesOverrides: Readonly<Record<string, readonly string[]>>
	readonly noArgumentBehavior: string
	/** The command bare invocation dispatches to, when the product declares one. */
	readonly bareInvocationCommand?: string
	/** The real public entry point, so a generated contract names a path that exists. */
	readonly entryScript?: string
	readonly executionModes: Readonly<Record<string, readonly ExecutionMode[]>>
	readonly previewExemptions: Readonly<Record<string, string>>
	readonly rootBranches: readonly RootBranch[]
	readonly positionalRoutes: readonly PositionalRoute[]
	readonly flags: Readonly<Record<string, readonly string[]>>
	readonly mutations: Readonly<Record<string, string>>
	readonly resultContracts: Readonly<
		Record<string, { readonly id: string; readonly version: number }>
	>
}

export interface SpecificationIr {
	readonly specMeta: SpecMeta
	readonly features: Features
	readonly states: readonly StateDefinition[]
	/**
	 * The declared state whose values `transitions[].toPhase` names, absent
	 * when the candidate declares no transitions.
	 */
	readonly phaseState?: string
	readonly transitions: readonly TransitionEntry[]
	readonly blockers: readonly string[]
	readonly actions: {
		readonly kinds: readonly NextSafeActionKind[]
		readonly catalog: readonly ActionEntry[]
		readonly resolution?: {
			readonly missingContext?: string
			readonly unavailableProjectionBlocker?: string
			readonly unavailableProjectionRetrySafety?: RetryPosture
			readonly unavailableProjectionStop?: 'domain_terminal' | 'agent_terminal'
		}
	}
	readonly retryPosture: {
		readonly values: readonly RetryPosture[]
		readonly rules: readonly RetryRule[]
		readonly neverAutoRetry: readonly string[]
	}
	/** Named Routing Tables, sorted by table name. */
	readonly routing: readonly RoutingTable[]
	readonly capabilities: readonly CapabilityAvailability[]
	readonly pauseModes: readonly PauseMode[]
	readonly observations: readonly ObservationBudget[]
	readonly expectationColumns: readonly ExpectationColumns[]
	/**
	 * Public compatibility identifiers and the canonical action ids they
	 * resolve to once context is supplied. Never a second action vocabulary.
	 */
	readonly contextualRenderings: Readonly<Record<string, readonly string[]>>
	readonly commandSurface: CommandSurface
	readonly entityNames: readonly string[]
	readonly invariantIds: readonly string[]
	readonly unresolvedDecisionIds: readonly string[]
	/** The full canonical document, key-sorted; the digest is taken over this. */
	readonly canonical: unknown
}
