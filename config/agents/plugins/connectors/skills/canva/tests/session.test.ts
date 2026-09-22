// Proof of the Canva session module at its interface against the fake
// authorization server. The fake computes S256 and rotates refresh tokens
// itself, so the oracle is independent of the module under test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { accessToken, clientEnvironment, login, logout, parseOAuthConfig, type SessionDeps, status } from "../scripts/session/index.ts";
import { type FakeAuthorizationServer, preRegister, startAuthorizationServer } from "./fixtures/authorization-server.ts";

let fake: FakeAuthorizationServer;
let root: string;
let now: number;
const NOW = 1_700_000_000_000;
const opened: string[] = [];
beforeEach(() => {
	fake = startAuthorizationServer();
	root = mkdtempSync(path.join(os.tmpdir(), "canva-session-"));
	now = NOW;
	opened.length = 0;
});
afterEach(() => {
	fake.stop();
	rmSync(root, { recursive: true, force: true });
});

// The attended browser is simulated by following the authorize redirect to
// the loopback callback, exactly what a real browser does after consent.
const browser = async (url: string) => {
	opened.push(url);
	await fetch(url);
};
const sessionFile = (account = "personal") => path.join(root, "connectors", "canva", account, "session.json");
const sessionText = (account = "personal") => readFileSync(sessionFile(account), "utf8");
const deps = (overrides: Partial<SessionDeps> = {}, config: Record<string, unknown> = {}): SessionDeps => {
	const parsed = parseOAuthConfig({ resource: fake.resource, client: { mode: "dcr", clientName: "Connectors plugin" }, loopbackPort: 0, callbackTimeoutMs: 2000, refreshLockWaitMs: 300, ...config });
	if (!parsed) throw new Error("test config invalid");
	return {
		fetch,
		openBrowser: browser,
		clock: { now: () => now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
		random: (bytes) => new Uint8Array(bytes).map((_, index) => (index * 7 + 3) % 256),
		stateRoot: root,
		env: {},
		config: parsed,
		...overrides,
	};
};
// Secrets the fake issues, restated so they can be asserted absent.
const SECRETS = ["fixture-access-token", "fixture-refresh-token", "fixture-code"];
const causeOf = (result: { ok: true } | { ok: false; cause: string }): string => (result.ok ? "ok" : result.cause);

describe("login", () => {
	test("the client environment admits only the registered secret key", () => {
		expect(clientEnvironment({ CANVA_CLIENT_SECRET: "fixture-secret", HOME: "/tmp/home", PATH: "/bin" })).toEqual({ CANVA_CLIENT_SECRET: "fixture-secret" });
		expect(clientEnvironment({ CANVA_CLIENT_SECRET: "" })).toEqual({});
	});

	test("registers a client, runs PKCE S256 with state and resource, exchanges the code, and stores an exact-0600 session", async () => {
		const result = await login("personal", { noBrowser: false }, deps());
		expect(result).toEqual({ ok: true, status: { account: "personal", clientMode: "dcr", clientId: "fixture-client-1", issuer: fake.issuer, resource: fake.resource, scope: "design:meta:read", obtainedAt: NOW, expiresAt: NOW + 3_600_000, refreshable: true } });
		expect([fake.calls.registrations, fake.calls.authorizations, fake.calls.tokenRequests]).toEqual([1, 1, 1]);
		expect(fake.authorizations[0]).toMatchObject({ clientId: "fixture-client-1", resource: fake.resource, codeChallengeMethod: "S256", scope: null });
		expect(fake.registered[0]?.redirectUris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(opened).toHaveLength(1);
		const url = new URL(opened[0] ?? "");
		expect([url.origin + url.pathname, url.searchParams.get("response_type"), url.searchParams.get("code_challenge_method")]).toEqual([`${fake.url}/authorize`, "code", "S256"]);
		expect(url.searchParams.get("state")?.length).toBeGreaterThan(20);
		expect(statSync(sessionFile()).mode & 0o7777).toBe(0o600);
		expect(statSync(path.dirname(sessionFile())).mode & 0o7777).toBe(0o700);
		expect(JSON.parse(sessionText())).toMatchObject({ version: 1, account: "personal", accessToken: "fixture-access-token-1", refreshToken: "fixture-refresh-token-1", tokenEndpoint: `${fake.url}/token`, revocationEndpoint: `${fake.url}/revoke` });
		for (const secret of SECRETS) expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("--no-browser surfaces the URL and never opens a browser", async () => {
		const urls: string[] = [];
		const pending = login("personal", { noBrowser: true, onAuthorizationUrl: (url) => urls.push(url) }, deps());
		// The attended user completes it out of band.
		while (urls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
		await fetch(urls[0] ?? "");
		expect((await pending).ok).toBe(true);
		expect(opened).toEqual([]);
	});

	test("a second login refuses before authorization while a session exists", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		const again = await login("personal", { noBrowser: false }, deps());
		expect(again).toEqual({ ok: false, cause: "session-exists", detail: "a session already exists for this account; run canva-auth logout before login" });
		expect([fake.calls.registrations, fake.calls.authorizations, fake.calls.tokenRequests]).toEqual([1, 1, 1]);
	});

	test("concurrent login rechecks under the mutation lock and never creates a second grant", async () => {
		let releaseFirst: () => void = () => undefined;
		let firstOpened = false;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = login("personal", { noBrowser: false }, deps({
			openBrowser: async (url) => {
				firstOpened = true;
				await gate;
				await browser(url);
			},
		}, { refreshLockWaitMs: 2000 }));
		while (!firstOpened) await new Promise((resolve) => setTimeout(resolve, 5));
		let secondOpened = false;
		const second = login("personal", { noBrowser: false }, deps({
			openBrowser: async () => {
				secondOpened = true;
			},
		}, { refreshLockWaitMs: 2000 }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		releaseFirst();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.ok).toBe(true);
		expect(secondResult).toMatchObject({ ok: false, cause: "session-exists" });
		expect([secondOpened, fake.calls.registrations, fake.calls.authorizations, fake.calls.tokenRequests]).toEqual([false, 1, 1, 1]);
	});

	test("denied consent, a mismatched state, a timeout, and a failed exchange each refuse with a closed cause and no session", async () => {
		fake.options.consent = "deny";
		expect(await login("personal", { noBrowser: false }, deps())).toEqual({ ok: false, cause: "login-denied", detail: "the authorization was denied in the browser" });
		fake.options.consent = "grant";
		fake.options.tamperState = true;
		expect(await login("personal", { noBrowser: false }, deps())).toEqual({ ok: false, cause: "login-mismatch", detail: "the callback did not carry this login's state and was ignored" });
		// The state is checked before the error parameter: a denial that does
		// not carry this login's state is a mismatch, never a denial.
		fake.options.consent = "deny";
		expect(causeOf(await login("personal", { noBrowser: false }, deps()))).toBe("login-mismatch");
		fake.options.consent = "grant";
		fake.options.tamperState = false;
		expect(await login("personal", { noBrowser: false }, deps({ openBrowser: async () => undefined }, { callbackTimeoutMs: 100 }))).toEqual({ ok: false, cause: "login-timeout", detail: "no callback arrived before the login window closed" });
		const failingExchange = deps({ fetch: (input, init) => (String(input).endsWith("/token") ? Promise.resolve(new Response('{"error":"server_error"}', { status: 500 })) : fetch(input, init)) });
		expect(await login("personal", { noBrowser: false }, failingExchange)).toEqual({ ok: false, cause: "exchange-failed", detail: "the authorization server did not issue tokens for the code" });
		expect(existsSync(sessionFile())).toBe(false);
		expect(fake.calls.tokenRequests).toBe(0);
	});

	test("a second callback after the first is rejected and cannot change the stored session", async () => {
		let firstCallback = "";
		const openOnce = async (url: string) => {
			const response = await fetch(url, { redirect: "manual" });
			firstCallback = response.headers.get("location") ?? "";
			await fetch(firstCallback);
		};
		expect((await login("personal", { noBrowser: false }, deps({ openBrowser: openOnce }))).ok).toBe(true);
		const replay = await fetch(firstCallback).catch(() => null);
		expect(replay === null || replay.status !== 200).toBe(true);
		expect(JSON.parse(sessionText()).accessToken).toBe("fixture-access-token-1");
	});

	test("discovery refuses a server without S256, a missing registration endpoint refuses dcr, and a bad account refuses first", async () => {
		fake.options.omitPkce = true;
		expect(causeOf(await login("personal", { noBrowser: false }, deps()))).toBe("discovery-failed");
		fake.options.omitPkce = false;
		fake.options.omitRegistration = true;
		expect(causeOf(await login("personal", { noBrowser: false }, deps()))).toBe("client-unresolved");
		fake.options.omitRegistration = false;
		fake.options.failRegistration = true;
		expect(causeOf(await login("personal", { noBrowser: false }, deps()))).toBe("client-unresolved");
		expect(causeOf(await login("Personal", { noBrowser: false }, deps()))).toBe("account-invalid");
		expect(existsSync(sessionFile())).toBe(false);
	});

	test("a registered client sends its secret only as Basic on the token endpoint, and cimd sends the metadata URL as client_id", async () => {
		preRegister(fake, "portal-client", []);
		const registered = deps({ env: { CANVA_CLIENT_SECRET: "fixture-client-secret" } }, { client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 });
		fake.registered[0]?.redirectUris.push("http://127.0.0.1:47391/callback");
		expect((await login("work", { noBrowser: false }, registered)).ok).toBe(true);
		expect(fake.tokenBodies.at(-1)?.has("client_id")).toBe(false);
		expect(sessionText("work")).not.toContain("fixture-client-secret");
		preRegister(fake, "https://example.invalid/client.json", ["http://127.0.0.1:47392/callback"]);
		const cimd = deps({}, { client: { mode: "cimd", metadataUrl: "https://example.invalid/client.json" }, loopbackPort: 47_392 });
		expect((await login("cimd", { noBrowser: false }, cimd)).ok).toBe(true);
		expect(fake.tokenBodies.at(-1)?.get("client_id")).toBe("https://example.invalid/client.json");
	});

	test("a registered client without its scoped secret refuses before discovery or authorization", async () => {
		const result = await login("work", { noBrowser: false }, deps({}, { client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 }));
		expect(result).toEqual({ ok: false, cause: "client-secret-required", detail: "registered client login requires CANVA_CLIENT_SECRET; set the scoped secret for the matching client in oauth.json, then retry" });
		expect([fake.calls.registrations, fake.calls.authorizations, fake.calls.tokenRequests, opened, existsSync(sessionFile("work"))]).toEqual([0, 0, 0, [], false]);
	});
});

describe("accessToken", () => {
	test("returns the stored token while fresh, then rotates the single-use refresh token once", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		expect(await accessToken("personal", deps())).toMatchObject({ ok: true, token: "fixture-access-token-1" });
		expect(fake.calls.refreshRequests).toBe(0);
		now = NOW + 3_600_000 - 30_000;
		const rotated = await accessToken("personal", deps());
		expect(rotated).toMatchObject({ ok: true, token: "fixture-access-token-2", status: { expiresAt: now + 3_600_000, obtainedAt: now } });
		expect(fake.calls.refreshRequests).toBe(1);
		expect(fake.tokenBodies.at(-1)?.get("refresh_token")).toBe("fixture-refresh-token-1");
		expect(JSON.parse(sessionText()).refreshToken).toBe("fixture-refresh-token-2");
		expect(readdirSync(path.dirname(sessionFile()))).toEqual(["session.json"]);
	});

	test("two concurrent refreshes make exactly one token request", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		now = NOW + 3_600_000;
		const [a, b] = await Promise.all([accessToken("personal", deps()), accessToken("personal", deps())]);
		expect([a.ok, b.ok, a.ok && b.ok && a.token === b.token]).toEqual([true, true, true]);
		expect(fake.calls.refreshRequests).toBe(1);
	});

	test("a rotation that omits the replacement refresh token fails closed and removes the spent session", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		now = NOW + 3_600_000;
		fake.options.omitRefreshOnRotate = true;
		expect(await accessToken("personal", deps())).toEqual({ ok: false, cause: "refresh-incomplete", detail: "the authorization server rotated the access token without a replacement refresh token; the single-use token is spent, so the session was removed; run canva-auth login" });
		expect([fake.calls.refreshRequests, existsSync(sessionFile())]).toEqual([1, false]);
		expect(await accessToken("personal", deps())).toMatchObject({ ok: false, cause: "auth-required" });
	});

	test("every ambiguous refresh result removes the old single-use token and cannot replay it", async () => {
		const cases = [
			{ account: "thrown", response: async () => { throw new Error("connection reset"); } },
			{ account: "server-error", response: async () => new Response('{"error":"server_error"}', { status: 500 }) },
			{ account: "malformed", response: async () => new Response('{"access_token":', { status: 200 }) },
		] as const;
		for (const scenario of cases) {
			expect((await login(scenario.account, { noBrowser: false }, deps())).ok).toBe(true);
			now = NOW + 3_600_000;
			let attempts = 0;
			const ambiguous = deps({
				fetch: async (input, init) => {
					if (String(input).endsWith("/token") && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
						attempts += 1;
						return scenario.response();
					}
					return fetch(input, init);
				},
			});
			expect(await accessToken(scenario.account, ambiguous)).toEqual({ ok: false, cause: "refresh-uncertain", detail: "the refresh request may have consumed the single-use token; the session was removed; inspect Canva connected apps, then run canva-auth login" });
			expect([attempts, existsSync(sessionFile(scenario.account))]).toEqual([1, false]);
			expect(await accessToken(scenario.account, ambiguous)).toMatchObject({ ok: false, cause: "auth-required" });
			expect(attempts).toBe(1);
			now = NOW;
		}
	});

	test("a stored registered session refuses refresh when its scoped secret is missing or its client configuration changed", async () => {
		const secret = "fixture-client-secret";
		preRegister(fake, "portal-client", ["http://127.0.0.1:47391/callback"]);
		const registeredConfig = { client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 };
		const registered = deps({ env: { CANVA_CLIENT_SECRET: secret } }, registeredConfig);
		expect((await login("work", { noBrowser: false }, registered)).ok).toBe(true);
		now = NOW + 3_600_000;
		const expected = { ok: false, cause: "client-secret-unavailable", detail: "the stored registered client cannot authenticate because CANVA_CLIENT_SECRET is missing or does not match oauth.json; restore the scoped secret and matching registered client configuration, then retry" } as const;
		expect(await accessToken("work", deps({ env: {} }, registeredConfig))).toEqual(expected);
		expect(await accessToken("work", deps({ env: { CANVA_CLIENT_SECRET: secret } }, { client: { mode: "registered", clientId: "other-client" }, loopbackPort: 47_391 }))).toEqual(expected);
		expect([fake.calls.refreshRequests, existsSync(sessionFile("work")), sessionText("work").includes(secret)]).toEqual([0, true, false]);
	});

	test("invalid_grant removes the session and reports auth-expired; a held lock reports auth-busy", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		now = NOW + 3_600_000;
		writeFileSync(path.join(path.dirname(sessionFile()), "refresh.lock"), "{}", { mode: 0o600 });
		expect(await accessToken("personal", deps())).toEqual({ ok: false, cause: "auth-busy", detail: "the account session lock may be active or abandoned; stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from the account's private state directory, then run status before retrying" });
		rmSync(path.join(path.dirname(sessionFile()), "refresh.lock"));
		fake.options.invalidGrantNext = true;
		expect(await accessToken("personal", deps())).toEqual({ ok: false, cause: "auth-expired", detail: "the session was revoked or expired at Canva and has been removed; run canva-auth login" });
		expect(existsSync(sessionFile())).toBe(false);
		expect(await accessToken("personal", deps())).toEqual({ ok: false, cause: "auth-required", detail: "no session exists for this account; run canva-auth login" });
	});

	test("a tampered, world-readable, or symlinked session refuses with session-invalid and never sends a token", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		chmodSync(sessionFile(), 0o644);
		expect(causeOf(await accessToken("personal", deps()))).toBe("session-invalid");
		expect(causeOf(status("personal", deps()))).toBe("session-invalid");
		chmodSync(sessionFile(), 0o600);
		writeFileSync(sessionFile(), '{"version":1,"account":"personal"}', { mode: 0o600 });
		expect(causeOf(await accessToken("personal", deps()))).toBe("session-invalid");
		const other = path.join(root, "elsewhere.json");
		writeFileSync(other, sessionText(), { mode: 0o600 });
		rmSync(sessionFile());
		symlinkSync(other, sessionFile());
		expect(causeOf(await accessToken("personal", deps()))).toBe("session-invalid");
		expect(fake.calls.refreshRequests).toBe(0);
	});

	test("a symlinked account directory refuses login and refresh", async () => {
		const elsewhere = path.join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(path.join(root, "connectors", "canva"), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, path.dirname(sessionFile()));
		expect(causeOf(await login("personal", { noBrowser: false }, deps()))).toBe("session-unwritable");
		expect(readdirSync(elsewhere)).toEqual([]);
	});
});

describe("status and logout", () => {
	test("status is the nonsecret view and logout revokes then removes", async () => {
		expect(status("personal", deps())).toEqual({ ok: false, cause: "auth-required", detail: "no session exists for this account; run canva-auth login" });
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		const shown = status("personal", deps());
		expect(shown).toEqual({ ok: true, status: { account: "personal", clientMode: "dcr", clientId: "fixture-client-1", issuer: fake.issuer, resource: fake.resource, scope: "design:meta:read", obtainedAt: NOW, expiresAt: NOW + 3_600_000, refreshable: true } });
		for (const secret of SECRETS) expect(JSON.stringify(shown)).not.toContain(secret);
		expect(await logout("personal", deps())).toEqual({ ok: true, removed: true, revoked: "confirmed" });
		expect(fake.calls.revocations).toEqual(["fixture-refresh-token-1"]);
		// The session state is removed; the owned directory outlives it and holds no lock.
		expect([existsSync(sessionFile()), readdirSync(path.dirname(sessionFile()))]).toEqual([false, []]);
		expect(await logout("personal", deps())).toEqual({ ok: true, removed: false, revoked: "not-needed" });
	});

	test("a registered session rehydrates its scoped secret for refresh and revoke without persisting it", async () => {
		const secret = "fixture-client-secret";
		preRegister(fake, "portal-client", ["http://127.0.0.1:47391/callback"]);
		const registered = deps({ env: { CANVA_CLIENT_SECRET: secret } }, { client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 });
		expect((await login("work", { noBrowser: false }, registered)).ok).toBe(true);
		expect(sessionText("work")).not.toContain(secret);
		now = NOW + 3_600_000;
		const authorizations: string[] = [];
		const withObservedAuth = deps({
			env: { CANVA_CLIENT_SECRET: secret },
			fetch: async (input, init) => {
				if (String(input).endsWith("/token") || String(input).endsWith("/revoke")) authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
				return fetch(input, init);
			},
		}, { client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 });
		expect((await accessToken("work", withObservedAuth)).ok).toBe(true);
		expect(sessionText("work")).not.toContain(secret);
		expect(await logout("work", withObservedAuth)).toEqual({ ok: true, removed: true, revoked: "confirmed" });
		expect(authorizations).toHaveLength(2);
		for (const header of authorizations) expect(header).toStartWith("Basic ");
		expect(JSON.stringify(authorizations)).not.toContain(secret);
		expect(existsSync(sessionFile("work"))).toBe(false);
	});

	test("a stored registered session refuses logout when its scoped secret is missing or its client configuration changed", async () => {
		const secret = "fixture-client-secret";
		preRegister(fake, "portal-client", ["http://127.0.0.1:47391/callback"]);
		const registeredConfig = { client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 };
		const registered = deps({ env: { CANVA_CLIENT_SECRET: secret } }, registeredConfig);
		expect((await login("work", { noBrowser: false }, registered)).ok).toBe(true);
		const expected = { ok: false, cause: "client-secret-unavailable", detail: "the stored registered client cannot authenticate because CANVA_CLIENT_SECRET is missing or does not match oauth.json; restore the scoped secret and matching registered client configuration, then retry", revoked: "not-needed" } as const;
		expect(await logout("work", deps({ env: {} }, registeredConfig))).toEqual(expected);
		expect(await logout("work", deps({ env: { CANVA_CLIENT_SECRET: secret } }, { client: { mode: "registered", clientId: "other-client" }, loopbackPort: 47_391 }))).toEqual(expected);
		expect([fake.calls.revocations, existsSync(sessionFile("work")), sessionText("work").includes(secret)]).toEqual([[], true, false]);
	});

	test("logout releases only the lock it owns; a lock taken over by another process is left in place", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		const lock = path.join(path.dirname(sessionFile()), "refresh.lock");
		let seenOwner = "";
		// During revocation (inside the lock) another process takes the lock over.
		const takeover = deps({
			fetch: async (input, init) => {
				if (String(input).endsWith("/revoke")) {
					seenOwner = JSON.parse(readFileSync(lock, "utf8")).owner;
					writeFileSync(lock, '{"pid":1,"at":0,"owner":"another-process"}', { mode: 0o600 });
				}
				return fetch(input, init);
			},
		});
		expect(await logout("personal", takeover)).toEqual({ ok: true, removed: true, revoked: "confirmed" });
		expect(seenOwner.length).toBeGreaterThan(20);
		expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual({ pid: 1, at: 0, owner: "another-process" });
		expect(await accessToken("personal", deps())).toMatchObject({ ok: false, cause: "auth-required" });
	});

	test("login refuses while a logout still owns the existing session", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		let releaseRevoke: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseRevoke = resolve;
		});
		const slowLogout = deps({
			fetch: async (input, init) => {
				if (String(input).endsWith("/revoke")) await gate;
				return fetch(input, init);
			},
		});
		const logoutPending = logout("personal", slowLogout);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const loginPending = login("personal", { noBrowser: false }, deps({}, { refreshLockWaitMs: 2000 }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		// The login has consent but has not exchanged: the lock is still the logout's.
		expect(fake.calls.tokenRequests).toBe(1);
		releaseRevoke();
		const [loggedOut, loggedIn] = await Promise.all([logoutPending, loginPending]);
		expect([loggedOut, loggedIn, fake.calls.tokenRequests]).toEqual([{ ok: true, removed: true, revoked: "confirmed" }, { ok: false, cause: "session-exists", detail: "a session already exists for this account; run canva-auth logout before login" }, 1]);
		expect(existsSync(sessionFile())).toBe(false);
	});

	test("logout still removes the session when revocation is unreachable", async () => {
		expect((await login("personal", { noBrowser: false }, deps())).ok).toBe(true);
		const offline = deps({ fetch: async () => { throw new Error("offline"); } });
		expect(await logout("personal", offline)).toEqual({ ok: true, removed: true, revoked: "uncertain" });
		expect(existsSync(sessionFile())).toBe(false);
	});
});
