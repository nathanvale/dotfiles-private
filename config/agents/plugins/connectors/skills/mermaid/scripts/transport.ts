// The Mermaid account transport: one tools/call through the front door's
// selected MCPorter to the account server, whose stdio command is this
// adapter's Provider role. Before every call the Provider's --preflight runs
// directly, because MCPorter flattens a stdio child's startup refusal; a
// preflight refusal therefore keeps its closed cause and fixed repair, and
// nothing was sent. Only after MCPorter starts may a request have left, so
// prepare() does everything before that and send() only starts MCPorter.
import type { ExecutionCapabilities } from "../../../bin/adapters/contract.ts";
import { planDispatcherRoute } from "../../../bin/provider-route.ts";
import { type EnvironmentSource, INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment } from "../../../bin/safe-environment.ts";
import { ACCOUNT_SERVER } from "./catalogue.ts";
import { accountContext, itemHandoff, OP_SETUP_REPAIR, SERVICE_TOKEN_HANDOFF } from "./custody/index.ts";

const CALL_TIMEOUT_MS = "30000";
const PROVIDER_FAILURE = /^mermaid-provider:error:([a-z-]+):/m;
const CUSTODY_REPAIR = "Mermaid account custody could not produce the credential; run connectors auth check mermaid";

// unsent: refused or failed before MCPorter started, so nothing left.
// sent: MCPorter ran and the request may have reached the Provider.
export type CallResult =
	| { ok: true; data: unknown }
	| { ok: false; sent: false; cause: string; repair: string }
	| { ok: false; sent: true; cause: "transport-failed" | "tool-error" | "reply-malformed" };
export type Unsent = Extract<CallResult, { sent: false }>;
export type SentResult = Exclude<CallResult, Unsent>;

function preflightRepair(code: string, item: string): string {
	switch (code) {
		case "op-unavailable":
			return OP_SETUP_REPAIR;
		case "service-token-missing":
			return SERVICE_TOKEN_HANDOFF;
		case "item-missing":
			return itemHandoff(item);
		default:
			return CUSTODY_REPAIR;
	}
}

// The Provider's readiness, run with exactly the environment the route gives
// it. null when ready.
export function providerPreflight(env: EnvironmentSource, item: string, capabilities: ExecutionCapabilities): { cause: string; repair: string } | null {
	const run = Bun.spawnSync([...capabilities.internalCommand("provider"), "--preflight"], { env: { ...safeEnvironment(env), [INTERNAL_INVOCATION_CONTEXT_ENV]: accountContext(item) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (run.exitCode === 0 && run.stdout.length === 0 && run.stderr.length === 0) return null;
	const code = PROVIDER_FAILURE.exec(run.stderr.toString())?.[1] ?? "provider-unready";
	return { cause: code, repair: preflightRepair(code, item) };
}

// MCPorter 0.14.0 exits 1 on a tool result with isError and still prints
// that result; any other non-zero exit prints its own offline or error
// report, so the Provider's reply never arrived (observed 2026-09-26).
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

export interface AccountCaller {
	// The route, the Provider preflight, and MCPorter selection: nothing leaves.
	prepare(tool: string, args: Readonly<Record<string, unknown>>): Promise<{ ok: true; send(): SentResult } | Unsent>;
	call(tool: string, args: Readonly<Record<string, unknown>>): Promise<CallResult>;
}

export function accountCaller(env: EnvironmentSource, skillsRoot: string, item: string, capabilities: ExecutionCapabilities): AccountCaller {
	const prepare: AccountCaller["prepare"] = async (tool, args) => {
		let plan: ReturnType<typeof planDispatcherRoute>;
		try {
			plan = planDispatcherRoute(["mermaid", "--provider", ACCOUNT_SERVER, "--", "call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS], skillsRoot, safeEnvironment(env), accountContext(item));
		} catch {
			return { ok: false, sent: false, cause: "route-invalid", repair: "Restore skills/mermaid/config/mcporter.json to the packaged account entry" };
		}
		const unready = providerPreflight(env, item, capabilities);
		if (unready) return { ok: false, sent: false, ...unready };
		const mcporter = await capabilities.selectMcporter();
		if (mcporter === null) return { ok: false, sent: false, cause: "mcporter-unselected", repair: "Run connectors deps repair mcporter" };
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
		async call(tool, args) {
			const ready = await prepare(tool, args);
			return ready.ok ? ready.send() : ready;
		},
	};
}
