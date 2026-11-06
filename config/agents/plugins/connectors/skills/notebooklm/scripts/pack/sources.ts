// Pack root containment (K1). A pack lives at ROOT/PACKID with its manifest at
// ROOT/PACKID/manifest.json and its sources in ROOT/PACKID/sources. ROOT must
// be registered by label on this host; nothing below an unregistered path is
// opened. Only files the manifest names are opened, each without following a
// symlink, and every source is checked before any source is read.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { readPrivateFile, stateRoot } from "../../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { record } from "../policy.ts";
import { type PackManifest, PACK_ID, parseManifest, ROOT_LABEL, type SourceEntry } from "./manifest.ts";

const MANIFEST_FILE = "manifest.json";
const MANIFEST_MAX_BYTES = 64 * 1024;
const SOURCE_MAX_BYTES = 256 * 1024;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type PackCause =
	| "pack-root-unregistered" | "pack-roots-invalid" | "pack-root-invalid" | "pack-manifest-invalid" | "pack-notebook-adopt-refused"
	| "pack-source-not-contained" | "pack-source-missing" | "pack-source-too-large" | "pack-source-invalid";
export interface LoadedSource extends SourceEntry { readonly digest: string; readonly bytes: number; readonly text: string }
export type LoadedPack = { readonly ok: true; readonly manifest: PackManifest; readonly sources: readonly LoadedSource[] } | { readonly ok: false; readonly cause: PackCause };

const packRootsFile = (env: EnvironmentSource): string => path.join(stateRoot(env), "connectors", "notebooklm", "pack-roots.json");

type Roots = { ok: true; roots: [string, string][] } | { ok: false; cause: PackCause };
function registeredRoots(env: EnvironmentSource): Roots {
	const file = readPrivateFile(packRootsFile(env), 16 * 1024);
	if (!file.ok) return { ok: false, cause: file.reason === "absent" ? "pack-root-unregistered" : "pack-roots-invalid" };
	let value: unknown;
	try { value = JSON.parse(file.text); } catch { return { ok: false, cause: "pack-roots-invalid" }; }
	if (!record(value) || value.schemaVersion !== 1 || !record(value.roots) || Object.keys(value).length !== 2) return { ok: false, cause: "pack-roots-invalid" };
	const roots = Object.entries(value.roots);
	if (roots.length > 32 || roots.some(([label, root]) => !ROOT_LABEL.test(label) || typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root || root.endsWith(path.sep))) return { ok: false, cause: "pack-roots-invalid" };
	return { ok: true, roots: roots as [string, string][] };
}

const kind = (target: string): "directory" | "file" | "symlink" | "other" | "absent" => {
	try {
		const stats = lstatSync(target);
		return stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
	} catch { return "absent"; }
};

// A selected file as its path check saw it. The read must open this same
// single-link inode: a hard link could name a file outside the pack, and a
// directory swapped for a symlink after the check would open another inode.
interface Checked { readonly file: string; readonly dev: number; readonly ino: number }
type Read = { ok: true; bytes: Buffer } | { ok: false; reason: "absent" | "not-contained" | "too-large" };
function readContained(checked: Checked, max: number): Read {
	let fd: number;
	try { fd = openSync(checked.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { return { ok: false, reason: (error as { code?: unknown }).code === "ENOENT" ? "absent" : "not-contained" }; }
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.nlink !== 1 || stats.dev !== checked.dev || stats.ino !== checked.ino) return { ok: false, reason: "not-contained" };
		if (stats.size > max) return { ok: false, reason: "too-large" };
		const bytes = Buffer.alloc(max + 1);
		let size = 0;
		while (size < bytes.length) {
			const count = readSync(fd, bytes, size, bytes.length - size, null);
			if (count === 0) break;
			size += count;
		}
		return size > max ? { ok: false, reason: "too-large" } : { ok: true, bytes: bytes.subarray(0, size) };
	} finally { closeSync(fd); }
}
const utf8 = (bytes: Buffer): string | null => {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
};
const inside = (child: string, parent: string): boolean => child.startsWith(`${parent}${path.sep}`);

type Step<T> = { ok: true; value: T } | { ok: false; cause: PackCause };
const refuse = (cause: PackCause): { ok: false; cause: PackCause } => ({ ok: false, cause });
const directoryCause = (target: string): PackCause | null => {
	const found = kind(target);
	return found === "directory" ? null : found === "absent" ? "pack-source-missing" : "pack-source-not-contained";
};
const readCause = (reason: "absent" | "not-contained" | "too-large", tooLarge: PackCause): PackCause => reason === "absent" ? "pack-source-missing" : reason === "too-large" ? tooLarge : "pack-source-not-contained";

// The registered root that holds ROOT/PACKID/manifest.json, as a real directory.
function packLocation(manifestPath: string, env: EnvironmentSource): Step<{ label: string; packDir: string; packId: string }> {
	const registered = registeredRoots(env);
	if (!registered.ok) return registered;
	const packDir = path.dirname(manifestPath);
	const match = registered.roots.find(([, root]) => path.dirname(packDir) === root && path.basename(manifestPath) === MANIFEST_FILE);
	if (!match) return refuse("pack-root-unregistered");
	const [label, root] = match;
	const packId = path.basename(packDir);
	if (!PACK_ID.test(packId)) return refuse("pack-manifest-invalid");
	let realRoot: string;
	try { realRoot = realpathSync(root); } catch { return refuse("pack-root-invalid"); }
	if (realRoot !== root || kind(root) !== "directory") return refuse("pack-root-invalid");
	const packCause = directoryCause(packDir);
	return packCause === null ? { ok: true, value: { label, packDir, packId } } : refuse(packCause);
}

function readManifest(manifestPath: string, packDir: string, label: string, packId: string): Step<PackManifest> {
	const checked = checkedFile(manifestPath, packDir);
	if (!checked.ok) return checked;
	const bytes = readContained(checked.value, MANIFEST_MAX_BYTES);
	if (!bytes.ok) return refuse(readCause(bytes.reason, "pack-manifest-invalid"));
	let value: unknown;
	try { value = JSON.parse(utf8(bytes.bytes) ?? ""); } catch { return refuse("pack-manifest-invalid"); }
	const parsed = parseManifest(value);
	if (!parsed.ok) return parsed;
	return parsed.manifest.pack.id === packId && parsed.manifest.sourceRoot === label ? { ok: true, value: parsed.manifest } : refuse("pack-manifest-invalid");
}

function checkedFile(file: string, directory: string): Step<Checked> {
	let stats: ReturnType<typeof lstatSync>;
	try { stats = lstatSync(file); } catch { return refuse("pack-source-missing"); }
	if (!stats.isFile() || stats.nlink !== 1) return refuse("pack-source-not-contained");
	try { return inside(realpathSync(file), directory) ? { ok: true, value: { file, dev: stats.dev, ino: stats.ino } } : refuse("pack-source-not-contained"); }
	catch { return refuse("pack-source-not-contained"); }
}

// Every selected path is checked before any selected source is read.
function containedFile(sourceDir: string, name: string): Step<Checked> {
	if (!SOURCE_NAME.test(name) || name.includes("..")) return refuse("pack-source-not-contained");
	return checkedFile(path.join(sourceDir, name), sourceDir);
}

function readSource(entry: SourceEntry, checked: Checked): Step<LoadedSource> {
	const bytes = readContained(checked, SOURCE_MAX_BYTES);
	if (!bytes.ok) return refuse(readCause(bytes.reason, "pack-source-too-large"));
	const text = utf8(bytes.bytes);
	if (text === null || text.includes("\0")) return refuse("pack-source-invalid");
	return { ok: true, value: { ...entry, digest: createHash("sha256").update(bytes.bytes).digest("hex"), bytes: bytes.bytes.length, text } };
}

export function loadPack(manifestPath: string, env: EnvironmentSource): LoadedPack {
	const location = packLocation(manifestPath, env);
	if (!location.ok) return location;
	const { label, packDir, packId } = location.value;
	const manifest = readManifest(manifestPath, packDir, label, packId);
	if (!manifest.ok) return manifest;
	const sourceDir = path.join(packDir, "sources");
	const sourceCause = directoryCause(sourceDir);
	if (sourceCause !== null) return refuse(sourceCause);
	const files: Checked[] = [];
	for (const entry of manifest.value.sources) {
		const file = containedFile(sourceDir, entry.file);
		if (!file.ok) return file;
		files.push(file.value);
	}
	const sources: LoadedSource[] = [];
	for (const [index, entry] of manifest.value.sources.entries()) {
		const source = readSource(entry, files[index] as Checked);
		if (!source.ok) return source;
		sources.push(source.value);
	}
	return { ok: true, manifest: manifest.value, sources };
}
