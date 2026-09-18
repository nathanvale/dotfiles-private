import type { StationRow } from "./command-contract.ts"

// Catalogue leaf: the literal Branch Station declarations (CONTRACT.md section 5 collapsed onto the checker's wire
// vocabulary; see REPORT-2B deviation 1). Each row names the product reasons it covers (the first token of `message`)
// and every next-action identity it may emit. Derivation and lookup live in branch-station-catalog.ts.

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
	StationRow["reasons"],
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
const USAGE = ["USAGE_INVALID_INVOCATION"] as const
const RECORD_UNREACHABLE = "recordCompletion classifies every failure of its two writes by evidence as INTERNAL_COMPLETION_RECORD_FAILED (unchanged before the ref, partially-completed after it); no write in this command can end with an unestablished result"

// Keep the declarations literal: the contract derives its finite StationId vocabulary from this single production owner.
const ROWS = [
	// Built-ins
	["vault-steward.help", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", 0, [], [DISCOVERY], "required", null],
	["vault-steward.help", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.discovery", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", 0, [], ["vault-steward.command-discovery"], "required", null],
	["vault-steward.discovery", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.command-discovery", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", 0, [], EVERY_COMMAND, "required", null],
	["vault-steward.command-discovery", "refused", "USAGE_UNKNOWN_COMMAND", "inspect", "unchanged", false, null, "next-action", 2, ["USAGE_UNKNOWN_COMMAND"], [DISCOVERY], "required", null],
	["vault-steward.command-discovery", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.dispatch", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.dispatch", "refused", "USAGE_UNKNOWN_COMMAND", "inspect", "unchanged", false, null, "next-action", 2, ["USAGE_UNKNOWN_COMMAND"], [HELP], "required", null],
	// begin
	["vault-steward.begin", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", 0, [], [PREVIEW], "required", null],
	["vault-steward.begin", "success", "SUCCESS_UNCHANGED", "repository-local", "unchanged", false, null, "next-action", 0, [], [BEGIN], "required", null],
	["vault-steward.begin", "refused", "USAGE_INVALID_INVOCATION", "repository-local", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.begin", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", 4, ["SCHEMA_INVALID_INPUT", "SCHEMA_CONFIG_INVALID"], [HELP], "required", null],
	["vault-steward.begin", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", 3, ["DOMAIN_CONFIG_MISSING", "DOMAIN_VAULT_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_PATH_REFUSED"], [BEGIN], "required", null],
	["vault-steward.begin", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNCHANGED"], HANDOFF, "required", null],
	["vault-steward.begin", "failed", "INTERNAL_RESULT_PARTIAL", "repository-local", "partially-completed", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_PARTIAL"], HANDOFF, "required", null],
	["vault-steward.begin", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNKNOWN"], HANDOFF, "required", null],
	["vault-steward.begin", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNCHANGED"], HANDOFF, "required", null],
	// finish --preview
	["vault-steward.finish-preview", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", 0, [], [APPLY], "required", null],
	["vault-steward.finish-preview", "success", "SUCCESS_UNCHANGED", "repository-local", "unchanged", false, null, "next-action", 0, [], [INSPECT], "required", null],
	["vault-steward.finish-preview", "refused", "USAGE_INVALID_INVOCATION", "repository-local", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.finish-preview", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", 4, ["SCHEMA_INVALID_INPUT", "SCHEMA_MANIFEST_INVALID", "SCHEMA_RECEIPT_INVALID"], [HELP, INSPECT], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", 3, ["DOMAIN_CANDIDATE_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_GUARD_INCOMPATIBLE", "DOMAIN_PATH_SET_MISMATCH", "DOMAIN_CHECK_FAILED", "DOMAIN_FORMAT_FAILED", "DOMAIN_CANDIDATE_INVALID"], [BEGIN, PREVIEW, INSPECT], "required", null],
	["vault-steward.finish-preview", "refused", "DOMAIN_AUTHORITY_REQUIRED", "repository-local", "unchanged", false, null, "handoff", 3, ["DOMAIN_MAIN_DIVERGED", "DOMAIN_SEMANTIC_OVERLAP"], HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNCHANGED"], HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNKNOWN", "INTERNAL_UNEXPECTED_UNKNOWN"], HANDOFF, "required", null],
	["vault-steward.finish-preview", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNCHANGED"], HANDOFF, "required", null],
	// finish --apply
	["vault-steward.finish-apply", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", 0, [], [INSPECT], "required", null],
	["vault-steward.finish-apply", "success", "SUCCESS_UNCHANGED", "repository-local", "unchanged", false, null, "next-action", 0, [], [INSPECT], "required", null],
	["vault-steward.finish-apply", "refused", "USAGE_INVALID_INVOCATION", "repository-local", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.finish-apply", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", 4, ["SCHEMA_INVALID_INPUT", "SCHEMA_MANIFEST_INVALID", "SCHEMA_RECEIPT_INVALID", "SCHEMA_PREVIEW_INVALID"], [HELP, INSPECT], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", 3, ["DOMAIN_CANDIDATE_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_PREVIEW_NOT_FOUND", "DOMAIN_PREVIEW_CONSUMED", "DOMAIN_PREVIEW_STALE", "DOMAIN_GUARD_INCOMPATIBLE", "DOMAIN_CANONICAL_NOT_READY", "DOMAIN_REBASED_CHECK_FAILED"], [BEGIN, PREVIEW, APPLY, INSPECT], "required", null],
	["vault-steward.finish-apply", "refused", "DOMAIN_AUTHORITY_REQUIRED", "repository-local", "unchanged", false, null, "handoff", 3, ["DOMAIN_REBASE_CONFLICT"], HANDOFF, "required", null],
	["vault-steward.finish-apply", "refused", "TRANSIENT_NOT_STARTED", "repository-local", "unchanged", true, 2000, "next-action", 75, ["TRANSIENT_INTEGRATION_BUSY"], [APPLY], "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "repository-local", "unknown", false, null, "handoff", 1, ["INTERNAL_INTEGRATION_UNPROVED"], HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_RESULT_PARTIAL", "repository-local", "partially-completed", false, null, "handoff", 1, ["INTERNAL_COMPLETION_RECORD_FAILED"], HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNCHANGED"], HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNKNOWN", "INTERNAL_UNEXPECTED_UNKNOWN"], HANDOFF, "required", null],
	["vault-steward.finish-apply", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNCHANGED"], HANDOFF, "required", null],
	// inspect
	["vault-steward.inspect", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", 0, [], [BEGIN, PREVIEW, APPLY, RECOVER, INSPECT], "required", null],
	["vault-steward.inspect", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.inspect", "refused", "SCHEMA_INVALID_INPUT", "inspect", "unchanged", false, null, "next-action", 4, ["SCHEMA_INVALID_INPUT"], [HELP], "required", null],
	["vault-steward.inspect", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNCHANGED"], HANDOFF, "required", null],
	["vault-steward.inspect", "failed", "INTERNAL_UNEXPECTED", "inspect", "unchanged", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNCHANGED"], HANDOFF, "required", null],
	// recover
	["vault-steward.recover", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", 0, [], [INSPECT], "required", null],
	["vault-steward.recover", "success", "SUCCESS_UNCHANGED", "repository-local", "unchanged", false, null, "next-action", 0, [], [INSPECT], "required", null],
	["vault-steward.recover", "refused", "USAGE_INVALID_INVOCATION", "repository-local", "unchanged", false, null, "next-action", 2, USAGE, [HELP], "required", null],
	["vault-steward.recover", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", 4, ["SCHEMA_INVALID_INPUT", "SCHEMA_MANIFEST_INVALID", "SCHEMA_RECEIPT_INVALID"], [HELP, INSPECT], "required", null],
	["vault-steward.recover", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", 3, ["DOMAIN_CANDIDATE_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_GUARD_INCOMPATIBLE"], [BEGIN, INSPECT], "required", null],
	["vault-steward.recover", "refused", "DOMAIN_AUTHORITY_REQUIRED", "repository-local", "unchanged", false, null, "handoff", 3, ["DOMAIN_RECOVERY_UNPROVABLE"], HANDOFF, "required", null],
	["vault-steward.recover", "refused", "TRANSIENT_NOT_STARTED", "repository-local", "unchanged", true, 2000, "next-action", 75, ["TRANSIENT_INTEGRATION_BUSY"], [RECOVER], "required", null],
	["vault-steward.recover", "failed", "INTERNAL_RESULT_PARTIAL", "repository-local", "partially-completed", false, null, "handoff", 1, ["INTERNAL_COMPLETION_RECORD_FAILED"], HANDOFF, "required", null],
	["vault-steward.recover", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_GIT_FAILED_UNCHANGED", "INTERNAL_COMPLETION_RECORD_FAILED"], HANDOFF, "required", null],
	["vault-steward.recover", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNKNOWN"], HANDOFF, "declared-unreachable", RECORD_UNREACHABLE],
	["vault-steward.recover", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", 1, ["INTERNAL_UNEXPECTED_UNCHANGED"], HANDOFF, "required", null],
] as const satisfies readonly Row[]

export type StationIdOf<RowTuple> = RowTuple extends readonly [infer Command extends string, infer Outcome extends string, infer Cause extends string, ...readonly unknown[]] ? `["${Command}","${Outcome}","${Cause}"]` : never

/** The sealed identity vocabulary declared by this production catalogue: the JSON tuple encoding of every row. */
export type DefinedStationId = StationIdOf<(typeof ROWS)[number]>

const DECLARED_ROWS: readonly StationRow[] = ROWS.map(([commandIdentity, outcome, causeCode, effectClass, transactionState, retryable, retryDelayMilliseconds, guidance, exit, reasons, nextActions, reachability, unreachableRationale]) => ({
	commandIdentity,
	outcome,
	causeCode,
	effectClass,
	transactionState,
	retryable,
	retryDelayMilliseconds,
	guidance,
	exit,
	reasons,
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
