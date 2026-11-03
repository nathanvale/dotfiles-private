// Read-only Atlassian collections. Community simplification omits pagination
// facts; these declared REST operations retain native continuation evidence.
import { createHash } from "node:crypto";
import type { CredentialBinding } from "../custody/index.ts";
import type { Input } from "./engine.ts";
import type { RestRequest } from "./rest.ts";

export const DISCOVERY_TOOLS = {
	jira_rest_search: ["jql", "fields", "limit", "start", "cursor"],
	jira_rest_comments: ["issue_key", "limit", "start", "cursor"],
	jira_rest_changelog: ["issue_key", "limit", "start", "cursor"],
	confluence_rest_search: ["cql", "limit", "start", "cursor"],
	confluence_rest_comments: ["page_id", "limit", "start", "cursor"],
	confluence_rest_attachments: ["page_id", "limit", "start", "cursor"],
	confluence_rest_children: ["page_id", "limit", "start", "cursor"],
} as const;

export const discoveryTool = (tool: string): tool is keyof typeof DISCOVERY_TOOLS => Object.hasOwn(DISCOVERY_TOOLS, tool);
export const discoveryProduct = (tool: string): "jira" | "confluence" | null => discoveryTool(tool) ? (tool.startsWith("jira_") ? "jira" : "confluence") : null;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const offset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const token = (value: unknown): value is string => typeof value === "string" && value.length <= 16_384 && !/[\r\n]/.test(value);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validRequestPosition(args: Record<string, unknown>): boolean {
	return offset(args.start) && token(args.cursor) && Number.isInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 100;
}

function validRequestIdentity(tool: string, args: Record<string, unknown>): boolean {
	if (tool === "jira_rest_search") return typeof args.jql === "string" && args.jql.trim().length > 0 && args.jql.length <= 32_768 && typeof args.fields === "string" && /^[A-Za-z0-9_.,-]+$/.test(args.fields);
	if (discoveryProduct(tool) === "jira") return typeof args.issue_key === "string" && /^[A-Z][A-Z0-9_]+-[0-9]+$/.test(args.issue_key);
	if (tool === "confluence_rest_search") return typeof args.cql === "string" && args.cql.trim().length > 0 && args.cql.length <= 32_768;
	return typeof args.page_id === "string" && /^[1-9][0-9]{0,19}$/.test(args.page_id);
}

export function discoveryRequest(tool: string, args: unknown): RestRequest | null {
	if (!discoveryTool(tool) || !object(args)) return null;
	const keys = DISCOVERY_TOOLS[tool];
	if (Object.keys(args).length !== keys.length || keys.some((key) => !(key in args))) return null;
	const search = tool === "confluence_rest_search";
	if (!validRequestPosition(args) || !validRequestIdentity(tool, args)) return null;
	if (discoveryProduct(tool) === "jira") return jiraRequest(tool, args);
	const resource = tool === "confluence_rest_comments" ? "comment" : tool === "confluence_rest_attachments" ? "attachment" : "page";
	const base = search ? "/wiki/rest/api/content/search" : `/wiki/rest/api/content/${args.page_id as string}/child/${resource}`;
	const query = new URLSearchParams({ limit: String(args.limit), expand: search ? "version,history,space" : "version,history,body.storage" });
	if (search) query.set("cql", args.cql as string);
	if (args.cursor) query.set("cursor", args.cursor as string);
	else query.set("start", String(args.start));
	return { method: "GET", path: `${base}?${query}` };
}

function jiraRequest(tool: string, args: Record<string, unknown>): RestRequest {
	const search = tool === "jira_rest_search";
	const base = search ? "/rest/api/3/search/jql" : `/rest/api/3/issue/${args.issue_key as string}/${tool === "jira_rest_comments" ? "comment" : "changelog"}`;
	const query = new URLSearchParams({ maxResults: String(args.limit) });
	if (search) {
		query.set("jql", args.jql as string);
		query.set("fields", args.fields as string);
		if (args.cursor) query.set("nextPageToken", args.cursor as string);
	} else query.set("startAt", String(args.start));
	return { method: "GET", path: `${base}?${query}` };
}

export function readScope(tenant: string, binding: CredentialBinding, operation: string, input: Input): string {
	const fields = Object.entries(input).filter(([key]) => key !== "continuation").sort(([a], [b]) => a.localeCompare(b));
	return digest([tenant, binding.origin, binding.principal, binding.itemVersion, binding.item, operation, fields]);
}

export interface Position { start: number; cursor: string }

// A continuation is scope-bound adapter state, not a watermark or authority.
// Only position values cross into the request, never a provider-controlled URL.
export function readPosition(continuation: unknown, scope: string): Position | null {
	if (continuation === undefined) return { start: 0, cursor: "" };
	if (!token(continuation)) return null;
	try {
		const value: unknown = JSON.parse(Buffer.from(continuation, "base64url").toString("utf8"));
		if (!object(value) || value.version !== 1 || value.scope !== scope || !offset(value.start) || !token(value.cursor)) return null;
		return { start: value.start, cursor: value.cursor };
	} catch { return null; }
}

export interface ReadCoverage {
	returned: number | null;
	terminal: boolean | null;
	nextContinuation: string | null;
	basis: "source-next-link" | "source-terminal-link-set" | "source-page-token" | "source-terminal-flag" | "source-total" | "provider-omits-pagination" | "unusable-source-pagination" | "body-captured";
	excluded: string[];
}

function sameCollection(next: URL, current: URL, origin: string): boolean {
	const path = next.pathname.startsWith("/rest/") ? `/wiki${next.pathname}` : next.pathname;
	if (next.origin !== origin || next.username || next.password || next.hash || path !== current.pathname) return false;
	if (next.searchParams.has("cql") && next.searchParams.get("cql") !== current.searchParams.get("cql")) return false;
	return !["start", "cursor"].some((key) => next.searchParams.getAll(key).length > 1);
}

function advancingPosition(next: URL, current: URL): Position | null {
	const startText = next.searchParams.get("start");
	const start = startText === null ? 0 : /^\d+$/.test(startText) ? Number(startText) : -1;
	const cursor = next.searchParams.get("cursor") ?? "";
	if (!offset(start) || !token(cursor)) return null;
	if (cursor ? cursor === current.searchParams.get("cursor") : start <= Number(current.searchParams.get("start") ?? 0)) return null;
	return { start, cursor };
}

function nextPosition(link: string, origin: string, request: RestRequest): Position | null {
	try {
		const current = new URL(request.path, origin);
		const next = new URL(link, `${origin}/wiki/`);
		return sameCollection(next, current, origin) ? advancingPosition(next, current) : null;
	} catch { return null; }
}

function decodeRead(data: unknown): unknown {
	let value = data;
	for (let depth = 0; depth < 4; depth++) {
		if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
		else if (object(value) && Object.keys(value).length === 1 && "result" in value) value = value.result;
		else return value;
	}
	return value;
}

function jiraCoverage(value: unknown, request: RestRequest, unknown: ReadCoverage, scope: string): ReadCoverage {
	if (!object(value)) return unknown;
	const search = request.path.startsWith("/rest/api/3/search/jql?");
	const list = search ? value.issues : request.path.includes("/changelog?") ? value.values : value.comments;
	if (!Array.isArray(list)) return unknown;
	const result = { ...unknown, returned: list.length };
	if (search) return jiraSearchCoverage(value, result, scope, request);
	const start = value.startAt;
	const total = value.total;
	if (!offset(start) || !offset(total) || start !== Number(new URL(request.path, "https://source.invalid").searchParams.get("startAt")) || start + list.length > total) return result;
	const terminal = start + list.length === total;
	if (typeof value.isLast === "boolean" && value.isLast !== terminal) return result;
	if (!terminal && list.length === 0) return result;
	const nextContinuation = terminal ? null : encodePosition(scope, { start: start + list.length, cursor: "" });
	return { ...result, terminal, nextContinuation, basis: "source-total" };
}

function encodePosition(scope: string, position: Position): string {
	return Buffer.from(JSON.stringify({ version: 1, scope, ...position })).toString("base64url");
}

function jiraSearchCoverage(value: Record<string, unknown>, result: ReadCoverage, scope: string, request: RestRequest): ReadCoverage {
	const cursor = value.nextPageToken;
	if (cursor && cursor === new URL(request.path, "https://source.invalid").searchParams.get("nextPageToken")) return result;
	if (value.isLast === true && !cursor) return { ...result, terminal: true, basis: "source-terminal-flag" };
	if (value.isLast !== true && token(cursor) && cursor.length > 0 && (result.returned ?? 0) > 0) return { ...result, terminal: false, nextContinuation: encodePosition(scope, { start: 0, cursor }), basis: "source-page-token" };
	return result;
}

function collectionCoverage(data: unknown, request: RestRequest, origin: string, scope: string): ReadCoverage {
	const value = decodeRead(data);
	const rows = object(value) && Array.isArray(value.results) ? value.results : null;
	const unknown: ReadCoverage = { returned: rows?.length ?? null, terminal: null, nextContinuation: null, basis: "unusable-source-pagination", excluded: ["snapshot-consistency", "item-bodies", "nested-replies", "attachment-bytes", "business-acceptance"] };
	if (request.path.startsWith("/rest/api/3/")) return jiraCoverage(value, request, unknown, scope);
	if (!rows || !object(value) || !object(value._links)) return unknown;
	if (typeof value.size === "number" && value.size !== rows.length) return unknown;
	const next = value._links.next;
	if (next === undefined || next === "") return { ...unknown, terminal: true, basis: "source-terminal-link-set" };
	if (typeof next !== "string" || rows.length === 0) return unknown;
	const position = nextPosition(next, origin, request);
	if (!position) return unknown;
	const nextContinuation = encodePosition(scope, position);
	return { ...unknown, terminal: false, nextContinuation, basis: "source-next-link" };
}

export interface ReadEvidence {
	schemaVersion: 1;
	observedAt: string;
	binding: { tenant: string; product: string; origin: string; principal: string; credentialRevision: string };
	scopeFingerprint: string;
	source?: { id: string; version: unknown; modified: unknown; representation: string; bodySha256: string };
	coverage: ReadCoverage;
}

export function readEvidence(tenant: string, binding: CredentialBinding, product: string, operation: string, input: Input, data: unknown, now: number, request?: RestRequest): ReadEvidence {
	const scope = readScope(tenant, binding, operation, input);
	const coverage: ReadCoverage = request ? collectionCoverage(data, request, binding.origin, scope) : { returned: null, terminal: null, nextContinuation: null, basis: "provider-omits-pagination", excluded: ["enumeration-completeness", "comments-completeness", "attachment-bytes", "business-acceptance"] };
	const value = decodeRead(data);
	const metadata = object(value) && object(value.metadata) ? value.metadata : null;
	const content = metadata && object(metadata.content) ? metadata.content : null;
	const source = operation === "page.get" && metadata && content && typeof metadata.id === "string" && metadata.id === input.pageId && typeof content.value === "string" ? { id: metadata.id as string, version: metadata.version ?? null, modified: metadata.updated ?? null, representation: String(content.format ?? "unknown"), bodySha256: createHash("sha256").update(content.value as string).digest("hex") } : undefined;
	if (source) { coverage.returned = 1; coverage.basis = "body-captured"; }
	return { ...(source ? { source } : {}), schemaVersion: 1, observedAt: new Date(now).toISOString(), binding: { tenant, product, origin: binding.origin, principal: binding.principal, credentialRevision: binding.itemVersion }, scopeFingerprint: scope, coverage };
}
