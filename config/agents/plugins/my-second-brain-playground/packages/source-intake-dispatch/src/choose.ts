// The attended one-item chooser. Nathan alone sees the local 00 Inbox, in the native macOS chooser; the caller receives
// only the selected file's name and local account, and only when that file sits directly inside a local Google Drive
// for desktop 00 Inbox. The command reads no file content, writes nothing and names no path in a refusal.
import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { isDescriptorLimit } from "./gate.ts"

export type ChooseOutcome =
	| { kind: "selected"; fileName: string; localAccount: string }
	| { kind: "cancelled" | "chooserUnavailable" | "inputBusy" | "noInbox" | "selectionRefused" }

/** One local Google Drive for desktop account folder and its 00 Inbox, both at their own physical paths. */
interface LocalInbox {
	account: string
	inbox: string
}

// The system osascript, by absolute path, never resolved through PATH. This pins the executable only; the README
// names the process trust boundary.
const OSASCRIPT = "/usr/bin/osascript"
const ACCOUNT_PREFIX = "GoogleDrive-"
const INBOX_PATH = ["My Drive", "00 Inbox"] as const
const PROMPT = "Choose one file in 00 Inbox for Source Intake"
// AppleScript reports a user cancel as error -128.
const USER_CANCELLED = "(-128)"
// The start folder and prompt arrive as run-handler arguments, so no caller value is spliced into the script text.
const CHOOSER_SCRIPT = [
	"on run argv",
	"set startFolder to POSIX file (item 1 of argv) as alias",
	"return POSIX path of (choose file with prompt (item 2 of argv) default location startFolder without invisibles and multiple selections allowed)",
	"end run",
]

let chooser: Bun.Subprocess | null = null

/** Closes an open chooser dialog. The signal handlers call it so no dialog outlives the command. */
export function closeChooser(): void {
	chooser?.kill()
}

type Probe = "present" | "absent" | "chooserUnavailable" | "inputBusy"
type Refusal = Exclude<Probe, "present" | "absent">

// Errors that mean the path, or one of its parents, is not there as a directory.
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"])

/** An absent path is "absent"; any other failure means this session cannot inspect it. */
function probeFailure(error: unknown): "absent" | Refusal {
	if (isDescriptorLimit(error)) return "inputBusy"
	return ABSENT_CODES.has((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "chooserUnavailable"
}

/**
 * A directory that is its own physical path, so no link can stand in for the account folder or 00 Inbox. A link, a
 * non-directory or a non-canonical path is "absent"; a path this session may not inspect is a refusal, never absent.
 */
function probeDirectory(path: string): Probe {
	try {
		return lstatSync(path).isDirectory() && realpathSync(path) === path ? "present" : "absent"
	} catch (error) {
		return probeFailure(error)
	}
}

/**
 * Every local 00 Inbox under HOME/Library/CloudStorage, sorted by path. HOME is trusted configuration, as for the
 * receipt root. A missing CloudStorage folder means no inbox. Any candidate this session cannot inspect refuses the
 * whole run, so a denied account is never reported as missing.
 */
function localInboxes(storage: string): LocalInbox[] | Refusal {
	let entries: string[]
	try {
		entries = readdirSync(storage)
	} catch (error) {
		const failure = probeFailure(error)
		return failure === "absent" ? [] : failure
	}
	const inboxes: LocalInbox[] = []
	for (const entry of entries.filter((name) => name.startsWith(ACCOUNT_PREFIX) && name.length > ACCOUNT_PREFIX.length)) {
		const candidate = { account: entry.slice(ACCOUNT_PREFIX.length), inbox: join(storage, entry, ...INBOX_PATH) }
		const probe = probeDirectory(candidate.inbox)
		if (probe === "present") inboxes.push(candidate)
		else if (probe !== "absent") return probe
	}
	return inboxes.sort((left, right) => left.inbox.localeCompare(right.inbox))
}

type ChooserReply = { kind: "reply"; text: string } | { kind: "cancelled" | "chooserUnavailable" | "inputBusy" }

/** Runs the native chooser; its stderr is classified, never echoed. */
async function runChooser(startFolder: string): Promise<ChooserReply> {
	try {
		chooser = Bun.spawn([OSASCRIPT, ...CHOOSER_SCRIPT.flatMap((line) => ["-e", line]), startFolder, PROMPT], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	} catch (error) {
		return { kind: isDescriptorLimit(error) ? "inputBusy" : "chooserUnavailable" }
	}
	const [exitCode, text, stderr] = await Promise.all([chooser.exited, new Response(chooser.stdout as ReadableStream).text(), new Response(chooser.stderr as ReadableStream).text()])
	chooser = null
	if (exitCode === 0) return { kind: "reply", text }
	return { kind: stderr.includes(USER_CANCELLED) ? "cancelled" : "chooserUnavailable" }
}

/** The reply must name one regular, non-hidden file whose parent is exactly one of the discovered inboxes. */
function acceptSelection(reply: string, inboxes: readonly LocalInbox[]): ChooseOutcome {
	const path = reply.endsWith("\n") ? reply.slice(0, -1) : reply
	if (!isAbsolute(path) || /[\0\n\r]/.test(path) || path.endsWith("/")) return { kind: "selectionRefused" }
	const fileName = basename(path)
	const match = inboxes.find((candidate) => candidate.inbox === dirname(path))
	if (match === undefined || fileName.startsWith(".")) return { kind: "selectionRefused" }
	const probe = probeDirectory(match.inbox)
	if (probe !== "present") return { kind: probe === "absent" ? "selectionRefused" : probe }
	try {
		if (!lstatSync(path).isFile()) return { kind: "selectionRefused" }
	} catch {
		return { kind: "selectionRefused" }
	}
	return { kind: "selected", fileName, localAccount: match.account }
}

/**
 * Opens the chooser at the one local 00 Inbox, or at the CloudStorage folder when several accounts have one, then
 * accepts only a file directly inside a discovered inbox.
 */
export async function chooseItem(): Promise<ChooseOutcome> {
	const home = homedir()
	if (!isAbsolute(home)) return { kind: "noInbox" }
	const storage = join(home, "Library", "CloudStorage")
	const inboxes = localInboxes(storage)
	if (typeof inboxes === "string") return { kind: inboxes }
	const [only, ...others] = inboxes
	if (only === undefined) return { kind: "noInbox" }
	const reply = await runChooser(others.length === 0 ? only.inbox : storage)
	if (reply.kind !== "reply") return { kind: reply.kind }
	return acceptSelection(reply.text, inboxes)
}
