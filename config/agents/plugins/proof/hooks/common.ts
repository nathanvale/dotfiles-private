/**
 * Shared helpers for the proof plugin's quality hooks. Owns the "the tool is
 * present in this repository" gate (repo-local binary plus a marker file,
 * never bunx or a global install), changed-file discovery, command spawning,
 * failure summarising, the harness-neutral pass/block output contracts, and
 * the fail-open self-destruct timer.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type Harness = 'claude' | 'codex'

export interface HookInput {
	hook_event_name?: string
	stop_hook_active?: boolean
	cwd?: string
	tool_name?: string
	tool_input?: {
		command?: unknown
		file_path?: string
		edits?: { file_path?: string }[]
	}
}

export interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface FailureEntry {
	file: string
	line: number
	message: string
}

export interface FailureSummary {
	errorCount: number
	errors: FailureEntry[]
}

const MAX_REPORTED_ENTRIES = 30
const RAW_EXCERPT_LENGTH = 500

/** `--harness=codex` is appended to every command this plugin's Codex hooks.json runs. */
export function parseHarness(argv: string[]): Harness {
	return argv.includes('--harness=codex') ? 'codex' : 'claude'
}

export async function readHookInput(): Promise<HookInput> {
	try {
		const raw = await Bun.stdin.text()
		if (!raw.trim()) return {}
		return JSON.parse(raw) as HookInput
	} catch {
		// Empty or non-JSON stdin should never block a hook.
		return {}
	}
}

export function resolveCwd(input: HookInput): string {
	return typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd()
}

/** Awaits a piped subprocess's exit code alongside its fully drained stdout/stderr text. */
export async function collectSpawnResult(
	exited: Promise<number>,
	stdout: ReadableStream<Uint8Array>,
	stderr: ReadableStream<Uint8Array>,
): Promise<CommandResult> {
	const [exitCode, stdoutText, stderrText] = await Promise.all([
		exited,
		new Response(stdout).text(),
		new Response(stderr).text(),
	])
	return { exitCode, stdout: stdoutText, stderr: stderrText }
}

function spawnCommand(argv: string[], options: Parameters<typeof runCommand>[1], detached = false) {
	return Bun.spawn(argv, {
		cwd: options.cwd,
		detached,
		stdout: 'pipe',
		stderr: 'pipe',
		env: options.env ? { ...process.env, ...options.env } : process.env,
	})
}

export async function runCommand(argv: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CommandResult> {
	const proc = spawnCommand(argv, options)
	return collectSpawnResult(proc.exited, proc.stdout, proc.stderr)
}

/** Owns POSIX command groups until their process and inherited output pipes have closed. */
export function createCommandScope() {
	const pending = new Map<number, Promise<CommandResult>>()
	let cancelled = false
	return {
		get cancelled() { return cancelled },
		async run(argv: string[], options: Parameters<typeof runCommand>[1]): Promise<CommandResult> {
			if (cancelled) throw new Error('Command scope was cancelled')
			const proc = spawnCommand(argv, options, true)
			const result = collectSpawnResult(proc.exited, proc.stdout, proc.stderr)
			pending.set(proc.pid, result)
			try {
				const collected = await result
				if (cancelled) throw new Error('Command scope was cancelled')
				return collected
			} finally {
				pending.delete(proc.pid)
			}
		},
		async cancel(): Promise<void> {
			cancelled = true
			if (process.platform === 'win32') throw new Error('Command group cleanup requires POSIX signals')
			const commands = [...pending]
			for (const [pid] of commands) signalCommandGroup(pid, 'SIGTERM')
			// Fallow handles SIGTERM and shuts down its detached type-aware group.
			// Give that protocol a bounded grace before forcing unresponsive launchers.
			const results = commands.map(([, result]) => result)
			if (await drainCommands(results, 1000)) return
			for (const [pid] of commands) {
				if (pending.has(pid)) signalCommandGroup(pid, 'SIGKILL')
			}
			if (!(await drainCommands(results, 1000))) {
				throw new Error('Owned command output did not close after forced termination')
			}
		},
	}
}

/** Negative PIDs address only the detached command groups created above. */
function signalCommandGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	try {
		process.kill(-pid, signal)
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
	}
}

async function drainCommands(results: Promise<CommandResult>[], ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			Promise.allSettled(results).then(() => true),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
		])
	} finally {
		clearTimeout(timer)
	}
}

async function runGit(cwd: string, args: string[], execute = runCommand): Promise<CommandResult> {
	return execute(['git', '-C', cwd, ...args], { cwd })
}

export async function resolveRepoRoot(cwd: string, execute = runCommand): Promise<string | null> {
	try {
		const { exitCode, stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel'], execute)
		if (exitCode !== 0) return null
		return stdout.trim() || null
	} catch {
		return null
	}
}

/** Requires a repo-local `node_modules/.bin/<binName>` AND at least one marker file. */
export function resolveRepoTool(
	repoRoot: string,
	binName: string,
	markerFiles: string[],
): string | null {
	const hasMarker = markerFiles.some((marker) => existsSync(join(repoRoot, marker)))
	if (!hasMarker) return null
	const binary = join(repoRoot, 'node_modules', '.bin', binName)
	if (!existsSync(binary)) return null
	return binary
}

export interface ToolContext {
	repoRoot: string
	binary: string
}

/** Shared repo-root-then-tool-marker guard prologue for every Stop and PreToolUse hook path. */
export async function resolveToolContext(
	input: HookInput,
	binName: string,
	markerFiles: string[],
): Promise<ToolContext | null> {
	const repoRoot = await resolveRepoRoot(resolveCwd(input))
	if (!repoRoot) return null
	const binary = resolveRepoTool(repoRoot, binName, markerFiles)
	if (!binary) return null
	return { repoRoot, binary }
}

export async function changedFiles(repoRoot: string, extensions: string[]): Promise<string[]> {
	const commands = [
		['diff', '--cached', '--name-only', '--diff-filter=d'],
		['diff', '--name-only', '--diff-filter=d'],
		['ls-files', '--others', '--exclude-standard'],
	]
	const outputs = await Promise.all(
		commands.map(async (args) => {
			const { stdout } = await runGit(repoRoot, ['-c', 'core.quotePath=false', ...args])
			return stdout
		}),
	)
	const seen = new Set<string>()
	for (const output of outputs) {
		for (const line of output.split('\n')) {
			const file = line.trim()
			if (!file) continue
			if (!extensions.some((extension) => file.endsWith(extension))) continue
			seen.add(join(repoRoot, file))
		}
	}
	return [...seen].filter((file) => existsSync(file))
}

/**
 * Falls back to a capped raw-output excerpt when the caller found no
 * structured entries but the command still failed, so a tool that crashed
 * without emitting its usual report format still surfaces something.
 */
export function summariseFailure(
	result: CommandResult,
	entries: FailureEntry[],
	toolLabel: string,
): FailureSummary {
	if (result.exitCode !== 0 && entries.length === 0) {
		const excerpt = (result.stderr || result.stdout).trim().slice(0, RAW_EXCERPT_LENGTH)
		return {
			errorCount: 1,
			errors: [
				{
					file: toolLabel,
					line: 0,
					message: excerpt || `${toolLabel} exited with code ${result.exitCode} and no output`,
				},
			],
		}
	}
	return {
		errorCount: entries.length,
		errors: entries.slice(0, MAX_REPORTED_ENTRIES),
	}
}

export function armSelfDestruct(name: string, ms: number): void {
	const timer = setTimeout(() => {
		process.stderr.write(`${name}: timed out\n`)
		process.exit(0)
	}, ms)
	timer.unref()
}

/** Codex `Stop` rejects plain-text stdout on exit 0, so it needs an empty JSON object. */
export function passStop(harness: Harness): never {
	if (harness === 'codex') process.stdout.write('{}')
	process.exit(0)
}

/** Never write the envelope to stdout: only stderr carries the blocking reason. */
export function blockWithEnvelope(envelope: unknown): never {
	process.stderr.write(JSON.stringify(envelope))
	process.exit(2)
}
