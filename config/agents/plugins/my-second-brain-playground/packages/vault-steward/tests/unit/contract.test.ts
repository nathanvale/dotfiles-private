import { expect, test } from "bun:test"
import { machineMode, routeRawArgv } from "../../src/cli.ts"
import { causeRule, COMMANDS, EXIT, EXIT_MEANINGS, exitFor, MachineEnvelopeSchema, sortedUnique, WIRE_CAUSES } from "../../src/command-contract.ts"
import { parseFaults } from "../../src/faults.ts"
import { BRANCH_STATIONS, catalogueSchemaIssues } from "../../src/station-catalogue.ts"

// Contract enumeration: the wire vocabulary is exactly the Contract Core 2.0 core rows plus the CONTRACT.md 3.3 product
// causes this CLI emits, every cause's rule row is the literal restated here (independent oracle, not read from the
// checker or the contract module), the exit map is the six accepted exits, and raw argv routing keeps the command
// identity for usage refusals.

const EXPECTED_RULES: Record<string, [string | null, string, string, boolean, string]> = {
	SUCCESS_UNCHANGED: [null, "success", "unchanged", false, "next"],
	SUCCESS_COMPLETED: [null, "success", "completed", false, "next"],
	USAGE_INVALID_INVOCATION: ["usage", "refused", "unchanged", false, "next"],
	USAGE_UNKNOWN_COMMAND: ["usage", "refused", "unchanged", false, "next"],
	SCHEMA_INVALID_INPUT: ["schema", "refused", "unchanged", false, "next"],
	SCHEMA_CONFIG_INVALID: ["schema", "refused", "unchanged", false, "next"],
	SCHEMA_MANIFEST_INVALID: ["schema", "refused", "unchanged", false, "handoff"],
	SCHEMA_RECEIPT_INVALID: ["schema", "refused", "unchanged", false, "handoff"],
	SCHEMA_PREVIEW_INVALID: ["schema", "refused", "unchanged", false, "handoff"],
	DOMAIN_CONFIG_MISSING: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_VAULT_NOT_FOUND: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_CANONICAL_NOT_MAIN: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_PATH_REFUSED: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_CANDIDATE_NOT_FOUND: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_CANDIDATE_INVALID: ["domain", "refused", "unchanged", false, "handoff"],
	DOMAIN_PATH_SET_MISMATCH: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_CHECK_FAILED: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_FORMAT_FAILED: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_GUARD_INCOMPATIBLE: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_CANONICAL_NOT_READY: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_MAIN_DIVERGED: ["domain", "refused", "unchanged", false, "handoff"],
	DOMAIN_SEMANTIC_OVERLAP: ["domain", "refused", "unchanged", false, "handoff"],
	DOMAIN_PREVIEW_NOT_FOUND: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_PREVIEW_CONSUMED: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_PREVIEW_STALE: ["domain", "refused", "unchanged", false, "next"],
	DOMAIN_REBASE_CONFLICT: ["domain", "failed", "unchanged", false, "handoff"],
	DOMAIN_REBASED_CHECK_FAILED: ["domain", "failed", "unchanged", false, "next"],
	DOMAIN_RECOVERY_UNPROVABLE: ["domain", "refused", "unchanged", false, "handoff"],
	TRANSIENT_INTEGRATION_BUSY: ["transient", "refused", "unchanged", true, "next"],
	INTERNAL_GIT_FAILED_UNCHANGED: ["internal", "failed", "unchanged", false, "handoff"],
	INTERNAL_GIT_FAILED_PARTIAL: ["internal", "failed", "partially-completed", false, "handoff"],
	INTERNAL_GIT_FAILED_UNKNOWN: ["internal", "failed", "unknown", false, "handoff"],
	INTERNAL_INTEGRATION_UNPROVED: ["internal", "failed", "unknown", false, "handoff"],
	INTERNAL_INTEGRATION_UNPROVED_UNCHANGED: ["internal", "failed", "unchanged", false, "handoff"],
	INTERNAL_COMPLETION_RECORD_FAILED: ["internal", "failed", "partially-completed", false, "next"],
	INTERNAL_UNEXPECTED_UNCHANGED: ["internal", "failed", "unchanged", false, "handoff"],
	INTERNAL_UNEXPECTED_UNKNOWN: ["internal", "failed", "unknown", false, "handoff"],
}

test("the wire cause vocabulary and its rule rows are exactly the expected literals", () => {
	expect([...WIRE_CAUSES].sort() as string[]).toEqual(Object.keys(EXPECTED_RULES).sort())
	for (const [code, [failureClass, outcome, state, retryable, guidance]] of Object.entries(EXPECTED_RULES)) {
		expect(causeRule(code as Parameters<typeof causeRule>[0]) as Record<string, unknown>, code).toEqual({ failureClass, outcome, transactionState: state, retryable, guidance })
	}
})

test("the exit map and meanings are the six accepted exits", () => {
	expect(EXIT as Record<string, number>).toEqual({ success: 0, internal: 1, usage: 2, domain: 3, schema: 4, transient: 75 })
	expect(EXIT_MEANINGS as Record<string, string>).toEqual({ "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" })
	expect(exitFor(null)).toBe(0)
	expect(exitFor("transient")).toBe(75)
	expect(COMMANDS.map((command) => command.commandIdentity)).toEqual(["vault-steward.dispatch", "vault-steward.help", "vault-steward.discovery", "vault-steward.command-discovery", "vault-steward.begin", "vault-steward.finish-preview", "vault-steward.finish-apply", "vault-steward.inspect", "vault-steward.recover"])
})

test("raw argv routing derives the identity before strict parsing and --json anywhere before -- is machine mode", () => {
	expect(routeRawArgv(["begin", "--bogus"]).identity).toBe("vault-steward.begin")
	expect(routeRawArgv(["finish", "--preview", "--worktree", "/w"]).identity).toBe("vault-steward.finish-preview")
	expect(routeRawArgv(["finish", "--apply", "--preview-id", "p"]).identity).toBe("vault-steward.finish-apply")
	expect(routeRawArgv(["finish", "--apply", "--preview"]).identity).toBe("vault-steward.finish-preview")
	expect(routeRawArgv(["inspect"]).identity).toBe("vault-steward.inspect")
	expect(routeRawArgv(["recover"]).identity).toBe("vault-steward.recover")
	expect(routeRawArgv(["--help"]).identity).toBe("vault-steward.help")
	expect(routeRawArgv(["--discover"]).identity).toBe("vault-steward.discovery")
	expect(routeRawArgv(["--discover-command", "vault-steward.begin"]).identity).toBe("vault-steward.command-discovery")
	expect(routeRawArgv(["--discover-command"]).identity).toBe("vault-steward.dispatch")
	expect(routeRawArgv(["--help", "--discover"]).identity).toBe("vault-steward.dispatch")
	expect(routeRawArgv([]).identity).toBe("vault-steward.dispatch")
	expect(routeRawArgv(["frobnicate"]).identity).toBe("vault-steward.dispatch")
	expect(machineMode(["begin", "--json"])).toBe(true)
	expect(machineMode(["begin", "--", "--json"])).toBe(false)
	expect(sortedUnique(["a", "b"])).toBe(true)
	expect(sortedUnique(["b", "a"])).toBe(false)
})

test("the fault channel grammar is closed", () => {
	expect(parseFaults(undefined)).toEqual([])
	expect(parseFaults("git-failure=rev-parse HEAD")).toEqual([{ kind: "git-failure", occurrence: 1, fragment: "rev-parse HEAD" }])
	expect(parseFaults("git-failure#3=rev-parse HEAD;halt=after-ff-merge;pause=after-lock:250")).toEqual([
		{ kind: "git-failure", occurrence: 3, fragment: "rev-parse HEAD" },
		{ kind: "halt", point: "after-ff-merge" },
		{ kind: "pause", point: "after-lock", milliseconds: 250 },
	])
	expect(parseFaults("unexpected=--git-common-dir")).toEqual([{ kind: "unexpected", occurrence: 1, fragment: "--git-common-dir" }])
	expect(parseFaults("explode")).toBeNull()
	expect(parseFaults("pause=after-lock:0")).toBeNull()
})

test("every declared station passes the strict catalogue schema and the envelope schema rejects a malformed result", () => {
	for (const station of BRANCH_STATIONS) expect(catalogueSchemaIssues(station), station.identity).toEqual([])
	const envelope = {
		envelopeVersion: 2,
		contractVersion: "2.0.0",
		message: "x",
		availablePaths: ["vault-steward.discovery", "vault-steward.help"],
		result: { runId: "run-1", commandIdentity: "vault-steward.inspect", outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: null, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "vault-steward.help" },
	}
	expect(MachineEnvelopeSchema.safeParse(envelope).success).toBe(true)
	expect(MachineEnvelopeSchema.safeParse({ ...envelope, result: { ...envelope.result, handoff: { owner: "human", reason: "both", inspect: ["x"] } } }).success).toBe(false)
	expect(MachineEnvelopeSchema.safeParse({ ...envelope, result: { ...envelope.result, effects: { ...envelope.result.effects, completed: ["b", "a"] } } }).success).toBe(false)
	expect(MachineEnvelopeSchema.safeParse({ ...envelope, availablePaths: ["vault-steward.help", "vault-steward.discovery"] }).success).toBe(false)
})
