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

export async function runCommand(
	argv: string[],
	options: { cwd: string; env?: Record<string, string> },
): Promise<CommandResult> {
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: options.env ? { ...process.env, ...options.env } : process.env,
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
	return runCommand(['git', '-C', cwd, ...args], { cwd })
}

export async function resolveRepoRoot(cwd: string): Promise<string | null> {
	try {
		const { exitCode, stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel'])
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
