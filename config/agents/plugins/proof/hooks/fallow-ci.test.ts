import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
	cleanupTempDirs,
	git,
	initRepo,
	installFakeBinary,
	makeTempDir,
	processTreeFixture,
	runHook,
	wasInvoked,
} from './test-support.ts'

const HOOK_PATH = join(import.meta.dir, 'fallow-ci.ts')

function runFallowHook(input: unknown, args: string[] = [], env: Record<string, string> = {}) {
	return runHook(HOOK_PATH, input, args, { FALLOW_AUDIT_BASE: '', ...env })
}

afterAll(() => {
	cleanupTempDirs()
})

interface FallowEnvelope {
	tool: string
	event: string
	status: string
	scope: string
	fileCount: number
	errorCount: number
	errors: { file: string; line: number; message: string }[]
}

interface SkippedEnvelope {
	tool: string
	event: string
	status: string
	reason: string
	excerpt: string
}

function failReport(): string {
	return JSON.stringify({
		verdict: 'fail',
		changed_files_count: 2,
		dead_code: {
			unused_exports: [{ path: 'src/api.ts', export_name: 'oldApi', introduced: true }],
		},
		complexity: { findings: [] },
		duplication: { clone_groups: [] },
	})
}

async function setupRepo(dir: string, options: { withFallow?: boolean; exitCode?: number } = {}): Promise<void> {
	initRepo(dir)
	writeFileSync(join(dir, 'committed.ts'), 'export const a = 1\n')
	if (options.withFallow) {
		writeFileSync(join(dir, '.fallowrc.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		const body =
			options.exitCode === 1
				? `echo '${failReport()}'\nexit 1`
				: options.exitCode === 2
					? `echo 'invalid comparison base' 1>&2\nexit 2`
					: `echo '{"verdict":"warn"}'\nexit 0`
		installFakeBinary(dir, 'fallow', body)
	}
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'init')
		git(dir, 'branch', 'proof-baseline')
		git(dir, 'config', 'workflow.baseBranch', 'proof-baseline')
	writeFileSync(join(dir, 'dirty.ts'), 'export const b = 1\n')
}

describe('fallow-ci Stop', () => {
	test('exits 0 when stop_hook_active is true', async () => {
		const run = await runFallowHook({ hook_event_name: 'Stop', stop_hook_active: true })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 silently when the repository has no local Fallow', async () => {
		const dir = await makeTempDir('proof-fallow-nofallow-')
		await setupRepo(dir)
		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 without invoking Fallow when the changed-file delta is empty', async () => {
		const dir = await makeTempDir('proof-fallow-empty-')
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		installFakeBinary(dir, 'fallow', `echo '${failReport()}'\nexit 1`)
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')
		git(dir, 'branch', 'proof-baseline')
		git(dir, 'config', 'workflow.baseBranch', 'proof-baseline')

		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(wasInvoked(dir, 'fallow')).toBe(false)
	})

	test('exits 2 with an envelope when the verdict is fail', async () => {
		const dir = await makeTempDir('proof-fallow-fail-')
		await setupRepo(dir, { withFallow: true, exitCode: 1 })
		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as FallowEnvelope
		expect(envelope.tool).toBe('fallow-ci')
		expect(envelope.event).toBe('Stop')
		expect(envelope.status).toBe('error')
		expect(envelope.scope).toBe('branch-delta')
		expect(envelope.fileCount).toBe(2)
		expect(envelope.errorCount).toBe(1)
		expect(envelope.errors[0]?.message).toBe('[dead_code.unused_exports] oldApi')
	})

	test('passes when the verdict is warn', async () => {
		const dir = await makeTempDir('proof-fallow-warn-')
		await setupRepo(dir, { withFallow: true, exitCode: 0 })
		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('skips with status:skipped on an operational error', async () => {
		const dir = await makeTempDir('proof-fallow-error-')
		await setupRepo(dir, { withFallow: true, exitCode: 2 })
		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		const envelope = JSON.parse(run.stderr) as SkippedEnvelope
		expect(envelope.tool).toBe('fallow-ci')
		expect(envelope.status).toBe('skipped')
		expect(envelope.reason).toBe('operational')
	})

	test('writes {} to stdout on a codex-harness pass', async () => {
		const dir = await makeTempDir('proof-fallow-codex-')
		await setupRepo(dir, { withFallow: true, exitCode: 0 })
		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
	})

	test('exits 0 for an event it does not own', async () => {
		const run = await runFallowHook({ hook_event_name: 'SomeOtherEvent' })
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('')
		expect(run.stderr).toBe('')
	})
})

describe('fallow-ci PreToolUse', () => {
	async function setupCommitRepo(dir: string, argsCaptureFile: string, reportJson: string, exitCode: number): Promise<void> {
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		installFakeBinary(dir, 'fallow', `echo "$@" > '${argsCaptureFile}'\necho '${reportJson}'\nexit ${exitCode}`)
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')
		git(dir, 'branch', 'proof-baseline')
		git(dir, 'config', 'workflow.baseBranch', 'proof-baseline')
	}

	test('blocks a git commit when the verdict is fail', async () => {
		const dir = await makeTempDir('proof-fallow-pre-commit-')
		const argsFile = join(dir, '.fallow-args')
		await setupCommitRepo(dir, argsFile, failReport(), 1)

		const run = await runFallowHook({
			hook_event_name: 'PreToolUse',
			cwd: dir,
			tool_name: 'Bash',
			tool_input: { command: 'git commit -m x' },
		})
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as FallowEnvelope
		expect(envelope.tool).toBe('fallow-ci')
		expect(envelope.event).toBe('PreToolUse')
		expect(envelope.scope).toBe('commit')
		expect(envelope.errors[0]?.message).toBe('[dead_code.unused_exports] oldApi')
		const args = readFileSync(argsFile, 'utf8')
		expect(args).toContain('--base')
		expect(args).toContain('--gate new-only')
	})

	test('a git push uses the explicit branch base and still forces --gate new-only', async () => {
		const dir = await makeTempDir('proof-fallow-pre-push-')
		const argsFile = join(dir, '.fallow-args')
		await setupCommitRepo(dir, argsFile, '{"verdict":"pass"}', 0)

		const run = await runFallowHook({
			hook_event_name: 'PreToolUse',
			cwd: dir,
			tool_name: 'Bash',
			tool_input: { command: 'git push' },
		})
		expect(run.exitCode).toBe(0)
		const args = readFileSync(argsFile, 'utf8')
		expect(args).not.toContain('--changed-since')
		expect(args).toContain('--gate new-only')
	})

	test('blocks a git commit spread across a real newline between two git commands', async () => {
		const dir = await makeTempDir('proof-fallow-pre-newline-')
		const argsFile = join(dir, '.fallow-args')
		await setupCommitRepo(dir, argsFile, failReport(), 1)

		const run = await runFallowHook({
			hook_event_name: 'PreToolUse',
			cwd: dir,
			tool_name: 'Bash',
			tool_input: { command: 'git add x\ngit commit -m y' },
		})
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as FallowEnvelope
		expect(envelope.event).toBe('PreToolUse')
		expect(envelope.scope).toBe('commit')
	})

	test('exits 0 without invoking Fallow for an unrelated command', async () => {
		const dir = await makeTempDir('proof-fallow-pre-other-')
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		installFakeBinary(dir, 'fallow', 'exit 1')
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')
		git(dir, 'branch', 'proof-baseline')
		git(dir, 'config', 'workflow.baseBranch', 'proof-baseline')

		const run = await runFallowHook({
			hook_event_name: 'PreToolUse',
			cwd: dir,
			tool_name: 'Bash',
			tool_input: { command: 'ls -la' },
		})
		expect(run.exitCode).toBe(0)
		expect(wasInvoked(dir, 'fallow')).toBe(false)
	})
})

describe('fallow-ci runner resolution', () => {
	const LEGACY_FLAG_ERROR = JSON.stringify({
		error: true,
		message: "error: unexpected argument '--type-aware' found",
		exit_code: 2,
	})

	/** A fake `pnpm` on PATH that appends each argv line to `argsFile`, then runs `body`. */
	async function installFakeLauncher(argsFile: string, body: string): Promise<string> {
		const binDir = await makeTempDir('proof-fallow-launcher-')
		const launcher = join(binDir, 'pnpm')
		writeFileSync(launcher, `#!/bin/sh\necho "$@" >> '${argsFile}'\n${body}\n`)
		chmodSync(launcher, 0o755)
		return binDir
	}

	async function setupPinnedRepo(dir: string, fallowServer: unknown): Promise<void> {
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), '{}\n')
		if (fallowServer) {
			writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { fallow: fallowServer } }))
		}
		writeFileSync(join(dir, 'committed.ts'), 'export const a = 1\n')
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')
		git(dir, 'branch', 'proof-baseline')
		git(dir, 'config', 'workflow.baseBranch', 'proof-baseline')
		writeFileSync(join(dir, 'dirty.ts'), 'export const b = 1\n')
	}

	const pinnedServer = { command: 'pnpm', args: ['dlx', '--package', 'fallow@9.9.9', 'fallow-mcp'] }

	test('audits through the pinned .mcp.json launcher and blocks a fail verdict', async () => {
		const dir = await makeTempDir('proof-fallow-pinned-fail-')
		const argsFile = join(dir, '.launcher-args')
		await setupPinnedRepo(dir, pinnedServer)
		const binDir = await installFakeLauncher(argsFile, `echo '${failReport()}'\nexit 1`)

		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, [], {
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
		})
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as FallowEnvelope
		expect(envelope.event).toBe('Stop')
		expect(envelope.errors[0]?.message).toBe('[dead_code.unused_exports] oldApi')
		const args = readFileSync(argsFile, 'utf8')
		expect(args.startsWith('dlx --package fallow@9.9.9 fallow audit ')).toBe(true)
		expect(args).toContain('--gate new-only')
		expect(args).toContain('--base ')
	})

	test('passes a clean pinned audit with no stderr', async () => {
		const dir = await makeTempDir('proof-fallow-pinned-pass-')
		const argsFile = join(dir, '.launcher-args')
		await setupPinnedRepo(dir, pinnedServer)
		const binDir = await installFakeLauncher(argsFile, `echo '{"verdict":"pass"}'\nexit 0`)

		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'], {
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
		})
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		expect(run.stderr).toBe('')
		expect(readFileSync(argsFile, 'utf8')).toContain('fallow audit')
	})

	test('retries once without type-aware flags when the pinned Fallow predates them', async () => {
		const dir = await makeTempDir('proof-fallow-pinned-legacy-')
		const argsFile = join(dir, '.launcher-args')
		await setupPinnedRepo(dir, pinnedServer)
		const legacyOutput = join(dir, '.legacy-output')
		writeFileSync(legacyOutput, LEGACY_FLAG_ERROR)
		const body = [
			'case "$*" in',
			`  *--type-aware*) cat '${legacyOutput}'; exit 2 ;;`,
			`  *) echo '${failReport()}'; exit 1 ;;`,
			'esac',
		].join('\n')
		const binDir = await installFakeLauncher(argsFile, body)

		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, [], {
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
		})
		expect(run.exitCode).toBe(2)
		const calls = readFileSync(argsFile, 'utf8').trim().split('\n')
		expect(calls).toHaveLength(2)
		expect(calls[0]).toContain('--type-aware')
		expect(calls[1]).not.toContain('--type-aware')
		expect(calls[1]).toContain('--gate new-only')
	})

	test('reports an explicit no-runner skip for a marker without a local or pinned Fallow', async () => {
		const dir = await makeTempDir('proof-fallow-norunner-')
		await setupPinnedRepo(dir, null)

		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		const envelope = JSON.parse(run.stderr) as SkippedEnvelope
		expect(envelope.tool).toBe('fallow-ci')
		expect(envelope.status).toBe('skipped')
		expect(envelope.reason).toBe('no-runner')
	})

	test('treats an unpinned .mcp.json launcher as no runner and never invokes it', async () => {
		const dir = await makeTempDir('proof-fallow-unpinned-')
		const argsFile = join(dir, '.launcher-args')
		await setupPinnedRepo(dir, { command: 'pnpm', args: ['dlx', '--package', 'fallow@latest', 'fallow-mcp'] })
		const binDir = await installFakeLauncher(argsFile, 'exit 1')

		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, [], {
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
		})
		expect(run.exitCode).toBe(0)
		expect((JSON.parse(run.stderr) as SkippedEnvelope).reason).toBe('no-runner')
		expect(existsSync(argsFile)).toBe(false)
	})
})


describe('fallow-ci branch ratchet', () => {
	async function branchRepo(remote: string, base = 'staging'): Promise<{dir: string; baseline: string; argsFile: string}> {
		const dir = await makeTempDir('proof-fallow-branch-')
		await setupRepo(dir, {withFallow: true, exitCode: 1})
		git(dir, 'branch', base)
		git(dir, 'config', 'workflow.baseBranch', base)
		git(dir, 'remote', 'add', 'origin', remote)
		const baseline = Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim()
		git(dir, 'update-ref', `refs/remotes/origin/${base}`, baseline)
		git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${base}`)
		git(dir, 'switch', '-q', '-c', 'feature/ratchet')
		git(dir, 'add', 'dirty.ts')
		git(dir, 'commit', '-q', '-m', 'committed branch change')
		const argsFile = join(dir, '.fallow-args')
		installFakeBinary(dir, 'fallow', `printf '%s\n' "$@" > '${argsFile}'\necho '${failReport()}'\nexit 1`)
		return {dir, baseline, argsFile}
	}

	test('a clean committed GitHub branch still blocks Stop against declared staging', async () => {
		const {dir, baseline, argsFile} = await branchRepo('https://github.com/example/proof-fixture.git')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(run.exitCode).toBe(2)
		expect(JSON.parse(run.stderr).scope).toBe('branch-delta')
		expect(readFileSync(argsFile, 'utf8').split('\n')).toContain(baseline)
	})

	test('a Bitbucket worktree blocks mixed content without a clean HEAD checkout against develop', async () => {
		const {dir, argsFile} = await branchRepo('https://bitbucket.org/example/proof-fixture.git', 'develop')
		writeFileSync(join(dir, 'runtime.json'), '{}')
		const worktree = await makeTempDir('proof-fallow-worktree-')
		git(dir, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
		mkdirSync(join(worktree, 'node_modules/.bin'), {recursive: true})
		symlinkSync(join(dir, 'node_modules/.bin/fallow'), join(worktree, 'node_modules/.bin/fallow'))
		writeFileSync(join(worktree, 'uncommitted.js'), 'export const pending = true\n')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: worktree})
		expect(run.exitCode).toBe(2)
		expect(JSON.parse(run.stderr).scope).toBe('branch-delta')
		expect(JSON.parse(run.stderr).reason).toBe('snapshot-mismatch')
		expect(existsSync(argsFile)).toBe(false)
	})

	// Two sequential 48s Stop audits, each with bounded cleanup, plus fixture setup.
	test('the real local Fallow passes inherited debt and blocks a new committed export despite gate all config', async () => {
		const dir = await makeTempDir('proof-fallow-native-')
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), JSON.stringify({entry: ['index.js'], audit: {gate: 'all'}, health: {maxCrap: 0}, rules: {'unused-exports': 'error'}}))
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.fallow/\n')
		writeFileSync(join(dir, 'package.json'), '{"name":"proof-ratchet-fixture","private":true,"type":"module"}')
		writeFileSync(join(dir, 'index.js'), "import {used} from './api.js'; console.log(used)\n")
		writeFileSync(join(dir, 'api.js'), 'export const used = 1; export const inheritedUnused = 2;\n')
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'inherited baseline')
		git(dir, 'branch', 'baseline')
		git(dir, 'config', 'workflow.baseBranch', 'baseline')
		mkdirSync(join(dir, 'node_modules/.bin'), {recursive: true})
		symlinkSync(realpathSync(join(import.meta.dir, '../../../../../node_modules/.bin/fallow')), join(dir, 'node_modules/.bin/fallow'))
		writeFileSync(join(dir, 'api.js'), 'export const used = 1; export const inheritedUnused = 2;\n// touch inherited code\n')
		const inherited = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
		expect(inherited.exitCode).toBe(0)
		expect(inherited.stderr).toBe('')
		writeFileSync(join(dir, 'api.js'), 'export const used = 1; export const inheritedUnused = 2; export const newlyUnused = 3;\n')
		git(dir, 'add', 'api.js')
		git(dir, 'commit', '-q', '-m', 'introduced unused export')
		const introduced = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
		expect(introduced.exitCode).toBe(2)
		expect(introduced.stderr).toContain('newlyUnused')
		expect(introduced.stderr).not.toContain('[dead_code.unused_exports] inheritedUnused')
	}, 110_000)

	test('explicit FALLOW_AUDIT_BASE wins over an invalid declared base', async () => {
		const {dir, baseline, argsFile} = await branchRepo('https://github.com/example/proof-fixture.git')
		git(dir, 'config', 'workflow.baseBranch', 'does-not-exist')
		git(dir, 'update-ref', 'refs/remotes/upstream/release', baseline)
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, [], {FALLOW_AUDIT_BASE: 'upstream/release'})
		expect(run.exitCode).toBe(2)
		expect(readFileSync(argsFile, 'utf8').split('\n')).toContain(baseline)
	})

	test('remote default remains the base after the feature branch has been pushed', async () => {
		const {dir, baseline, argsFile} = await branchRepo('https://bitbucket.org/example/proof-fixture.git', 'develop')
		git(dir, 'config', '--unset', 'workflow.baseBranch')
		git(dir, 'update-ref', 'refs/remotes/origin/feature/ratchet', 'HEAD')
		git(dir, 'branch', '--set-upstream-to=origin/feature/ratchet')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
		expect(run.exitCode).toBe(2)
		expect(readFileSync(argsFile, 'utf8').split('\n')).toContain(baseline)
	})

	test('comparison uses the merge-base rather than the advanced integration tip', async () => {
		const {dir, baseline, argsFile} = await branchRepo('https://github.com/example/proof-fixture.git')
		git(dir, 'switch', '-q', 'staging')
		writeFileSync(join(dir, 'integration.md'), 'integration advanced independently\n')
		git(dir, 'add', 'integration.md')
		git(dir, 'commit', '-q', '-m', 'integration advanced')
		git(dir, 'update-ref', 'refs/remotes/origin/staging', 'HEAD')
		git(dir, 'switch', '-q', 'feature/ratchet')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
		expect(run.exitCode).toBe(2)
		expect(readFileSync(argsFile, 'utf8').split('\n')).toContain(baseline)
	})

	for (const mode of ['staged', 'unstaged', 'untracked', 'deleted']) {
		test(`a ${mode} source delta still reaches the branch audit`, async () => {
			const {dir, baseline, argsFile} = await branchRepo('https://github.com/example/proof-fixture.git')
			git(dir, 'switch', '-q', '-c', `delta/${mode}`, 'staging')
			if (mode === 'deleted') rmSync(join(dir, 'committed.ts'))
			else writeFileSync(join(dir, mode === 'untracked' ? 'pending.js' : 'committed.ts'), 'export const changed = 7\n')
			if (mode === 'staged') git(dir, 'add', 'committed.ts')
			const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
			expect(run.exitCode).toBe(2)
			expect(readFileSync(argsFile, 'utf8').split('\n')).toContain(baseline)
		})
	}

	test('a documentation-only branch delegates supported file scope to Fallow', async () => {
		const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
		git(dir, 'switch', '-q', '-c', 'docs-only', 'staging')
		writeFileSync(join(dir, 'notes.md'), 'documentation only\n')
		git(dir, 'add', 'notes.md')
		git(dir, 'commit', '-q', '-m', 'docs only')
		installFakeBinary(dir, 'fallow', `echo '{"verdict":"pass"}'; exit 0`)
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
		expect(wasInvoked(dir, 'fallow')).toBe(true)
	})

		test('a clean committed mts-only branch reaches the audit', async () => {
		const { dir, argsFile } = await branchRepo('https://github.com/example/proof-fixture.git')
		git(dir, 'switch', '-q', '-c', 'mts-only', 'staging')
		writeFileSync(join(dir, 'new-module.mts'), 'export const newlyUnused = 3\n')
		git(dir, 'add', 'new-module.mts')
		git(dir, 'commit', '-q', '-m', 'mts-only change')
		const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		expect(existsSync(argsFile)).toBe(true)
		expect(JSON.parse(run.stderr).scope).toBe('branch-delta')
	})

	test('initial history remains fail-open with an explicit unqualified diagnostic', async () => {
		const dir = await makeTempDir('proof-fallow-initial-')
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), '{}')
		writeFileSync(join(dir, 'pending.ts'), 'export const value = 1\n')
		installFakeBinary(dir, 'fallow', `echo '${failReport()}'\nexit 1`)
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		expect(JSON.parse(run.stderr).excerpt).toContain('No initial commit')
		expect(wasInvoked(dir, 'fallow')).toBe(false)
	})

	test('missing branch ownership audits dirty files but reports committed scope unqualified', async () => {
		const dir = await makeTempDir('proof-fallow-nobase-')
		await setupRepo(dir, {withFallow: true})
		git(dir, 'config', '--unset', 'workflow.baseBranch')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		expect(JSON.parse(run.stderr).reason).toBe('branch-base-unavailable')
		expect(wasInvoked(dir, 'fallow')).toBe(true)
	})

	for (const setting of ['declared', 'override']) {
		test(`an invalid ${setting} base never falls back to a nominal successful audit`, async () => {
			const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
			if (setting === 'declared') git(dir, 'config', 'workflow.baseBranch', 'missing-base')
			const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'], setting === 'override' ? {FALLOW_AUDIT_BASE: 'missing-base'} : {})
			expect(run.exitCode).toBe(0)
			expect(run.stdout).toBe('{}')
			expect(JSON.parse(run.stderr).reason).toBe('operational')
			expect(wasInvoked(dir, 'fallow')).toBe(false)
		})
	}

	test('an opaque driver is not inspected and Stop supplies the committed-branch backstop', async () => {
		const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
		const before = await runFallowHook({hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: {command: 'python3 commit-driver.py'}}, ['--harness=codex'])
		expect(before.exitCode).toBe(0)
		expect(wasInvoked(dir, 'fallow')).toBe(false)
		const stop = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(stop.exitCode).toBe(2)
		expect(wasInvoked(dir, 'fallow')).toBe(true)
	})

	for (const harness of ['claude', 'codex']) {
		test(`${harness} documented normalized Bash payload blocks an existing branch finding before commit`, async () => {
			const {dir, baseline, argsFile} = await branchRepo('https://bitbucket.org/example/proof-fixture.git')
			const run = await runFallowHook({hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_use_id: 'fixture-call', tool_input: {command: 'git commit -m next'}}, harness === 'codex' ? ['--harness=codex'] : [])
			expect(run.exitCode).toBe(2)
			expect(readFileSync(argsFile, 'utf8').split('\n')).toContain(baseline)
		})
	}

	for (const output of ['not json', 'null', '{"verdict":"unexpected"}']) {
		test(`successful runner exit with ${output} is explicitly unqualified`, async () => {
			const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
			installFakeBinary(dir, 'fallow', `printf '%s' '${output}'; exit 0`)
			const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
			expect(run.exitCode).toBe(0)
			expect(run.stdout).toBe('{}')
			expect(JSON.parse(run.stderr).reason).toBe('operational')
		})
	}

	test('a fail verdict cannot be hidden behind runner exit zero', async () => {
		const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
		installFakeBinary(dir, 'fallow', `echo '${failReport()}'; exit 0`)
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir})
		expect(run.exitCode).toBe(2)
		expect(JSON.parse(run.stderr).errorCount).toBe(1)
	})

	test('a runner that cannot start reports an operational skip', async () => {
		const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
		writeFileSync(join(dir, 'node_modules/.bin/fallow'), '#!/nonexistent/proof-fixture-interpreter\n')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		expect(JSON.parse(run.stderr).reason).toBe('operational')
	})


	test('an unrelated declared history is reported without invoking an audit', async () => {
		const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
		git(dir, 'switch', '-q', '--orphan', 'unrelated')
		writeFileSync(join(dir, 'other.md'), 'unrelated history\n')
		git(dir, 'add', 'other.md')
		git(dir, 'commit', '-q', '-m', 'unrelated root')
		git(dir, 'switch', '-q', 'feature/ratchet')
		git(dir, 'config', 'workflow.baseBranch', 'unrelated')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		expect(JSON.parse(run.stderr).excerpt).toContain('no common history')
		expect(wasInvoked(dir, 'fallow')).toBe(false)
	})

	for (const event of ['PreToolUse', 'Stop']) {
		test(`${event} retains its real fail-open timeout with explicit unqualified output`, async () => {
			const {dir} = await branchRepo('https://github.com/example/proof-fixture.git')
			const ms = event === 'Stop' ? 48_000 : 24_000
			const tree = processTreeFixture(await makeTempDir('proof-fallow-process-'), false, event === 'Stop')
			const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
			const command = tree.argv.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(' ')
			installFakeBinary(dir, 'fallow', `exec ${command}`)
			const started = Date.now()
			try {
				const run = await runFallowHook({hook_event_name: event, cwd: dir, tool_name: 'Bash', tool_input: {command: 'git commit -m next'}}, ['--harness=codex'])
				expect(tree.pids()).toHaveLength(3)
				expect(run.exitCode).toBe(0)
				expect(run.stdout).toBe(event === 'Stop' ? '{}' : '')
				expect(JSON.parse(run.stderr)).toEqual({ tool: 'fallow-ci', event, status: 'skipped', reason: 'timeout', excerpt: `Fallow did not finish within ${ms}ms; no audit verdict was qualified.` })
				expect(Date.now() - started).toBeGreaterThanOrEqual(ms - 1000)
				expect(Date.now() - started).toBeLessThan(ms + 4000)
				expect(tree.alive()).toEqual([])
				expect(sentinel.exitCode).toBeNull()
				expect(process.kill(sentinel.pid, 0)).toBe(true)
			} finally {
				tree.cleanup()
				sentinel.kill('SIGKILL')
				await sentinel.exited
			}
		}, 60_000)
	}


	test('an unqualified runner result and missing branch base emit one parseable diagnostic', async () => {
		const dir = await makeTempDir('proof-fallow-one-diagnostic-')
		await setupRepo(dir, {withFallow: true})
		git(dir, 'config', '--unset', 'workflow.baseBranch')
		installFakeBinary(dir, 'fallow', 'echo invalid-json; exit 0')
		const run = await runFallowHook({hook_event_name: 'Stop', cwd: dir}, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
		expect(JSON.parse(run.stderr).reason).toBe('operational')
	})

})

describe('fallow-ci persisted content guard', () => {
	async function snapshotRepo() {
		const dir = await makeTempDir('proof-fallow-snapshot-')
		initRepo(dir)
		writeFileSync(join(dir, '.fallowrc.json'), JSON.stringify({ entry: ['index.js'], health: { maxCrap: 0 }, rules: { 'unused-exports': 'error' } }))
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.fallow/\n')
		writeFileSync(join(dir, 'package.json'), '{"name":"proof-snapshot-fixture","private":true,"type":"module"}')
		writeFileSync(join(dir, 'index.js'), "import { used } from './api.js'; console.log(used)\n")
		writeFileSync(join(dir, 'api.js'), 'export const used = 1;\n')
		git(dir, 'add', '.fallowrc.json', '.gitignore', 'package.json', 'index.js', 'api.js')
		git(dir, 'commit', '-q', '-m', 'baseline')
		git(dir, 'branch', 'baseline')
		git(dir, 'config', 'workflow.baseBranch', 'baseline')
		mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
		symlinkSync(realpathSync(join(import.meta.dir, '../../../../../node_modules/.bin/fallow')), join(dir, 'node_modules/.bin/fallow'))
		return dir
	}

	function preCommand(dir: string, command: string) {
		return runFallowHook({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command } }, ['--harness=codex'])
	}

	for (const state of ['clean', 'finding', 'mismatch']) {
		test(`explicit absolute -C audits the target rather than the dirty session checkout: ${state}`, async () => {
			const session = await snapshotRepo()
			writeFileSync(join(session, 'unrelated-runtime.json'), '{}')
			const target = await snapshotRepo()
			if (state !== 'clean') {
				writeFileSync(join(target, 'api.js'), 'export const used = 1; export const newlyUnused = 2;\n')
				git(target, 'add', 'api.js')
				if (state === 'mismatch') writeFileSync(join(target, 'api.js'), 'export const used = 1;\n')
			}
			const run = await preCommand(session, `git -C "${target}" commit -m next`)
			expect(run.exitCode).toBe(state === 'clean' ? 0 : 2)
			if (state === 'finding') expect(run.stderr).toContain('newlyUnused')
			if (state === 'mismatch') expect(run.stderr).toContain('snapshot-mismatch')
			expect(run.stderr).not.toContain('unrelated-runtime.json')
		})
	}

	for (const state of ['runtime', 'committed-finding', 'dirty-finding', 'snapshot-changed']) {
		test(`Stop uses a clean HEAD worktree without concealing findings: ${state}`, async () => {
			const dir = await snapshotRepo()
			const cleanApi = 'export const used = 2;\n'
			const badApi = 'export const used = 2; export const newlyUnused = 3;\n'
			writeFileSync(join(dir, 'api.js'), state === 'committed-finding' ? badApi : cleanApi)
			git(dir, 'add', 'api.js')
			git(dir, 'commit', '-q', '-m', 'branch change')
			const snapshot = await makeTempDir('proof-clean-head-')
			git(dir, 'worktree', 'add', '--detach', snapshot, 'HEAD')
			mkdirSync(join(snapshot, 'node_modules/.bin'), { recursive: true })
			symlinkSync(realpathSync(join(dir, 'node_modules/.bin/fallow')), join(snapshot, 'node_modules/.bin/fallow'))
			writeFileSync(join(dir, 'runtime.json'), '{}')
			if (state === 'committed-finding') writeFileSync(join(dir, 'api.js'), cleanApi)
			if (state === 'dirty-finding') writeFileSync(join(dir, 'api.js'), badApi)
			if (state === 'snapshot-changed') {
				rmSync(join(snapshot, 'node_modules/.bin/fallow'))
				installFakeBinary(snapshot, 'fallow', `echo 'export const used = 4;' > api.js\necho '{"verdict":"pass"}'`)
			}
			const run = await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'])
			expect(run.exitCode).toBe(state === 'runtime' ? 0 : 2)
			if (state === 'runtime') {
				expect(run.stdout).toBe('{}')
				expect(run.stderr).toBe('')
			} else {
				expect(run.stderr).toContain(state === 'snapshot-changed' ? 'snapshot-changed' : 'newlyUnused')
			}
			expect(readFileSync(join(dir, 'runtime.json'), 'utf8')).toBe('{}')
		})
	}

	test('blocks a staged unused export hidden by a clean unstaged overwrite before literal commit', async () => {
		const dir = await snapshotRepo()
		writeFileSync(join(dir, 'api.js'), 'export const used = 1; export const newlyUnused = 2;\n')
		git(dir, 'add', 'api.js')
		writeFileSync(join(dir, 'api.js'), 'export const used = 1;\n')
		const run = await preCommand(dir, 'git commit -m next')
		expect(run.exitCode).toBe(2)
		expect(run.stderr).toContain('snapshot-mismatch')
		expect(run.stderr).toContain('api.js')
	})

	for (const event of ['PreToolUse', 'Stop']) {
		test(`${event} blocks committed debt hidden by an unstaged revert to the branch baseline`, async () => {
			const dir = await snapshotRepo()
			writeFileSync(join(dir, 'api.js'), 'export const used = 1; export const newlyUnused = 2;\n')
			git(dir, 'add', 'api.js')
			git(dir, 'commit', '-q', '-m', 'committed unused export')
			writeFileSync(join(dir, 'api.js'), 'export const used = 1;\n')
			const run = event === 'Stop' ? await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, ['--harness=codex']) : await preCommand(dir, 'git push')
			expect(run.exitCode).toBe(2)
			expect(run.stderr).toContain('snapshot-mismatch')
			expect(run.stderr).toContain('api.js')
		})
	}

	test('a leading-space literal commit reaches the real audit and blocks a new unused export', async () => {
		const dir = await snapshotRepo()
		writeFileSync(join(dir, 'api.js'), 'export const used = 1; export const newlyUnused = 2;\n')
		git(dir, 'add', 'api.js')
		const run = await preCommand(dir, '  git commit -m "next push change"')
		expect(run.exitCode).toBe(2)
		expect(run.stderr).toContain('newlyUnused')
	})

	for (const event of ['PreToolUse', 'Stop']) {
		test(`${event} cannot self-disable by deleting only the working marker`, async () => {
			const dir = await snapshotRepo()
			rmSync(join(dir, '.fallowrc.json'))
			const run = event === 'Stop' ? await runFallowHook({ hook_event_name: 'Stop', cwd: dir }, ['--harness=codex']) : await preCommand(dir, 'git commit -m next')
			expect(run.exitCode).toBe(2)
			expect(run.stderr).toContain('snapshot-mismatch')
			expect(run.stderr).toContain('.fallowrc.json')
		})
	}

	test('a marker present only in the staged index cannot self-disable commit checks', async () => {
		const dir = await snapshotRepo()
		git(dir, 'rm', '.fallowrc.json')
		git(dir, 'commit', '-q', '-m', 'remove marker baseline')
		writeFileSync(join(dir, '.fallowrc.json'), '{}')
		git(dir, 'add', '.fallowrc.json')
		rmSync(join(dir, '.fallowrc.json'))
		const run = await preCommand(dir, 'git commit -m next')
		expect(run.exitCode).toBe(2)
		expect(run.stderr).toContain('snapshot-mismatch')
	})

	for (const [key, value] of [['push.default', 'matching'], ['remote.origin.push', 'other-branch:other-branch'], ['remote.origin.mirror', 'true']]) {
		test(`blocks implicit multi-ref selection from ${key}`, async () => {
			const dir = await snapshotRepo()
			git(dir, 'config', key ?? '', value ?? '')
			const run = await preCommand(dir, 'git push')
			expect(run.exitCode).toBe(2)
			expect(run.stderr).toContain('unsupported-command')
		})
	}

	for (const file of ['module.mts', 'module.cts', 'Component.vue', 'Component.svelte', 'page.mdx', 'fallow.toml', 'pnpm-lock.yaml', 'notes.md']) {
		test(`blocks an index/worktree mismatch in ${file}`, async () => {
			const dir = await snapshotRepo()
			writeFileSync(join(dir, file), 'staged content\n')
			git(dir, 'add', file)
			writeFileSync(join(dir, file), 'different unstaged content\n')
			const run = await preCommand(dir, 'git commit -m "fix push"')
			expect(run.exitCode).toBe(2)
			expect(run.stderr).toContain('snapshot-mismatch')
			expect(JSON.parse(run.stderr).scope).toBe('commit')
			expect(run.stderr).toContain(file)
		})
	}

	for (const command of ["git 'commit' -m next", "'git' push", 'git "push"']) {
		test(`quoted publication tokens still activate the content guard: ${command}`, async () => {
			const dir = await snapshotRepo()
			writeFileSync(join(dir, 'api.js'), 'dirty working content\n')
			const run = await preCommand(dir, command)
			expect(run.exitCode).toBe(2)
			expect(run.stderr).toContain('snapshot-mismatch')
		})
	}

	async function literalWordRepo() {
		const dir = await snapshotRepo()
		rmSync(join(dir, 'node_modules/.bin/fallow'))
		installFakeBinary(dir, 'fallow', `echo '{"verdict":"pass"}'`)
		return dir
	}

	for (const harness of ['claude', 'codex']) {
		for (const [command, configured] of [['git push origin"HEAD"', true], ['git push "origin"HEAD', true], ['git push # HEAD', true], ['git push origin\nHEAD', true], ['git push *', false], ['git push ?', false], ['git push [ab]', false], ['git push ~', false]] as const) {
			test(`literal shell words reject unaudited push selection (${harness}): ${command}`, async () => {
				const dir = await literalWordRepo()
				if (configured) {
					git(dir, 'config', 'remote.origin.push', 'other-branch:other-branch')
					git(dir, 'config', 'remote.originHEAD.push', 'other-branch:other-branch')
				}
				const run = await runFallowHook({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command } }, harness === 'codex' ? ['--harness=codex'] : [])
				expect(run.exitCode).toBe(2)
				expect(run.stdout).toBe('')
				expect(JSON.parse(run.stderr).reason).toBe('unsupported-command')
				expect(wasInvoked(dir, 'fallow')).toBe(false)
			})
		}

		for (const command of ['git commit --message="two words"', 'git commit --message=two" words"', 'git commit --message="literal # * ? [x] ~"', 'git push origin H"E"AD']) {
			test(`literal shell words preserve quoted publication arguments (${harness}): ${command}`, async () => {
				const dir = await literalWordRepo()
				git(dir, 'config', 'remote.origin.push', 'other-branch:other-branch')
				const run = await runFallowHook({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command } }, harness === 'codex' ? ['--harness=codex'] : [])
				expect(run.exitCode).toBe(0)
				expect(run.stdout).toBe('')
				expect(run.stderr).toBe('')
				expect(wasInvoked(dir, 'fallow')).toBe(true)
			})
		}
	}

	describe('base-independent publication guards', () => {
		for (const harness of ['claude', 'codex']) {
			for (const command of ['GIT_AUTHOR_NAME=x git commit -m next', 'A="two words" B=x git push origin HEAD', 'A=x git -C . commit -m next']) {
				test(`review guards reject assignment-prefixed publication (${harness}): ${command}`, async () => {
					const dir = await literalWordRepo()
					const run = await runFallowHook({hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: {command}}, harness === 'codex' ? ['--harness=codex'] : [])
					expect(run.exitCode).toBe(2)
					expect(run.stdout).toBe('')
					expect(JSON.parse(run.stderr).reason).toBe('unsupported-command')
					expect(wasInvoked(dir, 'fallow')).toBe(false)
				})
			}
			for (const action of ['commit', 'push']) {
				for (const setting of ['declared', 'override']) {
					test(`review guards reject candidate mismatch before invalid ${setting} base (${harness}/${action})`, async () => {
						const dir = await literalWordRepo()
						git(dir, 'config', 'workflow.baseBranch', 'missing-base')
						writeFileSync(join(dir, 'api.js'), 'dirty content\n')
						const command = action === 'commit' ? 'git commit -m next' : 'git push origin HEAD'
						const run = await runFallowHook({hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: {command}}, harness === 'codex' ? ['--harness=codex'] : [], setting === 'override' ? {FALLOW_AUDIT_BASE:'missing-override'} : {})
						expect(run.exitCode).toBe(2)
						expect(run.stdout).toBe('')
						expect(JSON.parse(run.stderr).reason).toBe('snapshot-mismatch')
						expect(run.stderr).toContain('api.js')
						expect(wasInvoked(dir, 'fallow')).toBe(false)
					})
				}
			}
			test(`review guards reject unsupported commands before an invalid base (${harness})`, async () => {
				const dir = await literalWordRepo()
				git(dir, 'config', 'workflow.baseBranch', 'missing-base')
				const run = await runFallowHook({hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: {command:'git commit -am next'}}, harness === 'codex' ? ['--harness=codex'] : [])
				expect(run.exitCode).toBe(2)
				expect(JSON.parse(run.stderr).reason).toBe('unsupported-command')
				expect(wasInvoked(dir, 'fallow')).toBe(false)
			})
			test(`review guards reject a missing working marker before an invalid Stop base (${harness})`, async () => {
				const dir = await literalWordRepo()
				git(dir, 'config', 'workflow.baseBranch', 'missing-base')
				rmSync(join(dir, '.fallowrc.json'))
				const run = await runFallowHook({hook_event_name:'Stop',cwd:dir}, harness === 'codex' ? ['--harness=codex'] : [])
				expect(run.exitCode).toBe(2)
				expect(JSON.parse(run.stderr).reason).toBe('snapshot-mismatch')
				expect(run.stderr).toContain('.fallowrc.json')
				expect(wasInvoked(dir, 'fallow')).toBe(false)
			})
			for (const event of ['PreToolUse', 'Stop']) {
				test(`review guards retain no-runner skip before invalid base (${harness}/${event})`, async () => {
					const dir = await literalWordRepo()
					git(dir, 'config', 'workflow.baseBranch', 'missing-base')
					rmSync(join(dir, 'node_modules/.bin/fallow'))
					const run = await runFallowHook({hook_event_name:event,cwd:dir,tool_name:'Bash',tool_input:{command:'git commit -am next'}}, harness === 'codex' ? ['--harness=codex'] : [])
					expect(run.exitCode).toBe(0)
					expect(run.stdout).toBe(event === 'Stop' && harness === 'codex' ? '{}' : '')
					expect(JSON.parse(run.stderr).reason).toBe('no-runner')
				})
			}
		}
	})

	for (const command of ['git log --grep=commit', 'git show HEAD:docs/push.md', 'git --no-pager log --grep=push', 'git -C . log --grep=commit', 'git log --grep=commit && git show HEAD:docs/push.md', "echo 'git commit'; git log --grep=push"]) {
		test(`read-only publication words do not activate the gate: ${command}`, async () => {
			const dir = await snapshotRepo()
			writeFileSync(join(dir, 'api.js'), 'dirty working content\n')
			const run = await preCommand(dir, command)
			expect(run.exitCode).toBe(0)
			expect(run.stdout).toBe('')
			expect(run.stderr).toBe('')
		})
	}

	for (const command of ['git commit -am next', 'git commit --only api.js -m next', 'git add api.js && git commit -m next', 'git commit -m next; git push', 'git push --all', 'git push origin other-branch', 'git -C . commit -m next', 'git --no-pager push', 'git -C"some path" commit -m next', 'git -cfoo="two words" commit -m next', 'git -Csome\\ path commit -m next', 'git log --grep=commit && git commit -am next']) {
		test(`blocks unaudited publication content selected by ${command}`, async () => {
			const dir = await snapshotRepo()
			const run = await preCommand(dir, command)
			expect(run.exitCode).toBe(2)
			expect(run.stderr).toContain('unsupported-command')
		})
	}
})
