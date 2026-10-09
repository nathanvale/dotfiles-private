import { afterAll, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runFile = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "browser-login-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let serial = 0;
const entry = { name: "example.login", enabled: true, vault: "Fixture Vault",
	item: "Fixture Login", itemId: "gddtezlrknpqokylqxnikd4srm",
	origin: "https://login.example.test", profile: "Personal" };
const item = { id: entry.itemId, title: entry.item, vault: { name: entry.vault }, category: "LOGIN",
	urls: [{ href: entry.origin }], fields: [{ id: "username", value: "fixture-user" },
		{ id: "password", value: "fixture-password-not-a-real-secret" }] };

async function scenario(changes = {}) {
	const home = join(root, String(serial++));
	const state = join(home, ".local/state/browser-automation");
	const bin = join(home, "code/dotfiles/bin");
	await mkdir(state, { recursive: true });
	await mkdir(bin, { recursive: true });
	await writeFile(join(state, "logins.json"), JSON.stringify(changes.config ?? { version: 1, logins: [entry] }), { mode: changes.mode ?? 0o600 });
	await cp(new URL("../scripts/browser-login.mjs", import.meta.url), join(home, "browser-login.mjs"));
	await cp(new URL("fixtures/browser-login-runner.mjs", import.meta.url), join(home, "runner.mjs"));
	await cp(new URL("fixtures/browser-login-wrapper.mjs", import.meta.url), join(bin, "with-one-password-token"));
	await chmod(join(bin, "with-one-password-token"), 0o700);
	await writeFile(join(home, "scenario.json"), JSON.stringify({ item, ...changes }));
	const { stdout, stderr } = await runFile(process.execPath, [join(home, "runner.mjs")], {
		env: { HOME: home, PATH: process.env.PATH }, timeout: 10_000 });
	expect(stderr).toBe("");
	let args;
	try { args = JSON.parse(await readFile(join(home, "wrapper-args.json"), "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	return { ...JSON.parse(stdout), args };
}

test("copied helper uses canonical state and default custody process with exact wrapper arguments", async () => {
	const run = await scenario();
	expect(run.result).toEqual({ status: "filled", effect: "filled", fields: ["username", "password"] });
	expect(run.args).toEqual(["op", "item", "get", "gddtezlrknpqokylqxnikd4srm", "--vault", "Fixture Vault", "--format", "json"]);
	expect(run.fills).toEqual([["#username", "fixture-user"], ["#password", "fixture-password-not-a-real-secret"]]);
	expect(run.observations).toEqual({ inventory: { emit: false }, browser: { id: "personal-browser" }, tab: "login-tab" });
	expect(JSON.stringify(run.result)).not.toContain("fixture-");
});

for (const [changes, cause] of [
	[{ profile: "Work" }, "wrong-profile"],
	[{ missingBrowser: true }, "wrong-profile"],
	[{ url: "https://login.example.test.attacker.test" }, "wrong-origin"],
	[{ url: "https://user@login.example.test" }, "wrong-origin"],
	[{ mode: 0o644 }, "unsafe-whitelist"],
	[{ config: { version: 1, logins: [{ ...entry, enabled: false }] } }, "login-disabled"],
	[{ config: { version: 1, logins: [entry, entry] } }, "login-not-allowlisted"],
	[{ aliasTargets: true }, "invalid-or-shared-input"],
	[{ passwordType: "text" }, "invalid-or-shared-input"],
	[{ inputCount: 2 }, "invalid-or-shared-input"],
	[{ hidden: true }, "ambiguous-or-hidden-field"],
	[{ disabled: true }, "ambiguous-or-hidden-field"],
	[{ extraOption: "readItemOverride" }, "invalid-options"],
	[{ extraOption: "whitelistPath" }, "invalid-options"],
	[{ extraOption: "profile" }, "invalid-options"],
	[{ extraOption: "tab" }, "invalid-options"],
	[{ suppliedLocator: true }, "invalid-fields"],
]) {
	test(`blocks ${JSON.stringify(changes)} before custody`, async () => {
		const run = await scenario(changes);
		expect(run.result).toEqual({ status: "blocked", effect: "none", cause });
		expect(run.args).toBeUndefined();
		expect(run.fills).toEqual([]);
	});
}

test("validates all credentials before the first fill", async () => {
	const run = await scenario({ item: { ...item, fields: [...item.fields, item.fields[1]] } });
	expect(run.result).toEqual({ status: "blocked", effect: "none", cause: "missing-or-duplicate-field" });
	expect(run.fills).toEqual([]);
});
test("custody navigation is reobserved before any fill", async () => {
	const run = await scenario({ navigate: true });
	expect(run.result).toEqual({ status: "blocked", effect: "none", cause: "wrong-origin" });
	expect(run.fills).toEqual([]);
});
test("staged username-only login uses the same default custody", async () => {
	const run = await scenario({ usernameOnly: true });
	expect(run.result).toEqual({ status: "filled", effect: "filled", fields: ["username"] });
	expect(run.fills).toEqual([["#username", "fixture-user"]]);
});
for (const [changes, effect, cause] of [
	[{ failFill: true }, "partial-or-unknown", "native-fill-failed"],
	[{ failRead: true }, "none", "credential-custody-failed"],
	[{ item: { ...item, title: "Other" } }, "none", "item-mismatch"],
	[{ item: { ...item, urls: [{ href: "https://other.test" }] } }, "none", "item-origin-mismatch"],
]) {
	test(`sanitizes ${cause}`, async () => {
		const run = await scenario(changes);
		expect(run.result).toEqual({ status: "blocked", effect, cause });
		expect(JSON.stringify(run.result)).not.toContain("fixture-");
	});
}
