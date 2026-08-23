import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	advanceVaultGitDoctorTaskState,
	createVaultGitDoctorTaskState,
} from "../../vault-git-transaction-manager/src/doctor-task-state.ts";
import {
	parseVaultGitReceipt,
} from "../../vault-git-transaction-manager/src/store.ts";
import {
	advanceVaultGitTaskState,
	createVaultGitTaskState,
} from "../../vault-git-transaction-manager/src/task-state.ts";
import { inspectVaultGitWorkState } from "../src/vault-git-work-state.ts";

const REPOSITORY_ID = "a".repeat(64);
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function makeStateRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "setup-vault-git-work-state-"));
	temporaryRoots.push(root);
	return root;
}

async function writeRepositoryFile(
	stateRoot: string,
	relativePath: readonly string[],
	bytes: string,
): Promise<string> {
	const path = join(stateRoot, "vault-git-transaction-manager", REPOSITORY_ID, ...relativePath);
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, bytes, { mode: 0o600 });
	return path;
}

function closedReceipt() {
	return parseVaultGitReceipt({
		schemaVersion: 2,
		receiptId: `receipt_${"1".repeat(32)}`,
		transactionId: null,
		revision: 2,
		phase: "closed",
		transition: "closed",
		recordedAt: "2026-08-24T00:00:00.000Z",
		event: "note_created",
		actor: "agent-a",
		host: "host-a",
		remote: "origin",
		ownedPaths: [{ path: "notes/example.md", baselineHash: null, admittedNewFile: true }],
		unrelatedState: { statusHex: "", indexHex: "" },
		localMainHead: "a".repeat(40),
		remoteMainHead: "a".repeat(40),
		expectedLeaseGeneration: null,
		leaseGeneration: null,
		leaseAcquiredAt: null,
		leaseDurationMs: 60_000,
		commitId: null,
		expectedMainCommit: null,
		ledgerReleaseId: null,
		pushOutcome: "not_attempted",
		nextSafeAction: "none",
		diagnosticsReference: `receipt:receipt_${"1".repeat(32)}`,
	});
}

function completionTask(state: "terminal" | "running") {
	const claimed = createVaultGitTaskState({
		taskId: `task_${"2".repeat(32)}`,
		receiptId: `receipt_${"1".repeat(32)}`,
		receiptRevision: 2,
		transactionId: `txn_${"3".repeat(32)}`,
		leaseGeneration: "a".repeat(40),
		recordedAt: "2026-08-24T00:00:00.000Z",
	});
	return state === "terminal"
		? advanceVaultGitTaskState(claimed, {
			state: "closed",
			phase: "terminal",
			updatedAt: "2026-08-24T00:01:00.000Z",
			heartbeatAt: null,
			checkpoint: "closed",
			terminalResult: {
				outcome: "completed",
				phase: "closed",
				changedState: "none",
				blocker: null,
				retrySafety: "same_input_safe",
			},
		})
		: advanceVaultGitTaskState(claimed, {
			state: "in_progress",
			phase: "running",
			updatedAt: "2026-08-24T00:01:00.000Z",
			heartbeatAt: "2026-08-24T00:01:00.000Z",
			checkpoint: "checking",
			launchGeneration: `launch_${"4".repeat(32)}`,
			launchExpiresAt: null,
		});
}

function doctorTask(state: "terminal" | "running") {
	const claimed = createVaultGitDoctorTaskState({
		taskId: `doctor_task_${"5".repeat(32)}`,
		binding: {
			repositoryId: REPOSITORY_ID,
			activationEvidenceId: `vault-git:prepared:v2:${"6".repeat(64)}`,
			receiptId: `receipt_${"1".repeat(32)}`,
			receiptRevision: 2,
			transactionId: `txn_${"3".repeat(32)}`,
			normalizedInput: '{"command":"doctor"}',
		},
		recordedAt: "2026-08-24T00:00:00.000Z",
	});
	return state === "terminal"
		? advanceVaultGitDoctorTaskState(claimed, {
			state: "closed",
			phase: "terminal",
			updatedAt: "2026-08-24T00:01:00.000Z",
			heartbeatAt: null,
			checkpoint: "terminal",
			launchGeneration: null,
			launchExpiresAt: null,
			workerPid: null,
			workerProcessIdentity: null,
			launchAttempt: 0,
			terminalResult: {
				kind: "observation_expired",
				blocker: "continuation_unavailable",
				retrySafety: "operator_required",
			},
		})
		: advanceVaultGitDoctorTaskState(claimed, {
			state: "in_progress",
			phase: "running",
			updatedAt: "2026-08-24T00:01:00.000Z",
			heartbeatAt: "2026-08-24T00:01:00.000Z",
			checkpoint: "checking_remote",
			launchGeneration: `doctor_launch_${"7".repeat(32)}`,
			launchExpiresAt: null,
			workerPid: 123,
			workerProcessIdentity: "8".repeat(64),
			launchAttempt: 1,
			terminalResult: null,
		});
}

async function writeReceipt(stateRoot: string, receipt = closedReceipt()): Promise<void> {
	await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify(receipt)}\n`);
}

async function writeCompletionTask(stateRoot: string, state = completionTask("terminal")): Promise<void> {
	await writeRepositoryFile(
		stateRoot,
		["tasks", state.taskId, "history", `${String(state.revision).padStart(12, "0")}.json`],
		`${JSON.stringify(state)}\n`,
	);
}

async function writeDoctorTask(stateRoot: string, state = doctorTask("terminal")): Promise<void> {
	await writeRepositoryFile(
		stateRoot,
		["doctor-tasks", state.taskId, "history", `${String(state.revision).padStart(12, "0")}.json`],
		`${JSON.stringify(state)}\n`,
	);
}

describe("Vault Git work-state evidence", () => {
	test("a missing manager root is clear", async () => {
		const stateRoot = await makeStateRoot();
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("clear");
	});

	test("a parser-approved closed receipt alone is clear", async () => {
		const stateRoot = await makeStateRoot();
		await writeReceipt(stateRoot);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("clear");
	});

	test("a parser-approved terminal Completion Task is clear beside a closed receipt", async () => {
		const stateRoot = await makeStateRoot();
		await writeReceipt(stateRoot);
		await writeCompletionTask(stateRoot);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("clear");
	});

	test("a parser-approved terminal Doctor Task is clear beside a closed receipt", async () => {
		const stateRoot = await makeStateRoot();
		await writeReceipt(stateRoot);
		await writeDoctorTask(stateRoot);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("clear");
	});

	test.each([
		["receipt", async (stateRoot: string) => {
			await writeReceipt(stateRoot, parseVaultGitReceipt({
				...closedReceipt(),
				phase: "writing",
				transition: "write_authority_granted",
				nextSafeAction: "resume_writing",
			}));
		}],
		["Completion Task", async (stateRoot: string) => {
			await writeReceipt(stateRoot);
			await writeCompletionTask(stateRoot, completionTask("running"));
		}],
		["Doctor Task", async (stateRoot: string) => {
			await writeReceipt(stateRoot);
			await writeDoctorTask(stateRoot, doctorTask("running"));
		}],
	] as const)("a parser-approved nonterminal %s is active", async (_kind, writeActiveState) => {
		const stateRoot = await makeStateRoot();
		await writeActiveState(stateRoot);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("active");
	});

	test("Completion and Doctor Task IDs are uncertain in the opposite durable root", async () => {
		const stateRoot = await makeStateRoot();
		await writeReceipt(stateRoot);
		const completion = completionTask("terminal");
		const doctor = doctorTask("terminal");
		await writeRepositoryFile(
			stateRoot,
			["tasks", doctor.taskId, "history", `${String(doctor.revision).padStart(12, "0")}.json`],
			`${JSON.stringify(doctor)}\n`,
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");

		const otherStateRoot = await makeStateRoot();
		await writeReceipt(otherStateRoot);
		await writeRepositoryFile(
			otherStateRoot,
			["doctor-tasks", completion.taskId, "history", `${String(completion.revision).padStart(12, "0")}.json`],
			`${JSON.stringify(completion)}\n`,
		);
		expect(await inspectVaultGitWorkState(otherStateRoot)).toBe("uncertain");
	});

	test("a phase-only transaction receipt is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "writing" })}\n`);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a phase-only closed receipt is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "closed" })}\n`);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a phase-only Completion Task is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "closed" })}\n`);
		await writeRepositoryFile(
			stateRoot,
			["tasks", "task-1", "history", "000000000002.json"],
			`${JSON.stringify({ phase: "running" })}\n`,
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a phase-only Doctor Task is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "closed" })}\n`);
		await writeRepositoryFile(
			stateRoot,
			["doctor-tasks", "doctor-1", "history", "000000000001.json"],
			`${JSON.stringify({ phase: "admitted" })}\n`,
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("phase-only terminal tasks stay uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "closed" })}\n`);
		await writeRepositoryFile(
			stateRoot,
			["tasks", "task-1", "history", "000000000003.json"],
			`${JSON.stringify({ phase: "terminal" })}\n`,
		);
		await writeRepositoryFile(
			stateRoot,
			["doctor-tasks", "doctor-1", "history", "000000000002.json"],
			`${JSON.stringify({ phase: "terminal" })}\n`,
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("phase-only revisions stay uncertain even when newest is terminal", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(
			stateRoot,
			["tasks", "task-1", "history", "000000000001.json"],
			`${JSON.stringify({ phase: "running" })}\n`,
		);
		await writeRepositoryFile(
			stateRoot,
			["tasks", "task-1", "history", "000000000002.json"],
			`${JSON.stringify({ phase: "terminal" })}\n`,
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a malformed receipt is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], "not json\n");
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("an unknown receipt phase is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "surprise" })}\n`);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a task with no readable history revision is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "closed" })}\n`);
		await mkdir(
			join(stateRoot, "vault-git-transaction-manager", REPOSITORY_ID, "tasks", "task-1", "history"),
			{ recursive: true, mode: 0o700 },
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a symlinked manager root is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		const elsewhere = join(stateRoot, "elsewhere");
		await mkdir(elsewhere, { recursive: true });
		await symlink(elsewhere, join(stateRoot, "vault-git-transaction-manager"));
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("a symlinked receipt is uncertain", async () => {
		const stateRoot = await makeStateRoot();
		const target = await writeRepositoryFile(
			stateRoot,
			["real-receipt.json"],
			`${JSON.stringify({ phase: "closed" })}\n`,
		);
		await symlink(
			target,
			join(stateRoot, "vault-git-transaction-manager", REPOSITORY_ID, "current.json"),
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});

	test("an unreadable manager root is uncertain", async () => {
		if (process.getuid?.() === 0) return;
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "closed" })}\n`);
		const managerRoot = join(stateRoot, "vault-git-transaction-manager");
		await chmod(managerRoot, 0o000);
		try {
			expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
		} finally {
			await chmod(managerRoot, 0o700);
		}
	});

	test("active receipt evidence with malformed task evidence stays uncertain", async () => {
		const stateRoot = await makeStateRoot();
		await writeRepositoryFile(stateRoot, ["current.json"], `${JSON.stringify({ phase: "writing" })}\n`);
		await writeRepositoryFile(
			stateRoot,
			["doctor-tasks", "doctor-1", "history", "000000000001.json"],
			"not json\n",
		);
		expect(await inspectVaultGitWorkState(stateRoot)).toBe("uncertain");
	});
});
