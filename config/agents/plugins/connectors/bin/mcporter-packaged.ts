// Linux MCPorter: the official npm package of the pinned release, staged
// into the plugin copy at pilot build time (pilot/build.ts) and selected
// read-only here. MCPorter publishes compiled binaries only for macOS, so
// Linux runs the release's own npm payload on Node. Its bytes are
// established at build time: the lockfile's sha512 for mcporter equals the
// official release tgz named in provenance.json, and every dependency
// installs only by its locked integrity. Each use rechecks the staged
// layout, the launcher text, and the reported version; it never downloads,
// repairs, or writes. Read docs/adr/0009-run-connectors-in-the-linux-pilot.md
// before changing it.
import { lstatSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";

export const PACKAGED_MCPORTER = {
	version: "0.14.0",
	// The npm integrity of mcporter@0.14.0, byte-identical to the official
	// release asset mcporter-0.14.0.tgz (sha256 01dc5904…8735c0).
	integrity: "sha512-R60nKyUcW65WawhVjoESC0HeNibsf+1iqpX0wHPX9P60AFX/DYCBlhS7pDYcuWzeGYqYfZG2Xf5jWWkM74d/+A==",
} as const;

// Relative to the plugin root.
export const PACKAGED_MCPORTER_DIR = path.join("vendor", "mcporter");

export type PackagedFailure = "packaged-mcporter-missing" | "packaged-mcporter-invalid" | "version-invalid";
export type PackagedSelection = { ok: true; binary: string } | { ok: false; cause: PackagedFailure };

// The one launcher text the build writes. It runs the package's own CLI with
// the absolute Node recorded at build time, relative to the launcher's real
// location, so a copied plugin keeps working.
export const launcherText = (node: string): string => `#!/bin/sh\nexec '${node}' "\${0%/*}/node_modules/mcporter/dist/cli.js" "$@"\n`;

// A safe absolute Node path: single-quoted in the launcher, so no quote.
export const isNodePath = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value) && /^[A-Za-z0-9_./+-]+$/.test(value);

export const releaseRecord = (node: string): string => `${JSON.stringify({ version: PACKAGED_MCPORTER.version, integrity: PACKAGED_MCPORTER.integrity, node })}\n`;

export type VersionRun = (binary: string) => { exitCode: number; stdout: string };

const nativeVersion: VersionRun = (binary) => {
	try {
		const result = Bun.spawnSync([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 });
		return { exitCode: result.exitCode ?? 1, stdout: result.stdout.toString().trim() };
	} catch {
		return { exitCode: 1, stdout: "" };
	}
};

// A real entry, not a symlink, that neither group nor others may write.
function stat(target: string): Stats | null {
	try {
		const entry = lstatSync(target);
		return entry.isSymbolicLink() || (entry.mode & 0o022) !== 0 ? null : entry;
	} catch {
		return null;
	}
}

function readText(file: string): string | null {
	const entry = stat(file);
	if (!entry?.isFile()) return null;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function recordedNode(text: string): string | null {
	try {
		const value = JSON.parse(text) as { node?: unknown } | null;
		const node = value?.node;
		return isNodePath(node) && text === releaseRecord(node) ? node : null;
	} catch {
		return null;
	}
}

function packageVersion(text: string | null): unknown {
	try {
		return text === null ? null : (JSON.parse(text) as { version?: unknown }).version;
	} catch {
		return null;
	}
}

// The plugin root's staged MCPorter, only when every check passes.
export function selectPackagedMcporter(pluginRoot: string, run: VersionRun = nativeVersion): PackagedSelection {
	const root = path.join(pluginRoot, PACKAGED_MCPORTER_DIR);
	if (!stat(root)?.isDirectory()) return { ok: false, cause: "packaged-mcporter-missing" };
	const record = readText(path.join(root, "release.json"));
	const node = record === null ? null : recordedNode(record);
	const binary = path.join(root, "mcporter");
	const launcher = stat(binary);
	if (node === null || !launcher?.isFile() || (launcher.mode & 0o100) === 0 || readText(binary) !== launcherText(node)) return { ok: false, cause: "packaged-mcporter-invalid" };
	if (packageVersion(readText(path.join(root, "node_modules", "mcporter", "package.json"))) !== PACKAGED_MCPORTER.version) return { ok: false, cause: "packaged-mcporter-invalid" };
	const reported = run(binary);
	return reported.exitCode === 0 && reported.stdout === PACKAGED_MCPORTER.version ? { ok: true, binary } : { ok: false, cause: "version-invalid" };
}

// The plugin root of the running compiled front door: bin/connectors sits
// one level below it.
export const runningPluginRoot = (): string => path.resolve(path.dirname(process.execPath), "..");

// The repair for any refusal: the staged copy belongs to the pilot build, so
// only a rebuild and reinstall of the plugin replaces it.
export const PACKAGED_REPAIR = "MCPorter is staged into the Linux pilot plugin at build time; rebuild the plugin with bun run build:pilot and reinstall it, and never edit the installed copy";

export const usesPackagedMcporter = (platform: string = process.platform): boolean => platform === "linux";
