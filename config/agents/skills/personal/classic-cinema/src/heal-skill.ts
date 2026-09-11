#!/usr/bin/env bun
// heal-skill — diagnose the classic-cinema skill's health and apply safe repairs.
//
// Facade-backed CLI. The command surface (commands, flags, exit codes, action
// affordances) is declared in command-contract.ts; this runner parses argv
// against that contract and renders runtime envelopes. Diagnosis logic lives in
// heal-engine.ts so the runner stays a thin transport.
//
// Commands:
//   check    [--only <check-id>] [--json]              read-only diagnosis (default)
//   repair   [--only <check-id>] [--execute] [--no-input] [--json]
//                                                       preview (default) or apply safe repairs
//   explain  <check-id> [--json]                        what a finding means + safe fix
//
// Exit codes (per contract):
//   0 healthy / repair fully succeeded
//   1 findings exist, none repaired
//   2 usage error
// Repair handoff (findings that need a human) also exits 1 with handoffNeeded set.

import {
	type CliWriter,
	type ParsedCliDiagnosticArgv,
	createCliRepairStateRuntimeError,
	createCliRuntimeErrorEnvelope,
	createCliRuntimeSuccessEnvelope,
	createCliUsageRuntimeError,
	parseCliDiagnosticArgv,
	parseCliDiagnosticFallbackArgv,
	renderCommandUsage,
	usageError,
	writeJsonEnvelope,
} from "@side-quest/cli-command-facade";
import {
	HEAL_SKILL_CHECK_IDS,
	HEAL_SKILL_SCHEMA_VERSION,
	type HealSkillCommand,
	healSkillContracts,
} from "./command-contract.ts";
import {
	CHECK_EXPLAIN,
	type Finding,
	knownCheckIds,
	type RepairResult,
	repairBookingLog,
	runChecks,
} from "./heal-engine.ts";

const VERSION = "0.1.0";

// --- parsed command shapes ---

type ParsedHealCommand =
	| { kind: "help"; command: HealSkillCommand | null }
	| { kind: "version" }
	| { kind: "check"; outputMode: OutputMode; only: string | null }
	| {
			kind: "repair";
			outputMode: OutputMode;
			only: string | null;
			execute: boolean;
			noInput: boolean;
	  }
	| { kind: "explain"; outputMode: OutputMode; checkId: string };

type OutputMode = "plain" | "json";

function isCommand(value: string | undefined): value is HealSkillCommand {
	return value === "check" || value === "repair" || value === "explain";
}

function findCommand(argv: readonly string[]): HealSkillCommand | null {
	for (const arg of argv) {
		if (isCommand(arg)) return arg;
	}
	return null;
}

function requireNext(args: readonly string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw usageError(`${flag} requires a value.`);
	}
	return value;
}

function requireInlineValue(arg: string, flag: string): string {
	const value = arg.slice(`${flag}=`.length);
	if (value === "") throw usageError(`${flag} requires a value.`);
	return value;
}

function parseCheckId(flag: string, value: string): string {
	if (!(HEAL_SKILL_CHECK_IDS as readonly string[]).includes(value)) {
		throw usageError(
			`${flag} must be one of: ${HEAL_SKILL_CHECK_IDS.join(", ")}`,
		);
	}
	return value;
}

// --- argv parsing (validated against the contract's per-command flags) ---

type ParsedHealOptions = {
	outputMode: OutputMode;
	only: string | null;
	execute: boolean;
	noInput: boolean;
	explainId: string | null;
};

type HealCommandPrefix = {
	command: HealSkillCommand;
	args: string[];
};

function createHealSkillOptions(): ParsedHealOptions {
	return {
		outputMode: "plain",
		only: null,
		execute: false,
		noInput: false,
		explainId: null,
	};
}

function parseSpecialArgv(argv: readonly string[]): ParsedHealCommand | null {
	if (argv.includes("--version")) return { kind: "version" };
	if (argv.includes("--help") || argv.includes("-h")) {
		return { kind: "help", command: findCommand(argv) };
	}
	if (argv[0] === "help") {
		return { kind: "help", command: findCommand(argv.slice(1)) };
	}
	return null;
}

function parseCommandPrefix(argv: readonly string[]): HealCommandPrefix {
	const args = [...argv];
	const candidate = args[0];
	if (candidate === undefined || candidate.startsWith("-")) {
		return { command: "check", args };
	}
	args.shift();
	if (!isCommand(candidate)) throw usageError(`unknown command: ${candidate}`);
	return { command: candidate, args };
}

/** Keyed by an attacker-controlled argv token, so this is a Map (not a plain
 * object): a plain object would let e.g. a bare `constructor` token resolve
 * `handlers.constructor` to `Object`, a truthy value that is not a real handler. */
const SIMPLE_FLAG_HANDLERS: ReadonlyMap<string, (state: ParsedHealOptions) => void> = new Map([
	[
		"--json",
		(state: ParsedHealOptions) => {
			state.outputMode = "json";
		},
	],
	[
		"--execute",
		(state: ParsedHealOptions) => {
			state.execute = true;
		},
	],
	[
		"--no-input",
		(state: ParsedHealOptions) => {
			state.noInput = true;
		},
	],
]);

function parseHealSkillOption(
	args: string[],
	index: number,
	command: HealSkillCommand,
	state: ParsedHealOptions,
): number {
	const arg = args[index];
	const handler = SIMPLE_FLAG_HANDLERS.get(arg);
	if (handler) {
		handler(state);
		return index;
	}
	if (arg === "--only") {
		state.only = parseCheckId("--only", requireNext(args, index, "--only"));
		return index + 1;
	}
	if (arg.startsWith("--only=")) {
		state.only = parseCheckId("--only", requireInlineValue(arg, "--only"));
		return index;
	}
	if (command === "explain" && !arg.startsWith("-") && state.explainId === null) {
		state.explainId = arg;
		return index;
	}
	if (arg.startsWith("-")) throw usageError(`unknown option: ${arg}`);
	throw usageError(`unexpected argument: ${arg}`);
}

function parseHealSkillOptions(
	args: string[],
	command: HealSkillCommand,
): ParsedHealOptions {
	const state = createHealSkillOptions();
	for (let index = 0; index < args.length; index += 1) {
		index = parseHealSkillOption(args, index, command, state);
	}
	return state;
}

function validateCheckOptions(options: ParsedHealOptions): void {
	if (options.execute) throw usageError("check does not accept --execute.");
	if (options.noInput) throw usageError("check does not accept --no-input.");
}

function validateExplainOptions(options: ParsedHealOptions): string {
	if (options.only) throw usageError("explain does not accept --only.");
	if (options.execute) throw usageError("explain does not accept --execute.");
	if (options.noInput) throw usageError("explain does not accept --no-input.");
	if (!options.explainId) {
		throw usageError(
			`explain requires a check id: ${knownCheckIds().join(", ")}`,
		);
	}
	return options.explainId;
}

function buildParsedHealCommand(
	command: HealSkillCommand,
	options: ParsedHealOptions,
): ParsedHealCommand {
	if (command === "check") {
		validateCheckOptions(options);
		return { kind: "check", outputMode: options.outputMode, only: options.only };
	}
	if (command === "repair") {
		return {
			kind: "repair",
			outputMode: options.outputMode,
			only: options.only,
			execute: options.execute,
			noInput: options.noInput,
		};
	}
	return {
		kind: "explain",
		outputMode: options.outputMode,
		checkId: validateExplainOptions(options),
	};
}

function parseHealSkillArgv(argv: readonly string[]): ParsedHealCommand {
	const special = parseSpecialArgv(argv);
	if (special) return special;
	const { command, args } = parseCommandPrefix(argv);
	return buildParsedHealCommand(command, parseHealSkillOptions(args, command));
}

// --- runtime (injectable for tests; the engine reads the real filesystem) ---

export type HealSkillRuntime = {
	now: () => number;
	runChecks: (only: string | null) => Promise<Finding[]>;
	repairBookingLog: (execute: boolean) => Promise<RepairResult>;
};

export function createDefaultHealSkillRuntime(
	overrides: Partial<HealSkillRuntime> = {},
): HealSkillRuntime {
	return {
		now: () => Date.now(),
		runChecks,
		repairBookingLog,
		...overrides,
	};
}

// --- command results ---

interface HealResult {
	run_id: string;
	duration_ms: number;
	exit_code: number;
	action: string;
	findings?: Finding[];
	repairs?: RepairResult[];
	mode?: "preview" | "execute";
	handoff_needed?: boolean;
	explanation?: { checkId: string; explanation: string };
}

async function runCheck(input: {
	parsed: Extract<ParsedHealCommand, { kind: "check" }>;
	runtime: HealSkillRuntime;
	runId: string;
	startedAt: number;
}): Promise<HealResult> {
	const findings = await input.runtime.runChecks(input.parsed.only);
	const hasFinding = findings.some((f) => f.status !== "ok");
	return {
		run_id: input.runId,
		duration_ms: input.runtime.now() - input.startedAt,
		exit_code: hasFinding ? 1 : 0,
		action: hasFinding ? "findings_present" : "skill_healthy",
		findings,
	};
}

async function processRepairFinding(input: {
	finding: Finding;
	execute: boolean;
	runtime: HealSkillRuntime;
	repairs: RepairResult[];
}): Promise<boolean> {
	if (input.finding.status === "ok") return false;
	if (
		input.finding.checkId === "booking-log-valid" &&
		input.finding.autoRepairable
	) {
		input.repairs.push(await input.runtime.repairBookingLog(input.execute));
		return false;
	}
	return input.finding.status === "handoff" || !input.finding.autoRepairable;
}

async function collectRepairResults(input: {
	findings: Finding[];
	execute: boolean;
	runtime: HealSkillRuntime;
}): Promise<{ repairs: RepairResult[]; handoffNeeded: boolean }> {
	const repairs: RepairResult[] = [];
	let handoffNeeded = false;
	for (const finding of input.findings) {
		if (
			await processRepairFinding({
				finding,
				execute: input.execute,
				runtime: input.runtime,
				repairs,
			})
		) {
			handoffNeeded = true;
		}
	}
	return { repairs, handoffNeeded };
}

function getRepairExitCode(
	findings: Finding[],
	applied: boolean,
	handoffNeeded: boolean,
): number {
	if (handoffNeeded) return 1;
	if (applied) return 0;
	return findings.some((finding) => finding.status !== "ok") ? 1 : 0;
}

function getRepairAction(applied: boolean, handoffNeeded: boolean): string {
	if (applied) return "repaired";
	return handoffNeeded ? "handoff_needed" : "no_repair_needed";
}

async function runRepair(input: {
	parsed: Extract<ParsedHealCommand, { kind: "repair" }>;
	runtime: HealSkillRuntime;
	runId: string;
	startedAt: number;
}): Promise<HealResult> {
	// Run the targeted (or full) checks first so we only repair what's broken.
	const findings = await input.runtime.runChecks(input.parsed.only);
	const { repairs, handoffNeeded } = await collectRepairResults({
		findings,
		execute: input.parsed.execute,
		runtime: input.runtime,
	});
	const applied = repairs.some((r) => r.applied);
	return {
		run_id: input.runId,
		duration_ms: input.runtime.now() - input.startedAt,
		exit_code: getRepairExitCode(findings, applied, handoffNeeded),
		action: getRepairAction(applied, handoffNeeded),
		mode: input.parsed.execute ? "execute" : "preview",
		findings,
		repairs,
		handoff_needed: handoffNeeded,
	};
}

function runExplain(input: {
	parsed: Extract<ParsedHealCommand, { kind: "explain" }>;
	runtime: HealSkillRuntime;
	runId: string;
	startedAt: number;
}): HealResult {
	const id = input.parsed.checkId;
	// id is an attacker-controlled argv token, so a plain-property read would
	// let e.g. "constructor" resolve to Object instead of failing the lookup.
	const explanation = Object.hasOwn(CHECK_EXPLAIN, id) ? CHECK_EXPLAIN[id] : undefined;
	if (!explanation) {
		throw usageError(`explain needs a known check id: ${knownCheckIds().join(", ")}`);
	}
	return {
		run_id: input.runId,
		duration_ms: input.runtime.now() - input.startedAt,
		exit_code: 0,
		action: "explained",
		explanation: { checkId: id, explanation },
	};
}

// --- output ---

function statusEmoji(s: Finding["status"]): string {
	return { ok: "✅", finding: "⚠️", repaired: "🔧", handoff: "🚑" }[s];
}

function renderExplanation(result: HealResult): string | null {
	if (!result.explanation) return null;
	return `${result.explanation.checkId}\n\n${result.explanation.explanation}\n`;
}

function renderFinding(finding: Finding): string[] {
	const lines = [`${statusEmoji(finding.status)} ${finding.checkId}: ${finding.summary}`];
	if (finding.detail) lines.push(`   ${finding.detail}`);
	lines.push(`   → ${finding.nextAction}`);
	return lines;
}

function renderFindings(findings: Finding[]): string[] {
	const lines: string[] = [];
	for (const finding of findings) {
		if (finding.status === "ok") continue;
		lines.push(...renderFinding(finding));
	}
	return lines;
}

function renderRepair(repair: RepairResult): string[] {
	const lines = [`${repair.applied ? "🔧" : "👁"} ${repair.checkId}: ${repair.summary}`];
	if (repair.backupPath) lines.push(`   backup: ${repair.backupPath}`);
	for (const line of repair.previewLines ?? []) lines.push(`   ${line}`);
	return lines;
}

function renderRepairs(repairs: RepairResult[]): string[] {
	const lines: string[] = [];
	for (const repair of repairs) lines.push(...renderRepair(repair));
	return lines;
}

function renderPreviewNotice(result: HealResult, repairs: RepairResult[]): string | null {
	if (result.mode !== "preview" || repairs.length === 0) return null;
	return "\nPreview only. Re-run with --execute to apply.";
}

function renderPlain(result: HealResult): string {
	const explanation = renderExplanation(result);
	if (explanation) return explanation;

	const findings = result.findings ?? [];
	const repairs = result.repairs ?? [];
	if (findings.every((finding) => finding.status === "ok") && repairs.length === 0) {
		return "✅ classic-cinema healthy — all checks pass\n";
	}

	const lines: string[] = [];
	lines.push(...renderFindings(findings));
	lines.push(...renderRepairs(repairs));
	const previewNotice = renderPreviewNotice(result, repairs);
	if (previewNotice) lines.push(previewNotice);
	return `${lines.join("\n")}\n`;
}

function writeResult(
	stdout: CliWriter,
	result: HealResult,
	outputMode: OutputMode,
): void {
	if (outputMode === "json") {
		if (result.exit_code === 0) {
			writeJsonEnvelope(
				stdout,
				createCliRuntimeSuccessEnvelope({
					run_id: result.run_id,
					data: result,
				}),
				{ runId: result.run_id, durationMs: result.duration_ms },
			);
			return;
		}
		writeJsonEnvelope(
			stdout,
			createCliRuntimeErrorEnvelope({
				run_id: result.run_id,
				process_exit_code: result.exit_code,
				error: createCliRepairStateRuntimeError({
					run_id: result.run_id,
					code: result.handoff_needed ? "repair_incomplete" : "findings_present",
					message:
						result.action === "handoff_needed"
							? "Findings need a human handoff; see findings[].nextAction."
							: "Findings present; see findings[].nextAction.",
					exit_code: result.exit_code,
					severity: "warning",
				}),
				data: result,
			}),
			{ runId: result.run_id, durationMs: result.duration_ms },
		);
		return;
	}
	stdout.write(renderPlain(result));
}

function inferOutputMode(argv: readonly string[]): OutputMode {
	return argv.includes("--json") ? "json" : "plain";
}

function emitUsageError(input: {
	error: unknown;
	outputMode: OutputMode;
	stdout: CliWriter;
	stderr: CliWriter;
	runId: string;
	durationMs: number;
}): number {
	const message = input.error instanceof Error ? input.error.message : String(input.error);
	if (input.outputMode === "json") {
		writeJsonEnvelope(
			input.stdout,
			createCliRuntimeErrorEnvelope({
				run_id: input.runId,
				process_exit_code: 2,
				error: createCliUsageRuntimeError({
					run_id: input.runId,
					code: "usage_error",
					message,
					exit_code: 2,
				}),
			}),
			{ runId: input.runId, durationMs: input.durationMs },
		);
	} else {
		input.stderr.write(`${message}\n`);
	}
	return 2;
}

// --- entry / dispatch ---

export async function runHealSkillCli(
	argv: readonly string[],
	options: {
		runtime?: HealSkillRuntime;
		stdout?: CliWriter;
		stderr?: CliWriter;
	} = {},
): Promise<number> {
	const runtime = options.runtime ?? createDefaultHealSkillRuntime();
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;

	let parsedDiagnostics: ParsedCliDiagnosticArgv;
	try {
		parsedDiagnostics = parseCliDiagnosticArgv(argv);
	} catch (error) {
		parsedDiagnostics = parseCliDiagnosticFallbackArgv(argv);
		return emitUsageError({
			error,
			outputMode: inferOutputMode(argv),
			stdout,
			stderr,
			runId: parsedDiagnostics.options.runId,
			durationMs: runtime.now() - parsedDiagnostics.options.startedAtMs,
		});
	}

	const runId = parsedDiagnostics.options.runId;
	const startedAt = parsedDiagnostics.options.startedAtMs;

	let parsed: ParsedHealCommand;
	try {
		parsed = parseHealSkillArgv(parsedDiagnostics.argv);
	} catch (error) {
		return emitUsageError({
			error,
			outputMode: inferOutputMode(parsedDiagnostics.argv),
			stdout,
			stderr,
			runId,
			durationMs: runtime.now() - startedAt,
		});
	}

	if (parsed.kind === "version") {
		stdout.write(`heal-skill ${VERSION}\n`);
		return 0;
	}
	if (parsed.kind === "help") {
		const command = parsed.command ?? "check";
		stdout.write(renderCommandUsage(healSkillContracts[command]));
		return 0;
	}

	let result: HealResult;
	try {
		result =
			parsed.kind === "check"
				? await runCheck({ parsed, runtime, runId, startedAt })
				: parsed.kind === "repair"
					? await runRepair({ parsed, runtime, runId, startedAt })
					: runExplain({ parsed, runtime, runId, startedAt });
	} catch (error) {
		return emitUsageError({
			error,
			outputMode: parsed.outputMode,
			stdout,
			stderr,
			runId,
			durationMs: runtime.now() - startedAt,
		});
	}

	writeResult(stdout, result, parsed.outputMode);
	return result.exit_code;
}

// --- test harness ---

class BufferWriter implements CliWriter {
	private chunks: string[] = [];

	write(chunk: string): true {
		this.chunks.push(chunk);
		return true;
	}

	toString(): string {
		return this.chunks.join("");
	}
}

export async function runForTest(
	argv: readonly string[],
	runtime: HealSkillRuntime = createDefaultHealSkillRuntime(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const stdout = new BufferWriter();
	const stderr = new BufferWriter();
	const exitCode = await runHealSkillCli(argv, { runtime, stdout, stderr });
	return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

export { HEAL_SKILL_SCHEMA_VERSION };

if (import.meta.main) {
	const exitCode = await runHealSkillCli(Bun.argv.slice(2));
	process.exit(exitCode);
}
