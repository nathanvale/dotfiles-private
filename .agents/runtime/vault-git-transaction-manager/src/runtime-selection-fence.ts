import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
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
	readonly lockfPath?: string;
	/** Test-only argv override; production always uses lockf plus tee. */
	readonly lockfArguments?: readonly string[];
	readonly acknowledgementTimeoutMs?: number;
}

const MAX_DIRECTORY_ENTRIES = 1024;
const REPOSITORY_ID = /^[a-f0-9]{64}$/u;
const TASK_ID = /^task_[a-f0-9]{32}$/u;
const DOCTOR_TASK_ID = /^doctor_task_[a-f0-9]{32}$/u;
const REVISION = /^\d{12}\.json$/u;
const MAX_ACK_BYTES = 512;

/** Create the macOS lockf-backed fence rooted in Vault Git private state. */
export function createVaultGitRuntimeSelectionFence(
	stateRoot: string,
	options: VaultGitRuntimeSelectionFenceOptions = {},
): VaultGitRuntimeSelectionFence {
	const lockRoot = join(stateRoot, "vault-git-runtime-selection");
	const lockPath = join(lockRoot, "fence.lock");
	return {
		async hold<T>(operation: () => Promise<T>): Promise<T> {
			await ensurePrivateLockRoot(lockRoot);
			const nonce = `${randomBytes(32).toString("hex")}\n`;
			const child = spawn(
				options.lockfPath ?? "/usr/bin/lockf",
				options.lockfArguments ?? ["-k", lockPath, "/usr/bin/tee", "/dev/null"],
				{ stdio: ["pipe", "pipe", "ignore"], detached: true, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
			);
			try {
				await waitForAcknowledgement(child, nonce, options.acknowledgementTimeoutMs ?? 2_000);
				await assertPrivateLockFile(lockPath);
			} catch (error) {
				try { await terminateFenceProcess(child); }
				catch (cleanupError) { throw new AggregateError([error, cleanupError], "Vault Git Runtime Selection acknowledgement and cleanup failed"); }
				throw error;
			}
			let operationError: unknown;
			try {
				return await operation();
			} catch (error) {
				operationError = error;
				throw error;
			} finally {
				child.stdin.end();
				try { await waitForExit(child, 2_000); }
				catch (cleanupError) {
					await terminateFenceProcess(child);
					if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Vault Git Runtime Selection operation and release failed");
					throw cleanupError;
				}
			}
		},
	};
}

async function assertPrivateLockFile(path: string): Promise<void> {
	const entry = await lstat(path);
	if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Vault Git Runtime Selection fence lock is unsafe");
	await chmod(path, 0o600);
	const verified = await lstat(path);
	if (verified.isSymbolicLink() || !verified.isFile() || (verified.mode & 0o777) !== 0o600) throw new Error("Vault Git Runtime Selection fence lock permissions unavailable");
}

async function terminateFenceProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
	try { await waitForExit(child, 250, true); }
	catch {
		try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		await waitForExit(child, 250, true);
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
			await mkdir(cursor, { mode: 0o700 });
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
		return entry.isDirectory() && !entry.isSymbolicLink() ? "directory" : "unsafe";
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
		if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
		return await readFile(path, "utf8");
	} catch (error) { return isMissing(error) ? null : undefined; }
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function waitForAcknowledgement(child: ReturnType<typeof spawn>, nonce: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		let settled = false;
		const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.stdout?.off("data", onData); child.off("error", onError); child.off("exit", onExit); error ? reject(error) : resolve(); };
		const onError = () => finish(new Error("Vault Git Runtime Selection fence process unavailable"));
		const onExit = (code: number | null) => finish(new Error(`Vault Git Runtime Selection fence exited before acknowledgement (${code})`));
		const onData = (chunk: Buffer) => { output += chunk.toString("utf8"); if (Buffer.byteLength(output, "utf8") > MAX_ACK_BYTES) return finish(new Error("Vault Git Runtime Selection fence acknowledgement exceeded limit")); if (output === nonce) finish(); else if (!nonce.startsWith(output)) finish(new Error("Vault Git Runtime Selection fence acknowledgement mismatch")); };
		const timer = setTimeout(() => finish(new Error("Vault Git Runtime Selection fence acknowledgement timed out")), timeoutMs);
		if (!child.stdout || !child.stdin) return finish(new Error("Vault Git Runtime Selection fence process pipes unavailable"));
		child.on("error", onError); child.on("exit", onExit); child.stdout.on("data", onData); child.stdin.once("error", onError); child.stdin.write(nonce);
	});
}

function waitForExit(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
	allowTerminationSignal = false,
): Promise<void> {
	const exitedSuccessfully = (code: number | null, signal: NodeJS.Signals | null): boolean =>
		code === 0 ||
		(allowTerminationSignal && (signal === "SIGTERM" || signal === "SIGKILL"));
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			exitedSuccessfully(child.exitCode, child.signalCode) ? resolve() : reject(new Error(`Vault Git Runtime Selection fence exited (${child.exitCode ?? child.signalCode})`));
			return;
		}
		let settled = false;
		const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.off("error", onError); child.off("exit", onExit); error ? reject(error) : resolve(); };
		const onError = () => finish(new Error("Vault Git Runtime Selection fence release failed"));
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => exitedSuccessfully(code, signal) ? finish() : finish(new Error(`Vault Git Runtime Selection fence exited (${code ?? signal})`));
		const timer = setTimeout(() => finish(new Error("Vault Git Runtime Selection fence release timed out")), timeoutMs);
		child.on("error", onError); child.on("exit", onExit);
	});
}
