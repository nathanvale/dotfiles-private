// Contract Core 2.0 through the public process: help, discovery, station reachability, validated output, transport
// failure and the strict CLI Design checker. Expected stations are a test-owned table, not the production catalogue:
// every declared station must be reached and every reached station must be declared.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
	CHECKER,
	createFixture,
	DESCRIPTOR_LIMIT_PRELOAD,
	EXHAUST_DESCRIPTORS,
	envelope,
	type Fixture,
	grant,
	type InvokeOptions,
	input,
	invoke,
	RUNTIME,
	receipt,
	removeFixture,
	request,
	SENTINEL,
	STDIN_ADAPTER,
	STDOUT_HOLD_PRELOAD,
	writeInput,
	writeJson,
} from "./fixtures/harness.ts"

let fixture: Fixture
let validInput: string
let validPath: string
let mismatchedInput: string
let mismatchedPath: string
let invalidPath: string
let directory: string

beforeAll(() => {
	fixture = createFixture()
	writeJson(fixture.receiptPath, receipt())
	validInput = input(grant(fixture), request())
	validPath = writeInput(fixture, grant(fixture), request(), "valid")
	mismatchedInput = input(grant(fixture), request({ provider: "opus" }))
	mismatchedPath = writeInput(fixture, grant(fixture), request({ provider: "opus" }), "mismatched")
	invalidPath = join(fixture.inputs, "invalid-input.json")
	writeFileSync(invalidPath, "{broken")
	directory = join(fixture.inputs, "a-directory")
	mkdirSync(directory)
})

afterAll(() => {
	removeFixture(fixture)
})

function preload(name: string, source: string): string {
	const path = join(fixture.root, `preload-${name}.ts`)
	writeFileSync(path, source)
	return path
}

const SERIALIZER_THROWS = `const stringify = JSON.stringify
JSON.stringify = (...args) => {
	if (args[0]?.result?.outcome === "success") {
		JSON.stringify = stringify
		throw new Error("fixture serializer failure")
	}
	return stringify(...args)
}
`

const SERIALIZER_DROPS_FIELD = `const stringify = JSON.stringify
JSON.stringify = (...args) => {
	const value = args[0]
	if (value?.result?.outcome === "success") {
		const { nextAction, ...result } = value.result
		return stringify({ ...value, result })
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
		expect(result.stdout).toContain("source-intake-dispatch project [--json] < GRANT_AND_REQUEST.json")
		expect(result.stdout).toContain("source-intake-dispatch --redacted RECIPIENT [--json]")
	})

	test("machine help lists every option with its value name", () => {
		const options = envelope(invoke(fixture, ["--help", "--json"])).result.data.options.map((option: { name: string; valueName: string | null }) => `${option.name} ${option.valueName}`)
		expect(options.sort()).toEqual(["--discover null", "--discover-command COMMAND_IDENTITY", "--help null", "--json null", "--redacted RECIPIENT"])
	})

	test("discovery reports the complex profile, inspect-only commands and effect exclusions", () => {
		const data = envelope(invoke(fixture, ["--discover", "--json"])).result.data
		expect(data).toMatchObject({ contractVersion: "2.0.0", generationConventionVersion: "2.0.0", profile: "complex" })
		expect(data.commands.map((command: { commandIdentity: string; effectClass: string }) => `${command.commandIdentity}:${command.effectClass}`)).toEqual([
			"source-intake-dispatch.dispatch:inspect",
			"source-intake-dispatch.help:inspect",
			"source-intake-dispatch.discovery:inspect",
			"source-intake-dispatch.command-discovery:inspect",
			"source-intake-dispatch.project:inspect",
			"source-intake-dispatch.redacted:inspect",
		])
		expect(data.effectExclusions).toContain("Never opens a private receipt before the grant and request match.")
	})

	test("human discovery is a concise line, not JSON", () => {
		expect(invoke(fixture, ["--discover"])).toEqual({ exitCode: 0, stderr: "", stdout: "Profile complex. Commands: project (inspect, reads standard input), --redacted RECIPIENT (inspect).\n" })
	})

	test("an unknown discovery selector is a usage refusal", () => {
		expect(envelope(invoke(fixture, ["--discover-command", "source-intake-dispatch.file", "--json"])).result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", exitCode: 2 })
	})
})

// Test-owned expected stations: cause|outcome|exit|class|retryable|repair action.
const EXPECTED_STATIONS: Record<"project" | "redacted", string[]> = {
	project: [
		"DOMAIN_PRECONDITION_UNMET|refused|3|domain|false|Verify the private grant, then issue a request that matches it exactly.",
		"INTERNAL_RESULT_UNCHANGED|failed|1|internal|false|Inspect the serialization failure before retrying.",
		"INTERNAL_UNEXPECTED|failed|1|internal|false|Pipe the grant and request from a readable file or stream.",
		"SCHEMA_INVALID_INPUT|refused|4|schema|false|Pipe exactly one JSON object with the grant and request keys and value formats in the package README.",
		"SUCCESS_UNCHANGED|success|0||false|",
		"TRANSIENT_NOT_STARTED|refused|75|transient|true|Wait for open files to be released, then retry the same command.",
		"USAGE_INVALID_INVOCATION|refused|2|usage|false|Choose one listed invocation with its required operands and retry.",
	],
	redacted: [
		"INTERNAL_RESULT_UNCHANGED|failed|1|internal|false|Inspect the serialization failure before retrying.",
		"SUCCESS_UNCHANGED|success|0||false|",
		"USAGE_INVALID_INVOCATION|refused|2|usage|false|Choose one listed invocation with its required operands and retry.",
	],
}

interface Row {
	args: string[]
	options?: () => InvokeOptions
}

// One invocation per reachable station.
const REACHING_ROWS: Record<"project" | "redacted", Row[]> = {
	project: [
		{ args: ["project"], options: () => ({ stdin: validInput }) },
		{ args: ["project", "extra"], options: () => ({ stdin: validInput }) },
		{ args: ["project"], options: () => ({ stdin: mismatchedInput }) },
		{ args: ["project"], options: () => ({ stdin: "{broken" }) },
		{ args: ["project"], options: () => ({ stdinPath: directory }) },
		{ args: ["project"], options: () => ({ stdin: validInput, preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS }) },
		{ args: ["project"], options: () => ({ stdin: validInput, preload: preload("throws", SERIALIZER_THROWS) }) },
	],
	redacted: [
		{ args: ["--redacted", "status"] },
		{ args: ["--redacted", "nobody"] },
		{ args: ["--redacted", "evaluation"], options: () => ({ preload: preload("throws", SERIALIZER_THROWS) }) },
	],
}

function projection(value: { causeCode: string; outcome: string; exitCode: number; failureClass: string | null; retryable: boolean; repairAction: string | null }): string {
	return [value.causeCode, value.outcome, value.exitCode, value.failureClass ?? "", value.retryable, value.repairAction ?? ""].join("|")
}

for (const command of ["project", "redacted"] as const) {
	test(`source-intake-dispatch.${command} declares exactly the expected stations and reaches every one`, () => {
		const stations = envelope(invoke(fixture, ["--discover-command", `source-intake-dispatch.${command}`, "--json"])).result.data.stations
		expect(stations.map(projection).sort()).toEqual(EXPECTED_STATIONS[command])
		const observed = REACHING_ROWS[command].map((row) => {
			const result = envelope(invoke(fixture, [...row.args, "--json"], row.options?.())).result
			expect(result.commandIdentity).toBe(`source-intake-dispatch.${command}`)
			return projection(result)
		})
		expect(observed.sort()).toEqual(EXPECTED_STATIONS[command])
	})
}

describe("validated output and transport failure", () => {
	test("a serializable result that fails envelope validation is replaced by the internal fallback", () => {
		const result = invoke(fixture, ["project", "--json"], { stdin: validInput, preload: preload("drop", SERIALIZER_DROPS_FIELD) })
		expect(result.exitCode).toBe(1)
		expect(envelope(result).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED", outcome: "failed", data: null })
		expect(result.stdout).not.toContain(SENTINEL)
	})

	test("machine mode: a failed stdout write leaves stderr empty and emits no replacement envelope", () => {
		expect(invoke(fixture, ["project", "--json"], { stdin: validInput, preload: preload("stdout", STDOUT_THROWS) })).toEqual({ exitCode: 1, stdout: "", stderr: "" })
	})

	test("human mode: a failed stdout write prints one repair line on stderr", () => {
		expect(invoke(fixture, ["project"], { stdin: validInput, preload: preload("stdout", STDOUT_THROWS) })).toEqual({ exitCode: 1, stdout: "", stderr: "stdout cannot be written. Inspect the output stream before retrying.\n" })
	})

	// Wrong behavior caught: returning the exit 4 envelope while standard input stays open, so a producer that keeps
	// writing holds the process forever.
	test("a streaming producer past 64 KiB gets exit 4 and the process ends", async () => {
		const child = Bun.spawn([process.execPath, RUNTIME, "project", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
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

	test("held-open stdin: other commands never read it, and project waits for end of input", async () => {
		const redacted = Bun.spawn([process.execPath, RUNTIME, "--redacted", "status", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
		expect(await Promise.race([redacted.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0)
		redacted.stdin.end()
		const project = Bun.spawn([process.execPath, RUNTIME, "project", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
		expect(await Promise.race([project.exited, Bun.sleep(300).then(() => "waiting")])).toBe("waiting")
		project.stdin.write(validInput)
		project.stdin.end()
		expect(await Promise.race([project.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0)
		expect(JSON.parse(await new Response(project.stdout).text()).result.causeCode).toBe("SUCCESS_UNCHANGED")
	})

	// A terminal on stdin is refused as usage instead of waiting for typed input. script(1) supplies the terminal; its
	// arguments differ on Linux, so this proof runs on macOS only.
	test.skipIf(process.platform !== "darwin")("a terminal on stdin is a usage refusal, never a prompt", () => {
		const child = Bun.spawnSync(["/usr/bin/script", "-q", "/dev/null", process.execPath, RUNTIME, "project", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
		expect(child.exitCode).toBe(2)
		expect(new TextDecoder().decode(child.stdout)).toContain('"causeCode":"USAGE_INVALID_INVOCATION"')
	})
})

// Contract Core bounded stop: a signal before any output exits 130 or 143 and leaves both streams empty. Wrong behavior
// caught: no handler (the process dies by signal with no exit code) or a handler that writes a replacement result.
for (const [signal, exitCode] of [
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	test(`${signal} before any output exits ${exitCode} with empty streams in both output modes`, async () => {
		for (const mode of [[], ["--json"]]) {
			const ready = join(fixture.root, `ready-${signal}-${mode.length}`)
			const child = Bun.spawn([process.execPath, "--preload", STDOUT_HOLD_PRELOAD, RUNTIME, "project", ...mode], {
				cwd: fixture.root,
				env: { ...fixture.env, SOURCE_INTAKE_TEST_READY: ready },
				stdin: new Blob([validInput]),
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

test("the strict CLI Design checker passes every applicable row", () => {
	// The checker passes argv only and gives every row /dev/null as stdin, so a test adapter maps stdin=FILE onto the
	// command's standard input. The missing-input row pipes a matching grant for an item that has no receipt.
	const missingPath = writeInput(fixture, grant(fixture, { opaqueItemRef: "synthetic-item-404", receiptPath: fixture.receiptPath.replace("synthetic-item-001", "synthetic-item-404") }), request({ opaqueItemRef: "synthetic-item-404" }), "missing")
	const malformedPath = writeInput(fixture, grant(fixture), request({ opaqueItemRef: "Not_An_Item" }), "malformed")
	const result = Bun.spawnSync(
		[
			CHECKER,
			"--cwd", fixture.root,
			"--command", `/bin/sh ${STDIN_ADAPTER} ${process.execPath} ${RUNTIME}`,
			"--success-args", `stdin=${validPath} project`,
			"--missing-args", `stdin=${missingPath} project`,
			"--internal-args", `stdin=${directory} project`,
			"--schema-args", `stdin=${invalidPath} project`,
			"--transient-args", `stdin-busy=${validPath} project`,
			"--effect-args", `stdin=${mismatchedPath} project`,
			"--malformed-args", `stdin=${malformedPath} project`,
			"--secret-args", `stdin=${validPath} project`,
			"--secret-marker", SENTINEL,
			"--timeout-ms", "30000",
			"--json",
		],
		{ cwd: fixture.root, env: { ...fixture.env, PATH: `${fixture.env.PATH}:${resolve(process.execPath, "..")}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	)
	const report = JSON.parse(result.stdout.toString())
	expect(report.message).toStartWith("Target contract 2.0.0 accepted.")
	expect(report.result).toMatchObject({ outcome: "success", exitCode: 0 })
	expect(report.result.data).toMatchObject({ passedCount: 18, failedCount: 0, targetUnchanged: true, changedPaths: [] })
	// large-envelope: an optional row the checker skips without --large-args; every output is bounded by four fields.
	expect(report.result.data.skippedRows).toEqual(["large-envelope"])
	expect(result.exitCode).toBe(0)
}, 60_000)
