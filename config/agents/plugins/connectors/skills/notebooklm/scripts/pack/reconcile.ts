// Read-back reconciliation. Item states come only from what the vendor read
// returned now: a notebook's title and sources and its paged Studio list. No
// state is remembered, settled or bound here.
import { type PackManifest, type Role, ROLES } from "./manifest.ts";
import type { LoadedSource } from "./sources.ts";

export type ItemState = "present" | "missing" | "duplicate" | "pending" | "failed" | "completed-unconfirmed" | "confirmed" | "superseded" | "stale" | "stale-sources" | "unknown" | "unmarked";
export interface Item { readonly key: string; readonly role: "notebook" | "source" | Role; readonly state: ItemState; readonly ids: readonly string[]; readonly evidence: Readonly<Record<string, unknown>> }
export interface NotebookRead { readonly id: string; readonly title: string; readonly sources: readonly { readonly id: string; readonly title: string }[] }
export interface StudioArtifact { readonly artifact_id: string; readonly title: string; readonly type: string; readonly status: string; readonly custom_instructions: string | null; readonly source_ids: readonly string[] | null; readonly duration_seconds: number | null }
export interface StudioRead { readonly artifacts: readonly StudioArtifact[]; readonly complete: boolean; readonly pages: number; readonly notebookUrl: string | null }

const packMarker = (packId: string): string => `[lp:${packId}]`;
// A role marker is the whole token lp:PACKID:ROLE or lp:PACKID:ROLE:NONCE.
const roleMarker = (packId: string, role: Role): RegExp => new RegExp(`(?<![\\w:-])lp:${packId}:${role}(?::[a-z0-9]+)?(?![\\w:-])`);
const startHereTitle = (packId: string): string => `Start Here ${packMarker(packId)}`;
const digestTitle = (source: Pick<LoadedSource, "key" | "digest">): string => `${source.key} [sha256:${source.digest.slice(0, 12)}]`;
const notebookMarked = (packId: string, title: string): boolean => new RegExp(`\\[lp:${packId}(?::[a-z0-9]+)?\\]`).test(title);

export function notebookItem(manifest: PackManifest, notebook: NotebookRead): Item {
	const marked = notebookMarked(manifest.pack.id, notebook.title) || notebook.sources.some((source) => source.title === startHereTitle(manifest.pack.id));
	return { key: "notebook", role: "notebook", state: marked ? "present" : "unmarked", ids: [notebook.id], evidence: { mode: manifest.notebook.mode, binding: "manifest", marked, adopt: manifest.notebook.adopt, writable: false } };
}

export function sourceItems(sources: readonly LoadedSource[], notebook: NotebookRead | null): Item[] {
	return sources.map((source) => {
		const title = source.title ?? digestTitle(source);
		const evidence = { digest: source.digest, match: source.title === null ? "digest-title" : "exact-title" };
		if (notebook === null) return { key: source.key, role: "source", state: "missing", ids: [], evidence };
		const exact = notebook.sources.filter((item) => item.title === title).map((item) => item.id);
		if (exact.length > 1) return { key: source.key, role: "source", state: "duplicate", ids: exact, evidence };
		if (exact.length === 1) return { key: source.key, role: "source", state: "present", ids: exact, evidence };
		const stale = source.title === null ? notebook.sources.filter((item) => item.title.startsWith(`${source.key} [sha256:`)).map((item) => item.id) : [];
		return { key: source.key, role: "source", state: stale.length > 0 ? "stale" : "missing", ids: stale, evidence };
	});
}

const generationState = (status: string): ItemState => {
	const value = status.toLowerCase();
	if (value === "completed") return "completed-unconfirmed";
	if (["in_progress", "queued", "pending", "generating"].includes(value)) return "pending";
	if (["failed", "error"].includes(value)) return "failed";
	return "unknown";
};
const ROLE_TYPES: Readonly<Record<Role, string>> = { mission: "quiz", audio: "audio", map: "mind_map" };

function artifactEvidence(manifest: PackManifest, role: Role, artifact: StudioArtifact, presentSources: readonly string[]): Record<string, unknown> {
	const marker = roleMarker(manifest.pack.id, role);
	const sourceIds = artifact.source_ids;
	return {
		type: artifact.type, status: artifact.status, typeMatches: artifact.type === ROLE_TYPES[role],
		customInstructions: artifact.custom_instructions === null ? "absent" : marker.test(artifact.custom_instructions) ? "marker" : "present",
		sourceIds: sourceIds === null ? null : { exposed: sourceIds.length, equalsPresentSources: sourcesMatch(sourceIds, presentSources) === true },
		durationSeconds: artifact.duration_seconds,
	};
}

// Set equality: a repeated id never stands in for a missing one. Absent ids
// are unknown; an explicit empty list is a source set like any other.
function sourcesMatch(sourceIds: readonly string[] | null, presentSources: readonly string[]): boolean | null {
	if (sourceIds === null) return null;
	const exposed = new Set(sourceIds);
	const present = new Set(presentSources);
	return exposed.size === present.size && [...present].every((id) => exposed.has(id));
}

// A completed artifact is stale-sources when a pack source changed or is
// absent from the notebook, or when its exposed source ids differ from the
// present pack sources (Appendix H).
export function roleItems(manifest: PackManifest, studio: StudioRead | null, sources: readonly Item[]): Item[] {
	const presentSources = sources.filter((item) => item.state === "present").flatMap((item) => item.ids);
	const sourcesChanged = sources.some((item) => item.state === "stale" || item.state === "missing");
	return ROLES.map((role) => {
		const spec = manifest.artifacts[role];
		const base = { key: role, role, evidence: { match: spec.id === null ? "marker" : "manifest-id" } } as const;
		if (studio === null) return { ...base, state: "missing" as const, ids: [] };
		const marker = roleMarker(manifest.pack.id, role);
		const found = spec.id === null
			? studio.artifacts.filter((artifact) => marker.test(artifact.title) || (artifact.custom_instructions !== null && marker.test(artifact.custom_instructions)))
			: studio.artifacts.filter((artifact) => artifact.artifact_id === spec.id);
		const ids = found.map((artifact) => artifact.artifact_id);
		if (found.length > 1) return { ...base, state: "duplicate" as const, ids };
		const [artifact] = found;
		if (artifact === undefined) return { ...base, state: studio.complete ? "missing" as const : "unknown" as const, ids, evidence: { ...base.evidence, scanComplete: studio.complete } };
		const generated = artifact.type === ROLE_TYPES[role] ? generationState(artifact.status) : "unknown";
		const stale = generated === "completed-unconfirmed" && (sourcesChanged || sourcesMatch(artifact.source_ids, presentSources) === false);
		return { ...base, state: stale ? "stale-sources" : generated, ids, evidence: { ...base.evidence, ...artifactEvidence(manifest, role, artifact, presentSources) } };
	});
}
