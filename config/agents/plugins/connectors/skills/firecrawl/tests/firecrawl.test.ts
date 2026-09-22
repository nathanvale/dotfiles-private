import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertCustody, createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("Firecrawl hosted provider", () => {
	test("keyless config exposes only search and scrape", () => {
		const config = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8"));
		expect(config.mcpServers.firecrawl.allowedTools).toEqual(["firecrawl_search", "firecrawl_scrape"]);
	});

	test("list reaches the keyless v2 entry with no header", async () => {
		const result = await harness.run(["firecrawl", "--", "list", "--schema", "--json", "--timeout", "15000"]);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, []);
		expect(receipt.kind).toBe("http");
		expect(receipt.url).toBe("https://mcp.firecrawl.dev/v2/mcp");
		expect(receipt.headers).toBeNull();
		expect(receipt.argv.slice(1)).toEqual([path.join(SKILL, "config", "mcporter.json"), "list", "firecrawl", "--schema", "--json", "--timeout", "15000", "--no-oauth"]);
	});

	test("call composes firecrawl.<tool> and keeps key=value tool arguments", async () => {
		const result = await harness.run(["firecrawl", "--", "call", "firecrawl_search", "query=bun", "limit=1"]);
		expect(result.code).toBe(0);
		expect(assertCustody(harness, result, []).argv.slice(2)).toEqual(["call", "firecrawl.firecrawl_search", "query=bun", "limit=1", "--no-oauth"]);
	});
});
