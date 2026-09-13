import { readFileSync, writeFileSync } from 'node:fs'
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

const HOOK_PATH = join(import.meta.dir, 'biome-ci.ts')

// Independent oracle: these are the module suffixes the public hook contract
// promises to pass through to Biome.
const MODULE_EXTENSIONS = ['mjs', 'cjs', 'mts', 'cts'] as const

afterAll(() => {
	cleanupTempDirs()
})

function fakeReport(): string {
	return JSON.stringify({
		diagnostics: [
			{
				severity: 'error',
				description: 'boom',
				category: 'lint/x',
				location: { path: 'dirty.ts', start: { line: 1 } },
			},
		],
	})
}

async function setupRepo(
	dir: string,
	options: { withBiome?: boolean; exitCode?: number; dirtyFile?: string; recordArgs?: boolean } = {},
): Promise<void> {
	initRepo(dir)
	writeFileSync(join(dir, 'committed.ts'), 'export const a = 1\n')
	if (options.withBiome) {
		writeFileSync(join(dir, 'biome.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		const recordArgs = options.recordArgs ? `printf '%s\\n' "$@" > "$PWD/biome-argv"\n` : ''
		installFakeBinary(dir, 'biome', `${recordArgs}echo '${fakeReport()}'\nexit ${options.exitCode ?? 0}`)
	}
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'init')
	writeFileSync(join(dir, options.dirtyFile ?? 'dirty.ts'), 'export const b = 1\n')
}

interface BiomeEnvelope {
	tool: string
	event: string
	status: string
	scope: string
	fileCount: number
	errorCount: number
	errors: { file: string; line: number; message: string }[]
}

function recordedBiomeArgs(dir: string): string[] {
	return readFileSync(join(dir, 'biome-argv'), 'utf8').trim().split('\n')
}

async function assertModuleExtensions(
	event: 'Stop' | 'PostToolUse',
	harnessArgs: string[],
	harness: 'claude' | 'codex',
): Promise<void> {
	for (const extension of MODULE_EXTENSIONS) {
		const dir = await makeTempDir(`proof-biome-${event.toLowerCase()}-${harness}-${extension}-`)
		await setupRepo(dir, { withBiome: true, exitCode: 1, dirtyFile: `dirty.${extension}`, recordArgs: true })
		const editedFile = join(dir, `dirty.${extension}`)
		const input =
			event === 'Stop'
				? { hook_event_name: event, cwd: dir }
				: { hook_event_name: event, cwd: dir, tool_input: { file_path: editedFile } }
		const run = await runHook(HOOK_PATH, input, harnessArgs)

		expect(run.exitCode).toBe(event === 'Stop' ? 2 : 0)
		expect(wasInvoked(dir, 'biome')).toBe(true)
		expect(recordedBiomeArgs(dir)).toContain(editedFile)

		if (event === 'Stop') {
			const envelope = JSON.parse(run.stderr) as BiomeEnvelope
			expect(envelope.event).toBe('Stop')
			expect(envelope.fileCount).toBe(1)
			expect(envelope.errorCount).toBe(1)
		} else if (harness === 'codex') {
			const payload = JSON.parse(run.stdout) as Record<string, unknown>
			expect(Object.keys(payload)).toEqual(['hookSpecificOutput'])
		} else {
			const payload = JSON.parse(run.stdout) as {
				decision: string
				hookSpecificOutput: { hookEventName: string }
			}
			expect(payload.decision).toBe('block')
			expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse')
		}
	}
}

describe('biome-ci Stop', () => {
	test('exits 0 when stop_hook_active is true', async () => {
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', stop_hook_active: true })
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('')
		expect(run.stderr).toBe('')
	})

	test('exits 0 silently when the repository has no local Biome', async () => {
		const dir = await makeTempDir('proof-biome-nobiome-')
		await setupRepo(dir)
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 without invoking Biome when the changed-file delta is empty', async () => {
		const dir = await makeTempDir('proof-biome-empty-')
		initRepo(dir)
		writeFileSync(join(dir, 'biome.json'), '{}\n')
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		installFakeBinary(dir, 'biome', 'exit 1')
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')

		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(wasInvoked(dir, 'biome')).toBe(false)
	})

	test('exits 2 with an envelope when Biome reports an error', async () => {
		const dir = await makeTempDir('proof-biome-fail-')
		await setupRepo(dir, { withBiome: true, exitCode: 1 })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as BiomeEnvelope
		expect(envelope.tool).toBe('biome-ci')
		expect(envelope.event).toBe('Stop')
		expect(envelope.status).toBe('error')
		expect(envelope.scope).toBe('changed-files')
		expect(envelope.fileCount).toBe(1)
		expect(envelope.errorCount).toBe(1)
		expect(envelope.errors[0]?.message).toBe('[lint/x] boom')
	})

	test('exits 0 when Biome reports no errors', async () => {
		const dir = await makeTempDir('proof-biome-pass-')
		await setupRepo(dir, { withBiome: true, exitCode: 0 })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('writes {} to stdout on a codex-harness pass', async () => {
		const dir = await makeTempDir('proof-biome-codex-')
		await setupRepo(dir)
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

describe('biome-ci PostToolUse', () => {
	test('exits 0 without invoking Biome when no edited file is reported', async () => {
		const run = await runHook(HOOK_PATH, { hook_event_name: 'PostToolUse', tool_input: {} })
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('')
	})

	test('writes a block decision to stdout and exits 0 when Biome reports an error', async () => {
		const dir = await makeTempDir('proof-biome-post-fail-')
		await setupRepo(dir, { withBiome: true, exitCode: 1 })
		const editedFile = join(dir, 'dirty.ts')
		const run = await runHook(HOOK_PATH, {
			hook_event_name: 'PostToolUse',
			tool_input: { file_path: editedFile },
		})
		expect(run.exitCode).toBe(0)
		const payload = JSON.parse(run.stdout) as {
			decision: string
			reason: string
			hookSpecificOutput: { hookEventName: string; additionalContext: string }
		}
		expect(payload.decision).toBe('block')
		expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse')
		expect(payload.hookSpecificOutput.additionalContext).toContain('boom')
	})

	test('emits a minimal envelope under the codex harness', async () => {
		const dir = await makeTempDir('proof-biome-post-codex-')
		await setupRepo(dir, { withBiome: true, exitCode: 1 })
		const editedFile = join(dir, 'dirty.ts')
		const run = await runHook(
			HOOK_PATH,
			{ hook_event_name: 'PostToolUse', tool_input: { file_path: editedFile } },
			['--harness=codex'],
		)
		expect(run.exitCode).toBe(0)
		const payload = JSON.parse(run.stdout) as Record<string, unknown>
		expect(Object.keys(payload)).toEqual(['hookSpecificOutput'])
	})

	test('exits 0 when Biome reports no errors', async () => {
		const dir = await makeTempDir('proof-biome-post-pass-')
		await setupRepo(dir, { withBiome: true, exitCode: 0 })
		const editedFile = join(dir, 'dirty.ts')
		const run = await runHook(HOOK_PATH, {
			hook_event_name: 'PostToolUse',
			tool_input: { file_path: editedFile },
		})
		expect(run.exitCode).toBe(0)
		expect(run.stdout).toBe('')
	})
})

describe('biome-ci module extensions', () => {
	test('Stop passes all module extensions to Biome for Claude', async () => {
		await assertModuleExtensions('Stop', [], 'claude')
	})

	test('Stop passes all module extensions to Biome for Codex', async () => {
		await assertModuleExtensions('Stop', ['--harness=codex'], 'codex')
	})

	test('PostToolUse reports all module extensions through the Claude envelope', async () => {
		await assertModuleExtensions('PostToolUse', [], 'claude')
	})

	test('PostToolUse reports all module extensions through the Codex envelope', async () => {
		await assertModuleExtensions('PostToolUse', ['--harness=codex'], 'codex')
	})
})
