import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	VaultGitRuntimeSelectionFenceBusyError,
	type VaultGitRuntimeSelectionFence,
} from "@side-quest/vault-git-transaction-manager";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HOST_HANDLE_PATTERN = /^host_[a-f0-9]{32}$/u;

/** Isolated owner roots for Vault Git Host Enrollment and Runtime Selection. */
export interface VaultGitHostEnrollmentRoots {
	readonly configRoot: string;
	readonly dataRoot: string;
	readonly selectorPath: string;
	readonly sourceRepoRoot?: string;
	readonly runtimeEntrypoint?: string;
	readonly inspectWorkState?: () => Promise<"clear" | "active" | "uncertain">;
	/** Vault Git-owned mutual exclusion covering the final selection publication. */
	readonly runtimeSelectionFence: VaultGitRuntimeSelectionFence;
	/** Test-only barrier after exact commit bytes are materialized. */
	readonly onRuntimeSourceBound?: () => Promise<void>;
	/** Test-only deterministic publication fault/barrier seam. */
	readonly onPublicationStep?: (step: VaultGitHostEnrollmentPublicationStep) => Promise<void>;
	/** Test-only executable used to capture the private-key derivation child argv. */
	readonly sshKeygenPath?: string;
}

export type VaultGitHostEnrollmentPublicationStep =
	| "apply_after_activation"
	| "apply_after_selector"
	| "apply_after_selection_record"
	| "rollback_after_selector"
	| "rollback_after_selection_record";

export interface VaultGitHostEnrollmentInputField {
	readonly id:
		| "ssh_identity_file_path"
		| "ssh_public_key_path"
		| "ssh_known_hosts_path";
	readonly inputChannel: "private_stdin";
}

/** The one immutable private-input descriptor projected by inspect and preview. */
export const VAULT_GIT_HOST_ENROLLMENT_INPUT_FIELDS = [
	{ id: "ssh_identity_file_path", inputChannel: "private_stdin" },
	{ id: "ssh_public_key_path", inputChannel: "private_stdin" },
	{ id: "ssh_known_hosts_path", inputChannel: "private_stdin" },
] as const satisfies readonly VaultGitHostEnrollmentInputField[];

export interface VaultGitHostEnrollmentStatus {
	readonly state: "not_enrolled";
	readonly station: "vault_git.host_enrollment_inputs_required";
	readonly nextAction: {
		readonly kind: "needs_input";
		readonly actionId: "provide_host_enrollment_inputs";
		readonly inputContractId: "setup.vault-git.host-enrollment";
		readonly fields: readonly VaultGitHostEnrollmentInputField[];
	};
	readonly installedRuntime: null;
	readonly selectedRuntime: null;
	readonly priorRuntime: null;
}

export interface VaultGitHostEnrollmentEnrolledStatus {
	readonly state: "enrolled";
	readonly station: "vault_git.runtime_selected";
	readonly hostHandle: string;
	readonly installedRuntime: VaultGitRuntimeReference;
	readonly selectedRuntime: VaultGitRuntimeReference;
	readonly priorRuntime: VaultGitRuntimeReference | null;
}

export interface VaultGitHostEnrollmentInput {
	readonly sshIdentityFilePath: string;
	readonly sshPublicKeyPath: string;
	readonly sshKnownHostsPath: string;
}

export type VaultGitSshPrerequisite =
	| "ssh_identity_file"
	| "ssh_public_key"
	| "ssh_known_hosts";

export interface VaultGitSshPrerequisiteDetail {
	readonly id: VaultGitSshPrerequisite;
	readonly purpose:
		| "dedicated_repository_ssh_identity"
		| "matching_repository_ssh_public_key"
		| "reviewed_repository_ssh_known_hosts";
	readonly requirement:
		| "regular_current_owner_private_file"
		| "regular_file_matching_identity"
		| "nonempty_current_owner_private_file";
	readonly expectedOwner: "current_user" | "any_user";
	readonly expectedMode: "0400_or_0600" | "0600" | "any_mode";
}

export interface VaultGitHostEnrollmentPrerequisiteStatus {
	readonly state: "needs_human";
	readonly station: "vault_git.repository_ssh_prerequisite";
	readonly nextAction: {
		readonly kind: "needs_human";
		readonly actionId: "provision_repository_ssh";
		readonly owner: "repository_ssh_owner";
		readonly condition: "dedicated_identity_ready";
	};
	readonly missingPrerequisites: readonly VaultGitSshPrerequisite[];
	readonly missingPrerequisiteDetails: readonly VaultGitSshPrerequisiteDetail[];
	readonly installedRuntime: null;
	readonly selectedRuntime: null;
	readonly priorRuntime: null;
}

export interface VaultGitHostEnrollmentReconciliationStatus {
	readonly state: "blocked";
	readonly station: "vault_git.host_enrollment_reconciliation_required";
	readonly nextAction: {
		readonly kind: "needs_human";
		readonly actionId: "reconcile_host_enrollment_evidence";
		readonly owner: "vault_git_operator";
		readonly condition: "host_enrollment_evidence_reconciled";
	};
	readonly installedRuntime: null;
	readonly selectedRuntime: null;
	readonly priorRuntime: null;
}

export interface VaultGitHostEnrollmentReadyStatus {
	readonly state: "ready";
	readonly station: "vault_git.host_enrollment_ready";
	readonly nextAction: {
		readonly kind: "needs_input";
		readonly actionId: "apply_host_enrollment";
		readonly inputContractId: "setup.vault-git.host-enrollment";
		readonly fields: readonly VaultGitHostEnrollmentInputField[];
	};
	readonly installedRuntime: VaultGitRuntimeReference;
	readonly selectedRuntime: null;
	readonly priorRuntime: null;
	readonly mutationPlan: {
		readonly operation: "install_and_select";
		readonly runtimeDigest: string;
	};
}

export interface VaultGitRuntimeReference {
	readonly digest: string;
}

export interface VaultGitHostEnrollmentAppliedStatus {
	readonly state: "applied" | "noop";
	readonly station: "vault_git.runtime_selected";
	readonly hostHandle: string;
	readonly installedRuntime: VaultGitRuntimeReference;
	readonly selectedRuntime: VaultGitRuntimeReference;
	readonly priorRuntime: VaultGitRuntimeReference | null;
}

export interface VaultGitRuntimeSelectionBlockedStatus {
	readonly state: "blocked";
	readonly station: "vault_git.runtime_selection_blocked";
	readonly nextAction: {
		readonly kind: "needs_human";
		readonly actionId: "wait_for_vault_git_idle";
		readonly owner: "vault_git_operator";
		readonly condition: "no_active_or_uncertain_work";
	};
	readonly installedRuntime: VaultGitRuntimeReference | null;
	readonly selectedRuntime: null;
	readonly priorRuntime: null;
}

export interface VaultGitRuntimeRollbackStatus {
	readonly state: "changes" | "applied";
	readonly station: "vault_git.rollback_ready" | "vault_git.rollback_applied";
	readonly selectedRuntime: VaultGitRuntimeReference;
	readonly priorRuntime: VaultGitRuntimeReference;
}

export interface VaultGitRuntimeRollbackBlockedStatus {
	readonly state: "blocked";
	readonly station: "vault_git.rollback_blocked";
	readonly nextAction: {
		readonly kind: "needs_human";
		readonly actionId: "wait_for_vault_git_idle";
		readonly owner: "vault_git_operator";
		readonly condition: "no_active_or_uncertain_work";
	};
	readonly selectedRuntime: VaultGitRuntimeReference;
	readonly priorRuntime: VaultGitRuntimeReference;
}

export type VaultGitHostEnrollmentResult =
	| VaultGitHostEnrollmentStatus
	| VaultGitHostEnrollmentEnrolledStatus
	| VaultGitHostEnrollmentPrerequisiteStatus
	| VaultGitHostEnrollmentReadyStatus
	| VaultGitHostEnrollmentAppliedStatus
	| VaultGitHostEnrollmentReconciliationStatus
	| VaultGitRuntimeSelectionBlockedStatus
	| VaultGitRuntimeRollbackStatus
	| VaultGitRuntimeRollbackBlockedStatus;

export interface VaultGitHostEnrollment {
	inspect(): Promise<
		| VaultGitHostEnrollmentStatus
		| VaultGitHostEnrollmentEnrolledStatus
		| VaultGitHostEnrollmentReconciliationStatus
	>;
	preview(
		input: VaultGitHostEnrollmentInput,
	): Promise<
		| VaultGitHostEnrollmentPrerequisiteStatus
		| VaultGitHostEnrollmentReadyStatus
		| VaultGitHostEnrollmentReconciliationStatus
	>;
	apply(input: VaultGitHostEnrollmentInput): Promise<
		| VaultGitHostEnrollmentPrerequisiteStatus
		| VaultGitHostEnrollmentAppliedStatus
		| VaultGitRuntimeSelectionBlockedStatus
		| VaultGitHostEnrollmentReconciliationStatus
	>;
	rollback(
		check: boolean,
	): Promise<
		| VaultGitRuntimeRollbackStatus
		| VaultGitRuntimeRollbackBlockedStatus
		| VaultGitRuntimeSelectionBlockedStatus
		| VaultGitHostEnrollmentReconciliationStatus
	>;
}

interface ValidatedEnrollmentInput {
	readonly sshIdentityFilePath: string;
	readonly sshPublicKeyPath: string;
	readonly sshKnownHostsPath: string;
}

interface ActivationConfiguration {
	readonly schema_version: 1;
	readonly host_handle: string;
	readonly ssh_identity_file_path: string;
	readonly ssh_public_key_path: string;
	readonly ssh_known_hosts_path: string;
}

interface RuntimeSelectionRecord {
	readonly schema_version: 1;
	readonly selected_digest: string;
	readonly prior_digest: string | null;
}

async function resolveRegularFile(path: string): Promise<string | undefined> {
	try {
		const configured = await lstat(path, { bigint: true });
		if (configured.isSymbolicLink() || !configured.isFile()) return undefined;
		const canonical = await realpath(path);
		const resolved = await lstat(canonical, { bigint: true });
		if (
			resolved.isSymbolicLink() ||
			!resolved.isFile() ||
			configured.dev !== resolved.dev ||
			configured.ino !== resolved.ino
		) {
			return undefined;
		}
		return canonical;
	} catch {
		return undefined;
	}
}

async function ownerOnlyFile(
	path: string,
	modeIsValid: (mode: bigint) => boolean,
): Promise<string | undefined> {
	const canonical = await resolveRegularFile(path);
	if (!canonical) return undefined;
	try {
		const metadata = await lstat(canonical, { bigint: true });
		const uid = process.getuid?.();
		if (!modeIsValid(metadata.mode) || (uid !== undefined && metadata.uid !== BigInt(uid))) {
			return undefined;
		}
		return canonical;
	} catch {
		return undefined;
	}
}

function publicKeyMaterial(value: string): string | undefined {
	const [algorithm, key] = value.trim().split(/\s+/u);
	return algorithm && key ? `${algorithm} ${key}` : undefined;
}

async function matchingPublicKey(
	roots: VaultGitHostEnrollmentRoots,
	privateKeyPath: string,
	publicKeyPath: string,
): Promise<boolean> {
	let scratch: string | undefined;
	try {
		scratch = await mkdtemp(join(tmpdir(), "vault-git-identity-"));
		await chmod(scratch, 0o700);
		const scratchEntry = await lstat(scratch);
		if (!scratchEntry.isDirectory() || scratchEntry.isSymbolicLink() || !isCurrentOwnerPrivate(scratchEntry, 0o700)) {
			return false;
		}
		// The original private pathname is never given to a child process. A
		// short-lived, owner-private copy gives ssh-keygen a generic child-visible
		// path while preserving its ordinary file-based input contract.
		const aliasPath = join(scratch, "identity");
		const alias = await open(aliasPath, "wx", 0o600);
		try {
			await alias.writeFile(await readFile(privateKeyPath));
			await alias.sync();
		} finally {
			await alias.close();
		}
		await chmod(aliasPath, 0o600);
		const generated = Bun.spawnSync(
			[roots.sshKeygenPath ?? "/usr/bin/ssh-keygen", "-y", "-P", "", "-f", aliasPath],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
			},
		);
		if (generated.exitCode !== 0) return false;
		const [derived, configured] = await Promise.all([
			Promise.resolve(generated.stdout.toString()),
			readFile(publicKeyPath, "utf8"),
		]);
		return publicKeyMaterial(derived) === publicKeyMaterial(configured);
	} catch {
		return false;
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}

async function validateEnrollmentInput(roots: VaultGitHostEnrollmentRoots, input: VaultGitHostEnrollmentInput): Promise<{
	readonly validated?: ValidatedEnrollmentInput;
	readonly missingPrerequisites: readonly VaultGitSshPrerequisite[];
}> {
	const [privateKeyPath, publicKeyPath, knownHostsPath] = await Promise.all([
		ownerOnlyFile(
			input.sshIdentityFilePath,
			(mode) => (mode & 0o077n) === 0n && (mode & 0o400n) !== 0n,
		),
		resolveRegularFile(input.sshPublicKeyPath),
		ownerOnlyFile(
			input.sshKnownHostsPath,
			(mode) => (mode & 0o777n) === 0o600n,
		),
	]);
	let knownHostsReady = false;
	if (knownHostsPath) {
		try {
			knownHostsReady = (await readFile(knownHostsPath, "utf8")).trim() !== "";
		} catch {
			knownHostsReady = false;
		}
	}
	const checks = [
		privateKeyPath !== undefined,
		privateKeyPath !== undefined && publicKeyPath !== undefined
			? await matchingPublicKey(roots, privateKeyPath, publicKeyPath)
			: false,
		knownHostsReady,
	];
	const prerequisiteNames: readonly VaultGitSshPrerequisite[] = [
		"ssh_identity_file",
		"ssh_public_key",
		"ssh_known_hosts",
	];
	const missingPrerequisites = prerequisiteNames.filter(
		(_prerequisite, index) => !checks[index],
	);
	return missingPrerequisites.length === 0 && privateKeyPath && publicKeyPath && knownHostsPath
		? {
			validated: {
				sshIdentityFilePath: privateKeyPath,
				sshPublicKeyPath: publicKeyPath,
				sshKnownHostsPath: knownHostsPath,
			},
			missingPrerequisites,
		}
		: { missingPrerequisites };
}

function prerequisiteStatus(
	missingPrerequisites: readonly VaultGitSshPrerequisite[],
): VaultGitHostEnrollmentPrerequisiteStatus {
	return {
		state: "needs_human",
		station: "vault_git.repository_ssh_prerequisite",
		nextAction: {
			kind: "needs_human",
			actionId: "provision_repository_ssh",
			owner: "repository_ssh_owner",
			condition: "dedicated_identity_ready",
		},
		missingPrerequisites,
		missingPrerequisiteDetails: missingPrerequisites.map(prerequisiteDetail),
		installedRuntime: null,
		selectedRuntime: null,
		priorRuntime: null,
	};
}

function prerequisiteDetail(
	id: VaultGitSshPrerequisite,
): VaultGitSshPrerequisiteDetail {
	if (id === "ssh_identity_file") {
		return {
			id,
			purpose: "dedicated_repository_ssh_identity",
			requirement: "regular_current_owner_private_file",
			expectedOwner: "current_user",
			expectedMode: "0400_or_0600",
		};
	}
	if (id === "ssh_public_key") {
		return {
			id,
			purpose: "matching_repository_ssh_public_key",
			requirement: "regular_file_matching_identity",
			expectedOwner: "any_user",
			expectedMode: "any_mode",
		};
	}
	return {
		id,
		purpose: "reviewed_repository_ssh_known_hosts",
		requirement: "nonempty_current_owner_private_file",
		expectedOwner: "current_user",
		expectedMode: "0600",
	};
}

function runChecked(
	command: readonly string[],
	cwd: string,
): string {
	const result = Bun.spawnSync([...command], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			LC_ALL: "C",
		},
	});
	if (result.exitCode !== 0) {
		throw new Error("Vault Git runtime source or compilation is not ready");
	}
	return result.stdout.toString().trim();
}

/** Run a fixed command and retain raw stdout for NUL-delimited Git records. */
function runCheckedBytes(command: readonly string[], cwd: string): Uint8Array {
	const result = Bun.spawnSync([...command], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			LC_ALL: "C",
		},
	});
	if (result.exitCode !== 0) {
		throw new Error("Vault Git runtime source or compilation is not ready");
	}
	return result.stdout;
}

async function cleanMergedSource(roots: VaultGitHostEnrollmentRoots): Promise<{
	readonly sourceRepoRoot: string;
	readonly entryRelative: string;
	readonly commit: string;
	readonly archivePaths: readonly string[];
}> {
	if (!roots.sourceRepoRoot || !roots.runtimeEntrypoint) {
		throw new Error("Vault Git runtime source is not configured");
	}
	const [sourceRepoRoot, runtimeEntrypoint] = await Promise.all([
		realpath(roots.sourceRepoRoot),
		realpath(roots.runtimeEntrypoint),
	]);
	const entryRelative = relative(sourceRepoRoot, runtimeEntrypoint);
	if (
		entryRelative === "" ||
		entryRelative === ".." ||
		entryRelative.startsWith("../") ||
		isAbsolute(entryRelative)
	) {
		throw new Error("Vault Git runtime entrypoint escapes its source repository");
	}
	const status = runChecked(
		["/usr/bin/git", "status", "--porcelain=v1", "--untracked-files=all"],
		sourceRepoRoot,
	);
	if (status !== "") throw new Error("Vault Git runtime source is not clean");
	const head = runChecked(["/usr/bin/git", "rev-parse", "HEAD"], sourceRepoRoot);
	const merged = runChecked(
		["/usr/bin/git", "rev-parse", "refs/remotes/origin/main"],
		sourceRepoRoot,
	);
	if (head !== merged) throw new Error("Vault Git runtime source is not merged to origin/main");
	const archivePaths = archivePathsForEntrypoint(entryRelative);
	const tree = runCheckedBytes(
		["/usr/bin/git", "ls-tree", "-r", "-z", "--full-tree", head],
		sourceRepoRoot,
	);
	if (containsUnsafeArchiveSymlink(tree, archivePaths)) {
		throw new Error("Vault Git runtime source contains an unsafe archive symlink");
	}
	return { sourceRepoRoot, entryRelative, commit: head, archivePaths };
}

/**
 * `git ls-tree -z` is an on-disk protocol, not display text: quoted newlines
 * and tabs must remain literal path bytes until the record separator is read.
 */
function containsUnsafeArchiveSymlink(
	tree: Uint8Array,
	archivePaths: readonly string[],
): boolean {
	for (const record of Buffer.from(tree).toString("utf8").split("\0")) {
		if (record.length === 0) continue;
		const tab = record.indexOf("\t");
		if (tab < 0 || !record.startsWith("120000 ")) continue;
		if (archivePathIncludes(archivePaths, record.slice(tab + 1))) return true;
	}
	return false;
}

/**
 * The Manager entrypoint is a workspace product, not an archive of every
 * dotfiles projection. Archive its declared workspace closure so unrelated
 * source-linked user configuration cannot influence frozen dependency install.
 * Other source roots retain the whole-tree fixture contract.
 */
function archivePathsForEntrypoint(entryRelative: string): readonly string[] {
	if (entryRelative !== ".agents/runtime/vault-git-transaction-manager/src/cli.ts") return [];
	return [
		"package.json",
		"bun.lock",
		".agents/runtime",
		"config/agents/skills/personal",
		"apps/vscode",
	];
}

function archivePathIncludes(archivePaths: readonly string[], path: string): boolean {
	return archivePaths.length === 0 || archivePaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
}

async function materializeCleanMergedSource(
	roots: VaultGitHostEnrollmentRoots,
	runtimesRoot: string,
): Promise<{ readonly sourceRoot: string; readonly runtimeEntrypoint: string }> {
	const source = await cleanMergedSource(roots);
	const sourceRoot = join(runtimesRoot, `.source-${source.commit}-${randomUUID()}`);
	await createFreshPrivateDirectory(sourceRoot);
	try {
		const archive = Bun.spawnSync(
			["/usr/bin/git", "archive", "--format=tar", source.commit, "--", ...source.archivePaths],
			{
				cwd: source.sourceRepoRoot,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
			},
		);
		if (archive.exitCode !== 0 || archive.stdout.byteLength === 0) {
			throw new Error("Vault Git runtime source or compilation is not ready");
		}
		const extracted = Bun.spawnSync(["/usr/bin/tar", "-xf", "-", "-C", sourceRoot], {
			stdin: archive.stdout,
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
		});
		if (extracted.exitCode !== 0) {
			throw new Error("Vault Git runtime source or compilation is not ready");
		}
		runChecked(
			[
				process.execPath,
				"install",
				"--frozen-lockfile",
				"--ignore-scripts",
				"--no-save",
				"--backend",
				"copyfile",
				"--cache-dir",
				join(sourceRoot, ".bun-cache"),
				"--no-progress",
				"--no-summary",
			],
			sourceRoot,
		);
		const runtimeEntrypoint = join(sourceRoot, source.entryRelative);
		const [boundRoot, boundEntrypoint] = await Promise.all([
			realpath(sourceRoot),
			realpath(runtimeEntrypoint),
		]);
		const entryRelative = relative(boundRoot, boundEntrypoint);
		if (entryRelative === "" || entryRelative === ".." || entryRelative.startsWith("../") || isAbsolute(entryRelative)) {
			throw new Error("Vault Git runtime entrypoint escapes its bound source");
		}
		return { sourceRoot: boundRoot, runtimeEntrypoint: boundEntrypoint };
	} catch (error) {
		await rm(sourceRoot, { recursive: true, force: true });
		throw error;
	}
}

async function createFreshPrivateDirectory(path: string): Promise<void> {
	await ensureTrustedDirectory(dirname(path));
	await mkdir(path, { mode: 0o700 });
	await chmod(path, 0o700);
	const entry = await lstat(path);
	if (!entry.isDirectory() || entry.isSymbolicLink() || !isCurrentOwnerPrivate(entry, 0o700)) {
		throw new Error("Vault Git bound runtime source root is unsafe");
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await ensureTrustedDirectory(path);
	// Only the designated owner leaf receives a chmod. Ancestors such as XDG
	// roots and ~/.bun may be shared by other tools and must remain untouched.
	await chmod(resolve(path), 0o700);
}

async function ensureTrustedDirectory(path: string): Promise<void> {
	const absolute = resolve(path);
	if (!isAbsolute(path)) throw new Error("Vault Git owner path must be absolute");
	let cursor = "/";
	for (const segment of absolute.split("/").filter(Boolean)) {
		cursor = join(cursor, segment);
		try {
			const entry = await lstat(cursor);
			// macOS exposes /var as the stable system alias for /private/var. It
			// precedes every caller-controlled anchor and is not an owner path.
			const trustedPlatformAlias = cursor === "/var" && entry.isSymbolicLink() && await realpath(cursor) === "/private/var";
			if (!trustedPlatformAlias && (entry.isSymbolicLink() || !entry.isDirectory())) {
				throw new Error("Vault Git owner path traverses an unsafe ancestor");
			}
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			try {
				await mkdir(cursor, { mode: 0o700 });
			} catch (createError) {
				if (!isAlreadyExists(createError)) throw createError;
			}
			const created = await lstat(cursor);
			if (created.isSymbolicLink() || !created.isDirectory()) {
				throw new Error("Vault Git owner path creation is unsafe");
			}
		}
	}
}

/**
 * Read-only admission for evidence roots. Unlike ensureTrustedDirectory this
 * never creates or chmods a path: existing evidence below a caller-controlled
 * symlink is untrustworthy and must reconcile before any rollback or publish.
 */
async function hasTrustedExistingAncestors(path: string): Promise<boolean> {
	if (!isAbsolute(path)) return false;
	let cursor = "/";
	for (const segment of resolve(path).split("/").filter(Boolean)) {
		cursor = join(cursor, segment);
		try {
			const entry = await lstat(cursor);
			const trustedPlatformAlias =
				cursor === "/var" && entry.isSymbolicLink() && (await realpath(cursor)) === "/private/var";
			if (!trustedPlatformAlias && (entry.isSymbolicLink() || !entry.isDirectory())) return false;
		} catch (error) {
			return isMissingPath(error);
		}
	}
	return true;
}

function isMissingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isCurrentOwnerPrivate(entry: Awaited<ReturnType<typeof lstat>>, mode: number): boolean {
	const owner = process.getuid?.();
	const permissions = typeof entry.mode === "bigint" ? Number(entry.mode & 0o777n) : entry.mode & 0o777;
	return permissions === mode && (owner === undefined || Number(entry.uid) === owner);
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeOwnerFile(path: string, bytes: string): Promise<void> {
	await ensurePrivateDirectory(dirname(path));
	const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, path);
		await syncDirectory(dirname(path));
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

async function compileRuntime(
	roots: VaultGitHostEnrollmentRoots,
	expectedPlan?: VaultGitRuntimeReference,
): Promise<VaultGitRuntimeReference> {
	const runtimesRoot = join(roots.dataRoot, "runtimes");
	await ensurePrivateDirectory(roots.dataRoot);
	await ensurePrivateDirectory(runtimesRoot);
	const source = await materializeCleanMergedSource(roots, runtimesRoot);
	const stagingRoot = join(runtimesRoot, `.staging-${randomUUID()}`);
	const stagedExecutable = join(stagingRoot, "vault-git");
	await ensurePrivateDirectory(stagingRoot);
	try {
		const digest = await compileFrozenRuntime(roots, source, stagingRoot, true);
		if (expectedPlan && expectedPlan.digest !== digest) {
			throw new Error("Vault Git runtime plan changed before apply");
		}
		const runtimeRoot = join(runtimesRoot, digest);
		await chmod(stagedExecutable, 0o755);
		await symlink("vault-git", join(stagingRoot, "bun"));
		try {
			await rename(stagingRoot, runtimeRoot);
			await syncDirectory(runtimesRoot);
		} catch {
			if (!(await runtimeMatches(roots, digest))) {
				throw new Error("Installed Vault Git runtime digest mismatch");
			}
		}
		if (!(await runtimeMatches(roots, digest))) {
			throw new Error("Installed Vault Git runtime digest mismatch");
		}
		await ensureRuntimeBunAlias(roots, digest);
		return { digest };
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
		await rm(source.sourceRoot, { recursive: true, force: true });
	}
}

async function compileFrozenRuntime(
	roots: VaultGitHostEnrollmentRoots,
	source: { readonly sourceRoot: string; readonly runtimeEntrypoint: string },
	stagingRoot: string,
	notifySourceBound = false,
): Promise<string> {
	if (notifySourceBound) await roots.onRuntimeSourceBound?.();
	const entryRelative = relative(source.sourceRoot, source.runtimeEntrypoint);
	if (entryRelative === "" || entryRelative === ".." || entryRelative.startsWith("../") || isAbsolute(entryRelative)) {
		throw new Error("Vault Git runtime entrypoint escapes its bound source");
	}
	const stagedExecutable = join(stagingRoot, "vault-git");
	const buildMetadataPath = join(stagingRoot, "vault-git.metafile.json");
	runChecked(
		[
			process.execPath,
			"build",
			entryRelative,
			"--compile",
			"--outfile",
			stagedExecutable,
			`--metafile=${buildMetadataPath}`,
		],
		source.sourceRoot,
	);
	await assertBuildInputsAreBound(source.sourceRoot, buildMetadataPath);
	const bytes = await readFile(stagedExecutable);
	await chmod(stagedExecutable, 0o755);
	return createHash("sha256").update(bytes).digest("hex");
}

/** Compile an exact-source runtime plan in owner-private scratch; never publish it. */
async function planRuntime(roots: VaultGitHostEnrollmentRoots): Promise<VaultGitRuntimeReference> {
	// macOS exposes /tmp as a platform symlink to /private/tmp. A scrubbed
	// process has no TMPDIR and therefore receives /tmp from node:os, while the
	// owner-path guard correctly rejects symlink ancestors. Resolve the
	// platform temp root before creating the private planning directory.
	const scratch = await mkdtemp(join(await realpath(tmpdir()), "vault-git-runtime-plan-"));
	try {
		await chmod(scratch, 0o700);
		const source = await materializeCleanMergedSource(roots, scratch);
		const stagingRoot = join(scratch, `.plan-${randomUUID()}`);
		await createFreshPrivateDirectory(stagingRoot);
		try {
			return { digest: await compileFrozenRuntime(roots, source, stagingRoot) };
		} finally {
			await rm(stagingRoot, { recursive: true, force: true });
			await rm(source.sourceRoot, { recursive: true, force: true });
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/**
 * Bun's resolver is the authoritative graph owner. Admit only a graph whose
 * every resolved input remains inside the frozen exact-commit source root;
 * this rejects a missing workspace dependency satisfied by an ancestor
 * node_modules without guessing at package names or import syntax.
 */
async function assertBuildInputsAreBound(sourceRoot: string, metadataPath: string): Promise<void> {
	let inputs: Record<string, unknown>;
	try {
		const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { inputs?: unknown };
		if (typeof metadata.inputs !== "object" || metadata.inputs === null || Array.isArray(metadata.inputs)) {
			throw new Error("invalid inputs");
		}
		inputs = metadata.inputs as Record<string, unknown>;
	} catch {
		throw new Error("Vault Git runtime source or compilation is not ready");
	}
	for (const input of Object.keys(inputs)) {
		const lexical = resolve(sourceRoot, input);
		if (!isContainedPath(sourceRoot, lexical)) {
			throw new Error("Vault Git runtime source or compilation is not ready");
		}
		try {
			if (!isContainedPath(sourceRoot, await realpath(lexical))) {
				throw new Error("Vault Git runtime source or compilation is not ready");
			}
		} catch (error) {
			if (error instanceof Error && error.message === "Vault Git runtime source or compilation is not ready") throw error;
			throw new Error("Vault Git runtime source or compilation is not ready");
		}
	}
}

function isContainedPath(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

/**
 * The immutable Installed Runtime directory carries a `bun` alias to the
 * exact selected executable bytes so an isolated vault-check PATH can
 * resolve nested `bun` without ambient authority. Derive and realpath-verify
 * the alias rather than trusting another binary; a pre-alias runtime
 * directory installed by an earlier Setup is repaired here on reinstall.
 */
async function trustedRuntimesRoot(
	roots: VaultGitHostEnrollmentRoots,
): Promise<string | undefined> {
	if (!(await hasTrustedExistingAncestors(roots.dataRoot))) return undefined;
	const runtimesRoot = join(roots.dataRoot, "runtimes");
	try {
		const entry = await lstat(runtimesRoot, { bigint: true });
		if (!entry.isDirectory() || entry.isSymbolicLink() || !isCurrentOwnerPrivate(entry, 0o700)) return undefined;
		const canonical = await realpath(runtimesRoot);
		const resolved = await lstat(canonical, { bigint: true });
		if (
			!resolved.isDirectory() ||
			resolved.isSymbolicLink() ||
			resolved.dev !== entry.dev ||
			resolved.ino !== entry.ino
		) return undefined;
		return canonical;
	} catch {
		return undefined;
	}
}

async function trustedRuntimeExecutable(
	roots: VaultGitHostEnrollmentRoots,
	digest: string,
): Promise<string | undefined> {
	if (!SHA256_PATTERN.test(digest)) return undefined;
	const runtimesRoot = join(roots.dataRoot, "runtimes");
	const canonicalRuntimesRoot = await trustedRuntimesRoot(roots);
	if (!canonicalRuntimesRoot) return undefined;
	const runtimeRoot = join(runtimesRoot, digest);
	try {
		const runtimeEntry = await lstat(runtimeRoot, { bigint: true });
		if (!runtimeEntry.isDirectory() || runtimeEntry.isSymbolicLink() || !isCurrentOwnerPrivate(runtimeEntry, 0o700)) return undefined;
		const canonicalRuntimeRoot = await realpath(runtimeRoot);
		const resolvedRuntime = await lstat(canonicalRuntimeRoot, { bigint: true });
		if (
			!resolvedRuntime.isDirectory() ||
			resolvedRuntime.isSymbolicLink() ||
			resolvedRuntime.dev !== runtimeEntry.dev ||
			resolvedRuntime.ino !== runtimeEntry.ino ||
			relative(canonicalRuntimesRoot, canonicalRuntimeRoot) !== digest
		) return undefined;
		const executable = join(runtimeRoot, "vault-git");
		const executableEntry = await lstat(executable, { bigint: true });
		if (!executableEntry.isFile() || executableEntry.isSymbolicLink() || (executableEntry.mode & 0o100n) === 0n) return undefined;
		const canonicalExecutable = await realpath(executable);
		const resolvedExecutable = await lstat(canonicalExecutable, { bigint: true });
		if (
			!resolvedExecutable.isFile() ||
			resolvedExecutable.isSymbolicLink() ||
			resolvedExecutable.dev !== executableEntry.dev ||
			resolvedExecutable.ino !== executableEntry.ino ||
			!isContainedPath(canonicalRuntimeRoot, canonicalExecutable)
		) return undefined;
		return canonicalExecutable;
	} catch {
		return undefined;
	}
}

async function ensureRuntimeBunAlias(
	roots: VaultGitHostEnrollmentRoots,
	digest: string,
): Promise<void> {
	const executable = await trustedRuntimeExecutable(roots, digest);
	if (!executable) throw new Error("Installed Vault Git runtime is unsafe");
	const runtimeRoot = dirname(executable);
	const aliasPath = join(runtimeRoot, "bun");
	try {
		await symlink("vault-git", aliasPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const [alias, resolvedExecutable] = await Promise.all([
		realpath(aliasPath),
		realpath(join(runtimeRoot, "vault-git")),
	]);
	if (alias !== resolvedExecutable) {
		throw new Error("Installed Vault Git runtime bun alias is invalid");
	}
}

async function runtimeMatches(
	roots: VaultGitHostEnrollmentRoots,
	digest: string,
): Promise<boolean> {
	const executable = await trustedRuntimeExecutable(roots, digest);
	if (!executable) return false;
	try {
		return createHash("sha256").update(await readFile(executable)).digest("hex") === digest;
	} catch {
		return false;
	}
}

type ActivationConfigurationEvidence =
	| { readonly kind: "absent" }
	| { readonly kind: "valid"; readonly value: ActivationConfiguration }
	| { readonly kind: "invalid" };

/**
 * Absence is the only condition that permits Host Enrollment to mint an
 * identity. An existing record that cannot be proven owner-private and valid
 * is durable evidence, not an invitation to overwrite it.
 */
async function readActivationConfiguration(
	path: string,
): Promise<ActivationConfigurationEvidence> {
	try {
		const entry = await lstat(path);
			if (!entry.isFile() || entry.isSymbolicLink() || !isCurrentOwnerPrivate(entry, 0o600)) {
			return { kind: "invalid" };
		}
		const parsed = parseActivationConfiguration(
			JSON.parse(await readFile(path, "utf8")),
		);
		return parsed === undefined ? { kind: "invalid" } : { kind: "valid", value: parsed };
	} catch (error) {
		return isMissingPath(error) ? { kind: "absent" } : { kind: "invalid" };
	}
}

function parseActivationConfiguration(value: unknown): ActivationConfiguration | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate).sort();
	if (
		keys.join("\0") !== [
			"host_handle",
			"schema_version",
			"ssh_identity_file_path",
			"ssh_known_hosts_path",
			"ssh_public_key_path",
		].sort().join("\0") ||
		candidate.schema_version !== 1 ||
		typeof candidate.host_handle !== "string" ||
		!HOST_HANDLE_PATTERN.test(candidate.host_handle) ||
		![
			candidate.ssh_identity_file_path,
			candidate.ssh_public_key_path,
			candidate.ssh_known_hosts_path,
			].every((path) => typeof path === "string" && isAbsolute(path) && !hasControlBytes(path))
	) {
		return undefined;
	}
	return candidate as unknown as ActivationConfiguration;
}

function hasControlBytes(value: string): boolean {
	return [...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	});
}

type RuntimeSelectionEvidence =
	| { readonly kind: "absent" }
	| { readonly kind: "valid"; readonly value: RuntimeSelectionRecord }
	| { readonly kind: "invalid" };

async function readRuntimeSelection(path: string): Promise<RuntimeSelectionEvidence> {
	try {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink() || !isCurrentOwnerPrivate(entry, 0o600)) return { kind: "invalid" };
		const parsed = parseRuntimeSelection(JSON.parse(await readFile(path, "utf8")));
		return parsed === undefined ? { kind: "invalid" } : { kind: "valid", value: parsed };
	} catch (error) {
		return isMissingPath(error) ? { kind: "absent" } : { kind: "invalid" };
	}
}

function parseRuntimeSelection(value: unknown): RuntimeSelectionRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		Object.keys(candidate).sort().join("\0") !==
			["prior_digest", "schema_version", "selected_digest"].sort().join("\0") ||
		candidate.schema_version !== 1 ||
		typeof candidate.selected_digest !== "string" ||
		!SHA256_PATTERN.test(candidate.selected_digest) ||
		!(candidate.prior_digest === null ||
			(typeof candidate.prior_digest === "string" &&
				SHA256_PATTERN.test(candidate.prior_digest)))
	) {
		return undefined;
	}
	// A legacy record naming itself as its prior stays an enrolled selection,
	// but its meaningless self-rollback normalizes to null so rollback fails
	// closed instead of reselecting the same runtime.
	if (candidate.prior_digest === candidate.selected_digest) {
		return {
			schema_version: 1,
			selected_digest: candidate.selected_digest,
			prior_digest: null,
		};
	}
	return candidate as unknown as RuntimeSelectionRecord;
}

async function selectRuntime(
	roots: VaultGitHostEnrollmentRoots,
	digest: string,
): Promise<void> {
	const runtimeExecutable = await trustedRuntimeExecutable(roots, digest);
	if (!runtimeExecutable || !(await runtimeMatches(roots, digest))) {
		throw new Error("Refusing to select an invalid Vault Git runtime");
	}
	await publishSelectorTarget(roots.selectorPath, runtimeExecutable);
}

async function publishSelectorTarget(selectorPath: string, target: string): Promise<void> {
	await ensureTrustedDirectory(dirname(selectorPath));
	const temporaryPath = join(dirname(selectorPath), `.vault-git.${randomUUID()}.tmp`);
	try {
		await symlink(target, temporaryPath);
		await rename(temporaryPath, selectorPath);
		await syncDirectory(dirname(selectorPath));
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

type OwnerFileSnapshot =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly bytes: string };

type SelectorSnapshot =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly target: string };

interface PublicationSnapshot {
	readonly activation: OwnerFileSnapshot;
	readonly selection: OwnerFileSnapshot;
	readonly selector: SelectorSnapshot;
}

async function ownerFileSnapshot(path: string): Promise<OwnerFileSnapshot> {
	try {
		return { kind: "present", bytes: await readFile(path, "utf8") };
	} catch (error) {
		if (isMissingPath(error)) return { kind: "absent" };
		throw error;
	}
}

async function publicationSnapshot(
	roots: VaultGitHostEnrollmentRoots,
	activationPath: string,
	selectionPath: string,
	selectorEvidence: SelectorEvidence,
): Promise<PublicationSnapshot> {
	if (selectorEvidence.kind === "invalid") throw new Error("Vault Git selector evidence is invalid");
	const [activation, selection] = await Promise.all([
		ownerFileSnapshot(activationPath),
		ownerFileSnapshot(selectionPath),
	]);
	return {
		activation,
		selection,
		selector: await selectorSnapshot(roots, selectorEvidence),
	};
}

async function selectorSnapshot(
	roots: VaultGitHostEnrollmentRoots,
	evidence: Exclude<SelectorEvidence, { readonly kind: "invalid" }>,
): Promise<SelectorSnapshot> {
	if (evidence.kind === "valid") return readLiteralSelector(roots.selectorPath);
	if (await isSourceLinkedSelector(roots)) return readLiteralSelector(roots.selectorPath);
	return { kind: "absent" };
}

async function readLiteralSelector(path: string): Promise<SelectorSnapshot> {
	try {
		const entry = await lstat(path);
		if (!entry.isSymbolicLink()) throw new Error("Vault Git selector evidence is invalid");
		return { kind: "present", target: await readlink(path) };
	} catch (error) {
		if (isMissingPath(error)) return { kind: "absent" };
		throw error;
	}
}

async function restorePublication(
	roots: VaultGitHostEnrollmentRoots,
	activationPath: string,
	selectionPath: string,
	snapshot: PublicationSnapshot,
): Promise<void> {
	const restoreFile = async (path: string, file: OwnerFileSnapshot) => {
		if (file.kind === "absent") await rm(path, { force: true });
		else await writeOwnerFile(path, file.bytes);
	};
	const failures: unknown[] = [];
	for (const restore of [
		() => restoreFile(activationPath, snapshot.activation),
		() => restoreFile(selectionPath, snapshot.selection),
		() => restoreSelector(roots, snapshot.selector),
	]) {
		try { await restore(); } catch (error) { failures.push(error); }
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Vault Git Host Enrollment restoration failed");
}

async function restoreSelector(
	roots: VaultGitHostEnrollmentRoots,
	snapshot: SelectorSnapshot,
): Promise<void> {
	if (snapshot.kind === "absent") {
		await rm(roots.selectorPath, { force: true });
		return;
	}
	await publishSelectorTarget(roots.selectorPath, snapshot.target);
}

/** Selector digest proven by real-path containment alone; bytes may be broken. */
async function managedSelectorPathDigest(
	roots: VaultGitHostEnrollmentRoots,
): Promise<string | undefined> {
	try {
		const entry = await lstat(roots.selectorPath);
		if (!entry.isSymbolicLink()) return undefined;
		const target = await realpath(roots.selectorPath);
		const runtimesRoot = await trustedRuntimesRoot(roots);
		if (!runtimesRoot) return undefined;
		const targetRelative = relative(runtimesRoot, target);
		if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) return undefined;
		const parts = targetRelative.split("/");
		const digest = parts.length === 2 && parts[1] === "vault-git" ? parts[0] : undefined;
		return digest && SHA256_PATTERN.test(digest) ? digest : undefined;
	} catch {
		return undefined;
	}
}

async function selectorDigest(
	roots: VaultGitHostEnrollmentRoots,
): Promise<string | undefined> {
	const digest = await managedSelectorPathDigest(roots);
	if (digest === undefined) return undefined;
	return (await runtimeMatches(roots, digest)) ? digest : undefined;
}

interface ReplaceableSelectorState {
	/** Containment-proven selected digest; undefined when no selector exists. */
	readonly pathDigest?: string;
	/** Digest additionally proven by exact executable bytes. */
	readonly verifiedDigest?: string;
}

async function replaceableSelectorState(
	roots: VaultGitHostEnrollmentRoots,
): Promise<ReplaceableSelectorState> {
	let entry: Awaited<ReturnType<typeof lstat>>;
	try {
		entry = await lstat(roots.selectorPath);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return {};
		}
		throw error;
	}
	if (!entry.isSymbolicLink()) {
		throw new Error("Refusing to replace a foreign Vault Git selector");
	}
	const pathDigest = await managedSelectorPathDigest(roots);
	if (pathDigest !== undefined) {
		const verifiedDigest = (await selectorDigest(roots)) === pathDigest
			? pathDigest
			: undefined;
		return { pathDigest, ...(verifiedDigest ? { verifiedDigest } : {}) };
	}
	if (await isSourceLinkedSelector(roots)) return {};
	throw new Error("Refusing to replace a foreign Vault Git selector");
}

async function isSourceLinkedSelector(roots: VaultGitHostEnrollmentRoots): Promise<boolean> {
	if (!roots.runtimeEntrypoint) return false;
	try {
		return (await realpath(roots.selectorPath)) === (await realpath(roots.runtimeEntrypoint));
	} catch {
		// A broken or racing link is not proven Setup ownership.
		return false;
	}
}

/**
 * The prior may never equal the new selection: a stale record naming the same
 * digest would otherwise persist a meaningless self-rollback. The live selector
 * stays rollback-eligible on containment proof alone (rollback re-verifies its
 * bytes); a record-sourced candidate must byte-verify before it is trusted.
 */
async function distinctPriorDigest(
	roots: VaultGitHostEnrollmentRoots,
	selectedDigest: string,
	selectorState: ReplaceableSelectorState,
	existingSelection: RuntimeSelectionRecord | undefined,
): Promise<string | null> {
	const livePathDigest = selectorState.pathDigest;
	if (livePathDigest !== undefined && livePathDigest !== selectedDigest) {
		return livePathDigest;
	}
	for (const candidate of [
		existingSelection?.selected_digest,
		existingSelection?.prior_digest ?? undefined,
	]) {
		if (candidate === undefined || candidate === selectedDigest) continue;
		if (await runtimeMatches(roots, candidate)) return candidate;
	}
	return null;
}

async function holdRuntimeSelection<T>(
	roots: VaultGitHostEnrollmentRoots,
	operation: () => Promise<T>,
): Promise<T> {
	return roots.runtimeSelectionFence.hold(operation);
}

function runtimeSelectionBlocked(): VaultGitRuntimeSelectionBlockedStatus {
	return {
		state: "blocked",
		station: "vault_git.runtime_selection_blocked",
		nextAction: {
			kind: "needs_human",
			actionId: "wait_for_vault_git_idle",
			owner: "vault_git_operator",
			condition: "no_active_or_uncertain_work",
		},
		installedRuntime: null,
		selectedRuntime: null,
		priorRuntime: null,
	};
}

function reconciliationRequired(): VaultGitHostEnrollmentReconciliationStatus {
	return {
		state: "blocked",
		station: "vault_git.host_enrollment_reconciliation_required",
		nextAction: {
			kind: "needs_human",
			actionId: "reconcile_host_enrollment_evidence",
			owner: "vault_git_operator",
			condition: "host_enrollment_evidence_reconciled",
		},
		installedRuntime: null,
		selectedRuntime: null,
		priorRuntime: null,
	};
}

function inputRequired(): VaultGitHostEnrollmentStatus {
	return {
		state: "not_enrolled",
		station: "vault_git.host_enrollment_inputs_required",
		nextAction: {
			kind: "needs_input",
			actionId: "provide_host_enrollment_inputs",
			inputContractId: "setup.vault-git.host-enrollment",
			fields: VAULT_GIT_HOST_ENROLLMENT_INPUT_FIELDS,
		},
		installedRuntime: null,
		selectedRuntime: null,
		priorRuntime: null,
	};
}

type SelectorEvidence =
	| { readonly kind: "absent" }
	| { readonly kind: "valid"; readonly pathDigest: string; readonly selectedBytesValid: boolean }
	| { readonly kind: "invalid" };

type EnrollmentEvidence =
	| { readonly kind: "all_absent" }
	| {
		readonly kind: "coherent_enrolled";
		readonly activation: ActivationConfiguration;
		readonly selection: RuntimeSelectionRecord;
		readonly selectorPathDigest: string;
		readonly selectedBytesValid: boolean;
	}
	| { readonly kind: "invalid" };

async function readSelectorEvidence(
	roots: VaultGitHostEnrollmentRoots,
): Promise<SelectorEvidence> {
	try {
		const selectorState = await replaceableSelectorState(roots);
		if (selectorState.pathDigest === undefined) return { kind: "absent" };
		return { kind: "valid", pathDigest: selectorState.pathDigest, selectedBytesValid: selectorState.verifiedDigest === selectorState.pathDigest };
	} catch {
		return { kind: "invalid" };
	}
}

async function classifyEnrollmentEvidence(
	roots: VaultGitHostEnrollmentRoots,
): Promise<EnrollmentEvidence> {
	if (
		!(await hasTrustedExistingAncestors(roots.configRoot)) ||
		!(await hasTrustedExistingAncestors(roots.dataRoot)) ||
		!(await hasTrustedExistingAncestors(dirname(roots.selectorPath)))
	) {
		return { kind: "invalid" };
	}
	const [activation, selection, selector] = await Promise.all([
		readActivationConfiguration(join(roots.configRoot, "activation.json")),
		readRuntimeSelection(join(roots.configRoot, "runtime-selection.json")),
		readSelectorEvidence(roots),
	]);
	if (activation.kind === "absent" && selection.kind === "absent" && selector.kind === "absent") {
		return { kind: "all_absent" };
	}
	if (
		activation.kind === "valid" &&
		selection.kind === "valid" &&
		selector.kind === "valid" &&
		selector.pathDigest === selection.value.selected_digest
	) {
		return {
			kind: "coherent_enrolled",
			activation: activation.value,
			selection: selection.value,
			selectorPathDigest: selector.pathDigest,
			selectedBytesValid: selector.selectedBytesValid,
		};
	}
	return { kind: "invalid" };
}

/** Create the Setup-owned Host Enrollment boundary for one isolated host state. */
export function createVaultGitHostEnrollment(
	roots: VaultGitHostEnrollmentRoots,
): VaultGitHostEnrollment {
	return {
		async inspect() {
			const evidence = await classifyEnrollmentEvidence(roots);
			if (evidence.kind === "all_absent") return inputRequired();
			if (evidence.kind === "coherent_enrolled" && evidence.selectedBytesValid) {
				const { activation, selection } = evidence;
				const selectedRuntime = { digest: selection.selected_digest };
				return {
					state: "enrolled",
					station: "vault_git.runtime_selected",
					hostHandle: activation.host_handle,
					installedRuntime: selectedRuntime,
					selectedRuntime,
					priorRuntime: selection.prior_digest
						? { digest: selection.prior_digest }
						: null,
				};
			}
			return reconciliationRequired();
		},
		async preview(input) {
			const evidence = await classifyEnrollmentEvidence(roots);
			if (evidence.kind === "invalid" || (evidence.kind === "coherent_enrolled" && !evidence.selectedBytesValid)) return reconciliationRequired();
			const validation = await validateEnrollmentInput(roots, input);
			if (validation.validated) {
				const plannedRuntime = await planRuntime(roots);
				return {
					state: "ready",
					station: "vault_git.host_enrollment_ready",
					nextAction: {
						kind: "needs_input",
						actionId: "apply_host_enrollment",
						inputContractId: "setup.vault-git.host-enrollment",
						fields: VAULT_GIT_HOST_ENROLLMENT_INPUT_FIELDS,
					},
					installedRuntime: plannedRuntime,
					selectedRuntime: null,
					priorRuntime: null,
					mutationPlan: {
						operation: "install_and_select",
						runtimeDigest: plannedRuntime.digest,
					},
				};
			}
			return prerequisiteStatus(validation.missingPrerequisites);
		},
		async apply(input) {
			const initialEvidence = await classifyEnrollmentEvidence(roots);
			if (
				initialEvidence.kind === "invalid" ||
				(initialEvidence.kind === "coherent_enrolled" && !initialEvidence.selectedBytesValid)
			) {
				return reconciliationRequired();
			}
			const validation = await validateEnrollmentInput(roots, input);
			if (!validation.validated) {
				return prerequisiteStatus(validation.missingPrerequisites);
			}
			const validated = validation.validated;
			// Each apply has its own fresh plan. The preview result is advisory rather
			// than a durable capability, so this detects a changed exact source before
			// publication instead of trusting a stale cross-process result.
			const plannedRuntime = await planRuntime(roots);
			const installedRuntime = await compileRuntime(roots, plannedRuntime);
			try {
				return await holdRuntimeSelection(roots, async () => {
				await ensureTrustedDirectory(roots.configRoot);
				await ensureTrustedDirectory(roots.dataRoot);
				await ensureTrustedDirectory(dirname(roots.selectorPath));
				const activationPath = join(roots.configRoot, "activation.json");
				const selectionPath = join(roots.configRoot, "runtime-selection.json");
				const evidence = await classifyEnrollmentEvidence(roots);
				if (evidence.kind === "invalid" || (evidence.kind === "coherent_enrolled" && !evidence.selectedBytesValid)) return reconciliationRequired();
				if ((await roots.inspectWorkState?.()) !== "clear") {
					return { ...runtimeSelectionBlocked(), installedRuntime };
				}
				const selectorEvidence: SelectorEvidence = evidence.kind === "coherent_enrolled"
					? { kind: "valid", pathDigest: evidence.selectorPathDigest, selectedBytesValid: evidence.selectedBytesValid }
					: { kind: "absent" };
				const beforePublication = await publicationSnapshot(
					roots,
					activationPath,
					selectionPath,
					selectorEvidence,
				);
				const existingActivation = evidence.kind === "coherent_enrolled" ? evidence.activation : undefined;
				const existingSelection = evidence.kind === "coherent_enrolled" ? evidence.selection : undefined;
				const selectorState = selectorEvidence.kind === "valid"
					? { pathDigest: selectorEvidence.pathDigest, ...(selectorEvidence.selectedBytesValid ? { verifiedDigest: selectorEvidence.pathDigest } : {}) }
					: {};
				const hostHandle = existingActivation?.host_handle ?? `host_${randomBytes(16).toString("hex")}`;
				const activation: ActivationConfiguration = {
					schema_version: 1,
					host_handle: hostHandle,
					ssh_identity_file_path: validated.sshIdentityFilePath,
					ssh_public_key_path: validated.sshPublicKeyPath,
					ssh_known_hosts_path: validated.sshKnownHostsPath,
				};
				const activationUnchanged = existingActivation !== undefined && JSON.stringify(existingActivation) === JSON.stringify(activation);
				const selectionUnchanged = existingSelection?.selected_digest === installedRuntime.digest && "verifiedDigest" in selectorState && selectorState.verifiedDigest === installedRuntime.digest;
				try {
					if (!activationUnchanged) {
						await writeOwnerFile(activationPath, `${JSON.stringify(activation)}\n`);
						await roots.onPublicationStep?.("apply_after_activation");
					}
					if (!selectionUnchanged) {
						const priorDigest = await distinctPriorDigest(roots, installedRuntime.digest, selectorState, existingSelection);
						await selectRuntime(roots, installedRuntime.digest);
						await roots.onPublicationStep?.("apply_after_selector");
						const selection: RuntimeSelectionRecord = { schema_version: 1, selected_digest: installedRuntime.digest, prior_digest: priorDigest };
						await writeOwnerFile(selectionPath, `${JSON.stringify(selection)}\n`);
						await roots.onPublicationStep?.("apply_after_selection_record");
						return { state: "applied", station: "vault_git.runtime_selected", hostHandle, installedRuntime, selectedRuntime: installedRuntime, priorRuntime: selection.prior_digest ? { digest: selection.prior_digest } : null };
					}
					return { state: activationUnchanged ? "noop" : "applied", station: "vault_git.runtime_selected", hostHandle, installedRuntime, selectedRuntime: installedRuntime, priorRuntime: existingSelection?.prior_digest ? { digest: existingSelection.prior_digest } : null };
				} catch (operationError) {
					try {
						await restorePublication(roots, activationPath, selectionPath, beforePublication);
					} catch (restoreError) {
						throw new AggregateError([operationError, restoreError], "Vault Git Host Enrollment publication and restoration failed");
					}
					throw operationError;
				}
				});
			} catch (error) {
				if (error instanceof VaultGitRuntimeSelectionFenceBusyError) {
					return { ...runtimeSelectionBlocked(), installedRuntime };
				}
				throw error;
			}
		},
		async rollback(check) {
			try {
				return await holdRuntimeSelection(roots, async () => {
				const activationPath = join(roots.configRoot, "activation.json");
				const selectionPath = join(roots.configRoot, "runtime-selection.json");
					const evidence = await classifyEnrollmentEvidence(roots);
					if (evidence.kind !== "coherent_enrolled") return reconciliationRequired();
					const { selection } = evidence;
				if (!selection?.prior_digest) {
					throw new Error("Vault Git prior Runtime Selection is unavailable");
				}
				const priorDigest = selection.prior_digest;
				// Containment proof only: a selected runtime with broken bytes must
				// remain rollback-eligible, while a foreign or drifted selector is not.
				const selectorEvidence: SelectorEvidence = { kind: "valid", pathDigest: evidence.selectorPathDigest, selectedBytesValid: evidence.selectedBytesValid };
				if (!(await runtimeMatches(roots, priorDigest))) {
					throw new Error("Vault Git prior runtime is invalid");
				}
				const selectedRuntime = { digest: selection.selected_digest };
				const priorRuntime = { digest: priorDigest };
				if ((await roots.inspectWorkState?.()) !== "clear") {
				return {
					state: "blocked",
					station: "vault_git.rollback_blocked",
					nextAction: {
						kind: "needs_human",
						actionId: "wait_for_vault_git_idle",
						owner: "vault_git_operator",
						condition: "no_active_or_uncertain_work",
					},
					selectedRuntime,
						priorRuntime,
					};
				}
				if (check) {
					return {
						state: "changes",
						station: "vault_git.rollback_ready",
						selectedRuntime,
						priorRuntime,
					};
				}
				const beforePublication = await publicationSnapshot(roots, activationPath, selectionPath, selectorEvidence);
				try {
					await selectRuntime(roots, priorDigest);
					await roots.onPublicationStep?.("rollback_after_selector");
					await writeOwnerFile(
						selectionPath,
						`${JSON.stringify({
							schema_version: 1,
							selected_digest: priorDigest,
							prior_digest: selection.selected_digest,
						} satisfies RuntimeSelectionRecord)}\n`,
					);
					await roots.onPublicationStep?.("rollback_after_selection_record");
					return {
						state: "applied",
						station: "vault_git.rollback_applied",
						selectedRuntime: priorRuntime,
						priorRuntime: selectedRuntime,
					};
				} catch (operationError) {
					try {
						await restorePublication(roots, activationPath, selectionPath, beforePublication);
					} catch (restoreError) {
						throw new AggregateError([operationError, restoreError], "Vault Git Host Enrollment publication and restoration failed");
					}
					throw operationError;
				}
				});
			} catch (error) {
				if (error instanceof VaultGitRuntimeSelectionFenceBusyError) return runtimeSelectionBlocked();
				throw error;
			}
		},
	};
}
