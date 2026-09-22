// Fake MCPorter: the one owner of the public process seam in tests. Mirrors
// MCPorter 0.13.13 as observed on 2026-09-22 with a real stdio child:
// explicit --config only; stdio cwd is the config directory; the child gets the
// whole parent environment plus the entry env with ${VAR} resolved; a missing
// placeholder aborts before any child runs; HTTP entries are recorded, never
// contacted. Receipts go to TMPDIR, the only writable path the route forwards.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Entry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	baseUrl?: string;
	url?: string;
	headers?: Record<string, string>;
}

const args = process.argv.slice(2);
const receipts = process.env.TMPDIR ?? "/tmp";
const record = (name: string, value: unknown) => writeFileSync(path.join(receipts, name), JSON.stringify(value, null, 1));
const configIndex = args.indexOf("--config");
if (configIndex === -1) {
	process.stderr.write("fake-mcporter: --config is required\n");
	process.exit(9);
}
const configPath = path.resolve(args[configIndex + 1] ?? "");
const verb = args[configIndex + 2];
const target = args[configIndex + 3] ?? "";
const server = verb === "call" ? target.split(".", 1)[0] : target;
const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, Entry> };
const entry = config.mcpServers[server ?? ""];
const base = { argv: args, env: process.env, pid: process.pid, cwd: process.cwd() };

if (!entry) {
	record("mcporter.json", { ...base, kind: "unknown" });
	process.stderr.write(`fake-mcporter: unknown server ${server}\n`);
	process.exit(1);
}
// One test-owned process failure can replace the Provider spawn. This mirrors
// MCPorter 0.13.13's public JSON failure shape, including its loss of child
// stderr, without teaching the fake how to classify a Provider failure.
const forcedFailure = path.join(receipts, "mcporter-failure.json");
if (existsSync(forcedFailure)) {
	const failure = JSON.parse(readFileSync(forcedFailure, "utf8")) as { code: number; stdout: string; stderr: string };
	record("mcporter.json", { ...base, kind: "forced-failure" });
	process.stdout.write(failure.stdout);
	process.stderr.write(failure.stderr);
	process.exit(failure.code);
}
// Canned responses: TMPDIR/canned/<server>/list.json for a listing, or
// TMPDIR/canned/<server>/<tool>.json for a call, replace any provider spawn.
const cannedName = verb === "call" ? (target.split(".")[1] ?? "") : "list";
const canned = path.join(receipts, "canned", server ?? "", `${cannedName}.json`);
if (existsSync(canned)) {
	record("mcporter.json", { ...base, kind: "canned", canned });
	process.stdout.write(readFileSync(canned, "utf8"));
	process.exit(0);
}

const url = entry.baseUrl ?? entry.url;
if (url) {
	record("mcporter.json", { ...base, kind: "http", url, headers: entry.headers ?? null });
	process.stdout.write(`${JSON.stringify({ fake: true, kind: "http", server, url })}\n`);
	process.exit(0);
}

const missing: string[] = [];
const resolve = (raw: string) =>
	raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (placeholder, name: string, fallback: string | undefined) => {
		const value = process.env[name];
		if (value !== undefined && value !== "") return value;
		if (fallback !== undefined) return fallback;
		missing.push(name);
		return placeholder;
	});
const childEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) childEnv[key] = value;
for (const [key, raw] of Object.entries(entry.env ?? {})) childEnv[key] = resolve(raw);
const childArgs = (entry.args ?? []).map(resolve);
if (missing.length > 0) {
	process.stderr.write(`fake-mcporter: Server '${server}' has unresolved env placeholder: ${missing.join(", ")} must be set\n`);
	process.exit(1);
}
const cwd = path.dirname(configPath);
const command = path.resolve(cwd, entry.command ?? "");
record("mcporter.json", { ...base, kind: "stdio", command, cwd });
const child = Bun.spawnSync([command, ...childArgs], { cwd, env: childEnv, stdin: "ignore" });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exit(child.exitCode);
