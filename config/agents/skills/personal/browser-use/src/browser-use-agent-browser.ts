import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
	AdapterSessionReleaseDebt,
} from "@side-quest/browser-connect/adapters";
import type { BrowserConnectHandoffPayload } from "@side-quest/browser-connect/contract";
import { emitCliDiagnostic } from "@side-quest/cli-command-facade";
import { TRANSPORT_STDIN_MAX_BYTES } from "@side-quest/mcporter-transport";
import type { BrowserUseItemBinding } from "./browser-use-auth-bindings";
import type { BrowserUseAuthMethodStep } from "./browser-use-auth-model";
import type {
	BrowserUseAccessibilitySnapshot,
	BrowserUseCdpObserver,
} from "./browser-use-cdp-observer";
import {
	type BrowserUseDeliveryHook,
	type BrowserUseDeliveryResumeDirective,
	type BrowserUseTargetReproof,
	type BrowserUseVerifiedTarget,
	deliverConfidentialFields,
} from "./browser-use-confidential-field-delivery";
import type {
	BrowserUseOpCredentialField,
	BrowserUseTokenRetrievalPort,
} from "./browser-use-op";
import type { BrowserUseDeliveredFieldShape } from "./browser-use-secret-scan";
import type {
	McporterCommandInput,
	McporterCommandResult,
} from "./mcporter-transport";
import { deriveSessionName } from "./browser-use-adapter-session-lease";
import { releaseAgentBrowserSession } from "./browser-use-agent-browser-session";
import {
	projectAgentBrowserSnapshotRefs,
	resolveUniqueSemanticRef,
	semanticClickInputIsValid,
} from "./browser-use-agent-browser-semantics";
import {
	agentBrowserAllowedOriginSet,
	agentBrowserHasExactOrigin,
	agentBrowserOriginIsAllowed,
	neutralTargetIsAllowed,
	reproveAgentBrowserOrigin,
	resolveAgentBrowserTarget,
	selectAgentBrowserTarget,
	verifyAgentBrowserPostcondition,
} from "./browser-use-agent-browser-native";
import {
	SAFE_BATCH_ITEM_KEY,
	SAFE_RUN_ID,
	SAFE_TAB_ID,
} from "./browser-use-identifiers";
import { safeJsonObject, isJsonObject, type RawPage } from "./browser-use-core";
import {
	BROWSER_USE_TARGET_OPERATION_MAX_EVIDENCE_BYTES,
	buildBrowserUseStorybookDocumentDiagnostic,
	parseBrowserUseTargetOperationEvidence,
	targetOperationPlanMatchesBoundOrigin,
} from "./browser-use-target-operations";
import type {
	BrowserUseTargetOperationAdapterRequest,
	BrowserUseTargetOperationBaseline,
	BrowserUseTargetOperationCleanupEvidence,
	BrowserUseTargetOperationCleanupMethod,
	BrowserUseTargetOperationFailureDetail,
	BrowserUseTargetOperationInspectStepV2,
	BrowserUseTargetOperationInspectStepV3,
	BrowserUseTargetOperationResult,
	BrowserUseTargetOperationStepOutcome,
} from "./browser-use-target-operations";

const HANDOFF_CONTRACT_ID = "browser-connect.verified-handoff";
const HANDOFF_SCHEMA_VERSION = "2";

// Each delivered credential field maps onto exactly one sensitive-interval
// method step (R15): a successful field delivery is the lane's evidence that
// the auth transaction's FSM may record that method-step-complete event.
const METHOD_STEP_BY_FIELD: Readonly<
	Record<BrowserUseOpCredentialField, BrowserUseAuthMethodStep>
> = {
	username: "fill-username",
	password: "fill-password",
	"otp-current": "fill-otp",
};
const COMMAND_TIMEOUT_MS = 30_000;
const STORYBOOK_TERMINAL_READINESS_TIMEOUT_MS = COMMAND_TIMEOUT_MS - 5_000;
const STORYBOOK_TERMINAL_READINESS_SELECTOR =
	'[data-path-parity-catalogue-version][data-path-parity-interactions-ready="true"][data-path-parity-play-status="complete"],[data-path-parity-catalogue-version][data-path-parity-play-status="failed"],body.sb-show-nopreview,body.sb-show-errordisplay';
const SAFE_REF = /^@e[1-9][0-9]*$/;

/** Adapter-owned proof that one retained session is the exact run session. */
export function isAgentBrowserPinnedSessionForRun(
	sessionName: string | undefined,
	runId: string,
): boolean {
	return sessionName !== undefined && sessionName === deriveSessionName(runId);
}

export type AgentBrowserTopologyTab = {
	tabId: string;
	targetId: string;
	url: string;
	title?: string;
	active?: boolean;
};

export type AgentBrowserTopologyAction =
	| { kind: "list" }
	| { kind: "create"; url: string }
	| { kind: "close"; targetId: string }
	| { kind: "pin"; targetId: string; expectedUrl: string }
	| { kind: "bind"; targetId: string; expectedUrl: string };

export type AgentBrowserTopologyResult =
	| { ok: true; kind: "list"; tabs: readonly AgentBrowserTopologyTab[] }
	| { ok: true; kind: "create"; data: Record<string, unknown> }
	| { ok: true; kind: "close"; confirmed: true }
	| { ok: true; kind: "pin"; sessionName: string }
	| { ok: false; code: "agent_browser_topology_unconfirmed" };

export type AgentBrowserOperationRequest = {
	runtime: AgentBrowserExecutionRuntime;
	env: Record<string, string | undefined>;
	handoff: {
		probeExecutable: string;
		endpointWs: string;
		runId: string;
	};
	targetId: string;
	expectedUrl?: string;
	operation: "snapshot" | "screenshot";
	screenshot?: { path?: string; fullPage?: boolean };
	targetPrepared: boolean;
	retainSession: boolean;
};

export type AgentBrowserOperationResult =
	| {
			ok: true;
			result: McporterCommandResult;
			focus: boolean;
			release?: AdapterSessionReleaseDebt;
	  }
	| {
			ok: false;
			code:
				| "agent_browser_operation_identifiers_unsafe"
				| "agent_browser_operation_dependency_missing"
				| "agent_browser_operation_timeout"
				| "agent_browser_operation_failed";
			message: string;
			focus: boolean;
			release?: AdapterSessionReleaseDebt;
	  };

export type AgentBrowserDiscoveryResult =
	| { ok: true; pages: RawPage[]; release?: AdapterSessionReleaseDebt }
	| {
			ok: false;
			code: "unsafe-run-id" | "dependency-missing" | "timeout" | "transport-failed";
			release?: AdapterSessionReleaseDebt;
	  };

/** Canonical Agent Browser discovery argv, envelope parsing, and session release. */
export async function discoverAgentBrowserPages(input: {
	runtime: Pick<AgentBrowserExecutionRuntime, "runCommand">;
	env: Record<string, string | undefined>;
	handoff: { probeExecutable: string; endpointWs: string; runId: string };
	retainSession: boolean;
}): Promise<AgentBrowserDiscoveryResult> {
	if (!SAFE_RUN_ID.test(input.handoff.runId)) {
		return { ok: false, code: "unsafe-run-id" };
	}
	let outcome: AgentBrowserDiscoveryResult;
	try {
		const result = await input.runtime.runCommand({
			command: input.handoff.probeExecutable,
			args: [
				"--cdp",
				input.handoff.endpointWs,
				"--session",
				deriveSessionName(input.handoff.runId),
				...(input.retainSession ? ["--pin-tab"] : []),
				"tab",
				"list",
				"--json",
			],
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
		if (result.timedOut === true) outcome = { ok: false, code: "timeout" };
		else if (result.exitCode !== 0) outcome = { ok: false, code: "transport-failed" };
		else {
			const envelope = safeJsonObject(result.stdout);
			const data = envelope?.success === true && isJsonObject(envelope.data)
				? envelope.data
				: undefined;
			if (!data || !Array.isArray(data.tabs)) {
				outcome = { ok: false, code: "transport-failed" };
			} else {
				const pages: RawPage[] = [];
				for (const rawTab of data.tabs) {
					const tab = isJsonObject(rawTab) ? rawTab : undefined;
					if (!tab) continue;
					pages.push({
						...(typeof tab.tabId === "string" ? { id: tab.tabId } : {}),
						...(typeof tab.targetId === "string" ? { cdp_target_id: tab.targetId } : {}),
						...(typeof tab.url === "string" ? { url: tab.url } : {}),
						...(typeof tab.title === "string" ? { title: tab.title } : {}),
						...(typeof tab.type === "string" ? { type: tab.type } : {}),
					});
				}
				outcome = { ok: true, pages };
			}
		}
	} catch {
		outcome = { ok: false, code: "dependency-missing" };
	}
	if (input.retainSession) return outcome;
	const release = await releaseAgentBrowserSession({
		env: input.env,
		runCommand: input.runtime.runCommand,
		probeExecutable: input.handoff.probeExecutable,
		runId: input.handoff.runId,
	});
	return release.released ? outcome : { ...outcome, release };
}

function topologyNativeData(result: McporterCommandResult): Record<string, unknown> | undefined {
	if (result.exitCode !== 0 || result.timedOut === true) return undefined;
	const envelope = safeJsonObject(result.stdout);
	return envelope?.success === true && isJsonObject(envelope.data)
		? envelope.data
		: undefined;
}

type AgentBrowserTopologyNativeFailureClass =
	| "cdp-connection-failed"
	| "daemon-unavailable"
	| "session-invalid"
	| "tab-gone"
	| "target-connection-refused"
	| "unclassified";

const AGENT_BROWSER_TOPOLOGY_ERROR_TERMS = [
	"browser",
	"cdp",
	"closed",
	"connect",
	"daemon",
	"endpoint",
	"invalid",
	"launch",
	"page",
	"protocol",
	"refused",
	"renderer",
	"session",
	"socket",
	"tab",
	"target",
	"timeout",
	"websocket",
] as const;

function nativeEnvelopeError(raw: string): string | undefined {
	const envelope = safeJsonObject(raw);
	return typeof envelope?.error === "string" ? envelope.error : undefined;
}

function exactHref(value: string): string | undefined {
	try {
		return new URL(value).href;
	} catch {
		return undefined;
	}
}

function exactOrigin(value: string): string | undefined {
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

/** Sanitized identity of one adapter tab: the id pair, never the URL. */
type AgentBrowserTabIdentity = {
	readonly tabId: string;
	readonly targetId: string;
};

type CurrentTabResolution =
	| { ok: true; identity: AgentBrowserTabIdentity }
	| { ok: false; reason: "current-tab-ambiguous" | "current-tab-unconfirmed" };

/**
 * Name the one tab an inventory reports as current.
 *
 * Identity is the (tabId, targetId) pair. The URL is deliberately not consulted
 * here: a page can rewrite its own URL the moment it loads, so a URL match is a
 * race, not an identity.
 */
function resolveCurrentTab(
	tabs: readonly AgentBrowserTopologyTab[],
): CurrentTabResolution {
	const active = tabs.filter((tab) => tab.active === true);
	if (active.length > 1) return { ok: false, reason: "current-tab-ambiguous" };
	const current = active[0];
	if (current === undefined) {
		return { ok: false, reason: "current-tab-unconfirmed" };
	}
	return {
		ok: true,
		identity: { tabId: current.tabId, targetId: current.targetId },
	};
}

function topologyCleanupRunId(runId: string): string {
	return `topology-cleanup-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

/**
 * A CDP transport fault names the protocol or its socket. The bare term
 * `connect` does not: a refused navigation to the requested target origin
 * carries it too, so `connect` alone must never imply CDP.
 */
function isCdpTransportError(error: string | undefined): boolean {
	return (
		error !== undefined &&
		(error.includes("cdp") ||
			error.includes("devtools") ||
			error.includes("websocket"))
	);
}

function isConnectionRefusedError(error: string | undefined): boolean {
	return (
		error !== undefined &&
		(error.includes("econnrefused") || error.includes("connection refused"))
	);
}

function cdpEndpointAuthority(endpointWs: string): string | undefined {
	try {
		return new URL(endpointWs).host.toLowerCase();
	} catch {
		return undefined;
	}
}

function classifyTargetTopologyNativeFailure(
	result: McporterCommandResult,
	cdpAuthority?: string,
): {
	failureClass: AgentBrowserTopologyNativeFailureClass;
	errorTerms: readonly string[];
} {
	const rawValues = [result.stdout, result.stderr];
	if (rawValues.some((raw) => nativeEnvelopeCode(raw) === "tab_gone")) {
		return { failureClass: "tab-gone", errorTerms: ["tab", "target"] };
	}
	const error = rawValues
		.map(nativeEnvelopeError)
		.find((value): value is string => value !== undefined)
		?.toLowerCase();
	const errorTerms = error === undefined
		? []
		: AGENT_BROWSER_TOPOLOGY_ERROR_TERMS.filter((term) => error.includes(term));
	if (error?.includes("session") && error.includes("invalid")) {
		return { failureClass: "session-invalid", errorTerms };
	}
	if (error?.includes("daemon") || error?.includes("socket")) {
		return { failureClass: "daemon-unavailable", errorTerms };
	}
	if (isCdpTransportError(error)) {
		return { failureClass: "cdp-connection-failed", errorTerms };
	}
	if (isConnectionRefusedError(error)) {
		// A refusal naming the verified CDP authority is a transport fault. Any
		// other authority is the requested target origin refusing the load, and
		// belongs to the target, not to Browser Connect.
		return {
			failureClass:
				cdpAuthority !== undefined && error?.includes(cdpAuthority)
					? "cdp-connection-failed"
					: "target-connection-refused",
			errorTerms,
		};
	}
	return { failureClass: "unclassified", errorTerms };
}

function emitTargetTopologyFailure(
	action: AgentBrowserTopologyAction["kind"],
	phase: "native-command" | "native-envelope" | "inventory",
	reason:
		| "command-failed"
		| "current-tab-ambiguous"
		| "current-tab-identity-drift"
		| "current-tab-origin-mismatch"
		| "current-tab-ref-changed"
		| "current-tab-unconfirmed"
		| "dependency-failed"
		| "invalid-envelope"
		| "invalid-page-row"
		| "missing-tabs"
		| "session-release-failed"
		| "timed-out",
	nativeFailureClass?: AgentBrowserTopologyNativeFailureClass,
	nativeErrorTerms: readonly string[] = [],
): void {
	emitCliDiagnostic(
		["browser-use.cli", "agent-browser"],
		"debug",
		"target-topology-unconfirmed",
		{
			action_kind: action,
			operation_phase: phase,
			failure_class: reason,
			...(nativeFailureClass === undefined
				? {}
				: { native_failure_class: nativeFailureClass }),
			...(nativeErrorTerms.length === 0
				? {}
				: { native_error_terms: nativeErrorTerms }),
		},
	);
}

/**
 * Record that the fallback adoption bound the target.
 *
 * Emitted only from the fallback success branch, after identity and origin are
 * proven, so its presence is the signal and its absence means the native create
 * already carried its own binding. Debug stderr only: the machine result is
 * unchanged, and the payload is a bounded vocabulary carrying no url, id,
 * session name, or endpoint.
 */
function emitTargetTopologyFallbackAdoption(
	action: AgentBrowserTopologyAction["kind"],
): void {
	emitCliDiagnostic(
		["browser-use.cli", "agent-browser"],
		"debug",
		"target-topology-fallback-adopted",
		{ action_kind: action, operation_phase: "inventory" },
	);
}

function parseAgentBrowserTopologyTabs(
	action: AgentBrowserTopologyAction["kind"],
	data: Record<string, unknown>,
): readonly AgentBrowserTopologyTab[] | undefined {
	if (!Array.isArray(data.tabs)) {
		emitTargetTopologyFailure(action, "inventory", "missing-tabs");
		return undefined;
	}
	const tabs: AgentBrowserTopologyTab[] = [];
	const targetIds = new Set<string>();
	for (const raw of data.tabs) {
		const tab = isJsonObject(raw) ? raw : undefined;
		if (
			!tab ||
			typeof tab.tabId !== "string" ||
			typeof tab.targetId !== "string" ||
			typeof tab.url !== "string" ||
			!SAFE_TAB_ID.test(tab.tabId) ||
			!SAFE_TAB_ID.test(tab.targetId) ||
			targetIds.has(tab.targetId)
		) {
			emitTargetTopologyFailure(action, "inventory", "invalid-page-row");
			return undefined;
		}
		targetIds.add(tab.targetId);
		tabs.push({
			tabId: tab.tabId,
			targetId: tab.targetId,
			url: tab.url,
			...(typeof tab.title === "string" ? { title: tab.title } : {}),
			...(typeof tab.active === "boolean" ? { active: tab.active } : {}),
		});
	}
	return tabs;
}

/**
 * Canonical Agent Browser target-topology mechanics. Browser Use topology owns
 * policy and custody; this adapter module alone owns native argv, parsing,
 * pinning, and session addressing.
 */
export async function runAgentBrowserTargetTopology(input: {
	runtime: AgentBrowserExecutionRuntime;
	handoff: { probeExecutable: string; endpointWs: string; runId: string };
	action: AgentBrowserTopologyAction;
}): Promise<AgentBrowserTopologyResult> {
	const usesCleanupSession =
		input.action.kind === "list" || input.action.kind === "close";
	const sessionRunId = usesCleanupSession
		? topologyCleanupRunId(input.handoff.runId)
		: input.handoff.runId;
	const sessionName = deriveSessionName(sessionRunId);
	let cleanupRuntimeDir: string | undefined;
	if (usesCleanupSession) {
		try {
			const baseDirectory = process.platform === "win32" ? tmpdir() : "/tmp";
			cleanupRuntimeDir = await mkdtemp(join(baseDirectory, "browser-use-topology-"));
			await chmod(cleanupRuntimeDir, 0o700);
		} catch {
			emitTargetTopologyFailure(input.action.kind, "native-command", "dependency-failed");
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
	}
	const invoke = async (args: readonly string[]) => {
		let data: Record<string, unknown> | undefined;
		try {
			const result = await input.runtime.runCommand({
					command: input.handoff.probeExecutable,
					args: ["--cdp", input.handoff.endpointWs, "--session", sessionName, ...args],
					env:
						cleanupRuntimeDir === undefined
							? undefined
							: {
									AGENT_BROWSER_SOCKET_DIR: cleanupRuntimeDir,
									MCPORTER_NO_KEEPALIVE: "*",
								},
					timeoutMs: COMMAND_TIMEOUT_MS,
				});
			if (result.timedOut === true) {
				emitTargetTopologyFailure(input.action.kind, "native-command", "timed-out");
			} else if (result.exitCode !== 0) {
				const failure = classifyTargetTopologyNativeFailure(
					result,
					cdpEndpointAuthority(input.handoff.endpointWs),
				);
				emitTargetTopologyFailure(
					input.action.kind,
					"native-command",
					"command-failed",
					failure.failureClass,
					failure.errorTerms,
				);
			} else {
				data = topologyNativeData(result);
				if (data === undefined) {
					emitTargetTopologyFailure(
						input.action.kind,
						"native-envelope",
						"invalid-envelope",
					);
				}
			}
		} catch {
			emitTargetTopologyFailure(input.action.kind, "native-command", "dependency-failed");
		}
		if (usesCleanupSession) {
			const release = await releaseAgentBrowserSession({
				env: { AGENT_BROWSER_SOCKET_DIR: cleanupRuntimeDir },
				runCommand: input.runtime.runCommand,
				probeExecutable: input.handoff.probeExecutable,
				runId: sessionRunId,
			}).catch(() => ({ released: false as const }));
			if (!release.released) {
				emitTargetTopologyFailure(
					input.action.kind,
					"native-command",
					"session-release-failed",
				);
				return undefined;
			}
			try {
				await rm(cleanupRuntimeDir as string, { recursive: true, force: true });
			} catch {
				emitTargetTopologyFailure(
					input.action.kind,
					"native-command",
					"session-release-failed",
				);
				return undefined;
			}
		}
		return data;
	};

	// `bind` retains lifecycle custody of a target this run did NOT create.
	//
	// It is deliberately a THREE-call sequence, and the order is the contract:
	//
	//   1. UNPINNED `tab <targetId>`  — a pinned session with no binding opens a
	//      fresh tab instead of adopting an existing one, so the exact tab must
	//      be selected before the binding is made strict.
	//   2. PINNED `tab list`          — proves the strict binding landed on the
	//      exact canonical target and nothing else is current.
	//   3. PINNED `get url`           — proves the bound tab is still the exact
	//      expected page.
	//
	// Identity is proven before content: a wrong-tab binding is refused at step
	// 2, before any page read. `pin` (post-create) keeps its own single-read
	// shape; this action never reuses it, because a created target's session is
	// already bound and an adopted target's session is not.
	if (input.action.kind === "bind") {
		const selected = await invoke(["tab", input.action.targetId, "--json"]);
		if (selected === undefined) {
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		const inventory = await invoke(["--pin-tab", "tab", "list", "--json"]);
		if (inventory === undefined) {
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		const boundTabs = parseAgentBrowserTopologyTabs(input.action.kind, inventory);
		if (boundTabs === undefined) {
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		const current = resolveCurrentTab(boundTabs);
		if (!current.ok) {
			emitTargetTopologyFailure(input.action.kind, "inventory", current.reason);
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		if (current.identity.targetId !== input.action.targetId) {
			emitTargetTopologyFailure(
				input.action.kind,
				"inventory",
				"current-tab-identity-drift",
			);
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		const urlData = await invoke(["--pin-tab", "get", "url", "--json"]);
		if (urlData === undefined) {
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		const observed =
			typeof urlData.url === "string" ? exactHref(urlData.url) : undefined;
		if (observed === undefined || observed !== exactHref(input.action.expectedUrl)) {
			emitTargetTopologyFailure(
				input.action.kind,
				"inventory",
				"current-tab-origin-mismatch",
			);
			return { ok: false, code: "agent_browser_topology_unconfirmed" };
		}
		return { ok: true, kind: "pin", sessionName };
	}

	const nativeArgs =
		input.action.kind === "list"
			? ["tab", "list", "--json"]
			: input.action.kind === "create"
				? ["--pin-tab", "tab", "new", input.action.url, "--json"]
				: input.action.kind === "close"
					? ["tab", "close", input.action.targetId, "--json"]
					: ["--pin-tab", "get", "url", "--json"];
	const data = await invoke(nativeArgs);
	if (data === undefined) return { ok: false, code: "agent_browser_topology_unconfirmed" };
	if (input.action.kind === "create") {
		let targetId =
			typeof data.targetId === "string" && SAFE_TAB_ID.test(data.targetId)
				? data.targetId
				: undefined;
		if (targetId === undefined) {
			// A receiptless create must still name exactly which tab it acted on.
			// Identity is carried as the (tabId, targetId) pair through
			// adopt-then-pin on ONE session:
			//
			//   step 1  unpinned `tab list` -> the session names the current tab
			//   step 2  pinned   `tab list` -> the same session makes it strict
			//
			// The URL is never the identity. A page can rewrite its own URL the
			// instant it loads, so comparing hrefs loses the tab the open just
			// acted on. The requested ORIGIN is still checked, as the minimal
			// tie between the adopted tab and the request that survives a
			// same-origin rewrite.
			const expectedOrigin = exactOrigin(input.action.url);
			if (expectedOrigin === undefined) {
				emitTargetTopologyFailure(
					input.action.kind,
					"inventory",
					"current-tab-unconfirmed",
				);
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const adoptedInventory = await invoke(["tab", "list", "--json"]);
			if (adoptedInventory === undefined) {
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const adoptedTabs = parseAgentBrowserTopologyTabs(
				input.action.kind,
				adoptedInventory,
			);
			if (adoptedTabs === undefined) {
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const adopted = resolveCurrentTab(adoptedTabs);
			if (!adopted.ok) {
				emitTargetTopologyFailure(
					input.action.kind,
					"inventory",
					adopted.reason,
				);
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const pinnedInventory = await invoke(["--pin-tab", "tab", "list", "--json"]);
			if (pinnedInventory === undefined) {
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const pinnedTabs = parseAgentBrowserTopologyTabs(
				input.action.kind,
				pinnedInventory,
			);
			if (pinnedTabs === undefined) {
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const pinned = resolveCurrentTab(pinnedTabs);
			if (!pinned.ok) {
				emitTargetTopologyFailure(input.action.kind, "inventory", pinned.reason);
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			// A changed canonical target id means the session moved to another
			// tab. An equal target id under a changed tab reference means the
			// adapter re-derived its handle, which is not the same binding.
			if (pinned.identity.targetId !== adopted.identity.targetId) {
				emitTargetTopologyFailure(
					input.action.kind,
					"inventory",
					"current-tab-identity-drift",
				);
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			if (pinned.identity.tabId !== adopted.identity.tabId) {
				emitTargetTopologyFailure(
					input.action.kind,
					"inventory",
					"current-tab-ref-changed",
				);
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			const confirmed = pinnedTabs.find(
				(tab) => tab.targetId === pinned.identity.targetId,
			);
			if (
				confirmed === undefined ||
				exactOrigin(confirmed.url) !== expectedOrigin
			) {
				emitTargetTopologyFailure(
					input.action.kind,
					"inventory",
					"current-tab-origin-mismatch",
				);
				return { ok: false, code: "agent_browser_topology_unconfirmed" };
			}
			emitTargetTopologyFallbackAdoption(input.action.kind);
			targetId = pinned.identity.targetId;
		}
		return {
			ok: true,
			kind: "create",
			data: { ...data, targetId, targetDisposition: "adopted-current" },
		};
	}
	if (input.action.kind === "close") return { ok: true, kind: "close", confirmed: true };
	if (input.action.kind === "pin") {
		const observed = typeof data.url === "string" ? exactHref(data.url) : undefined;
		const expected = exactHref(input.action.expectedUrl);
		return observed !== undefined && observed === expected
			? { ok: true, kind: "pin", sessionName }
			: { ok: false, code: "agent_browser_topology_unconfirmed" };
	}
	const tabs = parseAgentBrowserTopologyTabs(input.action.kind, data);
	if (tabs === undefined)
		return { ok: false, code: "agent_browser_topology_unconfirmed" };
	return { ok: true, kind: "list", tabs };
}

function targetPlanFailure(
	request: BrowserUseTargetOperationAdapterRequest,
	code:
		| "target_operation_plan_failed"
		| "target_operation_plan_unsupported"
		| "target_operation_cleanup_incomplete"
		| "target_operation_origin_mismatch"
		| "target_operation_evidence_invalid"
		| "target_operation_evidence_truncated",
	message: string,
	steps: readonly BrowserUseTargetOperationStepOutcome[] = [],
	cleanup = { attempted: false, closed: false, visible_owned_surface_count: 0 },
	failureDetail?: BrowserUseTargetOperationFailureDetail,
): BrowserUseTargetOperationResult {
	return {
		ok: false,
		code,
		message,
		scope: "target-local",
		focus: false,
		capability_id: "agent-browser.exact-target-no-focus.v1",
		plan_schema_version: request.plan.schema_version,
		plan_digest: request.plan_digest,
		plan_step_count: request.plan.steps.length,
		steps,
		cleanup,
		...(failureDetail === undefined ? {} : { failure_detail: failureDetail }),
	};
}

function targetEvidenceFailureAtStep(
	index: number,
	detail: BrowserUseTargetOperationFailureDetail,
): BrowserUseTargetOperationFailureDetail {
	return {
		reason: detail.reason,
		pointer: `/steps/${index}/inspect${detail.pointer}`,
	};
}

function postReadinessFailureAtStep(
	index: number,
	reason: "target_custody_failed" | "exact_target_proof_failed",
	proofReason?: Exclude<AgentBrowserExactTargetProofReason, "initial_active_target_attribution_failed">,
): BrowserUseTargetOperationFailureDetail {
	return {
		reason,
		pointer: reason === "target_custody_failed"
			? `/steps/${index}/inspect/post-readiness`
			: `/steps/${index}/inspect/post-readiness/${proofReason ?? "url_read_failed"}`,
	};
}

type AgentBrowserPlayStatusClassification =
	| "complete"
	| "running"
	| "failed"
	| "missing"
	| "invalid";
type AgentBrowserPlaySettlementClassification =
	| "sufficient"
	| "insufficient"
	| "missing"
	| "invalid";
type AgentBrowserPlayOverlayClassification = "zero" | "nonzero" | "missing" | "invalid";
type AgentBrowserReadinessWaitClassification =
	| "confirmed"
	| "timed-out"
	| "failed"
	| "unavailable";
type AgentBrowserPlayCheckpointClassification = number | "missing" | "invalid";

const AGENT_BROWSER_PLAY_STATUS_VALUES = ["complete", "running", "failed"] as const;

function classifyPlayStatus(value: unknown): AgentBrowserPlayStatusClassification {
	if (value === undefined || value === null || value === "missing") return "missing";
	return typeof value === "string" && (AGENT_BROWSER_PLAY_STATUS_VALUES as readonly string[]).includes(value)
		? value as AgentBrowserPlayStatusClassification
		: "invalid";
}

function classifyPlaySettlementFrames(value: unknown): AgentBrowserPlaySettlementClassification {
	if (value === undefined || value === null) return "missing";
	if (!Number.isSafeInteger(value) || (value as number) < 0) return "invalid";
	return (value as number) >= 2 ? "sufficient" : "insufficient";
}

function classifyPlayVisibleOwnedOverlays(value: unknown): AgentBrowserPlayOverlayClassification {
	if (value === undefined || value === null) return "missing";
	if (!Number.isSafeInteger(value) || (value as number) < 0) return "invalid";
	return value === 0 ? "zero" : "nonzero";
}

function classifyReadinessWait(
	readinessWait: AgentBrowserNativeResult | undefined,
): AgentBrowserReadinessWaitClassification {
	if (readinessWait === undefined) return "unavailable";
	if (readinessWait.ok) return "confirmed";
	return readinessWait.timed_out === true ? "timed-out" : "failed";
}

function classifyPlayCheckpoint(value: unknown): AgentBrowserPlayCheckpointClassification {
	if (value === undefined || value === null || value === "missing") return "missing";
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 255) return "invalid";
	return value as number;
}

function emitPlayReadinessFailureDiagnostic(
	value: unknown,
	index: number,
	readinessWait: AgentBrowserNativeResult | undefined,
	checkpoint: unknown,
): void {
	const evidence = isJsonObject(value) ? value : undefined;
	const rawPlayReadiness = evidence?.play_readiness;
	const playReadiness = isJsonObject(rawPlayReadiness) ? rawPlayReadiness : undefined;
	emitCliDiagnostic(
		["browser-use.cli", "agent-browser"],
		"error",
		"target-plan-play-readiness-failed",
		{
			operation_phase: "target-plan",
			step_index: index,
			step_kind: "inspect",
			play_status: rawPlayReadiness !== undefined && rawPlayReadiness !== null && !isJsonObject(rawPlayReadiness)
				? "invalid"
				: classifyPlayStatus(playReadiness?.status),
			error_present: playReadiness?.error !== undefined && playReadiness.error !== null,
			settlement_frames: classifyPlaySettlementFrames(playReadiness?.settlement_frames),
			visible_owned_overlays: classifyPlayVisibleOwnedOverlays(playReadiness?.visible_owned_overlays),
			interactions_ready: evidence?.interactions_ready === true,
			readiness_wait: classifyReadinessWait(readinessWait),
			play_checkpoint: classifyPlayCheckpoint(checkpoint),
		},
	);
}

function planEnvelopeData(stdout: string): unknown | undefined {
	const envelope = safeJsonObject(stdout);
	return envelope?.success === true ? envelope.data : undefined;
}

type AgentBrowserNativeFailureReason = "command_failed" | "tab_gone";

type AgentBrowserNativeResult =
	| { ok: true; result: McporterCommandResult; data: unknown }
	| { ok: false; reason: AgentBrowserNativeFailureReason; timed_out?: boolean };

type AgentBrowserExactTargetProofReason =
	| "initial_active_target_attribution_failed"
	| "tab_gone"
	| "url_read_failed"
	| "url_shape_failed"
	| "origin_mismatch"
	| "exact_url_mismatch";

/**
 * Sanitized shape of one post-navigation URL read that failed byte-exact
 * equality. Reports structure only: never a URL, query value, or fragment.
 */
type AgentBrowserUrlMismatchRead = {
	attempt: number;
	origin_equal: boolean;
	path_equal: boolean;
	query_key_set_equal: boolean;
	query_keys_only_in_actual: readonly string[];
	query_keys_only_in_expected: readonly string[];
	normalized_href_equal: boolean;
	length_delta: number;
};

/**
 * Separates a semantic URL rewrite (`normalized_href_equal` true) from a
 * document that never arrived inside the read budget (false).
 */
type AgentBrowserUrlMismatchShape = {
	reads: readonly AgentBrowserUrlMismatchRead[];
	converged_by_final_read: boolean;
};

const URL_MISMATCH_MAX_KEYS = 8;
const URL_MISMATCH_MAX_KEY_LENGTH = 64;
const URL_MISMATCH_MAX_LENGTH_DELTA = 1024;

function normalizedHref(url: URL): string {
	const normalized = new URL(url.href);
	normalized.hash = "";
	normalized.searchParams.sort();
	return normalized.href;
}

function queryKeysOnlyIn(from: URL, other: URL): string[] {
	const exclude = new Set(other.searchParams.keys());
	return [...new Set(from.searchParams.keys())]
		.filter((key) => !exclude.has(key) && key.length <= URL_MISMATCH_MAX_KEY_LENGTH)
		.sort()
		.slice(0, URL_MISMATCH_MAX_KEYS);
}

function urlMismatchRead(attempt: number, actual: URL, expected: URL, lengthDelta: number): AgentBrowserUrlMismatchRead {
	const actualKeys = new Set(actual.searchParams.keys());
	const expectedKeys = new Set(expected.searchParams.keys());
	return {
		attempt,
		origin_equal: actual.origin === expected.origin,
		path_equal: actual.pathname === expected.pathname,
		query_key_set_equal:
			actualKeys.size === expectedKeys.size && [...actualKeys].every((key) => expectedKeys.has(key)),
		query_keys_only_in_actual: queryKeysOnlyIn(actual, expected),
		query_keys_only_in_expected: queryKeysOnlyIn(expected, actual),
		normalized_href_equal: normalizedHref(actual) === normalizedHref(expected),
		length_delta: Math.max(
			-URL_MISMATCH_MAX_LENGTH_DELTA,
			Math.min(URL_MISMATCH_MAX_LENGTH_DELTA, lengthDelta),
		),
	};
}

type AgentBrowserExactTargetProof =
	| {
			ok: true;
			url: string;
			drifted?: boolean;
			drift_shape?: AgentBrowserUrlMismatchRead;
			reads?: number;
	  }
	| {
			ok: false;
			reason: AgentBrowserExactTargetProofReason;
			mismatch_shape?: AgentBrowserUrlMismatchShape;
		};

function nativeEnvelopeCode(raw: string): string | undefined {
	const envelope = safeJsonObject(raw);
	if (typeof envelope?.code === "string") return envelope.code;
	const error = isJsonObject(envelope?.error) ? envelope.error : undefined;
	if (typeof error?.code === "string") return error.code;
	const data = isJsonObject(envelope?.data) ? envelope.data : undefined;
	return typeof data?.code === "string" ? data.code : undefined;
}

function nativeFailureReason(
	result: McporterCommandResult,
	args: readonly string[],
): AgentBrowserNativeFailureReason {
	if (
		args[0] === "get" &&
		args[1] === "url" &&
		[result.stdout, result.stderr].some((raw) => nativeEnvelopeCode(raw) === "tab_gone")
	) {
		return "tab_gone";
	}
	return "command_failed";
}

function exactTargetProofMessage(prefix: string, reason: AgentBrowserExactTargetProofReason): string {
	return `${prefix} (${reason}).`;
}

function planObservationDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function visibleValue(value: unknown): boolean | undefined {
	if (!isJsonObject(value)) return undefined;
	if (typeof value.value === "boolean") return value.value;
	if (typeof value.visible === "boolean") return value.visible;
	return undefined;
}

function cleanupBindingScript(input: {
	surfaceSelector: string;
	identity: string;
	controlIdentity?: string;
	controlSelector?: string;
}): string {
	return `(() => { const v=n=>{const s=getComputedStyle(n),b=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&b.width>0&&b.height>0},surfaces=[...document.querySelectorAll(${JSON.stringify(input.surfaceSelector)})],visible=surfaces.filter(v);if(visible.length!==1)return {visible_owned_surface_count:visible.length,exact_target_bound:false,control_count:0};const surface=visible[0],controls=${input.controlSelector === undefined ? "[]" : `[...surface.querySelectorAll(${JSON.stringify(input.controlSelector)})]`};if(controls.length!==${input.controlSelector === undefined ? "0" : "1"})return {visible_owned_surface_count:1,exact_target_bound:false,control_count:controls.length};surface.setAttribute('data-browser-use-cleanup-target',${JSON.stringify(input.identity)});${input.controlIdentity === undefined ? "" : `controls[0].setAttribute('data-browser-use-cleanup-control',${JSON.stringify(input.controlIdentity)});`}return {visible_owned_surface_count:1,exact_target_bound:true,control_count:controls.length} })()`;
}

function cleanupClosedScript(identity: string): string {
	return `(() => { const n=document.querySelector('[data-browser-use-cleanup-target="${identity}"]');if(!n)return {closed:true};const s=getComputedStyle(n),b=n.getBoundingClientRect(),closed=s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||b.width===0||b.height===0;if(closed){const c=n.querySelector('[data-browser-use-cleanup-control]');if(c)c.removeAttribute('data-browser-use-cleanup-control');n.removeAttribute('data-browser-use-cleanup-target')}return {closed} })()`;
}

/** Fixed code-owned evaluation. Its only variable data comes from the parsed typed plan. */
function typedEvidenceScript(step: BrowserUseTargetOperationInspectStepV2): string {
	const request = JSON.stringify({
		selector: step.selector,
		fields: step.fields,
		catalogue: step.fields.includes("catalogue"),
		geometry: step.fields.includes("geometry"),
		visibility: step.fields.includes("visibility"),
		focus: step.fields.includes("focus"),
		scroll: step.fields.includes("scroll"),
		properties: step.computed_style_properties ?? [],
		maxRows: step.max_rows ?? 128,
	});
	return `(() => { const r = ${request}; const a=(n,k)=>n.getAttribute('data-path-parity-'+k); const m=(n,o,p=r.properties)=>{const x={ordinal:o};if(r.geometry){const b=n.getBoundingClientRect();x.geometry={x:b.x,y:b.y,width:b.width,height:b.height,top:b.top,right:b.right,bottom:b.bottom,left:b.left};}if(r.visibility){const s=getComputedStyle(n);x.visibility=s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;}if(r.focus)x.focus={focused:document.activeElement===n,contains_focus:n.contains(document.activeElement)};if(r.scroll)x.scroll={scroll_left:n.scrollLeft,scroll_top:n.scrollTop,scroll_width:n.scrollWidth,scroll_height:n.scrollHeight,client_width:n.clientWidth,client_height:n.clientHeight};if(p.length){const s=getComputedStyle(n);x.computed_styles=Object.fromEntries(p.map(k=>[k,s.getPropertyValue(k)]));}return x;};const meta={fields:r.fields,computed_style_properties:r.properties,max_rows:r.maxRows};const root=document.querySelector(r.selector);if(!r.catalogue){const nodes=[...document.querySelectorAll(r.selector)],matches=nodes.slice(0,r.maxRows).map(m),out={kind:'selector-observation',selector:r.selector,...meta,total_match_count:nodes.length,matches};if(nodes.length>matches.length)out.truncation={reason:'max_rows_exceeded',observed_count:nodes.length,emitted_count:matches.length,limit:r.maxRows};return out;}const ready=document.readyState==='complete',incomplete=[...document.images].filter(image=>!image.complete).length;if(!root)return {kind:'scenario-catalogue',root_selector:r.selector,...meta,component:'missing',catalogue_version:'missing',document_ready:ready,interactions_ready:false,incomplete_image_count:incomplete,total_row_count:0,rows:[]};const rows=[];for(const scenario of root.querySelectorAll('[data-path-parity-scenario]')){const scenario_id=a(scenario,'scenario')||'default',implementations=[...scenario.querySelectorAll('[data-path-parity-implementation]')];for(const implementationNode of (implementations.length?implementations:[scenario])){const implementation=a(implementationNode,'implementation')||'control',layers=[...implementationNode.querySelectorAll('[data-path-parity-measurement-layer]')];for(const layerNode of (layers.length?layers:[implementationNode])){const layer_id=a(layerNode,'measurement-layer')||'control',selector=a(layerNode,'measurement-selector')||a(implementationNode,'target-selector')||a(scenario,'target-selector')||a(root,'target-selector')||r.selector,declared=(a(layerNode,'measurement-properties')||'').split(',').map(v=>v.trim()).filter(Boolean),properties=declared.length?declared:r.properties,target=layerNode.matches(selector)?layerNode:implementationNode.matches(selector)?implementationNode:implementationNode.querySelector(selector);if(!target)return {kind:'scenario-catalogue',root_selector:r.selector,...meta,component:'missing',catalogue_version:'missing',document_ready:ready,interactions_ready:false,incomplete_image_count:incomplete,total_row_count:0,rows:[]};rows.push({scenario_id,implementation,layer_id,selector,computed_style_properties:properties,target});}}}rows.sort((u,v)=>{const ku=[u.scenario_id,u.implementation,u.layer_id,u.selector].join('\u0000'),kv=[v.scenario_id,v.implementation,v.layer_id,v.selector].join('\u0000');return ku<kv?-1:ku>kv?1:0;});const emitted=rows.slice(0,r.maxRows).map((row,o)=>({ordinal:o,scenario_id:row.scenario_id,implementation:row.implementation,layer_id:row.layer_id,selector:row.selector,computed_style_properties:row.computed_style_properties,...m(row.target,o,row.computed_style_properties)})),out={kind:'scenario-catalogue',root_selector:r.selector,...meta,component:a(root,'component')||'unknown',catalogue_version:a(root,'catalogue-version')||'unknown',document_ready:ready,interactions_ready:a(root,'interactions-ready')==='true',incomplete_image_count:incomplete,total_row_count:rows.length,rows:emitted};if(rows.length>emitted.length)out.truncation={reason:'max_rows_exceeded',observed_count:rows.length,emitted_count:emitted.length,limit:r.maxRows};return out;})()`;
}

/** Schema-v2 Scenario Catalogue projections. The browser-only implementation stays fixed and private. */
function typedEvidenceProjectionScript(step: BrowserUseTargetOperationInspectStepV2): string {
	const request = JSON.stringify({
		selector: step.selector,
		fields: step.fields,
		catalogue: step.fields.includes("catalogue"),
		geometry: step.fields.includes("geometry"),
		visibility: step.fields.includes("visibility"),
		focus: step.fields.includes("focus"),
		scroll: step.fields.includes("scroll"),
		properties: step.computed_style_properties ?? [],
		maxRows: step.max_rows ?? 128,
	});
	return `(() => { const r=${request},q='[data-docs-matrix] .scrollbar-table[role="region"]',a=(n,k)=>n.getAttribute('data-path-parity-'+k),v=n=>{const s=getComputedStyle(n),b=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&b.width>0&&b.height>0},m=(n,o,p=r.properties)=>{const x={ordinal:o};if(r.geometry){const b=n.getBoundingClientRect();x.geometry={x:b.x,y:b.y,width:b.width,height:b.height,top:b.top,right:b.right,bottom:b.bottom,left:b.left}}if(r.visibility)x.visibility=v(n);if(r.focus)x.focus={focused:document.activeElement===n,contains_focus:n.contains(document.activeElement)};if(r.scroll)x.scroll={scroll_left:n.scrollLeft,scroll_top:n.scrollTop,scroll_width:n.scrollWidth,scroll_height:n.scrollHeight,client_width:n.clientWidth,client_height:n.clientHeight};if(p.length){const s=getComputedStyle(n);x.computed_styles=Object.fromEntries(p.map(k=>[k,s.getPropertyValue(k)]))}return x},meta={fields:r.fields,computed_style_properties:r.properties,max_rows:r.maxRows},root=document.querySelector(r.selector);if(!r.catalogue){const nodes=[...document.querySelectorAll(r.selector)],matches=nodes.slice(0,r.maxRows).map((node,ordinal)=>m(node,ordinal)),out={kind:'selector-observation',selector:r.selector,...meta,total_match_count:nodes.length,matches};if(nodes.length>matches.length)out.truncation={reason:'max_rows_exceeded',observed_count:nodes.length,emitted_count:matches.length,limit:r.maxRows};return out}const ready=document.readyState==='complete',incomplete=[...document.images].filter(i=>!i.complete).length,empty={kind:'scenario-catalogue',root_selector:r.selector,...meta,component:'missing',catalogue_version:'missing',document_ready:ready,interactions_ready:false,incomplete_image_count:incomplete,play_readiness:{status:'missing',error:null,settlement_frames:0,visible_owned_overlays:0,expanded:false},overlay_catalogue:{total_record_count:0,records:[]},matrix_regions:{total_region_count:0,regions:[]},total_row_count:0,rows:[]};if(!root)return empty;const rows=[],overlays=[];for(const scenario of root.querySelectorAll('[data-path-parity-scenario]')){const scenario_id=a(scenario,'scenario')||'default',impls=[...scenario.querySelectorAll('[data-path-parity-implementation]')];for(const node of(impls.length?impls:[scenario])){const implementation=a(node,'implementation')||'control',layers=[...node.querySelectorAll('[data-path-parity-measurement-layer]')];for(const layer of(layers.length?layers:[node])){const layer_id=a(layer,'measurement-layer')||'control',selector=a(layer,'measurement-selector')||a(node,'target-selector')||a(scenario,'target-selector')||a(root,'target-selector')||r.selector,declared=(a(layer,'measurement-properties')||'').split(',').map(x=>x.trim()).filter(Boolean),properties=declared.length?declared:r.properties,target=layer.matches(selector)?layer:node.matches(selector)?node:node.querySelector(selector);if(!target)return empty;rows.push({scenario_id,implementation,layer_id,selector,computed_style_properties:properties,target})}const overlay_selector=a(node,'overlay-selector');overlays.push({scenario_id,implementation,overlay_present:overlay_selector!==null,target_selector:overlay_selector===null?null:a(node,'target-selector'),overlay_selector,trigger_selector:a(node,'overlay-trigger-selector'),item_selector:a(node,'overlay-item-selector'),role:a(node,'overlay-role'),cleanup_strategy:a(node,'overlay-cleanup-strategy'),cleanup_selector:a(node,'overlay-cleanup-selector'),item_index:(x=>x===null?null:/^(?:0|[1-9][0-9]*)$/.test(x)?Number(x):x)(a(node,'overlay-item-index')),item_interaction:a(node,'overlay-item-interaction'),item_state:a(node,'overlay-item-state')})}}rows.sort((u,v)=>{const a=[u.scenario_id,u.implementation,u.layer_id,u.selector].join('\u0000'),b=[v.scenario_id,v.implementation,v.layer_id,v.selector].join('\u0000');return a<b?-1:a>b?1:0});overlays.sort((u,v)=>{const a=[u.scenario_id,u.implementation].join('\u0000'),b=[v.scenario_id,v.implementation].join('\u0000');return a<b?-1:a>b?1:0});const matrix=[...root.querySelectorAll(q)],regions=matrix.slice(0,r.maxRows).map((region,ordinal)=>{const targets=[...region.querySelectorAll('[data-path-parity-scenario][data-path-parity-implementation]')].map(node=>({scenario_id:a(node,'scenario'),implementation:a(node,'implementation'),target_selector:a(node,'target-selector')})).sort((u,v)=>{const a=[u.scenario_id,u.implementation,u.target_selector].join('\u0000'),b=[v.scenario_id,v.implementation,v.target_selector].join('\u0000');return a<b?-1:a>b?1:0}),emitted=targets.slice(0,r.maxRows),out={ordinal,selector:q,total_target_count:targets.length,targets:emitted,scroll_left:region.scrollLeft,scroll_width:region.scrollWidth,client_width:region.clientWidth,at_right_edge:region.scrollLeft>=region.scrollWidth-region.clientWidth};if(targets.length>emitted.length)out.target_truncation={reason:'max_rows_exceeded',observed_count:targets.length,emitted_count:emitted.length,limit:r.maxRows};return out}),matrix_regions={total_region_count:matrix.length,regions};if(matrix.length>regions.length)matrix_regions.truncation={reason:'max_rows_exceeded',observed_count:matrix.length,emitted_count:regions.length,limit:r.maxRows};const emitted=rows.slice(0,r.maxRows).map((row,ordinal)=>({ordinal,scenario_id:row.scenario_id,implementation:row.implementation,layer_id:row.layer_id,selector:row.selector,computed_style_properties:row.computed_style_properties,...m(row.target,ordinal,row.computed_style_properties)})),records=overlays.slice(0,r.maxRows),overlay_catalogue={total_record_count:overlays.length,records};if(overlays.length>records.length)overlay_catalogue.truncation={reason:'max_rows_exceeded',observed_count:overlays.length,emitted_count:records.length,limit:r.maxRows};const owner=root.closest('[data-path-parity-component]')||root,frames=a(root,'play-settlement-frames'),visible=a(root,'play-visible-owned-overlays'),out={kind:'scenario-catalogue',root_selector:r.selector,...meta,component:a(owner,'component')||'unknown',catalogue_version:a(root,'catalogue-version')||'unknown',document_ready:ready,interactions_ready:a(root,'interactions-ready')==='true',incomplete_image_count:incomplete,play_readiness:{status:a(root,'play-status')||'missing',error:a(root,'play-error'),settlement_frames:frames!==null&&/^(?:0|[1-9][0-9]*)$/.test(frames)?Number(frames):null,visible_owned_overlays:visible!==null&&/^(?:0|[1-9][0-9]*)$/.test(visible)?Number(visible):null,expanded:a(root,'expanded')==='true'},overlay_catalogue,matrix_regions,total_row_count:rows.length,rows:emitted};if(rows.length>emitted.length)out.truncation={reason:'max_rows_exceeded',observed_count:rows.length,emitted_count:emitted.length,limit:r.maxRows};return out})()`;
}

/** Fixed Storybook-only wrapper around the sealed Scenario Catalogue projection. */
function typedStorybookEvidenceProjectionScript(
	step: BrowserUseTargetOperationInspectStepV3 & {
		storybook_diagnostic: NonNullable<BrowserUseTargetOperationInspectStepV3["storybook_diagnostic"]>;
	},
): string {
	const evidence = typedEvidenceProjectionScript(step);
	const expected = JSON.stringify({
		component: step.storybook_diagnostic.expected_component,
		catalogueVersion: step.storybook_diagnostic.expected_catalogue_version,
	});
	return `(() => {
		const evidence=${evidence},expected=${expected},classify=(nodes,attribute,value)=>nodes.length===0?'missing':nodes.length!==1?'mismatch':nodes[0].getAttribute(attribute)===value?'expected':nodes[0].getAttribute(attribute)===null||nodes[0].getAttribute(attribute)===''?'unknown':'mismatch',components=[...document.querySelectorAll('[data-path-parity-component]')],catalogues=[...document.querySelectorAll('[data-path-parity-catalogue-version]')],body=document.body,state=body?.classList.contains('sb-show-nopreview')?'missing-story':body?.classList.contains('sb-show-errordisplay')?'runtime-error':body?.classList.contains('sb-show-preparing-story')||body?.classList.contains('sb-show-preparing-docs')?'loading':body?.classList.contains('sb-show-main')?'main':'unknown';
		const checkpointAttribute=catalogues.length===1?catalogues[0].getAttribute('data-path-parity-play-checkpoint'):null,checkpointNumber=checkpointAttribute===null?Number.NaN:Number(checkpointAttribute),playCheckpoint=checkpointAttribute===null?null:/^(?:0|[1-9][0-9]*)$/.test(checkpointAttribute)&&Number.isSafeInteger(checkpointNumber)&&checkpointNumber<=255?checkpointNumber:'invalid';
		return {evidence,play_checkpoint:playCheckpoint,storybook_document:{document_ready_state:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'unknown',catalogue_version_count:catalogues.length,component_count:components.length,component_classification:classify(components,'data-path-parity-component',expected.component),catalogue_version_classification:classify(catalogues,'data-path-parity-catalogue-version',expected.catalogueVersion),storybook_state:state}};
	})()`;
}

/**
 * Execute the adapter-neutral target plan while retaining the exact pinned
 * target proof. Native argv and response parsing stay entirely in this module;
 * the generic operation receipt only receives neutral step outcomes.
 */
export async function runAgentBrowserTargetOperationPlan(
	request: BrowserUseTargetOperationAdapterRequest,
): Promise<BrowserUseTargetOperationResult> {
	if (!SAFE_RUN_ID.test(request.handoff.run_id) || !SAFE_TAB_ID.test(request.target_id)) {
		return targetPlanFailure(request, "target_operation_plan_failed", "The target operation identity is unsafe.");
	}
	if (request.lifecycle_ref !== deriveSessionName(request.handoff.run_id)) {
		return targetPlanFailure(request, "target_operation_plan_failed", "The retained exact-target lifecycle does not match the run.");
	}
	if (
		request.bound_origin !== undefined &&
		!targetOperationPlanMatchesBoundOrigin(request.plan, request.bound_origin)
	) {
		return targetPlanFailure(
			request,
			"target_operation_origin_mismatch",
			"The target plan navigation does not match the exact bound target origin.",
		);
	}
	const native = async (
		args: readonly string[],
		options: Readonly<{ env?: Record<string, string | undefined> }> = {},
	): Promise<AgentBrowserNativeResult> => {
		try {
			const result = await request.runtime.runCommand({
				command: request.handoff.executable,
				args: [
					"--cdp",
					request.handoff.endpoint_ws,
					"--session",
					deriveSessionName(request.handoff.run_id),
					"--pin-tab",
					...args,
					"--json",
				],
				...(options.env === undefined ? {} : { env: options.env }),
				timeoutMs: COMMAND_TIMEOUT_MS,
			});
			if (result.timedOut === true || result.exitCode !== 0) {
				return {
					ok: false,
					reason: nativeFailureReason(result, args),
					...(result.timedOut === true ? { timed_out: true } : {}),
				};
			}
			return { ok: true, result, data: planEnvelopeData(result.stdout) };
		} catch {
			return { ok: false, reason: "command_failed" };
		}
	};
	const boundOrigin = request.bound_origin ?? (() => {
		try {
			return new URL(request.expected_url).origin;
		} catch {
			return undefined;
		}
	})();
	let lastProvenUrl: string | undefined;
	const proveExactTarget = async (
		expectedUrl?: string,
		options: Readonly<{
			initialAttribution?: boolean;
			settleExactUrl?: boolean;
			/**
			 * Admit a same-origin URL difference instead of refusing.
			 *
			 * Only the pre-dispatch baseline sets this. Identity there is already
			 * proven by the canonical target id (checked under initialAttribution)
			 * and the bound origin, both of which stay fail-closed below. The URL
			 * discovery recorded came from a DIFFERENT source than this live read
			 * — the `tab list` inventory, not the page — so byte equality between
			 * them was never an identity claim, and a single-page app that
			 * rewrites its own query string breaks it without navigating.
			 * A navigate step still asserts its own URL byte-exactly.
			 */
			admitSameOriginDrift?: boolean;
		}> = {},
	): Promise<AgentBrowserExactTargetProof> => {
		if (boundOrigin === undefined) return { ok: false, reason: "origin_mismatch" };
		if (options.initialAttribution === true) {
			const pinned = await native(["tab", "list"]);
			const pinnedData = pinned.ok && isJsonObject(pinned.data) ? pinned.data : undefined;
			const tabs = pinnedData && Array.isArray(pinnedData.tabs) ? pinnedData.tabs : undefined;
			const active = tabs?.filter(
				(tab) => isJsonObject(tab) && tab.active === true && tab.targetId === request.target_id,
			);
			if (active === undefined || active.length !== 1) {
				return { ok: false, reason: "initial_active_target_attribution_failed" };
			}
		}
		const maxReads = options.settleExactUrl === true && expectedUrl !== undefined ? 3 : 1;
		let expectedParsed: URL | undefined;
		if (expectedUrl !== undefined) {
			try {
				expectedParsed = new URL(expectedUrl);
			} catch {
				expectedParsed = undefined;
			}
		}
		const mismatchReads: AgentBrowserUrlMismatchRead[] = [];
		const mismatchProof = (): AgentBrowserExactTargetProof =>
			mismatchReads.length === 0
				? { ok: false, reason: "exact_url_mismatch" }
				: {
						ok: false,
						reason: "exact_url_mismatch",
						mismatch_shape: { reads: mismatchReads, converged_by_final_read: false },
					};
		for (let attempt = 0; attempt < maxReads; attempt += 1) {
			const urlProof = await native(["get", "url"]);
			if (!urlProof.ok) {
				return {
					ok: false,
					reason: urlProof.reason === "tab_gone" ? "tab_gone" : "url_read_failed",
				};
			}
			const urlData = isJsonObject(urlProof.data) ? urlProof.data : undefined;
			if (!urlData || typeof urlData.url !== "string") return { ok: false, reason: "url_shape_failed" };
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(urlData.url);
			} catch {
				return { ok: false, reason: "url_shape_failed" };
			}
				if (parsedUrl.origin !== boundOrigin) return { ok: false, reason: "origin_mismatch" };
				if (expectedUrl !== undefined && urlData.url !== expectedUrl) {
					if (expectedParsed !== undefined) {
						mismatchReads.push(
							urlMismatchRead(attempt + 1, parsedUrl, expectedParsed, urlData.url.length - expectedUrl.length),
						);
					}
					if (attempt + 1 < maxReads) {
						await new Promise<void>((resolve) => setTimeout(resolve, 250));
						continue;
					}
					if (options.admitSameOriginDrift !== true) return mismatchProof();
					// Origin already matched above, and the canonical target id was
					// proven before the first read. Report the drift; never hide it.
					lastProvenUrl = urlData.url;
					return {
						ok: true,
						url: urlData.url,
						drifted: true,
						reads: attempt + 1,
						...(mismatchReads.at(-1) === undefined
							? {}
							: { drift_shape: mismatchReads.at(-1) as AgentBrowserUrlMismatchRead }),
					};
				}
			lastProvenUrl = urlData.url;
			return { ok: true, url: urlData.url, reads: attempt + 1 };
		}
		return mismatchProof();
	};
	const initialProof = await proveExactTarget(request.expected_url, {
		initialAttribution: true,
		// A page still finishing its load gets the same settle window a navigate
		// step gets, so a converging URL resolves cleanly instead of racing.
		settleExactUrl: true,
		admitSameOriginDrift: true,
	});
	if (!initialProof.ok) {
		// The reason travels as structured data, not only inside the message.
		// A caller that gets `steps: []` has nothing else to dispatch on, and a
		// reason readable only by parsing prose is a reason nobody parses.
		return targetPlanFailure(
			request,
			"target_operation_plan_failed",
			exactTargetProofMessage("The exact target and bound origin proof failed", initialProof.reason),
			[],
			{ attempted: false, closed: false, visible_owned_surface_count: 0 },
			{
				reason: "exact_target_proof_failed",
				pointer: `/baseline/${initialProof.reason}`,
			},
		);
	}
	const baseline: BrowserUseTargetOperationBaseline = {
		url_drifted: initialProof.drifted === true,
		settle_reads: initialProof.reads ?? 1,
		...(initialProof.drift_shape === undefined
			? {}
			: { drift_shape: initialProof.drift_shape }),
	};
	const outcomes: BrowserUseTargetOperationStepOutcome[] = [];
	let admittedEvidenceBytes = 0;
	let lastNavigation = { attempted: false, confirmed: false, changed_document: false };
	let cleanup: BrowserUseTargetOperationCleanupEvidence = {
		attempted: false,
		closed: false,
		visible_owned_surface_count: 0,
	};
	for (let index = 0; index < request.plan.steps.length; index += 1) {
		const step = request.plan.steps[index];
		if (request.assert_custody !== undefined) {
			const custody = await request.assert_custody();
			if (!custody.ok) {
				return targetPlanFailure(
					request,
					"target_operation_plan_failed",
					custody.message ?? "The exact Target Operation Lease is no longer live.",
					outcomes,
					cleanup,
				);
			}
		}
		let args: string[] | undefined;
		const beforeStepUrl = lastProvenUrl;
		if (step.kind === "navigate" && step.url === request.expected_url) {
			const nextStep = request.plan.steps[index + 1];
			const catalogueInspect =
				request.plan.schema_version === "2" &&
				nextStep?.kind === "inspect" &&
				nextStep.fields.includes("catalogue")
					? nextStep
					: undefined;
			if (request.plan.schema_version === "3" && lastProvenUrl === step.url) {
				const observed = await native(["get", "url"]);
				const observedData = observed.ok && isJsonObject(observed.data)
					? observed.data
					: undefined;
				if (observedData?.url !== step.url) {
					return targetPlanFailure(
						request,
						"target_operation_plan_failed",
						"The pinned target no longer exposes the exact requested Storybook URL.",
						outcomes,
						cleanup,
					);
				}
				lastNavigation = { attempted: false, confirmed: true, changed_document: false };
				outcomes.push({
					index,
					kind: step.kind,
					status: "confirmed",
					observation_digest: planObservationDigest(observedData),
				});
				continue;
			}
			if (catalogueInspect === undefined) {
				// A healthy non-catalogue short circuit must still dispatch through the
				// native adapter. The adapter result is the observation-backed digest;
				// an identity-derived digest would falsely claim navigation evidence.
				args = ["open", step.url];
			} else {
				const catalogueCountResult = await native(["get", "count", catalogueInspect.selector]);
				const catalogueCountData =
					catalogueCountResult.ok && isJsonObject(catalogueCountResult.data)
						? catalogueCountResult.data
						: undefined;
				const catalogueCount =
					catalogueCountData && typeof catalogueCountData.count === "number"
						? catalogueCountData.count
						: catalogueCountData && typeof catalogueCountData.value === "number"
							? catalogueCountData.value
							: undefined;
				if (catalogueCount === 1) {
					// The exact URL and the unique catalogue root together prove that the
					// retained Storybook document is already the intended settled preview.
					// Retain the genuine catalogue-count observation as its digest source.
					lastNavigation = { attempted: false, confirmed: true, changed_document: false };
					outcomes.push({
						index,
						kind: step.kind,
						status: "confirmed",
						observation_digest: planObservationDigest(catalogueCountData),
					});
					continue;
				}
				args = ["open", step.url];
			}
		}
		else if (step.kind === "navigate") args = ["open", step.url];
		else if (step.kind === "inspect") {
			if (request.plan.schema_version !== "1") {
				const typedStep = step as BrowserUseTargetOperationInspectStepV2;
				const storybookStep = request.plan.schema_version === "3" &&
					"storybook_diagnostic" in step && step.storybook_diagnostic !== undefined
					? step as BrowserUseTargetOperationInspectStepV3 & {
						storybook_diagnostic: NonNullable<BrowserUseTargetOperationInspectStepV3["storybook_diagnostic"]>;
					}
					: undefined;
				let readinessWait: AgentBrowserNativeResult | undefined;
				if (storybookStep !== undefined) {
					readinessWait = await native(
						["wait", STORYBOOK_TERMINAL_READINESS_SELECTOR],
						{
							env: {
								...request.env,
								AGENT_BROWSER_DEFAULT_TIMEOUT: `${STORYBOOK_TERMINAL_READINESS_TIMEOUT_MS}`,
							},
						},
					);
					if (request.assert_custody !== undefined) {
						const custody = await request.assert_custody();
						if (!custody.ok) {
							return targetPlanFailure(
								request,
								"target_operation_plan_failed",
								custody.message ?? "The exact Target Operation Lease is no longer live after the Storybook readiness wait.",
								outcomes,
								cleanup,
								postReadinessFailureAtStep(index, "target_custody_failed"),
							);
						}
					}
					const expectedUrlAfterWait = lastProvenUrl;
					const postWaitProof: AgentBrowserExactTargetProof = expectedUrlAfterWait === undefined
						? { ok: false, reason: "exact_url_mismatch" }
						: await proveExactTarget(expectedUrlAfterWait);
					if (!postWaitProof.ok) {
						return targetPlanFailure(
							request,
							"target_operation_plan_failed",
							exactTargetProofMessage(
								"The Storybook readiness wait changed or lost the exact target or bound origin before evaluation",
								postWaitProof.reason,
							),
							outcomes,
							cleanup,
							postReadinessFailureAtStep(
								index,
								"exact_target_proof_failed",
								postWaitProof.reason === "initial_active_target_attribution_failed"
									? "url_read_failed"
									: postWaitProof.reason,
							),
						);
					}
				}
				const inspected = await native([
					"eval",
					"-b",
						Buffer.from(
							storybookStep === undefined
								? typedEvidenceProjectionScript(typedStep)
								: typedStorybookEvidenceProjectionScript(storybookStep),
							"utf8",
						).toString("base64"),
				]);
					if (
						!inspected.ok ||
						!isJsonObject(inspected.data) ||
						!Object.hasOwn(inspected.data, "result")
					) {
						return targetPlanFailure(
							request,
							"target_operation_evidence_invalid",
							"The typed inspection did not return one valid adapter result.",
							outcomes,
							cleanup,
							{ reason: "adapter_eval_failed", pointer: `/steps/${index}/inspect/adapter_result` },
						);
					}
					const inspectedResult = inspected.data.result;
					const wrapped = storybookStep === undefined
						? undefined
						: isJsonObject(inspectedResult) && isJsonObject(inspectedResult.storybook_document)
							? inspectedResult
							: undefined;
					const storybookDiagnostic = storybookStep === undefined || wrapped === undefined || lastProvenUrl === undefined
						? undefined
						: buildBrowserUseStorybookDocumentDiagnostic({
							expectation: storybookStep.storybook_diagnostic,
							effective_url: lastProvenUrl,
							raw_projection: wrapped.storybook_document,
							navigation: {
								attempted: lastNavigation.attempted,
								confirmed: lastNavigation.confirmed,
								changed_document: lastNavigation.changed_document,
							},
						});
					if (storybookStep !== undefined && storybookDiagnostic === undefined) {
						return targetPlanFailure(
							request,
							"target_operation_evidence_invalid",
							"The fixed Storybook document diagnostic was missing or malformed.",
							outcomes,
							cleanup,
							{ reason: "adapter_eval_failed", pointer: `/steps/${index}/inspect/storybook_document_diagnostic` },
						);
					}
					if (
						storybookStep !== undefined &&
						readinessWait?.ok === false &&
						storybookDiagnostic?.storybook_document_classification !== "ready"
					) {
						const failureDetail: BrowserUseTargetOperationFailureDetail = {
							reason: "adapter_eval_failed",
							pointer: `/steps/${index}/inspect/storybook_document_diagnostic`,
						};
						outcomes.push({
							index,
							kind: "inspect",
							status: "blocked",
							code: "target_operation_evidence_invalid",
							storybook_document_diagnostic: storybookDiagnostic,
						});
						return targetPlanFailure(
							request,
							"target_operation_evidence_invalid",
							readinessWait.timed_out === true
								? "The Storybook terminal readiness wait timed out before strict evaluation."
								: "The Storybook terminal readiness wait did not confirm a ready document.",
							outcomes,
							cleanup,
							failureDetail,
						);
					}
						const typedProjection = wrapped?.evidence ?? inspectedResult;
						const evidence = parseBrowserUseTargetOperationEvidence(typedProjection, typedStep);
					if (!evidence.ok) {
						if (evidence.failure_detail.reason === "play_readiness_failed") {
							emitPlayReadinessFailureDiagnostic(
								typedProjection,
								index,
								readinessWait,
								wrapped?.play_checkpoint,
							);
						}
						outcomes.push({ index, kind: "inspect", status: "blocked", code: evidence.code, ...(evidence.evidence === undefined ? {} : { evidence: evidence.evidence }), ...(storybookDiagnostic === undefined ? {} : { storybook_document_diagnostic: storybookDiagnostic }) });
						return targetPlanFailure(
							request,
							evidence.code,
							"The typed inspection evidence was incomplete or exceeded its explicit limit.",
							outcomes,
							cleanup,
							targetEvidenceFailureAtStep(index, evidence.failure_detail),
						);
					}
					if (
						storybookStep !== undefined &&
						readinessWait?.ok === true &&
						storybookDiagnostic?.storybook_document_classification !== "ready"
					) {
						const failureDetail: BrowserUseTargetOperationFailureDetail = {
							reason: "adapter_eval_failed",
							pointer: `/steps/${index}/inspect/storybook_document_diagnostic`,
						};
						outcomes.push({
							index,
							kind: "inspect",
							status: "blocked",
							code: "target_operation_evidence_invalid",
							evidence: evidence.evidence,
							...(storybookDiagnostic === undefined ? {} : { storybook_document_diagnostic: storybookDiagnostic }),
						});
						return targetPlanFailure(
							request,
							"target_operation_evidence_invalid",
							"The Storybook terminal readiness wait did not confirm a ready document.",
							outcomes,
							cleanup,
							failureDetail,
						);
					}
					const evidenceBytes = Buffer.byteLength(JSON.stringify(evidence.evidence), "utf8");
				if (admittedEvidenceBytes + evidenceBytes > BROWSER_USE_TARGET_OPERATION_MAX_EVIDENCE_BYTES) {
					outcomes.push({ index, kind: "inspect", status: "blocked", code: "target_operation_evidence_invalid" });
						return targetPlanFailure(
							request,
							"target_operation_evidence_invalid",
							"The complete typed evidence payload exceeded its public byte limit.",
							outcomes,
							cleanup,
							{ reason: "evidence_budget_exceeded", pointer: `/steps/${index}/inspect/evidence` },
						);
				}
				admittedEvidenceBytes += evidenceBytes;
				outcomes.push({ index, kind: "inspect", status: "confirmed", evidence: evidence.evidence, ...(storybookDiagnostic === undefined ? {} : { storybook_document_diagnostic: storybookDiagnostic }) });
				continue;
			}
			if (step.fields.some((field) => field === "focus" || field === "scroll")) {
				return targetPlanFailure(request, "target_operation_plan_unsupported", "Agent Browser cannot truthfully observe the requested focus or scroll field.", outcomes, cleanup);
			}
			const observations: unknown[] = [];
			for (const field of step.fields) {
				const inspectArgs = field === "catalogue" ? ["snapshot", "-i"]
					: field === "dom" ? ["get", "html", step.selector]
					: field === "geometry" ? ["get", "box", step.selector]
					: field === "computed-styles" ? ["get", "styles", step.selector]
					: ["is", "visible", step.selector];
				const inspected = await native(inspectArgs);
				if (!inspected.ok) return targetPlanFailure(request, "target_operation_plan_failed", "A typed inspection failed.", outcomes, cleanup);
				observations.push(inspected.data);
			}
			outcomes.push({ index, kind: step.kind, status: "confirmed", observation_digest: planObservationDigest(observations) });
			continue;
		}
		else if (step.kind === "review-state") {
			args = step.state === "hover" ? ["hover", step.selector]
				: step.state === "focus" ? ["focus", step.selector]
				: undefined;
			if (args === undefined) return targetPlanFailure(request, "target_operation_plan_unsupported", `Agent Browser cannot truthfully establish the ${step.state} review state.`, outcomes, cleanup);
		}
		else if (step.kind === "input") {
			const scrollDelta = step.action === "scroll" ? step.delta : undefined;
			args = step.action === "move" ? ["mouse", "move", String(step.x ?? 0), String(step.y ?? 0)]
				: step.action === "click" ? ["click", step.selector ?? ""]
				: step.action === "focus" ? ["focus", step.selector ?? ""]
				: step.action === "scroll"
					? typeof scrollDelta === "number" && Number.isFinite(scrollDelta) && scrollDelta !== 0
						? ["scroll", scrollDelta > 0 ? "down" : "up", String(Math.abs(scrollDelta))]
						: undefined
				: step.action === "release" ? ["mouse", "up"]
				: ["press", step.key ?? ""];
			if (args === undefined) return targetPlanFailure(request, "target_operation_plan_unsupported", "Agent Browser cannot truthfully express a numeric scroll delta.", outcomes, cleanup);
		}
		else {
			cleanup = { attempted: true, closed: false, method: step.method, visible_owned_surface_count: 0 };
			if (request.plan.schema_version === "1") {
				if (step.method !== "close-control" || step.selector === undefined) return targetPlanFailure(request, "target_operation_plan_unsupported", "Only selector-bound close-control cleanup has a provable owned surface.", outcomes, cleanup);
				const countResult = await native(["get", "count", step.selector]);
				const countData = countResult.ok && isJsonObject(countResult.data) ? countResult.data : undefined;
				const count = countData && typeof countData.count === "number" ? countData.count : countData && typeof countData.value === "number" ? countData.value : undefined;
				if (count !== 1) return targetPlanFailure(request, "target_operation_cleanup_incomplete", "The cleanup selector did not prove exactly one owned surface.", outcomes, cleanup);
				const before = await native(["is", "visible", step.selector]);
				if (!before.ok || visibleValue(before.data) !== true) return targetPlanFailure(request, "target_operation_cleanup_incomplete", "The owned overlay surface was not uniquely visible before cleanup.", outcomes, cleanup);
				cleanup.visible_owned_surface_count = 1;
				const closed = await native(["click", step.selector]);
				const closedProof: AgentBrowserExactTargetProof = closed.ok
					? await proveExactTarget()
					: { ok: false, reason: "url_read_failed" };
				const closedProofReason = !closed.ok ? "url_read_failed" : !closedProof.ok ? closedProof.reason : undefined;
				if (closedProofReason !== undefined) {
					if (closed.ok) outcomes.push({ index, kind: step.kind, status: "unknown", effect: "possibly-effectful" });
					return targetPlanFailure(request, "target_operation_plan_failed", exactTargetProofMessage("Cleanup changed or lost the exact target or bound origin before confirmation", closedProofReason), outcomes, cleanup);
				}
				const after = await native(["is", "visible", step.selector]);
				cleanup.closed = after.ok ? visibleValue(after.data) === false : false;
				if (!cleanup.closed) return targetPlanFailure(request, "target_operation_cleanup_incomplete", "The owned overlay surface did not prove closed.", outcomes, cleanup);
				outcomes.push({ index, kind: step.kind, status: "confirmed" });
				continue;
			}
			if (step.method === "backdrop" || step.surface_selector === undefined || (step.method === "close-control" && step.control_selector === undefined)) return targetPlanFailure(request, "target_operation_plan_unsupported", "Only surface-bound close-control and escape cleanup are provable.", outcomes, cleanup);
			cleanup = { ...cleanup, surface_selector: step.surface_selector, ...(step.control_selector === undefined ? {} : { control_selector: step.control_selector }) };
			const identity = createHash("sha256").update(`${request.plan_digest}:${index}`).digest("hex").slice(0, 24);
			const controlIdentity = step.method === "close-control"
				? createHash("sha256").update(`${identity}:control`).digest("hex").slice(0, 24)
				: undefined;
			const bound = await native(["eval", "-b", Buffer.from(cleanupBindingScript({ surfaceSelector: step.surface_selector, identity, ...(step.control_selector === undefined ? {} : { controlSelector: step.control_selector }), ...(controlIdentity === undefined ? {} : { controlIdentity }) }), "utf8").toString("base64")]);
			const binding = bound.ok && isJsonObject(bound.data) && isJsonObject(bound.data.result) ? bound.data.result : undefined;
			if (!binding || typeof binding.visible_owned_surface_count !== "number" || typeof binding.exact_target_bound !== "boolean") return targetPlanFailure(request, "target_operation_cleanup_incomplete", "The owned overlay surface binding was incomplete.", outcomes, cleanup);
			cleanup.visible_owned_surface_count = binding.visible_owned_surface_count;
			cleanup.exact_target_bound = binding.exact_target_bound;
			if (binding.visible_owned_surface_count !== 1 || binding.exact_target_bound !== true || (step.method === "close-control" && binding.control_count !== 1)) return targetPlanFailure(request, "target_operation_cleanup_incomplete", "The cleanup surface did not bind exactly one visible owned overlay.", outcomes, cleanup);
			const dispatch = step.method === "close-control"
				? await native(["click", `[data-browser-use-cleanup-control="${controlIdentity}"]`])
				: await native(["press", "Escape"]);
			const dispatchProof: AgentBrowserExactTargetProof = dispatch.ok
				? await proveExactTarget()
				: { ok: false, reason: "url_read_failed" };
			const dispatchProofReason = !dispatch.ok ? "url_read_failed" : !dispatchProof.ok ? dispatchProof.reason : undefined;
			if (dispatchProofReason !== undefined) {
				if (dispatch.ok) outcomes.push({ index, kind: step.kind, status: "unknown", effect: "possibly-effectful" });
				return targetPlanFailure(request, "target_operation_plan_failed", exactTargetProofMessage("Cleanup changed or lost the exact target or bound origin before confirmation", dispatchProofReason), outcomes, cleanup);
			}
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const polled = await native(["eval", "-b", Buffer.from(cleanupClosedScript(identity), "utf8").toString("base64")]);
				const state = polled.ok && isJsonObject(polled.data) && isJsonObject(polled.data.result) ? polled.data.result : undefined;
				if (!state || typeof state.closed !== "boolean") break;
				if (state.closed) { cleanup.closed = true; break; }
			}
			if (!cleanup.closed) return targetPlanFailure(request, "target_operation_cleanup_incomplete", "The exact owned overlay surface did not prove closed.", outcomes, cleanup);
			outcomes.push({ index, kind: step.kind, status: "confirmed" });
			continue;
		}
		if (step.kind === "navigate") {
			emitCliDiagnostic(
				["browser-use.cli", "agent-browser"],
				"debug",
				"target-plan-navigation-dispatch",
				{
					operation_phase: "target-plan",
					step_index: index,
					step_kind: "navigate",
					dispatch_stage: "before",
				},
			);
		}
		const result = await native(args);
		if (!result.ok) return targetPlanFailure(request, "target_operation_plan_failed", "A typed target operation failed.", outcomes, cleanup);
		const proof = await proveExactTarget(
			step.kind === "navigate" ? step.url : undefined,
			step.kind === "navigate" ? { settleExactUrl: true } : {},
		);
		if (!proof.ok) {
			if (step.kind === "navigate") {
				emitCliDiagnostic(
					["browser-use.cli", "agent-browser"],
					"error",
					"target-plan-navigation-proof-lost",
					{
						operation_phase: "target-plan",
						step_index: index,
						step_kind: "navigate",
						proof_stage: "post-navigation-exact-target",
						native_result: "defined",
						proof_outcome: "lost",
						proof_reason: proof.reason,
						...(proof.mismatch_shape === undefined ? {} : { mismatch_shape: proof.mismatch_shape }),
					},
				);
			}
			outcomes.push({ index, kind: step.kind, status: "unknown", effect: "possibly-effectful" });
			return targetPlanFailure(request, "target_operation_plan_failed", exactTargetProofMessage("The action changed or lost the exact target or bound origin before confirmation", proof.reason), outcomes, cleanup);
		}
		if (step.kind === "navigate") {
			lastNavigation = {
				attempted: true,
				confirmed: true,
				changed_document: beforeStepUrl !== lastProvenUrl,
			};
		}
		outcomes.push({ index, kind: step.kind, status: "confirmed", observation_digest: planObservationDigest(result.data) });
	}
	return {
		ok: true,
		scope: "target-local",
		focus: false,
		capability_id: "agent-browser.exact-target-no-focus.v1",
		plan_schema_version: request.plan.schema_version,
		plan_digest: request.plan_digest,
		plan_step_count: request.plan.steps.length,
		steps: outcomes,
		cleanup,
		baseline,
	};
}

function operationFailure(
	code: Extract<AgentBrowserOperationResult, { ok: false }>["code"],
	message: string,
	focus = false,
): Extract<AgentBrowserOperationResult, { ok: false }> {
	return { ok: false, code, message, focus };
}

async function callAgentBrowserOperation(input: {
	request: AgentBrowserOperationRequest;
	args: readonly string[];
	label: string;
	strictTabBinding?: boolean;
}): Promise<
	| { ok: true; result: McporterCommandResult; data: unknown }
	| Extract<AgentBrowserOperationResult, { ok: false }>
> {
	let result: McporterCommandResult;
	try {
		result = await input.request.runtime.runCommand({
			command: input.request.handoff.probeExecutable,
			args: [
				"--cdp",
				input.request.handoff.endpointWs,
				"--session",
				deriveSessionName(input.request.handoff.runId),
				...(input.strictTabBinding === false ? [] : ["--pin-tab"]),
				...input.args,
				"--json",
			],
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
	} catch {
		return operationFailure(
			"agent_browser_operation_dependency_missing",
			`The agent-browser ${input.label} call could not be started.`,
		);
	}
	if (result.timedOut === true) {
		return operationFailure(
			"agent_browser_operation_timeout",
			`The agent-browser ${input.label} call timed out.`,
		);
	}
	if (result.exitCode !== 0) {
		return operationFailure(
			"agent_browser_operation_failed",
			`The agent-browser ${input.label} call failed.`,
		);
	}
	const envelope = safeJsonObject(result.stdout);
	if (envelope?.success !== true) {
		return operationFailure(
			"agent_browser_operation_failed",
			`The agent-browser ${input.label} call returned an invalid success envelope.`,
		);
	}
	return { ok: true, result, data: envelope.data };
}

/** Canonical native operation/session mechanics for Agent Browser. */
export async function runAgentBrowserOperation(
	request: AgentBrowserOperationRequest,
): Promise<AgentBrowserOperationResult> {
	if (
		!SAFE_RUN_ID.test(request.handoff.runId) ||
		!SAFE_TAB_ID.test(request.targetId)
	) {
		return operationFailure(
			"agent_browser_operation_identifiers_unsafe",
			"The agent-browser operation identifiers are unsafe.",
		);
	}
	const call = (
		args: readonly string[],
		label: string,
		strictTabBinding = true,
	) => callAgentBrowserOperation({ request, args, label, strictTabBinding });
	let focus = false;
	let outcome: AgentBrowserOperationResult;
	if (request.targetPrepared) {
		const pinned = await call(["tab", "list"], "pinned target proof");
		if (!pinned.ok) outcome = pinned;
		else {
			const data = isJsonObject(pinned.data) ? pinned.data : undefined;
			const activeTargetIds = Array.isArray(data?.tabs)
				? data.tabs
						.filter((tab) => isJsonObject(tab) && tab.active === true)
						.map((tab) => (isJsonObject(tab) ? tab.targetId : undefined))
						.filter(
							(targetId): targetId is string =>
								typeof targetId === "string" && SAFE_TAB_ID.test(targetId),
						)
				: undefined;
			outcome =
				activeTargetIds?.length === 1 && activeTargetIds[0] === request.targetId
					? await executeAgentBrowserOperation(request, call, false)
					: operationFailure(
							"agent_browser_operation_failed",
							"The retained Agent Browser session did not prove the exact canonical target.",
						);
		}
	} else {
		const activated = await call(
			["tab", request.targetId],
			"canonical target activation",
			false,
		);
		focus = activated.ok;
		outcome = activated.ok
			? await executeAgentBrowserOperation(request, call, true)
			: activated;
	}
	if (request.retainSession) return outcome;
	let release: AdapterSessionReleaseDebt | undefined;
	try {
		const released = await releaseAgentBrowserSession({
			env: request.env,
			runCommand: request.runtime.runCommand,
			probeExecutable: request.handoff.probeExecutable,
			runId: request.handoff.runId,
		});
		if (!released.released) release = released;
	} catch {
		release = {
			released: false,
			cause: "command-failed",
			detail: "The Agent Browser session release failed unexpectedly.",
		};
	}
	if (release === undefined) return outcome;
	return outcome.ok
		? {
				...operationFailure(
					"agent_browser_operation_failed",
					"The owning Agent Browser operation session could not be released.",
					outcome.focus,
				),
				release,
			}
		: { ...outcome, release };
}

async function executeAgentBrowserOperation(
	request: AgentBrowserOperationRequest,
	call: (
		args: readonly string[],
		label: string,
		strictTabBinding?: boolean,
	) => ReturnType<typeof callAgentBrowserOperation>,
	focus: boolean,
): Promise<AgentBrowserOperationResult> {
	const proof = await call(["get", "url"], "strict target proof");
	if (!proof.ok) return { ...proof, focus };
	const proofData = isJsonObject(proof.data) ? proof.data : undefined;
	if (
		request.expectedUrl !== undefined &&
		proofData?.url !== request.expectedUrl
	) {
		return operationFailure(
			"agent_browser_operation_failed",
			"The pinned Agent Browser target URL did not match the selected target.",
			focus,
		);
	}
	if (request.operation === "screenshot") {
		const result = await call(
			[
				"screenshot",
				...(request.screenshot?.fullPage ? ["--full"] : []),
				...(request.screenshot?.path ? [request.screenshot.path] : []),
			],
			"screenshot",
		);
		return result.ok
			? { ok: true, result: result.result, focus }
			: { ...result, focus };
	}
	const result = await call(["snapshot"], "snapshot");
	if (!result.ok) return { ...result, focus };
	const data = result.data;
	const snapshotText =
		typeof data === "string"
			? data
			: isJsonObject(data) && typeof data.snapshot === "string"
				? data.snapshot
				: undefined;
	if (snapshotText === undefined) {
		return operationFailure(
			"agent_browser_operation_failed",
			"The agent-browser snapshot call returned an unexpected payload shape.",
			focus,
		);
	}
	return {
		ok: true,
		focus,
		result: { ...result.result, stdout: snapshotText },
	};
}

/**
 * Verified Browser Connect payload pinned to the schema this consumer knows.
 */
export type AgentBrowserVerifiedHandoff = BrowserConnectHandoffPayload & {
	contract_id: string;
	schema_version: string;
};

/**
 * Structural evidence checked after an Agent Browser mutation.
 */
export type AgentBrowserPostcondition =
	| { kind: "url-equals"; url: string }
	| { kind: "url-starts-with"; url: string }
	| { kind: "value-equals"; selector: string; value: string }
	| { kind: "element-visible"; selector: string };

/**
 * One bounded native Agent Browser action.
 *
 * Refs are legal only immediately after this task's own snapshot. Confidential
 * field delivery remains owned by the Browser Authentication Transaction.
 */
export type AgentBrowserTaskStep =
	| { kind: "snapshot"; interactive: boolean }
	| {
			kind: "open";
			url: string;
			postcondition: Extract<
				AgentBrowserPostcondition,
				{ kind: "url-equals" | "url-starts-with" }
			>;
	  }
	| {
			kind: "click";
			ref: string;
			postcondition: AgentBrowserPostcondition;
	  }
	| {
			kind: "click-semantic";
			role: string;
			name: string;
			postcondition: Extract<
				AgentBrowserPostcondition,
				{ kind: "element-visible" }
			>;
	  }
	| {
			kind: "fill";
			ref: string;
			/** Binding slug resolved by confidential delivery at fill time. */
			item_binding?: string;
			value: string;
			sensitivity: "ordinary" | "confidential";
			/**
			 * Optional runtime-resolved semantic target (runbook v2, R11). When
			 * present, the executor resolves the fill ref from a FRESH snapshot by
			 * role + name and dispatches only when EXACTLY ONE current ref matches,
			 * overriding the durable `ref` placeholder. Absent for adapter-native
			 * @eN fills that already hold a snapshot ref.
			 */
			target?: { role: string; name: string };
			postcondition: AgentBrowserPostcondition;
	  }
	| {
			kind: "evaluate";
			action_id: string;
			/** Stable identity for one expanded iterate item (R12/R21). */
			item_key?: string;
			script: string;
			script_sha256: string;
			review_status: "approved" | "pending" | "rejected";
			allowed_origin: string;
			effect: "read" | "mutation";
			inputs: Readonly<Record<string, unknown>>;
			postcondition?: AgentBrowserPostcondition;
	  };

/**
 * The OPTIONAL auth-delivery context the auth wiring supplies for a task whose
 * confidential-fill steps must route through the Confidential Field Delivery
 * choreography instead of refusing (auth plan U5, R13-R16; release R13-R16).
 *
 * The context is only ever handed in DURING the auth transaction's
 * sensitive-interval (`in_sensitive_interval` — post lease-granted, pre
 * submission-dispatched); `field_by_binding_slug` names, per runbook binding,
 * credential field the choreography must deliver into that field. Every effect
 * is an injected port owned by the auth wiring: the disposable delivery helper
 * (`deliver`), the fresh target re-proof (`reproveTarget`), the verified target
 * proof bundle (`target`), the approved item binding (`binding`), and the
 * opaque-handle TokenRetrievalPort (`tokenRetrieval`). No secret material ever
 * flows through this context — the executor never observes a value.
 *
 * WITHOUT this context, a confidential fill is refused exactly as before
 * (`agent_browser_confidential_input_requires_auth_transaction`); the default
 * must not weaken. When no `tokenRetrieval` port exists at all (native
 * capability absent), the auth wiring supplies no context, so the typed refusal
 * stands — native-capability-absent behavior is unchanged.
 */
export type AgentBrowserAuthDeliveryContext = {
	/** True only while the auth transaction sits in its sensitive-interval. */
	in_sensitive_interval: boolean;
	binding: BrowserUseItemBinding;
	target: BrowserUseVerifiedTarget;
	tokenRetrieval: BrowserUseTokenRetrievalPort;
	deliver: BrowserUseDeliveryHook;
	reproveTarget: BrowserUseTargetReproof;
	/** Runbook binding slug -> credential field delivered for that step. */
	field_by_binding_slug: Readonly<
		Record<string, BrowserUseOpCredentialField>
	>;
};

/**
 * Complete input for one same-session Agent Browser task. `auth_delivery` is
 * optional: present only when the Browser Authentication Transaction has routed
 * a sensitive-interval delivery through this lane.
 */
export type AgentBrowserTask = {
	handoff: AgentBrowserVerifiedHandoff;
	run_id: string;
	target_tab_id: string;
	/**
	 * Exact process-local URL observed when the target was resolved.
	 *
	 * When supplied, target selection must reprove this URL before execution.
	 */
	expected_target_url?: string;
	allowed_origins: readonly string[];
	steps: readonly AgentBrowserTaskStep[];
	/** Admit exact about:blank only when the first remaining step is `open`. */
	allow_neutral_target?: boolean;
	auth_delivery?: AgentBrowserAuthDeliveryContext;
};

/**
 * Opaque, deterministic target binding safe for durable caller state.
 */
export type AgentBrowserTargetBinding = {
	schema_version: "1";
	target_candidate_id: string;
};

/**
 * One pre-execution target request.
 *
 * Exact adapter ids are input-only overrides. Automatic resumes use only the
 * opaque candidate binding produced by a prior successful resolution.
 */
export type AgentBrowserTargetRequest =
	| {
			kind: "exact";
			tab_id: string;
			target_envelope_id: string;
	  }
	| {
			kind: "auto";
			target_envelope_id: string;
			bound_target_candidate_id?: string;
	  };

/**
 * Input for target preflight through the verified Agent Browser handoff.
 */
export type AgentBrowserTargetResolutionInput = {
	handoff: AgentBrowserVerifiedHandoff;
	run_id: string;
	allowed_origins: readonly string[];
	steps: readonly AgentBrowserTaskStep[];
	target: AgentBrowserTargetRequest;
};

/**
 * Target preflight truth. Raw tab identity is transient execution input only.
 */
export type AgentBrowserTargetResolutionResult =
	| {
			ok: true;
			target_tab_id: string;
			/** Canonical CDP target identity supplied by Agent Browser 0.34. */
			target_id: string;
			/** Process-local resolution evidence. Never persist this URL. */
			target_url: string;
			binding: AgentBrowserTargetBinding;
	  }
	| Extract<AgentBrowserExecutionResult, { ok: false }>;

/**
 * Structured command seam shared with the Browser Use process runtime.
 */
export type AgentBrowserExecutionRuntime = {
	runCommand(input: McporterCommandInput): Promise<McporterCommandResult>;
	/**
	 * Persist write-ahead mutation truth before a native mutation command.
	 *
	 * The executor refuses when this seam is absent or cannot record the marker.
	 */
	beforeMutationDispatch?(
		input: Readonly<{ run_id: string }>,
	): Promise<{ ok: true } | { ok: false }>;
	/**
	 * Persist one iterated mutation's structural outcome before a later item.
	 *
	 * Structurally false postconditions collapse to `unknown` for durable retry
	 * safety because the mutation may already have changed browser state.
	 *
	 * A confirmed mutation whose checkpoint cannot be recorded becomes unknown;
	 * the executor stops so no later item can pass uncommitted truth.
	 */
	afterItemCheckpoint?(
		input: Readonly<{
			run_id: string;
			item_key: string;
			outcome: "confirmed" | "unknown";
		}>,
	): Promise<{ ok: true } | { ok: false }>;
};

async function checkpointItem(
	runtime: AgentBrowserExecutionRuntime,
	input: Readonly<{
		run_id: string;
		item_key: string;
		outcome: "confirmed" | "unknown";
	}>,
): Promise<boolean> {
	try {
		return (await runtime.afterItemCheckpoint?.(input))?.ok === true;
	} catch {
		return false;
	}
}

/**
 * Stable native lane refusal codes.
 */
export type AgentBrowserExecutionFailureCode =
	| "agent_browser_handoff_invalid"
	| "agent_browser_task_invalid"
	| "agent_browser_connection_unstable"
	| "agent_browser_target_unavailable"
	| "agent_browser_target_ambiguous"
	| "agent_browser_target_moved"
	| "agent_browser_target_origin_refused"
	| "agent_browser_command_failed"
	| "agent_browser_current_snapshot_required"
	| "agent_browser_ref_invalid"
	| "agent_browser_confidential_input_requires_auth_transaction"
	| "agent_browser_confidential_delivery_blocked"
	| "agent_browser_action_integrity_refused"
	| "agent_browser_action_target_refused"
	| "agent_browser_action_read_not_achieved"
	| "agent_browser_mutation_marker_unavailable"
	| "agent_browser_item_checkpoint_unavailable"
	| "agent_browser_mutation_effect_unknown"
	| "agent_browser_postcondition_not_achieved";

/**
 * Inspectable evidence of what a bounded reconnect actually observed (release
 * theme "no flaky CDP connections"). It is diagnostic only — never a retry
 * authority — and carries the adapter's own connection-class signal verbatim so
 * a caller can distinguish a genuinely-down browser from transient flakiness.
 */
export type AgentBrowserConnectionDiagnostic = {
	attempts: number;
	max_attempts: number;
	last_signal: string;
	next_repair_action: string;
};

/**
 * Structural evidence a confidential-field delivery produced inside this task
 * (auth plan U5). It is secret-free by construction: the delivered field shapes
 * (kind + byte length) feed the sentinel owner, the FSM method-step-complete
 * events name the ordered steps the auth transaction must record, and the
 * resume directive names the discard-stale-refs / fresh-identity-basis demand
 * the lane obeyed. Never a value on any field.
 */
export type AgentBrowserDeliveryEvidence = {
	delivered_shapes: readonly BrowserUseDeliveredFieldShape[];
	method_step_events: readonly BrowserUseAuthMethodStep[];
	resume: BrowserUseDeliveryResumeDirective;
};

/**
 * One read `evaluate` action's raw evaluated data, keyed by its action id
 * (R21, R24). The executor carries the raw value ONLY as far as the runbook
 * engine, which validates and redacts it through `captureStructuredResult`
 * before any of it reaches durable shared-run state. A read action that emits
 * no native `result` field yields `data: undefined` — a clean empty observation, never a
 * fabricated value. This shape never rides a mutation result and never carries
 * adapter stdout, endpoints, or secrets past the engine's redaction admission.
 */
export type AgentBrowserReadResult = {
	action_id: string;
	/** Stable identity when this read came from an expanded iterate item. */
	item_key?: string;
	data: unknown;
};


/**
 * Native Agent Browser execution result. It carries structural truth only,
 * never adapter stdout, page text, field values, endpoints, or secrets.
 */
export type AgentBrowserExecutionResult =
	| {
			ok: true;
			outcome: "confirmed";
			executed_steps: number;
			target_tab_id: string;
			mutation_dispatched: boolean;
			/** Non-fatal debt when the adapter session could not be released. */
			release?: AdapterSessionReleaseDebt;
			/** Present only when a confidential delivery engaged in this task. */
			delivery?: AgentBrowserDeliveryEvidence;
			/**
			 * Raw evaluated data from each read `evaluate` action in this task, in
			 * execution order (R21, R24). Empty unless a read action ran. The engine
			 * is the only consumer: it validates + redacts each entry before the
			 * bounded structured result reaches durable state.
			 */
			read_results?: readonly AgentBrowserReadResult[];
	  }
	| {
			ok: false;
			code: AgentBrowserExecutionFailureCode;
			outcome: "not-achieved" | "unknown";
			message: string;
			executed_steps: number;
			mutation_dispatched: boolean;
			/** Non-fatal debt when the adapter session could not be released. */
			release?: AdapterSessionReleaseDebt;
			/** Present only on `agent_browser_connection_unstable`. */
			connection?: AgentBrowserConnectionDiagnostic;
			/**
			 * Present only when a confidential delivery engaged in this task.
			 * A delivery that happened before a later failure is still delivered:
			 * the evidence rides the failure so the caller's sensitive-run guard
			 * engages regardless of the task's terminal truth.
			 */
			delivery?: AgentBrowserDeliveryEvidence;
	  };

type JsonObject = Record<string, unknown>;
type AgentBrowserExecutionFailure = Extract<
	AgentBrowserExecutionResult,
	{ ok: false }
>;

function failure(
	code: AgentBrowserExecutionFailureCode,
	outcome: "not-achieved" | "unknown",
	message: string,
	executedSteps = 0,
	mutationDispatched = false,
): AgentBrowserExecutionFailure {
	return {
		ok: false,
		code,
		outcome,
		message,
		executed_steps: executedSteps,
		mutation_dispatched: mutationDispatched,
	};
}

async function markMutationDispatch(
	runtime: AgentBrowserExecutionRuntime,
	task: AgentBrowserTask,
	executedSteps: number,
): Promise<AgentBrowserExecutionFailure | undefined> {
	if (runtime.beforeMutationDispatch === undefined) {
		return failure(
			"agent_browser_mutation_marker_unavailable",
			"not-achieved",
			"Mutation dispatch was refused because durable write-ahead truth is unavailable.",
			executedSteps,
		);
	}
	try {
		const marked = await runtime.beforeMutationDispatch({ run_id: task.run_id });
		if (marked.ok) return undefined;
	} catch {
		// The durable owner supplies repair detail outside the executor. This lane
		// carries only structural refusal truth.
	}
	return failure(
		"agent_browser_mutation_marker_unavailable",
		"not-achieved",
		"Mutation dispatch was refused because durable write-ahead truth could not be recorded.",
		executedSteps,
	);
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function parseSuccessData(stdout: string): JsonObject | undefined {
	try {
		const envelope = asObject(JSON.parse(stdout));
		if (envelope?.success !== true) return undefined;
		return asObject(envelope.data);
	} catch {
		return undefined;
	}
}

function actionIntegrityIsValid(
	step: Extract<AgentBrowserTaskStep, { kind: "evaluate" }>,
	allowedOrigins: ReadonlySet<string>,
): boolean {
	if (
		!SAFE_RUN_ID.test(step.action_id) ||
		(step.item_key !== undefined && !SAFE_BATCH_ITEM_KEY.test(step.item_key)) ||
		step.review_status !== "approved" ||
		step.script.length === 0 ||
		step.script.length > 100_000 ||
		!allowedOrigins.has(step.allowed_origin) ||
		step.script_sha256 !==
			createHash("sha256").update(step.script).digest("hex") ||
		(step.effect === "mutation" && step.postcondition === undefined)
	) {
		return false;
	}
	try {
		return (
			Buffer.byteLength(reviewedActionPayload(step), "utf-8") <=
			TRANSPORT_STDIN_MAX_BYTES
		);
	} catch {
		return false;
	}
}

function reviewedActionPayload(
	step: Extract<AgentBrowserTaskStep, { kind: "evaluate" }>,
): string {
	// Emit a single async-IIFE EXPRESSION, not a top-level `await` statement: the
	// native `eval` harness evaluates the payload as one expression and awaits the
	// returned promise. A bare `await action(...)` is top-level await, which the
	// evaluation context rejects with `SyntaxError: await is only valid in async
	// functions`, failing every async reviewed action before it runs.
	return `(async () => { const action = (${step.script}); return await action({ inputs: ${JSON.stringify(step.inputs)} }); })()`;
}

type AgentBrowserCommandContext = Pick<
	AgentBrowserTask,
	"handoff" | "run_id"
>;

function baseArgs(
	task: AgentBrowserCommandContext,
	strictTabBinding: boolean,
): string[] {
	return [
		"--cdp",
		task.handoff.endpoint.ws,
		"--session",
		deriveSessionName(task.run_id),
		...(strictTabBinding ? ["--pin-tab"] : []),
	];
}

async function runNative(
	runtime: AgentBrowserExecutionRuntime,
	task: AgentBrowserCommandContext,
	args: readonly string[],
	stdinText?: string,
): Promise<McporterCommandResult | undefined> {
	try {
		return await runtime.runCommand({
			command: task.handoff.attachment.probe_executable,
			args: [...baseArgs(task, true), ...args],
			...(stdinText === undefined ? {} : { stdinText }),
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
}

async function runNativeUnpinned(
	runtime: AgentBrowserExecutionRuntime,
	task: AgentBrowserCommandContext,
	args: readonly string[],
): Promise<McporterCommandResult | undefined> {
	try {
		return await runtime.runCommand({
			command: task.handoff.attachment.probe_executable,
			args: [...baseArgs(task, false), ...args],
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
}

function commandSucceeded(result: McporterCommandResult | undefined): boolean {
	return (
		result !== undefined &&
		result.exitCode === 0 &&
		result.timedOut !== true &&
		parseSuccessData(result.stdout) !== undefined
	);
}

type AgentBrowserValidationInput = Pick<
	AgentBrowserTask,
	"handoff" | "run_id" | "allowed_origins" | "steps"
>;

function validateExecutionContext(
	task: AgentBrowserValidationInput,
):
	| { ok: true; allowedOrigins: ReadonlySet<string> }
	| AgentBrowserExecutionFailure {
	if (
		task.handoff.contract_id !== HANDOFF_CONTRACT_ID ||
		task.handoff.schema_version !== HANDOFF_SCHEMA_VERSION ||
		task.handoff.outcome !== "verified" ||
		task.handoff.attachment.adapter_id !== "agent-browser" ||
		task.handoff.attachment.route !== "explicit-cdp" ||
		task.handoff.browser_entry_mode !== "explicit-cdp" ||
		task.handoff.proof.route_evidence !== "verified-live" ||
		!isAbsolute(task.handoff.attachment.probe_executable) ||
		task.handoff.endpoint.ws.length === 0
	) {
		return failure(
			"agent_browser_handoff_invalid",
			"not-achieved",
			"Agent Browser execution requires a schema-2 verified-live Browser Connect handoff for the agent-browser lane.",
		);
	}
	if (!SAFE_RUN_ID.test(task.run_id)) {
		return failure(
			"agent_browser_task_invalid",
			"not-achieved",
			"Run identity must be a bounded safe identifier.",
		);
	}
	const allowedOrigins = agentBrowserAllowedOriginSet(task.allowed_origins);
	if (allowedOrigins === undefined) {
		return failure(
			"agent_browser_task_invalid",
			"not-achieved",
			"At least one exact HTTP(S) origin is required.",
		);
	}
	if (
		task.steps.some(
			(step) =>
				step.kind === "click-semantic" &&
				!semanticClickInputIsValid({
					role: step.role,
					name: step.name,
					visibleSelector: step.postcondition.selector,
				}),
		)
	) {
		return failure(
			"agent_browser_task_invalid",
			"not-achieved",
			"Semantic click targets require one bounded accessible role and name.",
		);
	}
	return { ok: true, allowedOrigins };
}

function validateTask(
	task: AgentBrowserTask,
):
	| { ok: true; allowedOrigins: ReadonlySet<string> }
	| AgentBrowserExecutionFailure {
	const validation = validateExecutionContext(task);
	if (!validation.ok) return validation;
	if (!SAFE_TAB_ID.test(task.target_tab_id)) {
		return failure(
			"agent_browser_task_invalid",
			"not-achieved",
			"Tab identity must be a bounded safe identifier.",
		);
	}
	if (
		task.expected_target_url !== undefined &&
		(task.expected_target_url.length === 0 ||
			task.expected_target_url.length > 8192 ||
			(!agentBrowserOriginIsAllowed(
				task.expected_target_url,
				validation.allowedOrigins,
			) &&
				!(
					task.allow_neutral_target === true &&
					neutralTargetIsAllowed(task.expected_target_url, task.steps)
				)))
	) {
		return failure(
			"agent_browser_task_invalid",
			"not-achieved",
			"Expected target URL must be a bounded exact URL.",
		);
	}
	return validation;
}

/**
 * Resolve one exact execution target through a verified handoff.
 *
 * This wrapper owns the native argv so callers never reconstruct the Browser
 * Connect attachment contract. Persist only `binding`; pass `target_tab_id`
 * directly to the immediate executor call.
 *
 * @param runtime - Structured no-shell command runner
 * @param input - Verified handoff, target policy, remaining steps, and request
 * @returns One canonical CDP target id plus opaque binding, or typed repair truth
 */
export async function resolveAgentBrowserTaskTarget(
	runtime: AgentBrowserExecutionRuntime,
	input: AgentBrowserTargetResolutionInput,
): Promise<AgentBrowserTargetResolutionResult> {
	const validation = validateExecutionContext(input);
	if (!validation.ok) return validation;
	if (
		!/^[a-f0-9]{32}$/.test(input.target.target_envelope_id) ||
		(input.target.kind === "exact" && !SAFE_TAB_ID.test(input.target.tab_id)) ||
		(input.target.kind === "auto" &&
			input.target.bound_target_candidate_id !== undefined &&
			!/^[a-f0-9]{24}$/.test(input.target.bound_target_candidate_id))
	) {
		return failure(
			"agent_browser_task_invalid",
			"not-achieved",
			"Target requests require bounded exact or opaque identities.",
		);
	}
	const nativeCommand = (args: readonly string[]) =>
		runNativeUnpinned(runtime, input, args);
	const resolution = await resolveAgentBrowserTarget(
		nativeCommand,
		input,
		validation.allowedOrigins,
	);
	const release = await releaseAgentBrowserSession({
		env: {},
		runCommand: runtime.runCommand,
		probeExecutable: input.handoff.attachment.probe_executable,
		runId: input.run_id,
	});
	if (resolution.ok) {
		return release.released
			? resolution
			: {
					...failure(
						"agent_browser_command_failed",
						"not-achieved",
						"Agent Browser resolved the target but could not release its discovery session before custody admission.",
					),
					release,
				};
	}
	return release.released ? resolution : { ...resolution, release };
}

/**
 * Execute one bounded task through Agent Browser's native CLI.
 *
 * Browser Connect remains the only attachment owner: this consumer uses the
 * handed-off executable and endpoint verbatim, names one session and one tab,
 * requires a current snapshot before ref mutation, discards refs after every
 * mutation, and verifies fresh structure before reporting confirmed.
 *
 * @param runtime - Structured no-shell command runner
 * @param task - Verified handoff, target, origin policy, and bounded steps
 * @returns Structural task truth with no raw adapter or page output
 *
 * @example
 * ```ts
 * const result = await executeAgentBrowserTask(runtime, task)
 * if (!result.ok && result.outcome === "unknown") inspectBeforeRetry()
 * ```
 */
export async function executeAgentBrowserTask(
	runtime: AgentBrowserExecutionRuntime,
	task: AgentBrowserTask,
): Promise<AgentBrowserExecutionResult> {
	const validation = validateTask(task);
	if (!validation.ok) return validation;
	if (
		task.steps.some(
			(step) =>
				step.kind === "evaluate" &&
				step.effect === "mutation" &&
				step.item_key !== undefined,
		) &&
		runtime.afterItemCheckpoint === undefined
	) {
		return failure(
			"agent_browser_item_checkpoint_unavailable",
			"not-achieved",
			"An iterated mutation requires a durable per-item checkpoint seam before browser dispatch.",
		);
	}
	const nativeCommand = (args: readonly string[]) =>
		runNative(runtime, task, args);
	const unpinnedNativeCommand = (args: readonly string[]) =>
		runNativeUnpinned(runtime, task, args);
	const targetFailure = await selectAgentBrowserTarget(
		unpinnedNativeCommand,
		task,
		validation.allowedOrigins,
		nativeCommand,
	);
	let taskOutcome: AgentBrowserExecutionResult | undefined = targetFailure;

	let currentRefs = new Set<string>();
	let currentRefMetadata = new Map<string, { role: string; name: string }>();
	let hasCurrentSnapshot = false;
	let executedSteps = 0;
	let mutationDispatched = false;
	// Raw read-action data captured across this task's read `evaluate` steps
	// (R21, R24). Stays empty for mutation-only or ref-only tasks. The engine
	// validates + redacts each entry; the executor never persists it.
	const readResults: AgentBrowserReadResult[] = [];
	// Confidential-delivery evidence accumulates across the task's confidential
	// fills (auth plan U5): the delivered shapes feed the sentinel owner, the
	// method-step-complete events name the FSM steps the auth transaction records,
	// and the last resume directive carries the discard-refs / fresh-identity
	// demand. Empty unless the auth-delivery context engages at least once.
	const deliveredShapes: BrowserUseDeliveredFieldShape[] = [];
	const methodStepEvents: BrowserUseAuthMethodStep[] = [];
	let lastResume: BrowserUseDeliveryResumeDirective | undefined;
	// A failure AFTER at least one delivered shape must still carry the delivery
	// evidence: the secret already reached the page, so the caller's sensitive-run
	// guard has to engage even though the task did not confirm. Invariant:
	// lastResume is defined whenever deliveredShapes is non-empty (both are set
	// together on a successful delivery); the guard below enforces it structurally.
	const withDelivery = (
		result: AgentBrowserExecutionFailure,
	): AgentBrowserExecutionFailure =>
		deliveredShapes.length > 0 && lastResume !== undefined
			? {
					...result,
					delivery: {
						delivered_shapes: [...deliveredShapes],
						method_step_events: [...methodStepEvents],
						resume: lastResume,
					},
				}
			: result;
	for (const step of taskOutcome === undefined ? task.steps : []) {
		if (step.kind === "snapshot") {
			const result = await runNative(runtime, task, [
				"snapshot",
				...(step.interactive ? ["-i"] : []),
				"--json",
			]);
			if (!commandSucceeded(result)) {
				taskOutcome = withDelivery(failure(
					"agent_browser_command_failed",
					"not-achieved",
					"Agent Browser could not observe fresh page structure.",
					executedSteps,
				));
				break;
			}
			const projected = projectAgentBrowserSnapshotRefs(
				parseSuccessData(result?.stdout ?? "")?.refs,
			);
			currentRefs = new Set(projected.refs);
			currentRefMetadata = new Map(projected.metadata);
			hasCurrentSnapshot = true;
			executedSteps += 1;
			continue;
		}

		if (step.kind === "open") {
			if (!agentBrowserOriginIsAllowed(step.url, validation.allowedOrigins)) {
				taskOutcome = withDelivery(failure(
					"agent_browser_target_origin_refused",
					"not-achieved",
					"Navigation is outside the task's allowed origins.",
					executedSteps,
				));
				break;
			}
			const markerFailure = await markMutationDispatch(
				runtime,
				task,
				executedSteps,
			);
			if (markerFailure !== undefined) {
				taskOutcome = withDelivery(markerFailure);
				break;
			}
			mutationDispatched = true;
			const opened = await runNative(runtime, task, ["open", step.url, "--json"]);
			currentRefs = new Set();
			currentRefMetadata = new Map();
			hasCurrentSnapshot = false;
			if (!commandSucceeded(opened)) {
				taskOutcome = withDelivery(failure(
					"agent_browser_mutation_effect_unknown",
					"unknown",
					"Navigation may have reached the browser; inspect before retry.",
					executedSteps,
					mutationDispatched,
				));
				break;
			}
			const verified = await verifyAgentBrowserPostcondition(
				nativeCommand,
				step.postcondition,
				validation.allowedOrigins,
			);
			if (verified !== "confirmed") {
				taskOutcome = withDelivery(failure(
					verified === "unavailable"
						? "agent_browser_mutation_effect_unknown"
						: "agent_browser_postcondition_not_achieved",
					verified === "unavailable" ? "unknown" : "not-achieved",
					verified === "unavailable"
						? "Navigation completed without fresh structural proof; inspect before retry."
						: "Fresh structure did not satisfy the declared navigation postcondition.",
					executedSteps + 1,
					mutationDispatched,
				));
				break;
			}
			executedSteps += 1;
			continue;
		}

		if (!hasCurrentSnapshot) {
			taskOutcome = withDelivery(failure(
				"agent_browser_current_snapshot_required",
				"not-achieved",
				"A fresh task-local snapshot is required immediately before ref mutation.",
				executedSteps,
			));
			break;
		}
		if (step.kind === "evaluate") {
			if (!actionIntegrityIsValid(step, validation.allowedOrigins)) {
				taskOutcome = withDelivery(failure(
					"agent_browser_action_integrity_refused",
					"not-achieved",
					"Evaluated actions require an approved hash-bound script, admitted origin, bounded input, and mutation postcondition.",
					executedSteps,
				));
				break;
			}
			const currentUrl = await runNative(runtime, task, ["get", "url", "--json"]);
			const observedUrl = parseSuccessData(currentUrl?.stdout ?? "")?.url;
			if (
				!commandSucceeded(currentUrl) ||
				typeof observedUrl !== "string" ||
				!agentBrowserHasExactOrigin(observedUrl, step.allowed_origin)
			) {
				taskOutcome = withDelivery(failure(
					"agent_browser_action_target_refused",
					"not-achieved",
					"The reviewed action's exact allowed origin is not freshly proven.",
					executedSteps,
				));
				break;
			}
			if (step.effect === "mutation") {
				const markerFailure = await markMutationDispatch(
					runtime,
					task,
					executedSteps,
				);
				if (markerFailure !== undefined) {
					taskOutcome = withDelivery(markerFailure);
					break;
				}
				mutationDispatched = true;
			}
			const evaluated = await runNative(
				runtime,
				task,
				["eval", "--stdin", "--json"],
				reviewedActionPayload(step),
			);
			currentRefs = new Set();
			currentRefMetadata = new Map();
			hasCurrentSnapshot = false;
			if (!commandSucceeded(evaluated)) {
				// A mutation that may have dispatched is `unknown` (no retry). A read
				// dispatches no browser effect, so its failure is a clean
				// `not-achieved` — it never manufactures a possible mutation (R21).
				if (
					step.effect === "mutation" &&
					step.item_key !== undefined
				) {
					await checkpointItem(runtime, {
						run_id: task.run_id,
						item_key: step.item_key,
						outcome: "unknown",
					});
				}
				taskOutcome = withDelivery(
					step.effect === "mutation"
						? failure(
								"agent_browser_mutation_effect_unknown",
								"unknown",
								"The reviewed action may have dispatched browser effects; inspect before retry.",
								executedSteps,
								mutationDispatched,
							)
						: failure(
								"agent_browser_action_read_not_achieved",
								"not-achieved",
								"The reviewed read action did not return an observation.",
								executedSteps,
								mutationDispatched,
							),
				);
				break;
			}
			if (step.effect === "read") {
				// Carry the raw read observation only as far as the engine, which
				// validates + redacts it (R21). A read that emits no `result` field is a
				// clean empty observation.
				readResults.push({
					action_id: step.action_id,
					...(step.item_key !== undefined ? { item_key: step.item_key } : {}),
					data: parseSuccessData(evaluated?.stdout ?? "")?.result,
				});
			}
			if (step.effect === "mutation" && step.postcondition !== undefined) {
				const verified = await verifyAgentBrowserPostcondition(
					nativeCommand,
					step.postcondition,
					validation.allowedOrigins,
				);
				if (verified !== "confirmed") {
					if (
						step.item_key !== undefined
					) {
						await checkpointItem(runtime, {
							run_id: task.run_id,
							item_key: step.item_key,
							outcome: "unknown",
						});
					}
					taskOutcome = withDelivery(failure(
						verified === "unavailable"
							? "agent_browser_mutation_effect_unknown"
							: "agent_browser_postcondition_not_achieved",
						verified === "unavailable" ? "unknown" : "not-achieved",
						verified === "unavailable"
							? "Reviewed mutation completed without fresh structural proof; inspect before retry."
							: "Fresh structure did not satisfy the reviewed action postcondition.",
						executedSteps + 1,
						mutationDispatched,
					));
					break;
				}
				if (step.item_key !== undefined) {
					const checkpointed = await checkpointItem(runtime, {
						run_id: task.run_id,
						item_key: step.item_key,
						outcome: "confirmed",
					});
					if (!checkpointed) {
						taskOutcome = withDelivery(failure(
							"agent_browser_mutation_effect_unknown",
							"unknown",
							"The iterated mutation confirmed structurally, but its durable item checkpoint could not be recorded; inspect before retry.",
							executedSteps + 1,
							mutationDispatched,
						));
						break;
					}
				}
			}
			executedSteps += 1;
			continue;
		}
		const semanticTarget: { role: string; name: string } | undefined =
			step.kind === "click-semantic"
				? { role: step.role, name: step.name }
				: step.kind === "fill" && step.target !== undefined
					? step.target
					: undefined;
		const mutationRef =
			semanticTarget !== undefined
				? resolveUniqueSemanticRef(
						{ refs: currentRefs, metadata: currentRefMetadata },
						semanticTarget,
					)
				: step.kind === "click-semantic"
					? undefined
					: step.ref;
		if (
			mutationRef === undefined ||
			!SAFE_REF.test(mutationRef) ||
			!currentRefs.has(mutationRef)
		) {
			taskOutcome = withDelivery(failure(
				"agent_browser_ref_invalid",
				"not-achieved",
				semanticTarget !== undefined
					? "The semantic mutation target did not resolve to exactly one ref in the current task-local snapshot."
					: "The requested ref is absent from the current task-local snapshot.",
				executedSteps,
			));
			break;
		}
		if (!(step.kind === "fill" && step.sensitivity === "confidential")) {
			const originProof = await reproveAgentBrowserOrigin(
				nativeCommand,
				validation.allowedOrigins,
			);
			if (originProof !== "allowed") {
				taskOutcome = withDelivery(failure(
					originProof === "refused"
						? "agent_browser_target_origin_refused"
						: "agent_browser_target_unavailable",
					"not-achieved",
					originProof === "refused"
						? "The selected tab moved outside the task's allowed origins before mutation."
						: "The selected tab's exact origin could not be freshly proven before mutation.",
					executedSteps,
				));
				break;
			}
		}
		if (step.kind === "fill" && step.sensitivity === "confidential") {
			const delivery = task.auth_delivery;
			// Default (no auth-delivery context, or the transaction is not in its
			// sensitive-interval): the typed refusal stands unchanged. A missing
			// TokenRetrievalPort (native capability absent) means the auth wiring
			// supplies no context, so this refusal is exactly the pre-U5 behavior.
			if (delivery === undefined || !delivery.in_sensitive_interval) {
				taskOutcome = withDelivery(failure(
					"agent_browser_confidential_input_requires_auth_transaction",
					"not-achieved",
					"Confidential input must use the Browser Authentication Transaction.",
					executedSteps,
				));
				break;
			}
			// The context is present and we are inside the sensitive interval: route
			// this field through the Confidential Field Delivery choreography instead
			// of the executor's own `fill`. The choreography re-proves the target,
			// mints an opaque handle, and performs one bounded write inside the
			// disposable delivery helper — the executor never observes a value.
			const field =
				step.item_binding === undefined
					? undefined
					: delivery.field_by_binding_slug[step.item_binding];
			if (field === undefined) {
				taskOutcome = withDelivery(failure(
					"agent_browser_confidential_delivery_blocked",
					"not-achieved",
					"The confidential fill binding has no mapped credential field in the auth-delivery context.",
					executedSteps,
				));
				break;
			}
			const outcome = await deliverConfidentialFields({
				binding: delivery.binding,
				target: delivery.target,
				fields: [field],
				tokenRetrieval: delivery.tokenRetrieval,
				deliver: delivery.deliver,
				reproveTarget: delivery.reproveTarget,
			});
			// The resume directive demands stale refs be discarded before any
			// post-auth proof (R15/R22): drop the current snapshot now so the
			// step's postcondition re-observes fresh structure, never a stale ref.
			currentRefs = new Set();
			currentRefMetadata = new Map();
			hasCurrentSnapshot = false;
			if (!outcome.ok) {
				// A blocked delivery is a not-achieved refusal carrying the auth
				// choreography's own blocked cause; the executor never invents a
				// retry — the caller inspects the blocked cause before resuming.
				// withDelivery: an earlier fill in this task may already have
				// delivered, so prior evidence still rides this refusal.
				taskOutcome = withDelivery({
					ok: false,
					code: "agent_browser_confidential_delivery_blocked",
					outcome: "not-achieved",
					message: `Confidential field delivery was blocked (${outcome.blocked.blocked_cause}); resolve the blocked cause through the Browser Authentication Transaction before resuming.`,
					executed_steps: executedSteps,
					mutation_dispatched:
						mutationDispatched || outcome.blocked.external_effect_possible,
				});
				break;
			}
			mutationDispatched = true;
			for (const shape of outcome.resume.delivered_shapes) {
				deliveredShapes.push(shape);
				methodStepEvents.push(METHOD_STEP_BY_FIELD[shape.field]);
			}
			lastResume = outcome.resume;
			// Post-auth proof: the delivered field's structural postcondition, freshly
			// observed after the resume directive discarded stale refs.
			const verified = await verifyAgentBrowserPostcondition(
				nativeCommand,
				step.postcondition,
				validation.allowedOrigins,
			);
			if (verified !== "confirmed") {
				taskOutcome = withDelivery(failure(
					verified === "unavailable"
						? "agent_browser_mutation_effect_unknown"
						: "agent_browser_postcondition_not_achieved",
					verified === "unavailable" ? "unknown" : "not-achieved",
					verified === "unavailable"
						? "Confidential delivery completed without fresh structural proof; inspect before retry."
						: "Fresh structure did not satisfy the confidential fill postcondition.",
					executedSteps + 1,
					mutationDispatched,
				));
				break;
			}
			executedSteps += 1;
			continue;
		}

		const mutationArgs =
			step.kind === "fill"
				? ["fill", mutationRef, step.value, "--json"]
				: ["click", mutationRef, "--json"];
		const markerFailure = await markMutationDispatch(
			runtime,
			task,
			executedSteps,
		);
		if (markerFailure !== undefined) {
			taskOutcome = withDelivery(markerFailure);
			break;
		}
		mutationDispatched = true;
		const mutated = await runNative(runtime, task, mutationArgs);
		currentRefs = new Set();
		currentRefMetadata = new Map();
		hasCurrentSnapshot = false;
		if (!commandSucceeded(mutated)) {
			taskOutcome = withDelivery(failure(
				"agent_browser_mutation_effect_unknown",
				"unknown",
				"Agent Browser may have dispatched the mutation; inspect before retry.",
				executedSteps,
				mutationDispatched,
			));
			break;
		}
		const verified = await verifyAgentBrowserPostcondition(
			nativeCommand,
			step.postcondition,
			validation.allowedOrigins,
		);
		if (verified !== "confirmed") {
			taskOutcome = withDelivery(failure(
				verified === "unavailable"
					? "agent_browser_mutation_effect_unknown"
					: "agent_browser_postcondition_not_achieved",
				verified === "unavailable" ? "unknown" : "not-achieved",
				verified === "unavailable"
					? "Mutation completed without fresh structural proof; inspect before retry."
					: "Fresh structure did not satisfy the declared mutation postcondition.",
				executedSteps + 1,
				mutationDispatched,
			));
			break;
		}
		executedSteps += 1;
	}

	if (taskOutcome === undefined) {
		taskOutcome = {
			ok: true,
			outcome: "confirmed",
			executed_steps: executedSteps,
			target_tab_id: task.target_tab_id,
			mutation_dispatched: mutationDispatched,
			...(lastResume !== undefined
				? {
						delivery: {
							delivered_shapes: deliveredShapes,
							method_step_events: methodStepEvents,
							resume: lastResume,
						},
					}
				: {}),
			...(readResults.length > 0 ? { read_results: readResults } : {}),
		};
	}

	const release = await releaseAgentBrowserSession({
		env: {},
		runCommand: runtime.runCommand,
		probeExecutable: task.handoff.attachment.probe_executable,
		runId: task.run_id,
	});
	if (release.released) return taskOutcome;
	if (!taskOutcome.ok) return { ...taskOutcome, release };
	return withDelivery(
		failure(
			"agent_browser_command_failed",
			"unknown",
			"The task reached its terminal browser outcome, but the owning Agent Browser session could not be released; inspect custody before continuing.",
			executedSteps,
			mutationDispatched,
		),
	);
}

// ---------------------------------------------------------------------------
// Pause/resume continuity around confidential delivery (R18, AE10).
//
// The task lane pauses at the confidential step; the choreography
// (browser-use-confidential-field-delivery.ts) emits the resume directive.
// This section is the lane-side obedience: discard every adapter ref captured
// before delivery and re-observe one fresh identity basis before continuing.
// Ref staleness is judged by VISIBILITY/OPERABILITY over the non-secret
// main-process CDP observer (browser-use-cdp-observer.ts) — a still-resolvable
// but hidden node IS stale. SPA logins hide rather than remove screens, so a
// succeeding DOM.resolveNode is a false still-valid signal; the observer's
// probe API never consults it.
// ---------------------------------------------------------------------------

/**
 * One adapter-local ref captured BEFORE a confidential delivery, bridged to
 * the browser-global backend node id the main-process observer can probe. The
 * bridge exists so staleness is judged by rendered visibility and operability,
 * never by the adapter ref (or its DOM node) continuing to resolve.
 */
export type AgentBrowserCapturedRef = {
	ref: string;
	backend_node_id: number;
};

/**
 * Probe-grounded staleness verdict for one captured ref. A node that still
 * resolves but is hidden or inoperable IS stale (R18): the SPA advanced by
 * hiding the previous screen, so acting through the old ref would write into
 * an invisible surface.
 */
export type AgentBrowserRefStaleness =
	| { stale: false }
	| {
			stale: true;
			cause: "ref-not-visible" | "ref-not-operable" | "ref-unobservable";
	  };

/**
 * Judge one captured ref through the observer's visibility/operability probe
 * (R18). An unobservable node (target gone, snapshot refused, or the node
 * absent from the fresh tree) is stale, not an error: the ref cannot be
 * proven live, so it must not be reused.
 *
 * @param observer - U8 main-process CDP observer bound to a verified endpoint
 * @param input - Exact CDP target id and the browser-global backend node id
 * @returns Fresh-probe staleness truth; never consults DOM.resolveNode
 */
export async function judgeAgentBrowserRefStaleness(
	observer: BrowserUseCdpObserver,
	input: { cdp_target_id: string; backend_node_id: number },
): Promise<AgentBrowserRefStaleness> {
	const probed = await observer.probeNode({
		target_id: input.cdp_target_id,
		backend_node_id: input.backend_node_id,
	});
	if (!probed.ok) return { stale: true, cause: "ref-unobservable" };
	if (!probed.probe.visible) return { stale: true, cause: "ref-not-visible" };
	if (!probed.probe.operable) return { stale: true, cause: "ref-not-operable" };
	return { stale: false };
}

/**
 * Typed reuse refusal for a ref captured before delivery. The refusal is
 * unconditional; the probe evidence names why the underlying node is (or is
 * not) still live so the caller sees the screen-advance truth, never a bare
 * policy "no".
 */
export type AgentBrowserRefReuseRefusal = {
	reusable: false;
	code: "agent_browser_stale_ref_refused";
	message: string;
	/** Probe evidence at refusal time; a still-live node is still refused. */
	staleness: AgentBrowserRefStaleness;
};

/**
 * Refuse reuse of one pre-delivery adapter ref (R18/AE10). The resume
 * directive discarded every ref captured before delivery, so reuse is refused
 * unconditionally — repair is obeying the directive through
 * {@link resumeAgentBrowserAfterDelivery}, never retrying the old ref. The
 * attached staleness verdict is freshly probed by visibility/operability.
 *
 * @param observer - U8 main-process CDP observer bound to a verified endpoint
 * @param input - Exact CDP target id and the captured pre-delivery ref
 * @returns The typed refusal with probe-grounded staleness evidence
 */
export async function refuseAgentBrowserPreDeliveryRef(
	observer: BrowserUseCdpObserver,
	input: { cdp_target_id: string; captured: AgentBrowserCapturedRef },
): Promise<AgentBrowserRefReuseRefusal> {
	const staleness = await judgeAgentBrowserRefStaleness(observer, {
		cdp_target_id: input.cdp_target_id,
		backend_node_id: input.captured.backend_node_id,
	});
	return {
		reusable: false,
		code: "agent_browser_stale_ref_refused",
		message: `Ref ${input.captured.ref} was captured before confidential delivery; obey the resume directive — discard stale refs and re-observe a fresh identity basis — instead of reusing it.`,
		staleness,
	};
}

/**
 * Input for obeying one delivery resume directive on the task lane.
 */
export type AgentBrowserResumeContinuityInput = {
	resume: BrowserUseDeliveryResumeDirective;
	/** Exact CDP target id observed fresh — never an adapter-owned page ref. */
	cdp_target_id: string;
	/** Every adapter ref the lane captured before the delivery pause. */
	captured_refs: readonly AgentBrowserCapturedRef[];
};

/**
 * Resume continuity truth. Success carries the discarded pre-delivery refs and
 * ONE fresh identity basis — the only legal source of post-resume refs. When
 * no fresh basis is observable the lane must not continue at all, and when the
 * offered CDP target is not the directive's target the lane is refused before
 * any observation happens.
 */
export type AgentBrowserResumeContinuityResult =
	| {
			ok: true;
			/** The SAME lane resumes (R5/KTD3) — identity echoed from the directive. */
			lane_id: string;
			run_id: string;
			/** Every pre-delivery ref, discarded per `resume.discard_stale_refs`. */
			discarded_refs: readonly string[];
			/** One fresh basis per `resume.require_fresh_identity_basis`. */
			basis: BrowserUseAccessibilitySnapshot;
	  }
	| {
			ok: false;
			code: "agent_browser_resume_target_mismatch";
			message: string;
	  }
	| {
			ok: false;
			code: "agent_browser_fresh_identity_basis_unavailable";
			message: string;
	  };

/**
 * Obey one resume directive before the task lane continues (R18). The offered
 * CDP target must BE the directive's target: `resume.target_id` and
 * `cdp_target_id` name the same CDP target, so a mismatch is refused before
 * any snapshot — resuming on a different target would mint an identity basis
 * the delivery never verified. Then discards every pre-delivery ref and takes
 * exactly one fresh observer snapshot as the new identity basis. The
 * directive's demands are type-level truths (`discard_stale_refs: true`,
 * `require_fresh_identity_basis: true`), so obedience is unconditional —
 * there is no branch that keeps an old ref.
 *
 * @param observer - U8 main-process CDP observer bound to a verified endpoint
 * @param input - The choreography's directive, exact CDP target, captured refs
 * @returns Fresh identity basis plus discarded refs, or a typed refusal
 *
 * @example
 * ```ts
 * const resumed = await resumeAgentBrowserAfterDelivery(observer, {
 *   resume: delivery.resume,
 *   cdp_target_id: "cdp-target-7",
 *   captured_refs: [{ ref: "@e2", backend_node_id: 41 }],
 * })
 * if (resumed.ok) continueFrom(resumed.basis)
 * ```
 */
export async function resumeAgentBrowserAfterDelivery(
	observer: BrowserUseCdpObserver,
	input: AgentBrowserResumeContinuityInput,
): Promise<AgentBrowserResumeContinuityResult> {
	if (input.cdp_target_id !== input.resume.target_id) {
		return {
			ok: false,
			code: "agent_browser_resume_target_mismatch",
			message: `The resume directive names CDP target ${input.resume.target_id} but the lane offered ${input.cdp_target_id}; resume only on the directive's target — a fresh identity basis on any other target was never verified by delivery.`,
		};
	}
	const discarded_refs = input.captured_refs.map((captured) => captured.ref);
	const observed = await observer.snapshot({
		target_id: input.cdp_target_id,
	});
	if (!observed.ok) {
		return {
			ok: false,
			code: "agent_browser_fresh_identity_basis_unavailable",
			message:
				"The resumed lane could not observe a fresh identity basis; repair the target before continuing — pre-delivery refs stay discarded.",
		};
	}
	return {
		ok: true,
		lane_id: input.resume.lane_id,
		run_id: input.resume.run_id,
		discarded_refs,
		basis: observed.snapshot,
	};
}
