// Independent oracle (marked): the expected Branch Station semantics of the Vault Steward CLI, restated by hand from
// CONTRACT.md section 5 collapsed onto the Contract Core 2.0 checker vocabulary (REPORT-2B deviation 1). A dedupe pass
// must not hoist this table into src/station-rows.ts; the production table supplies enumeration only.

export interface ExpectedStation {
	failureClass: "usage" | "schema" | "domain" | "transient" | "internal" | null
	exit: number
	effectClass: "inspect" | "repository-local"
	state: "unchanged" | "completed" | "partially-completed" | "unknown"
	retryable: boolean
	delay: number | null
	guidance: "next-action" | "handoff"
	reasons: string[]
	nextActions: string[]
	reachability: "required" | "declared-unreachable"
}

export type Spec = [command: string, outcome: string, cause: string, expected: ExpectedStation]

const help = "vault-steward.help"
const discovery = "vault-steward.discovery"
const begin = "vault-steward.begin"
const preview = "vault-steward.finish-preview"
const apply = "vault-steward.finish-apply"
const inspect = "vault-steward.inspect"
const recover = "vault-steward.recover"
const every = ["vault-steward.begin", "vault-steward.command-discovery", "vault-steward.discovery", "vault-steward.dispatch", "vault-steward.finish-apply", "vault-steward.finish-preview", "vault-steward.help", "vault-steward.inspect", "vault-steward.recover"]

const usage = (effectClass: ExpectedStation["effectClass"], next = [help]): ExpectedStation => ({ failureClass: "usage", exit: 2, effectClass, state: "unchanged", retryable: false, delay: null, guidance: "next-action", reasons: ["USAGE_INVALID_INVOCATION"], nextActions: next, reachability: "required" })
const unknownCommand = (next: string[]): ExpectedStation => ({ failureClass: "usage", exit: 2, effectClass: "inspect", state: "unchanged", retryable: false, delay: null, guidance: "next-action", reasons: ["USAGE_UNKNOWN_COMMAND"], nextActions: next, reachability: "required" })
const unchanged = (effectClass: ExpectedStation["effectClass"], next: string[]): ExpectedStation => ({ failureClass: null, exit: 0, effectClass, state: "unchanged", retryable: false, delay: null, guidance: "next-action", reasons: [], nextActions: next, reachability: "required" })
const completed = (next: string[]): ExpectedStation => ({ failureClass: null, exit: 0, effectClass: "repository-local", state: "completed", retryable: false, delay: null, guidance: "next-action", reasons: [], nextActions: next, reachability: "required" })
const schema = (effectClass: ExpectedStation["effectClass"], reasons: string[], next: string[]): ExpectedStation => ({ failureClass: "schema", exit: 4, effectClass, state: "unchanged", retryable: false, delay: null, guidance: "next-action", reasons, nextActions: next, reachability: "required" })
const precondition = (reasons: string[], next: string[]): ExpectedStation => ({ failureClass: "domain", exit: 3, effectClass: "repository-local", state: "unchanged", retryable: false, delay: null, guidance: "next-action", reasons, nextActions: next, reachability: "required" })
const authority = (reasons: string[]): ExpectedStation => ({ failureClass: "domain", exit: 3, effectClass: "repository-local", state: "unchanged", retryable: false, delay: null, guidance: "handoff", reasons, nextActions: [], reachability: "required" })
const transient = (next: string): ExpectedStation => ({ failureClass: "transient", exit: 75, effectClass: "repository-local", state: "unchanged", retryable: true, delay: 2000, guidance: "next-action", reasons: ["TRANSIENT_INTEGRATION_BUSY"], nextActions: [next], reachability: "required" })
const internal = (effectClass: ExpectedStation["effectClass"], state: ExpectedStation["state"], reasons: string[], reachability: ExpectedStation["reachability"] = "required"): ExpectedStation => ({ failureClass: "internal", exit: 1, effectClass, state, retryable: false, delay: null, guidance: "handoff", reasons, nextActions: [], reachability })

export const EXPECTED_STATIONS: readonly Spec[] = [
	[help, "success", "SUCCESS_UNCHANGED", unchanged("inspect", [discovery])],
	[help, "refused", "USAGE_INVALID_INVOCATION", usage("inspect")],
	[discovery, "success", "SUCCESS_UNCHANGED", unchanged("inspect", ["vault-steward.command-discovery"])],
	[discovery, "refused", "USAGE_INVALID_INVOCATION", usage("inspect")],
	["vault-steward.command-discovery", "success", "SUCCESS_UNCHANGED", unchanged("inspect", every)],
	["vault-steward.command-discovery", "refused", "USAGE_UNKNOWN_COMMAND", unknownCommand([discovery])],
	["vault-steward.command-discovery", "refused", "USAGE_INVALID_INVOCATION", usage("inspect")],
	["vault-steward.dispatch", "refused", "USAGE_INVALID_INVOCATION", usage("inspect")],
	["vault-steward.dispatch", "refused", "USAGE_UNKNOWN_COMMAND", unknownCommand([help])],
	[begin, "success", "SUCCESS_COMPLETED", completed([preview])],
	[begin, "success", "SUCCESS_UNCHANGED", unchanged("repository-local", [begin])],
	[begin, "refused", "USAGE_INVALID_INVOCATION", usage("repository-local")],
	[begin, "refused", "SCHEMA_INVALID_INPUT", schema("repository-local", ["SCHEMA_INVALID_INPUT", "SCHEMA_CONFIG_INVALID"], [help])],
	[begin, "refused", "DOMAIN_PRECONDITION_UNMET", precondition(["DOMAIN_CONFIG_MISSING", "DOMAIN_VAULT_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_PATH_REFUSED"], [begin])],
	[begin, "failed", "INTERNAL_RESULT_UNCHANGED", internal("repository-local", "unchanged", ["INTERNAL_GIT_FAILED_UNCHANGED"])],
	[begin, "failed", "INTERNAL_RESULT_PARTIAL", internal("repository-local", "partially-completed", ["INTERNAL_GIT_FAILED_PARTIAL"])],
	[begin, "failed", "INTERNAL_RESULT_UNKNOWN", internal("repository-local", "unknown", ["INTERNAL_UNEXPECTED_UNKNOWN"])],
	[begin, "failed", "INTERNAL_UNEXPECTED", internal("repository-local", "unchanged", ["INTERNAL_UNEXPECTED_UNCHANGED"])],
	[preview, "success", "SUCCESS_COMPLETED", completed([apply])],
	[preview, "success", "SUCCESS_UNCHANGED", unchanged("repository-local", [inspect])],
	[preview, "refused", "USAGE_INVALID_INVOCATION", usage("repository-local")],
	[preview, "refused", "SCHEMA_INVALID_INPUT", schema("repository-local", ["SCHEMA_INVALID_INPUT", "SCHEMA_MANIFEST_INVALID", "SCHEMA_RECEIPT_INVALID"], [help, inspect])],
	[preview, "refused", "DOMAIN_PRECONDITION_UNMET", precondition(["DOMAIN_CANDIDATE_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_GUARD_INCOMPATIBLE", "DOMAIN_PATH_SET_MISMATCH", "DOMAIN_CHECK_FAILED", "DOMAIN_FORMAT_FAILED", "DOMAIN_CANDIDATE_INVALID"], [begin, preview, inspect])],
	[preview, "refused", "DOMAIN_AUTHORITY_REQUIRED", authority(["DOMAIN_MAIN_DIVERGED", "DOMAIN_SEMANTIC_OVERLAP"])],
	[preview, "failed", "INTERNAL_RESULT_UNCHANGED", internal("repository-local", "unchanged", ["INTERNAL_GIT_FAILED_UNCHANGED"])],
	[preview, "failed", "INTERNAL_RESULT_UNKNOWN", internal("repository-local", "unknown", ["INTERNAL_GIT_FAILED_UNKNOWN", "INTERNAL_UNEXPECTED_UNKNOWN"])],
	[preview, "failed", "INTERNAL_UNEXPECTED", internal("repository-local", "unchanged", ["INTERNAL_UNEXPECTED_UNCHANGED"])],
	[apply, "success", "SUCCESS_COMPLETED", completed([inspect])],
	[apply, "success", "SUCCESS_UNCHANGED", unchanged("repository-local", [inspect])],
	[apply, "refused", "USAGE_INVALID_INVOCATION", usage("repository-local")],
	[apply, "refused", "SCHEMA_INVALID_INPUT", schema("repository-local", ["SCHEMA_INVALID_INPUT", "SCHEMA_MANIFEST_INVALID", "SCHEMA_RECEIPT_INVALID", "SCHEMA_PREVIEW_INVALID"], [help, inspect])],
	[apply, "refused", "DOMAIN_PRECONDITION_UNMET", precondition(["DOMAIN_CANDIDATE_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_PREVIEW_NOT_FOUND", "DOMAIN_PREVIEW_CONSUMED", "DOMAIN_PREVIEW_STALE", "DOMAIN_GUARD_INCOMPATIBLE", "DOMAIN_CANONICAL_NOT_READY", "DOMAIN_REBASED_CHECK_FAILED"], [begin, preview, apply, inspect])],
	[apply, "refused", "DOMAIN_AUTHORITY_REQUIRED", authority(["DOMAIN_REBASE_CONFLICT"])],
	[apply, "refused", "TRANSIENT_NOT_STARTED", transient(apply)],
	[apply, "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", internal("repository-local", "unknown", ["INTERNAL_INTEGRATION_UNPROVED"])],
	[apply, "failed", "INTERNAL_RESULT_PARTIAL", internal("repository-local", "partially-completed", ["INTERNAL_COMPLETION_RECORD_FAILED"])],
	[apply, "failed", "INTERNAL_RESULT_UNCHANGED", internal("repository-local", "unchanged", ["INTERNAL_GIT_FAILED_UNCHANGED"])],
	[apply, "failed", "INTERNAL_RESULT_UNKNOWN", internal("repository-local", "unknown", ["INTERNAL_GIT_FAILED_UNKNOWN", "INTERNAL_UNEXPECTED_UNKNOWN"])],
	[apply, "failed", "INTERNAL_UNEXPECTED", internal("repository-local", "unchanged", ["INTERNAL_UNEXPECTED_UNCHANGED"])],
	[inspect, "success", "SUCCESS_UNCHANGED", unchanged("inspect", [begin, preview, apply, recover, inspect])],
	[inspect, "refused", "USAGE_INVALID_INVOCATION", usage("inspect")],
	[inspect, "refused", "SCHEMA_INVALID_INPUT", schema("inspect", ["SCHEMA_INVALID_INPUT"], [help])],
	[inspect, "failed", "INTERNAL_RESULT_UNCHANGED", internal("inspect", "unchanged", ["INTERNAL_GIT_FAILED_UNCHANGED"])],
	[inspect, "failed", "INTERNAL_UNEXPECTED", internal("inspect", "unchanged", ["INTERNAL_UNEXPECTED_UNCHANGED"])],
	[recover, "success", "SUCCESS_COMPLETED", completed([inspect])],
	[recover, "success", "SUCCESS_UNCHANGED", unchanged("repository-local", [inspect])],
	[recover, "refused", "USAGE_INVALID_INVOCATION", usage("repository-local")],
	[recover, "refused", "SCHEMA_INVALID_INPUT", schema("repository-local", ["SCHEMA_INVALID_INPUT", "SCHEMA_MANIFEST_INVALID", "SCHEMA_RECEIPT_INVALID"], [help, inspect])],
	[recover, "refused", "DOMAIN_PRECONDITION_UNMET", precondition(["DOMAIN_CANDIDATE_NOT_FOUND", "DOMAIN_CANONICAL_NOT_MAIN", "DOMAIN_GUARD_INCOMPATIBLE"], [begin, inspect])],
	[recover, "refused", "DOMAIN_AUTHORITY_REQUIRED", authority(["DOMAIN_RECOVERY_UNPROVABLE"])],
	[recover, "refused", "TRANSIENT_NOT_STARTED", transient(recover)],
	[recover, "failed", "INTERNAL_RESULT_PARTIAL", internal("repository-local", "partially-completed", ["INTERNAL_COMPLETION_RECORD_FAILED"])],
	[recover, "failed", "INTERNAL_RESULT_UNCHANGED", internal("repository-local", "unchanged", ["INTERNAL_GIT_FAILED_UNCHANGED", "INTERNAL_COMPLETION_RECORD_FAILED"])],
	[recover, "failed", "INTERNAL_RESULT_UNKNOWN", internal("repository-local", "unknown", ["INTERNAL_UNEXPECTED_UNKNOWN"], "declared-unreachable")],
	[recover, "failed", "INTERNAL_UNEXPECTED", internal("repository-local", "unchanged", ["INTERNAL_UNEXPECTED_UNCHANGED"])],
]

export const EXPECTED_STATION_COUNT = 55
export const identityOf = (command: string, outcome: string, cause: string): string => JSON.stringify([command, outcome, cause])
export const EXPECTED_BY_IDENTITY: ReadonlyMap<string, ExpectedStation> = new Map(EXPECTED_STATIONS.map(([command, outcome, cause, expected]) => [identityOf(command, outcome, cause), expected]))

// The expected command summaries of discovery, restated from CLI-BRIEF.md section 1 and CONTRACT.md 1.2.
export const EXPECTED_COMMANDS = [
	{ commandIdentity: "vault-steward.dispatch", route: [], effectClass: "inspect" },
	{ commandIdentity: "vault-steward.help", route: ["--help"], effectClass: "inspect" },
	{ commandIdentity: "vault-steward.discovery", route: ["--discover"], effectClass: "inspect" },
	{ commandIdentity: "vault-steward.command-discovery", route: ["--discover-command"], effectClass: "inspect" },
	{ commandIdentity: "vault-steward.begin", route: ["begin"], effectClass: "repository-local" },
	{ commandIdentity: "vault-steward.finish-preview", route: ["finish", "--preview"], effectClass: "repository-local" },
	{ commandIdentity: "vault-steward.finish-apply", route: ["finish", "--apply"], effectClass: "repository-local" },
	{ commandIdentity: "vault-steward.inspect", route: ["inspect"], effectClass: "inspect" },
	{ commandIdentity: "vault-steward.recover", route: ["recover"], effectClass: "repository-local" },
] as const
