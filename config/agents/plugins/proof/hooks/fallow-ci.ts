#!/usr/bin/env bun

/**
 * Fallow quality hook. `PreToolUse` runs the changed-code audit before
 * `git commit` or `git push` and blocks only on a `fail` verdict, the
 * official Fallow gate pattern, because it is the one layer an agent cannot
 * route around. `Stop` runs the same audit against the working-tree delta.
 * Both paths exit 0 silently when the repository has no `.fallowrc.json`,
 * report a `no-runner` skip when it has one but no local or exactly pinned
 * Fallow, and never block on an operational error (invalid ref, no git repo)
 * or output they cannot parse.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	armSelfDestruct,
	blockWithEnvelope,
	changedFiles,
	type CommandResult,
	type FailureEntry,
	type Harness,
	type HookInput,
	parseHarness,
	passStop,
	readHookInput,
	resolveCwd,
	resolveRepoRoot,
	resolveRepoTool,
	runCommand,
	summariseFailure,
} from './common.ts'

const FALLOW_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css']
const FALLOW_MARKERS = ['.fallowrc.json']
const GIT_COMMIT_OR_PUSH = /(^|[;&|\n]\s*)git\b[^;&|\n]*\b(commit|push)\b/
const PINNED_LAUNCHERS = new Set(['pnpm', 'npx', 'bunx'])
const EXACT_FALLOW_PIN = /^fallow@\d+\.\d+\.\d+$/
const TYPE_AWARE_ARGS = ['--type-aware', '--type-aware-require', 'best-effort']
const LEGACY_TYPE_AWARE_ERROR = "unexpected argument '--type-aware'"
const NO_RUNNER_EXCERPT =
	'.fallowrc.json is present, but there is no node_modules/.bin/fallow and no exact fallow@x.y.z pin in .mcp.json; Fallow did not run.'

interface McpServerEntry {
	command?: unknown
	args?: unknown
}

interface FallowFinding {
	path?: string
	file?: string
	line?: number
	export_name?: string
	name?: string
	introduced?: boolean
}

interface FallowAuditReport {
	verdict?: string
	changed_files_count?: number
	dead_code?: Record<string, unknown>
	complexity?: { findings?: unknown[] }
	duplication?: { clone_groups?: unknown[] }
}

function collectIntroduced(section: string, key: string, items: unknown): FailureEntry[] {
	if (!Array.isArray(items)) return []
	const entries: FailureEntry[] = []
	for (const raw of items) {
		const item = raw as FallowFinding
		if (!item.introduced) continue
		entries.push({
			file: item.path ?? item.file ?? '<fallow>',
			line: item.line ?? 0,
			message: `[${section}.${key}] ${item.export_name ?? item.name ?? ''}`,
		})
	}
	return entries
}

function collectFindings(report: FallowAuditReport): FailureEntry[] {
	const entries: FailureEntry[] = []
	for (const [key, value] of Object.entries(report.dead_code ?? {})) {
		entries.push(...collectIntroduced('dead_code', key, value))
	}
	entries.push(...collectIntroduced('complexity', 'findings', report.complexity?.findings))
	entries.push(...collectIntroduced('duplication', 'clone_groups', report.duplication?.clone_groups))
	return entries
}

/** Returns the repository root only when it carries the `.fallowrc.json` marker. */
async function resolveFallowRepo(input: HookInput): Promise<string | null> {
	const repoRoot = await resolveRepoRoot(resolveCwd(input))
	if (!repoRoot) return null
	return FALLOW_MARKERS.some((marker) => existsSync(join(repoRoot, marker))) ? repoRoot : null
}

function readMcpFallowServer(repoRoot: string): McpServerEntry | null {
	try {
		const config = JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf8')) as {
			mcpServers?: { fallow?: McpServerEntry }
		}
		return config.mcpServers?.fallow ?? null
	} catch {
		return null
	}
}

/**
 * Reuses the repository's own exact `.mcp.json` Fallow pin, such as
 * `pnpm dlx --package fallow@2.102.0 fallow-mcp`, with the CLI bin in place
 * of the MCP bin. A floating version or an unknown launcher is not a runner.
 */
function pinnedMcpRunner(repoRoot: string): string[] | null {
	const server = readMcpFallowServer(repoRoot)
	const command = server?.command
	const args = server?.args
	if (typeof command !== 'string' || !PINNED_LAUNCHERS.has(command)) return null
	if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
		return null
	}
	if (args.at(-1) !== 'fallow-mcp' || !args.some((arg) => EXACT_FALLOW_PIN.test(arg))) return null
	return [command, ...args.slice(0, -1), 'fallow']
}

/** A repo-local binary wins; otherwise the repository's exact `.mcp.json` pin. */
function resolveFallowRunner(repoRoot: string): string[] | null {
	const binary = resolveRepoTool(repoRoot, 'fallow', FALLOW_MARKERS)
	return binary ? [binary] : pinnedMcpRunner(repoRoot)
}

/**
 * Forces `--gate new-only` regardless of the target repo's own `.fallowrc.json`:
 * under `--gate all`, Fallow skips the attribution pass and no finding carries
 * `introduced`, which would make `collectFindings` return nothing and fall
 * back to a raw-excerpt block on pre-existing findings instead of gating only
 * what this change introduced. A pinned Fallow older than type-aware analysis
 * rejects those flags, so the audit retries once without them.
 */
async function runFallowAudit(
	runner: string[],
	repoRoot: string,
	extraArgs: string[],
): Promise<CommandResult> {
	const audit = (typeAware: string[]) =>
		runCommand(
			[...runner, 'audit', '--format', 'json', '--quiet', ...typeAware, '--gate', 'new-only', ...extraArgs],
			{ cwd: repoRoot },
		)
	const result = await audit(TYPE_AWARE_ARGS)
	const output = `${result.stdout}${result.stderr}`
	return output.includes(LEGACY_TYPE_AWARE_ERROR) ? audit([]) : result
}

function reportSkip(event: string, reason: string, excerpt: string): void {
	process.stderr.write(JSON.stringify({ tool: 'fallow-ci', event, status: 'skipped', reason, excerpt }))
}

function skipOperational(event: string, result: CommandResult): void {
	reportSkip(event, 'operational', (result.stderr || result.stdout).trim().slice(0, 500))
}

/** Resolves once the audit verdict is known: passes, blocks (never returns), or skips. */
function evaluate(event: string, scope: string, result: CommandResult): 'pass' | 'skip' {
	if (result.exitCode === 0) return 'pass'

	if (result.exitCode === 1) {
		let report: FallowAuditReport
		try {
			report = JSON.parse(result.stdout) as FallowAuditReport
		} catch {
			skipOperational(event, result)
			return 'skip'
		}
		if (report.verdict !== 'fail') return 'pass'

		const entries = collectFindings(report)
		const summary = summariseFailure(result, entries, '<fallow>')
		blockWithEnvelope({
			tool: 'fallow-ci',
			event,
			status: 'error',
			scope,
			fileCount: report.changed_files_count ?? 0,
			errorCount: summary.errorCount,
			errors: summary.errors,
		})
	}

	skipOperational(event, result)
	return 'skip'
}

function matchCommitOrPush(command: string): 'commit' | 'push' | null {
	const match = GIT_COMMIT_OR_PUSH.exec(command)
	if (!match) return null
	return match[2] === 'push' ? 'push' : 'commit'
}

async function runPreToolUse(input: HookInput): Promise<void> {
	if (input.tool_name !== 'Bash') process.exit(0)

	const command = input.tool_input?.command
	if (typeof command !== 'string') process.exit(0)

	const action = matchCommitOrPush(command)
	if (!action) process.exit(0)

	const repoRoot = await resolveFallowRepo(input)
	if (!repoRoot) process.exit(0)
	const runner = resolveFallowRunner(repoRoot)
	if (!runner) {
		reportSkip('PreToolUse', 'no-runner', NO_RUNNER_EXCERPT)
		process.exit(0)
	}

	const extraArgs = action === 'commit' ? ['--changed-since', 'HEAD'] : []
	const result = await runFallowAudit(runner, repoRoot, extraArgs)
	evaluate('PreToolUse', action, result)
	process.exit(0)
}

async function runStop(input: HookInput, harness: Harness): Promise<never> {
	if (input.stop_hook_active === true) passStop(harness)

	const repoRoot = await resolveFallowRepo(input)
	if (!repoRoot) passStop(harness)

	const files = await changedFiles(repoRoot, FALLOW_EXTENSIONS)
	if (files.length === 0) passStop(harness)

	const runner = resolveFallowRunner(repoRoot)
	if (!runner) {
		reportSkip('Stop', 'no-runner', NO_RUNNER_EXCERPT)
		passStop(harness)
	}

	const result = await runFallowAudit(runner, repoRoot, ['--changed-since', 'HEAD'])
	evaluate('Stop', 'changed-files', result)
	passStop(harness)
}

async function main(): Promise<void> {
	const harness = parseHarness(process.argv.slice(2))
	const input = await readHookInput()

	if (input.hook_event_name === 'Stop') {
		armSelfDestruct('fallow-ci', 48_000)
		await runStop(input, harness)
		return
	}
	if (input.hook_event_name === 'PreToolUse') {
		armSelfDestruct('fallow-ci', 24_000)
		await runPreToolUse(input)
		return
	}
	process.exit(0)
}

if (import.meta.main) main()
