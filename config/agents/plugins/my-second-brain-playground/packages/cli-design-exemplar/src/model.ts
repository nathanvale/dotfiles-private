// Domain types only. No behaviour lives here (brief 12, section 6).

import type { CommandIdentity } from "./command-contract.ts"

export type EffectId = "effect.update-index" | "effect.write-journal" | "effect.repair-cache"

export interface Resource {
	resource: string
	revision: number
	status: "healthy" | "index-missing"
	version: number
	[extra: string]: unknown
}

export interface Preview {
	preview_id: string
	kind: "apply" | "repair"
	resource_revision: number
	expected_effect_ids: EffectId[]
	consumed: boolean
	consumed_by_run?: string
}

export type JournalRecord =
	| { kind: "intent"; seq: number; run: string; effect: EffectId; operation: string; preview_id: string }
	| { kind: "completed"; seq: number; run: string; effect: EffectId; operation: string; preview_id: string; resource_revision: number }
	| { kind: "event"; seq: number; run: string; effect: EffectId; operation: string; preview_id: string; summary: string }

// The closed fault channel (brief 12, section 3.1). One domain fault and at most one egress fault per process.
export type DomainFault =
	| "effect.write-journal-outcome-unknown"
	| "one-transient-lock"
	| "persistent-lock"
	| "silent-no-op"
	| "throw-internal"
	| "sink-throw"
	| "sink-dispose-throw"
	| "diagnostics-flood"
	| { kind: "halt-before-effect"; effectId: EffectId }
	| { kind: "halt-after-effect"; effectId: EffectId }

export type EgressFault =
	| { kind: "egress-non-json"; variant: "cycle" | "depth65" | "date" | "undefined" | "function" | "bigint" | "nan" | "infinity" }
	| { kind: "egress-schema-invalid"; variant: "non-string-message" | "extra-key" | "bad-enum" | "both-guidance" }

export interface Faults {
	domain: DomainFault | null
	egress: EgressFault | null
}

export type DomainOutcome = "success" | "refused" | "failed" | "unknown"
export type TransactionState = "unchanged" | "completed" | "partially-completed" | "unknown"
export type EffectClass = "inspect" | "repository-local" | "external"

export type Guidance = { kind: "next-action"; target: "repair-lab inspect" | "repair-lab recover" } | { kind: "handoff"; station: "repair-lab.required-handoff" }

// Execution facts recorded before any result object is rendered; the egress fallback carries them (brief 12, 7.2).
export interface ExecutionFacts {
	commandIdentity: CommandIdentity
	runIdentity: string
	domainOutcome: DomainOutcome
	effectClass: EffectClass
	transactionState: TransactionState
	completedEffectIds: EffectId[]
	remainingEffectIds: EffectId[]
	stationLabel: string
	guidance: Guidance
}

// Write-boundary facts the runtime records as it crosses each boundary (brief 12, section 5, W0 through W5).
export interface WriteFacts {
	durableWriteAttempted: boolean
	intentRecorded: EffectId[]
	completed: EffectId[]
	remaining: EffectId[]
}
