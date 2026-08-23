import {
	type AdapterReleaseResult,
	findAdapterDefinition,
} from "@side-quest/browser-connect/adapters";
import type { BrowserUseRuntime } from "./browser-use-runtime";
import { deriveSessionName } from "./browser-use-adapter-session-lease";

/** Release one run-derived Agent Browser session through its registered owner. */
export async function releaseAgentBrowserSession(input: {
	env: BrowserUseRuntime["env"];
	runCommand: BrowserUseRuntime["runCommand"];
	probeExecutable: string;
	runId: string;
}): Promise<AdapterReleaseResult> {
	const releaseSession = findAdapterDefinition("agent-browser")?.releaseSession;
	if (!releaseSession) {
		return {
			released: false,
			cause: "command-failed",
			detail:
				"The agent-browser adapter has no registered session release mechanic.",
		};
	}
	return await releaseSession(
		{
			env: input.env,
			resolveExecutable: () => ({
				resolved: true,
				path: input.probeExecutable,
			}),
			runCommand: input.runCommand,
		},
		{ sessionName: deriveSessionName(input.runId) },
	);
}
