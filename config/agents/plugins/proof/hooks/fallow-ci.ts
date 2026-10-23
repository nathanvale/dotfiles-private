#!/usr/bin/env bun

/**
 * New-only Fallow ratchet for literal shell commits/pushes and the Stop
 * branch-delta backstop. Baselines come from local Git refs, never a forge
 * API. Missing markers self-disable; operational failures remain explicit
 * fail-open skips, not passing qualifications.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
	blockWithEnvelope,
	createCommandScope,
	type CommandResult,
	type FailureEntry,
	type Harness,
	type HookInput,
	parseHarness,
	passStop,
	readHookInput,
	resolveCwd,
	resolveRepoRoot,
	summariseFailure,
} from './common.ts'

const commandScope = createCommandScope()
const runCommand = commandScope.run

const FALLOW_MARKERS = ['.fallowrc.json']
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
		if (!raw || typeof raw !== 'object') continue
		const item = raw as FallowFinding
		if (item.introduced !== true) continue
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

/** Activate when the marker exists in the working tree, index or committed HEAD. */
async function resolveFallowRepo(input: HookInput, cwd = resolveCwd(input)): Promise<string | null> {
	const repoRoot = await resolveRepoRoot(cwd, runCommand)
	if (commandScope.cancelled) throw new Error('Command scope was cancelled')
	if (!repoRoot) return null
	if (FALLOW_MARKERS.some((marker) => existsSync(join(repoRoot, marker)))) return repoRoot
	const markers = await Promise.all([
		gitOutput(repoRoot, ['ls-files', '--error-unmatch', '--', '.fallowrc.json']),
		gitOutput(repoRoot, ['cat-file', '-e', 'HEAD:.fallowrc.json']),
	])
	return markers.some((result) => result.exitCode === 0) ? repoRoot : null
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
	const binary = join(repoRoot, 'node_modules', '.bin', 'fallow')
	return existsSync(binary) ? [binary] : pinnedMcpRunner(repoRoot)
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

interface AuditBase {
	commit: string
	branchQualified: boolean
}

async function gitOutput(repoRoot: string, args: string[]): Promise<CommandResult> {
	return runCommand(['git', '-C', repoRoot, ...args], { cwd: repoRoot })
}

async function commitForRef(repoRoot: string, ref: string): Promise<string | null> {
	const result = await gitOutput(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
	const commit = result.stdout.trim()
	return result.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(commit) ? commit : null
}

async function declaredBaseCommit(repoRoot: string, ref: string): Promise<string> {
	for (const candidate of [`${ref}@{upstream}`, `refs/remotes/origin/${ref}`, ref]) {
		const commit = await commitForRef(repoRoot, candidate)
		if (commit) return commit
	}
	throw new Error(`Declared workflow.baseBranch does not resolve to a commit: ${ref}`)
}

/** Select local Git identities only; no forge, credentials, fetch or provider API. */
async function comparisonBase(repoRoot: string): Promise<AuditBase> {
	const head = await commitForRef(repoRoot, 'HEAD')
	if (!head) throw new Error('No initial commit is available for a Fallow comparison')
	const override = process.env.FALLOW_AUDIT_BASE?.trim()
	const declared = await gitOutput(repoRoot, ['config', '--get', 'workflow.baseBranch'])
	let selected: string | null
	if (override) {
		selected = await commitForRef(repoRoot, override)
		if (!selected) throw new Error(`FALLOW_AUDIT_BASE does not resolve to a commit: ${override}`)
	} else if (declared.exitCode === 0 && declared.stdout.trim()) {
		selected = await declaredBaseCommit(repoRoot, declared.stdout.trim())
	} else {
		if (declared.exitCode !== 1) throw new Error('Cannot read workflow.baseBranch')
		const remote = await gitOutput(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
		if (remote.exitCode !== 0) return { commit: head, branchQualified: false }
		selected = await commitForRef(repoRoot, remote.stdout.trim())
		if (!selected) throw new Error('origin/HEAD does not resolve to a local commit')
	}
	const merged = await gitOutput(repoRoot, ['merge-base', head, selected])
	if (merged.exitCode !== 0 || !merged.stdout.trim())
		throw new Error('Fallow comparison base has no common history with HEAD')
	return { commit: merged.stdout.trim(), branchQualified: true }
}

/** Include committed changes, staged/unstaged changes and untracked paths, including deletions. */
async function hasFallowChanges(repoRoot: string, base: AuditBase): Promise<boolean> {
	const results = await Promise.all([
		gitOutput(repoRoot, ['diff', '--name-only', '-z', base.commit, '--']),
		gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
	])
	if (results.some((result) => result.exitCode !== 0))
		throw new Error('Cannot enumerate the Fallow comparison delta')
	return results.some((result) => result.stdout.length > 0)
}

/** A publication audit must inspect the same repository content Git will persist. */
function blockCandidate(event: string, scope: string, reason: string, message: string, files: string[] = []): never {
	blockWithEnvelope({ tool: 'fallow-ci', event, status: 'error', scope, reason,
		fileCount: files.length, errorCount: 1,
		errors: [{ file: files[0] ?? '<git>', line: 0, message }],
	})
}

async function candidateDifference(repoRoot: string, ref?: string): Promise<string[]> {
	const tracked = await gitOutput(repoRoot, ['diff', '--name-only', '-z', ...(ref ? [ref] : []), '--'])
	const untracked = await gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
	if (tracked.exitCode !== 0 || untracked.exitCode !== 0) throw new Error('Cannot compare the proposed Git content with the working tree')
	return [...new Set(`${tracked.stdout}${untracked.stdout}`.split('\0').filter(Boolean))]
}

async function requireMatchingCandidate(repoRoot: string, event: string, scope: string, ref?: string): Promise<void> {
	const files = await candidateDifference(repoRoot, ref)
	if (files.length === 0) return
	const candidate = ref ? 'committed HEAD' : 'staged index'
	blockCandidate(event, scope, 'snapshot-mismatch',
		`Fallow reads the working tree, which differs from the ${candidate}: ${files.slice(0, 10).join(', ')}. Align the tracked and untracked files with that candidate, then retry. This guard conservatively blocks partial staging; it has not audited the persisted content.`, files)
}

/** Accept literal tokens only. Shell composition and substitutions can change the candidate after this hook. */
function literalCommandTokens(command: string): string[] | null {
	const pattern = /(?:'[^'\r\n]*'|"[^"$`\\\r\n]*"|[^ \t'"\\;&|<>$`(){}#*?[\]~\r\n])+/g
	const tokens = command.match(pattern) ?? []
	if (command.replace(pattern, '').replace(/[ \t]/g, '')) return null
	return tokens.map((token) => token.replace(/'([^']*)'|"([^"]*)"/g,
		(_fragment, single: string | undefined, double: string | undefined) => single ?? double ?? ''))
}

function supportedCommitArgs(args: string[]): boolean {
	const switches = new Set(['--amend', '--no-edit', '--no-verify', '-n', '--signoff', '-s', '--allow-empty', '--allow-empty-message', '--quiet', '-q', '--verbose', '-v'])
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? ''
		if (switches.has(arg) || arg.startsWith('--message=')) continue
		if (arg !== '-m' && arg !== '--message') return false
		if (args[++index] === undefined) return false
	}
	return true
}

function supportedPushArgs(args: string[]): boolean {
	const positional = args.filter((arg) => !['-u', '--set-upstream', '--no-verify', '--dry-run', '-n', '--porcelain', '--verbose', '-v', '--quiet', '-q'].includes(arg))
	if (positional.some((arg) => arg.startsWith('-'))) return false
	if (positional.length <= 1) return true
	return positional.length === 2 && /^HEAD(?::[^\s:]+)?$/.test(positional[1] ?? '')
}

interface PublicationCommand {
	cwd: string
	args: string[]
}

/** Only an absolute, single -C is independent of the harness's session cwd. */
function publicationCommand(input: HookInput, command: string, action: 'commit' | 'push'): PublicationCommand | null {
	const tokens = literalCommandTokens(command)
	if (tokens?.[0] !== 'git') return null
	if (tokens[1] === action) return { cwd: resolveCwd(input), args: tokens.slice(2) }
	const target = tokens[2]
	if (tokens[1] !== '-C' || !target || !isAbsolute(target) || tokens[3] !== action) return null
	return { cwd: target, args: tokens.slice(4) }
}

async function requireSupportedCommand(repoRoot: string, publication: PublicationCommand | null, action: 'commit' | 'push'): Promise<void> {
	const args = publication?.args ?? []
	const supported = publication && (action === 'commit' ? supportedCommitArgs(args) : supportedPushArgs(args))
	if (!supported) blockCandidate('PreToolUse', action, 'unsupported-command',
		'Run a single git commit or git push, optionally with one absolute git -C <directory>. Compound commands, other Git prefix options, alternate commit content modes and other push refs cannot be qualified. Stage changes separately, then retry.')
	if (action !== 'push' || args.filter((arg) => !arg.startsWith('-')).length === 2) return
	const configured = await gitOutput(repoRoot, ['config', '--get-regexp', '^(remote\\..*\\.(push|mirror)|push\\.default)$'])
	if (configured.exitCode > 1) throw new Error('Cannot read configured Git push selection')
	const unsupported = configured.stdout.split('\n').some((line) => line.startsWith('remote.') || /^push\.default (matching|nothing)$/.test(line))
	if (unsupported) blockCandidate('PreToolUse', action, 'unsupported-command',
		'Configured Git push selection may publish a ref other than the audited HEAD. Use a single explicit git push <remote> HEAD:<branch>.')
}

/** Reuse an initialized checkout of exactly HEAD; never create or modify Git content. */
async function cleanHeadWorktree(repoRoot: string, head: string): Promise<string | null> {
	const listed = await gitOutput(repoRoot, ['worktree', 'list', '--porcelain', '-z'])
	if (listed.exitCode !== 0) throw new Error('Cannot enumerate existing Git worktrees')
	for (const record of listed.stdout.split('\0\0')) {
		const fields = record.split('\0')
		const root = fields.find((field) => field.startsWith('worktree '))?.slice(9)
		if (!root || root === repoRoot || !fields.includes(`HEAD ${head}`)) continue
		if (!existsSync(join(root, 'node_modules/.bin/fallow'))) continue
		if ((await candidateDifference(root, 'HEAD')).length === 0 && await commitForRef(root, 'HEAD') === head) return root
	}
	return null
}

async function requireStableHead(repoRoot: string, snapshot: string, head: string): Promise<void> {
	const files = await candidateDifference(snapshot, 'HEAD')
	const heads = await Promise.all([commitForRef(repoRoot, 'HEAD'), commitForRef(snapshot, 'HEAD')])
	if (files.length > 0 || heads.some((current) => current !== head))
		blockCandidate('Stop', 'branch-delta', 'snapshot-changed',
			'The committed checkout changed during its Fallow audit. Restore a clean checkout at the session HEAD and retry.', files)
}

async function guardCommittedBranch(repoRoot: string, base: AuditBase): Promise<void> {
	const head = await commitForRef(repoRoot, 'HEAD')
	if (!head) throw new Error('Cannot resolve the committed audit candidate')
	const committed = await gitOutput(repoRoot, ['diff', '--name-only', '-z', base.commit, head, '--'])
	if (committed.exitCode !== 0) throw new Error('Cannot enumerate committed branch changes')
	if (!committed.stdout || (await candidateDifference(repoRoot, 'HEAD')).length === 0) return
	const snapshot = await cleanHeadWorktree(repoRoot, head)
	if (!snapshot) {
		await requireMatchingCandidate(repoRoot, 'Stop', 'branch-delta', 'HEAD')
		return
	}
	await requireStableHead(repoRoot, snapshot, head)
	const result = await runFallowAudit([join(snapshot, 'node_modules/.bin/fallow')], snapshot, ['--base', base.commit])
	await requireStableHead(repoRoot, snapshot, head)
	evaluate('Stop', 'committed-branch', result)
}

function reportUnqualifiedBase(event: string, base: AuditBase): void {
	if (!base.branchQualified)
		reportSkip(event, 'branch-base-unavailable', 'No FALLOW_AUDIT_BASE, workflow.baseBranch or origin/HEAD is available. Only the working-tree delta against HEAD is qualified; committed branch changes were not checked.')
}

function reportSkip(event: string, reason: string, excerpt: string): void {
	process.stderr.write(JSON.stringify({ tool: 'fallow-ci', event, status: 'skipped', reason, excerpt: excerpt.slice(0, 500) }))
}

function skipOperational(event: string, result: CommandResult): void {
	reportSkip(event, 'operational', (result.stderr || result.stdout).trim() || `Fallow exited with code ${result.exitCode} without a qualified report.`)
}

/** Resolves once the audit verdict is known: passes, blocks (never returns), or skips. */
function evaluate(event: string, scope: string, result: CommandResult): 'pass' | 'skip' {
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		skipOperational(event, result)
		return 'skip'
	}
	let report: FallowAuditReport
	try {
		report = JSON.parse(result.stdout) as FallowAuditReport
		if (!report || !['pass', 'warn', 'fail'].includes(report.verdict ?? '')) throw new Error('Invalid verdict')
	} catch {
		skipOperational(event, result)
		return 'skip'
	}
	if (report.verdict === 'pass' || report.verdict === 'warn') {
		if (result.exitCode !== 0) skipOperational(event, result)
		return result.exitCode === 0 ? 'pass' : 'skip'
	}
	const entries = collectFindings(report)
	const summary = summariseFailure({ ...result, exitCode: 1 }, entries, '<fallow>')
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

/** Identify Git's subcommand, never publication words in a read-only command's arguments. */
function publicationAction(tokens: string[]): 'commit' | 'push' | null {
	let start = 0
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] ?? '')) start += 1
	if (tokens[start] !== 'git') return null
	const withValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])
	let index = start + 1
	while (tokens[index]?.startsWith('-')) {
		const option = tokens[index++] ?? ''
		if (option === '--') break
		if (withValue.has(option)) index += 1
	}
	const action = tokens[index]
	return action === 'commit' || action === 'push' ? action : null
}

function matchCommitOrPush(command: string): 'commit' | 'push' | null {
	// Split shell clauses without splitting quoted arguments. This is detection,
	// not execution: actual publication still requires the strict literal policy.
	const clauses = command.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^;&|\n])+/g) ?? []
	for (const clause of clauses) {
		const words = clause.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g) ?? []
		const tokens = words.map((word) => literalCommandTokens(word)?.join('') ?? word)
		const action = publicationAction(tokens)
		if (action) return action
	}
	return null
}

async function runPreToolUse(input: HookInput): Promise<void> {
	if (input.tool_name !== 'Bash') process.exit(0)

	const command = input.tool_input?.command
	if (typeof command !== 'string') process.exit(0)

	const action = matchCommitOrPush(command)
	if (!action) process.exit(0)

	const publication = publicationCommand(input, command, action)
	const repoRoot = await resolveFallowRepo(input, publication?.cwd)
	if (!repoRoot) process.exit(0)
	const runner = resolveFallowRunner(repoRoot)
	if (!runner) {
		reportSkip('PreToolUse', 'no-runner', NO_RUNNER_EXCERPT)
		process.exit(0)
	}

	await requireSupportedCommand(repoRoot, publication, action)
	await requireMatchingCandidate(repoRoot, 'PreToolUse', action, action === 'push' ? 'HEAD' : undefined)
	const base = await comparisonBase(repoRoot)
	const result = await runFallowAudit(runner, repoRoot, ['--base', base.commit])
	if (evaluate('PreToolUse', action, result) === 'pass')
		reportUnqualifiedBase('PreToolUse', base)
	process.exit(0)
}

async function runStop(input: HookInput, harness: Harness): Promise<never> {
	if (input.stop_hook_active === true) passStop(harness)

	const repoRoot = await resolveFallowRepo(input)
	if (!repoRoot) passStop(harness)

	const runner = resolveFallowRunner(repoRoot)
	if (!runner) {
		reportSkip('Stop', 'no-runner', NO_RUNNER_EXCERPT)
		passStop(harness)
	}
	if (!existsSync(join(repoRoot, '.fallowrc.json'))) {
		await requireMatchingCandidate(repoRoot, 'Stop', 'branch-delta')
		await requireMatchingCandidate(repoRoot, 'Stop', 'branch-delta', 'HEAD')
	}
	const base = await comparisonBase(repoRoot)
	await guardCommittedBranch(repoRoot, base)
	if (!(await hasFallowChanges(repoRoot, base))) {
		reportUnqualifiedBase('Stop', base)
		passStop(harness)
	}

	const result = await runFallowAudit(runner, repoRoot, ['--base', base.commit])
	if (evaluate('Stop', base.branchQualified ? 'branch-delta' : 'working-tree-only', result) === 'pass')
		reportUnqualifiedBase('Stop', base)
	passStop(harness)
}

/** Preserve fail-open budgets while emitting a parseable Codex Stop pass and an explicit skip. */
function armFallowTimeout(event: string, harness: Harness, ms: number): void {
	const timer = setTimeout(async () => {
		let cleanupError = ''
		try {
			await commandScope.cancel()
		} catch (error) {
			cleanupError = ` Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
		}
		reportSkip(event, 'timeout', `Fallow did not finish within ${ms}ms; no audit verdict was qualified.${cleanupError}`)
		if (event === 'Stop') passStop(harness)
		process.exit(0)
	}, ms)
	timer.unref()
}

async function main(): Promise<void> {
	const harness = parseHarness(process.argv.slice(2))
	const input = await readHookInput()
	try {
		if (input.hook_event_name === 'Stop') {
			armFallowTimeout('Stop', harness, 48_000)
			await runStop(input, harness)
			return
		}
		if (input.hook_event_name === 'PreToolUse') {
			armFallowTimeout('PreToolUse', harness, 24_000)
			await runPreToolUse(input)
			return
		}
	} catch (error) {
		if (commandScope.cancelled) return
		reportSkip(input.hook_event_name ?? 'unknown', 'operational', error instanceof Error ? error.message : 'Hook execution failed')
		if (input.hook_event_name === 'Stop') passStop(harness)
	}
	process.exit(0)
}

if (import.meta.main) main()
