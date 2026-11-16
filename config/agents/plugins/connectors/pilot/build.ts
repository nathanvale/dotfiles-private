#!/usr/bin/env bun
// Build the Linux pilot's Connectors marketplace: a directory marketplace
// holding one plugin copy for Linux arm64, ready for the pilot's
// /opt/plugin-sources. It leaves the macOS build and every tracked file
// unchanged. Read docs/adr/0009-run-connectors-in-the-linux-pilot.md first.
//
//   bun run build:pilot [--out <empty directory>]
//
// The copy holds:
// - bin/connectors compiled for bun-linux-arm64;
// - only the admitted Connector Skills (PILOT_SKILLS), without their tests;
// - vendor/mcporter: the pinned official MCPorter npm package and its
//   dependencies, installed only by the committed lockfile's integrity, with
//   a launcher bound to this host's Node.
//
// It writes only under --out (default: the gitignored dist/pilot here),
// which must be absent or empty, plus Bun's own package cache. It installs
// nothing into the pilot and never reads a credential.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isNodePath, launcherText, PACKAGED_MCPORTER, PACKAGED_MCPORTER_DIR, releaseRecord, selectPackagedMcporter } from "../bin/mcporter-packaged.ts";

// Admitted for the pilot. Figma and Canva are excluded by Nathan, Atlassian
// is Monash-only, and NotebookLM needs a desktop browser profile (ADR 0009).
export const PILOT_SKILLS = ["context7", "firecrawl", "jev", "mermaid", "notion"] as const;
export const MARKETPLACE = "connectors-pilot";
// The packaged Node must satisfy MCPorter's engines field.
const NODE_MAJOR = 24;

const pluginSource = path.resolve(import.meta.dir, "..");

function fail(message: string): never {
	process.stderr.write(`build:pilot: ${message}\n`);
	process.exit(1);
}

function run(argv: string[], cwd: string, env: Record<string, string>): string {
	const result = Bun.spawnSync(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) fail(`${argv.slice(0, 2).join(" ")} failed:\n${result.stderr.toString()}`);
	return result.stdout.toString();
}

function outDirectory(argv: readonly string[]): string {
	if (argv.length === 0) return path.join(pluginSource, "dist", "pilot");
	if (argv.length !== 2 || argv[0] !== "--out" || !argv[1]) fail("usage: bun run build:pilot [--out <empty directory>]");
	return path.resolve(argv[1]);
}

function hostNode(): string {
	const found = Bun.which("node");
	if (!found) fail("node is not on PATH; the pilot image provides Node 24");
	const node = realpathSync(found);
	if (!isNodePath(node)) fail("the resolved node path has characters the launcher cannot quote");
	const version = run([node, "--version"], pluginSource, { PATH: "/usr/bin:/bin" }).trim();
	const major = Number(/^v(\d+)\./.exec(version)?.[1]);
	if (!(major >= NODE_MAJOR)) fail(`node ${version} is older than MCPorter's required ${NODE_MAJOR}`);
	return node;
}

// The committed lockfile must pin mcporter to the official release bytes.
export function lockedIntegrity(lockText: string): string | null {
	return new RegExp(`"mcporter": \\["mcporter@${PACKAGED_MCPORTER.version.replaceAll(".", "\\.")}", "", \\{[^\\n]*\\}, "(sha512-[A-Za-z0-9+/=]+)"\\]`).exec(lockText)?.[1] ?? null;
}

function stageMcporter(plugin: string, bun: string): void {
	const vendor = path.join(plugin, PACKAGED_MCPORTER_DIR);
	mkdirSync(vendor, { recursive: true });
	const locked = path.join(pluginSource, "config", "mcporter-linux");
	for (const file of ["package.json", "bun.lock"]) cpSync(path.join(locked, file), path.join(vendor, file));
	if (lockedIntegrity(readFileSync(path.join(vendor, "bun.lock"), "utf8")) !== PACKAGED_MCPORTER.integrity) fail("config/mcporter-linux/bun.lock does not pin mcporter to the official release integrity");
	run([bun, "install", "--frozen-lockfile", "--production", "--ignore-scripts", "--linker=hoisted", "--no-progress"], vendor, { PATH: `${path.dirname(bun)}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/" });
	const node = hostNode();
	writeFileSync(path.join(vendor, "release.json"), releaseRecord(node), { mode: 0o644 });
	writeFileSync(path.join(vendor, "mcporter"), launcherText(node), { mode: 0o755 });
	chmodSync(path.join(vendor, "mcporter"), 0o755);
}

function copyPlugin(plugin: string): void {
	mkdirSync(path.join(plugin, "skills"), { recursive: true });
	for (const entry of [".claude-plugin", "requirements.json", "CONTEXT.md"]) cpSync(path.join(pluginSource, entry), path.join(plugin, entry), { recursive: true });
	cpSync(path.join(pluginSource, "config"), path.join(plugin, "config"), { recursive: true, filter: (source) => !source.includes(`${path.sep}mcporter-linux`) });
	for (const skill of PILOT_SKILLS) {
		const from = path.join(pluginSource, "skills", skill);
		cpSync(from, path.join(plugin, "skills", skill), { recursive: true, filter: (source) => path.relative(from, source).split(path.sep)[0] !== "tests" });
	}
}

// Nothing in the copy is writable by group or others, whatever the umask:
// the runtime refuses a staged MCPorter that is.
function normalizeModes(target: string): void {
	const entry = lstatSync(target);
	if (entry.isSymbolicLink()) return;
	if (entry.isDirectory()) {
		chmodSync(target, 0o755);
		for (const child of readdirSync(target)) normalizeModes(path.join(target, child));
		return;
	}
	chmodSync(target, (entry.mode & 0o111) !== 0 ? 0o755 : 0o644);
}

function writeMarketplace(out: string): void {
	const manifest = JSON.parse(readFileSync(path.join(pluginSource, ".claude-plugin", "plugin.json"), "utf8")) as { version: string; description: string; author: unknown };
	mkdirSync(path.join(out, ".claude-plugin"), { recursive: true });
	const marketplace = {
		name: MARKETPLACE,
		owner: { name: "Nathan Vale" },
		metadata: { description: "Connectors for the Linux agents pilot, built by pilot/build.ts" },
		plugins: [{ name: "connectors", description: manifest.description, version: manifest.version, author: manifest.author, source: "./connectors" }],
	};
	writeFileSync(path.join(out, ".claude-plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, "\t")}\n`);
}

function main(): void {
	if (process.platform !== "linux" || process.arch !== "arm64") fail("build on the Linux arm64 pilot host; the macOS build stays bun run build");
	const out = outDirectory(process.argv.slice(2));
	if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} is not empty; choose an empty directory, nothing was removed`);
	const plugin = path.join(out, "connectors");
	copyPlugin(plugin);
	run([process.execPath, "build", "./bin/connectors.ts", "--compile", "--target=bun-linux-arm64", "--outfile", path.join(plugin, "bin", "connectors"), "--minify"], pluginSource, { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" });
	stageMcporter(plugin, process.execPath);
	writeMarketplace(out);
	normalizeModes(out);
	const selected = selectPackagedMcporter(plugin);
	if (!selected.ok) fail(`the staged MCPorter does not verify: ${selected.cause}`);
	const listed = JSON.parse(run([path.join(plugin, "bin", "connectors"), "list"], "/", { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" })) as { result?: { data?: { connectors?: { id: string }[] } } };
	const ids = (listed.result?.data?.connectors ?? []).map((entry) => entry.id).sort();
	if (JSON.stringify(ids) !== JSON.stringify([...PILOT_SKILLS].sort())) fail(`the built front door lists ${ids.join(", ")}`);
	process.stdout.write(`${JSON.stringify({ marketplace: out, plugin, connectors: ids, mcporter: PACKAGED_MCPORTER.version })}\n`);
}

if (import.meta.main) main();
