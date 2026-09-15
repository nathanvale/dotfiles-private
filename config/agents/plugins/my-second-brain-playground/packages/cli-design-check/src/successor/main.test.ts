import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SuccessorRunReport } from "./runner.ts"
import { CHECKER_COMMANDS, CHECKER_DISCOVERY_DATA, CHECKER_HELP_DATA, CHECKER_VALUE_OPTIONS, FORMAT_CASES, HUMAN_DISCOVERY_CASES, PROCESS_EXIT_CASES, PUBLIC_BUNDLE_CASES, RETENTION_CASES, SEMANTIC_CASES, SUCCESSOR_ROWS } from "./specimen-manifest.ts"

interface ProcessResult {
	exitCode: number
	stdout: string
	stderr: string
}

interface CheckerEffects {
	completed: string[]
	remaining: string[]
	uncertain: string[]
	inventoryComplete: boolean
}

interface CheckerHandoff {
	owner: "operator"
	reason: string
	inspect: string[]
}

type CheckerGuidance = { nextAction: string; handoff?: never } | { nextAction?: never; handoff: CheckerHandoff }

interface CheckerEnvelope {
	envelopeVersion: 2
	contractVersion: "2.0.0"
	message: string
	availablePaths: string[]
	result: {
		runId: string
		commandIdentity: string
		outcome: "success" | "refused" | "failed"
		effectClass: "inspect" | "repository-local" | "external"
		transactionState: "unchanged" | "completed" | "partially-completed" | "unknown"
		causeCode: string
		failureClass: "usage" | "domain" | "schema" | "internal" | "transient" | null
		exitCode: number
		data: unknown
		retryable: boolean
		retryDelayMilliseconds?: number | undefined
		repairAction: string | null
		effects: CheckerEffects
	} & CheckerGuidance
}

type JsonRecord = Record<string, unknown>

const pluginDirectory = resolve(import.meta.dir, "../../../..")
const sourceEntry = resolve(import.meta.dir, "main.ts")
const publicLauncher = resolve(pluginDirectory, "bin/cli-design-check")
const fixturesRoot = resolve(import.meta.dir, "../../fixtures")
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix))
	temporaryDirectories.push(directory)
	return directory
}

function nonTestTypeScriptSources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) return nonTestTypeScriptSources(path)
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
	})
}

afterAll(() => {
	for (const directory of temporaryDirectories) {
		try {
			chmodSync(directory, 0o700)
		} catch {
			// A removed temporary directory needs no permission repair.
		}
		rmSync(directory, { recursive: true, force: true })
	}
})

async function runChecker(entry: "source" | "bundle", args: string[], env: Record<string, string> = {}): Promise<ProcessResult> {
	const command = entry === "source" ? ["bun", "run", sourceEntry, ...args] : [publicLauncher, ...args]
	const child = Bun.spawn(command, { cwd: pluginDirectory, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, stdout, stderr }
}

async function runCheckerWithZeroFileLimit(args: string[], env: Record<string, string> = {}): Promise<ProcessResult> {
	const child = Bun.spawn(["/bin/zsh", "-c", 'ulimit -f 0; exec bun run "$@"', "cli-design-check-test", sourceEntry, ...args], {
		cwd: pluginDirectory,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	})
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, stdout, stderr }
}

async function runTarget(args: readonly string[]): Promise<ProcessResult> {
	const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args, "--json"], {
		cwd: resolve(fixturesRoot, "successor-conformant"),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, stdout, stderr }
}

function targetCommand(mutation: string | null): string {
	return mutation === null ? "bun run src/cli.ts" : `env CLI_DESIGN_SUCCESSOR_MUTATION=${mutation} bun run src/cli.ts`
}

function matrixArgs(fixture: string, mutation: string | null, retainStreamsDirectory?: string, json = true): string[] {
	return [
		"--cwd", resolve(fixturesRoot, fixture),
		"--command", targetCommand(mutation),
		"--success-args", "success",
		"--missing-args", "missing",
		"--internal-args", "internal",
		"--schema-args", "schema",
		"--transient-args", "transient",
		...(retainStreamsDirectory === undefined ? [] : ["--retain-streams-dir", retainStreamsDirectory]),
		...(json ? ["--json"] : []),
	]
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, path: string): JsonRecord {
	if (!isRecord(value)) throw new Error(`${path} must be an object`)
	return value
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string") throw new Error(`${path} must be a string`)
	return value
}

function requireNonblankString(value: unknown, path: string): string {
	const text = requireString(value, path)
	if (text.trim().length === 0) throw new Error(`${path} must be nonblank`)
	return text
}

function requireStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${path} must be a string array`)
	return value
}

function requireHandoff(value: unknown, path: string): CheckerHandoff {
	const handoff = requireRecord(value, path)
	if (handoff.owner !== "operator") throw new Error(`${path}.owner is invalid`)
	requireNonblankString(handoff.reason, `${path}.reason`)
	const inspect = requireStringArray(handoff.inspect, `${path}.inspect`)
	if (inspect.length === 0 || inspect.some((entry) => entry.trim().length === 0)) throw new Error(`${path}.inspect must contain nonblank strings`)
	return handoff as unknown as CheckerHandoff
}

function requireCheckerEffects(result: JsonRecord): void {
	const effects = requireRecord(result.effects, "result.effects")
	requireStringArray(effects.completed, "result.effects.completed")
	requireStringArray(effects.remaining, "result.effects.remaining")
	requireStringArray(effects.uncertain, "result.effects.uncertain")
	if (typeof effects.inventoryComplete !== "boolean") throw new Error("result.effects.inventoryComplete is invalid")
}

function requireCheckerGuidance(result: JsonRecord): void {
	const hasNextAction = Object.hasOwn(result, "nextAction")
	const hasHandoff = Object.hasOwn(result, "handoff")
	if (hasNextAction === hasHandoff) throw new Error("result must contain exactly one guidance arm")
	if (hasNextAction) requireNonblankString(result.nextAction, "result.nextAction")
	else requireHandoff(result.handoff, "result.handoff")
}

function requireCheckerResult(value: unknown): JsonRecord {
	const result = requireRecord(value, "result")
	requireString(result.runId, "result.runId")
	requireString(result.commandIdentity, "result.commandIdentity")
	if (!["success", "refused", "failed"].includes(String(result.outcome))) throw new Error("result.outcome is invalid")
	if (!["inspect", "repository-local", "external"].includes(String(result.effectClass))) throw new Error("result.effectClass is invalid")
	if (!["unchanged", "completed", "partially-completed", "unknown"].includes(String(result.transactionState))) throw new Error("result.transactionState is invalid")
	requireString(result.causeCode, "result.causeCode")
	if (!(result.failureClass === null || ["usage", "domain", "schema", "internal", "transient"].includes(String(result.failureClass)))) throw new Error("result.failureClass is invalid")
	if (typeof result.exitCode !== "number" || typeof result.retryable !== "boolean") throw new Error("result exit or retry correlation is invalid")
	if (!(result.repairAction === null || typeof result.repairAction === "string")) throw new Error("result.repairAction is invalid")
	if (Object.hasOwn(result, "retryDelayMilliseconds") && typeof result.retryDelayMilliseconds !== "number") throw new Error("result.retryDelayMilliseconds is invalid")
	requireCheckerEffects(result)
	requireCheckerGuidance(result)
	return result
}

function parseEnvelope(stdout: string): CheckerEnvelope {
	const parsed: unknown = JSON.parse(stdout)
	const value = requireRecord(parsed, "envelope")
	if (value.envelopeVersion !== 2 || value.contractVersion !== "2.0.0") throw new Error("envelope identity is invalid")
	requireString(value.message, "message")
	requireStringArray(value.availablePaths, "availablePaths")
	requireCheckerResult(value.result)
	expect(stdout).toBe(`${JSON.stringify(value)}\n`)
	return value as unknown as CheckerEnvelope
}

function requireReport(value: unknown): SuccessorRunReport {
	const report = requireRecord(value, "result.data")
	requireString(report.runIdentity, "result.data.runIdentity")
	if (!Array.isArray(report.rows)) throw new Error("result.data.rows must be an array")
	for (const [index, candidate] of report.rows.entries()) {
		const row = requireRecord(candidate, `result.data.rows[${index}]`)
		requireString(row.scenario, `result.data.rows[${index}].scenario`)
		requireStringArray(row.findings, `result.data.rows[${index}].findings`)
		if (typeof row.passed !== "boolean") throw new Error(`result.data.rows[${index}].passed must be a boolean`)
	}
	if (typeof report.passedCount !== "number" || typeof report.failedCount !== "number") throw new Error("result.data counts are invalid")
	requireStringArray(report.skippedRows, "result.data.skippedRows")
	requireStringArray(report.observationExclusions, "result.data.observationExclusions")
	return report as unknown as SuccessorRunReport
}

function reportOf(run: ProcessResult): SuccessorRunReport {
	return requireReport(parseEnvelope(run.stdout).result.data)
}

function failedHumanRows(stdout: string): Array<{ scenario: string; findings: string[] }> {
	return stdout.split("\n").slice(1).flatMap((line) => {
		const cells = line.split(" | ")
		if (cells.length !== 7 || cells[3] !== "fail") return []
		return [{ scenario: cells[0] as string, findings: cells[4] === "-" ? [] : (cells[4] as string).split(", ") }]
	})
}

function expectConformant(run: ProcessResult): SuccessorRunReport {
	expect(run.exitCode).toBe(0)
	expect(run.stderr).toBe("")
	const report = reportOf(run)
	expect(report.rows.map((row) => row.scenario)).toEqual([...SUCCESSOR_ROWS])
	expect(report.failedCount).toBe(0)
	expect(report.passedCount).toBe(15)
	for (const row of report.rows) expect(row.findings).toEqual([])
	return report
}

test.each([...FORMAT_CASES])("CDS-CE-3 formats: $name", async (format) => {
	const run = await runChecker("source", matrixArgs(format.fixture, format.mutation))
	expect(run.exitCode).toBe(format.exit)
	expect(run.stderr).toBe("")
	const envelope = parseEnvelope(run.stdout)
	expect(envelope.result.causeCode).toBe(format.causeCode)
	expect(envelope.message).toBe(format.message)
	expect(envelope.result.repairAction).toBe(format.repairAction)
	if (format.finding === null) {
		const report = requireReport(envelope.result.data)
		expect(report.failedCount).toBe(0)
		for (const row of report.rows.filter((candidate) => candidate.scenario.endsWith("json"))) expect(row.observedContractVersion).toBe(format.observedVersion)
	} else {
		expect(envelope.result.data).toBeNull()
		expect(envelope.message).toContain(format.observedVersion === null ? "observed null" : format.observedVersion)
	}
}, 120000)

test.each([...SEMANTIC_CASES])("CDS-CE-3 semantic negative: $name", async (semantic) => {
	for (const mutation of semantic.mutations) {
		const run = await runChecker("source", matrixArgs("successor-specimens", mutation, undefined, false))
		expect(run.exitCode).toBe(4)
		expect(run.stderr).toBe("")
		const failed = failedHumanRows(run.stdout)
		expect(failed.map((row) => row.scenario)).toEqual([semantic.row])
		expect(failed[0]?.findings).toEqual([...semantic.findings])
	}
	expectConformant(await runChecker("source", matrixArgs("successor-conformant", null)))
}, 120000)

test.each([...PROCESS_EXIT_CASES])("CDS-CE-3 process exits: $row", async (processCase) => {
	const report = expectConformant(await runChecker("source", matrixArgs("successor-conformant", null)))
	const row = report.rows.find((candidate) => candidate.scenario === processCase.row)
	expect(row?.observedExit).toBe(processCase.expectedExit)
	const target = await runTarget(processCase.argv)
	expect(target.exitCode).toBe(processCase.expectedExit)
	expect(target.stderr).toBe("")
	const envelope = parseEnvelope(target.stdout)
	expect(envelope.result.commandIdentity).toBe(processCase.commandIdentity)
	expect(envelope.result.causeCode).toBe(processCase.causeCode)
	expect(envelope.result.outcome).toBe(processCase.outcome)
	expect(envelope.result.transactionState).toBe(processCase.transactionState)
	expect(envelope.result.failureClass).toBe(processCase.failureClass)
	expect(envelope.result.exitCode).toBe(processCase.expectedExit)
	expect(envelope.result.retryable).toBe(processCase.retryable)
	if (processCase.retryDelayMilliseconds === null) expect(Object.hasOwn(envelope.result, "retryDelayMilliseconds")).toBe(false)
	else expect(envelope.result.retryDelayMilliseconds).toBe(processCase.retryDelayMilliseconds)
}, 120000)

test.each([...HUMAN_DISCOVERY_CASES])("CDS-CE-3 human discovery: $name", async (humanCase) => {
	const run = await runChecker("source", matrixArgs(humanCase.mutation === null ? "successor-conformant" : "successor-specimens", humanCase.mutation, undefined, false))
	const row = failedHumanRows(run.stdout).find((candidate) => candidate.scenario === "discover-human")
	expect(row?.findings ?? []).toEqual([...humanCase.findings])
	if (humanCase.findings.length === 0) expect(run.exitCode).toBe(0)
	else expect(run.exitCode).toBe(4)
}, 120000)

test(`CDS-CE-3 retained streams: ${RETENTION_CASES[0]}`, async () => {
	const report = expectConformant(await runChecker("source", matrixArgs("successor-conformant", null)))
	expect(report.retention).toEqual({ requested: false, directory: null })
	for (const row of report.rows) expect(row.streamCustody).toBeNull()
}, 120000)

test(`CDS-CE-3 retained streams: ${RETENTION_CASES[1]}`, async () => {
	const directory = temporaryDirectory("cli-design-streams-")
	chmodSync(directory, 0o700)
	const report = expectConformant(await runChecker("source", matrixArgs("successor-conformant", null, directory)))
	expect(report.retention).toEqual({ requested: true, directory })
	expect(readdirSync(directory)).toHaveLength(28)
	for (const row of report.rows.slice(0, -1)) {
		expect(row.streamCustody).not.toBeNull()
		for (const path of [row.streamCustody?.stdoutPath, row.streamCustody?.stderrPath]) expect(statSync(path as string).mode & 0o777).toBe(0o600)
	}
	expect(JSON.stringify(report)).not.toContain("Fixture result produced.")
}, 120000)

test(`CDS-CE-3 retained streams: ${RETENTION_CASES[2]}`, async () => {
	const counterRoot = temporaryDirectory("cli-design-counter-")
	const counter = join(counterRoot, "counter.txt")
	const run = await runChecker("source", matrixArgs("successor-conformant", null, "relative-streams"), { CLI_DESIGN_INVOCATION_COUNTER: counter })
	expect(run.exitCode).toBe(2)
	expect(run.stderr).toBe("")
	expect(parseEnvelope(run.stdout).result.causeCode).toBe("USAGE_INVALID_INVOCATION")
	expect(existsSync(counter)).toBe(false)
}, 120000)

test(`CDS-CE-3 retained streams: ${RETENTION_CASES[3]}`, async () => {
	const directory = temporaryDirectory("cli-design-streams-fail-")
	chmodSync(directory, 0o700)
	const run = await runCheckerWithZeroFileLimit(matrixArgs("successor-conformant", null, directory))
	expect(run.exitCode).toBe(1)
	expect(run.stderr).toBe("")
	expect(parseEnvelope(run.stdout).result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED")
	expect(readdirSync(directory)).toEqual([])
}, 120000)

test(`CDS-CE-3 retained streams: ${RETENTION_CASES[4]}`, async () => {
	const directory = temporaryDirectory("cli-design-streams-custody-")
	const counterRoot = temporaryDirectory("cli-design-counter-")
	const counter = join(counterRoot, "counter.pipe")
	const fifo = Bun.spawnSync(["/usr/bin/mkfifo", counter], { stdout: "pipe", stderr: "pipe" })
	expect(fifo.exitCode, fifo.stderr.toString()).toBe(0)
	const counterReader = Bun.spawn(["/bin/cat", counter], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	const counterOutput = new Response(counterReader.stdout).text()
	chmodSync(directory, 0o700)
	for (const acl of ["everyone deny delete_child", "everyone deny readattr,file_inherit,only_inherit"]) {
		const applied = Bun.spawnSync(["/bin/chmod", "+a", acl, directory], { stdout: "pipe", stderr: "pipe" })
		expect(applied.exitCode, applied.stderr.toString()).toBe(0)
	}
	try {
		const run = await runCheckerWithZeroFileLimit(matrixArgs("successor-specimens", null, directory), { CLI_DESIGN_INVOCATION_COUNTER: counter })
		expect(run.exitCode).toBe(1)
		expect(run.stderr).toBe("")
		const envelope = parseEnvelope(run.stdout)
		expect(envelope.result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED")
		const retainedNames = readdirSync(directory)
		expect(retainedNames.length).toBeGreaterThan(0)
		for (const retainedName of retainedNames) expect(envelope.message).toContain(join(directory, retainedName))
		expect(await counterReader.exited).toBe(0)
		expect(await counterOutput).toBe("1\n")
	} finally {
		counterReader.kill()
		const cleared = Bun.spawnSync(["/bin/chmod", "-RN", directory], { stdout: "pipe", stderr: "pipe" })
		expect(cleared.exitCode, cleared.stderr.toString()).toBe(0)
	}
}, 120000)

const BUILTIN_CASES = [
	{ name: "help", args: ["--help", "--json"], commandIdentity: "cli-design-check.help", causeCode: "SUCCESS_UNCHANGED", exit: 0, data: CHECKER_HELP_DATA },
	{ name: "discovery", args: ["--discover", "--json"], commandIdentity: "cli-design-check.discovery", causeCode: "SUCCESS_UNCHANGED", exit: 0, data: CHECKER_DISCOVERY_DATA },
	{ name: "dispatch", args: ["--json"], commandIdentity: "cli-design-check.dispatch", causeCode: "USAGE_INVALID_INVOCATION", exit: 2, data: null },
] as const

test.each(BUILTIN_CASES.flatMap((builtin) => (["source", "bundle"] as const).map((entry) => ({ ...builtin, entry }))))("CDS-CE-3 public checker built-in: $entry $name", async (builtin) => {
	const run = await runChecker(builtin.entry, [...builtin.args])
	expect(run.exitCode).toBe(builtin.exit)
	expect(run.stderr).toBe("")
	const envelope = parseEnvelope(run.stdout)
	expect(envelope.availablePaths).toEqual(CHECKER_COMMANDS.map((command) => command.commandIdentity))
	expect(envelope.result.commandIdentity).toBe(builtin.commandIdentity)
	expect(envelope.result.causeCode).toBe(builtin.causeCode)
	expect(envelope.result.exitCode).toBe(builtin.exit)
	expect(envelope.result.data).toEqual(builtin.data)
	if (builtin.name === "discovery" && builtin.entry === "source") {
		const human = await runChecker("source", ["--discover"])
		expect(human.exitCode).toBe(0)
		expect(human.stderr).toBe("")
		expect(human.stdout).toContain("profile: simple\n")
		expect(human.stdout).toContain("command: cli-design-check.run\n")
	}
})

test.each([...CHECKER_VALUE_OPTIONS])("CDS-CE-3 checker option arity: $name", async (option) => {
	const run = await runChecker("source", [option.name, "--json", "--unknown-option"])
	expect(run.exitCode).toBe(2)
	expect(run.stdout).toBe("")
	expect(run.stderr).toContain(`Option '${option.name}' argument is ambiguous`)
})

test("test oracle rejects unvalidated process JSON", () => {
	expect(() => parseEnvelope('{"contractVersion":"2.0.0","result":null}\n')).toThrow()
})

test("test oracle rejects invalid effect and guidance fields", () => {
	const validResult: JsonRecord = {
		runId: "run-oracle",
		commandIdentity: "cli-design-check.run",
		outcome: "success",
		effectClass: "inspect",
		transactionState: "unchanged",
		causeCode: "SUCCESS_UNCHANGED",
		failureClass: null,
		exitCode: 0,
		data: null,
		retryable: false,
		repairAction: null,
		effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		nextAction: "cli-design-check.run",
	}
	const noGuidance: JsonRecord = { ...validResult }
	delete noGuidance.nextAction
	const invalidResults: Array<[string, JsonRecord]> = [
		["effect class", { ...validResult, effectClass: "mutate" }],
		["completed effects", { ...validResult, effects: { completed: [1], remaining: [], uncertain: [], inventoryComplete: true } }],
		["remaining effects", { ...validResult, effects: { completed: [], remaining: [1], uncertain: [], inventoryComplete: true } }],
		["uncertain effects", { ...validResult, effects: { completed: [], remaining: [], uncertain: [1], inventoryComplete: true } }],
		["effect inventory", { ...validResult, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: "yes" } }],
		["both guidance arms", { ...validResult, handoff: { owner: "operator", reason: "inspect", inspect: ["cli-design-check.run"] } }],
		["neither guidance arm", noGuidance],
		["blank next action", { ...validResult, nextAction: " " }],
		["invalid handoff", { ...noGuidance, handoff: { owner: "operator", reason: "", inspect: [] } }],
	]
	for (const [name, result] of invalidResults) {
		const stdout = `${JSON.stringify({ envelopeVersion: 2, contractVersion: "2.0.0", message: "oracle", availablePaths: [], result })}\n`
		expect(() => parseEnvelope(stdout), name).toThrow()
	}
})

test("successor source never forces process exit before stdout drains", () => {
	const sources = nonTestTypeScriptSources(import.meta.dir)
	expect(sources.length).toBeGreaterThan(0)
	for (const source of sources) expect(readFileSync(source, "utf8")).not.toMatch(/process\.exit\(/)
})

function normalizeEnvelope(stdout: string): CheckerEnvelope {
	const envelope = parseEnvelope(stdout)
	envelope.result.runId = "<run>"
	if (envelope.result.data !== null) {
		const report = requireReport(envelope.result.data)
		report.runIdentity = "<run>"
		for (const row of report.rows) row.durationMilliseconds = 0
	}
	return envelope
}

test.each([...PUBLIC_BUNDLE_CASES])("CDS-CE-3 public bundle: $name", async (bundleCase) => {
	const args = matrixArgs(bundleCase.mutation === null ? "successor-conformant" : "successor-specimens", bundleCase.mutation)
	const [source, bundle] = await Promise.all([runChecker("source", args), runChecker("bundle", args)])
	expect(source.exitCode).toBe(bundleCase.exit)
	expect(bundle.exitCode).toBe(bundleCase.exit)
	expect(source.stderr).toBe("")
	expect(bundle.stderr).toBe("")
	expect(normalizeEnvelope(bundle.stdout)).toEqual(normalizeEnvelope(source.stdout))
}, 120000)
