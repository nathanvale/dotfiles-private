// Ticket #137 under Spec #87 (AC11, AC26): the Firecrawl facts only this Skill
// owns. Its keyless and account behavior through the packaged front door is
// proved in tests/account-key.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ACCOUNT_ENDPOINT } from "../scripts/endpoint.ts";
import { createHarness, type Harness } from "../../../tests/harness.ts";

// Independent oracle: the one hosted origin the Firecrawl key may reach.
const HOSTED_ENDPOINT = "https://mcp.firecrawl.dev/v2/mcp";

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

// Fails if the shipped endpoint leaf names any other origin. Process tests
// substitute this leaf in a copy, so only this test observes the shipped
// value; tests/account-key.test.ts proves the Provider sends only to the leaf.
test("the shipped endpoint leaf names only the hosted Firecrawl endpoint", () => {
	expect(ACCOUNT_ENDPOINT).toBe(HOSTED_ENDPOINT);
});

// Fails if the direct launcher still reached Firecrawl: after configure, that
// keyless route would bypass the account key.
test("the direct launcher refuses Firecrawl, whose transport belongs to the front door", async () => {
	const result = await harness.run(["firecrawl", "--", "call", "firecrawl_search", "--args", '{"query":"bun"}']);
	expect([result.code, result.stdout, result.stderr.includes("provider-route:error:dispatcher-owned:")]).toEqual([3, "", true]);
	expect(harness.has("mcporter.json")).toBe(false);
});
