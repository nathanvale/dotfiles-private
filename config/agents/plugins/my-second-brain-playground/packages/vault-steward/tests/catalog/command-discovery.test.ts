import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { COMMANDS } from "../../src/command-contract.ts"
import { cleanupFixtures, fixture } from "../helpers/harness.ts"
import { steward, stewardEnvironment } from "../helpers/steward.ts"
import { EXPECTED_BY_IDENTITY, EXPECTED_COMMANDS, EXPECTED_STATION_COUNT, identityOf } from "./expected-station-semantics.ts"

// Public discovery seam: real child processes; JSON parsed through test-owned shapes and compared to the literal
// expected records. COMMANDS is enumerated for coverage only.

setDefaultTimeout(60_000)
afterAll(cleanupFixtures)

const PUBLIC_STATION_KEYS = ["causeCode", "commandIdentity", "effectClass", "exitCode", "failureClass", "guidance", "outcome", "reachability", "repairAction", "retryDelayPolicy", "retryable", "transactionState", "unreachableRationale"]

function stationsOf(identity: string): Record<string, unknown>[] {
	const f = fixture({ hook: false })
	const run = steward(f.vault, ["--discover-command", identity], stewardEnvironment(f))
	expect(run.exitCode, identity).toBe(0)
	expect(run.stderr, identity).toBe("")
	const result = run.envelope?.result as Record<string, unknown>
	expect(result.commandIdentity).toBe("vault-steward.command-discovery")
	expect(result.causeCode).toBe("SUCCESS_UNCHANGED")
	expect(result.nextAction).toBe(identity)
	const data = result.data as { command: unknown; semantics: unknown; stations: Record<string, unknown>[] }
	expect(Object.keys(data).sort()).toEqual(["command", "semantics", "stations"])
	expect(data.semantics).toBe("possible-outcomes")
	return data.stations
}

test("--discover --json publishes the nine commands with their literal routes and effect classes", () => {
	const f = fixture({ hook: false })
	const run = steward(f.vault, ["--discover"], stewardEnvironment(f))
	expect(run.exitCode).toBe(0)
	expect(run.stderr).toBe("")
	const data = (run.envelope?.result as Record<string, unknown>).data as Record<string, unknown>
	expect(data.contractVersion).toBe("2.0.0")
	expect(data.generationConventionVersion).toBe("2.0.0")
	expect(data.profile).toBe("complex")
	expect(data.exitMeanings).toEqual({ "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" })
	expect(data.signalExits).toEqual({ "130": "SIGINT", "143": "SIGTERM" })
	expect(data.effectExclusions).toContain("remote sync (push, fetch, publish)")
	expect(data.effectExclusions).toContain("candidate rebase inside the private candidate worktree")
	const commands = (data.commands as Record<string, unknown>[]).map((command) => ({ commandIdentity: command.commandIdentity, route: command.route, effectClass: command.effectClass }))
	expect(commands).toEqual(EXPECTED_COMMANDS.map((command) => ({ commandIdentity: command.commandIdentity, route: [...command.route], effectClass: command.effectClass })))
	expect(run.envelope?.availablePaths).toEqual(["vault-steward.command-discovery", "vault-steward.discovery", "vault-steward.help"])
})

test("--discover-command publishes exactly the expected stations for every canonical command", () => {
	const seen = new Set<string>()
	for (const command of COMMANDS) {
		const stations = stationsOf(command.commandIdentity)
		const expected = [...EXPECTED_BY_IDENTITY.entries()].filter(([identity]) => identity.startsWith(`["${command.commandIdentity}",`))
		expect(stations.length, command.commandIdentity).toBe(expected.length)
		for (const station of stations) {
			expect(Object.keys(station).sort(), command.commandIdentity).toEqual(PUBLIC_STATION_KEYS)
			const identity = identityOf(station.commandIdentity as string, station.outcome as string, station.causeCode as string)
			const oracle = EXPECTED_BY_IDENTITY.get(identity)
			if (oracle === undefined) throw new Error(`${identity} is not an expected station`)
			expect(station.failureClass, identity).toBe(oracle.failureClass)
			expect(station.exitCode, identity).toBe(oracle.exit)
			expect(station.effectClass, identity).toBe(oracle.effectClass)
			expect(station.transactionState, identity).toBe(oracle.state)
			expect(station.retryable, identity).toBe(oracle.retryable)
			expect(station.retryDelayPolicy, identity).toEqual(oracle.delay === null ? { kind: "none" } : { kind: "bounded", minimumMilliseconds: oracle.delay, maximumMilliseconds: oracle.delay })
			expect(station.reachability, identity).toBe(oracle.reachability)
			expect(station.repairAction, identity).toBe(oracle.failureClass !== null)
			const guidance = station.guidance as { kind: string; nextActions?: string[]; owners?: string[] }
			expect(guidance.kind, identity).toBe(oracle.guidance)
			if (oracle.guidance === "next-action") expect(guidance.nextActions, identity).toEqual(oracle.nextActions)
			else expect(guidance.owners?.length, identity).toBe(1)
			expect(JSON.stringify(station)).not.toContain("run-")
			seen.add(identity)
		}
	}
	expect(seen.size).toBe(EXPECTED_STATION_COUNT)
	expect(seen).toEqual(new Set(EXPECTED_BY_IDENTITY.keys()))
})

test("human selected-command discovery prints one line per possible outcome", () => {
	const f = fixture({ hook: false })
	const run = steward(f.vault, ["--discover-command", "vault-steward.finish-apply"], stewardEnvironment(f), false)
	expect(run.exitCode).toBe(0)
	expect(run.stderr).toBe("")
	const lines = run.stdout.split("\n").filter(Boolean)
	expect(lines[0]).toBe("vault-steward.finish-apply: possible outcomes")
	expect(lines.length - 1).toBe([...EXPECTED_BY_IDENTITY.keys()].filter((identity) => identity.startsWith('["vault-steward.finish-apply",')).length)
	expect(lines.some((line) => line.includes("TRANSIENT_INTEGRATION_BUSY") && line.includes("exit 75") && line.includes("retryable true"))).toBe(true)
})

test("an unknown selector is refused at the command-discovery identity with discovery as the next action", () => {
	const f = fixture({ hook: false })
	const run = steward(f.vault, ["--discover-command", "vault-steward.nope"], stewardEnvironment(f))
	expect(run.exitCode).toBe(2)
	expect(run.stderr).toBe("")
	expect(run.envelope?.result).toMatchObject({ commandIdentity: "vault-steward.command-discovery", outcome: "refused", causeCode: "USAGE_UNKNOWN_COMMAND", exitCode: 2, nextAction: "vault-steward.discovery", data: null })
})
