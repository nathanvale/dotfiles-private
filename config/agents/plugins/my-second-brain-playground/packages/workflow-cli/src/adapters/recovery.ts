// Recovery Adapter: the private binding and marker bytes at their documented session-keyed addresses, plus the
// locked section every write runs in. It never reads or writes the schema-v2 Python addresses under
// my-second-brain-playground/recovery/sessions/, and never spawns the preserved Python launcher.

import { lstatSync } from "node:fs"
import type { Stats } from "node:fs"
import { parseClosedJsonBytes } from "../closed-json.ts"
import { type CompactionMarker, emptyMarker, MARKER_LIMIT_BYTES, parseMarker } from "../compaction-marker.ts"
import type { LockAdapter } from "../lock-adapter.ts"
import type { RecoveryBinding } from "../model.ts"
import { BINDING_LIMIT_BYTES, validateBinding } from "../recovery.ts"
import { assertPrivateAncestors, type AtomicWriteHooks, atomicWritePrivate, privateEntryExists, readPrivateFile, RuntimeFailure, stateAddresses, withLocks, withSessionLock } from "../runtime.ts"

export type BindingRead =
	| { readonly status: "absent" }
	| { readonly status: "available"; readonly binding: RecoveryBinding; readonly stale: boolean; readonly bytes: Buffer }
	| { readonly status: "invalid"; readonly reason: string; readonly bytes: Buffer }
	| { readonly status: "unsafe"; readonly reason: string }
	| { readonly status: "unavailable"; readonly reason: string }

export type MarkerRead = { readonly status: "available"; readonly marker: CompactionMarker } | { readonly status: "invalid" | "unsafe" | "unavailable"; readonly reason: string }

export interface LockFileCheck {
	readonly path: string
	readonly status: "absent" | "safe" | "unsafe"
	readonly reason: string | null
}

export interface RecoveryStore {
	readonly stateHome: string
	readonly platform: string
	bindingPath(sessionIdentity: string): string
	markerPath(sessionIdentity: string): string
	readBinding(sessionIdentity: string, nowMilliseconds: number): BindingRead
	writeBinding(binding: RecoveryBinding): void
	readMarker(sessionIdentity: string): MarkerRead
	writeMarker(marker: CompactionMarker): void
	/** The binding write: workspace lock, then session lock. */
	withLocks<T>(workspace: string, sessionIdentity: string, action: () => Promise<T>): Promise<T>
	/** The marker read-decide-write sections: the session lock alone. */
	withSessionLock<T>(sessionIdentity: string, action: () => Promise<T>): Promise<T>
	checkLockFiles(workspace: string, sessionIdentity: string): readonly LockFileCheck[]
}

/** Fault seams for the two write outcomes; production composes none. */
export interface RecoveryStoreHooks {
	readonly bindingWrite?: AtomicWriteHooks
}

function classify(error: unknown): Extract<BindingRead, { status: "unsafe" | "unavailable" }> {
	if (error instanceof RuntimeFailure && error.kind === "unsafe") return { status: "unsafe", reason: error.message }
	return { status: "unavailable", reason: error instanceof Error ? error.message : "private state read failed" }
}

function lockFileCheck(path: string): LockFileCheck {
	let stat: Stats
	try {
		stat = lstatSync(path)
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? { path, status: "absent", reason: null } : { path, status: "unsafe", reason: "not accessible" }
	}
	const uid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid
	if (stat.isSymbolicLink() || !stat.isFile()) return { path, status: "unsafe", reason: "not a regular file" }
	if (stat.uid !== uid) return { path, status: "unsafe", reason: "not owned by the effective user" }
	if ((stat.mode & 0o777) !== 0o600) return { path, status: "unsafe", reason: "mode is not 0600" }
	if (stat.nlink !== 1) return { path, status: "unsafe", reason: "more than one link" }
	return { path, status: "safe", reason: null }
}

export function createRecoveryStore(stateHome: string, lockAdapter: LockAdapter, hooks: RecoveryStoreHooks = {}): RecoveryStore {
	const addresses = stateAddresses(stateHome)
	const readPrivate = (path: string, limit: number): Buffer | null => {
		// Ancestors are verified read-only before the file: an absent (ENOENT) helper directory means an absent record, never
		// a write. Any other failure to reach it (EACCES, ELOOP, ENOTDIR) throws and is classified unavailable or unsafe,
		// so a binding that exists but cannot be read is never reported absent.
		if (!privateEntryExists(addresses.sessions)) return null
		assertPrivateAncestors(stateHome, addresses.sessions)
		return readPrivateFile(path, limit)
	}
	return {
		stateHome,
		platform: lockAdapter.platform,
		bindingPath: addresses.binding,
		markerPath: addresses.marker,
		readBinding(sessionIdentity, nowMilliseconds) {
			let bytes: Buffer | null
			try {
				bytes = readPrivate(addresses.binding(sessionIdentity), BINDING_LIMIT_BYTES)
			} catch (error) {
				return classify(error)
			}
			if (bytes === null) return { status: "absent" }
			try {
				const validated = validateBinding(parseClosedJsonBytes(bytes, BINDING_LIMIT_BYTES), nowMilliseconds)
				if (validated.binding.sessionIdentity !== sessionIdentity) return { status: "invalid", reason: "binding sessionIdentity does not match its address", bytes }
				return { status: "available", binding: validated.binding, stale: validated.stale, bytes }
			} catch (error) {
				return { status: "invalid", reason: error instanceof Error ? error.message : "binding schema is invalid", bytes }
			}
		},
		writeBinding(binding) {
			atomicWritePrivate(stateHome, addresses.binding(binding.sessionIdentity), `${JSON.stringify(binding)}\n`, hooks.bindingWrite ?? {})
		},
		readMarker(sessionIdentity) {
			let bytes: Buffer | null
			try {
				bytes = readPrivate(addresses.marker(sessionIdentity), MARKER_LIMIT_BYTES)
			} catch (error) {
				return classify(error)
			}
			if (bytes === null) return { status: "available", marker: emptyMarker(sessionIdentity) }
			try {
				return { status: "available", marker: parseMarker(parseClosedJsonBytes(bytes, MARKER_LIMIT_BYTES), sessionIdentity) }
			} catch (error) {
				return { status: "invalid", reason: error instanceof Error ? error.message : "marker schema is invalid" }
			}
		},
		writeMarker(marker) {
			atomicWritePrivate(stateHome, addresses.marker(marker.sessionIdentity), `${JSON.stringify(marker)}\n`)
		},
		withLocks: (workspace, sessionIdentity, action) => withLocks(stateHome, lockAdapter, workspace, sessionIdentity, action),
		withSessionLock: (sessionIdentity, action) => withSessionLock(stateHome, lockAdapter, sessionIdentity, action),
		checkLockFiles: (workspace, sessionIdentity) => [lockFileCheck(addresses.workspaceLock(workspace)), lockFileCheck(addresses.sessionLock(sessionIdentity))],
	}
}
