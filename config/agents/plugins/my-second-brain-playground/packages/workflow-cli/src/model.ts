// Domain types for the msb-workflow recovery helper. No behaviour lives here.

export type DomainOutcome = "success" | "refused" | "failed" | "unknown"
export type TransactionState = "unchanged" | "completed" | "partially-completed" | "rolled-back" | "unknown"
export type EffectClass = "inspect" | "repository-local" | "external"

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

/** The one durable record this helper owns: the private schema-v3 session binding. The field set is closed. */
export interface RecoveryBinding {
	readonly schemaVersion: 3
	readonly sessionIdentity: string
	readonly workspace: string
	readonly storePath: string
	readonly storePrefix: string
	readonly beadsExecutable: string
	readonly beadsVersion: string
	readonly beadId: string
	/** The Bead's updated_at at bind time. A hint only; the pinned bd exposes no revision. */
	readonly beadObservedAt: string
	readonly sourceRepository: string
	readonly evidencePath: string | null
	readonly observedAt: string
}

/** Facts about the selected store, verified through read-only native reads. */
export interface StoreFacts {
	readonly executable: string
	readonly executableDigest: string
	readonly version: string
	readonly storePath: string
	readonly prefix: string
}

export interface BeadComment {
	readonly author: string
	readonly createdAt: string
	readonly text: string
}

export interface BeadDependency {
	readonly id: string
	readonly title: string
	readonly status: string
	readonly issueType: string
	readonly dependencyType: string
	readonly awaitType: string | null
}

/** One Bead as the pinned `bd show --json --include-comments` reports it, reduced to the panel's needs. */
export interface BeadFacts {
	readonly id: string
	readonly title: string
	readonly status: string
	readonly assignee: string | null
	readonly parent: string | null
	readonly labels: readonly string[]
	readonly specId: string | null
	readonly externalRef: string | null
	readonly updatedAt: string | null
	readonly dependencies: readonly BeadDependency[]
	readonly comments: readonly BeadComment[]
}

export interface GateFacts {
	readonly id: string
	readonly title: string
	readonly status: string
	readonly awaitType: string | null
}

/** A command body's answer: one Branch Station, its public facts, and the primary result. */
export interface CommandOutcome {
	readonly station: string
	readonly message: string
	readonly result: JsonObject
	readonly repairAction: string | null
	readonly nextAction: string | null
	readonly availablePaths: readonly string[]
	readonly handoffPrerequisites: readonly string[]
}
