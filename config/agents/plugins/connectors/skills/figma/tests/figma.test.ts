import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertCustody, createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const CONFIG = path.join(SKILL, "config", "mcporter.json");

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("Figma hosted Provider", () => {
	test("registry fixes the hosted endpoint and admits only identity", () => {
		const registry = JSON.parse(readFileSync(CONFIG, "utf8"));
		expect(registry.imports).toEqual([]);
		expect(registry.mcpServers).toEqual({
			"figma-connectors": {
				description: "Figma hosted MCP, attended local OAuth",
				baseUrl: "https://mcp.figma.com/mcp",
				auth: "oauth",
				clientName: "Claude Code",
				allowedTools: ["whoami"],
			},
		});
	});

	test("attended auth targets only the declared Figma server", async () => {
		const result = await harness.run(["figma", "--", "auth"]);
		expect(result.code).toBe(0);
		const receipt = harness.receipt<{ argv: string[]; env: Record<string, string>; pid: number; kind: string; url: string }>("mcporter.json");
		expect(receipt.argv).toEqual(["--config", CONFIG, "auth", "figma-connectors"]);
		expect(receipt.pid).toBe(result.pid);
		expect(receipt.kind).toBe("http");
		expect(receipt.url).toBe("https://mcp.figma.com/mcp");
		expect(receipt.env).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
		expect(receipt.env).not.toHaveProperty("AMBIENT_SENTINEL");
	});

	test("routine discovery uses cached OAuth without starting login", async () => {
		const result = await harness.run(["figma", "--", "list", "--schema", "--json"]);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, []);
		expect(receipt.kind).toBe("http");
		expect(receipt.url).toBe("https://mcp.figma.com/mcp");
		expect(receipt.argv).toEqual(["--config", CONFIG, "list", "figma-connectors", "--schema", "--json", "--no-oauth"]);
	});

	test("read-tool call stays on the Figma server and uses cached OAuth", async () => {
		const result = await harness.run(["figma", "--", "call", "whoami", "--output", "json"]);
		expect(result.code).toBe(0);
		expect(assertCustody(harness, result, []).argv).toEqual(["--config", CONFIG, "call", "figma-connectors.whoami", "--output", "json", "--no-oauth"]);
	});

	test("route cannot select the ambient figma server", async () => {
		const result = await harness.run(["figma", "--provider", "figma", "--", "auth"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("provider-route:error:provider-invalid:");
		expect(harness.has("mcporter.json")).toBe(false);
	});
});
