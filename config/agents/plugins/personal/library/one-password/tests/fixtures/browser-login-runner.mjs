import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { fillBrowserLogin } = await import(pathToFileURL(join(process.env.HOME, "browser-login.mjs")).href);

const scenario = JSON.parse(await readFile(join(process.env.HOME, "scenario.json"), "utf8"));
const fills = [];
const observations = {};
let urls = 0;
class Input {
	constructor(type) { this.type = type; this.tagName = "INPUT"; }
	getAttribute(name) { return name === "type" ? this.type : null; }
}
const username = new Input("text");
const password = scenario.aliasTargets ? username : new Input(scenario.passwordType ?? "password");
globalThis.document = {
	querySelectorAll(selector) {
		const input = selector === "#username" ? username : password;
		return Array.from({ length: scenario.inputCount ?? 1 }, () => input);
	},
};
const tab = {
	url: async () => scenario.navigate && ++urls > 1 ? "https://other.test" : scenario.url ?? "https://login.example.test",
	playwright: {
		evaluate: async (fn, arg) => fn(arg),
		locator: (selector) => ({ count: async () => 1,
			isVisible: async () => !scenario.hidden, isEnabled: async () => !scenario.disabled,
			fill: async (value) => {
				if (scenario.failFill) throw new Error("fixture-password-not-a-real-secret");
				fills.push([selector, value]);
			},
		}),
	},
};
const cua = {
	listBrowsers: async (options) => {
		observations.inventory = options;
		return scenario.missingBrowser ? [] : [{ id: "personal-browser", profileName: scenario.profile ?? "Personal" }];
	},
	getBrowser: async (selector) => {
		observations.browser = selector;
		return { tabs: { get: async (id) => { observations.tab = id; return tab; } } };
	},
};
const options = { login: "example.login", cua, browserId: "personal-browser", tabId: "login-tab",
	fields: [{ id: "username", selector: "#username" }, { id: "password", selector: "#password" }] };
if (scenario.usernameOnly) options.fields = options.fields.slice(0, 1);
if (scenario.extraOption) options[scenario.extraOption] = "forbidden";
if (scenario.suppliedLocator) options.fields = [{ id: "password", locator: {} }];
const result = await fillBrowserLogin(options);
process.stdout.write(JSON.stringify({ result, fills, observations }));
