import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

const HOOK_PATH = join(import.meta.dir, 'biome-ci.ts')
const tempDirs: string[] = []

interface HookRun {
	exitCode: number
	stdout: string
	stderr: string
}

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

/**
 * Creates a repo with one committed `.ts` file and one untracked `dirty.ts`.
 * When `fakeBiomeExitCode` is given, `biome.json` and `.gitignore` are
 * committed too (so only `dirty.ts` is a changed Biome file) and an executable
 * `node_modules/.bin/biome` sh script exiting with that code is installed.
 */
function initDirtyRepo(dir: string, fakeBiomeExitCode?: number): void {
	git(dir, 'init', '-q')
	git(dir, 'config', 'user.name', 'Biome Test')
	git(dir, 'config', 'user.email', 'biome-test@example.invalid')
	git(dir, 'config', 'commit.gpgsign', 'false')
	writeFileSync(join(dir, 'committed.ts'), 'export const a = 1\n')
	if (fakeBiomeExitCode !== undefined) {
		writeFileSync(join(dir, 'biome.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
		const bin = join(dir, 'node_modules', '.bin', 'biome')
		writeFileSync(bin, `#!/bin/sh\nexit ${fakeBiomeExitCode}\n`)
		chmodSync(bin, 0o755)
	}
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'init')
	writeFileSync(join(dir, 'dirty.ts'), 'export const b = 1\n')
}

async function runHook(input: unknown): Promise<HookRun> {
	const proc = Bun.spawn([process.execPath, 'run', HOOK_PATH], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	proc.stdin.write(JSON.stringify(input))
	proc.stdin.end()
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('biome-ci stop hook', () => {
	test('exits 0 when stop_hook_active is true', async () => {
		const run = await runHook({ stop_hook_active: true })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 silently when the repository has no local Biome', async () => {
		const dir = await makeTempDir('biome-ci-nobiome-')
		initDirtyRepo(dir)
		const run = await runHook({ cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 2 with a changed-files summary when Biome exits non-zero', async () => {
		const dir = await makeTempDir('biome-ci-fail-')
		initDirtyRepo(dir, 1)
		const run = await runHook({ cwd: dir })
		expect(run.exitCode).toBe(2)
		const report = JSON.parse(run.stderr) as {
			tool: string
			status: string
			scope: string
			fileCount: number
			errorCount: number
			errors: Array<{ file: string; line: number; message: string }>
		}
		expect(report.tool).toBe('biome-ci')
		expect(report.status).toBe('error')
		expect(report.scope).toBe('changed-files')
		expect(report.fileCount).toBe(1)
		expect(report.errorCount).toBe(1)
		expect(report.errors[0]?.file).toBe('<biome>')
	})

	test('exits 0 when Biome exits zero', async () => {
		const dir = await makeTempDir('biome-ci-pass-')
		initDirtyRepo(dir, 0)
		const run = await runHook({ cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})
})
