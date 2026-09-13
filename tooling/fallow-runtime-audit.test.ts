import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimePackages = [
	".agents/runtime/agent-native-state-machine-generator",
	".agents/runtime/agent-worktree",
	".agents/runtime/cli-command-facade",
	".agents/runtime/cli-test-fixtures",
	".agents/runtime/session-corpus",
] as const;

type ChildOutcome = {
	stdout: string;
	stderr: string;
	exit: number;
};

type ProcessResult = {
	stdout: string;
	stderr: string;
	exit: number;
};

type AuditRecord = {
	package: string;
	scope: string;
	verdict: unknown;
	exit: number | null;
	classification: string;
	nativeReport: unknown;
	summary: unknown;
	stdout: string;
	stderr: string;
	error?: string;
};

type MatrixCase = {
	name: string;
	outcomes: readonly ChildOutcome[];
	expectedExit: number;
	expectedClassifications: readonly string[];
	expectedVerdicts: readonly unknown[];
};

const sourcePath = join(import.meta.dir, "fallow-runtime-audit.ts");
const source = readFileSync(sourcePath, "utf8");

const nativeAuditFields = {
	kind: "audit",
	schema_version: 10,
	version: "3.19.0",
	command: "audit",
	changed_files_count: 1,
	base_ref: "fixture-base",
	elapsed_ms: 1,
	attribution: {
		gate: "all",
		dead_code_introduced: 0,
		dead_code_inherited: 0,
		complexity_introduced: 0,
		complexity_inherited: 0,
		duplication_introduced: 0,
		duplication_inherited: 0,
		styling_introduced: 0,
		styling_inherited: 0,
		duplication_demoted: 0,
	},
	_meta: { type_aware: { completeness: "partial", selected_tsconfigs: ["fixture/tsconfig.json"] } },
};
const passReport = {
	...nativeAuditFields,
	verdict: "pass",
	summary: {
		dead_code_issues: 0,
		dead_code_has_errors: false,
		complexity_findings: 0,
		max_cyclomatic: null,
		duplication_clone_groups: 0,
	},
};
const missingMaxCyclomaticReport = {
	...nativeAuditFields,
	verdict: "pass",
	summary: {
		dead_code_issues: 0,
		dead_code_has_errors: false,
		complexity_findings: 0,
		duplication_clone_groups: 0,
	},
};
const invalidMaxCyclomaticReport = {
	...passReport,
	summary: { ...passReport.summary, max_cyclomatic: "7" },
};
const numericMaxCyclomaticReport = {
	...passReport,
	summary: { ...passReport.summary, max_cyclomatic: 7 },
};
const warnReport = {
	...nativeAuditFields,
	verdict: "warn",
	summary: {
		dead_code_issues: 0,
		dead_code_has_errors: false,
		complexity_findings: 0,
		max_cyclomatic: null,
		duplication_clone_groups: 1,
	},
};
const failReport = {
	...nativeAuditFields,
	verdict: "fail",
	summary: {
		dead_code_issues: 2,
		dead_code_has_errors: true,
		complexity_findings: 0,
		max_cyclomatic: null,
		duplication_clone_groups: 0,
	},
};
const errorReport = {
	error: true,
	message: "child could not complete the audit",
	exit_code: 2,
};
const verdictOnlyReport = { verdict: "pass" };
const wrongKindReport = { ...passReport, kind: "fallow-audit" };
const wrongSchemaReport = { ...passReport, schema_version: 9 };
const missingSummaryReport = { ...nativeAuditFields, verdict: "pass" };
const missingAttributionReport = {
	kind: "audit",
	schema_version: 10,
	version: "3.19.0",
	command: "audit",
	verdict: "pass",
	changed_files_count: 1,
	base_ref: "fixture-base",
	elapsed_ms: 1,
	summary: passReport.summary,
};

function jsonOutcome(report: unknown, exit: number, stderr = ""): ChildOutcome {
	return { stdout: `${JSON.stringify(report)}\n`, stderr, exit };
}

function rawOutcome(stdout: string, exit: number, stderr = ""): ChildOutcome {
	return { stdout, stderr, exit };
}

const matrix: readonly MatrixCase[] = [
	{
		name: "accepts pass from every child",
		outcomes: runtimePackages.map(() => jsonOutcome(passReport, 0)),
		expectedExit: 0,
		expectedClassifications: ["success", "success", "success", "success", "success"],
		expectedVerdicts: ["pass", "pass", "pass", "pass", "pass"],
	},
	{
		name: "accepts warn from every child",
		outcomes: runtimePackages.map(() => jsonOutcome(warnReport, 0)),
		expectedExit: 0,
		expectedClassifications: ["success", "success", "success", "success", "success"],
		expectedVerdicts: ["warn", "warn", "warn", "warn", "warn"],
	},
	{
		name: "rejects a verdict-only object from a successful child",
		outcomes: [
			jsonOutcome(verdictOnlyReport, 0, "missing native audit envelope\n"),
			...runtimePackages.slice(1).map(() => jsonOutcome(passReport, 0)),
		],
		expectedExit: 2,
		expectedClassifications: ["operational-failure", "success", "success", "success", "success"],
		expectedVerdicts: [null, "pass", "pass", "pass", "pass"],
	},
	{
		name: "rejects missing or invalid max_cyclomatic summaries",
		outcomes: [
			jsonOutcome(missingMaxCyclomaticReport, 0, "missing max_cyclomatic\n"),
			jsonOutcome(invalidMaxCyclomaticReport, 0, "invalid max_cyclomatic\n"),
			jsonOutcome(numericMaxCyclomaticReport, 0),
			jsonOutcome(passReport, 0),
			jsonOutcome(passReport, 0),
		],
		expectedExit: 2,
		expectedClassifications: [
			"operational-failure",
			"operational-failure",
			"success",
			"success",
			"success",
		],
		expectedVerdicts: [null, null, "pass", "pass", "pass"],
	},
	{
		name: "rejects wrong or incomplete native audit envelopes",
		outcomes: [
			jsonOutcome(wrongKindReport, 0, "wrong native kind\n"),
			jsonOutcome(wrongSchemaReport, 0, "wrong native schema\n"),
			jsonOutcome(missingSummaryReport, 0, "missing native summary\n"),
			jsonOutcome(missingAttributionReport, 0, "missing native attribution\n"),
			jsonOutcome({ ...passReport, command: "dead-code" }, 0, "wrong native command\n"),
		],
		expectedExit: 2,
		expectedClassifications: [
			"operational-failure",
			"operational-failure",
			"operational-failure",
			"operational-failure",
			"operational-failure",
		],
		expectedVerdicts: [null, null, null, null, null],
	},
	{
		name: "returns quality failure only for exit one and fail",
		outcomes: [jsonOutcome(failReport, 1), ...runtimePackages.slice(1).map(() => jsonOutcome(passReport, 0))],
		expectedExit: 1,
		expectedClassifications: ["quality-failure", "success", "success", "success", "success"],
		expectedVerdicts: ["fail", "pass", "pass", "pass", "pass"],
	},
	{
		name: "rejects mismatched exits and unknown verdicts",
		outcomes: [
			jsonOutcome(failReport, 0, "fail verdict with successful exit\n"),
			jsonOutcome(passReport, 1, "pass verdict with quality exit\n"),
			jsonOutcome(passReport, 3, "unexpected nonzero exit\n"),
			jsonOutcome(errorReport, 0, "unknown verdict\n"),
			jsonOutcome(warnReport, 1, "warn verdict with quality exit\n"),
		],
		expectedExit: 2,
		expectedClassifications: [
			"operational-failure",
			"operational-failure",
			"operational-failure",
			"operational-failure",
			"operational-failure",
		],
		expectedVerdicts: ["fail", "pass", "pass", null, "warn"],
	},
	{
		name: "fails operationally for every unexpected result shape",
		outcomes: [
			jsonOutcome(errorReport, 2, "refused: no audit ran\n"),
			jsonOutcome(errorReport, 3, "unexpected child exit\n"),
			jsonOutcome({ summary: { scope: "runtime-package" } }, 0, "missing verdict\n"),
			rawOutcome("not json\n", 0, "malformed report\n"),
			rawOutcome(`${JSON.stringify("scalar-report")}\n`, 0, "scalar report\n"),
		],
		expectedExit: 2,
		expectedClassifications: [
			"operational-failure",
			"operational-failure",
			"operational-failure",
			"operational-failure",
			"operational-failure",
		],
		expectedVerdicts: [null, null, null, null, null],
	},
	{
		name: "gives operational failure precedence over quality failure",
		outcomes: [
			jsonOutcome(failReport, 1),
			jsonOutcome(errorReport, 3, "unexpected child exit\n"),
			jsonOutcome(passReport, 0),
			jsonOutcome(warnReport, 0),
			jsonOutcome(passReport, 0),
		],
		expectedExit: 2,
		expectedClassifications: ["quality-failure", "operational-failure", "success", "success", "success"],
		expectedVerdicts: ["fail", null, "pass", "warn", "pass"],
	},
];

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createFixture(outcomes?: readonly ChildOutcome[]): string {
	const root = mkdtempSync(join(tmpdir(), "fallow-runtime-audit-cli-"));
	fixtureRoots.push(root);
	mkdirSync(join(root, "tooling"), { recursive: true });
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	for (const packagePath of runtimePackages) mkdirSync(join(root, packagePath), { recursive: true });
	writeFileSync(join(root, "tooling", "fallow-runtime-audit.ts"), source);

	if (outcomes) {
		const script = [
			"#!/bin/sh",
			"printf '%s\\n' \"$3\" >> .fallow-invocations",
			"case \"$3\" in",
			...runtimePackages.flatMap((packagePath, index) => {
				const outcome = outcomes[index];
				if (!outcome) throw new Error(`Missing fixture outcome for ${packagePath}`);
				return [
					`  ${shellQuote(packagePath)})`,
					`    printf '%s' ${shellQuote(outcome.stdout)}`,
					`    printf '%s' ${shellQuote(outcome.stderr)} >&2`,
					`    exit ${outcome.exit}`,
					"    ;;",
				];
			}),
			"esac",
			"exit 99",
			"",
		].join("\n");
		const binPath = join(root, "node_modules", ".bin", "fallow");
		writeFileSync(binPath, script);
		chmodSync(binPath, 0o755);
	}

	return root;
}

async function runPublicAudit(root: string): Promise<ProcessResult> {
	const child = Bun.spawn([process.execPath, join(root, "tooling", "fallow-runtime-audit.ts")], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exit };
}

function parseRecords(stdout: string): AuditRecord[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as AuditRecord);
}

for (const matrixCase of matrix) {
	test(`public CLI ${matrixCase.name}`, async () => {
		const root = createFixture(matrixCase.outcomes);
		const result = await runPublicAudit(root);
		const records = parseRecords(result.stdout);

		expect(result.exit).toBe(matrixCase.expectedExit);
		expect(records).toHaveLength(5);
		expect(readFileSync(join(root, ".fallow-invocations"), "utf8").trim().split("\n")).toHaveLength(5);
		expect(records.map((record) => record.package)).toEqual([...runtimePackages]);
		expect(records.map((record) => record.scope)).toEqual([...runtimePackages]);
		expect(records.map((record) => record.classification)).toEqual([...matrixCase.expectedClassifications]);
		expect(records.map((record) => record.verdict)).toEqual([...matrixCase.expectedVerdicts]);
		if (matrixCase.expectedExit === 2) {
			expect(result.stderr).toContain("Fallow operational error");
		} else {
			expect(result.stderr).toBe("");
		}

		expect(records.map((record) => record.stdout)).toEqual(matrixCase.outcomes.map((outcome) => outcome.stdout));
		expect(records.map((record) => record.stderr)).toEqual(matrixCase.outcomes.map((outcome) => outcome.stderr));
		expect(records.map((record) => record.nativeReport)).toEqual(
			matrixCase.outcomes.map((outcome) => {
				try {
					return JSON.parse(outcome.stdout);
				} catch {
					return null;
				}
			}),
		);
	});
}

test("public CLI classifies a missing child executable as operational failure", async () => {
	const root = createFixture();
	const result = await runPublicAudit(root);
	const records = parseRecords(result.stdout);

	expect(result.exit).toBe(2);
	expect(records).toHaveLength(5);
	expect(records.every((record) => record.classification === "operational-failure")).toBe(true);
	expect(records.every((record) => record.exit === null)).toBe(true);
	expect(records.every((record) => (record.error ?? "").length > 0)).toBe(true);
	expect(result.stderr).toContain("Fallow operational error");
});
