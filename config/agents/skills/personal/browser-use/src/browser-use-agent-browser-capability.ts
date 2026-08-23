import {
	runAgentBrowserOperation,
	runAgentBrowserTargetOperationPlan,
	runAgentBrowserTargetTopology,
	isAgentBrowserPinnedSessionForRun,
} from "./browser-use-agent-browser";
import { releaseAgentBrowserSession } from "./browser-use-agent-browser-session";
import type {
	BrowserUseExactTargetOperationCapability,
	BrowserUseExactTargetTopologyCapability,
	BrowserUseRetainedLifecycle,
} from "./browser-use-adapter-model";
import { AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID } from "./command-contract";

/** Agent Browser translation behind the adapter-neutral exact-target interface. */
export const exactTargetCapabilitiesForPrimaryLane: {
	topology: BrowserUseExactTargetTopologyCapability;
	operation: BrowserUseExactTargetOperationCapability;
} = {
	topology: {
		adapter_id: "agent-browser",
		capability_id: AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID,
		run: async (input) => {
			const action =
				input.action.kind === "inventory"
					? { kind: "list" as const }
					: input.action.kind === "create"
						? { kind: "create" as const, url: input.action.url }
						: input.action.kind === "close"
							? { kind: "close" as const, targetId: input.action.target_id }
							: { kind: "pin" as const, targetId: input.action.target_id };
			const result = await runAgentBrowserTargetTopology({
				runtime: input.runtime,
				handoff: {
					probeExecutable: input.handoff.executable,
					endpointWs: input.handoff.endpoint_ws,
					runId: input.handoff.run_id,
				},
				action,
			});
			if (!result.ok) {
				return { ok: false, code: "exact_target_topology_unconfirmed" };
			}
			if (result.kind === "list") {
				return {
					ok: true,
					kind: "inventory",
					targets: result.tabs.map((tab) => ({
						adapter_target_ref: tab.tabId,
						canonical_target_id: tab.targetId,
						url: tab.url,
						...(tab.title === undefined ? {} : { title: tab.title }),
						...(tab.active === undefined ? {} : { active: tab.active }),
					})),
				};
			}
			if (result.kind === "create") {
				return {
					ok: true,
					kind: "create",
					data: {
						...(typeof result.data.targetId === "string"
							? { canonical_target_id: result.data.targetId }
							: {}),
					},
				};
			}
			if (result.kind === "close") return result;
			return {
				ok: true,
				kind: "retain-lifecycle",
				lifecycle_ref: result.sessionName,
			};
		},
		releaseLifecycle: async (input) =>
			await releaseAgentBrowserSession({
				env: input.env,
				runCommand: input.runtime.runCommand,
				probeExecutable: input.handoff.executable,
				runId: input.handoff.run_id,
			}),
	},
	operation: {
		adapter_id: "agent-browser",
		capability_id: AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID,
		retainedLifecycleIsValid: isAgentBrowserPinnedSessionForRun,
		run: async (request) => {
			const result = await runAgentBrowserOperation({
				runtime: request.runtime,
				env: request.env,
				handoff: {
					probeExecutable: request.handoff.executable,
					endpointWs: request.handoff.endpoint_ws,
					runId: request.handoff.run_id,
				},
				targetId: request.target_id,
				...(request.expected_url === undefined
					? {}
					: { expectedUrl: request.expected_url }),
				operation: request.operation,
				...(request.screenshot === undefined
					? {}
					: {
							screenshot: {
								path: request.screenshot.path,
								fullPage: request.screenshot.full_page,
							},
						}),
				targetPrepared: request.lifecycle_prepared,
				retainSession: request.retain_lifecycle,
			});
			if (result.ok) return result;
			return {
				...result,
				code:
					result.code === "agent_browser_operation_dependency_missing"
						? "dependency-missing"
						: result.code === "agent_browser_operation_timeout"
							? "timeout"
							: "operation-failed",
			};
		},
		runTargetPlan: async (request) =>
			runAgentBrowserTargetOperationPlan(request),
	},
};

/** Adapter-owned migration for the retired native selected-state lifecycle shape. */
export function migrateLegacyRetainedLifecycleForPrimaryLane(
	value: unknown,
	runId: string,
): BrowserUseRetainedLifecycle | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const ownership = value as Record<string, unknown>;
	const adapterSession = ownership.adapter_session;
	if (
		typeof adapterSession !== "object" ||
		adapterSession === null ||
		Array.isArray(adapterSession)
	) {
		return undefined;
	}
	const legacy = adapterSession as Record<string, unknown>;
	if (
		legacy.kind !== "agent-browser-pinned" ||
		typeof legacy.session_name !== "string" ||
		!isAgentBrowserPinnedSessionForRun(legacy.session_name, runId)
	) {
		return undefined;
	}
	return {
		adapter_id: "agent-browser",
		capability_id: AGENT_BROWSER_EXACT_TARGET_NO_FOCUS_CAPABILITY_ID,
		lifecycle_ref: legacy.session_name,
	};
}
