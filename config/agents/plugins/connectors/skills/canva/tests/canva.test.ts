// Public-process proof of the activated Canva route: registry and route
// literals, then the real launcher crossing the fake MCPorter into the real
// Provider and the shared bridge fake, with the session under XDG_STATE_HOME.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertCustody, createHarness, FIXTURES, type Harness } from "../../../tests/harness.ts";
import { FIXTURE_ACCESS_TOKEN as ACCESS_TOKEN, FIXTURE_REFRESH_TOKEN as REFRESH_TOKEN, writeSessionFixture } from "./fixtures/session.ts";

const SKILL = path.resolve(import.meta.dir, "..");
// Independent oracles: the read-only design-discovery tools documented by
// Canva, and the fixture session's tokens, restated so configuration cannot
// validate itself.
const EXPECTED_ALLOWED_TOOLS = ["search-designs", "get-design", "get-design-pages", "get-design-content"];

let harness: Harness;
beforeEach(() => {
	harness = createHarness({ "hyper-mcp-remote": path.join(FIXTURES, "bridge-fake.ts") });
});
afterEach(() => harness.dispose());

describe("Canva activated route", () => {
	test("registry runs the Provider as a stdio server with the account selector and only read-only design discovery", () => {
		const config = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8"));
		expect(config).toEqual({
			$schema: "https://raw.githubusercontent.com/openclaw/mcporter/main/mcporter.schema.json",
			imports: [],
			mcpServers: {
				canva: {
					description: "Canva Official remote MCP, read-only design discovery, through the per-account OAuth session Provider and the credential-scoped stdio bridge",
					command: "../scripts/canva-provider.ts",
					env: { CANVA_ACCOUNT: "${CANVA_ACCOUNT}" },
					allowedTools: EXPECTED_ALLOWED_TOOLS,
				},
			},
		});
	});

	test("route declares the account selector and no longer defers to a dispatcher", () => {
		const route = JSON.parse(readFileSync(path.join(SKILL, "config", "route.json"), "utf8"));
		expect(route).toEqual({ defaultProvider: "canva", selectors: { account: "CANVA_ACCOUNT" } });
	});

	test("a call crosses the route, MCPorter, the Provider, and the bridge with only the access token below MCPorter", async () => {
		writeSessionFixture(harness.root, { overrides: { revocationEndpoint: null } });
		const result = await harness.run(["canva", "--select", "account=personal", "--", "call", "search-designs", "--args", '{"query":"onboarding"}']);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		// The fixture Bun launcher adds a child while preloading the fake bridge.
		const mcporter = assertCustody(harness, result, [ACCESS_TOKEN, REFRESH_TOKEN], "child");
		expect(mcporter.kind).toBe("stdio");
		expect(mcporter.command).toBe(path.join(SKILL, "scripts", "canva-provider.ts"));
		expect(mcporter.env.CANVA_ACCOUNT).toBe("personal");
		expect(mcporter.argv).toEqual(["--config", path.join(SKILL, "config", "mcporter.json"), "call", "canva.search-designs", "--args", '{"query":"onboarding"}', "--no-oauth"]);
		const bridge = harness.receipt("bridge.json");
		expect(bridge.argv).toEqual(["https://mcp.canva.com/mcp", "--no-auth", "--header", "Authorization: Bearer ${CANVA_ACCESS_TOKEN}"]);
		expect([bridge.canvaTokenMatches, bridge.canvaRefreshPresent, bridge.ambient, bridge.opToken]).toEqual([true, false, false, false]);
	});

	test("a fresh tree refuses at the Provider with auth-required before any bridge starts", async () => {
		const result = await harness.run(["canva", "--select", "account=personal", "--", "list", "--schema", "--json"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "canva-provider:error:auth-required:no session exists for this account; run canva-auth login\n"]);
		expect(harness.has("bridge.json")).toBe(false);
	});

	test("a missing or malformed account selector refuses at the route before MCPorter", async () => {
		writeSessionFixture(harness.root, { overrides: { revocationEndpoint: null } });
		const missing = await harness.run(["canva", "--", "call", "search-designs"]);
		expect([missing.code, missing.stdout, missing.stderr]).toEqual([2, "", "provider-route:error:select-missing:skill canva requires --select account=<value>\n"]);
		const undeclared = await harness.run(["canva", "--select", "tenant=personal", "--", "call", "search-designs"]);
		expect([undeclared.code, undeclared.stderr]).toEqual([2, "provider-route:error:select-undeclared:skill canva does not declare selector tenant\n"]);
		expect(harness.has("mcporter.json")).toBe(false);
	});
});
