// Acceptance B1: public help, discovery, station reachability, validated output, transport failure and the strict
// CLI Design checker, all through the public process. Stations are checked against what the process actually emits:
// every declared station must be reached and every reached station must be declared.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { CLI, createFixture, envelope, type Fixture, invoke, removeFixture, route, SECRET_MARKER, writeRoutes } from "./fixtures/harness.ts"

const CHECKER = resolve(import.meta.dir, "../../../bin/cli-design-check")

let fixture: Fixture
let slow: Fixture
let invalidRoutes: string
let directory: string

beforeAll(() => {
	fixture = createFixture()
	writeRoutes(fixture, [route("personal-claude-code")])
	slow = createFixture({ monashDelaySeconds: 0.5 })
	writeRoutes(slow, [route("personal-claude-code")])
	invalidRoutes = join(fixture.root, "invalid-routes.json")
	writeFileSync(invalidRoutes, "{broken")
	directory = join(fixture.root, "a-directory")
	mkdirSync(directory)
})

afterAll(() => {
	removeFixture(fixture)
	removeFixture(slow)
})

async function preload(name: string, source: string): Promise<string> {
	const path = join(fixture.root, `preload-${name}.ts`)
	await Bun.write(path, source)
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
	test("human help names both commands and the dry-run requirement", () => {
		const result = invoke(fixture, ["--help"])
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(result.stdout).toContain("agent-router routes [--routes-file PATH]")
		expect(result.stdout).toContain("agent-router run TASK --dry-run")
	})

	test("machine help lists every option with its value name", () => {
		const options = envelope(invoke(fixture, ["--help", "--json"])).result.data.options.map((option: { name: string; valueName: string | null }) => `${option.name} ${option.valueName}`)
		expect(options.sort()).toEqual([
			"--discover null",
			"--discover-command COMMAND_IDENTITY",
			"--dry-run null",
			"--help null",
			"--herdr-projects-root DIR",
			"--json null",
			"--probe-timeout-ms N",
			"--project NAME",
			"--routes-file PATH",
		])
	})

	test("discovery reports the simple profile, inspect-only commands and effect exclusions", () => {
		const data = envelope(invoke(fixture, ["--discover", "--json"])).result.data
		expect(data).toMatchObject({ contractVersion: "2.0.0", profile: "simple" })
		expect(data.commands.map((command: { commandIdentity: string; effectClass: string }) => `${command.commandIdentity}:${command.effectClass}`)).toEqual([
			"agent-router.dispatch:inspect",
			"agent-router.help:inspect",
			"agent-router.discovery:inspect",
			"agent-router.command-discovery:inspect",
			"agent-router.routes:inspect",
			"agent-router.run:inspect",
		])
		expect(data.effectExclusions).toContain("Never consults TypeSafe or sends Task text anywhere.")
	})

	test("an unknown discovery selector is a usage refusal", () => {
		expect(envelope(invoke(fixture, ["--discover-command", "agent-router.launch", "--json"])).result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", exitCode: 2 })
	})
})

interface Row {
	fixture: () => Fixture
	args: string[]
	preload?: string
}

// One invocation per reachable envelope-bearing station. INTERNAL_RESULT_EMISSION has no envelope by contract and is
// proved by the transport tests below.
function reachingRows(command: "routes" | "run"): Row[] {
	const run = command === "run" ? ["run", "hpr-f5n.3", "--dry-run"] : ["routes"]
	const rows: Row[] = [
		{ fixture: () => fixture, args: run },
		{ fixture: () => fixture, args: command === "run" ? ["run"] : ["routes", "extra"] },
		{ fixture: () => fixture, args: [...run, "--probe-timeout-ms", "abc"] },
		{ fixture: () => fixture, args: [...run, "--routes-file", invalidRoutes] },
		{ fixture: () => slow, args: [...run, "--probe-timeout-ms", "50"] },
		{ fixture: () => fixture, args: [...run, "--routes-file", directory] },
		{ fixture: () => fixture, args: run, preload: SERIALIZER_THROWS },
	]
	if (command === "run") {
		rows.push({ fixture: () => fixture, args: [...run, "--routes-file", join(fixture.root, "absent.json")] })
		rows.push({ fixture: () => fixture, args: ["run", "hpr-f5n.3"] })
	}
	return rows
}

function projection(value: { causeCode: string; outcome: string; exitCode: number; failureClass: string | null; retryable: boolean; repairAction: string | null }) {
	return [value.causeCode, value.outcome, value.exitCode, value.failureClass, value.retryable, value.repairAction].join("|")
}

for (const command of ["routes", "run"] as const) {
	test(`every declared station of agent-router.${command} is reached, and every reached station is declared`, async () => {
		const stations = envelope(invoke(fixture, ["--discover-command", `agent-router.${command}`, "--json"])).result.data.stations
		const declared = stations.filter((station: { causeCode: string }) => station.causeCode !== "INTERNAL_RESULT_EMISSION").map(projection).sort()
		const observed: string[] = []
		for (const row of reachingRows(command)) {
			const path = row.preload === undefined ? undefined : await preload("row", row.preload)
			const result = envelope(invoke(row.fixture(), [...row.args, "--json"], path)).result
			expect(result.commandIdentity).toBe(`agent-router.${command}`)
			observed.push(projection(result))
		}
		expect(observed.sort()).toEqual(declared)
		expect(stations.map((station: { causeCode: string }) => station.causeCode)).toContain("INTERNAL_RESULT_EMISSION")
	})
}

describe("validated output and transport failure", () => {
	test("a serializable result that fails envelope validation is replaced by the internal fallback", async () => {
		const result = envelope(invoke(fixture, ["routes", "--json"], await preload("drop", SERIALIZER_DROPS_FIELD))).result
		expect(result).toMatchObject({ causeCode: "INTERNAL_RESULT_SERIALIZATION", outcome: "failed", exitCode: 1, data: null })
	})

	test("machine mode: a failed stdout write leaves stderr empty and emits no replacement envelope", async () => {
		const result = invoke(fixture, ["routes", "--json"], await preload("stdout", STDOUT_THROWS))
		expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "" })
	})

	test("human mode: a failed stdout write prints one repair line on stderr", async () => {
		const result = invoke(fixture, ["routes"], await preload("stdout", STDOUT_THROWS))
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe("")
		expect(result.stderr).toStartWith("stdout cannot be written.")
		expect(result.stderr.trim().split("\n")).toHaveLength(1)
	})

	test("machine mode: a consumer that closes the pipe early gets no stderr and no replacement envelope", async () => {
		const release = join(fixture.root, "release")
		const ready = join(fixture.root, "ready")
		const hold = await preload(
			"hold",
			`import { existsSync, writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(ready)}, "ready")
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(1)
`,
		)
		const child = Bun.spawn([process.execPath, "--preload", hold, CLI, "routes", "--json"], { cwd: fixture.root, env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
		const stderr = new Response(child.stderr).text()
		for (let attempt = 0; attempt < 5_000 && !existsSync(ready); attempt += 1) await Bun.sleep(1)
		await child.stdout.cancel()
		writeFileSync(release, "release")
		expect(await child.exited).toBe(1)
		expect(await stderr).toBe("")
	})
})

test("the strict CLI Design checker passes every applicable row", () => {
	const checked = createFixture({ monashDelaySeconds: 0.3 })
	try {
		writeRoutes(checked, [route("personal-claude-code")])
		// The checker hashes its whole --cwd tree, so it must read the sentinels; they still carry the secret marker.
		for (const path of checked.credentialSentinels) chmodSync(path, 0o600)
		const invalid = join(checked.root, "invalid-routes.json")
		writeFileSync(invalid, "{broken")
		const unreadable = join(checked.root, "a-directory")
		mkdirSync(unreadable)
		const result = Bun.spawnSync(
			[
				CHECKER,
				"--cwd", checked.root,
				"--command", `${process.execPath} ${CLI}`,
				"--success-args", "routes",
				"--missing-args", `run hpr-f5n.3 --dry-run --routes-file ${join(checked.root, "absent.json")}`,
				"--internal-args", `run hpr-f5n.3 --dry-run --routes-file ${unreadable}`,
				"--schema-args", `run hpr-f5n.3 --dry-run --routes-file ${invalid}`,
				"--transient-args", "routes --probe-timeout-ms 50",
				"--effect-args", "run hpr-f5n.3",
				"--malformed-args", "run NOT_A_TASK --dry-run",
				"--secret-args", "routes",
				"--secret-marker", SECRET_MARKER,
				"--timeout-ms", "30000",
				"--json",
			],
			{ cwd: checked.root, env: { ...checked.env, PATH: `${checked.env.PATH}:${resolve(process.execPath, "..")}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		)
		const report = JSON.parse(result.stdout.toString())
		expect(report.message).toStartWith("Target contract 2.0.0 accepted.")
		expect(report.result).toMatchObject({ outcome: "success", exitCode: 0 })
		expect(report.result.data).toMatchObject({ passedCount: 18, failedCount: 0, targetUnchanged: true, changedPaths: [] })
		// large-envelope: every output is bounded by the declared routes and one Monash snapshot.
		expect(report.result.data.skippedRows).toEqual(["large-envelope"])
		expect(result.exitCode).toBe(0)
	} finally {
		removeFixture(checked)
	}
}, 60_000)
