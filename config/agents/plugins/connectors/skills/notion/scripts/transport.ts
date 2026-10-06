import type { ExecutionCapabilities } from "../../../bin/adapters/contract.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import type { Call } from "./catalogue.ts";
import { record, toolData } from "./catalogue.ts";
import { planNotionRoute, prepareVault } from "./custody.ts";

export type Reply = { ok: true; data: unknown } | { ok: false; sent: boolean; cause: string; data?: unknown };
export interface Caller {
	prepare(call: Call): Promise<{ ok: true; send(): Reply } | { ok: false; sent: false; cause: string }>;
	call(call: Call): Promise<Reply>;
}
function terminalToolError(data: unknown): boolean {
	// Only this hosted Notion error has been qualified as a terminal rejection.
	// Generic MCP isError may describe a timeout or internal partial failure.
	const value = toolData(data);
	return record(value) && value.status === 400 && value.code === "validation_error" && typeof value.message === "string" && value.message.length > 0;
}
function outputReply(stdout: string, exitCode: number): Reply {
	try {
		const data: unknown = JSON.parse(stdout);
		// Native diagnostics may omit issue metadata. Every unrecognized nonzero
		// result is indeterminate, even when it is valid JSON.
		if (exitCode === 1 && terminalToolError(data)) return { ok: false, sent: true, cause: "tool-error", data };
		return exitCode === 0 ? { ok: true, data } : { ok: false, sent: true, cause: "transport-failed" };
	} catch { return { ok: false, sent: true, cause: "transport-failed" }; }
}
export function notionCaller(env: EnvironmentSource, skillsRoot: string, account: string, capabilities: ExecutionCapabilities): Caller {
	const prepare: Caller["prepare"] = async ({ tool, args }) => {
		let selection: ReturnType<typeof planNotionRoute>;
		try { selection = planNotionRoute(env, account, ["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", "60000"], skillsRoot); }
		catch { return { ok: false, sent: false, cause: "route-invalid" }; }
		const mcporter = await capabilities.selectMcporter();
		if (mcporter === null) return { ok: false, sent: false, cause: "mcporter-unselected" };
		try { prepareVault(selection.vault); } catch { return { ok: false, sent: false, cause: "vault-root-invalid" }; }
		return {
			ok: true,
			send() {
				try {
					const run = Bun.spawnSync([mcporter, ...selection.plan.argv], { env: selection.plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
					return outputReply(run.stdout.toString(), run.exitCode);
				} catch { return { ok: false, sent: true, cause: "transport-failed" }; }
			},
		};
	};
	return { prepare, async call(call) { const ready = await prepare(call); return ready.ok ? ready.send() : ready; } };
}
