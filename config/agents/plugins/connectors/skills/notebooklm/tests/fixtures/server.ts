// Independent vendor protocol fixture. Literal tool schemas and outcomes do
// not import the production catalogue, validators, projections or journal.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const home = process.env.HOME ?? "/nonexistent";
const state = path.join(home, "fixture.json");
const log = path.join(home, "calls.jsonl");
const id = "11111111-1111-1111-1111-111111111111";
const sourceId = "22222222-2222-2222-2222-222222222222";
interface Artifact { artifact_id: string; title: string; type: string; status: string; custom_instructions?: string | null; source_ids?: string[]; duration_seconds?: number | null }
// A learning-pack notebook: when present, notebook_get serves it only for its
// own id, studio_status pages its artifacts, and notebook_list reports count.
interface Pack { notebookId: string; notebookTitle: string; sources: { id: string; title: string }[]; artifacts: Artifact[]; notebooks?: { id: string; title: string }[]; total?: number; studio?: "error" | "no-pagination" | "overlap"; studioNotebookIds?: string[]; scan?: "error"; notebookUrl?: string }
interface State { title: string; sourceTitle: string; mode: string; auth: string; version: string; pack?: Pack }
const load = (): State => existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { title: "Synthetic notebook", sourceTitle: "Synthetic source", mode: "normal", auth: "configured", version: "0.15.8" };
const text = { type: "string" };
const boolean = { type: "boolean" };
const number = { type: "number" };
const optionalText = { anyOf: [text, { type: "null" }] };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const tools = [
	{ name: "server_info", inputSchema: schema({}) },
	{ name: "notebook_list", inputSchema: schema({ max_results: { type: "integer" } }) },
	{ name: "notebook_get", inputSchema: schema({ notebook_id: text }, ["notebook_id"]) },
	{ name: "notebook_describe", inputSchema: schema({ notebook_id: text }, ["notebook_id"]) },
	{ name: "notebook_rename", inputSchema: schema({ notebook_id: text, new_title: text }, ["notebook_id", "new_title"]) },
	{ name: "source_describe", inputSchema: schema({ source_id: text }, ["source_id"]) },
	{ name: "source_get_content", inputSchema: schema({ source_id: text, wait: boolean, wait_timeout: number, poll_interval: number }, ["source_id"]) },
	{ name: "source_rename", inputSchema: schema({ notebook_id: text, source_id: text, new_title: text }, ["notebook_id", "source_id", "new_title"]) },
	{ name: "studio_status", inputSchema: schema({ notebook_id: text, action: text, artifact_id: optionalText, new_title: optionalText, include_details: boolean, limit: { type: "integer" }, offset: { type: "integer" } }, ["notebook_id"]) },
];
function packCall(pack: Pack, name: string, args: Record<string, unknown>): unknown {
	if (name === "notebook_get") return args.notebook_id === pack.notebookId ? { status: "success", notebook: { id: pack.notebookId, title: pack.notebookTitle, source_count: pack.sources.length, url: "https://fixture.invalid/?token=SENTINEL_REPLY_CREDENTIAL" }, sources: pack.sources } : { status: "error", error: "Notebook not found SENTINEL_REPLY_CREDENTIAL" };
	if (name === "notebook_list") {
		if (pack.scan === "error") return { status: "error", error: "SENTINEL_REPLY_CREDENTIAL" };
		const notebooks = pack.notebooks ?? [];
		return { status: "success", notebooks: notebooks.slice(0, Number(args.max_results)).map((row) => ({ ...row, url: "https://fixture.invalid/?token=SENTINEL_REPLY_CREDENTIAL" })), count: pack.total ?? notebooks.length };
	}
	return name === "studio_status" ? studioPage(pack, args) : undefined;
}
function studioPage(pack: Pack, args: Record<string, unknown>): unknown {
	if (pack.studio === "error" || args.notebook_id !== pack.notebookId) return { status: "error", error: "SENTINEL_REPLY_CREDENTIAL" };
	// overlap: every later page repeats the previous page's last row.
	const offset = Math.max(0, Number(args.offset ?? 0) - (pack.studio === "overlap" && Number(args.offset ?? 0) > 0 ? 1 : 0));
	const limit = Number(args.limit ?? 100);
	const page = pack.artifacts.slice(offset, offset + limit).map((row) => args.include_details === true ? { ...row, audio_url: "https://fixture.invalid/?token=SENTINEL_REPLY_CREDENTIAL" } : { artifact_id: row.artifact_id, title: row.title, type: row.type, status: row.status });
	const pagination = pack.studio === "no-pagination" ? {} : { pagination: { returned: page.length, offset, limit, has_more: offset + page.length < pack.artifacts.length } };
	const notebookId = pack.studioNotebookIds?.[Math.floor(Number(args.offset ?? 0) / 20)] ?? pack.notebookId;
	return { status: "success", notebook_id: notebookId, artifacts: page, summary: { total: pack.artifacts.length }, ...pagination, notebook_url: pack.notebookUrl ?? `https://notebooklm.google.com/notebook/${notebookId}` };
}
function call(name: string, args: Record<string, unknown>): unknown {
	const value = load();
	appendFileSync(log, `${JSON.stringify({ name, args, profile: process.env.NLM_PROFILE, debug: process.env.NOTEBOOKLM_MCP_DEBUG, ambient: process.env.PRIVATE_SENTINEL !== undefined })}\n`);
	if (name === "server_info") return { status: "success", auth_status: value.auth, version: value.version, update_available: false, cookies: "SENTINEL_REPLY_CREDENTIAL" };
	if (value.mode === "expired") return { status: "error", error: "Authentication expired. Run 'nlm login' SENTINEL_REPLY_CREDENTIAL" };
	if (value.mode === "malformed") return { status: "success", error: "SENTINEL_REPLY_CREDENTIAL" };
	const packed = value.pack ? packCall(value.pack, name, args) : undefined;
	if (packed !== undefined) return packed;
	if (name === "notebook_get") return { status: "success", notebook: { id: value.mode === "wrong-target" ? sourceId : id, title: value.title, source_count: 1, cookies: "SENTINEL_REPLY_CREDENTIAL" }, sources: [{ id: sourceId, title: value.sourceTitle, token: "SENTINEL_REPLY_CREDENTIAL" }], extra: "SENTINEL_REPLY_CREDENTIAL" };
	if (name === "notebook_list") return { status: "success", notebooks: [{ id, title: value.title, cookie: "SENTINEL_REPLY_CREDENTIAL" }], count: 500, secret: "SENTINEL_REPLY_CREDENTIAL" };
	if (name === "notebook_describe") return { status: "success", summary: "Synthetic summary", suggested_topics: [{ question: "Synthetic question", prompt: "Synthetic prompt", extra: "SENTINEL_REPLY_CREDENTIAL" }], extra: "SENTINEL_REPLY_CREDENTIAL" };
	if (name === "source_describe") return { status: "success", summary: "Source summary", keywords: ["Synthetic"], extra: "SENTINEL_REPLY_CREDENTIAL" };
	if (name === "source_get_content") return { status: "success", title: value.sourceTitle, content: "Synthetic content", source_type: "text", char_count: 17, extra: "SENTINEL_REPLY_CREDENTIAL" };
	if (name === "studio_status") return { status: "success", artifacts: [{ artifact_id: sourceId, title: "Synthetic audio", type: "audio", status: "completed", url: "https://fixture.invalid/?token=SENTINEL_REPLY_CREDENTIAL" }] };
	return { status: "error", error: "SENTINEL_REPLY_CREDENTIAL" };
}
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (message.id === undefined) continue;
	let result: unknown;
	if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-notebooklm", version: "1" } };
	else if (message.method === "tools/list") result = { tools };
	else if (message.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify(call(String(message.params.name), message.params.arguments ?? {})) }] };
	else result = {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
