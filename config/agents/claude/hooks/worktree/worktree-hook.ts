// Claude Code WorktreeCreate / WorktreeRemove hook logic.
//
// Claude Code defaults to `<repo>/.claude/worktrees/<name>`. These hooks route
// creation and removal through the shared agent-worktree runtime CLI so every
// harness lands checkouts at `<repo>/.worktrees/<name>` with the same branch
// naming, Codex registration, and dirty or unmerged refusal.
//
// The runtime is driven as a subprocess, not imported: the hooks compile under
// the root tsconfig, the runtime under its own relaxed one, and the CLI's JSON
// envelope is the runtime's public contract anyway.
//
// Claude Code contract: https://code.claude.com/docs/en/hooks (WorktreeCreate
// prints the path as the last stdout line and a name whose checkout already
// exists reopens it; WorktreeRemove reports through exit status).

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const RUNTIME_CLI = join(
	realpathSync(import.meta.dir),
	"../../../../../.agents/runtime/agent-worktree/src/cli.ts",
);

/**
 * Hook stdin payload fields used by both events.
 */
export interface WorktreeHookPayload {
	/** Invocation directory reported by Claude Code. */
	cwd: string;
	/** Worktree name for WorktreeCreate. */
	name?: string;
	/** Absolute worktree path for WorktreeRemove. */
	worktree_path?: string;
}

/**
 * Hook outcome: `path` is the stdout contract for create; `message` is stderr.
 */
export type WorktreeHookOutcome =
	| { ok: true; path: string }
	| { ok: false; message: string };

interface RuntimeWorktree {
	path: string;
	branch?: string;
}

interface RuntimeEnvelope {
	status?: string;
	data?: {
		changed_state?: string;
		reason?: string;
		target_path?: string;
		worktrees?: RuntimeWorktree[];
		mainOwnerRoot?: string;
	};
	error?: { message?: string };
}

type RuntimeRun =
	| { ok: true; envelope: RuntimeEnvelope }
	| { ok: false; reason: string; message: string };

interface RepoListing {
	worktrees: RuntimeWorktree[];
	/** Main checkout that owns `.worktrees/`; falls back to the hook cwd. */
	mainOwnerRoot: string;
}

/**
 * Parse the hook stdin payload.
 *
 * @param raw - Raw stdin text
 * @returns Parsed payload
 * @throws Error when the payload is not a JSON object with a string `cwd`
 *
 * @example
 * ```typescript
 * parseWorktreeHookPayload('{"cwd":"/repo","name":"feat"}')
 * ```
 */
export function parseWorktreeHookPayload(raw: string): WorktreeHookPayload {
	const value: unknown = JSON.parse(raw);
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as { cwd?: unknown }).cwd !== "string"
	) {
		throw new Error("hook payload must be a JSON object with a string cwd");
	}
	return value as WorktreeHookPayload;
}

/**
 * Create, or reopen, the worktree `<repo>/.worktrees/<name>` on branch `<name>`.
 *
 * The runtime is always driven from the main checkout, so the hook works from
 * inside a linked worktree too. The new branch is based on the remote default
 * branch when the repo has one, which mirrors Claude Code's own
 * `worktree.baseRef: "fresh"` except that nothing is fetched first.
 *
 * @param payload - Hook payload with `cwd` and `name`
 * @returns Created or reopened path, or the runtime's refusal reason
 *
 * @example
 * ```typescript
 * const outcome = createWorktreeFromHook({ cwd: "/repo", name: "feat" })
 * ```
 */
export function createWorktreeFromHook(
	payload: WorktreeHookPayload,
): WorktreeHookOutcome {
	if (!payload.name) {
		return { ok: false, message: "WorktreeCreate payload has no name." };
	}
	const listed = listWorktrees(payload.cwd);
	if (!listed.ok) return listed;
	const { mainOwnerRoot } = listed.listing;
	const base = remoteDefaultBranch(mainOwnerRoot);
	const created = runRuntime(
		["create", payload.name, ...(base ? ["--base", base] : [])],
		mainOwnerRoot,
	);
	if (created.ok) {
		const path = created.envelope.data?.target_path;
		return path
			? { ok: true, path }
			: {
					ok: false,
					message: "agent-worktree create completed without a target_path.",
				};
	}
	if (created.reason === "branch_already_checked_out") {
		const existing = listed.listing.worktrees.find(
			(worktree) => worktree.branch === payload.name,
		);
		// Same owned-prefix rule as the runtime's findStrayWorktrees; restated
		// here only because the hook drives the runtime as a subprocess.
		if (existing?.path.startsWith(`${join(mainOwnerRoot, ".worktrees")}/`)) {
			return { ok: true, path: existing.path };
		}
	}
	return created;
}

/**
 * Remove the registered worktree at `worktree_path` and its branch.
 *
 * The runtime's `--force` is its destructive confirmation, which Claude Code
 * has already given by firing this hook. Its branch-safety check still refuses
 * a dirty checkout or commits main lacks, so unfinished work is preserved.
 *
 * @param payload - Hook payload with `cwd` and `worktree_path`
 * @returns Removed path, or the runtime's refusal reason
 *
 * @example
 * ```typescript
 * const outcome = removeWorktreeFromHook({ cwd: "/repo", worktree_path: "/repo/.worktrees/feat" })
 * ```
 */
export function removeWorktreeFromHook(
	payload: WorktreeHookPayload,
): WorktreeHookOutcome {
	if (!payload.worktree_path) {
		return { ok: false, message: "WorktreeRemove payload has no worktree_path." };
	}
	const targetPath = canonicalPath(payload.worktree_path);
	const listed = listWorktrees(payload.cwd);
	if (!listed.ok) return listed;
	const target = listed.listing.worktrees.find(
		(worktree) => canonicalPath(worktree.path) === targetPath,
	);
	if (!target) {
		return {
			ok: false,
			message: `worktree remove refused: ${payload.worktree_path} is not a registered worktree.`,
		};
	}
	if (!target.branch) {
		return {
			ok: false,
			message: `worktree remove refused: ${payload.worktree_path} is detached; remove it with git worktree remove.`,
		};
	}
	// Run from the main owner so git never removes the directory it runs in.
	const removed = runRuntime(
		["delete", target.branch, "--force", "--delete-branch"],
		listed.listing.mainOwnerRoot,
	);
	return removed.ok ? { ok: true, path: target.path } : removed;
}

/**
 * Run one hook end to end: stdin payload in, stdout path or stderr reason out.
 *
 * @param event - Which hook event to serve
 * @param raw - Raw stdin text
 * @param io - Output sinks
 * @returns Process exit code (0 success, 1 refusal or failure)
 *
 * @example
 * ```typescript
 * process.exit(runWorktreeHook("create", await Bun.stdin.text(), { stdout: console.log, stderr: console.error }))
 * ```
 */
export function runWorktreeHook(
	event: "create" | "remove",
	raw: string,
	io: { stdout: (line: string) => void; stderr: (line: string) => void },
): number {
	let outcome: WorktreeHookOutcome;
	try {
		const payload = parseWorktreeHookPayload(raw);
		outcome =
			event === "create"
				? createWorktreeFromHook(payload)
				: removeWorktreeFromHook(payload);
	} catch (error) {
		outcome = {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
	if (!outcome.ok) {
		io.stderr(`Worktree ${event} hook failed: ${outcome.message}`);
		return 1;
	}
	if (event === "create") io.stdout(outcome.path);
	return 0;
}

function runRuntime(args: readonly string[], cwd: string): RuntimeRun {
	const result = Bun.spawnSync([process.execPath, RUNTIME_CLI, ...args, "--json"], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout);
	let envelope: RuntimeEnvelope;
	try {
		envelope = JSON.parse(stdout) as RuntimeEnvelope;
	} catch {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		return {
			ok: false,
			reason: "no_envelope",
			message: `agent-worktree ${args[0]} produced no JSON envelope (exit ${result.exitCode}): ${stderr || stdout.trim()}`,
		};
	}
	if (envelope.status !== "ok") {
		const reason = envelope.data?.reason ?? envelope.error?.message ?? "unknown";
		return {
			ok: false,
			reason,
			message: `agent-worktree ${args[0]} refused (${reason}).`,
		};
	}
	return { ok: true, envelope };
}

function listWorktrees(
	cwd: string,
): { ok: true; listing: RepoListing } | { ok: false; message: string } {
	const listed = runRuntime(["list"], cwd);
	if (!listed.ok) return listed;
	return {
		ok: true,
		listing: {
			worktrees: listed.envelope.data?.worktrees ?? [],
			mainOwnerRoot: listed.envelope.data?.mainOwnerRoot ?? cwd,
		},
	};
}

function remoteDefaultBranch(repoRoot: string): string | undefined {
	const result = Bun.spawnSync(
		["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		{ cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	if (result.exitCode !== 0) return undefined;
	const ref = new TextDecoder().decode(result.stdout).trim();
	return ref || undefined;
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}
