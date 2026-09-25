// Proof of the Atlassian credential custody module at its interface: the
// dispatcher's bindCredential crosses the custody child, which reads the
// service token through the test Keychain reader in the substituted plugin
// copy (see plugin-copy.ts) and the item through the plugin-owned op fake;
// the child itself is proved as a public process: the copy's compiled front
// door in its internal custody role. Both run from the copy:
// substituted-reader process proof. The real Keychain read is the gated
// attended suite's proof.
// Provider-side custody (providerInvocation, boundItem, invocationEnvironment)
// is proved through the Provider process in providers.test.ts, because those
// functions refuse by exiting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CustodyFixture, PROVIDER_TOKEN, SERVICE_TOKEN } from "./fixtures/custody-fixture.ts";
import { substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

// The copy's custody module, so bindCredential starts the copy's child.
const SKILL = path.join(substitutedPluginRoot(), "skills", "atlassian");
const { bindCredential, bindingChannel } = (await import(path.join(SKILL, "scripts", "custody", "index.ts"))) as typeof import("../scripts/custody/index.ts");
const CHILD = [path.join(SKILL, "..", "..", "bin", "connectors"), "__internal", "atlassian", "custody-child"];
const JIRA_CONTEXT = '{"tenant":"example","product":"jira"}';
const PRINCIPAL = "service@example.invalid";
const ORIGIN = "https://example.atlassian.net";
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
// Independent oracles: the fixed refusal details the dispatcher renders.
const SITE_DETAIL = "the tenant's credential item must expose a valid site_url field";
const UNSTABLE_DETAIL = "credential custody could not produce a stable context";
const OP_DETAIL = "the plugin-owned 1Password CLI is not set up; run connectors setup";
const opRead = (title: string) => ["item", "get", title, "--vault", "API Credentials", "--format", "json"];
const itemJson = (entries: Record<string, string>, version?: number) => JSON.stringify({ ...(version === undefined ? {} : { version }), fields: Object.entries(entries).map(([label, value]) => ({ id: label, label, value })) });

let fixture: CustodyFixture;
beforeEach(() => {
	fixture = new CustodyFixture().installAll();
});
afterEach(() => fixture.dispose());
const env = () => ({ HOME: fixture.home, PATH: process.env.PATH ?? "", TMPDIR: fixture.root, XDG_STATE_HOME: fixture.state });
const writeItem = (text: string) => writeFileSync(path.join(fixture.root, "item.json"), text);
const opReads = () => fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv);
async function child(context: string, extra: Record<string, string> = {}, argv: string[] = []) {
	const proc = Bun.spawn([...CHILD, ...argv], { env: { ...env(), CONNECTORS_INTERNAL_INVOCATION_CONTEXT: context, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

describe("bindCredential", () => {
	test("performs one complete read through the custody child and returns only the typed nonsecret binding", () => {
		writeItem(itemJson({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: "https://Example.atlassian.net/" }, 42));
		const result = bindCredential("example", "confluence", env());
		expect(result).toEqual({ ok: true, binding: { principal: PRINCIPAL, itemVersion: "onepassword-item-version:42", origin: ORIGIN } });
		expect(JSON.stringify(result)).not.toContain(PROVIDER_TOKEN);
		expect(fixture.lines("op-calls.jsonl")).toEqual([{ argv: opRead("CONFLUENCE_EXAMPLE_API_TOKEN"), envKeys: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], serviceTokenMatches: true }]);
	});

	test("maps a dashed tenant slug to its item title", () => {
		writeItem(itemJson({ username: PRINCIPAL, credential: "x", site_url: ORIGIN }, 1));
		expect(bindCredential("example-team", "jira", env()).ok).toBe(true);
		expect(opReads()).toEqual([opRead("JIRA_EXAMPLE_TEAM_API_TOKEN")]);
	});

	test("an invalid or absent site_url is site-unresolved; the token-management url is never the origin", () => {
		for (const item of [
			itemJson({ username: PRINCIPAL, url: MANAGEMENT_URL }, 1),
			itemJson({ username: PRINCIPAL, url: ORIGIN }, 1),
			...[MANAGEMENT_URL, "https://example.example.com", "https://user@example.atlassian.net", "https://example.atlassian.net/wiki", "https://example.atlassian.net?x=1", "https://example.atlassian.net#frag", "https://example.atlassian.net:8443", "http://example.atlassian.net"].map((url) => itemJson({ username: PRINCIPAL, site_url: url, url: ORIGIN }, 1)),
		]) {
			writeItem(item);
			expect(bindCredential("example", "jira", env())).toEqual({ ok: false, cause: "site-unresolved", detail: SITE_DETAIL });
		}
	});

	test("a missing version, a missing or malformed username, or invalid JSON is a precondition refusal", () => {
		const cases: [string, string][] = [
			["no version", itemJson({ username: PRINCIPAL, site_url: ORIGIN, credential: "x" })],
			["zero version", itemJson({ username: PRINCIPAL, site_url: ORIGIN }, 0)],
			["no username", itemJson({ site_url: ORIGIN, credential: "x" }, 1)],
			["colon username", itemJson({ username: "a:b", site_url: ORIGIN }, 1)],
			["duplicate labels", JSON.stringify({ version: 1, fields: [{ label: "username", value: "a" }, { label: "Username", value: "b" }, { label: "site_url", value: ORIGIN }] })],
			["not json", "{"],
		];
		for (const [label, item] of cases) {
			writeItem(item);
			expect([label, bindCredential("example", "jira", env())]).toEqual([label, { ok: false, cause: "refused-precondition", detail: UNSTABLE_DETAIL }]);
		}
	});

	test("an absent item is a handoff to its owner that names the item and never its value", () => {
		const result = bindCredential("example", "jira", env());
		expect(result).toEqual({
			ok: false,
			cause: "refused-credential-unconfigured",
			detail: "create the Atlassian API token in your Atlassian account settings and store it yourself in the 1Password item JIRA_EXAMPLE_API_TOKEN in the API Credentials vault; Connectors never creates, rotates, or imports a token",
		});
		expect(opReads()).toEqual([opRead("JIRA_EXAMPLE_API_TOKEN")]);
	});

	test("a missing plugin-owned op is the setup repair and names no path", () => {
		rmSync(path.join(fixture.opDirectory, "op-selected"));
		const result = bindCredential("example", "jira", env());
		expect(result).toEqual({ ok: false, cause: "refused-precondition", detail: OP_DETAIL });
		expect(JSON.stringify(result)).not.toContain(fixture.root);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
	});

	test("the binding channel is the exact three-key JSON line the Providers parse", () => {
		expect(bindingChannel({ principal: PRINCIPAL, itemVersion: "onepassword-item-version:42", origin: ORIGIN })).toBe('{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:42","origin":"https://example.atlassian.net"}');
	});
});

describe("custody child process", () => {
	test("reads a full item but emits only the nonsecret binding line", async () => {
		writeItem(itemJson({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN }, 42));
		const result = await child(JIRA_CONTEXT);
		expect([result.code, result.stdout, result.stderr]).toEqual([0, '{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:42","origin":"https://example.atlassian.net"}\n', ""]);
		for (const secret of [PROVIDER_TOKEN, SERVICE_TOKEN]) expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
		expect(opReads()).toEqual([opRead("JIRA_EXAMPLE_API_TOKEN")]);
	});

	// A fault inside the role (here the reader leaf cannot write under an
	// absent HOME parent) is not a closed custody cause: the front door names
	// one fixed nonsecret line and never the thrown text, and the dispatcher
	// then refuses with the unstable-context detail.
	test("a role that throws names the fixed internal-role cause and no path", async () => {
		writeItem(itemJson({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN }, 1));
		const absentHome = path.join(fixture.root, "absent", "home");
		const result = await child(JIRA_CONTEXT, { HOME: absentHome });
		expect([result.code, result.stdout, result.stderr]).toEqual([1, "", "connectors-internal-role:error:unhandled\n"]);
		expect(bindCredential("example", "jira", { ...env(), HOME: absentHome })).toEqual({ ok: false, cause: "refused-precondition", detail: UNSTABLE_DETAIL });
		expect(opReads()).toEqual([]);
	});

	test("reports each closed custody cause on stderr without a value or path", async () => {
		const missingOp = new CustodyFixture();
		try {
			missingOp.installKeychainToken();
			const noOp = await child(JIRA_CONTEXT, { HOME: missingOp.home, XDG_STATE_HOME: missingOp.state });
			expect([noOp.code, noOp.stdout, noOp.stderr]).toEqual([3, "", "atlassian-credential-binding:error:op-unavailable\n"]);
		} finally {
			missingOp.dispose();
		}
		fixture.removeKeychainToken();
		const noToken = await child(JIRA_CONTEXT);
		expect([noToken.code, noToken.stdout, noToken.stderr]).toEqual([3, "", "atlassian-credential-binding:error:service-token-missing\n"]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
	});

	test("refuses a malformed invocation context or any argument before any custody access", async () => {
		writeItem(itemJson({ username: PRINCIPAL, site_url: ORIGIN }, 1));
		for (const [context, argv] of [
			['{"tenant":"example"}', []],
			['{"tenant":"Example","product":"jira"}', []],
			['{"tenant":"example","product":"bitbucket"}', []],
			['{"product":"jira","tenant":"example"}', []],
			['{"tenant":"example","product":"jira","extra":1}', []],
			["not json", []],
			[JIRA_CONTEXT, ["--tenant", "example"]],
		] as const) {
			const result = await child(context, {}, [...argv]);
			expect([context, argv.join(" "), result.code, result.stdout, result.stderr]).toEqual([context, argv.join(" "), 3, "", "atlassian-credential-binding:error:arguments-invalid\n"]);
		}
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
	});

	test("names the closed item causes on stderr", async () => {
		for (const [item, cause] of [
			[itemJson({ username: PRINCIPAL, site_url: ORIGIN }), "credential-revision-unavailable"],
			[itemJson({ username: PRINCIPAL }, 1), "site-url-invalid"],
			[itemJson({ site_url: ORIGIN }, 1), "credential-invalid"],
			["not json", "credential-invalid"],
		] as const) {
			writeItem(item);
			const result = await child(JIRA_CONTEXT);
			expect([cause, result.code, result.stdout, result.stderr]).toEqual([cause, 3, "", `atlassian-credential-binding:error:${cause}\n`]);
		}
	});
});
