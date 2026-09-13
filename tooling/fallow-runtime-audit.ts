import path from "node:path";
import type { AuditOutput } from "fallow/types";

const packages = [
	".agents/runtime/agent-native-state-machine-generator",
	".agents/runtime/agent-worktree",
	".agents/runtime/cli-command-facade",
	".agents/runtime/cli-test-fixtures",
	".agents/runtime/session-corpus",
] as const;

type FallowAuditOutput = AuditOutput & { kind: "audit" };

const FALLOW_AUDIT_SCHEMA_VERSION: AuditOutput["schema_version"] = 10;

type AuditClassification = "success" | "quality-failure" | "operational-failure";

type PackageResult = {
	package: string;
	scope: string;
	verdict: unknown;
	exit: number | null;
	classification: AuditClassification;
	nativeReport: unknown;
	summary: unknown;
	stdout: string;
	stderr: string;
	error?: string;
};

export type RunFallowRuntimeAuditOptions = {
	repoRoot: string;
	fallowBin: string;
	packages: readonly string[];
	extraArgs: readonly string[];
	log?: (line: string) => void;
	logError?: (line: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuditSummary(value: unknown): value is AuditOutput["summary"] {
	if (!isRecord(value)) return false;
	return (
		typeof value.dead_code_issues === "number" &&
		typeof value.dead_code_has_errors === "boolean" &&
		typeof value.complexity_findings === "number" &&
		(value.max_cyclomatic === null || typeof value.max_cyclomatic === "number") &&
		typeof value.duplication_clone_groups === "number"
	);
}

function isAuditAttribution(value: unknown): value is AuditOutput["attribution"] {
	if (!isRecord(value)) return false;
	return (
		(value.gate === "new-only" || value.gate === "all") &&
		typeof value.dead_code_introduced === "number" &&
		typeof value.dead_code_inherited === "number" &&
		typeof value.complexity_introduced === "number" &&
		typeof value.complexity_inherited === "number" &&
		typeof value.duplication_introduced === "number" &&
		typeof value.duplication_inherited === "number" &&
		typeof value.styling_introduced === "number" &&
		typeof value.styling_inherited === "number" &&
		typeof value.duplication_demoted === "number"
	);
}

function isFallowAuditOutput(value: unknown): value is FallowAuditOutput {
	if (!isRecord(value)) return false;
	return (
		value.kind === "audit" &&
		value.schema_version === FALLOW_AUDIT_SCHEMA_VERSION &&
		typeof value.version === "string" &&
		value.command === "audit" &&
		(value.verdict === "pass" || value.verdict === "warn" || value.verdict === "fail") &&
		typeof value.changed_files_count === "number" &&
		typeof value.base_ref === "string" &&
		typeof value.elapsed_ms === "number" &&
		isAuditSummary(value.summary) &&
		isAuditAttribution(value.attribution)
	);
}

function classifyAuditResult(exit: number | null, verdict: unknown): AuditClassification {
	if (exit === 0 && (verdict === "pass" || verdict === "warn")) return "success";
	if (exit === 1 && verdict === "fail") return "quality-failure";
	return "operational-failure";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runFallowRuntimeAudit(options: RunFallowRuntimeAuditOptions): Promise<number> {
	const { repoRoot, fallowBin, packages: packageList, extraArgs, log = console.log, logError = console.error } = options;
	const results: PackageResult[] = [];

	for (const packagePath of packageList) {
		let result: PackageResult;
		try {
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

			let nativeReport: unknown = null;
			let verdict: unknown = null;
			let summary: unknown = null;
			try {
				nativeReport = JSON.parse(stdout);
				if (isFallowAuditOutput(nativeReport)) {
					verdict = nativeReport.verdict ?? null;
					summary = nativeReport.summary ?? null;
				}
			} catch {
				// The raw stdout remains in the emitted record for diagnosis.
			}

			result = {
				package: packagePath,
				scope: packagePath,
				verdict,
				exit,
				classification: classifyAuditResult(exit, verdict),
				nativeReport,
				summary,
				stdout,
				stderr,
			};
		} catch (error) {
			result = {
				package: packagePath,
				scope: packagePath,
				verdict: null,
				exit: null,
				classification: "operational-failure",
				nativeReport: null,
				summary: null,
				stdout: "",
				stderr: "",
				error: errorMessage(error),
			};
		}

		log(JSON.stringify(result));
		results.push(result);
	}

	const operationalErrors = results
		.filter((result) => result.classification === "operational-failure")
		.map((result) => result.package);
	if (operationalErrors.length > 0) {
		logError(`Fallow operational error: ${operationalErrors.join(", ")}`);
		return 2;
	}
	if (results.some((result) => result.classification === "quality-failure")) {
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
