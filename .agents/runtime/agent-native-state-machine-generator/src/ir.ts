/**
 * Canonical typed intermediate representation.
 *
 * The IR is the compiler's output contract for stage 1. It is produced only
 * when zero diagnostics were raised, so every reference it holds is resolved
 * and every vocabulary it names is sealed.
 */
import type { NextSafeActionKind, RetryPosture } from './schema.ts'

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
	readonly flags: Readonly<Record<string, readonly string[]>>
	readonly mutations: Readonly<Record<string, string>>
	readonly resultContracts: Readonly<Record<string, { readonly id: string; readonly version: number }>>
}

export interface SpecificationIr {
	readonly specMeta: SpecMeta
	readonly features: Features
	readonly states: readonly StateDefinition[]
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
	readonly commandSurface: CommandSurface
	readonly entityNames: readonly string[]
	readonly invariantIds: readonly string[]
	readonly unresolvedDecisionIds: readonly string[]
	/** The full canonical document, key-sorted; the digest is taken over this. */
	readonly canonical: unknown
}
