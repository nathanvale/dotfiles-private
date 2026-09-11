import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
	changedFiles,
	parseHarness,
	resolveCwd,
	resolveRepoRoot,
	resolveRepoTool,
	summariseFailure,
} from './common.ts'
import { cleanupTempDirs, git, initRepo, makeTempDir } from './test-support.ts'

afterAll(() => {
	cleanupTempDirs()
})

describe('parseHarness', () => {
	test('defaults to claude', () => {
		expect(parseHarness([])).toBe('claude')
		expect(parseHarness(['--some-other-flag'])).toBe('claude')
	})

	test('detects codex from --harness=codex', () => {
		expect(parseHarness(['--harness=codex'])).toBe('codex')
	})
})

describe('resolveCwd', () => {
	test('uses input.cwd when it is a non-empty string', () => {
		expect(resolveCwd({ cwd: '/tmp/example' })).toBe('/tmp/example')
	})

	test('falls back to process.cwd() when cwd is missing or blank', () => {
		expect(resolveCwd({})).toBe(process.cwd())
		expect(resolveCwd({ cwd: '   ' })).toBe(process.cwd())
	})
})

describe('resolveRepoRoot', () => {
	test('returns the toplevel for a git repository', async () => {
		const dir = await makeTempDir('proof-common-root-')
		initRepo(dir)
		mkdirSync(join(dir, 'nested'))
		expect(await resolveRepoRoot(join(dir, 'nested'))).toBe(await realpath(dir))
	})

	test('returns null outside any repository', async () => {
		const dir = await makeTempDir('proof-common-noroot-')
		expect(await resolveRepoRoot(dir)).toBeNull()
	})
})

describe('resolveRepoTool', () => {
	test('returns null when the binary is missing even with a marker file', async () => {
		const dir = await makeTempDir('proof-common-nobin-')
		writeFileSync(join(dir, 'tool.marker'), '{}\n')
		expect(resolveRepoTool(dir, 'tool', ['tool.marker'])).toBeNull()
	})

	test('returns null when the binary exists but no marker is present', async () => {
		const dir = await makeTempDir('proof-common-nomarker-')
		const bin = join(dir, 'node_modules', '.bin', 'tool')
		mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
		writeFileSync(bin, '#!/bin/sh\nexit 0\n')
		chmodSync(bin, 0o755)
		expect(resolveRepoTool(dir, 'tool', ['tool.marker'])).toBeNull()
	})

	test('returns the binary path when both the binary and a marker exist', async () => {
		const dir = await makeTempDir('proof-common-both-')
		const bin = join(dir, 'node_modules', '.bin', 'tool')
		mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
		writeFileSync(bin, '#!/bin/sh\nexit 0\n')
		chmodSync(bin, 0o755)
		writeFileSync(join(dir, 'tool.marker'), '{}\n')
		expect(resolveRepoTool(dir, 'tool', ['tool.marker'])).toBe(bin)
	})
})

describe('changedFiles', () => {
	test('returns staged, unstaged, and untracked matching files that still exist', async () => {
		const dir = await makeTempDir('proof-common-changed-')
		initRepo(dir)

		writeFileSync(join(dir, 'committed.ts'), 'export const a = 1\n')
		writeFileSync(join(dir, 'modified.ts'), 'export const b = 1\n')
		writeFileSync(join(dir, 'deleted.ts'), 'export const c = 1\n')
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')

		writeFileSync(join(dir, 'staged.ts'), 'export const d = 1\n')
		git(dir, 'add', 'staged.ts')
		writeFileSync(join(dir, 'modified.ts'), 'export const b = 2\n')
		writeFileSync(join(dir, 'untracked.ts'), 'export const e = 1\n')
		writeFileSync(join(dir, 'notes.md'), '# not a matching extension\n')
		rmSync(join(dir, 'deleted.ts'))

		const files = await changedFiles(dir, ['.ts'])
		expect(files.sort()).toEqual(
			[join(dir, 'staged.ts'), join(dir, 'modified.ts'), join(dir, 'untracked.ts')].sort(),
		)
	})
})

describe('summariseFailure', () => {
	test('returns a raw-excerpt entry when exit is non-zero and no entries parsed', () => {
		const summary = summariseFailure({ exitCode: 1, stdout: '', stderr: '  internal error: boom  ' }, [], '<tool>')
		expect(summary).toEqual({
			errorCount: 1,
			errors: [{ file: '<tool>', line: 0, message: 'internal error: boom' }],
		})
	})

	test('falls back to stdout and caps the excerpt at 500 characters', () => {
		const summary = summariseFailure({ exitCode: 1, stdout: 'x'.repeat(600), stderr: '' }, [], '<tool>')
		expect(summary.errors[0]?.message).toHaveLength(500)
	})

	test('returns the parsed entries when present', () => {
		const summary = summariseFailure({ exitCode: 1, stdout: '{}', stderr: '' }, [
			{ file: 'a.ts', line: 3, message: '[lint/x] unused' },
			{ file: 'b.ts', line: 9, message: '[lint/y] bad' },
		], '<tool>')
		expect(summary).toEqual({
			errorCount: 2,
			errors: [
				{ file: 'a.ts', line: 3, message: '[lint/x] unused' },
				{ file: 'b.ts', line: 9, message: '[lint/y] bad' },
			],
		})
	})

	test('caps reported entries at 30 while keeping the true count', () => {
		const entries = Array.from({ length: 35 }, (_, index) => ({
			file: `f${index}.ts`,
			line: index,
			message: 'm',
		}))
		const summary = summariseFailure({ exitCode: 1, stdout: '', stderr: '' }, entries, '<tool>')
		expect(summary.errorCount).toBe(35)
		expect(summary.errors).toHaveLength(30)
	})
})

describe('dependency-free constraint', () => {
	test('the plugin package.json declares no dependencies', () => {
		const manifestPath = join(import.meta.dir, '..', 'package.json')
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
		expect(manifest.dependencies).toBeUndefined()
	})
})
