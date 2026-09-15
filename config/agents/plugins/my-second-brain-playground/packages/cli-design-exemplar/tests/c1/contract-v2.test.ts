import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseMachineEnvelope } from "../../src/command-contract.ts"
import { emitMachine } from "../../src/cli.ts"
import type { ExecutionFacts } from "../../src/model.ts"
import { createRoot, readState, removeRoot, runCli } from "../helpers/harness.ts"

const facts: ExecutionFacts = { commandIdentity: "repair-lab.status", runIdentity: "run-c1", domainOutcome: "success", effectClass: "inspect", transactionState: "unchanged", completedEffectIds: [], remainingEffectIds: [], stationLabel: "c1", guidance: { kind: "next-action", target: "repair-lab inspect" } }
const valid = { envelopeVersion: 2, contractVersion: "2.0.0", message: "Status read", availablePaths: ["repair-lab.inspect"], result: { runId: "run-c1", commandIdentity: "repair-lab.status", outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: { status: "healthy" }, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect" } }

describe("C1 successor writer", () => {
	test("accepts the independently authored success tuple and rejects reverse correlations", () => {
		expect(parseMachineEnvelope(valid).ok).toBe(true)
		expect(parseMachineEnvelope({ ...valid, result: { ...valid.result, data: null } }).ok).toBe(true)
		expect(parseMachineEnvelope({ ...valid, extra: true }).ok).toBe(false)
		expect(parseMachineEnvelope({ ...valid, result: { ...valid.result, transactionState: "unknown" } }).ok).toBe(false)
		expect(parseMachineEnvelope({ ...valid, result: { ...valid.result, nextAction: "repair-lab inspect", handoff: { owner: "operator", reason: "r", inspect: ["repair-lab inspect"] } } }).ok).toBe(false)
	})
	test("the production writer preserves successful null data", () => {
		const output: string[] = []
		expect(emitMachine({ ...valid, result: { ...valid.result, data: null } }, facts, { stdout: (text) => output.push(text), stderr: () => { throw new Error("machine stderr") } })).toBe(0)
		expect((JSON.parse(output[0] ?? "") as { result: { data: unknown } }).result.data).toBeNull()
	})
	test("admits every literal C0 cause, outcome, state, retry, and guidance correlation", () => {
		const rows = [
			{ runId: "matrix-success-unchanged", commandIdentity: "repair-lab.status", outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: { status: "healthy" }, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect", message: "Status read" },
			{ runId: "matrix-success-completed", commandIdentity: "repair-lab.apply", outcome: "success", effectClass: "repository-local", transactionState: "completed", causeCode: "SUCCESS_COMPLETED", failureClass: null, exitCode: 0, data: { status: "healthy" }, retryable: false, repairAction: null, effects: { completed: ["effect.one"], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect", message: "Apply completed" },
			{ runId: "matrix-usage-invalid", commandIdentity: "repair-lab.status", outcome: "refused", effectClass: "inspect", transactionState: "unchanged", causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exitCode: 2, data: null, retryable: false, repairAction: "Correct invocation", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab --help", message: "Invalid invocation" },
			{ runId: "matrix-usage-unknown", commandIdentity: "repair-lab.status", outcome: "refused", effectClass: "inspect", transactionState: "unchanged", causeCode: "USAGE_UNKNOWN_COMMAND", failureClass: "usage", exitCode: 2, data: null, retryable: false, repairAction: "Select a command", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab --help", message: "Unknown command" },
			{ runId: "matrix-schema-invalid", commandIdentity: "repair-lab.status", outcome: "refused", effectClass: "inspect", transactionState: "unchanged", causeCode: "SCHEMA_INVALID_INPUT", failureClass: "schema", exitCode: 4, data: null, retryable: false, repairAction: "Correct input", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab --help", message: "Invalid input" },
			{ runId: "matrix-schema-unsupported", commandIdentity: "repair-lab.status", outcome: "refused", effectClass: "inspect", transactionState: "unchanged", causeCode: "SCHEMA_UNSUPPORTED_CONTRACT", failureClass: "schema", exitCode: 4, data: null, retryable: false, repairAction: "Use 2.0.0", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab --help", message: "Unsupported contract" },
			{ runId: "matrix-domain-precondition", commandIdentity: "repair-lab.apply", outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Repair precondition", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect", message: "Precondition unmet" },
			{ runId: "matrix-domain-authority", commandIdentity: "repair-lab.apply", outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", causeCode: "DOMAIN_AUTHORITY_REQUIRED", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Obtain authority", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "Obtain authority", inspect: ["repair-lab inspect"] }, message: "Authority required" },
			{ runId: "matrix-transient-not-started", commandIdentity: "repair-lab.apply", outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", causeCode: "TRANSIENT_NOT_STARTED", failureClass: "transient", exitCode: 75, data: null, retryable: true, retryDelayMilliseconds: 25, repairAction: "Wait", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "retry", message: "Storage busy" },
			{ runId: "matrix-domain-before-deadline", commandIdentity: "repair-lab.apply", outcome: "refused", effectClass: "repository-local", transactionState: "unchanged", causeCode: "DOMAIN_DEADLINE_BEFORE_START", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Inspect deadline", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect", message: "Deadline before start" },
			{ runId: "matrix-internal-preparation", commandIdentity: "repair-lab.status", outcome: "refused", effectClass: "inspect", transactionState: "unchanged", causeCode: "INTERNAL_PREPARATION", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "Repair runtime", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect", message: "Preparation failed" },
			{ runId: "matrix-transient-unchanged", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "TRANSIENT_ATTEMPT_UNCHANGED", failureClass: "transient", exitCode: 75, data: null, retryable: true, retryDelayMilliseconds: 25, repairAction: "Wait", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "retry", message: "Attempt transiently failed" },
			{ runId: "matrix-domain-unchanged", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "DOMAIN_DEADLINE_UNCHANGED", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Inspect deadline", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect", message: "Deadline unchanged" },
			{ runId: "matrix-internal-unchanged", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "Inspect result", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect result", inspect: ["repair-lab inspect"] }, message: "Result failed unchanged" },
			{ runId: "matrix-domain-completed", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "completed", causeCode: "DOMAIN_DEADLINE_COMPLETED", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Inspect completion", effects: { completed: ["effect.one"], remaining: [], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect completion", inspect: ["repair-lab inspect"] }, message: "Deadline after completion" },
			{ runId: "matrix-internal-completed", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "completed", causeCode: "INTERNAL_RESULT_COMPLETED", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "Inspect completion", effects: { completed: ["effect.one"], remaining: [], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect completion", inspect: ["repair-lab inspect"] }, message: "Result failed after completion" },
			{ runId: "matrix-internal-partial", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", causeCode: "INTERNAL_RESULT_PARTIAL", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "Inspect partial", effects: { completed: ["effect.one"], remaining: ["effect.two"], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect partial", inspect: ["repair-lab inspect"] }, message: "Result partially failed" },
			{ runId: "matrix-domain-partial", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", causeCode: "DOMAIN_DEADLINE_PARTIAL", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Inspect partial", effects: { completed: ["effect.one"], remaining: ["effect.two"], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect partial", inspect: ["repair-lab inspect"] }, message: "Deadline after partial completion" },
			{ runId: "matrix-internal-unknown", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unknown", causeCode: "INTERNAL_RESULT_UNKNOWN", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "Inspect uncertainty", effects: { completed: [], remaining: [], uncertain: ["effect.one"], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect uncertainty", inspect: ["repair-lab inspect"] }, message: "Result uncertainty" },
			{ runId: "matrix-domain-unknown", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unknown", causeCode: "DOMAIN_DEADLINE_UNKNOWN", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "Inspect uncertainty", effects: { completed: [], remaining: [], uncertain: ["effect.one"], inventoryComplete: true }, handoff: { owner: "operator", reason: "Inspect uncertainty", inspect: ["repair-lab inspect"] }, message: "Deadline uncertainty" },
		] as const
		for (const row of rows) {
			const { message: _historicalResultMessage, ...result } = row
			expect(parseMachineEnvelope({ envelopeVersion: 2, contractVersion: "2.0.0", message: "Matrix specimen", availablePaths: ["repair-lab.inspect"], result: row }).ok, `${row.causeCode} rejects nested result.message`).toBe(false)
			expect(parseMachineEnvelope({ envelopeVersion: 2, contractVersion: "2.0.0", message: "Matrix specimen", availablePaths: ["repair-lab.inspect"], result }).ok, row.causeCode).toBe(true)
		}
	})
	test("writes one valid fallback for a cycle and keeps machine stderr empty", () => {
		const output: string[] = []; const cyclic = { ...valid, result: { ...valid.result } } as Record<string, unknown>; cyclic.self = cyclic
		expect(emitMachine(cyclic, facts, { stdout: (text) => output.push(text), stderr: () => { throw new Error("machine stderr") } })).toBe(1)
		expect(output).toHaveLength(1); expect(output[0]?.endsWith("\n")).toBe(true); expect(new TextEncoder().encode(output[0] ?? "").byteLength).toBeLessThanOrEqual(16_385); expect(parseMachineEnvelope(JSON.parse(output[0] ?? "")).ok).toBe(true)
	})
	test("does not recurse when fallback output fails or replace an output that already started", () => {
		let fallbackWrites = 0
		const throwing = { stdout: () => { fallbackWrites += 1; throw new Error("broken pipe") }, stderr: () => { throw new Error("machine stderr") } }
		const cyclic: Record<string, unknown> = { ...valid }; cyclic.self = cyclic
		expect(emitMachine(cyclic, facts, throwing)).toBe(1)
		expect(fallbackWrites).toBe(1)
		fallbackWrites = 0
		expect(emitMachine(valid, facts, throwing)).toBe(1)
		expect(fallbackWrites).toBe(1)
	})
	test("the public executable emits a single 2.0 envelope on clean piped streams", async () => {
		const root = createRoot("healthy")
		try { const observed = await runCli(root, ["status", "--json"]); expect(observed.exit).toBe(0); expect(observed.stderr).toBe(""); expect(observed.stdout.split("\n").filter(Boolean)).toHaveLength(1); expect(parseMachineEnvelope(JSON.parse(observed.stdout)).ok).toBe(true) } finally { removeRoot(root) }
	})
	test("the public writer falls back once for every guarded non-JSON class without changing resources", async () => {
		const variants = ["cycle", "depth65", "undefined", "function", "bigint", "date", "nan", "infinity"]
		for (const variant of variants) {
			const root = createRoot("healthy")
			try {
				const before = readState(root)
				const observed = await runCli(root, ["status", "--json"], { fault: `egress-non-json:${variant}` })
				const lines = observed.stdout.split("\n").filter(Boolean)
				expect(observed.exit, variant).toBe(1)
				expect(observed.stderr, variant).toBe("")
				expect(lines, variant).toHaveLength(1)
				const parsed = JSON.parse(lines[0] ?? "") as { result: { causeCode: string; data: unknown } }
				expect(parseMachineEnvelope(parsed).ok, variant).toBe(true)
				expect(parsed.result.causeCode, variant).toBe("INTERNAL_RESULT_UNCHANGED")
				expect(parsed.result.data, variant).toBeNull()
				expect(readState(root), variant).toEqual(before)
			} finally { removeRoot(root) }
		}
	})
	test("the public writer falls back once for every strict-schema corruption and retains the unknown-command cause", async () => {
		for (const variant of ["non-string-message", "extra-key", "bad-enum", "both-guidance"]) {
			const root = createRoot("healthy")
			try {
				const observed = await runCli(root, ["status", "--json"], { fault: `egress-schema-invalid:${variant}` })
				expect(observed.exit, variant).toBe(1)
				expect(observed.stderr, variant).toBe("")
				expect(observed.stdout.split("\n").filter(Boolean), variant).toHaveLength(1)
				expect(parseMachineEnvelope(JSON.parse(observed.stdout)).ok, variant).toBe(true)
			} finally { removeRoot(root) }
		}
		const root = createRoot("healthy")
		try {
			const observed = await runCli(root, ["not-a-command", "--json"])
			const parsed = JSON.parse(observed.stdout) as { result: { causeCode: string } }
			expect(observed.exit).toBe(2)
				expect(parsed.result.causeCode).toBe("USAGE_UNKNOWN_COMMAND")
		} finally { removeRoot(root) }
	})
	test("a real child process emits the accepted partial fallback with trusted completed and remaining effects", async () => {
		const cli = resolve(import.meta.dir, "../../src/cli.ts")
		const script = `import { emitMachine } from ${JSON.stringify(cli)}; const candidate = {}; candidate.self = candidate; const facts = { commandIdentity: "repair-lab.apply", runIdentity: "run-partial-process", domainOutcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", completedEffectIds: ["effect.update-index"], remainingEffectIds: ["effect.write-journal"], stationLabel: "partial", guidance: { kind: "handoff", station: "repair-lab.required-handoff" } }; process.exitCode = emitMachine(candidate, facts, { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) });`
		const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
		expect(exit).toBe(1)
		expect(stderr).toBe("")
		const parsed = JSON.parse(stdout) as { result: Record<string, unknown> }
		expect(parseMachineEnvelope(parsed).ok).toBe(true)
		expect(parsed.result).toMatchObject({ outcome: "failed", transactionState: "partially-completed", causeCode: "INTERNAL_RESULT_PARTIAL", effects: { completed: ["effect.update-index"], remaining: ["effect.write-journal"], uncertain: [], inventoryComplete: true } })
	})
})
