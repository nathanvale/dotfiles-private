// The two learning-pack reads. pack_check inspects local pack files and starts
// no child. pack_status resolves the notebook only from the manifest's bind
// mode (LP-1 records no bindings), reads it, and never creates anything.
import os from "node:os";
import path from "node:path";
import type { AdapterRequest, Executed, Prepared } from "../../../../bin/adapters/contract.ts";
import { record } from "../policy.ts";
import type { Caller } from "../transport.ts";
import { manifestDefaults, type PackManifest } from "./manifest.ts";
import { checkSource, sourceReady } from "./provenance.ts";
import { type Item, type NotebookRead, notebookItem, roleItems, type StudioArtifact, type StudioRead, sourceItems } from "./reconcile.ts";
import { type LoadedPack, type LoadedSource, loadPack, type PackCause } from "./sources.ts";
import { startHere } from "./start-here.ts";

export const PACK_READS = ["pack_check", "pack_status"] as const;
export type PackRead = (typeof PACK_READS)[number];
export const isPackRead = (name: string): name is PackRead => (PACK_READS as readonly string[]).includes(name);
export type Execute = (step: (client: Caller) => Promise<Executed>) => Prepared;

const STUDIO_PAGE = 20;
const STUDIO_PAGES = 2;
const REPAIRS: Readonly<Record<PackCause | "pack-notebook-unverified", string>> = {
	"pack-root-unregistered": "Register the pack root's real path by label in this host's NotebookLM pack-roots file, then name ROOT/PACKID/manifest.json",
	"pack-roots-invalid": "Restore the pack-roots registration as an owned 0600 JSON object with schemaVersion 1 and absolute real root paths",
	"pack-root-invalid": "Register the root's real path; the registered root must be a directory with no symlink in its path",
	"pack-manifest-invalid": "Correct the Learning Pack Manifest: its pack id must equal its folder, its sourceRoot must equal the registered label, and every field must match the reference",
	"pack-notebook-adopt-refused": "The trial notebook is read-only and cannot be adopted; remove adopt or bind another notebook",
	"pack-source-not-contained": "Name each source as a plain file inside ROOT/PACKID/sources; symlinks, nested paths and special files are refused",
	"pack-source-missing": "Create every selected source file inside ROOT/PACKID/sources before checking the pack",
	"pack-source-too-large": "Keep each selected source at or below 256 KiB",
	"pack-source-invalid": "Store each selected source as UTF-8 text",
	"pack-notebook-unverified": "notebook_get did not verify the bound notebook id; check the id and profile, then read pack status again. Nothing was created",
};
const refused = (cause: keyof typeof REPAIRS): Prepared => ({ kind: "refused", refusal: { kind: "domain", connectorCause: cause, repair: REPAIRS[cause] } });
const refusal = (cause: keyof typeof REPAIRS): Executed => ({ kind: "refused", refusal: { kind: "domain", connectorCause: cause, repair: REPAIRS[cause] } });

function manifestPath(input: Readonly<Record<string, unknown>> | null): string | null {
	if (!record(input) || Object.keys(input).length !== 1 || typeof input.manifest !== "string") return null;
	const value = input.manifest;
	return value.length <= 4096 && !value.includes("\0") && path.isAbsolute(value) && path.normalize(value) === value ? value : null;
}

const packSummary = (manifest: PackManifest) => ({ id: manifest.pack.id, title: manifest.pack.title });

function inspect(loaded: Extract<LoadedPack, { ok: true }>): Record<string, unknown> {
	const host = os.hostname();
	const sources = loaded.sources.map((source) => {
		const verdict = checkSource(source.text, loaded.manifest, host);
		return { key: source.key, file: source.file, digest: source.digest, bytes: source.bytes, provenance: verdict.provenance, labels: verdict.labels, ready: sourceReady(verdict) };
	});
	return { operation: "pack_check", pack: packSummary(loaded.manifest), defaults: manifestDefaults(loaded.manifest), sources, ready: sources.every((source) => source.ready) };
}

async function studioRead(client: Caller, notebookId: string): Promise<StudioRead | { cause: string }> {
	const artifacts: StudioArtifact[] = [];
	const seen = new Set<string>();
	let notebookUrl: string | null = null;
	for (let page = 0; page < STUDIO_PAGES; page += 1) {
		const reply = await client.internal("studio_marker", { notebook_id: notebookId, include_details: true, limit: STUDIO_PAGE, offset: page * STUDIO_PAGE });
		if (!reply.ok) return { cause: reply.cause };
		// Pages can overlap when the list shifts; one artifact id is one artifact.
		for (const artifact of reply.data.artifacts as StudioArtifact[]) if (!seen.has(artifact.artifact_id)) { seen.add(artifact.artifact_id); artifacts.push(artifact); }
		notebookUrl ??= reply.data.notebook_url as string | null;
		const more = reply.data.has_more;
		if (more === false) return { artifacts, complete: true, pages: page + 1, notebookUrl };
		if (more === null) return { artifacts, complete: false, pages: page + 1, notebookUrl };
	}
	return { artifacts, complete: false, pages: STUDIO_PAGES, notebookUrl };
}


async function bound(client: Caller, manifest: PackManifest, sources: readonly LoadedSource[], notebookId: string): Promise<Executed | { items: Item[]; studio: Record<string, unknown>; notebook: NotebookRead; notebookUrl: string | null }> {
	const reply = await client.call("notebook_get", { notebook_id: notebookId });
	const value = reply.ok ? reply.data : null;
	if (value === null || !record(value.notebook) || value.notebook.id !== notebookId) return refusal("pack-notebook-unverified");
	const notebook: NotebookRead = { id: notebookId, title: String(value.notebook.title), sources: value.sources as NotebookRead["sources"] };
	const sourceRows = sourceItems(sources, notebook);
	const studio = await studioRead(client, notebookId);
	if ("cause" in studio) {
		const unknown = roleItems(manifest, { artifacts: [], complete: false, pages: 0, notebookUrl: null }, sourceRows);
		return { items: [notebookItem(manifest, notebook), ...sourceRows, ...unknown], studio: { read: "failed", cause: studio.cause }, notebook, notebookUrl: null };
	}
	return { items: [notebookItem(manifest, notebook), ...sourceRows, ...roleItems(manifest, studio, sourceRows)], studio: { read: "completed", pages: studio.pages, complete: studio.complete, seen: studio.artifacts.length }, notebook, notebookUrl: studio.notebookUrl };
}

async function unbound(client: Caller, manifest: PackManifest, sources: readonly LoadedSource[]): Promise<{ items: Item[]; scan: Record<string, unknown> }> {
	const reply = await client.internal("notebook_scan", { max_results: 20 });
	const notebooks = reply.ok ? (reply.data.notebooks as { id: string; title: string }[]) : [];
	const total = reply.ok ? (reply.data.total as number | null) : null;
	const marked = notebooks.filter((notebook) => notebookItem(manifest, { ...notebook, sources: [] }).state === "present").map((notebook) => notebook.id);
	const scan = reply.ok
		? { read: "completed", advisory: true, seen: notebooks.length, total, complete: total !== null && notebooks.length >= total, marked }
		: { read: "failed", advisory: true, cause: reply.cause };
	const notebook: Item = { key: "notebook", role: "notebook", state: marked.length > 0 ? "unknown" : "missing", ids: [], evidence: { mode: manifest.notebook.mode, binding: "none", scan: "advisory" } };
	return { items: [notebook, ...sourceItems(sources, null), ...roleItems(manifest, null, [])], scan };
}

function status(request: AdapterRequest, loaded: Extract<LoadedPack, { ok: true }>, execute: Execute): Prepared {
	const { manifest, sources } = loaded;
	const ready = sources.every((source) => sourceReady(checkSource(source.text, manifest, os.hostname())));
	return execute(async (client) => {
		const base = { operation: "pack_status", profile: request.selectors.profile, pack: packSummary(manifest), check: { ready } };
		if (manifest.notebook.id === null) {
			const { items, scan } = await unbound(client, manifest, sources);
			return { kind: "success", data: { ...base, notebook: { id: null, mode: manifest.notebook.mode, binding: "none", state: items[0]?.state }, scan, items, startHere: startHere(manifest, items, null) } };
		}
		const result = await bound(client, manifest, sources, manifest.notebook.id);
		if ("kind" in result) return result;
		const { items, notebook, notebookUrl } = result;
		return { kind: "success", data: { ...base, notebook: { id: notebook.id, title: notebook.title, mode: manifest.notebook.mode, binding: "manifest", state: items[0]?.state, url: notebookUrl }, studio: result.studio, items, startHere: startHere(manifest, items, notebookUrl) } };
	});
}

export function packRead(request: AdapterRequest, name: PackRead, input: Readonly<Record<string, unknown>> | null, execute: Execute): Prepared {
	const file = manifestPath(input);
	if (file === null) return { kind: "refused", refusal: { kind: "schema", connectorCause: "input-invalid", repair: "Supply --input with exactly one field, manifest, the absolute path of ROOT/PACKID/manifest.json" } };
	const loaded = loadPack(file, request.env);
	if (!loaded.ok) return refused(loaded.cause);
	return name === "pack_check" ? { kind: "inspected", data: inspect(loaded) } : status(request, loaded, execute);
}
