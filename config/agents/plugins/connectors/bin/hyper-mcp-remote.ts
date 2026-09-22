// The pinned stdio-to-HTTP bridge shared by Providers that reach a remote MCP
// endpoint with a credential composed inside their own process: the version
// probe, the argv shape with `--no-auth` and a literal header template the
// bridge expands from its environment, and the private log directory.
import { ownedDirectory } from "./private-state.ts";
import type { ProviderProcess } from "./provider-process.ts";

const BRIDGE_VERSION = "0.5.0";
const BRIDGE = "hyper-mcp-remote";
const REPORTED = new RegExp(`^(?:${BRIDGE}\\s+)?${BRIDGE_VERSION.replaceAll(".", "\\.")}$`);

// The bridge on PATH, only when it reports the pinned version.
export function bridgeExecutable(proc: ProviderProcess): string {
	const bridge = Bun.which(BRIDGE, { PATH: proc.cleanEnvironment().PATH ?? "" });
	if (!bridge) proc.fail("bridge-version-invalid", `${BRIDGE} ${BRIDGE_VERSION} is required`);
	const probe = Bun.spawnSync([bridge, "--version"], { env: proc.cleanEnvironment(), stdin: "ignore" });
	if (probe.exitCode !== 0 || !REPORTED.test(probe.stdout.toString().trim())) proc.fail("bridge-version-invalid", `${BRIDGE} ${BRIDGE_VERSION} is required`);
	return bridge;
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
