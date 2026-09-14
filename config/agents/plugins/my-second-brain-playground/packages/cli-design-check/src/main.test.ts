import { afterAll, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { allFindingCodes, envelopeFindings } from "./contract.ts"
import { SPECIMEN_MANIFEST, type SpecimenExpectation, UNIT_BASE, type UnitInput } from "./specimen-manifest.ts"
import { scenarioFindings, type ProcessResult as ScenarioProcessResult, type ScenarioSpec } from "./scenario-rules.ts"
import type { RunReport } from "./runner.ts"

interface ProcessResult {
	exitCode: number
	stdout: string
	stderr: string
}

const pluginDirectory = resolve(import.meta.dir, "../../..")
const checkerEntryPoint = resolve(pluginDirectory, "bin/cli-design-check")
const conformantFixture = resolve(pluginDirectory, "packages/cli-design-check/fixtures/conformant")
const brokenFixture = resolve(pluginDirectory, "packages/cli-design-check/fixtures/broken")
const specimensFixture = resolve(pluginDirectory, "packages/cli-design-check/fixtures/specimens")
const specimenEntryPoint = resolve(specimensFixture, "src/cli.ts")
const brokenWrite = resolve(brokenFixture, "WROTE")
const temporaryDirectories: string[] = []

// Independent oracle: the row order and finding literals below are restated here on purpose.
const EXPECTED_ROWS = [
	"help",
	"help-json",
	"discover",
	"no-arguments",
	"no-arguments-json",
	"unknown-option",
	"unknown-option-json",
	"success-human",
	"success-json",
	"missing-input",
	"malformed-value-json",
	"large-envelope",
	"unauthorized-effect",
	"secret-redaction",
	"target-unchanged",
]
// The broken fixture is run without the optional rows that need fixture support it does not have.
const OPTIONAL_ROWS_NOT_SUPPLIED_TO_BROKEN = ["malformed-value-json", "large-envelope"]
const EXPECTED_ROWS_WITHOUT_OPTIONAL = EXPECTED_ROWS.filter((scenario) => !OPTIONAL_ROWS_NOT_SUPPLIED_TO_BROKEN.includes(scenario))

async function runChecker(args: string[], env: Record<string, string> = {}): Promise<ProcessResult> {
	const child = Bun.spawn([checkerEntryPoint, ...args], {
		cwd: pluginDirectory,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

async function runSpecimen(args: string[], env: Record<string, string> = {}): Promise<ProcessResult> {
	const child = Bun.spawn(["bun", "run", specimenEntryPoint, ...args], {
		cwd: pluginDirectory,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

// The specimens CLI runs inside the conformant target root so it reads the same config files.
const SPECIMEN_COMMAND = "bun run ../specimens/src/cli.ts"

// The optional malformed and large rows are supplied for the conformant target only; the broken fixture keeps
// the baseline rows so the report's skipped list stays observable.
const OPTIONAL_ROW_ARGS = ["--malformed-args", "config/malformed.json.txt", "--large-args", "config/valid.json --large"]

function matrixArgs(fixture: string, command = "bun run src/cli.ts", optionalRows: string[] = OPTIONAL_ROW_ARGS): string[] {
	return [
		"--cwd", fixture,
		"--command", command,
		"--success-args", "config/valid.json",
		"--missing-args", "config/missing.json",
		"--effect-args", "config/valid.json --write",
		"--secret-args", "config/secret.json",
		"--secret-marker", "CHECK_FIXTURE_SECRET_MARKER",
		...optionalRows,
		"--json",
	]
}

function parseJsonObject(stdout: string): Record<string, unknown> {
	const value = JSON.parse(stdout) as unknown
	expect(typeof value).toBe("object")
	expect(value).not.toBeNull()
	expect(Array.isArray(value)).toBe(false)
	expect(stdout).toBe(`${JSON.stringify(value)}\n`)
	return value as Record<string, unknown>
}

function removeBrokenWrite(): void {
	rmSync(brokenWrite, { force: true })
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cli-design-check-hang-"))
	temporaryDirectories.push(directory)
	return directory
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

// A killed grandchild may linger as an unreaped zombie for a moment; give reaping a bounded window.
async function processGone(pid: number, withinMs: number): Promise<boolean> {
	const deadline = Date.now() + withinMs
	while (processAlive(pid)) {
		if (Date.now() > deadline) return false
		await Bun.sleep(50)
	}
	return true
}

afterAll(() => {
	removeBrokenWrite()
	expect(existsSync(brokenWrite)).toBe(false)
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

test("O-01 S01: help-json prose is reported as a single-object finding", async () => {
	const expectation = SPECIMEN_MANIFEST.find(({ specimen }) => specimen === "S01")
	if (expectation === undefined) throw new Error("S01 specimen expectation is missing")
	const run = await runSpecimen(["--json", "--help"], { CLI_DESIGN_SPECIMEN: "S01" })
	const scenario: ScenarioSpec = { scenario: "help-json", argv: ["--json", "--help"], expectedExit: 0 }
	const result: ScenarioProcessResult = {
		stdout: run.stdout,
		stderr: run.stderr,
		observedExit: run.exitCode,
		timedOut: false,
		durationMilliseconds: 0,
	}
	expect(scenarioFindings(scenario, result)).toEqual([...expectation.findings])
})

function specimenPath(path: string, temporaryRoot = tmpdir()): string {
	return path.replace("<target>", conformantFixture).replace("<tmpdir>", temporaryRoot)
}

function specimenCleanup(entry: SpecimenExpectation, temporaryRoot = tmpdir()): void {
	for (const path of entry.cleanup ?? []) rmSync(specimenPath(path, temporaryRoot), { force: true })
}

// The specimen's durable effect is observed on the filesystem itself, before cleanup, so a
// specimen whose effect never happened cannot pass on report text alone.
function assertSpecimenEffects(entry: SpecimenExpectation, temporaryRoot = tmpdir()): void {
	for (const effect of entry.effects ?? []) {
		const path = specimenPath(effect.path, temporaryRoot)
		if (effect.kind === "file") {
			expect(existsSync(path)).toBe(true)
			expect(readFileSync(path, "utf8")).toBe(effect.content)
		} else {
			expect(lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true)
			expect(readlinkSync(path)).toBe(effect.target)
		}
	}
}

function assertOwnedPath(root: string, path: string): void {
	const pathWithinRoot = relative(root, path)
	expect(pathWithinRoot).not.toBe("")
	expect(pathWithinRoot.startsWith("..")).toBe(false)
	expect(resolve(root, pathWithinRoot)).toBe(path)
}

function cleanupS17Root(entry: SpecimenExpectation, root: string): void {
	for (const effect of entry.effects ?? []) assertOwnedPath(root, specimenPath(effect.path, root))
	for (const path of entry.cleanup ?? []) assertOwnedPath(root, specimenPath(path, root))
	rmSync(root, { recursive: true, force: true })
}

interface SpecimenMatrixOptions {
	readonly expectedTemporaryRoot?: string
	readonly executionTemporaryRoot?: string
	readonly retainExpectedTemporaryRoot?: boolean
}

async function runSpecimenMatrix(entry: SpecimenExpectation, options: SpecimenMatrixOptions = {}): Promise<{ run: ProcessResult; stdoutObject: Record<string, unknown>; result: RunReport }> {
	const args = [...matrixArgs(conformantFixture, SPECIMEN_COMMAND), ...(entry.timeoutMs === undefined ? [] : ["--timeout-ms", String(entry.timeoutMs)])]
	const isS17 = entry.specimen === "S17"
	const expectedTemporaryRoot = isS17 ? (options.expectedTemporaryRoot ?? mkdtempSync(join(tmpdir(), "cli-design-check-s17-"))) : tmpdir()
	const executionTemporaryRoot = isS17 ? (options.executionTemporaryRoot ?? expectedTemporaryRoot) : undefined
	if (!isS17) specimenCleanup(entry)
	try {
		const run = await runChecker(args, {
			CLI_DESIGN_SPECIMEN: entry.specimen,
			...(executionTemporaryRoot === undefined ? {} : { TMPDIR: executionTemporaryRoot }),
		})
		assertSpecimenEffects(entry, expectedTemporaryRoot)
		expect(run.stderr).toBe("")
		const stdoutObject = parseJsonObject(run.stdout)
		// A usage refusal means the checker rejected the matrix arguments, not the specimen.
		expect(stdoutObject.failureClass).not.toBe("usage")
		return { run, stdoutObject, result: stdoutObject.result as RunReport }
	} finally {
		if (isS17) {
			if (!options.retainExpectedTemporaryRoot) cleanupS17Root(entry, expectedTemporaryRoot)
			if (executionTemporaryRoot !== undefined && executionTemporaryRoot !== expectedTemporaryRoot) {
				cleanupS17Root(entry, executionTemporaryRoot)
			}
		} else specimenCleanup(entry)
	}
}

// Isolated process proof: the named row carries exactly the manifest literal, every other row
// passes, the checker exits 3 and repairAction names the row.
for (const entry of SPECIMEN_MANIFEST.filter((candidate) => candidate.proof === "process" && candidate.passes === undefined)) {
	test(`${entry.rule} ${entry.specimen}: ${entry.row} reports ${entry.findings.join(", ")} through the checker`, async () => {
		const { run, stdoutObject, result } = await runSpecimenMatrix(entry)

		const row = result.rows.find((candidate) => candidate.scenario === entry.row)
		expect(row?.findings).toEqual([...entry.findings])
		if (entry.observedExit !== undefined) expect(row?.observedExit).toBe(entry.observedExit)
		expect(result.rows.filter((candidate) => !candidate.passed).map((candidate) => candidate.scenario)).toEqual([entry.row])
		expect(run.exitCode).toBe(3)
		expect(stdoutObject.repairAction).toBe(`${entry.row} failed: ${entry.findings[0]}`)
		if (entry.changedPaths !== undefined) expect(result.targetObservation.changedPaths).toEqual([...entry.changedPaths])
	}, 60000)
}

// A specimen every row accepts: exit 0 and all rows pass; an unseen effect is named in the report.
for (const entry of SPECIMEN_MANIFEST.filter((candidate) => candidate.proof === "process" && candidate.passes !== undefined)) {
	const passes = entry.passes
	if (passes === undefined) throw new Error(`${entry.specimen} is a passing entry without an observation`)
	const names = passes.field === undefined || passes.names === undefined ? "" : ` and targetObservation.${passes.field} names ${passes.names}`
	test(`${entry.rule} ${entry.specimen}: ${entry.row} passes${names}`, async () => {
		const { run, result } = await runSpecimenMatrix(entry)

		const row = result.rows.find((candidate) => candidate.scenario === entry.row)
		expect(row?.findings).toEqual([])
		if (entry.observedExit !== undefined) expect(row?.observedExit).toBe(entry.observedExit)
		expect(result.rows.filter((candidate) => !candidate.passed).map((candidate) => candidate.scenario)).toEqual([])
		expect(run.exitCode).toBe(0)
		expect(result.targetObservation).toBeDefined()
		if (passes.field !== undefined && passes.names !== undefined) expect(result.targetObservation[passes.field]).toContain(passes.names)
	}, 60000)
}

test("O-15 S17: per-run effect custody keeps sibling evidence through cleanup", async () => {
	const entry = SPECIMEN_MANIFEST.find((candidate) => candidate.specimen === "S17")
	if (entry === undefined) throw new Error("S17 specimen expectation is missing")
	const firstRoot = mkdtempSync(join(tmpdir(), "cli-design-check-s17-"))
	const secondRoot = mkdtempSync(join(tmpdir(), "cli-design-check-s17-"))
	try {
		await runSpecimenMatrix(entry, {
			expectedTemporaryRoot: firstRoot,
			executionTemporaryRoot: firstRoot,
			retainExpectedTemporaryRoot: true,
		})
		await runSpecimenMatrix(entry, {
			expectedTemporaryRoot: secondRoot,
			executionTemporaryRoot: secondRoot,
		})
		expect(existsSync(secondRoot)).toBe(false)
		assertSpecimenEffects(entry, firstRoot)
	} finally {
		cleanupS17Root(entry, firstRoot)
		cleanupS17Root(entry, secondRoot)
	}
	expect(existsSync(firstRoot)).toBe(false)
})

test("O-15: the conformant run publishes what target-unchanged observed and did not observe", async () => {
	const run = await runChecker(matrixArgs(conformantFixture))

	const result = parseJsonObject(run.stdout).result as RunReport
	expect(result.targetObservation).toBeDefined()
	const { hashedRegularFiles, ...observation } = result.targetObservation
	expect(observation).toEqual({
		root: conformantFixture,
		excludedDirectories: [".git", "node_modules"],
		excludedEntryKinds: ["symlink", "socket", "fifo", "block-device", "character-device"],
		notObserved: ["out-of-tree paths", "reverted effects", "mode changes", "empty directories", "writes inside excluded directories"],
		changedPaths: [],
	})
	expect(hashedRegularFiles.map((file) => file.relativePath)).toEqual([
		"config/malformed.json.txt",
		"config/secret.json",
		"config/valid.json",
		"package.json",
		"src/cli.ts",
		"tsconfig.json",
	])
	for (const file of hashedRegularFiles) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
}, 60000)

function setPath(target: Record<string, unknown>, path: string[], value: unknown, remove: boolean): void {
	const [head, ...rest] = path
	if (head === undefined) return
	if (rest.length === 0) {
		if (remove) delete target[head]
		else target[head] = value
		return
	}
	const child = target[head]
	if (typeof child === "object" && child !== null) setPath(child as Record<string, unknown>, rest, value, remove)
}

function unitEnvelope(input: UnitInput): Record<string, unknown> {
	const envelope = structuredClone(UNIT_BASE[input.base]) as Record<string, unknown>
	for (const [path, value] of Object.entries(input.set ?? {})) setPath(envelope, path.split("."), value, false)
	for (const path of input.remove ?? []) setPath(envelope, path.split("."), undefined, true)
	return envelope
}

// Unit proof: the named row's rules see one mutated base envelope; the exit is taken as expected
// so only the envelope's own alignment is judged.
for (const entry of SPECIMEN_MANIFEST.filter((candidate) => candidate.proof === "unit")) {
	const input = entry.unit
	if (input === undefined) throw new Error(`${entry.specimen} is a unit entry without unit input`)
	test(`${entry.rule} ${entry.specimen}: ${entry.row} rules report ${entry.findings.join(", ")} at the unit seam`, () => {
		const spec: ScenarioSpec = { scenario: entry.row, argv: [], expectedExit: input.observedExit, secretMarker: input.secretMarker }
		const result: ScenarioProcessResult = {
			stdout: input.stdout ?? `${JSON.stringify(unitEnvelope(input))}\n`,
			stderr: input.stderr ?? "",
			observedExit: input.observedExit,
			timedOut: false,
			durationMilliseconds: 0,
		}
		expect(scenarioFindings(spec, result)).toEqual([...entry.findings])
	})
}

test("conformant fixture returns the exact success verdict", async () => {
	const run = await runChecker(matrixArgs(conformantFixture))

	expect(run.exitCode).toBe(0)
	expect(run.stderr).toBe("")
	const stdoutObject = parseJsonObject(run.stdout)
	expect(stdoutObject.outcome).toBe("success")
	expect(stdoutObject.failureClass).toBe(null)
	expect(stdoutObject.causeCode).toBe(null)
	expect(stdoutObject.commandIdentity).toBe("cli-design-check.run")
	expect(stdoutObject.contractVersion).toBe("1.0.0")
	expect(stdoutObject.envelopeVersion).toBe(1)
	expect(stdoutObject.transactionState).toBe("unchanged")
	expect(stdoutObject.effectClass).toBe("inspect")
	expect(stdoutObject.nextAction).toBe(null)
	expect(stdoutObject.handoff).toBe(null)

	const result = stdoutObject.result as RunReport
	expect(result.passedCount).toBe(15)
	expect(result.failedCount).toBe(0)
	expect(result.targetUnchanged).toBe(true)
	expect(result.rows.map((row) => row.scenario)).toEqual(EXPECTED_ROWS)
	for (const row of result.rows) {
		expect(row.passed).toBe(true)
		expect(row.findings).toEqual([])
	}
}, 60000)

test("broken fixture returns the exact refusal findings and cleans up", async () => {
	removeBrokenWrite()
	const run = await runChecker(matrixArgs(brokenFixture, "bun run src/cli.ts", []))

	expect(run.exitCode).toBe(3)
	expect(run.stderr).toBe("")
	const stdoutObject = parseJsonObject(run.stdout)
	expect(stdoutObject.outcome).toBe("refused")
	expect(stdoutObject.failureClass).toBe("domain")
	expect(stdoutObject.causeCode).toBe("DOMAIN_CONTRACT_VIOLATION")

	const result = stdoutObject.result as RunReport
	expect(result.passedCount).toBe(7)
	expect(result.failedCount).toBe(6)
	expect(result.targetUnchanged).toBe(false)
	expect(result.targetObservation?.changedPaths).toEqual(["WROTE"])
	expect(result.rows.map((row) => row.scenario)).toEqual(EXPECTED_ROWS_WITHOUT_OPTIONAL)

	const expectedFindings: Record<string, string[]> = {
		"help-json": ["STDOUT_NOT_SINGLE_JSON_OBJECT"],
		"success-json": ["STDOUT_NOT_SINGLE_JSON_OBJECT", "STDERR_NOT_EMPTY", "JSON_ON_STDERR"],
		"missing-input": [
			"ENVELOPE_FIELD_INVALID:outcome",
			"ENVELOPE_FIELD_INVALID:failureClass",
			"ENVELOPE_FIELD_INVALID:retryable",
			"ENVELOPE_FIELD_INVALID:repairAction",
			"EXIT_MISMATCH",
		],
		"unauthorized-effect": [
			"ENVELOPE_FIELD_INVALID:outcome",
			"ENVELOPE_FIELD_INVALID:failureClass",
			"ENVELOPE_FIELD_INVALID:retryable",
			"EXIT_MISMATCH",
		],
		"secret-redaction": ["STDOUT_NOT_SINGLE_JSON_OBJECT", "SECRET_MARKER_LEAKED:stderr", "STDERR_NOT_EMPTY", "JSON_ON_STDERR"],
		"target-unchanged": ["TARGET_MUTATED"],
	}
	for (const [scenario, findings] of Object.entries(expectedFindings)) {
		const row = result.rows.find((candidate) => candidate.scenario === scenario)
		expect(row).toBeDefined()
		expect(row?.passed).toBe(false)
		expect(row?.findings).toEqual(findings)
	}

	for (const scenario of ["help", "discover", "no-arguments", "no-arguments-json", "unknown-option", "unknown-option-json", "success-human"]) {
		const row = result.rows.find((candidate) => candidate.scenario === scenario)
		expect(row).toBeDefined()
		expect(row?.passed).toBe(true)
		expect(row?.findings).toEqual([])
	}

	expect(typeof stdoutObject.nextAction).toBe("string")
	expect(stdoutObject.nextAction as string).toContain("help-json")
	expect(stdoutObject.handoff).toBe(null)
	expect(typeof stdoutObject.repairAction).toBe("string")
	expect((stdoutObject.repairAction as string).length).toBeGreaterThan(0)

	removeBrokenWrite()
	expect(existsSync(brokenWrite)).toBe(false)
}, 60000)

test("a target that ignores SIGTERM and parks a grandchild on the pipes still returns a verdict", async () => {
	const directory = temporaryDirectory()
	const pidFile = join(directory, "..", `cli-design-check-hang-${process.pid}.pid`)
	rmSync(pidFile, { force: true })
	// Ignores TERM, then hangs on the no-arguments row behind a grandchild that inherits the ignore.
	writeFileSync(join(directory, "hang.sh"), 'trap "" TERM\nif [ "$#" -eq 0 ]; then\n  sleep 30 &\n  echo "$!" > "$HANG_PID_FILE"\n  wait\nfi\nexit 0\n')
	const started = Date.now()

	const run = await runChecker(
		["--cwd", directory, "--command", "sh hang.sh", "--success-args", "x", "--missing-args", "y", "--timeout-ms", "1000", "--json"],
		{ HANG_PID_FILE: pidFile },
	)

	const elapsed = Date.now() - started
	expect(run.exitCode).toBe(3)
	expect(run.stderr).toBe("")
	expect(elapsed).toBeLessThan(8000)
	const result = parseJsonObject(run.stdout).result as RunReport
	const row = result.rows.find((candidate) => candidate.scenario === "no-arguments")
	expect(row?.observedExit).toBe(null)
	expect(row?.findings).toEqual(["PROMPTED_OR_HUNG", "STDERR_NOT_ONE_LINE", "EXIT_MISMATCH"])
	const grandchildPid = Number(readFileSync(pidFile, "utf8").trim())
	rmSync(pidFile, { force: true })
	expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true)
	expect(await processGone(grandchildPid, 2000)).toBe(true)
}, 60000)

test("CDS-CH-2 T2-PR-PIPE-01: natural direct-child exit cleans a finite descendant and returns a complete verdict", async () => {
	const directory = temporaryDirectory()
	const custodyFile = join(directory, "..", `cli-design-check-natural-exit-${process.pid}.txt`)
	rmSync(custodyFile, { force: true })
	writeFileSync(
		join(directory, "natural-exit.sh"),
		[
			'if [ "$#" -eq 0 ]; then',
			"  /bin/sleep 15 &",
			'  descendant_pid="$!"',
			'  direct_pgid="$(/bin/ps -o pgid= -p "$$")"',
			'  descendant_pgid="$(/bin/ps -o pgid= -p "$descendant_pid")"',
			'  /usr/bin/printf \'%s %s %s %s\\n\' "$$" "$descendant_pid" "$direct_pgid" "$descendant_pgid" > "$PIPE_CUSTODY_FILE"',
			"fi",
			"exit 0",
			"",
		].join("\n"),
	)
	const started = Date.now()

	try {
		const run = await runChecker(matrixArgs(directory, "/bin/sh natural-exit.sh"), { PIPE_CUSTODY_FILE: custodyFile })
		const elapsed = Date.now() - started
		const custody = readFileSync(custodyFile, "utf8").trim().split(/\s+/).map(Number)
		const [directPid, descendantPid, directPgid, descendantPgid] = custody
		if (directPid === undefined || descendantPid === undefined || directPgid === undefined || descendantPgid === undefined) {
			throw new Error(`invalid process custody record: ${JSON.stringify(custody)}`)
		}
		const descendantGone = await processGone(descendantPid, 2000)

		expect(custody).toHaveLength(4)
		expect(custody.every((value) => Number.isInteger(value) && value > 0)).toBe(true)
		expect(directPgid).toBe(directPid)
		expect(descendantPgid).toBe(directPgid)
		expect(elapsed).toBeLessThan(8000)
		expect(descendantGone).toBe(true)
		expect(run.exitCode).toBe(3)
		expect(run.stderr).toBe("")
		const result = parseJsonObject(run.stdout).result as RunReport
		expect(result.rows.map((row) => row.scenario)).toEqual(EXPECTED_ROWS)
		expect(result.skippedScenarios).toEqual([])
		expect(result.findingCoverage).toEqual({ unproved: [] })
		expect(result.targetObservation.changedPaths).toEqual([])
		const row = result.rows.find((candidate) => candidate.scenario === "no-arguments")
		expect(row?.observedExit).toBe(0)
		expect(row?.findings).toEqual(["STDERR_NOT_ONE_LINE", "EXIT_MISMATCH"])
	} finally {
		rmSync(custodyFile, { force: true })
	}
}, 60000)

// O-18: the sealed vocabulary is the domain; the manifest must name every entry, at process level for
// every flat code and one instance per family, and the process/unit partition is explicit.
test("O-18: every finding code has a manifest specimen and the partition is explicit", () => {
	const proved = new Set(SPECIMEN_MANIFEST.flatMap((entry) => [entry.code, ...entry.findings]))
	expect(allFindingCodes().filter((code) => !proved.has(code))).toEqual([])
	const processProved = new Set(SPECIMEN_MANIFEST.filter((entry) => entry.proof === "process").flatMap((entry) => [entry.code, ...entry.findings]))
	const flatCodes = allFindingCodes().filter((code) => !code.includes(":"))
	expect(flatCodes.filter((code) => !processProved.has(code))).toEqual([])
	const families = new Set(allFindingCodes().filter((code) => code.includes(":")).map((code) => code.split(":")[0]))
	const processFamilies = new Set([...processProved].filter((code) => code.includes(":")).map((code) => code.split(":")[0]))
	expect([...families].filter((family) => !processFamilies.has(family))).toEqual([])
	expect(SPECIMEN_MANIFEST.filter((entry) => entry.proof === "unit").every((entry) => entry.unit !== undefined)).toBe(true)
	expect(SPECIMEN_MANIFEST.filter((entry) => entry.proof === "process").every((entry) => entry.unit === undefined)).toBe(true)
	expect(new Set(SPECIMEN_MANIFEST.map((entry) => entry.specimen)).size).toBe(SPECIMEN_MANIFEST.length)
})

// O-18: the report says what it skipped, what it never proved and what it does not judge, in both modes.
const UNJUDGED = ["exitMeanings.75"]
const SKIPPED_BY_BROKEN_RUN = ["malformed-value-json", "large-envelope"]

test("O-18: the JSON report lists skipped rows, the frozen unproved literal and the unjudged value", async () => {
	const conformant = parseJsonObject((await runChecker(matrixArgs(conformantFixture))).stdout).result as RunReport
	expect(conformant.skippedScenarios).toEqual([])
	expect(conformant.findingCoverage).toEqual({ unproved: [] })
	expect(conformant.unjudged).toEqual(UNJUDGED)

	removeBrokenWrite()
	const broken = parseJsonObject((await runChecker(matrixArgs(brokenFixture, "bun run src/cli.ts", []))).stdout).result as RunReport
	removeBrokenWrite()
	expect(broken.skippedScenarios).toEqual(SKIPPED_BY_BROKEN_RUN)
	expect(broken.findingCoverage).toEqual({ unproved: [] })
	expect(broken.unjudged).toEqual(UNJUDGED)
}, 60000)

test("O-18: the human report carries the same skipped, unproved, unjudged and observation lines", async () => {
	const conformant = await runChecker(matrixArgs(conformantFixture).filter((argument) => argument !== "--json"))
	expect(conformant.exitCode).toBe(0)
	expect(conformant.stderr).toBe("")
	const conformantLines = conformant.stdout.split("\n")
	expect(conformantLines).toContain("skipped scenarios: -")
	expect(conformantLines).toContain("unproved findings: -")
	expect(conformantLines).toContain("unjudged: exitMeanings.75")
	expect(conformantLines).toContain(`target root: ${conformantFixture}`)
	expect(conformantLines).toContain("target hashed regular files: 6")
	expect(conformantLines).toContain("target excluded directories: .git, node_modules")
	expect(conformantLines).toContain("target excluded entry kinds: symlink, socket, fifo, block-device, character-device")
	expect(conformantLines).toContain("target not observed: out-of-tree paths, reverted effects, mode changes, empty directories, writes inside excluded directories")
	expect(conformantLines).toContain("target changed paths: -")

	removeBrokenWrite()
	const broken = await runChecker(matrixArgs(brokenFixture, "bun run src/cli.ts", []).filter((argument) => argument !== "--json"))
	removeBrokenWrite()
	expect(broken.exitCode).toBe(3)
	const brokenLines = broken.stdout.split("\n")
	expect(brokenLines).toContain("skipped scenarios: malformed-value-json, large-envelope")
	expect(brokenLines).toContain("target changed paths: WROTE")
}, 60000)

// 12,000 hashed files put the report past 1 MiB, the size at which a forced exit truncates a Bun pipe.
const DRAIN_FILE_COUNT = 12000

test("O-14: a checker report of at least 1 MiB drains completely through a pipe", async () => {
	const directory = temporaryDirectory()
	for (let index = 0; index < DRAIN_FILE_COUNT; index += 1) writeFileSync(join(directory, `observed-${String(index).padStart(5, "0")}.txt`), `${index}\n`)

	const run = await runChecker(["--cwd", directory, "--command", "true", "--success-args", "x", "--missing-args", "y", "--json"])

	expect(run.stderr).toBe("")
	expect(Buffer.byteLength(run.stdout, "utf8")).toBeGreaterThanOrEqual(1024 * 1024)
	const result = parseJsonObject(run.stdout).result as RunReport
	expect(result.targetObservation.hashedRegularFiles.length).toBe(DRAIN_FILE_COUNT)
	expect(run.exitCode).toBe(3)
}, 60000)

test("O-14: no checker source file calls process.exit", () => {
	const sourceDirectory = resolve(pluginDirectory, "packages/cli-design-check/src")
	const sourceFiles = readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
	expect(sourceFiles.length).toBeGreaterThan(0)
	for (const name of sourceFiles) expect(readFileSync(join(sourceDirectory, name), "utf8")).not.toMatch(/process\.exit\(/)
})

test("missing required options is a one-line usage error in human mode", async () => {
	const run = await runChecker(["--cwd", conformantFixture])

	expect(run.exitCode).toBe(2)
	expect(run.stdout).toBe("")
	expect(run.stderr).toMatch(/^cli-design-check:[^\r\n]*(?:\r?\n)?$/)
}, 60000)

test("a usage error in --json mode is one envelope on stdout and nothing on stderr", async () => {
	const run = await runChecker(["--definitely-unknown-option", "--json"])

	expect(run.exitCode).toBe(2)
	expect(run.stderr).toBe("")
	const stdoutObject = parseJsonObject(run.stdout)
	expect(stdoutObject.outcome).toBe("refused")
	expect(stdoutObject.failureClass).toBe("usage")
	expect(stdoutObject.causeCode).toBe("USAGE_INVALID_ARGUMENTS")
	expect(stdoutObject.transactionState).toBe("unchanged")
	expect(typeof stdoutObject.nextAction).toBe("string")
	expect(stdoutObject.handoff).toBe(null)
	expect(stdoutObject.result).toBe(null)
}, 60000)

// O-02: CC:44 applies to the checker itself; the help result shape and commandIdentity are not judged.
for (const args of [
	["--help", "--json"],
	["--json", "--help"],
]) {
	test(`O-02: the checker's own ${args.join(" ")} is one success envelope on stdout and nothing on stderr`, async () => {
		const run = await runChecker(args)

		expect(run.stderr).toBe("")
		expect(run.stdout).toMatch(/^\{/)
		const stdoutObject = parseJsonObject(run.stdout)
		expect(stdoutObject.outcome).toBe("success")
		expect(stdoutObject.failureClass).toBe(null)
		expect(stdoutObject.contractVersion).toBe("1.0.0")
		expect(run.exitCode).toBe(0)
		expect(envelopeFindings(stdoutObject, run.exitCode)).toEqual([])
	}, 60000)
}

test("help prints usage", async () => {
	const run = await runChecker(["--help"])

	expect(run.exitCode).toBe(0)
	expect(run.stdout).toContain("usage:")
}, 60000)

test("next-step rule: a failure names exactly one of nextAction or handoff", () => {
	const refusal = {
		envelopeVersion: 1,
		contractVersion: "1.0.0",
		commandIdentity: "demo.read",
		runIdentity: "run-1",
		outcome: "refused",
		failureClass: "domain",
		causeCode: "DOMAIN_INPUT_MISSING",
		message: "Input file is missing",
		effectClass: "inspect",
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: "demo --help",
		availablePaths: ["demo --help"],
		repairAction: "Provide a readable file",
		handoff: null,
		result: null,
	}
	const handoff = { reason: "needs a credential", prerequisites: ["export DEMO_TOKEN"] }

	expect(envelopeFindings(refusal, 3)).toEqual([])
	expect(envelopeFindings({ ...refusal, nextAction: null, handoff }, 3)).toEqual([])
	expect(envelopeFindings({ ...refusal, nextAction: null }, 3)).toEqual(["ENVELOPE_NEXT_STEP_RULE"])
	expect(envelopeFindings({ ...refusal, handoff }, 3)).toEqual(["ENVELOPE_NEXT_STEP_RULE"])
	expect(envelopeFindings({ ...refusal, outcome: "failed", nextAction: null, availablePaths: [] }, 3)).toEqual(["ENVELOPE_NEXT_STEP_RULE"])
	expect(envelopeFindings({ ...refusal, outcome: "success", failureClass: null, causeCode: null, nextAction: null }, 0)).toEqual([])
})
