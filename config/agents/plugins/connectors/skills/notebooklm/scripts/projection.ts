import { record } from "./policy.ts";

const string = (value: unknown): value is string => typeof value === "string" && value.length <= 2_000_000;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every(string);

function decode(value: unknown): unknown {
	if (!record(value)) return null;
	if (value.isError === true) return null;
	if (value.structuredContent !== undefined) return value.structuredContent;
	if (!Array.isArray(value.content)) return value;
	const text = value.content.filter((item) => record(item) && item.type === "text");
	if (text.length !== 1 || !record(text[0]) || typeof text[0].text !== "string") return null;
	try { return JSON.parse(text[0].text); } catch { return null; }
}
export function providerFault(raw: unknown): string | null {
	const value = decode(raw);
	if (!record(value) || value.status !== "error") return null;
	return typeof value.error === "string" && /authentication expired|not authenticated|no authentication|run ['`]?nlm login/i.test(value.error) ? "authentication-expired" : "provider-rejected";
}

function summaries(value: unknown): { id: string; title: string }[] | null {
	if (!Array.isArray(value) || value.length > 1000) return null;
	const result: { id: string; title: string }[] = [];
	for (const row of value) {
		if (!record(row) || !string(row.id) || !string(row.title)) return null;
		result.push({ id: row.id, title: row.title });
	}
	return result;
}

function readiness(value: Record<string, unknown>): Record<string, unknown> | null {
	if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.update_available !== "boolean") return null;
	if (typeof value.auth_status !== "string" || !["configured", "stale", "unverified", "not_configured", "error"].includes(value.auth_status)) return null;
	return { version: value.version, update_available: value.update_available, auth_status: value.auth_status, status: value.auth_status === "configured" ? "ready" : value.auth_status === "unverified" ? "degraded" : "blocked", statusMaxAgeSeconds: 30 };
}
function notebook(value: Record<string, unknown>): Record<string, unknown> | null {
	if (!record(value.notebook) || !string(value.notebook.id) || !string(value.notebook.title) || !count(value.notebook.source_count)) return null;
	const sources = summaries(value.sources);
	return sources === null ? null : { notebook: { id: value.notebook.id, title: value.notebook.title, source_count: value.notebook.source_count }, sources };
}
function studio(value: Record<string, unknown>): Record<string, unknown> | null {
	if (!Array.isArray(value.artifacts) || value.artifacts.length > 20) return null;
	const artifacts: Record<string, unknown>[] = [];
	for (const row of value.artifacts) {
		if (!record(row) || !string(row.artifact_id) || !string(row.title) || !string(row.type) || !string(row.status)) return null;
		artifacts.push({ artifact_id: row.artifact_id, title: row.title, type: row.type, status: row.status });
	}
	return { artifacts };
}
function listing(value: Record<string, unknown>): Record<string, unknown> | null {
	const notebooks = summaries(value.notebooks);
	return notebooks === null ? null : { notebooks, returned: notebooks.length };
}
function description(value: Record<string, unknown>): Record<string, unknown> | null {
	if (!string(value.summary) || !Array.isArray(value.suggested_topics) || value.suggested_topics.length > 1000) return null;
	const topics: { question: string; prompt: string }[] = [];
	for (const topic of value.suggested_topics) {
		if (!record(topic) || !string(topic.question) || !string(topic.prompt)) return null;
		topics.push({ question: topic.question, prompt: topic.prompt });
	}
	return { summary: value.summary, suggested_topics: topics };
}
function sourceContent(value: Record<string, unknown>): Record<string, unknown> | null {
	return string(value.content) && string(value.title) && string(value.source_type) && count(value.char_count) ? { content: value.content, title: value.title, source_type: value.source_type, char_count: value.char_count } : null;
}
const PROJECTIONS: Record<string, (value: Record<string, unknown>) => Record<string, unknown> | null> = {
	server_info: readiness,
	notebook_get: notebook,
	notebook_list: listing,
	notebook_describe: description,
	source_describe: (value) => string(value.summary) && strings(value.keywords) ? { summary: value.summary, keywords: value.keywords } : null,
	source_get_content: sourceContent,
	studio_status: studio,
};
export function project(name: string, raw: unknown): Record<string, unknown> | null {
	const value = decode(raw);
	return record(value) && value.status === "success" ? PROJECTIONS[name]?.(value) ?? null : null;
}
