#!/usr/bin/env bun

/**
 * Biome quality hook. `PostToolUse` lints the files an agent just edited and
 * only informs (the write already happened, so it cannot block). `Stop`
 * lints the full changed-file delta and blocks with exit 2. Both paths exit
 * 0 silently when the repository has no local Biome.
 */

import { dirname, resolve } from 'node:path'
import {
	armSelfDestruct,
	blockWithEnvelope,
	changedFiles,
	type CommandResult,
	type FailureEntry,
	type Harness,
	type HookInput,
	parseHarness,
	passStop,
	readHookInput,
	resolveRepoRoot,
	resolveRepoTool,
	resolveToolContext,
	runCommand,
	summariseFailure,
} from './common.ts'

const BIOME_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.mts',
	'.cts',
	'.json',
	'.jsonc',
	'.css',
]
const BIOME_MARKERS = ['biome.json', 'biome.jsonc']

interface BiomeReporterDiagnostic {
	severity?: string
	description?: string
	message?: string
	category?: string
	location?: {
		path?: string
		start?: { line?: number }
	}
}

function parseBiomeErrors(stdout: string, stderr: string): FailureEntry[] {
	const parse = (output: string): FailureEntry[] => {
		try {
			const report = JSON.parse(output) as { diagnostics?: BiomeReporterDiagnostic[] }
			return (report.diagnostics ?? [])
				.filter((diagnostic) => diagnostic.severity === 'error')
				.map((diagnostic) => ({
					file: diagnostic.location?.path ?? 'unknown',
					line: diagnostic.location?.start?.line ?? 0,
					message: `[${diagnostic.category ?? 'unknown'}] ${
						diagnostic.description ?? diagnostic.message ?? 'Unknown issue'
					}`,
				}))
		} catch {
			return []
		}
	}
	const fromStdout = parse(stdout)
	return fromStdout.length > 0 ? fromStdout : parse(stderr)
}

async function runBiomeCheck(
	binary: string,
	repoRoot: string,
	files: string[],
): Promise<CommandResult> {
	return runCommand(
		[binary, 'check', '--diagnostic-level=error', '--no-errors-on-unmatched', '--reporter=json', '--', ...files],
		{ cwd: repoRoot, env: { CI: 'true' } },
	)
}

function extractEditedFiles(input: HookInput): string[] {
	const seen = new Set<string>()
	if (input.tool_input?.file_path) seen.add(input.tool_input.file_path)
	for (const edit of input.tool_input?.edits ?? []) {
		if (edit.file_path) seen.add(edit.file_path)
	}
	return [...seen]
		.filter((file) => BIOME_EXTENSIONS.some((extension) => file.endsWith(extension)))
		.map((file) => resolve(file))
}

async function runStop(input: HookInput, harness: Harness): Promise<never> {
	if (input.stop_hook_active === true) passStop(harness)

	const context = await resolveToolContext(input, 'biome', BIOME_MARKERS)
	if (!context) passStop(harness)
	const { repoRoot, binary } = context

	const files = await changedFiles(repoRoot, BIOME_EXTENSIONS)
	if (files.length === 0) passStop(harness)

	const result = await runBiomeCheck(binary, repoRoot, files)
	if (result.exitCode === 0) passStop(harness)

	const entries = parseBiomeErrors(result.stdout, result.stderr)
	const summary = summariseFailure(result, entries, '<biome>')
	blockWithEnvelope({
		tool: 'biome-ci',
		event: 'Stop',
		status: 'error',
		scope: 'changed-files',
		fileCount: files.length,
		errorCount: summary.errorCount,
		errors: summary.errors,
	})
}

async function runPostToolUse(input: HookInput, harness: Harness): Promise<void> {
	const files = extractEditedFiles(input)
	const firstFile = files[0]
	if (!firstFile) process.exit(0)

	const repoRoot = await resolveRepoRoot(dirname(firstFile))
	if (!repoRoot) process.exit(0)

	const binary = resolveRepoTool(repoRoot, 'biome', BIOME_MARKERS)
	if (!binary) process.exit(0)

	const result = await runBiomeCheck(binary, repoRoot, files)
	if (result.exitCode === 0) process.exit(0)

	const entries = parseBiomeErrors(result.stdout, result.stderr)
	const summary = summariseFailure(result, entries, '<biome>')
	const additionalContext = summary.errors
		.slice(0, 20)
		.map((error) => `${error.file}:${error.line} ${error.message}`)
		.join('\n')

	if (harness === 'codex') {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext } }))
	} else {
		process.stdout.write(
			JSON.stringify({
				decision: 'block',
				reason: `${summary.errorCount} Biome error(s) in edited files`,
				hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
			}),
		)
	}
	process.exit(0)
}

async function main(): Promise<void> {
	const harness = parseHarness(process.argv.slice(2))
	const input = await readHookInput()

	if (input.hook_event_name === 'Stop') {
		armSelfDestruct('biome-ci', 96_000)
		await runStop(input, harness)
		return
	}
	if (input.hook_event_name === 'PostToolUse') {
		armSelfDestruct('biome-ci', 24_000)
		await runPostToolUse(input, harness)
		return
	}
	process.exit(0)
}

if (import.meta.main) main()
