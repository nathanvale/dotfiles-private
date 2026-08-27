import {
	type CliWriter,
	createCliRuntimeError,
	createCliRuntimeErrorEnvelope,
	createCliRuntimeSuccessEnvelope,
	writeJsonEnvelope,
} from "@side-quest/cli-command-facade";
import { dirname } from "node:path";
import {
	BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
	BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
} from "./command-contract";
import type { ParsedBrowserUseCommand } from "./browser-use-parser";
import {
	BINDING_FAIL_CLOSED_EXIT_CODE,
	RUNTIME_FAILURE_EXIT_CODE,
	isJsonObject,
	parseUrlSafe,
	redactUnsafeText,
	safeJsonObject,
	stringField,
	targetEnvelopeIdOf,
	toCandidate,
	navigableRawPages,
} from "./browser-use-core";
import type { BrowserUseRuntime } from "./browser-use-runtime";
import { type HandoffFacts, parseHandoffFacts } from "./browser-use-discovery";
import {
	SELECTED_TARGET_STATE_TTL_MS,
	canonicalRunSelectedStatePath,
	loadSelectedStateForCleanup,
	persistAdoptedSelectedTargetState,
	persistCreatedSelectedTargetState,
	persistReleasedSelectedTargetState,
	removeSelectedTargetStateIfRevision,
} from "./browser-use-selection";
import {
	resolveExactTargetTopologyCapability,
} from "./browser-use-adapter-registry";
import {
	type TargetOperationLease,
	acquireBrowserLaneLease,
	acquireTargetOperationLease,
	browserAuthorityIdOf,
	ownedTargetRefsForRun,
	persistTargetOwnershipUnderCleanupLease,
	heartbeatRetainedTopologyCleanupLease,
	hasExactCreatedTargetOwnership,
	hasExactTargetOwnership,
	releaseBrowserLaneLease,
	releaseExactTargetOwnership,
	releaseExactTargetOwnershipByRef,
	releaseTargetOperationLease,
	retainedTopologyCleanupLeaseForRun,
	targetRefOf,
} from "./browser-use-browser-custody";
import {
	type BrowserUseAdmittedPaths,
	inspectBrowserUsePaths,
	openBrowserUsePaths,
} from "./browser-use-paths";
import type { RunStoreDeps } from "./browser-use-runs";
import { retryabilityForRecoverability } from "./runtime-error-retryability";
import { readDurableFile } from "./browser-use-store";
import { SAFE_RUN_ID } from "./browser-use-identifiers";
import { sealedQualificationRuntimeEvidence } from "./browser-use-qualification-evidence";
import {
	BROWSER_USE_ADAPTER_LANE_IDS,
	BROWSER_USE_CANONICAL_TARGET_ID_PATTERN,
	type BrowserUseAdapterLaneId,
	type BrowserUseExactTargetHandoff,
	type BrowserUseExactTargetInventoryEntry,
	type BrowserUseExactTargetTopologyCapability,
} from "./browser-use-adapter-model";

const TOPOLOGY_LEASE_TTL_MS = 120_000;

type TopologyEffect = "not_started" | "confirmed" | "unknown";

type TopologySuccessData = {
	effect: TopologyEffect;
	target_mutated: boolean;
	[key: string]: unknown;
};

type TopologyFailure = {
	code: string;
	message: string;
	exitCode: number;
	recoverability: "retry" | "change_input" | "repair_state" | "none";
	repairHint: string;
	effect: TopologyEffect;
	targetMutated: boolean | "unknown";
	targetPresent?: boolean | "unknown";
	cleanup?: { attempted: boolean; closed: boolean | "unknown"; cause?: string };
	primaryCause?: string;
	primaryCleanup?: {
		attempted: boolean;
		closed: boolean | "unknown";
		cause?: string;
	};
	cleanupDebt?: readonly string[];
};

type TopologyOutcome =
	| { ok: true; runId: string; data: TopologySuccessData }
	| { ok: false; runId: string; failure: TopologyFailure };

type TopologyBrowserLaneInterval = {
	acquiredAtEpochMs: number;
	releasedAtEpochMs: number;
};

type TopologyTargetLeaseInterval = TopologyBrowserLaneInterval;

type NativeTarget = BrowserUseExactTargetInventoryEntry;

function exactTargetHandoff(facts: HandoffFacts): BrowserUseExactTargetHandoff {
	return {
		adapter_id: facts.adapter,
		run_id: facts.runId,
		executable: facts.probeExecutable,
		endpoint_http: facts.endpointHttp,
		endpoint_ws: facts.endpointWs,
	};
}

function exactTopologyAdapter(value: unknown): BrowserUseAdapterLaneId | undefined {
	if (
		typeof value !== "string" ||
		!BROWSER_USE_ADAPTER_LANE_IDS.includes(value as BrowserUseAdapterLaneId)
	) return undefined;
	const resolved = resolveExactTargetTopologyCapability(
		value as BrowserUseAdapterLaneId,
	);
	return resolved.ok ? resolved.capability.adapter_id : undefined;
}

function nativeTargetPages(targets: readonly NativeTarget[]) {
	return navigableRawPages(
		targets.map((target) => ({
			id: target.adapter_target_ref,
			cdp_target_id: target.canonical_target_id,
			url: target.url,
			...(target.title === undefined ? {} : { title: target.title }),
		})),
	);
}

type VerifiedTopologyHandoff = {
	facts: HandoffFacts;
	capability: BrowserUseExactTargetTopologyCapability;
};

type TopologyInput = {
	parsed: Extract<ParsedBrowserUseCommand, { kind: "command" }>;
	runtime: BrowserUseRuntime;
	stdout: CliWriter;
	stderr: CliWriter;
	runId: string;
	runIdExplicit: boolean;
	durationMs: () => number;
};

function safeUrl(value: string): URL | undefined {
	if (value.length === 0 || value.length > 2_048) return undefined;
	const parsed = parseUrlSafe(value);
	return parsed !== undefined &&
		parsed.origin !== "null" &&
		parsed.username === "" &&
		parsed.password === ""
		? parsed
		: undefined;
}

async function readTopologyHandoff(
	input: TopologyInput,
): Promise<
	| { ok: true; handoff: VerifiedTopologyHandoff }
	| { ok: false; failure: TopologyFailure }
> {
	const path = stringField(input.parsed.flagValues["--handoff"]);
	let raw: string;
	try {
		raw = await input.runtime.readTextFile(path ?? "");
	} catch {
		return {
			ok: false,
			failure: preflightFailure(
				"target_topology_handoff_unreadable",
				"The Verified Handoff Envelope could not be read.",
				"Mint a fresh verified exact-target handoff and pass its exact private path.",
			),
		};
	}
	const parsed = parseHandoffFacts(raw);
	if (!parsed.ok || parsed.kind !== "verified") {
		return {
			ok: false,
			failure: preflightFailure(
				"target_topology_handoff_invalid",
				parsed.ok
					? "The supplied envelope is a connection failure and authorizes no target mutation."
					: parsed.failure.message,
				"Mint a fresh verified exact-target handoff, then retry with the same input.",
			),
		};
	}
	let envelope: Record<string, unknown> | undefined;
	try {
		envelope = safeJsonObject(raw);
	} catch {
		envelope = undefined;
	}
	const data = isJsonObject(envelope?.data) ? envelope.data : undefined;
	const attachment = isJsonObject(data?.attachment)
		? data.attachment
		: undefined;
	const proof = isJsonObject(data?.proof) ? data.proof : undefined;
	const resolvedCapability = resolveExactTargetTopologyCapability(
		parsed.facts.adapter,
	);
	if (
		!resolvedCapability.ok ||
		attachment?.route !== "explicit-cdp" ||
		data?.browser_entry_mode !== "explicit-cdp" ||
		proof?.route_evidence !== "verified-live" ||
		!SAFE_RUN_ID.test(parsed.facts.runId)
	) {
		return {
			ok: false,
			failure: preflightFailure(
				resolvedCapability.ok
					? "target_topology_handoff_invalid"
					: "target_topology_adapter_unsupported",
				"Target topology mutation requires a verified-live explicit-CDP adapter with exact-target topology capability.",
				"Re-mint a handoff for an adapter that implements exact-target topology.",
			),
		};
	}
	if (input.runIdExplicit && input.runId !== parsed.facts.runId) {
		return {
			ok: false,
			failure: preflightFailure(
				"target_discovery_run_mismatch",
				"The asserted invocation run does not match the handoff-bound run.",
				"Use the matching run-bound handoff; do not cross-use another run's envelope.",
			),
		};
	}
	return {
		ok: true,
		handoff: { facts: parsed.facts, capability: resolvedCapability.capability },
	};
}

function preflightFailure(
	code: string,
	message: string,
	repairHint: string,
): TopologyFailure {
	return {
		code,
		message,
		exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
		recoverability: "change_input",
		repairHint,
		effect: "not_started",
		targetMutated: false,
	};
}

async function listNativeTargets(
	input: TopologyInput,
	handoff: VerifiedTopologyHandoff,
): Promise<NativeTarget[] | undefined> {
	const result = await handoff.capability.run({
		runtime: input.runtime,
		handoff: exactTargetHandoff(handoff.facts),
		action: { kind: "inventory" },
	});
	return result.ok && result.kind === "inventory" ? [...result.targets] : undefined;
}

async function releaseAdapterLifecycle(
	input: TopologyInput,
	handoff: VerifiedTopologyHandoff,
): Promise<{ released: boolean; cause?: string }> {
	const release = await handoff.capability.releaseLifecycle({
		env: input.runtime.env,
		runtime: input.runtime,
		handoff: exactTargetHandoff(handoff.facts),
	});
	return release.released
		? { released: true }
		: { released: false, cause: release.cause };
}

async function openCustodyStore(
	input: TopologyInput,
): Promise<
	{ ok: true; deps: RunStoreDeps } | { ok: false; failure: TopologyFailure }
> {
	const opened = await openBrowserUsePaths(
		input.runtime.platformFs,
		input.runtime.env,
	);
	if (!opened.ok) {
		return {
			ok: false,
			failure: {
				...preflightFailure(
					opened.refusal.code,
					opened.refusal.message,
					opened.refusal.continuation.summary,
				),
				recoverability: "repair_state",
			},
		};
	}
	return {
		ok: true,
		deps: {
			fs: input.runtime.platformFs,
			paths: opened.paths,
			clock: input.runtime.now,
		},
	};
}

function topologyStatePath(
	input: TopologyInput,
	paths: BrowserUseAdmittedPaths,
	runId: string,
): string {
	return (
		stringField(input.parsed.flagValues["--state"]) ??
		canonicalRunSelectedStatePath(paths.resolution.roots.state, runId)
	);
}

async function inspectTopologyPaths(
	input: TopologyInput,
): Promise<
	| { ok: true; paths: BrowserUseAdmittedPaths }
	| { ok: false; failure: TopologyFailure }
> {
	const inspected = await inspectBrowserUsePaths(
		input.runtime.platformFs,
		input.runtime.env,
	);
	if (inspected.ok) return inspected;
	return {
		ok: false,
		failure: {
			...preflightFailure(
				inspected.refusal.code,
				inspected.refusal.message,
				inspected.refusal.continuation.summary,
			),
			recoverability: "repair_state",
		},
	};
}

async function resolveTopologyStatePath(
	input: TopologyInput,
	runId: string,
): Promise<
	{ ok: true; path: string } | { ok: false; failure: TopologyFailure }
> {
	const explicit = stringField(input.parsed.flagValues["--state"]);
	if (explicit !== undefined) return { ok: true, path: explicit };
	const inspected = await inspectTopologyPaths(input);
	return inspected.ok
		? { ok: true, path: topologyStatePath(input, inspected.paths, runId) }
		: inspected;
}

function emitFailure(
	input: TopologyInput,
	failure: TopologyFailure,
	runId: string,
): number {
	if (input.parsed.outputMode === "plain") {
		const targetPresent =
			failure.targetPresent === undefined
				? ""
				: ` target_present=${String(failure.targetPresent)}`;
		const primaryCause =
			failure.primaryCause === undefined
				? ""
				: ` primary_cause=${failure.primaryCause}`;
		const primaryCleanup =
			failure.primaryCleanup === undefined
				? ""
				: ` primary_cleanup=attempted:${String(failure.primaryCleanup.attempted)},closed:${String(failure.primaryCleanup.closed)}${
						failure.primaryCleanup.cause === undefined
							? ""
							: `,cause:${redactUnsafeText(failure.primaryCleanup.cause)}`
					}`;
		const cleanupDebt =
			failure.cleanupDebt === undefined
				? ""
				: ` cleanup_debt=${failure.cleanupDebt.join(",")}`;
		input.stderr.write(
			`browser_use ${failure.code}: ${redactUnsafeText(failure.message)} repair=${redactUnsafeText(failure.repairHint)} effect=${failure.effect} target_mutated=${String(failure.targetMutated)}${targetPresent}${primaryCause}${primaryCleanup}${cleanupDebt} (run_id=${runId})\n`,
		);
		return failure.exitCode;
	}
	writeJsonEnvelope(
		input.stdout,
		createCliRuntimeErrorEnvelope({
			run_id: runId,
			process_exit_code: failure.exitCode,
			data: {
				contract: BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
				schema_version: BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
				command: input.parsed.command,
				result_kind: "browser_target_topology",
				effect: failure.effect,
				target_mutated: failure.targetMutated,
				...(failure.targetPresent === undefined
					? {}
					: { target_present: failure.targetPresent }),
				...(failure.cleanup === undefined ? {} : { cleanup: failure.cleanup }),
				...(failure.primaryCause === undefined
					? {}
					: { primary_cause: failure.primaryCause }),
				...(failure.primaryCleanup === undefined
					? {}
					: { primary_cleanup: failure.primaryCleanup }),
				...(failure.cleanupDebt === undefined
					? {}
					: { cleanup_debt: failure.cleanupDebt }),
				repair_hint: redactUnsafeText(failure.repairHint),
			},
			error: createCliRuntimeError({
				run_id: runId,
				code: failure.code,
				message: redactUnsafeText(failure.message),
				exit_code: failure.exitCode,
				severity: "error",
				...retryabilityForRecoverability(failure.recoverability),
				failure_domain: "browser_use",
			}),
		}),
		{ runId, durationMs: input.durationMs() },
	);
	return failure.exitCode;
}

function emitSuccess(
	input: TopologyInput,
	runId: string,
	data: TopologySuccessData,
): number {
	const alreadyAbsent = data.already_absent === true;
	const qualificationEligible =
		data.qualification_eligible === true ||
		(data.qualification_eligible === undefined &&
			data.effect === "confirmed" &&
			data.target_mutated === true &&
			exactTopologyAdapter(data.adapter) !== undefined &&
			(data.target_present === true || data.target_present === false));
	if (input.parsed.outputMode === "plain") {
		const targetPresent =
			data.target_present === undefined
				? ""
				: ` target_present=${String(data.target_present)}`;
		input.stdout.write(
			`browser_target_topology command=${input.parsed.command} effect=${String(data.effect)} target_mutated=${String(data.target_mutated)}${targetPresent} run_id=${runId}\n`,
		);
		return 0;
	}
	writeJsonEnvelope(
		input.stdout,
		createCliRuntimeSuccessEnvelope({
			run_id: runId,
			data: {
				contract: BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
				schema_version: BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
				command: input.parsed.command,
				result_kind: "browser_target_topology",
				already_absent: alreadyAbsent,
				qualification_eligible: qualificationEligible,
				...(sealedQualificationRuntimeEvidence() === undefined
					? {}
					: {
							qualification_runtime:
								sealedQualificationRuntimeEvidence(),
						}),
				...data,
			},
			runtime_actions: [
				{
					id: "inspect_target_topology_result",
					summary: "Inspect the exact Browser Target topology result.",
					side_effects: ["check"],
				},
			],
			continuation: { next_action_id: "inspect_target_topology_result" },
		}),
		{ runId, durationMs: input.durationMs() },
	);
	return 0;
}

function failureOutcome(
	runId: string,
	failure: TopologyFailure,
): TopologyOutcome {
	return { ok: false, runId, failure };
}

function successOutcome(
	runId: string,
	data: TopologySuccessData,
): TopologyOutcome {
	return { ok: true, runId, data };
}

function bindTopologySuccessReceipt(input: {
	outcome: TopologyOutcome;
	handoff: HandoffFacts;
	origin: string;
	targetRef: string;
	browserLane: TopologyBrowserLaneInterval;
	targetLease: TopologyTargetLeaseInterval;
}): TopologyOutcome {
	if (!input.outcome.ok) return input.outcome;
	return successOutcome(input.outcome.runId, {
		...input.outcome.data,
		binding: {
			outer_run_id: input.outcome.runId,
			run_id: input.handoff.runId,
			handoff_evidence_id: input.handoff.handoffEvidenceId,
			browser_authority_id: browserAuthorityIdOf(input.handoff),
		},
		target_ref: input.targetRef,
		normalized_origin: input.origin,
		target: { target_ref: input.targetRef, origin: input.origin },
		custody: {
			target_operation_lease: {
				acquired_at_epoch_ms: input.targetLease.acquiredAtEpochMs,
				released_at_epoch_ms: input.targetLease.releasedAtEpochMs,
			},
			browser_lane: {
				acquired_at_epoch_ms: input.browserLane.acquiredAtEpochMs,
				released_at_epoch_ms: input.browserLane.releasedAtEpochMs,
			},
		},
	});
}

export type BrowserTargetTopologyQualificationReceipt = {
	receipt: Record<string, unknown>;
	data: Record<string, unknown>;
	binding: Record<string, unknown>;
	target: Record<string, unknown>;
	custody: Record<string, unknown>;
};

function topologyQualificationRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parse one complete public topology success receipt for qualification. */
export function parseBrowserTargetTopologyQualificationReceipt(
	raw: string,
): BrowserTargetTopologyQualificationReceipt | undefined {
	let receipt: Record<string, unknown> | undefined;
	try {
		receipt = topologyQualificationRecord(JSON.parse(raw));
	} catch {
		return undefined;
	}
	const data = topologyQualificationRecord(receipt?.data);
	const binding = topologyQualificationRecord(data?.binding);
	const target = topologyQualificationRecord(data?.target);
	const custody = topologyQualificationRecord(data?.custody);
	if (
		receipt?.status !== "ok" ||
		typeof receipt.run_id !== "string" ||
		!Number.isSafeInteger(receipt.duration_ms) ||
		!Array.isArray(receipt.runtime_actions) ||
		!topologyQualificationRecord(receipt.continuation) ||
		data?.contract !== BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID ||
		data.schema_version !== BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION ||
		data.result_kind !== "browser_target_topology" ||
		exactTopologyAdapter(data.adapter) === undefined ||
		data.effect !== "confirmed" ||
		data.target_mutated !== true ||
		data.already_absent !== false ||
		data.qualification_eligible !== true ||
		!binding ||
		typeof binding.outer_run_id !== "string" ||
		typeof binding.run_id !== "string" ||
		typeof binding.handoff_evidence_id !== "string" ||
		typeof binding.browser_authority_id !== "string" ||
		typeof data.target_ref !== "string" ||
		typeof data.normalized_origin !== "string" ||
		!target ||
		target.target_ref !== data.target_ref ||
		target.origin !== data.normalized_origin ||
		!custody
	) return undefined;
	if (
		!((data.command === "targets-open" && data.target_present === true) ||
			(data.command === "targets-close" && data.target_present === false && data.ownership_released === true))
	) return undefined;
	return { receipt, data, binding, target, custody };
}

function emitOutcome(input: TopologyInput, outcome: TopologyOutcome): number {
	return outcome.ok
		? emitSuccess(input, outcome.runId, outcome.data)
		: emitFailure(input, outcome.failure, outcome.runId);
}

function mergeReleaseDebt(
	outcome: TopologyOutcome,
	cleanupDebt: readonly string[],
): TopologyOutcome {
	if (cleanupDebt.length === 0) return outcome;
	const allCleanupDebt = [
		...(outcome.ok ? [] : (outcome.failure.cleanupDebt ?? [])),
		...cleanupDebt,
	].filter((value, index, values) => values.indexOf(value) === index);
	const primaryTargetPresent = outcome.ok
		? outcome.data.target_present
		: outcome.failure.targetPresent;
	return failureOutcome(outcome.runId, {
		code: "target_topology_release_incomplete",
		message:
			"The topology operation reached its primary outcome, but short custody or adapter lifecycle cleanup is incomplete.",
		exitCode: RUNTIME_FAILURE_EXIT_CODE,
		recoverability: "none",
		repairHint:
			"Inspect the named cleanup debt before any retry; do not repeat the browser mutation.",
		effect: outcome.ok ? outcome.data.effect : outcome.failure.effect,
		targetMutated: outcome.ok
			? outcome.data.target_mutated
			: outcome.failure.targetMutated,
		primaryCause: outcome.ok ? "success" : outcome.failure.code,
		...(primaryTargetPresent === true ||
		primaryTargetPresent === false ||
		primaryTargetPresent === "unknown"
			? { targetPresent: primaryTargetPresent }
			: {}),
		...(outcome.ok || outcome.failure.cleanup === undefined
			? {}
			: { primaryCleanup: outcome.failure.cleanup }),
		cleanupDebt: allCleanupDebt,
	});
}

async function releaseLifecycleAndEmit(
	input: TopologyInput,
	handoff: VerifiedTopologyHandoff,
	outcome: TopologyOutcome,
): Promise<number> {
	const lifecycle = await releaseAdapterLifecycle(input, handoff).catch(() => ({
		released: false as const,
		cause: "adapter-lifecycle-release-failed",
	}));
	return emitOutcome(
		input,
		mergeReleaseDebt(
			outcome,
			lifecycle.released
				? []
				: [lifecycle.cause ?? "adapter-lifecycle-release-failed"],
		),
	);
}

async function exactCleanup(
	input: TopologyInput,
	handoff: VerifiedTopologyHandoff,
	canonicalTargetId: string,
): Promise<{ attempted: true; closed: boolean | "unknown"; cause?: string }> {
	const closeResult = await handoff.capability.run({
		runtime: input.runtime,
		handoff: exactTargetHandoff(handoff.facts),
		action: { kind: "close", target_id: canonicalTargetId },
	});
	const transportConfirmed = closeResult.ok && closeResult.kind === "close";
	const listed = await listNativeTargets(input, handoff);
	if (listed === undefined) {
		return {
			attempted: true,
			closed: "unknown",
			cause: "post-close-inventory-unavailable",
		};
	}
	if (
		listed.some(
			(target) => target.canonical_target_id === canonicalTargetId,
		)
	) {
		return {
			attempted: true,
			closed: false,
			cause: transportConfirmed
				? "target-remains-visible"
				: "native-close-failed-and-target-remains-visible",
		};
	}
	return transportConfirmed
		? { attempted: true, closed: true }
		: {
				attempted: true,
				closed: true,
				cause: "native-close-transport-failed-after-confirmed-effect",
			};
}

export async function runTargetsOpen(input: TopologyInput): Promise<number> {
	const handoffRead = await readTopologyHandoff(input);
	if (!handoffRead.ok)
		return emitFailure(input, handoffRead.failure, input.runId);
	const handoff = handoffRead.handoff;
	const rawUrl = stringField(input.parsed.flagValues["--url"]) ?? "";
	const url = safeUrl(rawUrl);
	if (!url) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_url_invalid",
				"targets open requires one exact HTTP(S) URL.",
				"Supply a bounded exact HTTP(S) URL without changing the handoff.",
			),
			handoff.facts.runId,
		);
	}
	const resolvedState = await resolveTopologyStatePath(
		input,
		handoff.facts.runId,
	);
	if (!resolvedState.ok)
		return emitFailure(input, resolvedState.failure, handoff.facts.runId);
	const statePath = resolvedState.path;
	if (input.parsed.dryRun) {
		return emitSuccess(input, handoff.facts.runId, {
			effect: "not_started",
			target_mutated: false,
			adapter: handoff.facts.adapter,
			allowed_origin: url.origin,
			planned_effect: "create-bind-select",
			state_path_source:
				stringField(input.parsed.flagValues["--state"]) === undefined
					? "run-scoped-xdg"
					: "explicit",
		});
	}
	const store = await openCustodyStore(input);
	if (!store.ok) return emitFailure(input, store.failure, handoff.facts.runId);
	try {
		await input.runtime.ensureDirectory(dirname(statePath));
	} catch {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_parent_unavailable",
				"The private selected-state parent directory could not be prepared.",
				"Repair the private selected-state parent before retrying.",
			),
			handoff.facts.runId,
		);
	}
	const standingState = await readDurableFile(
		input.runtime.platformFs,
		statePath,
	);
	if (standingState.status !== "missing") {
		return emitFailure(
			input,
			preflightFailure(
				standingState.status === "present"
					? "target_topology_state_exists"
					: "target_topology_state_unreadable",
				"targets open requires an absent selected-state record.",
				"Close or repair the standing selected target before opening another.",
			),
			handoff.facts.runId,
		);
	}
	const authorityId = browserAuthorityIdOf(handoff.facts);
	const standingOwners = await ownedTargetRefsForRun(store.deps, {
		authorityId,
		runId: handoff.facts.runId,
		adapterId: handoff.facts.adapter,
	});
	if (!standingOwners.ok || standingOwners.targetRefs.length !== 0) {
		return emitFailure(
			input,
			{
				...preflightFailure(
					standingOwners.ok
						? "target_topology_persistent_owner_exists"
						: standingOwners.code,
					standingOwners.ok
						? "This run already owns an open-created adapter target."
						: standingOwners.message,
					"Close or repair the existing open-created target before opening another for this run.",
				),
				recoverability: "repair_state",
			},
			handoff.facts.runId,
		);
	}
	const browserLane = await acquireBrowserLaneLease(store.deps, {
		authorityId,
		runId: handoff.facts.runId,
		mutation: "target-topology",
		ttlMs: TOPOLOGY_LEASE_TTL_MS,
	});
	if (!browserLane.ok) {
		return emitFailure(
			input,
			{
				...preflightFailure(
					browserLane.code,
					browserLane.message,
					"Wait for the existing Browser Lane turn to release, then retry the same open input once.",
				),
				recoverability: "retry",
			},
			handoff.facts.runId,
		);
	}
	let targetLease: TargetOperationLease | undefined;
	let createdTargetId: string | undefined;
	let keepOwnership = false;
	let releaseOwnershipAfterAbsence = false;
	let retainCleanupLease = false;
	let outcome: TopologyOutcome;
	const cleanupDebt: string[] = [];
	let browserLaneInterval: TopologyBrowserLaneInterval | undefined;
	let targetLeaseInterval: TopologyTargetLeaseInterval | undefined;
	try {
		outcome = await (async (): Promise<TopologyOutcome> => {
		const before = await listNativeTargets(input, handoff);
		if (before === undefined) {
			return failureOutcome(
				handoff.facts.runId,
				preflightFailure(
					"target_topology_inventory_unavailable",
					"The adapter could not provide the pre-create target inventory.",
					"Inspect the verified handoff and exact-target adapter dependency, then retry once.",
				),
			);
		}
		const createdResult = await handoff.capability.run({
			runtime: input.runtime,
			handoff: exactTargetHandoff(handoff.facts),
			action: { kind: "create", url: rawUrl },
		});
		const created =
			createdResult.ok && createdResult.kind === "create"
				? createdResult.data
				: undefined;
		const reportedTargetId =
			typeof created?.canonical_target_id === "string" &&
			BROWSER_USE_CANONICAL_TARGET_ID_PATTERN.test(created.canonical_target_id)
				? created.canonical_target_id
					: undefined;
		const adoptedCurrent = created?.target_disposition === "adopted-current";
		const beforeIds = new Set(
			before.map((target) => target.canonical_target_id),
		);
		const after = await listNativeTargets(input, handoff);
		if (after === undefined) {
			const provisionalTargetId =
				reportedTargetId !== undefined && !beforeIds.has(reportedTargetId)
					? reportedTargetId
					: undefined;
			let cleanup:
				| { attempted: boolean; closed: boolean | "unknown"; cause?: string }
				| undefined;
			if (provisionalTargetId !== undefined) {
				const acquired = await acquireTargetOperationLease(store.deps, {
					authorityId,
					runId: handoff.facts.runId,
					adapterId: handoff.facts.adapter,
					rawTargetId: provisionalTargetId,
					operation: "close",
					ttlMs: TOPOLOGY_LEASE_TTL_MS,
					ownershipEvidence: {
						kind: "adapter-creation-receipt",
						adapter_id: handoff.facts.adapter,
						run_id: handoff.facts.runId,
						raw_target_id: provisionalTargetId,
					},
					retainLeaseOnBindingFailure: true,
				});
				const cleanupLease = acquired.ok
					? acquired.lease
					: "cleanup_lease" in acquired
						? acquired.cleanup_lease
						: undefined;
				if (cleanupLease !== undefined) {
					targetLease = cleanupLease;
					createdTargetId = provisionalTargetId;
					cleanup = await exactCleanup(
						input,
						handoff,
						provisionalTargetId,
					);
					releaseOwnershipAfterAbsence = cleanup.closed === true;
				}
			}
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_inventory_unavailable",
				message:
					"The post-create inventory was unavailable or contained malformed or duplicate target identities.",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability: "none",
				repairHint:
					cleanup?.closed === true
						? "Repair adapter target inventory before any bounded retry."
						: "Stop and inspect adapter target inventory and retained target ownership before any retry.",
				effect: cleanup?.closed === true ? "confirmed" : "unknown",
				targetMutated: provisionalTargetId === undefined ? "unknown" : true,
				targetPresent: cleanup?.closed === true ? false : "unknown",
				...(cleanup === undefined ? {} : { cleanup }),
			});
		}
		const afterIds = new Set(
			after.map((target) => target.canonical_target_id),
		);
		const collateralMissing = before.some(
			(target) => !afterIds.has(target.canonical_target_id),
		);
		const newTargets = after.filter(
			(target) => !beforeIds.has(target.canonical_target_id),
		);
		const exact = newTargets.filter(
			(target) => safeUrl(target.url)?.href === url.href,
		);
		const adoptedTarget =
			adoptedCurrent &&
			reportedTargetId !== undefined &&
			newTargets.length === 0 &&
			before.length === after.length &&
			before.every((target) => afterIds.has(target.canonical_target_id))
				? after.find(
						(target) =>
							target.canonical_target_id === reportedTargetId &&
							// Origin, not exact href. By this point the adapter has
							// already proven a stable identity for this exact target,
							// plus correspondence with the requested origin. A page
							// that rewrites its own query string as it loads must not
							// undo that: the canonical target id above is the identity
							// here, and a foreign origin is still refused.
							safeUrl(target.url)?.origin === url.origin &&
							before.some(
								(previous) =>
									previous.canonical_target_id === reportedTargetId,
							),
					)
				: undefined;
		const returnedIdDrift =
			reportedTargetId !== undefined &&
			exact.length === 1 &&
			exact[0]?.canonical_target_id !== reportedTargetId;
		const createdBindingValid =
			!collateralMissing &&
			newTargets.length === 1 &&
			exact.length === 1 &&
			!returnedIdDrift;
		const adoptedBindingValid = !collateralMissing && adoptedTarget !== undefined;
		if (
			!createdBindingValid &&
			!adoptedBindingValid
		) {
			const inventoryFullyReconciled =
				!collateralMissing && newTargets.length === 1;
			const independentlyIdentified =
				exact.length === 1
					? exact[0]
					: inventoryFullyReconciled &&
							newTargets[0]?.canonical_target_id === reportedTargetId
						? newTargets[0]
						: undefined;
			const cleanup =
				independentlyIdentified === undefined
					? undefined
					: await (async () => {
							const acquired = await acquireTargetOperationLease(store.deps, {
								authorityId,
								runId: handoff.facts.runId,
								adapterId: handoff.facts.adapter,
								rawTargetId: independentlyIdentified.canonical_target_id,
								operation: "close",
								ttlMs: TOPOLOGY_LEASE_TTL_MS,
								ownershipEvidence: {
									kind: "adapter-creation-receipt",
									adapter_id: handoff.facts.adapter,
									run_id: handoff.facts.runId,
									raw_target_id: independentlyIdentified.canonical_target_id,
								},
								retainLeaseOnBindingFailure: true,
							});
							const cleanupLease = acquired.ok
								? acquired.lease
								: "cleanup_lease" in acquired
									? acquired.cleanup_lease
									: undefined;
							if (cleanupLease === undefined) return undefined;
							targetLease = cleanupLease;
							createdTargetId = independentlyIdentified.canonical_target_id;
							const result = await exactCleanup(
								input,
								handoff,
								independentlyIdentified.canonical_target_id,
							);
							releaseOwnershipAfterAbsence = result.closed === true;
							return result;
						})();
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_create_binding_failed",
				message:
					"Independent adapter inventory did not prove exactly one new target at the requested origin.",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability:
					cleanup?.closed === true && inventoryFullyReconciled
						? "retry"
						: "none",
				repairHint:
					cleanup?.closed === true && inventoryFullyReconciled
						? "Inspect the adapter create/list contract before one bounded retry."
						: "Stop and inspect the surviving exact target before any retry.",
				effect: cleanup?.closed === true ? "confirmed" : "unknown",
				targetMutated: newTargets.length === 0 ? false : "unknown",
				targetPresent: cleanup?.closed === true ? false : "unknown",
				...(cleanup === undefined ? {} : { cleanup }),
			});
		}
		const target = (adoptedTarget ?? exact[0]) as NativeTarget;
		createdTargetId = target.canonical_target_id;
		const targetEnvelopeId = targetEnvelopeIdOf({
			runId: handoff.facts.runId,
			mode: "handoff-bound",
			adapter: handoff.facts.adapter,
			handoffEvidenceId: handoff.facts.handoffEvidenceId,
		});
		const canonicalPages = nativeTargetPages(after);
		const selectedCandidateIndex = canonicalPages.findIndex(
			(page) => page.cdp_target_id === target.canonical_target_id,
		);
		if (selectedCandidateIndex < 0) {
			const cleanup = await exactCleanup(input, handoff, target.canonical_target_id);
			releaseOwnershipAfterAbsence = cleanup.closed === true;
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_create_binding_failed",
				message: "The exact created target is not a canonical navigable page.",
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: cleanup.closed === true ? "change_input" : "none",
				repairHint: "Use an exact navigable HTTP(S) page target.",
				effect: cleanup.closed === true ? "confirmed" : "unknown",
				targetMutated: true,
				targetPresent: cleanup.closed === true ? false : "unknown",
				cleanup,
			});
		}
		const selectedCandidateOrdinal = selectedCandidateIndex + 1;
		const selectedPage = canonicalPages[selectedCandidateIndex];
		if (selectedPage === undefined) {
			throw new Error("selected canonical target page disappeared");
		}
		const targetCandidateId = toCandidate(
			selectedPage,
			selectedCandidateIndex,
			targetEnvelopeId,
			false,
		).candidate_id;
		const acquired = await acquireTargetOperationLease(store.deps, {
			authorityId,
			runId: handoff.facts.runId,
			adapterId: handoff.facts.adapter,
			rawTargetId: target.canonical_target_id,
			operation: "adopt",
			ttlMs: SELECTED_TARGET_STATE_TTL_MS,
			ownershipEvidence: adoptedBindingValid
				? {
						kind: "explicit-adoption",
						adapter_id: handoff.facts.adapter,
						run_id: handoff.facts.runId,
						raw_target_id: target.canonical_target_id,
						target_envelope_id: targetEnvelopeId,
						target_candidate_id: targetCandidateId,
						target_candidate_identity: {
							kind: "adapter-page-id",
							raw_adapter_page_id: target.adapter_target_ref,
						},
					}
				: {
						kind: "adapter-creation-receipt",
						adapter_id: handoff.facts.adapter,
						run_id: handoff.facts.runId,
						raw_target_id: target.canonical_target_id,
					},
			retainLeaseOnBindingFailure: true,
		});
		if (!acquired.ok) {
			if ("cleanup_lease" in acquired) {
				targetLease = acquired.cleanup_lease;
				const cleanup = await exactCleanup(input, handoff, target.canonical_target_id);
				releaseOwnershipAfterAbsence = cleanup.closed === true;
				const recoveredOwnership =
					cleanup.closed === true
						? undefined
						: await persistTargetOwnershipUnderCleanupLease(store.deps, {
								lease: acquired.cleanup_lease,
								authorityId,
								runId: handoff.facts.runId,
								adapterId: handoff.facts.adapter,
								rawTargetId: target.canonical_target_id,
								ttlMs: SELECTED_TARGET_STATE_TTL_MS,
							});
				if (recoveredOwnership?.ok === true) keepOwnership = true;
				if (cleanup.closed !== true && recoveredOwnership?.ok !== true) {
					retainCleanupLease = true;
				}
				return failureOutcome(handoff.facts.runId, {
					code: acquired.code,
					message: acquired.message,
					exitCode: RUNTIME_FAILURE_EXIT_CODE,
					recoverability: cleanup.closed === true ? "repair_state" : "none",
					repairHint:
						cleanup.closed === true
							? "Repair Browser Use custody persistence before one bounded retry."
							: recoveredOwnership?.ok === true
								? "Use targets close with the same verified handoff; exact adapter-created ownership was retained for repair."
								: "Stop and inspect the retained bounded cleanup lease before any retry; no browser mutation may be repeated.",
					effect: cleanup.closed === true ? "confirmed" : "unknown",
					targetMutated: true,
					targetPresent: cleanup.closed === true ? false : "unknown",
					cleanup,
					...(recoveredOwnership?.ok === true
						? { primaryCause: "target-ownership-retained-for-cleanup" }
						: {
								cleanupDebt: [
									"cleanup-operation-lease-retained",
									...(recoveredOwnership !== undefined &&
									!recoveredOwnership.ok &&
									"cleanup_debt" in recoveredOwnership
										? (recoveredOwnership.cleanup_debt ?? [])
										: []),
								],
							}),
				});
			}
			return failureOutcome(handoff.facts.runId, {
				code: acquired.code,
				message: acquired.message,
				exitCode: BINDING_FAIL_CLOSED_EXIT_CODE,
				recoverability: "repair_state",
				repairHint:
					"Inspect target custody; another holder may own the created target, so this run did not close it.",
				effect: "confirmed",
				targetMutated: true,
				targetPresent: true,
			});
		}
		targetLease = acquired.lease;
		const retainedLifecycle = await handoff.capability.run({
			runtime: input.runtime,
			handoff: exactTargetHandoff(handoff.facts),
			action: {
				kind: "retain-lifecycle",
				target_id: target.canonical_target_id,
				expected_url: target.url,
			},
		});
		if (!retainedLifecycle.ok || retainedLifecycle.kind !== "retain-lifecycle") {
			const cleanup = await exactCleanup(input, handoff, target.canonical_target_id);
			releaseOwnershipAfterAbsence = cleanup.closed === true;
			keepOwnership = cleanup.closed !== true;
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_create_binding_failed",
				message:
					"The adapter could not retain exact-target lifecycle custody for the created target.",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability: cleanup.closed === true ? "repair_state" : "none",
				repairHint:
					cleanup.closed === true
						? "Repair the adapter exact-target lifecycle capability before one bounded retry."
						: "Use targets close with the same handoff; exact ownership was retained.",
				effect: cleanup.closed === true ? "confirmed" : "unknown",
				targetMutated: true,
				targetPresent: cleanup.closed === true ? false : "unknown",
				cleanup,
			});
		}
		const adapterLifecycleRef = retainedLifecycle.lifecycle_ref;
		const persisted = await persistCreatedSelectedTargetState({
			runtime: input.runtime,
			path: statePath,
			handoff: handoff.facts,
			targetEnvelopeId,
			targetCandidateId,
			selectedCandidateOrdinal,
			targetRef: targetRefOf(target.canonical_target_id),
			retainedLifecycle: {
				adapter_id: handoff.capability.adapter_id,
				capability_id: handoff.capability.capability_id,
				lifecycle_ref: adapterLifecycleRef,
			},
			display: { origin: url.origin },
		});
		if (!persisted.ok) {
			const cleanup = await exactCleanup(input, handoff, target.canonical_target_id);
			let stateCleanup:
				| { attempted: boolean; removed: boolean; cause?: string }
				| undefined;
			const observedState = await readDurableFile(
				input.runtime.platformFs,
				statePath,
			);
			if (cleanup.closed === true && observedState.status === "present") {
				if (observedState.raw === persisted.raw) {
					const removed = await removeSelectedTargetStateIfRevision({
						runtime: input.runtime,
						path: statePath,
						runId: handoff.facts.runId,
						expectedRevision: persisted.state.revision,
						expectedRaw: persisted.raw,
					});
					stateCleanup = removed.ok
						? { attempted: true, removed: true }
						: {
								attempted: true,
								removed: false,
								cause: "selected-state-remove-failed",
							};
				} else {
					stateCleanup = {
						attempted: true,
						removed: false,
						cause: "selected-state-replacement-preserved",
					};
				}
			}
			if (cleanup.closed === true) {
				releaseOwnershipAfterAbsence =
					observedState.status === "missing" ||
					stateCleanup?.removed === true ||
					stateCleanup?.cause === "selected-state-replacement-preserved";
				keepOwnership = !releaseOwnershipAfterAbsence;
			} else {
				keepOwnership = true;
			}
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_state_write_failed",
				message:
					"The exact target was created but run-scoped selected state could not be committed.",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability:
					cleanup.closed === true && stateCleanup?.removed !== false
						? "repair_state"
						: "none",
				repairHint:
					cleanup.closed === true && stateCleanup?.removed !== false
						? "Repair the private selected-state path before retrying."
						: cleanup.closed !== true
							? "Use targets close with the same handoff; exact state or custody ownership was retained."
							: "Preserve the successor state and inspect local cleanup before any retry.",
				effect: cleanup.closed === true ? "confirmed" : "unknown",
				targetMutated: true,
				targetPresent: cleanup.closed === true ? false : "unknown",
				cleanup,
				...(stateCleanup === undefined
					? {}
					: {
							primaryCause: stateCleanup.cause ?? "selected-state-removed",
							...(stateCleanup.removed
								? {}
								: {
										cleanupDebt: [stateCleanup.cause ?? "state-cleanup-failed"],
									}),
						}),
			});
		}
		keepOwnership = true;
		return successOutcome(handoff.facts.runId, {
			effect: "confirmed",
			target_mutated: true,
			target_present: true,
			adapter: handoff.facts.adapter,
			allowed_origin: url.origin,
			target_candidate_id: targetCandidateId,
			ownership: { kind: "created-target", retained: true },
			retained_lifecycle_confirmed: true,
			command_outcome:
				created === undefined ? "inventory-confirmed" : "adapter-confirmed",
			...(created === undefined
				? { transport_warning: "native-create-output-unconfirmed" }
				: {}),
		});
		})();
	} catch {
		const targetEffectUnknown = createdTargetId !== undefined;
		outcome = failureOutcome(handoff.facts.runId, {
			code: "target_topology_runtime_failed",
			message:
				"An unexpected target-topology dependency failure interrupted open.",
			exitCode: RUNTIME_FAILURE_EXIT_CODE,
			recoverability: "none",
			repairHint: targetEffectUnknown
				? "Inspect the exact run-owned target with targets close; do not repeat open."
				: "Inspect the Browser Use runtime dependency before one bounded retry.",
			effect: targetEffectUnknown ? "unknown" : "not_started",
			targetMutated: targetEffectUnknown ? "unknown" : false,
			...(targetEffectUnknown ? { targetPresent: "unknown" as const } : {}),
		});
	} finally {
		if (targetLease !== undefined && !retainCleanupLease) {
			try {
				const released = await releaseTargetOperationLease(store.deps, targetLease);
				if (released.released_at_epoch_ms === undefined) {
					cleanupDebt.push("target-operation-lease-release-failed");
				} else {
					targetLeaseInterval = {
						acquiredAtEpochMs: targetLease.lease.acquired_at_epoch_ms,
						releasedAtEpochMs: released.released_at_epoch_ms,
					};
				}
			} catch {
				cleanupDebt.push("target-operation-lease-release-failed");
			}
		}
		if (
			!keepOwnership &&
			releaseOwnershipAfterAbsence &&
			createdTargetId !== undefined
		) {
			try {
				const released = await releaseExactTargetOwnership(store.deps, {
					authorityId,
					runId: handoff.facts.runId,
					rawTargetId: createdTargetId,
				});
				if (!released.ok) {
					cleanupDebt.push("target-ownership-release-failed");
				}
			} catch {
				cleanupDebt.push("target-ownership-release-failed");
			}
		}
		try {
			const released = await releaseBrowserLaneLease(
				store.deps,
				browserLane.lease,
			);
			if (released.released_at_epoch_ms === undefined) {
				cleanupDebt.push("browser-lane-release-failed");
			} else {
				browserLaneInterval = {
					acquiredAtEpochMs: browserLane.lease.lease.acquired_at_epoch_ms,
					releasedAtEpochMs: released.released_at_epoch_ms,
				};
			}
		} catch {
			cleanupDebt.push("browser-lane-release-failed");
		}
		if (!keepOwnership && !retainCleanupLease) {
			const lifecycle = await releaseAdapterLifecycle(input, handoff).catch(() => ({
				released: false as const,
				cause: "adapter-lifecycle-release-failed",
			}));
			if (!lifecycle.released) {
				cleanupDebt.push(lifecycle.cause ?? "adapter-lifecycle-release-failed");
			}
		}
	}
	if (
		createdTargetId !== undefined &&
		browserLaneInterval !== undefined &&
		targetLeaseInterval !== undefined
	) {
		outcome = bindTopologySuccessReceipt({
			outcome,
			handoff: handoff.facts,
			origin: url.origin,
			targetRef: targetRefOf(createdTargetId),
			browserLane: browserLaneInterval,
			targetLease: targetLeaseInterval,
		});
	}
	return emitOutcome(input, mergeReleaseDebt(outcome, cleanupDebt));
}


// ---------------------------------------------------------------------------
// Target adoption: retained lifecycle custody for a target this run did not open.
//
// `targets open` was the only way to reach a retained exact-target adapter
// lifecycle, because only a created target ever carried one. That made the
// retained fast lane unreachable for the ordinary case — a page the user
// already has open — so every operation on such a target paid a fresh adapter
// attach, a tab activation, and a session teardown.
//
// Adoption closes that gap WITHOUT weakening custody: it takes the same
// `adopt` Target Lease, supplies the same `explicit-adoption` first-ownership
// evidence the custody owner already admits, and proves the same exact
// canonical identity. What it deliberately does NOT take is the right to close
// the target: this run did not open it, so `targets release` gives the binding
// back and the tab is never touched.
// ---------------------------------------------------------------------------

/**
 * Bind the run-scoped selected target into a retained exact-target lifecycle.
 *
 * @param input - Parsed command, runtime, writers, and run identity
 * @returns Process exit code
 */
export async function runTargetsAdopt(input: TopologyInput): Promise<number> {
	const handoffRead = await readTopologyHandoff(input);
	if (!handoffRead.ok) return emitFailure(input, handoffRead.failure, input.runId);
	const handoff = handoffRead.handoff;
	const resolvedState = await resolveTopologyStatePath(input, handoff.facts.runId);
	if (!resolvedState.ok)
		return emitFailure(input, resolvedState.failure, handoff.facts.runId);
	const statePath = resolvedState.path;
	const loaded = await loadSelectedStateForCleanup(input.runtime, statePath, {
		expectedRunId: handoff.facts.runId,
	});
	if (!loaded.ok) {
		return emitFailure(
			input,
			{
				...preflightFailure(
					loaded.failure.code,
					loaded.failure.message,
					"Select a Browser Target with the same handoff before adopting it.",
				),
				recoverability: loaded.failure.recoverability,
			},
			handoff.facts.runId,
		);
	}
	const selected = loaded.state;
	const selectedRaw = loaded.raw;
	if (selectedRaw === undefined) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_unreadable",
				"The run-scoped selected state could not be read for a compare-and-set write.",
				"Repair the private selected-state path before adopting.",
			),
			handoff.facts.runId,
		);
	}
	if (selected.ownership?.kind === "created-target") {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_mismatch",
				"The selected target was created by this run and already owns its lifecycle.",
				"Use the open-created selection as-is; adoption is only for a target this run did not open.",
			),
			handoff.facts.runId,
		);
	}
	if (
		selected.selected_adapter_id !== handoff.facts.adapter ||
		selected.verified_endpoint_identity !== handoff.facts.verifiedEndpointIdentity ||
		selected.handoff_evidence_id !== handoff.facts.handoffEvidenceId
	) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_mismatch",
				"The selected state does not belong to this exact handoff-bound run.",
				"Reselect the Browser Target with the same verified handoff before adopting it.",
			),
			handoff.facts.runId,
		);
	}
	if (input.parsed.dryRun) {
		return emitSuccess(input, handoff.facts.runId, {
			effect: "not_started",
			target_mutated: false,
			adapter: handoff.facts.adapter,
			planned_effect: "resolve-bind-retain-lifecycle",
			state_path_source:
				stringField(input.parsed.flagValues["--state"]) === undefined
					? "run-scoped-xdg"
					: "explicit",
		});
	}

	// Fresh inventory is the identity source: the selected record holds redacted
	// display facts and a candidate ordinal, never a raw target id, so the exact
	// target is re-derived here and must still resolve to exactly one row.
	const inventory = await listNativeTargets(input, handoff);
	if (inventory === undefined) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_inventory_unavailable",
				"The attached adapter did not return a target inventory to adopt from.",
				"Re-run handoff-bound target discovery before adopting.",
			),
			handoff.facts.runId,
		);
	}
	const pages = nativeTargetPages(inventory);
	const targetEnvelopeId = targetEnvelopeIdOf({
		runId: handoff.facts.runId,
		mode: "handoff-bound",
		adapter: handoff.facts.adapter,
		handoffEvidenceId: handoff.facts.handoffEvidenceId,
	});
	if (targetEnvelopeId !== selected.target_envelope_id) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_mismatch",
				"The selected target envelope does not match this handoff-bound discovery binding.",
				"Re-run handoff-bound target discovery and reselect before adopting.",
			),
			handoff.facts.runId,
		);
	}
	const matches = pages
		.map((page, index) => ({ page, index }))
		.filter(
			({ page, index }) =>
				toCandidate(page, index, targetEnvelopeId, false).candidate_id ===
				selected.target_candidate_id,
		);
	const matched = matches.length === 1 ? matches[0] : undefined;
	if (matched === undefined || matched.page.cdp_target_id === undefined) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_target_mismatch",
				"Fresh discovery did not resolve exactly one target matching the selected candidate.",
				"Re-run handoff-bound target discovery and reselect the Browser Target before adopting.",
			),
			handoff.facts.runId,
		);
	}
	const canonicalTargetId = matched.page.cdp_target_id;
	const rawUrl = matched.page.url ?? "";
	const url = safeUrl(rawUrl);
	if (url === undefined || url.origin !== selected.display.origin) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_target_mismatch",
				"The selected target is no longer on the origin it was selected from.",
				"Reselect the Browser Target; adoption never re-binds across an origin change.",
			),
			handoff.facts.runId,
		);
	}
	if (!BROWSER_USE_CANONICAL_TARGET_ID_PATTERN.test(canonicalTargetId)) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_target_mismatch",
				"The adapter reported an unusable canonical target identity.",
				"Re-run handoff-bound target discovery before adopting.",
			),
			handoff.facts.runId,
		);
	}

	const store = await openCustodyStore(input);
	if (!store.ok) return emitFailure(input, store.failure, handoff.facts.runId);
	const authorityId = browserAuthorityIdOf(handoff.facts);
	const targetRef = targetRefOf(canonicalTargetId);
	let targetLease: TargetOperationLease | undefined;
	// Adoption's first lease registers durable ownership of the target. Close
	// recovery cannot reach it — that path admits `adapter-creation-receipt`
	// ownership only — but a failed adoption should still not leave a claim
	// behind that no state record names, so every path that does not end in a
	// committed adoption hands the ownership back.
	let keepOwnership = false;
	let firstOwnership = false;
	let outcome: TopologyOutcome;
	try {
		const acquired = await acquireTargetOperationLease(store.deps, {
			authorityId,
			runId: handoff.facts.runId,
			adapterId: handoff.facts.adapter,
			rawTargetId: canonicalTargetId,
			operation: "adopt",
			ttlMs: SELECTED_TARGET_STATE_TTL_MS,
			ownershipEvidence: {
				kind: "explicit-adoption",
				adapter_id: handoff.facts.adapter,
				run_id: handoff.facts.runId,
				raw_target_id: canonicalTargetId,
				target_envelope_id: targetEnvelopeId,
				target_candidate_id: selected.target_candidate_id,
				target_candidate_identity: {
					kind: "adapter-page-id",
					raw_adapter_page_id: matched.page.id ?? canonicalTargetId,
				},
			},
		});
		if (!acquired.ok) {
			// No browser mutation has happened yet, so a refused lease leaves the
			// target exactly as it was.
			return emitFailure(
				input,
				{
					...preflightFailure(
						acquired.code,
						acquired.message,
						"Another run may hold this target; inspect custody before adopting it.",
					),
					recoverability: "repair_state",
				},
				handoff.facts.runId,
			);
		}
		targetLease = acquired.lease;
		firstOwnership = acquired.first_ownership;
		const bound = await handoff.capability.run({
			runtime: input.runtime,
			handoff: exactTargetHandoff(handoff.facts),
			action: {
				kind: "bind-lifecycle",
				target_id: canonicalTargetId,
				expected_url: rawUrl,
			},
		});
		if (!bound.ok || bound.kind !== "retain-lifecycle") {
			// The bind sequence selects the tab before it proves the binding, so a
			// refusal may have left the adapter session pointing somewhere. Release
			// it rather than leaving an unnamed session behind, and report the
			// focus side effect honestly.
			const released = await releaseAdapterLifecycle(input, handoff);
			outcome = failureOutcome(handoff.facts.runId, {
				code: "target_topology_create_binding_failed",
				message:
					"The adapter could not retain exact-target lifecycle custody for the selected target.",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability: released.released ? "retry" : "repair_state",
				repairHint: released.released
					? "Reselect the Browser Target and adopt again; no lifecycle was retained."
					: "Inspect the adapter session; a lifecycle binding may still be held.",
				effect: "not_started",
				targetMutated: false,
				targetPresent: true,
				...(released.released
					? {}
					: { cleanupDebt: ["adapter-lifecycle-release-failed"] }),
			});
		} else {
			const persisted = await persistAdoptedSelectedTargetState({
				runtime: input.runtime,
				path: statePath,
				runId: handoff.facts.runId,
				previous: selected,
				previousRaw: selectedRaw,
				targetRef,
				retainedLifecycle: {
					adapter_id: handoff.capability.adapter_id,
					capability_id: handoff.capability.capability_id,
					lifecycle_ref: bound.lifecycle_ref,
				},
			});
			if (!persisted.ok) {
				// The binding is live but nothing durable names it. Give it back
				// rather than stranding a session no later command can release.
				const released = await releaseAdapterLifecycle(input, handoff);
				outcome = failureOutcome(handoff.facts.runId, {
					code: "target_topology_state_write_failed",
					message:
						"The exact target was bound but run-scoped adoption state could not be committed.",
					exitCode: RUNTIME_FAILURE_EXIT_CODE,
					recoverability: released.released ? "repair_state" : "none",
					repairHint: released.released
						? "Repair the private selected-state path, then adopt again."
						: "Inspect the adapter session; a lifecycle binding is held with no durable owner.",
					effect: "not_started",
					targetMutated: false,
					targetPresent: true,
					...(released.released
						? {}
						: { cleanupDebt: ["adapter-lifecycle-release-failed"] }),
				});
			} else {
				keepOwnership = true;
				outcome = successOutcome(handoff.facts.runId, {
					effect: "confirmed",
					// Adoption never creates, navigates, or closes anything. The one
					// observable side effect is that binding the exact tab makes it
					// current, which is reported rather than implied.
					target_mutated: false,
					target_present: true,
					adapter: handoff.facts.adapter,
					allowed_origin: url.origin,
					target_candidate_id: selected.target_candidate_id,
					ownership: { kind: "adopted-target", retained: true },
					retained_lifecycle_confirmed: true,
					focus: true,
					qualification_eligible: false,
				});
			}
		}
	} catch {
		// An unexpected fault leaves the binding effect unknown, so ownership is
		// deliberately retained: `targets release` can still give it back, and
		// retained ownership is what stops close-recovery from treating this
		// target as a stray this run created.
		keepOwnership = true;
		outcome = failureOutcome(handoff.facts.runId, {
			code: "target_topology_runtime_failed",
			message: "An unexpected dependency failure interrupted target adoption.",
			exitCode: RUNTIME_FAILURE_EXIT_CODE,
			recoverability: "none",
			repairHint:
				"Inspect the adapter session and run-scoped state before adopting again; do not repeat blindly.",
			effect: "unknown",
			targetMutated: false,
			targetPresent: "unknown",
			cleanupDebt: ["adoption-effect-unknown"],
		});
	} finally {
		if (!keepOwnership && firstOwnership) {
			await releaseExactTargetOwnershipByRef(store.deps, {
				authorityId,
				runId: handoff.facts.runId,
				targetRef,
			});
		}
		if (targetLease !== undefined) {
			await releaseTargetOperationLease(store.deps, targetLease);
		}
	}
	return emitOutcome(input, outcome);
}

/**
 * Give back a retained lifecycle binding without touching the adopted target.
 *
 * @param input - Parsed command, runtime, writers, and run identity
 * @returns Process exit code
 */
export async function runTargetsRelease(input: TopologyInput): Promise<number> {
	const handoffRead = await readTopologyHandoff(input);
	if (!handoffRead.ok) return emitFailure(input, handoffRead.failure, input.runId);
	const handoff = handoffRead.handoff;
	const resolvedState = await resolveTopologyStatePath(input, handoff.facts.runId);
	if (!resolvedState.ok)
		return emitFailure(input, resolvedState.failure, handoff.facts.runId);
	const statePath = resolvedState.path;
	const loaded = await loadSelectedStateForCleanup(input.runtime, statePath, {
		expectedRunId: handoff.facts.runId,
	});
	if (!loaded.ok) {
		return emitFailure(
			input,
			{
				...preflightFailure(
					loaded.failure.code,
					loaded.failure.message,
					"Restore or repair the exact run-scoped state before releasing.",
				),
				recoverability: loaded.failure.recoverability,
			},
			handoff.facts.runId,
		);
	}
	const selected = loaded.state;
	const selectedRaw = loaded.raw;
	if (selectedRaw === undefined) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_unreadable",
				"The run-scoped selected state could not be read for a compare-and-set write.",
				"Repair the private selected-state path before releasing.",
			),
			handoff.facts.runId,
		);
	}
	if (selected.ownership?.kind !== "adopted-target") {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_mismatch",
				"No adopted target lifecycle is held by this run-scoped selection.",
				selected.ownership?.kind === "created-target"
					? "Use targets close for an open-created target; release only gives back an adopted binding."
					: "Adopt a selected Browser Target before releasing it.",
			),
			handoff.facts.runId,
		);
	}
	if (input.parsed.dryRun) {
		return emitSuccess(input, handoff.facts.runId, {
			effect: "not_started",
			target_mutated: false,
			adapter: handoff.facts.adapter,
			planned_effect: "release-lifecycle-keep-target",
		});
	}
	const store = await openCustodyStore(input);
	if (!store.ok) return emitFailure(input, store.failure, handoff.facts.runId);
	const released = await releaseAdapterLifecycle(input, handoff);
	// The durable record is cleared even when the adapter release is unconfirmed:
	// leaving a state that names a lifecycle nothing can prove would send every
	// later operation down a target-local path with no live session behind it.
	// The unconfirmed release is reported as debt instead.
	const cleared = await persistReleasedSelectedTargetState({
		runtime: input.runtime,
		path: statePath,
		runId: handoff.facts.runId,
		previous: selected,
		previousRaw: selectedRaw,
	});
	if (!cleared.ok) {
		return emitFailure(
			input,
			{
				...preflightFailure(
					"target_topology_state_write_failed",
					"The adopted lifecycle could not be cleared from run-scoped state.",
					"Repair the private selected-state path; the adopted target itself was not touched.",
				),
				recoverability: "repair_state",
				effect: released.released ? "confirmed" : "unknown",
			},
			handoff.facts.runId,
		);
	}
	const ownershipReleased = await releaseExactTargetOwnershipByRef(store.deps, {
		authorityId: browserAuthorityIdOf(handoff.facts),
		runId: handoff.facts.runId,
		targetRef: selected.ownership.target_ref,
	});
	return emitSuccess(input, handoff.facts.runId, {
		effect: released.released ? "confirmed" : "unknown",
		// Release never closes: the adopted target is the user's, and it stays.
		target_mutated: false,
		target_present: true,
		adapter: handoff.facts.adapter,
		lifecycle_released: released.released,
		ownership_released: ownershipReleased.ok === true,
		qualification_eligible: false,
		...(released.released && ownershipReleased.ok === true
			? {}
			: {
					cleanup_debt: [
						...(released.released ? [] : ["adapter-lifecycle-release-failed"]),
						...(ownershipReleased.ok === true
							? []
							: ["target-ownership-release-failed"]),
					],
				}),
	});
}

export async function runTargetsClose(input: TopologyInput): Promise<number> {
	const handoffRead = await readTopologyHandoff(input);
	if (!handoffRead.ok)
		return emitFailure(input, handoffRead.failure, input.runId);
	const handoff = handoffRead.handoff;
	const resolvedState = await resolveTopologyStatePath(
		input,
		handoff.facts.runId,
	);
	if (!resolvedState.ok)
		return emitFailure(input, resolvedState.failure, handoff.facts.runId);
	const statePath = resolvedState.path;
	const loaded = await loadSelectedStateForCleanup(input.runtime, statePath, {
		expectedRunId: handoff.facts.runId,
	});
	if (!loaded.ok && loaded.failure.code !== "target_state_missing") {
		return emitFailure(
			input,
			{
				...preflightFailure(
					loaded.failure.code,
					loaded.failure.message,
					"Restore or repair the exact run-scoped state before closing.",
				),
				recoverability: loaded.failure.recoverability,
			},
			handoff.facts.runId,
		);
	}
	// Close is for a target THIS run opened. An adopted target belongs to the
	// user, so it must never fall through to registry recovery, which would
	// resolve this run's owned target ref and close a tab the run never opened.
	if (loaded.ok && loaded.state.ownership?.kind === "adopted-target") {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_mismatch",
				"The selected target was adopted, not opened by this run, so it must not be closed.",
				"Use targets release to give back the adopted lifecycle; the target itself stays open.",
			),
			handoff.facts.runId,
		);
	}
	const createdState =
		loaded.ok && loaded.state.ownership?.kind === "created-target"
			? loaded.state
			: undefined;
	if (
		createdState !== undefined &&
		(createdState.selected_adapter_id !== handoff.facts.adapter ||
			createdState.verified_endpoint_identity !==
				handoff.facts.verifiedEndpointIdentity ||
			createdState.handoff_evidence_id !== handoff.facts.handoffEvidenceId)
	) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_state_mismatch",
				"The open-created selected state does not belong to this exact handoff-bound run.",
				"Use the matching targets-open state and handoff; do not close another run's target.",
			),
			handoff.facts.runId,
		);
	}
	if (input.parsed.dryRun) {
		if (createdState === undefined) {
			return emitFailure(
				input,
				preflightFailure(
					"target_topology_recovery_owner_unproved",
					"Dry-run close requires an exact open-created selected state; registry recovery is intentionally not mutated or inferred.",
					"Supply the matching state or run non-dry close only when canonical custody recovery is required.",
				),
				handoff.facts.runId,
			);
		}
		return emitSuccess(input, handoff.facts.runId, {
			effect: "not_started",
			target_mutated: false,
			adapter: handoff.facts.adapter,
			planned_effect: "resolve-close-clear-release",
			recovery_mode: false,
			state_path_source:
				stringField(input.parsed.flagValues["--state"]) === undefined
					? "run-scoped-xdg"
					: "explicit",
		});
	}
	const store = await openCustodyStore(input);
	if (!store.ok) return emitFailure(input, store.failure, handoff.facts.runId);
	const authorityId = browserAuthorityIdOf(handoff.facts);
	const recoveryOwners =
		createdState === undefined
			? await ownedTargetRefsForRun(store.deps, {
					authorityId,
					runId: handoff.facts.runId,
					adapterId: handoff.facts.adapter,
				})
			: { ok: true as const, targetRefs: [] as readonly string[] };
	if (!recoveryOwners.ok) {
		return emitFailure(
			input,
			{
				...preflightFailure(
					recoveryOwners.code,
					recoveryOwners.message,
					"Repair the Browser Use custody registry before closing.",
				),
				recoverability: "repair_state",
			},
			handoff.facts.runId,
		);
	}
	const targetRef =
		createdState?.ownership?.target_ref ?? recoveryOwners.targetRefs[0];
	if (
		targetRef === undefined ||
		(createdState === undefined && recoveryOwners.targetRefs.length !== 1)
	) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_recovery_owner_mismatch",
				"Target cleanup requires exactly one adapter-created target still owned by this run.",
				"Inspect the run's adapter-created target ownership before retrying close.",
			),
			handoff.facts.runId,
		);
	}
	const retainedCleanupLease = await retainedTopologyCleanupLeaseForRun(
		store.deps,
		{ authorityId, runId: handoff.facts.runId, targetRef },
	);
	const registryOwnership = await (createdState === undefined
		? hasExactCreatedTargetOwnership
		: hasExactTargetOwnership)(store.deps, {
		authorityId,
		runId: handoff.facts.runId,
		adapterId: handoff.facts.adapter,
		targetRef,
	});
	if (!registryOwnership.ok) {
		return emitFailure(
			input,
			preflightFailure(
				registryOwnership.code,
				registryOwnership.message,
				"Repair exact target custody before retrying close.",
			),
			handoff.facts.runId,
		);
	}
	const registryOwnerPresent = registryOwnership.owned;
	if (createdState !== undefined && !registryOwnerPresent) {
		return emitFailure(
			input,
			preflightFailure(
				"target_topology_recovery_owner_mismatch",
				"The selected target state has no matching exact custody owner for this run.",
				"Repair the selected state or custody registry before retrying close.",
			),
			handoff.facts.runId,
		);
	}
	const targets = await listNativeTargets(input, handoff);
	if (targets === undefined) {
		return releaseLifecycleAndEmit(
			input,
			handoff,
			failureOutcome(
				handoff.facts.runId,
				preflightFailure(
					"target_topology_inventory_unavailable",
					"The adapter could not provide the pre-close target inventory.",
					"Inspect the verified handoff and exact-target adapter dependency before retrying.",
				),
			),
		);
	}
	const matches = targets.filter(
		(target) => targetRefOf(target.canonical_target_id) === targetRef,
	);
	if (matches.length > 1) {
		return releaseLifecycleAndEmit(
			input,
			handoff,
			failureOutcome(
				handoff.facts.runId,
				preflightFailure(
					"target_topology_target_mismatch",
					"Fresh discovery resolved more than one target matching the private created-target ownership reference.",
					"Stop and inspect target ownership; never close an ambiguous or replacement target.",
				),
			),
		);
	}
	if (matches.length === 0) {
		const stateRemoval =
			createdState === undefined
				? { ok: true as const }
				: await removeSelectedTargetStateIfRevision({
						runtime: input.runtime,
						path: statePath,
						runId: handoff.facts.runId,
						expectedRevision: createdState.revision,
						expectedRaw: loaded.ok ? (loaded.raw ?? "") : "",
					});
		const registryRelease =
			!stateRemoval.ok || !registryOwnerPresent
				? { ok: true as const, released: !registryOwnerPresent }
				: await releaseExactTargetOwnershipByRef(store.deps, {
						authorityId,
						runId: handoff.facts.runId,
						targetRef,
					});
			const retainedLeaseRelease =
				!stateRemoval.ok || retainedCleanupLease === undefined
					? { ok: true as const, released: retainedCleanupLease === undefined }
					: await releaseTargetOperationLease(store.deps, retainedCleanupLease)
							.then((released) => ({
								ok: true as const,
								released: released.released_at_epoch_ms !== undefined,
							}))
						.catch(() => ({ ok: false as const, released: false }));
		const localCleanupCauses = [
			stateRemoval.ok ? undefined : "selected-state-remove-failed",
			!stateRemoval.ok ||
			(registryRelease.ok && registryRelease.released === true)
				? undefined
				: "target-ownership-release-failed",
			!stateRemoval.ok ||
			(retainedLeaseRelease.ok && retainedLeaseRelease.released === true)
				? undefined
				: "topology-cleanup-lease-release-failed",
		].filter((cause): cause is string => cause !== undefined);
		const outcome =
			stateRemoval.ok &&
			registryRelease.ok &&
			registryRelease.released === true &&
			retainedLeaseRelease.ok &&
			retainedLeaseRelease.released === true
					? successOutcome(handoff.facts.runId, {
							effect: "not_started",
							target_mutated: false,
							target_present: false,
							adapter: handoff.facts.adapter,
							ownership_released: true,
							already_absent: true,
							qualification_eligible: false,
					})
				: failureOutcome(handoff.facts.runId, {
						code: "target_topology_local_cleanup_failed",
						message:
							"The exact target is already absent, but selected state or target ownership cleanup is unresolved.",
						exitCode: RUNTIME_FAILURE_EXIT_CODE,
						recoverability: "repair_state",
						repairHint:
							"Repair the private selected state and custody registry; do not recreate or re-close the absent target.",
						effect: "confirmed",
						targetMutated: false,
						targetPresent: false,
						cleanup: {
							attempted: true,
							closed: true,
							cause: localCleanupCauses.join("+"),
						},
					});
		return releaseLifecycleAndEmit(input, handoff, outcome);
	}
	const target = matches[0] as NativeTarget;
	const browserLane = await acquireBrowserLaneLease(store.deps, {
		authorityId,
		runId: handoff.facts.runId,
		mutation: "target-topology",
		ttlMs: TOPOLOGY_LEASE_TTL_MS,
	});
	if (!browserLane.ok) {
		return releaseLifecycleAndEmit(
			input,
			handoff,
			failureOutcome(handoff.facts.runId, {
				...preflightFailure(
					browserLane.code,
					browserLane.message,
					"Wait for the existing Browser Lane turn to release, then retry close once.",
				),
				recoverability: "retry",
			}),
		);
	}
	let targetLease: TargetOperationLease | undefined;
	let retainLeaseForRepair = false;
	let outcome: TopologyOutcome;
	const cleanupDebt: string[] = [];
	let browserLaneInterval: TopologyBrowserLaneInterval | undefined;
	let targetLeaseInterval: TopologyTargetLeaseInterval | undefined;
	try {
		outcome = await (async (): Promise<TopologyOutcome> => {
		const acquired =
			retainedCleanupLease === undefined
				? await acquireTargetOperationLease(store.deps, {
						authorityId,
						runId: handoff.facts.runId,
						adapterId: handoff.facts.adapter,
						rawTargetId: target.canonical_target_id,
						operation: "close",
						ttlMs: TOPOLOGY_LEASE_TTL_MS,
						ownershipEvidence: {
							kind: "adapter-creation-receipt",
							adapter_id: handoff.facts.adapter,
							run_id: handoff.facts.runId,
							raw_target_id: target.canonical_target_id,
						},
					})
				: await heartbeatRetainedTopologyCleanupLease(
						store.deps,
						retainedCleanupLease,
						TOPOLOGY_LEASE_TTL_MS,
					);
		if (!acquired.ok) {
			return failureOutcome(handoff.facts.runId, {
				...preflightFailure(
					acquired.code,
					acquired.message,
					"Restore exact target custody before retrying close.",
				),
				recoverability:
					acquired.code === "target_lease_held" ? "retry" : "repair_state",
			});
		}
		targetLease = acquired.lease;
		const cleanup = await exactCleanup(input, handoff, target.canonical_target_id);
		if (cleanup.closed !== true) {
			if (retainedCleanupLease !== undefined) {
				retainLeaseForRepair = true;
			}
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_close_unconfirmed",
				message:
					"The adapter did not independently prove the exact target absent after close.",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability: "none",
				repairHint:
					"Stop and inspect the exact target before any retry; close effect is unknown.",
				effect: "unknown",
				targetMutated: "unknown",
				targetPresent: "unknown",
				cleanup,
			});
		}
		const stateRemoval =
			createdState === undefined
				? { ok: true as const }
				: await removeSelectedTargetStateIfRevision({
						runtime: input.runtime,
						path: statePath,
						runId: handoff.facts.runId,
						expectedRevision: createdState.revision,
						expectedRaw: loaded.ok ? (loaded.raw ?? "") : "",
					});
		const stateRemoved = stateRemoval.ok;
		const ownership =
			!stateRemoved || !registryOwnerPresent
				? { ok: true as const, released: !registryOwnerPresent }
				: await releaseExactTargetOwnership(store.deps, {
						authorityId,
						runId: handoff.facts.runId,
						rawTargetId: target.canonical_target_id,
					});
		if (!stateRemoved && retainedCleanupLease !== undefined) {
			retainLeaseForRepair = true;
		}
		const localCleanupCauses = [
			stateRemoved ? undefined : "selected-state-remove-failed",
			!stateRemoved || (ownership.ok && ownership.released === true)
				? undefined
				: "target-ownership-release-failed",
		].filter((cause): cause is string => cause !== undefined);
		if (!stateRemoved || !ownership.ok || ownership.released !== true) {
			return failureOutcome(handoff.facts.runId, {
				code: "target_topology_local_cleanup_failed",
				message:
					"The exact target is confirmed closed, but selected state or target ownership cleanup is unresolved.",
				exitCode: RUNTIME_FAILURE_EXIT_CODE,
				recoverability: "repair_state",
				repairHint:
					"Repair the private selected state and custody registry; do not re-close the absent target.",
				effect: "confirmed",
				targetMutated: true,
				targetPresent: false,
				cleanup: {
					attempted: true,
					closed: true,
					cause: localCleanupCauses.join("+"),
				},
			});
		}
		return successOutcome(handoff.facts.runId, {
			effect: "confirmed",
			target_mutated: true,
			target_present: false,
			adapter: handoff.facts.adapter,
			ownership_released: true,
			command_outcome:
				cleanup.cause === undefined
					? "adapter-confirmed"
					: "inventory-confirmed",
			...(cleanup.cause === undefined
				? {}
				: { transport_warning: cleanup.cause }),
		});
		})();
	} catch {
		if (retainedCleanupLease !== undefined) retainLeaseForRepair = true;
		outcome = failureOutcome(handoff.facts.runId, {
			code: "target_topology_runtime_failed",
			message:
				"An unexpected target-topology dependency failure interrupted close.",
			exitCode: RUNTIME_FAILURE_EXIT_CODE,
			recoverability: "none",
			repairHint:
				"Inspect the exact run-owned target with targets close; do not repeat an unproved browser mutation.",
			effect: targetLease === undefined ? "not_started" : "unknown",
			targetMutated: targetLease === undefined ? false : "unknown",
			...(targetLease === undefined ? {} : { targetPresent: "unknown" as const }),
		});
	} finally {
		if (targetLease !== undefined && !retainLeaseForRepair) {
			try {
				const released = await releaseTargetOperationLease(store.deps, targetLease);
				if (released.released_at_epoch_ms === undefined) {
					cleanupDebt.push("target-operation-lease-release-failed");
				} else {
					targetLeaseInterval = {
						acquiredAtEpochMs: targetLease.lease.acquired_at_epoch_ms,
						releasedAtEpochMs: released.released_at_epoch_ms,
					};
				}
			} catch {
				cleanupDebt.push("target-operation-lease-release-failed");
			}
		}
		try {
			const released = await releaseBrowserLaneLease(
				store.deps,
				browserLane.lease,
			);
			if (released.released_at_epoch_ms === undefined) {
				cleanupDebt.push("browser-lane-release-failed");
			} else {
				browserLaneInterval = {
					acquiredAtEpochMs: browserLane.lease.lease.acquired_at_epoch_ms,
					releasedAtEpochMs: released.released_at_epoch_ms,
				};
			}
		} catch {
			cleanupDebt.push("browser-lane-release-failed");
		}
		const lifecycle = await releaseAdapterLifecycle(input, handoff).catch(() => ({
			released: false as const,
			cause: "adapter-lifecycle-release-failed",
		}));
		if (!lifecycle.released) {
			cleanupDebt.push(lifecycle.cause ?? "adapter-lifecycle-release-failed");
		}
	}
	if (
		browserLaneInterval !== undefined &&
		targetLeaseInterval !== undefined
	) {
		outcome = bindTopologySuccessReceipt({
			outcome,
			handoff: handoff.facts,
			origin:
				createdState?.display.origin ??
				parseUrlSafe(target.url)?.origin ??
				"unknown://origin",
			targetRef,
			browserLane: browserLaneInterval,
			targetLease: targetLeaseInterval,
		});
	}
	return emitOutcome(input, mergeReleaseDebt(outcome, cleanupDebt));
}
