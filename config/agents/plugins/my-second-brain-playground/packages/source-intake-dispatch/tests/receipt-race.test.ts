// Ticket #155 invariant 3, receipt side: no configuration of HOME or XDG_STATE_HOME, and no change to the configured
// tree during a run, may read or reveal a receipt outside the configured root. Each probe redirects both variables to
// a caller-owned decoy tree, swaps the decoy item directory for a link into another root (standing in for the
// account's default root) at a paused point in the read, and requires byte-identical output whether that other root's
// receipt is present or absent, with its value never projected. The pauses change timing only and never ship.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFixture, type Fixture, grant, input, invoke, PIN_PAUSE_PRELOAD, type ProcessResult, REFUSAL_HUMAN, REFUSAL_JSON, removeFixture, request, RUNTIME } from "./fixtures/harness.ts"

const ITEMS = ["my-second-brain-playground", "drive-inbox-filing", "items", "synthetic-item-001"] as const
const OTHER_ROOT_VALUE = "OTHER_ROOT_VALUE_MUST_NOT_BE_READ"
const DECOY_VALUE = "Decoy tree value"
// Inserted at the start of the receipt read, after the exact-text bind and authorization: the old check-then-read
// window. Test-only; the committed runtime is never changed.
const READ_ANCHOR = "function readBoundReceipt(itemDirectory) {"
const PAUSE = 'if (process.env.SOURCE_INTAKE_TEST_PAUSE_MARKER) { import.meta.require("node:fs").writeFileSync(process.env.SOURCE_INTAKE_TEST_PAUSE_MARKER, "checked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }'

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

function pausedRuntime(target: Fixture): string {
	const source = readFileSync(RUNTIME, "utf8")
	expect(source).toContain(READ_ANCHOR)
	const path = join(target.root, "paused-runtime.js")
	writeFileSync(path, source.replace(READ_ANCHOR, `${READ_ANCHOR}\n  ${PAUSE}`))
	return path
}

/** Runs one project invocation, swaps the decoy item directory when the pause marker appears, and returns the result. */
async function raced(target: Fixture, paths: Trees, cmd: string[]): Promise<ProcessResult> {
	const marker = join(target.root, "pause-marker")
	const child = Bun.spawn(cmd, { cwd: target.root, env: { ...target.env, SOURCE_INTAKE_TEST_PAUSE_MARKER: marker }, stdin: new Blob([paths.piped]), stdout: "pipe", stderr: "pipe" })
	const stdout = new Response(child.stdout).text()
	const stderr = new Response(child.stderr).text()
	for (let attempt = 0; attempt < 5_000 && !existsSync(marker); attempt += 1) await Bun.sleep(1)
	expect(existsSync(marker)).toBe(true)
	swapIntoOtherRoot(paths)
	return { exitCode: await child.exited, stdout: await stdout, stderr: await stderr }
}

type Window = (target: Fixture, mode: string[]) => string[]

const WINDOWS: Record<string, Window> = {
	"after the bind and before the read": (target, mode) => [process.execPath, pausedRuntime(target), "project", ...mode],
	"after the item directory is pinned": (_target, mode) => [process.execPath, "--preload", PIN_PAUSE_PRELOAD, RUNTIME, "project", ...mode],
}

async function probe(window: Window): Promise<Record<string, ProcessResult>> {
	const observed: Record<string, ProcessResult> = {}
	for (const otherPresent of [true, false]) {
		for (const mode of [["--json"], []]) {
			removeFixture(fixture)
			fixture = createFixture()
			const paths = trees(fixture, otherPresent)
			observed[`${otherPresent ? "present" : "absent"} ${mode.length === 0 ? "human" : "json"}`] = await raced(fixture, paths, window(fixture, mode))
		}
	}
	return observed
}

test("a swap into another root after the bind and before the read is refused identically, present or absent", async () => {
	const observed = await probe(WINDOWS["after the bind and before the read"] as Window)
	expect(observed).toEqual({
		"present json": { exitCode: 3, stderr: "", stdout: REFUSAL_JSON },
		"present human": { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" },
		"absent json": { exitCode: 3, stderr: "", stdout: REFUSAL_JSON },
		"absent human": { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" },
	})
})

test("a swap into another root after the pin still reads only the pinned configured tree, present or absent", async () => {
	const observed = await probe(WINDOWS["after the item directory is pinned"] as Window)
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
