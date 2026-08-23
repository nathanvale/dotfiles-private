// ---------------------------------------------------------------------------
// Browser Operations (plan U7, transport re-anchored in migration U3).
//
// Owns the operate workflow: the runOperate pipeline (read inputs -> load
// binding -> resolve target context -> lane-routed optional explicit focus
// and execution) plus the failure bridges that map discovery/selection/
// transport/resolution failures onto the operation diagnostic taxonomy, and
// snapshot bounding. Orchestrates every layer below it — imports down into
// core, runtime, transport, discovery, and selection. Single public entry:
// runOperate.
//
// Adapter-addressable identity (schema 3): the success envelope publishes the
// canonical CDP target id proven for this call, plus the verified http
// endpoint. Without them a caller holding a proven selection could not tell the
// adapter which tab it won — candidate_id is a one-way hash and cannot address
// a tab. This does NOT relax R32/KTD6 at discovery: `targets list` still
// projects redacted candidates only, so a canonical id is published for the one
// target actually operated on, never for every listed tab. Do not publish the
// ws debugger URL here, and do not publish the derived Adapter Session Lease
// lifecycle reference — short-lived lifecycle custody is released before this
// envelope is emitted, so naming it would hand the caller a dead pointer.
// ---------------------------------------------------------------------------

import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
	type CliWriter,
	type RuntimeActionGuidance,
	createCliRuntimeError,
	createCliRuntimeErrorEnvelope,
	createCliRuntimeSuccessEnvelope,
	writeJsonEnvelope,
} from "@side-quest/cli-command-facade";
import {
	BROWSER_USE_OPERATION_CONTRACT_ID,
	BROWSER_USE_OPERATION_SCHEMA_VERSION,
	type BrowserUseCommand,
	browserUseOperationFailureActions,
	browserUseOperationSuccessActions,
} from "./command-contract";
import { sealedQualificationRuntimeEvidence } from "./browser-use-qualification-evidence";
import {
	authorizesOperationClass,
	type BrowserOperationClass,
} from "./capability-policy";
import type {
	BrowserAdapterId,
	BrowserTargetCandidate,
} from "./discovery-model";
import type { McporterCommandResult } from "./mcporter-transport";
import {
	type BrowserOperationTransportFailure,
	type BrowserOperationTransportResult,
	runEnvelopeAdapterCall,
} from "./browser-use-transport";
import type { ParsedBrowserUseCommand } from "./browser-use-parser";
import {
	type Failure,
	type OutputMode,
	type RawPage,
	BINDING_FAIL_CLOSED_EXIT_CODE,
	RUNTIME_FAILURE_EXIT_CODE,
	USAGE_EXIT_CODE,
	actionFor,
	candidateMatchesHints,
	isJsonObject,
	navigableRawPages,
	parseUrlSafe,
	redactUnsafeText,
	stringField,
	targetEnvelopeIdOf,
	toCandidate,
} from "./browser-use-core";
import type { BrowserUseRuntime } from "./browser-use-runtime";
import {
	type HandoffFacts,
	type TargetDiscoveryFailure,
	discoverPages,
	readHandoffFacts,
} from "./browser-use-discovery";
import {
	type OperationResolution,
	type OperationTargetHints,
	type SelectedTargetState,
	type SelectionFailure,
	canonicalRunSelectedStatePath,
	loadSelectedState,
	resolveOperationTarget,
	resolveStatePath,
	runScopedKey,
} from "./browser-use-selection";
import { retryabilityForRecoverability } from "./runtime-error-retryability";
import {
	resolveExactTargetOperationCapability,
} from "./browser-use-adapter-registry";
import type {
	BrowserUseAdapterLifecycleReleaseDebt,
	BrowserUseExactTargetHandoff,
	BrowserUseExactTargetOperationCapability,
} from "./browser-use-adapter-model";
import {
	parseBrowserUseTargetOperationPlan,
	targetOperationPlanIsMutating,
	targetOperationPlanMatchesBoundOrigin,
	targetOperationPlanDigest,
	type BrowserUseTargetOperationCleanupMethod,
	type BrowserUseTargetOperationPlan,
	type BrowserUseTargetOperationResult,
} from "./browser-use-target-operations";
import type { RunStoreDeps } from "./browser-use-runs";
import {
	type BrowserUsePathRefusal,
	inspectBrowserUsePaths,
	openBrowserUsePaths,
} from "./browser-use-paths";
import {
	type BrowserCustodyRefusalCode,
	type BrowserLaneLease,
	type BrowserWideMutation,
	type TargetOperationLease,
	type TargetOperationLeaseResult,
	acquireBrowserLaneLease,
	acquireTargetOperationLease,
	browserAuthorityIdOf,
	heartbeatTargetOperationLease,
	releaseBrowserLaneLease,
	releaseExactTargetOwnershipByRef,
	releaseTargetOperationLease,
	targetRefOf,
} from "./browser-use-browser-custody";
import type {
	BrowserUseCdpTargetIdentity,
	BrowserUseTargetProofRefusalCause,
} from "./browser-use-target-proof";

// ---------------------------------------------------------------------------
// Browser Operations (plan U7, evidence re-based in migration U1).
//
// `browser-use operate snapshot|screenshot|emulate` runs one authorized live
// browser operation. The pipeline reads inputs, loads the Verified Handoff
// Envelope binding, loads the selected-target context, resolves an opaque
// adapter page ref, and dispatches through one adapter-neutral execution plan.
// A newly created target may use its run-owned retained exact-target lifecycle
// for a no-focus target-local snapshot. Ordinary targets and every adapter
// without its own exact-target no-focus proof remain
// Browser-Lane serialized. Chrome DevTools MCP keeps its native pageId routing;
// this module does not infer concurrency safety from that transport shape.
// Every failure mode bridges down into the operation failure taxonomy
// (handoff, selection, discovery, transport, resolution).
// ---------------------------------------------------------------------------

const SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_MAX_LINES = 1000;

type OperationActionId =
	| (typeof browserUseOperationFailureActions)[number]["id"]
	| (typeof browserUseOperationSuccessActions)[number]["id"];

const operationActions = [
	...browserUseOperationFailureActions,
	...browserUseOperationSuccessActions,
] as const;
const operationActionById = new Map(
	operationActions.map((action) => [action.id, action]),
);

type OperationCleanupDebt =
	| "browser-lane-release-failed"
	| "target-operation-lease-release-failed"
	| "target-ownership-release-failed";

type OperationFailure = Failure<OperationActionId> & {
	primaryCause?: string;
	operationEffect?: "confirmed" | "not_started" | "unknown";
	cleanupDebt?: readonly OperationCleanupDebt[];
};

type OperationSideEffects = {
	focus?: boolean;
};

/** Exact public target facts retained after pre-dispatch proof for a
 * controlled post-dispatch refusal. Adapter-private lifecycle data stays out. */
type OperationFailureReceiptContext = {
	operation: BrowserOperationClass;
	adapter: BrowserAdapterId;
	handoff: HandoffFacts;
	target: BrowserTargetCandidate;
	canonicalTargetId: string;
	targetSource: "hints" | "selected_state" | "single_candidate";
	capabilityId?: string;
	planDigest?: string;
};

type OperationExecutionEvidence = {
	scope: "target-local" | "browser-wide";
	focus: boolean;
	capability_id?: string;
	plan_digest?: string;
	steps?: BrowserUseTargetOperationResult["steps"];
	cleanup?: BrowserUseTargetOperationResult["cleanup"];
};

type TargetOperationLeaseInterval = {
	acquiredAtEpochMs: number;
	releasedAtEpochMs: number;
};

type BrowserLaneLeaseInterval = TargetOperationLeaseInterval;

type OperationExecutionPlan =
	| {
			scope: "target-local";
			retainedLifecycle: "adapter-exact-target-lifecycle";
			plan?: BrowserUseTargetOperationPlan;
	  }
	| {
			scope: "browser-wide";
			mutation: BrowserWideMutation;
	  };

function operationExecutionPlan(input: {
	adapter: BrowserAdapterId;
	operation: BrowserOperationClass;
	retainedLifecycleRef?: string;
	runId: string;
	plan?: BrowserUseTargetOperationPlan;
}): OperationExecutionPlan {
	const resolved = resolveExactTargetOperationCapability(input.adapter);
	if (
		resolved.ok &&
		input.operation === "target" &&
		input.plan !== undefined &&
		resolved.capability.runTargetPlan !== undefined &&
		resolved.capability.retainedLifecycleIsValid(
			input.retainedLifecycleRef,
			input.runId,
		)
	) {
		return {
			scope: "target-local",
			retainedLifecycle: "adapter-exact-target-lifecycle",
			plan: input.plan,
		};
	}
	if (
		resolved.ok &&
		input.operation === "snapshot" &&
		resolved.capability.retainedLifecycleIsValid(
			input.retainedLifecycleRef,
			input.runId,
		)
	) {
		return {
			scope: "target-local",
			retainedLifecycle: "adapter-exact-target-lifecycle",
		};
	}
	return {
		scope: "browser-wide",
		mutation:
			input.operation === "screenshot"
				? "capture"
				: input.operation === "emulate"
					? "viewport"
					: "snapshot",
	};
}

type OperationTargetEntry = {
	candidate: BrowserTargetCandidate;
	adapterPageRef?: string;
	canonicalTargetId?: string;
	rawUrl: string;
};

function exactTargetHandoff(facts: HandoffFacts): BrowserUseExactTargetHandoff {
	return {
		adapter_id: facts.adapter,
		run_id: facts.runId,
		executable: facts.probeExecutable,
		endpoint_http: facts.endpointHttp,
		endpoint_ws: facts.endpointWs,
	};
}

/** Exact browser-level target resolver injected by the CLI driver. */
export type BrowserOperationTargetIdentityResolver = (input: {
	handoff: HandoffFacts;
	expectedUrl: string;
	allowedOrigins: readonly string[];
	preferredTargetId?: string;
}) => Promise<
	| { ok: true; target: BrowserUseCdpTargetIdentity }
	| { ok: false; cause: BrowserUseTargetProofRefusalCause }
>;

/** Run-scoped PNG target owned by the screenshot Browser Operation. */
export type ScreenshotArtifact = {
	path: string;
	relativePath: string;
	root: string;
	format: "png";
	fullPage: boolean;
};

type ScreenshotArtifactEvidence = ScreenshotArtifact & {
	byteCount: number;
	contentSha256: string;
	mediaType: "image/png";
};

/** Result of adapter-agnostic screenshot-media capture for a bound target. */
export type BrowserUseScreenshotMediaCaptureResult =
	| {
			ok: true;
			artifact: ScreenshotArtifact;
			focus: boolean;
			release?: BrowserUseAdapterLifecycleReleaseDebt;
	  }
	| {
			ok: false;
			code: string;
			message: string;
			release?: BrowserUseAdapterLifecycleReleaseDebt;
			primary_code?: string;
			cleanup_debt?: readonly ["browser-lane-release-failed"];
	  };

/**
 * Capture one PNG through the existing screenshot-media Browser Operation lane.
 *
 * @param input - Verified handoff, exact adapter page ref, and run-scoped output
 * @returns Captured artifact metadata or one fail-closed operation refusal
 * @example
 * ```ts
 * await captureBrowserUseScreenshotMedia({
 *   runtime,
 *   handoff,
 *   adapterPageRef: "1",
 *   artifact: { path, relativePath: "approval.png", root, format: "png", fullPage: true },
 * })
 * ```
 */
export async function captureBrowserUseScreenshotMedia(input: {
	runtime: BrowserUseRuntime;
	handoff: HandoffFacts;
	adapterPageRef: string;
	artifact: ScreenshotArtifact;
	custody: {
		deps: RunStoreDeps;
		rawTargetId: string;
		targetLease: TargetOperationLease;
		ttlMs: number;
	};
}): Promise<BrowserUseScreenshotMediaCaptureResult> {
	if (
		!authorizesOperationClass(
			{ authorized_capabilities: [...input.handoff.authorizedCapabilities] },
			"screenshot",
		)
	) {
		return {
			ok: false,
			code: "browser_operation_capability_unauthorized",
			message:
				"the verified handoff does not authorize screenshot_media for this adapter.",
		};
	}
	const directory = await ensureScreenshotArtifactDirectory(
		input.runtime,
		input.artifact,
	);
	if (!directory.ok) {
		return {
			ok: false,
			code: directory.failure.code,
			message: directory.failure.message,
		};
	}
	const authorityId = browserAuthorityIdOf(input.handoff);
	if (
		input.custody.targetLease.authority_id !== authorityId ||
		input.custody.targetLease.run_id !== input.handoff.runId ||
		input.custody.targetLease.target_ref !==
			targetRefOf(input.custody.rawTargetId)
	) {
		return {
			ok: false,
			code: "target_lease_lost",
			message:
				"Screenshot capture requires the exact active Target Lease for this Browser target.",
		};
	}
	const targetLease = await heartbeatTargetOperationLease(
		input.custody.deps,
		input.custody.targetLease,
		{ ttlMs: input.custody.ttlMs },
	);
	if (!targetLease.ok) {
		return {
			ok: false,
			code: targetLease.code,
			message: targetLease.message,
		};
	}
	const browserLane = await acquireBrowserLaneLease(input.custody.deps, {
		authorityId,
		runId: input.handoff.runId,
		mutation: "capture",
		ttlMs: 120_000,
	});
	if (!browserLane.ok) {
		return {
			ok: false,
			code: browserLane.code,
			message: browserLane.message,
		};
	}
	let captured: Awaited<ReturnType<typeof runOperationLane>>;
	let browserLaneReleasedAtEpochMs: number | undefined;
	try {
		captured = await runOperationLane({
			runtime: input.runtime,
			handoff: input.handoff,
			adapterPageRef: input.adapterPageRef,
			operation: "screenshot",
			screenshot: input.artifact,
			verbose: false,
			bringToFront: false,
		});
	} finally {
		try {
			const released = await releaseBrowserLaneLease(
				input.custody.deps,
				browserLane.lease,
			);
			browserLaneReleasedAtEpochMs = released.released_at_epoch_ms;
		} catch {
			browserLaneReleasedAtEpochMs = undefined;
		}
	}
	if (browserLaneReleasedAtEpochMs === undefined) {
		return {
			ok: false,
			code: "browser_operation_cleanup_incomplete",
			message:
				"Screenshot capture completed, but Browser Lane release is unconfirmed.",
			primary_code: captured.ok
				? "browser_operation_completed"
				: captured.failure.code,
			cleanup_debt: ["browser-lane-release-failed"],
			...(captured.release ? { release: captured.release } : {}),
		};
	}
	return captured.ok
		? {
				ok: true,
				artifact: input.artifact,
				focus: captured.focus,
				...(captured.release ? { release: captured.release } : {}),
			}
		: {
				ok: false,
				code: captured.failure.code,
				message: captured.failure.message,
				...(captured.release ? { release: captured.release } : {}),
			};
}

type ViewportEmulation = {
	width: number;
	height: number;
	device_scale_factor: number;
	mobile: boolean;
	touch: boolean;
	landscape: boolean;
	viewport_arg: string;
};

type OperationInputs = {
	operation: BrowserOperationClass;
	targetPlan?: BrowserUseTargetOperationPlan;
	targetPlanDigest?: string;
	screenshot?: ScreenshotArtifact;
	viewport?: ViewportEmulation;
};

type OperationBindingContext = {
	handoff: HandoffFacts;
};

type OperationTargetContext = {
	targetEnvelopeId: string;
	targetEntries: OperationTargetEntry[];
};

type ResolvedOperationTarget = {
	candidate: BrowserTargetCandidate;
	source: "hints" | "selected_state" | "single_candidate";
	adapterPageRef: string;
	canonicalTargetId?: string;
	rawUrl: string;
	createdOwnership?: {
		targetRef: string;
		expiresAtMs: number;
		retainedLifecycleRef?: string;
	};
};

export async function runOperate(input: {
	parsed: Extract<ParsedBrowserUseCommand, { kind: "command" }>;
	runtime: BrowserUseRuntime;
	stdout: CliWriter;
	stderr: CliWriter;
	runId: string;
	runIdExplicit: boolean;
	diagnosticVerbose: boolean;
	durationMs: () => number;
	resolveTargetIdentity: BrowserOperationTargetIdentityResolver;
}): Promise<number> {
	const { parsed, runtime } = input;
	const flags = parsed.flagValues;
	// One run id threads the chain (R3): once the binding's handoff run id is
	// inherited below, every emitted envelope — failures after that point and
	// the success — carries it, so the top-level run_id agrees with
	// binding.run_id.
	let runId = input.runId;
	let failureReceiptContext: OperationFailureReceiptContext | undefined;
	const fail = (
		failure: OperationFailure,
		sideEffects: OperationSideEffects = {},
		release?: BrowserUseAdapterLifecycleReleaseDebt,
		targetPlan?: BrowserUseTargetOperationResult,
	) =>
		emitOperationFailure({
			failure,
			command: parsed.command,
			sideEffects,
			release,
			targetPlan,
			outputMode: parsed.outputMode,
			stdout: input.stdout,
			stderr: input.stderr,
			runId,
			durationMs: input.durationMs(),
			context: failureReceiptContext,
		});

	const operationInputs = await readOperationInputs({
		command: parsed.command,
		flags,
		env: runtime.env,
		runId: input.runId,
		runtime,
	});
	if (!operationInputs.ok) return fail(operationInputs.failure);

	const binding = await loadOperationBinding({
		runtime,
		flags,
		operation: operationInputs.inputs.operation,
		runId: input.runId,
		runIdExplicit: input.runIdExplicit,
	});
	if (!binding.ok) return fail(binding.failure);
	runId = binding.context.handoff.runId;
	const targetEnvelopeId = targetEnvelopeIdOf({
		runId,
		mode: "handoff-bound",
		adapter: binding.context.handoff.adapter,
		handoffEvidenceId: binding.context.handoff.handoffEvidenceId,
	});
	const selectedState = await loadOperationSelectedState({
		runtime,
		flags,
		env: runtime.env,
		runId,
		runIdExplicit: input.runIdExplicit,
		targetEnvelopeId,
		handoff: binding.context.handoff,
		now: runtime.now(),
	});
	if (!selectedState.ok) return fail(selectedState.failure);
	const selectedCapability = resolveExactTargetOperationCapability(
		binding.context.handoff.adapter,
	);
	if (
		operationInputs.inputs.operation === "target" &&
		(!selectedCapability.ok || selectedCapability.capability.runTargetPlan === undefined)
	) {
		return fail({
			code: "browser_operation_target_plan_unsupported",
			message: "The verified adapter does not provide the target-operation plan capability.",
			actionId: "change_operation_input",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		});
	}
	const retainedLifecycle =
		selectedState.state?.ownership?.kind === "created-target"
			? selectedState.state.ownership.retained_lifecycle
			: undefined;
	if (
		retainedLifecycle !== undefined &&
		(!selectedCapability.ok ||
			retainedLifecycle.adapter_id !== binding.context.handoff.adapter ||
			retainedLifecycle.capability_id !==
				selectedCapability.capability.capability_id)
	) {
		return fail({
			code: "target_state_mismatch",
			message:
				"The selected target retained lifecycle does not match the verified adapter capability.",
			actionId: "rerun_handoff_bound_target_discovery",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		});
	}
	if (
		retainedLifecycle !== undefined &&
		selectedCapability.ok &&
		!selectedCapability.capability.retainedLifecycleIsValid(
			retainedLifecycle.lifecycle_ref,
			runId,
		)
	) {
		return fail({
			code: "target_state_unreadable",
			message:
				"The selected target retained lifecycle cannot be read as this run's exact adapter lifecycle.",
			actionId: "repair_target_state",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "repair_state",
		});
	}
	const retainsExactTargetLifecycle =
		selectedState.state?.ownership?.kind === "created-target" &&
		selectedCapability.ok &&
		selectedCapability.capability.retainedLifecycleIsValid(
			retainedLifecycle?.lifecycle_ref,
			runId,
		);
	if (
		operationInputs.inputs.operation === "target" &&
		(!retainsExactTargetLifecycle || !selectedCapability.ok || selectedCapability.capability.runTargetPlan === undefined)
	) {
		return fail({
			code: "browser_operation_target_plan_unsupported",
			message: "Target-local plans require a retained exact-target adapter lifecycle.",
			actionId: "change_operation_input",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		});
	}

	const targetContext = await loadOperationTargetContext(runtime, binding.context, {
		targetEnvelopeId,
		retainLifecycle: retainsExactTargetLifecycle,
	});
	if (!targetContext.ok) return fail(targetContext.failure);

	const target = await resolveOperationTargetEntry({
		runtime,
		flags,
		runId,
		runIdExplicit: input.runIdExplicit,
		targetEnvelopeId: targetContext.context.targetEnvelopeId,
		targetEntries: targetContext.context.targetEntries,
		handoff: binding.context.handoff,
		selectedState,
	});
	if (!target.ok) return fail(target.failure);

	const artifactDirectory = operationInputs.inputs.screenshot
		? await ensureScreenshotArtifactDirectory(
				runtime,
				operationInputs.inputs.screenshot,
			)
		: undefined;
	if (artifactDirectory && !artifactDirectory.ok) return fail(artifactDirectory.failure);

	const bringToFront = flags["--bring-to-front"] !== undefined;
	const targetUrl = new URL(target.target.rawUrl);
	const targetIdentity =
		target.target.canonicalTargetId === undefined
			? await input.resolveTargetIdentity({
					handoff: binding.context.handoff,
					expectedUrl: target.target.rawUrl,
					allowedOrigins: [targetUrl.origin],
				})
			: {
					ok: true as const,
					target: {
						target_id: target.target.canonicalTargetId,
						top_level_url: target.target.rawUrl,
						top_level_origin: targetUrl.origin,
					},
				};
	if (!targetIdentity.ok) {
		return fail(operationTargetProofFailure(targetIdentity.cause));
	}
	failureReceiptContext = {
		operation: operationInputs.inputs.operation,
		adapter: binding.context.handoff.adapter,
		handoff: binding.context.handoff,
		target: target.target.candidate,
		canonicalTargetId: targetIdentity.target.target_id,
		targetSource: target.target.source,
		...(selectedCapability.ok
			? { capabilityId: selectedCapability.capability.capability_id }
			: {}),
		...(operationInputs.inputs.targetPlanDigest === undefined
			? {}
			: { planDigest: operationInputs.inputs.targetPlanDigest }),
	};
	if (
		target.target.createdOwnership !== undefined &&
		targetRefOf(targetIdentity.target.target_id) !==
			target.target.createdOwnership.targetRef
	) {
		return fail({
			code: "target_state_mismatch",
			message:
				"The re-discovered Browser target does not match the private created-target ownership reference.",
			actionId: "refresh_target_selection",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "repair_state",
		});
	}
	const openedPaths = await openBrowserUsePaths(runtime.platformFs, runtime.env);
	if (!openedPaths.ok) return fail(operationPathFailure(openedPaths.refusal));
	const custodyDeps: RunStoreDeps = {
		fs: runtime.platformFs,
		paths: openedPaths.paths,
		clock: runtime.now,
	};
	const createdOwnershipRemainingMs =
		target.target.createdOwnership === undefined
			? undefined
			: target.target.createdOwnership.expiresAtMs - runtime.now();
	if (
		createdOwnershipRemainingMs !== undefined &&
		createdOwnershipRemainingMs < 120_000
	) {
		return fail({
			code: "target_state_stale",
			message:
				"The open-created target state lacks enough lifetime for a bounded operation and cleanup.",
			actionId: "close_created_target",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		});
	}
	const acquiredTargetLease = await acquireTargetOperationLease(custodyDeps, {
		authorityId: browserAuthorityIdOf(binding.context.handoff),
		runId,
		adapterId: binding.context.handoff.adapter,
		rawTargetId: targetIdentity.target.target_id,
		operation:
			operationInputs.inputs.operation === "emulate" ||
			(operationInputs.inputs.operation === "target" &&
				operationInputs.inputs.targetPlan !== undefined &&
				targetOperationPlanIsMutating(operationInputs.inputs.targetPlan))
				? "action"
				: "read",
		ttlMs:
			createdOwnershipRemainingMs === undefined
				? 120_000
				: createdOwnershipRemainingMs,
		ownershipEvidence: {
			kind: "explicit-adoption",
			adapter_id: binding.context.handoff.adapter,
			run_id: runId,
			raw_target_id: targetIdentity.target.target_id,
			target_envelope_id: targetContext.context.targetEnvelopeId,
			target_candidate_id: target.target.candidate.candidate_id,
			target_candidate_identity: {
				kind: "adapter-page-id",
				raw_adapter_page_id: target.target.adapterPageRef,
			},
		},
	});
	if (!acquiredTargetLease.ok) return fail(operationCustodyFailure(acquiredTargetLease));
	let targetLease: Extract<TargetOperationLeaseResult, { ok: true }> = acquiredTargetLease;
	const executionPlan = operationExecutionPlan({
		adapter: binding.context.handoff.adapter,
		operation: operationInputs.inputs.operation,
		retainedLifecycleRef:
			target.target.createdOwnership?.retainedLifecycleRef,
		runId,
		plan: operationInputs.inputs.targetPlan,
	});
	let browserLane: BrowserLaneLease | undefined;
	const browserMutation =
		executionPlan.scope === "browser-wide"
			? executionPlan.mutation
			: undefined;
	if (browserMutation !== undefined) {
		const acquiredLane = await acquireBrowserLaneLease(custodyDeps, {
			authorityId: browserAuthorityIdOf(binding.context.handoff),
			runId,
			mutation: browserMutation,
			ttlMs: 120_000,
		});
		if (!acquiredLane.ok) {
			const primary = operationCustodyFailure(acquiredLane);
			const released = await releaseOperationResources({
				deps: custodyDeps,
				targetLease,
			});
			return released.cleanupDebt.length === 0
				? fail(primary)
				: fail(
						operationCleanupFailure({
							primaryCause: primary.code,
							operationEffect: "not_started",
							cleanupDebt: released.cleanupDebt,
						}),
					);
		}
		browserLane = acquiredLane.lease;
	}
	let operationCall: Awaited<ReturnType<typeof runOperationLane>>;
	let cleanupDebt: readonly OperationCleanupDebt[] = [];
	let targetLeaseInterval: TargetOperationLeaseInterval | undefined;
	let browserLaneInterval: BrowserLaneLeaseInterval | undefined;
	try {
		try {
			operationCall = await runOperationLane({
				runtime,
				handoff: binding.context.handoff,
				adapterPageRef: selectedCapability.ok
					? (target.target.canonicalTargetId ?? target.target.adapterPageRef)
					: target.target.adapterPageRef,
				operation: operationInputs.inputs.operation,
				screenshot: operationInputs.inputs.screenshot,
				viewport: operationInputs.inputs.viewport,
				verbose: input.diagnosticVerbose,
				bringToFront,
				expectedUrl: target.target.rawUrl,
				lifecyclePrepared: executionPlan.scope === "target-local",
				retainLifecycle: retainsExactTargetLifecycle,
				targetPlan: executionPlan.scope === "target-local" ? executionPlan.plan : undefined,
				planDigest: operationInputs.inputs.targetPlanDigest,
				lifecycleRef: retainedLifecycle?.lifecycle_ref,
				boundOrigin: target.target.candidate.origin,
				assertCustody:
					operationInputs.inputs.operation === "target"
						? async () => {
							const renewed = await heartbeatTargetOperationLease(
								custodyDeps,
								targetLease.lease,
								{ ttlMs: 120_000 },
							);
							if (!renewed.ok) return { ok: false, message: renewed.message };
							targetLease = { ...targetLease, lease: renewed.lease };
							return { ok: true };
						}
						: undefined,
			});
		} catch {
			operationCall = {
				ok: false,
				failure: operationTransportExitedFailure(
					"The adapter Browser Operation failed unexpectedly.",
				),
				focus: false,
			};
		}
	} finally {
		const released = await releaseOperationResources({
			deps: custodyDeps,
			targetLease,
			browserLane,
		});
		cleanupDebt = released.cleanupDebt;
		if (released.targetLeaseReleasedAtEpochMs !== undefined) {
			targetLeaseInterval = {
				acquiredAtEpochMs: targetLease.lease.lease.acquired_at_epoch_ms,
				releasedAtEpochMs: released.targetLeaseReleasedAtEpochMs,
			};
		}
		if (
			browserLane !== undefined &&
			released.browserLaneReleasedAtEpochMs !== undefined
		) {
			browserLaneInterval = {
				acquiredAtEpochMs: browserLane.lease.acquired_at_epoch_ms,
				releasedAtEpochMs: released.browserLaneReleasedAtEpochMs,
			};
		}
	}
	const focusSideEffect = operationCall.focus || bringToFront;
	if (!operationCall.ok) {
		if (cleanupDebt.length > 0) {
			return fail(
				operationCleanupFailure({
					primaryCause: operationCall.failure.code,
					operationEffect: "unknown",
					cleanupDebt,
				}),
				{ focus: focusSideEffect },
				operationCall.release,
				operationCall.targetPlan,
			);
		}
		return fail(
			operationCall.failure,
			{ focus: focusSideEffect },
			operationCall.release,
			operationCall.targetPlan,
		);
	}
	if (operationCall.result.exitCode !== 0) {
		const primary = operationTransportExitedFailure(
			"The adapter Browser Operation call failed.",
		);
		if (cleanupDebt.length > 0) {
			return fail(
				operationCleanupFailure({
					primaryCause: primary.code,
					operationEffect: "unknown",
					cleanupDebt,
				}),
				{ focus: focusSideEffect },
				operationCall.release,
				operationCall.targetPlan,
			);
		}
		return fail(
			primary,
			{ focus: focusSideEffect },
			operationCall.release,
			operationCall.targetPlan,
		);
	}
	if (cleanupDebt.length > 0) {
		return fail(
			operationCleanupFailure({
				primaryCause: "browser_operation_completed",
				operationEffect: "confirmed",
				cleanupDebt,
			}),
			{ focus: focusSideEffect },
			operationCall.release,
			operationCall.targetPlan,
		);
	}
	let screenshotEvidence: ScreenshotArtifactEvidence | undefined;
	if (operationInputs.inputs.screenshot !== undefined) {
		const screenshotStat = await runtime.platformFs.lstat(
			operationInputs.inputs.screenshot.path,
		);
		if (screenshotStat?.kind !== "file" || screenshotStat.size < 0) {
			return fail(
				operationTransportExitedFailure(
					"The screenshot artifact was not confirmed as one exact file.",
				),
				{ focus: focusSideEffect },
				operationCall.release,
			);
		}
		screenshotEvidence = {
			...operationInputs.inputs.screenshot,
			byteCount: screenshotStat.size,
			contentSha256: await runtime.platformFs.hashFile(
				operationInputs.inputs.screenshot.path,
			),
			mediaType: "image/png",
		};
	}

	return emitOperationSuccess({
		command: parsed.command,
		operation: operationInputs.inputs.operation,
		adapter: binding.context.handoff.adapter,
		handoff: binding.context.handoff,
		target: target.target.candidate,
		canonicalTargetId: targetIdentity.target.target_id,
		targetSource: target.target.source,
		outputMode: parsed.outputMode,
		stdout: input.stdout,
		runId,
		durationMs: input.durationMs(),
		transportResult: operationCall.result,
		release: operationCall.release,
		...(screenshotEvidence
			? { screenshot: screenshotEvidence }
			: {}),
		...(operationInputs.inputs.viewport
			? { viewport: operationInputs.inputs.viewport }
			: {}),
		focusSideEffect,
		execution: {
				scope: executionPlan.scope,
				focus: operationCall.focus,
				...(selectedCapability.ok &&
					(executionPlan.scope === "target-local" &&
						(operationInputs.inputs.operation === "snapshot" ||
							operationInputs.inputs.operation === "target"))
					? {
							capability_id: selectedCapability.capability.capability_id,
						}
					: {}),
				...(operationCall.targetPlan
					? {
							plan_digest: operationCall.targetPlan.plan_digest,
							steps: operationCall.targetPlan.steps,
							cleanup: operationCall.targetPlan.cleanup,
						}
					: {}),
		},
		targetPlan: operationCall.targetPlan,
		targetLeaseInterval,
		browserLaneInterval,
	});
}

async function readOperationInputs(input: {
	command: BrowserUseCommand;
	flags: Record<string, string>;
	env: Record<string, string | undefined>;
	runId: string;
	runtime: BrowserUseRuntime;
}): Promise<
	| { ok: true; inputs: OperationInputs }
	| { ok: false; failure: OperationFailure }
> {
	const operation = operationClassForCommand(input.command);
	let targetPlan: BrowserUseTargetOperationPlan | undefined;
	let targetPlanDigest: string | undefined;
	if (input.command === "operate-target") {
		const planPath = stringField(input.flags["--plan"]);
		if (!planPath || !isAbsolute(planPath) || planPath.includes("\0")) {
			return {
				ok: false,
				failure: {
					code: "browser_operation_target_plan_invalid",
					message: "operate target requires --plan <path>.",
					actionId: "change_operation_input",
					exitCode: USAGE_EXIT_CODE,
					recoverability: "change_input",
				},
			};
		}
		try {
			const planStat = await input.runtime.platformFs.lstat(planPath);
			if (planStat?.kind !== "file" || (planStat.mode & 0o077) !== 0) {
				throw new Error("target operation plan is not a private regular file");
			}
			const raw = await input.runtime.readTextFile(planPath);
			targetPlan = parseBrowserUseTargetOperationPlan(JSON.parse(raw));
			targetPlanDigest = targetOperationPlanDigest(targetPlan);
		} catch {
			return {
				ok: false,
				failure: {
					code: "browser_operation_target_plan_invalid",
					message: "The target-operation plan is not one valid private structured plan.",
					actionId: "change_operation_input",
					exitCode: USAGE_EXIT_CODE,
					recoverability: "change_input",
				},
			};
		}
	}
	const screenshot = input.command === "operate-screenshot"
		? readScreenshotArtifact(input.flags, input.env, input.runId)
		: undefined;
	if (screenshot && !screenshot.ok) return { ok: false, failure: screenshot.failure };

	const viewport = input.command === "operate-emulate"
		? readViewportEmulation(input.flags)
		: undefined;
	if (viewport && !viewport.ok) return { ok: false, failure: viewport.failure };

	return {
		ok: true,
		inputs: {
			operation,
			...(targetPlan === undefined ? {} : { targetPlan }),
			...(targetPlanDigest === undefined ? {} : { targetPlanDigest }),
			...(screenshot?.ok ? { screenshot: screenshot.artifact } : {}),
			...(viewport?.ok ? { viewport: viewport.viewport } : {}),
		},
	};
}

async function loadOperationBinding(input: {
	runtime: BrowserUseRuntime;
	flags: Record<string, string>;
	operation: BrowserOperationClass;
	runId: string;
	runIdExplicit: boolean;
}): Promise<
	| { ok: true; context: OperationBindingContext }
	| { ok: false; failure: OperationFailure }
> {
	const handoffPath = stringField(input.flags["--handoff"]);
	if (!handoffPath) {
		return {
			ok: false,
			failure: operationHandoffInvalidFailure("operate requires --handoff <path>"),
		};
	}

	const parse = await readHandoffFacts(input.runtime, handoffPath);
	if (!parse.ok) {
		return {
			ok: false,
			failure: operationHandoffInvalidFailure(parse.failure.message),
		};
	}
	if (parse.kind === "failed") {
		return {
			ok: false,
			failure: operationHandoffInvalidFailure(
				"the supplied envelope is a browser-connect failure envelope; it authorizes no attachment",
			),
		};
	}
	const handoff = parse.facts;

	// One run id threads the chain (R3): an explicitly asserted run id must be
	// the envelope's run id.
	if (input.runIdExplicit && input.runId !== handoff.runId) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_run_mismatch",
				message:
					"The asserted --run-id does not match the handoff envelope's run id.",
				actionId: "supply_verified_handoff",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}

	// Capability authorization (R5): the envelope authorizes an attachment; the
	// capability set for that adapter is browser-use policy, enforced through
	// the live capability-policy module.
	if (
		!authorizesOperationClass(
			{ authorized_capabilities: [...handoff.authorizedCapabilities] },
			input.operation,
		)
	) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_capability_unauthorized",
				message:
					"The verified handoff's adapter does not authorize the requested Browser Operation capability.",
				actionId: "change_operation_input",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}

	return { ok: true, context: { handoff } };
}

async function loadOperationTargetContext(
	runtime: BrowserUseRuntime,
	binding: OperationBindingContext,
	input: {
		targetEnvelopeId: string;
		retainLifecycle: boolean;
	},
): Promise<
	| { ok: true; context: OperationTargetContext }
	| { ok: false; failure: OperationFailure }
> {
	const discovery = await discoverPages(runtime, binding.handoff, {
		retainLifecycle: input.retainLifecycle,
	});
	if (!discovery.ok) {
		return { ok: false, failure: operationFailureFromDiscovery(discovery.failure) };
	}
	if (discovery.release !== undefined) {
		return {
			ok: false,
			failure: operationTransportExitedFailure(
				"The adapter discovery lifecycle could not be released; operation custody was not admitted.",
			),
		};
	}

	const targetEntries = operationTargetEntries(
		discovery.pages,
		input.targetEnvelopeId,
	);
	if (targetEntries.length === 0) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_target_missing",
				message:
					"No operation-ready Browser Target Candidates were discovered through the attached adapter.",
				actionId: "rerun_handoff_bound_target_discovery",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "retry",
			},
		};
	}

	return {
		ok: true,
		context: { targetEnvelopeId: input.targetEnvelopeId, targetEntries },
	};
}

async function resolveOperationTargetEntry(input: {
	runtime: BrowserUseRuntime;
	flags: Record<string, string>;
	runId: string;
	runIdExplicit: boolean;
	targetEnvelopeId: string;
	targetEntries: OperationTargetEntry[];
	handoff: HandoffFacts;
	selectedState: Extract<OperationStateLoad, { ok: true }>;
}): Promise<
	| { ok: true; target: ResolvedOperationTarget }
	| { ok: false; failure: OperationFailure }
> {
	const selectedState = input.selectedState;

	const hints = readOperationHints(input.flags);
	if (selectedState.state?.ownership?.kind === "created-target") {
		const canonicalIds = input.targetEntries.map(
			(entry) => entry.canonicalTargetId,
		);
		const validCanonicalIds = canonicalIds.filter(
			(value): value is string =>
				typeof value === "string" && value.length > 0 && value.length <= 512,
		);
		if (
			validCanonicalIds.length !== canonicalIds.length ||
			new Set(validCanonicalIds).size !== validCanonicalIds.length
		) {
			return {
				ok: false,
				failure: {
					code: "target_state_mismatch",
					message:
						"Fresh target inventory contains malformed or duplicate canonical identities.",
					actionId: "close_created_target",
					exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
					recoverability: "repair_state",
				},
			};
		}
		const ownedEntries = input.targetEntries.filter(
			(entry) =>
				entry.canonicalTargetId !== undefined &&
				targetRefOf(entry.canonicalTargetId) ===
					selectedState.state?.ownership?.target_ref,
		);
		if (
			ownedEntries.length !== 1 ||
			ownedEntries[0]?.adapterPageRef === undefined
		) {
			return {
				ok: false,
				failure: {
					code: "target_state_mismatch",
					message:
						"Fresh discovery did not resolve exactly one target matching the private created-target ownership reference.",
					actionId: "close_created_target",
					exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
					recoverability: "repair_state",
				},
			};
		}
		const owned = ownedEntries[0];
		if (
			parseUrlSafe(owned.rawUrl)?.origin !== selectedState.state.display.origin
		) {
			return {
				ok: false,
				failure: {
					code: "target_state_mismatch",
					message:
						"The exact open-created target navigated away from its approved origin.",
					actionId: "close_created_target",
					exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
					recoverability: "change_input",
				},
			};
		}
		if (
			hasOperationHints(hints) &&
			!candidateMatchesHints(owned.candidate, hints)
		) {
			return {
				ok: false,
				failure: operationFailureFromResolution({ kind: "no_match" }, true),
			};
		}
		return {
			ok: true,
			target: {
				candidate: owned.candidate,
				source: "selected_state",
				adapterPageRef: owned.adapterPageRef!,
				canonicalTargetId: owned.canonicalTargetId,
				rawUrl: owned.rawUrl,
				createdOwnership: {
					targetRef: selectedState.state.ownership.target_ref,
					expiresAtMs: selectedState.state.expires_at_ms,
					...(selectedState.state.ownership.retained_lifecycle === undefined
						? {}
						: {
								retainedLifecycleRef:
									selectedState.state.ownership.retained_lifecycle
										.lifecycle_ref,
							}),
				},
			},
		};
	}
	const resolution = resolveOperationTarget({
		hints,
		candidates: input.targetEntries.map((entry) => entry.candidate),
		...(selectedState.state
			? {
					selectedState: {
						target_candidate_id: selectedState.state.target_candidate_id,
						selected_candidate_ordinal:
							selectedState.state.selected_candidate_ordinal,
					},
				}
			: {}),
		handoffBoundFreshBinding: true,
	});
	if (resolution.kind !== "resolved") {
		return {
			ok: false,
			failure: operationFailureFromResolution(resolution, hasOperationHints(hints)),
		};
	}

	const targetEntry = input.targetEntries.find(
		(entry) => entry.candidate.candidate_id === resolution.candidate.candidate_id,
	);
	if (!targetEntry || targetEntry.adapterPageRef === undefined) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_target_missing",
				message:
					"The resolved Browser Target no longer carries an adapter page handle; re-run handoff-bound target discovery.",
				actionId: "rerun_handoff_bound_target_discovery",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "retry",
			},
		};
	}

	return {
		ok: true,
			target: {
				candidate: resolution.candidate,
				source: resolution.source,
				adapterPageRef: targetEntry.adapterPageRef,
				canonicalTargetId: targetEntry.canonicalTargetId,
				rawUrl: targetEntry.rawUrl,
			},
	};
}

// Explicit focus request (--bring-to-front): a select_page call with
// bringToFront through the envelope-derived transport, BEFORE the operation.
// The call's selection side effect is irrelevant (process-local, fresh spawn);
// bringToFront's window-focus side effect is the contract meaning kept.
async function focusOperationPage(input: {
	runtime: BrowserUseRuntime;
	handoff: HandoffFacts;
	pageId: number;
}): Promise<{ ok: true } | { ok: false; failure: OperationFailure }> {
	const selectPage = await runEnvelopeAdapterCall(input.runtime, {
		probeExecutable: input.handoff.probeExecutable,
		endpointHttp: input.handoff.endpointHttp,
		tool: "select_page",
		argsJson: JSON.stringify({ pageId: input.pageId, bringToFront: true }),
	});
	if (!selectPage.ok) {
		return { ok: false, failure: operationFailureFromTransport(selectPage.failure) };
	}
	if (selectPage.result.exitCode !== 0) {
		return {
			ok: false,
			failure: operationTransportExitedFailure("The adapter select_page call failed."),
		};
	}
	return { ok: true };
}

function operationClassForCommand(command: BrowserUseCommand): BrowserOperationClass {
	if (command === "operate-snapshot") return "snapshot";
	if (command === "operate-screenshot") return "screenshot";
	if (command === "operate-emulate") return "emulate";
	if (command === "operate-target") return "target";
	throw new Error(`Unsupported Browser Operation command: ${command}`);
}

function readOperationHints(flags: Record<string, string>): OperationTargetHints {
	return {
		...(stringField(flags["--origin"]) ? { origin: flags["--origin"] } : {}),
		...(stringField(flags["--url-contains"])
			? { urlContains: flags["--url-contains"] }
			: {}),
		...(stringField(flags["--title-contains"])
			? { titleContains: flags["--title-contains"] }
			: {}),
	};
}

function hasOperationHints(hints: OperationTargetHints): boolean {
	return (
		hints.origin !== undefined ||
		hints.urlContains !== undefined ||
		hints.titleContains !== undefined
	);
}

function operationTargetEntries(
	pages: readonly RawPage[],
	targetEnvelopeId: string,
): OperationTargetEntry[] {
	return navigableRawPages(pages)
		.map((page, index) => ({
			candidate: toCandidate(page, index, targetEnvelopeId, true),
			adapterPageRef: page.id === "" ? undefined : page.id,
			canonicalTargetId: page.cdp_target_id,
			rawUrl: page.url as string,
		}));
}

function operationTargetProofFailure(
	cause: BrowserUseTargetProofRefusalCause,
): OperationFailure {
	return {
		code: cause,
		message:
			cause === "origin-mismatch"
				? "The resolved CDP target is no longer on the selected allowed origin."
				: "The selected adapter page could not be resolved to exactly one canonical CDP target.",
		actionId: "inspect_operation_diagnostics",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: "retry",
	};
}

function operationPathFailure(refusal: BrowserUsePathRefusal): OperationFailure {
	return {
		code: refusal.code,
		message: refusal.message,
		actionId: "inspect_operation_diagnostics",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: "repair_state",
	};
}

function operationCustodyFailure(input: {
	code: BrowserCustodyRefusalCode;
	message: string;
}): OperationFailure {
	return {
		code: input.code,
		message: input.message,
		actionId: "inspect_operation_diagnostics",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability:
			input.code === "target_lease_held" || input.code === "browser_lane_held"
				? "retry"
				: "repair_state",
	};
}

function operationCleanupFailure(input: {
	primaryCause: string;
	operationEffect: "confirmed" | "not_started" | "unknown";
	cleanupDebt: readonly OperationCleanupDebt[];
}): OperationFailure {
	return {
		code: "browser_operation_cleanup_incomplete",
		message:
			"The Browser Operation reached a primary outcome, but one or more custody releases remain unresolved.",
		actionId: "inspect_operation_diagnostics",
		exitCode: RUNTIME_FAILURE_EXIT_CODE,
		recoverability: "none",
		primaryCause: input.primaryCause,
		operationEffect: input.operationEffect,
		cleanupDebt: input.cleanupDebt,
	};
}

async function releaseOperationResources(input: {
	deps: RunStoreDeps;
	targetLease: Extract<TargetOperationLeaseResult, { ok: true }>;
	browserLane?: BrowserLaneLease;
}): Promise<{
	cleanupDebt: readonly OperationCleanupDebt[];
	targetLeaseReleasedAtEpochMs?: number;
	browserLaneReleasedAtEpochMs?: number;
}> {
	const cleanupDebt: OperationCleanupDebt[] = [];
	const targetRelease = await releaseOperationTargetCustody(
		input.deps,
		input.targetLease,
	);
	cleanupDebt.push(...targetRelease.cleanupDebt);
	let browserLaneReleasedAtEpochMs: number | undefined;
	if (input.browserLane !== undefined) {
		try {
			const released = await releaseBrowserLaneLease(
				input.deps,
				input.browserLane,
			);
			browserLaneReleasedAtEpochMs = released.released_at_epoch_ms;
			if (browserLaneReleasedAtEpochMs === undefined) {
				cleanupDebt.push("browser-lane-release-failed");
			}
		} catch {
			cleanupDebt.push("browser-lane-release-failed");
		}
	}
	return {
		cleanupDebt,
		...(targetRelease.releasedAtEpochMs === undefined
			? {}
			: { targetLeaseReleasedAtEpochMs: targetRelease.releasedAtEpochMs }),
		...(browserLaneReleasedAtEpochMs === undefined
			? {}
			: { browserLaneReleasedAtEpochMs }),
	};
}

async function releaseOperationTargetCustody(
	deps: RunStoreDeps,
	acquired: Extract<TargetOperationLeaseResult, { ok: true }>,
): Promise<{
	cleanupDebt: readonly OperationCleanupDebt[];
	releasedAtEpochMs?: number;
}> {
	const cleanupDebt: OperationCleanupDebt[] = [];
	let releasedAtEpochMs: number | undefined;
	try {
		const released = await releaseTargetOperationLease(deps, acquired.lease);
		releasedAtEpochMs = released.released_at_epoch_ms;
		if (releasedAtEpochMs === undefined) {
			cleanupDebt.push("target-operation-lease-release-failed");
		}
	} catch {
		cleanupDebt.push("target-operation-lease-release-failed");
	}
	if (!acquired.first_ownership) {
		return { cleanupDebt, releasedAtEpochMs };
	}
	try {
		const ownership = await releaseExactTargetOwnershipByRef(deps, {
			authorityId: acquired.lease.authority_id,
			runId: acquired.lease.run_id,
			targetRef: acquired.lease.target_ref,
		});
		if (!ownership.ok || ownership.released !== true) {
			cleanupDebt.push("target-ownership-release-failed");
		}
	} catch {
		cleanupDebt.push("target-ownership-release-failed");
	}
	return { cleanupDebt, releasedAtEpochMs };
}

type OperationStateLoad =
	| { ok: true; state?: SelectedTargetState }
	| { ok: false; failure: OperationFailure };

async function loadOperationSelectedState(input: {
	runtime: BrowserUseRuntime;
	flags: Record<string, string>;
	env: Record<string, string | undefined>;
	runId: string;
	runIdExplicit: boolean;
	targetEnvelopeId: string;
	handoff: HandoffFacts;
	now: number;
}): Promise<OperationStateLoad> {
	const hasStateSource =
		stringField(input.flags["--state"]) !== undefined ||
		stringField(input.env.BROWSER_USE_TARGET_STATE_DIR) !== undefined;
	let statePath: string;
	if (hasStateSource) {
		const resolved = resolveStatePath(
			input.flags,
			input.env,
			input.runId,
			input.runIdExplicit,
		);
		if (!resolved.ok) {
			return {
				ok: false,
				failure: operationFailureFromSelection(resolved.failure),
			};
		}
		statePath = resolved.path;
	} else {
		const inspected = await inspectBrowserUsePaths(
			input.runtime.platformFs,
			input.env,
		);
		if (!inspected.ok) {
			return { ok: false, failure: operationPathFailure(inspected.refusal) };
		}
		statePath = canonicalRunSelectedStatePath(
			inspected.paths.resolution.roots.state,
			input.handoff.runId,
		);
		try {
			if ((await input.runtime.platformFs.lstat(statePath)) === undefined) {
				return { ok: true };
			}
		} catch {
			return {
				ok: false,
				failure: {
					code: "target_state_unreadable",
					message:
						"The canonical run-scoped selected-target state could not be inspected.",
					actionId: "refresh_target_selection",
					exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
					recoverability: "repair_state",
				},
			};
		}
	}
	const load = await loadSelectedState(input.runtime, statePath, {
		now: input.now,
		expectedRunId: input.handoff.runId,
	});
	if (!load.ok) {
		return { ok: false, failure: operationFailureFromSelection(load.failure) };
	}
	const state = load.state;
	if (
		state.selected_adapter_id !== input.handoff.adapter ||
		state.verified_endpoint_identity !== input.handoff.verifiedEndpointIdentity ||
		state.handoff_evidence_id !== input.handoff.handoffEvidenceId ||
		state.target_envelope_id !== input.targetEnvelopeId
	) {
		return {
			ok: false,
			failure: {
				code: "target_state_mismatch",
				message:
					"The selected-target state does not match the supplied Verified Handoff Envelope binding.",
				actionId: "refresh_target_selection",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}
	return { ok: true, state };
}

function readScreenshotArtifact(
	flags: Record<string, string>,
	env: Record<string, string | undefined>,
	runId: string,
):
	| { ok: true; artifact: ScreenshotArtifact }
	| { ok: false; failure: OperationFailure } {
	const raw = stringField(flags["--out"]);
	if (!raw) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_artifact_path_required",
				message: "operate screenshot requires --out <path>.",
				actionId: "change_operation_input",
				exitCode: USAGE_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}
	const root = screenshotArtifactRoot(env, runId);
	if (!root.ok) return { ok: false, failure: root.failure };
	const normalized = normalize(raw);
	const segments = normalized.split(/[\\/]+/);
	if (
		raw.includes("\0") ||
		isAbsolute(raw) ||
		normalized === "." ||
		normalized.startsWith("..") ||
		segments.includes("..")
	) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_artifact_path_unsafe",
				message:
					"operate screenshot --out must be a relative path inside the run-scoped artifact root.",
				actionId: "change_operation_input",
				exitCode: USAGE_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}
	const resolvedRoot = resolve(root.root);
	const artifactPath = resolve(resolvedRoot, normalized);
	const relativeToRoot = relative(resolvedRoot, artifactPath);
	if (
		relativeToRoot === "" ||
		relativeToRoot.startsWith("..") ||
		isAbsolute(relativeToRoot)
	) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_artifact_path_unsafe",
				message:
					"operate screenshot --out must resolve inside the run-scoped artifact root.",
				actionId: "change_operation_input",
				exitCode: USAGE_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}
	return {
		ok: true,
		artifact: {
			path: artifactPath,
			relativePath: normalized,
			root: resolvedRoot,
			format: "png",
			fullPage: flags["--full-page"] !== undefined,
		},
	};
}

function screenshotArtifactRoot(
	env: Record<string, string | undefined>,
	runId: string,
): { ok: true; root: string } | { ok: false; failure: OperationFailure } {
	const explicit = stringField(env.BROWSER_USE_ARTIFACT_ROOT);
	if (explicit) {
		if (explicit.includes("\0") || !isAbsolute(explicit)) {
			return {
				ok: false,
				failure: {
					code: "browser_operation_artifact_path_unsafe",
					message:
						"BROWSER_USE_ARTIFACT_ROOT must be an absolute run-scoped artifact root.",
					actionId: "change_operation_input",
					exitCode: USAGE_EXIT_CODE,
					recoverability: "change_input",
				},
			};
		}
		return { ok: true, root: explicit };
	}
	return {
		ok: true,
		root: join(tmpdir(), "browser-use-artifacts", runScopedKey(runId)),
	};
}

async function ensureScreenshotArtifactDirectory(
	runtime: BrowserUseRuntime,
	artifact: ScreenshotArtifact,
): Promise<{ ok: true } | { ok: false; failure: OperationFailure }> {
	try {
		await runtime.ensureDirectory(dirname(artifact.path));
		return { ok: true };
	} catch {
		return {
			ok: false,
			failure: {
				code: "browser_operation_artifact_root_unwritable",
				message:
					"Could not create the screenshot artifact directory under the run-scoped artifact root.",
				actionId: "change_operation_input",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability: "repair_state",
			},
		};
	}
}

function readViewportEmulation(
	flags: Record<string, string>,
):
	| { ok: true; viewport: ViewportEmulation }
	| { ok: false; failure: OperationFailure } {
	const width = positiveIntFlag(flags["--width"]);
	const height = positiveIntFlag(flags["--height"]);
	const dpr = positiveNumberFlag(flags["--dpr"] ?? "1");
	if (!width || !height || !dpr) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_viewport_invalid",
				message:
					"operate emulate requires positive --width, --height, and optional positive --dpr values.",
				actionId: "change_operation_input",
				exitCode: USAGE_EXIT_CODE,
				recoverability: "change_input",
			},
		};
	}
	const mobile = flags["--mobile"] !== undefined;
	const touch = flags["--touch"] !== undefined;
	const landscape = flags["--landscape"] !== undefined;
	const modifiers = [
		mobile ? "mobile" : "",
		touch ? "touch" : "",
		landscape ? "landscape" : "",
	].filter((part) => part !== "");
	const viewportArg = `${width}x${height}x${dpr}${modifiers.length > 0 ? `,${modifiers.join(",")}` : ""}`;
	return {
		ok: true,
		viewport: {
			width,
			height,
			device_scale_factor: dpr,
			mobile,
			touch,
			landscape,
			viewport_arg: viewportArg,
		},
	};
}

function positiveIntFlag(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumberFlag(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

type OperationLaneInput = {
	runtime: BrowserUseRuntime;
	handoff: HandoffFacts;
	adapterPageRef: string;
	expectedUrl?: string;
	operation: BrowserOperationClass;
	screenshot?: ScreenshotArtifact;
	viewport?: ViewportEmulation;
	verbose: boolean;
	bringToFront: boolean;
	lifecyclePrepared?: boolean;
	retainLifecycle?: boolean;
	targetPlan?: BrowserUseTargetOperationPlan;
	planDigest?: string;
	lifecycleRef?: string;
	boundOrigin?: string;
	assertCustody?: () => Promise<{ ok: boolean; message?: string }>;
};

type OperationLaneResult =
	| {
			ok: true;
			result: McporterCommandResult;
			focus: boolean;
			targetPlan?: BrowserUseTargetOperationResult;
			release?: BrowserUseAdapterLifecycleReleaseDebt;
	  }
	| {
			ok: false;
			failure: OperationFailure;
			focus: boolean;
			release?: BrowserUseAdapterLifecycleReleaseDebt;
			targetPlan?: BrowserUseTargetOperationResult;
	  };

async function runOperationLane(
	input: OperationLaneInput,
): Promise<OperationLaneResult> {
	const resolved = resolveExactTargetOperationCapability(input.handoff.adapter);
	if (resolved.ok) {
		if (input.operation === "target") {
			if (input.targetPlan === undefined || input.planDigest === undefined || resolved.capability.runTargetPlan === undefined) {
				return {
					ok: false,
					failure: {
						code: "browser_operation_target_plan_unsupported",
						message: "The adapter target-operation capability is unavailable.",
						actionId: "change_operation_input",
						exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
						recoverability: "change_input",
					},
					focus: false,
				};
			}
			return runExactTargetPlanOperation(input, resolved.capability);
		}
		return runExactTargetOperation(input, resolved.capability);
	}
	return runChromeDevtoolsOperation(input);
}

async function runChromeDevtoolsOperation(
	input: OperationLaneInput,
): Promise<OperationLaneResult> {
	const pageId = Number(input.adapterPageRef);
	if (!Number.isInteger(pageId) || pageId < 0) {
		return {
			ok: false,
			failure: operationTransportExitedFailure(
				"The chrome-devtools-mcp page ref must be a non-negative integer.",
			),
			focus: false,
		};
	}
	return runOperationCalls(input, pageId);
}

async function runExactTargetOperation(
	input: OperationLaneInput,
	capability: BrowserUseExactTargetOperationCapability,
): Promise<OperationLaneResult> {
	const outcome = await capability.run({
		runtime: input.runtime,
		env: input.runtime.env,
		handoff: exactTargetHandoff(input.handoff),
		target_id: input.adapterPageRef,
		...(input.expectedUrl === undefined
			? {}
			: { expected_url: input.expectedUrl }),
		operation: input.operation === "screenshot" ? "screenshot" : "snapshot",
		...(input.screenshot === undefined
			? {}
			: {
					screenshot: {
						path: input.screenshot.path,
						full_page: input.screenshot.fullPage,
					},
				}),
		lifecycle_prepared: input.lifecyclePrepared === true,
		retain_lifecycle: input.retainLifecycle === true,
	});
	if (outcome.ok) return outcome;
	const failure =
		outcome.code === "dependency-missing"
			? dependencyOperationFailure(
					"browser_operation_dependency_missing",
					outcome.message,
				)
			: outcome.code === "timeout"
				? {
						code: "browser_operation_transport_timeout" as const,
						message: outcome.message,
						actionId: "inspect_operation_diagnostics" as const,
						exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
						recoverability: "retry" as const,
					}
				: operationTransportExitedFailure(outcome.message);
	return {
		ok: false,
		failure,
		focus: outcome.focus,
		...(outcome.release ? { release: outcome.release } : {}),
	};
}

async function runExactTargetPlanOperation(
	input: OperationLaneInput,
	capability: BrowserUseExactTargetOperationCapability,
): Promise<OperationLaneResult> {
	if (input.targetPlan === undefined || input.planDigest === undefined || capability.runTargetPlan === undefined) {
		return {
			ok: false,
			failure: {
				code: "browser_operation_target_plan_unsupported",
				message: "The adapter target-operation capability is unavailable.",
				actionId: "change_operation_input",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "change_input",
			},
			focus: false,
		};
	}
	if (
		input.boundOrigin === undefined ||
		!targetOperationPlanMatchesBoundOrigin(input.targetPlan, input.boundOrigin)
	) {
		const outcome: BrowserUseTargetOperationResult = {
			ok: false,
			code: "target_operation_origin_mismatch",
			message: "The target plan navigation does not match the exact bound target origin.",
			scope: "target-local",
			focus: false,
			capability_id: capability.capability_id,
			plan_digest: input.planDigest,
			steps: [],
			cleanup: { attempted: false, closed: false, visible_owned_surface_count: 0 },
		};
		return {
			ok: false,
			failure: targetPlanOperationFailure(outcome),
			focus: false,
			targetPlan: outcome,
		};
	}
	const outcome = await capability.runTargetPlan({
		runtime: input.runtime,
		env: input.runtime.env,
		handoff: exactTargetHandoff(input.handoff),
		target_id: input.adapterPageRef,
		expected_url: input.expectedUrl ?? "",
		bound_origin: input.boundOrigin,
		assert_custody: input.assertCustody,
		plan: input.targetPlan,
		plan_digest: input.planDigest,
		lifecycle_ref: input.lifecycleRef,
	});
	if (!outcome.ok) {
		return {
			ok: false,
			failure: targetPlanOperationFailure(outcome),
			focus: false,
			targetPlan: outcome,
		};
	}
	return {
		ok: true,
		result: { exitCode: 0, stdout: "", stderr: "" },
		focus: false,
		targetPlan: outcome,
	};
}

function targetPlanOperationFailure(
	outcome: Extract<BrowserUseTargetOperationResult, { ok: false }>,
): OperationFailure {
	const code = outcome.code === "target_operation_plan_failed"
		? "browser_operation_target_plan_failed"
		: outcome.code === "target_operation_origin_mismatch"
			? "browser_operation_target_origin_mismatch"
			: outcome.code === "target_operation_cleanup_incomplete"
			? "browser_operation_target_cleanup_incomplete"
				: "browser_operation_target_plan_unsupported";
	const unknownEffect = outcome.steps.some(
		(step) => step.status === "unknown" && step.effect === "possibly-effectful",
	);
	return {
		code,
		message: outcome.message,
		actionId: unknownEffect ? "repair_target_state" : "change_operation_input",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: unknownEffect ? "repair_state" : "change_input",
		...(unknownEffect ? { operationEffect: "unknown" as const } : {}),
	};
}

async function runOperationCalls(
	input: OperationLaneInput,
	pageId: number,
): Promise<OperationLaneResult> {
	if (input.bringToFront) {
		const focused = await focusOperationPage({
			runtime: input.runtime,
			handoff: input.handoff,
			pageId,
		});
		if (!focused.ok) {
			return { ok: false, failure: focused.failure, focus: false };
		}
	}
	const operationCall = await runOperationTransport(input, pageId);
	if (!operationCall.ok) {
		return {
			ok: false,
			failure: operationFailureFromTransport(operationCall.failure),
			focus: input.bringToFront,
		};
	}
	return {
		...operationCall,
		focus: input.bringToFront,
	};
}

// Run the operation tool through the envelope-derived transport. Each
// operation's args carry the lane-owned pageId: --experimentalPageIdRouting on
// the spawn routes the call to that page directly on a fresh adapter process.
async function runOperationTransport(
	input: OperationLaneInput,
	pageId: number,
): Promise<BrowserOperationTransportResult> {
	const call = (tool: string, args: Record<string, unknown>) =>
		runEnvelopeAdapterCall(input.runtime, {
			probeExecutable: input.handoff.probeExecutable,
			endpointHttp: input.handoff.endpointHttp,
			tool,
			argsJson: JSON.stringify({ pageId, ...args }),
		});
	if (input.operation === "snapshot") {
		return call("take_snapshot", input.verbose ? { verbose: true } : {});
	}
	if (input.operation === "screenshot") {
		return call("take_screenshot", {
			filePath: input.screenshot?.path,
			fullPage: input.screenshot?.fullPage ?? false,
			format: "png",
		});
	}
	return call("emulate", { viewport: input.viewport?.viewport_arg });
}

function operationHandoffInvalidFailure(detail: string): OperationFailure {
	return {
		code: "browser_operation_handoff_invalid",
		message: `The supplied Verified Handoff Envelope cannot authorize the operation: ${detail}.`,
		actionId: "supply_verified_handoff",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: "change_input",
	};
}

function operationFailureFromSelection(
	failure: SelectionFailure,
): OperationFailure {
	return {
		code: failure.code,
		message: failure.message,
		actionId: failure.actionId,
		exitCode: failure.exitCode,
		recoverability: failure.recoverability,
	};
}

function operationFailureFromDiscovery(
	failure: TargetDiscoveryFailure,
): OperationFailure {
	if (failure.code === "target_discovery_dependency_missing") {
		return dependencyOperationFailure("browser_operation_dependency_missing", failure.message);
	}
	if (failure.code === "target_discovery_command_override_invalid") {
		return dependencyOperationFailure(
			"browser_operation_command_override_invalid",
			failure.message,
		);
	}
	if (failure.code === "target_discovery_transport_timeout") {
		return {
			code: "browser_operation_transport_timeout",
			message: failure.message,
			actionId: "inspect_operation_diagnostics",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "retry",
		};
	}
	return operationTransportExitedFailure(failure.message);
}

function operationFailureFromTransport(
	failure: BrowserOperationTransportFailure,
): OperationFailure {
	if (failure.kind === "dependency_missing") {
		return dependencyOperationFailure(failure.code, failure.hintSummary);
	}
	if (failure.kind === "command_override_invalid") {
		return dependencyOperationFailure(failure.code, failure.hintSummary);
	}
	if (failure.kind === "transport_timeout") {
		return {
			code: failure.code,
			message: failure.hintSummary,
			actionId: "inspect_operation_diagnostics",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "retry",
		};
	}
	return operationTransportExitedFailure(failure.hintSummary);
}

function dependencyOperationFailure(code: string, message: string): OperationFailure {
	return {
		code,
		message,
		actionId: "configure_operation_dependency",
		exitCode: RUNTIME_FAILURE_EXIT_CODE,
		recoverability: "repair_state",
	};
}

function operationTransportExitedFailure(message: string): OperationFailure {
	return {
		code: "browser_operation_transport_failed",
		message,
		actionId: "inspect_operation_diagnostics",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: "retry",
	};
}

function operationFailureFromResolution(
	resolution: Exclude<OperationResolution, { kind: "resolved" }>,
	hasHints: boolean,
): OperationFailure {
	if (resolution.kind === "ambiguous") {
		return {
			code: "browser_operation_target_ambiguous",
			message: `Browser Operation target resolution matched ${resolution.matchCount} candidates.`,
			actionId: hasHints ? "refine_target_hint" : "choose_target_candidate",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		};
	}
	if (resolution.kind === "no_match") {
		return {
			code: "browser_operation_target_no_match",
			message:
				"No Browser Target Candidate matches the supplied operation hints.",
			actionId: "refine_target_hint",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		};
	}
	if (resolution.kind === "selection_moved") {
		return {
			code: "browser_operation_target_moved",
			message:
				"The selected Browser Target is no longer present in the current handoff-bound target set.",
			actionId: "refresh_target_selection",
			exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
			recoverability: "change_input",
		};
	}
	return {
		code: "browser_operation_target_missing",
		message:
			"No Browser Target was selected and no single handoff-bound candidate is available.",
		actionId: "choose_target_candidate",
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: "change_input",
	};
}

function operationAction(id: OperationActionId): RuntimeActionGuidance {
	return actionFor(operationActionById, id, "operation");
}

function emitOperationFailure(input: {
	failure: OperationFailure;
	command: BrowserUseCommand;
	sideEffects: OperationSideEffects;
	release?: BrowserUseAdapterLifecycleReleaseDebt;
	targetPlan?: BrowserUseTargetOperationResult;
	outputMode: OutputMode;
	stdout: CliWriter;
	stderr: CliWriter;
	runId: string;
	durationMs: number;
	context?: OperationFailureReceiptContext;
}): number {
	const { failure } = input;
	if (input.outputMode === "plain") {
		const cleanupDetail =
			failure.cleanupDebt === undefined
				? ""
				: ` primary_cause=${failure.primaryCause} operation_effect=${failure.operationEffect} cleanup_debt=${failure.cleanupDebt.join(",")}`;
		input.stderr.write(
			`browser_use ${failure.code}: ${redactUnsafeText(failure.message)} action=${failure.actionId} focus_side_effect=${input.sideEffects.focus === true}${cleanupDetail} (run_id=${input.runId})\n`,
		);
		return failure.exitCode;
	}
	writeJsonEnvelope(
		input.stdout,
		createCliRuntimeErrorEnvelope({
			run_id: input.runId,
			process_exit_code: failure.exitCode,
			data: {
				command: input.command,
				result_kind: "browser_operation",
				...(input.context === undefined
					? {}
					: operationFailureReceiptContext(input.context, input.runId)),
				side_effects: { focus: input.sideEffects.focus === true },
				...(failure.primaryCause === undefined
					? {}
					: { primary_cause: failure.primaryCause }),
				...(failure.operationEffect === undefined
					? {}
					: { operation_effect: failure.operationEffect }),
				...(failure.cleanupDebt === undefined
					? {}
					: { cleanup_debt: failure.cleanupDebt }),
				...(input.release ? { release: input.release } : {}),
				...(input.targetPlan
					? { target_plan: targetPlanReceipt(input.targetPlan) }
					: {}),
			},
			runtime_actions: [operationAction(failure.actionId)],
			continuation: { next_action_id: failure.actionId },
			error: createCliRuntimeError({
				run_id: input.runId,
				code: failure.code,
				message: redactUnsafeText(failure.message),
				exit_code: failure.exitCode,
				severity: "error",
				...retryabilityForRecoverability(failure.recoverability),
				failure_domain: "browser_use",
			}),
		}),
		{ runId: input.runId, durationMs: input.durationMs },
	);
	return failure.exitCode;
}

function operationFailureReceiptContext(
	context: OperationFailureReceiptContext,
	runId: string,
): Record<string, unknown> {
	return {
		contract: BROWSER_USE_OPERATION_CONTRACT_ID,
		schema_version: BROWSER_USE_OPERATION_SCHEMA_VERSION,
		operation: context.operation,
		adapter: context.adapter,
		binding: {
			outer_run_id: runId,
			run_id: context.handoff.runId,
			handoff_evidence_id: context.handoff.handoffEvidenceId,
			browser_authority_id: browserAuthorityIdOf(context.handoff),
			target_candidate_id: context.target.candidate_id,
		},
		target_source: context.targetSource,
		target: {
			candidate_ordinal: context.target.candidate_ordinal,
			candidate_id: context.target.candidate_id,
			target_id: context.canonicalTargetId,
			target_ref: targetRefOf(context.canonicalTargetId),
			cdp_endpoint: context.handoff.endpointHttp,
			origin: context.target.origin,
			...(context.target.path_shape ? { path_shape: context.target.path_shape } : {}),
			...(context.target.title ? { title: context.target.title } : {}),
		},
		...(context.operation !== "target"
			? {}
			: {
					execution: {
						scope: "target-local",
						focus: false,
						...(context.capabilityId === undefined
							? {}
							: { capability_id: context.capabilityId }),
						...(context.planDigest === undefined
							? {}
							: { plan_digest: context.planDigest }),
					},
				}),
	};
}

function emitOperationSuccess(input: {
	command: BrowserUseCommand;
	operation: BrowserOperationClass;
	adapter: BrowserAdapterId;
	handoff: HandoffFacts;
	target: BrowserTargetCandidate;
	// Canonical CDP target id, proven under the Target Lease this call held.
	// Published so the caller can hand the exact tab to the adapter's native
	// surface; the hashed candidate_id cannot address a tab.
	canonicalTargetId: string;
	targetSource: "hints" | "selected_state" | "single_candidate";
	outputMode: OutputMode;
	stdout: CliWriter;
	runId: string;
	durationMs: number;
	transportResult: McporterCommandResult;
	release?: BrowserUseAdapterLifecycleReleaseDebt;
	screenshot?: ScreenshotArtifactEvidence;
	viewport?: ViewportEmulation;
	focusSideEffect: boolean;
	execution: OperationExecutionEvidence;
	targetPlan?: BrowserUseTargetOperationResult;
	targetLeaseInterval?: TargetOperationLeaseInterval;
	browserLaneInterval?: BrowserLaneLeaseInterval;
}): number {
	if (input.outputMode === "plain") {
		input.stdout.write(
			[
				"browser_operation_completed",
				`operation=${input.operation}`,
				`adapter=${input.adapter}`,
				`target_source=${input.targetSource}`,
				`candidate_ordinal=${input.target.candidate_ordinal}`,
				`focus_side_effect=${input.focusSideEffect}`,
				`execution_scope=${input.execution.scope}`,
				`execution_focus=${input.execution.focus}`,
				...(input.targetLeaseInterval
					? [
							`target_lease_acquired_at_epoch_ms=${input.targetLeaseInterval.acquiredAtEpochMs}`,
							`target_lease_released_at_epoch_ms=${input.targetLeaseInterval.releasedAtEpochMs}`,
						]
					: []),
				...(input.browserLaneInterval
					? [
							`browser_lane_acquired_at_epoch_ms=${input.browserLaneInterval.acquiredAtEpochMs}`,
							`browser_lane_released_at_epoch_ms=${input.browserLaneInterval.releasedAtEpochMs}`,
						]
					: []),
				"action=inspect_operation_result",
				`run_id=${input.runId}`,
				`duration_ms=${input.durationMs}`,
			].join(" ") + "\n",
		);
		return 0;
	}
	writeJsonEnvelope(
		input.stdout,
		createCliRuntimeSuccessEnvelope({
			run_id: input.runId,
			data: {
				contract: BROWSER_USE_OPERATION_CONTRACT_ID,
				schema_version: BROWSER_USE_OPERATION_SCHEMA_VERSION,
				command: input.command,
				result_kind: "browser_operation",
				operation: input.operation,
				adapter: input.adapter,
				effect: "confirmed",
				binding: {
					outer_run_id: input.runId,
					run_id: input.handoff.runId,
					handoff_evidence_id: input.handoff.handoffEvidenceId,
					browser_authority_id: browserAuthorityIdOf(input.handoff),
					target_candidate_id: input.target.candidate_id,
				},
				target_source: input.targetSource,
				target: {
					candidate_ordinal: input.target.candidate_ordinal,
					candidate_id: input.target.candidate_id,
					// Adapter-addressable identity (schema 3). Only the http endpoint
					// form is published; the ws debugger URL stays unemitted (R32).
					target_id: input.canonicalTargetId,
					target_ref: targetRefOf(input.canonicalTargetId),
					cdp_endpoint: input.handoff.endpointHttp,
					origin: input.target.origin,
					...(input.target.path_shape
						? { path_shape: input.target.path_shape }
						: {}),
					...(input.target.title ? { title: input.target.title } : {}),
				},
				side_effects: {
					focus: input.focusSideEffect,
				},
				execution: input.execution,
				...(input.targetLeaseInterval || input.browserLaneInterval
					? {
							custody: {
								...(input.targetLeaseInterval
									? {
											target_operation_lease: {
												acquired_at_epoch_ms:
													input.targetLeaseInterval.acquiredAtEpochMs,
												released_at_epoch_ms:
													input.targetLeaseInterval.releasedAtEpochMs,
											},
										}
									: {}),
								...(input.browserLaneInterval
									? {
											browser_lane: {
												acquired_at_epoch_ms:
													input.browserLaneInterval.acquiredAtEpochMs,
												released_at_epoch_ms:
													input.browserLaneInterval.releasedAtEpochMs,
											},
										}
									: {}),
							},
						}
					: {}),
				...(input.release ? { release: input.release } : {}),
				...(sealedQualificationRuntimeEvidence() === undefined
					? {}
					: {
							qualification_runtime:
								sealedQualificationRuntimeEvidence(),
						}),
				...operationPayload(input),
			},
			runtime_actions: [operationAction("inspect_operation_result")],
			continuation: { next_action_id: "inspect_operation_result" },
		}),
		{ runId: input.runId, durationMs: input.durationMs },
	);
	return 0;
}

function operationPayload(input: {
	operation: BrowserOperationClass;
	transportResult: McporterCommandResult;
	screenshot?: ScreenshotArtifactEvidence;
	viewport?: ViewportEmulation;
	targetPlan?: BrowserUseTargetOperationResult;
}): Record<string, unknown> {
	switch (input.operation) {
		case "snapshot":
			return { snapshot: normalizeSnapshot(input.transportResult.stdout) };
		case "screenshot":
			return {
				screenshot: {
					artifact: input.screenshot
						? {
								path: input.screenshot.path,
								relative_path: input.screenshot.relativePath,
								root: input.screenshot.root,
								format: input.screenshot.format,
								full_page: input.screenshot.fullPage,
								byte_count: input.screenshot.byteCount,
								content_sha256: input.screenshot.contentSha256,
								media_type: input.screenshot.mediaType,
							}
						: undefined,
				},
			};
		case "emulate":
			return {
				emulation: {
					viewport: input.viewport
						? {
								width: input.viewport.width,
								height: input.viewport.height,
								device_scale_factor: input.viewport.device_scale_factor,
								mobile: input.viewport.mobile,
								touch: input.viewport.touch,
								landscape: input.viewport.landscape,
							}
						: undefined,
				},
			};
		case "target":
			return {
				target_plan:
					input.targetPlan === undefined
						? undefined
						: targetPlanReceipt(input.targetPlan),
			};
		default: {
			const exhaustive: never = input.operation;
			throw new Error(`Unsupported Browser Operation: ${exhaustive}`);
		}
	}
}

/** Closed public receipt projection; adapter-only result framing never crosses this seam. */
function targetPlanReceipt(
	result: BrowserUseTargetOperationResult,
): {
	steps: BrowserUseTargetOperationResult["steps"];
	cleanup: BrowserUseTargetOperationResult["cleanup"];
} {
	return { steps: result.steps, cleanup: result.cleanup };
}

function normalizeSnapshot(stdout: string): Record<string, unknown> {
	const text = extractTextContent(parseTransportOutput(stdout));
	const bounded = boundSnapshotText(text);
	return {
		text: bounded.text,
		line_count: bounded.lineCount,
		byte_count: bounded.byteCount,
		truncated: bounded.truncated,
		limits: {
			max_bytes: SNAPSHOT_MAX_BYTES,
			max_lines: SNAPSHOT_MAX_LINES,
		},
	};
}

type QualificationOperationReceipt = {
	receipt: Record<string, unknown>;
	data: Record<string, unknown>;
	binding: Record<string, unknown>;
	target: Record<string, unknown>;
	execution: Record<string, unknown>;
	custody: Record<string, unknown>;
};

function qualificationRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasExactQualificationKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

type TargetPlanReceiptProjection = {
	steps: readonly BrowserUseTargetOperationResult["steps"][number][];
	cleanup: {
		attempted: boolean;
		closed: boolean;
		method?: BrowserUseTargetOperationCleanupMethod;
		visible_owned_surface_count: number;
	};
};

function parseTargetPlanReceiptProjection(
	value: unknown,
): TargetPlanReceiptProjection | undefined {
	const targetPlan = qualificationRecord(value);
	const cleanup = qualificationRecord(targetPlan?.cleanup);
	if (
		!targetPlan ||
		!hasExactQualificationKeys(targetPlan, ["steps", "cleanup"]) ||
		!Array.isArray(targetPlan.steps) ||
		!cleanup ||
		!(
			hasExactQualificationKeys(cleanup, ["attempted", "closed", "visible_owned_surface_count"]) ||
			hasExactQualificationKeys(cleanup, ["attempted", "closed", "method", "visible_owned_surface_count"])
		) ||
		typeof cleanup.attempted !== "boolean" ||
		typeof cleanup.closed !== "boolean" ||
		(cleanup.method !== undefined &&
			!(["close-control", "escape", "backdrop"] as unknown[]).includes(cleanup.method)) ||
		!Number.isSafeInteger(cleanup.visible_owned_surface_count) ||
		(cleanup.visible_owned_surface_count as number) < 0
	) return undefined;
	const steps: BrowserUseTargetOperationResult["steps"][number][] = [];
	for (const rawStep of targetPlan.steps) {
		const step = qualificationRecord(rawStep);
		if (
			!step ||
			!Number.isSafeInteger(step.index) ||
			(step.index as number) < 0 ||
			!( ["navigate", "inspect", "review-state", "input", "overlay-cleanup"] as unknown[]).includes(step.kind)
		) return undefined;
		if (step.status === "confirmed") {
			if (
				!(hasExactQualificationKeys(step, ["index", "kind", "status"]) ||
					hasExactQualificationKeys(step, ["index", "kind", "status", "observation_digest"])) ||
				(step.observation_digest !== undefined && typeof step.observation_digest !== "string")
			) return undefined;
			steps.push({
				index: step.index as number,
				kind: step.kind as BrowserUseTargetOperationResult["steps"][number]["kind"],
				status: "confirmed",
				...(step.observation_digest === undefined ? {} : { observation_digest: step.observation_digest }),
			});
			continue;
		}
		if (
			step.status !== "unknown" ||
			!hasExactQualificationKeys(step, ["index", "kind", "status", "effect"]) ||
			step.effect !== "possibly-effectful"
		) return undefined;
		steps.push({
			index: step.index as number,
			kind: step.kind as BrowserUseTargetOperationResult["steps"][number]["kind"],
			status: "unknown",
			effect: "possibly-effectful",
		});
	}
	return {
		steps,
		cleanup: {
			attempted: cleanup.attempted,
			closed: cleanup.closed,
			...(cleanup.method === undefined
				? {}
				: { method: cleanup.method as BrowserUseTargetOperationCleanupMethod }),
			visible_owned_surface_count: cleanup.visible_owned_surface_count as number,
		},
	};
}

/** Parse the closed neutral target-plan evidence from either public receipt status. */
export function parseBrowserOperationTargetPlanReceipt(
	raw: string,
): TargetPlanReceiptProjection | undefined {
	try {
		const receipt = qualificationRecord(JSON.parse(raw));
		return parseTargetPlanReceiptProjection(qualificationRecord(receipt?.data)?.target_plan);
	} catch {
		return undefined;
	}
}

/** Parse a controlled target-plan failure only when it retains exact public
 * binding and target facts alongside the closed partial receipt projection. */
export function parseBrowserOperationTargetPlanFailureReceipt(
	raw: string,
): { binding: Record<string, unknown>; target: Record<string, unknown>; targetPlan: TargetPlanReceiptProjection } | undefined {
	try {
		const receipt = qualificationRecord(JSON.parse(raw));
		const data = qualificationRecord(receipt?.data);
		const binding = qualificationRecord(data?.binding);
		const target = qualificationRecord(data?.target);
		const targetPlan = parseTargetPlanReceiptProjection(data?.target_plan);
		if (
			receipt?.status !== "error" ||
			data?.contract !== BROWSER_USE_OPERATION_CONTRACT_ID ||
			data.schema_version !== BROWSER_USE_OPERATION_SCHEMA_VERSION ||
			data.operation !== "target" ||
			!binding ||
			typeof binding.outer_run_id !== "string" ||
			typeof binding.run_id !== "string" ||
			typeof binding.handoff_evidence_id !== "string" ||
			typeof binding.browser_authority_id !== "string" ||
			typeof binding.target_candidate_id !== "string" ||
			!target ||
			typeof target.target_id !== "string" ||
			typeof target.target_ref !== "string" ||
			typeof target.origin !== "string" ||
			!targetPlan
		) return undefined;
		return { binding, target, targetPlan };
	} catch {
		return undefined;
	}
}

/** Parse one complete public Browser Operation success receipt for qualification. */
export function parseBrowserOperationQualificationReceipt(
	raw: string,
): QualificationOperationReceipt | undefined {
	let receipt: Record<string, unknown> | undefined;
	try {
		receipt = qualificationRecord(JSON.parse(raw));
	} catch {
		return undefined;
	}
	const data = qualificationRecord(receipt?.data);
	const binding = qualificationRecord(data?.binding);
	const target = qualificationRecord(data?.target);
	const execution = qualificationRecord(data?.execution);
	const sideEffects = qualificationRecord(data?.side_effects);
	const custody = qualificationRecord(data?.custody);
	if (
		receipt?.status !== "ok" ||
		typeof receipt.run_id !== "string" ||
		!Number.isSafeInteger(receipt.duration_ms) ||
		!Array.isArray(receipt.runtime_actions) ||
		!qualificationRecord(receipt.continuation) ||
		data?.contract !== BROWSER_USE_OPERATION_CONTRACT_ID ||
		data.schema_version !== BROWSER_USE_OPERATION_SCHEMA_VERSION ||
		data.result_kind !== "browser_operation" ||
		data.effect !== "confirmed" ||
		!binding ||
		typeof binding.outer_run_id !== "string" ||
		typeof binding.run_id !== "string" ||
		typeof binding.handoff_evidence_id !== "string" ||
		typeof binding.browser_authority_id !== "string" ||
		typeof binding.target_candidate_id !== "string" ||
		!(["hints", "selected_state", "single_candidate"] as unknown[]).includes(data.target_source) ||
		!target ||
		!Number.isSafeInteger(target.candidate_ordinal) ||
		typeof target.candidate_id !== "string" ||
		typeof target.target_id !== "string" ||
		typeof target.target_ref !== "string" ||
		typeof target.cdp_endpoint !== "string" ||
		typeof target.origin !== "string" ||
		!execution ||
		!sideEffects ||
		typeof sideEffects.focus !== "boolean" ||
		!custody
	) return undefined;
	const adapter = data.adapter;
	const operation = data.operation;
	const command = data.command;
	if (typeof adapter !== "string") return undefined;
	const exactCapability = resolveExactTargetOperationCapability(
		adapter as BrowserAdapterId,
	);
	if (!exactCapability.ok) return undefined;
	if (
		!((command === "operate-snapshot" && operation === "snapshot") ||
			(command === "operate-screenshot" && operation === "screenshot") ||
			(command === "operate-target" && operation === "target"))
	) return undefined;
	if (operation === "target") {
		const targetPlan = parseTargetPlanReceiptProjection(data.target_plan);
		if (
			execution.scope !== "target-local" ||
			execution.focus !== false ||
			sideEffects.focus !== false ||
			execution.capability_id !== exactCapability.capability.capability_id ||
			typeof execution.plan_digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(execution.plan_digest) ||
			!targetPlan ||
			targetPlan.steps.some((step) => step.status !== "confirmed")
		) return undefined;
		return { receipt, data, binding, target, execution, custody };
	}
	if (operation === "snapshot") {
		const snapshot = qualificationRecord(data.snapshot);
		const limits = qualificationRecord(snapshot?.limits);
		if (
			execution.scope !== "target-local" ||
			execution.focus !== false ||
			sideEffects.focus !== false ||
			execution.capability_id !== exactCapability.capability.capability_id ||
			!snapshot ||
			!hasExactQualificationKeys(snapshot, [
				"text",
				"line_count",
				"byte_count",
				"truncated",
				"limits",
			]) ||
			typeof snapshot.text !== "string" ||
			!Number.isSafeInteger(snapshot.line_count) ||
			(snapshot.line_count as number) < 0 ||
			!Number.isSafeInteger(snapshot.byte_count) ||
			(snapshot.byte_count as number) < 0 ||
			Buffer.byteLength(snapshot.text, "utf8") !== snapshot.byte_count ||
			typeof snapshot.truncated !== "boolean" ||
			!limits ||
			!hasExactQualificationKeys(limits, ["max_bytes", "max_lines"]) ||
			!Number.isSafeInteger(limits.max_bytes) ||
			(limits.max_bytes as number) < 1 ||
			!Number.isSafeInteger(limits.max_lines) ||
			(limits.max_lines as number) < 1
		) return undefined;
	} else {
		const screenshot = qualificationRecord(data.screenshot);
		const artifact = qualificationRecord(screenshot?.artifact);
		if (
			execution.scope !== "browser-wide" ||
			execution.focus !== true ||
			sideEffects.focus !== true ||
			!artifact ||
			!hasExactQualificationKeys(artifact, [
				"path",
				"relative_path",
				"root",
				"format",
				"full_page",
				"byte_count",
				"content_sha256",
				"media_type",
			]) ||
			typeof artifact.path !== "string" ||
			typeof artifact.relative_path !== "string" ||
			typeof artifact.root !== "string" ||
			!isAbsolute(artifact.path) ||
			!isAbsolute(artifact.root) ||
			isAbsolute(artifact.relative_path) ||
			normalize(resolve(artifact.root, artifact.relative_path)) !==
				normalize(artifact.path) ||
			relative(artifact.root, artifact.path).startsWith("..") ||
			artifact.format !== "png" ||
			typeof artifact.full_page !== "boolean" ||
			!Number.isSafeInteger(artifact.byte_count) ||
			(artifact.byte_count as number) < 0 ||
			typeof artifact.content_sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(artifact.content_sha256) ||
			artifact.media_type !== "image/png"
		) return undefined;
	}
	return { receipt, data, binding, target, execution, custody };
}

function parseTransportOutput(stdout: string): unknown {
	if (stdout.trim() === "") return "";
	try {
		return JSON.parse(stdout);
	} catch {
		return stdout;
	}
}

function extractTextContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isJsonObject(value)) return "";
	if (typeof value.text === "string") return value.text;
	if (typeof value.result === "string") return value.result;
	const content = value.content;
	if (Array.isArray(content)) {
		return content
			.flatMap((entry) =>
				isJsonObject(entry) && typeof entry.text === "string" ? [entry.text] : [],
			)
			.join("\n");
	}
	return "";
}

function boundSnapshotText(text: string): {
	text: string;
	lineCount: number;
	byteCount: number;
	truncated: boolean;
} {
	const lines = text.split("\n");
	let bounded = lines.slice(0, SNAPSHOT_MAX_LINES).join("\n");
	let truncated = lines.length > SNAPSHOT_MAX_LINES;
	while (Buffer.byteLength(bounded, "utf-8") > SNAPSHOT_MAX_BYTES) {
		bounded = bounded.slice(0, Math.max(0, bounded.length - 1024));
		truncated = true;
	}
	return {
		text: bounded,
		lineCount: bounded === "" ? 0 : bounded.split("\n").length,
		byteCount: Buffer.byteLength(bounded, "utf-8"),
		truncated,
	};
}
