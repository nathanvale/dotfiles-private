// Contract Core 2.0 through the public process: help, discovery, station reachability, validated output with effect
// facts, transport failure, held-open stdin, signals and the strict CLI Design checker. Expected stations are a
// test-owned table, not the production catalogue: every declared station must be reached and every reached one declared.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
	CHECKER,
	DESCRIPTOR_LIMIT_PRELOAD,
	EXHAUST_DESCRIPTORS,
	envelope,
	events,
	type Fixture,
	type InvokeOptions,
	createFixture,
	invoke,
	LANE_ADAPTER,
	laneInput,
	laneLedger,
	RUNTIME,
	removeFixture,
	SENTINEL,
	STDOUT_HOLD_PRELOAD,
	setFake,
	writeInput,
} from "./fixtures/harness.ts"

const proofs = laneLedger()
let fixture: Fixture
let validInput: string
let validPath: string
let invalidPath: string
let malformedPath: string
let directory: string

beforeAll(() => {
	fixture = createFixture()
	validInput = JSON.stringify(laneInput())
	validPath = writeInput(fixture, laneInput(), "valid")
	invalidPath = writeInput(fixture, "{broken", "invalid")
	malformedPath = writeInput(fixture, laneInput({ dispatch: { opaqueItemRef: "Not_An_Item", projection: { displayName: "x" } } }), "malformed")
	directory = join(fixture.inputs, "a-directory")
	mkdirSync(directory)
})

beforeEach(() => {
	setFake(fixture, "honest")
})

afterAll(() => {
	removeFixture(fixture)
})

function preload(name: string, source: string): string {
	const path = join(fixture.root, `preload-${name}.ts`)
	writeFileSync(path, source)
	return path
}

// Throws once while serializing the first envelope with the named outcome.
const serializerThrowsOn = (outcome: string) => `const stringify = JSON.stringify
JSON.stringify = (...args) => {
	if (args[0]?.result?.outcome === "${outcome}") {
		JSON.stringify = stringify
		throw new Error("fixture serializer failure")
	}
	return stringify(...args)
}
`

const STDOUT_THROWS = `process.stdout.write = () => {
	throw Object.assign(new Error("fixture EPIPE"), { code: "EPIPE" })
}
`

describe("help and discovery", () => {
	test("human help names every invocation", () => {
		const result = invoke(fixture, ["--help"])
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(result.stdout).toContain("source-intake-classify classify [--json] < LANE_INPUT.json")
	})

	test("machine help lists every option with its value name", () => {
		const options = envelope(invoke(fixture, ["--help", "--json"])).result.data.options.map((option: { name: string; valueName: string | null }) => `${option.name} ${option.valueName}`)
		expect(options.sort()).toEqual(["--discover null", "--discover-command COMMAND_IDENTITY", "--help null", "--json null"])
	})

	test("discovery reports the complex profile, one external command and the effect exclusions", () => {
		const data = envelope(invoke(fixture, ["--discover", "--json"])).result.data
		expect(data).toMatchObject({ contractVersion: "2.0.0", generationConventionVersion: "2.0.0", profile: "complex" })
		expect(data.commands.map((command: { commandIdentity: string; effectClass: string }) => `${command.commandIdentity}:${command.effectClass}`)).toEqual([
			"source-intake-classify.dispatch:inspect",
			"source-intake-classify.help:inspect",
			"source-intake-classify.discovery:inspect",
			"source-intake-classify.command-discovery:inspect",
			"source-intake-classify.classify:external",
		])
		expect(data.effectExclusions).toContain("Never starts the classifier model unless the per-run pre-flight proves the lane profile denies both private receipt roots.")
	})

	test("human discovery is a concise line, not JSON", () => {
		const result = invoke(fixture, ["--discover"])
		expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "Profile complex. Commands: classify (external, reads standard input, starts one Codex lane after a pre-flight).\n" })
	})

	test("an unknown discovery selector is a usage refusal", () => {
		expect(envelope(invoke(fixture, ["--discover-command", "source-intake-classify.file", "--json"])).result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", exitCode: 2 })
	})
})

// Test-owned expected stations: cause|outcome|state|exit|class|retryable|repair action.
const EXPECTED_STATIONS = [
	"DOMAIN_PRECONDITION_UNMET|refused|unchanged|3|domain|false|Inspect the Codex install, the lane profile and both receipt roots, then retry.",
	"INTERNAL_EFFECT_OUTCOME_UNKNOWN|failed|unknown|1|internal|false|Inspect the lane rollout before deciding on a new run; never replay automatically.",
	"INTERNAL_RESULT_COMPLETED|failed|completed|1|internal|false|Inspect the completed lane rollout; do not rerun to repair reporting.",
	"INTERNAL_RESULT_UNCHANGED|failed|unchanged|1|internal|false|Inspect the serialization failure before retrying.",
	"INTERNAL_UNEXPECTED|failed|unchanged|1|internal|false|Pipe the lane input from a readable file or stream.",
	"SCHEMA_INVALID_INPUT|refused|unchanged|4|schema|false|Pipe exactly one lane input object with the keys and value formats in the package README.",
	"SUCCESS_COMPLETED|success|completed|0||false|",
	"TRANSIENT_NOT_STARTED|refused|unchanged|75|transient|true|Wait for open files to be released, then retry the same command.",
	"USAGE_INVALID_INVOCATION|refused|unchanged|2|usage|false|Choose one listed invocation with its required operands and retry.",
]

interface Row {
	args: string[]
	options?: () => InvokeOptions
	setup?: () => void
}

// One invocation per reachable station.
const REACHING_ROWS: Row[] = [
	{ args: ["classify"], options: () => ({ stdin: validInput }) },
	{ args: ["classify", "extra"], options: () => ({ stdin: validInput }) },
	{ args: ["classify"], options: () => ({ stdin: validInput }), setup: () => setFake(fixture, "open") },
	{ args: ["classify"], options: () => ({ stdin: "{broken" }) },
	{ args: ["classify"], options: () => ({ stdinPath: directory }) },
	{ args: ["classify"], options: () => ({ stdin: validInput, preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS }) },
	{ args: ["classify"], options: () => ({ stdin: validInput }), setup: () => setFake(fixture, "honest", events({ completed: false }), 1) },
	{ args: ["classify"], options: () => ({ stdin: validInput }), setup: () => setFake(fixture, "honest", events({ message: "not a classification" })) },
	{ args: ["classify"], options: () => ({ stdin: "{broken", preload: preload("refused", serializerThrowsOn("refused")) }) },
]

function projection(value: { causeCode: string; outcome: string; transactionState: string; exitCode: number; failureClass: string | null; retryable: boolean; repairAction: string | null }): string {
	return [value.causeCode, value.outcome, value.transactionState, value.exitCode, value.failureClass ?? "", value.retryable, value.repairAction ?? ""].join("|")
}

test("classify declares exactly the expected stations", () => {
	const stations = envelope(invoke(fixture, ["--discover-command", "source-intake-classify.classify", "--json"])).result.data.stations
	expect(stations.map(projection).sort()).toEqual(EXPECTED_STATIONS)
})

proofs.test("classify reaches every declared station", () => {
	const observed = REACHING_ROWS.map((row) => {
		setFake(fixture, "honest")
		row.setup?.()
		const result = envelope(invoke(fixture, [...row.args, "--json"], row.options?.())).result
		expect(result.commandIdentity).toBe("source-intake-classify.classify")
		return projection(result)
	})
	expect(observed.sort()).toEqual(EXPECTED_STATIONS)
}, 120_000)

// Wrong behavior caught: discovery promising one next step while the command emits another.
proofs.test("the emitted success guidance is the guidance discovery declares", () => {
	const declared = envelope(invoke(fixture, ["--discover-command", "source-intake-classify.classify", "--json"])).result.data.stations.find((station: { causeCode: string }) => station.causeCode === "SUCCESS_COMPLETED")
	const emitted = envelope(invoke(fixture, ["classify", "--json"], { stdin: validInput }))
	expect(emitted.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(emitted.result.nextAction).toBe(declared.guidance.nextAction)
	// Independent oracle: the success message restated from the package README.
	expect(emitted.message).toBe("Classified one granted projection in the read-denied lane.")
}, 60_000)

proofs.test("effects follow the transaction state on every model-side station", () => {
	const success = envelope(invoke(fixture, ["classify", "--json"], { stdin: validInput })).result
	expect(success.effects).toEqual({ completed: ["classifier-model-call"], inventoryComplete: true, remaining: [], uncertain: [] })
	setFake(fixture, "honest", events({ thread: false }))
	const unknown = envelope(invoke(fixture, ["classify", "--json"], { stdin: validInput })).result
	expect(unknown.effects).toEqual({ completed: [], inventoryComplete: true, remaining: [], uncertain: ["classifier-model-call"] })
	expect(unknown.handoff.owner).toBe("human")
}, 60_000)

describe("validated output and transport failure", () => {
	// Wrong behavior caught: a fallback that reports "unchanged" after the model call completed would invite a replay.
	proofs.test("a completed run whose result cannot be emitted keeps its completed effect", () => {
		const result = invoke(fixture, ["classify", "--json"], { stdin: validInput, preload: preload("success", serializerThrowsOn("success")) })
		expect(result.exitCode).toBe(1)
		expect(envelope(result).result).toMatchObject({ causeCode: "INTERNAL_RESULT_COMPLETED", transactionState: "completed", data: null })
		expect(envelope(result).result.effects.completed).toEqual(["classifier-model-call"])
	}, 60_000)

	test("machine mode: a failed stdout write leaves stderr empty and emits no replacement envelope", () => {
		expect(invoke(fixture, ["--help", "--json"], { preload: preload("stdout", STDOUT_THROWS) })).toEqual({ exitCode: 1, stdout: "", stderr: "" })
	})

	test("human mode: a failed stdout write prints one repair line on stderr", () => {
		expect(invoke(fixture, ["--help"], { preload: preload("stdout", STDOUT_THROWS) })).toEqual({ exitCode: 1, stdout: "", stderr: "stdout cannot be written. Inspect the output stream before retrying.\n" })
	})

	test("a streaming producer past 256 KiB gets exit 4 and the process ends", async () => {
		const child = Bun.spawn([process.execPath, RUNTIME, "classify", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
		const stdout = new Response(child.stdout).text()
		let exited = false
		void child.exited.then(() => {
			exited = true
		})
		const chunk = new Uint8Array(64 * 1024).fill(0x20)
		const deadline = Date.now() + 3_000
		while (!exited && Date.now() < deadline) {
			try {
				child.stdin.write(chunk)
				await Promise.race([child.stdin.flush(), Bun.sleep(20)])
			} catch {
				break
			}
		}
		const exitCode = await Promise.race([child.exited, Bun.sleep(1_000).then(() => "still running")])
		if (!exited) child.kill("SIGKILL")
		expect(exitCode).toBe(4)
		expect(JSON.parse(await stdout).result.causeCode).toBe("SCHEMA_INVALID_INPUT")
	}, 10_000)

	test("held-open stdin: help never reads it, and classify waits for end of input", async () => {
		const help = Bun.spawn([process.execPath, RUNTIME, "--help", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
		expect(await Promise.race([help.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0)
		help.stdin.end()
		const classify = Bun.spawn([process.execPath, RUNTIME, "classify", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
		expect(await Promise.race([classify.exited, Bun.sleep(300).then(() => "waiting")])).toBe("waiting")
		classify.stdin.write("{broken")
		classify.stdin.end()
		expect(await Promise.race([classify.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(4)
	})

	test.skipIf(process.platform !== "darwin")("a terminal on stdin is a usage refusal, never a prompt", () => {
		const child = Bun.spawnSync(["/usr/bin/script", "-q", "/dev/null", process.execPath, RUNTIME, "classify", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
		expect(child.exitCode).toBe(2)
		expect(new TextDecoder().decode(child.stdout)).toContain('"causeCode":"USAGE_INVALID_INVOCATION"')
	})
})

// Contract Core bounded stop: a signal before any output exits 130 or 143 and leaves both streams empty.
for (const [signal, exitCode] of [
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	test(`${signal} before any output exits ${exitCode} with empty streams in both output modes`, async () => {
		for (const mode of [["--help"], ["--help", "--json"]]) {
			const ready = join(fixture.root, `ready-${signal}-${mode.length}`)
			const child = Bun.spawn([process.execPath, "--preload", STDOUT_HOLD_PRELOAD, RUNTIME, ...mode], {
				cwd: fixture.root,
				env: { ...fixture.env, SOURCE_INTAKE_TEST_READY: ready },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			})
			const stdout = new Response(child.stdout).text()
			const stderr = new Response(child.stderr).text()
			for (let attempt = 0; attempt < 5_000 && !existsSync(ready); attempt += 1) await Bun.sleep(1)
			expect(existsSync(ready)).toBe(true)
			child.kill(signal)
			expect(await child.exited).toBe(exitCode)
			expect(child.signalCode).toBeNull()
			expect({ stdout: await stdout, stderr: await stderr }).toEqual({ stdout: "", stderr: "" })
		}
	})
}

proofs.test("the strict CLI Design checker passes every applicable row", () => {
	// The checker passes argv only and gives every row /dev/null as stdin, so a test adapter maps stdin=FILE onto
	// standard input and lane=DIR onto PATH. Missing input: no codex on PATH. Unauthorized effect: a weakened lane.
	// The lane writes only under the fixture state root, so the checker watches a separate empty directory.
	const checkerCwd = join(fixture.root, "checker-cwd")
	mkdirSync(checkerCwd, { recursive: true })
	const result = Bun.spawnSync(
		[
			CHECKER,
			"--cwd", checkerCwd,
			"--command", `/bin/sh ${LANE_ADAPTER} ${process.execPath} ${RUNTIME}`,
			"--success-args", `stdin=${validPath} classify`,
			"--missing-args", `lane=/var/empty stdin=${validPath} classify`,
			"--internal-args", `stdin=${directory} classify`,
			"--schema-args", `stdin=${invalidPath} classify`,
			"--transient-args", `stdin-busy=${validPath} classify`,
			"--effect-args", `lane=${join(fixture.openFakeRoot, "bin")} stdin=${validPath} classify`,
			"--malformed-args", `stdin=${malformedPath} classify`,
			"--secret-args", `stdin=${validPath} classify`,
			"--secret-marker", SENTINEL,
			"--timeout-ms", "60000",
			"--json",
		],
		{ cwd: checkerCwd, env: { ...fixture.env, PATH: `${fixture.env.PATH}:${resolve(process.execPath, "..")}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	)
	const report = JSON.parse(result.stdout.toString())
	expect(report.message).toStartWith("Target contract 2.0.0 accepted.")
	expect(report.result).toMatchObject({ outcome: "success", exitCode: 0 })
	expect(report.result.data).toMatchObject({ passedCount: 18, failedCount: 0, targetUnchanged: true, changedPaths: [] })
	// large-envelope: an optional row the checker skips without --large-args; every output field is bounded.
	expect(report.result.data.skippedRows).toEqual(["large-envelope"])
	expect(result.exitCode).toBe(0)
}, 240_000)

proofs.pin(5)
