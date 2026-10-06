// The attended chooser through the public process. Each test builds its own fictional HOME holding Google Drive for
// desktop folders. The chooser-redirect preload sends the pinned /usr/bin/osascript spawn to a test-owned stand-in that
// replies, cancels, fails or hangs, so no dialog opens. Every name and account is fictional. Expected envelopes,
// stations, replies and start folders are test-owned literals, not production tables.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DESCRIPTOR_LIMIT_PRELOAD, EXHAUST_DESCRIPTORS, RUNTIME, type ProcessResult } from "./fixtures/harness.ts"

const CHOOSER_REDIRECT = join(import.meta.dir, "fixtures/chooser-redirect.ts")
const STAND_IN = join(import.meta.dir, "fixtures/fake-osascript.sh")
const PERSONAL = "fictional.person@example.test"
const OTHER = "fictional.other@example.test"
const FILE_NAME = "Fictional planning receipt 2026.pdf"
const PROMPT = "Choose one file in 00 Inbox for Source Intake"

// Independent oracle: the four fixed choose refusals, restated from the Contract Core 2.0 envelope and the README
// station table, not imported from src. A change to any production refusal byte fails these tests.
const PATHS = '"availablePaths":["source-intake-dispatch.choose","source-intake-dispatch.command-discovery","source-intake-dispatch.discovery","source-intake-dispatch.help","source-intake-dispatch.project","source-intake-dispatch.redacted"]'
const HEAD = '"runId":"run-source-intake-dispatch.choose","commandIdentity":"source-intake-dispatch.choose","outcome":"refused","effectClass":"inspect","transactionState":"unchanged"'
const EFFECTS = '"effects":{"completed":[],"inventoryComplete":true,"remaining":[],"uncertain":[]}'
const REFUSED = {
	selection: `{"envelopeVersion":2,"contractVersion":"2.0.0","message":"The selection is not one file directly inside a local 00 Inbox.",${PATHS},"result":{${HEAD},"causeCode":"DOMAIN_PATH_REFUSED","failureClass":"domain","exitCode":3,"data":null,"retryable":false,"repairAction":"Select one ordinary file that sits directly inside 00 Inbox, not a folder, link or nested file.",${EFFECTS},"nextAction":"Ask Nathan to retry choose and select one file directly inside 00 Inbox."}}\n`,
	noInbox: `{"envelopeVersion":2,"contractVersion":"2.0.0","message":"No local Google Drive 00 Inbox was found.",${PATHS},"result":{${HEAD},"causeCode":"DOMAIN_CONFIG_MISSING","failureClass":"domain","exitCode":3,"data":null,"retryable":false,"repairAction":"Start Google Drive for desktop with the personal account so its 00 Inbox syncs locally.",${EFFECTS},"nextAction":"Ask Nathan to start Google Drive for desktop, then retry choose."}}\n`,
	cancelled: `{"envelopeVersion":2,"contractVersion":"2.0.0","message":"No file was selected.",${PATHS},"result":{${HEAD},"causeCode":"DOMAIN_AUTHORITY_REQUIRED","failureClass":"domain","exitCode":3,"data":null,"retryable":false,"repairAction":"Only Nathan selects the item; retry choose while he is present.",${EFFECTS},"handoff":{"owner":"human","reason":"The item is selected only by Nathan in the native chooser.","inspect":["whether Nathan still wants to select one 00 Inbox file now"]}}}\n`,
	unavailable: `{"envelopeVersion":2,"contractVersion":"2.0.0","message":"The native chooser is unavailable in this session.",${PATHS},"result":{${HEAD},"causeCode":"INTERNAL_PREPARATION","failureClass":"internal","exitCode":1,"data":null,"retryable":false,"repairAction":"Run choose from a process in Nathan's logged-in macOS session that may show a dialog and read the local Drive folder.",${EFFECTS},"nextAction":"Ask Nathan to run choose from his own terminal in the granted foreground session."}}\n`,
}

interface ChooseFixture {
	root: string
	home: string
	storage: string
	log: string
}

function inbox(fixture: ChooseFixture, account: string): string {
	return join(fixture.storage, `GoogleDrive-${account}`, "My Drive", "00 Inbox")
}

/** A fictional HOME with one personal 00 Inbox holding one file. */
function createChooseFixture(): ChooseFixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-choose-")))
	const home = join(root, "home")
	const fixture = { root, home, storage: join(home, "Library", "CloudStorage"), log: join(root, "chooser.log") }
	mkdirSync(inbox(fixture, PERSONAL), { recursive: true })
	writeFileSync(join(inbox(fixture, PERSONAL), FILE_NAME), "fictional bytes")
	return fixture
}

/** Runs one test against its own fixture and always deletes that fixture's temporary root. */
async function withFixture(run: (fixture: ChooseFixture) => void | Promise<void>): Promise<void> {
	const fixture = createChooseFixture()
	try {
		await run(fixture)
	} finally {
		rmSync(fixture.root, { force: true, recursive: true })
	}
}

interface ChooseOptions {
	mode?: "reply" | "cancel" | "fail" | "hang"
	reply?: string
	standIn?: string
	preload?: string
	env?: Record<string, string>
}

function chooseEnv(fixture: ChooseFixture, options: ChooseOptions): Record<string, string> {
	return {
		HOME: fixture.home,
		PATH: process.env.PATH ?? "",
		SOURCE_INTAKE_TEST_CHOOSER: options.standIn ?? STAND_IN,
		FAKE_CHOOSER_LOG: fixture.log,
		FAKE_CHOOSER_MODE: options.mode ?? "reply",
		FAKE_CHOOSER_REPLY: options.reply ?? "",
		...options.env,
	}
}

/** The public runtime under the chooser redirect; every choose run in this file goes through it. */
function chooseCommand(args: readonly string[], options: ChooseOptions): string[] {
	const extra = options.preload === undefined ? [] : ["--preload", options.preload]
	return [process.execPath, "--preload", CHOOSER_REDIRECT, ...extra, RUNTIME, "choose", ...args]
}

function choose(fixture: ChooseFixture, args: readonly string[], options: ChooseOptions = {}): ProcessResult {
	rmSync(fixture.log, { force: true })
	const child = Bun.spawnSync({ cmd: chooseCommand(args, options), cwd: fixture.root, env: chooseEnv(fixture, options), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
	return { exitCode: child.exitCode, stderr: new TextDecoder().decode(child.stderr), stdout: new TextDecoder().decode(child.stdout) }
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary envelope fields after a strict JSON parse.
function result(process: ProcessResult): any {
	return JSON.parse(process.stdout).result
}

/** The chooser's recorded arguments after the four -e script lines: the start folder and the prompt. */
function chooserArguments(fixture: ChooseFixture): string[] | null {
	return existsSync(fixture.log) ? readFileSync(fixture.log, "utf8").trimEnd().split("\n").slice(8) : null
}

describe("a direct selection", () => {
	test("returns only the file name and local account, after opening the chooser at the one 00 Inbox", () =>
		withFixture((fixture) => {
			const process = choose(fixture, ["--json"], { reply: `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n` })
			expect(process.exitCode).toBe(0)
			expect(process.stderr).toBe("")
			expect(result(process)).toMatchObject({ commandIdentity: "source-intake-dispatch.choose", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged" })
			expect(result(process).data).toEqual({ fileName: FILE_NAME, localAccount: PERSONAL })
			expect(chooserArguments(fixture)).toEqual([inbox(fixture, PERSONAL), PROMPT])
			// The caller never receives the folder path.
			expect(process.stdout).not.toContain(fixture.storage)
		}))

	test("human mode prints the same two values", () =>
		withFixture((fixture) => {
			expect(choose(fixture, [], { reply: `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n` })).toEqual({
				exitCode: 0,
				stderr: "",
				stdout: `Selected one file in a local 00 Inbox:\n  fileName: ${FILE_NAME}\n  localAccount: ${PERSONAL}\n`,
			})
		}))

	// Wrong behavior caught: resolving osascript through PATH, which lets any PATH entry claim Nathan's selection.
	test("an osascript earlier on PATH is never run; only the pinned system chooser is", () =>
		withFixture((fixture) => {
			const bin = join(fixture.root, "path-bin")
			const marker = join(fixture.root, "path-osascript-ran")
			mkdirSync(bin)
			writeFileSync(join(bin, "osascript"), `#!/bin/sh\ntouch '${marker}'\nprintf '%s' '${inbox(fixture, PERSONAL)}/${FILE_NAME}'\n`, { mode: 0o755 })
			const process = choose(fixture, ["--json"], { reply: `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n`, env: { PATH: `${bin}:${globalThis.process.env.PATH ?? ""}` } })
			expect(result(process).causeCode).toBe("SUCCESS_UNCHANGED")
			expect(chooserArguments(fixture)).toEqual([inbox(fixture, PERSONAL), PROMPT])
			expect(existsSync(marker)).toBe(false)
		}))

	test("with two local inboxes the chooser starts at CloudStorage and the reply names the chosen account", () =>
		withFixture((fixture) => {
			mkdirSync(inbox(fixture, OTHER), { recursive: true })
			writeFileSync(join(inbox(fixture, OTHER), "Fictional other note.txt"), "fictional")
			const process = choose(fixture, ["--json"], { reply: `${inbox(fixture, OTHER)}/Fictional other note.txt\n` })
			expect(result(process).data).toEqual({ fileName: "Fictional other note.txt", localAccount: OTHER })
			expect(chooserArguments(fixture)?.[0]).toBe(fixture.storage)
		}))
})

// Each row prepares its own fixture and must give the identical literal refusal, so a refusal is no oracle for what
// was selected.
describe("a selection that is not one file directly inside 00 Inbox", () => {
	const refusedReplies: [string, (f: ChooseFixture) => string][] = [
		["a nested file", (f) => {
			mkdirSync(join(inbox(f, PERSONAL), "Fictional folder"))
			writeFileSync(join(inbox(f, PERSONAL), "Fictional folder", FILE_NAME), "fictional")
			return `${inbox(f, PERSONAL)}/Fictional folder/${FILE_NAME}\n`
		}],
		["a file in My Drive outside 00 Inbox", (f) => {
			writeFileSync(join(f.storage, `GoogleDrive-${PERSONAL}`, "My Drive", FILE_NAME), "fictional")
			return `${join(f.storage, `GoogleDrive-${PERSONAL}`, "My Drive", FILE_NAME)}\n`
		}],
		["a file outside Drive", (f) => {
			writeFileSync(join(f.root, FILE_NAME), "fictional")
			return `${join(f.root, FILE_NAME)}\n`
		}],
		["a link inside 00 Inbox", (f) => {
			writeFileSync(join(f.root, "elsewhere.txt"), "fictional")
			symlinkSync(join(f.root, "elsewhere.txt"), join(inbox(f, PERSONAL), "Fictional link.txt"))
			return `${inbox(f, PERSONAL)}/Fictional link.txt\n`
		}],
		["a package folder", (f) => {
			mkdirSync(join(inbox(f, PERSONAL), "Fictional.pages"))
			return `${inbox(f, PERSONAL)}/Fictional.pages/\n`
		}],
		["a hidden file", (f) => {
			writeFileSync(join(inbox(f, PERSONAL), ".Fictional hidden"), "fictional")
			return `${inbox(f, PERSONAL)}/.Fictional hidden\n`
		}],
		["a missing file", (f) => `${inbox(f, PERSONAL)}/Fictional missing.pdf\n`],
		["a parent-segment path", (f) => `${inbox(f, PERSONAL)}/../00 Inbox/${FILE_NAME}\n`],
		["two lines", (f) => `${inbox(f, PERSONAL)}/${FILE_NAME}\n${inbox(f, PERSONAL)}/${FILE_NAME}\n`],
		["a relative path", () => `00 Inbox/${FILE_NAME}\n`],
		["an empty reply", () => ""],
	]

	for (const [name, prepare] of refusedReplies) {
		test(`${name} is refused with the fixed literal envelope`, () =>
			withFixture((fixture) => {
				expect(choose(fixture, ["--json"], { reply: prepare(fixture) })).toEqual({ exitCode: 3, stderr: "", stdout: REFUSED.selection })
			}))
	}

	test("a linked 00 Inbox is not an inbox, so the only account has none and no chooser opens", () =>
		withFixture((fixture) => {
			const real = join(fixture.root, "real-inbox")
			rmSync(inbox(fixture, PERSONAL), { recursive: true })
			mkdirSync(real)
			symlinkSync(real, inbox(fixture, PERSONAL))
			expect(choose(fixture, ["--json"], { reply: `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n` })).toEqual({ exitCode: 3, stderr: "", stdout: REFUSED.noInbox })
			expect(chooserArguments(fixture)).toBeNull()
		}))
})

describe("refusals before or around the dialog", () => {
	test("no CloudStorage folder refuses before any chooser opens", () =>
		withFixture((fixture) => {
			rmSync(fixture.storage, { recursive: true })
			expect(choose(fixture, ["--json"])).toEqual({ exitCode: 3, stderr: "", stdout: REFUSED.noInbox })
			expect(chooserArguments(fixture)).toBeNull()
		}))

	test("a cancelled dialog hands back to Nathan without a value", () =>
		withFixture((fixture) => {
			expect(choose(fixture, ["--json"], { mode: "cancel" })).toEqual({ exitCode: 3, stderr: "", stdout: REFUSED.cancelled })
		}))

	test("a chooser that cannot open is an internal refusal that never echoes its error", () =>
		withFixture((fixture) => {
			expect(choose(fixture, ["--json"], { mode: "fail" })).toEqual({ exitCode: 1, stderr: "", stdout: REFUSED.unavailable })
		}))

	test("a chooser executable that cannot be started is the same internal refusal", () =>
		withFixture((fixture) => {
			expect(choose(fixture, ["--json"], { standIn: join(fixture.root, "no-such-chooser") })).toEqual({ exitCode: 1, stderr: "", stdout: REFUSED.unavailable })
		}))

	test("an exhausted descriptor table is a retryable refusal before the chooser opens", () =>
		withFixture((fixture) => {
			const process = choose(fixture, ["--json"], { preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS })
			expect(process.exitCode).toBe(75)
			expect(result(process)).toMatchObject({ causeCode: "TRANSIENT_NOT_STARTED", retryable: true, retryDelayMilliseconds: 1000 })
			expect(JSON.parse(process.stdout).message).toBe("A file-descriptor limit was reached before the chooser opened; nothing was read.")
			expect(chooserArguments(fixture)).toBeNull()
		}))

	test("an operand is a usage refusal and opens no chooser", () =>
		withFixture((fixture) => {
			const process = choose(fixture, ["/some/path", "--json"])
			expect(process.exitCode).toBe(2)
			expect(result(process)).toMatchObject({ commandIdentity: "source-intake-dispatch.choose", causeCode: "USAGE_INVALID_INVOCATION" })
			expect(chooserArguments(fixture)).toBeNull()
		}))
})

// Test-owned expected stations: cause|outcome|exit|class|retryable|repair action.
const EXPECTED_STATIONS = [
	"DOMAIN_AUTHORITY_REQUIRED|refused|3|domain|false|Only Nathan selects the item; retry choose while he is present.",
	"DOMAIN_CONFIG_MISSING|refused|3|domain|false|Start Google Drive for desktop with the personal account so its 00 Inbox syncs locally.",
	"DOMAIN_PATH_REFUSED|refused|3|domain|false|Select one ordinary file that sits directly inside 00 Inbox, not a folder, link or nested file.",
	"INTERNAL_PREPARATION|refused|1|internal|false|Run choose from a process in Nathan's logged-in macOS session that may show a dialog and read the local Drive folder.",
	"INTERNAL_RESULT_UNCHANGED|failed|1|internal|false|Inspect the serialization failure before retrying.",
	"SUCCESS_UNCHANGED|success|0||false|",
	"TRANSIENT_NOT_STARTED|refused|75|transient|true|Wait for open files to be released, then retry the same command.",
	"USAGE_INVALID_INVOCATION|refused|2|usage|false|Choose one listed invocation with its required operands and retry.",
]

function projection(value: { causeCode: string; outcome: string; exitCode: number; failureClass: string | null; retryable: boolean; repairAction: string | null }): string {
	return [value.causeCode, value.outcome, value.exitCode, value.failureClass ?? "", value.retryable, value.repairAction ?? ""].join("|")
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

test("source-intake-dispatch.choose declares exactly the expected stations and reaches every one", () =>
	withFixture(async (fixture) => {
		const discovery = Bun.spawnSync({ cmd: [process.execPath, RUNTIME, "--discover-command", "source-intake-dispatch.choose", "--json"], cwd: fixture.root, env: chooseEnv(fixture, {}), stdout: "pipe" })
		expect(JSON.parse(discovery.stdout.toString()).result.data.stations.map(projection).sort()).toEqual(EXPECTED_STATIONS)
		const throwing = join(fixture.root, "preload-throws.ts")
		writeFileSync(throwing, SERIALIZER_THROWS)
		const valid = `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n`
		const observed = [
			result(choose(fixture, ["--json"], { reply: valid })),
			result(choose(fixture, ["extra", "--json"])),
			result(choose(fixture, ["--json"], { mode: "cancel" })),
			result(choose(fixture, ["--json"], { reply: `${fixture.root}/x\n` })),
			result(choose(fixture, ["--json"], { mode: "fail" })),
			result(choose(fixture, ["--json"], { preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS })),
			result(choose(fixture, ["--json"], { reply: valid, preload: throwing })),
		]
		await withFixture((empty) => {
			rmSync(empty.storage, { recursive: true })
			observed.push(result(choose(empty, ["--json"])))
		})
		for (const value of observed) expect(value.commandIdentity).toBe("source-intake-dispatch.choose")
		expect(observed.map(projection).sort()).toEqual(EXPECTED_STATIONS)
	}))

const READY_BOUND_MS = 3000

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitUntil(condition: () => boolean, boundMs: number): Promise<boolean> {
	const deadline = Date.now() + boundMs
	while (!condition()) {
		if (Date.now() >= deadline) return false
		await Bun.sleep(5)
	}
	return true
}

/**
 * Starts choose with a hanging stand-in and returns once the stand-in's pid is recorded and proven alive (the positive
 * control). The caller signals the command; finally always kills both processes.
 */
async function withOpenChooser(run: (child: Bun.Subprocess<"ignore", "pipe", "pipe">, chooserPid: number) => Promise<void>): Promise<void> {
	await withFixture(async (fixture) => {
		const pidFile = `${fixture.log}.pid`
		const child = Bun.spawn(chooseCommand(["--json"], {}), { cwd: fixture.root, env: chooseEnv(fixture, { mode: "hang" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
		let chooserPid = 0
		try {
			expect(await waitUntil(() => existsSync(pidFile), READY_BOUND_MS)).toBe(true)
			chooserPid = Number(readFileSync(pidFile, "utf8"))
			expect(Number.isInteger(chooserPid) && chooserPid > 0).toBe(true)
			expect(isAlive(chooserPid)).toBe(true)
			await run(child, chooserPid)
		} finally {
			child.kill("SIGKILL")
			if (chooserPid > 0 && isAlive(chooserPid)) process.kill(chooserPid, "SIGKILL")
		}
	})
}

// Wrong behavior caught: a signal handler that exits without closing the dialog, leaving it on Nathan's screen.
describe("a signal while the chooser is open", () => {
	for (const [signal, exitCode] of [
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const) {
		test(`${signal} closes the chooser and exits ${exitCode} with empty streams`, () =>
			withOpenChooser(async (child, chooserPid) => {
				child.kill(signal)
				expect(await child.exited).toBe(exitCode)
				expect({ stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }).toEqual({ stdout: "", stderr: "" })
				expect(await waitUntil(() => !isAlive(chooserPid), READY_BOUND_MS)).toBe(true)
			}), 10_000)
	}

	// A hangup has no Contract Core exit: the process ends by SIGHUP itself, after closing the chooser.
	test("SIGHUP closes the chooser and ends the process by the hangup signal with empty streams", () =>
		withOpenChooser(async (child, chooserPid) => {
			child.kill("SIGHUP")
			await child.exited
			expect(child.signalCode).toBe("SIGHUP")
			expect({ stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }).toEqual({ stdout: "", stderr: "" })
			expect(await waitUntil(() => !isAlive(chooserPid), READY_BOUND_MS)).toBe(true)
		}), 10_000)
})
