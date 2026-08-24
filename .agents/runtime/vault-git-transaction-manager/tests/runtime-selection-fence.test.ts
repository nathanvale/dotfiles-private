import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createVaultGitRuntimeSelectionFence,
	inspectVaultGitDurableWorkState,
	VaultGitRuntimeSelectionFenceBusyError,
} from "../src/runtime-selection-fence.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Vault Git Runtime Selection fence", () => {
	test("a real callback process holds the parent-owned flock until that callback process dies", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-process-"));
		temporaryRoots.push(stateRoot);
		const moduleUrl = new URL("../src/runtime-selection-fence.ts", import.meta.url).href;
		const holder = spawn(process.execPath, ["-e", `
			import { createVaultGitRuntimeSelectionFence } from ${JSON.stringify(moduleUrl)};
			const fence = createVaultGitRuntimeSelectionFence(process.argv[1]);
			await fence.hold(async () => { process.stdout.write("entered\\n"); await new Promise(() => {}); });
		`, stateRoot], { stdio: ["ignore", "pipe", "pipe"] });
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.stdout?.once("data", (chunk) => chunk.toString("utf8") === "entered\n" ? resolve() : reject(new Error("holder acknowledgement mismatch")));
		});
		let secondEntered = false;
		const second = createVaultGitRuntimeSelectionFence(stateRoot).hold(async () => {
			secondEntered = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(secondEntered).toBe(false);
		holder.kill("SIGKILL");
		await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
		await second;
		expect(secondEntered).toBe(true);
	});

	test("a second real flock holder waits until the first holder releases", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-fence-"));
		temporaryRoots.push(stateRoot);
		const first = createVaultGitRuntimeSelectionFence(stateRoot);
		const second = createVaultGitRuntimeSelectionFence(stateRoot);
		let releaseFirst: (() => void) | undefined;
		let enteredFirst: (() => void) | undefined;
		const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
		let secondEntered = false;
		const firstRun = first.hold(async () => { enteredFirst?.(); await held; });
		await entered;
		const secondRun = second.hold(async () => { secondEntered = true; });
		await Promise.resolve();
		expect(secondEntered).toBe(false);
		releaseFirst?.();
		await Promise.all([firstRun, secondRun]);
		expect(secondEntered).toBe(true);
	});

	test("a phase-only receipt is uncertain rather than clear", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-state-"));
		temporaryRoots.push(stateRoot);
		const root = join(stateRoot, "vault-git-transaction-manager", "a".repeat(64));
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "current.json"), '{"phase":"closed"}\n');
		expect(await inspectVaultGitDurableWorkState(stateRoot)).toBe("uncertain");
	});

	test("a symlinked private lock root fails closed", async () => {
		const symlinkRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-symlink-"));
		temporaryRoots.push(symlinkRoot);
		const elsewhere = join(symlinkRoot, "elsewhere");
		await mkdir(elsewhere);
		await symlink(elsewhere, join(symlinkRoot, "vault-git-runtime-selection"));
		await expect(createVaultGitRuntimeSelectionFence(symlinkRoot).hold(async () => undefined)).rejects.toThrow("path is unsafe");
	});

	test("a bounded contended acquisition times out deterministically", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-timeout-"));
		temporaryRoots.push(stateRoot);
		const fence = createVaultGitRuntimeSelectionFence(stateRoot, {
			flock: () => -1,
			errno: () => 35,
			acquisitionTimeoutMs: 5,
		});
		await expect(fence.hold(async () => undefined)).rejects.toBeInstanceOf(
			VaultGitRuntimeSelectionFenceBusyError,
		);
	});

	test("retries only EINTR and rejects an unexpected flock errno", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-errno-"));
		temporaryRoots.push(stateRoot);
		let calls = 0;
		await expect(createVaultGitRuntimeSelectionFence(stateRoot, {
			flock: () => (++calls === 1 ? -1 : 0),
			errno: () => 4,
		}).hold(async () => undefined)).resolves.toBeUndefined();
		await expect(createVaultGitRuntimeSelectionFence(stateRoot, {
			flock: () => -1,
			errno: () => 1,
		}).hold(async () => undefined)).rejects.toThrow("errno 1");
	});

	test("preserves operation and injected release causes when both fail", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-release-failure-"));
		temporaryRoots.push(stateRoot);
		const operationFailure = new Error("operation failed");
		let calls = 0;
		const fence = createVaultGitRuntimeSelectionFence(stateRoot, {
			flock: () => (++calls === 1 ? 0 : -1),
		});

		try {
			await fence.hold(async () => {
				throw operationFailure;
			});
			expect.unreachable("the operation and release failures must reject");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			const aggregate = error as AggregateError;
			expect(aggregate.errors).toContain(operationFailure);
			expect(aggregate.errors).toSatisfy((errors) =>
				errors.some(
					(candidate) =>
						candidate instanceof Error &&
						candidate.message === "Vault Git Runtime Selection fence release failed",
				),
			);
		}
	});

	test("keeps an operation failure unaggregated when release succeeds", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-operation-failure-"));
		temporaryRoots.push(stateRoot);
		const operationFailure = new Error("operation failed");
		await expect(
			createVaultGitRuntimeSelectionFence(stateRoot).hold(async () => {
				throw operationFailure;
			}),
		).rejects.toBe(operationFailure);
	});

	test("a failed normal release rejects without manufacturing an AggregateError", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-signal-death-"));
		temporaryRoots.push(stateRoot);
		const fence = createVaultGitRuntimeSelectionFence(stateRoot, {
			flock: (() => {
				let calls = 0;
				return () => (++calls === 1 ? 0 : -1);
			})(),
		});

		await expect(fence.hold(async () => undefined)).rejects.toThrow(
			"Vault Git Runtime Selection fence release failed",
		);
	});

	test("an acquired OS fence stays outside durable repository classification", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-namespace-"));
		temporaryRoots.push(stateRoot);
		const fence = createVaultGitRuntimeSelectionFence(stateRoot);
		await fence.hold(async () => {
			expect(await inspectVaultGitDurableWorkState(stateRoot)).toBe("clear");
		});
		expect(await inspectVaultGitDurableWorkState(stateRoot)).toBe("clear");
	});
});
