import type { StationRow } from "./command-contract.ts"

// Catalogue leaf: the literal station declarations (CDS-PE-4). Derivation lives in
// branch-station-catalog.ts; the contract module owns STATIONS by re-exporting this table.
// Sources: fixture station_catalog, PE revision 3 (six routed identities, D6-c mapping),
// brief 12 sections 3.3, 3.4 and 5. Guidance kind: "next-action" or "handoff".

type Row = readonly [
	StationRow["commandIdentity"],
	StationRow["outcome"],
	StationRow["causeCode"],
	StationRow["effectClass"],
	StationRow["transactionState"],
	StationRow["retryable"],
	StationRow["retryDelayMilliseconds"],
	StationRow["guidance"],
	StationRow["repairAction"],
	StationRow["exit"],
	StationRow["fixtureLabel"],
]

const USAGE_INVALID_INVOCATION: readonly ["refused", "USAGE_INVALID_INVOCATION"] = ["refused", "USAGE_INVALID_INVOCATION"]
const PRE_DISPATCH: readonly ["unchanged", false, null, "next-action", true, 2, null] = ["unchanged", false, null, "next-action", true, 2, null]

const ROWS: readonly Row[] = [
	// Fixture scenarios (section 3.3)
	["repair-lab.status", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", false, 0, "repair-lab.healthy"],
	["repair-lab.inspect", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", false, 0, "repair-lab.inspect"],
	["repair-lab.preview", "success", "SUCCESS_UNCHANGED", "repository-local", "unchanged", false, null, "next-action", false, 0, "repair-lab.preview"],
	["repair-lab.apply", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", false, 0, "repair-lab.authorized-apply"],
	["repair-lab.apply", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.apply", "refused", "DOMAIN_AUTHORITY_REQUIRED", "repository-local", "unchanged", false, null, "handoff", true, 3, null],
	["repair-lab.repair", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.repair", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", false, 0, "repair-lab.authorized-repair"],
	["repair-lab.repair-retry", "success", "SUCCESS_COMPLETED", "repository-local", "completed", false, null, "next-action", false, 0, "repair-lab.permitted-transient-retry"],
	["repair-lab.recover", "failed", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "repository-local", "unknown", false, null, "handoff", true, 3, null],
	["repair-lab.inspect", "refused", "DOMAIN_PRECONDITION_UNMET", "inspect", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.inspect-diagnostics", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", false, 0, "repair-lab.secret-marker"],
	// Auxiliary routes (section 3.4)
	["repair-lab.help", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", false, 0, null],
	["repair-lab.discovery", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", false, null, "next-action", false, 0, null],
	["repair-lab.help", "refused", "USAGE_UNKNOWN_COMMAND", "inspect", "unchanged", false, null, "next-action", true, 2, null],
	["repair-lab.help", ...USAGE_INVALID_INVOCATION, "inspect", ...PRE_DISPATCH],
	["repair-lab.dispatch", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", true, 2, null],
	["repair-lab.dispatch", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.status", ...USAGE_INVALID_INVOCATION, "inspect", ...PRE_DISPATCH],
	["repair-lab.discovery", ...USAGE_INVALID_INVOCATION, "inspect", ...PRE_DISPATCH],
	["repair-lab.inspect", ...USAGE_INVALID_INVOCATION, "inspect", ...PRE_DISPATCH],
	["repair-lab.preview", ...USAGE_INVALID_INVOCATION, "repository-local", ...PRE_DISPATCH],
	["repair-lab.apply", ...USAGE_INVALID_INVOCATION, "repository-local", ...PRE_DISPATCH],
	["repair-lab.repair", ...USAGE_INVALID_INVOCATION, "repository-local", ...PRE_DISPATCH],
	["repair-lab.recover", ...USAGE_INVALID_INVOCATION, "repository-local", ...PRE_DISPATCH],
	["repair-lab.inspect", "refused", "SCHEMA_INVALID_INPUT", "inspect", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.inspect-diagnostics", "refused", "DOMAIN_PRECONDITION_UNMET", "inspect", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.repair-retry", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.repair", "refused", "TRANSIENT_NOT_STARTED", "repository-local", "unchanged", true, 25, "next-action", true, 75, null],
	["repair-lab.repair-retry", "refused", "TRANSIENT_NOT_STARTED", "repository-local", "unchanged", true, 25, "next-action", true, 75, null],
	["repair-lab.apply", "failed", "INTERNAL_EFFECT_NOT_OBSERVED", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.recover", "success", "SUCCESS_UNCHANGED", "repository-local", "unchanged", false, null, "next-action", false, 0, null],
	// Usage refusals keep the routed identity (section 3.4): unknown option and invalid arguments per routed command.
	["repair-lab.inspect-diagnostics", "refused", "USAGE_INVALID_INVOCATION", "inspect", "unchanged", false, null, "next-action", true, 2, null],
	["repair-lab.repair-retry", "refused", "USAGE_INVALID_INVOCATION", "repository-local", "unchanged", false, null, "next-action", true, 2, null],
	// W1: an unexpected exception before any durable write, on every routed command (section 5).
	["repair-lab.status", "failed", "INTERNAL_UNEXPECTED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.inspect", "failed", "INTERNAL_UNEXPECTED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.inspect-diagnostics", "failed", "INTERNAL_UNEXPECTED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.preview", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.apply", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.repair", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.repair-retry", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.recover", "failed", "INTERNAL_UNEXPECTED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	// W2: a durable write was attempted and nothing established its outcome (section 5, 8.1). Coordinator ruling
	// (implementation01/w2-owner-resolution.md): outcome failed with the existing cause INTERNAL_EFFECT_OUTCOME_UNKNOWN,
	// a tuple distinct from W1's failed|INTERNAL_UNEXPECTED|unchanged and from row 6's unknown|INTERNAL_EFFECT_OUTCOME_UNKNOWN.
	["repair-lab.repair", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.repair-retry", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	// Input refusals reach every resource-reading identity (F3): the resource is read before any route policy runs.
	["repair-lab.status", "refused", "DOMAIN_PRECONDITION_UNMET", "inspect", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.status", "refused", "SCHEMA_INVALID_INPUT", "inspect", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.inspect-diagnostics", "refused", "SCHEMA_INVALID_INPUT", "inspect", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.preview", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.preview", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.apply", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.repair", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.repair-retry", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", true, 4, null],
	["repair-lab.recover", "refused", "DOMAIN_PRECONDITION_UNMET", "repository-local", "unchanged", false, null, "next-action", true, 3, null],
	["repair-lab.recover", "refused", "SCHEMA_INVALID_INPUT", "repository-local", "unchanged", false, null, "next-action", true, 4, null],
	// Admission refusals on the repair identities (F3): authority precedes every preview lookup; the retry plan shares step 8.
	["repair-lab.repair", "refused", "DOMAIN_AUTHORITY_REQUIRED", "repository-local", "unchanged", false, null, "handoff", true, 3, null],
	["repair-lab.repair-retry", "refused", "DOMAIN_AUTHORITY_REQUIRED", "repository-local", "unchanged", false, null, "handoff", true, 3, null],
	["repair-lab.apply", "refused", "TRANSIENT_NOT_STARTED", "repository-local", "unchanged", true, 25, "next-action", true, 75, null],
	// W3 on the repair identities: effect.write-journal is in the repair plan too.
	// W4: an effect returned but read-back showed no change, on every effect-executing route.
	["repair-lab.repair", "failed", "INTERNAL_EFFECT_NOT_OBSERVED", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.repair-retry", "failed", "INTERNAL_EFFECT_NOT_OBSERVED", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	// Egress fallback rows under the accepted D6-c mapping (section 5): the brief's 28 rows plus the two
	// unknown|INTERNAL_RESULT_UNKNOWN rows of the repair identities that W3 makes reachable (F3).
	["repair-lab.help", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.discovery", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.discovery", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.status", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.status", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.inspect", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.inspect", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.inspect-diagnostics", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.inspect-diagnostics", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.preview", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.preview", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.apply", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.apply", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", false, null, "handoff", true, 1, null],
	["repair-lab.apply", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.apply", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.repair", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.repair", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", false, null, "handoff", true, 1, null],
	["repair-lab.repair", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.repair", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.repair-retry", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.repair-retry", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", false, null, "handoff", true, 1, null],
	["repair-lab.repair-retry", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
	["repair-lab.recover", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", false, null, "handoff", true, 1, null],
	["repair-lab.recover", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", false, null, "next-action", true, 1, null],
	["repair-lab.recover", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", false, null, "handoff", true, 1, null],
]

const DECLARED_ROWS: readonly StationRow[] = ROWS.map(
	([commandIdentity, outcome, causeCode, effectClass, transactionState, retryable, retryDelayMilliseconds, guidance, repairAction, exit, fixtureLabel]) => ({
		commandIdentity,
		outcome,
		causeCode,
		effectClass,
		transactionState,
		retryable,
		retryDelayMilliseconds,
		guidance,
		repairAction,
		exit,
		fixtureLabel,
	}),
)

export function defineStationRows(rows: readonly StationRow[]): readonly StationRow[] {
	const identities = new Set<string>()
	for (const row of rows) {
		const identity = JSON.stringify([row.commandIdentity, row.outcome, row.causeCode])
		if (identities.has(identity)) throw new Error(`duplicate station declaration: ${identity}`)
		identities.add(identity)
	}
	return rows
}

export const STATION_ROWS: readonly StationRow[] = defineStationRows(DECLARED_ROWS)
