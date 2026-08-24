import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createVaultGitRuntimeSelectionFence,
	VaultGitRuntimeSelectionFenceBusyError,
} from "@side-quest/vault-git-transaction-manager";

import {
	createVaultGitHostEnrollment as createProductionVaultGitHostEnrollment,
	type VaultGitHostEnrollmentRoots,
} from "../src/vault-git-host-enrollment.ts";

const temporaryRoots: string[] = [];
const vaultGitInProcessTestFence = { hold: async <T>(operation: () => Promise<T>) => operation() };
const committedDotfilesRoot = join(import.meta.dir, "..", "..", "..", "..");

const createVaultGitHostEnrollment = (
	roots: Omit<VaultGitHostEnrollmentRoots, "runtimeSelectionFence"> & Partial<Pick<VaultGitHostEnrollmentRoots, "runtimeSelectionFence">>,
) => createProductionVaultGitHostEnrollment({ ...roots, runtimeSelectionFence: roots.runtimeSelectionFence ?? vaultGitInProcessTestFence });

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Vault Git Host Enrollment", () => {
	test("fresh host requires private enrollment inputs without mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
		});

		expect(await enrollment.inspect()).toEqual({
			state: "not_enrolled",
			station: "vault_git.host_enrollment_inputs_required",
			nextAction: {
				kind: "needs_input",
				actionId: "provide_host_enrollment_inputs",
				inputContractId: "setup.vault-git.host-enrollment",
				fields: [
					{ id: "ssh_identity_file_path", inputChannel: "private_stdin" },
					{ id: "ssh_public_key_path", inputChannel: "private_stdin" },
					{ id: "ssh_known_hosts_path", inputChannel: "private_stdin" },
				],
			},
			installedRuntime: null,
			selectedRuntime: null,
			priorRuntime: null,
		});

		for (const path of [configRoot, dataRoot, selectorPath]) {
			expect(await Bun.file(path).exists()).toBe(false);
		}
	});

	test("missing SSH prerequisites stop at the external owner without mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const selectorPath = join(root, "bin", "vault-git");
		const privatePaths = {
			sshIdentityFilePath: join(root, "private-identity-do-not-echo"),
			sshPublicKeyPath: join(root, "private-public-key-do-not-echo"),
			sshKnownHostsPath: join(root, "private-known-hosts-do-not-echo"),
		};
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
		});

		const result = await enrollment.preview(privatePaths);

		expect(result).toEqual({
			state: "needs_human",
			station: "vault_git.repository_ssh_prerequisite",
			nextAction: {
				kind: "needs_human",
				actionId: "provision_repository_ssh",
				owner: "repository_ssh_owner",
				condition: "dedicated_identity_ready",
			},
			missingPrerequisites: [
				"ssh_identity_file",
				"ssh_public_key",
				"ssh_known_hosts",
			],
			missingPrerequisiteDetails: [
				{ id: "ssh_identity_file", purpose: "dedicated_repository_ssh_identity", requirement: "regular_current_owner_private_file", expectedOwner: "current_user", expectedMode: "0400_or_0600" },
				{ id: "ssh_public_key", purpose: "matching_repository_ssh_public_key", requirement: "regular_file_matching_identity", expectedOwner: "any_user", expectedMode: "any_mode" },
				{ id: "ssh_known_hosts", purpose: "reviewed_repository_ssh_known_hosts", requirement: "nonempty_current_owner_private_file", expectedOwner: "current_user", expectedMode: "0600" },
			],
			installedRuntime: null,
			selectedRuntime: null,
			priorRuntime: null,
		});
		const publicText = JSON.stringify(result);
		for (const privatePath of Object.values(privatePaths)) {
			expect(publicText).not.toContain(privatePath);
		}
		for (const path of [configRoot, dataRoot, selectorPath]) {
			expect(await Bun.file(path).exists()).toBe(false);
		}
	});

	test("matching owner-only SSH inputs are ready for explicit enrollment", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const selectorPath = join(root, "bin", "vault-git");
		const sshIdentityFilePath = join(root, "repository-writer");
		const generated = Bun.spawnSync([
			"/usr/bin/ssh-keygen",
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-f",
			sshIdentityFilePath,
		]);
		expect(generated.exitCode).toBe(0);
		const sshPublicKeyPath = `${sshIdentityFilePath}.pub`;
		const sshKnownHostsPath = join(root, "known_hosts");
		await writeFile(
			sshKnownHostsPath,
			"github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureReviewedHostKey\n",
		);
		await chmod(sshIdentityFilePath, 0o600);
		await chmod(sshKnownHostsPath, 0o600);
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});

		const preview = await enrollment.preview({
				sshIdentityFilePath,
				sshPublicKeyPath,
				sshKnownHostsPath,
			});
		expect(preview).toMatchObject({
			state: "ready",
			station: "vault_git.host_enrollment_ready",
			nextAction: {
				kind: "needs_input",
				actionId: "apply_host_enrollment",
				inputContractId: "setup.vault-git.host-enrollment",
				fields: [
					{ id: "ssh_identity_file_path", inputChannel: "private_stdin" },
					{ id: "ssh_public_key_path", inputChannel: "private_stdin" },
					{ id: "ssh_known_hosts_path", inputChannel: "private_stdin" },
				],
			},
			installedRuntime: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
			selectedRuntime: null,
			priorRuntime: null,
			mutationPlan: {
				operation: "install_and_select",
				runtimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		for (const path of [configRoot, dataRoot, selectorPath]) {
			expect(await Bun.file(path).exists()).toBe(false);
		}
	});

	test("private identity source pathname is absent from ssh-keygen child argv and preview output", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const capturedArgv = join(root, "ssh-keygen-argv.txt");
		const keygen = join(root, "ssh-keygen-capture");
		await writeFile(
			keygen,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capturedArgv)}\nprintf '%s\\n' 'ssh-ed25519 fixture-public-key'\n`,
		);
		await chmod(keygen, 0o755);
		await writeFile(privateInput.sshPublicKeyPath, "ssh-ed25519 fixture-public-key\n");
		const enrollment = createVaultGitHostEnrollment({
			configRoot: join(root, "config"),
			dataRoot: join(root, "data"),
			selectorPath: join(root, "bin", "vault-git"),
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
			sshKeygenPath: keygen,
		});

		const preview = await enrollment.preview(privateInput);
		const childArgv = await readFile(capturedArgv, "utf8");
		expect(childArgv).toContain("-f");
		expect(childArgv).not.toContain(privateInput.sshIdentityFilePath);
		expect(JSON.stringify(preview)).not.toContain(privateInput.sshIdentityFilePath);
	});

	test("preview canonicalizes the macOS temp root when TMPDIR is absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const selectorPath = join(root, "bin", "vault-git");
		const runner = join(root, "preview-without-tmpdir.ts");
		const modulePath = join(import.meta.dir, "..", "src", "vault-git-host-enrollment.ts");
		await writeFile(
			runner,
			`const { createVaultGitHostEnrollment } = await import(${JSON.stringify(modulePath)});\n` +
				`const runtimeSelectionFence = { hold: async (operation) => operation() };\n` +
				`const enrollment = createVaultGitHostEnrollment({\n` +
				`  configRoot: ${JSON.stringify(configRoot)},\n` +
				`  dataRoot: ${JSON.stringify(dataRoot)},\n` +
				`  selectorPath: ${JSON.stringify(selectorPath)},\n` +
				`  sourceRepoRoot: ${JSON.stringify(sourceRepoRoot)},\n` +
				`  runtimeEntrypoint: ${JSON.stringify(runtimeEntrypoint)},\n` +
				`  inspectWorkState: async () => "clear",\n` +
				`  runtimeSelectionFence,\n` +
				`});\n` +
				`const result = await enrollment.preview(${JSON.stringify(privateInput)});\n` +
				`console.log(JSON.stringify(result));\n`,
		);
		const child = Bun.spawnSync([process.execPath, runner], {
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				HOME: join(root, "home"),
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				LC_ALL: "C",
			},
		});

		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(JSON.parse(child.stdout.toString())).toMatchObject({
			state: "ready",
			station: "vault_git.host_enrollment_ready",
			installedRuntime: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
			mutationPlan: { operation: "install_and_select" },
		});
		for (const path of [configRoot, dataRoot, selectorPath]) {
			expect(await Bun.file(path).exists()).toBe(false);
		}
	}, 60_000);

	test("explicit apply installs and selects one content-addressed runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});

		const first = await enrollment.apply(privateInput);
		expect(first.state).toBe("applied");
		if (first.state !== "applied") throw new Error("expected applied enrollment");
		expect(first.station).toBe("vault_git.runtime_selected");
		expect(first.hostHandle).toMatch(/^host_[a-f0-9]{32}$/);
		expect(first.installedRuntime?.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(first.selectedRuntime).toEqual(first.installedRuntime);
		expect(first.priorRuntime).toBeNull();
		const publicText = JSON.stringify(first);
		for (const privatePath of Object.values(privateInput)) {
			expect(publicText).not.toContain(privatePath);
		}

		const activationPath = join(configRoot, "activation.json");
		const activation = JSON.parse(await readFile(activationPath, "utf8"));
		expect(activation).toEqual({
			schema_version: 1,
			host_handle: first.hostHandle,
			ssh_identity_file_path: await realpath(privateInput.sshIdentityFilePath),
			ssh_public_key_path: await realpath(privateInput.sshPublicKeyPath),
			ssh_known_hosts_path: await realpath(privateInput.sshKnownHostsPath),
		});
		expect((await lstat(configRoot)).mode & 0o777).toBe(0o700);
		expect((await lstat(activationPath)).mode & 0o777).toBe(0o600);
		const selectedPath = await realpath(selectorPath);
		expect(selectedPath).toBe(
			join(await realpath(dataRoot), "runtimes", first.installedRuntime.digest, "vault-git"),
		);
		expect((await lstat(selectedPath)).mode & 0o111).not.toBe(0);

		const second = await enrollment.apply(privateInput);
		expect(second.state).toBe("noop");
		if (second.state !== "noop") throw new Error("expected no-op enrollment");
		expect(second.hostHandle).toBe(first.hostHandle);
		expect(second.selectedRuntime).toEqual(first.selectedRuntime);
		expect(second.priorRuntime).toBeNull();
		expect(await enrollment.inspect()).toEqual({
			state: "enrolled",
			station: "vault_git.runtime_selected",
			hostHandle: first.hostHandle,
			installedRuntime: first.installedRuntime,
			selectedRuntime: first.selectedRuntime,
			priorRuntime: null,
		});
	});

	test("apply installs a realpath-verified bun alias and repairs a missing alias on reinstall", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});

		const applied = await enrollment.apply(privateInput);
		if (applied.state !== "applied") throw new Error("expected applied enrollment");
		const runtimeRoot = join(dataRoot, "runtimes", applied.installedRuntime.digest);
		const aliasPath = join(runtimeRoot, "bun");
		expect((await lstat(aliasPath)).isSymbolicLink()).toBe(true);
		expect(await realpath(aliasPath)).toBe(
			await realpath(join(runtimeRoot, "vault-git")),
		);

		await rm(aliasPath);
		const repaired = await enrollment.apply(privateInput);
		expect(repaired.state).toBe("noop");
		expect(await realpath(aliasPath)).toBe(
			await realpath(join(runtimeRoot, "vault-git")),
		);
	});

	test("active work allows installation but refuses Runtime Selection", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "active",
		});

		const result = await enrollment.apply(privateInput);
		expect(result.state).toBe("blocked");
		if (result.state !== "blocked") throw new Error("expected blocked selection");
		expect(result).toEqual({
			state: "blocked",
			station: "vault_git.runtime_selection_blocked",
			nextAction: {
				kind: "needs_human",
				actionId: "wait_for_vault_git_idle",
				owner: "vault_git_operator",
				condition: "no_active_or_uncertain_work",
			},
			installedRuntime: expect.any(Object),
			selectedRuntime: null,
			priorRuntime: null,
		});
		expect(result.installedRuntime).not.toBeNull();
		expect(await Bun.file(join(dataRoot, "runtimes", result.installedRuntime?.digest ?? "missing", "vault-git")).exists()).toBe(true);
		expect(await Bun.file(join(configRoot, "activation.json")).exists()).toBe(false);
		expect(await Bun.file(selectorPath).exists()).toBe(false);
	});

	test("uncertain work refuses Runtime Selection while retaining the installation", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "uncertain",
		});

		const result = await enrollment.apply(privateInput);
		expect(result.state).toBe("blocked");
		if (result.state !== "blocked") throw new Error("expected blocked selection");
		expect(result.station).toBe("vault_git.runtime_selection_blocked");
		expect(result.installedRuntime).not.toBeNull();
		expect(await Bun.file(join(dataRoot, "runtimes", result.installedRuntime?.digest ?? "missing", "vault-git")).exists()).toBe(true);
		expect(await Bun.file(join(configRoot, "activation.json")).exists()).toBe(false);
		expect(await Bun.file(selectorPath).exists()).toBe(false);
	});

	test("a missing work-state seam refuses Runtime Selection", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
		});

		const result = await enrollment.apply(privateInput);
		expect(result.state).toBe("blocked");
		expect(await Bun.file(selectorPath).exists()).toBe(false);
	});

	test("fence acquisition contention maps apply and rollback to selector-free blocked results", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		let busy = false;
		const fixture = await createEnrollmentFixture(root, async () => "clear", {
			hold: async <T>(operation: () => Promise<T>) => {
				if (busy) throw new VaultGitRuntimeSelectionFenceBusyError();
				return operation();
			},
		});
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected selected runtime");
		busy = true;
			const blockedApply = await fixture.enrollment.apply(fixture.privateInput);
			expect(blockedApply).toMatchObject({
				state: "blocked",
				station: "vault_git.runtime_selection_blocked",
				selectedRuntime: null,
				priorRuntime: null,
			});
			if (blockedApply.state !== "blocked") throw new Error("expected blocked apply");
			expect(blockedApply.installedRuntime?.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(await fixture.enrollment.rollback(false)).toMatchObject({
			state: "blocked",
			station: "vault_git.runtime_selection_blocked",
			selectedRuntime: null,
			priorRuntime: null,
		});
	});

	test("upgrade retains one verified prior runtime and rollback is preview-first", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root, "runtime one");
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});
		const first = await enrollment.apply(privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await writeFile(runtimeEntrypoint, '#!/usr/bin/env bun\nconsole.log("runtime two");\n');
		git(sourceRepoRoot, ["add", "."]);
		git(sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "runtime two"]);
		git(sourceRepoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

		const second = await enrollment.apply(privateInput);
		if (second.state !== "applied") throw new Error("expected upgraded selection");
		expect(second.selectedRuntime.digest).not.toBe(first.selectedRuntime.digest);
		expect(second.priorRuntime).toEqual(first.selectedRuntime);

		const preview = await enrollment.rollback(true);
		expect(preview).toEqual({
			state: "changes",
			station: "vault_git.rollback_ready",
			selectedRuntime: second.selectedRuntime,
			priorRuntime: first.selectedRuntime,
		});
		expect(await realpath(selectorPath)).toContain(second.selectedRuntime.digest);

		const rolledBack = await enrollment.rollback(false);
		expect(rolledBack).toEqual({
			state: "applied",
			station: "vault_git.rollback_applied",
			selectedRuntime: first.selectedRuntime,
			priorRuntime: second.selectedRuntime,
		});
		expect(await realpath(selectorPath)).toContain(first.selectedRuntime.digest);
	});

	test("absent selector evidence requires reconciliation without mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const selectionPath = join(fixture.configRoot, "runtime-selection.json");

		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		const selectionBefore = await readFile(selectionPath, "utf8");
		await rm(fixture.selectorPath);
		expect(await fixture.enrollment.apply(fixture.privateInput)).toMatchObject({
			state: "blocked",
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await readFile(selectionPath, "utf8")).toBe(selectionBefore);
	});

	test("apply and rollback retain the fence through selector and selection-record publication", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const observed: boolean[] = [];
		const fixture = await createEnrollmentFixture(root, async () => "clear", {
			hold: async <T>(operation: () => Promise<T>) => {
				const result = await operation();
				observed.push(await Bun.file(fixture.selectorPath).exists() && await Bun.file(join(fixture.configRoot, "runtime-selection.json")).exists());
				return result;
			},
		});
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		const second = await fixture.enrollment.apply(fixture.privateInput);
		if (second.state !== "applied") throw new Error("expected upgraded selection");
		await fixture.enrollment.rollback(false);
		expect(observed).toEqual([true, true, true]);
	});

	test("concurrent applies serialize exact-commit source materialization and leave no source residue", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(
			root,
			async () => "clear",
			createVaultGitRuntimeSelectionFence(join(root, "state")),
		);
		const results = await Promise.all([
			fixture.enrollment.apply(fixture.privateInput),
			fixture.enrollment.apply(fixture.privateInput),
		]);
		expect(results.map((result) => result.state).sort()).toEqual(["applied", "noop"]);
		expect((await readdir(join(fixture.dataRoot, "runtimes"))).some((name) => name.startsWith(".source-"))).toBe(false);
	});

	test.each([
		["rollback first", "C"],
		["apply C first", "B"],
	] as const)("serialized %s follows current selection state without a pre-fence stale overwrite", async (ordering, expected) => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const serial = createSerialTestFence();
		const fixture = await createEnrollmentFixture(root, async () => "clear", serial.fence);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected A selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "B");
		const second = await fixture.enrollment.apply(fixture.privateInput);
		if (second.state !== "applied") throw new Error("expected B selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "C");

		const entered = serial.blockNext();
		const firstOperation = ordering === "rollback first"
			? fixture.enrollment.rollback(false)
			: fixture.enrollment.apply(fixture.privateInput);
		await entered;
		const secondOperation = ordering === "rollback first"
			? fixture.enrollment.apply(fixture.privateInput)
			: fixture.enrollment.rollback(false);
		serial.release();
		const [firstResult, secondResult] = await Promise.all([firstOperation, secondOperation]);
		const selected = JSON.parse(await readFile(join(fixture.configRoot, "runtime-selection.json"), "utf8")) as { selected_digest: string };
		const cResult = ordering === "rollback first" ? secondResult : firstResult;
		if (cResult.state !== "applied") throw new Error("expected C selection");
		const expectedDigest = expected === "C" ? cResult.selectedRuntime.digest : second.selectedRuntime.digest;
		expect(selected.selected_digest).toBe(expectedDigest);
		expect(await realpath(fixture.selectorPath)).toContain(expectedDigest);
	});

	test("a legacy self-prior Runtime Selection stays enrolled with a null prior on read", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const selectionPath = join(fixture.configRoot, "runtime-selection.json");

		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		const legacyRecord = `${JSON.stringify({
			schema_version: 1,
			selected_digest: first.selectedRuntime.digest,
			prior_digest: first.selectedRuntime.digest,
		})}\n`;
		await writeFile(selectionPath, legacyRecord, { mode: 0o600 });

		expect(await fixture.enrollment.inspect()).toEqual({
			state: "enrolled",
			station: "vault_git.runtime_selected",
			hostHandle: first.hostHandle,
			installedRuntime: first.selectedRuntime,
			selectedRuntime: first.selectedRuntime,
			priorRuntime: null,
		});

		await expect(fixture.enrollment.rollback(false)).rejects.toThrow(
			"prior Runtime Selection is unavailable",
		);
		expect(await realpath(fixture.selectorPath)).toContain(
			first.selectedRuntime.digest,
		);
		expect(await readFile(selectionPath, "utf8")).toBe(legacyRecord);
	});

	test("foreign selector is preserved and blocks enrollment", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const foreign = join(root, "foreign-vault-git");
		await writeFile(foreign, "foreign\n", { mode: 0o755 });
		await mkdir(join(root, "bin"), { recursive: true });
		await symlink(foreign, selectorPath);
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});

		expect(await enrollment.apply(privateInput)).toMatchObject({
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await readlink(selectorPath)).toBe(foreign);
		expect(await readFile(foreign, "utf8")).toBe("foreign\n");
		expect(await Bun.file(join(configRoot, "activation.json")).exists()).toBe(false);
	});

	test.each(["malformed", "widened_mode", "control_bytes", "symlink"] as const)(
		"existing %s Activation Configuration refuses enrollment without minting a replacement Host Handle",
		async (kind) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const fixture = await createEnrollmentFixture(root);
			const applied = await fixture.enrollment.apply(fixture.privateInput);
			if (applied.state !== "applied") throw new Error("expected selected runtime");
			const activationPath = join(fixture.configRoot, "activation.json");
			let preservedPath = activationPath;
			if (kind === "malformed") {
				await writeFile(activationPath, '{"not":"an activation configuration"}\n', { mode: 0o600 });
			} else if (kind === "widened_mode") {
				await chmod(activationPath, 0o644);
			} else if (kind === "control_bytes") {
				const activation = JSON.parse(await readFile(activationPath, "utf8"));
				activation.ssh_identity_file_path = "/private/fixture/id\u0000";
				await writeFile(activationPath, `${JSON.stringify(activation)}\n`, { mode: 0o600 });
			} else {
				const external = join(root, "external-activation.json");
				await writeFile(external, "external activation evidence\n", { mode: 0o600 });
				await rm(activationPath);
				await symlink(external, activationPath);
				preservedPath = external;
			}
			const before = await readFile(preservedPath, "utf8");

			expect(await fixture.enrollment.inspect()).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
				nextAction: {
					kind: "needs_human",
					actionId: "reconcile_host_enrollment_evidence",
					owner: "vault_git_operator",
					condition: "host_enrollment_evidence_reconciled",
				},
			});
			expect(await fixture.enrollment.apply(fixture.privateInput)).toMatchObject({
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await readFile(preservedPath, "utf8")).toBe(before);
			expect(await realpath(fixture.selectorPath)).toContain(applied.selectedRuntime.digest);
		},
	);

	test.each(["malformed", "widened_mode", "symlink"] as const)(
		"existing %s Runtime Selection evidence is preserved and refuses replacement",
		async (kind) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const fixture = await createEnrollmentFixture(root);
			const applied = await fixture.enrollment.apply(fixture.privateInput);
			if (applied.state !== "applied") throw new Error("expected selected runtime");
			const selectionPath = join(fixture.configRoot, "runtime-selection.json");
			let preservedPath = selectionPath;
			if (kind === "malformed") {
				await writeFile(selectionPath, "not json\n", { mode: 0o600 });
			} else if (kind === "widened_mode") {
				await chmod(selectionPath, 0o644);
			} else {
				const external = join(root, "external-selection.json");
				await writeFile(external, "external selection evidence\n", { mode: 0o600 });
				await rm(selectionPath);
				await symlink(external, selectionPath);
				preservedPath = external;
			}
			const before = await readFile(preservedPath, "utf8");
			expect(await fixture.enrollment.inspect()).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
				nextAction: {
					actionId: "reconcile_host_enrollment_evidence",
					owner: "vault_git_operator",
					condition: "host_enrollment_evidence_reconciled",
				},
			});
			expect(await fixture.enrollment.apply(fixture.privateInput)).toMatchObject({
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await readFile(preservedPath, "utf8")).toBe(before);
		},
	);

	test("corrupt selected runtime digest fails closed without replacement", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});
		const applied = await enrollment.apply(privateInput);
		if (applied.state !== "applied") throw new Error("expected selected runtime");
		const selectedPath = await realpath(selectorPath);
		await writeFile(selectedPath, "corrupt runtime\n", { mode: 0o755 });

		expect(await enrollment.apply(privateInput)).toMatchObject({
			state: "blocked",
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await realpath(selectorPath)).toBe(selectedPath);
		expect(await readFile(selectedPath, "utf8")).toBe("corrupt runtime\n");
	});

	test("invalid selection evidence requires reconciliation without replacement", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected selected runtime");
		const activation = await readFile(join(fixture.configRoot, "activation.json"), "utf8");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		const selectionPath = join(fixture.configRoot, "runtime-selection.json");
		await rm(selectionPath);
		await mkdir(selectionPath);

		expect(await fixture.enrollment.apply(fixture.privateInput)).toMatchObject({
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await realpath(fixture.selectorPath)).toContain(first.selectedRuntime.digest);
		expect(await readFile(join(fixture.configRoot, "activation.json"), "utf8")).toBe(activation);
	});

	test("preview and apply require reconciliation for mismatched enrollment evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected selected runtime");
		const selectionPath = join(fixture.configRoot, "runtime-selection.json");
		const originalSelection = await readFile(selectionPath, "utf8");
		await writeFile(selectionPath, `${JSON.stringify({
			schema_version: 1,
			selected_digest: "f".repeat(64),
			prior_digest: null,
		})}\n`, { mode: 0o600 });

		for (const result of [
			await fixture.enrollment.preview(fixture.privateInput),
			await fixture.enrollment.apply(fixture.privateInput),
		]) {
			expect(result).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
			});
		}
		expect(await readFile(selectionPath, "utf8")).not.toBe(originalSelection);
		expect(await realpath(fixture.selectorPath)).toContain(first.selectedRuntime.digest);
	});

	test("preview requires reconciliation when persisted evidence has no selector", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected selected runtime");
		await rm(fixture.selectorPath);

		expect(await fixture.enrollment.preview(fixture.privateInput)).toMatchObject({
			state: "blocked",
			station: "vault_git.host_enrollment_reconciliation_required",
		});
	});

	test.each([
		["apply", "apply_after_selector"],
		["apply", "apply_after_selection_record"],
		["rollback", "rollback_after_selector"],
		["rollback", "rollback_after_selection_record"],
	] as const)("%s publication failure at %s restores all owner-private evidence", async (operation, failingStep) => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		let fail = false;
		const fixture = await createEnrollmentFixture(
			root,
			async () => "clear",
			vaultGitInProcessTestFence,
			async (step) => {
				if (fail && step === failingStep) throw new Error(`injected ${step}`);
			},
		);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		if (operation === "rollback") {
			const second = await fixture.enrollment.apply(fixture.privateInput);
			if (second.state !== "applied") throw new Error("expected second selection");
		}
		const activationBefore = await readFile(join(fixture.configRoot, "activation.json"), "utf8");
		const selectionBefore = await readFile(join(fixture.configRoot, "runtime-selection.json"), "utf8");
		const selectorBefore = await readlink(fixture.selectorPath);
		fail = true;

		await expect(operation === "apply"
			? fixture.enrollment.apply(fixture.privateInput)
			: fixture.enrollment.rollback(false)).rejects.toThrow(`injected ${failingStep}`);
		expect(await readFile(join(fixture.configRoot, "activation.json"), "utf8")).toBe(activationBefore);
		expect(await readFile(join(fixture.configRoot, "runtime-selection.json"), "utf8")).toBe(selectionBefore);
		expect(await readlink(fixture.selectorPath)).toBe(selectorBefore);
	});

	test.each([0o050, 0o001] as const)(
		"a selected runtime with only group or other execute bits is not trusted (%o)",
		async (mode) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const fixture = await createEnrollmentFixture(root);
			const applied = await fixture.enrollment.apply(fixture.privateInput);
			if (applied.state !== "applied") throw new Error("expected selected runtime");
			await chmod(await realpath(fixture.selectorPath), mode);
		expect((await fixture.enrollment.inspect()).state).toBe("blocked");
		},
	);

	test("rollback apply during active or uncertain work returns a structured refusal", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		let workState: "clear" | "active" | "uncertain" = "clear";
		const fixture = await createEnrollmentFixture(root, async () => workState);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		const second = await fixture.enrollment.apply(fixture.privateInput);
		if (second.state !== "applied") throw new Error("expected upgraded selection");

		workState = "active";
		const refused = await fixture.enrollment.rollback(false);
		expect(refused).toEqual({
			state: "blocked",
			station: "vault_git.rollback_blocked",
			nextAction: {
				kind: "needs_human",
				actionId: "wait_for_vault_git_idle",
				owner: "vault_git_operator",
				condition: "no_active_or_uncertain_work",
			},
			selectedRuntime: second.selectedRuntime,
			priorRuntime: first.selectedRuntime,
		});

			workState = "uncertain";
		expect((await fixture.enrollment.rollback(false)).state).toBe("blocked");
		expect((await fixture.enrollment.rollback(true)).state).toBe("blocked");
			expect(await realpath(fixture.selectorPath)).toContain(second.selectedRuntime.digest);
		});

	test("rollback publication restores the exact contained-corrupt selector target after failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		let fail = false;
		const fixture = await createEnrollmentFixture(root, async () => "clear", vaultGitInProcessTestFence, async (step) => {
			if (fail && step === "rollback_after_selector") throw new Error("injected rollback_after_selector");
		});
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		const second = await fixture.enrollment.apply(fixture.privateInput);
		if (second.state !== "applied") throw new Error("expected second selection");
		const selectorBefore = await readlink(fixture.selectorPath);
		await writeFile(await realpath(fixture.selectorPath), "corrupt selected runtime\n", { mode: 0o755 });
		fail = true;

		await expect(fixture.enrollment.rollback(false)).rejects.toThrow("injected rollback_after_selector");
		expect(await readlink(fixture.selectorPath)).toBe(selectorBefore);
	});

	test("apply publication restores a recognized legacy source-linked selector literally after failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		let fail = false;
		const fixture = await createEnrollmentFixture(root, async () => "clear", vaultGitInProcessTestFence, async (step) => {
			if (fail && step === "apply_after_selector") throw new Error("injected apply_after_selector");
		});
		await mkdir(dirname(fixture.selectorPath), { recursive: true });
		await symlink(fixture.runtimeEntrypoint, fixture.selectorPath);
		const selectorBefore = await readlink(fixture.selectorPath);
		fail = true;

		await expect(fixture.enrollment.apply(fixture.privateInput)).rejects.toThrow("injected apply_after_selector");
		expect(await readlink(fixture.selectorPath)).toBe(selectorBefore);
	});

	test("an encrypted SSH identity fails closed as a missing matching public key without interactive input", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const sshIdentityFilePath = join(root, "encrypted-repository-writer");
		const generated = Bun.spawnSync(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "fixture-passphrase", "-f", sshIdentityFilePath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		expect(generated.exitCode, generated.stderr.toString()).toBe(0);
		const sshKnownHostsPath = join(root, "known_hosts");
		await writeFile(sshKnownHostsPath, "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureReviewedHostKey\n");
		await chmod(sshIdentityFilePath, 0o600);
		await chmod(sshKnownHostsPath, 0o600);
		const enrollment = createVaultGitHostEnrollment({ configRoot: join(root, "config"), dataRoot: join(root, "data"), selectorPath: join(root, "bin", "vault-git") });

		await expect(enrollment.preview({ sshIdentityFilePath, sshPublicKeyPath: `${sshIdentityFilePath}.pub`, sshKnownHostsPath })).resolves.toMatchObject({ state: "needs_human", missingPrerequisites: ["ssh_public_key"] });
	}, 5_000);

	test("rollback swaps a broken selected runtime onto the verified prior runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		const second = await fixture.enrollment.apply(fixture.privateInput);
		if (second.state !== "applied") throw new Error("expected upgraded selection");
		const selectedPath = await realpath(fixture.selectorPath);
		await writeFile(selectedPath, "broken selected runtime\n", { mode: 0o755 });

		expect(await fixture.enrollment.inspect()).toMatchObject({
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await fixture.enrollment.rollback(true)).toEqual({
			state: "changes",
			station: "vault_git.rollback_ready",
			selectedRuntime: second.selectedRuntime,
			priorRuntime: first.selectedRuntime,
		});
		expect(await fixture.enrollment.rollback(false)).toEqual({
			state: "applied",
			station: "vault_git.rollback_applied",
			selectedRuntime: first.selectedRuntime,
			priorRuntime: second.selectedRuntime,
		});
		expect(await realpath(fixture.selectorPath)).toContain(first.selectedRuntime.digest);
	});

	test.each(["invalid", "absent"] as const)(
		"rollback requires reconciliation when Activation Configuration is %s",
		async (kind) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const fixture = await createEnrollmentFixture(root);
			const first = await fixture.enrollment.apply(fixture.privateInput);
			if (first.state !== "applied") throw new Error("expected first selection");
			await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
			const second = await fixture.enrollment.apply(fixture.privateInput);
			if (second.state !== "applied") throw new Error("expected upgraded selection");
			const activationPath = join(fixture.configRoot, "activation.json");
			if (kind === "invalid") await writeFile(activationPath, "not activation json\n", { mode: 0o600 });
			else await rm(activationPath);

			expect(await fixture.enrollment.rollback(true)).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await fixture.enrollment.rollback(false)).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await realpath(fixture.selectorPath)).toContain(second.selectedRuntime.digest);
		},
	);

	test("rollback without a prior runtime fails closed without mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");

		await expect(fixture.enrollment.rollback(false)).rejects.toThrow(
			"prior Runtime Selection is unavailable",
		);
		expect(await realpath(fixture.selectorPath)).toContain(first.selectedRuntime.digest);
	});

	test("rollback with a corrupt prior runtime fails closed without mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");
		const second = await fixture.enrollment.apply(fixture.privateInput);
		if (second.state !== "applied") throw new Error("expected upgraded selection");
		await writeFile(
			join(fixture.dataRoot, "runtimes", first.selectedRuntime.digest, "vault-git"),
			"corrupt prior runtime\n",
			{ mode: 0o755 },
		);

		await expect(fixture.enrollment.rollback(false)).rejects.toThrow(
			"prior runtime is invalid",
		);
		expect(await realpath(fixture.selectorPath)).toContain(second.selectedRuntime.digest);
	});

	test("apply replaces a managed-but-corrupt selected runtime from proven new source", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");
		const selectedPath = await realpath(fixture.selectorPath);
		await writeFile(selectedPath, "corrupt selected runtime\n", { mode: 0o755 });
		await commitRuntimeSource(fixture.sourceRepoRoot, fixture.runtimeEntrypoint, "runtime two");

		const second = await fixture.enrollment.apply(fixture.privateInput);
		expect(second).toMatchObject({ station: "vault_git.host_enrollment_reconciliation_required" });
		expect(await realpath(fixture.selectorPath)).toBe(selectedPath);
	});

	test("unclean, unmerged, or uncompilable source fails closed without corrupting the selection", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected first selection");

		await writeFile(join(fixture.sourceRepoRoot, "untracked.txt"), "dirty\n");
		await expect(fixture.enrollment.apply(fixture.privateInput)).rejects.toThrow("not clean");
		await rm(join(fixture.sourceRepoRoot, "untracked.txt"));

		await writeFile(fixture.runtimeEntrypoint, '#!/usr/bin/env bun\nconsole.log("ahead");\n');
		git(fixture.sourceRepoRoot, ["add", "."]);
		git(fixture.sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "ahead"]);
		await expect(fixture.enrollment.apply(fixture.privateInput)).rejects.toThrow("not merged");

		git(fixture.sourceRepoRoot, ["update-ref", "-d", "refs/remotes/origin/main"]);
		await expect(fixture.enrollment.apply(fixture.privateInput)).rejects.toThrow("not ready");

		await writeFile(fixture.runtimeEntrypoint, "this is not a compilable entrypoint ((((\n");
		git(fixture.sourceRepoRoot, ["add", "."]);
		git(fixture.sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "broken"]);
		git(fixture.sourceRepoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		await expect(fixture.enrollment.apply(fixture.privateInput)).rejects.toThrow("not ready");

		expect(await realpath(fixture.selectorPath)).toContain(first.selectedRuntime.digest);
		const record = JSON.parse(
			await readFile(join(fixture.configRoot, "runtime-selection.json"), "utf8"),
		);
		expect(record.selected_digest).toBe(first.selectedRuntime.digest);
	});

	test("compilation remains bound to clean merged commit bytes when the live checkout mutates after binding", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root, "bound commit");
		const privateInput = await createSshFixture(root);
		const enrollment = createVaultGitHostEnrollment({
			configRoot: join(root, "config", "context", "vault-git"),
			dataRoot: join(root, "data", "context", "vault-git"),
			selectorPath: join(root, "bin", "vault-git"),
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
			onRuntimeSourceBound: async () => {
				await writeFile(runtimeEntrypoint, '#!/usr/bin/env bun\nconsole.log("live mutation");\n');
			},
		});

			const applied = await enrollment.apply(privateInput);
		if (applied.state !== "applied") throw new Error("expected selected runtime");
		const result = Bun.spawnSync([await realpath(join(root, "bin", "vault-git"))], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("bound commit\n");
		expect(await readFile(runtimeEntrypoint, "utf8")).toContain("live mutation");
			expect(await Bun.file(join(root, "data", "context", "vault-git", "runtimes", `.source-${gitOutput(sourceRepoRoot, ["rev-parse", "HEAD"])}`)).exists()).toBe(false);
		});

	test("frozen compilation rejects an undeclared dependency resolved from an ancestor node_modules", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixtureFromEntrypoint(
			root,
			'#!/usr/bin/env bun\nimport { ambientMarker } from "ambient-sentinel";\nconsole.log(ambientMarker);\n',
		);
		const privateInput = await createSshFixture(root);
		const dataRoot = join(root, "data", "context", "vault-git");
		const hostilePackageRoot = join(dataRoot, "node_modules", "ambient-sentinel");
		await mkdir(hostilePackageRoot, { recursive: true });
		await writeFile(join(hostilePackageRoot, "package.json"), '{"name":"ambient-sentinel","type":"module"}\n');
		await writeFile(join(hostilePackageRoot, "index.ts"), 'export const ambientMarker = "hostile ancestor";\n');
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot: join(root, "config", "context", "vault-git"),
			dataRoot,
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});

		await expect(enrollment.apply(privateInput)).rejects.toThrow("not ready");
		expect(await Bun.file(selectorPath).exists()).toBe(false);
	});

	test("a clean clone at committed HEAD archives workspace dependencies and runs Manager discovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-committed-clone-"));
		temporaryRoots.push(root);
		const sourceRepoRoot = join(root, "dotfiles");
		const committedHead = gitOutput(committedDotfilesRoot, ["rev-parse", "HEAD"]);
		const cloned = Bun.spawnSync([
			"/usr/bin/git",
			"clone",
			"--no-local",
			committedDotfilesRoot,
			sourceRepoRoot,
		], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
		});
		expect(cloned.exitCode, cloned.stderr.toString()).toBe(0);
		expect(gitOutput(sourceRepoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
		expect(gitOutput(sourceRepoRoot, ["rev-parse", "HEAD"])).toBe(committedHead);
		expect(gitOutput(sourceRepoRoot, ["rev-parse", "refs/remotes/origin/main"])).toBe(committedHead);
		const privateInput = await createSshFixture(root);
		const selectorPath = join(root, "bin", "vault-git");
		const enrollment = createVaultGitHostEnrollment({
			configRoot: join(root, "config", "context", "vault-git"),
			dataRoot: join(root, "data", "context", "vault-git"),
			selectorPath,
			sourceRepoRoot,
			runtimeEntrypoint: join(sourceRepoRoot, ".agents", "runtime", "vault-git-transaction-manager", "src", "cli.ts"),
			inspectWorkState: async () => "clear",
		});

		const enrolled = await enrollment.apply(privateInput);
		if (enrolled.state !== "applied") throw new Error("expected committed manager runtime selection");
		const discovery = Bun.spawnSync([await realpath(selectorPath), "commands", "--json"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
		});
		expect(discovery.exitCode, discovery.stderr.toString()).toBe(0);
		expect(JSON.parse(discovery.stdout.toString())).toMatchObject({
			status: "ok",
			data: { commands: expect.any(Object) },
		});
	}, 180_000);

	test("a crash-leftover deterministic source root is never reused for exact commit extraction", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root, "bound commit");
		const privateInput = await createSshFixture(root);
		const dataRoot = join(root, "data", "context", "vault-git");
		const commit = gitOutput(sourceRepoRoot, ["rev-parse", "HEAD"]);
		const residue = join(dataRoot, "runtimes", `.source-${commit}`);
		await mkdir(residue, { recursive: true, mode: 0o700 });
		await chmod(residue, 0o700);
		await writeFile(join(residue, "residue.ts"), 'console.log("residue");\n', { mode: 0o600 });
		const enrollment = createVaultGitHostEnrollment({
			configRoot: join(root, "config", "context", "vault-git"),
			dataRoot,
			selectorPath: join(root, "bin", "vault-git"),
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});
		const applied = await enrollment.apply(privateInput);
		if (applied.state !== "applied") throw new Error("expected selected runtime");
		expect((await lstat(residue)).isDirectory()).toBe(true);
	});

	test("a committed archive symlink is rejected before dependency materialization", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		await symlink("/private/outside", join(sourceRepoRoot, "unsafe-archive-link"));
		git(sourceRepoRoot, ["add", "unsafe-archive-link"]);
		git(sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unsafe archive link"]);
		git(sourceRepoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		const enrollment = createVaultGitHostEnrollment({
			configRoot: join(root, "config", "context", "vault-git"),
			dataRoot: join(root, "data", "context", "vault-git"),
			selectorPath: join(root, "bin", "vault-git"),
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
		});

		await expect(enrollment.apply(privateInput)).rejects.toThrow("unsafe archive symlink");
	});

	test.each(["unsafe\tarchive-link", "unsafe\narchive-link"])(
		"a committed archive symlink with a literal special filename is rejected before install: %p",
		async (linkName) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
			const privateInput = await createSshFixture(root);
			await symlink("/private/outside", join(sourceRepoRoot, linkName));
			git(sourceRepoRoot, ["add", "--", linkName]);
			git(sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unsafe archive link"]);
			git(sourceRepoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
			const enrollment = createVaultGitHostEnrollment({
				configRoot: join(root, "config", "context", "vault-git"),
				dataRoot: join(root, "data", "context", "vault-git"),
				selectorPath: join(root, "bin", "vault-git"),
				sourceRepoRoot,
				runtimeEntrypoint,
				inspectWorkState: async () => "clear",
			});

			await expect(enrollment.apply(privateInput)).rejects.toThrow("unsafe archive symlink");
		},
	);

	test("a symlinked runtime root is never reused or written through", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const fixture = await createEnrollmentFixture(root);
		const first = await fixture.enrollment.apply(fixture.privateInput);
		if (first.state !== "applied") throw new Error("expected selected runtime");
		const runtimesRoot = join(fixture.dataRoot, "runtimes");
		const external = join(root, "external-runtimes");
		await rename(runtimesRoot, external);
		await symlink(external, runtimesRoot);
		const externalBefore = await readdir(external);

		expect(await fixture.enrollment.apply(fixture.privateInput)).toMatchObject({
			state: "blocked",
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await readdir(external)).toEqual(externalBefore);
		expect(await Bun.file(join(external, first.installedRuntime.digest, "bun")).exists()).toBe(true);
	});

	test("a symlinked configuration root refuses enrollment writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
		temporaryRoots.push(root);
		const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
		const privateInput = await createSshFixture(root);
		const configRoot = join(root, "config", "context", "vault-git");
		const elsewhere = join(root, "elsewhere");
		await mkdir(elsewhere, { recursive: true });
		await mkdir(join(root, "config", "context"), { recursive: true });
		await symlink(elsewhere, configRoot);
		const enrollment = createVaultGitHostEnrollment({
			configRoot,
			dataRoot: join(root, "data", "context", "vault-git"),
			selectorPath: join(root, "bin", "vault-git"),
			sourceRepoRoot,
			runtimeEntrypoint,
			inspectWorkState: async () => "clear",
			runtimeSelectionFence: vaultGitInProcessTestFence,
		});

		expect(await enrollment.apply(privateInput)).toMatchObject({
			state: "blocked",
			station: "vault_git.host_enrollment_reconciliation_required",
		});
		expect(await readdir(elsewhere)).toEqual([]);
		expect(await Bun.file(join(root, "bin", "vault-git")).exists()).toBe(false);
	});

	test.each(["configRoot", "dataRoot", "selectorPath"] as const)(
		"a symlinked caller-controlled %s ancestor rejects without external or enrollment writes",
		async (unsafeRoot) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
			const privateInput = await createSshFixture(root);
			const externalTarget = join(root, "external-target");
			const configRoot = join(root, "config", "context", "vault-git");
			const dataRoot = join(root, "data", "context", "vault-git");
			const selectorPath = join(root, "bin", "vault-git");
			const symlinkAncestor = join(root, `unsafe-${unsafeRoot}`);
			await mkdir(externalTarget, { recursive: true });
			await symlink(externalTarget, symlinkAncestor);
			const roots = {
				configRoot:
					unsafeRoot === "configRoot"
						? join(symlinkAncestor, "context", "vault-git")
						: configRoot,
				dataRoot:
					unsafeRoot === "dataRoot"
						? join(symlinkAncestor, "context", "vault-git")
						: dataRoot,
				selectorPath:
					unsafeRoot === "selectorPath"
						? join(symlinkAncestor, "bin", "vault-git")
						: selectorPath,
			};
			const enrollment = createVaultGitHostEnrollment({
				...roots,
				sourceRepoRoot,
				runtimeEntrypoint,
				inspectWorkState: async () => "clear",
				runtimeSelectionFence: vaultGitInProcessTestFence,
			});

			expect(await enrollment.apply(privateInput)).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await readdir(externalTarget)).toEqual([]);
			for (const path of [
				roots.selectorPath,
				join(roots.configRoot, "activation.json"),
				join(roots.configRoot, "runtime-selection.json"),
			]) {
				expect(await Bun.file(path).exists()).toBe(false);
			}
		},
	);

	test.each(["configRoot", "dataRoot"] as const)(
		"coherent evidence below a symlinked %s ancestor reconciles without external mutation",
		async (unsafeRoot) => {
			const root = await mkdtemp(join(tmpdir(), "setup-vault-git-enrollment-"));
			temporaryRoots.push(root);
			const fixture = await createEnrollmentFixture(root);
			const enrolled = await fixture.enrollment.apply(fixture.privateInput);
			if (enrolled.state !== "applied") throw new Error("expected enrolled fixture");
			const ownerRoot = unsafeRoot === "configRoot" ? fixture.configRoot : fixture.dataRoot;
			const ancestor = dirname(ownerRoot);
			const external = join(root, `external-${unsafeRoot}`);
			await rename(ancestor, external);
			await symlink(external, ancestor);
			const snapshot = await readdir(external, { recursive: true });

			expect(await fixture.enrollment.inspect()).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await fixture.enrollment.rollback(false)).toMatchObject({
				state: "blocked",
				station: "vault_git.host_enrollment_reconciliation_required",
			});
			expect(await readdir(external, { recursive: true })).toEqual(snapshot);
		},
	);
});

async function createEnrollmentFixture(
	root: string,
	inspectWorkState: () => Promise<"clear" | "active" | "uncertain"> = async () => "clear",
	runtimeSelectionFence = vaultGitInProcessTestFence,
	onPublicationStep?: VaultGitHostEnrollmentRoots["onPublicationStep"],
) {
	const { sourceRepoRoot, runtimeEntrypoint } = await createSourceFixture(root);
	const privateInput = await createSshFixture(root);
	const configRoot = join(root, "config", "context", "vault-git");
	const dataRoot = join(root, "data", "context", "vault-git");
	const selectorPath = join(root, "bin", "vault-git");
	const enrollment = createVaultGitHostEnrollment({
		configRoot,
		dataRoot,
		selectorPath,
		sourceRepoRoot,
		runtimeEntrypoint,
		inspectWorkState,
		runtimeSelectionFence,
		onPublicationStep,
	});
	return {
		enrollment,
		sourceRepoRoot,
		runtimeEntrypoint,
		privateInput,
		configRoot,
		dataRoot,
		selectorPath,
	};
}

async function commitRuntimeSource(
	sourceRepoRoot: string,
	runtimeEntrypoint: string,
	source: string,
): Promise<void> {
	await writeFile(runtimeEntrypoint, `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(source)});\n`);
	git(sourceRepoRoot, ["add", "."]);
	git(sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", source]);
	git(sourceRepoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
}

async function createSourceFixture(root: string, source = "fixture vault git") {
	return createSourceFixtureFromEntrypoint(
		root,
		`#!/usr/bin/env bun\nconsole.log(${JSON.stringify(source)});\n`,
	);
}

async function createSourceFixtureFromEntrypoint(root: string, entrypointSource: string) {
	const sourceRepoRoot = join(root, "source");
	const runtimeEntrypoint = join(sourceRepoRoot, "src", "cli.ts");
	await mkdir(join(sourceRepoRoot, "src"), { recursive: true });
	await writeFile(runtimeEntrypoint, entrypointSource);
	await writeFile(join(sourceRepoRoot, "package.json"), `${JSON.stringify({ name: "vault-git-source-fixture", private: true })}\n`);
	const locked = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts", "--no-save", "--no-progress", "--no-summary"], {
		cwd: sourceRepoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: `${join(process.execPath, "..") }:/usr/bin:/bin`, LC_ALL: "C" },
	});
	if (locked.exitCode !== 0) throw new Error("fixture lockfile install failed");
	git(sourceRepoRoot, ["init", "--initial-branch=main"]);
	git(sourceRepoRoot, ["add", "."]);
	git(sourceRepoRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
	git(sourceRepoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	return { sourceRepoRoot, runtimeEntrypoint };
}

async function createSshFixture(root: string) {
	const sshIdentityFilePath = join(root, "repository-writer");
	const generated = Bun.spawnSync([
		"/usr/bin/ssh-keygen",
		"-q",
		"-t",
		"ed25519",
		"-N",
		"",
		"-f",
		sshIdentityFilePath,
	]);
	if (generated.exitCode !== 0) throw new Error("fixture ssh-keygen failed");
	const sshPublicKeyPath = `${sshIdentityFilePath}.pub`;
	const sshKnownHostsPath = join(root, "known_hosts");
	await writeFile(
		sshKnownHostsPath,
		"github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureReviewedHostKey\n",
	);
	await chmod(sshIdentityFilePath, 0o600);
	await chmod(sshKnownHostsPath, 0o600);
	return { sshIdentityFilePath, sshPublicKeyPath, sshKnownHostsPath };
}

function git(cwd: string, args: readonly string[]): void {
	const result = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0] ?? "command"} failed`);
	}
}

function gitOutput(cwd: string, args: readonly string[]): string {
	const result = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
	});
	if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed`);
	return result.stdout.toString().trim();
}

function createSerialTestFence() {
	let tail = Promise.resolve();
	let block: { readonly entered: () => void; readonly gate: Promise<void>; readonly release: () => void } | undefined;
	let active: typeof block;
	return {
		fence: {
			hold: async <T>(operation: () => Promise<T>) => {
				const previous = tail;
				let releaseTail: (() => void) | undefined;
				tail = new Promise<void>((resolve) => { releaseTail = resolve; });
				await previous;
				const current = block;
				block = undefined;
				active = current;
				current?.entered();
				if (current) await current.gate;
				active = undefined;
				try {
					return await operation();
				} finally {
					releaseTail?.();
				}
			},
		},
		blockNext() {
			let entered: (() => void) | undefined;
			let release: (() => void) | undefined;
			const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
			const gate = new Promise<void>((resolve) => { release = resolve; });
			block = { entered: () => entered?.(), gate, release: () => release?.() };
			return enteredPromise;
		},
		release() { active?.release(); },
	};
}
