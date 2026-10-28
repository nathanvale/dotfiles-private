import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ExecutionCapabilities, SchemaRequest } from "../../../bin/adapters/contract.ts";
import { ownedDirectory, stateRoot } from "../../../bin/private-state.ts";
import { planDispatcherRoute } from "../../../bin/provider-route.ts";
import { runMcporter } from "./mcporter.ts";
import { ConsoleRefusal, record, scriptRefusal, unwrap } from "./model.ts";
import { CANONICAL_PATH, namespace, type Profile, profileRoot, verifyPayload } from "./profile.ts";

export const CONTEXT = "figma-console-adapter-v1";
export const SERVER = "figma-console-local";
export const TOOLS = ["figma_execute", "figma_get_status", "figma_get_variables", "figma_get_file_data", "figma_get_component", "figma_analyze_component_set", "figma_lint_design", "figma_audit_component_accessibility", "figma_get_design_changes", "figma_get_file_versions", "figma_take_screenshot", "figma_export_tokens"] as const;

export interface ConsoleCaller {
	call(tool: typeof TOOLS[number], args: Record<string, unknown>): Promise<unknown>;
	daemon(verb: "start" | "status" | "stop"): Promise<unknown>;
}

// Identity includes effective environment and cwd in MCPorter 0.14.0. Both
// read and write calls use this exact map, so they share one owned transport.
function sessionEnvironment(request: SchemaRequest, profile: Profile): Record<string, string> {
	const root = profileRoot(request.env, profile);
	return { PATH: CANONICAL_PATH, HOME: request.env.HOME ?? "", LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8", XDG_STATE_HOME: stateRoot(request.env), TMPDIR: path.join(root, "tmp"), MCPORTER_DAEMON_DIR: namespace(request.env, profile) };
}

function ownSession(request: SchemaRequest, profile: Profile): void {
	verifyPayload(profile, request.skillsRoot);
	const root = profileRoot(request.env, profile);
	for (const directory of [root, path.join(root, "tmp"), namespace(request.env, profile)]) if (!ownedDirectory(directory).ok) throw new ConsoleRefusal("session-root-invalid");
	mkdirSync(path.join(root, "home"), { recursive: true, mode: 0o700 });
}

export function caller(request: SchemaRequest, profile: Profile, capabilities: ExecutionCapabilities): ConsoleCaller {
	const run = async (args: string[]): Promise<unknown> => {
		ownSession(request, profile);
		const environment = sessionEnvironment(request, profile);
		const plan = planDispatcherRoute(["figma-console", "--select", `account=${profile.account}`, "--select", `file=${profile.fileKey}`, "--", ...args], request.skillsRoot, environment, CONTEXT);
		const { exit, stdout } = await runMcporter(capabilities, { argv: plan.argv, cwd: profileRoot(request.env, profile), env: { ...plan.env, MCPORTER_DAEMON_DIR: environment.MCPORTER_DAEMON_DIR ?? "" } });
		if (exit !== 0) throw scriptRefusal(stdout) ?? new ConsoleRefusal("transport-failed");
		// MCPorter 0.14.0 prints plain text for daemon start and stop.
		if (args[0] === "daemon" && args[1] !== "status") return { completed: true };
		let reply: unknown;
		try { reply = JSON.parse(stdout) as unknown; } catch { throw new ConsoleRefusal("reply-invalid"); }
		// A decoded refusal keeps its own closed cause, such as a script guard's.
		return unwrap(reply);
	};
	return {
		async call(tool, args) {
			const status = await run(["daemon", "status", "--json"]);
			if (!record(status)) throw new ConsoleRefusal("session-not-started");
			return run(["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", "30000"]);
		},
		daemon(verb) { return run(["daemon", verb, "--json"]); },
	};
}

export async function currentSnapshot(transport: ConsoleCaller, profile: Profile, code: string): Promise<Record<string, unknown>> {
	const value = await transport.call("figma_execute", { fileKey: profile.fileKey, code, timeout: 15000 });
	if (!record(value) || value.fileKey !== profile.fileKey || value.source !== "plugin-api-current" || value.cached !== false || !Array.isArray(value.variables) || !Array.isArray(value.collections)) throw new ConsoleRefusal("fresh-snapshot-required");
	return value;
}
