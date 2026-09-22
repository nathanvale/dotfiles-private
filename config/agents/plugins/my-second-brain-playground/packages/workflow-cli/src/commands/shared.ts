// Shared command plumbing: the dependency seam every command body crosses, session and workspace resolution, the
// store gate, and the small outcome constructors. Station names here must exist in the Branch Station catalog.

import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { type BeadRead, type BeadsReader, PINNED_BD_REVISION, PINNED_BD_VERSION, type StoreRead } from "../adapters/beads.ts"
import type { RecoveryStore } from "../adapters/recovery.ts"
import { HELP_ACTION } from "../command-contract.ts"
import type { Diagnostics, DiagnosticsContext } from "../diagnostics.ts"
import type { CommandOutcome, JsonObject } from "../model.ts"
import { SESSION_PATTERN } from "../recovery.ts"

export type Environment = Readonly<Record<string, string | undefined>>

/** The one private state root a process may use, or the reason no root may be used; there is never a fallback. */
export type StateRoot = { readonly status: "selected"; readonly path: string } | { readonly status: "refused"; readonly reason: string }

export interface CommandContext {
	readonly runIdentity: string
	readonly cwd: string
	readonly env: Environment
	readonly platform: string
	readonly now: () => Date
	readonly stateRoot: StateRoot
	readonly openStore: (stateHome: string) => RecoveryStore
	readonly openBeads: (executable: string, workspace: string, cwd: string) => BeadsReader
	readonly gitTopLevel: (cwd: string) => Promise<string | null>
	readonly openDiagnostics: (context: DiagnosticsContext) => Diagnostics
}

export function refusal(station: string, message: string, repairAction: string, nextAction: string, result: JsonObject = {}): CommandOutcome {
	return { station, message, result: { station, ...result }, repairAction, nextAction, availablePaths: [], handoffPrerequisites: [] }
}

export function success(station: string, message: string, result: JsonObject, nextAction: string | null): CommandOutcome {
	return { station, message, result: { station, ...result }, repairAction: null, nextAction, availablePaths: [], handoffPrerequisites: [] }
}

export function internalFailure(): CommandOutcome {
	return { station: "internal-failure", message: "unexpected internal failure before any durable write", result: { station: "internal-failure" }, repairAction: "Report the run identity to the helper owner; nothing was written", nextAction: null, availablePaths: [], handoffPrerequisites: ["Inspect the workspace and session with msb-workflow inspect", "Report the run identity to the helper owner"] }
}

export type SessionResolution = { readonly status: "resolved"; readonly session: string; readonly source: "explicit" | "environment" } | { readonly status: "missing" } | { readonly status: "invalid"; readonly value: string } | { readonly status: "conflict" }

/** --session or CODEX_SESSION_ID; both present and different refuses; an empty environment value counts as absent. */
export function resolveSession(explicit: string | null, env: Environment): SessionResolution {
	const inherited = env.CODEX_SESSION_ID !== undefined && env.CODEX_SESSION_ID.length > 0 ? env.CODEX_SESSION_ID : null
	if (explicit !== null && inherited !== null && explicit !== inherited) return { status: "conflict" }
	const value = explicit ?? inherited
	if (value === null) return { status: "missing" }
	if (!SESSION_PATTERN.test(value)) return { status: "invalid", value }
	return { status: "resolved", session: value, source: explicit !== null ? "explicit" : "environment" }
}

export function sessionOutcome(resolution: Exclude<SessionResolution, { status: "resolved" }>): CommandOutcome {
	if (resolution.status === "conflict") return refusal("session-conflict", "--session and CODEX_SESSION_ID disagree", "Pass the session identity of this Harness session once, through --session or CODEX_SESSION_ID, not two different values", HELP_ACTION)
	if (resolution.status === "invalid") return refusal("session-invalid", "the session token does not match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", "Pass the Harness session identity exactly as the Harness reports it", HELP_ACTION)
	return refusal("usage-refused", "--session or CODEX_SESSION_ID is required", `Pass --session <id> or export CODEX_SESSION_ID, then repeat the command; see ${HELP_ACTION}`, HELP_ACTION)
}

/** The workspace must be an existing canonical absolute directory; nothing is resolved against the working directory. */
export function canonicalWorkspace(workspace: string): string | null {
	if (!isAbsolute(workspace) || /[\0\r\n]/.test(workspace)) return null
	try {
		const real = realpathSync(workspace)
		return real === workspace && statSync(real).isDirectory() ? real : null
	} catch {
		return null
	}
}

export function workspaceOutcome(workspace: string): CommandOutcome {
	return refusal("workspace-refused", `workspace ${workspace} is not an existing canonical absolute directory`, "Pass the canonical absolute path of the directory whose .beads store is selected", HELP_ACTION, { workspace })
}

export function stateRootOutcome(reason: string): CommandOutcome {
	return refusal("state-root-refused", reason, "Configure MSB_WORKFLOW_STATE_HOME (or XDG_STATE_HOME) as one existing absolute directory you own, then repeat the command", HELP_ACTION)
}

export function isGitRepository(cwd: string): boolean {
	let current = cwd
	for (;;) {
		if (existsSync(join(current, ".git"))) return true
		const parent = join(current, "..")
		if (realpathSafe(parent) === realpathSafe(current)) return false
		current = parent
	}
}

function realpathSafe(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

/** The store gate as an outcome, shared by bind and recover; null means the store verified. */
export function storeOutcome(read: StoreRead, workspace: string): CommandOutcome | null {
	if (read.status === "verified") return null
	if (read.status === "executable-invalid") return refusal("executable-refused", read.reason, `Set MSB_WORKFLOW_BD_EXECUTABLE to the absolute path of the pinned bd ${PINNED_BD_VERSION} executable and bind again`, `msb-workflow inspect --workspace ${workspace}`, { reason: read.reason })
	if (read.status === "mismatch") return refusal("store-mismatch", read.reason, `Select the workspace whose .beads store is the intended one and the pinned bd ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}; a wrong, empty, global, or redirected store is never adopted`, `msb-workflow inspect --workspace ${workspace}`, { reason: read.reason })
	return { station: "beads-unavailable", message: read.reason, result: { station: "beads-unavailable", reason: read.reason }, repairAction: "Check that the selected .beads store exists and no other bd process holds it, then retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace}`, availablePaths: [], handoffPrerequisites: [] }
}

export function beadOutcome(read: BeadRead, beadId: string, workspace: string): CommandOutcome | null {
	if (read.status === "found") return null
	if (read.status === "missing") return refusal("bead-missing", `Bead ${beadId} is not in the selected store: ${read.reason}`, `Check the Bead identifier ${beadId} with BEADS_DIR=${join(workspace, ".beads")} bd list --readonly --json, then bind the correct one`, `msb-workflow inspect --workspace ${workspace}`, { beadId, reason: read.reason })
	return { station: "beads-unavailable", message: read.reason, result: { station: "beads-unavailable", reason: read.reason, beadId }, repairAction: "Check that the selected .beads store exists and no other bd process holds it, then retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace}`, availablePaths: [], handoffPrerequisites: [] }
}

export function unavailableOutcome(reason: string, workspace: string): CommandOutcome {
	return { station: "beads-unavailable", message: reason, result: { station: "beads-unavailable", reason }, repairAction: "Check that the selected .beads store exists and no other bd process holds it, then retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace}`, availablePaths: [], handoffPrerequisites: [] }
}

export function stateUnsafeOutcome(reason: string, workspace: string): CommandOutcome {
	return refusal("state-unsafe", reason, "Repair the named private state entry (owner, mode 0600/0700, no symlink, one link) or remove it, then repeat the command", `msb-workflow inspect --workspace ${workspace}`, { reason })
}

export function bindingInvalidOutcome(reason: string, path: string, workspace: string, session: string): CommandOutcome {
	return refusal("binding-invalid", `saved binding is not schema v3: ${reason}`, `Move or delete ${path} after reading it, then bind again; the helper never rewrites a malformed binding`, `msb-workflow bind --workspace ${workspace} --bead <bead-id> --session ${session}`, { reason, bindingPath: path })
}
