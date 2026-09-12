import path from "node:path";

const packages = [
	".agents/runtime/agent-native-state-machine-generator",
	".agents/runtime/agent-worktree",
	".agents/runtime/cli-command-facade",
	".agents/runtime/cli-test-fixtures",
	".agents/runtime/session-corpus",
] as const;

type FallowAuditOutput = {
	verdict?: string;
	summary?: Record<string, unknown>;
};

type PackageResult = { package: string; verdict: string | null; exit: number };

export type RunFallowRuntimeAuditOptions = {
	repoRoot: string;
	fallowBin: string;
	packages: readonly string[];
	extraArgs: readonly string[];
	log?: (line: string) => void;
	logError?: (line: string) => void;
};

export async function runFallowRuntimeAudit(options: RunFallowRuntimeAuditOptions): Promise<number> {
	const { repoRoot, fallowBin, packages: packageList, extraArgs, log = console.log, logError = console.error } = options;
	const results: PackageResult[] = [];

	for (const packagePath of packageList) {
		const fallowProcess = Bun.spawn(
			[
				fallowBin,
				"audit",
				"--root",
				packagePath,
				"--config",
				".fallowrc.json",
				"--format",
				"json",
				"--quiet",
				"--type-aware",
				"--type-aware-require",
				"best-effort",
				...extraArgs,
			],
			{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exit] = await Promise.all([
			new Response(fallowProcess.stdout).text(),
			new Response(fallowProcess.stderr).text(),
			fallowProcess.exited,
		]);

		try {
			const output = JSON.parse(stdout) as FallowAuditOutput;
			const verdict = output.verdict ?? null;
			log(
				JSON.stringify({
					package: packagePath,
					verdict,
					exit,
					summary: output.summary ?? null,
				}),
			);
			results.push({ package: packagePath, verdict, exit });
		} catch {
			// Unparseable stdout means no audit result exists, regardless of
			// what the child's own exit code claimed; a success exit paired
			// with non-JSON output is itself an operational failure.
			const operationalExit = exit === 0 ? 2 : exit;
			log(
				JSON.stringify({
					package: packagePath,
					verdict: null,
					exit: operationalExit,
					summary: null,
					stderr: stderr.slice(0, 2000),
				}),
			);
			results.push({ package: packagePath, verdict: null, exit: operationalExit });
		}
	}

	const operationalErrors = results.filter((result) => result.exit === 2).map((result) => result.package);
	if (operationalErrors.length > 0) {
		logError(`Fallow operational error (exit 2): ${operationalErrors.join(", ")}`);
		return 2;
	}
	if (results.some((result) => result.verdict === "fail" || result.exit === 1)) {
		return 1;
	}
	return 0;
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const exitCode = await runFallowRuntimeAudit({
		repoRoot,
		fallowBin: "node_modules/.bin/fallow",
		packages,
		extraArgs: process.argv.slice(2),
	});
	process.exitCode = exitCode;
}
