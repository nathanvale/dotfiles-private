import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");

// Independent oracle: the read-only design-discovery tools documented by
// Canva, restated here so configuration cannot validate itself.
const EXPECTED_ALLOWED_TOOLS = ["search-designs", "get-design", "get-design-pages", "get-design-content"];

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("Canva configured capability", () => {
	test("registry exposes only authenticated read-only design discovery", () => {
		const config = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8"));
		expect(config).toEqual({
			$schema: "https://raw.githubusercontent.com/openclaw/mcporter/main/mcporter.schema.json",
			imports: [],
			mcpServers: {
				canva: {
					description: "Canva Official remote MCP, configured read-only and unavailable pending accepted per-user OAuth custody",
					baseUrl: "https://mcp.canva.com/mcp",
					allowedTools: EXPECTED_ALLOWED_TOOLS,
				},
			},
		});
	});

	test("route remains fail-closed behind the dispatcher seam", () => {
		const route = JSON.parse(readFileSync(path.join(SKILL, "config", "route.json"), "utf8"));
		expect(route).toEqual({ defaultProvider: "canva", dispatcherOwned: true });
	});

	for (const invocation of [
		["canva", "--", "list", "--schema", "--json"],
		["canva", "--", "call", "search-designs", "--args", '{"query":"onboarding"}'],
	]) {
		test(`refuses ${invocation[2]} before MCPorter can own OAuth`, async () => {
			const result = await harness.run(invocation);
			expect([result.code, result.stdout, result.stderr]).toEqual([
				3,
				"",
				"provider-route:error:dispatcher-owned:skill canva accepts provider transport only through its semantic dispatcher\n",
			]);
			expect(harness.has("mcporter.json")).toBe(false);
		});
	}
});
