import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "credential-provider-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let serial = 0;
const entry = { name: "example.login", enabled: true, vault: "Agent Browsing", vaultId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
	item: "Fixture Login", itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbb", origin: "https://login.example.test", profile: "Personal",
	agentBrowser: { enabled: true, username: "fixture-user", usernameSelector: "#username", passwordSelector: "#password", submitSelector: "#submit" } };
const item = { id: entry.itemId, title: entry.item, vault: { id: entry.vaultId, name: entry.vault }, category: "LOGIN",
	urls: [{ href: entry.origin }], fields: [{ id: "username", type: "STRING", value: "fixture-user" },
		{ id: "password", type: "CONCEALED", value: "fixture-password-not-a-real-secret" }] };
const message = { protocol: "agent-browser.plugin.v1", type: "credential.resolve", capability: "credential.read",
	request: { profileName: "example.login", itemRef: "example.login", url: "https://login.example.test" } };

async function scenario(changes = {}) {
	const home = join(root, String(serial++));
	await mkdir(join(home, ".local/state/browser-automation"), { recursive: true });
	await mkdir(join(home, "code/dotfiles/bin"), { recursive: true });
	await mkdir(join(home, ".local/bin"), { recursive: true });
	await mkdir(join(home, ".config/agent-browser"), { recursive: true });
	await writeFile(join(home, ".config/agent-browser/one-password.json"), JSON.stringify({
		namespace: "agent-credentials", restoreSave: "never", ...changes.browserConfig,
	}), { mode: changes.browserConfigMode ?? 0o600 });
	await writeFile(join(home, ".local/state/browser-automation/logins.json"), JSON.stringify(changes.config ?? { version: 1, logins: [entry] }), { mode: changes.mode ?? 0o600 });
	for (const name of ["browser-login.mjs", "agent-browser-provider.mjs", "agent-browser-fill.mjs"]) await cp(new URL(`../scripts/${name}`, import.meta.url), join(home, name));
	await cp(new URL("fixtures/browser-login-wrapper.mjs", import.meta.url), join(home, "code/dotfiles/bin/with-one-password-token"));
	await chmod(join(home, "code/dotfiles/bin/with-one-password-token"), 0o700);
	await cp(new URL("fixtures/agent-browser-runner.mjs", import.meta.url), join(home, ".local/bin/agent-browser"));
	await chmod(join(home, ".local/bin/agent-browser"), 0o700);
	await writeFile(join(home, "scenario.json"), JSON.stringify({ item: changes.item ?? item, failRead: changes.failRead,
		browser: changes.browser }));
	const result = await new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [join(home, "agent-browser-provider.mjs")], {
			env: { HOME: home, PATH: process.env.PATH, OP_SERVICE_ACCOUNT_TOKEN: "fixture-ambient-token" }, timeout: 10_000,
		}, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
		child.stdin.end(changes.raw ?? JSON.stringify(changes.message ?? message));
	});
	expect(result.stderr).toBe("");
	let args;
	try { args = JSON.parse(await readFile(join(home, "wrapper-args.json"), "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	let browserCalls = [];
	try { browserCalls = (await readFile(join(home, "browser-calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	return { response: JSON.parse(result.stdout), args, output: result.stdout, browserCalls };
}

test("private provider delivers the exact credential only through the vendor protocol", async () => {
	const run = await scenario();
	expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: true, credential: {
		username: "fixture-user", password: "fixture-password-not-a-real-secret", url: "https://login.example.test",
		usernameSelector: "#username", passwordSelector: "#password", submitSelector: "#submit" } });
	expect(run.args).toEqual(["op", "item", "get", "bbbbbbbbbbbbbbbbbbbbbbbbbb", "--vault", "Agent Browsing", "--format", "json"]);
});

for (const change of [
	{ raw: "malformed" },
	{ raw: "x".repeat(65_537) },
	{ message: { ...message, protocol: "unknown" } },
	{ message: { ...message, capability: "command.run" } },
	{ message: { ...message, request: { ...message.request, itemRef: "other" } } },
	{ message: { ...message, request: { ...message.request, url: "https://login.example.test.attacker.test" } } },
	{ mode: 0o644 },
	{ config: { version: 1, logins: [entry, entry] } },
	{ config: { version: 1, logins: [{ ...entry, enabled: false }] } },
	{ config: { version: 1, logins: [{ ...entry, vault: "API Credentials" }] } },
	{ config: { version: 1, logins: [{ ...entry, agentBrowser: { ...entry.agentBrowser, enabled: false } }] } },
]) {
	test(`refuses before custody: ${JSON.stringify(change).slice(0, 110)}`, async () => {
		const run = await scenario(change);
		expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: false, error: "approved-credential-unavailable" });
		expect(run.args).toBeUndefined();
	});
}

for (const change of [
	{ failRead: true },
	{ item: { ...item, title: "wrong" } },
	{ item: { ...item, vault: { ...item.vault, id: "cccccccccccccccccccccccccc" } } },
	{ item: { ...item, urls: [{ href: "https://wrong.example.test" }] } },
	{ item: { ...item, fields: [item.fields[0], item.fields[1], item.fields[1]] } },
	{ item: { ...item, fields: [{ ...item.fields[0], value: "other-account" }, item.fields[1]] } },
	{ item: { ...item, fields: [item.fields[0], { ...item.fields[1], type: "STRING" }] } },
]) {
	test(`sanitizes custody refusal: ${JSON.stringify(change).slice(0, 90)}`, async () => {
		const run = await scenario(change);
		expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: false, error: "approved-credential-unavailable" });
		expect(run.output).not.toContain("fixture-");
	});
}

test("manifest discovery reads no credential", async () => {
	const run = await scenario({ message: { protocol: "agent-browser.plugin.v1", type: "plugin.manifest" } });
	expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: true, manifest: { name: "one-password", capabilities: ["credential.read", "credential.fill"] } });
	expect(run.args).toBeUndefined();
});

const fillMessage = { protocol: "agent-browser.plugin.v1", type: "credential.fill", capability: "credential.fill",
	request: { login: "example.login", field: "password", session: "fixture-task" } };

for (const field of ["username", "password"]) {
	test(`staged ${field} reaches only native batch stdin, with redacted public streams`, async () => {
		const run = await scenario({ message: { ...fillMessage, request: { ...fillMessage.request, field } } });
		expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: true,
			data: { status: "filled", effect: "filled", fields: [field] } });
		expect(run.args).toEqual(["op", "item", "get", "bbbbbbbbbbbbbbbbbbbbbbbbbb", "--vault", "Agent Browsing", "--format", "json"]);
		expect(run.browserCalls).toHaveLength(4);
		const batch = run.browserCalls[3];
		expect(batch.args.slice(-3)).toEqual(["batch", "--bail", "--omit-command"]);
		expect(JSON.parse(batch.stdin)[1]).toEqual(["fill", `#${field}`, field === "username" ? "fixture-user" : "fixture-password-not-a-real-secret"]);
		for (const call of run.browserCalls) {
			expect(JSON.stringify(call.args)).not.toContain("fixture-user");
			expect(JSON.stringify(call.args)).not.toContain("fixture-password-not-a-real-secret");
			expect(call.hasOpToken).toBe(false);
		}
		expect(run.output).not.toContain("fixture-password-not-a-real-secret");
		expect(run.output).not.toContain("fixture-user");
		expect(run.output).not.toContain("fixture-ambient-token");
	});
}

for (const change of [
	{ browser: { url: "https://wrong.example.test" } },
	{ browser: { url: "https://user:credential@login.example.test" } },
	{ browser: { streaming: true } },
	{ browser: { invalidInput: true } },
	{ browserConfig: { restoreSave: "always" } },
	{ browserConfigMode: 0o644 },
	{ message: { ...fillMessage, request: { ...fillMessage.request, session: "--headed" } } },
	{ message: { ...fillMessage, request: { ...fillMessage.request, selector: "#other" } } },
	{ message: { ...fillMessage, request: { ...fillMessage.request, field: "token" } } },
]) {
	test(`staged preflight refuses before custody: ${JSON.stringify(change)}`, async () => {
		const run = await scenario({ message: fillMessage, ...change });
		expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: true,
			data: { status: "blocked", effect: "none", cause: "staged-fill-preflight-refused" } });
		expect(run.args).toBeUndefined();
	});
}

test("staged failed native fill keeps secret-bearing child errors private and does not retry", async () => {
	const run = await scenario({ message: fillMessage, browser: { failBatch: true } });
	expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: true,
		data: { status: "blocked", effect: "partial-or-unknown", cause: "staged-fill-effect-unconfirmed" } });
	expect(run.browserCalls.filter(call => call.args.includes("batch"))).toHaveLength(1);
	expect(run.output).not.toContain("fixture-password-not-a-real-secret");
});

test("staged username needs only its observed selector; complete-form auth still requires every selector", async () => {
	const config = { version: 1, logins: [{ ...entry, agentBrowser: {
		enabled: true, username: "fixture-user", usernameSelector: "#username",
	} }] };
	const run = await scenario({ config, message: { ...fillMessage, request: { ...fillMessage.request, field: "username" } } });
	expect(run.response.data).toEqual({ status: "filled", effect: "filled", fields: ["username"] });
	const complete = await scenario({ config });
	expect(complete.response).toEqual({ protocol: "agent-browser.plugin.v1", success: false, error: "approved-credential-unavailable" });
	expect(complete.args).toBeUndefined();
});
