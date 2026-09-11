#!/usr/bin/env bun

/**
 * PostToolUse hook: run Biome on files an agent just edited.
 *
 * The repository is resolved from the first edited file, and the check runs
 * only when that repository has Biome installed locally. The hook stays
 * non-blocking unless Biome exits non-zero for the edited files.
 */

import { dirname, resolve } from 'node:path'
import {
	isBiomeFile,
	parseBiomeErrors,
	resolveRepoBiome,
	resolveRepoRoot,
	runBiomeCheck,
	summariseFailure,
} from './biome-common.ts'

interface HookInput {
	tool_name: string
	tool_input?: {
		file_path?: string
		edits?: Array<{ file_path?: string }>
	}
}

function extractFilePaths(input: HookInput): string[] {
	const seen = new Set<string>()
	if (input.tool_input?.file_path) seen.add(input.tool_input.file_path)
	for (const edit of input.tool_input?.edits ?? []) {
		if (edit.file_path) seen.add(edit.file_path)
	}
	return [...seen].filter(isBiomeFile).map((file) => resolve(file))
}

async function main(): Promise<void> {
	let input: HookInput
	try {
		input = (await Bun.stdin.json()) as HookInput
	} catch {
		process.exit(0)
	}

	const filePaths = extractFilePaths(input)
	const firstFile = filePaths[0]
	if (!firstFile) process.exit(0)

	const repoRoot = await resolveRepoRoot(dirname(firstFile))
	if (!repoRoot) process.exit(0)

	const biomeBin = resolveRepoBiome(repoRoot)
	if (!biomeBin) process.exit(0)

	const result = await runBiomeCheck(biomeBin, repoRoot, filePaths)
	if (result.exitCode === 0) process.exit(0)

	const diagnostics = parseBiomeErrors(result.stdout, result.stderr)
	const summary = summariseFailure(result, diagnostics)

	process.stdout.write(
		JSON.stringify({
			decision: 'block',
			reason: `${summary.errorCount} Biome error(s) in edited files`,
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				additionalContext: summary.errors
					.slice(0, 20)
					.map((error) => `${error.file}:${error.line} ${error.message}`)
					.join('\n'),
			},
		}),
	)
	process.exit(0)
}

if (import.meta.main) {
	const selfDestruct = setTimeout(() => {
		process.stderr.write('biome-check: timed out\n')
		process.exit(0)
	}, 24_000)
	selfDestruct.unref()
	main()
}
