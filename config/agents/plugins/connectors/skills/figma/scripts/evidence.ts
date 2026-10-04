// Figma read-back: what a read observed, and whether it proves a write's
// effect, proves the object still stands at its baseline, or proves nothing.
// Read-back parsing is deliberately shape-light: it looks for exact requested
// values, identifiers, versions, and statuses anywhere in a result, so an
// unfamiliar result shape degrades to "none" (an unknown effect), never to a
// false completion.
import { type Call, sha256, type WriteInput } from "./catalogue.ts";
import type { Baseline } from "./journal.ts";
import type { Caller, CallResult } from "./transport.ts";

export interface Observation {
	readonly text: string;
	readonly baseline: Baseline;
	readonly statuses: string[];
}
export type Observed = { ok: true; observation: Observation } | { ok: false; result: Extract<CallResult, { ok: false }> };
export type Evidence = { proof: "completed"; ids: string[] } | { proof: "baseline" } | { proof: "none" };

const ID_KEYS = new Set(["id", "runId"]);
const FILE_KEYS = new Set(["fileKey", "file_key"]);
const FILE_URL = /figma\.com\/(?:design|board|slides|file)\/([A-Za-z0-9]{10,})/g;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED"]);

function walk(value: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit, key);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [name, item] of Object.entries(value)) {
			if (name !== "_meta") walk(item, visit, name);
		}
		return;
	}
	visit(key, value);
}

// MCPorter prints a tool's JSON text content as the result itself; any text
// that is JSON is read through, so identifiers inside it are found too.
function expand(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return expand(JSON.parse(value));
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) return value.map(expand);
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_meta").map(([key, item]) => [key, expand(item)]));
	return value;
}

function collect(data: unknown, keys: ReadonlySet<string>): string[] {
	const found: string[] = [];
	walk(data, (key, value) => {
		if (keys.has(key) && (typeof value === "string" || typeof value === "number")) found.push(String(value));
	});
	return [...new Set(found)].sort();
}

// Node ids inside an XML outline such as get_metadata's.
const XML_ID = / id="([^"]+)"/g;
function xmlIds(data: unknown): string[] {
	const found: string[] = [];
	walk(data, (_key, value) => {
		if (typeof value === "string") for (const match of value.matchAll(XML_ID)) found.push(match[1] as string);
	});
	return found;
}

function observationOf(data: unknown): Observation {
	const expanded = expand(data);
	const text = JSON.stringify(expanded);
	const versions = collect(expanded, new Set(["version"]));
	const ids = [...new Set([...collect(expanded, ID_KEYS), ...xmlIds(expanded)])].sort();
	return { text, baseline: { digest: sha256(text), ids, version: versions.length === 1 ? (versions[0] as string) : null }, statuses: collect(expanded, new Set(["status"])) };
}

export async function observe(call: Call, caller: Caller): Promise<Observed> {
	const read = await caller.call(call);
	return read.ok ? { ok: true, observation: observationOf(read.data) } : { ok: false, result: read };
}

// The one created file a reply names, by key or by Figma URL, else null.
function fileKeyOf(data: unknown): string | null {
	const expanded = expand(data);
	const keys = new Set(collect(expanded, FILE_KEYS));
	walk(expanded, (_key, value) => {
		if (typeof value === "string") for (const match of value.matchAll(FILE_URL)) keys.add(match[1] as string);
	});
	return keys.size === 1 ? ([...keys][0] as string) : null;
}

export const runIdsOf = (data: unknown): string[] => collect(expand(data), new Set(["runId", "runIds"]));
export const statusOf = (data: unknown): string[] => collect(expand(data), new Set(["status"]));
export function costOf(data: unknown): number | null {
	const costs = collect(expand(data), new Set(["cost"])).map(Number).filter(Number.isFinite);
	return costs.length === 1 ? (costs[0] as number) : null;
}

const allPresent = (marks: string[], text: string): boolean => marks.length > 0 && marks.every((mark) => text.includes(JSON.stringify(mark).slice(1, -1)));

// A refusal cause when the baseline already shows the requested effect, lacks
// a required value, or cannot tell a new object apart; null when clear.
export function baselineRefusal(write: WriteInput, observation: Observation): string | null {
	const { spec, input } = write;
	const required = spec.require?.(input) ?? [];
	if (required.length > 0 && !allPresent(required, observation.text)) return "destination-unknown";
	const marks = spec.marks(input);
	if (spec.evidence === "marks" && allPresent(marks, observation.text)) return "already-present";
	if (spec.evidence === "new-id" && allPresent(marks, observation.text)) return "name-exists";
	if (spec.evidence === "reply-target" && allPresent(marks, observation.text)) return "already-present";
	if (spec.evidence === "canceled" && observation.statuses.length > 0 && observation.statuses.every((status) => TERMINAL.has(status))) return "runs-finished";
	return null;
}

export const newIds = (baseline: Baseline, observation: Observation): string[] => observation.baseline.ids.filter((id) => !baseline.ids.includes(id));

type Rule = (write: WriteInput, baseline: Baseline, observation: Observation, unchanged: Evidence) => Evidence;

const completed = (ids: string[]): Evidence => ({ proof: "completed", ids });

const RULES: Readonly<Record<WriteInput["spec"]["evidence"], Rule>> = {
	marks: ({ spec, input }, _baseline, observation, unchanged) => (allPresent(spec.marks(input), observation.text) ? completed([spec.identity(input)]) : unchanged),
	version: ({ spec, input }, baseline, observation, unchanged) => {
		const moved = observation.baseline.version !== null && baseline.version !== null && observation.baseline.version !== baseline.version;
		return moved ? completed([spec.identity(input)]) : unchanged;
	},
	canceled: ({ input }, _baseline, observation, unchanged) => (observation.statuses.length > 0 && observation.statuses.every((status) => status === "CANCELED") ? completed(input.runIds as string[]) : unchanged),
	"new-id": ({ spec, input }, baseline, observation) => {
		const created = newIds(baseline, observation);
		if (created.length === 1 && allPresent(spec.marks(input), observation.text)) return completed(created);
		return created.length === 0 ? { proof: "baseline" } : { proof: "none" };
	},
	// A run started elsewhere may also appear, so a new run is never
	// attributed without the run IDs a reply named.
	"weave-run": (_write, baseline, observation) => (newIds(baseline, observation).length === 0 ? { proof: "baseline" } : { proof: "none" }),
	// Only an existing destination file can show its baseline; an unchanged
	// plan list says nothing about a file created elsewhere.
	// uploads.ts settles uploads from its own page or node reads.
	upload: () => ({ proof: "none" }),
	"reply-target": ({ spec, input }, _baseline, observation, unchanged) => {
		if (input.fileKey === undefined) return { proof: "none" };
		return allPresent(spec.marks(input), observation.text) ? completed([input.fileKey as string]) : unchanged;
	},
};

function judge(write: WriteInput, baseline: Baseline, observation: Observation): Evidence {
	const unchanged: Evidence = observation.baseline.digest === baseline.digest ? { proof: "baseline" } : { proof: "none" };
	return RULES[write.spec.evidence](write, baseline, observation, unchanged);
}

// Read-back targets a reply names: the created file, or the started runs.
async function replyEvidence(write: WriteInput, reply: unknown, caller: Caller): Promise<Evidence | null> {
	const { spec, input } = write;
	if (spec.evidence === "reply-target") {
		const fileKey = fileKeyOf(reply) ?? (input.fileKey as string | undefined) ?? null;
		if (fileKey === null) return null;
		const read = await observe({ tool: "get_metadata", args: { fileKey } }, caller);
		const marks = spec.marks(input);
		return read.ok && (marks.length === 0 || allPresent(marks, read.observation.text)) ? { proof: "completed", ids: [fileKey] } : null;
	}
	if (spec.evidence === "weave-run") {
		const runIds = runIdsOf(reply);
		if (runIds.length === 0) return null;
		const read = await observe({ tool: "weave_get_tool_run_output", args: { recipeId: input.recipeId, runIds } }, caller);
		return read.ok && runIds.every((id) => read.observation.text.includes(id)) ? { proof: "completed", ids: runIds } : null;
	}
	return null;
}

// Evidence for a sent or adjudicated write. reply is the provider's result
// when it replied with success, else null.
export async function evidenceFor(write: WriteInput, baseline: Baseline, reply: unknown, caller: Caller): Promise<Evidence> {
	if (reply !== null) {
		const fromReply = await replyEvidence(write, reply, caller);
		if (fromReply) return fromReply;
	}
	const read = await observe(write.spec.observe(write.input), caller);
	if (!read.ok) return { proof: "none" };
	const evidence = judge(write, baseline, read.observation);
	return evidence.proof === "baseline" && write.spec.partial ? { proof: "none" } : evidence;
}
