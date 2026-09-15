import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { declaredStation, STATION_IDS, stationIdOf, stationIdOfRow } from "../../src/branch-station-catalog.ts"
import { STATIONS } from "../../src/command-contract.ts"
import { createRoot, envelopeOf, linkOutside, linkStateFile, readOnlyJournal, removeRoot, type Root, runCli, type Variant } from "../helpers/harness.ts"

// Independent oracle (CDS-PE-4; brief 12, section 5): EXPECTED_STATIONS is restated from the fixture's station_catalog,
// PE revision 3 and brief 12 sections 3.3, 3.4 and 5; BINDINGS ties every tuple to argv, state variant and fault with
// the expected transaction state and guidance per scenario. STATIONS supplies enumeration only; nothing below is read
// from the modules under test. Marked independent oracle: a dedupe pass must not hoist these tables into STATIONS.

type Identity = "help" | "discover" | "status" | "inspect" | "inspect-diagnostics" | "preview" | "apply" | "repair" | "repair-retry" | "recover"
type Outcome = "success" | "refused" | "failed" | "unknown"
type EffectClass = "inspect" | "repository-local"
type State = "unchanged" | "completed" | "unknown"
type Guidance = "next-action" | "handoff"

interface Signature {
	effectClass: EffectClass
	transactionState: State
	retryable: boolean
	delay: number | null
	guidance: Guidance
	repairAction: boolean
	exit: number
	label: string | null
}

const EXPECTED_STATIONS = new Map<string, Signature>()
const READ_ONLY: Identity[] = ["help", "discover", "status", "inspect", "inspect-diagnostics"]
const classOf = (identity: Identity): EffectClass => (READ_ONLY.includes(identity) ? "inspect" : "repository-local")
const id = (identity: Identity, outcome: Outcome, cause: string | null): string => `repair-lab.${identity}|${outcome}|${cause ?? "null"}`
function declare(identity: Identity, outcome: Outcome, cause: string | null, signature: Omit<Signature, "effectClass"> & { effectClass?: EffectClass }): void {
	const key = id(identity, outcome, cause)
	if (EXPECTED_STATIONS.has(key)) throw new Error(`oracle declares ${key} twice`)
	EXPECTED_STATIONS.set(key, { effectClass: classOf(identity), ...signature })
}
const success = (identity: Identity, transactionState: State, retryable: boolean, label: string | null): void => declare(identity, "success", null, { transactionState, retryable, delay: null, guidance: "next-action", repairAction: false, exit: 0, label })
const usage = (identity: Identity, cause: string): void => declare(identity, "refused", cause, { transactionState: "unchanged", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 2, label: null })
const domain = (identity: Identity, cause: string, label: string | null, repairAction = true, exit = 3): void => declare(identity, "refused", cause, { transactionState: "unchanged", retryable: false, delay: null, guidance: "next-action", repairAction, exit, label })
const fallback = (identity: Identity, outcome: Outcome, cause: string, transactionState: State, guidance: Guidance = "next-action"): void => declare(identity, outcome, cause, { transactionState, retryable: false, delay: null, guidance, repairAction: guidance === "next-action", exit: 1, label: "repair-lab.envelope-invalid" })

// Fixture scenarios (station_catalog, thirteen required stations; retry_safety mapped per brief 3.3).
success("status", "unchanged", true, "repair-lab.healthy")
success("inspect", "unchanged", true, "repair-lab.inspect")
success("preview", "unchanged", false, "repair-lab.preview")
success("apply", "completed", false, "repair-lab.authorized-apply")
domain("apply", "DOMAIN_PREVIEW_STALE", "repair-lab.stale-preview")
declare("apply", "unknown", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 1, label: "repair-lab.partial-unknown" })
domain("apply", "DOMAIN_AUTHORITY_MISSING", "repair-lab.prohibited-automation")
domain("repair", "DOMAIN_REPAIR_REQUIRED", "repair-lab.repairable-precondition")
success("repair", "completed", false, "repair-lab.authorized-repair")
success("repair-retry", "completed", false, "repair-lab.permitted-transient-retry")
declare("recover", "unknown", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", { transactionState: "unknown", retryable: false, delay: null, guidance: "handoff", repairAction: false, exit: 3, label: "repair-lab.required-handoff" })
domain("inspect", "DOMAIN_PATH_ESCAPE", "repair-lab.hostile-input")
success("inspect-diagnostics", "unchanged", true, "repair-lab.secret-marker")
// Auxiliary routes (brief 3.4) and the routed usage refusals.
success("help", "unchanged", false, null)
success("discover", "unchanged", false, null)
usage("help", "USAGE_COMMAND_REQUIRED")
usage("help", "USAGE_UNKNOWN_COMMAND")
const ROUTED: Identity[] = ["status", "inspect", "inspect-diagnostics", "preview", "apply", "repair", "repair-retry", "recover"]
for (const identity of ["help", "discover", ...ROUTED] as Identity[]) usage(identity, "USAGE_UNKNOWN_OPTION")
for (const identity of ["help", "discover"] as Identity[]) usage(identity, "USAGE_INVALID_ARGUMENTS")
for (const identity of ROUTED) usage(identity, "USAGE_INVALID_ARGUMENTS")
for (const identity of ROUTED) {
	domain(identity, "DOMAIN_INPUT_MISSING", "repair-lab.input-missing")
	domain(identity, "DOMAIN_INPUT_MALFORMED", "repair-lab.input-malformed")
	domain(identity, "DOMAIN_INPUT_UNREADABLE", "repair-lab.input-unreadable")
	domain(identity, "SCHEMA_STATE_INVALID", "repair-lab.state-schema-invalid", true, 4)
}
domain("inspect-diagnostics", "DOMAIN_PATH_ESCAPE", "repair-lab.hostile-input")
const MUTATING: Identity[] = ["apply", "repair", "repair-retry"]
for (const identity of MUTATING) {
	domain(identity, "DOMAIN_PREVIEW_MISSING", null)
	domain(identity, "DOMAIN_PREVIEW_CONSUMED", null)
	declare(identity, "refused", "UNAVAILABLE_STORAGE_BUSY", { transactionState: "unchanged", retryable: true, delay: 25, guidance: "next-action", repairAction: true, exit: 75, label: null })
	declare(identity, "failed", "INTERNAL_EFFECT_NOT_OBSERVED", { transactionState: "unknown", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 1, label: null })
	// W2 (coordinator ruling, implementation01/w2-owner-resolution.md): failed, existing cause, trusted state unknown.
	declare(identity, "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 1, label: "repair-lab.write-outcome-unknown" })
}
domain("repair", "DOMAIN_PREVIEW_STALE", "repair-lab.stale-preview")
domain("repair-retry", "DOMAIN_PREVIEW_STALE", "repair-lab.stale-preview")
domain("repair", "DOMAIN_AUTHORITY_MISSING", "repair-lab.prohibited-automation")
domain("repair-retry", "DOMAIN_AUTHORITY_MISSING", "repair-lab.prohibited-automation")
domain("repair", "DOMAIN_REPAIR_NOT_REQUIRED", null, false)
domain("repair-retry", "DOMAIN_REPAIR_NOT_REQUIRED", null, false)
declare("repair", "unknown", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 1, label: "repair-lab.partial-unknown" })
declare("repair-retry", "unknown", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", { transactionState: "unknown", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 1, label: "repair-lab.partial-unknown" })
success("recover", "unchanged", true, null)
// Internal state containment (PR 184, 4003813337): a symlinked state file is refused on every routed identity that reads it.
for (const identity of ["status", "preview", "apply", "repair", "repair-retry", "recover"] as Identity[]) domain(identity, "DOMAIN_PATH_ESCAPE", "repair-lab.hostile-input")
// W1: an unexpected exception before any durable write, every routed command (brief section 5).
for (const identity of ROUTED) declare(identity, "failed", "INTERNAL_UNEXPECTED", { transactionState: "unchanged", retryable: false, delay: null, guidance: "next-action", repairAction: true, exit: 1, label: null })
// Egress fallbacks under the accepted D6-c mapping (section 5 table plus the two repair-identity unknown rows).
for (const identity of ["help", "discover", "status", "inspect", "inspect-diagnostics", "preview"] as Identity[]) {
	fallback(identity, "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
	fallback(identity, "refused", "INTERNAL_PREPARATION", "unchanged")
}
for (const identity of MUTATING) {
	fallback(identity, "refused", "INTERNAL_PREPARATION", "unchanged")
	fallback(identity, "unknown", "INTERNAL_RESULT_UNKNOWN", "unknown")
	fallback(identity, "failed", "INTERNAL_RESULT_COMPLETED", "completed")
	fallback(identity, "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
	fallback(identity, "failed", "INTERNAL_RESULT_UNKNOWN", "unknown")
}
fallback("recover", "failed", "INTERNAL_RESULT_UNCHANGED", "unchanged")
fallback("recover", "refused", "INTERNAL_PREPARATION", "unchanged")
fallback("recover", "unknown", "INTERNAL_RESULT_UNKNOWN", "unknown", "handoff")

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
const b = (tuple: string, argv: string[], variant: Variant, rest: Partial<Binding> & { transactionState: State; guidance: Guidance }): Binding => ({ tuple, argv, variant, ...rest })
const un = (tuple: string, argv: string[], variant: Variant, rest: Partial<Binding> = {}): Binding => b(tuple, argv, variant, { transactionState: "unchanged", guidance: "next-action", nextAction: INSPECT, ...rest })
const ROUTE_ARGV: Record<Identity, string[]> = { help: ["--help"], discover: ["--discover"], status: ["status"], inspect: ["inspect"], "inspect-diagnostics": ["inspect", "--include-diagnostics"], preview: ["apply", "--preview"], apply: APPLY, repair: REPAIR, "repair-retry": RETRY, recover: ["recover"] }

const BINDINGS: Binding[] = [
	// Thirteen fixture scenarios (3.3)
	un(id("status", "success", null), ["status"], "healthy"),
	un(id("inspect", "success", null), ["inspect"], "healthy", { nextAction: "repair-lab apply --preview" }),
	un(id("preview", "success", null), ["apply", "--preview"], "healthy", { nextAction: "repair-lab apply --preview-id preview-healthy-revision-4 --authorize fixture-authority" }),
	b(id("apply", "success", null), APPLY, "healthy-with-fresh-preview", { transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("apply", "refused", "DOMAIN_PREVIEW_STALE"), STALE, "revision-5-with-revision-4-preview"),
	b(id("apply", "unknown", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), PARTIAL, "healthy-with-partial-preview", { fault: "effect.write-journal-outcome-unknown", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("apply", "refused", "DOMAIN_AUTHORITY_MISSING"), ["apply", "--automation"], "healthy"),
	un(id("repair", "refused", "DOMAIN_REPAIR_REQUIRED"), ["repair", "--preview"], "derived-index-missing", { nextAction: "repair-lab repair --apply --preview-id repair-preview-missing-index --authorize fixture-authority" }),
	b(id("repair", "success", null), REPAIR, "derived-index-missing-with-fresh-preview", { transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	b(id("repair-retry", "success", null), RETRY, "derived-index-missing-with-fresh-preview", { fault: "one-transient-lock", transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	b(id("recover", "unknown", "DOMAIN_RECOVERY_HANDOFF_REQUIRED"), ["recover"], "unknown-after-partial", { transactionState: "unknown", guidance: "handoff" }),
	un(id("inspect", "refused", "DOMAIN_PATH_ESCAPE"), ["inspect", "--state", "../../outside-root-sentinel"], "healthy"),
	un(id("inspect-diagnostics", "success", null), ["inspect", "--include-diagnostics"], "secret-marker-in-diagnostic-field"),
	// Containment negatives share row 12's station; the diagnostics route has its own.
	un(id("inspect", "refused", "DOMAIN_PATH_ESCAPE"), ["inspect", "--state", "../run-other/resource.json"], "healthy"),
	un(id("inspect", "refused", "DOMAIN_PATH_ESCAPE"), ["inspect", "--state", "state/link/resource.json"], "healthy", { setup: "link" }),
	un(id("inspect-diagnostics", "refused", "DOMAIN_PATH_ESCAPE"), ["inspect", "--include-diagnostics", "--state", "../../outside-root-sentinel"], "healthy"),
	// Help, discovery and usage (3.4)
	b(id("help", "success", null), ["--help"], "healthy", { transactionState: "unchanged", guidance: "next-action" }),
	b(id("discover", "success", null), ["--discover"], "healthy", { transactionState: "unchanged", guidance: "next-action" }),
	un(id("help", "refused", "USAGE_COMMAND_REQUIRED"), [], "healthy", { nextAction: HELP }),
	un(id("help", "refused", "USAGE_UNKNOWN_COMMAND"), ["frobnicate"], "healthy", { nextAction: HELP }),
	...(["help", "discover", ...ROUTED] as Identity[]).map((identity) => un(id(identity, "refused", "USAGE_UNKNOWN_OPTION"), [...(identity === "help" ? [] : ROUTE_ARGV[identity]), "--no-such-option"], "healthy", { nextAction: HELP })),
	un(id("help", "refused", "USAGE_INVALID_ARGUMENTS"), ["--help", "--apply"], "healthy", { nextAction: HELP }),
	un(id("discover", "refused", "USAGE_INVALID_ARGUMENTS"), ["--discover", "--state", "state/resource.json"], "healthy", { nextAction: HELP }),
	...ROUTED.map((identity) => un(id(identity, "refused", "USAGE_INVALID_ARGUMENTS"), ROUTE_ARGV[identity], "healthy", { fault: "nope", nextAction: HELP })),
	// Input refusals on every resource-reading identity (F3)
	...ROUTED.flatMap((identity) => [
		un(id(identity, "refused", "DOMAIN_INPUT_MISSING"), ROUTE_ARGV[identity], "healthy", { setup: "missing-resource" }),
		un(id(identity, "refused", "DOMAIN_INPUT_MALFORMED"), ROUTE_ARGV[identity], "healthy", { setup: "malformed-resource" }),
		un(id(identity, "refused", "DOMAIN_INPUT_UNREADABLE"), ROUTE_ARGV[identity], "healthy", { setup: "unreadable-resource" }),
		un(id(identity, "refused", "SCHEMA_STATE_INVALID"), ROUTE_ARGV[identity], "healthy", { setup: "invalid-resource" }),
	]),
	// Admission refusals (3.5 steps 2 through 10) on the three mutating identities
	un(id("apply", "refused", "DOMAIN_PREVIEW_MISSING"), APPLY, "healthy", { nextAction: "repair-lab apply --preview" }),
	un(id("repair", "refused", "DOMAIN_PREVIEW_MISSING"), REPAIR, "derived-index-missing", { nextAction: "repair-lab repair --preview" }),
	un(id("repair-retry", "refused", "DOMAIN_PREVIEW_MISSING"), RETRY, "derived-index-missing-with-apply-preview", { nextAction: "repair-lab repair --preview" }),
	un(id("apply", "refused", "DOMAIN_PREVIEW_CONSUMED"), APPLY, "healthy-with-consumed-preview"),
	un(id("repair", "refused", "DOMAIN_PREVIEW_CONSUMED"), REPAIR, "derived-index-missing-with-fresh-preview", { before: REPAIR }),
	un(id("repair-retry", "refused", "DOMAIN_PREVIEW_CONSUMED"), RETRY, "derived-index-missing-with-fresh-preview", { before: RETRY }),
	un(id("repair", "refused", "DOMAIN_PREVIEW_STALE"), REPAIR, "repair-stale"),
	un(id("repair-retry", "refused", "DOMAIN_PREVIEW_STALE"), RETRY, "repair-stale"),
	un(id("repair", "refused", "DOMAIN_AUTHORITY_MISSING"), ["repair", "--apply", "--preview-id", "repair-preview-missing-index"], "derived-index-missing-with-fresh-preview"),
	un(id("repair-retry", "refused", "DOMAIN_AUTHORITY_MISSING"), ["repair", "--apply", "--retry-once"], "derived-index-missing-with-fresh-preview"),
	un(id("repair", "refused", "DOMAIN_REPAIR_NOT_REQUIRED"), ["repair", "--preview"], "healthy"),
	un(id("repair-retry", "refused", "DOMAIN_REPAIR_NOT_REQUIRED"), RETRY, "healthy-with-repair-preview"),
	un(id("apply", "refused", "UNAVAILABLE_STORAGE_BUSY"), APPLY, "healthy-with-fresh-preview", { fault: "one-transient-lock", nextAction: "retry the same command after 25 ms" }),
	un(id("repair", "refused", "UNAVAILABLE_STORAGE_BUSY"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: "one-transient-lock", nextAction: "retry the same command after 25 ms" }),
	un(id("repair-retry", "refused", "UNAVAILABLE_STORAGE_BUSY"), RETRY, "derived-index-missing-with-fresh-preview", { fault: "persistent-lock", nextAction: "retry the same command after 25 ms" }),
	// Execution boundaries W2, W3, W4 on every effect route; W1 on every routed command
	b(id("apply", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), APPLY, "healthy-with-fresh-preview", { setup: "read-only-journal", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "unknown", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: "effect.write-journal-outcome-unknown", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "unknown", "INTERNAL_EFFECT_OUTCOME_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { fault: "effect.write-journal-outcome-unknown", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	...MUTATING.map((identity) => b(id(identity, "failed", "INTERNAL_EFFECT_NOT_OBSERVED"), ROUTE_ARGV[identity], identity === "apply" ? "healthy-with-fresh-preview" : "derived-index-missing-with-fresh-preview", { fault: "silent-no-op", transactionState: "unknown", guidance: "next-action", nextAction: RECOVER })),
	...ROUTED.map((identity) => un(id(identity, "failed", "INTERNAL_UNEXPECTED"), ROUTE_ARGV[identity], identity === "apply" ? "healthy-with-fresh-preview" : identity.startsWith("repair") ? "derived-index-missing-with-fresh-preview" : "healthy", { fault: "throw-internal" })),
	un(id("recover", "success", null), ["recover"], "healthy"),
	// Egress fallbacks (section 5): read-only and preview routes
	un(id("help", "failed", "INTERNAL_RESULT_UNCHANGED"), ["--help"], "healthy", { fault: CYCLE }),
	un(id("help", "refused", "INTERNAL_PREPARATION"), [], "healthy", { fault: CYCLE }),
	un(id("discover", "failed", "INTERNAL_RESULT_UNCHANGED"), ["--discover"], "healthy", { fault: CYCLE }),
	un(id("discover", "refused", "INTERNAL_PREPARATION"), ["--discover", "--no-such-option"], "healthy", { fault: CYCLE }),
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
	b(id("apply", "unknown", "INTERNAL_RESULT_UNKNOWN"), PARTIAL, "healthy-with-partial-preview", { fault: `effect.write-journal-outcome-unknown+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("apply", "failed", "INTERNAL_RESULT_COMPLETED"), APPLY, "healthy-with-fresh-preview", { fault: CYCLE, transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("apply", "failed", "INTERNAL_RESULT_UNCHANGED"), APPLY, "healthy-with-fresh-preview", { fault: `throw-internal+${CYCLE}` }),
	b(id("apply", "failed", "INTERNAL_RESULT_UNKNOWN"), APPLY, "healthy-with-fresh-preview", { setup: "read-only-journal", fault: CYCLE, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("apply", "failed", "INTERNAL_RESULT_UNKNOWN"), APPLY, "healthy-with-fresh-preview", { fault: `silent-no-op+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("repair", "refused", "INTERNAL_PREPARATION"), ["repair", "--preview"], "derived-index-missing", { fault: CYCLE }),
	un(id("repair", "refused", "INTERNAL_PREPARATION"), ["repair", "--preview"], "healthy", { fault: CYCLE }),
	un(id("repair", "refused", "INTERNAL_PREPARATION"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `one-transient-lock+${CYCLE}` }),
	b(id("repair", "unknown", "INTERNAL_RESULT_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `effect.write-journal-outcome-unknown+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_RESULT_COMPLETED"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: CYCLE, transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("repair", "failed", "INTERNAL_RESULT_UNCHANGED"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `throw-internal+${CYCLE}` }),
	b(id("repair", "failed", "INTERNAL_RESULT_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", fault: CYCLE, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair", "failed", "INTERNAL_RESULT_UNKNOWN"), REPAIR, "derived-index-missing-with-fresh-preview", { fault: `silent-no-op+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("repair-retry", "refused", "INTERNAL_PREPARATION"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `persistent-lock+${CYCLE}` }),
	b(id("repair-retry", "unknown", "INTERNAL_RESULT_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `effect.write-journal-outcome-unknown+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_COMPLETED"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `one-transient-lock+${CYCLE}`, transactionState: "completed", guidance: "next-action", nextAction: INSPECT }),
	un(id("repair-retry", "failed", "INTERNAL_RESULT_UNCHANGED"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `throw-internal+${CYCLE}` }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { setup: "read-only-journal", fault: CYCLE, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	b(id("repair-retry", "failed", "INTERNAL_RESULT_UNKNOWN"), RETRY, "derived-index-missing-with-fresh-preview", { fault: `silent-no-op+${CYCLE}`, transactionState: "unknown", guidance: "next-action", nextAction: RECOVER }),
	un(id("recover", "failed", "INTERNAL_RESULT_UNCHANGED"), ["recover"], "healthy", { fault: CYCLE }),
	un(id("recover", "failed", "INTERNAL_RESULT_UNCHANGED"), ["recover"], "healthy", { fault: `throw-internal+${CYCLE}` }),
	un(id("recover", "refused", "INTERNAL_PREPARATION"), ["recover", "--no-such-option"], "healthy", { fault: CYCLE }),
	b(id("recover", "unknown", "INTERNAL_RESULT_UNKNOWN"), ["recover"], "unknown-after-partial", { fault: CYCLE, transactionState: "unknown", guidance: "handoff" }),
	// Internal state containment (PR 184, 4003813337): the resource file itself is a final-component symlink.
	un(id("status", "refused", "DOMAIN_PATH_ESCAPE"), ["status"], "healthy", { setup: "link-resource" }),
	un(id("preview", "refused", "DOMAIN_PATH_ESCAPE"), ["apply", "--preview"], "healthy", { setup: "link-resource" }),
	un(id("apply", "refused", "DOMAIN_PATH_ESCAPE"), APPLY, "healthy-with-fresh-preview", { setup: "link-resource" }),
	un(id("repair", "refused", "DOMAIN_PATH_ESCAPE"), REPAIR, "derived-index-missing-with-fresh-preview", { setup: "link-resource" }),
	un(id("repair-retry", "refused", "DOMAIN_PATH_ESCAPE"), RETRY, "derived-index-missing-with-fresh-preview", { setup: "link-resource" }),
	un(id("recover", "refused", "DOMAIN_PATH_ESCAPE"), ["recover"], "healthy", { setup: "link-resource" }),
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
	const envelope = envelopeOf(run)
	const observation = { binding, tuple: stationIdOf({ commandIdentity: String(envelope.commandIdentity), outcome: String(envelope.outcome), causeCode: envelope.causeCode === null ? null : String(envelope.causeCode) }), envelope, exit: run.exit }
	observations.push(observation)
	return observation
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
		for (const binding of BINDINGS) {
			const observation = await observe(binding)
			const { envelope } = observation
			const signature = EXPECTED_STATIONS.get(binding.tuple) as Signature
			expect(`${scenarioLabel(binding)} -> ${observation.tuple}`).toBe(`${scenarioLabel(binding)} -> ${binding.tuple}`)
			expect(`${binding.tuple} ${envelope.effectClass}|${envelope.transactionState}|${envelope.retryable}|${envelope.retryDelayMilliseconds}|${observation.exit}`).toBe(`${binding.tuple} ${signature.effectClass}|${binding.transactionState}|${signature.retryable}|${signature.delay}|${signature.exit}`)
			expect(envelope.transactionState).toBe(signature.transactionState)
			const guidance = envelope.handoff !== null ? "handoff" : "next-action"
			expect(`${binding.tuple} ${guidance}`).toBe(`${binding.tuple} ${binding.guidance}`)
			expect(`${binding.tuple} ${guidance}`).toBe(`${binding.tuple} ${signature.guidance}`)
			expect(`${binding.tuple} repairAction ${envelope.repairAction !== null}`).toBe(`${binding.tuple} repairAction ${signature.repairAction}`)
			if (binding.nextAction !== undefined) expect(`${binding.tuple} ${String(envelope.nextAction)}`).toBe(`${binding.tuple} ${binding.nextAction}`)
			if (guidance === "handoff") expect(envelope.nextAction).toBeNull()
			if (signature.label !== null && envelope.result !== null) expect(`${binding.tuple} ${String((envelope.result as Record<string, unknown>).station_id)}`).toBe(`${binding.tuple} ${signature.label}`)
		}
	}, 120_000)
	test("three-way set equality: declared, expected and observed tuples coincide (STATION_UNREACHED / STATION_UNDECLARED)", () => {
		expect(observations.length).toBe(BINDINGS.length)
		const observed = new Set(observations.map((observation) => observation.tuple))
		const declared = new Set(STATION_IDS)
		const expected = new Set(EXPECTED_STATIONS.keys())
		const unreached = [...declared].filter((key) => !observed.has(key)).map((key) => `STATION_UNREACHED ${key}`)
		const undeclared = [...observed].filter((key) => !declared.has(key)).map((key) => `STATION_UNDECLARED ${key}`)
		const unexpected = [...observed].filter((key) => !expected.has(key)).map((key) => `STATION_UNEXPECTED ${key}`)
		expect([...unreached, ...undeclared, ...unexpected]).toEqual([])
		expect(observed.size).toBe(EXPECTED_STATIONS.size)
	})
})
