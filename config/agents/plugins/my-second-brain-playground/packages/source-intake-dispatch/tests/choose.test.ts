// The attended chooser through the public process. A fictional HOME holds Google Drive for desktop folders, and a
// test-owned osascript stand-in on PATH replies, cancels, fails or hangs instead of showing a dialog. Every name and
// account is fictional. Expected stations, replies and start folders are test-owned literals, not production tables.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMAND, DESCRIPTOR_LIMIT_PRELOAD, EXHAUST_DESCRIPTORS, RUNTIME, type ProcessResult } from "./fixtures/harness.ts"

const FAKE_OSASCRIPT = join(import.meta.dir, "fixtures/fake-osascript.sh")
const PERSONAL = "fictional.person@example.test"
const OTHER = "fictional.other@example.test"
const FILE_NAME = "Fictional planning receipt 2026.pdf"

interface ChooseFixture {
	root: string
	home: string
	storage: string
	bin: string
	log: string
}

function inbox(fixture: ChooseFixture, account: string): string {
	return join(fixture.storage, `GoogleDrive-${account}`, "My Drive", "00 Inbox")
}

/** A fictional HOME with one personal 00 Inbox holding one file, and a PATH directory holding the fake osascript. */
function createChooseFixture(): ChooseFixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-choose-")))
	const home = join(root, "home")
	const fixture = { root, home, storage: join(home, "Library", "CloudStorage"), bin: join(root, "bin"), log: join(root, "chooser.log") }
	mkdirSync(inbox(fixture, PERSONAL), { recursive: true })
	writeFileSync(join(inbox(fixture, PERSONAL), FILE_NAME), "fictional bytes")
	mkdirSync(fixture.bin)
	copyFileSync(FAKE_OSASCRIPT, join(fixture.bin, "osascript"))
	chmodSync(join(fixture.bin, "osascript"), 0o755)
	return fixture
}

interface ChooseOptions {
	mode?: "reply" | "cancel" | "fail" | "hang"
	reply?: string
	env?: Record<string, string>
	preload?: string
}

function chooseEnv(fixture: ChooseFixture, options: ChooseOptions): Record<string, string> {
	return {
		HOME: fixture.home,
		PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
		FAKE_CHOOSER_LOG: fixture.log,
		FAKE_CHOOSER_MODE: options.mode ?? "reply",
		FAKE_CHOOSER_REPLY: options.reply ?? "",
		...options.env,
	}
}

function choose(fixture: ChooseFixture, args: readonly string[], options: ChooseOptions = {}): ProcessResult {
	rmSync(fixture.log, { force: true })
	const cmd = options.preload === undefined ? [COMMAND, "choose", ...args] : [process.execPath, "--preload", options.preload, RUNTIME, "choose", ...args]
	const child = Bun.spawnSync({ cmd, cwd: fixture.root, env: chooseEnv(fixture, options), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
	return { exitCode: child.exitCode, stderr: new TextDecoder().decode(child.stderr), stdout: new TextDecoder().decode(child.stdout) }
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary envelope fields after a strict JSON parse.
function result(process: ProcessResult): any {
	return JSON.parse(process.stdout).result
}

/** The chooser's recorded arguments: the four -e script lines, then the start folder and the prompt. */
function chooserArguments(fixture: ChooseFixture): string[] | null {
	return existsSync(fixture.log) ? readFileSync(fixture.log, "utf8").trimEnd().split("\n").slice(8) : null
}

let fixture: ChooseFixture

beforeAll(() => {
	fixture = createChooseFixture()
})

afterAll(() => {
	rmSync(fixture.root, { force: true, recursive: true })
})

describe("a direct selection", () => {
	test("returns only the file name and local account, after opening the chooser at the one 00 Inbox", () => {
		const process = choose(fixture, ["--json"], { reply: `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n` })
		expect(process.exitCode).toBe(0)
		expect(process.stderr).toBe("")
		expect(result(process)).toMatchObject({ commandIdentity: "source-intake-dispatch.choose", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged" })
		expect(result(process).data).toEqual({ fileName: FILE_NAME, localAccount: PERSONAL })
		expect(chooserArguments(fixture)).toEqual([inbox(fixture, PERSONAL), "Choose one file in 00 Inbox for Source Intake"])
		// The caller never receives the folder path.
		expect(process.stdout).not.toContain(fixture.storage)
	})

	test("human mode prints the same two values", () => {
		expect(choose(fixture, [], { reply: `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n` })).toEqual({
			exitCode: 0,
			stderr: "",
			stdout: `Selected one file in a local 00 Inbox:\n  fileName: ${FILE_NAME}\n  localAccount: ${PERSONAL}\n`,
		})
	})

	test("with two local inboxes the chooser starts at CloudStorage and the reply names the chosen account", () => {
		const second = createChooseFixture()
		try {
			mkdirSync(inbox(second, OTHER), { recursive: true })
			writeFileSync(join(inbox(second, OTHER), "Fictional other note.txt"), "fictional")
			const process = choose(second, ["--json"], { reply: `${inbox(second, OTHER)}/Fictional other note.txt\n` })
			expect(result(process).data).toEqual({ fileName: "Fictional other note.txt", localAccount: OTHER })
			expect(chooserArguments(second)?.[0]).toBe(second.storage)
		} finally {
			rmSync(second.root, { force: true, recursive: true })
		}
	})
})

// Each refused reply must give the identical value-free bytes, so a refusal is no oracle for what was selected.
describe("a selection that is not one file directly inside 00 Inbox", () => {
	const refusedReplies: [string, (f: ChooseFixture) => string][] = [
		["a nested file", (f) => {
			mkdirSync(join(inbox(f, PERSONAL), "Fictional folder"), { recursive: true })
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
			symlinkSync(join(f.root, "elsewhere.txt"), join(inbox(f, PERSONAL), "Fictional link.txt"))
			writeFileSync(join(f.root, "elsewhere.txt"), "fictional")
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

	const refused = (process: ProcessResult) => ({ exitCode: process.exitCode, stderr: process.stderr, stdout: process.stdout })
	let expected: { exitCode: number | null; stderr: string; stdout: string } | null = null

	for (const [name, prepare] of refusedReplies) {
		test(`${name} is refused with the fixed value-free envelope`, () => {
			const process = choose(fixture, ["--json"], { reply: prepare(fixture) })
			expect(result(process)).toMatchObject({ causeCode: "DOMAIN_PATH_REFUSED", outcome: "refused", exitCode: 3, data: null })
			for (const value of [FILE_NAME, PERSONAL, "Fictional", fixture.root]) expect(process.stdout).not.toContain(value)
			expected ??= refused(process)
			expect(refused(process)).toEqual(expected)
		})
	}

	test("a linked 00 Inbox is not an inbox, so the only account has none", () => {
		const linked = createChooseFixture()
		try {
			const real = join(linked.root, "real-inbox")
			rmSync(inbox(linked, PERSONAL), { recursive: true })
			mkdirSync(real)
			symlinkSync(real, inbox(linked, PERSONAL))
			const process = choose(linked, ["--json"], { reply: `${inbox(linked, PERSONAL)}/${FILE_NAME}\n` })
			expect(result(process).causeCode).toBe("DOMAIN_CONFIG_MISSING")
			expect(chooserArguments(linked)).toBeNull()
		} finally {
			rmSync(linked.root, { force: true, recursive: true })
		}
	})
})

describe("refusals before or around the dialog", () => {
	test("no CloudStorage folder refuses before any chooser opens", () => {
		const empty = createChooseFixture()
		try {
			rmSync(empty.storage, { recursive: true })
			const process = choose(empty, ["--json"])
			expect(result(process)).toMatchObject({ causeCode: "DOMAIN_CONFIG_MISSING", exitCode: 3 })
			expect(chooserArguments(empty)).toBeNull()
		} finally {
			rmSync(empty.root, { force: true, recursive: true })
		}
	})

	test("a cancelled dialog hands back to Nathan without a value", () => {
		const process = choose(fixture, ["--json"], { mode: "cancel" })
		expect(result(process)).toMatchObject({ causeCode: "DOMAIN_AUTHORITY_REQUIRED", exitCode: 3, handoff: { owner: "human" } })
		expect(process.stderr).toBe("")
	})

	test("a chooser that cannot open is an internal refusal that never echoes its error", () => {
		const process = choose(fixture, ["--json"], { mode: "fail" })
		expect(result(process)).toMatchObject({ causeCode: "INTERNAL_PREPARATION", exitCode: 1 })
		expect(process.stdout).not.toContain("-1713")
	})

	test("a missing osascript is the same internal refusal", () => {
		const child = Bun.spawnSync({ cmd: [process.execPath, RUNTIME, "choose", "--json"], cwd: fixture.root, env: { HOME: fixture.home, PATH: join(fixture.root, "no-such-bin") }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
		expect(JSON.parse(child.stdout.toString()).result.causeCode).toBe("INTERNAL_PREPARATION")
	})

	test("an exhausted descriptor table is a retryable refusal before the chooser opens", () => {
		const process = choose(fixture, ["--json"], { preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS })
		expect(result(process)).toMatchObject({ causeCode: "TRANSIENT_NOT_STARTED", exitCode: 75, retryable: true })
		expect(chooserArguments(fixture)).toBeNull()
	})

	test("an operand is a usage refusal and opens no chooser", () => {
		expect(result(choose(fixture, ["/some/path", "--json"]))).toMatchObject({ commandIdentity: "source-intake-dispatch.choose", causeCode: "USAGE_INVALID_INVOCATION" })
		expect(chooserArguments(fixture)).toBeNull()
	})
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

test("source-intake-dispatch.choose declares exactly the expected stations and reaches every one", () => {
	const discovery = Bun.spawnSync({ cmd: [COMMAND, "--discover-command", "source-intake-dispatch.choose", "--json"], cwd: fixture.root, env: chooseEnv(fixture, {}), stdout: "pipe" })
	expect(JSON.parse(discovery.stdout.toString()).result.data.stations.map(projection).sort()).toEqual(EXPECTED_STATIONS)
	const throwing = join(fixture.root, "preload-throws.ts")
	writeFileSync(throwing, SERIALIZER_THROWS)
	const noStorage = createChooseFixture()
	rmSync(noStorage.storage, { recursive: true })
	const valid = `${inbox(fixture, PERSONAL)}/${FILE_NAME}\n`
	try {
		const observed = [
			result(choose(fixture, ["--json"], { reply: valid })),
			result(choose(fixture, ["extra", "--json"])),
			result(choose(noStorage, ["--json"])),
			result(choose(fixture, ["--json"], { mode: "cancel" })),
			result(choose(fixture, ["--json"], { reply: `${fixture.root}/x\n` })),
			result(choose(fixture, ["--json"], { mode: "fail" })),
			result(choose(fixture, ["--json"], { preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS })),
			result(choose(fixture, ["--json"], { reply: valid, preload: throwing })),
		].map((value) => {
			expect(value.commandIdentity).toBe("source-intake-dispatch.choose")
			return projection(value)
		})
		expect(observed.sort()).toEqual(EXPECTED_STATIONS)
	} finally {
		rmSync(noStorage.root, { force: true, recursive: true })
	}
})

// Wrong behavior caught: a signal handler that exits without closing the dialog, leaving it on Nathan's screen.
for (const [signal, exitCode] of [
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	test(`${signal} while the chooser is open closes it and exits ${exitCode} with empty streams`, async () => {
		rmSync(fixture.log, { force: true })
		rmSync(`${fixture.log}.pid`, { force: true })
		const child = Bun.spawn([process.execPath, RUNTIME, "choose", "--json"], { cwd: fixture.root, env: chooseEnv(fixture, { mode: "hang" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
		const stdout = new Response(child.stdout).text()
		const stderr = new Response(child.stderr).text()
		for (let attempt = 0; attempt < 5_000 && !existsSync(`${fixture.log}.pid`); attempt += 1) await Bun.sleep(1)
		const chooserPid = Number(readFileSync(`${fixture.log}.pid`, "utf8"))
		child.kill(signal)
		expect(await child.exited).toBe(exitCode)
		expect({ stdout: await stdout, stderr: await stderr }).toEqual({ stdout: "", stderr: "" })
		let alive = true
		for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
			try {
				process.kill(chooserPid, 0)
				await Bun.sleep(10)
			} catch {
				alive = false
			}
		}
		expect(alive).toBe(false)
	})
}
