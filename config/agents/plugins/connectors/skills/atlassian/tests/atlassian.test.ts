// Route-level Atlassian safety expectations through the shared launcher and
// fake MCPorter: four product routes, Official Jira default, credentials only
// in the Provider child, Basic API-token authentication, fail-closed refusals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertCustody, createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const FIXTURES = path.join(SKILL, "tests", "fixtures");
const BASIC = Buffer.from("service@example.invalid:fixture-atlassian-api-key").toString("base64");
const SECRETS = ["fixture-atlassian-api-key", "fixture-community-secret", BASIC];
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const item = (entries: Record<string, string>) => JSON.stringify({ fields: Object.entries(entries).map(([label, value]) => ({ id: label, label, value })) });
const OFFICIAL_ITEM = item({ username: "service@example.invalid", credential: "x", url: MANAGEMENT_URL });
const COMMUNITY_ITEM = item({ username: "service@example.invalid", credential: "fixture-community-secret", url: MANAGEMENT_URL, site_url: "https://example.atlassian.net/" });

let harness: Harness;
beforeEach(() => {
	harness = createHarness({
		"hyper-mcp-remote": path.join(FIXTURES, "bridge-fake.ts"),
		uvx: path.join(FIXTURES, "uvx-fake.ts"),
	});
});
afterEach(() => harness.dispose());

const wrapperLog = () => readFileSync(path.join(harness.root, "wrapper.log"), "utf8");

describe("Official routes", () => {
	test("Jira is the default route; the credential exists only in the provider child and reaches the bridge as Basic", async () => {
		harness.write("item.json", OFFICIAL_ITEM);
		const result = await harness.run(["atlassian", "--select", "tenant=example", "--", "list", "--status", "--json"]);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, SECRETS);
		expect(receipt.argv.slice(2)).toEqual(["list", "atlassian-official-jira", "--status", "--json", "--no-oauth"]);
		expect(receipt.argv[1]).toBe(path.join(SKILL, "config", "mcporter.json"));
		expect(receipt.env.ATLASSIAN_TENANT).toBe("example");
		expect(receipt.env).not.toHaveProperty("ATLASSIAN_PRODUCT");
		expect(wrapperLog()).toContain("inject ATLASSIAN_API_KEY op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential --");
		const bridge = harness.receipt("official-provider.json");
		expect(bridge.argv).toEqual(["https://mcp.atlassian.com/v2/mcp", "--no-auth", "--header", "Authorization: Basic ${ATLASSIAN_BASIC}"]);
		expect(bridge.basicMatches).toBe(true);
		expect(bridge.rawKeyPresent).toBe(false);
		expect(bridge.ambient).toBe(false);
		expect(bridge.opToken).toBe(false);
		const logPath = path.join(harness.home, ".local", "state", "atlassian-mcporter", "hyper-mcp-remote");
		expect(bridge.logPath).toBe(logPath);
		for (const directory of [path.dirname(logPath), logPath]) expect(statSync(directory).mode & 0o777).toBe(0o700);
	});

	test("the Confluence route selects the CONFLUENCE item for the same tenant", async () => {
		harness.write("item.json", OFFICIAL_ITEM);
		const result = await harness.run(["atlassian", "--provider", "atlassian-official-confluence", "--select", "tenant=example", "--", "list", "--status"]);
		expect(result.code).toBe(0);
		assertCustody(harness, result, SECRETS);
		expect(wrapperLog()).toContain("op://API Credentials/CONFLUENCE_EXAMPLE_API_TOKEN/credential");
		expect(wrapperLog()).not.toContain("JIRA_EXAMPLE_API_TOKEN");
	});

	test("raw provider tool calls are dispatcher-owned refusals before credential ingress", async () => {
		harness.write("item.json", OFFICIAL_ITEM);
		const result = await harness.run(["atlassian", "--select", "tenant=example", "--", "call", "getJiraIssue", "--args", '{"cloudId":"fixture","issueIdOrKey":"PROJ-1"}', "--output", "json"]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("dispatcher-owned");
		expect(harness.has("mcporter.json")).toBe(false);
		expect(harness.has("wrapper.log")).toBe(false);
	});

	test("maps the semantic tenant slug to its credential item inside the provider", async () => {
		harness.write("item.json", OFFICIAL_ITEM);
		const result = await harness.run(["atlassian", "--select", "tenant=example-team", "--", "list", "--status"]);
		expect(result.code).toBe(0);
		assertCustody(harness, result, SECRETS);
		expect(harness.receipt("mcporter.json").env).toMatchObject({ ATLASSIAN_TENANT: "example-team" });
		expect(wrapperLog()).toContain("op://API Credentials/JIRA_EXAMPLE_TEAM_API_TOKEN/credential");
	});

	test("checks the bridge pin before credential access", async () => {
		harness.write("item.json", OFFICIAL_ITEM);
		harness.write("bridge-version", "0.5.1\n");
		const result = await harness.run(["atlassian", "--select", "tenant=example", "--", "list", "--status"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("bridge-version-invalid");
		expect(harness.has("wrapper.log")).toBe(false);
		assertCustody(harness, result, SECRETS);
	});

	test("rejects a malformed tenant before MCPorter and a semantically invalid slug below it", async () => {
		const malformed = await harness.run(["atlassian", "--select", "tenant=Example Team", "--", "list", "--status"]);
		expect(malformed.code).toBe(2);
		expect(malformed.stderr).toContain("provider-route:error:select-invalid:");
		expect(harness.has("mcporter.json")).toBe(false);
		expect(harness.has("wrapper.log")).toBe(false);
		const semantic = await harness.run(["atlassian", "--select", "tenant=Example_Team", "--", "list", "--status"]);
		expect(semantic.code).not.toBe(0);
		expect(semantic.stderr).toContain("tenant-invalid");
		expect(harness.has("mcporter.json")).toBe(true);
		expect(harness.has("wrapper.log")).toBe(false);
	});

	test("ad-hoc and cross-provider targets fail before credential access", async () => {
		for (const argv of [
			["atlassian", "--provider", "context7", "--select", "tenant=example", "--", "list"],
			["atlassian", "--provider", "atlassian-official", "--select", "tenant=example", "--", "list"],
			["atlassian", "--select", "tenant=example", "--", "call", "atlassian-community-jira.jira_search"],
			["atlassian", "--select", "tenant=example", "--", "list", "--http-url=https://example.invalid/mcp"],
		]) {
			const result = await harness.run(argv);
			expect(result.code).not.toBe(0);
			expect(harness.has("mcporter.json")).toBe(false);
			expect(harness.has("wrapper.log")).toBe(false);
		}
	});
});

describe("Community routes", () => {
	test("Jira keeps its credential and site origin below MCPorter and injects only the Jira triplet", async () => {
		harness.write("item.json", COMMUNITY_ITEM);
		const result = await harness.run(["atlassian", "--provider", "atlassian-community-jira", "--select", "tenant=example", "--", "list", "--schema"]);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, SECRETS);
		expect(receipt.argv.slice(2)).toEqual(["list", "atlassian-community-jira", "--schema", "--no-oauth"]);
		expect(wrapperLog()).toContain("op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json");
		const community = harness.receipt("community-provider.json");
		expect(community.argv).toEqual(["--system-certs", "--no-env-file", "--from", "mcp-atlassian==0.23.1", "mcp-atlassian"]);
		expect(community.jiraKeys).toEqual(["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"]);
		expect(community.confluenceKeys).toEqual([]);
		expect(community.jiraUrl).toBe("https://example.atlassian.net");
		expect(community.username).toBe("service@example.invalid");
		expect(community.tokenMatches).toBe(true);
		expect(community.ambient).toBe(false);
		expect(community.opToken).toBe(false);
	});

	test("Confluence injects only the Confluence triplet with the wiki origin", async () => {
		harness.write("item.json", COMMUNITY_ITEM);
		const result = await harness.run(["atlassian", "--provider", "atlassian-community-confluence", "--select", "tenant=example", "--", "list", "--schema"]);
		expect(result.code).toBe(0);
		assertCustody(harness, result, SECRETS);
		const community = harness.receipt("community-provider.json");
		expect(community.confluenceKeys).toEqual(["CONFLUENCE_URL", "CONFLUENCE_USERNAME", "CONFLUENCE_API_TOKEN"]);
		expect(community.jiraKeys).toEqual([]);
		expect(community.confluenceUrl).toBe("https://example.atlassian.net/wiki");
	});

	test("rejects the token-management url when site_url is absent", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: MANAGEMENT_URL }));
		const result = await harness.run(["atlassian", "--provider", "atlassian-community-jira", "--select", "tenant=example", "--", "list", "--status"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("site-url-invalid");
		expect(result.stderr).not.toContain(MANAGEMENT_URL);
		expect(harness.has("community-provider.json")).toBe(false);
		assertCustody(harness, result, SECRETS);
	});

	test("rejects a credential-bearing site URL", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", site_url: "https://user@other.atlassian.net" }));
		const result = await harness.run(["atlassian", "--provider", "atlassian-community-jira", "--select", "tenant=example", "--", "list", "--status"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("site-url-invalid");
		expect(harness.has("community-provider.json")).toBe(false);
		assertCustody(harness, result, SECRETS);
	});

	test("an undeclared provider selector is refused before MCPorter", async () => {
		const result = await harness.run(["atlassian", "--provider", "legacy", "--select", "tenant=example", "--", "list", "--status"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("provider-route:error:provider-invalid:");
		expect(harness.has("mcporter.json")).toBe(false);
	});
});

test("the registry declares four product routes with exact allow-lists and no blocklist", () => {
	const registry = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8")) as {
		imports: unknown;
		mcpServers: Record<string, { allowedTools?: string[]; blockedTools?: unknown; env?: Record<string, string> }>;
	};
	expect(registry.imports).toEqual([]);
	expect(Object.keys(registry.mcpServers).sort()).toEqual(["atlassian-community-confluence", "atlassian-community-jira", "atlassian-official-confluence", "atlassian-official-jira"]);
	// Independent oracle: exact primary tool names per route; no broad dispatcher and no deferred name.
	expect(registry.mcpServers["atlassian-official-jira"]?.allowedTools).toEqual(["atlassianUserInfo", "getAccessibleAtlassianResources", "getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "editJiraIssue", "addOrEditJiraIssueComment"]);
	expect(registry.mcpServers["atlassian-official-confluence"]?.allowedTools).toEqual(["atlassianUserInfo", "getAccessibleAtlassianResources", "getConfluenceContent", "searchConfluence", "getConfluenceSpace", "createConfluenceContent", "updateConfluenceContent"]);
	expect(registry.mcpServers["atlassian-community-jira"]?.allowedTools).toEqual(["jira_get_issue", "jira_search", "jira_create_issue", "jira_update_issue", "jira_add_comment"]);
	expect(registry.mcpServers["atlassian-community-confluence"]?.allowedTools).toEqual(["confluence_get_page", "confluence_search", "confluence_get_space", "confluence_get_comments", "confluence_create_page", "confluence_update_page", "confluence_add_comment"]);
	for (const entry of Object.values(registry.mcpServers)) for (const name of ["executeWrite", "executeRead", "executeDestructive", "discover", "createConfluenceComment"]) expect(entry.allowedTools).not.toContain(name);
	for (const [name, entry] of Object.entries(registry.mcpServers)) {
		expect(entry).not.toHaveProperty("blockedTools");
		expect([name, entry.env?.ATLASSIAN_PRODUCT]).toEqual([name, name.endsWith("-jira") ? "jira" : "confluence"]);
	}
});
