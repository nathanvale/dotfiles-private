// Independent oracle (marked): the expected Branch Station semantics of the Vault Steward CLI, restated by hand from
// CONTRACT.md section 5 with the product causes on the wire. A dedupe pass must not hoist this table into
// src/station-rows.ts; the production table supplies enumeration only.

export interface ExpectedStation {
	failureClass: "usage" | "schema" | "domain" | "transient" | "internal" | null
	exit: number
	effectClass: "inspect" | "repository-local"
	state: "unchanged" | "completed" | "partially-completed" | "unknown"
	retryable: boolean
	delay: number | null
	guidance: "next-action" | "handoff"
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

type Class = ExpectedStation["failureClass"]
type State = ExpectedStation["state"]
const EXIT: Record<string, number> = { usage: 2, schema: 4, domain: 3, transient: 75, internal: 1, null: 0 }
const next = (failureClass: Class, effectClass: ExpectedStation["effectClass"], nextActions: string[], state: State = "unchanged"): ExpectedStation => ({ failureClass, exit: EXIT[String(failureClass)] as number, effectClass, state, retryable: failureClass === "transient", delay: failureClass === "transient" ? 2000 : null, guidance: "next-action", nextActions, reachability: "required" })
const handoff = (failureClass: Exclude<Class, null>, state: State = "unchanged", reachability: ExpectedStation["reachability"] = "required"): ExpectedStation => ({ failureClass, exit: EXIT[failureClass] as number, effectClass: "repository-local", state, retryable: false, delay: null, guidance: "handoff", nextActions: [], reachability })
const inspectHandoff = (failureClass: Exclude<Class, null>): ExpectedStation => ({ ...handoff(failureClass), effectClass: "inspect" })
const RL = "repository-local"

export const EXPECTED_STATIONS: readonly Spec[] = [
	[help, "success", "SUCCESS_UNCHANGED", next(null, "inspect", [discovery])],
	[help, "refused", "USAGE_INVALID_INVOCATION", next("usage", "inspect", [help])],
	[discovery, "success", "SUCCESS_UNCHANGED", next(null, "inspect", ["vault-steward.command-discovery"])],
	[discovery, "refused", "USAGE_INVALID_INVOCATION", next("usage", "inspect", [help])],
	["vault-steward.command-discovery", "success", "SUCCESS_UNCHANGED", next(null, "inspect", every)],
	["vault-steward.command-discovery", "refused", "USAGE_UNKNOWN_COMMAND", next("usage", "inspect", [discovery])],
	["vault-steward.command-discovery", "refused", "USAGE_INVALID_INVOCATION", next("usage", "inspect", [help])],
	["vault-steward.dispatch", "refused", "USAGE_INVALID_INVOCATION", next("usage", "inspect", [help])],
	["vault-steward.dispatch", "refused", "USAGE_UNKNOWN_COMMAND", next("usage", "inspect", [help])],
	[begin, "success", "SUCCESS_COMPLETED", next(null, RL, [preview], "completed")],
	[begin, "success", "SUCCESS_UNCHANGED", next(null, RL, [begin])],
	[begin, "refused", "USAGE_INVALID_INVOCATION", next("usage", RL, [help])],
	[begin, "refused", "SCHEMA_INVALID_INPUT", next("schema", RL, [help])],
	[begin, "refused", "SCHEMA_CONFIG_INVALID", next("schema", RL, [help])],
	[begin, "refused", "DOMAIN_CONFIG_MISSING", next("domain", RL, [begin])],
	[begin, "refused", "DOMAIN_VAULT_NOT_FOUND", next("domain", RL, [begin])],
	[begin, "refused", "DOMAIN_CANONICAL_NOT_MAIN", next("domain", RL, [begin])],
	[begin, "refused", "DOMAIN_PATH_REFUSED", next("domain", RL, [begin])],
	[begin, "refused", "DOMAIN_GUARD_INCOMPATIBLE", next("domain", RL, [begin])],
	[begin, "failed", "INTERNAL_GIT_FAILED_UNCHANGED", handoff("internal")],
	[begin, "failed", "INTERNAL_GIT_FAILED_PARTIAL", handoff("internal", "partially-completed")],
	[begin, "failed", "INTERNAL_UNEXPECTED_UNKNOWN", handoff("internal", "unknown")],
	[begin, "failed", "INTERNAL_UNEXPECTED_UNCHANGED", handoff("internal")],
	[preview, "success", "SUCCESS_COMPLETED", next(null, RL, [apply], "completed")],
	[preview, "success", "SUCCESS_UNCHANGED", next(null, RL, [inspect])],
	[preview, "refused", "USAGE_INVALID_INVOCATION", next("usage", RL, [help])],
	[preview, "refused", "SCHEMA_INVALID_INPUT", next("schema", RL, [help])],
	[preview, "refused", "SCHEMA_MANIFEST_INVALID", handoff("schema")],
	[preview, "refused", "SCHEMA_RECEIPT_INVALID", handoff("schema")],
	[preview, "refused", "DOMAIN_CANDIDATE_NOT_FOUND", next("domain", RL, [begin])],
	[preview, "refused", "DOMAIN_CANONICAL_NOT_MAIN", next("domain", RL, [begin])],
	[preview, "refused", "DOMAIN_GUARD_INCOMPATIBLE", next("domain", RL, [inspect])],
	[preview, "refused", "DOMAIN_PATH_SET_MISMATCH", next("domain", RL, [preview])],
	[preview, "refused", "DOMAIN_CHECK_FAILED", next("domain", RL, [preview])],
	[preview, "refused", "DOMAIN_FORMAT_FAILED", next("domain", RL, [preview])],
	[preview, "refused", "DOMAIN_CANDIDATE_INVALID", handoff("domain")],
	[preview, "refused", "DOMAIN_MAIN_DIVERGED", handoff("domain")],
	[preview, "refused", "DOMAIN_SEMANTIC_OVERLAP", handoff("domain")],
	[preview, "failed", "INTERNAL_GIT_FAILED_UNCHANGED", handoff("internal")],
	[preview, "failed", "INTERNAL_GIT_FAILED_UNKNOWN", handoff("internal", "unknown")],
	[preview, "failed", "INTERNAL_UNEXPECTED_UNKNOWN", handoff("internal", "unknown")],
	[preview, "failed", "INTERNAL_UNEXPECTED_UNCHANGED", handoff("internal")],
	[apply, "success", "SUCCESS_COMPLETED", next(null, RL, [inspect], "completed")],
	[apply, "success", "SUCCESS_UNCHANGED", next(null, RL, [inspect])],
	[apply, "refused", "USAGE_INVALID_INVOCATION", next("usage", RL, [help])],
	[apply, "refused", "SCHEMA_INVALID_INPUT", next("schema", RL, [help])],
	[apply, "refused", "SCHEMA_MANIFEST_INVALID", handoff("schema")],
	[apply, "refused", "SCHEMA_RECEIPT_INVALID", handoff("schema")],
	[apply, "refused", "SCHEMA_PREVIEW_INVALID", handoff("schema")],
	[apply, "refused", "DOMAIN_CANDIDATE_NOT_FOUND", next("domain", RL, [begin])],
	[apply, "refused", "DOMAIN_CANONICAL_NOT_MAIN", next("domain", RL, [begin])],
	[apply, "refused", "DOMAIN_PREVIEW_NOT_FOUND", next("domain", RL, [preview])],
	[apply, "refused", "DOMAIN_PREVIEW_CONSUMED", next("domain", RL, [inspect])],
	[apply, "refused", "DOMAIN_PREVIEW_STALE", next("domain", RL, [preview])],
	[apply, "refused", "DOMAIN_GUARD_INCOMPATIBLE", next("domain", RL, [inspect])],
	[apply, "refused", "DOMAIN_CANONICAL_NOT_READY", next("domain", RL, [apply])],
	[apply, "failed", "DOMAIN_REBASED_CHECK_FAILED", next("domain", RL, [preview])],
	[apply, "failed", "DOMAIN_REBASE_CONFLICT", handoff("domain")],
	[apply, "refused", "TRANSIENT_INTEGRATION_BUSY", next("transient", RL, [apply])],
	[apply, "failed", "INTERNAL_INTEGRATION_UNPROVED", handoff("internal", "unknown")],
	[apply, "failed", "INTERNAL_INTEGRATION_UNPROVED_UNCHANGED", next("internal", RL, [preview])],
	[apply, "failed", "INTERNAL_COMPLETION_RECORD_FAILED", next("internal", RL, [recover], "partially-completed")],
	[apply, "failed", "INTERNAL_GIT_FAILED_UNCHANGED", handoff("internal")],
	[apply, "failed", "INTERNAL_GIT_FAILED_UNKNOWN", handoff("internal", "unknown")],
	[apply, "failed", "INTERNAL_UNEXPECTED_UNKNOWN", handoff("internal", "unknown")],
	[apply, "failed", "INTERNAL_UNEXPECTED_UNCHANGED", handoff("internal")],
	[inspect, "success", "SUCCESS_UNCHANGED", next(null, "inspect", [begin, preview, apply, recover, inspect])],
	[inspect, "refused", "USAGE_INVALID_INVOCATION", next("usage", "inspect", [help])],
	[inspect, "refused", "SCHEMA_INVALID_INPUT", next("schema", "inspect", [help])],
	[inspect, "failed", "INTERNAL_GIT_FAILED_UNCHANGED", inspectHandoff("internal")],
	[inspect, "failed", "INTERNAL_UNEXPECTED_UNCHANGED", inspectHandoff("internal")],
	[recover, "success", "SUCCESS_COMPLETED", next(null, RL, [inspect], "completed")],
	[recover, "success", "SUCCESS_UNCHANGED", next(null, RL, [inspect])],
	[recover, "refused", "USAGE_INVALID_INVOCATION", next("usage", RL, [help])],
	[recover, "refused", "SCHEMA_INVALID_INPUT", next("schema", RL, [help])],
	[recover, "refused", "SCHEMA_MANIFEST_INVALID", handoff("schema")],
	[recover, "refused", "SCHEMA_RECEIPT_INVALID", handoff("schema")],
	[recover, "refused", "DOMAIN_CANDIDATE_NOT_FOUND", next("domain", RL, [begin])],
	[recover, "refused", "DOMAIN_CANONICAL_NOT_MAIN", next("domain", RL, [begin])],
	[recover, "refused", "DOMAIN_GUARD_INCOMPATIBLE", next("domain", RL, [inspect])],
	[recover, "refused", "DOMAIN_RECOVERY_UNPROVABLE", handoff("domain")],
	[recover, "refused", "TRANSIENT_INTEGRATION_BUSY", next("transient", RL, [recover])],
	[recover, "failed", "INTERNAL_COMPLETION_RECORD_FAILED", next("internal", RL, [recover], "partially-completed")],
	[recover, "failed", "INTERNAL_GIT_FAILED_UNCHANGED", handoff("internal")],
	[recover, "failed", "INTERNAL_UNEXPECTED_UNKNOWN", handoff("internal", "unknown", "declared-unreachable")],
	[recover, "failed", "INTERNAL_UNEXPECTED_UNCHANGED", handoff("internal")],
]

export const EXPECTED_STATION_COUNT = 86
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
