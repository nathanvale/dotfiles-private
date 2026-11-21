// Linux MCPorter: the official npm package of the pinned release, staged
// into the plugin copy at pilot build time (pilot/build.ts) and selected
// read-only here. MCPorter publishes compiled binaries only for macOS, so
// Linux runs the release's own npm payload on Node. Its bytes are
// established at build time: the lockfile's sha512 for mcporter equals the
// official release tgz named in provenance.json, and every dependency
// installs only by its locked integrity. The build also records the sha256
// of the Node binary the launcher runs and one digest of the staged mcporter
// package's files. Each use rechecks the staged layout, the launcher text,
// both recorded digests, and the reported version, in that order, so
// neither Node nor MCPorter runs before its bytes match the record; it
// never downloads, repairs, or writes. Read
// docs/adr/0009-run-connectors-in-the-linux-pilot.md before changing it.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Stats } from "node:fs";
import path from "node:path";

export const PACKAGED_MCPORTER = {
	version: "0.14.0",
	// The npm integrity of mcporter@0.14.0, byte-identical to the official
	// release asset mcporter-0.14.0.tgz (sha256 01dc5904…8735c0).
	integrity: "sha512-R60nKyUcW65WawhVjoESC0HeNibsf+1iqpX0wHPX9P60AFX/DYCBlhS7pDYcuWzeGYqYfZG2Xf5jWWkM74d/+A==",
} as const;

// Relative to the plugin root.
export const PACKAGED_MCPORTER_DIR = path.join("vendor", "mcporter");

export type PackagedFailure = "packaged-mcporter-missing" | "packaged-mcporter-invalid" | "packaged-node-mismatch" | "packaged-mcporter-mismatch" | "version-invalid";
export type PackagedSelection = { ok: true; binary: string } | { ok: false; cause: PackagedFailure };

// The one launcher text the build writes. It runs the package's own CLI with
// the absolute Node recorded at build time, relative to the path the launcher
// was invoked by (the front door always uses its absolute path), so a copied
// plugin keeps working.
export const launcherText = (node: string): string => `#!/bin/sh\nexec '${node}' "\${0%/*}/node_modules/mcporter/dist/cli.js" "$@"\n`;

// A safe absolute Node path: single-quoted in the launcher, so no quote.
export const isNodePath = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value) && /^[A-Za-z0-9_./+-]+$/.test(value);

// What the build recorded: the Node path with its sha256, and the digest of
// the staged mcporter package (packageDigest).
export interface StagedDigests {
	readonly node: string;
	readonly nodeSha256: string;
	readonly mcporterSha256: string;
}

export const releaseRecord = ({ node, nodeSha256, mcporterSha256 }: StagedDigests): string => `${JSON.stringify({ version: PACKAGED_MCPORTER.version, integrity: PACKAGED_MCPORTER.integrity, node, nodeSha256, mcporterSha256 })}\n`;

const SHA256 = /^[0-9a-f]{64}$/;

function sha256OfFile(file: string): string | null {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(file, "r");
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(1 << 20);
		for (let read = readSync(descriptor, chunk, 0, chunk.length, null); read > 0; read = readSync(descriptor, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, read));
		return hash.digest("hex");
	} catch {
		return null;
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
}

// The sha256 of the Node binary at a recorded path: a regular file, never a
// symlink, so the bytes hashed are the bytes the launcher runs.
export function nodeDigest(node: string): string | null {
	try {
		if (!lstatSync(node).isFile()) return null;
	} catch {
		return null;
	}
	return sha256OfFile(node);
}

// One sha256 over every file of a staged package: each relative path with
// that file's sha256, in sorted order. Null when the tree holds anything but
// directories and regular files, or a file cannot be read. It covers the
// mcporter package itself; its dependencies stay pinned at install time by
// the lockfile.
export function packageDigest(root: string): string | null {
	const hash = createHash("sha256");
	const walk = (directory: string): boolean => {
		for (const name of readdirSync(directory).sort()) {
			const target = path.join(directory, name);
			const entry = lstatSync(target);
			if (entry.isDirectory()) {
				if (!walk(target)) return false;
				continue;
			}
			const digest = entry.isFile() ? sha256OfFile(target) : null;
			if (digest === null) return false;
			hash.update(`${path.relative(root, target)}\0${digest}\n`);
		}
		return true;
	};
	try {
		return lstatSync(root).isDirectory() && walk(root) ? hash.digest("hex") : null;
	} catch {
		return null;
	}
}

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

function recorded(text: string): StagedDigests | null {
	try {
		const value = JSON.parse(text) as { node?: unknown; nodeSha256?: unknown; mcporterSha256?: unknown } | null;
		const { node, nodeSha256, mcporterSha256 } = value ?? {};
		if (!isNodePath(node) || typeof nodeSha256 !== "string" || !SHA256.test(nodeSha256) || typeof mcporterSha256 !== "string" || !SHA256.test(mcporterSha256)) return null;
		const digests = { node, nodeSha256, mcporterSha256 };
		return text === releaseRecord(digests) ? digests : null;
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
	const digests = record === null ? null : recorded(record);
	const binary = path.join(root, "mcporter");
	const launcher = stat(binary);
	if (digests === null || !launcher?.isFile() || (launcher.mode & 0o100) === 0 || readText(binary) !== launcherText(digests.node)) return { ok: false, cause: "packaged-mcporter-invalid" };
	const packageRoot = path.join(root, "node_modules", "mcporter");
	if (packageVersion(readText(path.join(packageRoot, "package.json"))) !== PACKAGED_MCPORTER.version) return { ok: false, cause: "packaged-mcporter-invalid" };
	// Neither runs before its bytes match what the build recorded.
	if (nodeDigest(digests.node) !== digests.nodeSha256) return { ok: false, cause: "packaged-node-mismatch" };
	if (packageDigest(packageRoot) !== digests.mcporterSha256) return { ok: false, cause: "packaged-mcporter-mismatch" };
	const reported = run(binary);
	return reported.exitCode === 0 && reported.stdout === PACKAGED_MCPORTER.version ? { ok: true, binary } : { ok: false, cause: "version-invalid" };
}

// The plugin root of the running compiled front door: bin/connectors sits
// one level below it.
export const runningPluginRoot = (): string => path.resolve(path.dirname(process.execPath), "..");

// The repair for any refusal, a digest mismatch included: the staged copy
// and its recorded digests belong to the pilot build, so only a rebuild and
// reinstall of the plugin replaces them.
export const PACKAGED_REPAIR = "MCPorter is staged into the Linux pilot plugin at build time; rebuild the plugin with bun run build:pilot and reinstall it, and never edit the installed copy";

export const usesPackagedMcporter = (platform: string = process.platform): boolean => platform === "linux";
