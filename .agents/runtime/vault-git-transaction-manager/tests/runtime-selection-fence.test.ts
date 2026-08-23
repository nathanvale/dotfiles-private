import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createVaultGitRuntimeSelectionFence,
	inspectVaultGitDurableWorkState,
} from "../src/runtime-selection-fence.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Vault Git Runtime Selection fence", () => {
	test("a second real lockf holder waits until the first holder releases", async () => {
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

	test("missing lockf and a symlinked private lock root fail closed", async () => {
		const missingRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-missing-"));
		const symlinkRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-symlink-"));
		temporaryRoots.push(missingRoot, symlinkRoot);
		await expect(createVaultGitRuntimeSelectionFence(missingRoot, { lockfPath: "/missing/lockf" }).hold(async () => undefined)).rejects.toThrow("process unavailable");
		const elsewhere = join(symlinkRoot, "elsewhere");
		await mkdir(elsewhere);
		await symlink(elsewhere, join(symlinkRoot, "vault-git-runtime-selection"));
		await expect(createVaultGitRuntimeSelectionFence(symlinkRoot).hold(async () => undefined)).rejects.toThrow("path is unsafe");
	});

	test("a bounded silent acknowledgement times out deterministically", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-timeout-"));
		temporaryRoots.push(stateRoot);
		const fence = createVaultGitRuntimeSelectionFence(stateRoot, {
			lockfPath: "/usr/bin/tail",
			lockfArguments: ["-f", "/dev/null"],
			acknowledgementTimeoutMs: 5,
		});
		await expect(fence.hold(async () => undefined)).rejects.toThrow("acknowledgement timed out");
	});

	test("preserves operation and injected release causes when both fail", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-release-failure-"));
		temporaryRoots.push(stateRoot);
		const operationFailure = new Error("operation failed");
		const fence = createVaultGitRuntimeSelectionFence(stateRoot, {
			lockfPath: process.execPath,
			lockfArguments: [
				"-e",
				"Bun.write(process.argv[1], '').then(() => process.stdin.once('data', (chunk) => { process.stdout.write(chunk); process.stdin.once('end', () => process.exit(1)); }));",
				join(stateRoot, "vault-git-runtime-selection", "fence.lock"),
			],
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
						candidate.message === "Vault Git Runtime Selection fence exited (1)",
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

	test("a normal release rejects a holder that exits by termination signal", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "vault-git-runtime-selection-signal-death-"));
		temporaryRoots.push(stateRoot);
		const fence = createVaultGitRuntimeSelectionFence(stateRoot, {
			lockfPath: process.execPath,
			lockfArguments: [
				"-e",
				"Bun.write(process.argv[1], '').then(() => process.stdin.once('data', (chunk) => { process.stdout.write(chunk); process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM')); }));",
				join(stateRoot, "vault-git-runtime-selection", "fence.lock"),
			],
		});

		await expect(fence.hold(async () => undefined)).rejects.toThrow(
			"Vault Git Runtime Selection fence exited (SIGTERM)",
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
