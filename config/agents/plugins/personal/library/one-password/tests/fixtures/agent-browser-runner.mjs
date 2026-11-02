#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const home = process.env.HOME;
const scenario = JSON.parse(await readFile(join(home, "scenario.json"), "utf8"));
const options = scenario.browser ?? {};
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
await appendFile(join(home, "browser-calls.jsonl"), `${JSON.stringify({ args, stdin,
	hasOpToken: Object.keys(process.env).some(key => key.startsWith("OP_")) })}\n`);
const inputs = new Map();
const document = {
	activeElement: null,
	querySelectorAll(selector) {
		if (!inputs.has(selector)) inputs.set(selector, {
			tagName: "INPUT", type: selector === "#password" ? "password" : "text",
			disabled: false, readOnly: false, value: "", width: 100, height: 20,
			visibility: "visible", display: "block", opacity: "1",
			getBoundingClientRect() { return { width: this.width, height: this.height }; },
			...options.input,
		});
		return Array.from({ length: options.inputCount ?? 1 }, () => inputs.get(selector));
	},
};
const location = { origin: new URL(options.url ?? "https://login.example.test/staged").origin };
function evaluate(expression) {
	return runInNewContext(expression, { location, document, getComputedStyle: input => input });
}
async function batch() {
	if (options.failBatch) {
		process.stdout.write("fixture-password-not-a-real-secret");
		process.stderr.write("fixture-password-not-a-real-secret");
		process.exit(1);
	}
	if (options.batchOrigin) location.origin = options.batchOrigin;
	options.input = { ...options.input, ...options.batchInput };
	const rows = [];
	for (const [index, command] of JSON.parse(stdin).entries()) {
		try {
			let result;
			if (command[0] === "eval") result = { result: evaluate(command[1]) };
			else if (command[0] === "fill") {
				const input = document.querySelectorAll(command[1])[0];
				input.value = options.clearAfterFill ? "" : command[2];
				document.activeElement = options.blurAfterFill ? null : input;
				await appendFile(join(home, "browser-fills.jsonl"), `${JSON.stringify(command[1])}\n`);
				result = { filled: command[1] };
			} else throw Error("fixture-command-refused");
			rows.push({ index, success: true, result });
		} catch {
			rows.push({ index, success: false, error: "fixture-guard-refused" });
			break;
		}
	}
	return rows;
}
const command = args.slice(5);
if (command[0] === "batch") process.stdout.write(JSON.stringify(await batch()));
else {
	try {
		let data;
		if (command[0] === "get") data = { url: options.url ?? "https://login.example.test/staged" };
		else if (command[0] === "stream") data = { enabled: options.streaming === true, screencasting: false };
		else if (command[0] === "eval") data = { result: evaluate(command[1]) };
		else throw Error("fixture-command-refused");
		process.stdout.write(JSON.stringify({ success: true, data }));
	} catch { process.stdout.write(JSON.stringify({ success: false, error: "fixture-guard-refused" })); }
}
