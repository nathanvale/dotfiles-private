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

/** A directory that is its own physical path, so no link can stand in for the account folder or 00 Inbox. */
function isPhysicalDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory() && realpathSync(path) === path
	} catch {
		return false
	}
}

/**
 * Every local 00 Inbox under HOME/Library/CloudStorage, sorted. HOME is trusted configuration, as for the receipt root.
 * A missing CloudStorage folder means no inbox; any other read failure means this session cannot see it.
 */
function localInboxes(storage: string): string[] | "unavailable" {
	let entries: string[]
	try {
		entries = readdirSync(storage)
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : "unavailable"
	}
	return entries
		.filter((entry) => entry.startsWith(ACCOUNT_PREFIX) && entry.length > ACCOUNT_PREFIX.length)
		.map((entry) => join(storage, entry, ...INBOX_PATH))
		.filter(isPhysicalDirectory)
		.sort()
}

type ChooserReply = { kind: "reply"; text: string } | { kind: "cancelled" | "chooserUnavailable" | "inputBusy" }

/** Runs the native chooser through osascript on PATH; its stderr is classified, never echoed. */
async function runChooser(startFolder: string): Promise<ChooserReply> {
	try {
		chooser = Bun.spawn(["osascript", ...CHOOSER_SCRIPT.flatMap((line) => ["-e", line]), startFolder, PROMPT], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	} catch (error) {
		return { kind: isDescriptorLimit(error) ? "inputBusy" : "chooserUnavailable" }
	}
	const [exitCode, text, stderr] = await Promise.all([chooser.exited, new Response(chooser.stdout as ReadableStream).text(), new Response(chooser.stderr as ReadableStream).text()])
	chooser = null
	if (exitCode === 0) return { kind: "reply", text }
	return { kind: stderr.includes(USER_CANCELLED) ? "cancelled" : "chooserUnavailable" }
}

/** The reply must name one regular, non-hidden file whose parent is exactly one of the discovered inboxes. */
function acceptSelection(reply: string, inboxes: readonly string[]): ChooseOutcome {
	const path = reply.endsWith("\n") ? reply.slice(0, -1) : reply
	if (!isAbsolute(path) || /[\0\n\r]/.test(path) || path.endsWith("/")) return { kind: "selectionRefused" }
	const inbox = dirname(path)
	const fileName = basename(path)
	if (!inboxes.includes(inbox) || fileName.startsWith(".") || !isPhysicalDirectory(inbox)) return { kind: "selectionRefused" }
	try {
		if (!lstatSync(path).isFile()) return { kind: "selectionRefused" }
	} catch {
		return { kind: "selectionRefused" }
	}
	const localAccount = basename(dirname(dirname(inbox))).slice(ACCOUNT_PREFIX.length)
	return { kind: "selected", fileName, localAccount }
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
	if (inboxes === "unavailable") return { kind: "chooserUnavailable" }
	const [only, ...others] = inboxes
	if (only === undefined) return { kind: "noInbox" }
	const reply = await runChooser(others.length === 0 ? only : storage)
	if (reply.kind !== "reply") return { kind: reply.kind }
	return acceptSelection(reply.text, inboxes)
}
