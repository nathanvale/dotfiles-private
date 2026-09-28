// Public-process proof of the Bun Atlassian Community Provider, invoked the
// way MCPorter invokes it: no arguments, cwd at the skill config directory,
// tenant slug and product in the environment, fakes on PATH, the credential
// helper below HOME. Two static routes: one per product.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { AMBIENT_SENTINEL, createHarness, type Harness, itemJson, OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const FIXTURES = path.join(SKILL, "tests", "fixtures");
const COMMUNITY = path.join(SKILL, "scripts", "atlassian-community-provider.ts");
const REST = path.join(SKILL, "scripts", "atlassian-rest-provider.ts");
const SECRETS = ["fixture-community-secret", OP_TOKEN_SENTINEL];
const item = (entries: Record<string, string>, version: number | string = 1) => itemJson({ site_url: "https://example.atlassian.net", ...entries }, version);
const rawItem = itemJson;
// The built-in url is token management, never the tenant origin.
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const FULL_ITEM = item({ username: "service@example.invalid", credential: "fixture-community-secret", url: MANAGEMENT_URL, site_url: "https://Example.atlassian.net/" });

let harness: Harness;
beforeEach(() => {
	harness = createHarness({ uvx: path.join(FIXTURES, "uvx-fake.ts") });
});
afterEach(() => harness.dispose());

async function runProvider(script: string, args: string[] = [], env: Record<string, string> = {}, stdin: string | undefined = undefined) {
	const proc = Bun.spawn([script, ...args], {
		cwd: path.join(SKILL, "config"),
		env: {
			HOME: harness.home,
			PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
			TMPDIR: harness.root,
			XDG_STATE_HOME: harness.root,
			ATLASSIAN_TENANT: "example",
		ATLASSIAN_PRODUCT: "jira",
		CONNECTORS_INTERNAL_INVOCATION_CONTEXT: '{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:1","origin":"https://example.atlassian.net"}',
			AMBIENT_SENTINEL,
			OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN_SENTINEL,
			...env,
		},
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
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

const wrapperLines = () => (harness.has("wrapper.log") ? readFileSync(path.join(harness.root, "wrapper.log"), "utf8").trim().split("\n") : []);

describe("Community provider process", () => {
	test("preflight proves local readiness without starting the pinned package", async () => {
		harness.write("item.json", FULL_ITEM);
		const result = await runProvider(COMMUNITY, ["--preflight"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
		expect(wrapperLines()).toEqual(["op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
		expect(harness.has("community-provider.json")).toBe(false);
		const outbox = path.join(harness.root, "connectors", "atlassian", "example", "outbox");
		expect((statSync(outbox).mode & 0o777).toString(8)).toBe("700");
	});

	test("preflight refuses a symlinked Upload Outbox before starting the package", async () => {
		harness.write("item.json", FULL_ITEM);
		const outbox = path.join(harness.root, "connectors", "atlassian", "example", "outbox");
		mkdirSync(path.dirname(outbox), { recursive: true });
		const outside = path.join(harness.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, outbox);
		const result = await runProvider(COMMUNITY, ["--preflight"]);
		expect([result.code, result.stdout, result.stderr.includes("atlassian-provider:error:outbox-unavailable:")]).toEqual([4, "", true]);
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("a rotated item version or trusted origin refuses before the Provider executable starts", async () => {
		const secret = "fixture-community-secret";
		for (const [label, changed] of [
			["version", item({ username: "service@example.invalid", credential: secret }, 2)],
			["origin", item({ username: "service@example.invalid", credential: secret, site_url: "https://other.atlassian.net" }, 1)],
		] as const) {
			harness.write("item.json", changed);
			const result = await runProvider(COMMUNITY);
			expect([label, result.code, result.stderr.includes("atlassian-provider:error:credential-context-stale:")]).toEqual([label, 4, true]);
			expect(harness.has("community-provider.json")).toBe(false);
			for (const stream of [result.stdout, result.stderr, readFileSync(path.join(harness.root, "wrapper.log"), "utf8")]) expect(stream).not.toContain(secret);
		}
	});

	test("a missing credential field is a fields-missing precondition; a malformed one is credential-invalid; neither starts the package", async () => {
		harness.write("item.json", item({ username: "service@example.invalid" }));
		const missing = await runProvider(COMMUNITY, ["--preflight"]);
		expect([missing.code, missing.stdout, missing.stderr.includes("atlassian-provider:error:community-fields-missing:")]).toEqual([4, "", true]);
		harness.write("item.json", item({ username: "service@example.invalid", credential: "private-value\nsecond-line" }));
		const malformed = await runProvider(COMMUNITY);
		expect([malformed.code, malformed.stderr.includes("atlassian-provider:error:credential-invalid:")]).toEqual([4, true]);
		expect(malformed.stderr).not.toContain("private-value");
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("the retired injected phase is refused as an argument, never re-entered", async () => {
		harness.write("item.json", FULL_ITEM);
		const result = await runProvider(COMMUNITY, ["--injected", "example", "jira"], { ATLASSIAN_API_KEY: "fixture-atlassian-api-key" });
		expect([result.code, result.stderr.includes("atlassian-provider:error:arguments-invalid:")]).toEqual([2, true]);
		expect(wrapperLines()).toEqual([]);
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("jira: injects only the Jira triplet from the JIRA item and the site_url origin", async () => {
		harness.write("item.json", FULL_ITEM);
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(wrapperLines()).toEqual(["op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
		const community = harness.receipt("community-provider.json");
		expect(community.argv).toEqual(["--system-certs", "--no-env-file", "--from", "mcp-atlassian==0.23.1", "mcp-atlassian"]);
		expect(community.jiraKeys).toEqual(["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"]);
		expect(community.confluenceKeys).toEqual([]);
		// The package starts in the tenant's private outbox, the only place it may read uploads from.
		const outbox = path.join(harness.root, "connectors", "atlassian", "example", "outbox");
		expect(realpathSync(community.cwd as string)).toBe(realpathSync(outbox));
		expect((statSync(outbox).mode & 0o777).toString(8)).toBe("700");
		expect(community.jiraUrl).toBe("https://example.atlassian.net");
		expect(community.username).toBe("service@example.invalid");
		expect(community.tokenMatches).toBe(true);
		expect(community.ambient).toBe(false);
		expect(community.opToken).toBe(false);
	});

	test("prefers site_url over the legacy url field", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: "https://other.atlassian.net", site_url: "https://Example.atlassian.net/" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(harness.receipt("community-provider.json").jiraUrl).toBe("https://example.atlassian.net");
	});

	test("refuses a legacy url when site_url is absent", async () => {
		harness.write("item.json", rawItem({ username: "service@example.invalid", credential: "fixture-community-secret", url: "https://Example.atlassian.net:443/" }, 1));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("refuses an invalid site_url without falling back to a valid legacy url", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: "https://example.atlassian.net", site_url: "https://example.atlassian.net/wiki" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(result.stderr).not.toContain("https://example.atlassian.net/wiki");
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("confluence: injects only the Confluence triplet from the CONFLUENCE item with the wiki origin", async () => {
		harness.write("item.json", FULL_ITEM);
		const result = await runProvider(COMMUNITY, [], { ATLASSIAN_PRODUCT: "confluence" });
		expect(result.code).toBe(0);
		expect(wrapperLines()).toEqual(["op item get CONFLUENCE_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
		const community = harness.receipt("community-provider.json");
		expect(community.confluenceKeys).toEqual(["CONFLUENCE_URL", "CONFLUENCE_USERNAME", "CONFLUENCE_API_TOKEN"]);
		expect(community.jiraKeys).toEqual([]);
		expect(community.confluenceUrl).toBe("https://example.atlassian.net/wiki");
	});

	test("never uses the built-in token-management url as the site origin", async () => {
		harness.write("item.json", rawItem({ username: "service@example.invalid", credential: "fixture-community-secret", url: MANAGEMENT_URL }, 1));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(result.stderr).not.toContain(MANAGEMENT_URL);
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("fails closed on an unreadable, incomplete, duplicate, or malformed item", async () => {
		const unreadable = await runProvider(COMMUNITY);
		expect(unreadable.stderr).toContain("atlassian-provider:error:credential-unavailable:");
		harness.write("item.json", item({ credential: "fixture-community-secret", site_url: "https://example.atlassian.net" }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		harness.write("item.json", JSON.stringify({ fields: [{ label: "username", value: "a" }, { label: "Username", value: "b" }, { label: "credential", value: "c" }, { label: "site_url", value: "https://example.atlassian.net" }] }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		harness.write("item.json", item({ username: "service@example.invalid\n", credential: "c", site_url: "https://example.atlassian.net" }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("an empty field label falls back to the field id", async () => {
		harness.write("item.json", JSON.stringify({ version: 1, fields: [
			{ id: "username", label: "", value: "service@example.invalid" },
			{ id: "credential", label: "", value: "fixture-community-secret" },
			{ id: "site_url", label: "", value: "https://example.atlassian.net" },
		] }));
		expect((await runProvider(COMMUNITY)).code).toBe(0);
		expect(harness.receipt("community-provider.json").username).toBe("service@example.invalid");
	});

	test("rejects legacy urls outside a plain https atlassian.net origin", async () => {
		for (const url of [
			MANAGEMENT_URL,
			"https://example.atlassian.net/wiki",
			"https://example.atlassian.net?project=TEST",
			"https://example.atlassian.net#fragment",
			"https://user@other.atlassian.net",
			"https://user:password@example.atlassian.net",
			"http://example.atlassian.net",
			"https://example.atlassian.net:443",
			"https://example.atlassian.net:8443",
			"https://@example.atlassian.net",
			"https://example.atlassian.net@evil.example",
			"https://example.atlassian.net.evil.example",
			"https://example.example.com",
			"https://.atlassian.net",
			"https:///",
			"not a URL",
			"https://example.atlassian.net\n",
		]) {
			harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", site_url: url }));
			const result = await runProvider(COMMUNITY);
			expect({ url, code: result.code, cause: result.stderr.includes("atlassian-provider:error:credential-invalid:") }).toEqual({ url, code: 4, cause: true });
			expect(result.stderr).not.toContain(url);
				harness.write("item.json", rawItem({ username: "service@example.invalid", credential: "fixture-community-secret", url }, 1));
			const legacy = await runProvider(COMMUNITY);
			expect({ url, code: legacy.code, cause: legacy.stderr.includes("atlassian-provider:error:credential-invalid:") }).toEqual({ url, code: 4, cause: true });
			expect(legacy.stderr).not.toContain(url);
		}
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("refuses arguments, a bad product, and a non-semantic slug before reading the item", async () => {
		harness.write("item.json", FULL_ITEM);
		expect((await runProvider(COMMUNITY, ["--x"])).stderr).toContain("atlassian-provider:error:arguments-invalid:");
		expect((await runProvider(COMMUNITY, [], { ATLASSIAN_PRODUCT: "both" })).stderr).toContain("atlassian-provider:error:product-invalid:");
		expect((await runProvider(COMMUNITY, [], { ATLASSIAN_TENANT: "Example" })).stderr).toContain("atlassian-provider:error:tenant-invalid:");
		expect(wrapperLines()).toEqual([]);
	});
});

// The owned REST Provider of the wiki-comment exception: the same custody
// below the dispatcher as the Community Provider, one request on stdin, and
// every refusal before a request can leave. No test here reaches the network:
// each request is refused first, so a green suite proves custody and the
// closed vocabulary, never a live call.
describe("REST provider process", () => {
	const request = (tool: string, args: unknown = {}) => JSON.stringify({ tool, args });

	test("refuses arguments, a non-Jira product, and a rotated item before reading a request", async () => {
		harness.write("item.json", FULL_ITEM);
		expect((await runProvider(REST, ["--preflight"], {}, request("jira_rest_myself"))).stderr).toContain("atlassian-provider:error:arguments-invalid:");
		expect(wrapperLines()).toEqual([]);
		const confluence = await runProvider(REST, [], { ATLASSIAN_PRODUCT: "confluence" }, request("jira_rest_myself"));
		expect([confluence.code, confluence.stderr.includes("atlassian-provider:error:product-invalid:")]).toEqual([2, true]);
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret" }, 2));
		const stale = await runProvider(REST, [], {}, request("jira_rest_myself"));
		expect([stale.code, stale.stderr.includes("atlassian-provider:error:credential-context-stale:")]).toEqual([4, true]);
		expect(stale.stdout).toBe("");
	});

	test("refuses a tool outside the closed vocabulary, malformed arguments, and a non-JSON request after the item read, with no request sent", async () => {
		harness.write("item.json", FULL_ITEM);
		for (const [label, stdin] of [
			["unknown tool", request("jira_rest_comment_delete", { issue_key: "PROJ-1", comment_id: "1" })],
			["Community tool", request("jira_add_comment", { issue_key: "PROJ-1", body: "x" })],
			["path escape", request("jira_rest_comment_get", { issue_key: "PROJ-1", comment_id: "1/../2" })],
			["extra argument", request("jira_rest_comment_add", { issue_key: "PROJ-1", body: "x", visibility: "{}" })],
			["extra key", JSON.stringify({ tool: "jira_rest_myself", args: {}, url: "https://evil.example" })],
			["delete without its issue", request("jira_rest_attachment_delete", { attachment_id: "202456" })],
			["delete by file name", request("jira_rest_attachment_delete", { issue_key: "PROJ-1", attachment_id: "before.png" })],
			["not JSON", "not json"],
		] as const) {
			const result = await runProvider(REST, [], {}, stdin);
			expect([label, result.code, result.stdout, result.stderr.includes("atlassian-provider:error:arguments-invalid:")]).toEqual([label, 2, "", true]);
			expect(result.stderr).not.toContain("evil.example");
		}
		expect(wrapperLines()).toEqual(Array(8).fill("op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json"));
	});

	test("a missing or malformed credential field fails closed before the request is read", async () => {
		harness.write("item.json", item({ username: "service@example.invalid" }));
		const missing = await runProvider(REST, [], {}, request("jira_rest_myself"));
		expect([missing.code, missing.stderr.includes("atlassian-provider:error:community-fields-missing:")]).toEqual([4, true]);
		harness.write("item.json", item({ username: "service@example.invalid", credential: "private-value\nsecond-line" }));
		const malformed = await runProvider(REST, [], {}, request("jira_rest_myself"));
		expect([malformed.code, malformed.stderr.includes("atlassian-provider:error:credential-invalid:")]).toEqual([4, true]);
		expect(malformed.stderr).not.toContain("private-value");
	});
});
