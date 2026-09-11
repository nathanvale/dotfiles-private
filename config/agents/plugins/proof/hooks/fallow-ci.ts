#!/usr/bin/env bun

/**
 * Fallow quality hook. `PreToolUse` runs the changed-code audit before
 * `git commit` or `git push` and blocks only on a `fail` verdict, the
 * official Fallow gate pattern, because it is the one layer an agent cannot
 * route around. `Stop` runs the same audit against the working-tree delta.
 * Both paths exit 0 silently when the repository has no local Fallow, and
 * never block on an operational error (invalid ref, no git repo) or output
 * they cannot parse.
 */

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
	resolveToolContext,
	runCommand,
	summariseFailure,
} from './common.ts'

const FALLOW_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css']
const FALLOW_MARKERS = ['.fallowrc.json']
const GIT_COMMIT_OR_PUSH = /(^|[;&|\n]\s*)git\b[^;&|\n]*\b(commit|push)\b/

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

/**
 * Forces `--gate new-only` regardless of the target repo's own `.fallowrc.json`:
 * under `--gate all`, Fallow skips the attribution pass and no finding carries
 * `introduced`, which would make `collectFindings` return nothing and fall
 * back to a raw-excerpt block on pre-existing findings instead of gating only
 * what this change introduced.
 */
async function runFallowAudit(
	binary: string,
	repoRoot: string,
	extraArgs: string[],
): Promise<CommandResult> {
	return runCommand(
		[
			binary,
			'audit',
			'--format',
			'json',
			'--quiet',
			'--type-aware',
			'--type-aware-require',
			'best-effort',
			'--gate',
			'new-only',
			...extraArgs,
		],
		{ cwd: repoRoot },
	)
}

function skipOperational(event: string, result: CommandResult): void {
	const excerpt = (result.stderr || result.stdout).trim().slice(0, 500)
	process.stderr.write(
		JSON.stringify({ tool: 'fallow-ci', event, status: 'skipped', reason: 'operational', excerpt }),
	)
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

	const context = await resolveToolContext(input, 'fallow', FALLOW_MARKERS)
	if (!context) process.exit(0)
	const { repoRoot, binary } = context

	const extraArgs = action === 'commit' ? ['--changed-since', 'HEAD'] : []
	const result = await runFallowAudit(binary, repoRoot, extraArgs)
	evaluate('PreToolUse', action, result)
	process.exit(0)
}

async function runStop(input: HookInput, harness: Harness): Promise<never> {
	if (input.stop_hook_active === true) passStop(harness)

	const context = await resolveToolContext(input, 'fallow', FALLOW_MARKERS)
	if (!context) passStop(harness)
	const { repoRoot, binary } = context

	const files = await changedFiles(repoRoot, FALLOW_EXTENSIONS)
	if (files.length === 0) passStop(harness)

	const result = await runFallowAudit(binary, repoRoot, ['--changed-since', 'HEAD'])
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
