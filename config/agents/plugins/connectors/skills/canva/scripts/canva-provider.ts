#!/usr/bin/env bun
// Canva Provider, one process per MCPorter call. It takes the Canva Account
// from the route selection, probes the bridge pin, obtains an access token
// that is fresh now from the private session (rotating the refresh token
// under the account lock when needed), creates the account's private log
// directory, and execs the pinned bridge against the Canva MCP endpoint with
// `--no-auth` and a literal Bearer header template. Only the access token
// crosses to the bridge; the refresh token never leaves the session module.
// It never opens a browser: an absent or expired session is a refusal that
// names canva-auth login.
import path from "node:path";
import { bridgeArgv, bridgeExecutable, bridgeLogDirectory } from "../../../bin/hyper-mcp-remote.ts";
import { stateRoot } from "../../../bin/private-state.ts";
import { type ProviderProcess, providerProcess } from "../../../bin/provider-process.ts";
import { ACCOUNT_PATTERN, accessToken, clientEnvironment, loadOAuthConfig, type SessionDeps } from "./session/index.ts";

const proc: ProviderProcess = providerProcess("canva-provider");
const ACCOUNT_ENV = "CANVA_ACCOUNT";
const TOKEN_ENV = "CANVA_ACCESS_TOKEN";
const HEADER_TEMPLATE = "Authorization: Bearer ${CANVA_ACCESS_TOKEN}";

function selectedAccount(): string {
	const account = process.env[ACCOUNT_ENV] ?? "";
	if (!ACCOUNT_PATTERN.test(account)) proc.fail("account-invalid", "expected CANVA_ACCOUNT to be a lowercase account slug", 2);
	return account;
}

async function main(argv: string[]): Promise<never> {
	proc.refuseArguments(argv);
	const account = selectedAccount();
	const config = loadOAuthConfig();
	if (!config) proc.fail("config-invalid", "the Canva oauth.json configuration is missing or invalid");
	// The bridge pin is checked before any session read, so a wrong bridge
	// never causes a refresh.
	const bridge = bridgeExecutable(proc);
	const environment = proc.cleanEnvironment();
	const deps: SessionDeps = {
		fetch,
		openBrowser: async () => proc.fail("attended-login-required", "run canva-auth login; the Provider never opens a browser", 3),
		clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
		random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
		stateRoot: stateRoot(environment),
		env: clientEnvironment(process.env),
		config,
	};
	const token = await accessToken(account, deps);
	if (!token.ok) proc.fail(token.cause, token.detail, 3);
	const logPath = bridgeLogDirectory(proc, path.join(deps.stateRoot, "connectors", "canva", account, "hyper-mcp-remote"));
	proc.replaceProcess(bridge, bridgeArgv(config.resource, HEADER_TEMPLATE), { ...environment, [TOKEN_ENV]: token.token, HYPER_MCP_REMOTE_LOG_PATH: logPath });
}

await main(process.argv.slice(2));
