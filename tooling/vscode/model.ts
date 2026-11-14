import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export class Refusal extends Error {
	constructor(public readonly kind: "usage" | "schema" | "domain" | "transient", message: string) {
		super(message);
	}
}

export function requireValue(condition: unknown, message: string, kind: Refusal["kind"] = "domain"): asserts condition {
	if (!condition) throw new Refusal(kind, message);
}

export function object(value: unknown): Record<string, unknown> {
	requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object; repair the input file.", "schema");
	return value as Record<string, unknown>;
}

export function strings(value: unknown): string[] {
	requireValue(Array.isArray(value) && value.every((item) => typeof item === "string"), "Expected a string array; repair the input file.", "schema");
	return value;
}

export function json(text: string): unknown {
	try {
		return Bun.JSONC.parse(text);
	} catch {
		throw new Refusal("schema", "Invalid JSONC; repair the input file.");
	}
}

export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function file(path: string): string | null {
	try {
		const stat = lstatSync(path);
		requireValue(stat.isFile() && stat.nlink === 1, "Expected a regular, unlinked file. Resolve symlinks or hardlinks manually.");
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export function directory(path: string): string {
	requireValue(isAbsolute(path), "Use an absolute directory path.", "usage");
	const canonical = realpathSync(path);
	const stat = lstatSync(path);
	requireValue(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0, "Directory must be owned by this user and not writable by others.");
	return canonical;
}

export function targetPaths(target: string) {
	const root = directory(target);
	const userData = join(root, "user-data");
	const user = join(userData, "User");
	const extensions = join(root, "extensions");
	for (const path of [userData, user, extensions]) {
		requireValue(directory(path) === path, "Isolated directories must not resolve through symlinks.");
	}
	return { root, userData, extensions, user };
}

const sourceRoot = resolve(import.meta.dir, "../../config/vscode");
const sourceFiles = ["settings.json", "keybindings.json", "isolated.json", "extensions.json"];

function versions(value: unknown): Record<string, string> {
	const entries = Object.entries(object(value));
	requireValue(entries.every(([id, version]) => /^[a-z0-9-]+\.[a-z0-9-]+$/.test(id) && typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)), "Extension IDs and exact versions are required.", "schema");
	return Object.fromEntries(entries) as Record<string, string>;
}

export function sources() {
	const bytes = sourceFiles.map((name) => {
		const text = file(join(sourceRoot, name));
		requireValue(text !== null, "A shared configuration source is missing.", "schema");
		return text;
	});
	const [settingsText = "", bindings = "", policyText = "", extensionsText = ""] = bytes;
	const settings = object(json(settingsText));
	requireValue(Array.isArray(json(bindings)), "Keybindings must be a JSONC array.", "schema");
	const policy = object(json(policyText));
	const manifest = object(json(extensionsText));
	const client = versions(manifest.client);
	const protectedVersions = versions(manifest.protected);
	const local = versions(manifest.local);
	const workspace = strings(manifest.workspace);
	requireValue(workspace.every((id) => /^[a-z0-9-]+\.[a-z0-9-]+$/.test(id)), "Invalid workspace extension ID.", "schema");
	const ids = [...Object.keys(client), ...Object.keys(protectedVersions), ...Object.keys(local), ...workspace];
	requireValue(new Set(ids).size === ids.length, "Each extension must have exactly one location declaration.", "schema");
	const excluded = strings(policy.excludedPrefixes);
	const personal = Object.fromEntries(Object.entries(settings).filter(([key]) => !excluded.some((prefix) => key.startsWith(prefix))));
	return {
		hash: digest(serialize(bytes)), bindings, personal,
		policy: { ...object(policy.settings), "dev.containers.defaultExtensions": workspace },
		client, protectedVersions, local, workspace,
	};
}

export function inventory(extensions: string): Record<string, string> {
	const text = file(join(extensions, "extensions.json"));
	const data = text === null ? [] : json(text);
	requireValue(Array.isArray(data), "Native extensions registry must be an array.", "schema");
	const entries = data.map((item) => {
		const row = object(item);
		const id = object(row.identifier).id;
		requireValue(typeof id === "string" && typeof row.version === "string", "Malformed native extension registry.", "schema");
		return [id.toLowerCase(), row.version] as const;
	});
	requireValue(new Set(entries.map(([id]) => id)).size === entries.length, "Duplicate installed extension identities need manual inspection.");
	return Object.fromEntries(entries);
}

export function snapshot(target: string) {
	const paths = targetPaths(target);
	return {
		settings: file(join(paths.user, "settings.json")),
		keybindings: file(join(paths.user, "keybindings.json")),
		extensions: inventory(paths.extensions),
	};
}

export type Snapshot = ReturnType<typeof snapshot>;
export type Configuration = Pick<Snapshot, "settings" | "keybindings">;

export function compose(before: Snapshot, previouslyOwned: string[] = []): Configuration {
	const source = sources();
	// Preserve target-only controls, but let authored personal preferences update.
	const existing = Object.fromEntries(Object.entries(before.settings === null ? {} : object(json(before.settings))).filter(([key]) => !previouslyOwned.includes(key)));
	return {
		settings: serialize({ ...existing, ...source.personal, ...source.policy }),
		keybindings: source.bindings,
	};
}
