import { afterAll, expect, test } from "bun:test";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fillBrowserLogin } from "../scripts/browser-login.mjs";

const root = await mkdtemp(join(tmpdir(), "timesheet-login-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let serial = 0;
const entry = {
	name: "timesheets.oncore", enabled: true, vault: "Browser Automation",
	item: "Oncoreservices", itemId: "gddtezlrknpqokylqxnikd4srm",
	origin: "https://iteraterecruitment.oncoreservices.com", profile: "nathanvale.com",
};
const item = {
	id: entry.itemId, title: "Oncoreservices", vault: { name: "Browser Automation" },
	category: "LOGIN", urls: [{ href: "https://iteraterecruitment.oncoreservices.com" }],
	fields: [{ id: "username", value: "fixture-user" },
		{ id: "password", value: "fixture-password-not-a-real-secret" }],
};

async function scenario({ config = { version: 1, logins: [entry] },
	url = "https://iteraterecruitment.oncoreservices.com/Pages/Login.aspx",
	profile = "nathanvale.com", selectedItem = item, mode = 0o600,
	failFill = false, locatorCount = 1, readFailure = false } = {}) {
	const whitelistPath = join(root, `${serial++}.json`);
	await writeFile(whitelistPath, JSON.stringify(config), { mode });
	let reads = 0;
	const fills = [];
	const locator = {
		count: async () => locatorCount, isVisible: async () => true,
		isEnabled: async () => true,
		fill: async (value) => {
			if (failFill) throw new Error("fixture-password-not-a-real-secret");
			fills.push(value);
		},
	};
	const options = {
		login: "timesheets.oncore", profile, tab: { url: async () => url },
		fields: [{ id: "username", locator }, { id: "password", locator }], whitelistPath,
		readItemOverride: async (selected) => {
			reads++;
			expect(selected.vault).toBe("Browser Automation");
			expect(selected.itemId).toBe("gddtezlrknpqokylqxnikd4srm");
			if (readFailure) throw new Error("fixture-password-not-a-real-secret");
			return selectedItem;
		},
	};
	return { options, fills, reads: () => reads };
}

test("native locators receive selected fields; receipt has no secrets", async () => {
	const run = await scenario();
	const result = await fillBrowserLogin(run.options);
	expect(result).toEqual({ status: "filled", effect: "filled", fields: ["username", "password"] });
	expect(run.fills).toEqual(["fixture-user", "fixture-password-not-a-real-secret"]);
	expect(JSON.stringify(result)).not.toContain("fixture-user");
	expect(JSON.stringify(result)).not.toContain("fixture-password");
});

for (const url of ["https://iteraterecruitment.oncoreservices.com.attacker.test",
	"http://iteraterecruitment.oncoreservices.com", "https://user@iteraterecruitment.oncoreservices.com"]) {
	test(`refuses unapproved destination before custody: ${url}`, async () => {
		const run = await scenario({ url });
		expect(await fillBrowserLogin(run.options)).toEqual({ status: "blocked", effect: "none", cause: "wrong-origin" });
		expect(run.reads()).toBe(0);
		expect(run.fills).toEqual([]);
	});
}

for (const [changes, cause] of [
	[{ profile: "Monash" }, "wrong-profile"],
	[{ mode: 0o644 }, "unsafe-whitelist"],
	[{ locatorCount: 2 }, "ambiguous-or-hidden-field"],
	[{ config: { version: 1, logins: [{ ...entry, enabled: false }] } }, "login-disabled"],
	[{ config: { version: 1, logins: [entry, entry] } }, "login-not-allowlisted"],
	[{ config: { version: 1, logins: [{ ...entry, vault: "" }] } }, "invalid-vault"],
]) {
	test(`refuses ${cause} before custody`, async () => {
		const run = await scenario(changes);
		expect(await fillBrowserLogin(run.options)).toEqual({ status: "blocked", effect: "none", cause });
		expect(run.reads()).toBe(0);
		expect(run.fills).toEqual([]);
	});
}

test("duplicate password IDs cannot partially fill username", async () => {
	const run = await scenario({ selectedItem: { ...item, fields: [...item.fields, item.fields[1]] } });
	expect(await fillBrowserLogin(run.options)).toEqual({ status: "blocked", effect: "none", cause: "missing-or-duplicate-field" });
	expect(run.fills).toEqual([]);
});

test("wrong item website or identity cannot fill", async () => {
	for (const selectedItem of [{ ...item, urls: [{ href: "https://other.test" }] },
		{ ...item, title: "Different login" }]) {
		const run = await scenario({ selectedItem });
		expect((await fillBrowserLogin(run.options)).status).toBe("blocked");
		expect(run.fills).toEqual([]);
	}
});

test("navigation during custody stops before filling", async () => {
	const run = await scenario();
	let observations = 0;
	run.options.tab.url = async () => ++observations === 1 ? entry.origin : "https://other.test";
	expect(await fillBrowserLogin(run.options)).toEqual({ status: "blocked", effect: "none", cause: "wrong-origin" });
	expect(run.fills).toEqual([]);
});

test("failed fill is unknown effect with sanitised error", async () => {
	const run = await scenario({ failFill: true });
	expect(await fillBrowserLogin(run.options)).toEqual({ status: "blocked", effect: "partial-or-unknown", cause: "native-fill-failed" });
});

test("failed custody is no effect with sanitised error", async () => {
	const run = await scenario({ readFailure: true });
	expect(await fillBrowserLogin(run.options)).toEqual({ status: "blocked", effect: "none", cause: "credential-custody-failed" });
});

test("FastTrack can fill username alone on its staged sign-in", async () => {
	const fast = { ...entry, name: "timesheets.fasttrack", item: "Fasttrack360",
		itemId: "6zxbhwbyrlwjgy4bz3bx2wc5sm", origin: "https://manpowergroup.fasttrack360.com.au" };
	const run = await scenario({ config: { version: 1, logins: [fast] }, url: fast.origin });
	run.options.login = "timesheets.fasttrack";
	run.options.fields = [run.options.fields[0]];
	run.options.readItemOverride = async () => ({ ...item, id: fast.itemId, title: "Fasttrack360", urls: [{ href: fast.origin }] });
	expect(await fillBrowserLogin(run.options)).toEqual({ status: "filled", effect: "filled", fields: ["username"] });
	expect(run.fills).toEqual(["fixture-user"]);
});

test("copied plugin module works without checkout dependencies", async () => {
	const copied = join(root, "browser-login.mjs");
	await cp(new URL("../scripts/browser-login.mjs", import.meta.url), copied);
	const loaded = await import(pathToFileURL(copied).href);
	const run = await scenario();
	expect((await loaded.fillBrowserLogin(run.options)).status).toBe("filled");
	expect(run.fills).toEqual(["fixture-user", "fixture-password-not-a-real-secret"]);
});

test("another approved website, vault and Chrome profile need only a config entry", async () => {
	const other = { ...entry, name: "example.photos", vault: "Personal Logins",
		item: "Photo Gallery", origin: "https://photos.example.test", profile: "Family" };
	const run = await scenario({ config: { version: 1, logins: [other] },
		url: other.origin, profile: "Family" });
	run.options.login = "example.photos";
	run.options.readItemOverride = async () => ({ ...item, title: "Photo Gallery",
		vault: { name: "Personal Logins" }, urls: [{ href: other.origin }] });
	expect((await fillBrowserLogin(run.options)).status).toBe("filled");
	expect(run.fills).toEqual(["fixture-user", "fixture-password-not-a-real-secret"]);
});

for (const origin of ["http://example.test", "https://example.test/path", "https://example.test?query=1", "https://*.example.test"]) {
	test(`refuses non-exact HTTPS origin in whitelist: ${origin}`, async () => {
		const run = await scenario({ config: { version: 1, logins: [{ ...entry, origin }] } });
		expect((await fillBrowserLogin(run.options)).status).toBe("blocked");
		expect(run.reads()).toBe(0);
		expect(run.fills).toEqual([]);
	});
}
