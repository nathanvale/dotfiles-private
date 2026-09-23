// Proof of the Atlassian credential custody module at its interface: the
// dispatcher's bindCredential crosses the custody child to the fake 1Password
// helper under a temp HOME, and the child itself is proved as a public process.
// Provider-side custody (providerInvocation, boundItem, invocationEnvironment)
// is proved through the Provider process in providers.test.ts, because those
// functions refuse by exiting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHarness, type Harness, itemJson, OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { bindCredential, bindingChannel } from "../scripts/custody/index.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const CHILD = path.join(SKILL, "scripts", "custody", "child.ts");
const PRINCIPAL = "service@example.invalid";
const ORIGIN = "https://example.atlassian.net";
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
// Independent oracles: the fixed refusal details the dispatcher renders.
const SITE_DETAIL = "the tenant's credential item must expose a valid site_url field";
const UNSTABLE_DETAIL = "credential custody could not produce a stable context";

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());
const env = () => ({ HOME: harness.home, PATH: process.env.PATH ?? "", TMPDIR: harness.root, XDG_STATE_HOME: harness.root });
const wrapperLog = () => (harness.has("wrapper.log") ? readFileSync(path.join(harness.root, "wrapper.log"), "utf8") : "");

describe("bindCredential", () => {
	test("performs one complete read through the custody child and returns only the typed nonsecret binding", () => {
		harness.write("item.json", itemJson({ username: PRINCIPAL, credential: "fixture-custody-secret", site_url: "https://Example.atlassian.net/" }, 42));
		expect(bindCredential("example", "confluence", env())).toEqual({ ok: true, binding: { principal: PRINCIPAL, itemVersion: "onepassword-item-version:42", origin: ORIGIN } });
		expect(wrapperLog().trim()).toBe("op item get CONFLUENCE_EXAMPLE_API_TOKEN --vault API Credentials --format json");
	});

	test("maps a dashed tenant slug to its item title", () => {
		harness.write("item.json", itemJson({ username: PRINCIPAL, credential: "x", site_url: ORIGIN }, 1));
		expect(bindCredential("example-team", "jira", env()).ok).toBe(true);
		expect(wrapperLog().trim()).toBe("op item get JIRA_EXAMPLE_TEAM_API_TOKEN --vault API Credentials --format json");
	});

	test("an invalid or absent site_url is site-unresolved; the token-management url is never the origin", () => {
		for (const item of [
			itemJson({ username: PRINCIPAL, url: MANAGEMENT_URL }, 1),
			itemJson({ username: PRINCIPAL, url: ORIGIN }, 1),
			...[MANAGEMENT_URL, "https://example.example.com", "https://user@example.atlassian.net", "https://example.atlassian.net/wiki", "https://example.atlassian.net?x=1", "https://example.atlassian.net#frag", "https://example.atlassian.net:8443", "http://example.atlassian.net"].map((url) => itemJson({ username: PRINCIPAL, site_url: url, url: ORIGIN }, 1)),
		]) {
			harness.write("item.json", item);
			expect(bindCredential("example", "jira", env())).toEqual({ ok: false, cause: "site-unresolved", detail: SITE_DETAIL });
		}
	});

	test("a missing version, a missing or malformed username, a missing item, or invalid JSON is a precondition refusal", () => {
		const cases: [string, string | undefined][] = [
			["no version", itemJson({ username: PRINCIPAL, site_url: ORIGIN, credential: "x" })],
			["zero version", itemJson({ username: PRINCIPAL, site_url: ORIGIN }, 0)],
			["no username", itemJson({ site_url: ORIGIN, credential: "x" }, 1)],
			["colon username", itemJson({ username: "a:b", site_url: ORIGIN }, 1)],
			["duplicate labels", JSON.stringify({ version: 1, fields: [{ label: "username", value: "a" }, { label: "Username", value: "b" }, { label: "site_url", value: ORIGIN }] })],
			["not json", "{"],
			["no item", undefined],
		];
		for (const [label, item] of cases) {
			if (item !== undefined) harness.write("item.json", item);
			expect([label, bindCredential("example", "jira", env())]).toEqual([label, { ok: false, cause: "refused-precondition", detail: UNSTABLE_DETAIL }]);
		}
	});

	test("a missing credential helper is a precondition refusal that names no path", () => {
		const result = bindCredential("example", "jira", { ...env(), HOME: path.join(harness.root, "missing-wrapper-home") });
		expect(result).toEqual({ ok: false, cause: "refused-precondition", detail: UNSTABLE_DETAIL });
		expect(JSON.stringify(result)).not.toContain(harness.root);
	});

	test("the binding channel is the exact three-key JSON line the Providers parse", () => {
		expect(bindingChannel({ principal: PRINCIPAL, itemVersion: "onepassword-item-version:42", origin: ORIGIN })).toBe('{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:42","origin":"https://example.atlassian.net"}');
	});
});

describe("custody child process", () => {
	test("reads a full item but emits only the nonsecret binding line", async () => {
		const secret = "fixture-custody-secret";
		harness.write("item.json", itemJson({ username: PRINCIPAL, credential: secret, site_url: ORIGIN }, 42));
		const result = await harness.run(["--tenant", "example", "--product", "jira"], {}, CHILD);
		expect([result.code, result.stdout, result.stderr]).toEqual([0, '{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:42","origin":"https://example.atlassian.net"}\n', ""]);
		expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr, log: wrapperLog() })).not.toContain(secret);
		expect(wrapperLog().trim()).toBe("op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json");
	});

	test("reports a fixed wrapper repair cause without secret output", async () => {
		const result = await harness.run(["--tenant", "example", "--product", "jira"], { HOME: path.join(harness.root, "missing-wrapper-home") }, CHILD);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "atlassian-credential-binding:error:credential-wrapper-missing:restore the dotfiles 1Password wrapper\n"]);
		expect(`${result.stdout}${result.stderr}`).not.toContain(OP_TOKEN_SENTINEL);
	});

	test("refuses malformed arguments before any helper access", async () => {
		harness.write("item.json", itemJson({ username: PRINCIPAL, site_url: ORIGIN }, 1));
		for (const argv of [[], ["--tenant", "example"], ["--tenant", "Example", "--product", "jira"], ["--tenant", "example", "--product", "bitbucket"], ["--tenant", "example", "--tenant", "example"], ["--product", "jira", "--tenant", "example", "extra"]]) {
			const result = await harness.run(argv, {}, CHILD);
			expect([argv.join(" "), result.code, result.stdout, result.stderr]).toEqual([argv.join(" "), 3, "", "atlassian-credential-binding:error:arguments-invalid\n"]);
		}
		expect(wrapperLog()).toBe("");
	});

	test("names the closed item causes on stderr", async () => {
		for (const [item, cause] of [
			[itemJson({ username: PRINCIPAL, site_url: ORIGIN }), "credential-revision-unavailable"],
			[itemJson({ username: PRINCIPAL }, 1), "site-url-invalid"],
			[itemJson({ site_url: ORIGIN }, 1), "credential-invalid"],
			["not json", "credential-invalid"],
		] as const) {
			harness.write("item.json", item);
			const result = await harness.run(["--tenant", "example", "--product", "jira"], {}, CHILD);
			expect([cause, result.code, result.stdout, result.stderr]).toEqual([cause, 3, "", `atlassian-credential-binding:error:${cause}\n`]);
		}
	});
});
