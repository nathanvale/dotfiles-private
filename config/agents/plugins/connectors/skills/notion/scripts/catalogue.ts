import { createHash } from "node:crypto";
import snapshot from "../config/catalogue.json";

export const OPERATIONS = snapshot.operations;
export const OPERATION_NAMES = OPERATIONS.map((operation) => operation.name);
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function operationKind(name: string): "read" | "write" | null {
	const operation = OPERATIONS.find((operation) => operation.name === name);
	return operation?.effect === "read" ? "read" : operation?.effect === "write" ? "write" : null;
}

export interface Call {
	tool: string;
	args: Record<string, unknown>;
}
export type Verification = { before: Call; after: Call; contains: string[]; absent: string[]; reply?: never } | { before: Call; reply: "prepared-handle"; after?: never; contains?: never; absent?: never };
export interface Write {
	operation: string;
	args: Record<string, unknown>;
	verify: Verification;
	digest: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	return record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
}
export const digest = (value: unknown): string => sha256(JSON.stringify(canonical(value)));

function readCall(value: unknown): value is Call {
	return record(value) && typeof value.tool === "string" && operationKind(value.tool) === "read" && record(value.args) && Object.keys(value).sort().join(",") === "args,tool";
}

function literals(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}
export function hasReplyReference(value: unknown): boolean {
	if (typeof value === "string") return value.startsWith("$reply.");
	return Array.isArray(value) ? value.some(hasReplyReference) : record(value) && Object.values(value).some(hasReplyReference);
}
function verification(operation: string, args: Record<string, unknown>, value: unknown): Verification | null {
	if (!record(value) || !readCall(value.before) || hasReplyReference(value.before.args)) return null;
	if (value.reply === "prepared-handle") {
		const admitted = operation === "notion-create-file-upload" || operation === "notion-create-attachment" || operation === "notion-upload-skill" && args.action === "prepare";
		return admitted && Object.keys(value).sort().join(",") === "before,reply" ? { before: value.before, reply: "prepared-handle" } : null;
	}
	if (Object.keys(value).some((key) => !["before", "after", "contains", "absent"].includes(key)) || !readCall(value.after) || !safeReferenceValue(value.after.args, true)) return null;
	const contains = value.contains ?? [];
	const absent = value.absent ?? [];
	return literals(contains) && literals(absent) && contains.length + absent.length > 0 ? { before: value.before, after: value.after, contains, absent } : null;
}
export function writeInput(operation: string, input: Readonly<Record<string, unknown>> | null): Write | null {
	if (input === null || operationKind(operation) !== "write") return null;
	const { _verify, ...args } = input;
	const spec = OPERATIONS.find((item) => item.name === operation);
	if (spec === undefined || spec.required.some((key) => args[key] === undefined)) return null;
	const verify = verification(operation, args, _verify);
	return verify === null ? null : { operation, args, verify, digest: digest([operation, input]) };
}

// Only explicit $reply.path references, as whole JSON string values, are
// substituted. URLs and prose that merely contain the text stay untouched.
const CREDENTIAL_KEY = /token|headers?|authorization|credentials?|password|secret|cookie|signature|api[_-]?key|private[_-]?key/i;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENTITY_SCHEMES = new Set(["notion:", "collection:", "view:", "session:", "thread:", "agent:"]);
const urlKey = (key: string): boolean => /url|uri|href/i.test(key);
function stableEntityUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	let url: URL;
	try { url = new URL(value); } catch { return false; }
	if (url.username || url.password || !url.hostname) return false;
	const queries = [...url.searchParams].every(([key, item]) => key === "pvs" && /^\d+$/.test(item) || key === "v" && /^[a-f0-9-]+$/i.test(item));
	if (!queries || url.hash && !/^#[a-f0-9-]+$/i.test(url.hash)) return false;
	if (ENTITY_SCHEMES.has(url.protocol)) return true;
	const host = url.hostname === "notion.so" || url.hostname.endsWith(".notion.so");
	return url.protocol === "https:" && host && !url.port && !/\/(?:api|signed|uploads?|downloads?)(?:\/|$)/i.test(url.pathname);
}
function replyPathAllowed(reference: string): boolean {
	return !reference.slice(7).split(".").some((key) => CREDENTIAL_KEY.test(key) || PROTOTYPE_KEYS.has(key));
}
function safeReferenceValue(value: unknown, allowReferences = false): boolean {
	if (allowReferences && typeof value === "string" && value.startsWith("$reply.")) return replyPathAllowed(value);
	if (typeof value === "string") return !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) || stableEntityUrl(value);
	if (Array.isArray(value)) return value.every((item) => safeReferenceValue(item, allowReferences));
	if (record(value)) return Object.entries(value).every(([key, item]) => !CREDENTIAL_KEY.test(key) && !PROTOTYPE_KEYS.has(key) && (!urlKey(key) || allowReferences && typeof item === "string" && item.startsWith("$reply.") || stableEntityUrl(item)) && safeReferenceValue(item, allowReferences));
	return value !== undefined;
}
export function replyReferenceAllowed(reference: string, value: unknown): boolean {
	const keys = reference.slice(7).split(".");
	return replyPathAllowed(reference) && (!keys.some(urlKey) || stableEntityUrl(value)) && safeReferenceValue(value);
}
function selectReference(value: string, reply: unknown): unknown {
	const keys = value.slice(7).split(".");
	if (keys.some((key) => PROTOTYPE_KEYS.has(key))) return undefined;
	let selected: unknown = reply;
	for (const key of keys) selected = record(selected) || Array.isArray(selected) ? (selected as Record<string, unknown>)[key] : undefined;
	return replyReferenceAllowed(value, selected) ? selected : undefined;
}
function reference(value: unknown, reply: unknown): unknown {
	if (typeof value === "string" && value.startsWith("$reply.")) return selectReference(value, reply);
	if (Array.isArray(value)) return value.map((item) => reference(item, reply));
	return record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item, reply)])) : value;
}
function missing(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) ? value.some(missing) : record(value) && Object.values(value).some(missing));
}
export function afterCall(write: Write, reply: unknown): Call | null {
	if (write.verify.reply === "prepared-handle") return null;
	const args = reference(write.verify.after.args, reply);
	if (!record(args) || missing(args) || !safeReferenceValue(args)) return null;
	return { tool: write.verify.after.tool, args };
}

// MCP tool results may wrap JSON in text content. Decode that one documented
// layer for reply references without interpreting instructions in the text.
export function toolData(value: unknown): unknown {
	if (record(value) && record(value.response)) return toolData(value.response);
	if (record(value) && Object.keys(value).join(",") === "result") return toolData(value.result);
	if (record(value) && value.structuredContent !== undefined) return value.structuredContent;
	if (!record(value) || !Array.isArray(value.content)) return value;
	for (const block of value.content) {
		if (!record(block) || block.type !== "text" || typeof block.text !== "string") continue;
		try { return JSON.parse(block.text); } catch { /* A page document is plain text. */ }
	}
	return value;
}

export function observedText(value: unknown): string {
	const data = toolData(value);
	return typeof data === "string" ? data : record(data) && typeof data.text === "string" ? data.text : JSON.stringify(data);
}
