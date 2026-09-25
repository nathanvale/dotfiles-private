// Canva custody interface (Ticket #93 under Spec #87): MCPorter's own native
// OAuth vault holds the Canva grant, and this module only decides where that
// vault lives for one Canva Account and whether the declared client identity
// may be used. It never reads, writes, imports, or deletes a credential.
//
// MCPorter 0.14.0 keys a grant by server name and URL inside one
// credentials.json under XDG_DATA_HOME (else HOME/.mcporter). One registry
// entry therefore cannot separate accounts; each account gets its own owned
// 0700 data root instead, selected here and nowhere else.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { planDispatcherRoute, type RoutePlan, RouteError } from "../../../../bin/provider-route.ts";
import { ownedDirectory, stateRoot } from "../../../../bin/private-state.ts";
import { type EnvironmentSource, safeEnvironment } from "../../../../bin/safe-environment.ts";
import { CanvaError } from "../contract.ts";

const ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const CANVA_ENDPOINT = "https://mcp.canva.com/mcp";
// The exact keys the Canva server entry may carry. MCPorter accepts camelCase
// and snake_case spellings of client, secret, metadata, token-cache, bearer,
// header, env, and command options; any of them could switch identity behind
// the dcr switch or move the grant out of the account root, so every key not
// listed here refuses.
const REGISTRY_KEYS = new Set(["description", "baseUrl", "auth", "clientName", "allowedTools"]);

export interface AccountVault {
	readonly account: string;
	readonly root: string;
	readonly dataHome: string;
	readonly cacheHome: string;
}

// dcr is the only admitted first-release mode. approved names the future
// Developer Portal or metadata-document client; it is reserved, never built.
export type ClientMode = "dcr" | "approved";

export function checkAccount(account: string | undefined): string {
	if (account === undefined || ACCOUNT_PATTERN.exec(account)?.[0] !== account) {
		throw new CanvaError("account-invalid", `--account needs a lowercase slug matching ${ACCOUNT_PATTERN.source}`);
	}
	return account;
}

export function accountVault(env: EnvironmentSource, account: string): AccountVault {
	const root = path.join(stateRoot(env), "connectors", "canva-mcporter", account);
	return { account, root, dataHome: path.join(root, "data"), cacheHome: path.join(root, "cache") };
}

// A compiled binary resolves import.meta.dir inside its virtual filesystem,
// so the packaged adapter names the physical <skillsRoot>/canva/config and
// <skillsRoot>; nothing defaults to this source tree.
export function readClientMode(configDir: string): ClientMode {
	let mode: unknown;
	try {
		mode = (JSON.parse(readFileSync(path.join(configDir, "client.json"), "utf8")) as { mode?: unknown }).mode;
	} catch {
		throw new CanvaError("client-mode-invalid", "config/client.json must be a JSON object with a mode");
	}
	if (mode !== "dcr" && mode !== "approved") throw new CanvaError("client-mode-invalid", "config/client.json mode must be dcr or approved");
	return mode;
}

export function requireAdmittedMode(mode: ClientMode): void {
	if (mode !== "dcr") {
		throw new CanvaError("client-mode-not-admitted", "client mode approved is not yet built or admitted; select dcr in config/client.json");
	}
}

// The registry must describe exactly the dynamic-registration client on the
// fixed Canva endpoint, so no MCPorter option can change identity behind the
// switch.
function checkRegistryIdentity(entry: unknown): void {
	const keys = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? Object.keys(entry) : [];
	const declared = entry as Record<string, unknown>;
	if (declared?.baseUrl !== CANVA_ENDPOINT || declared.auth !== "oauth" || keys.some((key) => !REGISTRY_KEYS.has(key))) {
		throw new CanvaError("registry-identity-invalid", `the Canva server must declare OAuth on ${CANVA_ENDPOINT} using only description, baseUrl, auth, clientName, and allowedTools`);
	}
}

// MCPorter migrates HOME/.mcporter/<server> into whichever vault it opens and
// clears it on logout. A cache there would silently cross into this account.
function refuseLegacyHomeCache(env: EnvironmentSource, server: string): void {
	const home = env.HOME;
	if (home === undefined) return;
	if (existsSync(path.join(home, ".mcporter", server))) {
		throw new CanvaError("legacy-cache-present", `a MCPorter cache for ${server} exists under HOME/.mcporter; move it aside, Connectors never imports it`);
	}
}

export function prepareVault(vault: AccountVault): void {
	for (const directory of [vault.root, vault.dataHome, vault.cacheHome]) {
		const owned = ownedDirectory(directory);
		if (!owned.ok) throw new CanvaError("vault-root-invalid", `the account vault root is not a private owned directory (${owned.reason})`);
	}
}

export type Presence = "present" | "absent";

// Existence only: neither file is opened.
export interface VaultInspection {
	readonly vaultFile: Presence;
	readonly legacySession: "preserved" | "absent";
}

function exists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

export function inspectVault(env: EnvironmentSource, vault: AccountVault): VaultInspection {
	const legacy = path.join(stateRoot(env), "connectors", "canva", vault.account, "session.json");
	return {
		vaultFile: exists(path.join(vault.dataHome, "mcporter", "credentials.json")) ? "present" : "absent",
		legacySession: exists(legacy) ? "preserved" : "absent",
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
export function planCanvaRoute(env: EnvironmentSource, account: string, mcporterArgs: readonly string[], skillsRoot: string): { plan: RoutePlan; vault: AccountVault } {
	let plan: RoutePlan;
	try {
		plan = planDispatcherRoute(["canva", "--select", `account=${account}`, "--", ...mcporterArgs], skillsRoot, safeEnvironment(env), `canva-account=${account}`);
	} catch (error) {
		if (error instanceof RouteError) throw new CanvaError("route-invalid", `the shared route refused the MCPorter arguments (${error.code})`, error.exitCode);
		throw error;
	}
	checkRegistryIdentity(registryEntry(plan));
	refuseLegacyHomeCache(plan.env, plan.server);
	const vault = accountVault(env, account);
	return { plan: { ...plan, env: { ...plan.env, XDG_DATA_HOME: vault.dataHome, XDG_CACHE_HOME: vault.cacheHome } }, vault };
}
