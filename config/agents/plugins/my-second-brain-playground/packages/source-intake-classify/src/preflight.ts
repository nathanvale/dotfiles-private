// The fail-closed pre-flight. Before any model call, it proves for this run, with the lane's exact configuration, that
// Codex's sandbox denies the private receipt roots and that the model session resolves the same profile and the
// dedicated instructions. Probe output never leaves this module; the caller learns only pass or fail.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

/**
 * A synthetic sentinel under a throwaway directory in the configured private root: cat, stat and ls must all be
 * denied. The stat probe fails a root where the sandbox still answers file metadata (Codex does under the per-user
 * temporary directory), so file size and times stay closed too.
 */
function sentinelDenied(lane: Lane, workspace: string): boolean {
	const nonce = randomBytes(16).toString("hex")
	const directory = join(lane.privateRoot, "source-intake-classify", `preflight-${nonce}`)
	const sentinel = join(directory, "sentinel")
	mkdirSync(directory, { mode: 0o700 })
	try {
		writeFileSync(sentinel, `${nonce}\n`, { mode: 0o600, flag: "wx" })
		const probes = [["/bin/cat", sentinel], ["/usr/bin/stat", sentinel], ["/bin/ls", directory]]
		return probes.every((argv) => denied(sandboxed(lane, workspace, argv)))
	} finally {
		if (existsSync(sentinel)) unlinkSync(sentinel)
		rmdirSync(directory)
	}
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

/**
 * The model session's own configuration: rendered without a model call, it must carry the dedicated instructions, no
 * AGENTS.md instructions, no multi-agent role, approval never, and a deny entry for the filesystem root and every
 * receipt root spelling.
 */
function sessionHolds(lane: Lane, workspace: string): boolean {
	const result = capture(lane, [lane.codex, "debug", "prompt-input", ...lane.configArgs, "pre-flight"], workspace)
	const text = result.exitCode === 0 ? promptText(result.stdout) : null
	if (text === null || text.includes("# AGENTS.md instructions") || text.includes("<multi_agent_role>") || !text.includes(INSTRUCTIONS_HEADING)) return false
	if (!text.includes("Approval policy is currently never.")) return false
	const entries = ['<special>:root</special>', ...lane.deniedRoots.map((root) => `<path>${root}</path>`)]
	return entries.every((entry) => text.includes(`<entry access="deny" escalatable="false">${entry}</entry>`))
}

/** True only when every probe passes. Any error, timeout or unexpected output fails closed. */
export function runPreflight(lane: Lane, workspace: string): boolean {
	try {
		return controlHolds(lane, workspace) && sentinelDenied(lane, workspace) && rootsDenied(lane, workspace) && sessionHolds(lane, workspace)
	} catch {
		return false
	}
}
