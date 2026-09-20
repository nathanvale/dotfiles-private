import type { StationRow } from "./command-contract.ts"

// Catalogue leaf: the literal Branch Station declarations (CONTRACT.md section 5 with the product causes on the wire).
// Each row names every next-action identity it may emit. Derivation and lookup live in branch-station-catalog.ts.

type Row = readonly [
	StationRow["commandIdentity"],
	StationRow["outcome"],
	StationRow["causeCode"],
	StationRow["effectClass"],
	StationRow["transactionState"],
	StationRow["retryable"],
	StationRow["retryDelayMilliseconds"],
	StationRow["guidance"],
	StationRow["exit"],
	StationRow["nextActions"],
	StationRow["reachability"],
	StationRow["unreachableRationale"],
]

const HELP = "vault-steward.help"
const DISCOVERY = "vault-steward.discovery"
const BEGIN = "vault-steward.begin"
const PREVIEW = "vault-steward.finish-preview"
const APPLY = "vault-steward.finish-apply"
const INSPECT = "vault-steward.inspect"
const RECOVER = "vault-steward.recover"
const EVERY_COMMAND = ["vault-steward.begin", "vault-steward.command-discovery", "vault-steward.discovery", "vault-steward.dispatch", "vault-steward.finish-apply", "vault-steward.finish-preview", "vault-steward.help", "vault-steward.inspect", "vault-steward.recover"] as const
const HANDOFF: readonly [] = []
const RECORD_UNREACHABLE = "recordCompletion classifies every failure of its two writes by evidence (INTERNAL_GIT_FAILED_UNCHANGED before the ref, INTERNAL_COMPLETION_RECORD_FAILED after it); no write in this command can end with an unestablished result"

type Tail = readonly [StationRow["retryable"], StationRow["retryDelayMilliseconds"], StationRow["guidance"], StationRow["exit"]]
const N0: Tail = [false, null, "next-action", 0]
const N2: Tail = [false, null, "next-action", 2]
const N3: Tail = [false, null, "next-action", 3]
const N4: Tail = [false, null, "next-action", 4]
const H3: Tail = [false, null, "handoff", 3]
const H4: Tail = [false, null, "handoff", 4]
const H1: Tail = [false, null, "handoff", 1]
const N1: Tail = [false, null, "next-action", 1]
const T75: Tail = [true, 2000, "next-action", 75]
const RL = "repository-local"

// Keep the declarations literal: the contract derives its finite StationId vocabulary from this single production owner.
const ROWS = [
	// Built-ins
	["vault-steward.help", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", ...N0, [DISCOVERY], "required", null],
	["vault-steward.help", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.discovery", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", ...N0, ["vault-steward.command-discovery"], "required", null],
	["vault-steward.discovery", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.command-discovery", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", ...N0, EVERY_COMMAND, "required", null],
	["vault-steward.command-discovery", "refused", "USAGE_UNKNOWN_COMMAND", "inspect", "unchanged", ...N2, [DISCOVERY], "required", null],
	["vault-steward.command-discovery", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.dispatch", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.dispatch", "refused", "USAGE_UNKNOWN_COMMAND", "inspect", "unchanged", ...N2, [HELP], "required", null],
	// begin
	["vault-steward.begin", "success", "SUCCESS_COMPLETED", RL, "completed", ...N0, [PREVIEW], "required", null],
	["vault-steward.begin", "success", "SUCCESS_UNCHANGED", RL, "unchanged", ...N0, [BEGIN], "required", null],
	["vault-steward.begin", "refused", "USAGE_INVALID_INVOCATION", RL, "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.begin", "refused", "SCHEMA_INVALID_INPUT", RL, "unchanged", ...N4, [HELP], "required", null],
	["vault-steward.begin", "refused", "SCHEMA_CONFIG_INVALID", RL, "unchanged", ...N4, [HELP], "required", null],
	["vault-steward.begin", "refused", "DOMAIN_CONFIG_MISSING", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.begin", "refused", "DOMAIN_VAULT_NOT_FOUND", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.begin", "refused", "DOMAIN_CANONICAL_NOT_MAIN", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.begin", "refused", "DOMAIN_PATH_REFUSED", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.begin", "refused", "DOMAIN_GUARD_INCOMPATIBLE", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.begin", "failed", "INTERNAL_GIT_FAILED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	["vault-steward.begin", "failed", "INTERNAL_GIT_FAILED_PARTIAL", RL, "partially-completed", ...H1, HANDOFF, "required", null],
	["vault-steward.begin", "failed", "INTERNAL_UNEXPECTED_UNKNOWN", RL, "unknown", ...H1, HANDOFF, "required", null],
	["vault-steward.begin", "failed", "INTERNAL_UNEXPECTED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	// finish --preview
	["vault-steward.finish-preview", "success", "SUCCESS_COMPLETED", RL, "completed", ...N0, [APPLY], "required", null],
	["vault-steward.finish-preview", "success", "SUCCESS_UNCHANGED", RL, "unchanged", ...N0, [INSPECT], "required", null],
	["vault-steward.finish-preview", "refused", "USAGE_INVALID_INVOCATION", RL, "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.finish-preview", "refused", "SCHEMA_INVALID_INPUT", RL, "unchanged", ...N4, [HELP], "required", null],
	["vault-steward.finish-preview", "refused", "SCHEMA_MANIFEST_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.finish-preview", "refused", "SCHEMA_RECEIPT_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_CANDIDATE_NOT_FOUND", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_CANONICAL_NOT_MAIN", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_GUARD_INCOMPATIBLE", RL, "unchanged", ...N3, [INSPECT], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_PATH_SET_MISMATCH", RL, "unchanged", ...N3, [PREVIEW], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_CHECK_FAILED", RL, "unchanged", ...N3, [PREVIEW], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_FORMAT_FAILED", RL, "unchanged", ...N3, [PREVIEW], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_CANDIDATE_INVALID", RL, "unchanged", ...H3, HANDOFF, "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_MAIN_DIVERGED", RL, "unchanged", ...H3, HANDOFF, "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_SEMANTIC_OVERLAP", RL, "unchanged", ...H3, HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_GIT_FAILED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_GIT_FAILED_UNKNOWN", RL, "unknown", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_UNEXPECTED_UNKNOWN", RL, "unknown", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_UNEXPECTED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	// finish --apply
	["vault-steward.finish-apply", "success", "SUCCESS_COMPLETED", RL, "completed", ...N0, [INSPECT], "required", null],
	["vault-steward.finish-apply", "success", "SUCCESS_UNCHANGED", RL, "unchanged", ...N0, [INSPECT], "required", null],
	["vault-steward.finish-apply", "refused", "USAGE_INVALID_INVOCATION", RL, "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.finish-apply", "refused", "SCHEMA_INVALID_INPUT", RL, "unchanged", ...N4, [HELP], "required", null],
	["vault-steward.finish-apply", "refused", "SCHEMA_MANIFEST_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.finish-apply", "refused", "SCHEMA_RECEIPT_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.finish-apply", "refused", "SCHEMA_PREVIEW_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_CANDIDATE_NOT_FOUND", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_CANONICAL_NOT_MAIN", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_PREVIEW_NOT_FOUND", RL, "unchanged", ...N3, [PREVIEW], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_PREVIEW_CONSUMED", RL, "unchanged", ...N3, [INSPECT], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_PREVIEW_STALE", RL, "unchanged", ...N3, [PREVIEW], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_GUARD_INCOMPATIBLE", RL, "unchanged", ...N3, [INSPECT], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_CANONICAL_NOT_READY", RL, "unchanged", ...N3, [APPLY], "required", null],
	["vault-steward.finish-apply", "failed", "DOMAIN_REBASED_CHECK_FAILED", RL, "unchanged", ...N3, [PREVIEW], "required", null],
	["vault-steward.finish-apply", "failed", "DOMAIN_REBASE_CONFLICT", RL, "unchanged", ...H3, HANDOFF, "required", null],
	["vault-steward.finish-apply", "refused", "TRANSIENT_INTEGRATION_BUSY", RL, "unchanged", ...T75, [APPLY], "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_INTEGRATION_UNPROVED", RL, "unknown", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_INTEGRATION_UNPROVED_UNCHANGED", RL, "unchanged", ...N1, [PREVIEW], "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_COMPLETION_RECORD_FAILED", RL, "partially-completed", ...N1, [RECOVER], "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_GIT_FAILED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_GIT_FAILED_UNKNOWN", RL, "unknown", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_UNEXPECTED_UNKNOWN", RL, "unknown", ...H1, HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_UNEXPECTED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	// inspect
	["vault-steward.inspect", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", ...N0, [BEGIN, PREVIEW, APPLY, RECOVER, INSPECT], "required", null],
	["vault-steward.inspect", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.inspect", "refused", "SCHEMA_INVALID_INPUT", "inspect", "unchanged", ...N4, [HELP], "required", null],
	["vault-steward.inspect", "failed", "INTERNAL_GIT_FAILED_UNCHANGED", "inspect", "unchanged", ...H1, HANDOFF, "required", null],
	["vault-steward.inspect", "failed", "INTERNAL_UNEXPECTED_UNCHANGED", "inspect", "unchanged", ...H1, HANDOFF, "required", null],
	// recover
	["vault-steward.recover", "success", "SUCCESS_COMPLETED", RL, "completed", ...N0, [INSPECT], "required", null],
	["vault-steward.recover", "success", "SUCCESS_UNCHANGED", RL, "unchanged", ...N0, [INSPECT], "required", null],
	["vault-steward.recover", "refused", "USAGE_INVALID_INVOCATION", RL, "unchanged", ...N2, [HELP], "required", null],
	["vault-steward.recover", "refused", "SCHEMA_INVALID_INPUT", RL, "unchanged", ...N4, [HELP], "required", null],
	["vault-steward.recover", "refused", "SCHEMA_MANIFEST_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.recover", "refused", "SCHEMA_RECEIPT_INVALID", RL, "unchanged", ...H4, HANDOFF, "required", null],
	["vault-steward.recover", "refused", "DOMAIN_CANDIDATE_NOT_FOUND", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.recover", "refused", "DOMAIN_CANONICAL_NOT_MAIN", RL, "unchanged", ...N3, [BEGIN], "required", null],
	["vault-steward.recover", "refused", "DOMAIN_GUARD_INCOMPATIBLE", RL, "unchanged", ...N3, [INSPECT], "required", null],
	["vault-steward.recover", "refused", "DOMAIN_RECOVERY_UNPROVABLE", RL, "unchanged", ...H3, HANDOFF, "required", null],
	["vault-steward.recover", "refused", "TRANSIENT_INTEGRATION_BUSY", RL, "unchanged", ...T75, [RECOVER], "required", null],
	["vault-steward.recover", "failed", "INTERNAL_COMPLETION_RECORD_FAILED", RL, "partially-completed", ...N1, [RECOVER], "required", null],
	["vault-steward.recover", "failed", "INTERNAL_GIT_FAILED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
	["vault-steward.recover", "failed", "INTERNAL_UNEXPECTED_UNKNOWN", RL, "unknown", ...H1, HANDOFF, "declared-unreachable", RECORD_UNREACHABLE],
	["vault-steward.recover", "failed", "INTERNAL_UNEXPECTED_UNCHANGED", RL, "unchanged", ...H1, HANDOFF, "required", null],
] as const satisfies readonly Row[]

export type StationIdOf<RowTuple> = RowTuple extends readonly [infer Command extends string, infer Outcome extends string, infer Cause extends string, ...readonly unknown[]] ? `["${Command}","${Outcome}","${Cause}"]` : never

/** The sealed identity vocabulary declared by this production catalogue: the JSON tuple encoding of every row. */
export type DefinedStationId = StationIdOf<(typeof ROWS)[number]>

const DECLARED_ROWS: readonly StationRow[] = ROWS.map(([commandIdentity, outcome, causeCode, effectClass, transactionState, retryable, retryDelayMilliseconds, guidance, exit, nextActions, reachability, unreachableRationale]) => ({
	commandIdentity,
	outcome,
	causeCode,
	effectClass,
	transactionState,
	retryable,
	retryDelayMilliseconds,
	guidance,
	exit,
	nextActions,
	reachability,
	unreachableRationale,
}))

function defineStationRows(rows: readonly StationRow[]): readonly StationRow[] {
	const identities = new Set<string>()
	for (const row of rows) {
		const identity = JSON.stringify([row.commandIdentity, row.outcome, row.causeCode])
		if (identities.has(identity)) throw new Error(`duplicate station declaration: ${identity}`)
		identities.add(identity)
	}
	return rows
}

export const STATION_ROWS: readonly StationRow[] = defineStationRows(DECLARED_ROWS)
