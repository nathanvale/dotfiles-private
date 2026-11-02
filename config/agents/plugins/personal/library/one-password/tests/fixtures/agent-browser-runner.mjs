#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.HOME;
const scenario = JSON.parse(await readFile(join(home, "scenario.json"), "utf8"));
const options = scenario.browser ?? {};
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
await appendFile(join(home, "browser-calls.jsonl"), `${JSON.stringify({ args, stdin,
	hasOpToken: Object.keys(process.env).some(key => key.startsWith("OP_")) })}\n`);
const command = args.slice(5);
let data;
if (command[0] === "get") data = { url: options.url ?? "https://login.example.test/staged" };
else if (command[0] === "stream") data = { enabled: options.streaming === true, screencasting: false };
else if (command[0] === "eval") data = { result: options.invalidInput !== true };
else if (command[0] === "batch") {
	if (options.failBatch) {
		process.stdout.write("fixture-password-not-a-real-secret");
		process.stderr.write("fixture-password-not-a-real-secret");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify([
		{ index: 0, success: true, result: { result: true } },
		{ index: 1, success: true, result: { filled: "#password" } },
		{ index: 2, success: true, result: { result: true } },
	]));
	process.exit(0);
} else process.exit(2);
process.stdout.write(JSON.stringify({ success: true, data }));
