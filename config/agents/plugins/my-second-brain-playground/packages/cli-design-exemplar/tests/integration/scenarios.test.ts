import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	blockDiagnostics,
	createRoot,
	diagnosticsFiles,
	diagnosticsRecords,
	envelopeKeys,
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
// The fixture's handoff sentence with one prerequisite per actual remaining effect (brief 12, 8.1); row 11's literal
// is handoffLiteral([J]).
function handoffLiteral(remaining: string[]): { reason: string; prerequisites: string[] } {
	return {
		reason: "The fixture cannot prove whether the remaining effect committed.",
		prerequisites: ["Inspect state/journal.jsonl and state/resource.json by hand", ...remaining.map((id) => `Confirm whether ${id} committed`), "Reset the fixture from its snapshot before any new apply"],
	}
}
const HANDOFF = handoffLiteral(["effect.write-journal"])
// W2 (coordinator ruling, implementation01/w2-owner-resolution.md): presented outcome failed, existing domain cause
// INTERNAL_EFFECT_OUTCOME_UNKNOWN, trusted state unknown; its actual egress failure is failed|INTERNAL_RESULT_UNKNOWN.
const W2_TUPLE = "failed|INTERNAL_EFFECT_OUTCOME_UNKNOWN"
const W2_FALLBACK_TUPLE = "failed|INTERNAL_RESULT_UNKNOWN"
const EXPECTED_DISCOVERY = {
	name: "repair-lab",
	contractVersion: "1.0.0",
	generationConventionVersion: "1.0.0",
	identities: ["repair-lab.help", "repair-lab.discover", "repair-lab.status", "repair-lab.inspect", "repair-lab.inspect-diagnostics", "repair-lab.preview", "repair-lab.apply", "repair-lab.repair", "repair-lab.repair-retry", "repair-lab.recover"],
	exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "retryable-or-unavailable" },
	machineMode: "--json",
	logtape: true,
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

const roots: Root[] = []
function fresh(variant: Variant): Root {
	const created = createRoot(variant)
	roots.push(created)
	return created
}
afterEach(() => {
	for (const created of roots.splice(0)) removeRoot(created)
})

interface Machine {
	run: Run
	envelope: Record<string, unknown>
	result: Record<string, unknown> | null
}

async function machine(root: Root, argv: string[], fault?: string, env?: Record<string, string>): Promise<Machine> {
	const args = argv.includes("--json") ? argv : [...argv, "--json"]
	const run = await runCli(root, args, { ...(fault === undefined ? {} : { fault }), ...(env === undefined ? {} : { env }) })
	expect(run.stderr).toBe("")
	expect(run.stdout.split("\n").filter((line) => line.length > 0)).toHaveLength(1)
	const envelope = envelopeOf(run)
	expect(Object.keys(envelope)).toEqual(envelopeKeys())
	expect(envelope.envelopeVersion).toBe(1)
	expect(envelope.contractVersion).toBe("1.0.0")
	expect(envelope.runIdentity).toMatch(/^run-[0-9a-f-]{36}$/)
	return { run, envelope, result: envelope.result as Record<string, unknown> | null }
}

function check(observed: Machine, expected: Expected): void {
	const { envelope, run } = observed
	expect(run.exit).toBe(expected.exit)
	expect(envelope.commandIdentity).toBe(expected.identity)
	expect(envelope.outcome).toBe(expected.outcome)
	expect(envelope.failureClass).toBe(expected.failureClass)
	expect(envelope.causeCode).toBe(expected.causeCode)
	expect(envelope.effectClass).toBe(expected.effectClass)
	expect(envelope.transactionState).toBe(expected.transactionState)
	expect(envelope.retryable).toBe(expected.retryable)
	expect(envelope.retryDelayMilliseconds).toBe(expected.delay)
	expect(envelope.nextAction).toBe(expected.nextAction)
	expect(typeof envelope.message).toBe("string")
	expect((envelope.message as string).length).toBeGreaterThan(0)
	if (expected.handoff !== undefined) {
		expect(envelope.handoff).toEqual(handoffLiteral(expected.handoff))
		expect(envelope.nextAction).toBeNull()
	} else expect(envelope.handoff).toBeNull()
	if (expected.outcome !== "success") expect((envelope.nextAction !== null) !== (envelope.handoff !== null)).toBe(true)
	const paths = envelope.availablePaths as string[]
	expect(paths.slice(0, 2)).toEqual([HELP, DISCOVER].slice(0, paths.length))
	if (expected.nextAction !== null && expected.nextAction !== HELP) expect(paths).toContain(expected.nextAction)
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
	return JSON.parse(JSON.stringify(normalize(observed.run.stdout, observed.envelope.runIdentity as string)).split(root.root).join("<root>")) as Record<string, unknown>
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
	test("--help --json is a success envelope with usage and example", async () => {
		const observed = await machine(fresh("healthy"), ["--help"])
		check(observed, { identity: "repair-lab.help", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: null })
		expect(observed.result?.usage).toBe("repair-lab <command> [options] [--json]")
		expect(observed.result?.example).toBe("repair-lab status --json")
	})
	test("--discover --json lists ten commands, six exit keys, machineMode and logtape true", async () => {
		const observed = await machine(fresh("healthy"), ["--discover"])
		check(observed, { identity: "repair-lab.discover", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: null })
		const document = observed.result as { name: string; contractVersion: string; generationConventionVersion: string; commands: Array<{ identity: string; argv: string; effectClass: string; description: string }>; exitMeanings: Record<string, string>; machineMode: string; logtape: boolean }
		expect(Object.keys(document).sort()).toEqual(["commands", "contractVersion", "exitMeanings", "generationConventionVersion", "logtape", "machineMode", "name"])
		expect(document.name).toBe(EXPECTED_DISCOVERY.name)
		expect(document.contractVersion).toBe(EXPECTED_DISCOVERY.contractVersion)
		expect(document.generationConventionVersion).toBe(EXPECTED_DISCOVERY.generationConventionVersion)
		expect(document.commands.map((command) => command.identity)).toEqual(EXPECTED_DISCOVERY.identities)
		for (const command of document.commands) expect(Object.keys(command).sort()).toEqual(["argv", "description", "effectClass", "identity"])
		expect(document.exitMeanings).toEqual(EXPECTED_DISCOVERY.exitMeanings)
		expect(document.machineMode).toBe(EXPECTED_DISCOVERY.machineMode)
		expect(document.logtape).toBe(true)
	})
	test("--discover without --json prints the same facts as text", async () => {
		const run = await human(fresh("healthy"), ["--discover"])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout).toContain("name: repair-lab\n")
		expect(run.stdout).toContain("exit 75: retryable-or-unavailable\n")
		expect(run.stdout).toContain("logtape: true\n")
		expect(lines(run.stdout).filter((line) => line.startsWith("command: "))).toHaveLength(10)
	})
	test("no arguments: exit 2, empty stdout, one stderr line naming --help", async () => {
		const run = await human(fresh("healthy"), [])
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toHaveLength(1)
		expect(run.stderr).toContain("--help")
	})
	test("--json alone is a USAGE_COMMAND_REQUIRED refusal with the help identity", async () => {
		const observed = await machine(fresh("healthy"), ["--json"])
		check(observed, usage("repair-lab.help", "USAGE_COMMAND_REQUIRED", "inspect"))
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
			[["--discover"], "repair-lab.discover", "inspect"],
			[["apply", "--preview"], "repair-lab.preview", "repository-local"],
			[["recover"], "repair-lab.recover", "repository-local"],
			[["inspect"], "repair-lab.inspect", "inspect"],
			[["inspect", "--include-diagnostics"], "repair-lab.inspect-diagnostics", "inspect"],
			[["apply"], "repair-lab.apply", "repository-local"],
			[["repair"], "repair-lab.repair", "repository-local"],
			[["repair", "--apply", "--retry-once"], "repair-lab.repair-retry", "repository-local"],
			[[], "repair-lab.help", "inspect"],
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
	// A usage refusal happens before root resolution, diagnostics or any state read: no diagnostics file, state byte-identical.
	async function expectNoEffect(root: Root, before: ReturnType<typeof readState>): Promise<void> {
		expect(diagnosticsFiles(root)).toEqual([])
		expect(readState(root)).toEqual(before)
	}
	test("flag-only help and discovery routes reject extra known options and positionals before success dispatch (PR 184, 4005104686)", async () => {
		const rows: Array<[string[], string]> = [
			[["--help", "--apply"], "repair-lab.help"],
			[["--help", "extra"], "repair-lab.help"],
			[["--discover", "--state", "state/resource.json"], "repair-lab.discover"],
			[["--discover", "extra"], "repair-lab.discover"],
		]
		for (const [argv, identity] of rows) {
			const root = fresh("healthy")
			const before = readState(root)
			const observed = await machine(root, argv)
			check(observed, usage(identity, "USAGE_INVALID_ARGUMENTS", "inspect"))
			expect(observed.result).toBeNull()
			await expectNoEffect(root, before)
		}
		const root = fresh("healthy")
		const before = readState(root)
		const run = await human(root, ["--discover", "--state", "state/resource.json"])
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toHaveLength(1)
		expect(run.stderr).toContain("--help")
		await expectNoEffect(root, before)
	})
	test("a known option with a missing or option-like value is USAGE_INVALID_ARGUMENTS on the routed identity, never unknown-option (PR 184, 4003813436)", async () => {
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
			// machine() appends --json, so a trailing string option sees an option-like value; both shapes are malformed values.
			const observed = await machine(root, argv)
			check(observed, usage(identity, "USAGE_INVALID_ARGUMENTS", effectClass))
			expect(observed.result).toBeNull()
			await expectNoEffect(root, before)
		}
		const root = fresh("healthy")
		const run = await human(root, ["inspect", "--state"])
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toHaveLength(1)
		expect(run.stderr).toContain("--help")
		expect(diagnosticsFiles(root)).toEqual([])
	})
	test("route grammar: extra positionals and options outside the route's declared shape are refused before any effect (PR 184, 4003813481)", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"]]> = [
			["healthy", ["status", "extra"], "repair-lab.status", "inspect"],
			["healthy", ["status", "--apply"], "repair-lab.status", "inspect"],
			["healthy", ["status", "--state", "state/resource.json"], "repair-lab.status", "inspect"],
			["healthy", ["inspect", "extra"], "repair-lab.inspect", "inspect"],
			["healthy", ["inspect", "--preview"], "repair-lab.inspect", "inspect"],
			["healthy", ["inspect", "--include-diagnostics", "--authorize", "fixture-authority"], "repair-lab.inspect-diagnostics", "inspect"],
			["healthy", ["apply", "--preview", "extra"], "repair-lab.preview", "repository-local"],
			["healthy", ["apply", "--preview", "--preview-id", "preview-healthy-revision-4"], "repair-lab.preview", "repository-local"],
			["healthy", ["apply", "--preview", "--automation"], "repair-lab.preview", "repository-local"],
			["healthy-with-fresh-preview", [...AUTHORIZED_APPLY, "extra"], "repair-lab.apply", "repository-local"],
			["healthy-with-fresh-preview", [...AUTHORIZED_APPLY, "--state", "state/resource.json"], "repair-lab.apply", "repository-local"],
			["healthy-with-fresh-preview", [...AUTHORIZED_APPLY, "--retry-once"], "repair-lab.apply", "repository-local"],
			["derived-index-missing", ["repair"], "repair-lab.repair", "repository-local"],
			["derived-index-missing", ["repair", "--preview", "--apply"], "repair-lab.repair", "repository-local"],
			["derived-index-missing", ["repair", "--preview", "--preview-id", "repair-preview-missing-index"], "repair-lab.repair", "repository-local"],
			["derived-index-missing-with-fresh-preview", [...AUTHORIZED_REPAIR, "extra"], "repair-lab.repair", "repository-local"],
			["derived-index-missing-with-fresh-preview", [...AUTHORIZED_REPAIR, "--include-diagnostics"], "repair-lab.repair", "repository-local"],
			["derived-index-missing-with-fresh-preview", [...RETRY_REPAIR, "--preview-id", "repair-preview-missing-index"], "repair-lab.repair-retry", "repository-local"],
			["derived-index-missing-with-fresh-preview", [...RETRY_REPAIR, "extra"], "repair-lab.repair-retry", "repository-local"],
			["unknown-after-partial", ["recover", "extra"], "repair-lab.recover", "repository-local"],
			["unknown-after-partial", ["recover", "--authorize", "fixture-authority"], "repair-lab.recover", "repository-local"],
		]
		for (const [variant, argv, identity, effectClass] of rows) {
			const root = fresh(variant)
			const before = readState(root)
			const observed = await machine(root, argv)
			check(observed, usage(identity, "USAGE_INVALID_ARGUMENTS", effectClass))
			expect(observed.result).toBeNull()
			await expectNoEffect(root, before)
		}
		const root = fresh("healthy")
		const before = readState(root)
		const run = await human(root, ["status", "extra"])
		expect(run.exit).toBe(2)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toHaveLength(1)
		expect(run.stderr).toContain("--help")
		await expectNoEffect(root, before)
		// Grammar is judged on the routed shape, so the declared shapes still reach their stations.
		expect((await machine(fresh("healthy"), ["inspect", "--state", "state/resource.json"])).envelope.outcome).toBe("success")
		expect((await machine(fresh("healthy"), ["inspect", "--include-diagnostics", "--state", "state/resource.json"])).envelope.outcome).toBe("success")
	})
	test("REPAIR_LAB_ROOT selects the fixture root when the process runs elsewhere", async () => {
		const root = fresh("healthy")
		const run = await runCli(root, ["status", "--json"], { cwd: root.privateRoot, env: { REPAIR_LAB_ROOT: root.root } })
		expect(run.exit).toBe(0)
		expect((envelopeOf(run).result as Record<string, unknown>).result).toBe("healthy")
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
		check(observed, { identity: "repair-lab.preview", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: false, delay: null, nextAction: "repair-lab apply --preview-id preview-healthy-revision-4 --authorize fixture-authority" })
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
		expect(projection(observed)).toEqual({ result: "path-refused", station_id: "repair-lab.hostile-input", transaction_state: "unchanged", path_escape: false })
		expect(observed.envelope.repairAction).toBe("inspect: provide a state path inside the fixture root")
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
		const resource = (envelope.result as { resource: Record<string, unknown> }).resource
		expect(resource.payload).toBe(largePayload())
		resource.payload = "<payload>"
		const runIdentity = envelope.runIdentity as string
		expect(normalize(JSON.stringify(envelope), runIdentity)).toEqual({
			envelopeVersion: 1,
			contractVersion: "1.0.0",
			commandIdentity: "repair-lab.inspect",
			runIdentity: "run-NORMALIZED",
			outcome: "success",
			failureClass: null,
			causeCode: null,
			message: "inspection ready",
			effectClass: "inspect",
			transactionState: "unchanged",
			retryable: true,
			retryDelayMilliseconds: null,
			nextAction: "repair-lab apply --preview",
			availablePaths: [HELP, DISCOVER, "repair-lab apply --preview"],
			repairAction: null,
			handoff: null,
			result: { result: "inspected", station_id: "repair-lab.inspect", effect_ids: [], resource: { resource: "demo", revision: 4, status: "healthy", version: 1, payload: "<payload>" }, diagnostics: { file: join(root.root, "diagnostics", "run-NORMALIZED.jsonl"), sinkFailure: null, droppedRecords: 0 } },
		})
	})
	test("every egress fault on status --json yields one valid status|failed|INTERNAL_RESULT_UNCHANGED envelope", async () => {
		const faults = [...NON_JSON.map((variant) => `egress-non-json:${variant}`), ...SCHEMA_INVALID.map((variant) => `egress-schema-invalid:${variant}`)]
		for (const fault of faults) {
			const observed = await machine(fresh("healthy"), ["status"], fault)
			check(observed, fallback("repair-lab.status", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
			expect(observed.result?.stage).toBe("candidate")
			expect(observed.result?.domain_outcome).toBe("success")
			expect(observed.result?.station_id).toBe("repair-lab.envelope-invalid")
			expect(observed.result?.completed_effect_ids).toEqual([])
			expect(observed.result?.remaining_effect_ids).toEqual([])
			expect((observed.result?.issues as string[]).length).toBeGreaterThan(0)
		}
		// F10: a success candidate carrying both guidance fields is malformed too (never both, on every outcome).
		check(await machine(fresh("healthy"), ["apply", "--automation"], "egress-schema-invalid:both-guidance"), fallback("repair-lab.apply", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
	})
	test("a real internal failure with no fault set takes the same fallback path (W1 then egress)", async () => {
		const observed = await machine(fresh("healthy"), ["status"], "throw-internal+egress-non-json:cycle")
		check(observed, fallback("repair-lab.status", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		expect(observed.result?.domain_outcome).toBe("failed")
		const plain = await machine(fresh("healthy"), ["status"], "throw-internal")
		check(plain, { identity: "repair-lab.status", outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED", exit: 1, effectClass: "inspect", transactionState: "unchanged", retryable: false, delay: null, nextAction: INSPECT })
	})
	test("egress fallback rows of the read-only routes carry unchanged and inspect guidance", async () => {
		const cycle = "egress-non-json:cycle"
		check(await machine(fresh("healthy"), ["--help"], cycle), fallback("repair-lab.help", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["--json"], cycle), fallback("repair-lab.help", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["--discover"], cycle), fallback("repair-lab.discover", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect"], cycle), fallback("repair-lab.inspect", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("checker-target"), ["inspect", "--state", "state/large.json"], cycle), fallback("repair-lab.inspect", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect", "--state", "../../outside-root-sentinel"], cycle), fallback("repair-lab.inspect", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect", "--state", "state/missing.json"], cycle), fallback("repair-lab.inspect", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["apply", "--preview"], cycle), fallback("repair-lab.preview", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", INSPECT))
	})
	test("routed unknown-option refusals: fault-free first, then the same argv with the egress fault", async () => {
		const rows: Array<[string[], string, Expected["effectClass"]]> = [
			[["status"], "repair-lab.status", "inspect"],
			[["--discover"], "repair-lab.discover", "inspect"],
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
		expect(projection(observed)).toEqual({ result: "stale-preview", station_id: "repair-lab.stale-preview", transaction_state: "unchanged", completed_effect_ids: [], remaining_effect_ids: [U, J], preview_revision: 4, resource_revision: 5 })
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
		expect(projection(observed)).toEqual({ result: "unknown-outcome", station_id: "repair-lab.partial-unknown", transaction_state: "unknown", completed_effect_ids: [U], remaining_effect_ids: [J], retry_safety: "unsafe", human_handoff: true })
	})
	test("row 7 prohibited automation and the authority step: refused before any preview lookup", async () => {
		const root = fresh("healthy")
		const run = await human(root, ["apply", "--automation"])
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["apply refused: fixture-local authority is required; inspect or hand off"])
		const observed = await machine(root, ["apply", "--automation"])
		check(observed, domain("repair-lab.apply", "DOMAIN_AUTHORITY_MISSING", "repository-local"))
		expect(projection(observed)).toEqual({ result: "automation-refused", station_id: "repair-lab.prohibited-automation", transaction_state: "unchanged", effect_attempted: false, human_handoff: false })
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
	test("ordinary mutation preview identity binding: omitted or mismatching ids refuse without effects", async () => {
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
			check(observed, domain(identity, "DOMAIN_PREVIEW_MISSING", "repository-local", `repair-lab ${command} --preview`))
			expect(observed.result?.reason).toBe("mismatch")
			expect(journalRecords(root)).toEqual([])
			await expectUnchanged(root, before)
		}
	})
	test("preview presence, identity binding, route agreement and expected-effect binding all refuse as DOMAIN_PREVIEW_MISSING", async () => {
		const absent = await machine(fresh("healthy"), AUTHORIZED_APPLY)
		check(absent, domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab apply --preview"))
		expect(absent.result?.reason).toBe("absent")
		const mismatch = await machine(fresh("healthy-with-fresh-preview"), ["apply", "--preview-id", "preview-other", "--authorize", "fixture-authority"])
		check(mismatch, domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab apply --preview"))
		expect(mismatch.result?.reason).toBe("mismatch")
		check(await machine(fresh("derived-index-missing-with-apply-preview"), RETRY_REPAIR), domain("repair-lab.repair-retry", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab repair --preview"))
		check(await machine(fresh("healthy-with-repair-preview"), ["apply", "--preview-id", "repair-preview-missing-index", "--authorize", "fixture-authority"]), domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab apply --preview"))
		check(await machine(fresh("derived-index-missing-with-apply-preview"), ["repair", "--apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority"]), domain("repair-lab.repair", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab repair --preview"))
		const rootEffects = fresh("healthy-with-mismatched-effects-preview")
		const before = readState(rootEffects)
		check(await machine(rootEffects, AUTHORIZED_APPLY), domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab apply --preview"))
		await expectUnchanged(rootEffects, before)
		check(await machine(fresh("derived-index-missing-with-mismatched-effects-preview"), AUTHORIZED_REPAIR), domain("repair-lab.repair", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab repair --preview"))
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
		check(observed, { ...domain("repair-lab.repair", "DOMAIN_REPAIR_REQUIRED", "repository-local"), nextAction: "repair-lab repair --apply --preview-id repair-preview-missing-index --authorize fixture-authority" })
		expect(observed.envelope.repairAction).toBe("repair")
		expect(projection(observed)).toEqual({ result: "repair-required", station_id: "repair-lab.repairable-precondition", transaction_state: "unchanged", repair_action: "repair", preview_effect_ids: [R, J], preview_id: "repair-preview-missing-index", repair_is_authorized: false })
		const notRequired = await machine(fresh("healthy"), ["repair", "--preview"])
		check(notRequired, domain("repair-lab.repair", "DOMAIN_REPAIR_NOT_REQUIRED", "repository-local"))
		expect(notRequired.envelope.repairAction).toBeNull()
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
		expect(busy.result?.retry_count).toBe(0)
		await expectUnchanged(root, before)
		const persistent = await machine(root, RETRY_REPAIR, "persistent-lock")
		check(persistent, { identity: "repair-lab.repair-retry", outcome: "refused", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY", exit: 75, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: 25, nextAction: "retry the same command after 25 ms" })
		expect(persistent.result?.retry_count).toBe(1)
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
		expect(envelopeOf(observed.run).handoff).toEqual(HANDOFF)
		expect(projection(observed)).toEqual({ result: "handoff-required", station_id: "repair-lab.required-handoff", transaction_state: "unknown", next_action: null, fabricated_action: false, completed_effect_ids: [U], remaining_effect_ids: [J], resource_revision: 5, human_handoff: true })
		await expectUnchanged(root, before)
		const nothing = await machine(fresh("healthy"), ["recover"])
		check(nothing, { identity: "repair-lab.recover", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT })
		expect(nothing.result?.result).toBe("nothing-pending")
	})
	// Seeded recovery state (PR 184, 4003813581): a consumed preview whose journal claims the whole plan, with the resource
	// varied independently. Every literal is authored here; nothing is read from the runtime.
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
	test("recover claims nothing-pending only when the scoped completions and the resource read-back agree; any disagreement is the handoff with no replay (PR 184, 4003813581)", async () => {
		const agreeing = fresh("healthy")
		seedRecovery(agreeing, "apply", { revision: 5, status: "healthy" }, 5)
		const agreed = await machine(agreeing, ["recover"])
		check(agreed, { identity: "repair-lab.recover", outcome: "success", failureClass: null, causeCode: null, exit: 0, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: null, nextAction: INSPECT })
		expect(projection(agreed)).toEqual({ result: "nothing-pending", station_id: "repair-lab.nothing-pending", transaction_state: "unchanged", observed_resource_revision: 5 })
		const repairAgreeing = fresh("healthy")
		seedRecovery(repairAgreeing, "repair", { revision: 5, status: "healthy" }, 5)
		expect((await machine(repairAgreeing, ["recover"])).result?.result).toBe("nothing-pending")
		const disagreements: Array<["apply" | "repair", { revision: number; status: "healthy" | "index-missing" }, number, string[]]> = [
			["apply", { revision: 4, status: "healthy" }, 5, [U, J]],
			["apply", { revision: 6, status: "healthy" }, 5, [U, J]],
			["repair", { revision: 5, status: "index-missing" }, 5, [R, J]],
			["repair", { revision: 4, status: "index-missing" }, 5, [R, J]],
		]
		for (const [kind, resource, claimed, plan] of disagreements) {
			const root = fresh("healthy")
			seedRecovery(root, kind, resource, claimed)
			const before = readState(root)
			const observed = await machine(root, ["recover"])
			check(observed, { identity: "repair-lab.recover", outcome: "unknown", failureClass: "domain", causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", exit: 3, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: null, handoff: plan })
			expect(projection(observed)).toEqual({ result: "handoff-required", station_id: "repair-lab.required-handoff", transaction_state: "unknown", next_action: null, fabricated_action: false, completed_effect_ids: [], remaining_effect_ids: plan, resource_revision: resource.revision, human_handoff: true })
			await expectUnchanged(root, before)
			const text = await human(root, ["recover"])
			expect(text.exit).toBe(3)
			expect(lines(text.stderr)).toEqual(["handoff required: the remaining effect outcome is unknown; no safe automatic action is available"])
			await expectUnchanged(root, before)
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
		expect(recovered.result?.completed_effect_ids).toEqual([])
		expect(recovered.result?.remaining_effect_ids).toEqual([U, J])
		expect(recovered.result?.resource_revision).toBe(4)
		const after = fresh("healthy-with-fresh-preview")
		const haltedAfter = await runCli(after, [...AUTHORIZED_APPLY, "--json"], { fault: `halt-after-effect:${U}` })
		expect(haltedAfter.signal).toBe("SIGKILL")
		expect(journalRecords(after).map((record) => `${record.kind}:${record.effect}`)).toEqual([`intent:${U}`])
		expect(JSON.parse(readState(after).resource).revision).toBe(5)
		const recoveredAfter = await machine(after, ["recover"])
		expect(recoveredAfter.envelope.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
		expect(recoveredAfter.result?.completed_effect_ids).toEqual([])
		expect(recoveredAfter.result?.remaining_effect_ids).toEqual([U, J])
		expect(recoveredAfter.result?.resource_revision).toBe(5)
	})
	test("W4 silent no-op: an effect that returns without an observable change never records completion", async () => {
		const rows: Array<[Variant, string[], string, string | undefined]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", undefined],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", undefined],
		]
		for (const [variant, argv, identity] of rows) {
			const root = fresh(variant)
			const observed = await machine(root, argv, "silent-no-op")
			check(observed, { identity, outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_EFFECT_NOT_OBSERVED", exit: 1, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: RECOVER })
			expect(observed.result?.completed_effect_ids).toEqual([])
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
		expect(recovered.result?.completed_effect_ids).toEqual([U])
		expect(recovered.result?.remaining_effect_ids).toEqual([J])
		expect(recovered.result?.resource_revision).toBe(6)
	})
	test("F6: the storage probe (step 9) precedes expected-effect binding (step 10)", async () => {
		const root = fresh("healthy-with-mismatched-effects-preview")
		const before = readState(root)
		check(await machine(root, AUTHORIZED_APPLY, "one-transient-lock"), { identity: "repair-lab.apply", outcome: "refused", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY", exit: 75, effectClass: "repository-local", transactionState: "unchanged", retryable: true, delay: 25, nextAction: "retry the same command after 25 ms" })
		await expectUnchanged(root, before)
		check(await machine(root, AUTHORIZED_APPLY), domain("repair-lab.apply", "DOMAIN_PREVIEW_MISSING", "repository-local", "repair-lab apply --preview"))
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
			expect(tupleOf(observed)).toBe(W2_TUPLE)
			check(observed, { identity, outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", exit: 1, effectClass: "repository-local", transactionState: "unknown", retryable: false, delay: null, nextAction: RECOVER })
			expect(observed.result?.completed_effect_ids).toEqual([])
			expect(observed.result?.remaining_effect_ids).toEqual(plan)
			expect(journalRecords(root)).toEqual([])
			expect(readState(root).resource).toBe(resourceBefore)
			expect((JSON.parse(readState(root).preview as string) as { consumed: boolean }).consumed).toBe(true)
			const recovered = await machine(root, ["recover"])
			expect(recovered.envelope.causeCode).toBe("DOMAIN_RECOVERY_HANDOFF_REQUIRED")
			expect(recovered.result?.remaining_effect_ids).toEqual(plan)
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
		const observedCompleted = journalRecords(root).filter((record) => record.kind === "completed").map((record) => record.effect)
		const stateFromObservation = observedRevision === 5 && observedCompleted.length === 2 ? "completed" : "unchanged"
		expect({ transactionState: observed.envelope.transactionState, completed_effect_ids: observed.result?.completed_effect_ids }).toEqual({ transactionState: stateFromObservation, completed_effect_ids: observedCompleted })
		check(observed, fallback("repair-lab.apply", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", INSPECT))
		expect(observed.result?.domain_outcome).toBe("success")
		expect(observed.result?.completed_effect_ids).toEqual([U, J])
		expect(observed.result?.remaining_effect_ids).toEqual([])
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
		expect(automation.result?.domain_outcome).toBe("refused")
		expect(automation.result?.remaining_effect_ids).toEqual([])
		const root = fresh("revision-5-with-revision-4-preview")
		const before = readState(root)
		const stale = await machine(root, STALE_APPLY, "egress-non-json:cycle")
		check(stale, fallback("repair-lab.apply", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
		expect(stale.result?.completed_effect_ids).toEqual([])
		expect(stale.result?.remaining_effect_ids).toEqual([U, J])
		await expectUnchanged(root, before)
	})
	test("D6-c (d'): unknown facts, W2, W4 and W1 each map to their accepted fallback tuple; recover afterwards only reads", async () => {
		const partial = await machine(fresh("healthy-with-partial-preview"), PARTIAL_APPLY, "effect.write-journal-outcome-unknown+egress-non-json:cycle")
		check(partial, fallback("repair-lab.apply", "unknown", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", RECOVER))
		expect(partial.result?.completed_effect_ids).toEqual([U])
		expect(partial.result?.remaining_effect_ids).toEqual([J])
		const w2 = fresh("healthy-with-fresh-preview")
		readOnlyJournal(w2)
		const unknown = await machine(w2, AUTHORIZED_APPLY, "egress-non-json:cycle")
		expect(tupleOf(unknown)).toBe(W2_FALLBACK_TUPLE)
		check(unknown, fallback("repair-lab.apply", "failed", "INTERNAL_RESULT_UNKNOWN", "repository-local", "unknown", RECOVER))
		expect(unknown.result?.domain_outcome).toBe("failed")
		expect(unknown.result?.remaining_effect_ids).toEqual([U, J])
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
		expect(handoff.result?.remaining_effect_ids).toEqual([J])
		check(await machine(fresh("healthy"), ["recover"], "egress-non-json:cycle"), fallback("repair-lab.recover", "failed", "INTERNAL_RESULT_UNCHANGED", "repository-local", "unchanged", INSPECT))
		check(await machine(fresh("derived-index-missing-with-fresh-preview"), RETRY_REPAIR, "persistent-lock+egress-non-json:cycle"), fallback("repair-lab.repair-retry", "refused", "INTERNAL_PREPARATION", "repository-local", "unchanged", INSPECT))
		check(await machine(fresh("derived-index-missing-with-fresh-preview"), RETRY_REPAIR, "one-transient-lock+egress-non-json:cycle"), fallback("repair-lab.repair-retry", "failed", "INTERNAL_RESULT_COMPLETED", "repository-local", "completed", INSPECT))
	})
})

// Internal state containment (PR 184, 4003813337; CDS-PE-3): a pre-existing final-component symlink at a state path is
// refused as DOMAIN_PATH_ESCAPE by every route that would read or write it, before any durable write; the outside
// file's bytes are re-read independently afterwards and must be identical.
describe("containment", () => {
	const FRESH_APPLY_PREVIEW = `${JSON.stringify({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: [U, J], consumed: false })}\n`
	const FRESH_REPAIR_PREVIEW = `${JSON.stringify({ preview_id: "repair-preview-missing-index", kind: "repair", resource_revision: 4, expected_effect_ids: [R, J], consumed: false })}\n`
	const CONSUMED_PREVIEW = `${JSON.stringify({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: [U, J], consumed: true, consumed_by_run: "run-fixture" })}\n`
	const INDEX_MISSING = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'
	const REVISION_4 = '{"resource":"demo","revision":4,"status":"healthy","version":1}\n'
	function refused(identity: string, effectClass: Expected["effectClass"]): Expected {
		return domain(identity, "DOMAIN_PATH_ESCAPE", effectClass)
	}
	async function expectRefusedAndPreserved(root: Root, argv: string[], identity: string, effectClass: Expected["effectClass"], outside: string, outsideBytes: string, before: ReturnType<typeof readState>): Promise<void> {
		const observed = await machine(root, argv)
		check(observed, refused(identity, effectClass))
		expect(projection(observed)).toEqual({ result: "path-refused", station_id: "repair-lab.hostile-input", transaction_state: "unchanged", path_escape: false })
		expect(readFileSync(outside, "utf8")).toBe(outsideBytes)
		expect(readState(root)).toEqual(before)
	}
	test("preview.json symlink: every preview reader and writer refuses; the outside preview is neither written nor consumed", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"], string]> = [
			["healthy", ["apply", "--preview"], "repair-lab.preview", "repository-local", "outside-preview\n"],
			["derived-index-missing", ["repair", "--preview"], "repair-lab.repair", "repository-local", "outside-preview\n"],
			["healthy", AUTHORIZED_APPLY, "repair-lab.apply", "repository-local", FRESH_APPLY_PREVIEW],
			["derived-index-missing", AUTHORIZED_REPAIR, "repair-lab.repair", "repository-local", FRESH_REPAIR_PREVIEW],
			["derived-index-missing", RETRY_REPAIR, "repair-lab.repair-retry", "repository-local", FRESH_REPAIR_PREVIEW],
			["healthy", ["recover"], "repair-lab.recover", "repository-local", CONSUMED_PREVIEW],
		]
		for (const [variant, argv, identity, effectClass, bytes] of rows) {
			const root = fresh(variant)
			const outside = linkStateFile(root, "preview.json", bytes)
			const before = readState(root)
			await expectRefusedAndPreserved(root, argv, identity, effectClass, outside, bytes, before)
			expect(journalRecords(root)).toEqual([])
		}
		const root = fresh("healthy")
		const outside = linkStateFile(root, "preview.json", "outside-preview\n")
		const run = await human(root, ["apply", "--preview"])
		expect(run.exit).toBe(3)
		expect(run.stdout).toBe("")
		expect(lines(run.stderr)).toEqual(["apply refused: state path must remain inside the fixture root"])
		expect(readFileSync(outside, "utf8")).toBe("outside-preview\n")
	})
	test("journal.jsonl symlink: effect routes refuse before consuming the preview or appending intent; recover refuses too", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"]]> = [
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "repository-local"],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", "repository-local"],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", "repository-local"],
			["unknown-after-partial", ["recover"], "repair-lab.recover", "repository-local"],
		]
		for (const [variant, argv, identity, effectClass] of rows) {
			const root = fresh(variant)
			const outside = linkStateFile(root, "journal.jsonl", "")
			const before = readState(root)
			await expectRefusedAndPreserved(root, argv, identity, effectClass, outside, "", before)
			const preview = before.preview === null ? null : (JSON.parse(before.preview) as { consumed: boolean })
			if (variant !== "unknown-after-partial") expect(preview?.consumed).toBe(false)
		}
	})
	test("resource.json symlink: every routed identity refuses and the outside resource is untouched", async () => {
		const rows: Array<[Variant, string[], string, Expected["effectClass"], string]> = [
			["healthy", ["status"], "repair-lab.status", "inspect", REVISION_4],
			["healthy", ["inspect"], "repair-lab.inspect", "inspect", REVISION_4],
			["healthy", ["inspect", "--include-diagnostics"], "repair-lab.inspect-diagnostics", "inspect", REVISION_4],
			["healthy", ["apply", "--preview"], "repair-lab.preview", "repository-local", REVISION_4],
			["healthy-with-fresh-preview", AUTHORIZED_APPLY, "repair-lab.apply", "repository-local", REVISION_4],
			["derived-index-missing-with-fresh-preview", AUTHORIZED_REPAIR, "repair-lab.repair", "repository-local", INDEX_MISSING],
			["derived-index-missing-with-fresh-preview", RETRY_REPAIR, "repair-lab.repair-retry", "repository-local", INDEX_MISSING],
			["unknown-after-partial", ["recover"], "repair-lab.recover", "repository-local", REVISION_4],
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
		const runIdentity = observed.envelope.runIdentity as string
		expect(modeOf(join(root.root, "diagnostics"))).toBe(0o700)
		expect(diagnosticsFiles(root)).toEqual([`${runIdentity}.jsonl`])
		expect(modeOf(join(root.root, "diagnostics", `${runIdentity}.jsonl`))).toBe(0o600)
		expect(observed.result?.diagnostics).toEqual({ file: join(root.root, "diagnostics", `${runIdentity}.jsonl`), sinkFailure: null, droppedRecords: 0 })
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
		expect(observed.result?.diagnostics).toMatchObject({ sinkFailure: null, droppedRecords: 0 })
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
		expect(observed.result?.diagnostics).toMatchObject({ sinkFailure: null, droppedRecords: 8 })
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
			expect((blocked.result?.diagnostics as { sinkFailure: string }).sinkFailure.startsWith("open: ")).toBe(true)
			expect(comparable(blocked, unwritable)).toEqual(expected)
			expect(existsSync(join(unwritable.root, "diagnostics", `${blocked.envelope.runIdentity as string}.jsonl`))).toBe(false)
			const throwingRoot = fresh(variant)
			const throwing = await machine(throwingRoot, argv, "sink-throw")
			expect(throwing.run.exit).toBe(baseline.run.exit)
			expect((throwing.result?.diagnostics as { sinkFailure: string }).sinkFailure.startsWith("flush: ")).toBe(true)
			expect(comparable(throwing, throwingRoot)).toEqual(expected)
			const disposingRoot = fresh(variant)
			const disposing = await machine(disposingRoot, argv, "sink-dispose-throw")
			expect((disposing.result?.diagnostics as { sinkFailure: string }).sinkFailure.startsWith("dispose: ")).toBe(true)
			expect(comparable(disposing, disposingRoot)).toEqual(expected)
			// Resulting state compares with each process's run token normalized (consumed_by_run and journal run fields).
			const stateOf = (root: Root, runIdentity: string): string => JSON.stringify(readState(root)).split(runIdentity).join("run-NORMALIZED")
			expect(stateOf(unwritable, blocked.envelope.runIdentity as string)).toBe(stateOf(normal, baseline.envelope.runIdentity as string))
			expect(stateOf(throwingRoot, throwing.envelope.runIdentity as string)).toBe(stateOf(normal, baseline.envelope.runIdentity as string))
		}
	})
	test("deleting the diagnostics file leaves recover's domain decision, effect identities and guidance identical", async () => {
		const root = fresh("unknown-after-partial")
		const first = await machine(root, ["recover"])
		const { rmSync } = await import("node:fs")
		rmSync(join(root.root, "diagnostics", `${first.envelope.runIdentity as string}.jsonl`))
		const second = await machine(root, ["recover"])
		expect(normalize(second.run.stdout, second.envelope.runIdentity as string)).toEqual(normalize(first.run.stdout, first.envelope.runIdentity as string))
		expect(second.envelope.handoff).toEqual(HANDOFF)
		expect(diagnosticsFiles(root)).toEqual([`${second.envelope.runIdentity as string}.jsonl`])
	})
	test("inspect-diagnostics fallback rows carry unchanged and inspect guidance", async () => {
		check(await machine(fresh("secret-marker-in-diagnostic-field"), ["inspect", "--include-diagnostics"], "egress-non-json:cycle"), fallback("repair-lab.inspect-diagnostics", "failed", "INTERNAL_RESULT_UNCHANGED", "inspect", "unchanged", INSPECT))
		check(await machine(fresh("healthy"), ["inspect", "--include-diagnostics", "--state", "state/missing.json"], "egress-non-json:cycle"), fallback("repair-lab.inspect-diagnostics", "refused", "INTERNAL_PREPARATION", "inspect", "unchanged", INSPECT))
	})
})
