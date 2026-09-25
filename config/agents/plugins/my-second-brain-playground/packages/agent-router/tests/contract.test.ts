// Acceptance B1: public help, discovery, command-scoped discovery and the strict CLI Design checker, all through the
// public process. The expected station table below is an independent oracle; it is not read from src/contract.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { CLI, createFixture, envelope, type Fixture, invoke, removeFixture, route, SECRET_MARKER, writeRoutes } from "./fixtures/harness.ts"

const CHECKER = resolve(import.meta.dir, "../../../bin/cli-design-check")

// Independent oracle: cause|outcome|exit for every declared station per command.
const EXPECTED_STATIONS = {
	"agent-router.routes": [
		"INTERNAL_RESULT_EMISSION|failed|1",
		"INTERNAL_RESULT_SERIALIZATION|failed|1",
		"INTERNAL_UNEXPECTED|failed|1",
		"SCHEMA_CONFIG_INVALID|refused|4",
		"SCHEMA_INVALID_INPUT|refused|4",
		"SUCCESS_UNCHANGED|success|0",
		"TRANSIENT_NOT_STARTED|refused|75",
	],
	"agent-router.run": [
		"DOMAIN_AUTHORITY_REQUIRED|refused|3",
		"DOMAIN_CONFIG_MISSING|refused|3",
		"INTERNAL_RESULT_EMISSION|failed|1",
		"INTERNAL_RESULT_SERIALIZATION|failed|1",
		"INTERNAL_UNEXPECTED|failed|1",
		"SCHEMA_CONFIG_INVALID|refused|4",
		"SCHEMA_INVALID_INPUT|refused|4",
		"SUCCESS_UNCHANGED|success|0",
		"TRANSIENT_NOT_STARTED|refused|75",
		"USAGE_INVALID_INVOCATION|refused|2",
	],
}

let fixture: Fixture

beforeAll(() => {
	fixture = createFixture()
	writeRoutes(fixture, [route("personal-claude-code")])
})

afterAll(() => removeFixture(fixture))

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
			"--observations-file PATH",
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

	for (const [identity, expected] of Object.entries(EXPECTED_STATIONS)) {
		test(`command discovery lists every station of ${identity}`, () => {
			const stations = envelope(invoke(fixture, ["--discover-command", identity, "--json"])).result.data.stations
			expect(stations.map((station: { causeCode: string; outcome: string; exitCode: number }) => `${station.causeCode}|${station.outcome}|${station.exitCode}`).sort()).toEqual(expected)
		})
	}

	test("an unknown discovery selector is a usage refusal", () => {
		expect(envelope(invoke(fixture, ["--discover-command", "agent-router.launch", "--json"])).result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", exitCode: 2 })
	})
})

test("a serialization failure emits the internal fallback envelope", async () => {
	const preload = join(fixture.root, "serializer-failure.ts")
	await Bun.write(
		preload,
		`const stringify = JSON.stringify
JSON.stringify = (...args) => {
	if (args[0]?.result?.outcome === "success") {
		JSON.stringify = stringify
		throw new Error("fixture serializer failure")
	}
	return stringify(...args)
}
`,
	)
	const result = envelope(invoke(fixture, ["routes", "--json"], preload))
	expect(result.result).toMatchObject({ causeCode: "INTERNAL_RESULT_SERIALIZATION", outcome: "failed", exitCode: 1, data: null })
})

test("the strict CLI Design checker passes every applicable row", () => {
	const checked = createFixture({ monashDelaySeconds: 0.3 })
	try {
		writeRoutes(checked, [route("personal-claude-code")])
		const invalid = join(checked.root, "invalid-routes.json")
		writeFileSync(invalid, "{broken")
		const directory = join(checked.root, "a-directory")
		mkdirSync(directory)
		const result = Bun.spawnSync(
			[
				CHECKER,
				"--cwd", checked.root,
				"--command", `${process.execPath} ${CLI}`,
				"--success-args", "routes",
				"--missing-args", `run hpr-f5n.3 --dry-run --routes-file ${join(checked.root, "absent.json")}`,
				"--internal-args", `run hpr-f5n.3 --dry-run --routes-file ${directory}`,
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
		expect(report.result).toMatchObject({ outcome: "success", exitCode: 0 })
		expect(report.result.data).toMatchObject({ passedCount: 18, failedCount: 0, targetUnchanged: true, changedPaths: [] })
		// large-envelope: every output is bounded by the declared routes and one Monash snapshot.
		expect(report.result.data.skippedRows).toEqual(["large-envelope"])
		expect(result.exitCode).toBe(0)
	} finally {
		removeFixture(checked)
	}
}, 60_000)
