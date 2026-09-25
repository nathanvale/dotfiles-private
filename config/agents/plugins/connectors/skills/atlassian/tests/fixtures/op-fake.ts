// Fake plugin-owned op, installed where `connectors setup` publishes the real
// one. The custody reader gives it only HOME, a fixed PATH, and the service
// token, so it finds the fixture root as HOME's parent. It records argv, the
// environment key set, and whether the token matched; never a value.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.dirname(process.env.HOME ?? "/nonexistent");
const argv = process.argv.slice(2);
const expected = readFileSync(path.join(root, "expected-service-token"), "utf8");
appendFileSync(
	path.join(root, "op-calls.jsonl"),
	`${JSON.stringify({ argv, envKeys: Object.keys(process.env).sort(), serviceTokenMatches: process.env.OP_SERVICE_ACCOUNT_TOKEN === expected })}\n`,
);
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== expected) {
	process.stderr.write("[ERROR] authentication failed\n");
	process.exit(1);
}
if (argv[0] === "item" && argv[1] === "get") {
	const item = path.join(root, "item.json");
	if (!existsSync(item)) {
		process.stderr.write(`[ERROR] "${argv[2]}" isn't an item in the "API Credentials" vault. Specify the item with its UUID, name, or domain.\n`);
		process.exit(1);
	}
	process.stdout.write(readFileSync(item, "utf8"));
	process.exit(0);
}
process.stderr.write("[ERROR] unsupported fake op command\n");
process.exit(2);
