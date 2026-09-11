import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { cleanupTempDirs, git, initRepo, installFakeBinary, makeTempDir, runHook, wasInvoked } from './test-support.ts'
import { parseTscOutput } from './typecheck-ci.ts'

const HOOK_PATH = join(import.meta.dir, 'typecheck-ci.ts')

afterAll(() => {
	cleanupTempDirs()
})

interface TypecheckEnvelope {
	tool: string
	event: string
	status: string
	scope: string
	fileCount: number
	errorCount: number
	errors: { file: string; line: number; message: string }[]
	suppressedCount?: number
}

interface OkEnvelope {
	tool: string
	status: string
	scope: string
	suppressedCount: number
}

async function setupTsRepo(
	dir: string,
	options: { withTsc?: boolean; tscBody?: string } = {},
): Promise<void> {
	initRepo(dir)
	writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{}}\n')
	writeFileSync(join(dir, 'untouched.ts'), 'export const a = 1\n')
	if (options.withTsc) {
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
		installFakeBinary(dir, 'tsc', options.tscBody ?? 'exit 0')
	}
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'init')
}

const inScopeOnlyBody = [
	`cat <<'EOF'`,
	"changed.ts(3,5): error TS2322: Type 'string' is not assignable to",
	"  type 'number'.",
	'EOF',
	'exit 2',
].join('\n')

const inScopeAndOutOfScopeBody = [
	`cat <<'EOF'`,
	"changed.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
	"untouched.ts(1,1): error TS2551: Property 'foo' does not exist.",
	'EOF',
	'exit 2',
].join('\n')

const outOfScopeOnlyBody = [
	`cat <<'EOF'`,
	"untouched.ts(1,1): error TS2551: Property 'foo' does not exist.",
	'EOF',
	'exit 2',
].join('\n')

const globalErrorBody = [
	`cat <<'EOF'`,
	"error TS5083: Cannot read file 'tsconfig.json'.",
	'EOF',
	'exit 1',
].join('\n')

describe('typecheck-ci Stop', () => {
	test('exits 0 when stop_hook_active is true', async () => {
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', stop_hook_active: true })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 silently when the repository has no local tsc', async () => {
		const dir = await makeTempDir('proof-tsc-notool-')
		await setupTsRepo(dir)
		writeFileSync(join(dir, 'changed.ts'), 'export const b = 1\n')
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('exits 0 without invoking tsc when nothing typecheck-relevant changed', async () => {
		const dir = await makeTempDir('proof-tsc-empty-')
		await setupTsRepo(dir, { withTsc: true, tscBody: 'exit 1' })
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(wasInvoked(dir, 'tsc')).toBe(false)
	})

	test('exits 0 when tsc reports no errors', async () => {
		const dir = await makeTempDir('proof-tsc-pass-')
		await setupTsRepo(dir, { withTsc: true, tscBody: 'exit 0' })
		writeFileSync(join(dir, 'changed.ts'), 'export const b = 1\n')
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		expect(run.stderr).toBe('')
	})

	test('writes {} to stdout on a codex-harness pass', async () => {
		const dir = await makeTempDir('proof-tsc-codex-')
		await setupTsRepo(dir, { withTsc: true, tscBody: 'exit 0' })
		writeFileSync(join(dir, 'changed.ts'), 'export const b = 1\n')
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

	test('blocks on an in-scope error with the envelope fields asserted', async () => {
		const dir = await makeTempDir('proof-tsc-inscope-')
		await setupTsRepo(dir, { withTsc: true, tscBody: inScopeOnlyBody })
		writeFileSync(join(dir, 'changed.ts'), 'export const b = 1\n')
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as TypecheckEnvelope
		expect(envelope.tool).toBe('typecheck-ci')
		expect(envelope.event).toBe('Stop')
		expect(envelope.status).toBe('error')
		expect(envelope.scope).toBe('changed-files')
		expect(envelope.errorCount).toBe(1)
		expect(envelope.suppressedCount).toBe(0)
		expect(envelope.errors[0]?.message).toBe("[TS2322] Type 'string' is not assignable to\ntype 'number'.")
	})

	test('reports errorCount 1 and suppressedCount 1 for a mixed in-scope and out-of-scope failure', async () => {
		const dir = await makeTempDir('proof-tsc-mixed-')
		await setupTsRepo(dir, { withTsc: true, tscBody: inScopeAndOutOfScopeBody })
		writeFileSync(join(dir, 'changed.ts'), 'export const b = 1\n')
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as TypecheckEnvelope
		expect(envelope.errorCount).toBe(1)
		expect(envelope.suppressedCount).toBe(1)
	})

	test('exits 0 with an ok note when only an out-of-scope file fails', async () => {
		const dir = await makeTempDir('proof-tsc-outofscope-')
		await setupTsRepo(dir, { withTsc: true, tscBody: outOfScopeOnlyBody })
		writeFileSync(join(dir, 'changed.ts'), 'export const b = 1\n')
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(0)
		const envelope = JSON.parse(run.stderr) as OkEnvelope
		expect(envelope.tool).toBe('typecheck-ci')
		expect(envelope.status).toBe('ok')
		expect(envelope.scope).toBe('changed-files')
		expect(envelope.suppressedCount).toBe(1)
	})

	test('blocks on a global error when a tsconfig file changed', async () => {
		const dir = await makeTempDir('proof-tsc-globalerror-')
		await setupTsRepo(dir, { withTsc: true, tscBody: globalErrorBody })
		writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{},"extra":true}\n')
		const run = await runHook(HOOK_PATH, { hook_event_name: 'Stop', cwd: dir })
		expect(run.exitCode).toBe(2)
		const envelope = JSON.parse(run.stderr) as TypecheckEnvelope
		expect(envelope.errorCount).toBe(1)
		expect(envelope.errors[0]).toEqual({
			file: '<tsc>',
			line: 0,
			message: "[TS5083] Cannot read file 'tsconfig.json'.",
		})
		expect(envelope.suppressedCount).toBeUndefined()
	})
})

describe('parseTscOutput', () => {
	test('appends continuation lines to the previous diagnostic and records a global error', () => {
		const output = [
			"changed.ts(3,5): error TS2322: Type 'string' is not assignable to",
			"  type 'number'.",
			"error TS5083: Cannot read file 'tsconfig.json'.",
		].join('\n')

		const diagnostics = parseTscOutput(output)
		expect(diagnostics).toHaveLength(2)
		expect(diagnostics[0]).toEqual({
			file: 'changed.ts',
			line: 3,
			col: 5,
			code: 'TS2322',
			message: "Type 'string' is not assignable to\ntype 'number'.",
		})
		expect(diagnostics[1]).toEqual({
			file: null,
			line: 0,
			col: 0,
			code: 'TS5083',
			message: "Cannot read file 'tsconfig.json'.",
		})
	})
})
