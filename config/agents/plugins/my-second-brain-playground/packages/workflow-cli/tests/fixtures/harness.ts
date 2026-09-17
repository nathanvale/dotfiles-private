import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Public process seam: every scenario spawns a fresh `bun run src/cli.ts` under a fresh private root with a pinned,
// scrubbed environment, an isolated MSB_WORKFLOW_STATE_HOME, and the fixture bd shim as MSB_WORKFLOW_BD_EXECUTABLE.
// Both streams are piped; stdin is ignored except for `hook`. Nothing here imports the modules under test; the
// fault helpers compose the production context through its documented seam inside a fresh process.

const PRODUCTION_CLI = resolve(import.meta.dir, "../../src/cli.ts")
const NATIVE = resolve(import.meta.dir, "../../src/adapters/native.ts")
export const FIXTURE_BD = resolve(import.meta.dir, "checker/bd")
export const SECRET_MARKER = "CHECK_FIXTURE_SECRET_MARKER"
export const BEAD = "lkr-fixture"
export const OTHER_BEAD = "lkr-other"
export const SECRET_BEAD = "lkr-secret"

export interface Root {
	/** A Git working directory: bind derives sourceRepository from it. */
	readonly privateRoot: string
	readonly workspace: string
	readonly stateHome: string
}

export function createRoot(): Root {
	const privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "msb-workflow-")))
	const workspace = join(privateRoot, "workspace")
	const stateHome = join(privateRoot, "state")
	mkdirSync(join(workspace, ".beads"), { recursive: true, mode: 0o700 })
	mkdirSync(stateHome, { recursive: true, mode: 0o700 })
	const init = Bun.spawnSync(["git", "init", "-q", privateRoot], { stdout: "pipe", stderr: "pipe" })
	if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`)
	return { privateRoot, workspace, stateHome }
}

export function removeRoot(root: Root): void {
	rmSync(root.privateRoot, { recursive: true, force: true })
}

/** Steers the fixture bd for this root's workspace; an empty object restores the recorded defaults. */
export function steerBd(root: Root, scenario: Record<string, unknown>): void {
	writeFileSync(join(root.workspace, ".beads", "fixture.json"), `${JSON.stringify(scenario)}\n`)
}

export function bindingPath(root: Root, session: string): string {
	return join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery", "sessions", `${session}.json`)
}

export function markerPath(root: Root, session: string): string {
	return join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery", "sessions", `${session}.marker.json`)
}

export function diagnosticsDirectory(root: Root): string {
	return join(root.stateHome, "my-second-brain-playground", "workflow-cli", "diagnostics")
}

export interface Run {
	readonly stdout: string
	readonly stderr: string
	readonly exit: number
}

export interface RunOptions {
	/** Overrides for the pinned child environment; an undefined value removes that variable from the child. */
	readonly env?: Record<string, string | undefined>
	readonly cwd?: string
	readonly stdin?: string
	readonly timeoutMs?: number
}

function childEnvironment(root: Root, overrides: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "", NO_COLOR: "1", TERM: "dumb", MSB_WORKFLOW_STATE_HOME: root.stateHome, MSB_WORKFLOW_BD_EXECUTABLE: FIXTURE_BD }
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key]
		else env[key] = value
	}
	return env
}

async function spawnBun(args: readonly string[], root: Root, options: RunOptions): Promise<Run> {
	const child = Bun.spawn(["bun", ...args], { cwd: options.cwd ?? root.privateRoot, env: childEnvironment(root, options.env ?? {}), stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe" })
	const deadline = options.timeoutMs ?? 30_000
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		child.kill("SIGKILL")
	}, deadline)
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
	const exit = await child.exited
	clearTimeout(timer)
	if (timedOut) throw new Error(`msb-workflow hung for ${deadline} ms; partial stdout ${stdout.length} bytes`)
	return { stdout, stderr, exit }
}

/** Drives the production entry in a fresh process. */
export function runCli(root: Root, argv: readonly string[], options: RunOptions = {}): Promise<Run> {
	return spawnBun(["run", PRODUCTION_CLI, ...argv], root, options)
}

/** Drives the production `hook` entry with one Harness event on stdin. */
export function runHook(root: Root, event: unknown, options: RunOptions = {}): Promise<Run> {
	return spawnBun(["run", PRODUCTION_CLI, "hook"], root, { ...options, stdin: typeof event === "string" ? event : JSON.stringify(event) })
}

export type StoreFaultMode = "before-rename" | "after-rename" | "hold-lock-3s"

/** A fresh process drives runCli's public parser, dispatch, envelope and exit while the Recovery Adapter fails at
 * the documented write seam: before the rename (unchanged) or after it (unknown), or holds the locked section. */
export function runCliWithStoreFault(root: Root, argv: readonly string[], mode: StoreFaultMode, options: RunOptions = {}): Promise<Run> {
	const script = `
import { main } from ${JSON.stringify(PRODUCTION_CLI)}
import { productionContext } from ${JSON.stringify(NATIVE)}
const mode = ${JSON.stringify(mode)}
const fail = () => { throw new Error("controlled " + mode + " failure") }
const hooks = mode === "before-rename" ? { beforeReplace: fail } : mode === "after-rename" ? { afterReplace: fail } : { beforeReplace: () => Bun.sleepSync(3000) }
process.argv = [process.argv[0], "cli", ...${JSON.stringify(argv)}]
main(productionContext(process.env, process.cwd(), { storeHooks: { bindingWrite: hooks } }))
`
	return spawnBun(["-e", script], root, options)
}

/** A fresh process drives the production entry with a context whose Beads reader throws when opened: the one way to
 * reach the internal-failure station, because no argv reaches an internal outcome under Contract Core 1.0.0. */
export function runCliWithThrowingBeads(root: Root, argv: readonly string[], options: RunOptions = {}): Promise<Run> {
	const script = `
import { main } from ${JSON.stringify(PRODUCTION_CLI)}
import { productionContext } from ${JSON.stringify(NATIVE)}
process.argv = [process.argv[0], "cli", ...${JSON.stringify(argv)}]
main({ ...productionContext(process.env, process.cwd()), openBeads: () => { throw new Error("controlled reader failure") } })
`
	return spawnBun(["-e", script], root, options)
}

export type HookFaultMode = "kill-after-claim" | "kill-after-output"

/** The hook process kills itself with SIGKILL right after the durable claim or right after the panel left stdout. */
export function runHookWithFault(root: Root, event: unknown, mode: HookFaultMode, options: RunOptions = {}): Promise<Run> {
	const script = `
import { main } from ${JSON.stringify(PRODUCTION_CLI)}
import { productionContext } from ${JSON.stringify(NATIVE)}
const kill = () => process.kill(process.pid, "SIGKILL")
const faults = ${JSON.stringify(mode)} === "kill-after-claim" ? { afterClaim: kill } : { afterOutput: kill }
process.argv = [process.argv[0], "cli", "hook"]
main(productionContext(process.env, process.cwd()), { hookFaults: faults })
`
	return spawnBun(["-e", script], root, { ...options, stdin: JSON.stringify(event) })
}

/** Runs the production entry with the Lock Adapter for another platform selected at the composition seam. */
export function runCliOnPlatform(root: Root, argv: readonly string[], platform: string, options: RunOptions = {}): Promise<Run> {
	const script = `
import { main } from ${JSON.stringify(PRODUCTION_CLI)}
import { productionContext } from ${JSON.stringify(NATIVE)}
process.argv = [process.argv[0], "cli", ...${JSON.stringify(argv)}]
main(productionContext(process.env, process.cwd(), { platform: ${JSON.stringify(platform)} }))
`
	return spawnBun(["-e", script], root, options)
}

export interface Holder {
	readonly pid: number
	/** Resolves with the held lock path once the fixture printed its `held` line. */
	readonly held: Promise<string>
	kill(signal?: NodeJS.Signals): void
	readonly exited: Promise<number>
}

const HOLD_SESSION_LOCK = resolve(import.meta.dir, "checker/hold-session-lock.ts")

/** Spawns the checker's lock holder for a session (or, with a workspace, the workspace lock) through the helper's own Lock Adapter. */
export function spawnLockHolder(root: Root, session: string, workspace?: string): Holder {
	const args = workspace === undefined ? [session] : [session, "--workspace", workspace]
	const child = Bun.spawn(["bun", "run", HOLD_SESSION_LOCK, ...args], { cwd: root.privateRoot, env: childEnvironment(root, {}), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	const held = (async (): Promise<string> => {
		const reader = child.stdout.getReader()
		let text = ""
		for (;;) {
			const { value, done } = await reader.read()
			if (done) throw new Error(`lock holder exited before holding: ${await new Response(child.stderr).text()}`)
			text += new TextDecoder().decode(value)
			const match = /^held (.+)\n/m.exec(text)
			if (match !== null) return match[1] as string
		}
	})()
	return { pid: child.pid, held, kill: (signal = "SIGKILL") => child.kill(signal), exited: child.exited }
}

export function envelopeOf(run: Run): Record<string, unknown> {
	if (!run.stdout.endsWith("\n")) throw new Error(`stdout does not end with a newline: ${run.stdout.slice(-40)}`)
	if (run.stdout.trim().split("\n").length !== 1) throw new Error("stdout is not exactly one line")
	const parsed = JSON.parse(run.stdout) as unknown
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("stdout is not one JSON object")
	return parsed as Record<string, unknown>
}

export function resultOf(run: Run): Record<string, unknown> {
	const result = envelopeOf(run).result
	if (typeof result !== "object" || result === null) throw new Error("envelope result is not an object")
	return result as Record<string, unknown>
}

/** One Harness hook output line, or null when the hook was silent. */
export function hookOutputOf(run: Run): { hookEventName: string; additionalContext: string } | null {
	if (run.stdout === "") return null
	const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } }
	const specific = parsed.hookSpecificOutput
	if (specific === undefined || typeof specific.hookEventName !== "string" || typeof specific.additionalContext !== "string") throw new Error("hook output is not Harness JSON")
	return { hookEventName: specific.hookEventName, additionalContext: specific.additionalContext }
}

export function modeOf(path: string): number {
	return statSync(path).mode & 0o777
}

export function readJsonFile(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

/** Every byte the CLI retained under the private state root, for the secret-marker scan. */
export function retainedBytes(root: Root): string {
	const parts: string[] = []
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (entry.isFile()) parts.push(readFileSync(path, "utf8"))
		}
	}
	if (existsSync(root.stateHome)) walk(root.stateHome)
	return parts.join("\n")
}

/** Every path under the state root with its mode, for "nothing was written" and "only these were written" claims. */
export function stateListing(root: Root): string[] {
	const entries: string[] = []
	const walk = (directory: string, prefix: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name)
			const relativePath = `${prefix}${entry.name}`
			entries.push(`${relativePath}:${modeOf(path).toString(8)}`)
			if (entry.isDirectory()) walk(path, `${relativePath}/`)
		}
	}
	if (existsSync(root.stateHome)) walk(root.stateHome, "")
	return entries
}

export function hookEvent(root: Root, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { hook_event_name: "SessionStart", source: "startup", session_id: "session-1", cwd: root.privateRoot, ...overrides }
}

export async function bindSession(root: Root, session: string, bead: string = BEAD, extra: readonly string[] = []): Promise<Run> {
	const run = await runCli(root, ["bind", "--workspace", root.workspace, "--session", session, "--bead", bead, ...extra, "--json"])
	if (run.exit !== 0) throw new Error(`bind failed: ${run.stdout}${run.stderr}`)
	return run
}
