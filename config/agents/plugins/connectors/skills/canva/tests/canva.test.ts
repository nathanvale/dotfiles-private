// Canva's source-level proof (Ticket #93 under Spec #87): the registry and
// route declarations, the custody interface's physical-path seam for the
// packaged adapter, and the public shared route's refusal of Canva. The
// packaged front door's process proof lives in tests/canva-packaged.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planCanvaRoute, readClientMode } from "../scripts/custody/index.ts";
import { createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
// Independent oracles, restated from Canva's documented read-only discovery
// tools and the accepted Spec so configuration cannot validate itself.
const EXPECTED_ALLOWED_TOOLS = ["search-designs", "get-design", "get-design-pages", "get-design-content"];
const EXPECTED_SERVER = "canva-connectors";

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

const vaultRoot = (account: string) => path.join(harness.root, "connectors", "canva-mcporter", account);

describe("Canva native custody configuration", () => {
	test("registry declares only dynamic-registration OAuth on the fixed endpoint with the four read tools", () => {
		expect(JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8"))).toEqual({
			$schema: "https://raw.githubusercontent.com/openclaw/mcporter/main/mcporter.schema.json",
			imports: [],
			mcpServers: {
				[EXPECTED_SERVER]: {
					description: "Canva Official remote MCP, read-only design discovery, with the OAuth grant in MCPorter's per-account native vault",
					baseUrl: "https://mcp.canva.com/mcp",
					auth: "oauth",
					clientName: "Connectors plugin",
					allowedTools: EXPECTED_ALLOWED_TOOLS,
				},
			},
		});
	});

	test("route declares MCPorter OAuth behind the packaged Canva adapter and the switch selects dcr", () => {
		expect(JSON.parse(readFileSync(path.join(SKILL, "config", "route.json"), "utf8"))).toEqual({
			defaultProvider: EXPECTED_SERVER,
			selectors: { account: "CANVA_ACCOUNT" },
			oauth: "mcporter",
			dispatcherOwned: true,
		});
		expect(JSON.parse(readFileSync(path.join(SKILL, "config", "client.json"), "utf8"))).toEqual({ mode: "dcr" });
	});
});

describe("physical-path seam for a packaged adapter", () => {
	// Private-module proof: a compiled binary cannot use import.meta.dir, so the
	// adapter must be able to name the physical skills root and config dir.
	test("an explicit skills root and config dir are honoured and planning creates no vault", () => {
		const skillsRoot = path.join(harness.root, "physical", "skills");
		cpSync(SKILL, path.join(skillsRoot, "canva"), { recursive: true });
		const configDir = path.join(skillsRoot, "canva", "config");
		writeFileSync(path.join(configDir, "client.json"), JSON.stringify({ mode: "approved" }));
		const env = { HOME: harness.home, PATH: "/usr/bin:/bin", XDG_STATE_HOME: harness.root };
		const { plan, vault } = planCanvaRoute(env, "personal", ["list"], skillsRoot);
		expect([readClientMode(configDir), readClientMode(), plan.configPath, plan.env.XDG_DATA_HOME, vault.root]).toEqual([
			"approved",
			"dcr",
			path.join(skillsRoot, "canva", "config", "mcporter.json"),
			path.join(vaultRoot("personal"), "data"),
			vaultRoot("personal"),
		]);
		expect(existsSync(vaultRoot("personal"))).toBe(false);
	});
});

describe("shared route regression", () => {
	test("the public route refuses Canva, so no read can reach the shared HOME vault", async () => {
		const result = await harness.run(["canva", "--select", "account=personal", "--", "auth"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "provider-route:error:dispatcher-owned:skill canva accepts provider transport only through its semantic dispatcher\n"]);
		expect(harness.has("mcporter.json")).toBe(false);
	});
});
