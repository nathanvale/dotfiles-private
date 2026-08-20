import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createVaultGitDoctorTaskStore } from "../src/doctor-task-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Background Doctor task store", () => {
	test("twenty identical callers publish one claim and one task", async () => {
		const root = await mkdtemp(join(tmpdir(), "vault-git-doctor-task-store-"));
		roots.push(root);
		const store = createVaultGitDoctorTaskStore({
			stateRoot: root,
			repositoryId: "a".repeat(64),
		});
		const binding = {
			repositoryId: "a".repeat(64),
			activationEvidenceId: `vault-git:prepared:v2:${"e".repeat(64)}`,
			receiptId: `receipt_${"b".repeat(32)}`,
			receiptRevision: 7,
			transactionId: `txn_${"c".repeat(32)}`,
			normalizedInput: '{"command":"doctor"}',
		} as const;

		const admissions = await Promise.all(
			Array.from({ length: 20 }, () =>
				store.claimOrJoin(binding, "2026-08-14T01:00:00.000Z"),
			),
		);
		expect(admissions.filter(({ launch }) => launch === "winner")).toHaveLength(
			1,
		);
		expect(new Set(admissions.map(({ state }) => state.taskId)).size).toBe(1);

		const taskId = admissions[0]?.state.taskId;
		if (!taskId) throw new Error("Doctor task admission omitted task id");
		const loaded = await store.loadByTaskId(taskId);
		expect(loaded).toMatchObject({
			status: "loaded",
			state: { taskId, revision: 1, state: "claimed" },
		});

		const repositoryRoot = join(
			root,
			"vault-git-transaction-manager",
			"a".repeat(64),
		);
		expect(await readdir(join(repositoryRoot, "doctor-task-claims"))).toHaveLength(
			1,
		);
		expect(await readdir(join(repositoryRoot, "doctor-tasks"))).toEqual([
			taskId,
		]);
		expect((await stat(repositoryRoot)).mode & 0o777).toBe(0o700);
	});

	test("refuses changed input within one receipt revision and isolates a new revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "vault-git-doctor-task-store-"));
		roots.push(root);
		const store = createVaultGitDoctorTaskStore({
			stateRoot: root,
			repositoryId: "a".repeat(64),
		});
		const binding = {
			repositoryId: "a".repeat(64),
			activationEvidenceId: `vault-git:prepared:v2:${"e".repeat(64)}`,
			receiptId: `receipt_${"b".repeat(32)}`,
			receiptRevision: 7,
			transactionId: `txn_${"c".repeat(32)}`,
			normalizedInput: '{"command":"doctor","transactionId":null}',
		} as const;
		const admitted = await store.claimOrJoin(
			binding,
			"2026-08-14T01:00:00.000Z",
		);
		const changedBindings = [
			{
				...binding,
				activationEvidenceId: `vault-git:prepared:v2:${"f".repeat(64)}`,
			},
			{ ...binding, transactionId: `txn_${"d".repeat(32)}` },
			{
				...binding,
				normalizedInput: '{"command":"doctor","transactionId":"changed"}',
			},
		] as const;
		for (const changed of changedBindings) {
			const refused = await store.claimOrJoin(
				changed,
				"2026-08-14T01:00:01.000Z",
			);
			expect(refused).toMatchObject({
				launch: "refused",
				reason: "task_input_mismatch",
				state: { taskId: admitted.state.taskId },
			});
			}
		const newRevision = await store.claimOrJoin(
			{ ...binding, receiptRevision: binding.receiptRevision + 1 },
			"2026-08-14T01:00:02.000Z",
		);
		expect(newRevision).toMatchObject({ launch: "winner" });
		expect(newRevision.state.taskId).not.toBe(admitted.state.taskId);
		const tasks = await readdir(
			join(
				root,
				"vault-git-transaction-manager",
				"a".repeat(64),
				"doctor-tasks",
			),
		);
		expect(new Set(tasks)).toEqual(
			new Set([admitted.state.taskId, newRevision.state.taskId]),
		);
	});

	test("does not create private directories during an absent lookup", async () => {
		const root = await mkdtemp(join(tmpdir(), "vault-git-doctor-task-store-"));
		roots.push(root);
		const store = createVaultGitDoctorTaskStore({
			stateRoot: root,
			repositoryId: "a".repeat(64),
		});
		await expect(
			store.loadByTaskId(`doctor_task_${"d".repeat(32)}`),
		).resolves.toEqual({ status: "absent" });
		expect(await readdir(root)).toEqual([]);
	});

	test("fails closed when an invalid durable route reaches Doctor admission or transition", async () => {
		const root = await mkdtemp(join(tmpdir(), "vault-git-doctor-task-store-"));
		roots.push(root);
		const repositoryId = "a".repeat(64);
		const store = createVaultGitDoctorTaskStore({ stateRoot: root, repositoryId });
		const binding = {
			repositoryId,
			activationEvidenceId: null,
			receiptId: `receipt_${"b".repeat(32)}`,
			receiptRevision: 7,
			transactionId: `txn_${"c".repeat(32)}`,
			normalizedInput: '{"command":"doctor","transactionId":null}',
		} as const;
		const admitted = await store.claimOrJoin(
			binding,
			"2026-08-14T01:00:00.000Z",
		);
		const invalidState = {
			...admitted.state,
			state: "closed",
			phase: "terminal",
			updatedAt: "2026-08-14T01:00:01.000Z",
			checkpoint: "terminal",
			terminalResult: {
				kind: "doctor_result",
				nextActionId: "invalid_durable_route",
			},
		};
		const repositoryRoot = join(
			root,
			"vault-git-transaction-manager",
			repositoryId,
		);
		const bytes = `${JSON.stringify(invalidState, null, 2)}\n`;
		// The immutable claim stays valid. Only the state reader's latest durable
		// history record carries invalid route evidence, exercising the exact
		// `loadByTaskId` seam reached by admission and transition.
		await writeFile(
			join(
				repositoryRoot,
				"doctor-tasks",
				admitted.state.taskId,
				"history",
				"000000000001.json",
			),
			bytes,
			{ mode: 0o600 },
		);

		await expect(
			store.claimOrJoin(binding, "2026-08-14T01:00:02.000Z"),
		).resolves.toMatchObject({
			launch: "refused",
			reason: "continuation_unavailable",
			state: { taskId: admitted.state.taskId },
		});
		const unavailable = await store.transition(
			admitted.state.taskId,
			admitted.state.revision,
			{
				state: "claimed",
				phase: "admitted",
				updatedAt: "2026-08-14T01:00:02.000Z",
				heartbeatAt: null,
				checkpoint: null,
				launchGeneration: null,
				launchExpiresAt: null,
				workerPid: null,
				workerProcessIdentity: null,
				launchAttempt: 0,
				terminalResult: null,
			},
		);
		expect(unavailable).toEqual({
			status: "unavailable",
			reason: "continuation_unavailable",
			taskId: admitted.state.taskId,
		});
	});
});
