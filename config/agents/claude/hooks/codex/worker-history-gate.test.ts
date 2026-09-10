import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

interface HookResult {
	exitCode: number
	stdout: string
	stderr: string
}

const launcher = join(import.meta.dir, 'worker-history-gate.sh')
const repair = 'Retry the spawn_agent call with fork_turns: none.'

function runHook(input: string, path = dirname(process.execPath)): HookResult {
	const process = Bun.spawnSync(['/bin/sh', launcher], {
		env: { PATH: path },
		stdin: new TextEncoder().encode(input),
		stdout: 'pipe',
		stderr: 'pipe',
	})

	return {
		exitCode: process.exitCode,
		stdout: new TextDecoder().decode(process.stdout),
		stderr: new TextDecoder().decode(process.stderr),
	}
}

function spawnInput(
	forkTurns: unknown,
	includeForkTurns = true,
	toolName = 'spawn_agent',
): string {
	return JSON.stringify({
		tool_name: toolName,
		tool_input: {
			task_name: 'reader',
			...(includeForkTurns ? { fork_turns: forkTurns } : {}),
		},
	})
}

function expectRefusal(result: HookResult, cause: string): void {
	expect(result.exitCode).toBe(2)
	expect(result.stdout).toBe('')
	expect(result.stderr).toBe(
		`Worker history gate refused the launch: ${cause} ${repair}\n`,
	)
}

describe('worker history gate public process', () => {
	test('allows an explicit fresh worker', () => {
		const result = runHook(spawnInput('none'))

		expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
	})

	test('allows an explicit fresh worker from the flattened v2 tool name', () => {
		const result = runHook(spawnInput('none', true, 'collaborationspawn_agent'))

		expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
	})

	test('refuses an omitted fork_turns value', () => {
		expectRefusal(
			runHook(spawnInput(undefined, false)),
			'fork_turns must be the explicit string "none".',
		)
	})

	test('refuses full history', () => {
		expectRefusal(
			runHook(spawnInput('all')),
			'fork_turns must be the explicit string "none".',
		)
	})

	test('refuses full history from the flattened v2 tool name', () => {
		expectRefusal(
			runHook(spawnInput('all', true, 'collaborationspawn_agent')),
			'fork_turns must be the explicit string "none".',
		)
	})

	test('refuses limited history', () => {
		expectRefusal(
			runHook(spawnInput(2)),
			'fork_turns must be the explicit string "none".',
		)
	})

	test.each(
		[null, true, false, 0, -1, '2', {}, []].map((value) => ({ value })),
	)(
		'refuses wrong-typed or unsupported fork_turns value $value',
		({ value }) => {
			expectRefusal(
				runHook(spawnInput(value)),
				'fork_turns must be the explicit string "none".',
			)
		},
	)

	test('refuses malformed JSON', () => {
		expectRefusal(runHook('{'), 'Hook input is not valid JSON.')
	})

	test('refuses malformed hook input', () => {
		expectRefusal(
			runHook(JSON.stringify({ tool_name: 'spawn_agent' })),
			'Hook input has no valid tool_input object.',
		)
	})

	test('fails closed when Bun is unavailable', () => {
		const emptyPath = mkdtempSync(join(tmpdir(), 'worker-history-gate-'))
		try {
			expectRefusal(
				runHook(spawnInput('none'), emptyPath),
				'Bun is unavailable.',
			)
		} finally {
			rmSync(emptyPath, { recursive: true, force: true })
		}
	})

	test('fails closed when the parser runtime exits unexpectedly', () => {
		const fakePath = mkdtempSync(join(tmpdir(), 'worker-history-gate-'))
		try {
			const fakeBun = join(fakePath, 'bun')
			writeFileSync(fakeBun, '#!/bin/sh\nexit 1\n')
			chmodSync(fakeBun, 0o755)

			expectRefusal(
				runHook(spawnInput('none'), fakePath),
				'the parser runtime failed with exit 1.',
			)
		} finally {
			rmSync(fakePath, { recursive: true, force: true })
		}
	})

	test('does not affect another tool when invoked directly', () => {
		const result = runHook(
			JSON.stringify({ tool_name: 'read_file', tool_input: {} }),
		)

		expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
	})
})
