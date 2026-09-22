// Token endpoint requests: the authorization-code exchange and the refresh
// rotation, both bound to the protected resource (RFC 8707). The response is
// reduced to typed fields; an invalid_grant error is the one distinguished
// failure because it ends the session. No response text leaves.
import { type ClientIdentity, clientAuthentication } from "./client.ts";
import type { Fetch } from "./discovery.ts";
import { isRecord } from "./validate.ts";

export interface TokenSet {
	accessToken: string;
	expiresInSeconds: number | null;
	refreshToken: string | null;
	scope: string | null;
}

export type TokenFailure = "invalid-grant" | "token-request-failed" | "token-response-invalid";
export type TokenResult = { ok: true; tokens: TokenSet } | { ok: false; reason: TokenFailure };


async function errorCode(response: Response): Promise<string | null> {
	try {
		const document: unknown = await response.json();
		return isRecord(document) && typeof document.error === "string" ? document.error : null;
	} catch {
		return null;
	}
}

// An absent optional field is null; a present field that fails its check is
// undefined, which fails the whole response.
function optional<T>(value: unknown, valid: (value: unknown) => value is T): T | null | undefined {
	if (value === undefined) return null;
	return valid(value) ? value : undefined;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positiveSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const isBearer = (value: unknown): boolean => typeof value === "string" && value.toLowerCase() === "bearer";

function parseTokens(document: unknown): TokenSet | null {
	if (!isRecord(document) || !nonEmptyString(document.access_token) || !isBearer(document.token_type)) return null;
	const expiresIn = optional(document.expires_in, positiveSeconds);
	const refreshToken = optional(document.refresh_token, nonEmptyString);
	const scope = optional(document.scope, (value): value is string => typeof value === "string");
	if (expiresIn === undefined || refreshToken === undefined || scope === undefined) return null;
	return { accessToken: document.access_token, expiresInSeconds: expiresIn === null ? null : Math.floor(expiresIn), refreshToken, scope };
}

async function tokenRequest(tokenEndpoint: string, client: ClientIdentity, form: URLSearchParams, fetchFn: Fetch): Promise<TokenResult> {
	const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...clientAuthentication(client, form) };
	let response: Response;
	try {
		response = await fetchFn(tokenEndpoint, { method: "POST", headers, body: form.toString(), redirect: "manual" });
	} catch {
		return { ok: false, reason: "token-request-failed" };
	}
	if (!response.ok) {
		const code = await errorCode(response);
		return { ok: false, reason: code === "invalid_grant" ? "invalid-grant" : "token-request-failed" };
	}
	let document: unknown;
	try {
		document = await response.json();
	} catch {
		return { ok: false, reason: "token-response-invalid" };
	}
	const tokens = parseTokens(document);
	return tokens ? { ok: true, tokens } : { ok: false, reason: "token-response-invalid" };
}

export function exchangeCode(input: { tokenEndpoint: string; client: ClientIdentity; code: string; codeVerifier: string; redirectUri: string; resource: string }, fetchFn: Fetch): Promise<TokenResult> {
	const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri, resource: input.resource });
	return tokenRequest(input.tokenEndpoint, input.client, form, fetchFn);
}

export function refreshTokens(input: { tokenEndpoint: string; client: ClientIdentity; refreshToken: string; resource: string }, fetchFn: Fetch): Promise<TokenResult> {
	const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken, resource: input.resource });
	return tokenRequest(input.tokenEndpoint, input.client, form, fetchFn);
}

// Best effort revocation (RFC 7009). The result says whether the server
// confirmed it; a local logout proceeds either way.
export async function revokeToken(revocationEndpoint: string, client: ClientIdentity, token: string, fetchFn: Fetch): Promise<"confirmed" | "uncertain"> {
	const form = new URLSearchParams({ token, token_type_hint: "refresh_token" });
	const headers = { "content-type": "application/x-www-form-urlencoded", ...clientAuthentication(client, form) };
	try {
		const response = await fetchFn(revocationEndpoint, { method: "POST", headers, body: form.toString(), redirect: "manual" });
		return response.ok ? "confirmed" : "uncertain";
	} catch {
		return "uncertain";
	}
}
