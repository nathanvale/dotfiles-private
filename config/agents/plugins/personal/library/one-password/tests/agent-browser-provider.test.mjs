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
	await writeFile(join(home, ".local/state/browser-automation/logins.json"), JSON.stringify(changes.config ?? { version: 1, logins: [entry] }), { mode: changes.mode ?? 0o600 });
	for (const name of ["browser-login.mjs", "agent-browser-provider.mjs"]) await cp(new URL(`../scripts/${name}`, import.meta.url), join(home, name));
	await cp(new URL("fixtures/browser-login-wrapper.mjs", import.meta.url), join(home, "code/dotfiles/bin/with-one-password-token"));
	await chmod(join(home, "code/dotfiles/bin/with-one-password-token"), 0o700);
	await writeFile(join(home, "scenario.json"), JSON.stringify({ item: changes.item ?? item, failRead: changes.failRead }));
	const result = await new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [join(home, "agent-browser-provider.mjs")], {
			env: { HOME: home, PATH: process.env.PATH }, timeout: 10_000,
		}, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
		child.stdin.end(changes.raw ?? JSON.stringify(changes.message ?? message));
	});
	expect(result.stderr).toBe("");
	let args;
	try { args = JSON.parse(await readFile(join(home, "wrapper-args.json"), "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	return { response: JSON.parse(result.stdout), args, output: result.stdout };
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
	expect(run.response).toEqual({ protocol: "agent-browser.plugin.v1", success: true, manifest: { name: "one-password", capabilities: ["credential.read"] } });
	expect(run.args).toBeUndefined();
});
