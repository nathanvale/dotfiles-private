/**
 * Shared test scaffolding for the proof plugin's hook tests: disposable git
 * repos, a real-script spawn helper, and fake `node_modules/.bin/<tool>`
 * binaries that leave a sentinel file so a guard-short-circuit test can prove
 * the tool was never invoked.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []

export async function makeTempDir(prefix: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	tempDirs.push(dir)
	return dir
}

export function cleanupTempDirs(): void {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true })
	}
}

export function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
	})
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
	}
}

export function initRepo(dir: string): void {
	git(dir, 'init', '-q')
	git(dir, 'config', 'user.name', 'Proof Test')
	git(dir, 'config', 'user.email', 'proof-test@example.invalid')
	git(dir, 'config', 'commit.gpgsign', 'false')
}

export interface HookRunResult {
	exitCode: number
	stdout: string
	stderr: string
}

export async function runHook(
	hookPath: string,
	input: unknown,
	extraArgs: string[] = [],
): Promise<HookRunResult> {
	const proc = Bun.spawn([process.execPath, 'run', hookPath, ...extraArgs], {
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

export function sentinelPath(repoRoot: string, binName: string): string {
	return join(repoRoot, `.${binName}-invoked`)
}

/** Writes a `#!/bin/sh` fake binary at `node_modules/.bin/<binName>` that records invocation, then runs `body`. */
export function installFakeBinary(repoRoot: string, binName: string, body: string): void {
	const binDir = join(repoRoot, 'node_modules', '.bin')
	mkdirSync(binDir, { recursive: true })
	const bin = join(binDir, binName)
	writeFileSync(bin, `#!/bin/sh\ntouch "${sentinelPath(repoRoot, binName)}"\n${body}\n`)
	chmodSync(bin, 0o755)
}

export function wasInvoked(repoRoot: string, binName: string): boolean {
	return existsSync(sentinelPath(repoRoot, binName))
}
