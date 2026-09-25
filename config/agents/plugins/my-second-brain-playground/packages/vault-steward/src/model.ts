// Domain types and sealed vocabularies of the Vault Steward CLI. No behaviour lives here.
// Naming register: CLI-BRIEF.md section 7 and CONTRACT.md 1.2 (frozen strings).

export const schemaVersion = 1 as const
export const manifestName = "vault-note-commit.json"
export const runIdPattern = /^vnc-[a-f0-9]{32}$/
export const commitPattern = /^[a-f0-9]{40,64}$/
export const lockDirectoryName = "vault-note-commits.lock"
export const invalidLockOwnerGraceMs = 1_000
export const selfTestTimeoutMs = 2_000
export const hookName = "reference-transaction"
export const guardDeniedCode = "VAULT_GUARD_BRANCH_CREATE_DENIED"
export const guardFailOpenCode = "VAULT_GUARD_FAIL_OPEN"

export interface Manifest {
	schemaVersion: 1
	runId: string
	vault: string
	worktree: string
	commonGitDirectory: string
	baseCommit: string
	paths: string[]
}

export type ReceiptCode = "INTEGRATED" | "NO_CHANGES"

export interface Receipt extends Manifest {
	code: ReceiptCode
	commit?: string
}

// A receipt that passed storage, shape, identity, and Git evidence validation, with the path it was read from.
export interface ValidReceipt {
	receipt: Receipt
	path: string
}

export type SelfTest = "pass" | "incompatible" | "probe-allowed" | "error" | "skipped" | "missing"

export interface GuardStatus {
	installed: boolean
	executable: boolean
	hookPath: string | null
	current: boolean | null
	selfTest: SelfTest
	hooksPathOverride: string | null
	branches: string[]
	worktrees: string[]
}

export const WARNING_CODES = [
	"GUARD_MISSING",
	"GUARD_STALE",
	"GUARD_PROBE_ALLOWED",
	"GUARD_SELFTEST_ERROR",
	"BRANCH_SPRAWL_PRESENT",
	"FOREIGN_WORKTREE_PRESENT",
	"HOOKS_PATH_OVERRIDE",
] as const
export type WarningCode = (typeof WARNING_CODES)[number]

export interface Warning {
	code: WarningCode
	detail: string
}

export interface GuardObservation {
	guard: GuardStatus
	warnings: Warning[]
}

// Where a candidate stands after validation: a commit to integrate, no authored change, or a commit that Git already
// proves is on main (hazard H1, CONTRACT.md 4.2 A4) so only the completion record is missing.
export type CandidateState =
	| { kind: "commit"; commit: string }
	| { kind: "no-changes" }
	| { kind: "already-on-main"; commit: string }

export interface Completion {
	code: ReceiptCode
	commit: string | undefined
	receipt: string
	removed: boolean
}

export type TransactionState = "unchanged" | "partially-completed" | "unknown"

// The closed refusal vocabulary of the engine. Each reason maps to exactly one Contract Core 2.0 cause (CONTRACT.md 3.3).
export const REASON_CAUSES = {
	"config-home-invalid": "SCHEMA_INVALID_INPUT",
	"config-absent": "DOMAIN_CONFIG_MISSING",
	"config-unparseable": "SCHEMA_CONFIG_INVALID",
	"config-off-schema": "SCHEMA_CONFIG_INVALID",
	"vault-not-found": "DOMAIN_VAULT_NOT_FOUND",
	"not-canonical-main": "DOMAIN_CANONICAL_NOT_MAIN",
	"path-form-invalid": "SCHEMA_INVALID_INPUT",
	"path-escapes-vault": "DOMAIN_PATH_REFUSED",
	"path-symlink-component": "DOMAIN_PATH_REFUSED",
	"state-home-missing": "SCHEMA_INVALID_INPUT",
	"git-failed": "INTERNAL_GIT_FAILED_UNCHANGED",
	"candidate-not-found": "DOMAIN_CANDIDATE_NOT_FOUND",
	"manifest-invalid": "SCHEMA_MANIFEST_INVALID",
	"receipt-invalid": "SCHEMA_RECEIPT_INVALID",
	"guard-incompatible": "DOMAIN_GUARD_INCOMPATIBLE",
	"candidate-changed-after-commit": "DOMAIN_CANDIDATE_INVALID",
	"candidate-history-invalid": "DOMAIN_CANDIDATE_INVALID",
	"check-changed-candidate": "DOMAIN_CANDIDATE_INVALID",
	"path-set-mismatch": "DOMAIN_PATH_SET_MISMATCH",
	"path-set-changed-by-checker": "DOMAIN_PATH_SET_MISMATCH",
	"check-failed": "DOMAIN_CHECK_FAILED",
	"format-failed": "DOMAIN_FORMAT_FAILED",
	"integration-busy": "TRANSIENT_INTEGRATION_BUSY",
	"canonical-not-ready": "DOMAIN_CANONICAL_NOT_READY",
	"main-diverged": "DOMAIN_MAIN_DIVERGED",
	"semantic-overlap": "DOMAIN_SEMANTIC_OVERLAP",
	"rebase-failed": "DOMAIN_REBASE_CONFLICT",
	// A rebased commit whose paths differ from the admitted set is an invalid candidate (the pre-rebase commit is restored,
	// A8); the separate REBASED_PATH_SET_MISMATCH code stays off the wire (vault decision 2026-09-19).
	"rebased-path-set-mismatch": "DOMAIN_CANDIDATE_INVALID",
	"rebased-check-failed": "DOMAIN_REBASED_CHECK_FAILED",
	"integration-unproved": "INTERNAL_INTEGRATION_UNPROVED",
	"completion-record-failed": "INTERNAL_COMPLETION_RECORD_FAILED",
	"unexpected": "INTERNAL_UNEXPECTED_UNCHANGED",
	"preview-not-found": "DOMAIN_PREVIEW_NOT_FOUND",
	"preview-consumed": "DOMAIN_PREVIEW_CONSUMED",
	"preview-stale": "DOMAIN_PREVIEW_STALE",
	"preview-invalid": "SCHEMA_PREVIEW_INVALID",
	"recovery-unprovable": "DOMAIN_RECOVERY_UNPROVABLE",
	"input-invalid": "SCHEMA_INVALID_INPUT",
} as const
export type RefusalReason = keyof typeof REASON_CAUSES
export type ProductCause = (typeof REASON_CAUSES)[RefusalReason] | "INTERNAL_GIT_FAILED_PARTIAL" | "INTERNAL_GIT_FAILED_UNKNOWN" | "INTERNAL_INTEGRATION_UNPROVED_UNCHANGED" | "INTERNAL_UNEXPECTED_UNKNOWN"

// The CONTRACT.md 3.3 name of a refusal, split by transaction state where the design splits it.
export function productCause(reason: RefusalReason, transaction: TransactionState): ProductCause {
	if (reason === "git-failed") return transaction === "unchanged" ? "INTERNAL_GIT_FAILED_UNCHANGED" : transaction === "partially-completed" ? "INTERNAL_GIT_FAILED_PARTIAL" : "INTERNAL_GIT_FAILED_UNKNOWN"
	if (reason === "unexpected") return transaction === "unchanged" ? "INTERNAL_UNEXPECTED_UNCHANGED" : "INTERNAL_UNEXPECTED_UNKNOWN"
	if (reason === "integration-unproved" && transaction === "unchanged") return "INTERNAL_INTEGRATION_UNPROVED_UNCHANGED"
	// A completion record that failed before its first write (the ref) changed nothing: that is the Git failure itself.
	if (reason === "completion-record-failed" && transaction === "unchanged") return "INTERNAL_GIT_FAILED_UNCHANGED"
	return REASON_CAUSES[reason]
}

// Effect identities of the 2.0 inventories (CONTRACT.md 3.4; the candidate rebase is a published exclusion).
export type EffectId = "candidate.manifest" | "candidate.worktree" | "candidate.commit" | "preview.record" | "main.fast-forward" | "completion.ref" | "completion.receipt"

export interface PreviewPlan {
	kind: "integrate" | "no-changes"
	rebase: boolean
	expectedEffects: EffectId[]
}

// Run store preview record (CONTRACT.md 3.7): the durable binding an apply must match before its first effect.
export interface PreviewRecord {
	schemaVersion: 1
	previewId: string
	runId: string
	worktree: string
	commonGitDirectory: string
	baseCommit: string
	candidateCommit: string | null
	observedMain: string
	paths: string[]
	plan: PreviewPlan
	consumed: boolean
	createdBy: string
	consumedBy?: string
}

// Facts a refusal carries for its front door to render. Every field is optional because each reason admits its own set.
export interface RefusalFacts {
	runId?: string | null
	worktree?: string
	commit?: string
	paths?: string[]
	receipt?: string
	diagnosticsPath?: string
	diagnostics?: string[]
	detail?: string
	overlap?: string[]
	ref?: string
	// True when the begin candidate worktree exists at refusal time (hazard H2, CONTRACT.md 4.2 A5).
	worktreeCreated?: boolean
	// True when the completion record failed after main was fast-forwarded (as opposed to a no-changes record).
	afterFastForward?: boolean
	// True when the refusal happened after a rebase moved the candidate commit (hazard H3, CONTRACT.md 4.2 A6).
	afterRebase?: boolean
	// The guard observation completed before a guard refusal, so front doors can still report it.
	guard?: GuardObservation
	// Effects the 2.0 front door reports as completed or uncertain when the refusal is not unchanged.
	completedEffects?: EffectId[]
	uncertainEffects?: EffectId[]
}
