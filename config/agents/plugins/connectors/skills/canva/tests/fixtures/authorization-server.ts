// In-process fake authorization server and protected resource for the Canva
// session tests. It is the independent oracle for the OAuth contract: it
// computes S256 of the verifier it receives, echoes state, requires resource,
// rotates refresh tokens, rejects a reused refresh token, and returns
// invalid_grant or denies consent on demand. Tokens are literal so tests can
// assert their absence from every nonsecret surface.
export interface FakeAuthorizationServer {
	url: string;
	issuer: string;
	resource: string;
	calls: { registrations: number; authorizations: number; tokenRequests: number; refreshRequests: number; revocations: string[] };
	options: { consent: "grant" | "deny"; tamperState: boolean; invalidGrantNext: boolean; failRegistration: boolean; omitRegistration: boolean; omitPkce: boolean; omitRefreshOnRotate: boolean; mismatchedResourceMetadata: boolean };
	registered: { clientId: string; redirectUris: string[] }[];
	authorizations: { clientId: string; redirectUri: string; resource: string | null; scope: string | null; codeChallengeMethod: string | null }[];
	tokenBodies: URLSearchParams[];
	currentRefreshToken: string | null;
	stop(): void;
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const s256 = (verifier: string) => base64url(new Bun.CryptoHasher("sha256").update(verifier).digest());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

interface IssuedCode {
	challenge: string;
	redirectUri: string;
	resource: string | null;
	clientId: string;
	used: boolean;
}

export function startAuthorizationServer(): FakeAuthorizationServer {
	const codes = new Map<string, IssuedCode>();
	const sequences = new Map<string, number>();
	const next = (prefix: string) => {
		const count = (sequences.get(prefix) ?? 0) + 1;
		sequences.set(prefix, count);
		return `${prefix}-${count}`;
	};
	// The client id from the body, or from HTTP Basic for a confidential client.
	const clientIdOf = (request: Request, form: URLSearchParams): string | null => {
		const authorization = request.headers.get("authorization");
		if (authorization?.startsWith("Basic ")) return decodeURIComponent(Buffer.from(authorization.slice(6), "base64").toString().split(":")[0] ?? "");
		return form.get("client_id");
	};
	const fake: FakeAuthorizationServer = {
		url: "",
		issuer: "",
		resource: "",
		calls: { registrations: 0, authorizations: 0, tokenRequests: 0, refreshRequests: 0, revocations: [] },
		options: { consent: "grant", tamperState: false, invalidGrantNext: false, failRegistration: false, omitRegistration: false, omitPkce: false, omitRefreshOnRotate: false, mismatchedResourceMetadata: false },
		registered: [],
		authorizations: [],
		tokenBodies: [],
		currentRefreshToken: null,
		stop: () => undefined,
	};

	const issueTokens = (withRefresh: boolean) => {
		const refreshToken = withRefresh ? next("fixture-refresh-token") : null;
		if (refreshToken) fake.currentRefreshToken = refreshToken;
		return { access_token: next("fixture-access-token"), token_type: "Bearer", expires_in: 3600, ...(refreshToken ? { refresh_token: refreshToken } : {}), scope: "design:meta:read" };
	};

	const authorize = (url: URL): Response => {
		fake.calls.authorizations += 1;
		const clientId = url.searchParams.get("client_id") ?? "";
		const redirectUri = url.searchParams.get("redirect_uri") ?? "";
		const state = url.searchParams.get("state") ?? "";
		const client = fake.registered.find((entry) => entry.clientId === clientId);
		fake.authorizations.push({ clientId, redirectUri, resource: url.searchParams.get("resource"), scope: url.searchParams.get("scope"), codeChallengeMethod: url.searchParams.get("code_challenge_method") });
		if (!client || !client.redirectUris.includes(redirectUri)) return new Response("unknown client or redirect", { status: 400 });
		const target = new URL(redirectUri);
		target.searchParams.set("state", fake.options.tamperState ? `${state}x` : state);
		if (fake.options.consent === "deny") {
			target.searchParams.set("error", "access_denied");
		} else {
			const code = next("fixture-code");
			codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri, resource: url.searchParams.get("resource"), clientId, used: false });
			target.searchParams.set("code", code);
		}
		return Response.redirect(target.toString(), 302);
	};

	const token = async (request: Request): Promise<Response> => {
		fake.calls.tokenRequests += 1;
		const form = new URLSearchParams(await request.text());
		fake.tokenBodies.push(form);
		if (form.get("resource") !== fake.resource) return json({ error: "invalid_target" }, 400);
		if (form.get("grant_type") === "authorization_code") {
			const issued = codes.get(form.get("code") ?? "");
			if (!issued || issued.used || issued.clientId !== clientIdOf(request, form) || issued.redirectUri !== form.get("redirect_uri") || s256(form.get("code_verifier") ?? "") !== issued.challenge || issued.resource !== form.get("resource")) {
				return json({ error: "invalid_grant" }, 400);
			}
			issued.used = true;
			return json(issueTokens(true));
		}
		if (form.get("grant_type") === "refresh_token") {
			fake.calls.refreshRequests += 1;
			if (fake.options.invalidGrantNext) {
				fake.options.invalidGrantNext = false;
				return json({ error: "invalid_grant" }, 400);
			}
			if (form.get("refresh_token") !== fake.currentRefreshToken) return json({ error: "invalid_grant" }, 400);
			return json(issueTokens(!fake.options.omitRefreshOnRotate));
		}
		return json({ error: "unsupported_grant_type" }, 400);
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			switch (url.pathname) {
				case "/.well-known/oauth-protected-resource/mcp":
					return json({ resource: fake.options.mismatchedResourceMetadata ? `${fake.url}/other` : fake.resource, authorization_servers: [fake.issuer] });
				case "/.well-known/oauth-authorization-server":
					return json({
						issuer: fake.issuer,
						authorization_endpoint: `${fake.url}/authorize`,
						token_endpoint: `${fake.url}/token`,
						revocation_endpoint: `${fake.url}/revoke`,
						...(fake.options.omitRegistration ? {} : { registration_endpoint: `${fake.url}/register` }),
						...(fake.options.omitPkce ? {} : { code_challenge_methods_supported: ["S256"] }),
					});
				case "/register": {
					fake.calls.registrations += 1;
					if (fake.options.failRegistration) return json({ error: "invalid_client_metadata" }, 400);
					const body = (await request.json()) as { redirect_uris?: string[] };
					const clientId = next("fixture-client");
					fake.registered.push({ clientId, redirectUris: body.redirect_uris ?? [] });
					return json({ client_id: clientId }, 201);
				}
				case "/authorize":
					return authorize(url);
				case "/token":
					return token(request);
				case "/revoke": {
					const form = new URLSearchParams(await request.text());
					fake.calls.revocations.push(form.get("token") ?? "");
					return new Response("", { status: 200 });
				}
				default:
					return new Response("not found", { status: 404 });
			}
		},
	});
	fake.url = `http://127.0.0.1:${server.port}`;
	fake.issuer = fake.url;
	fake.resource = `${fake.url}/mcp`;
	fake.stop = () => server.stop(true);
	return fake;
}

// A pre-registered client for tests that need a registered or cimd identity.
export function preRegister(fake: FakeAuthorizationServer, clientId: string, redirectUris: string[]): void {
	fake.registered.push({ clientId, redirectUris });
}
