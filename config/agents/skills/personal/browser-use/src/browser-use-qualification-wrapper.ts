import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	configureCliDiagnostics,
	createCliDiagnosticContext,
	emitCliDiagnostic,
	parseCliDiagnosticArgv,
	resetCliDiagnostics,
	withCliDiagnosticContext,
} from "@side-quest/cli-command-facade";
import {
	BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
	createBrowserUseQualificationManifest,
} from "./browser-use-qualification";
import { acquireSourceLock } from "./browser-use-source-lock";
import { quietDiagnosticWriter } from "./cli-diagnostics-bootstrap";
import {
	BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_SCHEMA_VERSION,
} from "./command-contract";

export const BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID =
	"browser-use.qualification-bundle" as const;
export const BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION = "1" as const;
export const SEALED_ARTIFACT_NAME = "browser-use-qualification-runtime.js";
export const SEALED_MANIFEST_NAME = "manifest.json";

const SHA256 = /^[a-f0-9]{64}$/;
const QUALIFICATION_DIAGNOSTIC_RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;
const QUALIFICATION_DIAGNOSTIC_CATEGORY = [
	"browser-use",
	"qualification",
] as const;
const SOURCE_ROOT = resolve(import.meta.dir, "../../../../../..");
const RUNTIME_ENTRY =
	"config/agents/skills/personal/browser-use/src/browser-use-qualification-runtime.ts";

class QualificationCampaignFailure extends Error {
	readonly primaryCode: string;
	readonly cleanupDebt: readonly string[];

	constructor(primaryCode: string, cleanupDebt: readonly string[]) {
		super(primaryCode);
		this.primaryCode = primaryCode;
		this.cleanupDebt = cleanupDebt;
	}
}

function qualificationFailureCode(error: unknown): string {
	const message = error instanceof Error ? error.message : undefined;
	return typeof message === "string" && /^qualification_[a-z0-9_]+$/.test(message)
		? message
		: "qualification_bundle_failed";
}

type QualificationFrontDoorCommand =
	| "prepare"
	| "manifest"
	| "validate"
	| "exec"
	| "handoff"
	| "session"
	| "help"
	| "unknown";

type QualificationBundleRootClassification =
	| "admitted"
	| "missing_root"
	| "non_directory"
	| "symlink"
	| "wrong_mode"
	| "noncanonical_realpath"
	| "unprepared_or_unsealed_root"
	| "inspection_failed";

type QualificationPrepareAdmission =
	| "admitted"
	| "non_absolute_output"
	| "parent_unavailable"
	| "parent_escape"
	| "output_exists";

type QualificationTerminalFailureKind =
	| "bundle_input_invalid"
	| "bundle_root_invalid"
	| "bundle_verification_failed"
	| "prepare_admission_failed"
	| "source_guard_failed"
	| "execution_failed"
	| "cleanup_failed"
	| "qualification_failed";

type QualificationDiagnosticEvent =
	| "qualification-front-door-dispatch"
	| "qualification-prepare-admission"
	| "qualification-prepare-created"
	| "qualification-bundle-verification-started"
	| "qualification-bundle-root-classified"
	| "qualification-bundle-verification-completed"
	| "qualification-cleanup-debt"
	| "qualification-terminal-failure";

function qualificationFrontDoorCommand(
	subcommand: string | undefined,
): QualificationFrontDoorCommand {
	if (subcommand === undefined || subcommand === "--help") return "help";
	return ["prepare", "manifest", "validate", "exec", "handoff", "session"].includes(
		subcommand,
	)
		? (subcommand as Exclude<QualificationFrontDoorCommand, "help" | "unknown">)
		: "unknown";
}

function qualificationTerminalFailureKind(
	code: string,
): QualificationTerminalFailureKind {
	if (code === "qualification_bundle_input_invalid") return "bundle_input_invalid";
	if (code === "qualification_bundle_root_invalid") return "bundle_root_invalid";
	if (
		code === "qualification_bundle_path_invalid" ||
		code === "qualification_bundle_exists"
	) {
		return "prepare_admission_failed";
	}
	if (code.includes("cleanup") || code.includes("release_failed")) {
		return "cleanup_failed";
	}
	if (code.includes("source_drift") || code.includes("source_identity")) {
		return "source_guard_failed";
	}
	if (
		code.includes("manifest") ||
		code.includes("bundle_file") ||
		code.includes("bundle_drift") ||
		code.includes("identity_mismatch")
	) {
		return "bundle_verification_failed";
	}
	if (code.startsWith("qualification_")) return "execution_failed";
	return "qualification_failed";
}

function emitQualificationDiagnostic(
	level: "debug" | "warning" | "error",
	event: QualificationDiagnosticEvent,
	properties: Record<string, unknown> = {},
): void {
	emitCliDiagnostic(
		QUALIFICATION_DIAGNOSTIC_CATEGORY,
		level,
		event,
		properties,
	);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function manifestDigest(value: Record<string, unknown>): string {
	const body = { ...value };
	delete body.manifest_digest;
	return sha256(JSON.stringify(body));
}

async function packageIdentity(logicalPath: string): Promise<Record<string, unknown>> {
	const absolute = await realpath(resolve(SOURCE_ROOT, logicalPath));
	const raw = await readFile(absolute);
	const parsed = record(JSON.parse(new TextDecoder().decode(raw)));
	if (typeof parsed?.name !== "string" || typeof parsed.version !== "string") {
		throw new Error("qualification_package_identity_invalid");
	}
	return {
		path: logicalPath,
		name: parsed.name,
		version: parsed.version,
		exports: parsed.exports ?? null,
		bin: parsed.bin ?? null,
		sha256: sha256(raw),
	};
}

async function nativeSupervisorIdentity(): Promise<Record<string, unknown>> {
	const candidates = [
		resolve(
			SOURCE_ROOT,
			".agents/runtime/browser-use-environment-auth/.build/release/browser-use-op-supervisor",
		),
		resolve(import.meta.dir, "../dist/bin/browser-use-op-supervisor"),
	];
	for (const candidate of candidates) {
		try {
			const resolved = await realpath(candidate);
			return {
				resolved_executable_realpath: resolved,
				content_sha256: sha256(await readFile(resolved)),
				argv_contract: [
					"descriptor-exec --executable-fd <fd> --expected-dev <device> --expected-ino <inode> --expected-size <bytes> --expected-sha256 <sha256> -- <argv0> [args...]",
					"custody-snapshot --state-root <canonical-xdg-state-root>",
				],
			};
		} catch {
			// Keep the ordered owner candidates; absence admits nothing.
		}
	}
	throw new Error("qualification_native_supervisor_unavailable");
}

async function classifySealedQualificationBundleRoot(
	path: string,
): Promise<QualificationBundleRootClassification> {
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(path);
	} catch (error) {
		return record(error)?.code === "ENOENT"
			? "missing_root"
			: "inspection_failed";
	}
	if (stat.isSymbolicLink()) return "symlink";
	if (!stat.isDirectory()) return "non_directory";
	if ((stat.mode & 0o777) !== 0o500) return "wrong_mode";
	try {
		if ((await realpath(path)) !== path) return "noncanonical_realpath";
	} catch {
		return "inspection_failed";
	}
	for (const name of [SEALED_ARTIFACT_NAME, SEALED_MANIFEST_NAME]) {
		try {
			await lstat(join(path, name));
		} catch (error) {
			return record(error)?.code === "ENOENT"
				? "unprepared_or_unsealed_root"
				: "inspection_failed";
		}
	}
	return "admitted";
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && !rel.startsWith("..") && resolve(root, rel) === candidate;
}

export type SealedQualificationBundle = {
	root: string;
	artifactPath: string;
	manifestPath: string;
	manifest: Record<string, unknown> & { manifest_digest: string };
};

/**
 * Refuse the qualification workflow unless its bundler entrypoint is a real
 * source file inside this checkout. A bundled `dist/` copy resolves
 * `SOURCE_ROOT` elsewhere, so this gate stops the packaged bin from silently
 * qualifying stale bytes.
 */
export async function assertBrowserUseQualificationRuntimeEntry(
	sourceRoot: string = SOURCE_ROOT,
): Promise<string> {
	const entryPath = resolve(sourceRoot, RUNTIME_ENTRY);
	if (!contained(sourceRoot, entryPath)) {
		throw new Error("qualification_bundle_source_entry_unavailable");
	}
	const stat = await lstat(entryPath).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error("qualification_bundle_source_entry_unavailable");
	}
	return entryPath;
}

async function buildSealedRuntime(): Promise<{
	artifactBytes: Uint8Array;
	metafile: { inputs: Record<string, unknown> };
}> {
	await assertBrowserUseQualificationRuntimeEntry();
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const built=await Bun.build({entrypoints:[${JSON.stringify(RUNTIME_ENTRY)}],target:"bun",format:"esm",minify:false,sourcemap:"none",metafile:true}); if(!built.success||built.outputs.length!==1||built.metafile===undefined) process.exit(1); const bytes=new Uint8Array(await built.outputs[0].arrayBuffer()); process.stdout.write(JSON.stringify({artifact_base64:Buffer.from(bytes).toString("base64"),metafile:built.metafile}));`,
		],
		{ cwd: SOURCE_ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`qualification_bundle_build_failed${stderr ? `: ${stderr}` : ""}`);
	}
	const result = record(JSON.parse(stdout));
	const metafile = record(result?.metafile);
	if (typeof result?.artifact_base64 !== "string" || !record(metafile?.inputs)) {
		throw new Error("qualification_bundle_build_failed");
	}
	return {
		artifactBytes: Uint8Array.from(Buffer.from(result.artifact_base64, "base64")),
		metafile: metafile as { inputs: Record<string, unknown> },
	};
}

export async function prepareSealedQualificationBundle(input: {
	outputRoot: string;
	wrapperPath: string;
	agentBrowserExecutable?: string;
	agentBrowserInstallLock?: string;
}): Promise<SealedQualificationBundle> {
	if (!isAbsolute(input.outputRoot)) {
		emitQualificationDiagnostic("debug", "qualification-prepare-admission", {
			admitted: false,
			prepare_admission: "non_absolute_output" satisfies QualificationPrepareAdmission,
		});
		throw new Error("qualification_bundle_path_invalid");
	}
	let parent: string;
	try {
		parent = await realpath(dirname(input.outputRoot));
	} catch (error) {
		emitQualificationDiagnostic("debug", "qualification-prepare-admission", {
			admitted: false,
			prepare_admission: "parent_unavailable" satisfies QualificationPrepareAdmission,
		});
		throw error;
	}
	const outputRoot = resolve(input.outputRoot);
	if (!contained(parent, outputRoot)) {
		emitQualificationDiagnostic("debug", "qualification-prepare-admission", {
			admitted: false,
			prepare_admission: "parent_escape" satisfies QualificationPrepareAdmission,
		});
		throw new Error("qualification_bundle_path_invalid");
	}
	const existing = await lstat(outputRoot).catch(() => undefined);
	if (existing !== undefined) {
		emitQualificationDiagnostic("debug", "qualification-prepare-admission", {
			admitted: false,
			prepare_admission: "output_exists" satisfies QualificationPrepareAdmission,
		});
		throw new Error("qualification_bundle_exists");
	}
	emitQualificationDiagnostic("debug", "qualification-prepare-admission", {
		admitted: true,
		prepare_admission: "admitted" satisfies QualificationPrepareAdmission,
		agent_browser_identity_source:
			input.agentBrowserExecutable === undefined ? "discovered" : "explicit",
	});

	const built = await buildSealedRuntime();
	const artifactBytes = built.artifactBytes;
	const inputPaths = Object.keys(built.metafile.inputs).sort();
	const closureEntries: Array<{ path: string; sha256: string }> = [];
	for (const rawPath of inputPaths) {
		// The builder always executes from the repository root. A caller cwd can
		// therefore never change artifact bytes or closure identities.
		const absolute = await realpath(resolve(SOURCE_ROOT, rawPath));
		if (!contained(SOURCE_ROOT, absolute)) throw new Error("qualification_bundle_input_escape");
		closureEntries.push({
			path: relative(SOURCE_ROOT, absolute),
			sha256: sha256(await readFile(absolute)),
		});
	}
	const sourceManifest = await createBrowserUseQualificationManifest({
		...(input.agentBrowserExecutable === undefined
			? {}
			: { agentBrowserExecutable: input.agentBrowserExecutable }),
		...(input.agentBrowserInstallLock === undefined
			? {}
			: { agentBrowserInstallLock: input.agentBrowserInstallLock }),
	});
	const wrapperRealpath = await realpath(input.wrapperPath);
	const body: Record<string, unknown> = {
		...sourceManifest,
		contract: BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID,
		schema_version: BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION,
		wrapper: {
			resolved_executable_realpath: wrapperRealpath,
			content_sha256: sha256(await readFile(wrapperRealpath)),
			argv_contract: [
				"qualification prepare --output <private-dir> --json",
				"qualification manifest --bundle <private-dir> --expected-manifest-digest <sha256> --json",
				"qualification validate --bundle <private-dir> --expected-manifest-digest <sha256> --evidence <path> --json",
				"qualification exec --bundle <private-dir> --expected-manifest-digest <sha256> -- <browser-use-argv>",
				"qualification handoff --bundle <private-dir> --expected-manifest-digest <sha256> --run-id <id> --output <private-path> --json",
				"qualification session --bundle <private-dir> --expected-manifest-digest <sha256> --expected-source-digest <sha256> --jsonl",
			],
		},
		sealed_runtime: {
			artifact_name: SEALED_ARTIFACT_NAME,
			artifact_sha256: sha256(artifactBytes),
			artifact_mode: 0o500,
			metafile_input_count: closureEntries.length,
			metafile_closure_sha256: sha256(JSON.stringify(closureEntries)),
			metafile_inputs: closureEntries,
		},
		native_supervisor: await nativeSupervisorIdentity(),
		packages: {
			browser_use: await packageIdentity(
				"config/agents/skills/personal/browser-use/package.json",
			),
			browser_connect: await packageIdentity(".agents/runtime/browser-connect/package.json"),
			warm_chrome: await packageIdentity(".agents/runtime/warm-chrome/package.json"),
		},
	};
	delete body.manifest_digest;
	const manifest = { ...body, manifest_digest: manifestDigest(body) };
	await mkdir(outputRoot, { recursive: false, mode: 0o700 });
	await chmod(outputRoot, 0o700);
	const artifactPath = join(outputRoot, SEALED_ARTIFACT_NAME);
	const manifestPath = join(outputRoot, SEALED_MANIFEST_NAME);
	await writeFile(artifactPath, artifactBytes, { flag: "wx", mode: 0o600 });
	const artifactHandle = await open(artifactPath, constants.O_RDONLY);
	await artifactHandle.sync();
	await artifactHandle.close();
	await chmod(artifactPath, 0o500);
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
	const manifestHandle = await open(manifestPath, constants.O_RDONLY);
	await manifestHandle.sync();
	await manifestHandle.close();
	await chmod(manifestPath, 0o400);
	const directoryHandle = await open(outputRoot, constants.O_RDONLY);
	await directoryHandle.sync();
	await directoryHandle.close();
	await chmod(outputRoot, 0o500);
	const parentHandle = await open(parent, constants.O_RDONLY);
	await parentHandle.sync();
	await parentHandle.close();
	emitQualificationDiagnostic("debug", "qualification-prepare-created", {
		contract_id: BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID,
		schema_version: BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION,
		artifact_count: 2,
		root_mode: 0o500,
		artifact_mode: 0o500,
		manifest_mode: 0o400,
	});
	return { root: outputRoot, artifactPath, manifestPath, manifest };
}

export async function verifySealedQualificationBundle(input: {
	bundleRoot: string;
	expectedManifestDigest: string;
	wrapperPath: string;
}): Promise<SealedQualificationBundle> {
	emitQualificationDiagnostic(
		"debug",
		"qualification-bundle-verification-started",
		{
			contract_id: BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID,
			schema_version: BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION,
		},
	);
	if (!SHA256.test(input.expectedManifestDigest) || !isAbsolute(input.bundleRoot)) {
		throw new Error("qualification_bundle_input_invalid");
	}
	const root = resolve(input.bundleRoot);
	const rootClassification = await classifySealedQualificationBundleRoot(root);
	emitQualificationDiagnostic(
		"debug",
		"qualification-bundle-root-classified",
		{
			bundle_root_state: rootClassification,
			admitted: rootClassification === "admitted",
			recommended_phase:
				rootClassification === "admitted"
					? "bundle_verification"
					: "qualification_prepare",
		},
	);
	if (rootClassification !== "admitted") {
		throw new Error("qualification_bundle_root_invalid");
	}
	const artifactPath = join(root, SEALED_ARTIFACT_NAME);
	const manifestPath = join(root, SEALED_MANIFEST_NAME);
	for (const [path, mode] of [[artifactPath, 0o500], [manifestPath, 0o400]] as const) {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode || (await realpath(path)) !== path) {
			throw new Error("qualification_bundle_file_invalid");
		}
	}
	const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")));
	if (!manifest || manifest.manifest_digest !== input.expectedManifestDigest || manifestDigest(manifest) !== input.expectedManifestDigest) {
		throw new Error("qualification_manifest_mismatch");
	}
	const sealedRuntime = record(manifest.sealed_runtime);
	const wrapper = record(manifest.wrapper);
	const nativeSupervisor = record(manifest.native_supervisor);
	const wrapperRealpath = await realpath(input.wrapperPath);
	if (
		sealedRuntime?.artifact_sha256 !== sha256(await readFile(artifactPath)) ||
		wrapper?.resolved_executable_realpath !== wrapperRealpath ||
		wrapper.content_sha256 !== sha256(await readFile(wrapperRealpath)) ||
		typeof nativeSupervisor?.resolved_executable_realpath !== "string" ||
		nativeSupervisor.content_sha256 !==
			sha256(await readFile(nativeSupervisor.resolved_executable_realpath))
	) {
		throw new Error("qualification_bundle_drift");
	}
	emitQualificationDiagnostic(
		"debug",
		"qualification-bundle-verification-completed",
		{
			contract_id: BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID,
			schema_version: BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION,
			artifact_count: 2,
		},
	);
	return { root, artifactPath, manifestPath, manifest: manifest as SealedQualificationBundle["manifest"] };
}

type VerifiedHandleIdentity = {
	dev: number;
	ino: number;
	size: number;
	sha256: string;
};

type AdmittedExternalFile = {
	logicalPath: string;
	handle: FileHandle;
	identity: VerifiedHandleIdentity;
	copyPath: string;
};

async function readExactHandle(
	handle: FileHandle,
	size: number,
): Promise<Uint8Array> {
	const bytes = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const read = await handle.read(bytes, offset, size - offset, offset);
		if (read.bytesRead === 0) throw new Error("qualification_bundle_file_changed");
		offset += read.bytesRead;
	}
	return bytes;
}

async function handleIdentity(handle: FileHandle): Promise<VerifiedHandleIdentity> {
	const stat = await handle.stat();
	if (!stat.isFile() || stat.size < 1 || !Number.isSafeInteger(stat.size)) {
		throw new Error("qualification_bundle_file_invalid");
	}
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		sha256: sha256(await readExactHandle(handle, stat.size)),
	};
}

async function openNoFollow(path: string): Promise<FileHandle> {
	return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

async function canonicalRegularPath(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new Error("qualification_external_identity_mismatch");
	const absolute = resolve(path);
	const stat = await lstat(absolute);
	if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
		throw new Error("qualification_external_identity_mismatch");
	}
	return absolute;
}

async function copyAdmittedFile(input: {
	root: string;
	name: string;
	logicalPath: string;
	expectedSha256?: string;
	mode: 0o400 | 0o500;
}): Promise<AdmittedExternalFile> {
	const handle = await openNoFollow(input.logicalPath);
	try {
		const identity = await handleIdentity(handle);
		if (
			input.expectedSha256 !== undefined &&
			identity.sha256 !== input.expectedSha256
		) {
			throw new Error("qualification_external_identity_mismatch");
		}
		const copyPath = join(input.root, input.name);
		await writeFile(copyPath, await readExactHandle(handle, identity.size), {
			flag: "wx",
			mode: 0o600,
		});
		const copyHandle = await openNoFollow(copyPath);
		try {
			await copyHandle.sync();
			const copied = await handleIdentity(copyHandle);
			if (copied.sha256 !== identity.sha256 || copied.size !== identity.size) {
				throw new Error("qualification_external_identity_mismatch");
			}
		} finally {
			await copyHandle.close();
		}
		await chmod(copyPath, input.mode);
		return { logicalPath: input.logicalPath, handle, identity, copyPath };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function exactManifestIdentity(
	manifest: Record<string, unknown>,
	key: "runtime" | "native_supervisor" | "agent_browser",
): { path: string; sha256: string; installLockPath?: string; installLockSha256?: string } {
	const value = record(manifest[key]);
	const path = key === "runtime"
		? value?.executable_realpath
		: key === "native_supervisor"
			? value?.resolved_executable_realpath
			: value?.executable_realpath;
	const digest = key === "runtime"
		? value?.executable_sha256
		: key === "native_supervisor"
			? value?.content_sha256
			: value?.executable_sha256;
	if (typeof path !== "string" || typeof digest !== "string" || !SHA256.test(digest)) {
		throw new Error("qualification_manifest_mismatch");
	}
	return {
		path,
		sha256: digest,
		...(key === "agent_browser" &&
		typeof value?.install_lock_realpath === "string" &&
		typeof value.install_lock_sha256 === "string"
			? {
					installLockPath: value.install_lock_realpath,
					installLockSha256: value.install_lock_sha256,
				}
			: {}),
	};
}

export async function executeVerifiedSealedQualificationBundle(input: {
	bundleRoot: string;
	expectedManifestDigest: string;
	wrapperPath: string;
	childArgv: readonly string[];
	env: NodeJS.ProcessEnv;
	afterVerifiedForTest?: (bundle: SealedQualificationBundle) => Promise<void>;
	afterExternalAdmissionForTest?: () => Promise<void>;
	onStdout?: (chunk: Uint8Array) => void;
	onStderr?: (chunk: Uint8Array) => void;
	cleanupForTest?: {
		closeHandle?: () => Promise<void>;
		removeInvocationRoot?: () => Promise<void>;
	};
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const bundle = await verifySealedQualificationBundle(input);
	const artifactExec = await openNoFollow(bundle.artifactPath);
	const artifactVerify = await openNoFollow(bundle.artifactPath);
	const manifestHandle = await openNoFollow(bundle.manifestPath);
	let invocationRoot: string | undefined;
	const admittedExternal: AdmittedExternalFile[] = [];
	let primaryFailure: unknown;
	let executionResult:
		| { exitCode: number; stdout: string; stderr: string }
		| undefined;
	try {
		const beforeExec = await handleIdentity(artifactExec);
		const beforeVerify = await handleIdentity(artifactVerify);
		const manifestIdentity = await handleIdentity(manifestHandle);
		const manifestBytes = await readExactHandle(
			manifestHandle,
			manifestIdentity.size,
		);
		const admittedManifest = record(
			JSON.parse(new TextDecoder().decode(manifestBytes)),
		);
		const admittedSealedRuntime = record(admittedManifest?.sealed_runtime);
		if (
			beforeExec.dev !== beforeVerify.dev ||
			beforeExec.ino !== beforeVerify.ino ||
			beforeExec.size !== beforeVerify.size ||
			beforeExec.sha256 !== beforeVerify.sha256 ||
			!admittedManifest ||
			admittedManifest.manifest_digest !== input.expectedManifestDigest ||
			manifestDigest(admittedManifest) !== input.expectedManifestDigest ||
			admittedSealedRuntime?.artifact_sha256 !== beforeExec.sha256 ||
			manifestIdentity.sha256 !== sha256(manifestBytes)
		) {
			throw new Error("qualification_bundle_drift");
		}
		const runtimeIdentity = exactManifestIdentity(admittedManifest, "runtime");
		const currentRuntimeRealpath = await realpath(process.execPath);
		if (currentRuntimeRealpath !== runtimeIdentity.path) {
			throw new Error("qualification_runtime_identity_mismatch");
		}
		invocationRoot = await mkdtemp(
			join(dirname(bundle.root), ".browser-use-sealed-exec-"),
		);
		await chmod(invocationRoot, 0o700);
		const runtime = await copyAdmittedFile({
			root: invocationRoot,
			name: "bun",
			logicalPath: runtimeIdentity.path,
			expectedSha256: runtimeIdentity.sha256,
			mode: 0o500,
		});
		admittedExternal.push(runtime);
		const supervisorIdentity = exactManifestIdentity(
			admittedManifest,
			"native_supervisor",
		);
		const supervisor = await copyAdmittedFile({
			root: invocationRoot,
			name: "browser-use-op-supervisor",
			logicalPath: supervisorIdentity.path,
			expectedSha256: supervisorIdentity.sha256,
			mode: 0o500,
		});
		admittedExternal.push(supervisor);

		let handoff: AdmittedExternalFile | undefined;
		let producerReceipt: AdmittedExternalFile | undefined;
		let agentBrowser: AdmittedExternalFile | undefined;
		let agentBrowserInstallLock: AdmittedExternalFile | undefined;
		const handoffPath = flag(input.childArgv, "--handoff");
		const requiresAgentBrowser = handoffPath !== undefined ||
			(input.childArgv[0] === "qualification" &&
				(input.childArgv[1] === "handoff" || input.childArgv[1] === "session"));
		if (requiresAgentBrowser) {
			const agentIdentity = exactManifestIdentity(admittedManifest, "agent_browser");
			if (!agentIdentity.installLockPath || !agentIdentity.installLockSha256) {
				throw new Error("qualification_manifest_mismatch");
			}
			agentBrowser = await copyAdmittedFile({
				root: invocationRoot,
				name: "agent-browser",
				logicalPath: agentIdentity.path,
				expectedSha256: agentIdentity.sha256,
				mode: 0o500,
			});
			admittedExternal.push(agentBrowser);
			agentBrowserInstallLock = await copyAdmittedFile({
				root: invocationRoot,
				name: "agent-browser-install-lock",
				logicalPath: agentIdentity.installLockPath,
				expectedSha256: agentIdentity.installLockSha256,
				mode: 0o400,
			});
			admittedExternal.push(agentBrowserInstallLock);
		}
		if (handoffPath !== undefined) {
			try {
				handoff = await copyAdmittedFile({
					root: invocationRoot,
					name: "handoff.json",
					logicalPath: await canonicalRegularPath(handoffPath),
					mode: 0o400,
				});
			} catch {
				throw new Error("qualification_handoff_invalid");
			}
			admittedExternal.push(handoff);
			const producerPath = `${handoffPath}.producer.json`;
			try {
				producerReceipt = await copyAdmittedFile({
					root: invocationRoot,
					name: "handoff.producer.json",
					logicalPath: await canonicalRegularPath(producerPath),
					mode: 0o400,
				});
			} catch {
				throw new Error("qualification_handoff_producer_invalid");
			}
			admittedExternal.push(producerReceipt);
		}
		for (const admitted of admittedExternal) {
			const current = await handleIdentity(admitted.handle);
			if (
				current.dev !== admitted.identity.dev ||
				current.ino !== admitted.identity.ino ||
				current.size !== admitted.identity.size ||
				current.sha256 !== admitted.identity.sha256
			) throw new Error("qualification_external_identity_mismatch");
		}
		if (agentBrowser !== undefined && agentBrowserInstallLock === undefined) {
			throw new Error("qualification_manifest_mismatch");
		}
		if (handoff !== undefined && producerReceipt === undefined) {
			throw new Error("qualification_handoff_producer_invalid");
		}
		await chmod(invocationRoot, 0o500);
		await input.afterVerifiedForTest?.(bundle);
		await input.afterExternalAdmissionForTest?.();
		const childEnv = { ...input.env };
		delete childEnv.BROWSER_USE_QUALIFICATION_EXPECTED_MANIFEST_DIGEST;
		delete childEnv.BROWSER_USE_QUALIFICATION_OBSERVED_MANIFEST_DIGEST;
		delete childEnv.BROWSER_USE_QUALIFICATION_SEALED_ARTIFACT_SHA256;
		delete childEnv.BROWSER_USE_QUALIFICATION_SEALED_MANIFEST;
		delete childEnv.OP_SERVICE_ACCOUNT_TOKEN;
		delete childEnv.OP_CONNECT_HOST;
		delete childEnv.OP_CONNECT_TOKEN;
		delete childEnv.BROWSER_USE_TOKEN;
		delete childEnv.BROWSER_USE_OP_TOKEN;
		const child = spawn(
			supervisor.copyPath,
			[
				"descriptor-exec",
				"--executable-fd",
				"3",
				"--expected-dev",
				String(runtime.identity.dev),
				"--expected-ino",
				String(runtime.identity.ino),
				"--expected-size",
				String(runtime.identity.size),
				"--expected-sha256",
				runtime.identity.sha256,
				"--",
				runtime.logicalPath,
				"/dev/fd/4",
				"--sealed-artifact-exec-fd",
				"4",
				"--sealed-artifact-verify-fd",
				"5",
				"--sealed-manifest-fd",
				"6",
				"--sealed-bundle-root",
				bundle.root,
				"--expected-manifest-digest",
				input.expectedManifestDigest,
				"--sealed-artifact-dev",
				String(beforeExec.dev),
				"--sealed-artifact-ino",
				String(beforeExec.ino),
				"--sealed-artifact-size",
				String(beforeExec.size),
				"--sealed-supervisor-copy-path",
				supervisor.copyPath,
				...(agentBrowser === undefined
					? []
					: [
							"--sealed-agent-browser-copy-path",
							agentBrowser.copyPath,
							"--sealed-agent-browser-logical-path",
							agentBrowser.logicalPath,
							"--sealed-agent-browser-install-lock-copy-path",
							agentBrowserInstallLock?.copyPath ?? "",
						]),
				...(handoff === undefined
					? []
					: [
							"--sealed-handoff-copy-path",
							handoff.copyPath,
							"--sealed-handoff-logical-path",
							handoff.logicalPath,
							"--sealed-producer-receipt-copy-path",
							producerReceipt?.copyPath ?? "",
						]),
				"--sealed-child-argv",
				...input.childArgv,
			],
			{
				env: childEnv,
				stdio: [
					"inherit",
					"pipe",
					"pipe",
					runtime.handle.fd,
					artifactExec.fd,
					artifactVerify.fd,
					manifestHandle.fd,
				],
			},
		);
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
			input.onStdout?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
			input.onStderr?.(chunk);
		});
		const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("close", (code) => resolveExit(code ?? 20));
		});
		const afterExec = await handleIdentity(artifactExec);
		if (
			afterExec.dev !== beforeExec.dev ||
			afterExec.ino !== beforeExec.ino ||
			afterExec.size !== beforeExec.size ||
			afterExec.sha256 !== beforeExec.sha256
		) {
			throw new Error("qualification_bundle_file_changed");
		}
		executionResult = {
			exitCode,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
		};
	} catch (error) {
		primaryFailure = error;
	}
	{
		const cleanupDebt: string[] = [];
		const recordDebt = (code: string) => {
			if (!cleanupDebt.includes(code)) cleanupDebt.push(code);
		};
		for (const handle of [
			...admittedExternal.map((entry) => entry.handle),
			artifactExec,
			artifactVerify,
			manifestHandle,
		]) {
			try {
				await input.cleanupForTest?.closeHandle?.();
			} catch {
				recordDebt("qualification_invocation_handle_close_failed");
			}
			try {
				await handle.close();
			} catch {
				recordDebt("qualification_invocation_handle_close_failed");
			}
		}
		if (invocationRoot !== undefined) {
			try {
				await chmod(invocationRoot, 0o700);
			} catch {
				recordDebt("qualification_invocation_root_remove_failed");
			}
			try {
				await input.cleanupForTest?.removeInvocationRoot?.();
			} catch {
				recordDebt("qualification_invocation_root_remove_failed");
			}
			try {
				await rm(invocationRoot, { recursive: true, force: true });
			} catch {
				recordDebt("qualification_invocation_root_remove_failed");
			}
			if ((await lstat(invocationRoot).catch(() => undefined)) !== undefined) {
				recordDebt("qualification_invocation_root_remove_failed");
			}
		}
		if (cleanupDebt.length > 0) {
			emitQualificationDiagnostic("warning", "qualification-cleanup-debt", {
				cleanup_debt_count: cleanupDebt.length,
				handle_close_failed: cleanupDebt.includes(
					"qualification_invocation_handle_close_failed",
				),
				invocation_root_remove_failed: cleanupDebt.includes(
					"qualification_invocation_root_remove_failed",
				),
			});
			throw new QualificationCampaignFailure(
				primaryFailure === undefined
					? "qualification_invocation_cleanup_failed"
					: qualificationFailureCode(primaryFailure),
				cleanupDebt,
			);
		}
	}
	if (primaryFailure !== undefined) throw primaryFailure;
	if (executionResult === undefined) {
		throw new Error("qualification_invocation_result_missing");
	}
	return executionResult;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function writeEnvelope(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeQualificationHelp(subcommand?: string): void {
	const usage =
		subcommand === "prepare"
			? "browser-use qualification prepare --output <private-dir> --json"
			: subcommand === "manifest"
				? "browser-use qualification manifest --bundle <private-dir> --expected-manifest-digest <sha256> --json"
				: subcommand === "validate"
					? "browser-use qualification validate --bundle <private-dir> --expected-manifest-digest <sha256> --evidence <path> --json"
					: subcommand === "exec"
						? "browser-use qualification exec --bundle <private-dir> --expected-manifest-digest <sha256> -- <browser-use-argv>"
						: subcommand === "handoff"
						? "browser-use qualification handoff --bundle <private-dir> --expected-manifest-digest <sha256> --run-id <id> --output <private-path> --json"
							: subcommand === "session"
				? "browser-use qualification session --bundle <private-dir> --expected-manifest-digest <sha256> --expected-source-digest <sha256> --jsonl"
								: "browser-use qualification <prepare|manifest|validate|exec|handoff|session> --help";
	process.stdout.write(`Usage: ${usage}\n`);
}

function parseQualificationDiagnosticInvocation(argv: readonly string[]): {
	argv: string[];
	options: ReturnType<typeof parseCliDiagnosticArgv>["options"];
} {
	const separator = argv.indexOf("--");
	const head = separator < 0 ? [...argv] : argv.slice(0, separator);
	const tail = separator < 0 ? [] : argv.slice(separator + 1);
	const diagnosticTokens: string[] = [];
	const withoutModes = head.filter(
		(arg) => arg !== "--quiet" && arg !== "--verbose" && arg !== "--debug",
	);
	const subcommand = withoutModes[1];
	const runIdCandidates: Array<
		| { index: number; inline: true; value: string }
		| { index: number; inline: false; value: string }
	> = [];
	for (let index = 0; index < head.length; index += 1) {
		const arg = head[index];
		if (arg === "--run-id" && head[index + 1] !== undefined) {
			runIdCandidates.push({
				index,
				inline: false,
				value: head[index + 1] as string,
			});
			index += 1;
		} else if (arg?.startsWith("--run-id=")) {
			runIdCandidates.push({
				index,
				inline: true,
				value: arg.slice("--run-id=".length),
			});
		}
	}
	const diagnosticRunId =
		subcommand !== "handoff" &&
		runIdCandidates.length === 1 &&
		QUALIFICATION_DIAGNOSTIC_RUN_ID.test(runIdCandidates[0]?.value ?? "")
			? runIdCandidates[0]
			: undefined;
	const strippedHead: string[] = [];
	for (let index = 0; index < head.length; index += 1) {
		const arg = head[index];
		if (arg === "--quiet" || arg === "--verbose" || arg === "--debug") {
			diagnosticTokens.push(arg);
			continue;
		}
		if (diagnosticRunId?.index === index) {
			diagnosticTokens.push(
				diagnosticRunId.inline
					? `--run-id=${diagnosticRunId.value}`
					: "--run-id",
			);
			if (!diagnosticRunId.inline) {
				diagnosticTokens.push(diagnosticRunId.value);
				index += 1;
			}
			continue;
		}
		strippedHead.push(arg as string);
	}
	if (head.includes("--json") || head.includes("--jsonl")) {
		diagnosticTokens.push("--json");
	}
	const parsed = parseCliDiagnosticArgv(diagnosticTokens);
	return {
		argv: [
			...strippedHead,
			...(separator < 0 ? [] : ["--", ...tail]),
		],
		options: parsed.options,
	};
}

export async function runBrowserUseFrontDoor(
	argv: readonly string[],
	input: { wrapperPath: string },
): Promise<number> {
	if (argv[0] !== "qualification") {
		const { runBrowserUseCli } = await import("./browser-use");
		return await runBrowserUseCli(argv);
	}
	const diagnostic = parseQualificationDiagnosticInvocation(argv);
	configureCliDiagnostics({
		categoryRoot: QUALIFICATION_DIAGNOSTIC_CATEGORY,
		options: diagnostic.options,
		diagnosticWriter: diagnostic.options.quiet
			? quietDiagnosticWriter
			: process.stderr,
	});
	const command = qualificationFrontDoorCommand(diagnostic.argv[1]);
	const context = createCliDiagnosticContext(diagnostic.options, {
		qualification_command: command,
		qualification_contract_id: BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID,
		qualification_schema_version:
			BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION,
	});
	try {
		return await withCliDiagnosticContext(context, async () => {
			emitQualificationDiagnostic(
				"debug",
				"qualification-front-door-dispatch",
				{
					command,
					machine_output: diagnostic.options.json,
				},
			);
			return await runQualificationFrontDoor(diagnostic.argv, input);
		});
	} finally {
		resetCliDiagnostics();
	}
}

async function runQualificationFrontDoor(
	argv: readonly string[],
	input: { wrapperPath: string },
): Promise<number> {
	const subcommand = argv[1];
	const wrapperPath = input.wrapperPath;
	try {
		if (subcommand === undefined || subcommand === "--help") {
			writeQualificationHelp();
			return 0;
		}
		if (argv.includes("--help")) {
			if (!["prepare", "manifest", "validate", "exec", "handoff", "session"].includes(subcommand)) {
				throw new Error("qualification_bundle_input_invalid");
			}
			writeQualificationHelp(subcommand);
			return 0;
		}
		if (subcommand === "prepare") {
			const outputRoot = flag(argv, "--output");
			if (!outputRoot) throw new Error("qualification_bundle_input_invalid");
			const agentBrowserExecutable = flag(argv, "--agent-browser-executable");
			const agentBrowserInstallLock = flag(argv, "--agent-browser-install-lock");
			if ((agentBrowserExecutable === undefined) !== (agentBrowserInstallLock === undefined)) {
				throw new Error("qualification_bundle_input_invalid");
			}
			const prepared = await prepareSealedQualificationBundle({
				outputRoot,
				wrapperPath,
				...(agentBrowserExecutable === undefined
					? {}
					: { agentBrowserExecutable, agentBrowserInstallLock }),
			});
			writeEnvelope({ status: "ok", data: {
				contract: BROWSER_USE_QUALIFICATION_BUNDLE_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_BUNDLE_SCHEMA_VERSION,
				bundle_root: prepared.root,
				manifest_digest: prepared.manifest.manifest_digest,
				artifact_sha256: record(prepared.manifest.sealed_runtime)?.artifact_sha256,
				artifact_mode: 0o500,
				manifest_mode: 0o400,
			} });
			return 0;
		}
		if (
			subcommand === "manifest" ||
			subcommand === "validate" ||
			subcommand === "exec" ||
			subcommand === "handoff" ||
			subcommand === "session"
		) {
			const bundleRoot = flag(argv, "--bundle");
			const expectedManifestDigest = flag(argv, "--expected-manifest-digest");
			if (!bundleRoot || !expectedManifestDigest) throw new Error("qualification_bundle_input_invalid");
			const separator = argv.indexOf("--");
			if (
				subcommand === "exec" &&
				(separator < 0 || separator === argv.length - 1)
			) {
				throw new Error("qualification_bundle_input_invalid");
			}
			const childArgv = subcommand === "exec"
				? argv.slice(separator + 1)
				: subcommand === "manifest"
					? ["qualification", "manifest", "--json"]
					: subcommand === "handoff"
						? [
								"qualification",
								"handoff",
								"--run-id",
								flag(argv, "--run-id") ?? "",
								"--output",
								flag(argv, "--output") ?? "",
								"--json",
							]
						: subcommand === "session"
							? ["qualification", "session", "--jsonl"]
							: [
							"qualification",
							"validate",
							"--expected-manifest-digest",
							expectedManifestDigest,
							"--evidence",
							flag(argv, "--evidence") ?? "",
							"--json",
						];
			const sourceDigest = subcommand === "session"
				? flag(argv, "--expected-source-digest")
				: undefined;
			if (subcommand === "session" && (!sourceDigest || !SHA256.test(sourceDigest))) {
				throw new Error("qualification_source_identity_invalid");
			}
			const driftGuard = subcommand === "session" && sourceDigest
				? await acquireSourceLock({
						lockPath: resolve(SOURCE_ROOT, ".git/browser-use-qualification-source-drift-guard.lock"),
						subject: "Browser Use qualification campaign",
						binding: {
							generation: Number.parseInt(expectedManifestDigest.slice(0, 12), 16),
							source_digest: sourceDigest,
							manifest_digest: expectedManifestDigest,
						},
					})
				: undefined;
			if (subcommand === "session" && (!driftGuard || !driftGuard.ok)) {
				throw new Error("qualification_source_drift_guard_conflict");
			}
			let executed: Awaited<ReturnType<typeof executeVerifiedSealedQualificationBundle>> | undefined;
			let driftGuardReleased = false;
			let primaryFailure: unknown;
			let driftGuardReleaseFailure = false;
			let preSourceDigest: string | undefined;
			let postSourceDigest: string | undefined;
			let preExecutionClosureDigest: string | undefined;
			let postExecutionClosureDigest: string | undefined;
			try {
				if (subcommand === "session") {
					await assertBrowserUseQualificationRuntimeEntry();
					const admittedBundle = await verifySealedQualificationBundle({
						bundleRoot,
						expectedManifestDigest,
						wrapperPath,
					});
					const admittedSource = record(admittedBundle.manifest.source_inventory);
					const admittedClosure = record(admittedBundle.manifest.execution_closure);
					const current = await createBrowserUseQualificationManifest();
					preSourceDigest = current.source_inventory.digest;
					preExecutionClosureDigest = current.execution_closure.bundle_sha256;
					if (
						admittedSource?.digest !== sourceDigest ||
						current.source_inventory.digest !== sourceDigest ||
						admittedClosure?.bundle_sha256 !== current.execution_closure.bundle_sha256
					) throw new Error("qualification_source_drift");
				}
				executed = await executeVerifiedSealedQualificationBundle({
				bundleRoot,
				expectedManifestDigest,
				wrapperPath,
				childArgv,
					env: process.env,
					...(subcommand === "session"
						? {
								onStdout: (chunk: Uint8Array) => process.stdout.write(chunk),
								onStderr: (chunk: Uint8Array) => process.stderr.write(chunk),
							}
						: {}),
					});
				if (driftGuard?.ok) {
					const current = await createBrowserUseQualificationManifest();
					postSourceDigest = current.source_inventory.digest;
					postExecutionClosureDigest = current.execution_closure.bundle_sha256;
					if (
						current.source_inventory.digest !== sourceDigest ||
						!(await driftGuard.validate({
							generation: Number.parseInt(expectedManifestDigest.slice(0, 12), 16),
							source_digest: sourceDigest,
							manifest_digest: expectedManifestDigest,
						})).ok
					) throw new Error("qualification_source_drift_guard_lost");
				}
			} catch (error) {
				primaryFailure = error;
			} finally {
				if (driftGuard?.ok) {
					const released = await driftGuard.release();
					driftGuardReleaseFailure = !released.ok;
					driftGuardReleased = released.ok;
				}
			}
			if (driftGuardReleaseFailure) {
				throw new QualificationCampaignFailure(
					primaryFailure === undefined
						? "qualification_source_drift_guard_release_failed"
						: qualificationFailureCode(primaryFailure),
					["qualification_source_drift_guard_release_failed"],
				);
			}
			if (primaryFailure !== undefined) throw primaryFailure;
			if (executed === undefined) throw new Error("qualification_bundle_failed");
			if (subcommand !== "session" && executed.stdout) process.stdout.write(executed.stdout);
			if (subcommand !== "session" && executed.stderr) process.stderr.write(executed.stderr);
			if (subcommand === "session") {
				writeEnvelope({
					status: executed.exitCode === 0 ? "ok" : "stopped",
					data: {
						contract: BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_CONTRACT_ID,
						schema_version: BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_SCHEMA_VERSION,
						threat_model: BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
						expected_manifest_digest: expectedManifestDigest,
						observed_manifest_digest: expectedManifestDigest,
						pre_source_inventory_digest: preSourceDigest,
						post_source_inventory_digest: postSourceDigest,
						pre_execution_closure_digest: preExecutionClosureDigest,
						post_execution_closure_digest: postExecutionClosureDigest,
						source_drift_guard: {
							generation: Number.parseInt(expectedManifestDigest.slice(0, 12), 16),
							released: driftGuardReleased,
						},
						child_exit_code: executed.exitCode,
					},
				});
			}
			if (executed.exitCode !== 0) {
				emitQualificationDiagnostic(
					"error",
					"qualification-terminal-failure",
					{
						failure_kind: "execution_failed" satisfies QualificationTerminalFailureKind,
						exit_code: executed.exitCode,
						cleanup_debt_count: 0,
					},
				);
			}
			return executed.exitCode;
		}
		throw new Error("qualification_bundle_input_invalid");
	} catch (error) {
		const code = error instanceof QualificationCampaignFailure
			? error.primaryCode
			: qualificationFailureCode(error);
		emitQualificationDiagnostic("error", "qualification-terminal-failure", {
			failure_kind: qualificationTerminalFailureKind(code),
			exit_code: 20,
			cleanup_debt_count:
				error instanceof QualificationCampaignFailure
					? error.cleanupDebt.length
					: 0,
		});
		writeEnvelope({
			status: "error",
			...(error instanceof QualificationCampaignFailure
				? { data: { cleanup_debt: error.cleanupDebt } }
				: {}),
			error: { code, exit_code: 20, message: "The sealed Browser Use qualification runtime was not admitted." },
		});
		return 20;
	}
}
