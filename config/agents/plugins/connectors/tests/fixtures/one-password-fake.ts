// Fake 1Password helper. Records references and arguments, never values.
// Mirrors the real helper's contract: `inject` forwards only HOME, PATH, LANG,
// LC_ALL, TMPDIR plus the one requested secret; `op item get` returns the
// receipts-directory item.json when present.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const receipts = process.env.TMPDIR ?? "/tmp";
const args = process.argv.slice(2);
appendFileSync(path.join(receipts, "wrapper.log"), `${args.join(" ")}\n`);

export function fixtureSecret(envKey: string): string {
	return `fixture-${envKey.toLowerCase().replaceAll("_", "-")}`;
}

if (args[0] === "inject") {
	const [, envKey, reference, dash, ...target] = args;
	if (!envKey || !/^[A-Z][A-Z0-9_]*$/.test(envKey) || !/^op:\/\/[^/]+\/[^/]+\/[^/]+$/.test(reference ?? "") || dash !== "--" || target.length === 0) {
		process.exit(2);
	}
	const env: Record<string, string> = { [envKey]: fixtureSecret(envKey) };
	for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	const child = Bun.spawnSync(target, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	process.exit(child.exitCode);
}
if (args[0] === "op" && args[1] === "item" && args[2] === "get" && args.includes("--format")) {
	const item = path.join(receipts, "item.json");
	if (!existsSync(item)) process.exit(1);
	process.stdout.write(readFileSync(item, "utf8"));
	process.exit(0);
}
process.exit(2);
