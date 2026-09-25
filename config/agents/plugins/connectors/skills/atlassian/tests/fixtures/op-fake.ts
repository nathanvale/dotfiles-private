// Fake plugin-owned op, installed where `connectors setup` publishes the real
// one. The custody reader gives it only HOME, a fixed PATH, and the service
// token, so it finds the fixture root as HOME's parent. It records argv, the
// environment key set, and whether the token matched; never a value. From the
// kernel's process table it also records its parent (the process that ran op)
// in op-parents.jsonl, one line per call: the executable path, the role argv,
// and booleans for environment visibility and each token; never a token value.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { processStrings } from "./process-table.ts";

const root = path.dirname(process.env.HOME ?? "/nonexistent");
const argv = process.argv.slice(2);
const expected = readFileSync(path.join(root, "expected-service-token"), "utf8");
appendFileSync(
	path.join(root, "op-calls.jsonl"),
	`${JSON.stringify({ argv, envKeys: Object.keys(process.env).sort(), serviceTokenMatches: process.env.OP_SERVICE_ACCOUNT_TOKEN === expected })}\n`,
);
const parent = processStrings(process.ppid);
const providerToken = readFileSync(path.join(root, "expected-provider-token"), "utf8");
const parentStrings = [...parent.argv, ...parent.environment];
appendFileSync(
	path.join(root, "op-parents.jsonl"),
	`${JSON.stringify({
		parentExecutable: parent.executable,
		parentRole: parent.argv.slice(1),
		// The fixture's own HOME, as an exact environment entry, proves the
		// environment region was read.
		parentEnvironmentVisible: parent.environment.includes(`HOME=${process.env.HOME}`),
		parentHoldsServiceToken: parentStrings.some((entry) => entry.includes(expected)),
		parentHoldsProviderToken: parentStrings.some((entry) => entry.includes(providerToken)),
	})}\n`,
);
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== expected) {
	process.stderr.write("[ERROR] authentication failed\n");
	process.exit(1);
}
// An item is served only for the exact reference it was stored under, as
// items/<reference>.json. A reference's items/<reference>.then.json, when
// present, is served for its second and later reads instead, so a row can
// change the item between the custody child's read and the Provider's.
if (argv[0] === "item" && argv[1] === "get") {
	const reference = argv[2] ?? "";
	const item = path.join(root, "items", `${reference}.json`);
	if (!/^[A-Za-z0-9_-]+$/.test(reference) || !existsSync(item)) {
		process.stderr.write(`[ERROR] "${reference}" isn't an item in the "API Credentials" vault. Specify the item with its UUID, name, or domain.\n`);
		process.exit(1);
	}
	const reads = readFileSync(path.join(root, "op-calls.jsonl"), "utf8").trim().split("\n").filter((line) => (JSON.parse(line) as { argv: string[] }).argv[2] === reference).length;
	const later = path.join(root, "items", `${reference}.then.json`);
	process.stdout.write(readFileSync(reads > 1 && existsSync(later) ? later : item, "utf8"));
	process.exit(0);
}
process.stderr.write("[ERROR] unsupported fake op command\n");
process.exit(2);
