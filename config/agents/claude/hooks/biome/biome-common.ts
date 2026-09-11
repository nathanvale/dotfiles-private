/**
 * Shared helpers for the Biome hooks. Owns the "Biome is in this repository"
 * gate (repo-local binary plus config, never bunx or a global install), the
 * changed-file discovery, the check spawn, and the failure summary.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const BIOME_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.json',
	'.jsonc',
	'.css',
]

export interface BiomeDiagnostic {
	file: string
	line: number
	message: string
	code: string
}

export interface BiomeCheckResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface BiomeFailureEntry {
	file: string
	line: number
	message: string
}

export interface BiomeFailureSummary {
	errorCount: number
	errors: BiomeFailureEntry[]
}

interface BiomeReporterDiagnostic {
	severity?: string
	description?: string
	message?: string
	category?: string
	location?: {
		path?: string
		start?: {
			line?: number
		}
	}
}

const MAX_REPORTED_ERRORS = 30
const RAW_EXCERPT_LENGTH = 500

export function isBiomeFile(file: string): boolean {
	return BIOME_EXTENSIONS.some((extension) => file.endsWith(extension))
}

async function runGit(
	repoRoot: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(['git', '-C', repoRoot, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
	])
	return { exitCode, stdout }
}

export async function resolveRepoRoot(cwd: string): Promise<string | null> {
	try {
		const { exitCode, stdout } = await runGit(cwd, [
			'rev-parse',
			'--show-toplevel',
		])
		if (exitCode !== 0) return null
		return stdout.trim() || null
	} catch {
		return null
	}
}

export function resolveRepoBiome(repoRoot: string): string | null {
	const hasConfig =
		existsSync(join(repoRoot, 'biome.json')) ||
		existsSync(join(repoRoot, 'biome.jsonc'))
	if (!hasConfig) return null
	const binary = join(repoRoot, 'node_modules', '.bin', 'biome')
	if (!existsSync(binary)) return null
	return binary
}

export async function changedBiomeFiles(repoRoot: string): Promise<string[]> {
	const commands = [
		['diff', '--cached', '--name-only', '--diff-filter=d'],
		['diff', '--name-only', '--diff-filter=d'],
		['ls-files', '--others', '--exclude-standard'],
	]
	const outputs = await Promise.all(
		commands.map(async (args) => {
			const { stdout } = await runGit(repoRoot, [
				'-c',
				'core.quotePath=false',
				...args,
			])
			return stdout
		}),
	)
	const seen = new Set<string>()
	for (const output of outputs) {
		for (const line of output.split('\n')) {
			const file = line.trim()
			if (!file || !isBiomeFile(file)) continue
			seen.add(join(repoRoot, file))
		}
	}
	return [...seen].filter((file) => existsSync(file))
}

export async function runBiomeCheck(
	biomeBin: string,
	repoRoot: string,
	files: string[],
): Promise<BiomeCheckResult> {
	const proc = Bun.spawn(
		[
			biomeBin,
			'check',
			'--diagnostic-level=error',
			'--no-errors-on-unmatched',
			'--reporter=json',
			'--',
			...files,
		],
		{
			cwd: repoRoot,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, CI: 'true' },
		},
	)
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

function parseReport(output: string): BiomeDiagnostic[] {
	try {
		const report = JSON.parse(output) as {
			diagnostics?: BiomeReporterDiagnostic[]
		}
		return (report.diagnostics ?? [])
			.filter((diagnostic) => diagnostic.severity === 'error')
			.map((diagnostic) => ({
				file: diagnostic.location?.path ?? 'unknown',
				line: diagnostic.location?.start?.line ?? 0,
				message:
					diagnostic.description ?? diagnostic.message ?? 'Unknown issue',
				code: diagnostic.category ?? 'unknown',
			}))
	} catch {
		return []
	}
}

export function parseBiomeErrors(
	stdout: string,
	stderr: string,
): BiomeDiagnostic[] {
	const fromStdout = parseReport(stdout)
	return fromStdout.length > 0 ? fromStdout : parseReport(stderr)
}

export function summariseFailure(
	result: BiomeCheckResult,
	diagnostics: BiomeDiagnostic[],
): BiomeFailureSummary {
	if (result.exitCode !== 0 && diagnostics.length === 0) {
		const excerpt = (result.stderr || result.stdout)
			.trim()
			.slice(0, RAW_EXCERPT_LENGTH)
		return {
			errorCount: 1,
			errors: [
				{
					file: '<biome>',
					line: 0,
					message:
						excerpt || `biome exited with code ${result.exitCode} and no output`,
				},
			],
		}
	}
	return {
		errorCount: diagnostics.length,
		errors: diagnostics.slice(0, MAX_REPORTED_ERRORS).map((diagnostic) => ({
			file: diagnostic.file,
			line: diagnostic.line,
			message: `[${diagnostic.code}] ${diagnostic.message}`,
		})),
	}
}
