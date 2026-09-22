// Socket-free binding proof with an independent outbound request observer.
// Public route and Provider process custody is covered by canva.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessToken, logout, parseOAuthConfig, type SessionDeps, status } from "../scripts/session/index.ts";
import { FIXTURE_ACCESS_TOKEN, FIXTURE_REFRESH_TOKEN, writeSessionFixture } from "./fixtures/session.ts";

let root: string;
let now: number;
const requests: { url: string; form: URLSearchParams }[] = [];
const config = parseOAuthConfig({ resource: "https://mcp.canva.com/mcp", client: { mode: "dcr", clientName: "Connectors plugin" }, loopbackPort: 0 });
if (config === null) throw new Error("Canva fixture configuration is invalid");

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "canva-binding-"));
	now = 1_700_000_000_000;
	requests.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (): SessionDeps => ({
	fetch: async (input, init) => {
		const url = String(input);
		requests.push({ url, form: new URLSearchParams(String(init?.body)) });
		if (url.endsWith("/token") && !requests.at(-1)?.form.has("token")) return Response.json({ access_token: "renewed-access", refresh_token: "renewed-refresh", token_type: "Bearer", expires_in: 3600 });
		return new Response("", { status: 200 });
	},
	openBrowser: async () => { throw new Error("unexpected browser open"); },
	clock: { now: () => now, sleep: async () => undefined },
	random: (bytes) => new Uint8Array(bytes),
	stateRoot: root,
	env: {},
	config,
});
const file = () => path.join(root, "connectors", "canva", "personal", "session.json");
const receiptFile = () => path.join(path.dirname(file()), "registration.json");

test("status inspects legacy state; migration uses the lock and later fresh reads keep working while it is held", async () => {
	writeSessionFixture(root, { now });
	const before = readFileSync(file(), "utf8");
	expect(status("personal", deps()).ok).toBe(true);
	expect([readFileSync(file(), "utf8"), existsSync(receiptFile())]).toEqual([before, false]);
	writeFileSync(path.join(path.dirname(file()), "refresh.lock"), "held", { mode: 0o600 });
	expect(await accessToken("personal", deps())).toMatchObject({ ok: false, cause: "auth-busy" });
	expect([readFileSync(file(), "utf8"), existsSync(receiptFile()), requests]).toEqual([before, false, []]);
	rmSync(path.join(path.dirname(file()), "refresh.lock"));
	expect(await accessToken("personal", deps())).toMatchObject({ ok: true, token: FIXTURE_ACCESS_TOKEN });
	expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ dcrReceipt: 1 });
	expect(JSON.parse(readFileSync(receiptFile(), "utf8"))).toMatchObject({ account: "personal", client: { clientId: "fixture-client-1" } });
	expect(statSync(receiptFile()).mode & 0o7777).toBe(0o600);
	const receipt = readFileSync(receiptFile(), "utf8");
	writeFileSync(path.join(path.dirname(file()), "refresh.lock"), "held", { mode: 0o600 });
	expect(await accessToken("personal", deps())).toMatchObject({ ok: true, token: FIXTURE_ACCESS_TOKEN });
	writeFileSync(receiptFile(), receipt.replace("fixture-client-1", "other-dcr-client"));
	expect(await accessToken("personal", deps())).toMatchObject({ ok: false, cause: "session-binding-invalid" });
	writeFileSync(receiptFile(), receipt);
	expect([readFileSync(receiptFile(), "utf8"), requests]).toEqual([receipt, []]);
	rmSync(path.join(path.dirname(file()), "refresh.lock"));
});

test("a receipt mismatch or missing marked receipt refuses fresh access and logout without changing the grant", async () => {
	writeSessionFixture(root, { now });
	expect(await accessToken("personal", deps())).toMatchObject({ ok: true });
	const original = JSON.parse(readFileSync(file(), "utf8"));
	for (const damage of [
		() => writeFileSync(file(), `${JSON.stringify({ ...original, client: { ...original.client, clientId: "another-dcr-client" } })}\n`),
		() => { writeFileSync(file(), `${JSON.stringify(original)}\n`); rmSync(receiptFile()); },
	]) {
		damage();
		const before = readFileSync(file(), "utf8");
		expect(await accessToken("personal", deps())).toMatchObject({ ok: false, cause: "session-binding-invalid" });
		expect(await logout("personal", deps())).toMatchObject({ ok: false, cause: "session-binding-invalid", revoked: "not-needed" });
		expect([readFileSync(file(), "utf8"), requests]).toEqual([before, []]);
	}
});

test("a receipt written before the marked session recovers without replacing the receipt", async () => {
	writeSessionFixture(root, { now });
	const original = JSON.parse(readFileSync(file(), "utf8"));
	const receipt = `${JSON.stringify({ version: 1, account: "personal", issuer: original.issuer, resource: original.resource, client: original.client })}\n`;
	writeFileSync(receiptFile(), receipt, { mode: 0o600 });
	expect(await accessToken("personal", deps())).toMatchObject({ ok: true, token: FIXTURE_ACCESS_TOKEN });
	expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ dcrReceipt: 1 });
	expect([readFileSync(receiptFile(), "utf8"), requests]).toEqual([receipt, []]);
});

test("the selected Canva record returns a fresh token, then refreshes and revokes at trusted endpoints", async () => {
	writeSessionFixture(root, { now });
	expect(await accessToken("personal", deps())).toMatchObject({ ok: true, token: FIXTURE_ACCESS_TOKEN });
	expect(requests).toEqual([]);
	now += 3_600_000;
	expect(await accessToken("personal", deps())).toMatchObject({ ok: true, token: "renewed-access" });
	expect(requests.map((request) => request.url)).toEqual(["https://mcp.canva.com/token"]);
	expect([requests[0]?.form.get("grant_type"), requests[0]?.form.get("resource"), requests[0]?.form.get("refresh_token")]).toEqual(["refresh_token", "https://mcp.canva.com/mcp", FIXTURE_REFRESH_TOKEN]);
	expect(await logout("personal", deps())).toEqual({ ok: true, removed: true, revoked: "confirmed" });
	expect(requests.map((request) => request.url)).toEqual(["https://mcp.canva.com/token", "https://mcp.canva.com/token"]);
	expect([requests[1]?.form.get("token"), existsSync(file()), existsSync(receiptFile())]).toEqual(["renewed-refresh", false, true]);
});

test("wrong resource, server, client, or endpoint never sends a credential, even when the access token is fresh", async () => {
	const cases = [
		{ resource: "https://mcp.canva.com/other" },
		{ issuer: "https://other.example" },
		{ issuer: "https://mcp.canva.com/other" },
		{ tokenEndpoint: "https://other.example/token" },
		{ tokenEndpoint: "https://mcp.canva.com/other" },
		{ tokenEndpoint: "http://127.0.0.1:1/token" },
		{ revocationEndpoint: "https://other.example/revoke" },
		{ revocationEndpoint: "https://mcp.canva.com/mcp" },
		{ revocationEndpoint: "https://mcp.canva.com/revoke?redirect=other" },
		{ client: { mode: "cimd" as const, clientId: "https://other.example/client.json", redirectUri: "http://127.0.0.1:47391/callback" } },
	];
	for (const overrides of cases) {
		writeSessionFixture(root, { now, overrides });
		for (const selectedTime of [now, now + 3_600_000]) {
			const previous = now;
			now = selectedTime;
			expect(await accessToken("personal", deps())).toMatchObject({ ok: false, cause: "session-binding-invalid" });
			now = previous;
		}
		expect(await logout("personal", deps())).toMatchObject({ ok: false, cause: "session-binding-invalid", revoked: "not-needed" });
		expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject(overrides);
	}
	expect(requests).toEqual([]);
});

test("production configuration refuses fixture HTTP resources", () => {
	expect(parseOAuthConfig({ resource: "http://127.0.0.1:5000/mcp", client: { mode: "dcr", clientName: "Connectors plugin" }, loopbackPort: 0 })).toBeNull();
});
