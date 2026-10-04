// The Figma transport: one tools/call through the front door's selected
// MCPorter to the hosted server, planned by the shared route with cached OAuth
// only (the route adds --no-oauth to every call). prepare() plans the route and
// selects MCPorter, so nothing leaves before send().
import type { ExecutionCapabilities } from "../../../bin/adapters/contract.ts";
import { MCPORTER_REPAIR_ACTION } from "../../../bin/mcporter-custody.ts";
import { planDispatcherRoute } from "../../../bin/provider-route.ts";
import { type EnvironmentSource, safeEnvironment } from "../../../bin/safe-environment.ts";
import type { Call } from "./catalogue.ts";

export const INTERNAL_CONTEXT = "figma-adapter";
const CALL_TIMEOUT_MS = "60000";

// unsent: refused before MCPorter started, so nothing left.
// sent: MCPorter ran and the request may have reached Figma.
export type CallResult =
	| { ok: true; data: unknown }
	| { ok: false; sent: false; cause: string; repair: string }
	| { ok: false; sent: true; cause: "transport-failed" | "tool-error" | "reply-malformed" };
export type Unsent = Extract<CallResult, { sent: false }>;
export type SentResult = Exclude<CallResult, Unsent>;

// MCPorter 0.14.0 exits 1 on a tool result with isError and still prints that
// result; any other non-zero exit prints its own offline or error report, so
// Figma's reply never arrived.
function parseReply(exitCode: number, stdout: string): SentResult {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return { ok: false, sent: true, cause: exitCode === 0 ? "reply-malformed" : "transport-failed" };
	}
	if (typeof data === "object" && data !== null && (data as { isError?: unknown }).isError === true) return { ok: false, sent: true, cause: "tool-error" };
	return exitCode === 0 ? { ok: true, data } : { ok: false, sent: true, cause: "transport-failed" };
}

export interface Caller {
	prepare(call: Call): Promise<{ ok: true; send(): SentResult } | Unsent>;
	call(call: Call): Promise<CallResult>;
}

export function figmaCaller(env: EnvironmentSource, skillsRoot: string, capabilities: ExecutionCapabilities): Caller {
	const prepare: Caller["prepare"] = async ({ tool, args }) => {
		let plan: ReturnType<typeof planDispatcherRoute>;
		try {
			plan = planDispatcherRoute(["figma", "--", "call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS], skillsRoot, safeEnvironment(env), INTERNAL_CONTEXT);
		} catch {
			return { ok: false, sent: false, cause: "route-invalid", repair: "Restore skills/figma/config to the packaged Figma registry and route" };
		}
		const mcporter = await capabilities.selectMcporter();
		if (mcporter === null) return { ok: false, sent: false, cause: "mcporter-unselected", repair: MCPORTER_REPAIR_ACTION };
		return {
			ok: true,
			send() {
				const run = Bun.spawnSync([mcporter, ...plan.argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
				return parseReply(run.exitCode, run.stdout.toString());
			},
		};
	};
	return {
		prepare,
		async call(call) {
			const ready = await prepare(call);
			return ready.ok ? ready.send() : ready;
		},
	};
}
