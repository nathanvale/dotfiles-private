// The nonsecret OAuth configuration for the Canva session: the protected
// resource, the client identity mode, the loopback port, and the bounded
// waits. It is parsed from unknown and never holds a secret.
import { readFileSync } from "node:fs";
import path from "node:path";
import { secureUrl } from "./discovery.ts";
import { isRecord } from "./validate.ts";

export const CLIENT_MODES = ["dcr", "registered", "cimd"] as const;
export type ClientMode = (typeof CLIENT_MODES)[number];

export interface ClientConfig {
	mode: ClientMode;
	// dcr: the client_name sent at registration.
	clientName: string | null;
	// registered: the Developer Portal client id.
	clientId: string | null;
	// cimd: the https URL of the hosted client metadata document.
	metadataUrl: string | null;
}

export interface OAuthConfig {
	resource: string;
	client: ClientConfig;
	// 0 asks the OS for a port; only a dcr client can register it per login.
	loopbackPort: number;
	scope: string | null;
	callbackTimeoutMs: number;
	refreshLockWaitMs: number;
}

const CONFIG_PATH = path.resolve(import.meta.dir, "..", "..", "config", "oauth.json");


function optionalString(record: Record<string, unknown>, key: string): string | null | undefined {
	const value = record[key];
	if (value === undefined) return null;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function parseClient(value: unknown): ClientConfig | null {
	if (!isRecord(value) || typeof value.mode !== "string" || !(CLIENT_MODES as readonly string[]).includes(value.mode)) return null;
	const mode = value.mode as ClientMode;
	const clientName = optionalString(value, "clientName");
	const clientId = optionalString(value, "clientId");
	const metadataUrl = optionalString(value, "metadataUrl");
	if (clientName === undefined || clientId === undefined || metadataUrl === undefined) return null;
	if (mode === "dcr" && clientName === null) return null;
	if (mode === "registered" && clientId === null) return null;
	if (mode === "cimd" && (metadataUrl === null || !secureUrl(metadataUrl))) return null;
	return { mode, clientName, clientId, metadataUrl };
}

export function parseOAuthConfig(value: unknown): OAuthConfig | null {
	if (!isRecord(value) || !secureUrl(value.resource)) return null;
	const client = parseClient(value.client);
	if (!client) return null;
	const loopbackPort = value.loopbackPort;
	if (!Number.isSafeInteger(loopbackPort) || (loopbackPort as number) < 0 || (loopbackPort as number) > 65535) return null;
	if (loopbackPort === 0 && client.mode !== "dcr") return null;
	const scope = optionalString(value, "scope");
	const callbackTimeoutMs = positiveInteger(value.callbackTimeoutMs, 300_000);
	const refreshLockWaitMs = positiveInteger(value.refreshLockWaitMs, 10_000);
	if (scope === undefined || callbackTimeoutMs === undefined || refreshLockWaitMs === undefined) return null;
	return { resource: value.resource, client, loopbackPort: loopbackPort as number, scope, callbackTimeoutMs, refreshLockWaitMs };
}

export function loadOAuthConfig(file: string = CONFIG_PATH): OAuthConfig | null {
	try {
		return parseOAuthConfig(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}
