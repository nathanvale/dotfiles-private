#!/usr/bin/env bun

import {
	type CliWriter,
	type CommandFacadeResultContract,
	type CommandResultPayload,
	createCliRepairStateRuntimeError,
	createCliRuntimeErrorEnvelope,
	createCliRuntimeSuccessEnvelope,
	createCliUsageRuntimeError,
	createCommandResultData,
	parseCliDiagnosticArgv,
	projectCommandDiscoveryTree,
	renderCommandUsage,
	writeJsonEnvelope,
} from "@side-quest/cli-command-facade";
import {
	agentWorktreeLifecycleResultContract,
	agentWorktreeContractEntries,
	agentWorktreeContracts,
} from "./command-contract.ts";
import {
	type GitRunner,
	defaultGitRunner,
	discoverRepo,
} from "./discovery.ts";
import { runDoctor } from "./doctor.ts";
import type { DoctorMap } from "./doctor.ts";
import {
	buildHandoffSnapshot,
	inspectRefFromRoot,
	parseAgentWorktreeRef,
} from "./inspect.ts";
import {
	AGENT_WORKTREE_CLI_NAME,
	AGENT_WORKTREE_COMMANDS,
	type AgentWorktreeChangedState,
	type AgentWorktreeCommand,
	type AgentWorktreeDiagnosticCode,
} from "./model.ts";
import {
	PROJECTION_FIELD_SETS,
	type ProjectionFieldSet,
} from "./projection.ts";
import {
	attachWorktree,
	checkWorktree,
	cleanPreview,
	createWorktree,
	deleteWorktree,
	type LifecycleResult,
	listWorktrees,
	recoverPreview,
	refreshWorktrees,
	statusWorktreeResult,
} from "./worktrees.ts";

const VERSION = "0.1.0";

/**
 * Runtime hooks for the CLI front door.
 */
export interface AgentWorktreeCliRuntime {
	/** Current cwd for repo-scoped commands. */
	cwd: () => string;
	/** Current epoch millis for deterministic envelope durations in tests. */
	now: () => number;
	/** Git subprocess runner. */
	run: GitRunner;
}

/**
 * Parsed public invocation.
 *
 * @example
 * ```typescript
 * const parsed = parseInvocation(["doctor", "--json"])
 * ```
 */
export interface ParsedInvocation {
	/** Command id. */
	command?: AgentWorktreeCommand;
	/** Positional args after the command. */
	positionals: readonly string[];
	/** Explicit repo cwd. */
	repo?: string;
	/** JSON output requested. */
	json: boolean;
	/** Dry-run/write preview. */
	dryRun: boolean;
	/** Preview spelling for clean. */
	preview: boolean;
	/** Force destructive execution. */
	force: boolean;
	/** Delete branch after worktree removal. */
	deleteBranch: boolean;
	/** Explicit typed ref. */
	ref?: string;
	/** Base branch or revision for creation. */
	base?: string;
	/** Pull request number for attach. */
	pr?: number;
	/** Use gh checkout for push-tracking PR attach. */
	track: boolean;
	/** Output limit. */
	limit?: number;
	/** Projection field sets. */
	fields?: readonly ProjectionFieldSet[];
	/** Projection selector. */
	select?: readonly string[];
	/** Parse error result. */
	parseError?: CommandResult;
}

/**
 * Build the default CLI runtime adapter.
 *
 * @param overrides - Hooks tests use to keep envelope timing deterministic
 * @returns Runtime adapter for the CLI front door
 *
 * @example
 * ```typescript
 * const runtime = createDefaultRuntime({ now: () => 0 })
 * ```
 */
export function createDefaultRuntime(
	overrides: Partial<AgentWorktreeCliRuntime> = {},
): AgentWorktreeCliRuntime {
	return {
		cwd: () => process.cwd(),
		now: () => Date.now(),
		run: defaultGitRunner,
		...overrides,
	};
}

export type CommandResult =
	| {
			ok: true;
			data: Record<string, unknown>;
			changedState?: AgentWorktreeChangedState;
	  }
	| {
			ok: false;
			exitCode: 1 | 2;
			code: AgentWorktreeDiagnosticCode;
			message: string;
			action: string;
			changedState: AgentWorktreeChangedState;
			data?: Record<string, unknown>;
	  };

type ContextHeavyReadCommand = Extract<
	AgentWorktreeCommand,
	"doctor" | "list" | "status" | "clean" | "handoff"
>;

type AgentWorktreeLifecycleData = {
	action: LifecycleResult["action"];
	changed_state: LifecycleResult["changedState"];
	preview: LifecycleResult["preview"];
	run_ref: LifecycleResult["runRef"] | undefined;
	failure_ref: LifecycleResult["failureRef"] | undefined;
	changes: LifecycleResult["changes"];
	next_safe_action: LifecycleResult["nextSafeAction"];
	reason: LifecycleResult["reason"] | undefined;
	recovery: LifecycleResult["recovery"] | undefined;
	backup_ref: LifecycleResult["backupRef"] | undefined;
	resolved_ref: LifecycleResult["resolvedRef"] | undefined;
	target_path: LifecycleResult["targetPath"] | undefined;
	mode: LifecycleResult["mode"] | undefined;
	existing_checkout_path: LifecycleResult["existingCheckoutPath"] | undefined;
};

type AgentWorktreeDoctorData = {
	summary: {
		status: DoctorMap["status"];
		repo_root: DoctorMap["repo"]["gitRoot"] | undefined;
		isolation: DoctorMap["repo"]["isolation"] | undefined;
		main_owner_root: DoctorMap["repo"]["mainOwnerRoot"] | undefined;
		active_worktree: DoctorMap["repo"]["activeWorktree"] | undefined;
		current_branch: DoctorMap["repo"]["currentBranch"] | undefined;
		default_branch: DoctorMap["repo"]["defaultBranch"] | undefined;
		store_root: DoctorMap["repo"]["storeRoot"] | undefined;
		linked_worktree_count: DoctorMap["repo"]["linkedWorktreeCount"];
		stale_dir_count: DoctorMap["repo"]["staleDirCount"];
		stray_worktree_count: DoctorMap["repo"]["strayWorktreeCount"];
		available_commands: DoctorMap["availableCommands"];
	};
	checks: {
		id: DoctorMap["checks"][number]["id"];
		owner: DoctorMap["checks"][number]["owner"];
		status: DoctorMap["checks"][number]["status"];
		summary: DoctorMap["checks"][number]["summary"];
		blockers: DoctorMap["checks"][number]["blockers"];
		next_actions: DoctorMap["checks"][number]["nextActions"];
	}[];
	mutation_readiness: DoctorMap["mutationReadiness"];
	blockers: string[];
	next_actions: DoctorMap["nextActions"][number][];
};

const PROJECTION_FIELD_SET_VALUES = new Set<string>(PROJECTION_FIELD_SETS);

const PROJECTION_METADATA_KEYS = ["contract_id", "schema_version"] as const;

const READ_PROJECTION_KEYS = {
	doctor: {
		default: ["summary", "mutation_readiness", "blockers", "next_actions"],
		refs: ["summary"],
		evidence: ["checks", "blockers"],
		actions: ["mutation_readiness", "blockers", "next_actions"],
	},
	list: {
		default: ["worktrees", "total", "truncated"],
		refs: ["worktrees"],
		evidence: ["worktrees", "total", "truncated"],
		actions: ["truncated"],
	},
	status: {
		default: ["isolation", "statuses", "total", "truncated"],
		refs: ["isolation", "statuses"],
		evidence: ["isolation", "statuses", "total", "truncated"],
		actions: ["isolation", "statuses"],
	},
	clean: {
		default: [
			"registeredWorktrees",
			"orphanBranches",
			"staleDirs",
			"blockers",
			"totalRegisteredWorktrees",
			"totalOrphanBranches",
			"totalStaleDirs",
			"truncated",
			"previewOnly",
		],
		refs: ["registeredWorktrees", "orphanBranches"],
		evidence: [
			"registeredWorktrees",
			"orphanBranches",
			"staleDirs",
			"blockers",
			"totalRegisteredWorktrees",
			"totalOrphanBranches",
			"totalStaleDirs",
			"truncated",
		],
		actions: ["blockers", "previewOnly"],
	},
	handoff: {
		default: ["storeRoot", "latest", "total", "truncated", "nextSafeActions"],
		refs: ["storeRoot", "latest"],
		evidence: ["latest", "total", "truncated"],
		actions: ["nextSafeActions"],
	},
} as const satisfies Record<
	ContextHeavyReadCommand,
	Record<ProjectionFieldSet, readonly string[]>
>;

/**
 * CLI entry point: parse argv, route public commands, and emit facade envelopes.
 *
 * @param argv - Process argv tail after the executable name
 * @param options - Optional runtime and writers for tests
 * @returns Process exit code
 *
 * @example
 * ```typescript
 * const exitCode = await main(["commands", "--json"])
 * ```
 */
export async function main(
	argv: readonly string[],
	options: {
		runtime?: Partial<AgentWorktreeCliRuntime>;
		stdout?: CliWriter;
		stderr?: CliWriter;
	} = {},
): Promise<number> {
	const runtime = createDefaultRuntime(options.runtime);
	const stdout = options.stdout ?? process.stdout;

	if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
		const command = argv.find(isAgentWorktreeCommand) ?? "doctor";
		stdout.write(renderCommandUsage(agentWorktreeContracts[command]));
		return 0;
	}
	if (argv.includes("--version")) {
		stdout.write(`${AGENT_WORKTREE_CLI_NAME} ${VERSION}\n`);
		return 0;
	}

	const parsedDiagnostics = parseCliDiagnosticArgv(argv);
	const runId = parsedDiagnostics.options.runId;
	const startedAtMs = parsedDiagnostics.options.startedAtMs;
	const invocation = parseInvocation(parsedDiagnostics.argv);
	const result = await runCommand(invocation, runtime, runId);
	const durationMs = runtime.now() - startedAtMs;

	if (result.ok) {
		writeJsonEnvelope(
			stdout,
			createCliRuntimeSuccessEnvelope({ run_id: runId, data: result.data }),
			{ runId, durationMs },
		);
		return 0;
	}

	writeJsonEnvelope(
		stdout,
		createCliRuntimeErrorEnvelope({
			run_id: runId,
			process_exit_code: result.exitCode,
			error:
				result.code === "usage_error"
					? createCliUsageRuntimeError({
							run_id: runId,
							code: result.code,
							message: result.message,
							hint: { action: "change_input", summary: result.action },
							failure_domain: "agent_worktree",
						})
					: createCliRepairStateRuntimeError({
							run_id: runId,
							code: result.code,
							message: result.message,
							exit_code: result.exitCode,
							hint: { action: "repair_state", summary: result.action },
							failure_domain: "agent_worktree",
						}),
			data: lifecycleResultData({
				changed_state: result.changedState,
				next_safe_action: result.action,
				...result.data,
			}),
		}),
		{ runId, durationMs },
	);
	return result.exitCode;
}

type InvocationState = Omit<ParsedInvocation, "positionals" | "parseError"> & {
	positionals: string[];
	usedFlags: Set<string>;
};

type InvocationStep = { nextIndex: number; error?: string };

type InvocationFlagParser = (
	state: InvocationState,
	index: number,
	value: string | undefined,
) => InvocationStep;

type InvocationValueParser = (
	state: InvocationState,
	value: string,
) => string | undefined;

const INVOCATION_FLAG_PARSERS = new Map<string, InvocationFlagParser>([
	[
		"--json",
		createBooleanFlagParser("--json", (state) => {
			state.json = true;
		}),
	],
	[
		"--dry-run",
		createBooleanFlagParser("--dry-run", (state) => {
			state.dryRun = true;
		}),
	],
	[
		"--preview",
		createBooleanFlagParser("--preview", (state) => {
			state.preview = true;
		}),
	],
	[
		"--force",
		createBooleanFlagParser("--force", (state) => {
			state.force = true;
		}),
	],
	[
		"--delete-branch",
		createBooleanFlagParser("--delete-branch", (state) => {
			state.deleteBranch = true;
		}),
	],
	[
		"--track",
		createBooleanFlagParser("--track", (state) => {
			state.track = true;
		}),
	],
	[
		"--repo",
		createValueFlagParser("--repo", (state, value) => {
			state.repo = value;
		}),
	],
	[
		"--ref",
		createValueFlagParser("--ref", (state, value) => {
			state.ref = value;
		}),
	],
	[
		"--base",
		createValueFlagParser("--base", (state, value) => {
			state.base = value;
		}),
	],
	[
		"--pr",
		createValueFlagParser("--pr", parsePullRequestFlag),
	],
	[
		"--limit",
		createValueFlagParser("--limit", parseLimitFlag),
	],
	[
		"--fields",
		createValueFlagParser("--fields", parseFieldsFlag),
	],
	[
		"--select",
		createValueFlagParser("--select", parseSelectFlag),
	],
]);

/**
 * Parse argv into the package command invocation.
 *
 * @param argv - Diagnostic-stripped argv
 * @returns Parsed invocation with package-owned usage errors
 *
 * @example
 * ```typescript
 * const parsed = parseInvocation(["inspect", "run:abc", "--json"])
 * ```
 */
export function parseInvocation(argv: readonly string[]): ParsedInvocation {
	const state = createInvocationState();
	for (let index = 0; index < argv.length; index += 1) {
		const step = parseInvocationArgument(state, argv[index], index, argv[index + 1]);
		if (step.error) return invocationWithError(state, step.error);
		index = step.nextIndex;
	}

	if (!state.command) return invocationWithError(state, "Missing command.");
	const flagError = validateInvocationFlags(state);
	if (flagError) return invocationWithError(state, flagError);
	return toParsedInvocation(state);
}

function createInvocationState(): InvocationState {
	return {
		positionals: [],
		json: false,
		dryRun: false,
		preview: false,
		force: false,
		deleteBranch: false,
		track: false,
		usedFlags: new Set<string>(),
	};
}

function parseInvocationArgument(
	state: InvocationState,
	arg: string,
	index: number,
	value: string | undefined,
): InvocationStep {
	const parser = INVOCATION_FLAG_PARSERS.get(arg);
	if (parser) return parser(state, index, value);
	if (arg.startsWith("--")) {
		return { nextIndex: index, error: `Unknown flag '${arg}'.` };
	}
	if (!state.command && isAgentWorktreeCommand(arg)) {
		state.command = arg;
		return { nextIndex: index };
	}
	if (!state.command) {
		return { nextIndex: index, error: `Unknown command '${arg}'.` };
	}
	state.positionals.push(arg);
	return { nextIndex: index };
}

function validateInvocationFlags(state: InvocationState): string | undefined {
	if (!state.command) return undefined;
	const allowedFlags = new Set(Object.keys(agentWorktreeContracts[state.command].flags));
	for (const flag of state.usedFlags) {
		if (!allowedFlags.has(flag)) {
			return `Flag '${flag}' is not accepted by agent-worktree ${state.command}.`;
		}
	}
	return undefined;
}

function toParsedInvocation(state: InvocationState): ParsedInvocation {
	return {
		command: state.command,
		positionals: state.positionals,
		repo: state.repo,
		json: state.json,
		dryRun: state.dryRun,
		preview: state.preview,
		force: state.force,
		deleteBranch: state.deleteBranch,
		track: state.track,
		ref: state.ref,
		base: state.base,
		pr: state.pr,
		limit: state.limit,
		fields: state.fields,
		select: state.select,
	};
}

function invocationWithError(
	state: InvocationState,
	message: string,
): ParsedInvocation {
	return {
		...toParsedInvocation(state),
		parseError: usageFailure(message),
	};
}

function createBooleanFlagParser(
	flag: string,
	apply: (state: InvocationState) => void,
): InvocationFlagParser {
	return (state, index) => {
		state.usedFlags.add(flag);
		apply(state);
		return { nextIndex: index };
	};
}

function createValueFlagParser(
	flag: string,
	parse: InvocationValueParser,
): InvocationFlagParser {
	return (state, index, value) => {
		state.usedFlags.add(flag);
		if (!value || value.startsWith("--")) {
			return { nextIndex: index, error: `${flag} needs a value.` };
		}
		const error = parse(state, value);
		return error
			? { nextIndex: index, error }
			: { nextIndex: index + 1 };
	};
}

function parsePullRequestFlag(
	state: InvocationState,
	value: string,
): string | undefined {
	const parsedPr = Number.parseInt(value, 10);
	if (!/^\d+$/.test(value) || parsedPr < 1) {
		return "--pr needs a positive integer.";
	}
	state.pr = parsedPr;
	return undefined;
}

function parseLimitFlag(state: InvocationState, value: string): string | undefined {
	const parsedLimit = Number.parseInt(value, 10);
	if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
		return "--limit needs a positive integer.";
	}
	state.limit = parsedLimit;
	return undefined;
}

function parseFieldsFlag(state: InvocationState, value: string): string | undefined {
	const parsedFields = parseProjectionFields(value);
	if (!parsedFields.ok) return parsedFields.message;
	state.fields = parsedFields.fields;
	return undefined;
}

function parseSelectFlag(state: InvocationState, value: string): string | undefined {
	const parsedSelect = parseProjectionSelect(value);
	if (!parsedSelect.ok) return parsedSelect.message;
	state.select = parsedSelect.select;
	return undefined;
}

type CommandContext = {
	invocation: ParsedInvocation;
	runtime: AgentWorktreeCliRuntime;
	runId: string;
	cwd: string;
};

type CommandHandler = (
	context: CommandContext,
) => CommandResult | Promise<CommandResult>;

const COMMAND_HANDLERS = new Map<AgentWorktreeCommand, CommandHandler>([
	["commands", runCommandsCommand],
	["doctor", runDoctorCommand],
	["list", runListCommand],
	["status", runStatusCommand],
	["check", runCheckCommand],
	["create", runCreateCommand],
	["attach", runAttachCommand],
	["delete", runDeleteCommand],
	["refresh", runRefreshCommand],
	["clean", runCleanCommand],
	["recover", runRecoverCommand],
	["inspect", runInspectCommand],
	["handoff", runHandoffCommand],
]);

/**
 * Route a parsed invocation to command behavior.
 *
 * @param invocation - Parsed argv
 * @param runtime - CLI runtime
 * @param runId - Facade run id
 * @returns Command result
 *
 * @example
 * ```typescript
 * const result = await runCommand(parseInvocation(["doctor"]), createDefaultRuntime(), "r1")
 * ```
 */
export async function runCommand(
	invocation: ParsedInvocation,
	runtime: AgentWorktreeCliRuntime,
	runId: string,
): Promise<CommandResult> {
	if (invocation.parseError) return invocation.parseError;
	const command = invocation.command;
	const cwd = invocation.repo ?? runtime.cwd();
	if (!command) return usageFailure("Missing command.");
	const handler = COMMAND_HANDLERS.get(command);
	if (!handler) return usageFailure(`Unknown command '${command}'.`);

	try {
		return await handler({ invocation, runtime, runId, cwd });
	} catch (error) {
		return commandRuntimeFailure(error);
	}
}

function runCommandsCommand(): CommandResult {
	return {
		ok: true,
		data: resultData(
			"commands",
			projectCommandDiscoveryTree(agentWorktreeContractEntries),
		),
	};
}

async function runDoctorCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	return readCommandResult(
		"doctor",
		doctorData(await runDoctor({ cwd, run: runtime.run })),
		invocation,
	);
}

async function runListCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	return readCommandResult(
		"list",
		await listWorktrees({ cwd, run: runtime.run, limit: invocation.limit }),
		invocation,
	);
}

async function runStatusCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	return readCommandResult(
		"status",
		await statusWorktreeResult({
			cwd,
			run: runtime.run,
			limit: invocation.limit,
		}),
		invocation,
	);
}

async function runCheckCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const branch = invocation.positionals[0];
	if (!branch) return usageFailure("check needs <branch>.");
	return {
		ok: true,
		data: resultData(
			"check",
			await checkWorktree({ cwd, run: runtime.run, branch }),
		),
	};
}

async function runCreateCommand({
	cwd,
	runtime,
	runId,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const branch = invocation.positionals[0];
	if (!branch) return usageFailure("create needs <branch>.");
	const result = await createWorktree({
		cwd,
		run: runtime.run,
		branch,
		base: invocation.base,
		dryRun: invocation.dryRun,
		runId,
		now: runtime.now,
	});
	return lifecycleCommandResult("create", result, invocation.dryRun);
}

async function runAttachCommand({
	cwd,
	runtime,
	runId,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const validationError = validateAttachInvocation(invocation);
	if (validationError) return usageFailure(validationError);
	const result = await attachWorktree({
		cwd,
		run: runtime.run,
		ref: invocation.positionals[0],
		pr: invocation.pr,
		track: invocation.track,
		dryRun: invocation.dryRun,
		runId,
		now: runtime.now,
	});
	return lifecycleCommandResult("attach", result, invocation.dryRun);
}

function validateAttachInvocation(
	invocation: ParsedInvocation,
): string | undefined {
	const ref = invocation.positionals[0];
	if (ref && invocation.pr !== undefined) {
		return "attach accepts either <ref> or --pr, not both.";
	}
	if (invocation.track && invocation.pr === undefined) {
		return "attach --track needs --pr <n>.";
	}
	if (!ref && invocation.pr === undefined) {
		return "attach needs <ref> or --pr <n>.";
	}
	if (invocation.positionals.length > 1) {
		return "attach accepts one positional <ref>.";
	}
	return undefined;
}

async function runDeleteCommand({
	cwd,
	runtime,
	runId,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const validation = validateDeleteInvocation(invocation);
	if ("error" in validation) return usageFailure(validation.error);
	const result = await deleteWorktree({
		cwd,
		run: runtime.run,
		branch: validation.branch,
		dryRun: invocation.dryRun,
		force: invocation.force,
		deleteBranch: invocation.deleteBranch,
		runId,
		now: runtime.now,
	});
	return lifecycleCommandResult("delete", result, invocation.dryRun);
}

function validateDeleteInvocation(
	invocation: ParsedInvocation,
): { error: string } | { branch: string } {
	const branch = invocation.positionals[0];
	if (!branch) return { error: "delete needs <branch>." };
	if (!invocation.dryRun && !invocation.force) {
		return { error: "delete normal execution needs --force." };
	}
	return { branch };
}

async function runRefreshCommand({
	cwd,
	runtime,
	runId,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const result = await refreshWorktrees({
		cwd,
		run: runtime.run,
		dryRun: invocation.dryRun,
		runId,
		now: runtime.now,
	});
	return lifecycleCommandResult("refresh", result, invocation.dryRun);
}

async function runCleanCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	return readCommandResult(
		"clean",
		await cleanPreview({
			cwd,
			run: runtime.run,
			limit: invocation.limit,
		}),
		invocation,
	);
}

async function runRecoverCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const ref = invocation.ref ?? invocation.positionals[0];
	const parsedRef = ref ? parseAgentWorktreeRef(ref) : null;
	if (!ref || !parsedRef) return usageFailure("recover needs a typed ref.");
	const discovery = await discoverRepo({ cwd, run: runtime.run });
	if (!discovery.storeRoot) {
		return runtimeFailure(
			"recover needs a resolved repo store root.",
			"Repo readiness needs a repository root before recovery.",
			"none",
		);
	}
	const inspected = await inspectRefFromRoot(discovery.storeRoot, ref);
	if (!inspected?.found) {
		return runtimeFailure(
			"recover ref was not found in the durable store.",
			"Inspect current durable refs before recovery.",
			"none",
		);
	}
	const record = inspected.record as
		| { changedState?: AgentWorktreeChangedState }
		| undefined;
	return {
		ok: true,
		data: resultData(
			"recover",
			lifecycleData(
				recoverPreview({
					ref,
					changedState: record?.changedState,
					failureRef:
						parsedRef.kind === "failure" ? parsedRef : undefined,
				}),
			),
		),
	};
}

async function runInspectCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const ref = invocation.ref ?? invocation.positionals[0];
	if (!ref) return usageFailure("inspect needs a typed ref.");
	if (!parseAgentWorktreeRef(ref)) {
		return usageFailure("inspect needs a supported typed ref.");
	}
	const discovery = await discoverRepo({ cwd, run: runtime.run });
	if (!discovery.storeRoot) {
		return runtimeFailure(
			"inspect needs a resolved repo store root.",
			"Repo readiness needs a repository root before ref inspection.",
			"none",
		);
	}
	const inspected = await inspectRefFromRoot(discovery.storeRoot, ref);
	if (!inspected) return usageFailure("inspect needs a supported typed ref.");
	return { ok: true, data: resultData("inspect", inspected) };
}

async function runHandoffCommand({
	cwd,
	runtime,
	invocation,
}: CommandContext): Promise<CommandResult> {
	const discovery = await discoverRepo({ cwd, run: runtime.run });
	if (!discovery.storeRoot) {
		return runtimeFailure(
			"handoff needs a resolved repo store root.",
			"Repo readiness needs a repository root before handoff.",
			"none",
		);
	}
	return readCommandResult(
		"handoff",
		await buildHandoffSnapshot(discovery.storeRoot, {
			limit: invocation.limit,
		}),
		invocation,
	);
}

function commandRuntimeFailure(error: unknown): CommandResult {
	return {
		ok: false,
		exitCode: 1,
		code: "runtime_error",
		message: error instanceof Error ? error.message : "Command failed.",
		action: "Inspect repo readiness and durable state before retry.",
		changedState: "unknown",
	};
}

function usageFailure(message: string): CommandResult {
	return {
		ok: false,
		exitCode: 2,
		code: "usage_error",
		message,
		action: "Review command help and retry with supported arguments.",
		changedState: "none",
	};
}

function runtimeFailure(
	message: string,
	action: string,
	changedState: AgentWorktreeChangedState,
	data?: Record<string, unknown>,
	code: AgentWorktreeDiagnosticCode = "runtime_error",
): CommandResult {
	return {
		ok: false,
		exitCode: 1,
		code,
		message,
		action,
		changedState,
		data,
	};
}

function lifecycleCommandResult(
	command: AgentWorktreeCommand,
	result: LifecycleResult,
	previewAllowed: boolean,
): CommandResult {
	const data = lifecycleData(result);
	if (result.changedState === "complete" || (previewAllowed && result.preview)) {
		return {
			ok: true,
			data: resultData(command, data),
			changedState: result.changedState,
		};
	}
	const diagnostic =
		result.reason === "gh_not_found"
			? {
					code: "gh_not_found" as const,
					action:
						"Install GitHub CLI (gh), then inspect the created worktree before retrying.",
				}
			: result.reason === "gh_pr_checkout_failed"
				? {
						code: "gh_pr_checkout_failed" as const,
						action:
							"Inspect the failure ref and GitHub CLI authentication or pull request state before retrying.",
					}
				: {
						code: "runtime_error" as const,
						action: `Follow lifecycle recovery action: ${result.nextSafeAction}.`,
					};
	return runtimeFailure(
		result.reason
			? `Lifecycle ${result.action} did not complete: ${result.reason}.`
			: `Lifecycle ${result.action} did not complete.`,
		diagnostic.action,
		result.changedState,
		data,
		diagnostic.code,
	);
}

function readCommandResult<TData extends object>(
	command: ContextHeavyReadCommand,
	data: CommandResultPayload<TData>,
	invocation: ParsedInvocation,
): CommandResult {
	const projected = projectReadData(command, resultData(command, data), invocation);
	if (!projected.ok) return usageFailure(projected.message);
	return { ok: true, data: projected.data };
}

function projectReadData(
	command: ContextHeavyReadCommand,
	data: Record<string, unknown>,
	invocation: ParsedInvocation,
):
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; message: string } {
	if (!invocation.fields && !invocation.select) return { ok: true, data };

	const keys = new Set<string>(PROJECTION_METADATA_KEYS);
	for (const fieldSet of invocation.fields ?? []) {
		for (const key of READ_PROJECTION_KEYS[command][fieldSet]) {
			keys.add(key);
		}
	}

	for (const key of invocation.select ?? []) {
		if (!(key in data)) {
			return {
				ok: false,
				message: `--select field '${key}' is not present in agent-worktree ${command} output.`,
			};
		}
		keys.add(key);
	}

	return {
		ok: true,
		data: pickExistingKeys(data, keys),
	};
}

function pickExistingKeys(
	data: Record<string, unknown>,
	keys: Iterable<string>,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const key of keys) {
		if (key in data) output[key] = data[key];
	}
	return output;
}

function parseProjectionFields(
	value: string,
):
	| { ok: true; fields: readonly ProjectionFieldSet[] }
	| { ok: false; message: string } {
	const fields = value
		.split(",")
		.map((field) => field.trim())
		.filter(Boolean);
	if (fields.length === 0) {
		return { ok: false, message: "--fields needs at least one field set." };
	}
	const invalid = fields.find((field) => !PROJECTION_FIELD_SET_VALUES.has(field));
	if (invalid) {
		return {
			ok: false,
			message: `Unsupported --fields value '${invalid}'. Use ${PROJECTION_FIELD_SETS.join(", ")}.`,
		};
	}
	return {
		ok: true,
		fields: [...new Set(fields)] as readonly ProjectionFieldSet[],
	};
}

function parseProjectionSelect(
	value: string,
):
	| { ok: true; select: readonly string[] }
	| { ok: false; message: string } {
	const select = value
		.split(",")
		.map((field) => field.trim())
		.filter(Boolean);
	if (select.length === 0) {
		return { ok: false, message: "--select needs at least one field." };
	}
	const invalid = select.find((field) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(field));
	if (invalid) {
		return {
			ok: false,
			message:
				"--select accepts comma-separated top-level JSON field names.",
		};
	}
	return { ok: true, select: [...new Set(select)] };
}

function doctorData(data: DoctorMap): AgentWorktreeDoctorData {
	const blockers = [...new Set(data.checks.flatMap((check) => check.blockers))];
	return {
		summary: {
			status: data.status,
			repo_root: data.repo.gitRoot,
			isolation: data.repo.isolation,
			main_owner_root: data.repo.mainOwnerRoot,
			active_worktree: data.repo.activeWorktree,
			current_branch: data.repo.currentBranch,
			default_branch: data.repo.defaultBranch,
			store_root: data.repo.storeRoot,
			linked_worktree_count: data.repo.linkedWorktreeCount,
			stale_dir_count: data.repo.staleDirCount,
			stray_worktree_count: data.repo.strayWorktreeCount,
			available_commands: data.availableCommands,
		},
		checks: data.checks.map((check) => ({
			id: check.id,
			owner: check.owner,
			status: check.status,
			summary: check.summary,
			blockers: check.blockers,
			next_actions: check.nextActions,
		})),
		mutation_readiness: data.mutationReadiness,
		blockers,
		next_actions: [...new Set(data.nextActions)],
	};
}

function resultData<TData extends object>(
	command: AgentWorktreeCommand,
	data: CommandResultPayload<TData>,
): Record<string, unknown> {
	return createCommandResultData(
		agentWorktreeContracts[command] as {
			resultContract?: CommandFacadeResultContract;
		},
		data,
	);
}

function lifecycleResultData<TData extends object>(
	data: CommandResultPayload<TData>,
): Record<string, unknown> {
	return createCommandResultData(
		{ resultContract: agentWorktreeLifecycleResultContract },
		data,
	);
}

function lifecycleData(result: LifecycleResult): AgentWorktreeLifecycleData {
	return {
		action: result.action,
		changed_state: result.changedState,
		preview: result.preview,
		run_ref: result.runRef,
		failure_ref: result.failureRef,
		changes: result.changes,
		next_safe_action: result.nextSafeAction,
		reason: result.reason,
		recovery: result.recovery,
		backup_ref: result.backupRef,
		resolved_ref: result.resolvedRef,
		target_path: result.targetPath,
		mode: result.mode,
		existing_checkout_path: result.existingCheckoutPath,
	};
}

function isAgentWorktreeCommand(value: string): value is AgentWorktreeCommand {
	return AGENT_WORKTREE_COMMANDS.includes(value as AgentWorktreeCommand);
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
