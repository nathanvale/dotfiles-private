import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { declaredStation, STATION_IDS, stationIdOf, stationIdOfRow } from "../../src/branch-station-catalog.ts"
import { STATIONS } from "../../src/command-contract.ts"
import { defineStationRows } from "../../src/station-rows.ts"
import { createRoot, envelopeOf, linkOutside, linkStateFile, readOnlyJournal, removeRoot, type Root, runCli, type Variant } from "../helpers/harness.ts"

// Independent oracle (CDS-PE-4; brief 12, section 5): EXPECTED_STATIONS is restated from the fixture's station_catalog,
// PE revision 3 and brief 12 sections 3.3, 3.4 and 5; BINDINGS ties every tuple to argv, state variant and fault with
// the expected transaction state and guidance per scenario. STATIONS supplies enumeration only; nothing below is read
// from the modules under test. Marked independent oracle: a dedupe pass must not hoist these tables into STATIONS.

type Identity = "dispatch" | "help" | "discovery" | "status" | "inspect" | "inspect-diagnostics" | "preview" | "apply" | "repair" | "repair-retry" | "recover"
type Outcome = "success" | "refused" | "failed"
type EffectClass = "inspect" | "repository-local"
type State = "unchanged" | "completed" | "partially-completed" | "unknown"
type Guidance = "next-action" | "handoff"
type FailureClass = "internal" | "usage" | "domain" | "schema" | "transient" | null

interface Signature {
	effectClass: EffectClass
	failureClass: FailureClass
	transactionState: State
	retryable: boolean
	delay: number | null
	guidance: Guidance
	repairAction: boolean
	exit: number
	label: string | null
}

const EXPECTED_STATIONS = new Map<string, Signature>()
const HANDOFF_CAUSES = new Set([
	"DOMAIN_AUTHORITY_REQUIRED",
	"DOMAIN_RECOVERY_HANDOFF_REQUIRED",
	"INTERNAL_EFFECT_OUTCOME_UNKNOWN",
	"INTERNAL_EFFECT_NOT_OBSERVED",
	"INTERNAL_UNEXPECTED",
	"INTERNAL_RESULT_UNCHANGED",
	"INTERNAL_RESULT_COMPLETED",
	"INTERNAL_RESULT_UNKNOWN",
])
const FAILURE_CLASS_BY_CAUSE: Readonly<Record<string, Exclude<FailureClass, null>>> = {
	USAGE_INVALID_INVOCATION: "usage",
	USAGE_UNKNOWN_COMMAND: "usage",
	SCHEMA_INVALID_INPUT: "schema",
	DOMAIN_PRECONDITION_UNMET: "domain",
	DOMAIN_AUTHORITY_REQUIRED: "domain",
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: "domain",
	TRANSIENT_NOT_STARTED: "transient",
	INTERNAL_PREPARATION: "internal",
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: "internal",
	INTERNAL_EFFECT_NOT_OBSERVED: "internal",
	INTERNAL_UNEXPECTED: "internal",
	INTERNAL_RESULT_UNCHANGED: "internal",
	INTERNAL_RESULT_COMPLETED: "internal",
	INTERNAL_RESULT_UNKNOWN: "internal",
}
const READ_ONLY: Identity[] = ["dispatch", "help", "discovery", "status", "inspect", "inspect-diagnostics"]
const classOf = (identity: Identity): EffectClass => (READ_ONLY.includes(identity) ? "inspect" : "repository-local")
const id = (identity: Identity, outcome: Outcome, cause: string | null): string => JSON.stringify([`repair-lab.${identity}`, outcome, cause])
const successId = (identity: Identity, transactionState: Extract<State, "unchanged" | "completed">): string => id(identity, "success", transactionState === "completed" ? "SUCCESS_COMPLETED" : "SUCCESS_UNCHANGED")
function declare(identity: Identity, outcome: Outcome, cause: string | null, signature: Omit<Signature, "effectClass" | "failureClass" | "guidance" | "repairAction"> & { effectClass?: EffectClass }): void {
	const key = id(identity, outcome, cause)
	const failureClass = outcome === "success" ? null : FAILURE_CLASS_BY_CAUSE[cause ?? ""]
	if (failureClass === undefined) throw new Error(`oracle has no accepted failure class for ${key}`)
	const expected: Signature = {
		effectClass: classOf(identity),
		failureClass,
		...signature,
		retryable: outcome === "success" ? false : signature.retryable,
		guidance: cause !== null && HANDOFF_CAUSES.has(cause) ? "handoff" : "next-action",
		repairAction: outcome !== "success",
		label: outcome === "success" ? signature.label : null,
	}
	const prior = EXPECTED_STATIONS.get(key)
	if (prior === undefined) EXPECTED_STATIONS.set(key, expected)
	else if (JSON.stringify(prior) !== JSON.stringify(expected)) throw new Error(`oracle declares ${key} with conflicting C0 signatures`)
}
const success = (identity: Identity, transactionState: Extract<State, "unchanged" | "completed">, label: string | null): void => declare(identity, "success", transactionState === "completed" ? "SUCCESS_COMPLETED" : "SUCCESS_UNCHANGED", { transactionState, retryable: false, delay: null, exit: 0, label })
const usage = (identity: Identity, cause: string): void => declare(identity, "refused", cause, { transactionState: "unchanged", retryable: false, delay: null, exit: 2, label: null })
const domain = (identity: Identity, cause: string, label: string | null, exit = cause === "SCHEMA_INVALID_INPUT" ? 4 : 3): void => declare(identity, "refused", cause, { transactionState: "unchanged", retryable: false, delay: null, exit, label })
const fallback = (identity: Identity, outcome: Outcome, cause: string, transactionState: State): void => declare(identity, outcome, cause, { transactionState, retryable: false, delay: null, exit: 1, label: null })

// Fixture scenarios (station_catalog, thirteen required stations; retry_safety mapped per brief 3.3).
success("status", "unchanged", "repair-lab.healthy")
success("inspect", "unchanged", "repair-lab.inspect")
success("preview", "unchanged", "repair-lab.preview")
success("apply", "completed", "repair-lab.authorized-apply")
domain("apply", "DOMAIN_PRECONDITION_UNMET", "repair-lab.stale-preview")
declare("apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, exit: 1, label: "repair-lab.partial-unknown" })
domain("apply", "DOMAIN_AUTHORITY_REQUIRED", "repair-lab.prohibited-automation")
domain("repair", "DOMAIN_PRECONDITION_UNMET", "repair-lab.repairable-precondition")
success("repair", "completed", "repair-lab.authorized-repair")
success("repair-retry", "completed", "repair-lab.permitted-transient-retry")
declare("recover", "failed", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", { transactionState: "unknown", retryable: false, delay: null, exit: 3, label: "repair-lab.required-handoff" })
domain("inspect", "DOMAIN_PRECONDITION_UNMET", "repair-lab.hostile-input")
success("inspect-diagnostics", "unchanged", "repair-lab.secret-marker")
// Auxiliary routes (brief 3.4) and the routed usage refusals.
success("help", "unchanged", null)
success("discovery", "unchanged", null)
usage("help", "USAGE_UNKNOWN_COMMAND")
usage("dispatch", "USAGE_INVALID_INVOCATION")
const ROUTED: Identity[] = ["status", "inspect", "inspect-diagnostics", "preview", "apply", "repair", "repair-retry", "recover"]
for (const identity of ["help", "discovery", ...ROUTED] as Identity[]) usage(identity, "USAGE_INVALID_INVOCATION")
for (const identity of ROUTED) usage(identity, "USAGE_INVALID_INVOCATION")
for (const identity of ROUTED) {
	domain(identity, "DOMAIN_PRECONDITION_UNMET", "repair-lab.input-missing")
	domain(identity, "DOMAIN_PRECONDITION_UNMET", "repair-lab.input-malformed")
	domain(identity, "DOMAIN_PRECONDITION_UNMET", "repair-lab.input-unreadable")
	domain(identity, "SCHEMA_INVALID_INPUT", "repair-lab.state-schema-invalid")
}
domain("inspect-diagnostics", "DOMAIN_PRECONDITION_UNMET", "repair-lab.hostile-input")
const MUTATING: Identity[] = ["apply", "repair", "repair-retry"]
for (const identity of MUTATING) {
	domain(identity, "DOMAIN_PRECONDITION_UNMET", null)
	domain(identity, "DOMAIN_PRECONDITION_UNMET", null)
	declare(identity, "refused", "TRANSIENT_NOT_STARTED", { transactionState: "unchanged", retryable: true, delay: 25, exit: 75, label: null })
	declare(identity, "failed", "INTERNAL_EFFECT_NOT_OBSERVED", { transactionState: "unknown", retryable: false, delay: null, exit: 1, label: null })
	// W2 (coordinator ruling, implementation01/w2-owner-resolution.md): failed, existing cause, trusted state unknown.
	declare(identity, "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, exit: 1, label: "repair-lab.write-outcome-unknown" })
}
domain("repair", "DOMAIN_PRECONDITION_UNMET", "repair-lab.stale-preview")
domain("repair-retry", "DOMAIN_PRECONDITION_UNMET", "repair-lab.stale-preview")
domain("repair", "DOMAIN_AUTHORITY_REQUIRED", "repair-lab.prohibited-automation")
domain("repair-retry", "DOMAIN_AUTHORITY_REQUIRED", "repair-lab.prohibited-automation")
domain("repair", "DOMAIN_PRECONDITION_UNMET", null)
domain("repair-retry", "DOMAIN_PRECONDITION_UNMET", null)
declare("repair", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, exit: 1, label: "repair-lab.partial-unknown" })
declare("repair-retry", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, exit: 1, label: "repair-lab.partial-unknown" })
success("recover", "unchanged", null)
// W1: an unexpected exception before any durable write, every routed command (brief section 5).
for (const identity of ROUTED) declare(identity, "failed", "INTERNAL_UNEXPECTED", { transactionState: "unchanged", retryable: false, delay: null, exit: 1, label: null })
// Egress fallbacks under the accepted D6-c mapping (section 5 table plus the two repair-identity unknown rows).
fallback("dispatch", "refused", "INTERNAL_PREPARATION", "unchanged")
fallback("help", "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
for (const identity of ["discovery", "status", "inspect", "inspect-diagnostics", "preview"] as Identity[]) {
	fallback(identity, "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
	fallback(identity, "refused", "INTERNAL_PREPARATION", "unchanged")
}
for (const identity of MUTATING) {
	fallback(identity, "refused", "INTERNAL_PREPARATION", "unchanged")
	fallback(identity, "failed", "INTERNAL_RESULT_UNKNOWN", "unknown")
	fallback(identity, "failed", "INTERNAL_RESULT_COMPLETED", "completed")
	fallback(identity, "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
	fallback(identity, "failed", "INTERNAL_RESULT_UNKNOWN", "unknown")
}
fallback("recover", "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
fallback("recover", "refused", "INTERNAL_PREPARATION", "unchanged")
fallback("recover", "failed", "INTERNAL_RESULT_UNKNOWN", "unknown")

// Binding table: (tuple, argv, variant, fault, setup, before) with the expected transaction state and guidance per scenario.
type Setup = "read-only-journal" | "missing-resource" | "malformed-resource" | "unreadable-resource" | "invalid-resource" | "link" | "link-resource"
interface Binding {
	tuple: string
	argv: string[]
	variant: Variant
	fault?: string
	setup?: Setup
	before?: string[]
	env?: Record<string, string>
	transactionState: State
	guidance: Guidance
	nextAction?: string
}
const U = "effect.update-index"
const J = "effect.write-journal"
const R = "effect.repair-cache"
const APPLY = ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority"]
const STALE = ["apply", "--preview-id", "preview-stale-revision-4", "--authorize", "fixture-authority"]
const PARTIAL = ["apply", "--preview-id", "preview-partial-revision-4", "--authorize", "fixture-authority"]
const REPAIR = ["repair", "--apply", "--preview-id", "repair-preview-missing-index", "--authorize", "fixture-authority"]
const RETRY = ["repair", "--apply", "--retry-once", "--authorize", "fixture-authority"]
const CYCLE = "egress-non-json:cycle"
const INSPECT = "repair-lab inspect"
const RECOVER = "repair-lab recover"
const HELP = "repair-lab --help"
const b = (tuple: string, argv: string[], variant: Variant, rest: Partial<Binding> & { transactionState: State; guidance: Guidance }): Binding => {
	const decoded = JSON.parse(tuple) as [string, string, string | null]
	const cause = decoded[2] ?? ""
	if (!HANDOFF_CAUSES.has(cause)) return { tuple, argv, variant, ...rest }
	const { nextAction: _nextAction, ...handoffBinding } = rest
	return { tuple, argv, variant, ...handoffBinding, guidance: "handoff" }
}
const un = (tuple: string, argv: string[], variant: Variant, rest: Partial<Binding> = {}): Binding => b(tuple, argv, variant, { transactionState: "unchanged", guidance: "next-action", nextAction: INSPECT, ...rest })
const ROUTE_ARGV: Record<Identity, string[]> = { dispatch: [], help: ["--help"], discovery: ["--discover"], status: ["status"], inspect: ["inspect"], "inspect-diagnostics": ["inspect", "--include-diagnostics"], preview: ["apply", "--preview"], apply: APPLY, repair: REPAIR, "repair-retry": RETRY, recover: ["recover"] }

const BINDINGS: Binding[] = [
	// Thirteen fixture scenarios (3.3)
	un(successId("status", "unchanged"), ["status"], "healthy"),
	un(successId("inspect", "unchanged"), ["inspect"], "healthy", { nextAction: "repair-lab apply --preview" }),
	un(successId("preview", "unchanged"), ["apply", "--preview"], "healthy", { nextAction: "repair-lab apply --preview-id preview-healthy-revision-4 --authorize fixture-authority" }),
	b(successId("apply", "completed"), APPLY, "healthy-with-fresh-preview", { transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("apply", "refused", "DOMAIN_PRECONDITION_UNMET"), STALE, "revision-5-with-revision-4-preview"),
	b(id("apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), PARTIAL, "healthy-with-partial-preview", { fault: "effect.write-journal-outcome-unknown", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("apply", "refused", "DOMAIN_AUTHORITY_REQUIRED"), ["apply", "--automation"], "healthy"),
	un(id("repair", "refused", "DOMAIN_PRECONDITION_UNMET"), ["repair", "--preview"], "derived-index-missing", { nextAction: "repair-lab repair --apply --preview-id repair-preview-missing-index --authorize fixture-authority" }),
	b(successId("repair", "completed"), REPAIR, "derived-index-missing-with-fresh-preview", { transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	b(successId("repair-retry", "completed"), RETRY, "derived-index-missing-with-fresh-preview", { fault: "one-transient-lock", transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	b(id("recover", "failed", "DOMAIN_RECOVERY_HANDOFF_REQUIRED"), ["recover"], "unknown-after-partial", { transactionState: "unknown", guidance: "handoff" }),
	un(id("inspect", "refused", "DOMAIN_PRECONDITION_UNMET"), ["inspect", "--state", "../../outside-root-sentinel"], "healthy"),
	un(successId("inspect-diagnostics", "unchanged"), ["inspect", "--include-diagnostics"], "secret-marker-in-diagnostic-field"),
	// Containment negatives share row 12's station; the diagnostics route has its own.
	un(id("inspect", "refused", "DOMAIN_PRECONDITION_UNMET"), ["inspect", "--state", "../run-other/resource.json"], "healthy"),
	un(id("inspect", "refused", "DOMAIN_PRECONDITION_UNMET"), ["inspect", "--state", "state/link/resource.json"], "healthy", { setup: "link" }),
	un(id("inspect-diagnostics", "refused", "DOMAIN_PRECONDITION_UNMET"), ["inspect", "--include-diagnostics", "--state", "../../outside-root-sentinel"], "healthy"),
	// Help, discovery and usage (3.4)
	b(successId("help", "unchanged"), ["--help"], "healthy", { transactionState: "unchanged", guidance: "next-action", nextAction: INSPECT }),
	b(successId("discovery", "unchanged"), ["--discover"], "healthy", { transactionState: "unchanged", guidance: "next-action", nextAction: INSPECT }),
	un(id("dispatch", "refused", "USAGE_INVALID_INVOCATION"), [], "healthy", { nextAction: HELP }),
	un(id("help", "refused", "USAGE_UNKNOWN_COMMAND"), ["frobnicate"], "healthy", { nextAction: HELP }),
	...(["help", "discovery", ...ROUTED] as Identity[]).map((identity) => un(id(identity === "help" ? "dispatch" : identity, "refused", "USAGE_INVALID_INVOCATION"), [...(identity === "help" ? [] : ROUTE_ARGV[identity]), "--no-such-option"], "healthy", { nextAction: HELP })),
	un(id("help", "refused", "USAGE_INVALID_INVOCATION"), ["--help", "--apply"], "healthy", { nextAction: HELP }),
	un(id("discovery", "refused", "USAGE_INVALID_INVOCATION"), ["--discover", "--state", "state/resource.json"], "healthy", { nextAction: HELP }),
	...ROUTED.map((identity) => un(id(identity, "refused", "USAGE_INVALID_INVOCATION"), ROUTE_ARGV[identity], "healthy", { fault: "nope", nextAction: HELP })),
	// Input refusals on every resource-reading identity (F3)
	...ROUTED.flatMap((identity) => [
		un(id(identity, "refused", "DOMAIN_PRECONDITION_UNMET"), ROUTE_ARGV[identity], "healthy", { setup: "missing-resource" }),
		un(id(identity, "refused", "DOMAIN_PRECONDITION_UNMET"), ROUTE_ARGV[identity], "healthy", { setup: "malformed-resource" }),
		un(id(identity, "refused", "DOMAIN_PRECONDITION_UNMET"), ROUTE_ARGV[identity], "healthy", { setup: "unreadable-resource" }),
		un(id(identity, "refused", "SCHEMA_INVALID_INPUT"), ROUTE_ARGV[identity], "healthy", { setup: "invalid-resource" }),
	]),
	// Admission refusals (3.5 steps 2 through 10) on the three mutating identities
	un(id("apply", "refused", "DOMAIN_PRECONDITION_UNMET"), APPLY, "healthy", { nextAction: "repair-lab apply --preview" }),
	un(id("repair", "refused", "DOMAIN_PRECONDITION_UNMET"), REPAIR, "derived-index-missing", { nextAction: "repair-lab repair --preview" }),
	un(id("repair-retry", "refused", "DOMAIN_PRECONDITION_UNMET"), RETRY, "derived-index-missing-with-apply-preview", { nextAction: "repair-lab repair --preview" }),
	un(id("apply", "refused", "DOMAIN_PRECONDITION_UNMET"), APPLY, "healthy-with-consumed-preview"),
	un(id("repair", "refused", "DOMAIN_PRECONDITION_UNMET"), REPAIR, "derived-index-missing-with-fresh-preview", { before: REPAIR }),
	un(id("repair-retry", "refused", "DOMAIN_PRECONDITION_UNMET"), RETRY, "derived-index-missing-with-fresh-preview", { before: RETRY }),
	un(id("repair", "refused", "DOMAIN_PRECONDITION_UNMET"), REPAIR, "repair-stale"),
	un(id("repair-retry", "refused", "DOMAIN_PRECONDITION_UNMET"), RETRY, "repair-stale"),
	un(id("repair", "refused", "DOMAIN_AUTHORITY_REQUIRED"), ["repair", "--apply", "--preview-id", "repair-preview-missing-index"], "derived-index-missing-with-fresh-preview"),
	un(id("repair-retry", "refused", "DOMAIN_AUTHORITY_REQUIRED"), ["repair", "--apply", "--retry-once"], "derived-index-missing-with-fresh-preview"),
	un(id("repair", "refused", "DOMAIN_PRECONDITION_UNMET"), ["repair", "--preview"], "healthy"),
	un(id("repair-retry", "refused", "DOMAIN_PRECONDITION_UNMET"), RETRY, "healthy-with-repair-preview"),
	un(id("apply", "refused", "TRANSIENT_NOT_STARTED"), APPLY, "healthy-with-fresh-preview", { fault: "one-transient-lock", nextAction: "retry the same command after 25 ms" }),
	un(id("repair", "refused", "TRANSIENT_NOT_STARTED"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: "one-transient-lock", nextAction: "retry the same command after 25 ms" }),
	un(id("repair-retry", "refused", "TRANSIENT_NOT_STARTED"), RETRY, "derived-index-missing-with-fresh-preview", { fault: "persistent-lock", nextAction: "retry the same command after 25 ms" }),
	// Execution boundaries W2, W3, W4 on every effect route; W1 on every routed command
	b(id("apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), APPLY, "healthy-with-fresh-preview", { setup: "read-only-journal", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: "effect.write-journal-outcome-unknown", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { fault: "effect.write-journal-outcome-unknown", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	...MUTATING.map((identity) => b(id(identity, "failed", "INTERNAL_EFFECT_NOT_OBSERVED"), ROUTE_ARGV[identity], identity === "apply" ? "healthy-with-fresh-preview" : "derived-index-missing-with-fresh-preview", { fault: "silent-no-op", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER })),
	...ROUTED.map((identity) => un(id(identity, "failed", "INTERNAL_UNEXPECTED"), ROUTE_ARGV[identity], identity === "apply" ? "healthy-with-fresh-preview" : identity.startsWith("repair") ? "derived-index-missing-with-fresh-preview" : "healthy", { fault: "throw-internal" })),
	un(successId("recover", "unchanged"), ["recover"], "healthy"),
	// Egress fallbacks (section 5): read-only and preview routes
	un(id("help", "failed", "INTERNAL_RESULT_UNCHANGED"), ["--help"], "healthy", { fault: CYCLE }),
	un(id("dispatch", "refused", "INTERNAL_PREPARATION"), [], "healthy", { fault: CYCLE }),
	un(id("discovery", "failed", "INTERNAL_RESULT_UNCHANGED"), ["--discover"], "healthy", { fault: CYCLE }),
	un(id("discovery", "refused", "INTERNAL_PREPARATION"), ["--discover", "--no-such-option"], "healthy", { fault: CYCLE }),
	un(id("status", "failed", "INTERNAL_RESULT_UNCHANGED"), ["status"], "healthy", { fault: CYCLE }),
	un(id("status", "failed", "INTERNAL_RESULT_UNCHANGED"), ["status"], "healthy", { fault: `throw-internal+${CYCLE}` }),
	un(id("status", "refused", "INTERNAL_PREPARATION"), ["status", "--no-such-option"], "healthy", { fault: CYCLE }),
	un(id("inspect", "failed", "INTERNAL_RESULT_UNCHANGED"), ["inspect"], "healthy", { fault: CYCLE }),
	un(id("inspect", "failed", "INTERNAL_RESULT_UNCHANGED"), ["inspect", "--state", "state/large.json"], "checker-target", { fault: CYCLE }),
	un(id("inspect", "refused", "INTERNAL_PREPARATION"), ["inspect", "--state", "../../outside-root-sentinel"], "healthy", { fault: CYCLE }),
	un(id("inspect", "refused", "INTERNAL_PREPARATION"), ["inspect", "--state", "state/missing.json"], "healthy", { fault: CYCLE }),
	un(id("inspect-diagnostics", "failed", "INTERNAL_RESULT_UNCHANGED"), ["inspect", "--include-diagnostics"], "secret-marker-in-diagnostic-field", { fault: CYCLE }),
	un(id("inspect-diagnostics", "refused", "INTERNAL_PREPARATION"), ["inspect", "--include-diagnostics", "--state", "state/missing.json"], "healthy", { fault: CYCLE }),
	un(id("preview", "failed", "INTERNAL_RESULT_UNCHANGED"), ["apply", "--preview"], "healthy", { fault: CYCLE }),
	un(id("preview", "refused", "INTERNAL_PREPARATION"), ["apply", "--preview", "--no-such-option"], "healthy", { fault: CYCLE }),
	// Egress fallbacks: effect routes and recover
	un(id("apply", "refused", "INTERNAL_PREPARATION"), STALE, "revision-5-with-revision-4-preview", { fault: CYCLE }),
	un(id("apply", "refused", "INTERNAL_PREPARATION"), ["apply", "--automation"], "healthy", { fault: CYCLE }),
	un(id("apply", "refused", "INTERNAL_PREPARATION"), APPLY, "healthy-with-consumed-preview", { fault: CYCLE }),
	b(id("apply", "failed", "INTERNAL_RESULT_UNKNOWN"), PARTIAL, "healthy-with-partial-preview", { fault: `effect.write-journal-outcome-unknown+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("apply", "failed", "INTERNAL_RESULT_COMPLETED"), APPLY, "healthy-with-fresh-preview", { fault: CYCLE, transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("apply", "failed", "INTERNAL_RESULT_UNCHANGED"), APPLY, "healthy-with-fresh-preview", { fault: `throw-internal+${CYCLE}` }),
	b(id("apply", "failed", "INTERNAL_RESULT_UNKNOWN"), APPLY, "healthy-with-fresh-preview", { setup: "read-only-journal", fault: CYCLE, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("apply", "failed", "INTERNAL_RESULT_UNKNOWN"), APPLY, "healthy-with-fresh-preview", { fault: `silent-no-op+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("repair", "refused", "INTERNAL_PREPARATION"), ["repair", "--preview"], "derived-index-missing", { fault: CYCLE }),
	un(id("repair", "refused", "INTERNAL_PREPARATION"), ["repair", "--preview"], "healthy", { fault: CYCLE }),
	un(id("repair", "refused", "INTERNAL_PREPARATION"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `one-transient-lock+${CYCLE}` }),
	b(id("repair", "failed", "INTERNAL_RESULT_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `effect.write-journal-outcome-unknown+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_RESULT_COMPLETED"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: CYCLE, transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("repair", "failed", "INTERNAL_RESULT_UNCHANGED"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `throw-internal+${CYCLE}` }),
	b(id("repair", "failed", "INTERNAL_RESULT_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", fault: CYCLE, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_RESULT_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `silent-no-op+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("repair-retry", "refused", "INTERNAL_PREPARATION"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `persistent-lock+${CYCLE}` }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `effect.write-journal-outcome-unknown+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_COMPLETED"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `one-transient-lock+${CYCLE}`, transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("repair-retry", "failed", "INTERNAL_RESULT_UNCHANGED"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `throw-internal+${CYCLE}` }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", fault: CYCLE, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `silent-no-op+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("recover", "failed", "INTERNAL_RESULT_UNCHANGED"), ["recover"], "healthy", { fault: CYCLE }),
	un(id("recover", "failed", "INTERNAL_RESULT_UNCHANGED"), ["recover"], "healthy", { fault: `throw-internal+${CYCLE}` }),
	un(id("recover", "refused", "INTERNAL_PREPARATION"), ["recover", "--no-such-option"], "healthy", { fault: CYCLE }),
	b(id("recover", "failed", "INTERNAL_RESULT_UNKNOWN"), ["recover"], "unknown-after-partial", { fault: CYCLE, transactionState: "unknown", guidance: "handoff" }),
	// Internal final-component resource symlinks reach the existing 2.0 precondition tuple on every affected route.
	...(["status", "preview", "apply", "repair", "repair-retry", "recover"] as Identity[]).map((identity) => un(id(identity, "refused", "DOMAIN_PRECONDITION_UNMET"), ROUTE_ARGV[identity], identity === "apply" ? "healthy-with-fresh-preview" : identity === "repair" || identity === "repair-retry" ? "derived-index-missing-with-fresh-preview" : "healthy", { setup: "link-resource" })),
]

function applySetup(root: Root, setup: Setup | undefined): void {
	const resource = join(root.root, "state", "resource.json")
	switch (setup) {
		case undefined:
			return
		case "read-only-journal":
			readOnlyJournal(root)
			return
		case "missing-resource":
			rmSync(resource)
			return
		case "malformed-resource":
			writeFileSync(resource, '{"resource":"demo","revision":4,"stat')
			return
		case "unreadable-resource":
			chmodSync(resource, 0o000)
			return
		case "invalid-resource":
			writeFileSync(resource, '{"resource":"demo","revision":"four","status":"healthy","version":1}\n')
			return
		case "link":
			linkOutside(root, "link")
			return
		case "link-resource":
			linkStateFile(root, "resource.json", readFileSync(resource, "utf8"))
			return
	}
}

interface Observation {
	binding: Binding
	tuple: string
	envelope: Record<string, unknown>
	exit: number
}

const observations: Observation[] = []
const roots: Root[] = []
afterAll(() => {
	for (const root of roots) removeRoot(root)
})

// Readable scenario prefix for the tuple expectation: argv, variant, and the fault or setup that shaped the run.
const scenarioLabel = (binding: Binding): string => `${binding.argv.join(" ")} [${binding.variant}${binding.fault === undefined ? "" : ` ${binding.fault}`}${binding.setup === undefined ? "" : ` ${binding.setup}`}]`

async function observe(binding: Binding): Promise<Observation> {
	const root = createRoot(binding.variant)
	roots.push(root)
	applySetup(root, binding.setup)
	const options = { ...(binding.fault === undefined ? {} : { fault: binding.fault }), ...(binding.env === undefined ? {} : { env: binding.env }) }
	if (binding.before !== undefined) {
		const first = await runCli(root, [...binding.before, "--json"], options)
		if (first.exit !== 0) throw new Error(`before step failed for ${binding.tuple}: ${first.stdout}`)
	}
	const run = await runCli(root, [...binding.argv, "--json"], options)
	expect(run.stderr).toBe("")
	const outer = envelopeOf(run)
	const envelope = outer.result as Record<string, unknown>
	const observation = { binding, tuple: stationIdOf({ commandIdentity: String(envelope.commandIdentity), outcome: String(envelope.outcome), causeCode: String(envelope.causeCode) }), envelope, exit: run.exit }
	observations.push(observation)
	return observation
}

function signatureFor(binding: Binding): Signature {
	const signature = EXPECTED_STATIONS.get(binding.tuple)
	if (signature === undefined) throw new Error(`binding has no oracle signature for ${binding.tuple}`)
	return signature
}

function assertCoreCorrelation(binding: Binding, observation: Observation, signature: Signature): void {
	const { envelope } = observation
	expect(`${scenarioLabel(binding)} -> ${observation.tuple}`).toBe(`${scenarioLabel(binding)} -> ${binding.tuple}`)
	expect(`${binding.tuple} ${envelope.effectClass}|${envelope.transactionState}|${envelope.retryable}|${observation.exit}`).toBe(`${binding.tuple} ${signature.effectClass}|${signature.transactionState}|${signature.retryable}|${signature.exit}`)
	expect(envelope.transactionState).toBe(signature.transactionState)
	expect(envelope.failureClass).toBe(signature.failureClass)
	if (signature.retryable) expect(envelope.retryDelayMilliseconds).toBe(signature.delay)
	else expect(envelope.retryDelayMilliseconds).toBeUndefined()
	if (signature.repairAction) {
		expect(typeof envelope.repairAction).toBe("string")
		expect((envelope.repairAction as string).trim().length).toBeGreaterThan(0)
	} else expect(envelope.repairAction).toBeNull()
}

function assertGuidance(binding: Binding, envelope: Record<string, unknown>, signature: Signature): void {
	const guidance = envelope.nextAction === undefined ? envelope.handoff === undefined ? "missing" : "handoff" : envelope.handoff === undefined ? "next-action" : "invalid"
	expect(`${binding.tuple} ${guidance}`).toBe(`${binding.tuple} ${binding.guidance}`)
	expect(`${binding.tuple} ${guidance}`).toBe(`${binding.tuple} ${signature.guidance}`)
	if (guidance === "handoff") {
		expect(envelope.nextAction).toBeUndefined()
		expect(envelope.handoff).toMatchObject({ owner: "operator" })
		const handoff = envelope.handoff as Record<string, unknown>
		expect(typeof handoff.reason).toBe("string")
		expect((handoff.reason as string).trim().length).toBeGreaterThan(0)
		expect(handoff.inspect).toEqual([INSPECT])
		return
	}
	expect(typeof envelope.nextAction).toBe("string")
	expect((envelope.nextAction as string).trim().length).toBeGreaterThan(0)
	expect(envelope.handoff).toBeUndefined()
	if (binding.nextAction === undefined) throw new Error(`binding lacks next action for ${binding.tuple}`)
	expect(`${binding.tuple} ${String(envelope.nextAction)}`).toBe(`${binding.tuple} ${binding.nextAction}`)
}

function assertData(binding: Binding, envelope: Record<string, unknown>, signature: Signature): void {
	if (envelope.outcome !== "success") expect(envelope.data).toBeNull()
	if (signature.label !== null) expect(`${binding.tuple} ${String((envelope.data as Record<string, unknown>).station_id)}`).toBe(`${binding.tuple} ${signature.label}`)
}

describe("station catalogue", () => {
	test("STATIONS enumerates the same tuples the independent oracle expects; no tuple is declared with two signatures", () => {
		const declared = new Set(STATION_IDS)
		const expected = new Set(EXPECTED_STATIONS.keys())
		expect([...declared].filter((key) => !expected.has(key))).toEqual([])
		expect([...expected].filter((key) => !declared.has(key))).toEqual([])
		const collisions = STATION_IDS.filter((key) => {
			const rows = declaredStation(key)
			return new Set(rows.map((row) => `${row.transactionState}|${row.guidance}|${row.retryable}|${row.retryDelayMilliseconds}|${row.exit}|${row.effectClass}`)).size !== 1
		})
		expect(collisions).toEqual([])
		expect(STATIONS.map((row) => stationIdOfRow(row)).every((key) => expected.has(key))).toBe(true)
		expect(STATIONS).toHaveLength(STATION_IDS.length)
		expect(() => defineStationRows([STATIONS[0] as (typeof STATIONS)[number], STATIONS[0] as (typeof STATIONS)[number]])).toThrow("duplicate station declaration")
	})
	test("every declaration matches the oracle's signature field by field", () => {
		for (const row of STATIONS) {
			const signature = EXPECTED_STATIONS.get(stationIdOfRow(row))
			if (signature === undefined) throw new Error(`STATION_UNDECLARED_IN_ORACLE ${stationIdOfRow(row)}`)
			expect(`${stationIdOfRow(row)} ${row.effectClass}|${row.transactionState}|${row.retryable}|${row.retryDelayMilliseconds}|${row.guidance}|${row.repairAction}|${row.exit}`).toBe(`${stationIdOfRow(row)} ${signature.effectClass}|${signature.transactionState}|${signature.retryable}|${signature.delay}|${signature.guidance}|${signature.repairAction}|${signature.exit}`)
			// Nullable labels compare directly (PR 184, 4003813673): a missing or unexpected fixtureLabel is a field mismatch.
			expect(`${stationIdOfRow(row)} label ${String(row.fixtureLabel)}`).toBe(`${stationIdOfRow(row)} label ${String(signature.label)}`)
		}
	})
	test("every bound scenario reaches its tuple through a real child process with the expected transaction, retry and recovery fields", async () => {
		expect(BINDINGS).toHaveLength(151)
		for (const binding of BINDINGS) {
			const observation = await observe(binding)
			const signature = signatureFor(binding)
			assertCoreCorrelation(binding, observation, signature)
			assertGuidance(binding, observation.envelope, signature)
			assertData(binding, observation.envelope, signature)
		}
	}, 120_000)
	test("three-way set equality: declared, expected and observed tuples coincide (STATION_UNREACHED / STATION_UNDECLARED)", () => {
		expect(observations).toHaveLength(151)
		const observed = new Set(observations.map((observation) => observation.tuple))
		const boundTuples = new Set(BINDINGS.map((binding) => binding.tuple))
		const declared = new Set(STATION_IDS)
		const expected = new Set(EXPECTED_STATIONS.keys())
		const unreached = [...declared].filter((key) => !observed.has(key)).map((key) => `STATION_UNREACHED ${key}`)
		const undeclared = [...observed].filter((key) => !declared.has(key)).map((key) => `STATION_UNDECLARED ${key}`)
		const unexpected = [...observed].filter((key) => !expected.has(key)).map((key) => `STATION_UNEXPECTED ${key}`)
		expect([...unreached, ...undeclared, ...unexpected]).toEqual([])
		expect(observed.size).toBe(boundTuples.size)
		expect(observed.size).toBe(EXPECTED_STATIONS.size)
	})
})
