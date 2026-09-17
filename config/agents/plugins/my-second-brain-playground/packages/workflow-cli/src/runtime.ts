// Runtime Module: the private state addresses, descriptor-stable private reads, atomic private writes, and the
// workspace-before-session lock ordering over the Lock Adapter. Every durable byte this helper owns passes through
// this Module. The private root arrives already selected and validated; nothing here derives a root of its own.

import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import type { Stats } from "node:fs"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { type LockAdapter, LockFailure } from "./lock-adapter.ts"

export type RuntimeFailureKind = "busy" | "unsafe" | "unavailable" | "unsupported" | "uncertain"

export class RuntimeFailure extends Error {
	constructor(
		readonly kind: RuntimeFailureKind,
		message: string,
	) {
		super(message)
	}
}

const HELPER_SEGMENTS = ["my-second-brain-playground", "workflow-cli"] as const

function identityKey(identity: string): string {
	return createHash("sha256").update(identity).digest("hex")
}

/** The fixed private addresses under one state root. Bindings and markers are keyed by session as the Python owner was. */
export function stateAddresses(stateHome: string) {
	const helper = join(stateHome, ...HELPER_SEGMENTS)
	const sessions = join(helper, "recovery", "sessions")
	const locks = join(helper, "locks")
	return {
		helper,
		sessions,
		diagnostics: join(helper, "diagnostics"),
		binding: (sessionIdentity: string): string => join(sessions, `${sessionIdentity}.json`),
		marker: (sessionIdentity: string): string => join(sessions, `${sessionIdentity}.marker.json`),
		workspaceLock: (workspace: string): string => join(locks, "workspaces", `${identityKey(workspace).slice(0, 32)}.lock`),
		sessionLock: (sessionIdentity: string): string => join(locks, "sessions", `${identityKey(sessionIdentity).slice(0, 32)}.lock`),
	}
}

function currentUid(): number | null {
	return typeof process.geteuid === "function" ? process.geteuid() : null
}

function assertOwned(stat: Stats, path: string): void {
	const uid = currentUid()
	if (uid !== null && stat.uid !== uid) throw new RuntimeFailure("unsafe", `${path} is not owned by the effective user`)
}

function assertDirectory(path: string): void {
	let stat: Stats
	try {
		stat = lstatSync(path)
	} catch {
		throw new RuntimeFailure("unavailable", `${path} is not accessible`)
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RuntimeFailure("unsafe", `${path} is not a real directory`)
	assertOwned(stat, path)
	if ((stat.mode & 0o777) !== 0o700) throw new RuntimeFailure("unsafe", `${path} must have mode 0700`)
}

/** Creates only descendants of the selected private state root as 0700 and refuses unsafe existing ancestors. The
 * root itself must exist and be owned; its mode is the operator's (a shared XDG state home is commonly 0755). */
function ensurePrivateDirectory(stateHome: string, path: string): void {
	if (!isAbsolute(stateHome) || stateHome.length === 0) throw new RuntimeFailure("unsafe", "the configured state root must be a nonempty absolute path")
	const root = resolve(stateHome)
	const target = resolve(path)
	if (target === root || !target.startsWith(`${root}${sep}`)) throw new RuntimeFailure("unsafe", "private state path escaped the selected state root")
	let rootStat: Stats
	try {
		rootStat = lstatSync(root)
	} catch {
		throw new RuntimeFailure("unavailable", `${root} is not accessible`)
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new RuntimeFailure("unsafe", `${root} is not a real directory`)
	assertOwned(rootStat, root)
	let current = root
	for (const segment of target.slice(root.length + 1).split(sep)) {
		current = join(current, segment)
		if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
		assertDirectory(current)
	}
}

/** Read-only check of every helper directory between the root and `path`; nothing is created. */
export function assertPrivateAncestors(stateHome: string, path: string): void {
	const root = resolve(stateHome)
	const target = resolve(path)
	if (!target.startsWith(`${root}${sep}`)) throw new RuntimeFailure("unsafe", "private state path escaped the selected state root")
	let current = root
	for (const segment of target.slice(root.length + 1).split(sep)) {
		current = join(current, segment)
		assertDirectory(current)
	}
}

function assertPrivateFile(path: string, expected?: Stats): Stats {
	let named: Stats
	try {
		named = lstatSync(path)
	} catch {
		throw new RuntimeFailure("unavailable", `${path} is not accessible`)
	}
	if (named.isSymbolicLink() || !named.isFile()) throw new RuntimeFailure("unsafe", `${path} is not a real regular file`)
	assertOwned(named, path)
	if ((named.mode & 0o777) !== 0o600) throw new RuntimeFailure("unsafe", `${path} must have mode 0600`)
	if (named.nlink !== 1) throw new RuntimeFailure("unsafe", `${path} must have exactly one link`)
	if (expected !== undefined && (named.dev !== expected.dev || named.ino !== expected.ino)) throw new RuntimeFailure("unsafe", `${path} changed identity during access`)
	return named
}

/** True when a private entry exists by name (lstat, so a symlink is an entry); only ENOENT is "absent", any other
 * failure to reach the name is "unavailable" and never reads as absent. */
export function privateEntryExists(path: string): boolean {
	try {
		return lstatSync(path) !== undefined
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return false
		throw new RuntimeFailure("unavailable", `${path} is not accessible`)
	}
}

function assertPrivateDescriptor(path: string, opened: Stats, named: Stats, limit: number): void {
	if (!opened.isFile()) throw new RuntimeFailure("unsafe", `${path} is not a real regular file`)
	assertOwned(opened, path)
	if ((opened.mode & 0o777) !== 0o600) throw new RuntimeFailure("unsafe", `${path} must have mode 0600`)
	if (opened.nlink !== 1) throw new RuntimeFailure("unsafe", `${path} must have exactly one link`)
	if (opened.dev !== named.dev || opened.ino !== named.ino) throw new RuntimeFailure("unsafe", `${path} changed identity during access`)
	if (opened.size > limit) throw new RuntimeFailure("unsafe", `${path} exceeds ${limit} bytes`)
}

function privateReadFailure(path: string, error: unknown): never {
	if (error instanceof RuntimeFailure) throw error
	const code = (error as { code?: unknown }).code
	throw new RuntimeFailure(code === "ELOOP" ? "unsafe" : "unavailable", `${path} could not be read${typeof code === "string" ? ` (${code})` : ""}`)
}

/** Returns the bytes of one private 0600 regular file, or null when absent; any other entry is refused. */
export function readPrivateFile(path: string, limit: number): Buffer | null {
	if (!privateEntryExists(path)) return null
	const named = assertPrivateFile(path)
	let descriptor: number | null = null
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
		const opened = fstatSync(descriptor)
		assertPrivateDescriptor(path, opened, named, limit)
		const bytes = readFileSync(descriptor)
		assertPrivateDescriptor(path, fstatSync(descriptor), opened, limit)
		return bytes
	} catch (error) {
		return privateReadFailure(path, error)
	} finally {
		if (descriptor !== null) closeSync(descriptor)
	}
}

/** Fault-injection seams for process tests of the two write outcomes; production passes none. */
export interface AtomicWriteHooks {
	readonly beforeReplace?: () => void
	readonly afterReplace?: () => void
}

/** Exclusive same-directory temporary file, fsync, rename, directory fsync. A failure before the rename is
 * "unavailable" (unchanged); a failure after it is "uncertain" (unknown). */
export function atomicWritePrivate(stateHome: string, path: string, bytes: string, hooks: AtomicWriteHooks = {}): void {
	const directory = dirname(path)
	ensurePrivateDirectory(stateHome, directory)
	if (privateEntryExists(path)) assertPrivateFile(path)
	const temporary = join(directory, `.${path.slice(path.lastIndexOf(sep) + 1)}.${randomUUID()}.tmp`)
	let descriptor: number | null = null
	let visible = false
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
		const opened = fstatSync(descriptor)
		assertOwned(opened, temporary)
		if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) throw new RuntimeFailure("unsafe", "temporary state file is unsafe")
		writeFileSync(descriptor, bytes, "utf8")
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = null
		assertPrivateFile(temporary, opened)
		hooks.beforeReplace?.()
		renameSync(temporary, path)
		visible = true
		assertPrivateFile(path)
		hooks.afterReplace?.()
		const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			fsyncSync(directoryDescriptor)
		} finally {
			closeSync(directoryDescriptor)
		}
	} catch (error) {
		if (error instanceof RuntimeFailure && !visible) throw error
		const code = (error as { code?: unknown }).code
		throw new RuntimeFailure(visible ? "uncertain" : "unavailable", `private state replacement failed${typeof code === "string" ? ` (${code})` : ""}`)
	} finally {
		if (descriptor !== null) closeSync(descriptor)
		try {
			if (existsSync(temporary)) unlinkSync(temporary)
		} catch {
			// A failed cleanup never changes whether the authoritative rename became visible.
		}
	}
}

function lockFailure(error: unknown): never {
	if (error instanceof LockFailure) throw new RuntimeFailure(error.kind, error.message)
	throw error
}

/** Workspace lock, then session lock, in every path that takes both; the order is fixed here and nowhere else. */
export async function withLocks<T>(stateHome: string, adapter: LockAdapter, workspace: string, sessionIdentity: string, action: () => Promise<T>): Promise<T> {
	const addresses = stateAddresses(stateHome)
	const workspaceLock = addresses.workspaceLock(workspace)
	const sessionLock = addresses.sessionLock(sessionIdentity)
	ensurePrivateDirectory(stateHome, dirname(workspaceLock))
	ensurePrivateDirectory(stateHome, dirname(sessionLock))
	try {
		return await adapter.withExclusive(workspaceLock, async () => adapter.withExclusive(sessionLock, action))
	} catch (error) {
		return lockFailure(error)
	}
}

/** The session lock alone, for the compaction marker: no workspace lock is taken, so the order above is untouched and
 * a marker operation never waits behind another session's hook or a `bind` on the same workspace. */
export async function withSessionLock<T>(stateHome: string, adapter: LockAdapter, sessionIdentity: string, action: () => Promise<T>): Promise<T> {
	const sessionLock = stateAddresses(stateHome).sessionLock(sessionIdentity)
	ensurePrivateDirectory(stateHome, dirname(sessionLock))
	try {
		return await adapter.withExclusive(sessionLock, action)
	} catch (error) {
		return lockFailure(error)
	}
}
