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
import path from "node:path";
import { bridgeArgv, bridgeExecutable, bridgeLogDirectory } from "../../../bin/hyper-mcp-remote.ts";
import { stateRoot } from "../../../bin/private-state.ts";
import { boundItem, credentialHelper, credentialReference, invocationEnvironment, type ProviderInvocation, providerInvocation } from "./custody/index.ts";
import { atlassianProcess, type ProviderProcess, singleLine } from "./provider-process.ts";

const { cleanEnvironment } = atlassianProcess;
const fail: ProviderProcess["fail"] = atlassianProcess.fail;
const replaceProcess: ProviderProcess["replaceProcess"] = atlassianProcess.replaceProcess;
const BRIDGE_URL = "https://mcp.atlassian.com/v2/mcp";
const HEADER_TEMPLATE = "Authorization: Basic ${ATLASSIAN_BASIC}";
const KEY_ENV = "ATLASSIAN_API_KEY";

function injectedPhase(invocation: ProviderInvocation): never {
	// Revalidate before probing or spawning the bridge; the helper phase may
	// have raced a rotation after its parent checked the item.
	const user = boundItem(invocation).principal;
	const bridge = bridgeExecutable(atlassianProcess);
	const token = process.env[KEY_ENV];
	if (!singleLine(token)) fail("credential-invalid", "the injected credential is unavailable or malformed");
	const privateRoot = bridgeLogDirectory(atlassianProcess, path.join(stateRoot(process.env), "atlassian-mcporter"));
	const logPath = bridgeLogDirectory(atlassianProcess, path.join(privateRoot, "hyper-mcp-remote"));
	// Only the composed Basic value crosses to the bridge; the raw token does not.
	const environment = {
		...cleanEnvironment(),
		ATLASSIAN_BASIC: Buffer.from(`${user}:${token}`).toString("base64"),
		HYPER_MCP_REMOTE_LOG_PATH: logPath,
	};
	replaceProcess(bridge, bridgeArgv(BRIDGE_URL, HEADER_TEMPLATE), environment);
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
	bridgeExecutable(atlassianProcess);
	const helper = credentialHelper();
	const relaunch = Object.entries(invocationEnvironment(invocation)).map(([key, value]) => `${key}=${value}`);
	const target = [ENV_BINARY, ...relaunch, Bun.main, "--injected", invocation.tenant, invocation.product];
	replaceProcess(helper, [helper, "inject", KEY_ENV, credentialReference(invocation), "--", ...target], cleanEnvironment());
}

main(process.argv.slice(2));
