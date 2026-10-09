import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

/** @typedef {{name: string, enabled: boolean, vault: string, item: string, itemId: string, origin: string, profile: string}} LoginEntry */
/** @typedef {{count: () => Promise<number>, isVisible: () => Promise<boolean>, isEnabled: () => Promise<boolean>, fill: (value: string) => Promise<void>}} NativeLocator */

class LoginFailure extends Error {
	/** @param {string} cause */
	constructor(cause) {
		super(cause);
		this.code = cause;
	}
}

/** @param {unknown} condition @param {string} cause @returns {asserts condition} */
function requireValue(condition, cause) {
	if (!condition) throw new LoginFailure(cause);
}

/** @param {string} path @returns {Promise<unknown>} */
async function loadWhitelist(path) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		requireValue(stat.isFile() && (stat.mode & 0o077) === 0, "unsafe-whitelist");
		requireValue(stat.uid === userInfo().uid, "unsafe-whitelist");
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
	requireValue(typeof value === "object" && value !== null && !Array.isArray(value), "invalid-object");
	return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} login @param {string} profile @returns {LoginEntry} */
function selectLogin(value, login, profile) {
	const config = record(value);
	requireValue(config.version === 1 && Array.isArray(config.logins), "invalid-whitelist");
	const matches = config.logins.map(record).filter((row) => row.name === login);
	requireValue(matches.length === 1, "login-not-allowlisted");
	const entry = matches[0];
	requireValue(entry.enabled === true, "login-disabled");
	requireValue(typeof entry.origin === "string", "origin-not-approved");
	const origin = new URL(entry.origin);
	requireValue(origin.protocol === "https:" && origin.origin === entry.origin &&
		!origin.hostname.includes("*"),
		"origin-not-approved");
	requireValue(typeof profile === "string" && profile.length > 0 && entry.profile === profile,
		"wrong-profile");
	requireValue(typeof entry.vault === "string" && entry.vault.trim().length > 0,
		"invalid-vault");
	requireValue(typeof entry.item === "string" && entry.item.length > 0, "invalid-item");
	requireValue(typeof entry.itemId === "string" && /^[a-z0-9]{26}$/.test(entry.itemId), "invalid-item");
	return { name: login, enabled: true, vault: entry.vault, item: entry.item,
		itemId: entry.itemId, origin: entry.origin, profile };
}

/** @param {string | undefined} url @param {string} expected */
function assertOrigin(url, expected) {
	requireValue(typeof url === "string", "wrong-origin");
	const actual = new URL(url);
	requireValue(actual.origin === expected && !actual.username && !actual.password,
		"wrong-origin");
}

/** @param {LoginEntry} entry @returns {Promise<unknown>} */
async function readItem(entry) {
	const wrapper = join(homedir(), "code/dotfiles/bin/with-one-password-token");
	const { stdout } = await runFile(wrapper, [
		"op", "item", "get", entry.itemId, "--vault", entry.vault, "--format", "json",
	], { timeout: 20_000, maxBuffer: 1024 * 1024 });
	return JSON.parse(stdout);
}

/** @param {Record<string, unknown>} item @param {LoginEntry} entry */
function validateItem(item, entry) {
	requireValue(item.id === entry.itemId && item.title === entry.item,
		"item-mismatch");
	requireValue(record(item.vault).name === entry.vault && item.category === "LOGIN",
		"item-mismatch");
	requireValue(Array.isArray(item.urls) && item.urls.some((row) => {
		try {
			const href = record(row).href;
			return typeof href === "string" && new URL(href).origin === entry.origin;
		}
		catch { return false; }
	}), "item-origin-mismatch");
}

/** @param {Record<string, unknown>} item @param {string} id @returns {string} */
function credential(item, id) {
	requireValue(Array.isArray(item.fields), "missing-or-duplicate-field");
	const matches = item.fields.map(record).filter((field) => field.id === id);
	requireValue(matches.length === 1, "missing-or-duplicate-field");
	const value = matches[0].value;
	requireValue(typeof value === "string" && value.length > 0 && !value.includes("\0"),
		"invalid-credential");
	return value;
}

// The caller supplies native Harness locators, not another browser connection.
// readItemOverride is a test seam; production callers use wrapper custody above.
/** @param {{login: string, profile: string, tab: {url: () => Promise<string | undefined>}, fields: Array<{id: 'username' | 'password', locator: NativeLocator}>, whitelistPath?: string, readItemOverride?: (entry: LoginEntry) => Promise<unknown>}} options */
export async function fillBrowserLogin({
	login, profile, tab, fields,
	whitelistPath = join(homedir(), ".config/browser-automation/logins.json"),
	readItemOverride = readItem,
}) {
	let effect = "none";
	let stage = "whitelist-read-failed";
	try {
		const entry = selectLogin(await loadWhitelist(whitelistPath), login, profile);
		stage = "native-observation-failed";
		assertOrigin(await tab.url(), entry.origin);
		requireValue(Array.isArray(fields) && fields.length > 0 && fields.length <= 2,
			"invalid-fields");
		const ids = fields.map((field) => field.id);
		requireValue(ids.every((id) => id === "username" || id === "password") &&
			new Set(ids).size === ids.length, "invalid-fields");
		for (const field of fields) {
			requireValue(await field.locator.count() === 1 &&
				await field.locator.isVisible() && await field.locator.isEnabled(),
				"ambiguous-or-hidden-field");
		}
		stage = "credential-custody-failed";
		const item = record(await readItemOverride(entry));
		validateItem(item, entry);
		const values = fields.map((field) => credential(item, field.id));
		stage = "native-fill-failed";
		for (let index = 0; index < fields.length; index++) {
			assertOrigin(await tab.url(), entry.origin);
			effect = "partial-or-unknown";
			await fields[index].locator.fill(values[index]);
		}
		return { status: "filled", effect: "filled", fields: ids };
	} catch (error) {
		return { status: "blocked", effect,
			cause: error instanceof LoginFailure ? error.code : stage };
	}
}
