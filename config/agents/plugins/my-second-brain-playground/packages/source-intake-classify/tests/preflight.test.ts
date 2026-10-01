// Ticket #158 acceptance 2: the pre-flight refuses, with one fixed value-free refusal and no model start, whenever
// this run cannot prove the lane denies both receipt roots. The weakened double is a fake codex whose sandbox runs
// every probe unsandboxed, and, at module level, a profile with the explicit denies removed and read on the root.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Lane, laneConfigArgs, prepareLane } from "../src/lane.ts"
import { runPreflight } from "../src/preflight.ts"
import {
	clearObservations,
	createFixture,
	execObservations,
	execStarted,
	type Fixture,
	invoke,
	LANE_REFUSAL_JSON,
	laneInput,
	laneLedger,
	removeFixture,
	RUNTIME,
	SENTINEL,
	SPAWN_RECORDER_PRELOAD,
	setFake,
} from "./fixtures/harness.ts"

// Independent oracle: the human-mode form of the Ticket #158 lane refusal.
const LANE_REFUSAL_HUMAN = "Classifier lane not started. Its read-prevention pre-flight did not pass. Next: Ask the granted foreground Steward to inspect the classifier lane pre-flight before any retry.\n"

const proofs = laneLedger()
let fixture: Fixture
let input: string

beforeAll(() => {
	fixture = createFixture()
	input = JSON.stringify(laneInput())
})

beforeEach(() => {
	setFake(fixture, "honest")
	clearObservations(fixture)
})

afterAll(() => {
	removeFixture(fixture)
})

function expectRefusedWithoutModel(args: string[], options: { env?: Record<string, string> } = {}): void {
	const json = invoke(fixture, [...args, "--json"], { stdin: input, ...options })
	expect(json).toEqual({ exitCode: 3, stdout: LANE_REFUSAL_JSON, stderr: "" })
	const human = invoke(fixture, args, { stdin: input, ...options })
	expect(human).toEqual({ exitCode: 3, stdout: "", stderr: LANE_REFUSAL_HUMAN })
	expect(execObservations(fixture)).toEqual([])
}

proofs.test("positive control: the honest lane passes the pre-flight and starts the model once", () => {
	const spawnLog = join(fixture.root, "positive-control.spawns")
	expect(invoke(fixture, ["classify", "--json"], { stdin: input, preload: SPAWN_RECORDER_PRELOAD, env: { SOURCE_INTAKE_TEST_SPAWN_LOG: spawnLog } }).exitCode).toBe(0)
	// Both start oracles see this lane, so their absence in the signal tests is evidence, not a blind check.
	expect(laneSpawns(spawnLog)).toBe(1)
	expect(execStarted(fixture)).toBe(true)
	expect(execObservations(fixture)).toHaveLength(1)
	// The throwaway sentinel item directory is removed after every pre-flight; only the fixture's own item remains.
	expect(readdirSync(join(fixture.privateRoot, "drive-inbox-filing", "items"))).toEqual(["synthetic-item-001"])
	expect(readdirSync(join(fixture.privateRoot, "source-intake-classify"))).toEqual(["codex-home"])
}, 60_000)

proofs.test("a sandbox that lets the probes read gets the fixed refusal and no model start", () => {
	setFake(fixture, "open")
	expectRefusedWithoutModel(["classify"])
}, 60_000)

test("no codex on PATH gets the same refusal and no model start", () => {
	// The bin wrapper still needs bun; its directory holds no codex.
	expectRefusedWithoutModel(["classify"], { env: { PATH: `/usr/bin:/bin:${dirname(process.execPath)}` } })
})

// Wrong behavior caught: a lane whose Codex home carries an AGENTS.md (the global pointer) would reach the model.
proofs.test("a lane session that would load AGENTS.md instructions is refused", () => {
	const agents = join(fixture.privateRoot, "source-intake-classify", "codex-home", "AGENTS.md")
	mkdirSync(join(agents, ".."), { recursive: true })
	writeFileSync(agents, "Read the global instructions first.\n")
	try {
		expectRefusedWithoutModel(["classify"])
	} finally {
		rmSync(agents)
	}
}, 60_000)

// Wrong behavior caught: a permission entry in a format the check does not parse passing as if it were absent.
proofs.test("a rendered permission entry in an unrecognised format is refused", () => {
	setFake(fixture, "render-variant")
	expectRefusedWithoutModel(["classify"])
}, 60_000)

// Independent oracle: the opaque item ref shape restated from the source-intake-dispatch README.
const OPAQUE_ITEM_REF_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Lane spawns the parent recorded before creating each process; a missing log means none. */
function laneSpawns(spawnLog: string): number {
	return existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter((line) => line === "exec").length : 0
}

interface PausedRun {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">
	runTmpdir: string
	spawnLog: string
}

/**
 * Starts classify under the parent-side spawn recorder with the slow-probe fake, and resolves once the pre-flight is
 * paused at a sandboxed receipt read.
 */
async function classifyPausedInPreflight(): Promise<PausedRun> {
	setFake(fixture, "slow-probe")
	const marker = join(fixture.fakeRoot, "probe-waiting")
	rmSync(marker, { force: true })
	// A fresh fixture-owned TMPDIR per run makes this run's workspace visible, so a test can see whether it was removed.
	const runTmpdir = mkdtempSync(join(fixture.root, "run-tmp-"))
	const spawnLog = `${runTmpdir}.spawns`
	const env = { ...fixture.env, TMPDIR: runTmpdir, SOURCE_INTAKE_TEST_SPAWN_LOG: spawnLog }
	const child = Bun.spawn({ cmd: [process.execPath, "--preload", SPAWN_RECORDER_PRELOAD, RUNTIME, "classify", "--json"], cwd: fixture.root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
	child.stdin.write(input)
	await child.stdin.end()
	for (let attempt = 0; attempt < 600 && !existsSync(marker); attempt += 1) await Bun.sleep(50)
	expect(existsSync(marker)).toBe(true)
	return { child, runTmpdir, spawnLog }
}

// Independent oracle: the workspace name prefix restated from the package README ("a fresh, empty 0700 directory
// under TMPDIR"), as src/lane.ts createWorkspace names it.
const WORKSPACE_PREFIX = "source-intake-classify-"

function workspacesLeft(runTmpdir: string): string[] {
	return readdirSync(runTmpdir).filter((name) => name.startsWith(WORKSPACE_PREFIX))
}

function itemsBesideFixture(): string[] {
	return readdirSync(join(fixture.privateRoot, "drive-inbox-filing", "items")).filter((name) => name !== "synthetic-item-001")
}

// Wrong behavior caught: a killed pre-flight leaving a sentinel that dispatch would accept as a real item directory.
proofs.test("a pre-flight killed mid-probe leaves nothing shaped like a receipt item", async () => {
	const { child, runTmpdir } = await classifyPausedInPreflight()
	child.kill("SIGKILL")
	await child.exited
	// Positive control for the workspace oracle: SIGKILL cannot run cleanup, so exactly this run's workspace remains.
	expect(workspacesLeft(runTmpdir)).toHaveLength(1)
	const leftovers = itemsBesideFixture()
	try {
		expect(leftovers.length).toBeGreaterThan(0)
		for (const name of leftovers) expect(OPAQUE_ITEM_REF_SHAPE.test(name)).toBe(false)
	} finally {
		for (const name of leftovers) rmSync(join(fixture.privateRoot, "drive-inbox-filing", "items", name), { recursive: true, force: true })
	}
}, 60_000)

// Wrong behavior caught: a signal during the synchronous pre-flight handled only after the lane process was spawned
// (Bun runs signal handlers on the event loop, after the blocking pre-flight), or an exit that skips the workspace
// cleanup. The spawn recorder sees a lane even when the handler kills it within a millisecond.
for (const [signal, exitCode] of [
	["SIGTERM", 143],
	["SIGINT", 130],
] as const) {
	proofs.test(`${signal} mid pre-flight exits ${exitCode}, starts no model and leaves no sentinel or workspace`, async () => {
		const { child, runTmpdir, spawnLog } = await classifyPausedInPreflight()
		child.kill(signal)
		expect(await child.exited).toBe(exitCode)
		expect(laneSpawns(spawnLog)).toBe(0)
		expect(execStarted(fixture)).toBe(false)
		expect(execObservations(fixture)).toEqual([])
		expect(itemsBesideFixture()).toEqual([])
		expect(workspacesLeft(runTmpdir)).toEqual([])
	}, 60_000)
}

test("the refusal names no path, sentinel or probe output", () => {
	for (const text of [LANE_REFUSAL_JSON, LANE_REFUSAL_HUMAN]) {
		expect(text).not.toContain(SENTINEL)
		expect(text).not.toContain(fixture.root)
		expect(text).not.toContain("Operation not permitted")
	}
})

describe("module-level pre-flight", () => {
	let lane: Lane
	let workspace: string

	const resolveLane = (): Lane => {
		const saved = { ...process.env }
		try {
			Object.assign(process.env, fixture.env)
			const resolved = prepareLane()
			if (resolved === null) throw new Error("fixture lane did not resolve")
			return resolved
		} finally {
			process.env = saved
		}
	}

	const setup = () => {
		lane = resolveLane()
		workspace = join(fixture.root, "preflight-workspace")
		if (!existsSync(workspace)) mkdirSync(workspace, { mode: 0o700 })
	}

	proofs.test("module: the lane profile passes the pre-flight", () => {
		setup()
		expect(runPreflight(lane, workspace)).toBe(true)
	}, 60_000)

	proofs.test("module: explicit denies removed and read on the root fails the pre-flight", () => {
		setup()
		const weak = `{filesystem={":root"="read", ":minimal"="read", ${JSON.stringify(lane.codexPackage)}="read", ":workspace_roots"={"."="read"}}, network={enabled=false}}`
		expect(runPreflight({ ...lane, profile: weak, configArgs: laneConfigArgs(weak) }, workspace)).toBe(false)
	}, 60_000)

	// Each weakening edits the lane's own profile, then runs the real pre-flight against the real Codex sandbox.
	const weakened = (edit: (profile: string) => string): boolean => {
		setup()
		const profile = edit(lane.profile)
		expect(profile).not.toBe(lane.profile)
		return runPreflight({ ...lane, profile, configArgs: laneConfigArgs(profile) }, workspace)
	}

	proofs.test("module: a read grant over the receipt items fails the pre-flight", () => {
		expect(weakened((profile) => profile.replace('":root"="deny"', `":root"="deny", ${JSON.stringify(join(fixture.privateRoot, "drive-inbox-filing"))}="read"`))).toBe(false)
	}, 60_000)

	proofs.test("module: a read grant anywhere else under a denied root fails the pre-flight", () => {
		expect(weakened((profile) => profile.replace('":root"="deny"', `":root"="deny", ${JSON.stringify(join(fixture.privateRoot, "source-intake"))}="read"`))).toBe(false)
	}, 60_000)

	proofs.test("module: network enabled fails the pre-flight", () => {
		expect(weakened((profile) => profile.replace("network={enabled=false}", "network={enabled=true}"))).toBe(false)
	}, 60_000)

	proofs.test("module: the :tmpdir deny removed fails the pre-flight", () => {
		expect(weakened((profile) => profile.replace('":tmpdir"="deny", ', ""))).toBe(false)
	}, 60_000)

	proofs.test("module: a missing receipt root is not a denial, so the pre-flight fails", () => {
		setup()
		const missing = join(fixture.root, "absent-state", "my-second-brain-playground")
		expect(runPreflight({ ...lane, deniedRoots: [...lane.deniedRoots, missing].sort() }, workspace)).toBe(false)
	}, 60_000)
})

proofs.pin(14)
