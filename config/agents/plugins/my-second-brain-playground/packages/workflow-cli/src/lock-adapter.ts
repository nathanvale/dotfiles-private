// The Lock Adapter seam: one small Interface over process exclusion. The admitted Adapter (Gate lkr-yoc) is BSD
// flock(2) through bun:ffi on macOS: permanent private lock files, descriptor-held authority, a 2,000 ms bounded
// wait, and no age or PID stealing. A Linux flock Adapter can be added here later without changing any caller.
// An unsupported platform refuses before effects.

import { closeSync, constants, fstatSync, openSync } from "node:fs"
import type { Stats } from "node:fs"
import { dlopen, FFIType, read } from "bun:ffi"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const EWOULDBLOCK = 35
const LOCK_WAIT_MILLISECONDS = 2_000
const LOCK_POLL_MILLISECONDS = 25

export type LockFailureKind = "busy" | "unsafe" | "unavailable" | "unsupported"

export class LockFailure extends Error {
	constructor(
		readonly kind: LockFailureKind,
		message: string,
	) {
		super(message)
	}
}

/** The process-exclusion Interface. The lock file is permanent; authority lives in the open descriptor only. */
export interface LockAdapter {
	readonly platform: string
	withExclusive<T>(lockPath: string, action: () => Promise<T>): Promise<T>
}

function currentUid(): number | null {
	return typeof process.geteuid === "function" ? process.geteuid() : null
}

function assertPrivateLockDescriptor(lockPath: string, stat: Stats, expected?: Stats): void {
	const uid = currentUid()
	if (!stat.isFile()) throw new LockFailure("unsafe", `${lockPath} is not a regular file`)
	if (uid !== null && stat.uid !== uid) throw new LockFailure("unsafe", `${lockPath} is not owned by the effective user`)
	if ((stat.mode & 0o777) !== 0o600) throw new LockFailure("unsafe", `${lockPath} must have mode 0600`)
	if (stat.nlink !== 1) throw new LockFailure("unsafe", `${lockPath} must have exactly one link`)
	if (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino)) throw new LockFailure("unsafe", `${lockPath} changed identity while locked`)
}

/** Admitted Darwin Adapter: descriptor-scoped flock(2) through Bun FFI. */
function createDarwinFlockAdapter(): LockAdapter {
	return {
		platform: "darwin",
		async withExclusive<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
			const library = dlopen("/usr/lib/libSystem.B.dylib", {
				flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
				__error: { args: [], returns: FFIType.ptr },
			})
			let descriptor: number | null = null
			try {
				try {
					descriptor = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
				} catch (error) {
					const code = (error as { code?: unknown }).code
					throw new LockFailure(code === "ELOOP" ? "unsafe" : "unavailable", `lock file open failed${typeof code === "string" ? ` (${code})` : ""}`)
				}
				const opened = fstatSync(descriptor)
				assertPrivateLockDescriptor(lockPath, opened)
				const started = performance.now()
				for (;;) {
					if (library.symbols.flock(descriptor, LOCK_EX | LOCK_NB) === 0) break
					const pointer = library.symbols.__error()
					if (pointer === null) throw new LockFailure("unavailable", "flock errno pointer was null")
					const errorNumber = read.i32(pointer)
					if (errorNumber !== EWOULDBLOCK) throw new LockFailure("unavailable", `flock failed with errno ${errorNumber}`)
					if (performance.now() - started >= LOCK_WAIT_MILLISECONDS) throw new LockFailure("busy", `lock remained busy for ${LOCK_WAIT_MILLISECONDS} ms`)
					await Bun.sleep(LOCK_POLL_MILLISECONDS)
				}
				assertPrivateLockDescriptor(lockPath, fstatSync(descriptor), opened)
				return await action()
			} finally {
				if (descriptor !== null) {
					library.symbols.flock(descriptor, LOCK_UN)
					closeSync(descriptor)
				}
				library.close()
			}
		},
	}
}

/** The refusing Adapter for every platform without an admitted mechanism. It never touches the filesystem. */
function createUnsupportedLockAdapter(platform: string): LockAdapter {
	return {
		platform,
		withExclusive: async () => Promise.reject(new LockFailure("unsupported", `process-safe locking is unsupported on ${platform}; only darwin is admitted`)),
	}
}

export function lockAdapterFor(platform: string = process.platform): LockAdapter {
	return platform === "darwin" ? createDarwinFlockAdapter() : createUnsupportedLockAdapter(platform)
}
