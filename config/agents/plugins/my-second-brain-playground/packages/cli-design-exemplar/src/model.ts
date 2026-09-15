// Domain types and the sealed vocabularies that define them. No behaviour lives here (brief 12, section 6).

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

// Journal revision 2 records (O1 Candidate A, ticket freeze 2026-09-15). An intent carries the observation tuple that
// recovery classifies against: the SHA-256 of the exact bytes before the effect (null for effect.write-journal) and of
// the exact bytes the effect must produce (the resource serialization, or the event payload). A completed record carries
// the digest of the bytes the read-back observed; it corroborates but never establishes an effect.
export type JournalRecord =
	| { kind: "intent"; seq: number; run: string; effect: EffectId; operation: string; preview_id: string; before_sha256: string | null; expected_after_sha256: string }
	| { kind: "completed"; seq: number; run: string; effect: EffectId; operation: string; preview_id: string; resource_revision: number; observed_after_sha256: string }
	| { kind: "event"; seq: number; run: string; effect: EffectId; operation: string; preview_id: string; summary: string }

// One validated frame of the journal scan with its payload digest, and the two reasons a scan can be incomplete: a torn
// final fragment (no terminal LF) or bytes beyond the scan bound that were never read.
export interface JournalEntry {
	record: JournalRecord
	payloadSha256: string
}
export interface JournalScan {
	entries: JournalEntry[]
	torn: boolean
	exceedsScanBound: boolean
}

// The closed fault channel (brief 12, section 3.1). One domain fault and at most one egress fault per process. The
// named domain faults are one sealed vocabulary: the runtime's token parser admits exactly this tuple.
export const DOMAIN_FAULT_NAMES = ["effect.write-journal-outcome-unknown", "one-transient-lock", "persistent-lock", "silent-no-op", "throw-internal", "sink-throw", "sink-dispose-throw", "diagnostics-flood", "journal-contention"] as const
export type DomainFault =
	| (typeof DOMAIN_FAULT_NAMES)[number]
	| { kind: "halt-before-effect"; effectId: EffectId }
	| { kind: "halt-after-effect"; effectId: EffectId }
	| { kind: "readback-fail"; effectId: EffectId }

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
	// False only when the journal scan stopped at its bound, so the plan's classification may be missing evidence.
	inventoryComplete: boolean
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
