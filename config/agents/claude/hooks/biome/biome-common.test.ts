import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
	changedBiomeFiles,
	resolveRepoBiome,
	resolveRepoRoot,
	summariseFailure,
} from './biome-common.ts'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	tempDirs.push(dir)
	return dir
}

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
	})
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr.toString()}`,
		)
	}
}

function initRepo(dir: string): void {
	git(dir, 'init', '-q')
	git(dir, 'config', 'user.name', 'Biome Test')
	git(dir, 'config', 'user.email', 'biome-test@example.invalid')
	git(dir, 'config', 'commit.gpgsign', 'false')
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('resolveRepoRoot', () => {
	test('returns the toplevel for a git repository', async () => {
		const dir = await makeTempDir('biome-common-root-')
		initRepo(dir)
		mkdirSync(join(dir, 'nested'))
		expect(await resolveRepoRoot(join(dir, 'nested'))).toBe(
			await realpath(dir),
		)
	})

	test('returns null outside any repository', async () => {
		const dir = await makeTempDir('biome-common-noroot-')
		expect(await resolveRepoRoot(dir)).toBeNull()
	})
})

describe('changedBiomeFiles', () => {
	test('returns staged, unstaged, and untracked Biome files that exist', async () => {
		const dir = await makeTempDir('biome-common-changed-')
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
		writeFileSync(join(dir, 'notes.md'), '# not a biome file\n')
		rmSync(join(dir, 'deleted.ts'))

		const files = await changedBiomeFiles(dir)
		expect(files.sort()).toEqual(
			[
				join(dir, 'staged.ts'),
				join(dir, 'modified.ts'),
				join(dir, 'untracked.ts'),
			].sort(),
		)
	})
})

describe('resolveRepoBiome', () => {
	test('returns null when the binary is missing even with biome.json', async () => {
		const dir = await makeTempDir('biome-common-nobin-')
		writeFileSync(join(dir, 'biome.json'), '{}\n')
		expect(resolveRepoBiome(dir)).toBeNull()
	})

	test('returns null when the binary exists but no config', async () => {
		const dir = await makeTempDir('biome-common-noconfig-')
		const bin = join(dir, 'node_modules', '.bin', 'biome')
		mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
		writeFileSync(bin, '#!/bin/sh\nexit 0\n')
		chmodSync(bin, 0o755)
		expect(resolveRepoBiome(dir)).toBeNull()
	})

	test('returns the binary path when both binary and config exist', async () => {
		const dir = await makeTempDir('biome-common-both-')
		const bin = join(dir, 'node_modules', '.bin', 'biome')
		mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
		writeFileSync(bin, '#!/bin/sh\nexit 0\n')
		chmodSync(bin, 0o755)
		writeFileSync(join(dir, 'biome.jsonc'), '{}\n')
		expect(resolveRepoBiome(dir)).toBe(bin)
	})
})

describe('summariseFailure', () => {
	test('returns a raw-excerpt entry when exit is non-zero and no diagnostics parsed', () => {
		const summary = summariseFailure(
			{ exitCode: 1, stdout: '', stderr: '  internal error: boom  ' },
			[],
		)
		expect(summary).toEqual({
			errorCount: 1,
			errors: [{ file: '<biome>', line: 0, message: 'internal error: boom' }],
		})
	})

	test('falls back to stdout and caps the excerpt at 500 characters', () => {
		const summary = summariseFailure(
			{ exitCode: 1, stdout: 'x'.repeat(600), stderr: '' },
			[],
		)
		expect(summary.errors[0]?.message).toHaveLength(500)
	})

	test('returns the parsed entries otherwise', () => {
		const summary = summariseFailure(
			{ exitCode: 1, stdout: '{}', stderr: '' },
			[
				{ file: 'a.ts', line: 3, message: 'unused', code: 'lint/x' },
				{ file: 'b.ts', line: 9, message: 'bad', code: 'lint/y' },
			],
		)
		expect(summary).toEqual({
			errorCount: 2,
			errors: [
				{ file: 'a.ts', line: 3, message: '[lint/x] unused' },
				{ file: 'b.ts', line: 9, message: '[lint/y] bad' },
			],
		})
	})

	test('caps reported errors at 30 while keeping the full count', () => {
		const diagnostics = Array.from({ length: 35 }, (_, index) => ({
			file: `f${index}.ts`,
			line: index,
			message: 'm',
			code: 'c',
		}))
		const summary = summariseFailure(
			{ exitCode: 1, stdout: '', stderr: '' },
			diagnostics,
		)
		expect(summary.errorCount).toBe(35)
		expect(summary.errors).toHaveLength(30)
	})
})
