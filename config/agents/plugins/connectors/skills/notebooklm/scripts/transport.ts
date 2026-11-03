import type { ExecutionCapabilities, SchemaRequest } from "../../../bin/adapters/contract.ts";
import { planDispatcherRoute } from "../../../bin/provider-route.ts";
import { INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment } from "../../../bin/safe-environment.ts";
import { profileContext } from "./provider.ts";
import { type InternalRead, internalInputFor, internalTool } from "./policy.ts";
import { project, projectInternal, providerFault } from "./projection.ts";

export type Reply = { ok: true; data: Record<string, unknown> } | { ok: false; cause: string };
export interface Caller {
	call(name: string, args: Record<string, unknown>): Promise<Reply>;
	internal(read: InternalRead, args: Record<string, unknown>): Promise<Reply>;
	schema(): Promise<Reply>;
}
export function caller(request: SchemaRequest, capabilities: ExecutionCapabilities): Caller {
	const profile = request.selectors.profile ?? "default";
	async function run(arguments_: string[], projection: (raw: unknown) => Record<string, unknown> | null): Promise<Reply> {
		let plan: ReturnType<typeof planDispatcherRoute>;
		try { plan = planDispatcherRoute(["notebooklm", "--select", `profile=${profile}`, "--", ...arguments_], request.skillsRoot, safeEnvironment(request.env), profileContext(profile)); }
		catch { return { ok: false, cause: "route-invalid" }; }
		const preflight = Bun.spawnSync([...capabilities.internalCommand("provider"), "--preflight"], { env: { ...safeEnvironment(request.env), [INTERNAL_INVOCATION_CONTEXT_ENV]: profileContext(profile) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		if (preflight.exitCode !== 0) return { ok: false, cause: "vendor-executable-missing" };
		const binary = await capabilities.selectMcporter();
		if (binary === null) return { ok: false, cause: "mcporter-unselected" };
		try {
			const child = Bun.spawn([binary, ...plan.argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 65000 });
			const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			if (stdout.length > 8_000_000) return { ok: false, cause: "transport-failed" };
			const parsed: unknown = JSON.parse(stdout);
			const fault = providerFault(parsed);
			if (fault !== null) return { ok: false, cause: fault };
			if (exit !== 0) return { ok: false, cause: "transport-failed" };
			const data = projection(parsed);
			return data === null ? { ok: false, cause: "projection-shape-mismatch" } : { ok: true, data };
		} catch { return { ok: false, cause: "transport-failed" }; }
	}
	return {
		call: (name, args) => run(["call", name, "--args", JSON.stringify(args), "--output", "json", "--timeout", "60000"], (raw) => project(name, raw)),
		internal: async (read, args) => {
			const checked = internalInputFor(read, args);
			if (checked === null) return { ok: false, cause: "input-invalid" };
			return run(["call", internalTool(read), "--args", JSON.stringify(checked), "--output", "json", "--timeout", "60000"], (raw) => projectInternal(read, raw));
		},
		schema: () => run(["list", "--schema", "--json", "--timeout", "60000"], (raw) => typeof raw === "object" && raw !== null && "tools" in raw && Array.isArray(raw.tools) ? { tools: raw.tools } : null),
	};
}
