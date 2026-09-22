// The pinned stdio-to-HTTP bridge shared by Providers that reach a remote MCP
// endpoint with a credential composed inside their own process: the version
// probe, the argv shape with `--no-auth` and a literal header template the
// bridge expands from its environment, and the private log directory.
import { ownedDirectory } from "./private-state.ts";
import type { ProviderProcess } from "./provider-process.ts";
import { BRIDGE_VERSION, ownedBridgePath, ownedBridgeReady } from "./bridge-runtime.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BRIDGE = "hyper-mcp-remote";
const REPORTED = new RegExp(`^(?:${BRIDGE}\\s+)?${BRIDGE_VERSION.replaceAll(".", "\\.")}$`);

// Only pinned Connector-owned bytes may receive a Provider's credential.
// First use provisions them through the Connector runtime.
export function bridgeExecutable(proc: ProviderProcess): string {
	const env = proc.cleanEnvironment();
	const owned = ownedBridgePath(env);
	if (!ownedDirectory(path.dirname(owned)).ok) proc.fail("bridge-version-invalid", `${BRIDGE} ${BRIDGE_VERSION} is required`);
	if (!ownedBridgeReady(owned)) {
		const install = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./bridge-runtime.ts", import.meta.url))], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		if (install.exitCode !== 0 || !ownedBridgeReady(owned)) proc.fail("bridge-version-invalid", `${BRIDGE} ${BRIDGE_VERSION} is required`);
	}
	const probe = Bun.spawnSync([owned, "--version"], { env, stdin: "ignore" });
	if (probe.exitCode !== 0 || !REPORTED.test(probe.stdout.toString().trim())) proc.fail("bridge-version-invalid", `${BRIDGE} ${BRIDGE_VERSION} is required`);
	return owned;
}

// `--no-auth` keeps the bridge out of OAuth discovery; the header template is
// literal here and expanded by the bridge from the one variable the Provider
// supplies.
export const bridgeArgv = (url: string, headerTemplate: string): string[] => [BRIDGE, url, "--no-auth", "--header", headerTemplate];

// The owned 0700 directory the bridge may log into.
export function bridgeLogDirectory(proc: ProviderProcess, directory: string): string {
	if (!ownedDirectory(directory).ok) proc.fail("log-path-invalid", "the bridge log directory must be an owned directory");
	return directory;
}
