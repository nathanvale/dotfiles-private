// The 1Password static-token custody mode's one item read, shared by every
// Connector Skill that uses it. The Connectors 1Password service-account
// token is the only Connectors credential in Keychain; it is read from the
// login Keychain into this process and handed only to the plugin-owned op
// child's environment. The item returned stays in the caller process. Nothing
// here prints, logs, or returns a token, and nothing here creates, rotates, or
// imports a credential: a missing token or item is a handoff to its owner.
//
// The caller passes its own skill's Keychain leaf, the one file that spawns
// the macOS security tool, so each skill keeps its own substitutable reader.
// This module names no service.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { EnvironmentSource } from "./safe-environment.ts";
import { installedOp } from "./setup/op.ts";

export const CREDENTIAL_VAULT = "API Credentials";
// Nonsecret Keychain coordinates of the service-account token.
export const SERVICE_TOKEN_SERVICE = "connectors.1password.service-account";
export const SERVICE_TOKEN_ACCOUNT = "connectors";
const SYSTEM_PATH = "/usr/bin:/bin";
// `security` reports an absent item or keychain with this exit status.
const KEYCHAIN_ITEM_NOT_FOUND = 44;
const SERVICE_TOKEN_SHAPE = /^ops_[A-Za-z0-9_\-.=]+$/;
const OP_ITEM_MISSING = /isn't an item|isn't a vault|not found/i;

export type KeychainReader = (argv: readonly string[], env: Record<string, string>) => { status: number | null; stdout: string | null };
export type OnePasswordFailure = "op-unavailable" | "service-token-missing" | "service-token-unavailable" | "item-missing" | "credential-unavailable" | "credential-invalid";
export type OnePasswordRead = { ok: true; item: unknown } | { ok: false; cause: OnePasswordFailure };

// The fixed handoffs. They name where the owner puts a credential and never
// ask for, accept, or echo its value.
export const SERVICE_TOKEN_HANDOFF = `store the Connectors 1Password service-account token in the login Keychain yourself: security add-generic-password -s ${SERVICE_TOKEN_SERVICE} -a ${SERVICE_TOKEN_ACCOUNT} -w (it prompts for the value; Connectors never receives it)`;
export const OP_SETUP_REPAIR = "the plugin-owned 1Password CLI is not set up; run connectors setup";

function serviceToken(env: EnvironmentSource, readKeychain: KeychainReader): { ok: true; token: string } | { ok: false; cause: "service-token-missing" | "service-token-unavailable" } {
	const home = env.HOME ?? "";
	if (!path.isAbsolute(home)) return { ok: false, cause: "service-token-unavailable" };
	const keychain = path.join(home, "Library", "Keychains", "login.keychain-db");
	const read = readKeychain(["find-generic-password", "-s", SERVICE_TOKEN_SERVICE, "-a", SERVICE_TOKEN_ACCOUNT, "-w", keychain], { HOME: home, PATH: SYSTEM_PATH });
	if (read.status === KEYCHAIN_ITEM_NOT_FOUND) return { ok: false, cause: "service-token-missing" };
	if (read.status !== 0 || read.stdout === null) return { ok: false, cause: "service-token-unavailable" };
	const token = read.stdout.endsWith("\n") ? read.stdout.slice(0, -1) : read.stdout;
	return SERVICE_TOKEN_SHAPE.test(token) ? { ok: true, token } : { ok: false, cause: "service-token-unavailable" };
}

// One complete item read, by its configured item ID, through the
// plugin-owned op. The op child receives only HOME, a fixed system PATH, and
// the service-account token.
export function readOnePasswordItem(itemId: string, env: EnvironmentSource, readKeychain: KeychainReader): OnePasswordRead {
	const op = installedOp(env);
	if (op === null) return { ok: false, cause: "op-unavailable" };
	const token = serviceToken(env, readKeychain);
	if (!token.ok) return token;
	const read = spawnSync(op, ["item", "get", itemId, "--vault", CREDENTIAL_VAULT, "--format", "json"], {
		env: { HOME: env.HOME ?? "", PATH: SYSTEM_PATH, OP_SERVICE_ACCOUNT_TOKEN: token.token },
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
	if (read.status !== 0) return { ok: false, cause: OP_ITEM_MISSING.test(read.stderr ?? "") ? "item-missing" : "credential-unavailable" };
	try {
		return { ok: true, item: JSON.parse(read.stdout) };
	} catch {
		return { ok: false, cause: "credential-invalid" };
	}
}
