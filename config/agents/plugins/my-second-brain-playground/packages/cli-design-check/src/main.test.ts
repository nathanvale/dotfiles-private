import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { envelopeFindings } from "./contract.ts"
import type { RunReport } from "./runner.ts"

interface ProcessResult {
	exitCode: number
	stdout: string
	stderr: string
}

const pluginDirectory = resolve(import.meta.dir, "../../..")
const checkerEntryPoint = resolve(pluginDirectory, "packages/cli-design-check/src/main.ts")
const conformantFixture = resolve(pluginDirectory, "packages/cli-design-check/fixtures/conformant")
const brokenFixture = resolve(pluginDirectory, "packages/cli-design-check/fixtures/broken")
const brokenWrite = resolve(brokenFixture, "WROTE")
const temporaryDirectories: string[] = []

// Independent oracle: the row order and finding literals below are restated here on purpose.
const EXPECTED_ROWS = [
	"help",
	"discover",
	"no-arguments",
	"unknown-option",
	"unknown-option-json",
	"success-human",
	"success-json",
	"missing-input",
	"unauthorized-effect",
	"secret-redaction",
	"target-unchanged",
]

async function runChecker(args: string[], env: Record<string, string> = {}): Promise<ProcessResult> {
	const child = Bun.spawn(["bun", "run", checkerEntryPoint, ...args], {
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

function matrixArgs(fixture: string): string[] {
	return [
		"--cwd", fixture,
		"--command", "bun run src/cli.ts",
		"--success-args", "config/valid.json",
		"--missing-args", "config/missing.json",
		"--effect-args", "config/valid.json --write",
		"--secret-args", "config/secret.json",
		"--secret-marker", "CHECK_FIXTURE_SECRET_MARKER",
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
	expect(result.passedCount).toBe(11)
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
	const run = await runChecker(matrixArgs(brokenFixture))

	expect(run.exitCode).toBe(3)
	expect(run.stderr).toBe("")
	const stdoutObject = parseJsonObject(run.stdout)
	expect(stdoutObject.outcome).toBe("refused")
	expect(stdoutObject.failureClass).toBe("domain")
	expect(stdoutObject.causeCode).toBe("DOMAIN_CONTRACT_VIOLATION")

	const result = stdoutObject.result as RunReport
	expect(result.passedCount).toBe(6)
	expect(result.failedCount).toBe(5)
	expect(result.targetUnchanged).toBe(false)
	expect(result.rows.map((row) => row.scenario)).toEqual(EXPECTED_ROWS)

	const expectedFindings: Record<string, string[]> = {
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
		"target-unchanged": ["TARGET_MUTATED", "WROTE"],
	}
	for (const [scenario, findings] of Object.entries(expectedFindings)) {
		const row = result.rows.find((candidate) => candidate.scenario === scenario)
		expect(row).toBeDefined()
		expect(row?.passed).toBe(false)
		expect(row?.findings).toEqual(findings)
	}

	for (const scenario of ["help", "discover", "no-arguments", "unknown-option", "unknown-option-json", "success-human"]) {
		const row = result.rows.find((candidate) => candidate.scenario === scenario)
		expect(row).toBeDefined()
		expect(row?.passed).toBe(true)
		expect(row?.findings).toEqual([])
	}

	expect(typeof stdoutObject.nextAction).toBe("string")
	expect(stdoutObject.nextAction as string).toContain("success-json")
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
