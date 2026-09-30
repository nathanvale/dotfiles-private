// Ticket #155 invariant 3, receipt side: no configuration of HOME or XDG_STATE_HOME, and no change to the configured
// tree during a run, may read or reveal a receipt outside the configured root. Each probe redirects both variables to
// a caller-owned decoy tree, swaps the decoy item directory for a link into another root (standing in for the
// account's default root) at a paused point in the read, and requires byte-identical output whether that other root's
// receipt is present or absent, with its value never projected. The pauses change timing only and never ship.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFixture, type Fixture, grant, input, invoke, PIN_PAUSE_PRELOAD, type ProcessResult, REFUSAL_HUMAN, REFUSAL_JSON, removeFixture, request, RUNTIME } from "./fixtures/harness.ts"

const ITEMS = ["my-second-brain-playground", "drive-inbox-filing", "items", "synthetic-item-001"] as const
const OTHER_ROOT_VALUE = "OTHER_ROOT_VALUE_MUST_NOT_BE_READ"
const DECOY_VALUE = "Decoy tree value"
// Pause points in a test-only runtime copy; the committed runtime is never changed. Each writes its own marker
// (SOURCE_INTAKE_TEST_PAUSE_MARKER plus the point name), then pauses for 300 ms.
interface PausePoint {
	name: string
	anchor: string
	placement: "after" | "before"
}
// The start of the receipt read, after the exact-text bind and authorization: the old check-then-read window.
const BEFORE_READ: PausePoint = { name: "read", anchor: "function readBoundReceipt(itemDirectory) {", placement: "after" }
// Between the open of the receipt and the fstat of that descriptor.
const AFTER_OPEN: PausePoint = { name: "open", anchor: "const stat = fstatSync(descriptor);", placement: "before" }
// Between the read from the descriptor and the lstat of the receipt name.
const BEFORE_NAME_CHECK: PausePoint = { name: "named", anchor: "const named = lstatSync(RECEIPT_FILE);", placement: "before" }

function pauseStatement(name: string): string {
	return `if (process.env.SOURCE_INTAKE_TEST_PAUSE_MARKER) { import.meta.require("node:fs").writeFileSync(process.env.SOURCE_INTAKE_TEST_PAUSE_MARKER + ".${name}", "paused"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }`
}

let fixture: Fixture

beforeEach(() => {
	fixture = createFixture()
})

afterEach(() => {
	removeFixture(fixture)
})

interface Trees {
	decoyItem: string
	otherItem: string
	piped: string
}

/** Redirects HOME and XDG_STATE_HOME to a decoy tree with its own receipt, beside another root's item directory. */
function trees(target: Fixture, otherPresent: boolean): Trees {
	const decoy = join(target.root, "decoy")
	const decoyItem = join(decoy, "state", ...ITEMS)
	const otherItem = join(target.root, "other", ".local", "state", ...ITEMS)
	mkdirSync(decoyItem, { recursive: true })
	mkdirSync(otherItem, { recursive: true })
	writeFileSync(join(decoyItem, "classification-metadata.json"), JSON.stringify({ displayName: DECOY_VALUE, mimeType: "text/plain" }))
	if (otherPresent) writeFileSync(join(otherItem, "classification-metadata.json"), JSON.stringify({ displayName: OTHER_ROOT_VALUE, mimeType: "text/plain" }))
	target.env.HOME = decoy
	target.env.XDG_STATE_HOME = join(decoy, "state")
	return { decoyItem, otherItem, piped: input(grant(target, { receiptPath: join(decoyItem, "classification-metadata.json") }), request()) }
}

function swapIntoOtherRoot(paths: Trees): void {
	renameSync(paths.decoyItem, `${paths.decoyItem}.original`)
	symlinkSync(paths.otherItem, paths.decoyItem)
}

function pausedRuntime(target: Fixture, points: readonly PausePoint[]): string {
	let source = readFileSync(RUNTIME, "utf8")
	for (const point of points) {
		expect(source).toContain(point.anchor)
		const pause = pauseStatement(point.name)
		source = source.replace(point.anchor, point.placement === "after" ? `${point.anchor}\n  ${pause}` : `${pause}\n    ${point.anchor}`)
	}
	const path = join(target.root, "paused-runtime.js")
	writeFileSync(path, source)
	return path
}

interface Step {
	point: string
	act: () => void
}

/**
 * Runs one project invocation and performs each step when its pause marker appears. A step whose point is never
 * reached (the run ended first) is skipped, so an absent receipt that ends the read early still yields its output.
 */
async function raced(target: Fixture, piped: string, cmd: string[], steps: readonly Step[], fired: string[]): Promise<ProcessResult> {
	const marker = join(target.root, "pause-marker")
	const child = Bun.spawn(cmd, { cwd: target.root, env: { ...target.env, SOURCE_INTAKE_TEST_PAUSE_MARKER: marker }, stdin: new Blob([piped]), stdout: "pipe", stderr: "pipe" })
	let ended = false
	void child.exited.then(() => {
		ended = true
	})
	const stdout = new Response(child.stdout).text()
	const stderr = new Response(child.stderr).text()
	for (const step of steps) {
		const stepMarker = `${marker}.${step.point}`
		for (let attempt = 0; attempt < 5_000 && !ended && !existsSync(stepMarker); attempt += 1) await Bun.sleep(1)
		if (existsSync(stepMarker)) {
			step.act()
			fired.push(step.point)
		}
	}
	return { exitCode: await child.exited, stdout: await stdout, stderr: await stderr }
}

type Window = (target: Fixture, mode: string[]) => string[]

const WINDOWS: Record<string, Window> = {
	"after the bind and before the read": (target, mode) => [process.execPath, pausedRuntime(target, [BEFORE_READ]), "project", ...mode],
	"after the item directory is pinned": (_target, mode) => [process.execPath, "--preload", PIN_PAUSE_PRELOAD, RUNTIME, "project", ...mode],
}

// Every probe reaches its pause in every run (the decoy receipt exists), so a pause that never fires fails the probe.
async function probe(window: Window, point: string): Promise<Record<string, ProcessResult>> {
	const observed: Record<string, ProcessResult> = {}
	const fired: string[] = []
	for (const otherPresent of [true, false]) {
		for (const mode of [["--json"], []]) {
			removeFixture(fixture)
			fixture = createFixture()
			const paths = trees(fixture, otherPresent)
			const steps = [{ point, act: () => swapIntoOtherRoot(paths) }]
			observed[`${otherPresent ? "present" : "absent"} ${mode.length === 0 ? "human" : "json"}`] = await raced(fixture, paths.piped, window(fixture, mode), steps, fired)
		}
	}
	expect(fired).toEqual([point, point, point, point])
	return observed
}

const REFUSED_ALL = {
	"present json": { exitCode: 3, stderr: "", stdout: REFUSAL_JSON },
	"present human": { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" },
	"absent json": { exitCode: 3, stderr: "", stdout: REFUSAL_JSON },
	"absent human": { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" },
}

test("a swap into another root after the bind and before the read is refused identically, present or absent", async () => {
	const observed = await probe(WINDOWS["after the bind and before the read"] as Window, BEFORE_READ.name)
	expect(observed).toEqual(REFUSED_ALL)
})

test("a swap into another root after the pin still reads only the pinned configured tree, present or absent", async () => {
	const observed = await probe(WINDOWS["after the item directory is pinned"] as Window, "pinned")
	expect(Object.keys(observed)).toEqual(["present json", "present human", "absent json", "absent human"])
	expect(observed["present json"]).toEqual(observed["absent json"] as ProcessResult)
	expect(observed["present human"]).toEqual(observed["absent human"] as ProcessResult)
	expect(observed["present json"]?.exitCode).toBe(0)
	expect(observed["present json"]?.stdout).toContain(DECOY_VALUE)
	for (const result of Object.values(observed)) expect(`${result.stdout}${result.stderr}`).not.toContain(OTHER_ROOT_VALUE)
})

test("a hard link from another root planted at the configured receipt path is refused identically, present or absent", () => {
	const observed: Record<string, ProcessResult[]> = {}
	for (const otherPresent of [true, false]) {
		removeFixture(fixture)
		fixture = createFixture()
		const paths = trees(fixture, otherPresent)
		const configured = join(paths.decoyItem, "classification-metadata.json")
		renameSync(configured, join(fixture.root, "decoy-receipt-moved.json"))
		if (otherPresent) linkSync(join(paths.otherItem, "classification-metadata.json"), configured)
		observed[otherPresent ? "present" : "absent"] = [invoke(fixture, ["project", "--json"], { stdin: paths.piped }), invoke(fixture, ["project"], { stdin: paths.piped })]
	}
	const refused = [
		{ exitCode: 3, stderr: "", stdout: REFUSAL_JSON },
		{ exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" },
	]
	expect(observed).toEqual({ present: refused, absent: refused })
})

// A hard link to another root's receipt, planted at the configured path, then changed around the open. The value
// must never be projected, and the output must not depend on whether the other root's receipt exists.
// With the other root's receipt present, every step's pause must fire; with it absent the open fails first.
async function hardLinkRace(points: readonly PausePoint[], steps: (configured: string, other: string) => readonly Step[]): Promise<Record<string, ProcessResult>> {
	const observed: Record<string, ProcessResult> = {}
	const firedWhenPresent: string[] = []
	const firedWhenAbsent: string[] = []
	for (const otherPresent of [true, false]) {
		for (const mode of [["--json"], []]) {
			removeFixture(fixture)
			fixture = createFixture()
			const paths = trees(fixture, otherPresent)
			const configured = join(paths.decoyItem, "classification-metadata.json")
			const other = join(paths.otherItem, "classification-metadata.json")
			renameSync(configured, join(fixture.root, "decoy-receipt-moved.json"))
			if (otherPresent) linkSync(other, configured)
			const cmd = [process.execPath, pausedRuntime(fixture, points), "project", ...mode]
			const planned = steps(configured, other)
			observed[`${otherPresent ? "present" : "absent"} ${mode.length === 0 ? "human" : "json"}`] = await raced(fixture, paths.piped, cmd, planned, otherPresent ? firedWhenPresent : firedWhenAbsent)
		}
	}
	const expected = steps("", "").map((step) => step.point)
	expect(firedWhenPresent).toEqual([...expected, ...expected])
	expect(firedWhenAbsent).toEqual([])
	return observed
}

// Wrong behavior caught: trusting the descriptor's link count alone. Unlinking the planted name after the open leaves
// the descriptor with one link to the other root's receipt.
test("a planted hard link unlinked between the open and the fstat is refused identically, present or absent", async () => {
	const observed = await hardLinkRace([AFTER_OPEN], (configured) => [{ point: AFTER_OPEN.name, act: () => unlinkSync(configured) }])
	expect(observed).toEqual(REFUSED_ALL)
})

// Wrong behavior caught: checking only the name's identity after the read. Relinking the planted name after the fstat
// restores the same inode with two links.
test("a planted hard link unlinked before the fstat and relinked before the name check is refused identically, present or absent", async () => {
	const observed = await hardLinkRace([AFTER_OPEN, BEFORE_NAME_CHECK], (configured, other) => [
		{ point: AFTER_OPEN.name, act: () => unlinkSync(configured) },
		{ point: BEFORE_NAME_CHECK.name, act: () => linkSync(other, configured) },
	])
	expect(observed).toEqual(REFUSED_ALL)
})
