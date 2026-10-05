import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { planDispatcherRoute, type RoutePlan, RouteError } from "../../../bin/provider-route.ts";
import { ownedDirectory, stateRoot } from "../../../bin/private-state.ts";
import { type EnvironmentSource, safeEnvironment } from "../../../bin/safe-environment.ts";
import { NotionError } from "./contract.ts";

const ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
import { NOTION_ENDPOINT } from "./endpoint.ts";
// Refuse identity overrides and token locations outside the account vault.
const REGISTRY_KEYS = new Set(["description", "baseUrl", "auth", "clientName", "allowedTools"]);

export interface AccountVault {
	readonly account: string;
	readonly root: string;
	readonly dataHome: string;
	readonly cacheHome: string;
}

export function checkAccount(account: string | undefined): string {
	if (account === undefined || ACCOUNT_PATTERN.exec(account)?.[0] !== account) {
		throw new NotionError("account-invalid", `--account needs a lowercase slug matching ${ACCOUNT_PATTERN.source}`);
	}
	return account;
}

export function accountVault(env: EnvironmentSource, account: string): AccountVault {
	const root = path.join(stateRoot(env), "connectors", "notion-mcporter", account);
	return { account, root, dataHome: path.join(root, "data"), cacheHome: path.join(root, "cache") };
}

// Only the fixed hosted endpoint and declared native OAuth client are admitted.
function checkRegistryIdentity(entry: unknown): void {
	const keys = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? Object.keys(entry) : [];
	const declared = entry as Record<string, unknown>;
	if (declared?.baseUrl !== NOTION_ENDPOINT || declared.auth !== "oauth" || keys.some((key) => !REGISTRY_KEYS.has(key))) {
		throw new NotionError("registry-identity-invalid", `the Notion registry must use the fixed endpoint and declared OAuth client`);
	}
}

// MCPorter migrates HOME/.mcporter/<server> into whichever vault it opens and
// clears it on logout. A cache there would silently cross into this account.
function refuseLegacyHomeCache(env: EnvironmentSource, server: string): void {
	const home = env.HOME;
	if (home === undefined) return;
	if (existsSync(path.join(home, ".mcporter", server))) {
		throw new NotionError("legacy-cache-present", `a MCPorter cache for ${server} exists under HOME/.mcporter; move it aside, Connectors never imports it`);
	}
}

export function prepareVault(vault: AccountVault): void {
	for (const directory of [vault.root, vault.dataHome, vault.cacheHome]) {
		const owned = ownedDirectory(directory);
		if (!owned.ok) throw new NotionError("vault-root-invalid", `the account vault root is not a private owned directory (${owned.reason})`);
	}
}

export type Presence = "present" | "absent";

// Metadata only; the credential file is never opened.
export interface VaultInspection {
	readonly vaultFile: Presence;

}

function exists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

export function inspectVault(vault: AccountVault): VaultInspection {
	return {
		vaultFile: exists(path.join(vault.dataHome, "mcporter", "credentials.json")) ? "present" : "absent",

	};
}

// The shared route already validated this file's shape; only the entry is read.
function registryEntry(plan: RoutePlan): unknown {
	const registry = JSON.parse(readFileSync(plan.configPath, "utf8")) as { mcpServers: Record<string, unknown> };
	return registry.mcpServers[plan.server];
}

// The one seam a generic run needs: the shared route's own plan for this
// account, with MCPorter's data and cache roots moved into the account vault.
// Planning changes no state; the caller runs prepareVault only after every
// dependency resolves. The route's message is dropped because it can quote
// caller argv; its sealed code carries the cause.
export function planNotionRoute(env: EnvironmentSource, account: string, mcporterArgs: readonly string[], skillsRoot: string): { plan: RoutePlan; vault: AccountVault } {
	let plan: RoutePlan;
	try {
		plan = planDispatcherRoute(["notion", "--select", `account=${account}`, "--", ...mcporterArgs], skillsRoot, safeEnvironment(env), `notion-account=${account}`);
	} catch (error) {
		if (error instanceof RouteError) throw new NotionError("route-invalid", `the shared route refused the MCPorter arguments (${error.code})`, error.exitCode);
		throw error;
	}
	checkRegistryIdentity(registryEntry(plan));
	refuseLegacyHomeCache(plan.env, plan.server);
	const vault = accountVault(env, account);
	return { plan: { ...plan, env: { ...plan.env, XDG_DATA_HOME: vault.dataHome, XDG_CACHE_HOME: vault.cacheHome } }, vault };
}
