#!/usr/bin/env bun
// Official Atlassian Provider, one product per route. Phase one (no
// arguments) validates tenant and product, re-reads the bound complete item,
// probes the bridge pin only after that precondition, then execs the
// credential helper to inject the API token into phase two. Phase two
// (--injected) runs only below the helper: it re-probes the bridge pin,
// re-reads the item as metadata, composes the Basic credential inside this
// process, creates the private log path, and execs the pinned bridge with a
// literal header template that the bridge expands. Bearer is a different
// credential type and is never sent or auto-detected.
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundItem, credentialHelper, credentialReference, invocationEnvironment, type ProviderInvocation, providerInvocation } from "./custody/index.ts";
import { atlassianProcess, type ProviderProcess, singleLine } from "./provider-process.ts";

const { cleanEnvironment, executableOnPath } = atlassianProcess;
const fail: ProviderProcess["fail"] = atlassianProcess.fail;
const replaceProcess: ProviderProcess["replaceProcess"] = atlassianProcess.replaceProcess;
const BRIDGE_VERSION = "0.5.0";
const BRIDGE_URL = "https://mcp.atlassian.com/v2/mcp";
const HEADER_TEMPLATE = "Authorization: Basic ${ATLASSIAN_BASIC}";
const KEY_ENV = "ATLASSIAN_API_KEY";

function privateDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(directory);
	if (!metadata.isDirectory() || metadata.uid !== os.userInfo().uid) {
		fail("log-path-invalid", "the bridge log directory must be an owned directory");
	}
	chmodSync(directory, 0o700);
}

function bridgeExecutable(): string {
	const bridge = executableOnPath("hyper-mcp-remote");
	const probe = Bun.spawnSync([bridge, "--version"], { env: cleanEnvironment(), stdin: "ignore" });
	const reported = probe.stdout.toString().trim();
	if (probe.exitCode !== 0 || !new RegExp(`^(?:hyper-mcp-remote\\s+)?${BRIDGE_VERSION.replaceAll(".", "\\.")}$`).test(reported)) {
		fail("bridge-version-invalid", `hyper-mcp-remote ${BRIDGE_VERSION} is required`);
	}
	return bridge;
}

function injectedPhase(invocation: ProviderInvocation): never {
	// Revalidate before probing or spawning the bridge; the helper phase may
	// have raced a rotation after its parent checked the item.
	const user = boundItem(invocation).principal;
	const bridge = bridgeExecutable();
	const token = process.env[KEY_ENV];
	if (!singleLine(token)) fail("credential-invalid", "the injected credential is unavailable or malformed");
	const stateHome = process.env.XDG_STATE_HOME ?? "";
	const stateRoot = path.isAbsolute(stateHome) ? stateHome : path.join(process.env.HOME ?? "", ".local", "state");
	const privateRoot = path.join(stateRoot, "atlassian-mcporter");
	const logPath = path.join(privateRoot, "hyper-mcp-remote");
	privateDirectory(privateRoot);
	privateDirectory(logPath);
	// Only the composed Basic value crosses to the bridge; the raw token does not.
	const environment = {
		...cleanEnvironment(),
		ATLASSIAN_BASIC: Buffer.from(`${user}:${token}`).toString("base64"),
		HYPER_MCP_REMOTE_LOG_PATH: logPath,
	};
	replaceProcess(bridge, ["hyper-mcp-remote", BRIDGE_URL, "--no-auth", "--header", HEADER_TEMPLATE], environment);
}

// The helper forwards only a fixed set of variables, so phase one re-supplies
// its validated invocation to phase two through /usr/bin/env and also passes
// the tenant and product as arguments. Phase two requires that argument pair
// to equal the selected pair, so the injected item is bound exactly to the
// selection and a mismatch is refused before any helper or bridge access.
const ENV_BINARY = "/usr/bin/env";

function main(argv: string[]): never {
	if (argv[0] === "--injected") {
		if (argv.length !== 3) fail("arguments-invalid", "the injected phase needs the selected tenant and product", 2);
		injectedPhase(providerInvocation(process.env, { tenant: argv[1] ?? "", product: argv[2] ?? "" }));
	}
	if (argv.length !== 0) fail("arguments-invalid", "no provider arguments are accepted", 2);
	const invocation = providerInvocation();
	boundItem(invocation);
	bridgeExecutable();
	const helper = credentialHelper();
	const relaunch = Object.entries(invocationEnvironment(invocation)).map(([key, value]) => `${key}=${value}`);
	const target = [ENV_BINARY, ...relaunch, Bun.main, "--injected", invocation.tenant, invocation.product];
	replaceProcess(helper, [helper, "inject", KEY_ENV, credentialReference(invocation), "--", ...target], cleanEnvironment());
}

main(process.argv.slice(2));
