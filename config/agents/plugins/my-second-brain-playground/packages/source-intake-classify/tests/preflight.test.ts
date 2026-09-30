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
	createFixture,
	execObservations,
	type Fixture,
	invoke,
	LANE_READY,
	LANE_REFUSAL_JSON,
	LANE_SKIP_RATIONALE,
	laneInput,
	removeFixture,
	SENTINEL,
	setFake,
} from "./fixtures/harness.ts"

// Independent oracle: the human-mode form of the Ticket #158 lane refusal.
const LANE_REFUSAL_HUMAN = "Classifier lane not started. Its read-prevention pre-flight did not pass. Next: Ask Stage Manager to inspect the classifier lane pre-flight before any retry.\n"

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

test.skipIf(!LANE_READY)(`positive control: the honest lane passes the pre-flight and starts the model once (${LANE_SKIP_RATIONALE})`, () => {
	expect(invoke(fixture, ["classify", "--json"], { stdin: input }).exitCode).toBe(0)
	expect(execObservations(fixture)).toHaveLength(1)
	// The throwaway sentinel directory is removed after every pre-flight.
	expect(readdirSync(join(fixture.privateRoot, "source-intake-classify"))).toEqual(["codex-home"])
}, 60_000)

test.skipIf(!LANE_READY)(`a sandbox that lets the probes read gets the fixed refusal and no model start (${LANE_SKIP_RATIONALE})`, () => {
	setFake(fixture, "open")
	expectRefusedWithoutModel(["classify"])
}, 60_000)

test("no codex on PATH gets the same refusal and no model start", () => {
	// The bin wrapper still needs bun; its directory holds no codex.
	expectRefusedWithoutModel(["classify"], { env: { PATH: `/usr/bin:/bin:${dirname(process.execPath)}` } })
})

// Wrong behavior caught: a lane whose Codex home carries an AGENTS.md (the global pointer) would reach the model.
test.skipIf(!LANE_READY)(`a lane session that would load AGENTS.md instructions is refused (${LANE_SKIP_RATIONALE})`, () => {
	const agents = join(fixture.privateRoot, "source-intake-classify", "codex-home", "AGENTS.md")
	mkdirSync(join(agents, ".."), { recursive: true })
	writeFileSync(agents, "Read the global instructions first.\n")
	try {
		expectRefusedWithoutModel(["classify"])
	} finally {
		rmSync(agents)
	}
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

	test.skipIf(!LANE_READY)(`module: the lane profile passes the pre-flight (${LANE_SKIP_RATIONALE})`, () => {
		setup()
		expect(runPreflight(lane, workspace)).toBe(true)
	}, 60_000)

	test.skipIf(!LANE_READY)(`module: explicit denies removed and read on the root fails the pre-flight (${LANE_SKIP_RATIONALE})`, () => {
		setup()
		const weak = `{filesystem={":root"="read", ":minimal"="read", ${JSON.stringify(lane.codexPackage)}="read", ":workspace_roots"={"."="read"}}, network={enabled=false}}`
		expect(runPreflight({ ...lane, profile: weak, configArgs: laneConfigArgs(weak) }, workspace)).toBe(false)
	}, 60_000)

	test.skipIf(!LANE_READY)(`module: a missing receipt root is not a denial, so the pre-flight fails (${LANE_SKIP_RATIONALE})`, () => {
		setup()
		const missing = join(fixture.root, "absent-state", "my-second-brain-playground")
		expect(runPreflight({ ...lane, deniedRoots: [...lane.deniedRoots, missing].sort() }, workspace)).toBe(false)
	}, 60_000)
})
