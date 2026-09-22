// Canva OAuth session custody. This is the only import path into the module.
//
// One Canva Account has one Canva Session in private state. `login` runs the
// attended authorization-code flow with PKCE against the discovered
// authorization server and stores the session; `accessToken` returns a token
// that is fresh now, rotating the single-use refresh token under a per-account
// lock when needed; `status` is the nonsecret view; `logout` revokes when it
// can and removes the local session. Every dependency with an effect is
// injected. Tokens never appear in a result other than `accessToken`'s.
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { type CallbackResult, listenForCallback } from "./callback.ts";
import { CLIENT_SECRET_ENV, clientEnvironment, clientForSession, type ClientIdentity, resolveClient } from "./client.ts";
import type { OAuthConfig } from "./config.ts";
import { discover, type Fetch } from "./discovery.ts";
import { codeChallenge, codeVerifier, type Random, stateValue } from "./pkce.ts";
import { ACCOUNT_PATTERN, type LockClock, prepareAccountDirectory, readSession, removeSession, type SessionRecord, withRefreshLock, writeSession } from "./store.ts";
import { exchangeCode, refreshTokens, revokeToken, type TokenSet } from "./token.ts";

export { loadOAuthConfig, type OAuthConfig, parseOAuthConfig } from "./config.ts";
export { clientEnvironment } from "./client.ts";
export { ACCOUNT_PATTERN } from "./store.ts";

export interface SessionDeps {
	fetch: Fetch;
	openBrowser(url: string): Promise<void>;
	clock: LockClock;
	random: Random;
	stateRoot: string;
	env: EnvironmentSource;
	config: OAuthConfig;
}

// The nonsecret view of a session. No key names a token, so a redaction
// audit of this view finds nothing to redact.
export interface SessionStatus {
	account: string;
	clientMode: SessionRecord["client"]["mode"];
	clientId: string;
	issuer: string;
	resource: string;
	scope: string | null;
	obtainedAt: number;
	expiresAt: number | null;
	refreshable: boolean;
}

export type LoginCause = "account-invalid" | "discovery-failed" | "client-unresolved" | "client-secret-required" | "login-denied" | "login-mismatch" | "login-timeout" | "login-invalid" | "exchange-failed" | "session-busy" | "session-exists" | "session-unwritable";
export type TokenCause = "account-invalid" | "auth-required" | "session-invalid" | "auth-expired" | "auth-busy" | "client-secret-unavailable" | "refresh-uncertain" | "refresh-incomplete" | "session-unwritable";
export type LogoutRevocation = "confirmed" | "uncertain" | "unsupported" | "not-needed";
export type LogoutCause = "account-invalid" | "auth-busy" | "client-secret-unavailable" | "session-unremovable";

export type LoginResult = { ok: true; status: SessionStatus } | { ok: false; cause: LoginCause; detail: string };
export type AccessTokenResult = { ok: true; token: string; status: SessionStatus } | { ok: false; cause: TokenCause; detail: string };
export type StatusResult = { ok: true; status: SessionStatus } | { ok: false; cause: "account-invalid" | "auth-required" | "session-invalid"; detail: string };
export type LogoutResult = { ok: true; removed: boolean; revoked: LogoutRevocation } | { ok: false; cause: LogoutCause; detail: string; revoked: LogoutRevocation };

export interface LoginOptions {
	noBrowser: boolean;
	// Receives the authorization URL before the wait starts; the CLI prints
	// it for an attended browser that this process never automates.
	onAuthorizationUrl?(url: string): void;
}

// Refresh when less than this remains, so a token handed to a Provider is
// not about to expire mid-call.
const REFRESH_SKEW_MS = 60_000;

const DETAILS: Record<LoginCause | TokenCause | LogoutCause, string> = {
	"account-invalid": "the account must be a lowercase slug",
	"discovery-failed": "the Canva authorization server could not be discovered or does not meet the PKCE and https requirements",
	"client-unresolved": "the client identity could not be established with the authorization server",
	"client-secret-required": "registered client login requires CANVA_CLIENT_SECRET; set the scoped secret for the matching client in oauth.json, then retry",
	"client-secret-unavailable": "the stored registered client cannot authenticate because CANVA_CLIENT_SECRET is missing or does not match oauth.json; restore the scoped secret and matching registered client configuration, then retry",
	"login-denied": "the authorization was denied in the browser",
	"login-mismatch": "the callback did not carry this login's state and was ignored",
	"login-timeout": "no callback arrived before the login window closed",
	"session-busy": "the account session lock may be active or abandoned; stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from the account's private state directory, then run status before retrying",
	"session-exists": "a session already exists for this account; run canva-auth logout before login",
	"login-invalid": "the callback carried no usable authorization code",
	"exchange-failed": "the authorization server did not issue tokens for the code",
	"session-unwritable": "the private session directory is not an owned 0700 directory",
	"auth-required": "no session exists for this account; run canva-auth login",
	"session-invalid": "the session file is not an owned exact-0600 record; run canva-auth logout, then login",
	"auth-expired": "the session was revoked or expired at Canva and has been removed; run canva-auth login",
	"auth-busy": "the account session lock may be active or abandoned; stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from the account's private state directory, then run status before retrying",
	"refresh-uncertain": "the refresh request may have consumed the single-use token; the session was removed; inspect Canva connected apps, then run canva-auth login",
	"refresh-incomplete": "the authorization server rotated the access token without a replacement refresh token; the single-use token is spent, so the session was removed; run canva-auth login",
	"session-unremovable": "the private session directory could not be removed; inspect its permissions, then run canva-auth logout again",
};

export const statusOf = (session: SessionRecord): SessionStatus => ({
	account: session.account,
	clientMode: session.client.mode,
	clientId: session.client.clientId,
	issuer: session.issuer,
	resource: session.resource,
	scope: session.scope,
	obtainedAt: session.obtainedAt,
	expiresAt: session.accessTokenExpiresAt,
	refreshable: session.refreshToken !== null,
});

const validAccount = (account: string): boolean => ACCOUNT_PATTERN.test(account);

function recordFrom(previous: Pick<SessionRecord, "account" | "issuer" | "resource" | "tokenEndpoint" | "revocationEndpoint" | "client">, tokens: TokenSet, now: number): SessionRecord {
	return {
		version: 1,
		account: previous.account,
		client: previous.client,
		issuer: previous.issuer,
		resource: previous.resource,
		tokenEndpoint: previous.tokenEndpoint,
		revocationEndpoint: previous.revocationEndpoint,
		scope: tokens.scope,
		accessToken: tokens.accessToken,
		accessTokenExpiresAt: tokens.expiresInSeconds === null ? null : now + tokens.expiresInSeconds * 1000,
		refreshToken: tokens.refreshToken,
		obtainedAt: now,
	};
}

function authorizationUrl(endpoint: string, client: ClientIdentity, challenge: string, state: string, config: OAuthConfig): string {
	const url = new URL(endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.clientId);
	url.searchParams.set("redirect_uri", client.redirectUri);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("resource", config.resource);
	if (config.scope !== null) url.searchParams.set("scope", config.scope);
	return url.toString();
}

const loginFailure = (cause: LoginCause): LoginResult => ({ ok: false, cause, detail: DETAILS[cause] });
const tokenFailure = (cause: TokenCause): AccessTokenResult => ({ ok: false, cause, detail: DETAILS[cause] });

async function attendedLogin(account: string, options: LoginOptions, deps: SessionDeps): Promise<LoginResult> {
	const discovered = await discover(deps.config.resource, deps.fetch);
	if (!discovered.ok) return loginFailure("discovery-failed");
	const server = discovered.server;
	// One state value binds the listener's check and the authorization URL.
	const state = stateValue(deps.random);
	const listener = listenForCallback({ port: deps.config.loopbackPort, state, timeoutMs: deps.config.callbackTimeoutMs });
	try {
		const resolved = await resolveClient(deps.config.client, server, listener.redirectUri, null, deps.fetch, deps.env);
		if (!resolved.ok) return loginFailure(resolved.reason === "client-secret-required" ? "client-secret-required" : "client-unresolved");
		const verifier = codeVerifier(deps.random);
		const url = authorizationUrl(server.authorizationEndpoint, resolved.client, codeChallenge(verifier), state, deps.config);
		options.onAuthorizationUrl?.(url);
		if (!options.noBrowser) await deps.openBrowser(url);
		const callback = await listener.result;
		if (!callback.ok) return loginFailure(CALLBACK_CAUSES[callback.reason]);
		const exchanged = await exchangeCode({ tokenEndpoint: server.tokenEndpoint, client: resolved.client, code: callback.code, codeVerifier: verifier, redirectUri: listener.redirectUri, resource: deps.config.resource }, deps.fetch);
		if (!exchanged.ok) return loginFailure("exchange-failed");
		const record = recordFrom(
			{ account, issuer: server.issuer, resource: deps.config.resource, tokenEndpoint: server.tokenEndpoint, revocationEndpoint: server.revocationEndpoint, client: { mode: resolved.client.mode, clientId: resolved.client.clientId, redirectUri: resolved.client.redirectUri } },
			exchanged.tokens,
			deps.clock.now(),
		);
		if (!writeSession(deps.stateRoot, record).ok) return loginFailure("session-unwritable");
		return { ok: true, status: statusOf(record) };
	} finally {
		listener.close();
	}
}

export async function login(account: string, options: LoginOptions, deps: SessionDeps): Promise<LoginResult> {
	if (!validAccount(account)) return loginFailure("account-invalid");
	// Prove private storage and refuse an existing session before discovery or
	// authorization. The same refusal is repeated under the mutation lock so
	// two concurrent logins can create at most one grant.
	if (!prepareAccountDirectory(deps.stateRoot, account)) return loginFailure("session-unwritable");
	if (readSession(deps.stateRoot, account).ok) return loginFailure("session-exists");
	if (deps.config.client.mode === "registered" && clientEnvironment(deps.env)[CLIENT_SECRET_ENV] === undefined) return loginFailure("client-secret-required");
	const locked = await withRefreshLock(deps.stateRoot, account, deps.clock, deps.config.refreshLockWaitMs, async (): Promise<LoginResult> => {
		if (readSession(deps.stateRoot, account).ok) return loginFailure("session-exists");
		return attendedLogin(account, options, deps);
	});
	if (!locked.ok) return loginFailure(locked.reason === "auth-busy" ? "session-busy" : "session-unwritable");
	return locked.value;
}

const CALLBACK_CAUSES: Record<Exclude<CallbackResult, { ok: true }>["reason"], LoginCause> = {
	"state-mismatch": "login-mismatch",
	"authorization-denied": "login-denied",
	"callback-timeout": "login-timeout",
	"callback-invalid": "login-invalid",
};

const fresh = (session: SessionRecord, now: number): boolean => session.accessTokenExpiresAt === null || session.accessTokenExpiresAt - now > REFRESH_SKEW_MS;

async function rotate(account: string, session: SessionRecord, deps: SessionDeps): Promise<AccessTokenResult> {
	if (session.refreshToken === null) {
		removeSession(deps.stateRoot, account);
		return tokenFailure("auth-expired");
	}
	const client = clientForSession(session.client, deps.config.client, deps.env);
	if (client === null) return tokenFailure("client-secret-unavailable");
	const refreshToken = session.refreshToken;
	// Persist consumption before the request. If the process crashes, the old
	// single-use token is no longer replayable; a later call removes this
	// terminal session instead of attempting another refresh.
	if (!writeSession(deps.stateRoot, { ...session, refreshToken: null }).ok) return tokenFailure("session-unwritable");
	const refreshed = await refreshTokens({ tokenEndpoint: session.tokenEndpoint, client, refreshToken, resource: session.resource }, deps.fetch);
	if (!refreshed.ok) {
		removeSession(deps.stateRoot, account);
		return tokenFailure(refreshed.reason === "invalid-grant" ? "auth-expired" : "refresh-uncertain");
	}
	// Canva refresh tokens are single use: the one just sent is spent, so a
	// reply without a replacement leaves no way to continue. Fail closed.
	if (refreshed.tokens.refreshToken === null) {
		removeSession(deps.stateRoot, account);
		return tokenFailure("refresh-incomplete");
	}
	const tokens: TokenSet = refreshed.tokens;
	const record = recordFrom(session, tokens, deps.clock.now());
	if (!writeSession(deps.stateRoot, record).ok) {
		removeSession(deps.stateRoot, account);
		return tokenFailure("refresh-incomplete");
	}
	return { ok: true, token: record.accessToken, status: statusOf(record) };
}

// A token that is fresh now. Refresh runs under the per-account lock and
// re-reads the session first, so two Providers racing an expiry make exactly
// one token request.
export async function accessToken(account: string, deps: SessionDeps): Promise<AccessTokenResult> {
	if (!validAccount(account)) return tokenFailure("account-invalid");
	const read = readSession(deps.stateRoot, account);
	if (!read.ok) return tokenFailure(read.reason === "absent" ? "auth-required" : "session-invalid");
	if (fresh(read.session, deps.clock.now())) return { ok: true, token: read.session.accessToken, status: statusOf(read.session) };
	const locked = await withRefreshLock(deps.stateRoot, account, deps.clock, deps.config.refreshLockWaitMs, async () => {
		const again = readSession(deps.stateRoot, account);
		if (!again.ok) return tokenFailure(again.reason === "absent" ? "auth-required" : "session-invalid");
		if (fresh(again.session, deps.clock.now())) return { ok: true as const, token: again.session.accessToken, status: statusOf(again.session) };
		return rotate(account, again.session, deps);
	});
	if (!locked.ok) return tokenFailure(locked.reason === "auth-busy" ? "auth-busy" : "session-unwritable");
	return locked.value;
}

export function status(account: string, deps: Pick<SessionDeps, "stateRoot">): StatusResult {
	if (!validAccount(account)) return { ok: false, cause: "account-invalid", detail: DETAILS["account-invalid"] };
	const read = readSession(deps.stateRoot, account);
	if (!read.ok) {
		const cause = read.reason === "absent" ? "auth-required" : "session-invalid";
		return { ok: false, cause, detail: DETAILS[cause] };
	}
	return { ok: true, status: statusOf(read.session) };
}

type RevokeSessionResult = { ok: true; revoked: LogoutRevocation } | { ok: false; cause: "client-secret-unavailable" };

async function revokeSession(account: string, deps: Pick<SessionDeps, "stateRoot" | "fetch"> & Partial<Pick<SessionDeps, "config" | "env">>): Promise<RevokeSessionResult> {
	const read = readSession(deps.stateRoot, account);
	if (!read.ok || read.session.refreshToken === null) return { ok: true, revoked: "not-needed" };
	if (read.session.revocationEndpoint === null) return { ok: true, revoked: "unsupported" };
	const client = clientForSession(read.session.client, deps.config?.client ?? null, deps.env ?? {});
	if (client === null) return { ok: false, cause: "client-secret-unavailable" };
	return { ok: true, revoked: await revokeToken(read.session.revocationEndpoint, client, read.session.refreshToken, deps.fetch) };
}

// Revoke the refresh token when the server offers revocation, then remove the
// local session whatever the server said. The local removal is the effect
// this command owns; revocation is reported as confirmed or uncertain. It
// runs under the refresh lock so a Provider mid-rotation is never pulled out
// from under, and a held lock refuses immediately rather than waiting.
export async function logout(account: string, deps: Pick<SessionDeps, "stateRoot" | "fetch" | "clock"> & Partial<Pick<SessionDeps, "config" | "env">>): Promise<LogoutResult> {
	if (!validAccount(account)) return { ok: false, cause: "account-invalid", detail: DETAILS["account-invalid"], revoked: "not-needed" };
	const existing = readSession(deps.stateRoot, account);
	if (!existing.ok && existing.reason === "absent") return { ok: true, removed: false, revoked: "not-needed" };
	const locked = await withRefreshLock(deps.stateRoot, account, deps.clock, 0, async (): Promise<LogoutResult> => {
		const revocation = await revokeSession(account, deps);
		if (!revocation.ok) return { ok: false, cause: revocation.cause, detail: DETAILS[revocation.cause], revoked: "not-needed" };
		const revoked = revocation.revoked;
		try {
			return { ok: true, removed: removeSession(deps.stateRoot, account), revoked };
		} catch {
			return { ok: false, cause: "session-unremovable", detail: DETAILS["session-unremovable"], revoked };
		}
	});
	if (!locked.ok) return { ok: false, cause: locked.reason === "auth-busy" ? "auth-busy" : "session-unremovable", detail: DETAILS[locked.reason === "auth-busy" ? "auth-busy" : "session-unremovable"], revoked: "not-needed" };
	return locked.value;
}
