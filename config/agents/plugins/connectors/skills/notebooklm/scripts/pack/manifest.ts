// Learning Pack Manifest parser and defaults. The manifest is caller-authored
// pack data: it selects sources by name and names an existing notebook only in
// bind mode. Parsing never touches the filesystem or the vendor.
import { record } from "../policy.ts";

const TRIAL_NOTEBOOK_ID = "19ae491d-ea63-4da0-be29-aefcdbf8964e";
export const ROLES = ["mission", "audio", "map"] as const;
export type Role = (typeof ROLES)[number];
export const PACK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ROOT_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LENGTHS = ["short", "default", "long"] as const;
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Length = (typeof LENGTHS)[number];

export interface Provenance { readonly repo: string; readonly commit: string; readonly subtree: string; readonly plugin: string; readonly vendor: string }
export interface SourceEntry { readonly key: string; readonly file: string; readonly title: string | null }
export interface RoleSpec { readonly role: Role; readonly type: "quiz" | "audio" | "mind_map"; readonly id: string | null; readonly settings: Readonly<Record<string, string | number>> }
export interface PackManifest {
	readonly pack: { readonly id: string; readonly title: string; readonly request: string; readonly provenance: Provenance };
	readonly notebook: { readonly mode: "create-if-needed" | "bind"; readonly id: string | null; readonly adopt: boolean };
	readonly sourceRoot: string;
	readonly sources: readonly SourceEntry[];
	readonly artifacts: Readonly<Record<Role, RoleSpec>>;
	readonly preferences: { readonly audioLength: Length; readonly deeper: boolean };
}
export type ManifestCause = "pack-manifest-invalid" | "pack-notebook-adopt-refused";
export type ManifestResult = { readonly ok: true; readonly manifest: PackManifest } | { readonly ok: false; readonly cause: ManifestCause };

class Invalid extends Error {}
const fail = (): never => { throw new Invalid(); };
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail();
	return value as Record<string, unknown>;
}
const optionalObject = (value: unknown, allowed: readonly string[]): Record<string, unknown> => value === undefined ? {} : object(value, allowed);
function text(value: unknown, max: number, pattern?: RegExp): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || (pattern && !pattern.test(value))) fail();
	return value as string;
}
function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	return options.includes(value as T) ? value as T : fail();
}
function flag(value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return typeof value === "boolean" ? value : fail();
}
function fixedType<T extends string>(value: unknown, type: T): T {
	return value === undefined || value === type ? type : fail();
}

function provenance(value: unknown): Provenance {
	const fields = object(value, ["repo", "commit", "subtree", "plugin", "vendor"]);
	const subtree = text(fields.subtree, 300);
	if (subtree.startsWith("/") || subtree.split("/").some((part) => part === ".." || part === "")) fail();
	return { repo: text(fields.repo, 200, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commit: text(fields.commit, 40, /^[0-9a-f]{7,40}$/), subtree, plugin: text(fields.plugin, 80), vendor: text(fields.vendor, 80) };
}

function sources(value: unknown): SourceEntry[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 50) fail();
	const entries = (value as unknown[]).map((item) => {
		const fields = object(item, ["key", "file", "title"]);
		// The file name is checked for containment by sources.ts, so a path-like
		// name refuses there with the containment cause rather than here.
		return { key: text(fields.key, 48, KEY), file: text(fields.file, 255), title: fields.title === undefined ? null : text(fields.title, 200) };
	});
	if (new Set(entries.map((entry) => entry.key)).size !== entries.length || new Set(entries.map((entry) => entry.file)).size !== entries.length) fail();
	return entries;
}

function artifactId(value: unknown, mode: string): string | null {
	if (value === undefined) return null;
	if (mode !== "bind") fail();
	return text(value, 36, UUID);
}

function artifacts(value: unknown, mode: string, audioLength: Length): Record<Role, RoleSpec> {
	const fields = optionalObject(value, ROLES);
	const mission = optionalObject(fields.mission, ["type", "questions", "difficulty", "id"]);
	const audio = optionalObject(fields.audio, ["type", "format", "length", "id"]);
	const map = optionalObject(fields.map, ["type", "id"]);
	const questions = mission.questions ?? 5;
	if (typeof questions !== "number" || !Number.isSafeInteger(questions) || questions < 1 || questions > 10) fail();
	return {
		mission: { role: "mission", type: fixedType(mission.type, "quiz"), id: artifactId(mission.id, mode), settings: { questions: questions as number, difficulty: choice(mission.difficulty, DIFFICULTIES, "easy") } },
		audio: { role: "audio", type: fixedType(audio.type, "audio"), id: artifactId(audio.id, mode), settings: { format: fixedType(audio.format, "deep_dive"), length: choice(audio.length, LENGTHS, audioLength) } },
		map: { role: "map", type: fixedType(map.type, "mind_map"), id: artifactId(map.id, mode), settings: {} },
	};
}

export function parseManifest(value: unknown): ManifestResult {
	try {
		const top = object(value, ["schemaVersion", "pack", "notebook", "sourceRoot", "sources", "artifacts", "preferences"]);
		if (top.schemaVersion !== 1) fail();
		const pack = object(top.pack, ["id", "title", "request", "provenance"]);
		const notebook = optionalObject(top.notebook, ["mode", "id", "adopt"]);
		const mode = choice(notebook.mode, ["create-if-needed", "bind"] as const, "create-if-needed");
		const id = notebook.id === undefined ? null : text(notebook.id, 36, UUID);
		if ((mode === "bind") !== (id !== null)) fail();
		const adopt = flag(notebook.adopt, false);
		if (adopt && mode !== "bind") fail();
		const preferences = optionalObject(top.preferences, ["audioLength", "deeper"]);
		const audioLength = choice(preferences.audioLength, LENGTHS, "short");
		const manifest: PackManifest = {
			pack: { id: text(pack.id, 63, PACK_ID), title: text(pack.title, 200), request: text(pack.request, 500), provenance: provenance(pack.provenance) },
			notebook: { mode, id, adopt },
			sourceRoot: text(top.sourceRoot, 32, ROOT_LABEL),
			sources: sources(top.sources),
			artifacts: artifacts(top.artifacts, mode, audioLength),
			preferences: { audioLength, deeper: flag(preferences.deeper, false) },
		};
		// K3: the trial notebook stays read-only; no manifest may adopt it.
		if (adopt && id === TRIAL_NOTEBOOK_ID) return { ok: false, cause: "pack-notebook-adopt-refused" };
		return { ok: true, manifest };
	} catch (error) {
		if (error instanceof Invalid) return { ok: false, cause: "pack-manifest-invalid" };
		throw error;
	}
}

// The resolved defaults a caller can compare with what they wrote.
export function manifestDefaults(manifest: PackManifest): Record<string, unknown> {
	return {
		notebook: { mode: manifest.notebook.mode, adopt: manifest.notebook.adopt },
		artifacts: Object.fromEntries(ROLES.map((role) => [role, { type: manifest.artifacts[role].type, ...manifest.artifacts[role].settings, bound: manifest.artifacts[role].id !== null }])),
		preferences: manifest.preferences,
	};
}
