import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
	cleanupTempDirs,
	git,
	initRepo,
	installFakeBinary,
	makeTempDir,
	runHook,
	wasInvoked,
} from './test-support.ts'

const HOOK_PATH = join(import.meta.dir, 'fallow-ci.ts')

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
	writeFileSync(join(dir, 'dirty.ts'), 'export const b = 1\n')
}

describe('fallow-ci Stop', () => {
	test('exits 0 when stop_hook_active is true', async () => {
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', stop_hook_active: true })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 silently when the repository has no local Fallow', async () => {
		const dir = await makeTempDir('proof-fallow-nofallow-')
		await setupRepo(dir)
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
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

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(wasInvoked(dir, 'fallow')).toBe(false)
	})

	test('exits 2 with an envelope when the verdict is fail', async () => {
		const dir = await makeTempDir('proof-fallow-fail-')
		await setupRepo(dir, { withFallow: true, exitCode: 1 })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as FallowEnvelope
		expect(envelope.tool).toBe('fallow-ci')
		expect(envelope.event).toBe('Stop')
		expect(envelope.status).toBe('error')
		expect(envelope.scope).toBe('changed-files')
		expect(envelope.fileCount).toBe(2)
		expect(envelope.errorCount).toBe(1)
		expect(envelope.errors[0]?.message).toBe('[dead_code.unused_exports] oldApi')
	})

	test('passes when the verdict is warn', async () => {
		const dir = await makeTempDir('proof-fallow-warn-')
		await setupRepo(dir, { withFallow: true, exitCode: 0 })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('skips with status:skipped on an operational error', async () => {
		const dir = await makeTempDir('proof-fallow-error-')
		await setupRepo(dir, { withFallow: true, exitCode: 2 })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		const envelope = JSON.parse(run.stderr) as SkippedEnvelope
		expect(envelope.tool).toBe('fallow-ci')
		expect(envelope.status).toBe('skipped')
		expect(envelope.reason).toBe('operational')
	})

	test('writes {} to stdout on a codex-harness pass', async () => {
		const dir = await makeTempDir('proof-fallow-codex-')
		await setupRepo(dir, { withFallow: true, exitCode: 0 })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'])
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('{}')
	})

	test('exits 0 for an event it does not own', async () => {
		const run = await runHook(HOOK_PATH, { hook_event_name: 'SomeOtherEvent' })
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
	}

	test('blocks a git commit when the verdict is fail', async () => {
		const dir = await makeTempDir('proof-fallow-pre-commit-')
		const argsFile = join(dir, '.fallow-args')
		await setupCommitRepo(dir, argsFile, failReport(), 1)

		const run = await runHook(HOOK_PATH, {
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
		expect(args).toContain('--changed-since')
		expect(args).toContain('--gate new-only')
	})

	test('a git push carries no --changed-since flag but still forces --gate new-only', async () => {
		const dir = await makeTempDir('proof-fallow-pre-push-')
		const argsFile = join(dir, '.fallow-args')
		await setupCommitRepo(dir, argsFile, '{"verdict":"pass"}', 0)

		const run = await runHook(HOOK_PATH, {
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

		const run = await runHook(HOOK_PATH, {
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

		const run = await runHook(HOOK_PATH, {
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
		writeFileSync(join(dir, 'dirty.ts'), 'export const b = 1\n')
	}

	const pinnedServer = { command: 'pnpm', args: ['dlx', '--package', 'fallow@9.9.9', 'fallow-mcp'] }

	test('audits through the pinned .mcp.json launcher and blocks a fail verdict', async () => {
		const dir = await makeTempDir('proof-fallow-pinned-fail-')
		const argsFile = join(dir, '.launcher-args')
		await setupPinnedRepo(dir, pinnedServer)
		const binDir = await installFakeLauncher(argsFile, `echo '${failReport()}'\nexit 1`)

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir }, [], {
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
		})
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as FallowEnvelope
		expect(envelope.event).toBe('Stop')
		expect(envelope.errors[0]?.message).toBe('[dead_code.unused_exports] oldApi')
		const args = readFileSync(argsFile, 'utf8')
		expect(args.startsWith('dlx --package fallow@9.9.9 fallow audit ')).toBe(true)
		expect(args).toContain('--gate new-only')
		expect(args).toContain('--changed-since HEAD')
	})

	test('passes a clean pinned audit with no stderr', async () => {
		const dir = await makeTempDir('proof-fallow-pinned-pass-')
		const argsFile = join(dir, '.launcher-args')
		await setupPinnedRepo(dir, pinnedServer)
		const binDir = await installFakeLauncher(argsFile, `echo '{"verdict":"pass"}'\nexit 0`)

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'], {
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

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir }, [], {
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

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir }, ['--harness=codex'])
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

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir }, [], {
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
		})
		expect(run.exitCode).toBe(0)
		expect((JSON.parse(run.stderr) as SkippedEnvelope).reason).toBe('no-runner')
		expect(existsSync(argsFile)).toBe(false)
	})
})
