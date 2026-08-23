import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { BrowserAdapterId } from "./discovery-model";
import { candidateIdOf } from "./browser-use-core";
import {
	acquireLease,
	heartbeatLease,
	listLeases,
	releaseLease,
	type LeaseDeps,
	validateStoredLeaseForWrite,
	withActivationEpochBarrier,
} from "./browser-use-locks";
import type { RunStoreDeps } from "./browser-use-runs";
import type { BrowserUseLeasePayload } from "./browser-use-schemas";
import {
	type StoreFailure,
	readDurableFile,
	withExclusiveFileLock,
	writeDurableFile,
} from "./browser-use-store";

export const BROWSER_USE_CUSTODY_CONTRACT_ID =
	"browser-use.browser-custody" as const;
export const BROWSER_USE_CUSTODY_SCHEMA_VERSION = "1" as const;
const CONTRACT = BROWSER_USE_CUSTODY_CONTRACT_ID;
const SCHEMA_VERSION = BROWSER_USE_CUSTODY_SCHEMA_VERSION;
const PRIVATE_DIRECTORY_MODE = 0o700;
const LOCK_STALE_AFTER_MS = 10_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;

/** Target-scoped operation classes governed by one atomic Target Lease. */
export type TargetOperation = "read" | "action" | "close" | "adopt";

/** Browser-wide mutations that must serialize through the single Browser Lane. */
export type BrowserWideMutation =
	| "capture"
	| "device-scale"
	| "domain-policy"
	| "snapshot"
	| "target-topology"
	| "viewport";

/** Exact first-ownership evidence admitted before a target can be leased. */
export type TargetOwnershipEvidence =
	| {
			kind: "adapter-creation-receipt";
			adapter_id: BrowserAdapterId;
			run_id: string;
			raw_target_id: string;
	  }
	| {
			kind: "explicit-adoption";
			adapter_id: BrowserAdapterId;
			run_id: string;
			raw_target_id: string;
			target_envelope_id: string;
			target_candidate_id: string;
			target_candidate_identity:
				| { kind: "adapter-page-id"; raw_adapter_page_id: string }
				| { kind: "cdp-target-id" };
	  };

/** Atomic target-operation lease bound to one Browser authority and run. */
export type TargetOperationLease = {
	contract: typeof CONTRACT;
	schema_version: typeof SCHEMA_VERSION;
	authority_id: string;
	target_ref: string;
	run_id: string;
	adapter_id: BrowserAdapterId;
	operation: TargetOperation;
	lease: BrowserUseLeasePayload;
};

/** Exclusive Browser-wide mutation lease bound to one Browser authority. */
export type BrowserLaneLease = {
	contract: typeof CONTRACT;
	schema_version: typeof SCHEMA_VERSION;
	authority_id: string;
	run_id: string;
	mutation: BrowserWideMutation;
	lease: BrowserUseLeasePayload;
};

/** Stable typed refusal codes returned by the custody owner. */
export type BrowserCustodyRefusalCode =
	| "browser_authority_changed"
	| "browser_lane_held"
	| "browser_lane_lost"
	| "browser_lane_store_failed"
	| "target_lease_held"
	| "target_lease_lost"
	| "target_lease_store_failed"
	| "target_owned_by_other_run"
	| "target_ownership_evidence_invalid"
	| "target_unowned";

/** Target Lease acquisition outcome. */
export type TargetOperationLeaseResult =
	| { ok: true; lease: TargetOperationLease; first_ownership: boolean }
	| {
			ok: false;
			code: BrowserCustodyRefusalCode;
			message: string;
			cleanup_debt?: readonly string[];
	  }
	| {
			ok: false;
			code: "target_lease_store_failed";
			message: string;
			failure_stage: "first_ownership_persistence_failed_after_no_live_binding";
			/** Short exact lease retained only for immediate creator rollback. */
			cleanup_lease: TargetOperationLease;
	  };

/** Browser Lane acquisition outcome. */
export type BrowserLaneLeaseResult =
	| { ok: true; lease: BrowserLaneLease }
	| { ok: false; code: BrowserCustodyRefusalCode; message: string };

/** Target Lease renewal outcome. */
export type TargetOperationLeaseHeartbeatResult =
	| { ok: true; lease: TargetOperationLease }
	| { ok: false; code: BrowserCustodyRefusalCode; message: string };

/** Browser Lane renewal outcome. */
export type BrowserLaneLeaseHeartbeatResult =
	| { ok: true; lease: BrowserLaneLease }
	| { ok: false; code: BrowserCustodyRefusalCode; message: string };

export type TargetBinding = {
	owner_run_id: string | null;
	status: "owned" | "released";
	adapters: BrowserAdapterId[];
	ownership_provenance: TargetOwnershipEvidence["kind"] | "legacy-unknown";
	expires_at_epoch_ms: number;
	revision: number;
};

export type BrowserCustodyRegistry = {
	contract: typeof CONTRACT;
	schema_version: typeof SCHEMA_VERSION;
	authority_id: string;
	revision: number;
	targets: Record<string, TargetBinding>;
};

type RegistryRead =
	| { status: "missing" }
	| { status: "present"; registry: BrowserCustodyRegistry }
	| { status: "invalid" };

function hash(parts: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Derive the opaque identity of one verified Agent Chrome Browser authority.
 *
 * @param input - Verified logical Browser identity and endpoint forms
 * @returns A stable opaque authority digest
 */
export function browserAuthorityIdOf(input: {
	environmentName: string;
	environmentProfile: string;
	endpointHttp: string;
	endpointWs: string;
}): string {
	return hash([
		"browser-authority",
		input.environmentName,
		input.environmentProfile,
		input.endpointHttp,
		input.endpointWs,
	]);
}

/**
 * Redact a canonical CDP target id into a durable registry key.
 *
 * @param rawTargetId - Exact CDP target id held only in process memory
 * @returns An opaque target reference safe for durable state
 * @throws {TypeError} When the target id is empty or unbounded
 */
export function targetRefOf(rawTargetId: string): string {
	if (rawTargetId.length === 0 || rawTargetId.length > 512) {
		throw new TypeError("raw target id must be bounded and non-empty");
	}
	return hash(["browser-target", rawTargetId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdapterId(value: unknown): value is BrowserAdapterId {
	return (
		value === "agent-browser" ||
		value === "chrome-devtools-mcp" ||
		value === "playwright-cdp"
	);
}

export function parseBrowserCustodyRegistry(
	raw: string,
): BrowserCustodyRegistry | undefined {
	if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (
		!isRecord(value) ||
		value.contract !== CONTRACT ||
		value.schema_version !== SCHEMA_VERSION ||
		typeof value.authority_id !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.authority_id) ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		!isRecord(value.targets)
	) {
		return undefined;
	}
	const targets: Record<string, TargetBinding> = {};
	for (const [targetRef, rawBinding] of Object.entries(value.targets)) {
		const ownershipProvenance =
			rawBinding !== null &&
			isRecord(rawBinding) &&
			(rawBinding.ownership_provenance === "adapter-creation-receipt" ||
				rawBinding.ownership_provenance === "explicit-adoption")
				? rawBinding.ownership_provenance
				: rawBinding !== null &&
						isRecord(rawBinding) &&
						rawBinding.ownership_provenance === undefined
					? "legacy-unknown"
					: undefined;
		if (
			!/^[a-f0-9]{64}$/.test(targetRef) ||
			!isRecord(rawBinding) ||
			(rawBinding.status !== "owned" && rawBinding.status !== "released") ||
			!(rawBinding.owner_run_id === null || typeof rawBinding.owner_run_id === "string") ||
			(rawBinding.status === "owned"
				? typeof rawBinding.owner_run_id !== "string" || rawBinding.owner_run_id === ""
				: rawBinding.owner_run_id !== null) ||
			!Array.isArray(rawBinding.adapters) ||
			!rawBinding.adapters.every(isAdapterId) ||
			ownershipProvenance === undefined ||
			typeof rawBinding.expires_at_epoch_ms !== "number" ||
			!Number.isSafeInteger(rawBinding.expires_at_epoch_ms) ||
			rawBinding.expires_at_epoch_ms < 0 ||
			typeof rawBinding.revision !== "number" ||
			!Number.isSafeInteger(rawBinding.revision) ||
			rawBinding.revision < 1
		) {
			return undefined;
		}
		targets[targetRef] = {
			owner_run_id: rawBinding.owner_run_id,
			status: rawBinding.status,
			adapters: [...new Set(rawBinding.adapters)],
			ownership_provenance: ownershipProvenance,
			expires_at_epoch_ms: rawBinding.expires_at_epoch_ms,
			revision: rawBinding.revision,
		};
	}
	return {
		contract: CONTRACT,
		schema_version: SCHEMA_VERSION,
		authority_id: value.authority_id,
		revision: value.revision,
		targets,
	};
}

function registryPaths(deps: RunStoreDeps) {
	const directory = join(deps.paths.resolution.roots.state, "browser-custody");
	return {
		directory,
		record: join(directory, "registry.json"),
		lock: join(deps.paths.runtime.locksDir, "browser-custody.lock"),
	};
}

type CustodyLockFailure = { ok: false; failure: StoreFailure };

async function withCustodyRegistryLock<T extends { ok: boolean }>(
	deps: RunStoreDeps,
	holderId: string,
	body: () => Promise<T>,
): Promise<T | CustodyLockFailure> {
	const paths = registryPaths(deps);
	const outcome = await withActivationEpochBarrier(
		deps,
		{ holderId: `browser-custody-epoch-${holderId}` },
		async () =>
			await withExclusiveFileLock<T>(
				deps.fs,
				{
					lockPath: paths.lock,
					holderId,
					staleAfterMs: LOCK_STALE_AFTER_MS,
					clock: deps.clock,
				},
				body,
			),
	);
	if (!outcome.ok && "code" in outcome && outcome.code === "epoch_store_failed") {
		return {
				ok: false,
				failure: {
					code: "store_lock_contended",
					message: outcome.message,
				},
			};
	}
	return outcome as T | CustodyLockFailure;
}

export type BrowserCustodySnapshot = {
	root_path: string;
	root_realpath: string;
	registry_path: string;
	registry_raw: string;
	lease_records: Array<{ name: string; raw: string }>;
	native_proof_digest: string;
};

export type BrowserCustodyNoFollowSnapshot = {
	root_path: string;
	root_realpath: string;
	registry_raw: string;
	lease_records: Array<{ name: string; raw: string }>;
	proof_digest: string;
};

function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && resolve(root, rel) === candidate);
}

async function exactRegularPath(
	deps: RunStoreDeps,
	path: string,
	kind: "file" | "directory",
	root: string,
): Promise<boolean> {
	const stat = await deps.fs.lstat(path);
	if (stat?.kind !== kind) return false;
	const resolvedPath = await deps.fs.realpath(path);
	return resolvedPath === path && isContained(root, resolvedPath);
}

/**
 * Capture the complete custody registry and lease set under the same global
 * activation barrier every canonical registry and lease mutation honors.
 */
export async function captureBrowserCustodySnapshot(
	deps: RunStoreDeps & {
		readNoFollowSnapshot: (
			stateRoot: string,
		) => Promise<BrowserCustodyNoFollowSnapshot | undefined>;
	},
): Promise<{ ok: true; snapshot: BrowserCustodySnapshot } | CustodyLockFailure> {
	const paths = registryPaths(deps);
	const rootPath = deps.paths.resolution.roots.state;
	const rootRealpath = await deps.fs.realpath(rootPath);
	if (rootRealpath !== rootPath) {
		return {
			ok: false,
			failure: {
				code: "store_record_corrupt",
				message: "Browser custody root is aliased or unavailable.",
			},
		};
	}
	const outcome = await withActivationEpochBarrier(
		deps,
		{ holderId: "browser-custody-snapshot" },
		async () => {
			const snapshot = await deps.readNoFollowSnapshot(rootPath);
			if (
				!snapshot ||
				snapshot.root_path !== rootPath ||
				snapshot.root_realpath !== rootRealpath ||
				!/^[a-f0-9]{64}$/.test(snapshot.proof_digest)
			) {
				return {
					ok: false as const,
					failure: {
						code: "store_record_corrupt" as const,
						message: "Browser custody no-follow snapshot was unavailable or malformed.",
					},
				};
			}
			return {
				ok: true as const,
				snapshot: {
					root_path: rootPath,
					root_realpath: rootRealpath,
					registry_path: paths.record,
					registry_raw: snapshot.registry_raw,
					lease_records: snapshot.lease_records,
					native_proof_digest: snapshot.proof_digest,
				},
			};
		},
	);
	if (!outcome.ok && "code" in outcome && outcome.code === "epoch_store_failed") {
		return {
				ok: false,
				failure: {
					code: "store_lock_contended",
					message: outcome.message,
				},
			};
	}
	return outcome as
		| { ok: true; snapshot: BrowserCustodySnapshot }
		| CustodyLockFailure;
}

async function ensureRegistryDirectories(
	deps: RunStoreDeps,
	directory: string,
): Promise<boolean> {
	try {
		await deps.fs.mkdir(directory, {
			recursive: true,
			mode: PRIVATE_DIRECTORY_MODE,
		});
		await deps.fs.mkdir(deps.paths.runtime.locksDir, {
			recursive: true,
			mode: PRIVATE_DIRECTORY_MODE,
		});
		return true;
	} catch {
		return false;
	}
}

async function readRegistry(
	deps: RunStoreDeps,
	path: string,
): Promise<RegistryRead> {
	const read = await readDurableFile(deps.fs, path);
	if (read.status === "missing") return { status: "missing" };
	if (read.status === "unreadable") return { status: "invalid" };
		const registry = parseBrowserCustodyRegistry(read.raw);
	return registry === undefined
		? { status: "invalid" }
		: { status: "present", registry };
}

function emptyRegistry(authorityId: string): BrowserCustodyRegistry {
	return {
		contract: CONTRACT,
		schema_version: SCHEMA_VERSION,
		authority_id: authorityId,
		revision: 0,
		targets: {},
	};
}

function storeFailure(failure?: StoreFailure): Extract<
	TargetOperationLeaseResult,
	{ ok: false }
> {
	return {
		ok: false,
		code: "target_lease_store_failed",
		message:
			failure === undefined
				? "Target Lease state could not be prepared."
				: `Target Lease state could not be updated (${failure.code}).`,
	};
}

function evidenceMatches(
	evidence: TargetOwnershipEvidence | undefined,
	runId: string,
	adapterId: BrowserAdapterId,
	rawTargetId: string,
): boolean {
	if (
		evidence === undefined ||
		evidence.run_id !== runId ||
		evidence.raw_target_id !== rawTargetId
	) {
		return false;
	}
	return evidence.kind === "explicit-adoption"
		? evidence.adapter_id === adapterId &&
			/^[a-f0-9]{32}$/.test(evidence.target_envelope_id) &&
			/^[a-f0-9]{24}$/.test(evidence.target_candidate_id) &&
			(evidence.target_candidate_identity.kind === "cdp-target-id" ||
				(evidence.target_candidate_identity.raw_adapter_page_id.length > 0 &&
					evidence.target_candidate_identity.raw_adapter_page_id.length <= 512)) &&
			candidateIdOf(
				evidence.target_envelope_id,
				evidence.target_candidate_identity.kind === "cdp-target-id"
					? ["cdp_target_id", rawTargetId]
					: [
							"adapter_page_id",
							evidence.target_candidate_identity.raw_adapter_page_id,
						],
			) === evidence.target_candidate_id
		: evidence.adapter_id === adapterId;
}

async function classifyAuthorityTransition(
	deps: RunStoreDeps,
	registry: BrowserCustodyRegistry,
	nextAuthorityId: string,
): Promise<
	| { ok: true; transition: "same-authority" | "rehome-authority" }
	| Extract<TargetOperationLeaseResult, { ok: false }>
> {
	if (registry.authority_id === nextAuthorityId) {
		return { ok: true, transition: "same-authority" };
	}
	const now = deps.clock();
	const hasLiveBinding = Object.values(registry.targets).some(
		(binding) =>
			binding.status === "owned" && binding.expires_at_epoch_ms > now,
	);
	const oldAuthorityId = registry.authority_id;
	const hasLiveAuthorityLease = (await listLeases(deps)).some(
		(lease) =>
			lease.live &&
			(lease.key.startsWith(
				`browser-target-operation:${oldAuthorityId}:`,
			) || lease.key === `browser-lane:${oldAuthorityId}`),
	);
	if (hasLiveBinding || hasLiveAuthorityLease) {
		return {
			ok: false,
			code: "browser_authority_changed",
			message:
				"Agent Chrome Browser authority changed while old-authority target or Browser Lane custody remains live.",
		};
	}
	return { ok: true, transition: "rehome-authority" };
}

async function bindOrAuthorizeTarget(
	deps: RunStoreDeps,
	input: {
		authorityId: string;
		runId: string;
		adapterId: BrowserAdapterId;
		rawTargetId: string;
		ttlMs: number;
		ownershipEvidence?: TargetOwnershipEvidence;
	},
): Promise<
	| { ok: true; firstOwnership: boolean }
	| (Extract<TargetOperationLeaseResult, { ok: false }> & {
			firstOwnershipPersistenceFailedAfterNoLiveBinding?: true;
	  })
> {
	const paths = registryPaths(deps);
	if (!(await ensureRegistryDirectories(deps, paths.directory))) {
		return storeFailure();
	}
	const targetRef = targetRefOf(input.rawTargetId);
	const outcome = await withCustodyRegistryLock<
		| { ok: true; firstOwnership: boolean }
		| Extract<TargetOperationLeaseResult, { ok: false }>
	>(
		deps,
		`browser-custody-${input.runId}`,
		async () => {
			const read = await readRegistry(deps, paths.record);
			if (read.status === "invalid") return storeFailure();
			let registry =
				read.status === "missing"
					? emptyRegistry(input.authorityId)
					: read.registry;
			const authorityTransition = await classifyAuthorityTransition(
				deps,
				registry,
				input.authorityId,
			);
			if (!authorityTransition.ok) return authorityTransition;
			const registryAuthorityMatches =
				authorityTransition.transition === "same-authority";
			if (authorityTransition.transition === "rehome-authority") {
				registry = emptyRegistry(input.authorityId);
			}
			const now = deps.clock();
			const requestedExpiresAt = now + input.ttlMs;
			const current = registry.targets[targetRef];
			if (
				current?.status === "owned" &&
				current.expires_at_epoch_ms > now
			) {
				if (current.owner_run_id !== input.runId) {
					return {
						ok: false,
						code: "target_owned_by_other_run",
						message: "The exact Browser target is owned by another run.",
					};
				}
				const expiresAt = Math.max(
					current.expires_at_epoch_ms,
					requestedExpiresAt,
				);
				if (
					!current.adapters.includes(input.adapterId) ||
					current.expires_at_epoch_ms !== expiresAt
				) {
					const next: BrowserCustodyRegistry = {
						...registry,
						revision: registry.revision + 1,
						targets: {
							...registry.targets,
							[targetRef]: {
								...current,
								adapters: current.adapters.includes(input.adapterId)
									? current.adapters
									: [...current.adapters, input.adapterId],
								expires_at_epoch_ms: expiresAt,
								revision: current.revision + 1,
							},
						},
					};
					const written = await writeDurableFile(deps.fs, {
						path: paths.record,
						contents: `${JSON.stringify(next)}\n`,
					});
					if (!written.ok) return storeFailure(written.failure);
				}
				return { ok: true, firstOwnership: false };
			}
			const ownershipEvidence = input.ownershipEvidence;
			if (
				ownershipEvidence === undefined ||
				!evidenceMatches(
					ownershipEvidence,
					input.runId,
					input.adapterId,
					input.rawTargetId,
				)
			) {
				return {
					ok: false,
					code: "target_ownership_evidence_invalid",
					message:
						"First ownership requires an exact adapter creation receipt or explicit adoption receipt.",
				};
			}
			const nextRevision = (current?.revision ?? 0) + 1;
			const next: BrowserCustodyRegistry = {
				...registry,
				revision: registry.revision + 1,
				targets: {
					...registry.targets,
					[targetRef]: {
						owner_run_id: input.runId,
						status: "owned",
						adapters: [input.adapterId],
						ownership_provenance: ownershipEvidence.kind,
						expires_at_epoch_ms: requestedExpiresAt,
						revision: nextRevision,
					},
				},
			};
			// The live-owner branch above has already returned. A missing, released,
			// or expired record is therefore a proven no-live-owner first-ownership
			// attempt. Authority drift remains ineligible for cleanup authority.
			const noLiveStandingOwner = registryAuthorityMatches;
			const written = await writeDurableFile(deps.fs, {
				path: paths.record,
				contents: `${JSON.stringify(next)}\n`,
			});
			return written.ok
				? { ok: true, firstOwnership: true }
				: {
						...storeFailure(written.failure),
						...(noLiveStandingOwner &&
						ownershipEvidence.kind === "adapter-creation-receipt"
							? {
									firstOwnershipPersistenceFailedAfterNoLiveBinding:
										true as const,
								}
							: {}),
					};
		},
	);
	return !outcome.ok && "failure" in outcome
		? storeFailure(outcome.failure)
		: outcome;
}

/**
 * Acquire exclusive operation custody for one canonical CDP target.
 *
 * @param deps - Admitted Browser Use durable-store dependencies
 * @param input - Browser authority, run, adapter, target, operation, and evidence
 * @returns An atomic Target Lease or one typed refusal
 */
export async function acquireTargetOperationLease(
	deps: RunStoreDeps,
	input: {
		authorityId: string;
		runId: string;
		adapterId: BrowserAdapterId;
		rawTargetId: string;
		operation: TargetOperation;
		ttlMs: number;
		ownershipEvidence?: TargetOwnershipEvidence;
		retainLeaseOnBindingFailure?: boolean;
	},
): Promise<TargetOperationLeaseResult> {
	const targetRef = targetRefOf(input.rawTargetId);
	const operationLease = await acquireLease(deps, {
		key: `browser-target-operation:${input.authorityId}:${targetRef}`,
		holderId: `browser-target-run:${input.runId}`,
		ttlMs: input.ttlMs,
		scope: {
			target_id: targetRef,
			...(input.retainLeaseOnBindingFailure === true &&
			input.ownershipEvidence?.kind === "adapter-creation-receipt"
				? { topology_cleanup: "adapter-creation" as const }
				: {}),
		},
	});
	if (!operationLease.ok) {
		return {
			ok: false,
			code:
				operationLease.code === "lease_held"
					? "target_lease_held"
					: "target_lease_store_failed",
			message:
				operationLease.code === "lease_held"
					? operationLease.continuation.summary
					: operationLease.message,
		};
	}
	const lease: TargetOperationLease = {
		contract: CONTRACT,
		schema_version: SCHEMA_VERSION,
		authority_id: input.authorityId,
		target_ref: targetRef,
		run_id: input.runId,
		adapter_id: input.adapterId,
		operation: input.operation,
		lease: operationLease.lease,
	};
	const binding = await bindOrAuthorizeTarget(deps, input);
	if (!binding.ok) {
		if (
			input.retainLeaseOnBindingFailure === true &&
			binding.firstOwnershipPersistenceFailedAfterNoLiveBinding === true
		) {
			return {
				ok: false,
				code: "target_lease_store_failed",
				message: binding.message,
				failure_stage:
					"first_ownership_persistence_failed_after_no_live_binding",
				cleanup_lease: lease,
			};
		}
		await releaseLease(deps, operationLease.lease);
		return binding;
	}
	return {
		ok: true,
		first_ownership: binding.firstOwnership,
		lease,
	};
}

/**
 * Retry only the durable creator-ownership write while an exact cleanup lease
 * from the narrow first-write failure is still held. This never performs a
 * browser mutation and never admits conflict or invalid-evidence failures.
 */
export async function persistTargetOwnershipUnderCleanupLease(
	deps: RunStoreDeps,
	input: {
		lease: TargetOperationLease;
		authorityId: string;
		runId: string;
		adapterId: BrowserAdapterId;
		rawTargetId: string;
		ttlMs: number;
	},
): Promise<{ ok: true } | Extract<TargetOperationLeaseResult, { ok: false }>> {
	if (
		input.lease.authority_id !== input.authorityId ||
		input.lease.run_id !== input.runId ||
		input.lease.adapter_id !== input.adapterId ||
		input.lease.target_ref !== targetRefOf(input.rawTargetId) ||
		input.lease.lease.key !==
			`browser-target-operation:${input.authorityId}:${input.lease.target_ref}` ||
		input.lease.lease.holder_id !== `browser-target-run:${input.runId}` ||
		input.lease.lease.scope.target_id !== input.lease.target_ref ||
		input.lease.lease.scope.topology_cleanup !== "adapter-creation"
	) {
		return {
			ok: false,
			code: "target_ownership_evidence_invalid",
			message: "Cleanup ownership retry does not match the exact held lease.",
		};
	}
	const refreshed = await heartbeatLease(deps, input.lease.lease, {
		ttlMs: input.ttlMs,
		requireExactPayload: true,
	});
	if (!refreshed.ok) {
		return {
			ok: false,
			code: "target_lease_lost",
			message:
				"The exact topology-cleanup lease is no longer live and current.",
		};
	}
	input = {
		...input,
		lease: { ...input.lease, lease: refreshed.lease },
	};
	const refreshedPresented = {
		fencing_token: input.lease.lease.fencing_token,
		activation_epoch: input.lease.lease.activation_epoch,
		holderId: input.lease.lease.holder_id,
	};
	const binding = await bindOrAuthorizeTarget(deps, {
		authorityId: input.authorityId,
		runId: input.runId,
		adapterId: input.adapterId,
		rawTargetId: input.rawTargetId,
		ttlMs: input.ttlMs,
		ownershipEvidence: {
			kind: "adapter-creation-receipt",
			adapter_id: input.adapterId,
			run_id: input.runId,
			raw_target_id: input.rawTargetId,
		},
	});
	if (!binding.ok) return binding;
	const after = await validateStoredLeaseForWrite(deps, {
		key: input.lease.lease.key,
		presented: refreshedPresented,
	});
	if (after.ok) return { ok: true };
	if (binding.firstOwnership) {
		const rollback = await releaseExactTargetOwnershipByRef(deps, {
			authorityId: input.authorityId,
			runId: input.runId,
			targetRef: input.lease.target_ref,
		});
		if (!rollback.ok || rollback.released !== true) {
			return {
				ok: false,
				code: "target_lease_lost",
				message:
					"The topology-cleanup lease was lost and newly written ownership rollback is unresolved.",
				cleanup_debt: ["target-ownership-rollback-failed"],
			};
		}
	}
	return {
		ok: false,
		code: "target_lease_lost",
		message:
			"The exact topology-cleanup lease was lost during ownership persistence; newly written ownership was rolled back.",
	};
}

/**
 * Release one exact operation lease without changing any Browser target.
 *
 * @param deps - Durable lease dependencies
 * @param lease - Exact lease returned by acquisition
 * @returns Confirmation that the operation lease was removed
 */
export async function releaseTargetOperationLease(
	deps: LeaseDeps,
	lease: TargetOperationLease,
): Promise<{ ok: true; released_at_epoch_ms?: number }> {
	return await releaseLease(deps, lease.lease);
}

async function extendTargetBinding(
	deps: RunStoreDeps,
	input: {
		lease: TargetOperationLease;
		ttlMs: number;
	},
): Promise<
	{ ok: true } | Extract<TargetOperationLeaseHeartbeatResult, { ok: false }>
> {
	const paths = registryPaths(deps);
	if (!(await ensureRegistryDirectories(deps, paths.directory))) {
		return storeFailure();
	}
	const outcome = await withCustodyRegistryLock<
		{ ok: true } | Extract<TargetOperationLeaseHeartbeatResult, { ok: false }>
	>(
		deps,
		`browser-custody-heartbeat-${input.lease.run_id}`,
		async () => {
			const read = await readRegistry(deps, paths.record);
			if (read.status !== "present") return storeFailure();
			if (read.registry.authority_id !== input.lease.authority_id) {
				return {
					ok: false,
					code: "browser_authority_changed",
					message:
						"Agent Chrome Browser authority changed while the Target Lease was active.",
				};
			}
			const binding = read.registry.targets[input.lease.target_ref];
			if (
				binding?.status !== "owned" ||
				binding.owner_run_id !== input.lease.run_id ||
				!binding.adapters.includes(input.lease.adapter_id)
			) {
				return {
					ok: false,
					code: "target_lease_lost",
					message:
						"The exact Browser target is no longer owned by this run and adapter.",
				};
			}
			const next: BrowserCustodyRegistry = {
				...read.registry,
				revision: read.registry.revision + 1,
				targets: {
					...read.registry.targets,
					[input.lease.target_ref]: {
						...binding,
						expires_at_epoch_ms: Math.max(
							binding.expires_at_epoch_ms,
							deps.clock() + input.ttlMs,
						),
						revision: binding.revision + 1,
					},
				},
			};
			const written = await writeDurableFile(deps.fs, {
				path: paths.record,
				contents: `${JSON.stringify(next)}\n`,
			});
			return written.ok ? { ok: true } : storeFailure(written.failure);
		},
	);
	return !outcome.ok && "failure" in outcome
		? storeFailure(outcome.failure)
		: outcome;
}

/**
 * Renew one held Target Lease and its durable target ownership window.
 *
 * @param deps - Admitted Browser Use durable-store dependencies
 * @param lease - Exact Target Lease returned by acquisition or prior heartbeat
 * @param input - New bounded TTL window
 * @returns The renewed Target Lease or one typed loss/store refusal
 */
export async function heartbeatTargetOperationLease(
	deps: RunStoreDeps,
	lease: TargetOperationLease,
	input: { ttlMs: number },
): Promise<TargetOperationLeaseHeartbeatResult> {
	const renewed = await heartbeatLease(deps, lease.lease, input);
	if (!renewed.ok) {
		return {
			ok: false,
			code:
				renewed.code === "lease_store_failed"
					? "target_lease_store_failed"
					: "target_lease_lost",
			message:
				"message" in renewed
					? renewed.message
					: "The exact Target Lease is no longer held by this run.",
		};
	}
	const extended = await extendTargetBinding(deps, { lease, ttlMs: input.ttlMs });
	if (!extended.ok) {
		await releaseLease(deps, renewed.lease);
		return extended;
	}
	return { ok: true, lease: { ...lease, lease: renewed.lease } };
}

/**
 * Release every durable target binding owned by one completed run.
 *
 * @param deps - Admitted Browser Use durable-store dependencies
 * @param runId - Exact completed run id
 * @returns The number of released bindings or one typed store refusal
 */
export async function releaseRunTargetOwnership(
	deps: RunStoreDeps,
	runId: string,
): Promise<
	| { ok: true; released: number }
	| Extract<TargetOperationLeaseResult, { ok: false }>
> {
	const paths = registryPaths(deps);
	if (!(await ensureRegistryDirectories(deps, paths.directory))) {
		return storeFailure();
	}
	const outcome = await withCustodyRegistryLock<
		| { ok: true; released: number }
		| Extract<TargetOperationLeaseResult, { ok: false }>
	>(
		deps,
		`browser-custody-release-${runId}`,
		async () => {
			const read = await readRegistry(deps, paths.record);
			if (read.status === "invalid") return storeFailure();
			if (read.status === "missing") return { ok: true, released: 0 };
			let released = 0;
			const targets = Object.fromEntries(
				Object.entries(read.registry.targets).map(([targetRef, binding]) => {
					if (binding.status !== "owned" || binding.owner_run_id !== runId) {
						return [targetRef, binding];
					}
					released += 1;
					return [
						targetRef,
						{
							...binding,
							owner_run_id: null,
							status: "released" as const,
							expires_at_epoch_ms: deps.clock(),
							revision: binding.revision + 1,
						},
					];
				}),
			);
			if (released === 0) return { ok: true, released: 0 };
			const written = await writeDurableFile(deps.fs, {
				path: paths.record,
				contents: `${JSON.stringify({
					...read.registry,
					revision: read.registry.revision + 1,
					targets,
				})}\n`,
			});
			return written.ok
				? { ok: true, released }
				: storeFailure(written.failure);
		},
	);
	return !outcome.ok && "failure" in outcome
		? storeFailure(outcome.failure)
		: outcome;
}

/**
 * Release one exact target binding owned by one run without affecting another
 * target the same run or another run owns.
 */
export async function releaseExactTargetOwnershipByRef(
	deps: RunStoreDeps,
	input: { authorityId: string; runId: string; targetRef: string },
): Promise<
	| { ok: true; released: boolean }
	| Extract<TargetOperationLeaseResult, { ok: false }>
> {
	const paths = registryPaths(deps);
	if (!(await ensureRegistryDirectories(deps, paths.directory))) {
		return storeFailure();
	}
	if (!/^[a-f0-9]{64}$/.test(input.targetRef)) return storeFailure();
	const targetRef = input.targetRef;
	const outcome = await withCustodyRegistryLock<
		| { ok: true; released: boolean }
		| Extract<TargetOperationLeaseResult, { ok: false }>
	>(
		deps,
		`browser-custody-release-${input.runId}`,
		async () => {
			const read = await readRegistry(deps, paths.record);
			if (read.status === "invalid") return storeFailure();
			if (read.status === "missing") return { ok: true, released: false };
			if (read.registry.authority_id !== input.authorityId) {
				return {
					ok: false,
					code: "browser_authority_changed",
					message:
						"The exact Browser authority does not match the custody registry.",
				};
			}
			const binding = read.registry.targets[targetRef];
			if (binding?.status !== "owned" || binding.owner_run_id !== input.runId) {
				return { ok: true, released: false };
			}
			const next: BrowserCustodyRegistry = {
				...read.registry,
				revision: read.registry.revision + 1,
				targets: {
					...read.registry.targets,
					[targetRef]: {
						...binding,
						owner_run_id: null,
						status: "released",
						expires_at_epoch_ms: deps.clock(),
						revision: binding.revision + 1,
					},
				},
			};
			const written = await writeDurableFile(deps.fs, {
				path: paths.record,
				contents: `${JSON.stringify(next)}\n`,
			});
			return written.ok
				? { ok: true, released: true }
				: storeFailure(written.failure);
		},
	);
	return !outcome.ok && "failure" in outcome
		? storeFailure(outcome.failure)
		: outcome;
}

/** Private repair projection of opaque target refs still owned by one run. */
export async function ownedTargetRefsForRun(
	deps: RunStoreDeps,
	input: {
		authorityId: string;
		runId: string;
		adapterId: BrowserAdapterId;
	},
): Promise<
	| { ok: true; targetRefs: readonly string[] }
	| Extract<TargetOperationLeaseResult, { ok: false }>
> {
	const paths = registryPaths(deps);
	if (!(await ensureRegistryDirectories(deps, paths.directory))) {
		return storeFailure();
	}
	const read = await readRegistry(deps, paths.record);
	if (read.status === "invalid") return storeFailure();
	const authorityTransition =
		read.status === "present"
			? await classifyAuthorityTransition(
					deps,
					read.registry,
					input.authorityId,
				)
			: { ok: true as const, transition: "same-authority" as const };
	if (!authorityTransition.ok) return authorityTransition;
	const registryRefs =
		read.status === "present" &&
		authorityTransition.transition === "same-authority"
			? Object.entries(read.registry.targets)
					.filter(
						([, binding]) =>
							binding.status === "owned" &&
							binding.owner_run_id === input.runId &&
							binding.adapters.includes(input.adapterId) &&
							binding.ownership_provenance === "adapter-creation-receipt",
					)
					.map(([targetRef]) => targetRef)
			: [];
	const cleanupRefs = (await listLeases(deps))
		.filter(
			(lease) =>
				lease.live &&
				lease.holder_id === `browser-target-run:${input.runId}` &&
				lease.key.startsWith(
					`browser-target-operation:${input.authorityId}:`,
				) &&
				lease.scope.topology_cleanup === "adapter-creation" &&
				typeof lease.scope.target_id === "string" &&
				/^[a-f0-9]{64}$/.test(lease.scope.target_id),
		)
		.map((lease) => lease.scope.target_id as string);
	return {
		ok: true,
		targetRefs: [...new Set([...registryRefs, ...cleanupRefs])].sort(),
	};
}

/** Private exact check for a persistent adapter-created registry owner. */
export async function hasExactCreatedTargetOwnership(
	deps: RunStoreDeps,
	input: {
		authorityId: string;
		runId: string;
		adapterId: BrowserAdapterId;
		targetRef: string;
	},
): Promise<
	| { ok: true; owned: boolean }
	| Extract<TargetOperationLeaseResult, { ok: false }>
> {
	const read = await readRegistry(deps, registryPaths(deps).record);
	if (read.status === "invalid") return storeFailure();
	if (read.status === "missing") return { ok: true, owned: false };
	if (read.registry.authority_id !== input.authorityId) {
		return {
			ok: false,
			code: "browser_authority_changed",
			message:
				"The exact Browser authority does not match the custody registry.",
		};
	}
	const binding = read.registry.targets[input.targetRef];
	return {
		ok: true,
		owned:
			binding?.status === "owned" &&
			binding.owner_run_id === input.runId &&
			binding.adapters.includes(input.adapterId) &&
			binding.ownership_provenance === "adapter-creation-receipt",
	};
}

/** Resolve one exact retained topology-cleanup lease for canonical close. */
export async function retainedTopologyCleanupLeaseForRun(
	deps: RunStoreDeps,
	input: { authorityId: string; runId: string; targetRef: string },
): Promise<TargetOperationLease | undefined> {
	const matches = (await listLeases(deps)).filter(
		(lease) =>
			lease.live &&
			lease.holder_id === `browser-target-run:${input.runId}` &&
			lease.key ===
				`browser-target-operation:${input.authorityId}:${input.targetRef}` &&
			lease.scope.target_id === input.targetRef &&
			lease.scope.topology_cleanup === "adapter-creation",
	);
	if (matches.length !== 1) return undefined;
	const lease = matches[0]!;
	return {
		contract: CONTRACT,
		schema_version: SCHEMA_VERSION,
		authority_id: input.authorityId,
		target_ref: input.targetRef,
		run_id: input.runId,
		adapter_id: "agent-browser",
		operation: "close",
		lease: {
			key: lease.key,
			holder_id: lease.holder_id,
			fencing_token: lease.fencing_token,
			activation_epoch: lease.activation_epoch,
			acquired_at_epoch_ms: lease.acquired_at_epoch_ms,
			heartbeat_at_epoch_ms: lease.heartbeat_at_epoch_ms,
			expires_at_epoch_ms: lease.expires_at_epoch_ms,
			recovered_from: lease.recovered_from,
			scope: lease.scope,
		},
	};
}

/** Revalidate and extend one exact retained topology-cleanup lease. */
export async function heartbeatRetainedTopologyCleanupLease(
	deps: RunStoreDeps,
	lease: TargetOperationLease,
	ttlMs: number,
): Promise<TargetOperationLeaseResult> {
	if (
		lease.lease.key !==
			`browser-target-operation:${lease.authority_id}:${lease.target_ref}` ||
		lease.lease.holder_id !== `browser-target-run:${lease.run_id}` ||
		lease.lease.scope.target_id !== lease.target_ref ||
		lease.lease.scope.topology_cleanup !== "adapter-creation"
	) {
		return {
			ok: false,
			code: "target_ownership_evidence_invalid",
			message: "Retained topology-cleanup lease identity is invalid.",
		};
	}
	const heartbeat = await heartbeatLease(deps, lease.lease, {
		ttlMs,
		requireExactPayload: true,
	});
	if (!heartbeat.ok) {
		return {
			ok: false,
			code:
				heartbeat.code === "lease_store_failed"
					? "target_lease_store_failed"
					: "target_lease_lost",
			message: "Retained topology-cleanup lease is no longer live and current.",
		};
	}
	return {
		ok: true,
		first_ownership: false,
		lease: { ...lease, lease: heartbeat.lease, operation: "close" },
	};
}

/** Raw-id convenience wrapper; durable callers should prefer the opaque ref. */
export async function releaseExactTargetOwnership(
	deps: RunStoreDeps,
	input: { authorityId: string; runId: string; rawTargetId: string },
) {
	return await releaseExactTargetOwnershipByRef(deps, {
		authorityId: input.authorityId,
		runId: input.runId,
		targetRef: targetRefOf(input.rawTargetId),
	});
}

/**
 * Acquire the exclusive Browser-wide mutation lane.
 *
 * @param deps - Durable lease dependencies
 * @param input - Browser authority, run, mutation class, and bounded TTL
 * @returns The Browser Lane lease or one typed refusal
 */
export async function acquireBrowserLaneLease(
	deps: LeaseDeps,
	input: {
		authorityId: string;
		runId: string;
		mutation: BrowserWideMutation;
		ttlMs: number;
	},
): Promise<BrowserLaneLeaseResult> {
	const acquired = await acquireLease(deps, {
		key: `browser-lane:${input.authorityId}`,
		holderId: `browser-lane-run:${input.runId}`,
		ttlMs: input.ttlMs,
	});
	if (!acquired.ok) {
		return {
			ok: false,
			code:
				acquired.code === "lease_held"
					? "browser_lane_held"
					: "browser_lane_store_failed",
			message:
				acquired.code === "lease_held"
					? acquired.continuation.summary
					: acquired.message,
		};
	}
	return {
		ok: true,
		lease: {
			contract: CONTRACT,
			schema_version: SCHEMA_VERSION,
			authority_id: input.authorityId,
			run_id: input.runId,
			mutation: input.mutation,
			lease: acquired.lease,
		},
	};
}

/**
 * Release one exact Browser Lane lease.
 *
 * @param deps - Durable lease dependencies
 * @param lease - Exact Browser Lane lease returned by acquisition
 * @returns Exact durable release epoch when this holder's live lease was released
 */
export async function releaseBrowserLaneLease(
	deps: LeaseDeps,
	lease: BrowserLaneLease,
): Promise<{ ok: true; released_at_epoch_ms?: number }> {
	return await releaseLease(deps, lease.lease);
}

/**
 * Renew the exclusive Browser Lane without changing its Browser authority.
 *
 * @param deps - Durable lease dependencies
 * @param lease - Exact Browser Lane lease returned by acquisition or heartbeat
 * @param input - New bounded TTL window
 * @returns The renewed Browser Lane lease or one typed loss/store refusal
 */
export async function heartbeatBrowserLaneLease(
	deps: LeaseDeps,
	lease: BrowserLaneLease,
	input: { ttlMs: number },
): Promise<BrowserLaneLeaseHeartbeatResult> {
	const renewed = await heartbeatLease(deps, lease.lease, input);
	if (!renewed.ok) {
		return {
			ok: false,
			code:
				renewed.code === "lease_store_failed"
					? "browser_lane_store_failed"
					: "browser_lane_lost",
			message:
				"message" in renewed
					? renewed.message
					: "The exclusive Browser Lane is no longer held by this run.",
		};
	}
	return { ok: true, lease: { ...lease, lease: renewed.lease } };
}
