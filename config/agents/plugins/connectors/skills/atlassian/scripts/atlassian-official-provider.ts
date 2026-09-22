#!/usr/bin/env bun
// Official Atlassian Provider, one product per route. Phase one (no
// arguments) validates tenant and product, probes the bridge pin before any
// credential access, confirms the item's username as metadata, then execs the
// credential helper to inject the API token into phase two. Phase two
// (--injected) runs only below the helper: it re-probes the bridge pin,
// re-reads the username as metadata, composes the Basic credential inside
// this process, creates the private log path, and execs the pinned bridge
// with a literal header template that the bridge expands. Bearer is a
// different credential type and is never sent or auto-detected.
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	cleanEnvironment,
	CREDENTIAL_VAULT,
	credentialWrapper,
	executableOnPath,
	fail,
	productFromEnvironment,
	productItemTitle,
	readItemFields,
	replaceProcess,
	singleLine,
	tenantFromEnvironment,
} from "./atlassian-provider-common.ts";

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

// The username is item metadata, read through the helper without the secret.
// A colon would corrupt the Basic pair, so it is refused.
function username(itemTitle: string): string {
	const value = readItemFields(itemTitle, ["username"]).get("username");
	if (value === undefined) fail("username-missing", `${itemTitle} needs a username field for Basic API-token authentication`);
	if (!singleLine(value) || value.includes(":")) fail("credential-invalid", `${itemTitle} has a malformed username`);
	return value;
}

function injectedPhase(itemTitle: string): never {
	const bridge = bridgeExecutable();
	const token = process.env[KEY_ENV];
	if (!singleLine(token)) fail("credential-invalid", "the injected credential is unavailable or malformed");
	const user = username(itemTitle);
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
// its validated tenant and product to phase two through /usr/bin/env and also
// passes them as arguments. Phase two validates the environment with the same
// owner functions and requires the argument pair to equal it, so the injected
// item is bound exactly to the selected pair and a mismatch is refused before
// any helper or bridge access.
const ENV_BINARY = "/usr/bin/env";

function boundItemTitle(argv: string[]): string {
	if (argv.length !== 3) fail("arguments-invalid", "the injected phase needs the selected tenant and product", 2);
	const tenant = tenantFromEnvironment();
	const product = productFromEnvironment();
	if (argv[1] !== tenant || argv[2] !== product) fail("injection-mismatch", "the injected pair does not match the selected tenant and product", 2);
	return productItemTitle(product, tenant);
}

function main(argv: string[]): never {
	if (argv[0] === "--injected") injectedPhase(boundItemTitle(argv));
	if (argv.length !== 0) fail("arguments-invalid", "no provider arguments are accepted", 2);
	const tenant = tenantFromEnvironment();
	const product = productFromEnvironment();
	const itemTitle = productItemTitle(product, tenant);
	bridgeExecutable();
	const wrapper = credentialWrapper();
	username(itemTitle);
	const reference = `op://${CREDENTIAL_VAULT}/${itemTitle}/credential`;
	const target = [ENV_BINARY, `ATLASSIAN_TENANT=${tenant}`, `ATLASSIAN_PRODUCT=${product}`, Bun.main, "--injected", tenant, product];
	replaceProcess(wrapper, [wrapper, "inject", KEY_ENV, reference, "--", ...target], cleanEnvironment());
}

main(process.argv.slice(2));
