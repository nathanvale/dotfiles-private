#!/usr/bin/env bun

/**
 * Stop hook: delta Biome gate. Lints only the files changed in the working
 * tree (staged, unstaged, untracked), and only when the repository itself has
 * Biome installed (`node_modules/.bin/biome` plus `biome.json[c]`). Repos
 * without a local Biome, and pre-existing errors in untouched files, never
 * block a Stop.
 */

import {
	changedBiomeFiles,
	parseBiomeErrors,
	resolveRepoBiome,
	resolveRepoRoot,
	runBiomeCheck,
	summariseFailure,
} from './biome-common.ts'

interface StopHookInput {
	stop_hook_active?: boolean
	cwd?: string
}

async function readInput(): Promise<StopHookInput> {
	try {
		const raw = await Bun.stdin.text()
		if (!raw.trim()) return {}
		return JSON.parse(raw) as StopHookInput
	} catch {
		// Empty or non-JSON stdin should not block the stop hook.
		return {}
	}
}

async function main(): Promise<void> {
	const input = await readInput()
	if (input.stop_hook_active === true) process.exit(0)

	const cwd =
		typeof input.cwd === 'string' && input.cwd.trim()
			? input.cwd
			: process.cwd()
	const repoRoot = await resolveRepoRoot(cwd)
	if (!repoRoot) process.exit(0)

	const biomeBin = resolveRepoBiome(repoRoot)
	if (!biomeBin) process.exit(0)

	const files = await changedBiomeFiles(repoRoot)
	if (files.length === 0) process.exit(0)

	const result = await runBiomeCheck(biomeBin, repoRoot, files)
	if (result.exitCode === 0) process.exit(0)

	const diagnostics = parseBiomeErrors(result.stdout, result.stderr)
	const summary = summariseFailure(result, diagnostics)
	process.stderr.write(
		JSON.stringify({
			tool: 'biome-ci',
			status: 'error',
			scope: 'changed-files',
			fileCount: files.length,
			errorCount: summary.errorCount,
			errors: summary.errors,
		}),
	)
	process.exit(2)
}

if (import.meta.main) {
	const selfDestruct = setTimeout(() => {
		process.stderr.write('biome-ci: timed out\n')
		process.exit(0)
	}, 96_000)
	selfDestruct.unref()
	main()
}
