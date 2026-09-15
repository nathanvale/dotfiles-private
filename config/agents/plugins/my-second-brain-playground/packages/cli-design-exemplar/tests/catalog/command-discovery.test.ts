import { afterAll, describe, expect, test } from "bun:test"
import { COMMANDS } from "../../src/command-contract.ts"
import { createRoot, envelopeOf, removeRoot, type Root, runCli } from "../helpers/harness.ts"
import { EXPECTED_APPLY_COMMAND, EXPECTED_COMMAND_DISCOVERY_COMMAND, EXPECTED_STATION_COUNT, EXPECTED_STATION_SEMANTICS, expectedStationsFor } from "./expected-station-semantics.ts"

// B1 public discovery seam (accepted C0 command-scoped discovery): real `bun run src/main.ts` child processes on a
// fresh reset root; JSON is parsed through test-owned shapes and compared to literal expected records, never through
// MachineEnvelopeSchema. COMMANDS is enumerated for coverage only; every expected value comes from the B1 oracle.

const roots: Root[] = []
const root = (): Root => {
	const value = createRoot("healthy")
	roots.push(value)
	return value
}
afterAll(() => roots.forEach(removeRoot))

const PUBLIC_STATION_KEYS = ["causeCode", "commandIdentity", "effectClass", "exitCode", "failureClass", "guidance", "outcome", "reachability", "repairAction", "retryDelayPolicy", "retryable", "transactionState", "trigger", "unreachableRationale"]
const identityOf = (station: Record<string, unknown>): string => JSON.stringify([station.commandIdentity, station.outcome, station.causeCode])
const byIdentity = (left: Record<string, unknown>, right: Record<string, unknown>): number => identityOf(left).localeCompare(identityOf(right))
const sorted = (stations: readonly unknown[]): readonly Record<string, unknown>[] => [...(stations as readonly Record<string, unknown>[])].sort(byIdentity)

describe("command-scoped discovery", () => {
	test("returns literal possible outcomes for exactly the selected command in JSON mode", async () => {
		const run = await runCli(root(), ["--discover-command", "repair-lab.apply", "--json"])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		const envelope = envelopeOf(run)
		const result = envelope.result as Record<string, unknown>
		expect(result.commandIdentity).toBe("repair-lab.command-discovery")
		expect(result.outcome).toBe("success")
		expect(result.causeCode).toBe("SUCCESS_UNCHANGED")
		expect(result.effectClass).toBe("inspect")
		expect(result.transactionState).toBe("unchanged")
		const data = result.data as Record<string, unknown>
		expect(Object.keys(data).sort()).toEqual(["command", "semantics", "stations"])
		expect(data.semantics).toBe("possible-outcomes")
		expect(data.command).toEqual(EXPECTED_APPLY_COMMAND)
		const stations = data.stations as readonly Record<string, unknown>[]
		expect(sorted(stations)).toEqual(sorted(expectedStationsFor("repair-lab.apply")))
		expect(stations.length).toBeGreaterThan(0)
		for (const station of stations) {
			expect(Object.keys(station).sort()).toEqual(PUBLIC_STATION_KEYS)
			expect(station.commandIdentity).toBe("repair-lab.apply")
			expect(JSON.stringify(station)).not.toContain(String(result.runId))
			expect(JSON.stringify(station)).not.toContain("effect.")
		}
	})
	test("publishes the independently expected complete station semantics for every canonical command", async () => {
		const seen = new Set<string>()
		for (const command of COMMANDS) {
			const run = await runCli(root(), ["--discover-command", command.commandIdentity, "--json"])
			expect(run.exit, command.commandIdentity).toBe(0)
			expect(run.stderr, command.commandIdentity).toBe("")
			const data = (envelopeOf(run).result as Record<string, unknown>).data as { command: unknown; semantics: unknown; stations: readonly Record<string, unknown>[] }
			expect(data.command, command.commandIdentity).toEqual(command)
			expect(data.semantics).toBe("possible-outcomes")
			expect(sorted(data.stations), command.commandIdentity).toEqual(sorted(expectedStationsFor(command.commandIdentity)))
			for (const station of data.stations) seen.add(identityOf(station))
		}
		expect(seen.size).toBe(EXPECTED_STATION_COUNT)
		expect(seen).toEqual(new Set(EXPECTED_STATION_SEMANTICS.keys()))
		expect(COMMANDS.some((command) => command.commandIdentity === "repair-lab.command-discovery")).toBe(true)
		expect(COMMANDS.find((command) => command.commandIdentity === "repair-lab.command-discovery")).toEqual(EXPECTED_COMMAND_DISCOVERY_COMMAND)
	})
	test("renders a human selected-command summary with one line per possible outcome", async () => {
		const run = await runCli(root(), ["--discover-command", "repair-lab.apply"])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		const lines = run.stdout.split("\n").filter(Boolean)
		expect(lines[0]).toBe("repair-lab.apply: possible outcomes")
		expect(lines.slice(1)).toHaveLength(expectedStationsFor("repair-lab.apply").length)
		expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true)
		expect(run.stdout).toContain("refused | DOMAIN_PRECONDITION_UNMET | unchanged | exit 3 | retryable false | next-action | required")
	})
	test("refuses a missing selector as dispatch invalid invocation", async () => {
		for (const argv of [["--discover-command", "--json"], ["--discover-command", "--help", "--json"], ["--json", "--discover-command"]]) {
			const run = await runCli(root(), argv)
			expect(run.exit, argv.join(" ")).toBe(2)
			expect(run.stderr, argv.join(" ")).toBe("")
			const result = envelopeOf(run).result as Record<string, unknown>
			expect(result.commandIdentity, argv.join(" ")).toBe("repair-lab.dispatch")
			expect(result.causeCode, argv.join(" ")).toBe("USAGE_INVALID_INVOCATION")
			expect(result.data).toBeNull()
		}
		const human = await runCli(root(), ["--discover-command"])
		expect(human.exit).toBe(2)
		expect(human.stdout).toBe("")
		expect(human.stderr.split("\n").filter(Boolean)).toHaveLength(1)
	})
	test("refuses an unknown selector at command-discovery", async () => {
		const run = await runCli(root(), ["--discover-command", "repair-lab.nope", "--json"])
		expect(run.exit).toBe(2)
		expect(run.stderr).toBe("")
		const result = envelopeOf(run).result as Record<string, unknown>
		expect(result.commandIdentity).toBe("repair-lab.command-discovery")
		expect(result.causeCode).toBe("USAGE_UNKNOWN_COMMAND")
		expect(result.failureClass).toBe("usage")
		expect(result.transactionState).toBe("unchanged")
		expect(result.data).toBeNull()
		expect(result.nextAction).toBe("repair-lab --help")
		const human = await runCli(root(), ["--discover-command", "repair-lab.nope"])
		expect(human.exit).toBe(2)
		expect(human.stdout).toBe("")
		expect(human.stderr).toContain("unknown command")
	})
})
