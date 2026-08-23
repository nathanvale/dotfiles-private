import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SOURCE_LOCK_STALE_MS = 5 * 60_000;
const TRANSITION_RETRY_COUNT = 100;
const TRANSITION_RETRY_MS = 5;

/** Process identity persisted before an authoring critical section begins. */
export type BrowserUseSourceLockOwner = {
	/** Unpredictable per-acquisition ownership fence. */
	token: string;
	/** Process that acquired the lock. */
	pid: number;
	/** Wall-clock acquisition time used to recover hung owners. */
	acquired_at_epoch_ms: number;
	/** Last cooperative liveness proof for long-running qualification guards. */
	heartbeat_at_epoch_ms?: number;
	/** Procedural source generation admitted by the qualification campaign. */
	generation?: number;
	/** Reviewed source fixed point checked by the cooperative drift guard. */
	source_digest?: string;
	/** Reviewed manifest fixed point checked by the cooperative drift guard. */
	manifest_digest?: string;
};

/** One held authoring lock whose release is fenced to its owner token. */
export type BrowserUseSourceLockHandle = {
	/** Persisted identity for inspection and fenced release. */
	owner: BrowserUseSourceLockOwner;
	/** Release only when the persisted owner still matches this handle. */
	release: () => Promise<BrowserUseSourceLockReleaseResult>;
	/** Prove that this exact persisted fence and fixed point are still current. */
	validate: (binding?: BrowserUseSourceLockBinding) => Promise<BrowserUseSourceLockValidationResult>;
	/** Refresh only this exact persisted fence under the canonical transition lock. */
	heartbeat: () => Promise<BrowserUseSourceLockValidationResult>;
};

export type BrowserUseSourceLockBinding = {
	generation: number;
	source_digest: string;
	manifest_digest: string;
};

export type BrowserUseSourceLockValidationResult =
	| { ok: true; owner: BrowserUseSourceLockOwner }
	| {
			ok: false;
			reason: "ownership-lost" | "generation-stale" | "source-drift" | "manifest-drift" | "refresh-failed";
	  };

/** Fenced release result, including any lock that may require manual repair. */
export type BrowserUseSourceLockReleaseResult =
	| { ok: true; status: "released" | "ownership-changed" }
	| {
			ok: false;
			reason:
				| "transition-unavailable"
				| "owner-remove-failed"
				| "transition-release-failed";
			message: string;
	  };

/** Typed acquisition outcome with a deterministic operator repair path. */
export type BrowserUseSourceLockAcquireResult =
	| ({ ok: true } & BrowserUseSourceLockHandle)
	| {
			ok: false;
			reason: "contended" | "repair-required";
			message: string;
	  };

/** Body result or the acquisition refusal that prevented it from running. */
export type BrowserUseSourceLockOperationResult<T> =
	| { acquired: true; released: true; value: T }
	| {
			acquired: true;
			released: false;
			body_status: "succeeded";
			value: T;
			release_failure: Extract<BrowserUseSourceLockReleaseResult, { ok: false }>;
	  }
	| {
			acquired: true;
			released: false;
			body_status: "failed";
			body_error: unknown;
			release_failure: Extract<BrowserUseSourceLockReleaseResult, { ok: false }>;
	  }
	| {
			acquired: false;
			reason: "contended" | "repair-required";
			message: string;
	  };

type FileRead =
	| { status: "present"; raw: string }
	| { status: "missing" }
	| { status: "unreadable" };

type ExclusiveCreate =
	| { status: "created"; raw: string }
	| { status: "exists" }
	| { status: "failed" };

function errorCode(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
}

function ownerBytes(owner: BrowserUseSourceLockOwner): string {
	return `${JSON.stringify(owner)}\n`;
}

function parseOwner(raw: string): BrowserUseSourceLockOwner | undefined {
	try {
		const value = JSON.parse(raw) as Partial<BrowserUseSourceLockOwner>;
		return typeof value.token === "string" && value.token !== "" &&
			Number.isInteger(value.pid) && (value.pid ?? 0) > 0 &&
			typeof value.acquired_at_epoch_ms === "number" &&
			Number.isFinite(value.acquired_at_epoch_ms)
			? value as BrowserUseSourceLockOwner
			: undefined;
	} catch {
		return undefined;
	}
}

function pidIsDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return errorCode(error) !== "EPERM";
	}
}

function ownerIsStale(owner: BrowserUseSourceLockOwner): boolean {
	if (pidIsDead(owner.pid)) return true;
	// Long-running qualification guards carry heartbeat identity. A live owner
	// is never reclaimed merely because two reviewed runs take longer than the
	// authoring-lock timeout; cooperative holders validate the exact token and
	// fixed point at every session boundary.
	return owner.heartbeat_at_epoch_ms === undefined &&
		Date.now() - owner.acquired_at_epoch_ms > SOURCE_LOCK_STALE_MS;
}

async function readOwnedFile(path: string): Promise<FileRead> {
	try {
		return { status: "present", raw: await readFile(path, "utf8") };
	} catch (error) {
		return errorCode(error) === "ENOENT"
			? { status: "missing" }
			: { status: "unreadable" };
	}
}

async function createOwnedFile(
	path: string,
	owner: BrowserUseSourceLockOwner,
): Promise<ExclusiveCreate> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "wx", 0o600);
	} catch (error) {
		return errorCode(error) === "EEXIST"
			? { status: "exists" }
			: { status: "failed" };
	}
	const raw = ownerBytes(owner);
	try {
		await handle.writeFile(raw, "utf8");
		await handle.sync();
		return { status: "created", raw };
	} catch {
		await rm(path, { force: true }).catch(() => undefined);
		return { status: "failed" };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function removeIfOwned(path: string, raw: string): Promise<boolean> {
	const current = await readOwnedFile(path);
	if (current.status !== "present" || current.raw !== raw) return false;
	try {
		await rm(path);
		return true;
	} catch {
		return false;
	}
}

function newOwner(binding?: BrowserUseSourceLockBinding): BrowserUseSourceLockOwner {
	const now = Date.now();
	return {
		token: randomUUID(),
		pid: process.pid,
		acquired_at_epoch_ms: now,
		heartbeat_at_epoch_ms: now,
		...(binding ?? {}),
	};
}

function repairMessage(
	subject: string,
	lockPath: string,
	driftGuard: boolean,
): string {
	return driftGuard
		? `another ${subject} observation holds the private source drift guard. Dead owners and stale claims are reclaimed automatically. This guard does not prevent repository edits; if it persists, verify no qualification observation is running, then remove ${lockPath} and ${lockPath}.reclaim.`
		: `another ${subject} source mutation holds the catalog lock. Dead owners and locks older than 5 minutes are reclaimed automatically. If the lock persists, verify no source mutation is running, then remove ${lockPath} and ${lockPath}.reclaim.`;
}

async function acquireTransition(
	transitionPath: string,
): Promise<{ ownerRaw: string; release: () => Promise<boolean> } | undefined> {
	const created = await createOwnedFile(transitionPath, newOwner());
	if (created.status !== "created") return undefined;
	return {
		ownerRaw: created.raw,
		release: async () => await removeIfOwned(transitionPath, created.raw),
	};
}

async function transitionIsAbsent(transitionPath: string): Promise<boolean> {
	for (let attempt = 0; attempt < TRANSITION_RETRY_COUNT; attempt += 1) {
		if ((await readOwnedFile(transitionPath)).status === "missing") return true;
		await Bun.sleep(TRANSITION_RETRY_MS);
	}
	return false;
}

function handleFor(
	lockPath: string,
	owner: BrowserUseSourceLockOwner,
	ownerRaw: string,
	repair: string,
): BrowserUseSourceLockHandle {
	let released = false;
	let exactOwner = owner;
	let exactRaw = ownerRaw;
	const validate = async (
		binding?: BrowserUseSourceLockBinding,
	): Promise<BrowserUseSourceLockValidationResult> => {
		const current = await readOwnedFile(lockPath);
		if (current.status !== "present" || current.raw !== exactRaw) {
			return { ok: false, reason: "ownership-lost" };
		}
		if (binding !== undefined) {
			if (exactOwner.generation !== binding.generation) {
				return { ok: false, reason: "generation-stale" };
			}
			if (exactOwner.source_digest !== binding.source_digest) {
				return { ok: false, reason: "source-drift" };
			}
			if (exactOwner.manifest_digest !== binding.manifest_digest) {
				return { ok: false, reason: "manifest-drift" };
			}
		}
		return { ok: true, owner: exactOwner };
	};
	return {
		get owner() {
			return exactOwner;
		},
		validate,
		heartbeat: async () => {
			const transition = await acquireTransition(`${lockPath}.reclaim`);
			if (transition === undefined) return { ok: false, reason: "refresh-failed" };
			try {
				const valid = await validate();
				if (!valid.ok) return valid;
				const refreshed = { ...exactOwner, heartbeat_at_epoch_ms: Date.now() };
				await writeSourceFileAtomically({ path: lockPath, bytes: ownerBytes(refreshed) });
				exactOwner = refreshed;
				exactRaw = ownerBytes(refreshed);
				return { ok: true, owner: refreshed };
			} catch {
				return { ok: false, reason: "refresh-failed" };
			} finally {
				await transition.release();
			}
		},
		release: async () => {
			if (released) return { ok: true, status: "released" };
			const transitionPath = `${lockPath}.reclaim`;
			let transition: Awaited<ReturnType<typeof acquireTransition>>;
			for (let attempt = 0; attempt < TRANSITION_RETRY_COUNT; attempt += 1) {
				transition = await acquireTransition(transitionPath);
				if (transition !== undefined) break;
				await Bun.sleep(TRANSITION_RETRY_MS);
			}
			if (transition === undefined) {
				return {
					ok: false,
					reason: "transition-unavailable",
					message: repair,
				};
			}
			let result: BrowserUseSourceLockReleaseResult;
			try {
				const current = await readOwnedFile(lockPath);
				if (current.status === "missing" ||
					(current.status === "present" && current.raw !== exactRaw)) {
					result = { ok: true, status: "ownership-changed" };
				} else if (current.status === "present" && await removeIfOwned(lockPath, exactRaw)) {
					result = { ok: true, status: "released" };
				} else {
					result = {
						ok: false,
						reason: "owner-remove-failed",
						message: repair,
					};
				}
			} finally {
				if (!(await transition.release())) {
					result = {
						ok: false,
						reason: "transition-release-failed",
						message: repair,
					};
				}
			}
			if (result.ok) released = true;
			return result;
		},
	};
}

/**
 * Acquire one crash-recoverable source mutation lock.
 *
 * A separate exclusive transition claim binds stale reclamation to the exact
 * observed owner. Every release uses the same claim and removes only its own
 * token, so a delayed releaser cannot unlink a successor.
 *
 * @param input - Absolute lock path and operator-facing mutation subject
 * @returns Held lock or typed contention with the manual repair path
 * @internal
 */
export async function acquireSourceLock(input: {
	lockPath: string;
	subject: string;
	binding?: BrowserUseSourceLockBinding;
}): Promise<BrowserUseSourceLockAcquireResult> {
	const transitionPath = `${input.lockPath}.reclaim`;
	const repair = repairMessage(
		input.subject,
		input.lockPath,
		input.binding !== undefined,
	);
	const owner = newOwner(input.binding);
	const direct = await createOwnedFile(input.lockPath, owner);
	if (direct.status === "created") {
		if (!(await transitionIsAbsent(transitionPath))) {
			await removeIfOwned(input.lockPath, direct.raw);
			return { ok: false, reason: "repair-required", message: repair };
		}
		const current = await readOwnedFile(input.lockPath);
		if (current.status !== "present" || current.raw !== direct.raw) {
			await removeIfOwned(input.lockPath, direct.raw);
			return { ok: false, reason: "contended", message: repair };
		}
		return { ok: true, ...handleFor(input.lockPath, owner, direct.raw, repair) };
	}
	if (direct.status === "failed") {
		return { ok: false, reason: "repair-required", message: repair };
	}

	const observed = await readOwnedFile(input.lockPath);
	if (observed.status === "missing") {
		return { ok: false, reason: "contended", message: repair };
	}
	if (observed.status === "unreadable") {
		return { ok: false, reason: "repair-required", message: repair };
	}
	const observedOwner = parseOwner(observed.raw);
	if (observedOwner === undefined) {
		return { ok: false, reason: "repair-required", message: repair };
	}
	if (!ownerIsStale(observedOwner)) {
		return { ok: false, reason: "contended", message: repair };
	}

	const transition = await acquireTransition(transitionPath);
	if (transition === undefined) {
		return { ok: false, reason: "contended", message: repair };
	}
	let replacement: ExclusiveCreate | undefined;
	let transitionReleased = false;
	try {
		const current = await readOwnedFile(input.lockPath);
		if (current.status !== "present" || current.raw !== observed.raw) {
			return { ok: false, reason: "contended", message: repair };
		}
		const currentOwner = parseOwner(current.raw);
		if (currentOwner === undefined || !ownerIsStale(currentOwner)) {
			return {
				ok: false,
				reason: currentOwner === undefined ? "repair-required" : "contended",
				message: repair,
			};
		}
		if (!(await removeIfOwned(input.lockPath, observed.raw))) {
			return { ok: false, reason: "contended", message: repair };
		}
		replacement = await createOwnedFile(input.lockPath, owner);
	} finally {
		transitionReleased = await transition.release();
	}
	if (replacement?.status === "created" && !transitionReleased) {
		await removeIfOwned(input.lockPath, replacement.raw);
	}
	if (replacement?.status !== "created" || !transitionReleased) {
		return { ok: false, reason: "repair-required", message: repair };
	}
	return { ok: true, ...handleFor(input.lockPath, owner, replacement.raw, repair) };
}

/**
 * Run one source mutation under the shared crash-recoverable lock protocol.
 *
 * @param input - Absolute lock path and operator-facing mutation subject
 * @param body - Mutation that requires exclusive source ownership
 * @returns Body result, combined body/release failure, or typed acquisition refusal
 * @throws When the body throws and the lock releases cleanly
 * @internal
 */
export async function withSourceLock<T>(
	input: { lockPath: string; subject: string },
	body: () => Promise<T>,
): Promise<BrowserUseSourceLockOperationResult<T>> {
	const acquired = await acquireSourceLock(input);
	if (!acquired.ok) {
		return {
			acquired: false,
			reason: acquired.reason,
			message: acquired.message,
		};
	}
	let value: T;
	try {
		value = await body();
	} catch (bodyError) {
		const released = await acquired.release();
		if (released.ok) throw bodyError;
		return {
			acquired: true,
			released: false,
			body_status: "failed",
			body_error: bodyError,
			release_failure: released,
		};
	}
	const released = await acquired.release();
	return released.ok
		? { acquired: true, released: true, value }
		: {
				acquired: true,
				released: false,
				body_status: "succeeded",
				value,
				release_failure: released,
		  };
}

/**
 * Replace one source file through a private unique temporary file.
 *
 * The helper owns the temporary path from exclusive creation through rename
 * and removes it in `finally` after every failed write or replacement.
 *
 * @param input - Destination path and exact bytes to persist
 * @returns Nothing after the replacement is durable
 * @throws When temporary creation, write, sync, close, or rename fails
 * @internal
 */
export async function writeSourceFileAtomically(input: {
	path: string;
	bytes: string;
}): Promise<void> {
	const temporary = join(
		dirname(input.path),
		`.${basename(input.path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let created = false;
	try {
		const handle = await open(temporary, "wx", 0o600);
		created = true;
		try {
			await handle.writeFile(input.bytes, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, input.path);
		created = false;
	} finally {
		if (created) await rm(temporary, { force: true }).catch(() => undefined);
	}
}
