import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXPECTED_COMMAND_IDENTITIES } from "../helpers/command-identity-oracle.ts"
import {
	APPLY_EVENT_PAYLOAD,
	blockDiagnostics,
	createRoot,
	decodeFrame,
	diagnosticsFiles,
	diagnosticsRecords,
	envelopeOf,
	fillJournal,
	frameLine,
	journalRecords,
	largePayload,
	linkOutside,
	linkStateFile,
	modeOf,
	normalize,
	PARTIAL_APPLY_FRAMES,
	readOnlyJournal,
	readState,
	removeRoot,
	RESET_RESOURCE,
	RESET_RESOURCE_SHA256,
	REVISION_5_RESOURCE,
	REVISION_5_RESOURCE_SHA256,
	type Root,
	type Run,
	runCli,
	SECRET_MARKER,
	sentinelUntouched,
	sha256,
	TORN_APPLY_EVENT_FRAGMENT,
	type Variant,
	writeReceipt,
} from "../helpers/harness.ts"

// Independent oracle (brief 12, 7.3, 8.1, 8.2): every expected value below is restated from the immutable
// repair-lab fixture, Contract Core 1.0.0 and PE revision 3; nothing is read from the modules under test.

const HELP = "repair-lab --help"
const DISCOVER = "repair-lab --discover --json"
const INSPECT = "repair-lab inspect"
const RECOVER = "repair-lab recover"
const U = "effect.update-index"
const J = "effect.write-journal"
const R = "effect.repair-cache"
const AUTHORIZED_APPLY = ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority"]
const STALE_APPLY = ["apply", "--preview-id", "preview-stale-revision-4", "--authorize", "fixture-authority"]
const PARTIAL_APPLY = ["apply", "--preview-id", "preview-partial-revision-4", "--authorize", "fixture-authority"]
const AUTHORIZED_REPAIR = ["repair", "--apply", "--preview-id", "repair-preview-missing-index", "--authorize", "fixture-authority"]
const RETRY_REPAIR = ["repair", "--apply", "--retry-once", "--authorize", "fixture-authority"]
const W2_FALLBACK_TUPLE = "failed|INTERNAL_RESULT_UNKNOWN"
const EXPECTED_DISCOVERY = {
	contractVersion: "2.0.0",
	generationConventionVersion: "2.0.0",
	profile: "complex",
	identities: EXPECTED_COMMAND_IDENTITIES,
	exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
	signalExits: { "130": "SIGINT", "143": "SIGTERM" },
	effectExclusions: ["diagnostic file and journal maintenance"],
}
const NON_JSON = ["cycle", "date", "undefined", "function", "bigint", "nan"]
const SCHEMA_INVALID = ["non-string-message", "extra-key", "bad-enum", "both-guidance"]

interface Expected {
	identity: string
	outcome: "success" | "refused" | "failed" | "unknown"
	failureClass: string | null
	causeCode: string | null
	exit: number
	effectClass: "inspect" | "repository-local"
	transactionState: "unchanged" | "completed" | "partially-completed" | "unknown"
	retryable: boolean
	delay: number | null
	nextAction: string | null
	handoff?: string[]
}

const C0_LEGACY_BINDINGS: Readonly<Record<string, Partial<Expected>>> = {
	USAGE_UNKNOWN_COMMAND: { causeCode: "USAGE_UNKNOWN_COMMAND", failureClass: "usage", exit: 2 },
	USAGE_UNKNOWN_OPTION: { causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exit: 2 },
	USAGE_INVALID_ARGUMENTS: { causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exit: 2 },
	USAGE_COMMAND_REQUIRED: { causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exit: 2 },
	SCHEMA_STATE_INVALID: { causeCode: "SCHEMA_INVALID_INPUT", failureClass: "schema", exit: 4 },
	UNAVAILABLE_STORAGE_BUSY: { causeCode: "TRANSIENT_NOT_STARTED", failureClass: "transient", exit: 75 },
	DOMAIN_AUTHORITY_MISSING: { causeCode: "DOMAIN_AUTHORITY_REQUIRED", failureClass: "domain", exit: 3 },
	DOMAIN_INPUT_MISSING: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_INPUT_MALFORMED: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_INPUT_UNREADABLE: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_PATH_ESCAPE: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_PREVIEW_STALE: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_PREVIEW_CONSUMED: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_PREVIEW_MISSING: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_REPAIR_REQUIRED: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_REPAIR_NOT_REQUIRED: { causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exit: 3 },
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: { outcome: "failed", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", failureClass: "domain", exit: 3 },
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: { outcome: "failed", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", failureClass: "internal", exit: 1 },
	INTERNAL_EFFECT_NOT_OBSERVED: { outcome: "failed", causeCode: "INTERNAL_EFFECT_NOT_OBSERVED", failureClass: "internal", exit: 1 },
	INTERNAL_RESULT_UNKNOWN: { outcome: "failed", causeCode: "INTERNAL_RESULT_UNKNOWN", failureClass: "internal", exit: 1 },
	INTERNAL_UNEXPECTED: { outcome: "failed", causeCode: "INTERNAL_UNEXPECTED", failureClass: "internal", exit: 1 },
	INTERNAL_RESULT_UNCHANGED: { outcome: "failed", causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", exit: 1 },
	INTERNAL_RESULT_COMPLETED: { outcome: "failed", causeCode: "INTERNAL_RESULT_COMPLETED", failureClass: "internal", exit: 1 },
	INTERNAL_PREPARATION: { outcome: "refused", causeCode: "INTERNAL_PREPARATION", failureClass: "internal", exit: 1 },
	// O1 Candidate A (ticket freeze 2026-09-15): the three accepted domain causes of this candidate, on their exact rows.
	DOMAIN_JOURNAL_LIMIT_REACHED: { outcome: "refused", causeCode: "DOMAIN_JOURNAL_LIMIT_REACHED", failureClass: "domain", exit: 3 },
	DOMAIN_PRIOR_RUN_PENDING: { outcome: "refused", causeCode: "DOMAIN_PRIOR_RUN_PENDING", failureClass: "domain", exit: 3 },
	DOMAIN_RECOVERY_PARTIAL_HANDOFF: { outcome: "failed", causeCode: "DOMAIN_RECOVERY_PARTIAL_HANDOFF", failureClass: "domain", exit: 3 },
}
const c0Success = (expected: Expected): Expected => ({ ...expected, causeCode: expected.transactionState === "completed" ? "SUCCESS_COMPLETED" : "SUCCESS_UNCHANGED", failureClass: null, exit: 0, retryable: false })
const c0Expected = (expected: Expected): Expected => expected.outcome === "success" ? c0Success(expected) : { ...expected, ...(expected.causeCode === null ? {} : C0_LEGACY_BINDINGS[expected.causeCode]) }

const roots: Root[] = []
function fresh(variant: Variant): Root {
	const created = createRoot(variant)
	roots.push(created)
	return created
}
afterEach(() => {
	for (const created of roots.splice(0)) removeRoot(created)
})

function retainRecoveryEvidence(name: string, evidence: unknown): void {
	const directory = process.env.REPAIR_LAB_TEST_RECEIPTS
	if (directory === undefined) return
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
}

// One process receipt: both streams, exit, signal, and the raw state bytes plus diagnostics files after the run.
function receiptOf(root: Root, run: Run): Record<string, unknown> {
	const diagnostics = Object.fromEntries(diagnosticsFiles(root).map((file) => [file, readFileSync(join(root.root, "diagnostics", file), "utf8")]))
	return { stdout: run.stdout, stderr: run.stderr, exit: run.exit, signal: run.signal, state: readState(root), diagnostics }
}

interface Machine {
	run: Run
	message: string
	envelope: Record<string, unknown>
	result: Record<string, unknown> | null
	diagnostics: Record<string, unknown> | undefined
}

async function machine(root: Root, argv: string[], fault?: string, env?: Record<string, string>): Promise<Machine> {
	const args = argv.includes("--json") ? argv : [...argv, "--json"]
	const run = await runCli(root, args, { ...(fault === undefined ? {} : { fault }), ...(env === undefined ? {} : { env }) })
	expect(run.stderr).toBe("")
	expect(run.stdout.split("\n").filter((line) => line.length > 0)).toHaveLength(1)
	const outer = envelopeOf(run)
	expect(Object.keys(outer).sort()).toEqual("diagnostics" in outer ? ["availablePaths", "contractVersion", "diagnostics", "envelopeVersion", "message", "result"] : ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"])
	expect(outer.envelopeVersion).toBe(2)
	expect(outer.contractVersion).toBe("2.0.0")
	if ("diagnostics" in outer) expect((outer.diagnostics as Record<string, unknown>).status).toBeOneOf(["available", "unavailable"])
	const envelope = outer.result as Record<string, unknown>
	expect(envelope.runId).toMatch(/^run-[0-9a-f-]{36}$/)
	return { run, message: outer.message as string, envelope, result: envelope.data as Record<string, unknown> | null, diagnostics: outer.diagnostics as Record<string, unknown> | undefined }
}

function check(observed: Machine, expected: Expected): void {
	const { envelope, run } = observed
	const selected = c0Expected(expected)
	const handoffCause = ["DOMAIN_AUTHORITY_REQUIRED", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "DOMAIN_RECOVERY_PARTIAL_HANDOFF", "DOMAIN_PRIOR_RUN_PENDING", "DOMAIN_JOURNAL_LOCK_HELD", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "INTERNAL_EFFECT_NOT_OBSERVED", "INTERNAL_UNEXPECTED", "INTERNAL_RESULT_UNCHANGED", "INTERNAL_RESULT_COMPLETED", "INTERNAL_RESULT_PARTIAL", "INTERNAL_RESULT_UNKNOWN"].includes(selected.causeCode ?? "")
	expect(run.exit).toBe(selected.exit)
	expect(envelope.commandIdentity).toBe(expected.identity)
	expect(envelope.outcome).toBe(selected.outcome)
	expect(envelope.failureClass).toBe(selected.failureClass)
	expect(envelope.causeCode).toBe(selected.causeCode)
	expect(envelope.effectClass).toBe(expected.effectClass)
	expect(envelope.transactionState).toBe(expected.transactionState)
	expect(envelope.retryable).toBe(selected.retryable)
	if (selected.delay === null) expect(envelope.retryDelayMilliseconds).toBeUndefined()
	else expect(envelope.retryDelayMilliseconds).toBe(selected.delay)
	expect(typeof observed.message).toBe("string")
	expect(observed.message.length).toBeGreaterThan(0)
	expect(envelope.data === null).toBe(selected.outcome !== "success")
	if (handoffCause) {
		expect(envelope.handoff).toMatchObject({ owner: "operator", inspect: [INSPECT] })
		expect(envelope.nextAction).toBeUndefined()
	} else {
		expect(envelope.handoff).toBeUndefined()
		expect(envelope.nextAction).toBe(selected.nextAction)
	}
}

function domain(identity: string, causeCode: string, effectClass: Expected["effectClass"], nextAction: string = INSPECT): Expected {
	return { identity, outcome: "refused", failureClass: "domain", causeCode, exit: 3, effectClass, transactionState: "unchanged", retryable: false, delay: null, nextAction }
}

function usage(identity: string, causeCode: string, effectClass: Expected["effectClass"]): Expected {
	return { identity, outcome: "refused", failureClass: "usage", causeCode, exit: 2, effectClass, transactionState: "unchanged", retryable: false, delay: null, nextAction: HELP }
}

function fallback(identity: string, outcome: Expected["outcome"], causeCode: string, effectClass: Expected["effectClass"], transactionState: Expected["transactionState"], nextAction: string | null, handoff?: string[]): Expected {
	return { identity, outcome, failureClass: "internal", causeCode, exit: 1, effectClass, transactionState, retryable: false, delay: null, nextAction, ...(handoff === undefined ? {} : { handoff }) }
}

function tupleOf(observed: Machine): string {
	return `${String(observed.envelope.outcome)}|${String(observed.envelope.causeCode)}`
}

// Root-relative comparison (brief 12, 8.2): the run token and the fixture root are the only normalized values.
function comparable(observed: Machine, root: Root): Record<string, unknown> {
	const outer = envelopeOf(observed.run)
	delete outer.diagnostics
	return JSON.parse(JSON.stringify(normalize(JSON.stringify(outer), observed.envelope.runId as string)).split(root.root).join("<root>")) as Record<string, unknown>
}

function projection(observed: Machine): Record<string, unknown> {
	const result = { ...(observed.result ?? {}) }
	delete result.diagnostics
	return result
}

async function human(root: Root, argv: string[], fault?: string): Promise<Run> {
	return runCli(root, argv, fault === undefined ? {} : { fault })
}

function lines(text: string): string[] {
	return text.split("\n").filter((line) => line.length > 0)
}

// Literal state after one fixture run (O1 U0 and O1 Candidate A). Journal revision 2 literals: each line is a test-encoded
// frame of the literal record; the digests are computed by the test from the fixture's literal resource bytes and the
// literal event payload, never by the production writer.
const REVISION_5_HEALTHY = REVISION_5_RESOURCE
const PARTIAL_REASON = "handoff required: a known subset of effects completed and the remaining effects are known not applied; no safe automatic action is available"
const PRIOR_RUN_REASON = "a prior run's consumed plan has unresolved effects; recover before previewing or applying again"
type Kind = "apply" | "repair"
const previewIdOf = (kind: Kind): string => (kind === "apply" ? "preview-healthy-revision-4" : "repair-preview-missing-index")
const planOf = (kind: Kind): [string, string] => (kind === "apply" ? [U, J] : [R, J])
const consumedPreview = (kind: Kind, runId: string): string => `{"preview_id":"${previewIdOf(kind)}","kind":"${kind}","resource_revision":4,"expected_effect_ids":["${planOf(kind)[0]}","effect.write-journal"],"consumed":true,"consumed_by_run":"${runId}"}\n`
const beforeOf = (kind: Kind): string => (kind === "apply" ? RESET_RESOURCE_SHA256 : sha256('{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'))
const eventPayload = (kind: Kind, seq: number, runId: string): string => `{"kind":"event","seq":${seq},"run":"${runId}","effect":"effect.write-journal","operation":"${kind}","preview_id":"${previewIdOf(kind)}","summary":"${kind} recorded"}`
const intentLine = (kind: Kind, seq: number, runId: string, effect: string): string => frameLine(effect === J ? `{"kind":"intent","seq":${seq},"run":"${runId}","effect":"${effect}","operation":"${kind}","preview_id":"${previewIdOf(kind)}","before_sha256":null,"expected_after_sha256":"${sha256(eventPayload(kind, seq + 1, runId))}"}` : `{"kind":"intent","seq":${seq},"run":"${runId}","effect":"${effect}","operation":"${kind}","preview_id":"${previewIdOf(kind)}","before_sha256":"${beforeOf(kind)}","expected_after_sha256":"${REVISION_5_RESOURCE_SHA256}"}`)
const completedLine = (kind: Kind, seq: number, runId: string, effect: string): string => frameLine(`{"kind":"completed","seq":${seq},"run":"${runId}","effect":"${effect}","operation":"${kind}","preview_id":"${previewIdOf(kind)}","resource_revision":5,"observed_after_sha256":"${effect === J ? sha256(eventPayload(kind, seq - 1, runId)) : REVISION_5_RESOURCE_SHA256}"}`)
const eventLine = (kind: Kind, seq: number, runId: string): string => frameLine(eventPayload(kind, seq, runId))
const completedJournal = (kind: Kind, runId: string): string => {
	const [first] = planOf(kind)
	return `${intentLine(kind, 1, runId, first)}${completedLine(kind, 2, runId, first)}${intentLine(kind, 3, runId, J)}${eventLine(kind, 4, runId)}${completedLine(kind, 5, runId, J)}`
}
const recoverPartial = (completed: string[], remaining: string[]): { expected: Expected; effects: Record<string, unknown> } => ({ expected: { identity: "repair-lab.recover", outcome: "failed", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_PARTIAL_HANDOFF", exit: 3, effectClass: "repository-local", transactionState: "partially-completed", retryable: false, delay: null, nextAction: null }, effects: { completed, remaining, uncertain: [], inventoryComplete: true } })
const recoverNothingPending: Expected = { identity: "repair-lab.recover", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT }
const recoverUnknown: Expected = { identity: "repair-lab.recover", outcome: "unknown", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", exit: 3, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null }
const priorRunPending = (identity: string): Expected => ({ identity, outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_PRIOR_RUN_PENDING", exit: 3, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: null })
const schemaRefusal = (identity: string, effectClass: Expected["effectClass"]): Expected => ({ identity, outcome: "refused", failureClass: "schema", causeCode: "SCHEMA_STATE_INVALID", exit: 4, effectClass, transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })

describe("egress", () => {
	test("--help prints the usage line and one example on stdout, exit 0", async () => {
		const run = await human(fresh("healthy"), ["--help"])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout.startsWith("repair-lab: ")).toBe(true)
		expect(run.stdout).toContain("usage: repair-lab <command> [options] [--json]")
		expect(run.stdout).toContain("example:\n  repair-lab status --json\n")
	})
	test("--help --json emits exact accepted HelpData", async () => {
		const observed = await machine(fresh("healthy"), ["--help"])
		check(observed, { identity: "repair-lab.help", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
		expect(Object.keys(observed.result ?? {}).sort()).toEqual(["commands", "options", "summary", "usage"])
		expect(observed.result?.usage).toBe("repair-lab <command> [options] [--json]")
		expect(observed.result?.summary).toBe("Inspect, preview, apply and repair a fixture-local resource with journal-backed recovery")
		const commands = observed.result?.commands as Array<Record<string, unknown>>
		expect(commands.map((command) => command.commandIdentity)).toEqual([...EXPECTED_DISCOVERY.identities])
		for (const command of commands) expect(Object.keys(command).sort()).toEqual(["commandIdentity", "effectClass", "route", "summary"])
		const options = observed.result?.options as Array<Record<string, unknown>>
		expect(options.length).toBeGreaterThan(0)
		for (const option of options) expect(Object.keys(option).sort()).toEqual(["name", "summary", "valueName"])
	})
	test("--discover --json emits exact accepted DiscoveryData", async () => {
		const observed = await machine(fresh("healthy"), ["--discover"])
		check(observed, { identity: "repair-lab.discovery", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
		const document = observed.result as { contractVersion: string; generationConventionVersion: string; profile: string; commands: Array<{ commandIdentity: string; route: string[]; effectClass: string; summary: string }>; exitMeanings: Record<string, string>; signalExits: Record<string, string>; effectExclusions: string[] }
		expect(Object.keys(document).sort()).toEqual(["commands", "contractVersion", "effectExclusions", "exitMeanings", "generationConventionVersion", "profile", "signalExits"])
		expect(document.contractVersion).toBe(EXPECTED_DISCOVERY.contractVersion)
		expect(document.generationConventionVersion).toBe(EXPECTED_DISCOVERY.generationConventionVersion)
		expect(document.profile).toBe(EXPECTED_DISCOVERY.profile)
		expect(document.commands.map((command) => command.commandIdentity)).toEqual([...EXPECTED_DISCOVERY.identities])
		for (const command of document.commands) expect(Object.keys(command).sort()).toEqual(["commandIdentity", "effectClass", "route", "summary"])
		expect(document.exitMeanings).toEqual(EXPECTED_DISCOVERY.exitMeanings)
		expect(document.signalExits).toEqual(EXPECTED_DISCOVERY.signalExits)
		expect(document.effectExclusions).toEqual(EXPECTED_DISCOVERY.effectExclusions)
	})
	test("--discover without --json prints the same facts as text", async () => {
		const run = await human(fresh("healthy"), ["--discover"])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout).toContain("profile: complex\n")
		expect(run.stdout).toContain("exit 75: transient\n")
		expect(run.stdout).toContain("signal 130: SIGINT\n")
		expect(run.stdout).toContain("effect exclusion: diagnostic file and journal maintenance\n")
		expect(lines(run.stdout).filter((line) => line.startsWith("command: "))).toHaveLength(12)
	})
	test("no arguments: exit 2, empty stdout, one stderr line naming --help", async () => {
		const run = await human(fresh("healthy"), [])
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toHaveLength(1)
		expect(run.stderr).toContain("--help")
	})
	test("--json alone is a dispatch refusal", async () => {
		const observed = await machine(fresh("healthy"), ["--json"])
		check(observed, usage("repair-lab.dispatch", "USAGE_COMMAND_REQUIRED", "inspect"))
		expect(observed.result).toBeNull()
		expect(observed.envelope.repairAction).not.toBeNull()
	})
	test("an unknown command is refused with the help identity", async () => {
		check(await machine(fresh("healthy"), ["frobnicate"]), usage("repair-lab.help", "USAGE_UNKNOWN_COMMAND", "inspect"))
		const run = await human(fresh("healthy"), ["frobnicate"])
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toHaveLength(1)
	})
	test("an unknown option keeps the routed identity derived from raw argv", async () => {
		const routed: Array<[string[], string, Expected["effectClass"]]> = [
			[["status"], "repair-lab.status", "inspect"],
			[["--discover"], "repair-lab.discovery", "inspect"],
			[["apply", "--preview"], "repair-lab.preview", "repository-local"],
			[["recover"], "repair-lab.recover", "repository-local"],
			[["inspect"], "repair-lab.inspect", "inspect"],
			[["inspect", "--include-diagnostics"], "repair-lab.inspect-diagnostics", "inspect"],
			[["apply"], "repair-lab.apply", "repository-local"],
			[["repair"], "repair-lab.repair", "repository-local"],
			[["repair", "--apply", "--retry-once"], "repair-lab.repair-retry", "repository-local"],
			[[], "repair-lab.dispatch", "inspect"],
		]
		for (const [argv, identity, effectClass] of routed) {
			const observed = await machine(fresh("healthy"), [...argv, "--no-such-option"])
			check(observed, usage(identity, "USAGE_UNKNOWN_OPTION", effectClass))
			expect(observed.result).toBeNull()
		}
	})
	test("an unsupported fault value and a bad REPAIR_LAB_ROOT are USAGE_INVALID_ARGUMENTS on the routed identity", async () => {
		check(await machine(fresh("healthy"), ["status"], "nope"), usage("repair-lab.status", "USAGE_INVALID_ARGUMENTS", "inspect"))
		check(await machine(fresh("healthy"), ["status"], "throw-internal+silent-no-op"), usage("repair-lab.status", "USAGE_INVALID_ARGUMENTS", "inspect"))
		check(await machine(fresh("healthy"), ["recover"], undefined, { REPAIR_LAB_ROOT: "relative/path" }), usage("repair-lab.recover", "USAGE_INVALID_ARGUMENTS", "repository-local"))
		const run = await human(fresh("healthy"), ["status"], "nope")
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
	})
	async function expectNoEffect(root: Root, before: ReturnType<typeof readState>): Promise<void> {
		expect(diagnosticsFiles(root)).toEqual([])
		expect(readState(root)).toEqual(before)
	}
	test("flag-only help and discovery reject extra known options and positionals before success dispatch", async () => {
		const rows: Array<[string[], string]> = [
			[["--help", "--apply"], "repair-lab.help"],
			[["--help", "extra"], "repair-lab.help"],
			[["--discover", "--state", "state/resource.json"], "repair-lab.discovery"],
			[["--discover", "extra"], "repair-lab.discovery"],
		]
		for (const [argv, identity] of rows) {
			const root = fresh("healthy")
			const before = readState(root)
			const observed = await machine(root, argv)
			check(observed, usage(identity, "USAGE_INVALID_ARGUMENTS", "inspect"))
			expect(observed.result).toBeNull()
			await expectNoEffect(root, before)
		}
	})
	test("known options with missing or option-like values are invalid arguments, not unknown options", async () => {
		const rows: Array<[string[], string, Expected["effectClass"]]> = [
			[["inspect", "--state"], "repair-lab.inspect", "inspect"],
			[["inspect", "--include-diagnostics", "--state"], "repair-lab.inspect-diagnostics", "inspect"],
			[["apply", "--preview-id"], "repair-lab.apply", "repository-local"],
			[["repair", "--apply", "--authorize"], "repair-lab.repair", "repository-local"],
			[["repair", "--apply", "--retry-once", "--authorize"], "repair-lab.repair-retry", "repository-local"],
			[["status", "--json=1"], "repair-lab.status", "inspect"],
		]
		for (const [argv, identity, effectClass] of rows) {
			const root = fresh("healthy")
			const before = readState(root)
			const observed = await machine(root, argv)
			check(observed, usage(identity, "USAGE_INVALID_ARGUMENTS", effectClass))
			expect(observed.message).toContain("malformed option value")
			await expectNoEffect(root, before)
		}
	})
	test("route grammar refuses extra positionals and options outside the declared route before effects", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"]]> = [
			["healthy", ["status", "extra"], "repair-lab.status", "inspect"],
			["healthy", ["status", "--apply"], "repair-lab.status", "inspect"],
			["healthy", ["inspect", "--preview"], "repair-lab.inspect", "inspect"],
			["healthy", ["apply", "--preview", "extra"], "repair-lab.preview", "repository-local"],
			["healthy", ["apply", "--preview", "--automation"], "repair-lab.preview", "repository-local"],
			["healthy-with-fresh-preview", [...AUTHORIZED_APPLY, "--state", "state/resource.json"], "repair-lab.apply", "repository-local"],
			["derived-index-missing", ["repair"], "repair-lab.repair", "repository-local"],
			["derived-index-missing", ["repair", "--preview", "--apply"], "repair-lab.repair", "repository-local"],
			["derived-index-missing-with-fresh-preview", [...RETRY_REPAIR, "--preview-id", "repair-preview-missing-index"], "repair-lab.repair-retry", "repository-local"],
			["unknown-after-partial", ["recover", "extra"], "repair-lab.recover", "repository-local"],
		]
		for (const [variant, argv, identity, effectClass] of rows) {
			const root = fresh(variant)
			const before = readState(root)
			check(await machine(root, argv), usage(identity, "USAGE_INVALID_ARGUMENTS", effectClass))
			await expectNoEffect(root, before)
		}
	})
	test("REPAIR_LAB_ROOT selects the fixture root when the process runs elsewhere", async () => {
		const root = fresh("healthy")
		const run = await runCli(root, ["status", "--json"], { cwd: root.privateRoot, env: { REPAIR_LAB_ROOT: root.root } })
		expect(run.exit).toBe(0)
		expect(((envelopeOf(run).result as { data: { result: string } }).data).result).toBe("healthy")
	})
	test("row 1 healthy: status in both modes", async () => {
		const run = await human(fresh("healthy"), ["status"])
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["resource: demo", "revision: 4", "status: healthy"])
		expect(run.stderr).toBe("")
		const observed = await machine(fresh("healthy"), ["status"])
		check(observed, { identity: "repair-lab.status", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT })
		expect(projection(observed)).toEqual({ result: "healthy", station_id: "repair-lab.healthy", effect_ids: [], resource: { resource: "demo", revision: 4, status: "healthy", version: 1 } })
	})
	test("row 2 inspect: status lines, next action preview", async () => {
		const run = await human(fresh("healthy"), ["inspect"])
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["inspection: ready", "next: preview"])
		expect(run.stderr).toBe("")
		const observed = await machine(fresh("healthy"), ["inspect"])
		check(observed, { identity: "repair-lab.inspect", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: true, delay: null, nextAction: "repair-lab apply --preview" })
		expect(projection(observed)).toEqual({ result: "inspected", station_id: "repair-lab.inspect", effect_ids: [], resource: { resource: "demo", revision: 4, status: "healthy", version: 1 } })
	})
	test("row 3 preview: writes the preview file only and binds the expected effects", async () => {
		const root = fresh("healthy")
		const run = await human(root, ["apply", "--preview"])
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["preview: ready", "effects: effect.update-index, effect.write-journal", "next: authorize apply"])
		expect(run.stderr).toBe("")
		const state = readState(root)
		expect(JSON.parse(state.preview as string)).toEqual({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: [U, J], consumed: false })
		expect(state.journal).toBe("")
		expect(state.resource).toBe('{"resource":"demo","revision":4,"status":"healthy","version":1}\n')
		const observed = await machine(fresh("healthy"), ["apply", "--preview"])
		check(observed, { identity: "repair-lab.preview", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
		expect(projection(observed)).toEqual({ result: "previewed", station_id: "repair-lab.preview", preview_revision: 4, effect_ids: [U, J], preview_id: "preview-healthy-revision-4" })
	})
	test("row 12 hostile input: the sentinel path is refused before any access", async () => {
		const root = fresh("healthy")
		const run = await human(root, ["inspect", "--state", "../../outside-root-sentinel"])
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["inspect refused: state path must remain inside the fixture root"])
		expect(sentinelUntouched(root)).toBe(true)
		const observed = await machine(root, ["inspect", "--state", "../../outside-root-sentinel"])
		check(observed, domain("repair-lab.inspect", "DOMAIN_PATH_ESCAPE", "inspect"))
		expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		expect(observed.envelope.repairAction).toBe("provide a readable state file inside the fixture root, then inspect")
		expect(sentinelUntouched(root)).toBe(true)
	})
	test("containment: a sibling-prefix path and a pre-existing directory symlink are both refused", async () => {
		const root = fresh("healthy")
		writeFileSync(join(root.privateRoot, "fixtures", "repair-lab", "sibling-marker"), "")
		const sibling = await machine(root, ["inspect", "--state", "../run-other/resource.json"])
		check(sibling, domain("repair-lab.inspect", "DOMAIN_PATH_ESCAPE", "inspect"))
		linkOutside(root, "link")
		const linked = await machine(root, ["inspect", "--state", "state/link/resource.json"])
		check(linked, domain("repair-lab.inspect", "DOMAIN_PATH_ESCAPE", "inspect"))
		expect(sentinelUntouched(root)).toBe(true)
	})
	test("row 13 secret marker: redacted in both modes and absent from every surface", async () => {
		const root = fresh("secret-marker-in-diagnostic-field")
		const observed = await machine(root, ["inspect", "--include-diagnostics"])
		check(observed, { identity: "repair-lab.inspect-diagnostics", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT })
		expect(projection(observed)).toEqual({ result: "inspected-redacted", station_id: "repair-lab.secret-marker", marker_absent: true, redaction_placeholder: "[REDACTED]", redacted_fields: ["diagnostic_token"], resource: { resource: "demo", revision: 4, status: "healthy", version: 1, diagnostic_token: "[REDACTED]" } })
		const receipt = writeReceipt(root, "repair-lab.secret-marker", observed.run)
		for (const [name, bytes] of Object.entries(receipt.surfaces)) expect(`${name}: ${bytes.includes(SECRET_MARKER)}`).toBe(`${name}: false`)
		const run = await human(fresh("secret-marker-in-diagnostic-field"), ["inspect", "--include-diagnostics"])
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["inspection: ready", "redaction: applied", "next: inspect"])
		expect(run.stdout.includes(SECRET_MARKER) || run.stderr.includes(SECRET_MARKER)).toBe(false)
	})
	test("inspect input refusals: missing, malformed, unreadable and schema-invalid state", async () => {
		const root = fresh("checker-target")
		check(await machine(root, ["inspect", "--state", "state/missing.json"]), domain("repair-lab.inspect", "DOMAIN_INPUT_MISSING", "inspect"))
		check(await machine(root, ["inspect", "--state", "state/malformed.json"]), domain("repair-lab.inspect", "DOMAIN_INPUT_MALFORMED", "inspect"))
		writeFileSync(join(root.root, "state", "locked.json"), '{"resource":"demo"}\n', { mode: 0o000 })
		check(await machine(root, ["inspect", "--state", "state/locked.json"]), domain("repair-lab.inspect", "DOMAIN_INPUT_UNREADABLE", "inspect"))
		writeFileSync(join(root.root, "state", "shape.json"), '{"resource":"demo","revision":"four","status":"healthy","version":1}\n')
		const invalid = await machine(root, ["inspect", "--state", "state/shape.json"])
		check(invalid, { identity: "repair-lab.inspect", outcome: "refused", failureClass: "schema", causeCode: "SCHEMA_STATE_INVALID", exit: 4, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
		const missingHuman = await human(root, ["inspect", "--state", "state/missing.json"])
		expect(missingHuman.exit).toBe(3)
		expect(missingHuman.stdout).toBe("")
		expect(lines(missingHuman.stderr)).toHaveLength(1)
	})
	test("drain: a 2 MiB result reaches the pipe reader completely with process.exitCode", async () => {
		const root = fresh("checker-target")
		const run = await runCli(root, ["inspect", "--state", "state/large.json", "--json"])
		expect(run.stderr).toBe("")
		expect(run.exit).toBe(0)
		expect(run.stdout.endsWith("\n")).toBe(true)
		expect(Buffer.byteLength(run.stdout)).toBeGreaterThanOrEqual(1_048_576)
		const envelope = envelopeOf(run)
		const resource = ((envelope.result as { data: { resource: Record<string, unknown> } }).data).resource
		expect(resource.payload).toBe(largePayload())
		resource.payload = "<payload>"
		const result = envelope.result as { outcome: string; causeCode: string; effectClass: string; transactionState: string; retryable: boolean; data: Record<string, unknown>; effects: Record<string, unknown>; nextAction: string }
		expect(result).toMatchObject({ outcome: "success", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged", retryable: false, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab apply --preview" })
	})
	test("every egress fault on status --json yields one valid status|failed|INTERNAL_RESULT_UNCHANGED envelope", async () => {
		const faults = [...NON_JSON.map((variant) => `egress-non-json:${variant}`), ...SCHEMA_INVALID.map((variant) => `egress-schema-invalid:${variant}`)]
		for (const fault of faults) {
			const observed = await machine(fresh("healthy"), ["status"], fault)
			check(observed, fallback("repair-lab.status", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		}
		// F10: a success candidate carrying both guidance fields is malformed too (never both, on every outcome).
		check(await machine(fresh("healthy"), ["apply", "--automation"], "egress-schema-invalid:both-guidance"), fallback("repair-lab.apply", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
	})
	test("a real internal failure with no fault set takes the same fallback path (W1 then egress)", async () => {
		const observed = await machine(fresh("healthy"), ["status"], "throw-internal+egress-non-json:cycle")
		check(observed, fallback("repair-lab.status", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		expect(observed.envelope.data).toBeNull()
		const plain = await machine(fresh("healthy"), ["status"], "throw-internal")
		check(plain, { identity: "repair-lab.status", outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED", exit: 1, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
	})
	test("egress fallback rows of the read-only routes carry unchanged and inspect guidance", async () => {
		const cycle = "egress-non-json:cycle"
		check(await machine(fresh("healthy"), ["--help"], cycle), fallback("repair-lab.help", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["--json"], cycle), fallback("repair-lab.dispatch", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["--discover"], cycle), fallback("repair-lab.discovery", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect"], cycle), fallback("repair-lab.inspect", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("checker-target"), ["inspect", "--state", "state/large.json"], cycle), fallback("repair-lab.inspect", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect", "--state", "../../outside-root-sentinel"], cycle), fallback("repair-lab.inspect", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect", "--state", "state/missing.json"], cycle), fallback("repair-lab.inspect", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["apply", "--preview"], cycle), fallback("repair-lab.preview", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", INSPECT))
	})
	test("routed unknown-option refusals: fault-free first, then the same argv with the egress fault", async () => {
		const rows: Array<[string[], string, Expected["effectClass"]]> = [
			[["status"], "repair-lab.status", "inspect"],
			[["--discover"], "repair-lab.discovery", "inspect"],
			[["apply", "--preview"], "repair-lab.preview", "repository-local"],
			[["recover"], "repair-lab.recover", "repository-local"],
		]
		for (const [argv, identity, effectClass] of rows) {
			check(await machine(fresh("healthy"), [...argv, "--no-such-option"]), usage(identity, "USAGE_UNKNOWN_OPTION", effectClass))
			check(await machine(fresh("healthy"), [...argv, "--no-such-option"], "egress-non-json:cycle"), fallback(identity, "refused", "INTERNAL_PREPARATION", effectClass, "unchanged", INSPECT))
		}
	})
})

describe("recovery", () => {
	async function expectUnchanged(root: Root, before: ReturnType<typeof readState>): Promise<void> {
		expect(readState(root)).toEqual(before)
	}
	test("row 4 authorized apply: intent, effect, read-back, completed for each effect; preview consumed", async () => {
		const root = fresh("healthy-with-fresh-preview")
		const run = await human(root, AUTHORIZED_APPLY)
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["apply: completed", "effects: effect.update-index, effect.write-journal", "next: inspect"])
		expect(run.stderr).toBe("")
		const state = readState(root)
		expect(JSON.parse(state.resource)).toEqual({ resource: "demo", revision: 5, status: "healthy", version: 1 })
		const preview = JSON.parse(state.preview as string) as Record<string, unknown>
		expect(preview.consumed).toBe(true)
		expect(typeof preview.consumed_by_run).toBe("string")
		const records = journalRecords(root)
		expect(records.map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`, `completed:${U}`, `intent:${J}`, `event:${J}`, `completed:${J}`])
		expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5])
		expect(records[1]?.resource_revision).toBe(5)
		const observed = await machine(fresh("healthy-with-fresh-preview"), AUTHORIZED_APPLY)
		check(observed, { identity: "repair-lab.apply", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "completed", retryable: false, delay: null, nextAction: INSPECT })
		expect(projection(observed)).toEqual({ result: "applied", station_id: "repair-lab.authorized-apply", transaction_state: "completed", completed_effect_ids: [U, J], remaining_effect_ids: [] })
	})
	test("B2: an identical authorized argv after completion is refused as consumed with byte-identical state", async () => {
		const rows: Array<[Variant, string[], string, string | undefined]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", undefined],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", undefined],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", "one-transient-lock"],
		]
		for (const [variant, argv, identity, fault] of rows) {
			const root = fresh(variant)
			const first = await machine(root, argv, fault)
			expect(first.envelope.outcome).toBe("success")
			const after = readState(root)
			const repeat = await machine(root, argv, fault)
			check(repeat, domain(identity, "DOMAIN_PREVIEW_CONSUMED", "repository-local"))
			await expectUnchanged(root, after)
		}
	})
	test("row 5 stale preview: refused before any effect, preview not consumed", async () => {
		const root = fresh("revision-5-with-revision-4-preview")
		const before = readState(root)
		const run = await human(root, STALE_APPLY)
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["apply refused: preview is stale; inspect current state and preview again"])
		await expectUnchanged(root, before)
		const observed = await machine(root, STALE_APPLY)
		check(observed, domain("repair-lab.apply", "DOMAIN_PREVIEW_STALE", "repository-local"))
		expect(observed.envelope.effects).toEqual({ completed: [], remaining: [U, J], uncertain: [], inventoryComplete: true })
		expect(observed.envelope.repairAction).toBe("inspect current state and preview again")
		await expectUnchanged(root, before)
		check(await machine(fresh("repair-stale"), AUTHORIZED_REPAIR), domain("repair-lab.repair", "DOMAIN_PREVIEW_STALE", "repository-local"))
		check(await machine(fresh("repair-stale"), RETRY_REPAIR), domain("repair-lab.repair-retry", "DOMAIN_PREVIEW_STALE", "repository-local"))
	})
	test("row 6 partial unknown: first effect completed, second unresolved, retry unsafe, handoff guidance", async () => {
		const root = fresh("healthy-with-partial-preview")
		const run = await human(root, PARTIAL_APPLY, "effect.write-journal-outcome-unknown")
		expect(run.exit).toBe(1)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["apply outcome unknown: inspect state or request human handoff; do not retry automatically"])
		const records = journalRecords(root)
		expect(records.map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`, `completed:${U}`, `intent:${J}`])
		expect(JSON.parse(readState(root).resource).revision).toBe(5)
		expect((JSON.parse(readState(root).preview as string) as { consumed: boolean }).consumed).toBe(true)
		const observed = await machine(fresh("healthy-with-partial-preview"), PARTIAL_APPLY, "effect.write-journal-outcome-unknown")
		check(observed, { identity: "repair-lab.apply", outcome: "unknown", failureClass: "internal", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", exit: 1, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: RECOVER })
		expect(observed.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: true })
	})
	test("row 7 prohibited automation and the authority step: refused before any preview lookup", async () => {
		const root = fresh("healthy")
		const run = await human(root, ["apply", "--automation"])
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["apply refused: fixture-local authority is required; inspect or hand off"])
		const observed = await machine(root, ["apply", "--automation"])
		check(observed, domain("repair-lab.apply", "DOMAIN_AUTHORITY_MISSING", "repository-local"))
		expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		expect(readState(root).preview).toBeNull()
		const ordinaryWithoutAuthority: Array<[Variant, string[], string]> = [
			["healthy-with-fresh-preview", ["apply"], "repair-lab.apply"],
			["derived-index-missing-with-fresh-preview", ["repair", "--apply"], "repair-lab.repair"],
		]
		for (const [variant, argv, identity] of ordinaryWithoutAuthority) {
			const routeRoot = fresh(variant)
			const before = readState(routeRoot)
			check(await machine(routeRoot, argv), domain(identity, "DOMAIN_AUTHORITY_MISSING", "repository-local"))
			await expectUnchanged(routeRoot, before)
		}
		check(await machine(fresh("healthy-with-fresh-preview"), ["apply", "--preview-id", "preview-healthy-revision-4"]), domain("repair-lab.apply", "DOMAIN_AUTHORITY_MISSING", "repository-local"))
		check(await machine(fresh("healthy-with-fresh-preview"), ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "wrong"]), domain("repair-lab.apply", "DOMAIN_AUTHORITY_MISSING", "repository-local"))
		check(await machine(fresh("derived-index-missing-with-fresh-preview"), ["repair", "--apply", "--retry-once"]), domain("repair-lab.repair-retry", "DOMAIN_AUTHORITY_MISSING", "repository-local"))
	})
	test("ordinary apply and repair require an exact explicit preview id before effects", async () => {
		const rows: Array<[Variant, string[], string, string]> = [
			["healthy-with-fresh-preview", ["apply", "--authorize", "fixture-authority"], "repair-lab.apply", "apply"],
			["healthy-with-fresh-preview", ["apply", "--preview-id", "preview-other", "--authorize", "fixture-authority"], "repair-lab.apply", "apply"],
			["derived-index-missing-with-fresh-preview", ["repair", "--apply", "--authorize", "fixture-authority"], "repair-lab.repair", "repair"],
			["derived-index-missing-with-fresh-preview", ["repair", "--apply", "--preview-id", "repair-preview-other", "--authorize", "fixture-authority"], "repair-lab.repair", "repair"],
		]
		for (const [variant, argv, identity, command] of rows) {
			const root = fresh(variant)
			const before = readState(root)
			const observed = await machine(root, argv)
			check(observed, domain(identity, "DOMAIN_PREVIEW_MISSING", "repository-local"))
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(journalRecords(root)).toEqual([])
			await expectUnchanged(root, before)
		}
	})
	test("preview presence, identity binding, route agreement and expected-effect binding all refuse as DOMAIN_PREVIEW_MISSING", async () => {
		const absent = await machine(fresh("healthy"), AUTHORIZED_APPLY)
		check(absent, domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		const mismatch = await machine(fresh("healthy-with-fresh-preview"), ["apply", "--preview-id", "preview-other", "--authorize", "fixture-authority"])
		check(mismatch, domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		check(await machine(fresh("derived-index-missing-with-apply-preview"), RETRY_REPAIR), domain("repair-lab.repair-retry", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		check(await machine(fresh("healthy-with-repair-preview"), ["apply", "--preview-id", "repair-preview-missing-index", "--authorize", "fixture-authority"]), domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		check(await machine(fresh("derived-index-missing-with-apply-preview"), ["repair", "--apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority"]), domain("repair-lab.repair", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		const rootEffects = fresh("healthy-with-mismatched-effects-preview")
		const before = readState(rootEffects)
		check(await machine(rootEffects, AUTHORIZED_APPLY), domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		await expectUnchanged(rootEffects, before)
		check(await machine(fresh("derived-index-missing-with-mismatched-effects-preview"), AUTHORIZED_REPAIR), domain("repair-lab.repair", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		check(await machine(fresh("healthy-with-consumed-preview"), AUTHORIZED_APPLY), domain("repair-lab.apply", "DOMAIN_PREVIEW_CONSUMED", "repository-local"))
	})
	test("row 8 repairable precondition and the repair-not-required refusal", async () => {
		const root = fresh("derived-index-missing")
		const run = await human(root, ["repair", "--preview"])
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["repair required: derived index is absent; inspect and authorize repair"])
		expect(JSON.parse(readState(root).preview as string)).toEqual({ preview_id: "repair-preview-missing-index", kind: "repair", resource_revision: 4, expected_effect_ids: [R, J], consumed: false })
		const observed = await machine(fresh("derived-index-missing"), ["repair", "--preview"])
		check(observed, domain("repair-lab.repair", "DOMAIN_REPAIR_REQUIRED", "repository-local"))
		expect(observed.envelope.repairAction).toBe("inspect current state and preview again")
		expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		const notRequired = await machine(fresh("healthy"), ["repair", "--preview"])
		check(notRequired, domain("repair-lab.repair", "DOMAIN_REPAIR_NOT_REQUIRED", "repository-local"))
			expect(notRequired.envelope.repairAction).toBe("inspect current state and preview again")
		check(await machine(fresh("healthy-with-repair-preview"), AUTHORIZED_REPAIR), domain("repair-lab.repair", "DOMAIN_REPAIR_NOT_REQUIRED", "repository-local"))
	})
	test("row 9 authorized repair: resource healthy at revision 5, journal lines, preview consumed", async () => {
		const root = fresh("derived-index-missing-with-fresh-preview")
		const run = await human(root, AUTHORIZED_REPAIR)
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["repair: completed", "effects: effect.repair-cache, effect.write-journal", "next: inspect"])
		expect(JSON.parse(readState(root).resource)).toEqual({ resource: "demo", revision: 5, status: "healthy", version: 1 })
		expect(journalRecords(root).map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${R}`, `completed:${R}`, `intent:${J}`, `event:${J}`, `completed:${J}`])
		const observed = await machine(fresh("derived-index-missing-with-fresh-preview"), AUTHORIZED_REPAIR)
		check(observed, { identity: "repair-lab.repair", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "completed", retryable: false, delay: null, nextAction: INSPECT })
		expect(projection(observed)).toEqual({ result: "repair-applied", station_id: "repair-lab.authorized-repair", transaction_state: "completed", completed_effect_ids: [R, J], remaining_effect_ids: [], repair_is_authorized: true })
	})
	test("row 10 permitted transient retry: exactly one bounded retry, outward retryable false", async () => {
		const root = fresh("derived-index-missing-with-fresh-preview")
		const run = await human(root, RETRY_REPAIR, "one-transient-lock")
		expect(run.exit).toBe(0)
		expect(lines(run.stdout)).toEqual(["repair: completed after one bounded retry", "next: inspect"])
		expect(lines(run.stderr)).toEqual(["retry: one permitted transient retry after bounded delay"])
		expect(JSON.parse(readState(root).resource)).toEqual({ resource: "demo", revision: 5, status: "healthy", version: 1 })
		const observed = await machine(fresh("derived-index-missing-with-fresh-preview"), RETRY_REPAIR, "one-transient-lock")
		check(observed, { identity: "repair-lab.repair-retry", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "completed", retryable: false, delay: null, nextAction: INSPECT })
		expect(projection(observed)).toEqual({ result: "retried-once", station_id: "repair-lab.permitted-transient-retry", transaction_state: "completed", retry_count: 1, completed_effect_ids: [R, J], remaining_effect_ids: [], retry_safety: "safe", automatic_retry_limit: 1, retry_delay_milliseconds: 25 })
	})
	test("storage busy: without --retry-once the refusal is retryable with delay 25 and the preview stays unconsumed; persistent lock refuses after one retry", async () => {
		const root = fresh("derived-index-missing-with-fresh-preview")
		const before = readState(root)
		const busy = await machine(root, AUTHORIZED_REPAIR, "one-transient-lock")
		check(busy, { identity: "repair-lab.repair", outcome: "refused", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY", exit: 75, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: 25, nextAction: "retry the same command after 25 ms" })
		await expectUnchanged(root, before)
		const persistent = await machine(root, RETRY_REPAIR, "persistent-lock")
		check(persistent, { identity: "repair-lab.repair-retry", outcome: "refused", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY", exit: 75, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: 25, nextAction: "retry the same command after 25 ms" })
		await expectUnchanged(root, before)
	})
	test("row 11 required handoff: recover reports remaining ids with the fixture's handoff literal and no fabricated action", async () => {
		const root = fresh("unknown-after-partial")
		const before = readState(root)
		const run = await human(root, ["recover"])
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["handoff required: the remaining effect outcome is unknown; no safe automatic action is available"])
		await expectUnchanged(root, before)
		const observed = await machine(root, ["recover"])
		check(observed, { identity: "repair-lab.recover", outcome: "unknown", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", exit: 3, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null, handoff: [J] })
			expect(observed.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: true })
		await expectUnchanged(root, before)
		const nothing = await machine(fresh("healthy"), ["recover"])
		check(nothing, { identity: "repair-lab.recover", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT })
		expect(nothing.result?.result).toBe("nothing-pending")
	})
	// D3 seeding (O1 Candidate A): a consumed preview plus the revision 2 frames a run would leave. Every digest is
	// computed by the test from its own literal bytes; bookkeeping (completed) frames and the event frame are optional so
	// each row states what the journal claims versus what the resource bytes independently show.
	const INDEX_MISSING_RESOURCE = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'
	type Seed = { resource: string; bookkeeping: boolean; event: boolean; claimedRevision?: number; extraFrames?: string[] }
	function seedRecovery(root: Root, kind: "apply" | "repair", seed: Seed): { plan: [string, string]; frames: string[] } {
		const plan: [string, string] = kind === "apply" ? [U, J] : [R, J]
		const previewId = kind === "apply" ? "preview-healthy-revision-4" : "repair-preview-missing-index"
		const before = kind === "apply" ? RESET_RESOURCE_SHA256 : sha256(INDEX_MISSING_RESOURCE)
		const eventPayload = `{"kind":"event","seq":4,"run":"run-fixture","effect":"effect.write-journal","operation":"${kind}","preview_id":"${previewId}","summary":"${kind} recorded"}`
		const claimed = seed.claimedRevision ?? 5
		const frames = [
			frameLine(`{"kind":"intent","seq":1,"run":"run-fixture","effect":"${plan[0]}","operation":"${kind}","preview_id":"${previewId}","before_sha256":"${before}","expected_after_sha256":"${REVISION_5_RESOURCE_SHA256}"}`),
			...(seed.bookkeeping ? [frameLine(`{"kind":"completed","seq":2,"run":"run-fixture","effect":"${plan[0]}","operation":"${kind}","preview_id":"${previewId}","resource_revision":${claimed},"observed_after_sha256":"${REVISION_5_RESOURCE_SHA256}"}`)] : []),
			frameLine(`{"kind":"intent","seq":3,"run":"run-fixture","effect":"effect.write-journal","operation":"${kind}","preview_id":"${previewId}","before_sha256":null,"expected_after_sha256":"${sha256(eventPayload)}"}`),
			...(seed.event ? [frameLine(eventPayload)] : []),
			...(seed.bookkeeping ? [frameLine(`{"kind":"completed","seq":5,"run":"run-fixture","effect":"effect.write-journal","operation":"${kind}","preview_id":"${previewId}","resource_revision":${claimed},"observed_after_sha256":"${sha256(eventPayload)}"}`)] : []),
			...(seed.extraFrames ?? []),
		]
		const state = join(root.root, "state")
		writeFileSync(join(state, "resource.json"), seed.resource)
		writeFileSync(join(state, "preview.json"), `${JSON.stringify({ preview_id: previewId, kind, resource_revision: 4, expected_effect_ids: plan, consumed: true, consumed_by_run: "run-fixture" })}\n`)
		writeFileSync(join(state, "journal.jsonl"), frames.join(""))
		return { plan, frames }
	}
	test("O1 A6 recovery observation: completion is established from resource bytes and the event frame, never from completed bookkeeping frames", async () => {
		for (const kind of ["apply", "repair"] as const) {
			// Both effects independently observed (resource at the expected bytes, event frame present): nothing pending even
			// when a contradictory bookkeeping frame precedes the run's frames.
			const agreeing = fresh("healthy")
			const { plan, frames } = seedRecovery(agreeing, kind, { resource: REVISION_5_RESOURCE, bookkeeping: true, event: true })
			const previewId = kind === "apply" ? "preview-healthy-revision-4" : "repair-preview-missing-index"
			const contradiction = frameLine(`{"kind":"completed","seq":0,"run":"run-fixture","effect":"${plan[0]}","operation":"${kind}","preview_id":"${previewId}","resource_revision":4,"observed_after_sha256":"${RESET_RESOURCE_SHA256}"}`)
			writeFileSync(join(agreeing.root, "state", "journal.jsonl"), `${contradiction}${frames.join("")}`)
			const before = readState(agreeing)
			const observed = await machine(agreeing, ["recover"])
			check(observed, recoverNothingPending)
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(projection(observed)).toEqual({ result: "nothing-pending", station_id: "repair-lab.nothing-pending", transaction_state: "unchanged", observed_resource_revision: 5, consumed_preview_id: previewId, observed_completed_effect_ids: plan, not_applied_effect_ids: [] })
			expect(readState(agreeing)).toEqual(before)
			// Bookkeeping claims both completions but the event frame is absent: the second effect is known not applied.
			const claimedOnly = fresh("healthy")
			seedRecovery(claimedOnly, kind, { resource: REVISION_5_RESOURCE, bookkeeping: true, event: false })
			const partial = await machine(claimedOnly, ["recover"])
			check(partial, recoverPartial([plan[0]], [J]).expected)
			expect(partial.envelope.effects).toEqual({ completed: [plan[0]], remaining: [J], uncertain: [], inventoryComplete: true })
			expect(partial.envelope.handoff).toEqual({ owner: "operator", reason: "handoff required: a known subset of effects completed and the remaining effects are known not applied; no safe automatic action is available", inspect: [INSPECT] })
			expect(partial.envelope.repairAction).toBe("Inspect the known partial effects before separately authorized recovery")
			// Resource at its pre-image with bookkeeping claiming revision 5: the bytes win; nothing was applied.
			const preImage = fresh("healthy")
			seedRecovery(preImage, kind, { resource: kind === "apply" ? RESET_RESOURCE : INDEX_MISSING_RESOURCE, bookkeeping: true, event: false })
			const notApplied = await machine(preImage, ["recover"])
			check(notApplied, recoverNothingPending)
			expect(projection(notApplied)).toEqual({ result: "nothing-pending", station_id: "repair-lab.nothing-pending", transaction_state: "unchanged", observed_resource_revision: 4, consumed_preview_id: previewId, observed_completed_effect_ids: [], not_applied_effect_ids: plan })
			// Resource bytes that match neither digest: the first effect is uncertain; the run cannot be classified.
			const third = fresh("healthy")
			seedRecovery(third, kind, { resource: kind === "apply" ? '{"resource":"demo","revision":6,"status":"healthy","version":1}\n' : '{"resource":"demo","revision":5,"status":"index-missing","version":1}\n', bookkeeping: true, event: false })
			const unknown = await machine(third, ["recover"])
			check(unknown, { ...recoverUnknown, handoff: plan })
			expect(unknown.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: plan, inventoryComplete: true })
			// Two scoped intents for one effect are contradictory evidence: uncertain, never resolved by either digest.
			const duplicated = fresh("healthy")
			const duplicate = frameLine(`{"kind":"intent","seq":9,"run":"run-fixture","effect":"${plan[0]}","operation":"${kind}","preview_id":"${previewId}","before_sha256":"${RESET_RESOURCE_SHA256}","expected_after_sha256":"${REVISION_5_RESOURCE_SHA256}"}`)
			seedRecovery(duplicated, kind, { resource: REVISION_5_RESOURCE, bookkeeping: false, event: true, extraFrames: [duplicate] })
			const contradictory = await machine(duplicated, ["recover"])
			check(contradictory, { ...recoverUnknown, handoff: [plan[0]] })
			expect(contradictory.envelope.effects).toEqual({ completed: [J], remaining: [], uncertain: [plan[0]], inventoryComplete: true })
			retainRecoveryEvidence(`o1-a6-observation-${kind}`, { kind, agreeing: receiptOf(agreeing, observed.run), claimedOnly: receiptOf(claimedOnly, partial.run), preImage: receiptOf(preImage, notApplied.run), third: receiptOf(third, unknown.run), duplicated: receiptOf(duplicated, contradictory.run) })
		}
	})
	test("O1 A2: a resource aliased as the journal is an unversioned nonempty journal, refused before consumption with every byte unchanged", async () => {
		const rows: Array<[Variant, string[], string]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply"],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair"],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry"],
		]
		for (const [variant, argv, identity] of rows) {
			const root = fresh(variant)
			const state = join(root.root, "state")
			rmSync(join(state, "journal.jsonl"))
			// Real filesystem alias: the journal's bytes are the resource JSON, a nonempty line without journalVersion.
			linkSync(join(state, "resource.json"), join(state, "journal.jsonl"))
			const before = readState(root)
			const observed = await machine(root, argv)
			retainRecoveryEvidence(`o1-a2-aliased-journal-${identity}`, { identity, before, run: receiptOf(root, observed.run) })
			check(observed, { identity, outcome: "refused", failureClass: "schema", causeCode: "SCHEMA_STATE_INVALID", exit: 4, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
			expect(observed.message).toContain("unversioned")
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(readState(root)).toEqual(before)
			expect((JSON.parse(before.preview as string) as { consumed: boolean }).consumed).toBe(false)
		}
	})
	test("write-ahead: halt before the effect leaves the intent and nothing else; halt after leaves no completion", async () => {
		const before = fresh("healthy-with-fresh-preview")
		const halted = await runCli(before, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-before-effect:${U}` })
		retainRecoveryEvidence("o1-write-ahead-after-intent", receiptOf(before, halted))
		expect(halted.signal).toBe("SIGKILL")
		expect(halted.stdout).toBe("")
		expect(journalRecords(before).map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`])
		expect(readState(before).resource).toBe('{"resource":"demo","revision":4,"status":"healthy","version":1}\n')
		expect((JSON.parse(readState(before).preview as string) as { consumed: boolean }).consumed).toBe(true)
		// O1 A6 (D3): the intent's pre-image digest matches the resource and the scan is complete, so nothing was applied.
		const recovered = await machine(before, ["recover"])
		retainRecoveryEvidence("o1-write-ahead-after-intent-recover", receiptOf(before, recovered.run))
		check(recovered, recoverNothingPending)
		expect(recovered.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		expect(projection(recovered)).toEqual({ result: "nothing-pending", station_id: "repair-lab.nothing-pending", transaction_state: "unchanged", observed_resource_revision: 4, consumed_preview_id: "preview-healthy-revision-4", observed_completed_effect_ids: [], not_applied_effect_ids: [U, J] })
		const after = fresh("healthy-with-fresh-preview")
		const haltedAfter = await runCli(after, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-after-effect:${U}` })
		retainRecoveryEvidence("o1-write-ahead-after-effect", receiptOf(after, haltedAfter))
		expect(haltedAfter.signal).toBe("SIGKILL")
		expect(journalRecords(after).map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`])
		expect(JSON.parse(readState(after).resource).revision).toBe(5)
		// O1 A6 (D3): the resource equals the expected bytes and the second effect has no intent under a complete scan.
		const recoveredAfter = await machine(after, ["recover"])
		retainRecoveryEvidence("o1-write-ahead-after-effect-recover", receiptOf(after, recoveredAfter.run))
		check(recoveredAfter, recoverPartial([U], [J]).expected)
		expect(recoveredAfter.envelope.effects).toEqual({ completed: [U], remaining: [J], uncertain: [], inventoryComplete: true })
	})
	test("W4 silent no-op: an effect that returns without an observable change never records completion", async () => {
		const rows: Array<[Variant, string[], string, string[]]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", [U, J]],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", [R, J]],
		]
		for (const [variant, argv, identity, uncertain] of rows) {
			const root = fresh(variant)
			const observed = await machine(root, argv, "silent-no-op")
			retainRecoveryEvidence(`o1-silent-no-op-${identity}`, receiptOf(root, observed.run))
			check(observed, { identity, outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_EFFECT_NOT_OBSERVED", exit: 1, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: RECOVER })
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain, inventoryComplete: true })
			expect(journalRecords(root).map((record) => record.kind)).toEqual(["intent"])
			expect(JSON.parse(readState(root).resource).revision).toBe(4)
		}
	})
	test("F2: recover never counts an earlier cycle's completed records against the current consumed preview", async () => {
		const root = fresh("healthy")
		expect((await machine(root, ["apply", "--preview"])).envelope.outcome).toBe("success")
		expect((await machine(root, AUTHORIZED_APPLY)).envelope.outcome).toBe("success")
		const second = await machine(root, ["apply", "--preview"])
		expect(second.result?.preview_id).toBe("preview-healthy-revision-5")
		const partial = await machine(root, ["apply", "--preview-id", "preview-healthy-revision-5", "--authorize", "fixture-authority"], "effect.write-journal-outcome-unknown")
			expect(partial.envelope.causeCode).toBe("INTERNAL_EFFECT_OUTCOME_UNKNOWN")
		// O1 A6 (D3): the earlier cycle's frames are out of scope; this run's second effect has an intent but no event frame
		// under a complete scan, so the live-run uncertainty resolves to a known partial completion.
		const recovered = await machine(root, ["recover"])
		check(recovered, recoverPartial([U], [J]).expected)
		expect(recovered.envelope.effects).toEqual({ completed: [U], remaining: [J], uncertain: [], inventoryComplete: true })
	})
	test("F6: the storage probe (step 9) precedes expected-effect binding (step 10)", async () => {
		const root = fresh("healthy-with-mismatched-effects-preview")
		const before = readState(root)
		check(await machine(root, AUTHORIZED_APPLY, "one-transient-lock"), { identity: "repair-lab.apply", outcome: "refused", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY", exit: 75, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: 25, nextAction: "retry the same command after 25 ms" })
		await expectUnchanged(root, before)
		check(await machine(root, AUTHORIZED_APPLY), domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local"))
		await expectUnchanged(root, before)
	})
	test("W2 and W1 boundaries: an unwritable journal is failed|INTERNAL_EFFECT_OUTCOME_UNKNOWN with trusted state unknown; an exception before any write is failed|INTERNAL_UNEXPECTED unchanged", async () => {
		const rows: Array<[Variant, string[], string, string[], string | undefined]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", [U, J], undefined],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", [R, J], undefined],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", [R, J], "one-transient-lock"],
		]
		for (const [variant, argv, identity, plan, fault] of rows) {
			const root = fresh(variant)
			const resourceBefore = readState(root).resource
			readOnlyJournal(root)
			const observed = await machine(root, argv, fault)
			expect(tupleOf(observed)).toBe("failed|INTERNAL_EFFECT_OUTCOME_UNKNOWN")
			check(observed, { identity, outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", exit: 1, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: RECOVER })
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: plan, inventoryComplete: true })
			expect(journalRecords(root)).toEqual([])
			expect(readState(root).resource).toBe(resourceBefore)
			expect((JSON.parse(readState(root).preview as string) as { consumed: boolean }).consumed).toBe(true)
			// O1 A6 (D3): no intent frame under a complete scan means nothing was applied; the live W2 uncertainty resolves.
			const recovered = await machine(root, ["recover"])
			check(recovered, recoverNothingPending)
			expect(recovered.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(projection(recovered)).toMatchObject({ result: "nothing-pending", observed_completed_effect_ids: [], not_applied_effect_ids: plan })
			expect(journalRecords(root)).toEqual([])
			const w1 = fresh(variant)
			const before = readState(w1)
			const thrown = await machine(w1, argv, fault === undefined ? "throw-internal" : "throw-internal")
			check(thrown, { identity, outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED", exit: 1, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
			await expectUnchanged(w1, before)
		}
	})
	test("D6-c (d): completed facts survive a non-JSON candidate as INTERNAL_RESULT_COMPLETED and are never replayed", async () => {
		const root = fresh("healthy-with-fresh-preview")
		const observed = await machine(root, AUTHORIZED_APPLY, "egress-non-json:cycle")
		// Claim versus observation first (brief 7.2, e3): the envelope may not report what the resource and journal contradict.
		const observedRevision = (JSON.parse(readState(root).resource) as { revision: number }).revision
		const observedCompleted = journalRecords(root).filter((record) => record.kind === "completed").map((record) => record.effect).filter((effect): effect is string => typeof effect === "string")
		const stateFromObservation = observedRevision === 5 && observedCompleted.length === 2 ? "completed" : "unchanged"
			expect({ transactionState: observed.envelope.transactionState, completed: (observed.envelope.effects as { completed: string[] }).completed }).toEqual({ transactionState: stateFromObservation, completed: observedCompleted })
		check(observed, fallback("repair-lab.apply", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", INSPECT))
			expect(observed.envelope.effects).toEqual({ completed: [U, J], remaining: [], uncertain: [], inventoryComplete: true })
		expect(JSON.parse(readState(root).resource).revision).toBe(5)
		expect(journalRecords(root).filter((record) => record.kind === "completed")).toHaveLength(2)
		expect((JSON.parse(readState(root).preview as string) as { consumed: boolean }).consumed).toBe(true)
		const journalAfter = readState(root).journal
		const inspected = await machine(root, ["inspect"])
		expect((inspected.result?.resource as { revision: number }).revision).toBe(5)
		expect(readState(root).journal).toBe(journalAfter)
	})
	test("D6-c (d): refused facts stay refused as INTERNAL_PREPARATION with unchanged state and the recorded remaining ids", async () => {
		const automation = await machine(fresh("healthy"), ["apply", "--automation"], "egress-non-json:cycle")
		check(automation, fallback("repair-lab.apply", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
			expect(automation.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		const root = fresh("revision-5-with-revision-4-preview")
		const before = readState(root)
		const stale = await machine(root, STALE_APPLY, "egress-non-json:cycle")
		check(stale, fallback("repair-lab.apply", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
			expect(stale.envelope.effects).toEqual({ completed: [], remaining: [U, J], uncertain: [], inventoryComplete: true })
		await expectUnchanged(root, before)
	})
	test("D6-c (d'): unknown facts, W2, W4 and W1 each map to their accepted fallback tuple; recover afterwards only reads", async () => {
		const partial = await machine(fresh("healthy-with-partial-preview"), PARTIAL_APPLY, "effect.write-journal-outcome-unknown+egress-non-json:cycle")
		check(partial, fallback("repair-lab.apply", "unknown", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", RECOVER))
			expect(partial.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: true })
		const w2 = fresh("healthy-with-fresh-preview")
		readOnlyJournal(w2)
		const unknown = await machine(w2, AUTHORIZED_APPLY, "egress-non-json:cycle")
		expect(tupleOf(unknown)).toBe(W2_FALLBACK_TUPLE)
		check(unknown, fallback("repair-lab.apply", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", RECOVER))
			expect(unknown.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [U, J], inventoryComplete: true })
		const stateAfter = readState(w2)
		const recovered = await machine(w2, ["recover"])
		expect(recovered.envelope.causeCode).toBe("SUCCESS_UNCHANGED")
		expect(projection(recovered)).toMatchObject({ result: "nothing-pending", not_applied_effect_ids: [U, J] })
		expect(readState(w2)).toEqual(stateAfter)
		const w4 = await machine(fresh("healthy-with-fresh-preview"), AUTHORIZED_APPLY, "silent-no-op+egress-non-json:cycle")
		check(w4, fallback("repair-lab.apply", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", RECOVER))
		const w1root = fresh("healthy-with-fresh-preview")
		const before = readState(w1root)
		const w1 = await machine(w1root, AUTHORIZED_APPLY, "throw-internal+egress-non-json:cycle")
		check(w1, fallback("repair-lab.apply", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", INSPECT))
		await expectUnchanged(w1root, before)
		const handoff = await machine(fresh("unknown-after-partial"), ["recover"], "egress-non-json:cycle")
		check(handoff, fallback("repair-lab.recover", "unknown", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", null, [J]))
			expect(handoff.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: true })
		check(await machine(fresh("healthy"), ["recover"], "egress-non-json:cycle"), fallback("repair-lab.recover", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", INSPECT))
		check(await machine(fresh("derived-index-missing-with-fresh-preview"), RETRY_REPAIR, "persistent-lock+egress-non-json:cycle"), fallback("repair-lab.repair-retry", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
		check(await machine(fresh("derived-index-missing-with-fresh-preview"), RETRY_REPAIR, "one-transient-lock+egress-non-json:cycle"), fallback("repair-lab.repair-retry", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", INSPECT))
	})
})

describe("internal state containment", () => {
	const APPLY_PREVIEW_BYTES = `${JSON.stringify({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: [U, J], consumed: false })}\n`
	const REPAIR_PREVIEW_BYTES = `${JSON.stringify({ preview_id: "repair-preview-missing-index", kind: "repair", resource_revision: 4, expected_effect_ids: [R, J], consumed: false })}\n`
	const CONSUMED_PREVIEW_BYTES = `${JSON.stringify({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: [U, J], consumed: true, consumed_by_run: "run-fixture" })}\n`
	const HEALTHY_RESOURCE_BYTES = '{"resource":"demo","revision":4,"status":"healthy","version":1}\n'
	const REPAIR_RESOURCE_BYTES = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'

	async function expectRefusedAndPreserved(root: Root, argv: string[], identity: string, effectClass: Expected["effectClass"], outside: string, outsideBytes: string, before: ReturnType<typeof readState>): Promise<void> {
		const observed = await machine(root, argv)
		check(observed, domain(identity, "DOMAIN_PATH_ESCAPE", effectClass))
		expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		expect(readFileSync(outside, "utf8")).toBe(outsideBytes)
		expect(readState(root)).toEqual(before)
	}

	test("preview.json symlinks are refused by every preview reader and writer", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"], string]> = [
			["healthy", ["apply", "--preview"], "repair-lab.preview", "repository-local", "outside-preview\n"],
			["derived-index-missing", ["repair", "--preview"], "repair-lab.repair", "repository-local", "outside-preview\n"],
			["healthy", AUTHORIZED_APPLY, "repair-lab.apply", "repository-local", APPLY_PREVIEW_BYTES],
			["derived-index-missing", AUTHORIZED_REPAIR, "repair-lab.repair", "repository-local", REPAIR_PREVIEW_BYTES],
			["derived-index-missing", RETRY_REPAIR, "repair-lab.repair-retry", "repository-local", REPAIR_PREVIEW_BYTES],
			["healthy", ["recover"], "repair-lab.recover", "repository-local", CONSUMED_PREVIEW_BYTES],
		]
		for (const [variant, argv, identity, effectClass, bytes] of rows) {
			const root = fresh(variant)
			const outside = linkStateFile(root, "preview.json", bytes)
			const before = readState(root)
			await expectRefusedAndPreserved(root, argv, identity, effectClass, outside, bytes, before)
		}
	})

	test("journal.jsonl symlinks refuse effect routes before preview consumption and refuse recovery", async () => {
		const rows: Array<[Variant, string[], string]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply"],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair"],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry"],
			["unknown-after-partial", ["recover"], "repair-lab.recover"],
		]
		for (const [variant, argv, identity] of rows) {
			const root = fresh(variant)
			const outside = linkStateFile(root, "journal.jsonl", "")
			const before = readState(root)
			await expectRefusedAndPreserved(root, argv, identity, "repository-local", outside, "", before)
			if (variant !== "unknown-after-partial") expect((JSON.parse(before.preview as string) as { consumed: boolean }).consumed).toBe(false)
		}
	})

	test("resource.json symlinks are refused by every state-reading route", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"], string]> = [
			["healthy", ["status"], "repair-lab.status", "inspect", HEALTHY_RESOURCE_BYTES],
			["healthy", ["inspect"], "repair-lab.inspect", "inspect", HEALTHY_RESOURCE_BYTES],
			["healthy", ["inspect", "--include-diagnostics"], "repair-lab.inspect-diagnostics", "inspect", HEALTHY_RESOURCE_BYTES],
			["healthy", ["apply", "--preview"], "repair-lab.preview", "repository-local", HEALTHY_RESOURCE_BYTES],
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "repository-local", HEALTHY_RESOURCE_BYTES],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", "repository-local", REPAIR_RESOURCE_BYTES],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", "repository-local", REPAIR_RESOURCE_BYTES],
			["unknown-after-partial", ["recover"], "repair-lab.recover", "repository-local", HEALTHY_RESOURCE_BYTES],
		]
		for (const [variant, argv, identity, effectClass, bytes] of rows) {
			const root = fresh(variant)
			const outside = linkStateFile(root, "resource.json", bytes)
			const before = readState(root)
			await expectRefusedAndPreserved(root, argv, identity, effectClass, outside, bytes, before)
		}
	})
})

describe("diagnostics", () => {
	function records(root: Root): Array<Record<string, unknown>> {
		const files = diagnosticsFiles(root)
		expect(files).toHaveLength(1)
		return diagnosticsRecords(root, files[0] as string)
	}
	test("per-run JSON Lines file: 0700 directory, 0600 file named by runIdentity, ordered sequence, station on the terminal record", async () => {
		const root = fresh("healthy-with-fresh-preview")
		const observed = await machine(root, AUTHORIZED_APPLY)
		const runIdentity = observed.envelope.runId as string
		expect(modeOf(join(root.root, "diagnostics"))).toBe(0o700)
		expect(diagnosticsFiles(root)).toEqual([`${runIdentity}.jsonl`])
		expect(modeOf(join(root.root, "diagnostics", `${runIdentity}.jsonl`))).toBe(0o600)
		expect(observed.diagnostics).toEqual({ status: "available", file: join(root.root, "diagnostics", `${runIdentity}.jsonl`), sinkFailure: null, droppedRecords: 0, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: true })
		const lines = records(root)
		expect(lines.map((record) => record.event_kind)).toEqual(["apply.started", "effect.update-index.completed", "effect.write-journal.completed", "apply.completed"])
		expect(lines.map((record) => record.sequence)).toEqual([1, 2, 3, 4])
		for (const record of lines) {
			expect(record.runIdentity).toBe(runIdentity)
			expect(record.command).toBe("repair-lab.apply")
			expect(record.event_id).toBe(`${runIdentity}:${record.sequence}`)
			expect(typeof record["@timestamp"] === "string" || typeof record.timestamp === "number").toBe(true)
		}
		expect(lines.map((record) => record.station_id)).toEqual([null, null, null, "repair-lab.authorized-apply"])
	})
	test("record counts on a refusal and on a status run; the file exists even with zero records", async () => {
		const refused = fresh("revision-5-with-revision-4-preview")
		await machine(refused, STALE_APPLY)
		expect(records(refused).map((record) => record.event_kind)).toEqual(["apply.started", "apply.stale-preview.refused"])
		const status = fresh("healthy")
		const observed = await machine(status, ["status"])
		expect(records(status)).toEqual([])
		expect(observed.diagnostics).toEqual({ status: "available", file: join(status.root, "diagnostics", `${observed.envelope.runId as string}.jsonl`), sinkFailure: null, droppedRecords: 0, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: true })
	})
	test("redaction: the marker never reaches the diagnostics file and the redaction event names the field", async () => {
		const root = fresh("secret-marker-in-diagnostic-field")
		await machine(root, ["inspect", "--include-diagnostics"])
		const lines = records(root)
		expect(lines.map((record) => record.event_kind)).toEqual(["inspect.started", "inspect.redaction-applied", "inspect.completed"])
		expect(lines[1]?.sensitive_fields_redacted).toEqual(["diagnostic_token"])
		expect(readFileSync(join(root.root, "diagnostics", diagnosticsFiles(root)[0] as string), "utf8").includes(SECRET_MARKER)).toBe(false)
	})
	test("bounded queue: a flood keeps 256 records plus one truncation record and reports the drops", async () => {
		const root = fresh("healthy")
		const observed = await machine(root, ["status"], "diagnostics-flood")
		expect(observed.envelope.outcome).toBe("success")
		const lines = records(root)
		expect(lines).toHaveLength(257)
		expect(lines[256]?.event_kind).toBe("diagnostics.truncated")
		expect(observed.diagnostics).toEqual({ status: "available", file: join(root.root, "diagnostics", `${observed.envelope.runId as string}.jsonl`), sinkFailure: "capacity", droppedRecords: 8, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: true })
	})
	test("sink failures preserve exit, envelope and domain result; only runIdentity and sinkFailure differ", async () => {
		const scenarios: Array<[Variant, string[]]> = [
			["unknown-after-partial", ["recover"]],
			["secret-marker-in-diagnostic-field", ["inspect", "--include-diagnostics"]],
			["healthy-with-fresh-preview", AUTHORIZED_APPLY],
		]
		for (const [variant, argv] of scenarios) {
			const normal = fresh(variant)
			const baseline = await machine(normal, argv)
			const expected = comparable(baseline, normal)
			const unwritable = fresh(variant)
			blockDiagnostics(unwritable)
			const blocked = await machine(unwritable, argv)
			expect(blocked.run.exit).toBe(baseline.run.exit)
			expect(blocked.diagnostics).toEqual({ status: "unavailable", reason: "status-unavailable", trusted: { file: null, sinkFailure: "setup" } })
			expect(comparable(blocked, unwritable)).toEqual(expected)
			expect(existsSync(join(unwritable.root, "diagnostics", `${blocked.envelope.runId as string}.jsonl`))).toBe(false)
			const throwingRoot = fresh(variant)
			const throwing = await machine(throwingRoot, argv, "sink-throw")
			expect(throwing.run.exit).toBe(baseline.run.exit)
			expect(Object.keys(throwing.diagnostics ?? {}).sort()).toEqual(["closed", "countsComplete", "droppedRecords", "file", "sinkFailure", "status", "truncatedRecords", "unflushedRecords"])
			expect(throwing.diagnostics).toEqual({ status: "available", file: join(throwingRoot.root, "diagnostics", `${throwing.envelope.runId as string}.jsonl`), sinkFailure: "write", droppedRecords: 0, unflushedRecords: baseline.envelope.commandIdentity === "repair-lab.apply" ? 4 : baseline.envelope.commandIdentity === "repair-lab.inspect-diagnostics" ? 3 : 2, truncatedRecords: 0, countsComplete: true, closed: true })
			expect(comparable(throwing, throwingRoot)).toEqual(expected)
			const disposingRoot = fresh(variant)
			const disposing = await machine(disposingRoot, argv, "sink-dispose-throw")
			expect(disposing.diagnostics).toEqual({ status: "available", file: join(disposingRoot.root, "diagnostics", `${disposing.envelope.runId as string}.jsonl`), sinkFailure: "close", droppedRecords: 0, unflushedRecords: 0, truncatedRecords: 0, countsComplete: true, closed: false })
			expect(comparable(disposing, disposingRoot)).toEqual(expected)
			// Resulting state compares with each process's run token normalized (consumed_by_run and journal run fields).
			// Journal frames are decoded (the decoder re-derives each frame's digest) and the digests bound to the run token
			// through the event payload are normalized, since two runs can never share them.
			const stateOf = (root: Root, runId: string): string => {
				const state = readState(root)
				const segments = state.journal.split("\n")
				const fragment = segments.pop() ?? ""
				const records = segments.map((line) => JSON.parse(JSON.stringify(decodeFrame(line)).split(runId).join("run-NORMALIZED")) as Record<string, unknown>)
				for (const record of records) {
					if (record.effect !== J) continue
					if ("expected_after_sha256" in record) record.expected_after_sha256 = "<run-bound>"
					if ("observed_after_sha256" in record) record.observed_after_sha256 = "<run-bound>"
				}
				return JSON.stringify({ resource: state.resource, preview: state.preview?.split(runId).join("run-NORMALIZED") ?? null, records, fragment })
			}
			expect(stateOf(unwritable, blocked.envelope.runId as string)).toBe(stateOf(normal, baseline.envelope.runId as string))
			expect(stateOf(throwingRoot, throwing.envelope.runId as string)).toBe(stateOf(normal, baseline.envelope.runId as string))
		}
	})
	test("deleting the diagnostics file leaves recover's domain decision, effect identities and guidance identical", async () => {
		const root = fresh("unknown-after-partial")
		const first = await machine(root, ["recover"])
		const { rmSync } = await import("node:fs")
		rmSync(join(root.root, "diagnostics", `${first.envelope.runId as string}.jsonl`))
		const second = await machine(root, ["recover"])
		expect(normalize(second.run.stdout, second.envelope.runId as string)).toEqual(normalize(first.run.stdout, first.envelope.runId as string))
		expect(second.envelope.handoff).toMatchObject({ owner: "operator", inspect: [INSPECT] })
		expect(diagnosticsFiles(root)).toEqual([`${second.envelope.runId as string}.jsonl`])
	})
	test("inspect-diagnostics fallback rows carry unchanged and inspect guidance", async () => {
		check(await machine(fresh("secret-marker-in-diagnostic-field"), ["inspect", "--include-diagnostics"], "egress-non-json:cycle"), fallback("repair-lab.inspect-diagnostics", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect", "--include-diagnostics", "--state", "state/missing.json"], "egress-non-json:cycle"), fallback("repair-lab.inspect-diagnostics", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
	})
})

// O1 unit U0 (CDS-LO-1 A6 and A9 on the repaired base): read-back failure after a successful durable write, diagnostics
// that never authorize completion or replay, and a sequential second child. Every literal below is restated from the
// fixture and the accepted 2.0 station table; the rows add no journal version, lock, cause, station or observation rule.
describe("O1 U0", () => {
	const READ_BACK_REASON = "a durable write was attempted and its outcome is not established"
	function diagnosticsBytes(root: Root): Record<string, string> {
		return Object.fromEntries(diagnosticsFiles(root).map((file) => [file, readFileSync(join(root.root, "diagnostics", file), "utf8")]))
	}
	const handoffExpectation = (identity: string, causeCode: string, failureClass: "internal" | "domain", exit: number): Expected => ({ identity, outcome: "failed", failureClass, causeCode, exit, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null })
	// Journal-shaped completion text and a fabricated authorizing event, written where only diagnostics live.
	function forgeDiagnostics(root: Root, kind: Kind, runId: string): string[] {
		const [first] = planOf(kind)
		const forged = `${completedLine(kind, 2, runId, first)}${eventLine(kind, 4, runId)}${completedLine(kind, 5, runId, J)}${JSON.stringify({ event_kind: "recovery.replay-authorized", station: "repair-lab.authorized-apply", run: runId, completed_effect_ids: planOf(kind) })}\n`
		const directory = join(root.root, "diagnostics")
		mkdirSync(directory, { recursive: true })
		const files = diagnosticsFiles(root)
		for (const file of files) appendFileSync(join(directory, file), forged)
		writeFileSync(join(directory, "run-00000000-0000-4000-8000-000000000000.jsonl"), forged)
		return diagnosticsFiles(root)
	}
	async function recoverUnchangedAcrossDiagnostics(root: Root, kind: Kind, forgedRunId: string, expected: Expected, effects: Record<string, unknown>, label: string): Promise<void> {
		const state = readState(root)
		const intact = await machine(root, ["recover"])
		check(intact, expected)
		expect(intact.envelope.effects).toEqual(effects)
		expect(intact.diagnostics).toMatchObject({ status: "available", sinkFailure: null })
		const oracle = comparable(intact, root)
		expect(readState(root)).toEqual(state)
		const intactReceipt = receiptOf(root, intact.run)
		for (const file of diagnosticsFiles(root)) rmSync(join(root.root, "diagnostics", file))
		const deleted = await machine(root, ["recover"])
		expect(comparable(deleted, root)).toEqual(oracle)
		expect(deleted.diagnostics).toMatchObject({ status: "available", sinkFailure: null })
		expect(readState(root)).toEqual(state)
		const deletedReceipt = receiptOf(root, deleted.run)
		const throwing = await machine(root, ["recover"], "sink-throw")
		expect(comparable(throwing, root)).toEqual(oracle)
		expect(throwing.diagnostics).toMatchObject({ status: "available", sinkFailure: "write", unflushedRecords: 2 })
		expect(readState(root)).toEqual(state)
		const throwingReceipt = receiptOf(root, throwing.run)
		const forgedFiles = forgeDiagnostics(root, kind, forgedRunId)
		expect(forgedFiles.length).toBeGreaterThanOrEqual(3)
		const forgedBefore = diagnosticsBytes(root)
		const forged = await machine(root, ["recover"])
		expect(comparable(forged, root)).toEqual(oracle)
		expect(forged.envelope.effects).toEqual(effects)
		expect(forged.diagnostics).toMatchObject({ status: "available", sinkFailure: null })
		expect(readState(root)).toEqual(state)
		const forgedAfter = diagnosticsBytes(root)
		for (const [file, bytes] of Object.entries(forgedBefore)) expect(forgedAfter[file]).toBe(bytes)
		retainRecoveryEvidence(`o1-u0-p12-${label}`, { kind, forgedRunId, state, oracle, intact: intactReceipt, deleted: deletedReceipt, throwing: throwingReceipt, forged: receiptOf(root, forged.run) })
	}

	test("O1 U0 P8: a durable write that lands but cannot be read back is failed|INTERNAL_EFFECT_OUTCOME_UNKNOWN; recover and the same argv never replay", async () => {
		const rows: Array<[Variant, string[], string, Kind, string, string[], string[]]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "apply", U, [], [U, J]],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", "repair", R, [], [R, J]],
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "apply", J, [U], [J]],
		]
		for (const [variant, argv, identity, kind, effect, completed, uncertain] of rows) {
			const root = fresh(variant)
			const before = readState(root)
			const observed = await machine(root, argv, `readback-fail:${effect}`)
			const runId = observed.envelope.runId as string
			expect(observed.run).toMatchObject({ exit: 1, stderr: "", signal: null })
			check(observed, handoffExpectation(identity, "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "internal", 1))
			expect(observed.envelope).toMatchObject({ data: null, retryable: false, repairAction: "run repair-lab recover; do not retry automatically", handoff: { owner: "operator", reason: READ_BACK_REASON, inspect: [INSPECT] }, effects: { completed, remaining: [], uncertain, inventoryComplete: true } })
			expect(observed.envelope.nextAction).toBeUndefined()
			expect(observed.envelope.retryDelayMilliseconds).toBeUndefined()
			expect(observed.message).toBe(READ_BACK_REASON)
			// Independent state: the write landed, the preview is consumed by this run, and no completion line names the effect.
			const [first] = planOf(kind)
			const expectedJournal = effect === J ? `${intentLine(kind, 1, runId, first)}${completedLine(kind, 2, runId, first)}${intentLine(kind, 3, runId, J)}${eventLine(kind, 4, runId)}` : intentLine(kind, 1, runId, effect)
			const afterFault = readState(root)
			expect(afterFault).toEqual({ resource: REVISION_5_HEALTHY, preview: consumedPreview(kind, runId), journal: expectedJournal })
			expect(afterFault.resource).not.toBe(before.resource)
			// O1 A6 (D3) on the U0 rows: recover classifies from the landed bytes. A landed resource write with no second
			// intent is a known partial completion; a landed event frame completes the plan, so nothing is pending.
			const recovered = await machine(root, ["recover"])
			if (effect === J) {
				check(recovered, recoverNothingPending)
				expect(projection(recovered)).toMatchObject({ result: "nothing-pending", observed_completed_effect_ids: [U, J], not_applied_effect_ids: [] })
			} else {
				const partial = recoverPartial([effect], [J])
				check(recovered, partial.expected)
				expect(recovered.envelope.effects).toEqual(partial.effects)
				expect(recovered.envelope.handoff).toEqual({ owner: "operator", reason: PARTIAL_REASON, inspect: [INSPECT] })
			}
			expect(readState(root)).toEqual(afterFault)
			// O1 A7 (D6): the same argv never replays. An unresolved prior run refuses DOMAIN_PRIOR_RUN_PENDING; a resolved
			// consumed plan keeps the existing consumed-preview refusal. Either way every byte is unchanged.
			const repeated = await machine(root, argv)
			if (effect === J) check(repeated, domain(identity, "DOMAIN_PREVIEW_CONSUMED", "repository-local"))
			else {
				check(repeated, { identity, outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_PRIOR_RUN_PENDING", exit: 3, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: null })
				expect(repeated.envelope.handoff).toEqual({ owner: "operator", reason: PRIOR_RUN_REASON, inspect: [INSPECT] })
			}
			expect(repeated.envelope.effects).toMatchObject({ completed: [], uncertain: [], inventoryComplete: true })
			expect(readState(root)).toEqual(afterFault)
			retainRecoveryEvidence(`o1-u0-p8-${identity}-${effect}`, { variant, argv, fault: `readback-fail:${effect}`, before, fault_run: receiptOf(root, observed.run), recover: receiptOf(root, recovered.run), repeat: receiptOf(root, repeated.run) })
		}
		const humanRoot = fresh("healthy-with-fresh-preview")
		const humanRun = await human(humanRoot, AUTHORIZED_APPLY, `readback-fail:${U}`)
		expect(humanRun).toMatchObject({ exit: 1, stdout: "", signal: null })
		expect(lines(humanRun.stderr)).toEqual([`apply failed: ${READ_BACK_REASON}; run repair-lab recover`])
		expect(readState(humanRoot).resource).toBe(REVISION_5_HEALTHY)
		retainRecoveryEvidence("o1-u0-p8-human", receiptOf(humanRoot, humanRun))
		// The channel stays closed: an unbound, unknown or extra-suffixed effect argument is a usage refusal before any
		// state access; a known effect id followed by more syntax is not that effect id.
		for (const token of ["readback-fail", "readback-fail:effect.nope", "readback-fail:", `readback-fail:${U}:extra`, `readback-fail:${U}:`]) {
			const closed = fresh("healthy-with-fresh-preview")
			const untouched = readState(closed)
			check(await machine(closed, AUTHORIZED_APPLY, token), usage("repair-lab.apply", "USAGE_INVALID_ARGUMENTS", "repository-local"))
			expect(readState(closed)).toEqual(untouched)
		}
	})

	test("O1 U0 P12: intact, deleted, throwing and forged diagnostics leave recover's decision, effects and guidance identical after a completed real apply and after a real pending run", async () => {
		// Completed real apply: recover is nothing-pending under every diagnostics condition; nothing is re-applied.
		const completedRoot = fresh("healthy-with-fresh-preview")
		const applied = await machine(completedRoot, AUTHORIZED_APPLY)
		expect(applied.envelope).toMatchObject({ outcome: "success", transactionState: "completed" })
		const appliedRun = applied.envelope.runId as string
		const completedState = readState(completedRoot)
		expect(completedState).toEqual({ resource: REVISION_5_HEALTHY, preview: consumedPreview("apply", appliedRun), journal: completedJournal("apply", appliedRun) })
		await recoverUnchangedAcrossDiagnostics(completedRoot, "apply", appliedRun, recoverNothingPending, { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, "completed-apply")
		expect(readState(completedRoot)).toEqual(completedState)
		expect(journalRecords(completedRoot).filter((record) => record.kind === "event")).toHaveLength(1)
		// Real pending run: the first effect's write landed and the process was killed before its completion line.
		const pendingRoot = fresh("healthy-with-fresh-preview")
		const halted = await runCli(pendingRoot, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-after-effect:${U}` })
		expect(halted.signal).toBe("SIGKILL")
		expect(halted.stdout).toBe("")
		const pendingState = readState(pendingRoot)
		const haltedRun = (JSON.parse(pendingState.preview as string) as { consumed_by_run: string }).consumed_by_run
		expect(pendingState).toEqual({ resource: REVISION_5_HEALTHY, preview: consumedPreview("apply", haltedRun), journal: intentLine("apply", 1, haltedRun, U) })
		// O1 A6 (D3): the landed first effect and the never-intended second effect are a known partial completion; the
		// U0 invariant holds unchanged: no diagnostics condition alters that decision, its effects or its guidance.
		const pending = recoverPartial([U], [J])
		await recoverUnchangedAcrossDiagnostics(pendingRoot, "apply", haltedRun, pending.expected, pending.effects, "pending-apply")
		expect(readState(pendingRoot)).toEqual(pendingState)
	})

	test("O1 U0 P3: a second real child started after a completed apply or repair exits is refused as consumed and leaves every state byte identical", async () => {
		const rows: Array<[Variant, string[], string, Kind]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "apply"],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", "repair"],
		]
		for (const [variant, argv, identity, kind] of rows) {
			const root = fresh(variant)
			const first = await machine(root, argv)
			const firstRun = first.envelope.runId as string
			expect(first.run).toMatchObject({ exit: 0, signal: null })
			expect(first.envelope).toMatchObject({ outcome: "success", transactionState: "completed", effects: { completed: planOf(kind), remaining: [], uncertain: [], inventoryComplete: true } })
			const done = readState(root)
			expect(done).toEqual({ resource: REVISION_5_HEALTHY, preview: consumedPreview(kind, firstRun), journal: completedJournal(kind, firstRun) })
			// runCli resolves only after the first child's exit, so the second child is strictly sequential.
			const second = await machine(root, argv)
			const secondRun = second.envelope.runId as string
			expect(secondRun).not.toBe(firstRun)
			check(second, domain(identity, "DOMAIN_PREVIEW_CONSUMED", "repository-local"))
			expect(second.envelope).toMatchObject({ data: null, retryable: false, effects: { completed: [], uncertain: [], inventoryComplete: true } })
			expect(second.envelope.handoff).toBeUndefined()
			expect(readState(root)).toEqual(done)
			expect(done.journal.includes(secondRun)).toBe(false)
			expect(diagnosticsFiles(root)).toEqual([`${firstRun}.jsonl`, `${secondRun}.jsonl`].sort())
			// The 2.0 wire folds consumed and stale into DOMAIN_PRECONDITION_UNMET; the station is pinned through the
			// second child's terminal diagnostics record and, below, the human stderr line.
			expect(diagnosticsRecords(root, `${secondRun}.jsonl`).map((record) => [record.event_kind, record.station_id])).toEqual([[kind === "apply" ? "apply.started" : "repair.apply.started", null], [`${kind}.preview-consumed`, "repair-lab.preview-consumed"]])
			const third = await human(root, argv)
			expect(third).toMatchObject({ exit: 3, stdout: "", signal: null })
			expect(lines(third.stderr)).toEqual([`${kind} refused: preview already consumed; inspect and preview again`])
			expect(readState(root)).toEqual(done)
			retainRecoveryEvidence(`o1-u0-p3-${identity}`, { variant, argv, first: receiptOf(root, first.run), second: receiptOf(root, second.run), third: receiptOf(root, third) })
		}
	})
})

// O1 Candidate A (CDS-LO-1, ticket freeze 2026-09-15): journal revision 2 framing, the unversioned, torn and corrupt
// journal behaviours, the three finite bounds, atomic preview consumption, and the prior-run refusal. Every expected
// byte, digest, message and station below is a literal authored from the freeze and C0 revision 2; nothing is read
// from the modules under test. Recovery observation (A6) lives with the other recover rows in "recovery" above.
describe("O1 A", () => {
	const LIMIT_ACTION = "Inspect, then archive the journal manually; nothing is rotated or pruned automatically"
	const SCAN_BOUND = 10_000_000
	const UNVERSIONED_LINE = '{"kind":"intent","seq":1,"run":"run-fixture","effect":"effect.update-index","operation":"apply","preview_id":"preview-healthy-revision-4"}\n'
	// Every routed state command with the fixture variant on which it would otherwise proceed past the journal read.
	const ROUTED: Array<[Variant, string[], string, Expected["effectClass"]]> = [
		["healthy", ["status"], "repair-lab.status", "inspect"],
		["healthy", ["inspect"], "repair-lab.inspect", "inspect"],
		["healthy", ["inspect", "--include-diagnostics"], "repair-lab.inspect-diagnostics", "inspect"],
		["healthy", ["apply", "--preview"], "repair-lab.preview", "repository-local"],
		["healthy", ["repair", "--preview"], "repair-lab.repair", "repository-local"],
		["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "repository-local"],
		["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", "repository-local"],
		["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", "repository-local"],
		["partial-after-halt", ["recover"], "repair-lab.recover", "repository-local"],
	]
	const WRITERS = ROUTED.filter(([, argv]) => argv.includes("--preview") || argv.includes("--authorize"))
	const journalPath = (root: Root): string => join(root.root, "state", "journal.jsonl")
	const seedJournal = (root: Root, bytes: string): void => writeFileSync(journalPath(root), bytes)
	function stateEntries(root: Root): string[] {
		return readdirSync(join(root.root, "state")).sort()
	}
	async function expectSchemaRefusal(root: Root, argv: string[], identity: string, effectClass: Expected["effectClass"], message: string): Promise<Machine> {
		const before = readState(root)
		const observed = await machine(root, argv)
		retainRecoveryEvidence(`o1-schema-${sha256(before.journal)}-${argv.join("_")}`, { argv, before, run: receiptOf(root, observed.run) })
		check(observed, schemaRefusal(identity, effectClass))
		expect(`${argv.join(" ")}: ${observed.message}`).toBe(`${argv.join(" ")}: ${message}`)
		expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
		expect(observed.envelope.repairAction).toBe("Restore a resource that matches the resource schema, then inspect")
		expect(readState(root)).toEqual(before)
		return observed
	}

	test("O1 A9 recover precedence: resource validation precedes journal validation, then preview validation", async () => {
		const rows: Array<[string, string, string, string]> = [
			["resource-first", "{}\n", "garbage\n", "resource does not match the resource schema"],
			["journal-first", RESET_RESOURCE, "garbage\n", "journal line is not a strict journal revision 2 frame"],
			["preview-last", RESET_RESOURCE, "", "preview does not match the preview schema"],
		]
		for (const [label, resource, journal, message] of rows) {
			const root = fresh("healthy-with-fresh-preview")
			writeFileSync(join(root.root, "state", "resource.json"), resource)
			writeFileSync(join(root.root, "state", "preview.json"), "{}\n")
			seedJournal(root, journal)
			const before = readState(root)
			const observed = await machine(root, ["recover"])
			retainRecoveryEvidence(`o1-a9-${label}`, { before, run: receiptOf(root, observed.run) })
			check(observed, schemaRefusal("repair-lab.recover", "repository-local"))
			expect(observed.message).toBe(message)
			expect(readState(root)).toEqual(before)
		}
	})

	test("O1 A1 framing: a completed apply and repair leave exactly the five test-encoded revision 2 frames with the run's digests", async () => {
		const rows: Array<[Variant, string[], Kind]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "apply"],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair"],
		]
		for (const [variant, argv, kind] of rows) {
			const root = fresh(variant)
			const observed = await machine(root, argv)
			const runId = observed.envelope.runId as string
			expect(observed.envelope).toMatchObject({ outcome: "success", transactionState: "completed" })
			const state = readState(root)
			expect(state).toEqual({ resource: REVISION_5_HEALTHY, preview: consumedPreview(kind, runId), journal: completedJournal(kind, runId) })
			// Each line is one strict frame in the frozen key order; the decoder re-derives length and digest independently.
			for (const line of lines(state.journal)) expect(line.startsWith('{"journalVersion":2,"payloadBytes":')).toBe(true)
			expect(journalRecords(root).map((record) => [record.kind, record.seq, record.effect])).toEqual([["intent", 1, planOf(kind)[0]], ["completed", 2, planOf(kind)[0]], ["intent", 3, J], ["event", 4, J], ["completed", 5, J]])
			expect(stateEntries(root)).toEqual(["journal.jsonl", "preview.json", "resource.json"])
			retainRecoveryEvidence(`o1-a1-framing-${kind}`, receiptOf(root, observed.run))
		}
	})

	test("O1 A2 unversioned: a nonempty journal without journalVersion is refused by every routed state command, unchanged and unmigrated", async () => {
		for (const [variant, argv, identity, effectClass] of ROUTED) {
			const root = fresh(variant)
			seedJournal(root, UNVERSIONED_LINE)
			await expectSchemaRefusal(root, argv, identity, effectClass, "journal is unversioned; journal revision 2 frames are required and no migration is performed")
			expect(readState(root).journal).toBe(UNVERSIONED_LINE)
		}
		const humanRoot = fresh("healthy")
		seedJournal(humanRoot, UNVERSIONED_LINE)
		const run = await human(humanRoot, ["status"])
		expect(run).toMatchObject({ exit: 4, stdout: "", signal: null })
		expect(lines(run.stderr)).toEqual(["status refused: journal is unversioned; journal revision 2 frames are required and no migration is performed"])
		retainRecoveryEvidence("o1-a2-unversioned-human", receiptOf(humanRoot, run))
	})

	test("O1 A3 corrupt terminated frame: shape, version, length, digest, bound and payload violations each block every routed state command", async () => {
		const valid = frameLine(APPLY_EVENT_PAYLOAD)
		const frame = JSON.parse(valid) as { journalVersion: number; payloadBytes: number; payloadSha256: string; payload: string }
		const withFrame = (changes: Record<string, unknown>): string => `${JSON.stringify({ ...frame, ...changes })}\n`
		const flipped = frame.payload.replace('"summary":"apply recorded"}', '"summary":"apply recordeD"}')
		expect(flipped).not.toBe(frame.payload)
		const oversizedPayload = `{"kind":"event","seq":1,"run":"run-fixture","effect":"effect.write-journal","operation":"apply","preview_id":"preview-filler","summary":"${"y".repeat(64_001 - 139)}"}`
		expect(Buffer.byteLength(oversizedPayload, "utf8")).toBe(64_001)
		const boundaryPayload = `{"kind":"event","seq":1,"run":"run-fixture","effect":"effect.write-journal","operation":"apply","preview_id":"preview-filler","summary":"${"y".repeat(64_000 - 139)}"}`
		expect(Buffer.byteLength(boundaryPayload, "utf8")).toBe(64_000)
		const corruptions: Array<[string, string, string]> = [
			["not JSON", "garbage\n", "journal line is not a strict journal revision 2 frame"],
			["JSON array", "[1]\n", "journal line is not a strict journal revision 2 frame"],
			["version literal 3", withFrame({ journalVersion: 3 }), "journal line is not a strict journal revision 2 frame"],
			["extra frame key", withFrame({ extra: true }), "journal line is not a strict journal revision 2 frame"],
			["missing payloadSha256", `${JSON.stringify({ journalVersion: 2, payloadBytes: frame.payloadBytes, payload: frame.payload })}\n`, "journal line is not a strict journal revision 2 frame"],
			["payloadBytes off by one", withFrame({ payloadBytes: frame.payloadBytes + 1 }), "journal frame payloadBytes disagrees with its payload"],
			["one flipped payload byte", withFrame({ payload: flipped }), "journal frame payloadSha256 disagrees with its payload"],
			["uppercase digest", withFrame({ payloadSha256: frame.payloadSha256.toUpperCase() }), "journal line is not a strict journal revision 2 frame"],
			["payload over 64,000 bytes", frameLine(oversizedPayload), "journal frame payload exceeds the 64,000-byte bound"],
			["line over 512,000 bytes", `${JSON.stringify({ journalVersion: 2, payloadBytes: 0, payloadSha256: frame.payloadSha256, payload: "", pad: "z".repeat(512_000) })}\n`, "journal line exceeds the 512,000-byte framed-line bound"],
			["payload is not a strict record", frameLine('{"kind":"intent","seq":1}'), "journal frame payload is not a strict journal record"],
			["record with an unknown field", frameLine(`${APPLY_EVENT_PAYLOAD.slice(0, -1)},"extra":1}`), "journal frame payload is not a strict journal record"],
			["intent without digests", frameLine(UNVERSIONED_LINE.trim()), "journal frame payload is not a strict journal record"],
			["corrupt frame after a valid prefix", `${PARTIAL_APPLY_FRAMES}${withFrame({ payloadBytes: frame.payloadBytes + 1 })}`, "journal frame payloadBytes disagrees with its payload"],
		]
		for (const [label, bytes, message] of corruptions) {
			const readers: Array<[Variant, string[], string, Expected["effectClass"]]> = [ROUTED[0] as (typeof ROUTED)[number], ROUTED[3] as (typeof ROUTED)[number], ROUTED[5] as (typeof ROUTED)[number], ROUTED[8] as (typeof ROUTED)[number]]
			for (const [variant, argv, identity, effectClass] of readers) {
				const root = fresh(variant)
				seedJournal(root, bytes)
				const observed = await expectSchemaRefusal(root, argv, identity, effectClass, message)
				expect(`${label}: ${observed.envelope.causeCode as string}`).toBe(`${label}: SCHEMA_INVALID_INPUT`)
				if (identity === "repair-lab.apply") expect((JSON.parse(readState(root).preview as string) as { consumed: boolean }).consumed).toBe(false)
			}
		}
		// The payload bound is inclusive: a 64,000-byte payload frame is a valid journal for readers and writers.
		const boundary = fresh("healthy-with-fresh-preview")
		seedJournal(boundary, frameLine(boundaryPayload))
		expect((await machine(boundary, ["status"])).envelope.outcome).toBe("success")
		const applied = await machine(boundary, AUTHORIZED_APPLY)
		expect(applied.envelope).toMatchObject({ outcome: "success", transactionState: "completed" })
		expect(readState(boundary).journal.startsWith(frameLine(boundaryPayload))).toBe(true)
		retainRecoveryEvidence("o1-a3-boundary-payload", receiptOf(boundary, applied.run))
	})

	test("O1 A4 torn tail: readers keep the validated prefix and never parse the fragment; writers refuse before any durable write", async () => {
		// Row 11's fixture is the torn event frame: status and inspect succeed on the prefix; recover classifies the second
		// effect as uncertain (that row is checked in "recovery" above and rechecked here through the effects inventory).
		const torn = fresh("unknown-after-partial")
		const before = readState(torn)
		expect(before.journal.endsWith("\n")).toBe(false)
		expect((await machine(torn, ["status"])).envelope).toMatchObject({ outcome: "success", causeCode: "SUCCESS_UNCHANGED" })
		expect((await machine(torn, ["inspect"])).envelope).toMatchObject({ outcome: "success", causeCode: "SUCCESS_UNCHANGED" })
		const recovered = await machine(torn, ["recover"])
		check(recovered, { ...recoverUnknown, handoff: [J] })
		expect(recovered.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: true })
		expect(readState(torn)).toEqual(before)
		// Every writer refuses schema-class on a torn tail, whether the fragment is a partial frame or a whole frame that
		// merely lacks its terminal LF; the preview stays unconsumed and no byte changes.
		const fragments: Array<[string, string]> = [
			["partial frame", TORN_APPLY_EVENT_FRAGMENT],
			["frame without LF", frameLine(APPLY_EVENT_PAYLOAD).slice(0, -1)],
			["fragment after a valid prefix", `${PARTIAL_APPLY_FRAMES}{"journalVersion":2,"payloadBytes":`],
		]
		for (const [label, fragment] of fragments) {
			for (const [variant, argv, identity, effectClass] of WRITERS) {
				const root = fresh(variant)
				seedJournal(root, fragment)
				const observed = await expectSchemaRefusal(root, argv, identity, effectClass, "journal ends in a torn frame; writers are blocked until it is inspected")
				expect(`${label}: ${observed.envelope.causeCode as string}`).toBe(`${label}: SCHEMA_INVALID_INPUT`)
				if (argv.includes("--authorize")) expect((JSON.parse(readState(root).preview as string) as { consumed: boolean }).consumed).toBe(false)
				else if (variant === "healthy") expect(readState(root).preview).toBeNull()
			}
		}
		// A torn bookkeeping frame after an independently confirmed event is not uncertainty: every effect is established.
		const bookkeeping = fresh("healthy-with-fresh-preview")
		const applied = await machine(bookkeeping, AUTHORIZED_APPLY)
		const runId = applied.envelope.runId as string
		const journal = readState(bookkeeping).journal
		expect(journal).toBe(completedJournal("apply", runId))
		seedJournal(bookkeeping, journal.slice(0, -30))
		const settled = await machine(bookkeeping, ["recover"])
		check(settled, recoverNothingPending)
		expect(projection(settled)).toMatchObject({ result: "nothing-pending", observed_completed_effect_ids: [U, J], not_applied_effect_ids: [] })
		check(await machine(bookkeeping, ["apply", "--preview"]), schemaRefusal("repair-lab.preview", "repository-local"))
		retainRecoveryEvidence("o1-a4-torn-bookkeeping", receiptOf(bookkeeping, settled.run))
	})

	test("O1 A5 bounds: a journal over the scan bound refuses every writer with DOMAIN_JOURNAL_LIMIT_REACHED and hands recovery off with an incomplete inventory; exactly at the bound one more apply is admitted", async () => {
		const limit = (identity: string): Expected => ({ identity, outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_JOURNAL_LIMIT_REACHED", exit: 3, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
		for (const [variant, argv, identity] of WRITERS) {
			const root = fresh(variant)
			fillJournal(root, SCAN_BOUND + 1)
			const before = readState(root)
			expect(Buffer.byteLength(before.journal, "utf8")).toBeGreaterThan(SCAN_BOUND)
			const observed = await machine(root, argv)
			check(observed, limit(identity))
			expect(observed.envelope.repairAction).toBe(LIMIT_ACTION)
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(observed.message).toBe("journal scan bound of 10,000,000 bytes reached; inspect, then archive the journal manually")
			expect(readState(root)).toEqual(before)
		}
		// Readers still run on an over-bound journal; recover with a consumed plan reports an incomplete inventory.
		const reader = fresh("partial-after-halt")
		fillJournal(reader, SCAN_BOUND + 1)
		seedJournal(reader, `${PARTIAL_APPLY_FRAMES}${readState(reader).journal}`)
		expect((await machine(reader, ["status"])).envelope.outcome).toBe("success")
		const incomplete = await machine(reader, ["recover"])
		check(incomplete, { ...recoverUnknown, handoff: [J] })
		expect(incomplete.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: false })
		const humanRoot = fresh("healthy-with-fresh-preview")
		fillJournal(humanRoot, SCAN_BOUND + 1)
		const humanRun = await human(humanRoot, AUTHORIZED_APPLY)
		expect(humanRun).toMatchObject({ exit: 3, stdout: "", signal: null })
		expect(lines(humanRun.stderr)).toEqual(["apply refused: journal scan bound of 10,000,000 bytes reached; inspect, then archive the journal manually"])
		// Exactly 10,000,000 bytes is inside the bound: the apply lands, its frames cross the bound, and only then do the
		// next writer refuse and recovery report an incomplete inventory. Nothing is rotated or pruned.
		const exact = fresh("healthy-with-fresh-preview")
		fillJournal(exact, SCAN_BOUND, true)
		const filler = readState(exact).journal
		expect(Buffer.byteLength(filler, "utf8")).toBe(SCAN_BOUND)
		const applied = await machine(exact, AUTHORIZED_APPLY)
		expect(applied.envelope).toMatchObject({ outcome: "success", transactionState: "completed" })
		const runId = applied.envelope.runId as string
		expect(readState(exact)).toEqual({ resource: REVISION_5_HEALTHY, preview: consumedPreview("apply", runId), journal: `${filler}${completedJournal("apply", runId)}` })
		const afterCrossing = await machine(exact, ["recover"])
		check(afterCrossing, { ...recoverUnknown, handoff: [U, J] })
		expect(afterCrossing.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [U, J], inventoryComplete: false })
		check(await machine(exact, ["apply", "--preview"]), limit("repair-lab.preview"))
		expect(readState(exact).journal).toBe(`${filler}${completedJournal("apply", runId)}`)
		retainRecoveryEvidence("o1-a5-exact-bound", { applied: { stdout: applied.run.stdout, exit: applied.run.exit }, recover: afterCrossing.run.stdout, journalBytes: Buffer.byteLength(readState(exact).journal, "utf8") })
	}, 120_000)

	test("O1 A7 prior-run refusal: an unresolved consumed plan blocks every writer with DOMAIN_PRIOR_RUN_PENDING and preserves the recovery inventory; a resolved plan does not", async () => {
		const rows: Array<[string[], string]> = [
			[["apply", "--preview"], "repair-lab.preview"],
			[["repair", "--preview"], "repair-lab.repair"],
			[["apply", "--preview-id", "preview-partial-revision-4", "--authorize", "fixture-authority"], "repair-lab.apply"],
			[["apply", "--preview-id", "preview-other", "--authorize", "fixture-authority"], "repair-lab.apply"],
			[AUTHORIZED_REPAIR, "repair-lab.repair"],
			[RETRY_REPAIR, "repair-lab.repair-retry"],
		]
		for (const [argv, identity] of rows) {
			const root = fresh("partial-after-halt")
			const before = readState(root)
			const observed = await machine(root, argv)
			check(observed, priorRunPending(identity))
			expect(observed.envelope.handoff).toEqual({ owner: "operator", reason: PRIOR_RUN_REASON, inspect: [INSPECT] })
			expect(observed.envelope.repairAction).toBe("run repair-lab recover; do not retry automatically")
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(readState(root)).toEqual(before)
		}
		// Authority still precedes the prior-run check; a torn tail still precedes it as the schema refusal.
		check(await machine(fresh("partial-after-halt"), ["apply", "--preview-id", "preview-partial-revision-4"]), domain("repair-lab.apply", "DOMAIN_AUTHORITY_MISSING", "repository-local"))
		check(await machine(fresh("unknown-after-partial"), ["apply", "--preview"]), schemaRefusal("repair-lab.preview", "repository-local"))
		const humanRoot = fresh("partial-after-halt")
		const humanRun = await human(humanRoot, ["apply", "--preview"])
		expect(humanRun).toMatchObject({ exit: 3, stdout: "", signal: null })
		expect(lines(humanRun.stderr)).toEqual(["apply refused: a prior run's consumed plan has unresolved effects; run repair-lab recover"])
		// Candidate B: the crash lock refuses first. Only explicit operator removal after the child has exited permits
		// the existing prior-run check; the consumed preview and independently observed effects survive both refusals.
		const crashed = fresh("healthy-with-fresh-preview")
		const halted = await runCli(crashed, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-after-effect:${U}` })
		expect(halted.signal).toBe("SIGKILL")
		const residue = readState(crashed)
		const locked = await machine(crashed, ["apply", "--preview"])
		check(locked, { ...priorRunPending("repair-lab.preview"), causeCode: "DOMAIN_JOURNAL_LOCK_HELD" })
		expect(readState(crashed)).toEqual(residue)
		retainRecoveryEvidence("o1-a7-crash-lock", receiptOf(crashed, locked.run))
		rmSync(join(crashed.root, "state", "journal.lock")) // Explicit operator action after observing SIGKILL completion.
		check(await machine(crashed, ["apply", "--preview"]), priorRunPending("repair-lab.preview"))
		expect(readState(crashed)).toEqual(residue)
		// Resolved plans: after explicit crash-lock removal, fully not applied and fully completed admit a fresh preview.
		const aborted = fresh("healthy-with-fresh-preview")
		expect((await runCli(aborted, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-before-effect:${U}` })).signal).toBe("SIGKILL")
		check(await machine(aborted, ["apply", "--preview"]), { ...priorRunPending("repair-lab.preview"), causeCode: "DOMAIN_JOURNAL_LOCK_HELD" })
		rmSync(join(aborted.root, "state", "journal.lock")) // Explicit operator action after observing SIGKILL completion.
		const abortedPreview = await machine(aborted, ["apply", "--preview"])
		check(abortedPreview, { identity: "repair-lab.preview", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
		expect(JSON.parse(readState(aborted).preview as string)).toEqual({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: [U, J], consumed: false })
		const completed = fresh("healthy-with-fresh-preview")
		expect((await machine(completed, AUTHORIZED_APPLY)).envelope.outcome).toBe("success")
		const completedPreview = await machine(completed, ["apply", "--preview"])
		expect(completedPreview.result?.preview_id).toBe("preview-healthy-revision-5")
		retainRecoveryEvidence("o1-a7-crash-residue", receiptOf(crashed, halted))
	})

	test("O1 A8 atomic consumption: no temp residue after a run, consumed bytes and lock after a halt, and refused lock creation leaves the preview unconsumed", async () => {
		const normal = fresh("healthy-with-fresh-preview")
		expect((await machine(normal, AUTHORIZED_APPLY)).envelope.outcome).toBe("success")
		expect(stateEntries(normal)).toEqual(["journal.jsonl", "preview.json", "resource.json"])
		const halted = fresh("healthy-with-fresh-preview")
		const run = await runCli(halted, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-before-effect:${U}` })
		expect(run.signal).toBe("SIGKILL")
		const haltedRun = (JSON.parse(readState(halted).preview as string) as { consumed_by_run: string }).consumed_by_run
		expect(readState(halted).preview).toBe(consumedPreview("apply", haltedRun))
		expect(stateEntries(halted)).toEqual(["journal.jsonl", "journal.lock", "preview.json", "resource.json"])
		// Candidate B admits the exclusive lock before preview consumption. A directory that admits no new entry now
		// fails before any durable domain write, so the result is unchanged and recovery finds nothing pending.
		const readOnly = fresh("healthy-with-fresh-preview")
		const before = readState(readOnly)
		chmodSync(join(readOnly.root, "state"), 0o500)
		try {
			const observed = await machine(readOnly, AUTHORIZED_APPLY)
			check(observed, { identity: "repair-lab.apply", outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED", exit: 1, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: null })
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true })
			expect(readState(readOnly)).toEqual(before)
			expect(stateEntries(readOnly)).toEqual(["journal.jsonl", "preview.json", "resource.json"])
			retainRecoveryEvidence("o1-a8-read-only-state", receiptOf(readOnly, observed.run))
		} finally {
			chmodSync(join(readOnly.root, "state"), 0o700)
		}
		const recovered = await machine(readOnly, ["recover"])
		check(recovered, recoverNothingPending)
		expect(projection(recovered)).toMatchObject({ result: "nothing-pending", consumed_preview_id: null, observed_completed_effect_ids: [], not_applied_effect_ids: [] })
		expect(readState(readOnly)).toEqual(before)
	})
})
