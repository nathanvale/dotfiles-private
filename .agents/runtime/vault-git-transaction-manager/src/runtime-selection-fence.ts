import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseVaultGitDoctorTaskState } from "./doctor-task-state.ts";
import { parseVaultGitReceipt } from "./store.ts";
import { parseVaultGitTaskState } from "./task-state.ts";

/** Capability-free classification consumed by Runtime Selection only. */
export type VaultGitDurableWorkState = "clear" | "active" | "uncertain";

/** One cross-process mutual-exclusion boundary for selection and admission. */
export interface VaultGitRuntimeSelectionFence {
	hold<T>(operation: () => Promise<T>): Promise<T>;
}

export interface VaultGitRuntimeSelectionFenceOptions {
	readonly acquisitionTimeoutMs?: number;
	/** Test-only direct binding for release-failure coverage. */
	readonly flock?: (fd: number, operation: number) => number;
	/** Test-only errno source paired with a direct flock binding. */
	readonly errno?: () => number;
}

/** Expected contention only; FFI, path, and release failures remain fatal. */
export class VaultGitRuntimeSelectionFenceBusyError extends Error {
	constructor() {
		super("Vault Git Runtime Selection fence acquisition timed out");
		this.name = "VaultGitRuntimeSelectionFenceBusyError";
	}
}

const MAX_DIRECTORY_ENTRIES = 1024;
const REPOSITORY_ID = /^[a-f0-9]{64}$/u;
const TASK_ID = /^task_[a-f0-9]{32}$/u;
const DOCTOR_TASK_ID = /^doctor_task_[a-f0-9]{32}$/u;
const REVISION = /^\d{12}\.json$/u;
const LOCK_EX = 0x0002;
const LOCK_NB = 0x0004;
const LOCK_UN = 0x0008;
const LOCK_RETRY_MS = 10;
const DARWIN_LIBC_PATH = "/usr/lib/libSystem.B.dylib";

/** Create the macOS flock-backed fence rooted in Vault Git private state. */
export function createVaultGitRuntimeSelectionFence(
	stateRoot: string,
	options: VaultGitRuntimeSelectionFenceOptions = {},
): VaultGitRuntimeSelectionFence {
	const lockRoot = join(stateRoot, "vault-git-runtime-selection");
	const lockPath = join(lockRoot, "fence.lock");
	return {
		async hold<T>(operation: () => Promise<T>): Promise<T> {
			await ensurePrivateLockRoot(lockRoot);
			const native = options.flock
				? { flock: options.flock, errno: options.errno ?? (() => EWOULDBLOCK) }
				: loadFlock();
			const handle = await open(
				lockPath,
				constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await assertPrivateLockFile(handle, lockPath);
				await acquireFlock(
					handle.fd,
					native,
					options.acquisitionTimeoutMs ?? 2_000,
				);
				await assertPrivateLockFile(handle, lockPath);
			} catch (error) {
				await handle.close();
				throw error;
			}
			let operationError: unknown;
			try {
				return await operation();
			} catch (error) {
				operationError = error;
				throw error;
			} finally {
				try { await releaseFlock(handle, native.flock); }
				catch (cleanupError) {
					if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Vault Git Runtime Selection operation and release failed");
					throw cleanupError;
				}
			}
		},
	};
}

type FlockBinding = (fd: number, operation: number) => number;
interface NativeFlock {
	readonly flock: FlockBinding;
	readonly errno: () => number;
}

const EINTR = 4;
const EAGAIN = 35;
const EWOULDBLOCK = 35;

function loadFlock(): NativeFlock {
	if (process.platform !== "darwin") {
		throw new Error("Vault Git Runtime Selection fence requires macOS flock support");
	}
	try {
		const { dlopen, FFIType, toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
		const libc = dlopen(DARWIN_LIBC_PATH, {
			flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
			__error: { args: [], returns: FFIType.ptr },
		});
		return {
			flock: (fd, operation) => libc.symbols.flock(fd, operation) as number,
			errno: () => new DataView(toArrayBuffer(libc.symbols.__error() as never, 0, 4)).getInt32(0, true),
		};
	} catch {
		throw new Error("Vault Git Runtime Selection fence FFI is unavailable");
	}
}

async function acquireFlock(fd: number, native: NativeFlock, timeoutMs: number): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (native.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		const errno = native.errno();
		if (errno === EINTR) continue;
		if (errno !== EAGAIN && errno !== EWOULDBLOCK) {
			throw new Error(`Vault Git Runtime Selection fence acquisition failed with errno ${errno}`);
		}
		if (performance.now() >= deadline) {
			throw new VaultGitRuntimeSelectionFenceBusyError();
		}
		await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
	}
}

async function assertPrivateLockFile(handle: Awaited<ReturnType<typeof open>>, path: string): Promise<void> {
	const [entry, opened] = await Promise.all([lstat(path, { bigint: true }), handle.stat({ bigint: true })]);
	const uid = process.getuid?.();
	const privateFile = (candidate: typeof entry) =>
		candidate.isFile() && !candidate.isSymbolicLink() &&
		(candidate.mode & 0o777n) === 0o600n &&
		(uid === undefined || candidate.uid === BigInt(uid));
	if (!privateFile(entry) || !privateFile(opened) || entry.dev !== opened.dev || entry.ino !== opened.ino) {
		throw new Error("Vault Git Runtime Selection fence lock is unsafe");
	}
}

async function releaseFlock(handle: Awaited<ReturnType<typeof open>>, flock: FlockBinding): Promise<void> {
	try {
		if (flock(handle.fd, LOCK_UN) !== 0) {
			throw new Error("Vault Git Runtime Selection fence release failed");
		}
	} finally {
		await handle.close();
	}
}

async function ensurePrivateLockRoot(path: string): Promise<void> {
	let cursor = "/";
	for (const segment of resolve(path).split("/").filter(Boolean)) {
		cursor = join(cursor, segment);
		try {
			const entry = await lstat(cursor);
			const macosVarAlias = cursor === "/var" && entry.isSymbolicLink() && await realpath(cursor) === "/private/var";
			if (!macosVarAlias && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error("Vault Git Runtime Selection fence path is unsafe");
		} catch (error) {
			if (!isMissing(error)) throw error;
			try {
				await mkdir(cursor, { mode: 0o700 });
			} catch (createError) {
				if (!isAlreadyExists(createError)) throw createError;
			}
			const created = await lstat(cursor);
			if (created.isSymbolicLink() || !created.isDirectory()) {
				throw new Error("Vault Git Runtime Selection fence path is unsafe");
			}
		}
	}
	await chmod(resolve(path), 0o700);
}

/**
 * Read all known durable Vault Git work roots. It declares clear only after
 * exact owner parsers prove every receipt and task reaches a terminal state.
 */
export async function inspectVaultGitDurableWorkState(
	stateRoot: string,
): Promise<VaultGitDurableWorkState> {
	const managerRoot = join(stateRoot, "vault-git-transaction-manager");
	if ((await directoryState(managerRoot)) === "absent") return "clear";
	if ((await directoryState(managerRoot)) !== "directory") return "uncertain";
	const repositories = await list(managerRoot);
	if (!repositories) return "uncertain";
	let result: VaultGitDurableWorkState = "clear";
	for (const repository of repositories) {
		if (!REPOSITORY_ID.test(repository)) return "uncertain";
		const state = await inspectRepository(join(managerRoot, repository));
		if (state === "uncertain") return state;
		if (state === "active") result = state;
	}
	return result;
}

async function inspectRepository(root: string): Promise<VaultGitDurableWorkState> {
	if ((await directoryState(root)) !== "directory") return "uncertain";
	let result = await inspectReceipt(join(root, "current.json"));
	if (result === "uncertain") return result;
	for (const kind of ["tasks", "doctor-tasks"] as const) {
		const state = await inspectTasks(join(root, kind), kind === "tasks");
		if (state === "uncertain") return state;
		if (state === "active") result = state;
	}
	return result;
}

async function inspectReceipt(path: string): Promise<VaultGitDurableWorkState> {
	const text = await readRegularText(path);
	if (text === null) return "clear";
	if (text === undefined) return "uncertain";
	try {
			return parseVaultGitReceipt(JSON.parse(text)).phase === "closed" ? "clear" : "active";
	} catch {
		return "uncertain";
	}
}

async function inspectTasks(root: string, completion: boolean): Promise<VaultGitDurableWorkState> {
	const rootState = await directoryState(root);
	if (rootState === "absent") return "clear";
	if (rootState !== "directory") return "uncertain";
	const taskIds = await list(root);
	if (!taskIds) return "uncertain";
	let result: VaultGitDurableWorkState = "clear";
	for (const taskId of taskIds) {
		if (!(completion ? TASK_ID : DOCTOR_TASK_ID).test(taskId) || (await directoryState(join(root, taskId))) !== "directory") return "uncertain";
		const history = join(root, taskId, "history");
		if ((await directoryState(history)) !== "directory") return "uncertain";
		const revisions = await list(history);
		if (!revisions || revisions.length === 0 || revisions.some((name) => !REVISION.test(name))) return "uncertain";
		const text = await readRegularText(join(history, revisions.at(-1) ?? ""));
		if (text === null || text === undefined) return "uncertain";
		try {
			const phase = completion
				? parseVaultGitTaskState(JSON.parse(text)).phase
				: parseVaultGitDoctorTaskState(JSON.parse(text)).phase;
			if (phase !== "terminal") result = "active";
		} catch {
			return "uncertain";
		}
	}
	return result;
}

async function directoryState(path: string): Promise<"absent" | "directory" | "unsafe"> {
	try {
		const entry = await lstat(path);
		return entry.isDirectory() && !entry.isSymbolicLink() && isCurrentOwnerPrivate(entry, 0o700)
			? "directory"
			: "unsafe";
	} catch (error) {
		return isMissing(error) ? "absent" : "unsafe";
	}
}

async function list(path: string): Promise<readonly string[] | undefined> {
	try {
		const names = await readdir(path);
		return names.length > MAX_DIRECTORY_ENTRIES ? undefined : names.sort();
	} catch { return undefined; }
}

async function readRegularText(path: string): Promise<string | null | undefined> {
	try {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink() || !isCurrentOwnerPrivate(entry, 0o600)) {
			return undefined;
		}
		return await readFile(path, "utf8");
	} catch (error) { return isMissing(error) ? null : undefined; }
}

function isCurrentOwnerPrivate(
	entry: Awaited<ReturnType<typeof lstat>>,
	expectedMode: number,
): boolean {
	const uid = process.getuid?.();
	const mode = typeof entry.mode === "bigint"
		? Number(entry.mode & 0o777n)
		: entry.mode & 0o777;
	return mode === expectedMode && (uid === undefined || Number(entry.uid) === uid);
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
