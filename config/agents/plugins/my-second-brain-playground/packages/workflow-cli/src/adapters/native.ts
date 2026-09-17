// Production composition: the one validated private state root, the Beads read Adapter over the accepted bd pin, the
// Recovery Adapter over the admitted Lock Adapter, the Git read, and the Diagnostics Module. Production always
// composes native owners; tests reach the same runCli through this seam with faulted stores, or with the fixture bd
// pinned to its own bytes by a test-owned openBeads (tests/fixtures/checker/fixture-context.ts).

import { randomUUID } from "node:crypto"
import { lstatSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { CommandContext, Environment, StateRoot } from "../commands/shared.ts"
import { openDiagnostics } from "../diagnostics.ts"
import { lockAdapterFor } from "../lock-adapter.ts"
import { type BeadsPin, createBeadsReader } from "./beads.ts"
import { gitTopLevel } from "./git.ts"
import { createRecoveryStore, type RecoveryStoreHooks } from "./recovery.ts"

/** Ticket #58: the accepted native Beads executable. Any other path or digest refuses before any bd read. */
const PRODUCTION_BD_PIN: BeadsPin = { executable: "/Users/nathanvale/.local/state/trustworthy-engineering-loop-prototype/beads/bd", sha256: "9581d8bcd9662ccf9d889ee8d879787e32cd4c0249d93374eeac5044e9f24351" }

// The configured root is validated as written: no normalization, no symlink resolution, no creation. Ancestors may be
// symlinks (macOS temp roots live under /var -> /private/var); the root entry itself must be a real owned directory.
function stateRootIssue(configured: string): string | null {
	if (configured.length === 0) return "the configured state root must be nonempty"
	if (!isAbsolute(configured) || /[\0\r\n]/.test(configured)) return "the configured state root must be an absolute path"
	let stat: ReturnType<typeof lstatSync>
	try {
		stat = lstatSync(configured)
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? "the configured state root does not exist" : "the configured state root is not accessible"
	}
	if (stat.isSymbolicLink()) return "the configured state root must not be a symbolic link"
	if (!stat.isDirectory()) return "the configured state root must be a directory"
	if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) return "the configured state root must be owned by the effective user"
	return null
}

/** Selects MSB_WORKFLOW_STATE_HOME, else XDG_STATE_HOME, else $HOME/.local/state; an explicit value is never skipped. */
function selectStateRoot(env: Environment): StateRoot {
	const configured = env.MSB_WORKFLOW_STATE_HOME ?? env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state")
	const issue = stateRootIssue(configured)
	return issue === null ? { status: "selected", path: configured } : { status: "refused", reason: issue }
}

export interface CompositionOptions {
	readonly platform?: string | undefined
	readonly storeHooks?: RecoveryStoreHooks | undefined
}

/** The dependencies runCli needs; runIdentity is generated first so every record carries it. */
export function productionContext(env: Environment, cwd: string, options: CompositionOptions = {}): CommandContext {
	const platform = options.platform ?? process.platform
	return {
		runIdentity: `run-${randomUUID()}`,
		cwd,
		env,
		platform,
		now: () => new Date(),
		stateRoot: selectStateRoot(env),
		openStore: (stateHome) => createRecoveryStore(stateHome, lockAdapterFor(platform), options.storeHooks ?? {}),
		openBeads: (executable, workspace, processCwd) => createBeadsReader({ executable, workspace, cwd: processCwd, pin: PRODUCTION_BD_PIN }),
		gitTopLevel,
		openDiagnostics,
	}
}
