// The local Start Here view: one primary action (the mission) and two links
// (audio and map), built only from read-back artifact ids and the vendor's
// notebook URL. Rendered text comes from the packaged template.
import template from "../../references/templates/start-here.md" with { type: "text" };
import type { PackManifest, Role } from "./manifest.ts";
import type { Item } from "./reconcile.ts";

export interface StartHereEntry { readonly role: Role; readonly label: string; readonly state: string; readonly artifactId: string | null; readonly url: string | null }
export interface StartHere { readonly primary: StartHereEntry; readonly links: readonly [StartHereEntry, StartHereEntry]; readonly next: string; readonly text: string }

const LABELS: Readonly<Record<Role, string>> = { mission: "5-minute mission", audio: "Short Deep Dive audio", map: "Map" };
const plain = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 120);

function entry(items: readonly Item[], role: Role, notebookUrl: string | null): StartHereEntry {
	const item = items.find((candidate) => candidate.role === role);
	const state = item?.state ?? "missing";
	const artifactId = item !== undefined && item.ids.length === 1 && state !== "duplicate" ? (item.ids[0] ?? null) : null;
	return { role, label: LABELS[role], state, artifactId, url: artifactId === null ? null : notebookUrl };
}

function nextAction(notebook: Item | undefined, primary: StartHereEntry): string {
	if (notebook === undefined || notebook.state === "missing") return "No notebook is bound. Pack creation is not admitted in this release; bind an existing notebook with notebook.mode bind.";
	if (notebook.state === "unknown") return "A pack-marked notebook may exist. Name it in the manifest with notebook.mode bind; nothing was bound.";
	switch (primary.state) {
		case "completed-unconfirmed": return "Open the mission in the notebook full view and confirm it renders before calling it ready.";
		case "confirmed": return "Start the mission.";
		case "pending": return "Generation is still pending. Read pack status again later.";
		case "stale-sources": return "The mission was built from sources that changed since. Regeneration is not admitted in this release.";
		case "duplicate": return "More than one mission carries this pack's marker. Name one artifact id in the manifest.";
		case "failed": return "The mission generation failed. Regeneration is not admitted in this release.";
		case "missing": return "No mission was found. Generation is not admitted in this release.";
		default: return "The mission state is unknown. Read pack status again, then inspect the notebook full view.";
	}
}

const line = (value: StartHereEntry): string => `${value.state}${value.artifactId === null ? "" : ` (artifact ${value.artifactId})`}${value.url === null ? "" : ` ${value.url}`}`;

export function startHere(manifest: PackManifest, items: readonly Item[], notebookUrl: string | null): StartHere {
	const notebook = items.find((item) => item.role === "notebook");
	const primary = entry(items, "mission", notebookUrl);
	const links = [entry(items, "audio", notebookUrl), entry(items, "map", notebookUrl)] as const;
	const next = nextAction(notebook, primary);
	const values: Record<string, string> = {
		title: plain(manifest.pack.title),
		status: `Notebook: ${notebook?.state ?? "missing"}. Sources: ${items.filter((item) => item.role === "source" && item.state === "present").length} of ${manifest.sources.length} present.`,
		primary: line(primary), audio: line(links[0]), map: line(links[1]), next,
	};
	return { primary, links, next, text: template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "") };
}
