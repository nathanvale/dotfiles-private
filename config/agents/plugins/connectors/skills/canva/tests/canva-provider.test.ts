// Public-process proof of the Canva Provider, invoked the way MCPorter invokes
// it: no arguments, cwd at the skill config directory, the account slug in
// the environment, the bridge fake on PATH, and a private session under
// XDG_STATE_HOME. Refresh crosses a real loopback HTTP call to the fake
// authorization server in this test process.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AMBIENT_SENTINEL, createHarness, FIXTURES, type Harness, OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { type FakeAuthorizationServer, startAuthorizationServer } from "./fixtures/authorization-server.ts";
import { FIXTURE_ACCESS_TOKEN as ACCESS_TOKEN, FIXTURE_REFRESH_TOKEN as REFRESH_TOKEN, writeSessionFixture } from "./fixtures/session.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const PROVIDER = path.join(SKILL, "scripts", "canva-provider.ts");
// Independent oracles restated from the bridge fake and the fixture session.
const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, "fixture-access-token", "fixture-refresh-token", OP_TOKEN_SENTINEL];

let harness: Harness;
let fake: FakeAuthorizationServer;
beforeEach(() => {
	harness = createHarness({ "hyper-mcp-remote": path.join(FIXTURES, "bridge-fake.ts") });
	fake = startAuthorizationServer();
});
afterEach(() => {
	fake.stop();
	harness.dispose();
});

const accountDirectory = (account = "personal") => path.join(harness.root, "connectors", "canva", account);
const sessionFile = (account = "personal") => path.join(accountDirectory(account), "session.json");

async function runProvider(args: string[] = [], env: Record<string, string> = {}) {
	const proc = Bun.spawn([PROVIDER, ...args], {
		cwd: path.join(SKILL, "config"),
		env: {
			HOME: harness.home,
			PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
			TMPDIR: harness.root,
			XDG_STATE_HOME: harness.root,
			CANVA_ACCOUNT: "personal",
			AMBIENT_SENTINEL,
			OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN_SENTINEL,
			...env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	for (const secret of SECRETS) {
		expect(stdout).not.toContain(secret);
		expect(stderr).not.toContain(secret);
	}
	return { code, stdout, stderr };
}

describe("Canva Provider process", () => {
	test("execs the pinned bridge against the Canva endpoint with --no-auth and a Bearer template; only the access token crosses", async () => {
		writeSessionFixture(harness.root, { server: fake });
		const result = await runProvider();
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const bridge = harness.receipt("bridge.json");
		expect(bridge.argv).toEqual(["https://mcp.canva.com/mcp", "--no-auth", "--header", "Authorization: Bearer ${CANVA_ACCESS_TOKEN}"]);
		expect([bridge.canvaTokenMatches, bridge.canvaRefreshPresent, bridge.rawKeyPresent, bridge.ambient, bridge.opToken]).toEqual([true, false, false, false, false]);
		expect(bridge.environmentKeys).toEqual(["CANVA_ACCESS_TOKEN", "HOME", "HYPER_MCP_REMOTE_LOG_PATH", "PATH", "TMPDIR", "XDG_STATE_HOME"]);
		const logPath = path.join(accountDirectory(), "hyper-mcp-remote");
		expect(bridge.logPath).toBe(logPath);
		expect(statSync(logPath).mode & 0o777).toBe(0o700);
		expect(JSON.stringify(bridge)).not.toContain(REFRESH_TOKEN);
		expect(fake.calls.tokenRequests).toBe(0);
	});

	test("rotates an expiring token through the session module before exec, with one token request", async () => {
		writeSessionFixture(harness.root, { server: fake, overrides: { accessTokenExpiresAt: Date.now() + 10_000 } });
		fake.currentRefreshToken = REFRESH_TOKEN;
		const result = await runProvider();
		expect([result.code, result.stderr]).toEqual([0, ""]);
		expect([fake.calls.tokenRequests, fake.calls.refreshRequests]).toEqual([1, 1]);
		expect(fake.tokenBodies[0]?.get("refresh_token")).toBe(REFRESH_TOKEN);
		const bridge = harness.receipt("bridge.json");
		expect(bridge.canvaTokenMatches).toBe(false);
		expect(bridge.environmentKeys).toContain("CANVA_ACCESS_TOKEN");
		const session = JSON.parse(readFileSync(sessionFile(), "utf8"));
		expect([session.accessToken, session.refreshToken]).toEqual(["fixture-access-token-1", "fixture-refresh-token-1"]);
		expect(statSync(sessionFile()).mode & 0o7777).toBe(0o600);
	});

	test("no session refuses with auth-required at exit 3 and never spawns the bridge", async () => {
		const result = await runProvider();
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "canva-provider:error:auth-required:no session exists for this account; run canva-auth login\n"]);
		expect(harness.has("bridge.json")).toBe(false);
	});

	test("a revoked grant refuses with auth-expired and removes the session; the next run is auth-required", async () => {
		writeSessionFixture(harness.root, { server: fake, overrides: { accessTokenExpiresAt: Date.now() - 1 } });
		fake.options.invalidGrantNext = true;
		const expired = await runProvider();
		expect([expired.code, expired.stderr]).toEqual([3, "canva-provider:error:auth-expired:the session was revoked or expired at Canva and has been removed; run canva-auth login\n"]);
		expect(harness.has("bridge.json")).toBe(false);
		const again = await runProvider();
		expect(again.stderr).toBe("canva-provider:error:auth-required:no session exists for this account; run canva-auth login\n");
	});

	test("a bridge pin mismatch refuses before any session read", async () => {
		harness.write("bridge-version", "0.5.1\n");
		const result = await runProvider();
		expect([result.code, result.stderr]).toEqual([4, "canva-provider:error:bridge-version-invalid:hyper-mcp-remote 0.5.0 is required\n"]);
		expect(harness.has("bridge.json")).toBe(false);
	});

	test("a world-readable or tampered session refuses with session-invalid and makes no token request", async () => {
		writeSessionFixture(harness.root, { server: fake, overrides: { accessTokenExpiresAt: Date.now() - 1 } });
		chmodSync(sessionFile(), 0o644);
		const readable = await runProvider();
		expect([readable.code, readable.stderr.startsWith("canva-provider:error:session-invalid:")]).toEqual([3, true]);
		chmodSync(sessionFile(), 0o600);
		writeFileSync(sessionFile(), "{}", { mode: 0o600 });
		const tampered = await runProvider();
		expect([tampered.code, tampered.stderr.startsWith("canva-provider:error:session-invalid:")]).toEqual([3, true]);
		expect(fake.calls.tokenRequests).toBe(0);
		expect(harness.has("bridge.json")).toBe(false);
	});

	test("refuses arguments and a missing or non-semantic account before anything else", async () => {
		writeSessionFixture(harness.root, { server: fake });
		expect((await runProvider(["--verbose"])).stderr).toBe("canva-provider:error:arguments-invalid:no provider arguments are accepted\n");
		for (const account of ["", "Personal", "personal team", "../x"]) {
			const result = await runProvider([], { CANVA_ACCOUNT: account });
			expect([account, result.code, result.stderr]).toEqual([account, 2, "canva-provider:error:account-invalid:expected CANVA_ACCOUNT to be a lowercase account slug\n"]);
		}
		expect(harness.has("bridge.json")).toBe(false);
	});

	test("sessions are keyed by account and never cross", async () => {
		writeSessionFixture(harness.root, { account: "other", server: fake });
		const result = await runProvider();
		expect(result.stderr).toBe("canva-provider:error:auth-required:no session exists for this account; run canva-auth login\n");
		expect(harness.has("bridge.json")).toBe(false);
	});
});
