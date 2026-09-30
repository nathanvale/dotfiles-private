// Ticket #158 acceptance 2: the pre-flight refuses, with one fixed value-free refusal and no model start, whenever
// this run cannot prove the lane denies both receipt roots. The weakened double is a fake codex whose sandbox runs
// every probe unsandboxed, and, at module level, a profile with the explicit denies removed and read on the root.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Lane, laneConfigArgs, prepareLane } from "../src/lane.ts"
import { runPreflight } from "../src/preflight.ts"
import {
	clearObservations,
	COMMAND,
	createFixture,
	execObservations,
	type Fixture,
	invoke,
	LANE_REFUSAL_JSON,
	laneInput,
	laneLedger,
	removeFixture,
	SENTINEL,
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
	expect(invoke(fixture, ["classify", "--json"], { stdin: input }).exitCode).toBe(0)
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

/** Starts classify with the slow-probe fake and resolves once the pre-flight is paused at a sandboxed receipt read. */
async function classifyPausedInPreflight(): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
	setFake(fixture, "slow-probe")
	const marker = join(fixture.fakeRoot, "probe-waiting")
	rmSync(marker, { force: true })
	const child = Bun.spawn({ cmd: [COMMAND, "classify", "--json"], cwd: fixture.root, env: { ...fixture.env, PATH: `${fixture.env.PATH}:${dirname(process.execPath)}` }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
	child.stdin.write(input)
	await child.stdin.end()
	for (let attempt = 0; attempt < 600 && !existsSync(marker); attempt += 1) await Bun.sleep(50)
	expect(existsSync(marker)).toBe(true)
	return child
}

function itemsBesideFixture(): string[] {
	return readdirSync(join(fixture.privateRoot, "drive-inbox-filing", "items")).filter((name) => name !== "synthetic-item-001")
}

// Wrong behavior caught: a killed pre-flight leaving a sentinel that dispatch would accept as a real item directory.
proofs.test("a pre-flight killed mid-probe leaves nothing shaped like a receipt item", async () => {
	const child = await classifyPausedInPreflight()
	child.kill("SIGKILL")
	await child.exited
	const leftovers = itemsBesideFixture()
	try {
		expect(leftovers.length).toBeGreaterThan(0)
		for (const name of leftovers) expect(OPAQUE_ITEM_REF_SHAPE.test(name)).toBe(false)
	} finally {
		for (const name of leftovers) rmSync(join(fixture.privateRoot, "drive-inbox-filing", "items", name), { recursive: true, force: true })
	}
}, 60_000)

// Wrong behavior caught: a SIGTERM during the synchronous pre-flight handled only after the model process started.
proofs.test("SIGTERM mid pre-flight exits 143, starts no model and leaves no sentinel", async () => {
	const child = await classifyPausedInPreflight()
	child.kill("SIGTERM")
	expect(await child.exited).toBe(143)
	expect(execObservations(fixture)).toEqual([])
	expect(itemsBesideFixture()).toEqual([])
}, 60_000)

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

proofs.pin(13)
