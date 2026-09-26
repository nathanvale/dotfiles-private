// Ticket #93 under Spec #87 (AC19, AC20): the packaged `bin/connectors schema`
// reaches the adapter-backed read stations through the test-bundle-only
// test-auth adapter's prepareSchema. Every process runs in a sandbox that
// allows loopback only; the official MCPorter 0.14.0 is selected from local
// release bytes, and a hostile `mcporter` sits first on PATH. The success
// server is the shared keyless loopback stub; the auth-failure server is this
// file's own, answering HTTP 401 to every request. Expected values are
// test-owned literals restated from the accepted read inventory.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startLoopbackMcpStub } from "./fixtures/loopback-mcp-stub.ts";
import { createBundle, createFakeMcporterBinDir, createFixtureAuthorityBinDir } from "./harness.ts";

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

// Denies all remote network except loopback, and any Keychain command. A
// runner that wraps this file in its own sandbox must use this exact profile.
const LOOPBACK_ONLY = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "localhost:*"))(deny process-exec (literal "/usr/bin/security"))';
const CONNECTOR = "loopback-fixture-skill";
const TOKEN_SENTINEL = "ghp_connectorsSchemaTokenSentinel0000000";
const PROVIDER_SENTINEL = "SENTINEL_SCHEMA_PROVIDER_TEXT";

// Answers every request 401 with a bearer challenge, and keeps each request's
// headers so the test can see what MCPorter presented.
function unauthorizedServer() {
	const headers: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
		headers.push(JSON.stringify([...request.headers]));
		return new Response(PROVIDER_SENTINEL, { status: 401, headers: { "WWW-Authenticate": `Bearer error="${PROVIDER_SENTINEL}"` } });
	} });
	return { url: `http://127.0.0.1:${server.port}/mcp`, headers, stop: () => server.stop(true) };
}

test.skipIf(!official)("schema through the fixture adapter reports success after observed effects and fails closed on HTTP 401", async () => {
	const bundle = createBundle();
	bundle.addSkill(CONNECTOR);
	const hostile = createFakeMcporterBinDir();
	const authority = createFixtureAuthorityBinDir(bundle);
	const stub = startLoopbackMcpStub();
	const unauthorized = unauthorizedServer();
	const state = path.join(bundle.root, "state");
	const home = path.join(bundle.root, "home");
	mkdirSync(state);
	mkdirSync(home);
	const env = { HOME: home, PATH: `${hostile.binDir}:/usr/bin:/bin`, TMPDIR: bundle.root, XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: official ?? "", GITHUB_TOKEN: TOKEN_SENTINEL, OP_SERVICE_ACCOUNT_TOKEN: TOKEN_SENTINEL };
	const pointAt = (url: string) => writeFileSync(path.join(bundle.skillsRoot, CONNECTOR, "config", "mcporter.json"), JSON.stringify({ imports: [], mcpServers: { [CONNECTOR]: { baseUrl: url, allowedTools: ["probe"] } } }));
	const failed = "If the grant expired, run connectors auth login loopback-fixture-skill --select account=<value> yourself in a terminal; otherwise run connectors auth status loopback-fixture-skill --select account=<value> before retrying";
	try {
		// [account, server, exit, cause, completed effects, repairAction], in invocation order.
		// The repeats for b prove effects are observed on disk, never supplied.
		const rows: ReadonlyArray<readonly [string, "stub" | "401", number, string, readonly string[], string | null]> = [
			["a", "stub", 0, "SUCCESS_BOOTSTRAPPED", ["mcporter-bootstrap", "account-vault", "mcporter-vault-file"], null],
			["b", "stub", 0, "SUCCESS_AFTER_ACCOUNT_EFFECT", ["account-vault", "mcporter-vault-file"], null],
			["b", "stub", 0, "SUCCESS_UNCHANGED", [], null],
			["c", "401", 3, "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT", ["account-vault", "mcporter-vault-file"], failed],
			// Pointing b at the 401 server changes its registry URL, so MCPorter rewrites the vault's serverUrls index once; the repeat at the same URL leaves it.
			["b", "401", 3, "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT", ["mcporter-vault-file"], failed],
			["b", "401", 3, "DOMAIN_PROVIDER_CALL_FAILED", [], failed],
		];
		for (const [index, [account, server, exit, cause, completed, repairAction]] of rows.entries()) {
			pointAt(server === "stub" ? stub.url : unauthorized.url);
			const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", LOOPBACK_ONLY, bundle.binary, "schema", CONNECTOR, "--select", `account=${account}`], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			expect({ index, code, stderr, lines: stdout.trim().split("\n").length }).toEqual({ index, code: exit, stderr: "", lines: 1 });
			const { result } = JSON.parse(stdout);
			expect({ index, identity: result.commandIdentity, cause: result.causeCode, effects: result.effects, repairAction: result.repairAction }).toEqual({
				index, identity: "connectors.schema", cause, effects: { completed, remaining: [], uncertain: [], inventoryComplete: true }, repairAction,
			});
			// The tool list comes only from the stub's own tools/list answer.
			if (server === "stub") expect({ index, connector: result.data.connector, tools: result.data.schema.tools }).toEqual({ index, connector: CONNECTOR, tools: [{ name: "probe", inputSchema: { type: "object", properties: {} }, options: [] }] });
			else expect(result.data).toBeNull();
			// No token, provider text, or MCPorter rawMessage reaches the envelope.
			for (const sentinel of [TOKEN_SENTINEL, PROVIDER_SENTINEL, "SSE error"]) expect({ index, sentinel, leaked: stdout.includes(sentinel) }).toEqual({ index, sentinel, leaked: false });
		}
		// MCPorter reached the 401 server at least once per failing row and presented no credential.
		expect(unauthorized.headers.length).toBeGreaterThanOrEqual(3);
		for (const sent of unauthorized.headers) {
			expect(sent).not.toContain(TOKEN_SENTINEL);
			expect(sent.toLowerCase()).not.toContain("authorization");
		}
		// A schema read never calls a tool.
		expect(stub.calls).toBe(0);
		expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
		expect(existsSync(path.join(home, ".mcporter"))).toBe(false);
	} finally {
		unauthorized.stop();
		stub.stop();
		authority.dispose();
		hostile.dispose();
		bundle.dispose();
	}
}, 90_000);
