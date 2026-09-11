#!/usr/bin/env bun

/**
 * TypeScript quality hook. `Stop`-only: `tsc` is whole-program, so mid-edit
 * multi-file states across `PostToolUse` would produce false errors. Blocks
 * only on diagnostics inside the changed-file set (`inScope`); an error in an
 * untouched file is reported as `suppressedCount` context, never a block,
 * unless it is a global (file-less) error and a `tsconfig*.json` itself
 * changed. Exits 0 silently when the repository has no local `tsc`.
 */

import { resolve } from 'node:path'
import {
	armSelfDestruct,
	blockWithEnvelope,
	changedFiles,
	type Harness,
	type HookInput,
	parseHarness,
	passStop,
	readHookInput,
	resolveToolContext,
	runCommand,
} from './common.ts'

const TSCONFIG_PATTERN = /(^|\/)tsconfig([^/]*)\.json$/

export interface TscDiagnostic {
	file: string | null
	line: number
	col: number
	code: string
	message: string
}

const FILE_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const GLOBAL_ERROR = /^error (TS\d+): (.*)$/

export function parseTscOutput(output: string): TscDiagnostic[] {
	const diagnostics: TscDiagnostic[] = []
	for (const line of output.split('\n')) {
		const fileMatch = FILE_ERROR.exec(line)
		if (fileMatch) {
			diagnostics.push({
				file: fileMatch[1] ?? '',
				line: Number(fileMatch[2]),
				col: Number(fileMatch[3]),
				code: fileMatch[4] ?? '',
				message: fileMatch[5] ?? '',
			})
			continue
		}
		const globalMatch = GLOBAL_ERROR.exec(line)
		if (globalMatch) {
			diagnostics.push({ file: null, line: 0, col: 0, code: globalMatch[1] ?? '', message: globalMatch[2] ?? '' })
			continue
		}
		const last = diagnostics.at(-1)
		if (last && /^\s+\S/.test(line)) {
			last.message += `\n${line.trim()}`
		}
	}
	return diagnostics
}

async function resolveChangeScope(
	repoRoot: string,
): Promise<{ tsFiles: string[]; tsconfigChanged: boolean }> {
	const [tsFiles, jsonFiles] = await Promise.all([
		changedFiles(repoRoot, ['.ts', '.tsx']),
		changedFiles(repoRoot, ['.json']),
	])
	const tsconfigChanged = jsonFiles.some((file) => TSCONFIG_PATTERN.test(file))
	return { tsFiles, tsconfigChanged }
}

async function runStop(input: HookInput, harness: Harness): Promise<never> {
	if (input.stop_hook_active === true) passStop(harness)

	const context = await resolveToolContext(input, 'tsc', ['tsconfig.json'])
	if (!context) passStop(harness)
	const { repoRoot, binary } = context

	const { tsFiles, tsconfigChanged } = await resolveChangeScope(repoRoot)
	if (tsFiles.length === 0 && !tsconfigChanged) passStop(harness)

	const result = await runCommand([binary, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], {
		cwd: repoRoot,
		env: { NO_COLOR: '1', FORCE_COLOR: '0' },
	})
	if (result.exitCode === 0) passStop(harness)

	const diagnostics = parseTscOutput(result.stdout)
	const changedSet = new Set(tsFiles)
	const fileDiagnostics = diagnostics.filter((diagnostic) => diagnostic.file !== null) as (TscDiagnostic & {
		file: string
	})[]
	const globalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.file === null)

	const inScope = fileDiagnostics.filter((diagnostic) => changedSet.has(resolve(repoRoot, diagnostic.file)))
	const suppressed = fileDiagnostics.filter((diagnostic) => !changedSet.has(resolve(repoRoot, diagnostic.file)))

	if (inScope.length > 0) {
		blockWithEnvelope({
			tool: 'typecheck-ci',
			event: 'Stop',
			status: 'error',
			scope: 'changed-files',
			fileCount: tsFiles.length,
			errorCount: inScope.length,
			errors: inScope.map((diagnostic) => ({
				file: resolve(repoRoot, diagnostic.file),
				line: diagnostic.line,
				message: `[${diagnostic.code}] ${diagnostic.message}`,
			})),
			suppressedCount: suppressed.length,
		})
	}

	if (globalDiagnostics.length > 0 && tsconfigChanged) {
		blockWithEnvelope({
			tool: 'typecheck-ci',
			event: 'Stop',
			status: 'error',
			scope: 'changed-files',
			fileCount: tsFiles.length,
			errorCount: globalDiagnostics.length,
			errors: globalDiagnostics.map((diagnostic) => ({
				file: '<tsc>',
				line: 0,
				message: `[${diagnostic.code}] ${diagnostic.message}`,
			})),
		})
	}

	if (suppressed.length > 0) {
		process.stderr.write(
			JSON.stringify({
				tool: 'typecheck-ci',
				status: 'ok',
				scope: 'changed-files',
				suppressedCount: suppressed.length,
			}),
		)
	}

	passStop(harness)
}

async function main(): Promise<void> {
	const harness = parseHarness(process.argv.slice(2))
	const input = await readHookInput()

	if (input.hook_event_name !== 'Stop') process.exit(0)

	armSelfDestruct('typecheck-ci', 96_000)
	await runStop(input, harness)
}

if (import.meta.main) main()
