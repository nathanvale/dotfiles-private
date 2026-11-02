import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { loadAgentBrowserBinding, resolveAgentBrowserField } from "./browser-login.mjs";

/** @returns {never} */
function refuse() { throw new Error("staged-fill-refused"); }

/** @param {unknown} input */
function parseRequest(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) refuse();
	const request = /** @type {Record<string, unknown>} */ (input);
	if (Object.keys(request).sort().join(",") !== "field,login,session" ||
		typeof request.login !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.login) ||
		typeof request.session !== "string" || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(request.session) ||
		!["username", "password"].includes(String(request.field))) refuse();
	return { login: String(request.login), session: String(request.session),
		field: /** @type {'username' | 'password'} */ (request.field) };
}

async function checkConfig() {
	const path = join(homedir(), ".config/agent-browser/one-password.json");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== userInfo().uid || (stat.mode & 0o077) !== 0) refuse();
		const config = JSON.parse(await file.readFile("utf8"));
		if (config.namespace !== "agent-credentials" || config.restoreSave !== "never" ||
			config.debug === true || config.trace || config.record || config.state || config.cdp || config.profile) refuse();
	} finally { await file.close(); }
	return path;
}

function browserEnvironment() {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		!key.startsWith("OP_") && !key.startsWith("AGENT_BROWSER_")));
}

/** @param {string[]} args @param {string} [stdin] @returns {Promise<unknown>} */
function browser(args, stdin = "") {
	return new Promise((resolve, reject) => {
		const child = execFile(join(homedir(), ".local/bin/agent-browser"), args,
			{ env: browserEnvironment(), timeout: 12_000, maxBuffer: 1_048_576 }, (error, stdout) => {
				if (error) { reject(new Error("browser-operation-refused")); return; }
				try { resolve(JSON.parse(stdout)); }
				catch { reject(new Error("browser-response-invalid")); }
			});
		child.stdin?.on("error", () => {});
		child.stdin?.end(stdin);
	});
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function browserData(value) {
	if (typeof value !== "object" || value === null || !("success" in value) || value.success !== true ||
		!("data" in value) || typeof value.data !== "object" || value.data === null) refuse();
	return /** @type {Record<string, unknown>} */ (value.data);
}

/** @param {string} origin @param {string} selector @param {'username' | 'password'} field @param {boolean} after */
function guard(origin, selector, field, after = false) {
	return `(() => {
		if (location.origin !== ${JSON.stringify(origin)}) throw Error("origin-refused");
		const matches = document.querySelectorAll(${JSON.stringify(selector)});
		if (matches.length !== 1) throw Error("input-refused");
		const input = matches[0], box = input.getBoundingClientRect(), style = getComputedStyle(input);
		if (input.tagName !== "INPUT" || input.disabled || input.readOnly || box.width <= 0 || box.height <= 0 ||
			style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0 ||
			!${JSON.stringify(field === "password" ? ["password"] : ["text", "email", "tel"])}.includes(input.type)) throw Error("input-refused");
		if (${after} ? document.activeElement !== input : input.value.length !== 0) throw Error("input-state-refused");
		return true;
	})()`;
}

/** Fill one approved stage. Native batch stdin owns the secret transport, never MCP fill argv. @param {unknown} input */
export async function fillAgentBrowserCredential(input) {
	let effect = "none";
	let cause = "staged-fill-preflight-refused";
	try {
		const { login, session, field } = parseRequest(input);
		const { entry, settings } = await loadAgentBrowserBinding(login, [`${field}Selector`]);
		const config = await checkConfig();
		const args = ["--config", config, "--session", session, "--json"];
		const selector = String(settings[`${field}Selector`]);
		const url = browserData(await browser([...args, "get", "url"])).url;
		if (typeof url !== "string") refuse();
		const actual = new URL(url);
		if (actual.origin !== entry.origin || actual.username || actual.password) refuse();
		const stream = browserData(await browser([...args, "stream", "status"]));
		if (stream.enabled !== false || stream.screencasting !== false) refuse();
		if (browserData(await browser([...args, "eval", guard(entry.origin, selector, field)])).result !== true) refuse();
		cause = "staged-fill-custody-refused";
		const credential = await resolveAgentBrowserField(login, field);
		if (credential.url !== entry.origin || credential.selector !== selector) refuse();
		cause = "staged-fill-effect-unconfirmed";
		effect = "partial-or-unknown";
		const rows = await browser([...args, "batch", "--bail", "--omit-command"], JSON.stringify([
			["eval", guard(entry.origin, selector, field)],
			["fill", selector, credential.value],
			["eval", guard(entry.origin, selector, field, true)],
		]));
		if (!Array.isArray(rows) || rows.length !== 3 || rows.some((row, index) =>
			row?.success !== true || row?.index !== index) || rows[0].result?.result !== true || rows[2].result?.result !== true) refuse();
		return { status: "filled", effect: "filled", fields: [field] };
	} catch {
		return { status: "blocked", effect, cause };
	}
}
