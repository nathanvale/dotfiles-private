// Authorization server discovery: RFC 9728 protected resource metadata names
// the authorization server, then RFC 8414 metadata names its endpoints. Every
// endpoint must be https (loopback http is admitted for tests only), the
// issuer must match, and S256 must be advertised. No response text leaves.
export interface AuthorizationServer {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint: string | null;
	revocationEndpoint: string | null;
}

export type DiscoveryFailure = "resource-metadata-unavailable" | "resource-metadata-invalid" | "authorization-server-unavailable" | "authorization-server-invalid" | "issuer-mismatch" | "insecure-endpoint" | "pkce-unsupported";
export type DiscoveryResult = { ok: true; server: AuthorizationServer } | { ok: false; reason: DiscoveryFailure };

// The injected HTTP seam: the global fetch in production, a routing or
// failing function in tests.
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// https, or http on the loopback host only.
export function secureUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
		return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
	} catch {
		return false;
	}
}

async function fetchJson(fetchFn: Fetch, url: string): Promise<unknown | undefined> {
	try {
		const response = await fetchFn(url, { headers: { accept: "application/json" }, redirect: "manual" });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	}
}

// Path-aware well-known URL per RFC 9728 and RFC 8414, with the root form as
// the fallback for a resource or issuer without a path.
function wellKnown(base: string, suffix: string): string[] {
	const url = new URL(base);
	const path = url.pathname.replace(/\/+$/, "");
	const candidates = [`${url.origin}/.well-known/${suffix}${path}`];
	if (path !== "") candidates.push(`${url.origin}/.well-known/${suffix}`);
	return candidates;
}

async function firstJson(fetchFn: Fetch, urls: string[]): Promise<unknown | undefined> {
	for (const url of urls) {
		const document = await fetchJson(fetchFn, url);
		if (document !== undefined) return document;
	}
	return undefined;
}

function optionalEndpoint(record: Record<string, unknown>, key: string): string | null | undefined {
	const value = record[key];
	if (value === undefined) return null;
	return secureUrl(value) ? value : undefined;
}

function parseServer(document: unknown, issuer: string): DiscoveryResult {
	if (!isRecord(document)) return { ok: false, reason: "authorization-server-invalid" };
	if (document.issuer !== issuer) return { ok: false, reason: "issuer-mismatch" };
	const methods = document.code_challenge_methods_supported;
	if (!Array.isArray(methods) || !methods.includes("S256")) return { ok: false, reason: "pkce-unsupported" };
	const authorizationEndpoint = document.authorization_endpoint;
	const tokenEndpoint = document.token_endpoint;
	if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") return { ok: false, reason: "authorization-server-invalid" };
	const registrationEndpoint = optionalEndpoint(document, "registration_endpoint");
	const revocationEndpoint = optionalEndpoint(document, "revocation_endpoint");
	if (!secureUrl(authorizationEndpoint) || !secureUrl(tokenEndpoint) || registrationEndpoint === undefined || revocationEndpoint === undefined) return { ok: false, reason: "insecure-endpoint" };
	return { ok: true, server: { issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint } };
}

export async function discover(resource: string, fetchFn: Fetch): Promise<DiscoveryResult> {
	const resourceMetadata = await firstJson(fetchFn, wellKnown(resource, "oauth-protected-resource"));
	if (resourceMetadata === undefined) return { ok: false, reason: "resource-metadata-unavailable" };
	if (!isRecord(resourceMetadata) || !Array.isArray(resourceMetadata.authorization_servers)) return { ok: false, reason: "resource-metadata-invalid" };
	const issuer = resourceMetadata.authorization_servers[0];
	if (!secureUrl(issuer)) return { ok: false, reason: "resource-metadata-invalid" };
	const serverMetadata = await firstJson(fetchFn, [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]);
	if (serverMetadata === undefined) return { ok: false, reason: "authorization-server-unavailable" };
	return parseServer(serverMetadata, issuer);
}
