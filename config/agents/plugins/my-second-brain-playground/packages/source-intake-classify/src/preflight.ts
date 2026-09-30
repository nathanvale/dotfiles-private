// The fail-closed pre-flight. Before any model call, it proves for this run, with the lane's exact configuration, that
// Codex's sandbox denies the private receipt roots and that the model session resolves the same profile and the
// dedicated instructions. Probe output never leaves this module; the caller learns only pass or fail.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Lane, PROFILE_NAME } from "./lane.ts"

const PROBE_TIMEOUT_MS = 15_000
const PERMISSION_DENIAL = "Operation not permitted"
const INSTRUCTIONS_HEADING = "# Source Intake classifier lane"
const VERSION_LINE = /^codex-cli (\d+\.\d+\.\d+[^\s]*)\n?$/

interface Captured {
	exitCode: number | null
	stdout: string
	stderr: string
}

function capture(lane: Lane, cmd: string[], cwd: string): Captured {
	try {
		const child = Bun.spawnSync({ cmd, cwd, env: lane.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS })
		return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
	} catch {
		return { exitCode: null, stdout: "", stderr: "" }
	}
}

function sandboxed(lane: Lane, workspace: string, argv: string[]): Captured {
	return capture(lane, [lane.codex, "sandbox", ...lane.configArgs, "-P", PROFILE_NAME, "-C", workspace, "--", ...argv], workspace)
}

/** A permission denial: the command failed, printed nothing, and the sandbox named the denial. */
function denied(result: Captured): boolean {
	return result.exitCode !== 0 && result.exitCode !== null && result.stdout === "" && result.stderr.includes(PERMISSION_DENIAL)
}

/** The running Codex version, from the same binary the lane runs. */
export function codexVersion(lane: Lane): string | null {
	const result = capture(lane, [lane.codex, "--version"], lane.laneHome)
	const match = result.exitCode === 0 ? VERSION_LINE.exec(result.stdout) : null
	return match?.[1] ?? null
}

/** Positive control: the sandbox runs a permitted command, so a later denial is the profile, not a broken sandbox. */
function controlHolds(lane: Lane, workspace: string): boolean {
	const nonce = randomBytes(16).toString("hex")
	const result = sandboxed(lane, workspace, ["/bin/echo", nonce])
	return result.exitCode === 0 && result.stdout === `${nonce}\n`
}

/** Removes the directories mkdirSync created, deepest first, stopping at the first one still in use. */
function removeCreated(directory: string, firstCreated: string | undefined): void {
	for (let path = directory; firstCreated !== undefined && path.startsWith(firstCreated); path = dirname(path)) {
		try {
			rmdirSync(path)
		} catch {
			return
		}
	}
}

/**
 * A synthetic receipt at the real receipt layout, `drive-inbox-filing/items/preflight-<nonce>/`, under the configured
 * private root: cat, stat and ls must all be denied. The stat probe fails a root where the sandbox still answers file
 * metadata (Codex does under the per-user temporary directory), so file size and times stay closed too.
 */
function sentinelDenied(lane: Lane, workspace: string): boolean {
	const nonce = randomBytes(16).toString("hex")
	const directory = join(lane.privateRoot, "drive-inbox-filing", "items", `preflight-${nonce}`)
	const sentinel = join(directory, "classification-metadata.json")
	const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 })
	try {
		writeFileSync(sentinel, `${nonce}\n`, { mode: 0o600, flag: "wx" })
		const probes = [["/bin/cat", sentinel], ["/usr/bin/stat", sentinel], ["/bin/ls", directory]]
		return probes.every((argv) => denied(sandboxed(lane, workspace, argv)))
	} finally {
		if (existsSync(sentinel)) unlinkSync(sentinel)
		removeCreated(directory, firstCreated)
	}
}

/** The sandbox marks network access disabled for the lane's commands. */
function networkDisabled(lane: Lane, workspace: string): boolean {
	const result = sandboxed(lane, workspace, ["/usr/bin/env"])
	return result.exitCode === 0 && result.stdout.split("\n").includes("CODEX_SANDBOX_NETWORK_DISABLED=1")
}

/** Each spelling of both receipt roots, and the caller's Codex credential, must be denied. A missing root is not a denial. */
function rootsDenied(lane: Lane, workspace: string): boolean {
	const rootsHold = lane.deniedRoots.every((root) => denied(sandboxed(lane, workspace, ["/bin/cat", root])) && denied(sandboxed(lane, workspace, ["/bin/ls", root])))
	return rootsHold && denied(sandboxed(lane, workspace, ["/bin/cat", lane.authTarget]))
}

function promptText(stdout: string): string | null {
	try {
		const items: unknown = JSON.parse(stdout)
		if (!Array.isArray(items)) return null
		const texts = items.flatMap((item) => (Array.isArray(item?.content) ? item.content : [])).map((part: { text?: unknown }) => part?.text)
		return texts.filter((text): text is string => typeof text === "string").join("\n")
	} catch {
		return null
	}
}

function contains(ancestor: string, path: string): boolean {
	return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * Every read entry under a denied root must be Codex's own helper-link directory. A more specific read entry overrides
 * a deny, so any other one would open part of a receipt root that the sentinel probe cannot see.
 */
function readEntriesHold(lane: Lane, text: string): boolean {
	const helperLinks = join(lane.laneHome, "tmp", "arg0")
	const reads = [...text.matchAll(/<entry access="read"><path>([^<]*)<\/path><\/entry>/g)].map((match) => match[1] ?? "")
	return reads.every((path) => !lane.deniedRoots.some((root) => contains(root, path)) || contains(helperLinks, path))
}

/**
 * The model session's own configuration: rendered without a model call, it must carry the dedicated instructions, no
 * AGENTS.md instructions, no multi-agent role, approval never, restricted network, no write entry, no extra read entry
 * under a denied root, and a deny entry for the filesystem root, both temporary directories and every receipt root
 * spelling.
 */
function sessionHolds(lane: Lane, workspace: string): boolean {
	const result = capture(lane, [lane.codex, "debug", "prompt-input", ...lane.configArgs, "pre-flight"], workspace)
	const text = result.exitCode === 0 ? promptText(result.stdout) : null
	if (text === null || text.includes("# AGENTS.md instructions") || text.includes("<multi_agent_role>") || !text.includes(INSTRUCTIONS_HEADING)) return false
	if (!text.includes("Approval policy is currently never.") || !text.includes("Network access is restricted.") || text.includes('<entry access="write"')) return false
	const entries = ["<special>:root</special>", "<special>:tmpdir</special>", "<special>:slash_tmp</special>", ...lane.deniedRoots.map((root) => `<path>${root}</path>`)]
	return entries.every((entry) => text.includes(`<entry access="deny" escalatable="false">${entry}</entry>`)) && readEntriesHold(lane, text)
}

/** True only when every probe passes. Any error, timeout or unexpected output fails closed. */
export function runPreflight(lane: Lane, workspace: string): boolean {
	try {
		return controlHolds(lane, workspace) && networkDisabled(lane, workspace) && sentinelDenied(lane, workspace) && rootsDenied(lane, workspace) && sessionHolds(lane, workspace)
	} catch {
		return false
	}
}
