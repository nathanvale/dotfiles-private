import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	WARM_CHROME_CONTRACT_ID,
	WARM_CHROME_SCHEMA_VERSION,
} from "@side-quest/warm-chrome";
import {
	AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID,
	BROWSER_CONNECT_HANDOFF_CONTRACT_ID,
	BROWSER_CONNECT_HANDOFF_SCHEMA_VERSION,
	BROWSER_USE_OPERATION_CONTRACT_ID,
	BROWSER_USE_OPERATION_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_EVIDENCE_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_MANIFEST_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_MANIFEST_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_SESSION_REQUEST_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_SESSION_REQUEST_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_VALIDATION_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_VALIDATION_SCHEMA_VERSION,
	BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
	BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
} from "./command-contract";
import {
	BROWSER_USE_CUSTODY_CONTRACT_ID,
	BROWSER_USE_CUSTODY_SCHEMA_VERSION,
	type BrowserCustodyNoFollowSnapshot,
	browserAuthorityIdOf,
	captureBrowserCustodySnapshot,
	parseBrowserCustodyRegistry,
	targetRefOf,
} from "./browser-use-browser-custody";
import { parseHandoffFacts } from "./browser-use-discovery";
import { parseBrowserOperationQualificationReceipt } from "./browser-use-operations";
import { parseBrowserTargetTopologyQualificationReceipt } from "./browser-use-target-topology";
import { parseDurableRecord } from "./browser-use-schemas";
import {
	type BrowserUsePlatformFs,
	inspectBrowserUsePaths,
} from "./browser-use-paths";
import type { BrowserUseRuntime } from "./browser-use-runtime";
import type { BrowserUseQualificationSessionAuthority } from "./browser-use-qualification-session";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_ROOT = resolve(import.meta.dir, "../../../../../..");

const QUALIFICATION_FRONT_DOOR =
	"config/agents/skills/personal/browser-use/src/browser-use-bun-preflight.ts" as const;

export const BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL = {
	id: "cooperative-same-uid-canonical-writer-v1",
	properties_proved: [
		"procedural-single-writer-custody-declared",
		"cooperative-source-drift-detected-before-and-after",
		"reviewed-closure-byte-identical-before-and-after",
		"sealed-session-handoff-capability-not-replayable",
	],
	does_not_protect: [
		"malicious-or-noncooperating-same-uid-writers",
		"compliant-writer-that-does-not-consult-the-private-drift-guard",
		"debugger-injection",
		"forged-source-drift-guard-files",
		"adversarial-time-of-check-time-of-use",
	],
} as const;

/** Native/runtime owners invoked outside the Bun module graph. */
const BROWSER_USE_QUALIFICATION_SUPPLEMENTAL_INVENTORY = [
	"config/agents/skills/personal/browser-use/package.json",
	"config/agents/skills/personal/browser-use/src/browser-use-bun-preflight.ts",
	".agents/runtime/browser-connect/package.json",
	".agents/runtime/warm-chrome/package.json",
	".agents/runtime/warm-chrome/src/model.ts",
	".agents/runtime/browser-connect/adapter-install/agent-browser/package.json",
	".agents/runtime/browser-connect/adapter-install/agent-browser/package-lock.json",
	".agents/runtime/browser-use-environment-auth/Package.swift",
	"bun.lock",
] as const;

type ManifestEntry = { path: string; sha256: string };

export type BrowserUseQualificationManifestDeps = {
	readFileBytes?: (absolutePath: string) => Promise<Uint8Array>;
	realpath?: (absolutePath: string) => Promise<string>;
	runtimeVersion?: string;
	agentBrowserExecutable?: string;
	agentBrowserInstallLock?: string;
};

export type BrowserUseQualificationManifest = {
	contract: typeof BROWSER_USE_QUALIFICATION_MANIFEST_CONTRACT_ID;
	schema_version: typeof BROWSER_USE_QUALIFICATION_MANIFEST_SCHEMA_VERSION;
	adapter_capability_id: typeof AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID;
	threat_model: typeof BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL;
	front_door: {
		path: "config/agents/skills/personal/browser-use/src/browser-use-bun-preflight.ts";
		resolved_executable_realpath: string;
		content_sha256: string;
	};
	runtime: {
		name: "bun";
		version: string;
		executable_realpath: string;
		executable_sha256: string;
		lock_sha256: string;
	};
	agent_browser: {
		executable_realpath: string;
		executable_sha256: string;
		install_lock_realpath: string;
		install_lock_sha256: string;
	};
	browser_connect: {
		resolved_executable_realpath: string;
		content_sha256: string;
	};
	warm_chrome: {
		resolved_executable_realpath: string;
		content_sha256: string;
	};
	contracts: {
		browser_entry: { id: string; schema_version: string };
		handoff: { id: string; schema_version: string };
		operation: { id: string; schema_version: string };
		topology: { id: string; schema_version: string };
		custody: { id: string; schema_version: string };
		qualification_manifest: { id: string; schema_version: string };
		qualification_validation: { id: string; schema_version: string };
		qualification_evidence: { id: string; schema_version: string };
		qualification_custody_inventory: { id: string; schema_version: string };
		qualification_runtime_evidence: { id: string; schema_version: string };
		qualification_handoff_producer: { id: string; schema_version: string };
		qualification_session_request: { id: string; schema_version: string };
		qualification_session_result: { id: string; schema_version: string };
		qualification_campaign_receipt: { id: string; schema_version: string };
	};
	source_inventory: { digest: string; entries: ManifestEntry[] };
	native_source_inventory: {
		owner: "swiftpm-package-description-v1";
		product: "browser-use-op-supervisor";
		entries: ManifestEntry[];
	};
	execution_closure: {
		bundle_sha256: string;
		input_count: number;
		owners: Array<{
			owner_id: "browser-use" | "browser-connect";
			entrypoint: string;
			input_count: number;
			digest: string;
		}>;
	};
	manifest_digest: string;
};

type SwiftPackageTarget = {
	name: string;
	path: string;
	sources: string[];
	target_dependencies?: string[];
};

async function swiftPmSupervisorSourcePaths(): Promise<string[]> {
	const packageRoot = resolve(
		SOURCE_ROOT,
		".agents/runtime/browser-use-environment-auth",
	);
	const child = Bun.spawn(["swift", "package", "describe", "--type", "json"], {
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]).then(([code, output]) => [code, output] as const);
	if (exitCode !== 0) throw new Error("qualification SwiftPM source inventory unavailable");
	const described = record(JSON.parse(stdout));
	if (!described || !Array.isArray(described.targets)) {
		throw new Error("qualification SwiftPM source inventory invalid");
	}
	const targets = new Map<string, SwiftPackageTarget>();
	for (const raw of described.targets) {
		const target = record(raw);
		if (
			typeof target?.name !== "string" ||
			typeof target.path !== "string" ||
			!Array.isArray(target.sources) ||
			target.sources.some((source) => typeof source !== "string") ||
			(target.target_dependencies !== undefined &&
				(!Array.isArray(target.target_dependencies) ||
					target.target_dependencies.some((dependency) => typeof dependency !== "string")))
		) {
			throw new Error("qualification SwiftPM source inventory invalid");
		}
		targets.set(target.name, target as unknown as SwiftPackageTarget);
	}
	const pending = ["BrowserUseEnvironmentOpSupervisor"];
	const admitted = new Set<string>();
	const paths: string[] = [];
	while (pending.length > 0) {
		const name = pending.pop();
		if (!name || admitted.has(name)) continue;
		const target = targets.get(name);
		if (!target) throw new Error("qualification SwiftPM source inventory incomplete");
		admitted.add(name);
		pending.push(...(target.target_dependencies ?? []));
		for (const source of target.sources) {
			paths.push(
				`.agents/runtime/browser-use-environment-auth/${target.path}/${source}`,
			);
		}
	}
	return [...new Set(paths)].sort();
}

export type QualificationValidation =
	| {
			ok: true;
			threat_model: typeof BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL;
			manifest_digest: string;
			expected_manifest_digest: string;
			observed_manifest_digest: string;
			sealed_artifact_sha256?: string;
			run_ids: string[];
			custody_inventory_receipt?: BrowserUseQualificationCustodyInventory["inventory_receipt"];
	  }
	| { ok: false; code: string; message: string };

type QualificationFailure = Extract<QualificationValidation, { ok: false }>;
type QualificationInterval = { acquired: number; released: number };
type ValidatedQualificationRun = {
	ok: true;
	runId: string;
	authorityId: string;
	browserWideIntervals: QualificationInterval[];
};

export type BrowserUseQualificationCustodyInventory = {
	inventory_receipt: {
		contract: typeof BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_CONTRACT_ID;
		schema_version: typeof BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_SCHEMA_VERSION;
		authority_id: string;
		root_path: string;
		root_realpath: string;
		registry_count: 1;
		lease_count: number;
		entry_count: number;
		inventory_digest: string;
		registry_revision: number;
		native_snapshot_digest: string;
		entries: Array<{ kind: "registry" | "lease"; path: string; sha256: string }>;
	};
	registry_raw: string;
	lease_record_raws: string[];
};

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseOneJson(raw: string): Record<string, unknown> | undefined {
	try {
		return record(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function refusal(code: string, message: string): QualificationFailure {
	return { ok: false, code, message };
}

export async function captureBrowserUseQualificationCustodyInventory(input: {
	fs: BrowserUsePlatformFs;
	env: Record<string, string | undefined>;
	runCommand: BrowserUseRuntime["runCommand"];
	clock?: () => number;
}): Promise<BrowserUseQualificationCustodyInventory | undefined> {
	const inspected = await inspectBrowserUsePaths(input.fs, input.env);
	if (!inspected.ok) return undefined;
	const captured = await captureBrowserCustodySnapshot({
		fs: input.fs,
		paths: inspected.paths,
		clock: input.clock ?? (() => 0),
		readNoFollowSnapshot: async (stateRoot) =>
			await readNativeCustodySnapshot({
				stateRoot,
				env: input.env,
				runCommand: input.runCommand,
			}),
	});
	if (!captured.ok) return undefined;
	const snapshot = captured.snapshot;
	const registry = parseBrowserCustodyRegistry(snapshot.registry_raw);
	if (!registry) return undefined;
	const leaseNames = snapshot.lease_records.map((record) => record.name);
	const leaseRecordRaws = snapshot.lease_records.map((record) => record.raw);
	const inventoryEntries = [
		{
			kind: "registry" as const,
			path: "browser-custody/registry.json",
			sha256: sha256(snapshot.registry_raw),
		},
		...leaseNames.map((name, index) => ({
			kind: "lease" as const,
			path: `leases/${name}`,
			sha256: sha256(leaseRecordRaws[index] ?? ""),
		})),
	];
	return {
		inventory_receipt: {
			contract: BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_CONTRACT_ID,
			schema_version: BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_SCHEMA_VERSION,
			authority_id: registry.authority_id,
			root_path: snapshot.root_path,
			root_realpath: snapshot.root_realpath,
			registry_count: 1,
			lease_count: leaseRecordRaws.length,
			entry_count: inventoryEntries.length,
			inventory_digest: sha256(JSON.stringify(inventoryEntries)),
			registry_revision: registry.revision,
			native_snapshot_digest: snapshot.native_proof_digest,
			entries: inventoryEntries,
		},
		registry_raw: snapshot.registry_raw,
		lease_record_raws: leaseRecordRaws,
	};
}

function identityRecord(value: unknown): Record<string, unknown> | undefined {
	const candidate = record(value);
	return candidate &&
		Number.isSafeInteger(candidate.device) &&
		Number.isSafeInteger(candidate.inode) &&
		Number.isSafeInteger(candidate.mode)
		? candidate
		: undefined;
}

async function readNativeCustodySnapshot(input: {
	stateRoot: string;
	env: Record<string, string | undefined>;
	runCommand: BrowserUseRuntime["runCommand"];
}): Promise<BrowserCustodyNoFollowSnapshot | undefined> {
	const supervisor = input.env.BROWSER_USE_QUALIFICATION_SUPERVISOR_PATH;
	if (!supervisor) return undefined;
	let result: Awaited<ReturnType<BrowserUseRuntime["runCommand"]>>;
	try {
		result = await input.runCommand({
			command: supervisor,
			args: ["custody-snapshot", "--state-root", input.stateRoot],
			timeoutMs: 30_000,
		});
	} catch {
		return undefined;
	}
	if (result.exitCode !== 0 || result.timedOut === true) return undefined;
	const envelope = parseOneJson(result.stdout);
	const data = record(envelope?.data);
	if (
		envelope?.contract !== "browser-use.native-custody-snapshot" ||
		envelope.schema_version !== "1" ||
		envelope.ok !== true ||
		!data ||
		data.root_path !== input.stateRoot ||
		data.root_realpath !== input.stateRoot ||
		typeof data.registry_raw !== "string" ||
		!identityRecord(data.root_identity) ||
		!identityRecord(data.custody_identity) ||
		!identityRecord(data.leases_identity) ||
		!identityRecord(data.registry_identity) ||
		!Array.isArray(data.lease_records)
	) return undefined;
	const leaseRecords: Array<{ name: string; raw: string }> = [];
	for (const rawLease of data.lease_records) {
		const lease = record(rawLease);
		if (
			!lease ||
			typeof lease.name !== "string" ||
			!/^[a-f0-9]{32}\.json$/.test(lease.name) ||
			typeof lease.raw !== "string" ||
			!identityRecord(lease.identity)
		) return undefined;
		leaseRecords.push({ name: lease.name, raw: lease.raw });
	}
	if (leaseRecords.some((entry, index) => index > 0 && entry.name <= leaseRecords[index - 1]!.name)) {
		return undefined;
	}
	return {
		root_path: input.stateRoot,
		root_realpath: input.stateRoot,
		registry_raw: data.registry_raw,
		lease_records: leaseRecords,
		proof_digest: sha256(JSON.stringify(data)),
	};
}

async function inventoryEntry(
	path: string,
	deps: BrowserUseQualificationManifestDeps,
): Promise<ManifestEntry> {
	const absolute = resolve(SOURCE_ROOT, path);
	const resolveRealpath = deps.realpath ?? realpath;
	const readBytes = deps.readFileBytes ?? (async (entry) => await readFile(entry));
	const resolvedRoot = await resolveRealpath(SOURCE_ROOT);
	const resolvedPath = await resolveRealpath(absolute);
	const rel = relative(resolvedRoot, resolvedPath);
	if (rel.startsWith("..") || resolve(resolvedRoot, rel) !== resolvedPath) {
		throw new Error("qualification inventory path escaped its source root");
	}
	return { path, sha256: sha256(await readBytes(resolvedPath)) };
}

type ExecutionClosureOwner = {
	ownerId: "browser-use" | "browser-connect";
	entrypoint: string;
	paths: string[];
};

let executionClosurePromise: Promise<ExecutionClosureOwner[]> | undefined;

async function buildCanonicalExecutionClosure(): Promise<ExecutionClosureOwner[]> {
	// Bun's metafile keys are relative to process cwd. Build in an isolated Bun
	// process with a code-owned cwd so another in-process test/caller cannot move
	// or delete the cwd while the async closure is being discovered.
	const owners = [
		{
			ownerId: "browser-use",
			entrypoint: "config/agents/skills/personal/browser-use/src/browser-use.ts",
			external: ["@side-quest/browser-connect/cli"],
		},
		{
			ownerId: "browser-connect",
			entrypoint: ".agents/runtime/browser-connect/src/cli.ts",
			external: [],
		},
	] as const;
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const root=${JSON.stringify(SOURCE_ROOT)}; const owners=${JSON.stringify(owners)}; const result=[]; for (const owner of owners) { const built=await Bun.build({entrypoints:[root+"/"+owner.entrypoint],target:"bun",format:"esm",external:owner.external,metafile:true,write:false}); if(!built.success||built.outputs.length!==1||built.metafile===undefined) process.exit(1); result.push({ownerId:owner.ownerId,entrypoint:owner.entrypoint,paths:Object.keys(built.metafile.inputs)}); } process.stdout.write(JSON.stringify(result));`,
		],
		{ cwd: SOURCE_ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdoutText] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]).then(([code, stdout]) => [code, stdout] as const);
	if (exitCode !== 0) {
		throw new Error("qualification source closure could not be bundled");
	}
	const discovered = JSON.parse(stdoutText) as unknown;
	if (!Array.isArray(discovered) || discovered.length !== owners.length) {
		throw new Error("qualification source closure returned invalid inputs");
	}
	const resolvedRoot = await realpath(SOURCE_ROOT);
	return await Promise.all(discovered.map(async (rawOwner, index) => {
		const owner = record(rawOwner);
		const expected = owners[index];
		if (
			owner?.ownerId !== expected?.ownerId ||
			owner.entrypoint !== expected.entrypoint ||
			!Array.isArray(owner.paths) ||
			owner.paths.some((inputPath) => typeof inputPath !== "string")
		) {
			throw new Error("qualification source closure returned invalid owner inputs");
		}
		const paths = await Promise.all(
			(owner.paths as string[]).map(async (inputPath) => {
			const resolvedPath = await realpath(resolve(SOURCE_ROOT, inputPath));
			const logicalPath = relative(resolvedRoot, resolvedPath);
			if (
				logicalPath.startsWith("..") ||
				resolve(resolvedRoot, logicalPath) !== resolvedPath
			) {
				throw new Error("qualification source closure escaped its source root");
			}
			return logicalPath;
			}),
		);
		return {
			ownerId: expected.ownerId,
			entrypoint: expected.entrypoint,
			paths: [...new Set(paths)].sort(),
		};
	}));
}

async function canonicalExecutionClosure(): Promise<ExecutionClosureOwner[]> {
	executionClosurePromise ??= buildCanonicalExecutionClosure();
	return await executionClosurePromise;
}

/** Emit the code-owned static manifest. No run input can select its files. */
export async function createBrowserUseQualificationManifest(
	deps: BrowserUseQualificationManifestDeps = {},
): Promise<BrowserUseQualificationManifest> {
	const closure = await canonicalExecutionClosure();
	const nativeSourcePaths = await swiftPmSupervisorSourcePaths();
	const inventoryPaths = [
		...closure.flatMap((owner) => owner.paths),
		...nativeSourcePaths,
		...BROWSER_USE_QUALIFICATION_SUPPLEMENTAL_INVENTORY,
	].filter((path, index, values) => values.indexOf(path) === index).sort();
	const entries: ManifestEntry[] = [];
	for (const path of inventoryPaths) {
		entries.push(await inventoryEntry(path, deps));
	}
	const inventoryDigest = sha256(JSON.stringify(entries));
	const nativeSourceEntries = entries.filter((entry) =>
		nativeSourcePaths.includes(entry.path),
	);
	const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
	const closureOwners = closure.map((owner) => {
		const closureEntries = owner.paths.map((path) => {
			const entry = entryByPath.get(path);
			if (!entry) throw new Error("qualification execution closure is incomplete");
			return entry;
		});
		return {
			owner_id: owner.ownerId,
			entrypoint: owner.entrypoint,
			input_count: closureEntries.length,
			digest: sha256(JSON.stringify(closureEntries)),
		};
	});
	const frontDoorPath = QUALIFICATION_FRONT_DOOR;
	const frontDoor = entries.find((entry) => entry.path === frontDoorPath);
	const lock = entries.find((entry) => entry.path === "bun.lock");
	const agentBrowserLock = entries.find(
		(entry) =>
			entry.path ===
			".agents/runtime/browser-connect/adapter-install/agent-browser/package-lock.json",
	);
	const resolveRealpath = deps.realpath ?? realpath;
	const readBytes = deps.readFileBytes ?? (async (entry) => await readFile(entry));
	const browserUseExecutable = Bun.which("browser-use");
	const browserConnectExecutable = Bun.which("browser-connect");
	const warmChromeExecutable = Bun.which("warm-chrome");
	// Bind the interpreter image actually preparing this sealed fixed point.
	// PATH resolution is not execution identity and may name a different Bun.
	const bunExecutable = process.execPath;
	const agentBrowserExecutable =
		deps.agentBrowserExecutable ?? Bun.which("agent-browser");
	if (
		!frontDoor ||
		!lock ||
		!agentBrowserLock ||
		!browserUseExecutable ||
		!browserConnectExecutable ||
		!warmChromeExecutable ||
		!agentBrowserExecutable
	) {
		throw new Error("qualification inventory is incomplete");
	}
	const resolvedFrontDoor = await resolveRealpath(browserUseExecutable);
	const resolvedBrowserConnect = await resolveRealpath(browserConnectExecutable);
	const resolvedWarmChrome = await resolveRealpath(warmChromeExecutable);
	const resolvedBun = await resolveRealpath(bunExecutable);
	const resolvedAgentBrowser = await resolveRealpath(agentBrowserExecutable);
	const agentBrowserInstallLockSha256 = deps.agentBrowserInstallLock
		? sha256(await readBytes(await resolveRealpath(deps.agentBrowserInstallLock)))
		: agentBrowserLock.sha256;
	const agentBrowserInstallLockRealpath = deps.agentBrowserInstallLock
		? await resolveRealpath(deps.agentBrowserInstallLock)
		: await resolveRealpath(
				resolve(
					SOURCE_ROOT,
					".agents/runtime/browser-connect/adapter-install/agent-browser/package-lock.json",
				),
			);
	const body = {
		contract: BROWSER_USE_QUALIFICATION_MANIFEST_CONTRACT_ID,
		schema_version: BROWSER_USE_QUALIFICATION_MANIFEST_SCHEMA_VERSION,
		adapter_capability_id: AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID,
		threat_model: BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
		front_door: {
			path: frontDoorPath,
			resolved_executable_realpath: resolvedFrontDoor,
			content_sha256: sha256(await readBytes(resolvedFrontDoor)),
		},
		runtime: {
			name: "bun" as const,
			version: deps.runtimeVersion ?? Bun.version,
			executable_realpath: resolvedBun,
			executable_sha256: sha256(await readBytes(resolvedBun)),
			lock_sha256: lock.sha256,
		},
		agent_browser: {
			executable_realpath: resolvedAgentBrowser,
			executable_sha256: sha256(await readBytes(resolvedAgentBrowser)),
			install_lock_realpath: agentBrowserInstallLockRealpath,
			install_lock_sha256: agentBrowserInstallLockSha256,
		},
		browser_connect: {
			resolved_executable_realpath: resolvedBrowserConnect,
			content_sha256: sha256(await readBytes(resolvedBrowserConnect)),
		},
		warm_chrome: {
			resolved_executable_realpath: resolvedWarmChrome,
			content_sha256: sha256(await readBytes(resolvedWarmChrome)),
		},
		contracts: {
			browser_entry: {
				id: WARM_CHROME_CONTRACT_ID,
				schema_version: WARM_CHROME_SCHEMA_VERSION,
			},
			handoff: {
				id: BROWSER_CONNECT_HANDOFF_CONTRACT_ID,
				schema_version: BROWSER_CONNECT_HANDOFF_SCHEMA_VERSION,
			},
			operation: {
				id: BROWSER_USE_OPERATION_CONTRACT_ID,
				schema_version: BROWSER_USE_OPERATION_SCHEMA_VERSION,
			},
			topology: {
				id: BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
				schema_version: BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
			},
			custody: {
				id: BROWSER_USE_CUSTODY_CONTRACT_ID,
				schema_version: BROWSER_USE_CUSTODY_SCHEMA_VERSION,
			},
			qualification_manifest: {
				id: BROWSER_USE_QUALIFICATION_MANIFEST_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_MANIFEST_SCHEMA_VERSION,
			},
			qualification_validation: {
				id: BROWSER_USE_QUALIFICATION_VALIDATION_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_VALIDATION_SCHEMA_VERSION,
			},
			qualification_evidence: {
				id: BROWSER_USE_QUALIFICATION_EVIDENCE_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
			},
			qualification_custody_inventory: {
				id: BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_CONTRACT_ID,
				schema_version:
					BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_SCHEMA_VERSION,
			},
			qualification_runtime_evidence: {
				id: BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID,
				schema_version:
					BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
			},
			qualification_handoff_producer: {
				id: BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_CONTRACT_ID,
				schema_version:
					BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_SCHEMA_VERSION,
			},
			qualification_session_request: {
				id: BROWSER_USE_QUALIFICATION_SESSION_REQUEST_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_SESSION_REQUEST_SCHEMA_VERSION,
			},
			qualification_session_result: {
				id: BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION,
			},
			qualification_campaign_receipt: {
				id: BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_CAMPAIGN_RECEIPT_SCHEMA_VERSION,
			},
		},
		source_inventory: { digest: inventoryDigest, entries },
		native_source_inventory: {
			owner: "swiftpm-package-description-v1" as const,
			product: "browser-use-op-supervisor" as const,
			entries: nativeSourceEntries,
		},
		execution_closure: {
			bundle_sha256: sha256(JSON.stringify(closureOwners)),
			input_count: new Set(closure.flatMap((owner) => owner.paths)).size,
			owners: closureOwners,
		},
	};
	return { ...body, manifest_digest: sha256(JSON.stringify(body)) };
}

export async function validateBrowserUseQualificationManifest(
	value: unknown,
	expectedManifestDigest: string,
	deps: BrowserUseQualificationManifestDeps = {},
): Promise<QualificationValidation> {
	if (!SHA256.test(expectedManifestDigest)) {
		return refusal(
			"qualification_manifest_expected_invalid",
			"The externally reviewed expected manifest digest is missing or invalid.",
		);
	}
	const supplied = record(value);
	if (
		supplied?.contract === "browser-use.qualification-bundle" &&
		supplied.schema_version === "1"
	) {
		const sealedRuntime = record(supplied.sealed_runtime);
		const body = { ...supplied };
		delete body.manifest_digest;
		const observed = sha256(JSON.stringify(body));
		if (
			supplied.manifest_digest !== expectedManifestDigest ||
			observed !== expectedManifestDigest ||
			typeof sealedRuntime?.artifact_sha256 !== "string" ||
			!SHA256.test(sealedRuntime.artifact_sha256)
		) {
			return refusal(
				"qualification_manifest_mismatch",
				"The externally reviewed sealed manifest digest does not match the observed bundle.",
			);
		}
		return {
			ok: true,
			threat_model: BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
			manifest_digest: observed,
			expected_manifest_digest: expectedManifestDigest,
			observed_manifest_digest: observed,
			sealed_artifact_sha256: sealedRuntime.artifact_sha256,
			run_ids: [],
		};
	}
	const current = await createBrowserUseQualificationManifest(deps);
	if (expectedManifestDigest !== current.manifest_digest) {
		return refusal(
			"qualification_manifest_mismatch",
			"The externally reviewed manifest digest does not match the observed implementation.",
		);
	}
	if (!isDeepStrictEqual(value, current)) {
		const suppliedDigest =
			record(value)?.manifest_digest;
		return refusal(
			"qualification_manifest_drift",
			`The supplied qualification manifest does not match this exact Browser Use implementation (supplied=${typeof suppliedDigest === "string" ? suppliedDigest.slice(0, 12) : "missing"}, current=${current.manifest_digest.slice(0, 12)}).`,
		);
	}
	return {
		ok: true,
		threat_model: BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
		manifest_digest: current.manifest_digest,
		expected_manifest_digest: expectedManifestDigest,
		observed_manifest_digest: current.manifest_digest,
		run_ids: [],
	};
}

function intervalFrom(
	value: unknown,
): QualificationInterval | undefined {
	const interval = record(value);
	const acquired = interval?.acquired_at_epoch_ms;
	const released = interval?.released_at_epoch_ms;
	return Number.isSafeInteger(acquired) &&
		Number.isSafeInteger(released) &&
		(acquired as number) >= 0 &&
		(released as number) >= (acquired as number)
		? { acquired: acquired as number, released: released as number }
		: undefined;
}

function normalizedOrigin(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: undefined;
	} catch {
		return undefined;
	}
}

export async function validateBrowserUseQualificationEvidence(input: {
	manifest: unknown;
	evidence: unknown;
	expectedManifestDigest: string;
	observedFinalCustody: BrowserUseQualificationCustodyInventory;
	sessionAuthority?: BrowserUseQualificationSessionAuthority;
}): Promise<QualificationValidation> {
	const manifestResult = await validateBrowserUseQualificationManifest(
		input.manifest,
		input.expectedManifestDigest,
	);
	if (!manifestResult.ok) return manifestResult;
	const evidence = record(input.evidence);
	if (
		!evidence ||
		evidence.contract !== BROWSER_USE_QUALIFICATION_EVIDENCE_CONTRACT_ID ||
		evidence.schema_version !== BROWSER_USE_QUALIFICATION_EVIDENCE_SCHEMA_VERSION ||
		evidence.adapter_capability_id !==
			AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID ||
		evidence.expected_manifest_digest !== input.expectedManifestDigest ||
		evidence.observed_manifest_digest !== manifestResult.manifest_digest ||
		!Array.isArray(evidence.runs) ||
		evidence.runs.length === 0
	) {
		return refusal(
			"qualification_evidence_invalid",
			"Qualification evidence is missing its exact contract, capability, or run set.",
		);
	}
	if (!isDeepStrictEqual(evidence.threat_model, BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL)) {
		return refusal(
			"qualification_threat_model_invalid",
			"Qualification evidence must declare the exact cooperative same-uid threat model and its explicit non-protections.",
		);
	}
	if (input.sessionAuthority === undefined) {
		return refusal(
			"qualification_handoff_capability_not_live",
			"Qualification evidence is not bound to the live sealed qualification session that minted its handoff.",
		);
	}

	const validatedRuns: ValidatedQualificationRun[] = [];
	const admittedManifest = record(input.manifest);
	const executionClosure = record(admittedManifest?.execution_closure);
	const browserConnectIdentity = record(admittedManifest?.browser_connect);
	const warmChromeIdentity = record(admittedManifest?.warm_chrome);
	if (
		typeof executionClosure?.bundle_sha256 !== "string" ||
		typeof browserConnectIdentity?.content_sha256 !== "string" ||
		typeof warmChromeIdentity?.content_sha256 !== "string"
	) {
		return refusal(
			"qualification_manifest_mismatch",
			"The sealed producer identities are missing from the manifest.",
		);
	}
	for (const rawRun of evidence.runs) {
		const validated = validateQualificationRun(rawRun, {
			expectedManifestDigest: manifestResult.expected_manifest_digest,
			observedManifestDigest: manifestResult.observed_manifest_digest,
			sealedArtifactSha256: manifestResult.sealed_artifact_sha256,
			producerIdentity: {
				executionClosureSha256: executionClosure.bundle_sha256,
				browserConnectSha256: browserConnectIdentity.content_sha256,
				warmChromeSha256: warmChromeIdentity.content_sha256,
			},
		}, input.sessionAuthority);
		if (!validated.ok) return validated;
		validatedRuns.push(validated);
	}
	const authorityIds = new Set(validatedRuns.map((run) => run.authorityId));
	if (authorityIds.size !== 1) {
		return refusal(
			"qualification_authority_mismatch",
			"Qualification handoffs do not share one Browser authority.",
		);
	}
	const browserWideIntervals = validatedRuns.flatMap(
		(run) => run.browserWideIntervals,
	);
	if (browserLaneIntervalsOverlap(browserWideIntervals)) {
		return refusal(
			"qualification_browser_lane_overlap",
			"Browser-wide Browser Lane intervals overlap.",
		);
	}
	const runIds = validatedRuns.map((run) => run.runId);
	const custodyFailure = validateFinalQualificationCustody(
		input.observedFinalCustody,
		runIds,
		validatedRuns[0]?.authorityId,
	);
	if (custodyFailure) return custodyFailure;
	return {
		ok: true,
		threat_model: BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
		manifest_digest: manifestResult.manifest_digest,
		expected_manifest_digest: manifestResult.expected_manifest_digest,
		observed_manifest_digest: manifestResult.observed_manifest_digest,
		...(manifestResult.sealed_artifact_sha256 === undefined
			? {}
			: { sealed_artifact_sha256: manifestResult.sealed_artifact_sha256 }),
		run_ids: runIds,
		custody_inventory_receipt: input.observedFinalCustody.inventory_receipt,
	};
}

function validateQualificationRun(
	rawRun: unknown,
	runtimeIdentity: {
		expectedManifestDigest: string;
		observedManifestDigest: string;
		sealedArtifactSha256?: string;
		producerIdentity: {
			executionClosureSha256: string;
			browserConnectSha256: string;
			warmChromeSha256: string;
		};
	},
	sessionAuthority: BrowserUseQualificationSessionAuthority,
): ValidatedQualificationRun | QualificationFailure {
	const run = record(rawRun);
	const runId = typeof run?.run_id === "string" ? run.run_id : undefined;
	const expectedOrigin = normalizedOrigin(run?.expected_origin);
	const expectedTargetRef = run?.expected_target_ref;
	if (
		!runId ||
		!expectedOrigin ||
		typeof expectedTargetRef !== "string" ||
		!SHA256.test(expectedTargetRef) ||
		typeof run?.handoff_capability_handle !== "string" ||
		!Array.isArray(run.receipt_raws) ||
		run.receipt_raws.length === 0
	) {
		return refusal(
			"qualification_evidence_invalid",
			"A qualification run record is malformed.",
		);
	}
	const liveHandoff = sessionAuthority.resolveHandoffCapability(
		String(run.handoff_capability_handle),
		runId,
	);
	if (liveHandoff === undefined) {
		return refusal(
			"qualification_handoff_capability_not_live",
			"The qualification handoff handle is absent, replayed, or belongs to another sealed child.",
		);
	}
	const handoffRaw = liveHandoff.raw;
	const parsedHandoff = parseHandoffFacts(handoffRaw);
	if (!parsedHandoff.ok || parsedHandoff.kind !== "verified") {
		return refusal(
			"qualification_handoff_invalid",
			"The run handoff is not a verified Browser Connect envelope.",
		);
	}
	const handoff = parsedHandoff.facts;
	if (handoff.adapter !== "agent-browser") {
		return refusal(
			"qualification_handoff_invalid",
			"The qualification capability requires Agent Browser.",
		);
	}
	if (handoff.runId !== runId) {
		return refusal(
			"qualification_run_mismatch",
			"The evidence run does not match its verified handoff.",
		);
	}
	const authorityId = browserAuthorityIdOf(handoff);
	const producer = parseOneJson(liveHandoff.producerReceiptRaw);
	const producerData = record(producer?.data);
	const producerIdentity = record(producerData?.producer_identity);
	if (
		producer?.status !== "ok" ||
		producerData?.contract !==
			BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_CONTRACT_ID ||
		producerData.schema_version !==
			BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_SCHEMA_VERSION ||
		producerData.command !== "qualification-handoff" ||
		producerData.producer !== "browser-connect" ||
		producerData.adapter !== "agent-browser" ||
		producerData.run_id !== runId ||
		producerData.handoff_sha256 !== sha256(handoffRaw) ||
		producerData.handoff_evidence_id !== handoff.handoffEvidenceId ||
		producerData.browser_authority_id !== authorityId ||
		producerData.expected_manifest_digest !==
			runtimeIdentity.expectedManifestDigest ||
		producerData.observed_manifest_digest !==
			runtimeIdentity.observedManifestDigest ||
		(runtimeIdentity.sealedArtifactSha256 === undefined
			? producerData.sealed_artifact_sha256 !== undefined
			: producerData.sealed_artifact_sha256 !==
				runtimeIdentity.sealedArtifactSha256) ||
		producerIdentity?.execution_closure_sha256 !==
			runtimeIdentity.producerIdentity.executionClosureSha256 ||
		producerIdentity.browser_connect_sha256 !==
			runtimeIdentity.producerIdentity.browserConnectSha256 ||
		producerIdentity.warm_chrome_sha256 !==
			runtimeIdentity.producerIdentity.warmChromeSha256
	) {
		return refusal(
			"qualification_handoff_producer_invalid",
			"The handoff was not minted by this exact sealed Browser Connect producer.",
		);
	}
	const browserWideIntervals: QualificationInterval[] = [];
	for (const rawReceipt of run.receipt_raws) {
		const failure = validateQualificationReceipt({
			rawReceipt,
			runId,
			expectedOrigin,
			expectedTargetRef,
			authorityId,
			handoffEvidenceId: handoff.handoffEvidenceId,
			handoffEndpointHttp: handoff.endpointHttp,
			browserWideIntervals,
			runtimeIdentity,
		});
		if (failure) return failure;
	}
	return { ok: true, runId, authorityId, browserWideIntervals };
}

function validateQualificationReceipt(input: {
	rawReceipt: unknown;
	runId: string;
	expectedOrigin: string;
	expectedTargetRef: string;
	authorityId: string;
	handoffEvidenceId: string;
	handoffEndpointHttp: string;
	browserWideIntervals: QualificationInterval[];
	runtimeIdentity: {
		expectedManifestDigest: string;
		observedManifestDigest: string;
		sealedArtifactSha256?: string;
		producerIdentity: {
			executionClosureSha256: string;
			browserConnectSha256: string;
			warmChromeSha256: string;
		};
	};
}): QualificationFailure | undefined {
	if (typeof input.rawReceipt !== "string") {
		return refusal(
			"qualification_receipt_invalid",
			"A receipt is not one JSON document.",
		);
	}
	const receipt = parseOneJson(input.rawReceipt);
	const rawData = record(receipt?.data);
	if (rawData?.contract === BROWSER_USE_OPERATION_CONTRACT_ID) {
		const rawExecution = record(rawData.execution);
		const rawSideEffects = record(rawData.side_effects);
		if (rawExecution?.scope !== "target-local" && rawExecution?.scope !== "browser-wide") {
			return refusal("qualification_receipt_invalid", "The operation receipt execution scope is missing or unknown.");
		}
		const exactSnapshot =
			rawData.command === "operate-snapshot" &&
			rawData.operation === "snapshot" &&
			rawExecution.scope === "target-local" &&
			rawExecution.focus === false &&
			rawSideEffects?.focus === false &&
			rawExecution.capability_id === AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID;
		const exactScreenshot =
			rawData.command === "operate-screenshot" &&
			rawData.operation === "screenshot" &&
			rawExecution.scope === "browser-wide" &&
			rawExecution.focus === true &&
			rawSideEffects?.focus === true;
		if (!exactSnapshot && !exactScreenshot) {
			return refusal(
				"qualification_capability_mismatch",
				"The operation receipt is not an exact sealed Agent Browser qualification capability.",
			);
		}
	}
	const parsedOperation =
		rawData?.contract === BROWSER_USE_OPERATION_CONTRACT_ID
			? parseBrowserOperationQualificationReceipt(input.rawReceipt)
			: undefined;
	const parsedTopology =
		rawData?.contract === BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID
			? parseBrowserTargetTopologyQualificationReceipt(input.rawReceipt)
			: undefined;
	const parsedOwner = parsedOperation ?? parsedTopology;
	const data = parsedOwner?.data;
	const binding = parsedOwner?.binding;
	const target = parsedOwner?.target;
	const execution = parsedOperation?.execution;
	const custody = parsedOwner?.custody;
	if (!receipt || !data || !binding || !target || !custody) {
		return refusal(
			"qualification_receipt_invalid",
			"A receipt is malformed or not successful.",
		);
	}
	const runtimeEvidence = record(data.qualification_runtime);
	if (
		input.runtimeIdentity.sealedArtifactSha256 !== undefined &&
		(runtimeEvidence?.contract !==
			BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID ||
			runtimeEvidence.schema_version !==
				BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION ||
			runtimeEvidence.expected_manifest_digest !==
				input.runtimeIdentity.expectedManifestDigest ||
			runtimeEvidence.observed_manifest_digest !==
				input.runtimeIdentity.observedManifestDigest ||
			runtimeEvidence.sealed_artifact_sha256 !==
				input.runtimeIdentity.sealedArtifactSha256)
	) {
		return refusal(
			"qualification_runtime_mismatch",
			"Receipt runtime identity does not match the reviewed sealed artifact.",
		);
	}
	const operationReceipt = data.contract === BROWSER_USE_OPERATION_CONTRACT_ID;
	const topologyReceipt =
		data.contract === BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID;
	if (
		!((operationReceipt &&
			data.schema_version === BROWSER_USE_OPERATION_SCHEMA_VERSION) ||
			(topologyReceipt &&
				data.schema_version === BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION))
	) {
		return refusal(
			"qualification_receipt_invalid",
			"A receipt contract or schema is not current.",
		);
	}
	if (
		data.result_kind !==
			(operationReceipt ? "browser_operation" : "browser_target_topology") ||
		data.adapter !== "agent-browser" ||
		data.effect !== "confirmed"
	) {
		return refusal(
			"qualification_receipt_invalid",
			"A receipt is not a complete successful Agent Browser owner receipt.",
		);
	}
	if (
		topologyReceipt &&
		data.command !== "targets-open" &&
		data.command !== "targets-close"
	) {
		return refusal(
			"qualification_receipt_invalid",
			"A topology receipt does not identify an exact public topology command.",
		);
	}
	if (topologyReceipt) {
		const isOpen =
			data.command === "targets-open" &&
			data.target_mutated === true &&
			data.target_present === true &&
			data.already_absent === false &&
			data.qualification_eligible === true;
		const isClose =
			data.command === "targets-close" &&
			data.target_mutated === true &&
			data.target_present === false &&
			data.already_absent === false &&
			data.qualification_eligible === true;
		if (!isOpen && !isClose) {
			return refusal(
				"qualification_receipt_invalid",
				"Topology qualification requires a mutation-confirmed eligible open or close receipt.",
			);
		}
	}
	if (
		receipt.run_id !== input.runId ||
		binding.outer_run_id !== input.runId ||
		binding.run_id !== input.runId
	) {
		return refusal(
			"qualification_run_mismatch",
			"Receipt outer and binding run identities disagree.",
		);
	}
	if (
		binding.handoff_evidence_id !== input.handoffEvidenceId ||
		binding.browser_authority_id !== input.authorityId ||
		(parsedOperation !== undefined && target.cdp_endpoint !== input.handoffEndpointHttp)
	) {
		return refusal(
			"qualification_handoff_invalid",
			"Receipt handoff binding does not match the verified envelope.",
		);
	}
	if (normalizedOrigin(target.origin ?? data.normalized_origin) !== input.expectedOrigin) {
		return refusal(
			"qualification_origin_mismatch",
			"Receipt origin differs from the run's exact normalized origin.",
		);
	}
	const receiptTargetRef = target.target_ref ?? data.target_ref;
	if (
		receiptTargetRef !== input.expectedTargetRef ||
		(operationReceipt &&
			(typeof target.target_id !== "string" ||
				targetRefOf(target.target_id) !== input.expectedTargetRef))
	) {
		return refusal(
			"qualification_target_mismatch",
			"Receipt target reference differs from the run's exact target.",
		);
	}
	const scope = execution?.scope;
	if (operationReceipt && scope === "target-local") {
		if (
			data.command !== "operate-snapshot" ||
			data.operation !== "snapshot" ||
			execution?.capability_id !==
				AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID ||
			execution.focus !== false ||
			record(data.side_effects)?.focus !== false
		) {
			return refusal(
				"qualification_capability_mismatch",
				"Target-local qualification requires the exact Agent Browser no-focus snapshot capability.",
			);
		}
	}
	if (
		operationReceipt &&
		scope === "browser-wide" &&
		!((data.command === "operate-screenshot" && data.operation === "screenshot") ||
			(data.command === "operate-emulate" && data.operation === "emulate"))
	) {
		return refusal(
			"qualification_capability_mismatch",
			"Browser-wide qualification evidence must identify a supported serialized operation.",
		);
	}
	const topologyTargetLease = topologyReceipt
		? intervalFrom(custody.target_operation_lease)
		: undefined;
	const targetOperationInterval = operationReceipt
		? intervalFrom(custody.target_operation_lease)
		: topologyTargetLease;
	const browserLaneInterval =
		topologyReceipt || scope === "browser-wide"
			? intervalFrom(custody.browser_lane)
			: undefined;
	const interval =
		scope === "target-local" ? targetOperationInterval : browserLaneInterval;
	if (
		!interval ||
		(topologyReceipt && !topologyTargetLease) ||
		(scope === "browser-wide" && !targetOperationInterval)
	) {
		return refusal(
			"qualification_release_unconfirmed",
			"Receipt custody lacks an exact confirmed release interval.",
		);
	}
	if (topologyReceipt || scope === "browser-wide") {
		input.browserWideIntervals.push(interval);
	}
	return undefined;
}

function browserLaneIntervalsOverlap(
	intervals: QualificationInterval[],
): boolean {
	for (let left = 0; left < intervals.length; left += 1) {
		for (let right = left + 1; right < intervals.length; right += 1) {
			const a = intervals[left];
			const b = intervals[right];
			if (Math.max(a.acquired, b.acquired) < Math.min(a.released, b.released)) {
				return true;
			}
		}
	}
	return false;
}

function validateFinalQualificationCustody(
	value: unknown,
	runIds: string[],
	expectedAuthorityId: string | undefined,
): QualificationFailure | undefined {
	const finalCustody = record(value);
	const inventoryReceipt = record(finalCustody?.inventory_receipt);
	if (finalCustody && !inventoryReceipt) {
		return refusal(
			"qualification_custody_inventory_unproved",
			"Final custody lacks a Browser Use-owned exhaustive inventory receipt.",
		);
	}
	if (
		!finalCustody ||
		!inventoryReceipt ||
		typeof finalCustody.registry_raw !== "string" ||
		!Array.isArray(finalCustody.lease_record_raws)
	) {
		return refusal(
			"qualification_custody_invalid",
			"Final custody evidence is malformed.",
		);
	}
	const registry = parseBrowserCustodyRegistry(finalCustody.registry_raw);
	if (!registry) {
		return refusal(
			"qualification_custody_invalid",
			"Final custody registry is invalid.",
		);
	}
	if (
		expectedAuthorityId === undefined ||
		registry.authority_id !== expectedAuthorityId ||
		inventoryReceipt.authority_id !== expectedAuthorityId
	) {
		return refusal(
			"qualification_custody_authority_mismatch",
			"Final custody is not bound to the verified Browser authority.",
		);
	}
	const leaseRaws = finalCustody.lease_record_raws;
	if (
		inventoryReceipt.contract !==
			BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_CONTRACT_ID ||
		inventoryReceipt.schema_version !==
			BROWSER_USE_QUALIFICATION_CUSTODY_INVENTORY_SCHEMA_VERSION ||
		typeof inventoryReceipt.root_path !== "string" ||
		inventoryReceipt.root_path !== inventoryReceipt.root_realpath ||
		inventoryReceipt.registry_count !== 1 ||
		inventoryReceipt.lease_count !== leaseRaws.length ||
		inventoryReceipt.entry_count !== leaseRaws.length + 1 ||
		inventoryReceipt.registry_revision !== registry.revision ||
		!Array.isArray(inventoryReceipt.entries) ||
		inventoryReceipt.entries.length !== leaseRaws.length + 1 ||
		typeof inventoryReceipt.inventory_digest !== "string" ||
		!SHA256.test(inventoryReceipt.inventory_digest) ||
		inventoryReceipt.inventory_digest !==
			sha256(JSON.stringify(inventoryReceipt.entries))
	) {
		return refusal(
			"qualification_custody_inventory_invalid",
			"Final custody inventory is incomplete, aliased, or internally inconsistent.",
		);
	}
	const inventoryEntries = inventoryReceipt.entries as Array<{
		kind?: unknown;
		path?: unknown;
		sha256?: unknown;
	}>;
	const registryEntry = inventoryEntries[0];
	if (
		registryEntry?.kind !== "registry" ||
		registryEntry.path !== "browser-custody/registry.json" ||
		registryEntry.sha256 !== sha256(finalCustody.registry_raw)
	) {
		return refusal(
			"qualification_custody_inventory_invalid",
			"Final custody registry bytes do not match their inventory entry.",
		);
	}
	for (let index = 0; index < leaseRaws.length; index += 1) {
		const entry = inventoryEntries[index + 1];
		if (
			entry?.kind !== "lease" ||
			typeof entry.path !== "string" ||
			!/^leases\/[a-f0-9]{32}\.json$/.test(entry.path) ||
			entry.sha256 !== sha256(leaseRaws[index] as string)
		) {
			return refusal(
				"qualification_custody_inventory_invalid",
				"Final custody lease bytes do not match their exhaustive inventory entry.",
			);
		}
	}
	const runSet = new Set(runIds);
	if (
		Object.values(registry.targets).some(
			(binding) =>
				binding.status === "owned" &&
				typeof binding.owner_run_id === "string" &&
				runSet.has(binding.owner_run_id),
		)
	) {
		return refusal(
			"qualification_owned_residue",
			"A qualification run still owns a target binding.",
		);
	}
	for (const rawLease of finalCustody.lease_record_raws) {
		if (typeof rawLease !== "string") {
			return refusal(
				"qualification_custody_invalid",
				"A lease record is malformed.",
			);
		}
		const parsed = parseDurableRecord(rawLease, "run-lease");
		if (!parsed.ok) {
			return refusal(
				"qualification_custody_invalid",
				"A lease record is invalid.",
			);
		}
		if (
			runIds.some(
				(runId) =>
					parsed.payload.holder_id === `browser-target-run:${runId}` ||
					parsed.payload.holder_id === `browser-lane-run:${runId}`,
			)
		) {
			return refusal(
				"qualification_lease_residue",
				"A qualification run still has a durable lease record.",
			);
		}
	}
	return undefined;
}
