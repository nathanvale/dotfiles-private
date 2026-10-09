#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const home = process.env.HOME;
await writeFile(join(home, "wrapper-args.json"), JSON.stringify(process.argv.slice(2)));
const scenario = JSON.parse(await readFile(join(home, "scenario.json"), "utf8"));
if (scenario.failRead) {
	process.stderr.write("fixture-password-not-a-real-secret");
	process.exit(1);
}
process.stdout.write(JSON.stringify(scenario.item));
