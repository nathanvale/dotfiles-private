import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { STATIONS } from "../../src/branch-station-catalog.ts"
import { BEAD, bindingPath, bindSession, createRoot, envelopeOf, OTHER_BEAD, removeRoot, resultOf, type Root, type Run, runCli, runCliOnPlatform, runCliWithStoreFault, runCliWithThrowingBeads, spawnLockHolder, steerBd } from "../fixtures/harness.ts"

// Catalog layer. STATIONS supplies the domain to enumerate only. EXPECTED is the independent oracle restated from
// Spec #57, Ticket #58 and Contract Core 1.0.0: outcome, causeCode, effectClass, transactionState, retryable,
// retryDelayMilliseconds, guidance and exit per station. Marked independent oracle: a dedupe pass must not hoist
// these literals into the catalog. Every declared station is reached by one real public process; an unobserved
// declaration fails its row, and the pinned count fails on any drift.

type Guidance = "next-action" | "handoff" | "none"
type Expected = readonly [outcome: string, causeCode: string | null, effectClass: string, transactionState: string, retryable: boolean, delay: number | null, guidance: Guidance, exit: number]

const DECLARED_STATION_COUNT = 50
const INSPECT = "inspect"
const LOCAL = "repository-local"

const usage = (effectClass: string): Expected => ["refused", "USAGE_INVALID_INVOCATION", effectClass, "unchanged", false, null, "next-action", 2]
const domain = (cause: string, effectClass: string): Expected => ["refused", cause, effectClass, "unchanged", false, null, "next-action", 3]
const schema = (cause: string, effectClass: string): Expected => ["refused", cause, effectClass, "unchanged", false, null, "next-action", 4]
const beadsUnavailable = (effectClass: string): Expected => ["failed", "UNAVAILABLE_BEADS_READ", effectClass, "unchanged", true, 1000, "next-action", 75]
const internal = (effectClass: string): Expected => ["failed", "INTERNAL_UNEXPECTED", effectClass, "unchanged", false, null, "handoff", 1]

const EXPECTED: Readonly<Record<string, Expected>> = {
	"msb-workflow.help#help-shown": ["success", null, INSPECT, "unchanged", false, null, "none", 0],
	"msb-workflow.discover#discovery-shown": ["success", null, INSPECT, "unchanged", false, null, "none", 0],
	"msb-workflow.help#usage-refused": usage(INSPECT),
	"msb-workflow.discover#usage-refused": usage(INSPECT),
	"msb-workflow.inspect#usage-refused": usage(INSPECT),
	"msb-workflow.bind#usage-refused": usage(LOCAL),
	"msb-workflow.recover#usage-refused": usage(INSPECT),
	"msb-workflow.hook#usage-refused": usage(LOCAL),
	"msb-workflow.inspect#state-root-refused": domain("DOMAIN_STATE_ROOT_UNSAFE", INSPECT),
	"msb-workflow.bind#state-root-refused": domain("DOMAIN_STATE_ROOT_UNSAFE", LOCAL),
	"msb-workflow.recover#state-root-refused": domain("DOMAIN_STATE_ROOT_UNSAFE", INSPECT),
	"msb-workflow.inspect#workspace-refused": domain("DOMAIN_WORKSPACE_INVALID", INSPECT),
	"msb-workflow.bind#workspace-refused": domain("DOMAIN_WORKSPACE_INVALID", LOCAL),
	"msb-workflow.recover#workspace-refused": domain("DOMAIN_WORKSPACE_INVALID", INSPECT),
	"msb-workflow.inspect#session-invalid": domain("DOMAIN_SESSION_INVALID", INSPECT),
	"msb-workflow.bind#session-invalid": domain("DOMAIN_SESSION_INVALID", LOCAL),
	"msb-workflow.recover#session-invalid": domain("DOMAIN_SESSION_INVALID", INSPECT),
	"msb-workflow.inspect#session-conflict": domain("DOMAIN_SESSION_CONFLICT", INSPECT),
	"msb-workflow.bind#session-conflict": domain("DOMAIN_SESSION_CONFLICT", LOCAL),
	"msb-workflow.recover#session-conflict": domain("DOMAIN_SESSION_CONFLICT", INSPECT),
	"msb-workflow.inspect#internal-failure": internal(INSPECT),
	"msb-workflow.bind#internal-failure": internal(LOCAL),
	"msb-workflow.recover#internal-failure": internal(INSPECT),
	"msb-workflow.inspect#beads-unavailable": beadsUnavailable(INSPECT),
	"msb-workflow.bind#beads-unavailable": beadsUnavailable(LOCAL),
	"msb-workflow.recover#beads-unavailable": beadsUnavailable(INSPECT),
	"msb-workflow.bind#executable-refused": domain("DOMAIN_EXECUTABLE_INVALID", LOCAL),
	"msb-workflow.recover#executable-refused": domain("DOMAIN_EXECUTABLE_INVALID", INSPECT),
	"msb-workflow.bind#store-mismatch": domain("DOMAIN_STORE_MISMATCH", LOCAL),
	"msb-workflow.recover#store-mismatch": domain("DOMAIN_STORE_MISMATCH", INSPECT),
	"msb-workflow.bind#state-unsafe": domain("DOMAIN_STATE_UNSAFE", LOCAL),
	"msb-workflow.recover#state-unsafe": domain("DOMAIN_STATE_UNSAFE", INSPECT),
	"msb-workflow.bind#binding-invalid": schema("SCHEMA_BINDING_INVALID", LOCAL),
	"msb-workflow.recover#binding-invalid": schema("SCHEMA_BINDING_INVALID", INSPECT),
	"msb-workflow.bind#bead-missing": domain("DOMAIN_BEAD_MISSING", LOCAL),
	"msb-workflow.recover#bead-missing": domain("DOMAIN_BEAD_MISSING", INSPECT),
	"msb-workflow.inspect#inspected": ["success", null, INSPECT, "unchanged", false, null, "next-action", 0],
	"msb-workflow.inspect#inspect-refused": domain("DOMAIN_PREREQUISITE_FAILED", INSPECT),
	"msb-workflow.bind#source-repository-missing": domain("DOMAIN_SOURCE_REPOSITORY_MISSING", LOCAL),
	"msb-workflow.bind#evidence-invalid": domain("DOMAIN_EVIDENCE_INVALID", LOCAL),
	"msb-workflow.bind#binding-owner-conflict": domain("DOMAIN_BINDING_OWNERSHIP_CONFLICT", LOCAL),
	"msb-workflow.bind#binding-inherited-conflict": domain("DOMAIN_SESSION_INHERITED_CONFLICT", LOCAL),
	"msb-workflow.bind#storage-busy": ["failed", "UNAVAILABLE_STORAGE_BUSY", LOCAL, "unchanged", true, 2000, "next-action", 75],
	"msb-workflow.bind#platform-unsupported": ["failed", "UNAVAILABLE_LOCK_UNSUPPORTED", LOCAL, "unchanged", false, null, "next-action", 75],
	"msb-workflow.bind#write-failed": ["failed", "UNAVAILABLE_WRITE_FAILED", LOCAL, "unchanged", true, null, "next-action", 75],
	"msb-workflow.bind#write-unknown": ["unknown", "INTERNAL_WRITE_OUTCOME_UNKNOWN", LOCAL, "unknown", false, null, "next-action", 1],
	"msb-workflow.bind#bound": ["success", null, LOCAL, "completed", false, null, "next-action", 0],
	"msb-workflow.recover#recovered": ["success", null, INSPECT, "unchanged", false, null, "next-action", 0],
	"msb-workflow.recover#binding-absent": domain("DOMAIN_BINDING_ABSENT", INSPECT),
	"msb-workflow.recover#binding-workspace-mismatch": domain("DOMAIN_BINDING_WORKSPACE_MISMATCH", INSPECT),
}

const SESSION = "session-1"
const bindArgv = (root: Root, extra: string[] = []): string[] => ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", BEAD, ...extra, "--json"]
const recoverArgv = (root: Root, workspace = root.workspace): string[] => ["recover", "--workspace", workspace, "--session", SESSION, "--json"]
const inspectArgv = (root: Root): string[] => ["inspect", "--workspace", root.workspace, "--session", SESSION, "--json"]

function plant(root: Root, bytes: string): void {
	mkdirSync(join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery", "sessions"), { recursive: true, mode: 0o700 })
	writeFileSync(bindingPath(root, SESSION), bytes, { mode: 0o600 })
}

function symlinkBinding(root: Root): void {
	const target = join(root.privateRoot, "elsewhere.json")
	writeFileSync(target, "{}\n", { mode: 0o600 })
	mkdirSync(join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery", "sessions"), { recursive: true, mode: 0o700 })
	symlinkSync(target, bindingPath(root, SESSION))
}

async function bindThenBreakExecutable(root: Root): Promise<void> {
	await bindSession(root, SESSION)
	const binding = JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as Record<string, unknown>
	writeFileSync(bindingPath(root, SESSION), `${JSON.stringify({ ...binding, beadsExecutable: join(root.privateRoot, "no-bd") })}\n`, { mode: 0o600 })
}

const absentRoot = (root: Root): Record<string, string> => ({ MSB_WORKFLOW_STATE_HOME: join(root.privateRoot, "absent-state") })

/** One real public process per declared station. Each reach uses only the public seams the harness documents. */
const REACH: Readonly<Record<string, (root: Root) => Promise<Run>>> = {
	"msb-workflow.help#help-shown": (root) => runCli(root, ["--help", "--json"]),
	"msb-workflow.discover#discovery-shown": (root) => runCli(root, ["--discover", "--json"]),
	"msb-workflow.help#usage-refused": (root) => runCli(root, ["--json"]),
	"msb-workflow.discover#usage-refused": (root) => runCli(root, ["--discover", "--workspace", root.workspace, "--json"]),
	"msb-workflow.inspect#usage-refused": (root) => runCli(root, ["inspect", "--json"]),
	"msb-workflow.bind#usage-refused": (root) => runCli(root, ["bind", "--workspace", root.workspace, "--json"]),
	"msb-workflow.recover#usage-refused": (root) => runCli(root, ["recover", "--workspace", root.workspace, "--json"]),
	"msb-workflow.hook#usage-refused": (root) => runCli(root, ["hook", "--json"]),
	"msb-workflow.inspect#state-root-refused": (root) => runCli(root, inspectArgv(root), { env: absentRoot(root) }),
	"msb-workflow.bind#state-root-refused": (root) => runCli(root, bindArgv(root), { env: absentRoot(root) }),
	"msb-workflow.recover#state-root-refused": (root) => runCli(root, recoverArgv(root), { env: absentRoot(root) }),
	"msb-workflow.inspect#workspace-refused": (root) => runCli(root, ["inspect", "--workspace", "relative", "--json"]),
	"msb-workflow.bind#workspace-refused": (root) => runCli(root, ["bind", "--workspace", join(root.privateRoot, "absent"), "--session", SESSION, "--bead", BEAD, "--json"]),
	"msb-workflow.recover#workspace-refused": (root) => runCli(root, recoverArgv(root, "relative")),
	"msb-workflow.inspect#session-invalid": (root) => runCli(root, ["inspect", "--workspace", root.workspace, "--session", "-bad", "--json"]),
	"msb-workflow.bind#session-invalid": (root) => runCli(root, ["bind", "--workspace", root.workspace, "--session", "-bad", "--bead", BEAD, "--json"]),
	"msb-workflow.recover#session-invalid": (root) => runCli(root, ["recover", "--workspace", root.workspace, "--session", "-bad", "--json"]),
	"msb-workflow.inspect#session-conflict": (root) => runCli(root, inspectArgv(root), { env: { CODEX_SESSION_ID: "session-2" } }),
	"msb-workflow.bind#session-conflict": (root) => runCli(root, bindArgv(root), { env: { CODEX_SESSION_ID: "session-2" } }),
	"msb-workflow.recover#session-conflict": (root) => runCli(root, recoverArgv(root), { env: { CODEX_SESSION_ID: "session-2" } }),
	"msb-workflow.inspect#internal-failure": (root) => runCliWithThrowingBeads(root, inspectArgv(root)),
	"msb-workflow.bind#internal-failure": (root) => runCliWithThrowingBeads(root, bindArgv(root)),
	"msb-workflow.recover#internal-failure": async (root) => {
		await bindSession(root, SESSION)
		return runCliWithThrowingBeads(root, recoverArgv(root))
	},
	"msb-workflow.inspect#beads-unavailable": (root) => {
		steerBd(root, { unavailable: "no_beads_directory" })
		return runCli(root, inspectArgv(root))
	},
	"msb-workflow.bind#beads-unavailable": (root) => {
		steerBd(root, { unavailable: "database is locked" })
		return runCli(root, bindArgv(root))
	},
	"msb-workflow.recover#beads-unavailable": async (root) => {
		await bindSession(root, SESSION)
		steerBd(root, { noJson: true })
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.bind#executable-refused": (root) => runCli(root, bindArgv(root), { env: { MSB_WORKFLOW_BD_EXECUTABLE: undefined } }),
	"msb-workflow.recover#executable-refused": async (root) => {
		await bindThenBreakExecutable(root)
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.bind#store-mismatch": (root) => {
		steerBd(root, { version: "bd version 1.3.0 (deadbeef: deadbeef0000)" })
		return runCli(root, bindArgv(root))
	},
	"msb-workflow.recover#store-mismatch": async (root) => {
		await bindSession(root, SESSION)
		steerBd(root, { wherePath: "/elsewhere/.beads" })
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.bind#state-unsafe": (root) => {
		symlinkBinding(root)
		return runCli(root, bindArgv(root))
	},
	"msb-workflow.recover#state-unsafe": (root) => {
		symlinkBinding(root)
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.bind#binding-invalid": (root) => {
		plant(root, "{not json\n")
		return runCli(root, bindArgv(root))
	},
	"msb-workflow.recover#binding-invalid": (root) => {
		plant(root, '{"schemaVersion":2}\n')
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.bind#bead-missing": (root) => runCli(root, ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", "lkr-nope", "--json"]),
	"msb-workflow.recover#bead-missing": async (root) => {
		await bindSession(root, SESSION)
		steerBd(root, { showError: { [BEAD]: "no issues found matching the provided IDs" } })
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.inspect#inspected": async (root) => {
		await bindSession(root, SESSION)
		return runCli(root, inspectArgv(root))
	},
	"msb-workflow.inspect#inspect-refused": (root) => runCli(root, inspectArgv(root)),
	"msb-workflow.bind#source-repository-missing": (root) => runCli(root, bindArgv(root), { cwd: realpathSync(mkdtempSync(join(tmpdir(), "msb-catalog-outside-"))) }),
	"msb-workflow.bind#evidence-invalid": (root) => runCli(root, bindArgv(root, ["--evidence", join(root.privateRoot, "missing.md")])),
	"msb-workflow.bind#binding-owner-conflict": async (root) => {
		await bindSession(root, SESSION)
		return runCli(root, ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", OTHER_BEAD, "--json"])
	},
	"msb-workflow.bind#binding-inherited-conflict": async (root) => {
		await bindSession(root, SESSION)
		return runCli(root, ["bind", "--workspace", root.workspace, "--bead", OTHER_BEAD, "--json"], { env: { CODEX_SESSION_ID: SESSION } })
	},
	"msb-workflow.bind#storage-busy": async (root) => {
		const holder = spawnLockHolder(root, SESSION)
		await holder.held
		try {
			return await runCli(root, bindArgv(root))
		} finally {
			holder.kill()
			await holder.exited
		}
	},
	"msb-workflow.bind#platform-unsupported": (root) => runCliOnPlatform(root, bindArgv(root), "linux"),
	"msb-workflow.bind#write-failed": (root) => runCliWithStoreFault(root, bindArgv(root), "before-rename"),
	"msb-workflow.bind#write-unknown": (root) => runCliWithStoreFault(root, bindArgv(root), "after-rename"),
	"msb-workflow.bind#bound": (root) => runCli(root, bindArgv(root)),
	"msb-workflow.recover#recovered": async (root) => {
		await bindSession(root, SESSION)
		return runCli(root, recoverArgv(root))
	},
	"msb-workflow.recover#binding-absent": (root) => runCli(root, recoverArgv(root)),
	"msb-workflow.recover#binding-workspace-mismatch": async (root) => {
		await bindSession(root, SESSION)
		const other = join(root.privateRoot, "workspace-two")
		mkdirSync(join(other, ".beads"), { recursive: true, mode: 0o700 })
		return runCli(root, recoverArgv(root, other))
	},
}

const declaredKeys = STATIONS.map((station) => `${station.commandIdentity}#${station.station}`).sort()
const observed = new Set<string>()

describe("Branch Station catalog", () => {
	test("the declared station set is closed, pinned, and fully named by the independent oracle", () => {
		expect(declaredKeys.length).toBe(DECLARED_STATION_COUNT)
		expect(new Set(declaredKeys).size).toBe(DECLARED_STATION_COUNT)
		expect(declaredKeys).toEqual(Object.keys(EXPECTED).sort())
		expect(declaredKeys).toEqual(Object.keys(REACH).sort())
	})

	test("every declaration carries exactly the facts the oracle restates", () => {
		for (const station of STATIONS) {
			const [outcome, causeCode, effectClass, transactionState, retryable, delay, guidance, exit] = EXPECTED[`${station.commandIdentity}#${station.station}`] as Expected
			expect([station.outcome, station.causeCode, station.effectClass, station.transactionState, station.retryable, station.retryDelayMilliseconds, station.guidance, station.exit]).toEqual([outcome, causeCode, effectClass, transactionState, retryable, delay, guidance, exit])
		}
	})

	describe("reachability", () => {
		let root: Root

		beforeEach(() => {
			root = createRoot()
		})

		afterEach(() => {
			removeRoot(root)
		})

		for (const key of Object.keys(EXPECTED).sort()) {
			test(`reaches ${key} through a real public process with the declared facts`, async () => {
				const [outcome, causeCode, effectClass, transactionState, retryable, delay, guidance, exit] = EXPECTED[key] as Expected
				const run = await (REACH[key] as (target: Root) => Promise<Run>)(root)
				expect(run.stderr).toBe("")
				const envelope = envelopeOf(run)
				const result = resultOf(run)
				expect(`${String(envelope.commandIdentity)}#${String(result.station)}`).toBe(key)
				expect(envelope.outcome).toBe(outcome)
				expect(envelope.causeCode).toBe(causeCode)
				expect(envelope.effectClass).toBe(effectClass)
				expect(envelope.transactionState).toBe(transactionState)
				expect(envelope.retryable).toBe(retryable)
				expect(envelope.retryDelayMilliseconds).toBe(delay)
				expect(run.exit).toBe(exit)
				expect(envelope.nextAction !== null).toBe(guidance === "next-action")
				expect(envelope.handoff !== null).toBe(guidance === "handoff")
				if (guidance === "handoff") expect((envelope.handoff as { prerequisites: string[] }).prerequisites.length).toBeGreaterThan(0)
				if (outcome !== "success") expect(typeof envelope.repairAction).toBe("string")
				observed.add(key)
			})
		}
	})

	test("every declared station was observed by a real process; unobserved declarations fail", () => {
		const unobserved = declaredKeys.filter((key) => !observed.has(key))
		expect(unobserved).toEqual([])
		expect(observed.size).toBe(DECLARED_STATION_COUNT)
	})
})
