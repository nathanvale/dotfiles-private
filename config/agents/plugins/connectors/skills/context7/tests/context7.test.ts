import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { assertCustody, createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("Context7 hosted provider", () => {
	test("list reaches the hosted entry with no selection and no header", async () => {
		const result = await harness.run(["context7", "--", "list", "--schema", "--json"]);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, []);
		expect(receipt.kind).toBe("http");
		expect(receipt.url).toBe("https://mcp.context7.com/mcp");
		expect(receipt.headers).toBeNull();
		expect(receipt.argv.slice(1)).toEqual([path.join(SKILL, "config", "mcporter.json"), "list", "context7", "--schema", "--json", "--no-oauth"]);
		expect(Object.keys(receipt.env).sort()).toEqual(["HOME", "MCPORTER_NO_KEEPALIVE", "PATH", "TMPDIR", "XDG_STATE_HOME"]);
	});

	test("call composes the documented tool on the context7 server", async () => {
		const result = await harness.run(["context7", "--", "call", "resolve-library-id", "--args", '{"libraryName":"bun"}']);
		expect(result.code).toBe(0);
		expect(assertCustody(harness, result, []).argv.slice(2)).toEqual(["call", "context7.resolve-library-id", "--args", '{"libraryName":"bun"}', "--no-oauth"]);
	});

	test("a selection is refused because this skill declares none", async () => {
		const result = await harness.run(["context7", "--select", "tenant=example", "--", "list"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("provider-route:error:select-undeclared:");
		expect(harness.has("mcporter.json")).toBe(false);
	});
});
