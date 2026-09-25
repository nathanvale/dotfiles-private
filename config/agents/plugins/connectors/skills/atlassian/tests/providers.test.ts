// Public-process proof of the Bun Atlassian Community Provider, invoked the
// way MCPorter invokes it: no arguments, cwd at the skill config directory,
// tenant slug and product in the environment. Custody is the 1Password mode:
// the test Keychain reader in the substituted plugin copy (see plugin-copy.ts)
// answers the service-token read, and the plugin-owned op and uv are fakes at
// the paths setup publishes. The Provider runs from the copy:
// substituted-reader process proof. Two static routes: one per product.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CustodyFixture, PROVIDER_TOKEN, SERVICE_TOKEN } from "./fixtures/custody-fixture.ts";
import { substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

const SKILL = path.join(substitutedPluginRoot(), "skills", "atlassian");
const COMMUNITY = path.join(SKILL, "scripts", "atlassian-community-provider.ts");
const AMBIENT_SENTINEL = "must-not-cross-provider";
const AMBIENT_OP_TOKEN = "ops_ambient-token-must-not-cross";
const SECRETS = [PROVIDER_TOKEN, SERVICE_TOKEN, AMBIENT_OP_TOKEN];
const itemJson = (entries: Record<string, string>, version?: number | string) => JSON.stringify({ ...(version === undefined ? {} : { version }), fields: Object.entries(entries).map(([label, value]) => ({ id: label, label, value })) });
const item = (entries: Record<string, string>, version: number | string = 1) => itemJson({ site_url: "https://example.atlassian.net", ...entries }, version);
const rawItem = itemJson;
// The built-in url is token management, never the tenant origin.
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const FULL_ITEM = item({ username: "service@example.invalid", credential: PROVIDER_TOKEN, url: MANAGEMENT_URL, site_url: "https://Example.atlassian.net/" });
const JIRA_ENV_KEYS = ["HOME", "JIRA_API_TOKEN", "JIRA_URL", "JIRA_USERNAME", "PATH", "TMPDIR", "XDG_STATE_HOME"];
const CONFLUENCE_ENV_KEYS = ["CONFLUENCE_API_TOKEN", "CONFLUENCE_URL", "CONFLUENCE_USERNAME", "HOME", "PATH", "TMPDIR", "XDG_STATE_HOME"];

interface CommunityStart {
	argv: string[];
	cwd: string;
	envKeys: string[];
	jiraUrl: string | null;
	confluenceUrl: string | null;
	username: string | null;
	providerTokenMatches: boolean;
	serviceTokenInEnvironment: boolean;
}

let fixture: CustodyFixture;
beforeEach(() => {
	fixture = new CustodyFixture().installAll();
});
afterEach(() => fixture.dispose());
const write = (text: string) => writeFileSync(path.join(fixture.root, "item.json"), text);
const started = () => fixture.lines("community-starts.jsonl").length > 0;
const lastStart = () => fixture.lines<CommunityStart>("community-starts.jsonl").at(-1) as CommunityStart;
const opLines = () => fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => ["op", ...call.argv].join(" "));

async function runProvider(script: string, args: string[] = [], env: Record<string, string> = {}) {
	const proc = Bun.spawn([script, ...args], {
		cwd: path.join(SKILL, "config"),
		env: {
			HOME: fixture.home,
			PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
			TMPDIR: fixture.root,
			XDG_STATE_HOME: fixture.state,
			ATLASSIAN_TENANT: "example",
			ATLASSIAN_PRODUCT: "jira",
			CONNECTORS_INTERNAL_INVOCATION_CONTEXT: '{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:1","origin":"https://example.atlassian.net"}',
			AMBIENT_SENTINEL,
			OP_SERVICE_ACCOUNT_TOKEN: AMBIENT_OP_TOKEN,
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

describe("Community provider process", () => {
	test("preflight proves local readiness without starting the pinned package", async () => {
		write(FULL_ITEM);
		const result = await runProvider(COMMUNITY, ["--preflight"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
		expect(opLines()).toEqual(["op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
		expect(started()).toBe(false);
		const outbox = path.join(fixture.state, "connectors", "atlassian", "example", "outbox");
		expect((statSync(outbox).mode & 0o777).toString(8)).toBe("700");
	});

	test("preflight refuses a symlinked Upload Outbox before starting the package", async () => {
		write(FULL_ITEM);
		const outbox = path.join(fixture.state, "connectors", "atlassian", "example", "outbox");
		mkdirSync(path.dirname(outbox), { recursive: true });
		const outside = path.join(fixture.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, outbox);
		const result = await runProvider(COMMUNITY, ["--preflight"]);
		expect([result.code, result.stdout, result.stderr.includes("atlassian-provider:error:outbox-unavailable:")]).toEqual([4, "", true]);
		expect(started()).toBe(false);
	});

	test("a rotated item version or trusted origin refuses before the Provider executable starts", async () => {
		const secret = PROVIDER_TOKEN;
		for (const [label, changed] of [
			["version", item({ username: "service@example.invalid", credential: secret }, 2)],
			["origin", item({ username: "service@example.invalid", credential: secret, site_url: "https://other.atlassian.net" }, 1)],
		] as const) {
			write(changed);
			const result = await runProvider(COMMUNITY);
			expect([label, result.code, result.stderr.includes("atlassian-provider:error:credential-context-stale:")]).toEqual([label, 4, true]);
			expect(started()).toBe(false);
			for (const stream of [result.stdout, result.stderr, JSON.stringify(fixture.lines("op-calls.jsonl"))]) expect(stream).not.toContain(secret);
		}
	});

	test("a missing credential field is a fields-missing precondition; a malformed one is credential-invalid; neither starts the package", async () => {
		write(item({ username: "service@example.invalid" }));
		const missing = await runProvider(COMMUNITY, ["--preflight"]);
		expect([missing.code, missing.stdout, missing.stderr.includes("atlassian-provider:error:community-fields-missing:")]).toEqual([4, "", true]);
		write(item({ username: "service@example.invalid", credential: "private-value\nsecond-line" }));
		const malformed = await runProvider(COMMUNITY);
		expect([malformed.code, malformed.stderr.includes("atlassian-provider:error:credential-invalid:")]).toEqual([4, true]);
		expect(malformed.stderr).not.toContain("private-value");
		expect(started()).toBe(false);
	});

	test("the retired injected phase is refused as an argument, never re-entered", async () => {
		write(FULL_ITEM);
		const result = await runProvider(COMMUNITY, ["--injected", "example", "jira"], { ATLASSIAN_API_KEY: "fixture-atlassian-api-key" });
		expect([result.code, result.stderr.includes("atlassian-provider:error:arguments-invalid:")]).toEqual([2, true]);
		expect(opLines()).toEqual([]);
		expect(started()).toBe(false);
	});

	test("jira: injects only the Jira triplet from the JIRA item and the site_url origin", async () => {
		write(FULL_ITEM);
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(opLines()).toEqual(["op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
		const community = lastStart();
		// The plugin-owned uv runs the pinned package; only the Jira triplet crosses,
		// and neither the ambient nor the custody service token does.
		expect(community.argv).toEqual(["tool", "run", "--system-certs", "--no-env-file", "--from", "mcp-atlassian==0.23.1", "mcp-atlassian"]);
		expect(community.envKeys).toEqual(JIRA_ENV_KEYS);
		// The package starts in the tenant's private outbox, the only place it may read uploads from.
		const outbox = path.join(fixture.state, "connectors", "atlassian", "example", "outbox");
		expect(realpathSync(community.cwd as string)).toBe(realpathSync(outbox));
		expect((statSync(outbox).mode & 0o777).toString(8)).toBe("700");
		expect(community.jiraUrl).toBe("https://example.atlassian.net");
		expect(community.username).toBe("service@example.invalid");
		expect([community.providerTokenMatches, community.serviceTokenInEnvironment]).toEqual([true, false]);
	});

	test("prefers site_url over the legacy url field", async () => {
		write(item({ username: "service@example.invalid", credential: PROVIDER_TOKEN, url: "https://other.atlassian.net", site_url: "https://Example.atlassian.net/" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(0);
		expect(lastStart().jiraUrl).toBe("https://example.atlassian.net");
	});

	test("refuses a legacy url when site_url is absent", async () => {
		write(rawItem({ username: "service@example.invalid", credential: PROVIDER_TOKEN, url: "https://Example.atlassian.net:443/" }, 1));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(started()).toBe(false);
	});

	test("refuses an invalid site_url without falling back to a valid legacy url", async () => {
		write(item({ username: "service@example.invalid", credential: PROVIDER_TOKEN, url: "https://example.atlassian.net", site_url: "https://example.atlassian.net/wiki" }));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(result.stderr).not.toContain("https://example.atlassian.net/wiki");
		expect(started()).toBe(false);
	});

	test("confluence: injects only the Confluence triplet from the CONFLUENCE item with the wiki origin", async () => {
		write(FULL_ITEM);
		const result = await runProvider(COMMUNITY, [], { ATLASSIAN_PRODUCT: "confluence" });
		expect(result.code).toBe(0);
		expect(opLines()).toEqual(["op item get CONFLUENCE_EXAMPLE_API_TOKEN --vault API Credentials --format json"]);
		const community = lastStart();
		expect(community.envKeys).toEqual(CONFLUENCE_ENV_KEYS);
		expect(community.confluenceUrl).toBe("https://example.atlassian.net/wiki");
	});

	test("never uses the built-in token-management url as the site origin", async () => {
		write(rawItem({ username: "service@example.invalid", credential: PROVIDER_TOKEN, url: MANAGEMENT_URL }, 1));
		const result = await runProvider(COMMUNITY);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(result.stderr).not.toContain(MANAGEMENT_URL);
		expect(started()).toBe(false);
	});

	test("fails closed on an unreadable, incomplete, duplicate, or malformed item", async () => {
		const absent = await runProvider(COMMUNITY);
		expect(absent.stderr).toContain("atlassian-provider:error:item-missing:");
		write(item({ credential: PROVIDER_TOKEN, site_url: "https://example.atlassian.net" }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		write(JSON.stringify({ fields: [{ label: "username", value: "a" }, { label: "Username", value: "b" }, { label: "credential", value: "c" }, { label: "site_url", value: "https://example.atlassian.net" }] }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		write(item({ username: "service@example.invalid\n", credential: "c", site_url: "https://example.atlassian.net" }));
		expect((await runProvider(COMMUNITY)).stderr).toContain("atlassian-provider:error:credential-invalid:");
		expect(started()).toBe(false);
	});

	test("an empty field label falls back to the field id", async () => {
		write(JSON.stringify({ version: 1, fields: [
			{ id: "username", label: "", value: "service@example.invalid" },
			{ id: "credential", label: "", value: PROVIDER_TOKEN },
			{ id: "site_url", label: "", value: "https://example.atlassian.net" },
		] }));
		expect((await runProvider(COMMUNITY)).code).toBe(0);
		expect(lastStart().username).toBe("service@example.invalid");
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
			write(item({ username: "service@example.invalid", credential: PROVIDER_TOKEN, site_url: url }));
			const result = await runProvider(COMMUNITY);
			expect({ url, code: result.code, cause: result.stderr.includes("atlassian-provider:error:credential-invalid:") }).toEqual({ url, code: 4, cause: true });
			expect(result.stderr).not.toContain(url);
				write(rawItem({ username: "service@example.invalid", credential: PROVIDER_TOKEN, url }, 1));
			const legacy = await runProvider(COMMUNITY);
			expect({ url, code: legacy.code, cause: legacy.stderr.includes("atlassian-provider:error:credential-invalid:") }).toEqual({ url, code: 4, cause: true });
			expect(legacy.stderr).not.toContain(url);
		}
		expect(started()).toBe(false);
	});

	test("refuses arguments, a bad product, and a non-semantic slug before reading the item", async () => {
		write(FULL_ITEM);
		expect((await runProvider(COMMUNITY, ["--x"])).stderr).toContain("atlassian-provider:error:arguments-invalid:");
		expect((await runProvider(COMMUNITY, [], { ATLASSIAN_PRODUCT: "both" })).stderr).toContain("atlassian-provider:error:product-invalid:");
		expect((await runProvider(COMMUNITY, [], { ATLASSIAN_TENANT: "Example" })).stderr).toContain("atlassian-provider:error:tenant-invalid:");
		expect(opLines()).toEqual([]);
	});
});

describe("Community provider plugin-owned dependencies", () => {
	test("a missing plugin-owned uv refuses before the package starts; PATH never supplies one", async () => {
		write(FULL_ITEM);
		rmSync(fixture.uvExecutable);
		const result = await runProvider(COMMUNITY, [], { PATH: `${fixture.hostileBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
		expect([result.code, result.stdout, result.stderr]).toEqual([4, "", "atlassian-provider:error:uv-unavailable:the plugin-owned uv is not set up; run connectors setup\n"]);
		expect(started()).toBe(false);
	});

	test("an absent Keychain service token refuses without starting op or the package", async () => {
		write(FULL_ITEM);
		fixture.removeKeychainToken();
		const result = await runProvider(COMMUNITY);
		expect([result.code, result.stderr.startsWith("atlassian-provider:error:service-token-missing:")]).toEqual([4, true]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
		expect(started()).toBe(false);
	});
});
