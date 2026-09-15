import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXPECTED_COMMAND_IDENTITIES } from "../helpers/command-identity-oracle.ts"
import {
	blockDiagnostics,
	createRoot,
	diagnosticsFiles,
	diagnosticsRecords,
	envelopeOf,
	journalRecords,
	largePayload,
	linkOutside,
	linkStateFile,
	modeOf,
	normalize,
	readOnlyJournal,
	readState,
	removeRoot,
	type Root,
	type Run,
	runCli,
	SECRET_MARKER,
	sentinelUntouched,
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
	transactionState: "unchanged" | "completed" | "unknown"
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
	const handoffCause = ["DOMAIN_AUTHORITY_REQUIRED", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "INTERNAL_EFFECT_OUTCOME_UNKNOWN", "INTERNAL_EFFECT_NOT_OBSERVED", "INTERNAL_UNEXPECTED", "INTERNAL_RESULT_UNCHANGED", "INTERNAL_RESULT_COMPLETED", "INTERNAL_RESULT_UNKNOWN"].includes(selected.causeCode ?? "")
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
	function seedRecovery(root: Root, kind: "apply" | "repair", resource: { revision: number; status: "healthy" | "index-missing" }, claimedRevision: number): void {
		const plan = kind === "apply" ? [U, J] : [R, J]
		const previewId = kind === "apply" ? "preview-healthy-revision-4" : "repair-preview-missing-index"
		const state = join(root.root, "state")
		writeFileSync(join(state, "resource.json"), `${JSON.stringify({ resource: "demo", revision: resource.revision, status: resource.status, version: 1 })}\n`)
		writeFileSync(join(state, "preview.json"), `${JSON.stringify({ preview_id: previewId, kind, resource_revision: 4, expected_effect_ids: plan, consumed: true, consumed_by_run: "run-fixture" })}\n`)
		const records = plan.flatMap((effect, index) => [
			{ kind: "intent", seq: index * 2 + 1, run: "run-fixture", effect, operation: kind, preview_id: previewId },
			{ kind: "completed", seq: index * 2 + 2, run: "run-fixture", effect, operation: kind, preview_id: previewId, resource_revision: claimedRevision },
		])
		writeFileSync(join(state, "journal.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
	}
	test("candidate2 recovery: mixed scoped completion revisions require handoff without replay", async () => {
		for (const kind of ["apply", "repair"] as const) {
			const root = fresh("healthy")
			seedRecovery(root, kind, { revision: 5, status: "healthy" }, 5)
			const plan = kind === "apply" ? [U, J] : [R, J]
			const contradiction = { kind: "completed", seq: 0, run: "run-fixture", effect: plan[0], operation: kind, preview_id: kind === "apply" ? "preview-healthy-revision-4" : "repair-preview-missing-index", resource_revision: 4 }
			const journal = join(root.root, "state", "journal.jsonl")
			writeFileSync(journal, `${JSON.stringify(contradiction)}\n${readFileSync(journal, "utf8")}`)
			const before = readState(root)
			const run = await runCli(root, ["recover", "--json"])
			retainRecoveryEvidence(`mixed-completion-revisions-${kind}`, { kind, run, before, after: readState(root) })
			const result = envelopeOf(run).result as Record<string, unknown>
			expect(run).toMatchObject({ exit: 3, stderr: "", signal: null })
			expect(result).toMatchObject({ commandIdentity: "repair-lab.recover", outcome: "failed", transactionState: "unknown", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", failureClass: "domain", exitCode: 3, retryable: false, data: null, effects: { completed: [], remaining: [], uncertain: plan, inventoryComplete: true }, handoff: { owner: "operator", inspect: ["repair-lab inspect"] } })
			expect(result.nextAction).toBeUndefined()
			expect(result.retryDelayMilliseconds).toBeUndefined()
			expect(readState(root)).toEqual(before)
		}
	})
	test("candidate2 recovery: post-consumption RuntimeRefusal is failed unknown with a complete uncertain inventory", async () => {
		const rows: Array<[Variant, string[], string, string[]]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", [U, J]],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", [R, J]],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", [R, J]],
		]
		for (const [variant, argv, identity, plan] of rows) {
			const root = fresh(variant)
			const state = join(root.root, "state")
			rmSync(join(state, "journal.jsonl"))
			// Real filesystem alias: the first intent append invalidates resource JSON after preview consumption.
			linkSync(join(state, "resource.json"), join(state, "journal.jsonl"))
			const before = readState(root)
			const run = await runCli(root, [...argv, "--json"])
			const after = readState(root)
			retainRecoveryEvidence(`post-consumption-runtime-refusal-${identity}`, { identity, run, before, after })
			const result = envelopeOf(run).result as Record<string, unknown>
			expect(run).toMatchObject({ exit: 1, stderr: "", signal: null })
			expect(result).toMatchObject({ commandIdentity: identity, outcome: "failed", transactionState: "unknown", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", failureClass: "internal", exitCode: 1, retryable: false, data: null, effects: { completed: [], remaining: [], uncertain: plan, inventoryComplete: true }, repairAction: "run repair-lab recover; do not retry automatically", handoff: { owner: "operator", reason: "a durable write was attempted and its outcome is not established", inspect: ["repair-lab inspect"] } })
			expect(result.nextAction).toBeUndefined()
			expect(result.retryDelayMilliseconds).toBeUndefined()
			expect(JSON.parse(after.preview as string)).toEqual({ ...JSON.parse(before.preview as string), consumed: true, consumed_by_run: result.runId })
			const intent = { kind: "intent", seq: 1, run: result.runId, effect: plan[0], operation: identity === "repair-lab.apply" ? "apply" : "repair", preview_id: JSON.parse(before.preview as string).preview_id }
			expect(after.resource).toBe(`${before.resource}${JSON.stringify(intent)}\n`)
			expect(after.journal).toBe(after.resource)
		}
	})
	test("recover reports nothing pending only when scoped completion records and resource read-back agree", async () => {
		for (const kind of ["apply", "repair"] as const) {
			const root = fresh("healthy")
			seedRecovery(root, kind, { revision: 5, status: "healthy" }, 5)
			const observed = await machine(root, ["recover"])
			check(observed, { identity: "repair-lab.recover", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT })
		}
		const disagreements: Array<["apply" | "repair", { revision: number; status: "healthy" | "index-missing" }, number, string[]]> = [
			["apply", { revision: 4, status: "healthy" }, 5, [U, J]],
			["apply", { revision: 6, status: "healthy" }, 5, [U, J]],
			["repair", { revision: 5, status: "index-missing" }, 5, [R, J]],
			["repair", { revision: 4, status: "index-missing" }, 5, [R, J]],
		]
		for (const [kind, resource, claimedRevision, plan] of disagreements) {
			const root = fresh("healthy")
			seedRecovery(root, kind, resource, claimedRevision)
			const before = readState(root)
			const observed = await machine(root, ["recover"])
			check(observed, { identity: "repair-lab.recover", outcome: "unknown", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", exit: 3, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null, handoff: plan })
			expect(observed.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: plan, inventoryComplete: true })
			expect(readState(root)).toEqual(before)
		}
	})
	test("write-ahead: halt before the effect leaves the intent and nothing else; halt after leaves no completion", async () => {
		const before = fresh("healthy-with-fresh-preview")
		const halted = await runCli(before, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-before-effect:${U}` })
		expect(halted.signal).toBe("SIGKILL")
		expect(halted.stdout).toBe("")
		expect(journalRecords(before).map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`])
		expect(readState(before).resource).toBe('{"resource":"demo","revision":4,"status":"healthy","version":1}\n')
		expect((JSON.parse(readState(before).preview as string) as { consumed: boolean }).consumed).toBe(true)
		const recovered = await machine(before, ["recover"])
		check(recovered, { identity: "repair-lab.recover", outcome: "unknown", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", exit: 3, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null, handoff: [U, J] })
			expect(recovered.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [U, J], inventoryComplete: true })
		const after = fresh("healthy-with-fresh-preview")
		const haltedAfter = await runCli(after, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-after-effect:${U}` })
		expect(haltedAfter.signal).toBe("SIGKILL")
		expect(journalRecords(after).map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`])
		expect(JSON.parse(readState(after).resource).revision).toBe(5)
		const recoveredAfter = await machine(after, ["recover"])
		expect(recoveredAfter.envelope.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
			expect(recoveredAfter.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [U, J], inventoryComplete: true })
	})
	test("W4 silent no-op: an effect that returns without an observable change never records completion", async () => {
		const rows: Array<[Variant, string[], string, string[]]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", [U, J]],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", [R, J]],
		]
		for (const [variant, argv, identity, uncertain] of rows) {
			const root = fresh(variant)
			const observed = await machine(root, argv, "silent-no-op")
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
		const recovered = await machine(root, ["recover"])
		check(recovered, { identity: "repair-lab.recover", outcome: "unknown", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", exit: 3, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null, handoff: [J] })
			expect(recovered.envelope.effects).toEqual({ completed: [U], remaining: [], uncertain: [J], inventoryComplete: true })
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
			const recovered = await machine(root, ["recover"])
			expect(recovered.envelope.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
			expect(recovered.envelope.effects).toEqual({ completed: [], remaining: [], uncertain: plan, inventoryComplete: true })
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
		expect(recovered.envelope.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
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
			const stateOf = (root: Root, runId: string): string => JSON.stringify(readState(root)).split(runId).join("run-NORMALIZED")
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
