// The one process leaf of the Console transport: select the core's verified
// MCPorter and run one planned invocation. Process fixtures replace only this
// file in a verified private plugin copy; route planning, environment, cwd,
// namespace, session gating and reply decoding stay shipped source.
import type { ExecutionCapabilities } from "../../../bin/adapters/contract.ts";
import { ConsoleRefusal } from "./model.ts";

export interface Invocation {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export async function runMcporter(capabilities: ExecutionCapabilities, invocation: Invocation): Promise<{ exit: number; stdout: string }> {
	const executable = await capabilities.selectMcporter();
	if (executable === null) throw new ConsoleRefusal("mcporter-unavailable");
	const child = Bun.spawn([executable, ...invocation.argv], { cwd: invocation.cwd, env: { ...invocation.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exit, stdout };
}
