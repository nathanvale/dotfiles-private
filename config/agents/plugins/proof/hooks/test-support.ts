/**
 * Shared test scaffolding for the proof plugin's hook tests: disposable git
 * repos, a real-script spawn helper, and fake `node_modules/.bin/<tool>`
 * binaries that leave a sentinel file so a guard-short-circuit test can prove
 * the tool was never invoked.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSpawnResult } from './common'

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
	env?: Record<string, string>,
): Promise<HookRunResult> {
	const proc = Bun.spawn([process.execPath, 'run', hookPath, ...extraArgs], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: env ? { ...process.env, ...env } : process.env,
	})
	proc.stdin.write(JSON.stringify(input))
	proc.stdin.end()
	return collectSpawnResult(proc.exited, proc.stdout, proc.stderr)
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

/** Real Node descendants inherit pipes and their parent's process group, like Fallow's type helper. */
export function processTreeFixture(dir: string, parentExits = false, detachedChild = false) {
	const node = Bun.which('node')
	if (!node) throw new Error('Node is required for the process-tree fixture')
	const script = join(dir, 'owned-tree.mjs')
	writeFileSync(script, `
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [directory, depthText, parentExits, detachedChild] = process.argv.slice(2);
const depth = Number(depthText);
writeFileSync(join(directory, 'pid-' + depth), String(process.pid));
const ownsDetachedChild = depth === 0 && detachedChild === 'true';
const child = depth < 2 ? spawn(process.execPath, [import.meta.filename, directory, String(depth + 1), parentExits, detachedChild], { detached: ownsDetachedChild, stdio: ['ignore', 'inherit', 'inherit'] }) : null;
if (ownsDetachedChild) process.on('SIGTERM', () => { process.kill(-child.pid, 'SIGTERM'); child.once('exit', () => process.exit(0)); });
else if (detachedChild !== 'true') process.on('SIGTERM', () => {});
const timer = setInterval(() => {
 if (depth === 0 && parentExits === 'true' && existsSync(join(directory, 'pid-2'))) process.exit(0);
}, 10);
if (depth === 0) { console.log('owned stdout'); console.error('owned stderr'); }
`)
	const pids = () => [0, 1, 2].flatMap((depth) => {
		const file = join(dir, `pid-${depth}`)
		if (!existsSync(file)) return []
		const text = readFileSync(file, 'utf8')
		const pid = Number(text)
		return /^[0-9]+$/.test(text) && Number.isSafeInteger(pid) && pid > 0 ? [pid] : []
	})
	return {
		argv: [node, script, dir, '0', String(parentExits), String(detachedChild)],
		pids,
		async ready() {
			const deadline = Date.now() + 5000
			while (pids().length !== 3 && Date.now() < deadline) await Bun.sleep(10)
			if (pids().length !== 3) throw new Error('Owned child/grandchild did not start')
		},
		alive() {
			return pids().filter((pid) => {
				try { process.kill(pid, 0); return true } catch { return false }
			})
		},
		cleanup() {
			for (const pid of pids().reverse()) {
				try { process.kill(pid, 'SIGKILL') } catch { /* fixture may already have exited */ }
			}
		},
	}
}
