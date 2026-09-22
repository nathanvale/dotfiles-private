// Public-process proof of the Bun Atlassian Providers, invoked the way MCPorter
// invokes them: no arguments, cwd at the skill config directory, tenant slug
// and product in the environment, fakes on PATH, the credential helper below
// HOME. Four static routes: official and community, each for jira or confluence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AMBIENT_SENTINEL, createHarness, type Harness, OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const FIXTURES = path.join(SKILL, "tests", "fixtures");
const OFFICIAL = path.join(SKILL, "scripts", "atlassian-official-provider.ts");
const COMMUNITY = path.join(SKILL, "scripts", "atlassian-community-provider.ts");
const SECRETS = ["fixture-atlassian-api-key", "fixture-community-secret", OP_TOKEN_SENTINEL, Buffer.from("service@example.invalid:fixture-atlassian-api-key").toString("base64")];
const item = (fields: Record<string, string>) =>
	JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ id: label, label, value })) });
// The built-in url is token management, never the tenant origin.
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const FULL_ITEM = item({ username: "service@example.invalid", credential: "fixture-community-secret", url: MANAGEMENT_URL, site_url: "https://Example.atlassian.net/" });

let harness: Harness;
beforeEach(() => {
	harness = createHarness({
		"hyper-mcp-remote": path.join(FIXTURES, "bridge-fake.ts"),
		uvx: path.join(FIXTURES, "uvx-fake.ts"),
	});
});
afterEach(() => harness.dispose());

async function runProvider(script: string, args: string[] = [], env: Record<string, string> = {}) {
	const proc = Bun.spawn([script, ...args], {
		cwd: path.join(SKILL, "config"),
		env: {
			HOME: harness.home,
			PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
			TMPDIR: harness.root,
			XDG_STATE_HOME: harness.root,
			ATLASSIAN_TENANT: "example",
			ATLASSIAN_PRODUCT: "jira",
			AMBIENT_SENTINEL,
			OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN_SENTINEL,
			...env,
		},
		stdin: "ignore",
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

describe("Official provider process", () => {
	test("jira: probes the bridge pin, reads the username as metadata, injects the credential, then sends Basic to the bridge", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x", url: MANAGEMENT_URL }));
		const result = await runProvider(OFFICIAL);
		expect(result.code).toBe(0);
		// The helper forwards no custom environment through inject, so the
		// injected phase re-reads the username as metadata rather than taking
		// it from argv or env.
		expect(wrapperLines()).toEqual([
			"op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --fields label=username --format json",
			`inject ATLASSIAN_API_KEY op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential -- /usr/bin/env ATLASSIAN_TENANT=example ATLASSIAN_PRODUCT=jira ${OFFICIAL} --injected example jira`,
			"op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --fields label=username --format json",
		]);
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

	test("confluence: selects the CONFLUENCE item for the same tenant", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x" }));
		expect((await runProvider(OFFICIAL, [], { ATLASSIAN_PRODUCT: "confluence" })).code).toBe(0);
		expect(wrapperLines()[0]).toBe("op item get CONFLUENCE_EXAMPLE_API_TOKEN --vault API Credentials --fields label=username --format json");
		expect(wrapperLines()[1]).toContain("op://API Credentials/CONFLUENCE_EXAMPLE_API_TOKEN/credential");
	});

	test("maps a dashed tenant slug to its item title", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x" }));
		expect((await runProvider(OFFICIAL, [], { ATLASSIAN_TENANT: "example-team" })).code).toBe(0);
		expect(wrapperLines()[1]).toContain("op://API Credentials/JIRA_EXAMPLE_TEAM_API_TOKEN/credential");
	});

	test("refuses a missing or unknown product, and a non-semantic slug, before any credential access", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x" }));
		for (const [env, cause] of [
			[{ ATLASSIAN_PRODUCT: "" }, "product-invalid"],
			[{ ATLASSIAN_PRODUCT: "bitbucket" }, "product-invalid"],
			[{ ATLASSIAN_PRODUCT: "Jira" }, "product-invalid"],
			[{ ATLASSIAN_TENANT: "Example" }, "tenant-invalid"],
			[{ ATLASSIAN_TENANT: "example_team" }, "tenant-invalid"],
		] as [Record<string, string>, string][]) {
			const result = await runProvider(OFFICIAL, [], env);
			expect([cause, result.code]).toEqual([cause, 2]);
			expect(result.stderr).toContain(`atlassian-provider:error:${cause}:`);
		}
		expect(wrapperLines()).toEqual([]);
	});

	test("refuses arguments", async () => {
		const result = await runProvider(OFFICIAL, ["--verbose"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("atlassian-provider:error:arguments-invalid:");
		expect(wrapperLines()).toEqual([]);
	});

	test("checks the bridge pin before credential access", async () => {
		harness.write("bridge-version", "0.5.1\n");
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x" }));
		const result = await runProvider(OFFICIAL);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:bridge-version-invalid:");
		expect(wrapperLines()).toEqual([]);
		expect(harness.has("official-provider.json")).toBe(false);
	});

	test("fails closed when the username is missing or malformed, before injecting the credential", async () => {
		harness.write("item.json", item({ credential: "x", url: MANAGEMENT_URL }));
		const missing = await runProvider(OFFICIAL);
		expect(missing.code).toBe(4);
		expect(missing.stderr).toContain("atlassian-provider:error:username-missing:");
		harness.write("item.json", item({ username: "bad:user\n", credential: "x" }));
		const malformed = await runProvider(OFFICIAL);
		expect(malformed.code).toBe(4);
		expect(malformed.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(wrapperLines().some((line) => line.startsWith("inject"))).toBe(false);
		expect(harness.has("official-provider.json")).toBe(false);
	});

	test("fails closed when the credential helper is absent", async () => {
		const result = await runProvider(OFFICIAL, [], { HOME: path.join(harness.root, "no-such-home") });
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-wrapper-missing:");
	});

	test("the injected phase re-probes the bridge pin and refuses a missing or malformed credential or username", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x" }));
		const injected = ["--injected", "example", "jira"];
		harness.write("bridge-version", "0.5.1\n");
		const stale = await runProvider(OFFICIAL, injected, { ATLASSIAN_API_KEY: "fixture-atlassian-api-key" });
		expect(stale.code).toBe(4);
		expect(stale.stderr).toContain("atlassian-provider:error:bridge-version-invalid:");
		harness.write("bridge-version", "0.5.0\n");
		const missing = await runProvider(OFFICIAL, injected);
		expect(missing.stderr).toContain("atlassian-provider:error:credential-invalid:");
		const malformed = await runProvider(OFFICIAL, injected, { ATLASSIAN_API_KEY: "fixture-atlassian-api-key\nextra" });
		expect(malformed.stderr).toContain("atlassian-provider:error:credential-invalid:");
		harness.write("item.json", item({ credential: "x" }));
		const noUser = await runProvider(OFFICIAL, injected, { ATLASSIAN_API_KEY: "fixture-atlassian-api-key" });
		expect(noUser.stderr).toContain("atlassian-provider:error:username-missing:");
		expect(harness.has("official-provider.json")).toBe(false);
	});

	test("the injected phase binds its item to the selected tenant and product only; a raw title or foreign pair is refused", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "x" }));
		const key = { ATLASSIAN_API_KEY: "fixture-atlassian-api-key" };
		for (const [args, cause] of [
			[["--injected", "JIRA_EXAMPLE_API_TOKEN"], "arguments-invalid"],
			[["--injected", "example"], "arguments-invalid"],
			[["--injected", "example", "jira", "extra"], "arguments-invalid"],
			// Under a valid outer selection, any differing pair is a mismatch.
			[["--injected", "../etc", "jira"], "injection-mismatch"],
			[["--injected", "Example", "jira"], "injection-mismatch"],
			[["--injected", "example", "bitbucket"], "injection-mismatch"],
			[["--injected", "example", "Jira"], "injection-mismatch"],
		] as [string[], string][]) {
			const result = await runProvider(OFFICIAL, args, key);
			expect([args.join(" "), result.code]).toEqual([args.join(" "), 2]);
			expect(result.stderr).toContain(`atlassian-provider:error:${cause}:`);
		}
		// The argument pair must equal the outer validated selection; a foreign
		// pair is refused before the helper or bridge, even with a credential.
		for (const args of [
			["--injected", "example-team", "jira"],
			["--injected", "example", "confluence"],
			["--injected", "example-team", "confluence"],
		]) {
			const mismatch = await runProvider(OFFICIAL, args, key);
			expect([args.join(" "), mismatch.code]).toEqual([args.join(" "), 2]);
			expect(mismatch.stderr).toContain("atlassian-provider:error:injection-mismatch:");
		}
		const noOuter = await runProvider(OFFICIAL, ["--injected", "example", "jira"], { ...key, ATLASSIAN_TENANT: "", ATLASSIAN_PRODUCT: "" });
		expect(noOuter.code).toBe(2);
		expect(noOuter.stderr).toContain("atlassian-provider:error:tenant-invalid:");
		expect(wrapperLines()).toEqual([]);
		expect(harness.has("official-provider.json")).toBe(false);
		// The matching pair reads exactly the selected item and reaches the bridge.
		const bound = await runProvider(OFFICIAL, ["--injected", "example", "jira"], key);
		expect(bound.code).toBe(0);
		expect(wrapperLines()).toEqual(["op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --fields label=username --format json"]);
		expect(harness.receipt("official-provider.json").basicMatches).toBe(true);
	});
});

describe("Community provider process", () => {
	test("jira: injects only the Jira triplet from the JIRA item and the site_url origin", async () => {
		harness.write("item.json", FULL_ITEM);
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(wrapperLines()).toEqual(["op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
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

	test("prefers site_url over the legacy url field", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: "https://other.atlassian.net", site_url: "https://Example.atlassian.net/" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(harness.receipt("community-provider.json").jiraUrl).toBe("https://example.atlassian.net");
	});

	test("falls back to a canonical legacy url when site_url is absent", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: "https://Example.atlassian.net:443/" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(harness.receipt("community-provider.json").jiraUrl).toBe("https://example.atlassian.net");
	});

	test("refuses an invalid site_url without falling back to a valid legacy url", async () => {
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: "https://example.atlassian.net", site_url: "https://example.atlassian.net/wiki" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:site-url-invalid:");
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
		harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url: MANAGEMENT_URL }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:site-url-invalid:");
		expect(result.stderr).not.toContain(MANAGEMENT_URL);
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("fails closed on an unreadable, incomplete, duplicate, or malformed item", async () => {
		const unreadable = await runProvider(COMMUNITY);
		expect(unreadable.stderr).toContain("atlassian-provider:error:credential-unavailable:");
		harness.write("item.json", item({ credential: "fixture-community-secret", site_url: "https://example.atlassian.net" }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:community-fields-missing:");
		harness.write("item.json", JSON.stringify({ fields: [{ label: "username", value: "a" }, { label: "Username", value: "b" }, { label: "credential", value: "c" }, { label: "site_url", value: "https://example.atlassian.net" }] }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		harness.write("item.json", item({ username: "service@example.invalid\n", credential: "c", site_url: "https://example.atlassian.net" }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(harness.has("community-provider.json")).toBe(false);
	});

	test("an empty field label falls back to the field id", async () => {
		harness.write("item.json", JSON.stringify({ fields: [
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
			expect({ url, code: result.code, cause: result.stderr.includes("atlassian-provider:error:site-url-invalid:") }).toEqual({ url, code: 4, cause: true });
			expect(result.stderr).not.toContain(url);
			harness.write("item.json", item({ username: "service@example.invalid", credential: "fixture-community-secret", url }));
			const legacy = await runProvider(COMMUNITY);
			expect({ url, code: legacy.code, cause: legacy.stderr.includes("atlassian-provider:error:site-url-invalid:") }).toEqual({ url, code: 4, cause: true });
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
