// Client identity adapters. The authorization server must recognise the
// client before a login can start: dynamic registration (the first qualified
// slice), a Developer Portal registered client, or a hosted client metadata
// document (CIMD). The adapter yields one client id plus the way the token
// endpoint is authenticated; a registered client's secret enters only from
// the injected environment, never from config or the session file.
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import type { ClientConfig, ClientMode } from "./config.ts";
import type { AuthorizationServer, Fetch } from "./discovery.ts";
import { isRecord } from "./validate.ts";

export interface ClientIdentity {
	mode: ClientMode;
	clientId: string;
	// The redirect URI this identity was registered for, so a later login on
	// a different loopback port registers again instead of failing at Canva.
	redirectUri: string;
	secret: string | null;
}

export type ClientFailure = "registration-unsupported" | "registration-failed" | "registration-invalid" | "client-secret-required";
export type ClientResult = { ok: true; client: ClientIdentity } | { ok: false; reason: ClientFailure };

export const CLIENT_SECRET_ENV = "CANVA_CLIENT_SECRET";

// The one secret-bearing environment route admitted by the Canva client
// adapter. Callers keep this projection inside the session module and use the
// shared safe environment for every child process.
export function clientEnvironment(source: EnvironmentSource): EnvironmentSource {
	const secret = source[CLIENT_SECRET_ENV];
	return typeof secret === "string" && secret.length > 0 ? { [CLIENT_SECRET_ENV]: secret } : {};
}

// Rehydrate a stored client for token and revocation requests. The session
// carries only nonsecret identity; a registered client's secret must still
// match the active scoped configuration and enters from the environment for
// this request only.
export function clientForSession(stored: Omit<ClientIdentity, "secret">, config: ClientConfig | null, env: EnvironmentSource): ClientIdentity | null {
	if (stored.mode !== "registered") return { ...stored, secret: null };
	if (config?.mode !== "registered" || config.clientId !== stored.clientId) return null;
	const secret = env[CLIENT_SECRET_ENV];
	return typeof secret === "string" && secret.length > 0 ? { ...stored, secret } : null;
}


async function register(config: ClientConfig, server: AuthorizationServer, redirectUri: string, fetchFn: Fetch): Promise<ClientResult> {
	if (server.registrationEndpoint === null) return { ok: false, reason: "registration-unsupported" };
	let response: Response;
	try {
		response = await fetchFn(server.registrationEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			redirect: "manual",
			body: JSON.stringify({
				client_name: config.clientName,
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
	} catch {
		return { ok: false, reason: "registration-failed" };
	}
	if (response.status !== 201 && response.status !== 200) return { ok: false, reason: "registration-failed" };
	let document: unknown;
	try {
		document = await response.json();
	} catch {
		return { ok: false, reason: "registration-invalid" };
	}
	if (!isRecord(document) || typeof document.client_id !== "string" || document.client_id.length === 0) return { ok: false, reason: "registration-invalid" };
	return { ok: true, client: { mode: "dcr", clientId: document.client_id, redirectUri, secret: null } };
}

// Resolve the client for one login. A prior dcr registration is reused only
// for the same issuer and redirect URI.
export async function resolveClient(config: ClientConfig, server: AuthorizationServer, redirectUri: string, previous: { mode: ClientMode; clientId: string; redirectUri: string; issuer: string } | null, fetchFn: Fetch, env: EnvironmentSource): Promise<ClientResult> {
	switch (config.mode) {
		case "dcr":
			if (previous && previous.mode === "dcr" && previous.issuer === server.issuer && previous.redirectUri === redirectUri) {
				return { ok: true, client: { mode: "dcr", clientId: previous.clientId, redirectUri, secret: null } };
			}
			return register(config, server, redirectUri, fetchFn);
		case "registered": {
			const secret = clientEnvironment(env)[CLIENT_SECRET_ENV];
			return typeof secret === "string" && secret.length > 0 ? { ok: true, client: { mode: "registered", clientId: config.clientId ?? "", redirectUri, secret } } : { ok: false, reason: "client-secret-required" };
		}
		case "cimd":
			return { ok: true, client: { mode: "cimd", clientId: config.metadataUrl ?? "", redirectUri, secret: null } };
	}
}

// Client authentication on the token endpoint: public clients send client_id
// in the body; a registered client with a secret uses HTTP Basic.
export function clientAuthentication(client: Pick<ClientIdentity, "clientId" | "secret">, form: URLSearchParams): Record<string, string> {
	if (client.secret === null) {
		form.set("client_id", client.clientId);
		return {};
	}
	return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`).toString("base64")}` };
}
