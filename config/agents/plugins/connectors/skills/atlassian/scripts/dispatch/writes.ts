// Write policy for the Atlassian write operations, pure and I/O free. One
// neutral input contract per operation; the Community provider argument
// adapter; the preparatory read each write needs (revision, current title);
// effect extraction from a provider reply; and read-back evidence for operator
// adjudication. Argument names are taken from the v0.23.1 Community source and
// are confirmed only by the live schema at dispatch time; reply shapes are the
// ones observed live on 2026-09-23 plus the REST shapes, and nothing here
// assumes a shape without checking.
import path from "node:path";
import { type OperationSpec, WRITE_OPERATION_IDS } from "./contract.ts";
import { collectInput } from "./engine.ts";
import type { Effect, WriteBaseline, WriteOperation } from "./journal.ts";

export type WriteInput = Record<string, unknown>;
export type WriteValidation = { ok: true; input: WriteInput } | { ok: false; reason: string };

type Field =
	| { kind: "text"; required: boolean; pattern?: RegExp }
	| { kind: "body"; required: boolean }
	| { kind: "fields"; required: boolean }
	| { kind: "path"; required: boolean };

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const SPACE_KEY = /^[A-Za-z0-9~][A-Za-z0-9_.-]{0,254}$/;
// One absolute local file for the Provider process to read. The Community
// Jira tool joins several paths with commas, so a comma is refused here.
const LOCAL_FILE = /^\/[^\n,]{1,1023}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BODY_LIMIT = 200_000;

// Neutral input per write operation. Unknown keys are refused so a caller
// cannot smuggle provider arguments through the semantic seam.
const WRITE_INPUTS: Record<WriteOperation, Record<string, Field>> = {
	"issue.create": {
		projectKey: { kind: "text", required: true, pattern: PROJECT_KEY },
		issueType: { kind: "text", required: true },
		summary: { kind: "text", required: true },
		description: { kind: "body", required: false },
		assignee: { kind: "text", required: false },
	},
	"issue.update": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY }, fields: { kind: "fields", required: true } },
	"issue.comment": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY }, body: { kind: "body", required: true } },
	"issue.comment.update": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY }, commentId: { kind: "text", required: true, pattern: NUMERIC_ID }, body: { kind: "body", required: true } },
	"issue.attach": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY }, file: { kind: "path", required: true } },
	// toStatus names the status the issue must reach; the transition that leads
	// there is resolved from the live transition list at preview and apply.
	"issue.transition": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY }, toStatus: { kind: "text", required: true } },
	// An omitted assignee unassigns the issue.
	"issue.assign": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY }, assignee: { kind: "text", required: false } },
	"issue.delete": { issueKey: { kind: "text", required: true, pattern: ISSUE_KEY } },
	"page.create": {
		spaceKey: { kind: "text", required: true, pattern: SPACE_KEY },
		title: { kind: "text", required: true },
		body: { kind: "body", required: true },
		parentId: { kind: "text", required: false, pattern: NUMERIC_ID },
	},
	"page.update": {
		pageId: { kind: "text", required: true, pattern: NUMERIC_ID },
		title: { kind: "text", required: false },
		body: { kind: "body", required: true },
		versionMessage: { kind: "text", required: false },
	},
	"page.comment": { pageId: { kind: "text", required: true, pattern: NUMERIC_ID }, body: { kind: "body", required: true } },
	"page.attach": { pageId: { kind: "text", required: true, pattern: NUMERIC_ID }, file: { kind: "path", required: true } },
	"page.attachment.delete": { pageId: { kind: "text", required: true, pattern: NUMERIC_ID }, attachmentId: { kind: "text", required: true, pattern: ATTACHMENT_ID } },
	"page.delete": { pageId: { kind: "text", required: true, pattern: NUMERIC_ID } },
};

export const WRITE_OPERATIONS = WRITE_OPERATION_IDS;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown, pattern?: RegExp): value is string =>
	typeof value === "string" && value.trim().length > 0 && !value.includes("\n") && value.length <= 1024 && (pattern === undefined || pattern.test(value));

// Update fields are a flat object of scalar or string-list values; nested
// objects are refused because their meaning is provider-specific.
function validFields(value: unknown): boolean {
	if (!isRecord(value) || Object.keys(value).length === 0) return false;
	return Object.entries(value).every(
		([key, entry]) =>
			/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
			(typeof entry === "string" || typeof entry === "number" || (Array.isArray(entry) && entry.every((item) => typeof item === "string"))),
	);
}

function validField(field: Field, value: unknown): boolean {
	switch (field.kind) {
		case "text":
			return text(value, field.pattern);
		case "body":
			return typeof value === "string" && value.trim().length > 0 && value.length <= BODY_LIMIT;
		case "fields":
			return validFields(value);
		case "path":
			return typeof value === "string" && LOCAL_FILE.test(value) && path.isAbsolute(value) && path.basename(value).length > 0;
	}
}

export function writeInput(operation: WriteOperation, raw: unknown): WriteValidation {
	return collectInput(raw, WRITE_INPUTS[operation], validField);
}

// What a write needs to read before it can be previewed or applied. The read
// is repeated at apply so the revision is current, and the journal refuses the
// apply when the revision moved. Creates and comments bind no revision: a
// changed target is still the same container. Attachments bind the target's
// revision because an upload moves it, which lets an unchanged revision prove
// that a possibly-sent upload never landed.
export type Preparation = { kind: "none" } | { kind: "issue"; issueKey: string } | { kind: "comment"; issueKey: string; commentId: string } | { kind: "transition"; issueKey: string; toStatus: string } | { kind: "page"; pageId: string };

export function preparation(operation: WriteOperation, input: WriteInput): Preparation {
	switch (operation) {
		case "issue.create":
		case "issue.comment":
		case "page.create":
			return { kind: "none" };
		case "issue.update":
		case "issue.attach":
		case "issue.assign":
		case "issue.delete":
			return { kind: "issue", issueKey: input.issueKey as string };
		case "issue.comment.update":
			return { kind: "comment", issueKey: input.issueKey as string, commentId: input.commentId as string };
		case "issue.transition":
			return { kind: "transition", issueKey: input.issueKey as string, toStatus: input.toStatus as string };
		case "page.update":
		case "page.comment":
		case "page.attach":
		case "page.attachment.delete":
		case "page.delete":
			return { kind: "page", pageId: input.pageId as string };
	}
}

export interface PreparedContext {
	// Revision of the target as observed by the preparatory read; null when the
	// operation binds none. Jira exposes no monotonic issue revision, so the
	// issue or comment `updated` timestamp stands in for staleness detection
	// only; it is never read-back proof on its own.
	revision: string | null;
	// Current title of a page, needed by Community updates that keep it.
	currentTitle?: string;
	// The staged copy of an upload, relative to the Provider's outbox.
	stagedFile?: string;
	// The live transition id that leads to the requested status.
	transitionId?: string;
	// Provider identifiers and stable revisions observed before the write. This
	// is persisted with the preview and compared by read-back, not inferred from
	// text that may have existed before the preview.
	baseline: WriteBaseline;
}

export interface ShapedArguments {
	args: Record<string, unknown>;
	// The exact args the journal digests, so an apply sends only what was
	// previewed.
	bound: Record<string, unknown>;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

export function writeArguments(spec: OperationSpec, input: WriteInput, ctx: PreparedContext): ShapedArguments {
	const operation = spec.id as WriteOperation;
	const args: Record<string, unknown> = {};
	switch (operation) {
		case "issue.create":
			assign(args, "project_key", input.projectKey);
			assign(args, "issue_type", input.issueType);
			for (const key of ["summary", "description", "assignee"]) assign(args, key, input[key]);
			break;
		case "issue.update":
			assign(args, "issue_key", input.issueKey);
			args.fields = JSON.stringify(input.fields);
			break;
		case "issue.comment":
			assign(args, "issue_key", input.issueKey);
			assign(args, "body", input.body);
			break;
		case "issue.comment.update":
			assign(args, "issue_key", input.issueKey);
			assign(args, "comment_id", input.commentId);
			assign(args, "body", input.body);
			break;
		case "issue.attach":
			// The Community upload rides on the update tool with no field change.
			assign(args, "issue_key", input.issueKey);
			args.fields = "{}";
			assign(args, "attachments", ctx.stagedFile ?? input.file);
			break;
		case "issue.transition":
			assign(args, "issue_key", input.issueKey);
			assign(args, "transition_id", ctx.transitionId);
			break;
		case "issue.assign":
			// The Community tool unassigns on an empty string.
			assign(args, "issue_key", input.issueKey);
			args.assignee = input.assignee ?? "";
			break;
		case "issue.delete":
			assign(args, "issue_key", input.issueKey);
			break;
		case "page.create":
			assign(args, "space_key", input.spaceKey);
			assign(args, "title", input.title);
			assign(args, "content", input.body);
			assign(args, "parent_id", input.parentId);
			args.content_format = "markdown";
			break;
		case "page.update":
			assign(args, "page_id", input.pageId);
			// Community requires the title on every update; an omitted title keeps
			// the one the preparatory read observed, which the revision binds.
			assign(args, "title", input.title ?? ctx.currentTitle);
			assign(args, "content", input.body);
			assign(args, "version_comment", input.versionMessage);
			args.content_format = "markdown";
			break;
		case "page.comment":
			assign(args, "page_id", input.pageId);
			assign(args, "body", input.body);
			break;
		case "page.attach":
			assign(args, "content_id", input.pageId);
			assign(args, "file_path", ctx.stagedFile ?? input.file);
			break;
		case "page.attachment.delete":
			assign(args, "attachment_id", input.attachmentId);
			break;
		case "page.delete":
			assign(args, "page_id", input.pageId);
			break;
	}
	return { args, bound: args };
}

// Effect kinds per operation; the id comes from the provider reply or the
// read-back, or is the target itself for an update or delete.
const EFFECT_KIND: Record<WriteOperation, Effect["kind"]> = {
	"issue.create": "jira-issue",
	"issue.update": "jira-issue",
	"issue.delete": "jira-issue",
	"issue.comment": "jira-comment",
	"issue.comment.update": "jira-comment",
	"issue.attach": "jira-attachment",
	"issue.transition": "jira-issue",
	"issue.assign": "jira-issue",
	"page.create": "confluence-content",
	"page.update": "confluence-content",
	"page.delete": "confluence-content",
	"page.comment": "confluence-comment",
	"page.attach": "confluence-attachment",
	"page.attachment.delete": "confluence-attachment",
};

// Writes whose effect is the object they name, proven by read-back.
const TARGET_OPERATIONS: ReadonlySet<WriteOperation> = new Set<WriteOperation>(["issue.update", "issue.transition", "issue.assign", "page.update"]);
// Writes proven by the Provider refusing to find the object afterwards.
const OBJECT_DELETES: ReadonlySet<WriteOperation> = new Set<WriteOperation>(["issue.delete", "page.delete"]);
export const isObjectDelete = (operation: WriteOperation): boolean => OBJECT_DELETES.has(operation);

export const effectKindOf = (operation: WriteOperation): Effect["kind"] => EFFECT_KIND[operation];

const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DELETED_MESSAGE = /deleted successfully/i;

function stringAt(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
		if (typeof value === "number" && Number.isInteger(value)) return String(value);
	}
	return undefined;
}

// Walk a reply looking for records, depth-bounded so a hostile reply cannot
// blow the stack. Arrays and nested objects are both searched.
function records(data: unknown, depth = 0): Record<string, unknown>[] {
	if (depth > 6) return [];
	if (Array.isArray(data)) return data.flatMap((entry) => records(entry, depth + 1));
	if (!isRecord(data)) return [];
	return [data, ...Object.values(data).flatMap((entry) => records(entry, depth + 1))];
}

function parsedJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// MCPorter returns tool text content: with --output json as one JSON string
// under result (observed live, MCPorter 0.13.13), otherwise as text blocks.
// A JSON string is unwrapped once so provider replies serialised as text still
// yield records.
export function unwrapReply(data: unknown): unknown {
	if (!isRecord(data)) return data;
	if (typeof data.result === "string" && Object.keys(data).length === 1) return parsedJson(data.result) ?? data;
	if (!Array.isArray(data.content)) return data;
	const texts = data.content.filter((entry): entry is { type: "text"; text: string } => isRecord(entry) && entry.type === "text" && typeof entry.text === "string");
	if (texts.length !== 1) return data;
	return parsedJson(texts[0]?.text ?? "") ?? data;
}

// Normalised text for read-back matching: case, whitespace, and punctuation
// are not part of a comment's or title's identity.
export const normalised = (value: string): string =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

// The Community Jira read path renders an ADF mention as User:<accountId>,
// while its write path accepts Markdown mention syntax. Keep the account ID
// and all surrounding text in the comparison; only the display name changes.
const JIRA_MENTION = /@\[[^\]\r\n]{1,256}\]\(accountid:([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\)/g;
const JIRA_RENDERED_MENTION = /\bUser:([A-Za-z0-9][A-Za-z0-9:_-]{0,127})(?=$|[^A-Za-z0-9:_-])/g;
// Jira turns a bare key into a Markdown link to that same key on its Cloud site.
// A different link label, target key, or non-Atlassian host is not equivalent.
const JIRA_AUTOLINK = /\[([A-Z][A-Z0-9_]+-[0-9]+)\]\((https:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/\1)\)/g;
const jiraCommentNormalised = (value: string, issueOrigin?: string): string =>
	normalised(
		value
			.replace(JIRA_MENTION, (_mention, accountId: string) => `User:${accountId}`)
			.replace(JIRA_RENDERED_MENTION, (_rendered, accountId: string) => `User${Buffer.from(accountId).toString("hex")}`)
			.replace(JIRA_AUTOLINK, (link, key: string, target: string) => (issueOrigin !== undefined && target === `${issueOrigin}/browse/${key}` ? key : link)),
	);

function namedIdentity(reply: unknown, keys: string[]): string | undefined {
	for (const record of records(unwrapReply(reply))) {
		const identity = stringAt(record, ...keys);
		if (identity !== undefined) return identity;
	}
	return undefined;
}

function issueIdentity(reply: unknown): string | undefined {
	return namedIdentity(reply, ["key", "issueKey", "issue_key"]);
}

function pageIdentity(reply: unknown, includePlainId: boolean): string | undefined {
	const named = namedIdentity(reply, ["pageId", "page_id", "contentId", "content_id"]);
	if (named !== undefined) return named;
	for (const record of records(unwrapReply(reply))) {
		const container = isRecord(record.container) ? stringAt(record.container, "id") : undefined;
		if (container !== undefined) return container;
		if (includePlainId) {
			const id = stringAt(record, "id");
			if (id !== undefined) return id;
		}
	}
	return undefined;
}

const issueScoped = (operation: WriteOperation) => operation.startsWith("issue.") && operation !== "issue.create";
const pageScoped = (operation: WriteOperation) => operation.startsWith("page.") && operation !== "page.create";

function replyNamesRequestedObject(operation: WriteOperation, input: WriteInput, reply: unknown): boolean {
	if (issueScoped(operation)) {
		const observed = issueIdentity(reply);
		return observed === undefined || observed === input.issueKey;
	}
	if (pageScoped(operation)) {
		const observed = pageIdentity(reply, operation === "page.update" || operation === "page.delete");
		return observed === undefined || observed === input.pageId;
	}
	return true;
}

function commentRecordMatches(record: Record<string, unknown>, input: WriteInput, kind: Effect["kind"]): boolean {
	if (!("body" in record)) return false;
	const wanted = kind === "jira-comment" ? jiraCommentNormalised(input.body as string) : normalised(input.body as string);
	return wanted.length > 0 && (kind === "jira-comment" ? jiraCommentNormalised(bodyText(record.body)) : normalised(bodyText(record.body))) === wanted;
}

// The Community Jira attachment record carries no id field (observed live):
// the id is the last segment of its content url.
const ATTACHMENT_URL_ID = /\/attachment\/(?:content\/)?([A-Za-z0-9_-]+)\/?$/;

function attachmentId(record: Record<string, unknown>): string | undefined {
	const own = stringAt(record, "id");
	if (own !== undefined) return own;
	const url = stringAt(record, "url", "content_url", "self");
	return url === undefined ? undefined : ATTACHMENT_URL_ID.exec(url)?.[1];
}

// Jira names an attachment by `filename`, Confluence by `title`.
function attachmentNameMatches(record: Record<string, unknown>, file: string): boolean {
	return stringAt(record, "filename", "title", "name") === path.basename(file);
}

function attachmentRecord(record: Record<string, unknown>, file: string): string | undefined {
	const id = attachmentId(record);
	return id !== undefined && EFFECT_ID.test(id) && attachmentNameMatches(record, file) ? id : undefined;
}

function effectFromRecord(operation: WriteOperation, input: WriteInput, kind: Effect["kind"], record: Record<string, unknown>): Effect | undefined {
	if (kind.endsWith("-attachment")) {
		const id = attachmentRecord(record, input.file as string);
		return id === undefined ? undefined : { kind, id };
	}
	const id = operation === "issue.create" ? stringAt(record, "key") : stringAt(record, "id");
	if (id === undefined || !EFFECT_ID.test(id)) return undefined;
	if (operation === "issue.create" && !ISSUE_KEY.test(id)) return undefined;
	if (operation === "issue.comment.update" && id !== input.commentId) return undefined;
	if (kind.endsWith("-comment") && !commentRecordMatches(record, input, kind)) return undefined;
	return { kind, id };
}

// The identifier of the object a write created, changed, or removed, read
// from the provider reply. Updates fall back to the target the caller named
// only when the reply does not name a different object; a delete needs the
// Provider's explicit success message.
// The object an update or delete names in its own input.
function targetOf(operation: WriteOperation, input: WriteInput): string {
	if (operation === "page.attachment.delete") return input.attachmentId as string;
	return (operation.startsWith("issue.") ? input.issueKey : input.pageId) as string;
}

function deleteEffect(operation: WriteOperation, input: WriteInput, kind: Effect["kind"], data: unknown): Effect[] {
	const message = isRecord(data) ? stringAt(data, "message") : undefined;
	return message !== undefined && DELETED_MESSAGE.test(message) ? [{ kind, id: targetOf(operation, input) }] : [];
}

export function effectsFromReply(operation: WriteOperation, input: WriteInput, reply: unknown): Effect[] {
	const kind = EFFECT_KIND[operation];
	if (!replyNamesRequestedObject(operation, input, reply)) return [];
	const data = unwrapReply(reply);
	if (operation.endsWith(".delete")) return deleteEffect(operation, input, kind, data);
	if (TARGET_OPERATIONS.has(operation)) return [{ kind, id: targetOf(operation, input) }];
	for (const record of records(data)) {
		const effect = effectFromRecord(operation, input, kind, record);
		if (effect !== undefined) return [effect];
	}
	return [];
}

// Flatten a body that may be a string, a Confluence body object, or an ADF
// document into plain text.
export function bodyText(value: unknown, depth = 0): string {
	if (depth > 12) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((entry) => bodyText(entry, depth + 1)).join(" ");
	if (!isRecord(value)) return "";
	if (typeof value.text === "string") return value.text;
	return ["value", "content", "storage", "view", "atlas_doc_format", "body"].map((key) => bodyText(value[key], depth + 1)).join(" ");
}

// Observations a preparatory read must yield. A reply that does not expose
// the field is reported as missing so the caller can refuse rather than guess.
export interface PageObservation {
	id: string | undefined;
	version: string | null;
	title: string | undefined;
	body: string;
}

type PageObservationState = Omit<PageObservation, "body">;

function pageVersion(record: Record<string, unknown>): string | undefined {
	const own = record.version;
	if (typeof own === "number" && Number.isInteger(own) && own > 0) return String(own);
	if (isRecord(own) && typeof own.number === "number") return String(own.number);
	return undefined;
}

function observePageRecord(previous: PageObservationState, record: Record<string, unknown>): PageObservationState {
	return {
		id: previous.id,
		version: previous.version ?? pageVersion(record) ?? null,
		title: previous.title ?? stringAt(record, "title"),
	};
}

// The Community page read with include_metadata wraps the page as
// {metadata: {...}} (observed live); other replies put the page on top.
export function observePage(reply: unknown): PageObservation {
	const data = unwrapReply(reply);
	const top = isRecord(data) ? data : {};
	const page = isRecord(top.metadata) && !("id" in top) ? top.metadata : top;
	let observation: PageObservationState = { id: stringAt(page, "id"), version: null, title: undefined };
	for (const record of records(page)) {
		observation = observePageRecord(observation, record);
	}
	return { ...observation, body: bodyText(page) };
}

export interface IssueComment {
	id: string;
	text: string;
	// The comment's own `updated` timestamp when the reply carries one.
	updated: string | undefined;
}

export interface IssueObservation {
	key: string | undefined;
	browseOrigin: string | undefined;
	// A provider revision when one exists, else the `updated` timestamp: enough
	// to detect that the issue moved between preview and apply, never enough on
	// its own to prove what landed.
	revision: string | null;
	fields: Record<string, unknown>;
	comments: IssueComment[];
	attachments: { id: string; name: string }[];
}

function issueBrowseOrigin(issue: Record<string, unknown>): string | undefined {
	const key = stringAt(issue, "key");
	const browse = stringAt(issue, "browse_url");
	if (key === undefined || browse === undefined) return undefined;
	try {
		const url = new URL(browse);
		return url.protocol === "https:" && url.hostname.endsWith(".atlassian.net") && url.pathname === `/browse/${key}` ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

export function observeIssue(reply: unknown): IssueObservation {
	const data = unwrapReply(reply);
	const top = isRecord(data) ? data : {};
	const fields = isRecord(top.fields) ? { ...top, ...top.fields } : top;
	const comments: IssueComment[] = [];
	const attachments: { id: string; name: string }[] = [];
	for (const record of records(data)) {
		if ("key" in record) continue;
		const name = stringAt(record, "filename");
		const id = name === undefined ? stringAt(record, "id") : attachmentId(record);
		if (id === undefined || !EFFECT_ID.test(id)) continue;
		if ("body" in record) comments.push({ id, text: bodyText(record.body), updated: stringAt(record, "updated") });
		if (name !== undefined) attachments.push({ id, name });
	}
	return { key: stringAt(top, "key"), browseOrigin: issueBrowseOrigin(top), revision: stringAt(fields, "version", "revision", "updated") ?? null, fields, comments, attachments };
}

export type ReadBack = { kind: "found"; effects: Effect[] } | { kind: "absent"; revisionUnchanged: boolean } | { kind: "indeterminate"; reason: string };

// Which Community read proves a write's effect. The dispatcher runs it and
// hands the reply back to readBackEvidence.
export interface ReadBackPlan {
	tool: string;
	args: Record<string, unknown>;
}

const jqlString = (value: string) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
const cqlString = jqlString;

export function readBackPlan(operation: WriteOperation, input: WriteInput): ReadBackPlan {
	switch (operation) {
		case "issue.create": {
			const jql = `project = ${jqlString(input.projectKey as string)} AND summary ~ ${jqlString(input.summary as string)} ORDER BY created DESC`;
			return { tool: "jira_search", args: { jql, limit: 20, fields: "summary,issuetype,created" } };
		}
		case "issue.update":
			return { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: [...Object.keys(input.fields as Record<string, unknown>), "updated"].join(",") } };
		case "issue.comment":
		case "issue.comment.update":
			return { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: "comment,updated", comment_limit: 100 } };
		case "issue.attach":
			return { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: "attachment,updated" } };
		case "issue.transition":
			return { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: "status,updated" } };
		case "issue.assign":
			return { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: "assignee,updated" } };
		case "issue.delete":
			return { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: "summary,updated" } };
		case "page.create": {
			const cql = `type = page AND space = ${cqlString(input.spaceKey as string)} AND title = ${cqlString(input.title as string)}`;
			return { tool: "confluence_search", args: { query: cql, limit: 20 } };
		}
		case "page.update":
		case "page.delete":
			return { tool: "confluence_get_page", args: { page_id: input.pageId, include_metadata: true } };
		case "page.comment":
			return { tool: "confluence_get_comments", args: { page_id: input.pageId } };
		case "page.attach":
		case "page.attachment.delete":
			return { tool: "confluence_get_attachments", args: { content_id: input.pageId } };
	}
}

// A Jira status is identified by its name; its category ("To Do", "In
// Progress", "Done") groups statuses and is not itself a status. `sameValue`
// would match a status record by any of its string fields, so a transition
// or a live status whose category happens to equal the wanted text would
// false-match. Compare only the name.
function sameStatus(wanted: string, observed: unknown): boolean {
	const target = normalised(wanted);
	if (target.length === 0) return false;
	if (typeof observed === "string") return normalised(observed) === target;
	const name = isRecord(observed) ? stringAt(observed, "name") : undefined;
	return name !== undefined && normalised(name) === target;
}

// The live transition whose destination is the requested status, from the
// Community transition list ({id, name, to_status?: {name}}). When the site
// reports no destination (observed live), the transition name is the status
// it leads to.
export function transitionTo(reply: unknown, toStatus: string): string | undefined {
	const wanted = normalised(toStatus);
	if (wanted.length === 0) return undefined;
	for (const record of records(unwrapReply(reply))) {
		const id = stringAt(record, "id");
		if (id === undefined || !("name" in record)) continue;
		const destination = isRecord(record.to_status) ? record.to_status : isRecord(record.to) ? record.to : undefined;
		const matches = destination !== undefined ? sameStatus(toStatus, destination) : sameStatus(toStatus, record.name);
		if (matches) return id;
	}
	return undefined;
}

const UNASSIGNED = "unassigned";

// Whether the observed assignee is the requested one, or nobody when the
// request names nobody.
function assigneeMatches(wanted: unknown, observed: unknown): boolean {
	if (wanted === undefined) return observed === undefined || observed === null || sameValue(UNASSIGNED, observed);
	return sameValue(wanted, observed);
}

const EMPTY_BASELINE: WriteBaseline = { effectIds: [], commentIds: [], revision: null };

function newEffects(kind: Effect["kind"], ids: Iterable<string>, baseline: readonly string[]): ReadBack {
	const novel = [...new Set(ids)].filter((id) => !baseline.includes(id));
	return novel.length === 0 ? { kind: "absent", revisionUnchanged: false } : { kind: "found", effects: novel.map((id) => ({ kind, id })) };
}

type IssueCreateMatch = string | { reason: string } | undefined;

function issueTypeName(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	return isRecord(value) && typeof value.name === "string" ? value.name : undefined;
}

// A search result is either the REST shape (summary and issuetype under
// fields) or the Community v0.23.1 shape (summary and issue_type beside the
// key). A record with neither its own key nor a fields object is a nested
// fragment, never a candidate.
function issueCreateMatch(record: Record<string, unknown>, wanted: string, wantedType: string, projectKey: string): IssueCreateMatch {
	const nested = isRecord(record.fields) ? record.fields : undefined;
	if (nested === undefined && stringAt(record, "key") === undefined) return undefined;
	const fields = nested ?? record;
	const summary = stringAt(fields, "summary");
	if (summary === undefined || normalised(summary) !== wanted) return undefined;
	const observedType = issueTypeName(fields.issuetype ?? fields.issue_type);
	const normalisedObservedType = observedType === undefined ? undefined : normalised(observedType);
	if (normalisedObservedType === undefined || normalisedObservedType.length === 0) return { reason: "a matching issue search result carries no stable issue type" };
	if (normalisedObservedType !== wantedType) return undefined;
	const id = stringAt(record, "key");
	if (id === undefined || !ISSUE_KEY.test(id) || !id.startsWith(`${projectKey}-`)) return { reason: "a matching issue search result carries no stable issue key" };
	return id;
}

function issueCreateEvidence(input: WriteInput, reply: unknown, baseline: WriteBaseline): ReadBack {
	const wanted = normalised(input.summary as string);
	if (wanted.length === 0) return { kind: "indeterminate", reason: "the requested issue summary has no stable read-back representation" };
	const wantedType = normalised(input.issueType as string);
	if (wantedType.length === 0) return { kind: "indeterminate", reason: "the requested issue type has no stable read-back representation" };
	const ids = new Set<string>();
	for (const record of records(unwrapReply(reply))) {
		const match = issueCreateMatch(record, wanted, wantedType, input.projectKey as string);
		if (typeof match === "string") ids.add(match);
		else if (match !== undefined) return { kind: "indeterminate", reason: match.reason };
	}
	return newEffects("jira-issue", ids, baseline.effectIds);
}

// A wanted value matches an observed scalar, list, or record. A record matches
// when any of its own string values is the wanted text, which covers a user
// named by email, display name, or account id, and a named option.
const sameValue = (wanted: unknown, observed: unknown): boolean => {
	if (typeof wanted === "string") {
		const normalisedWanted = normalised(wanted);
		if (normalisedWanted.length === 0) return false;
		if (typeof observed === "string") return normalised(observed) === normalisedWanted;
		if (!isRecord(observed)) return false;
		return Object.values(observed).some((value) => typeof value === "string" && normalised(value) === normalisedWanted) || normalised(bodyText(observed)) === normalisedWanted;
	}
	if (Array.isArray(wanted)) return Array.isArray(observed) && wanted.length === observed.length && wanted.every((entry, index) => sameValue(entry, observed[index]));
	return observed === wanted || String(observed) === String(wanted);
};

const wantedFields = (input: WriteInput) => input.fields as Record<string, unknown>;

function fieldsHold(issue: IssueObservation, wanted: Record<string, unknown>): boolean {
	return Object.entries(wanted).every(([key, value]) => key in issue.fields && sameValue(value, issue.fields[key]));
}

function issueUpdateEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply is not an issue" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	if (issue.revision === null || baseline.revision === null) return { kind: "indeterminate", reason: "the Jira reply carries no revision" };
	// The preview refused a no-op, so the requested values present now were
	// not present before the write.
	if (fieldsHold(issue, wantedFields(input))) return { kind: "found", effects: [{ kind: "jira-issue", id: issue.key }] };
	return { kind: "absent", revisionUnchanged: revisionMatches(issue.revision) };
}

function issueStateEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline, holds: (issue: IssueObservation) => boolean): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply is not an issue" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	if (issue.revision === null || baseline.revision === null) return { kind: "indeterminate", reason: "the Jira reply carries no revision" };
	if (holds(issue)) return { kind: "found", effects: [{ kind: "jira-issue", id: issue.key }] };
	return { kind: "absent", revisionUnchanged: revisionMatches(issue.revision) };
}

const statusHolds = (input: WriteInput) => (issue: IssueObservation) => sameStatus(input.toStatus as string, issue.fields.status);
const assigneeHolds = (input: WriteInput) => (issue: IssueObservation) => assigneeMatches(input.assignee, issue.fields.assignee);

function issueCommentEvidence(input: WriteInput, reply: unknown, baseline: WriteBaseline): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply names no issue key" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	return commentEvidence("jira-comment", input.body as string, issue.comments, baseline, issue.browseOrigin);
}

function issueCommentUpdateEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply names no issue key" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	const comment = issue.comments.find((entry) => entry.id === input.commentId);
	if (comment === undefined) return { kind: "indeterminate", reason: "the read-back reply names no such comment" };
	const wanted = jiraCommentNormalised(input.body as string, issue.browseOrigin);
	if (wanted.length === 0) return { kind: "indeterminate", reason: "the requested comment has no stable read-back representation" };
	if (jiraCommentNormalised(comment.text, issue.browseOrigin) === wanted) return { kind: "found", effects: [{ kind: "jira-comment", id: comment.id }] };
	return { kind: "absent", revisionUnchanged: comment.updated !== undefined && revisionMatches(comment.updated) };
}

function issueAttachEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply names no issue key" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	const name = path.basename(input.file as string);
	const found = newEffects("jira-attachment", issue.attachments.filter((entry) => entry.name === name).map((entry) => entry.id), baseline.effectIds);
	if (found.kind === "found") return found;
	return { kind: "absent", revisionUnchanged: issue.revision !== null && revisionMatches(issue.revision) };
}

// The Community update tool reports a failed upload inside an otherwise
// successful reply; the issue is then untouched.
export function uploadFailed(reply: unknown): boolean {
	for (const record of records(unwrapReply(reply))) {
		const results = record.attachment_results;
		if (isRecord(results) && Array.isArray(results.failed) && results.failed.length > 0) return true;
		if (isRecord(results) && results.success === false) return true;
	}
	return false;
}

// A delete's read-back succeeding means the object is still there. Its
// absence is proven only by the Provider's not-found refusal, which the
// dispatcher maps to a found effect before this function is reached.
function issueDeleteEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply names no issue key" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	return { kind: "absent", revisionUnchanged: issue.revision !== null && revisionMatches(issue.revision) };
}

function pageDeleteEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown): ReadBack {
	const page = observePage(reply);
	if (page.id === undefined) return { kind: "indeterminate", reason: "the read-back reply names no page" };
	if (page.id !== input.pageId) return { kind: "indeterminate", reason: "the read-back reply names a different page" };
	return { kind: "absent", revisionUnchanged: page.version !== null && revisionMatches(page.version) };
}

function commentEvidence(kind: Effect["kind"], body: string, comments: { id: string; text: string }[], baseline: WriteBaseline, issueOrigin?: string): ReadBack {
	const wanted = kind === "jira-comment" ? jiraCommentNormalised(body, issueOrigin) : normalised(body);
	if (wanted.length === 0) return { kind: "indeterminate", reason: "the requested comment has no stable read-back representation" };
	return newEffects(
		kind,
		comments.filter((comment) => (kind === "jira-comment" ? jiraCommentNormalised(comment.text, issueOrigin) : normalised(comment.text)) === wanted).map((comment) => comment.id),
		baseline.commentIds,
	);
}

function pageCreateRecordEvidence(record: Record<string, unknown>, wanted: string, spaceKey: string): { id: string } | { reason: string } | undefined {
	const title = stringAt(record, "title");
	if (title === undefined || normalised(title) !== wanted) return undefined;
	if (!("id" in record) && !("space" in record) && !("spaceKey" in record)) return undefined;
	const id = stringAt(record, "id");
	if (id === undefined || !NUMERIC_ID.test(id)) return { reason: "a matching page search result carries no stable content id" };
	const spaceRecord = isRecord(record.space) ? record.space : {};
	const observedKey = stringAt(record, "spaceKey") ?? stringAt(spaceRecord, "key");
	if (observedKey === undefined) return { reason: "a matching title was found but the reply names no space" };
	return observedKey === spaceKey ? { id } : undefined;
}

function pageCreateEvidence(input: WriteInput, reply: unknown, baseline: WriteBaseline): ReadBack {
	const wanted = normalised(input.title as string);
	if (wanted.length === 0) return { kind: "indeterminate", reason: "the requested page title has no stable read-back representation" };
	const ids = new Set<string>();
	for (const record of records(unwrapReply(reply))) {
		const evidence = pageCreateRecordEvidence(record, wanted, input.spaceKey as string);
		if (evidence === undefined) continue;
		if ("reason" in evidence) return { kind: "indeterminate", reason: evidence.reason };
		ids.add(evidence.id);
	}
	return newEffects("confluence-content", ids, baseline.effectIds);
}

function pageUpdateEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline): ReadBack {
	const page = observePage(reply);
	if (page.id === undefined) return { kind: "indeterminate", reason: "the read-back reply names no page" };
	if (page.id !== input.pageId) return { kind: "indeterminate", reason: "the read-back reply names a different page" };
	if (page.version === null || baseline.revision === null) return { kind: "indeterminate", reason: "the read-back reply carries no stable version" };
	if (revisionMatches(page.version)) return { kind: "absent", revisionUnchanged: true };
	const wantedBody = normalised(input.body as string);
	const bodyMatches = wantedBody.length > 0 && normalised(page.body) === wantedBody;
	const wantedTitle = input.title === undefined ? undefined : normalised(input.title as string);
	const titleMatches = wantedTitle === undefined || (wantedTitle.length > 0 && page.title !== undefined && normalised(page.title) === wantedTitle);
	if (bodyMatches && titleMatches) return { kind: "found", effects: [{ kind: "confluence-content", id: input.pageId as string }] };
	return { kind: "indeterminate", reason: "the page moved to another version whose content is not this update" };
}

function pageCommentEvidence(input: WriteInput, reply: unknown, baseline: WriteBaseline): ReadBack {
	const observedPage = pageIdentity(reply, false);
	if (observedPage !== undefined && observedPage !== input.pageId) return { kind: "indeterminate", reason: "the read-back reply names a different page" };
	const comments: { id: string; text: string }[] = [];
	for (const record of records(unwrapReply(reply))) {
		const id = stringAt(record, "id");
		if (id !== undefined && EFFECT_ID.test(id) && "body" in record) comments.push({ id, text: normalised(bodyText(record.body)) });
	}
	return commentEvidence("confluence-comment", input.body as string, comments, baseline);
}

// Removal is proven by the attachment no longer being listed; a listing that
// still carries it proves the delete did not land.
function pageAttachmentDeleteEvidence(input: WriteInput, reply: unknown): ReadBack {
	const observedPage = pageIdentity(reply, false);
	if (observedPage !== undefined && observedPage !== input.pageId) return { kind: "indeterminate", reason: "the read-back reply names a different page" };
	const present = records(unwrapReply(reply)).some((record) => attachmentId(record) === input.attachmentId);
	return present ? { kind: "absent", revisionUnchanged: true } : { kind: "found", effects: [{ kind: "confluence-attachment", id: input.attachmentId as string }] };
}

function pageAttachEvidence(input: WriteInput, reply: unknown, baseline: WriteBaseline): ReadBack {
	const observedPage = pageIdentity(reply, false);
	if (observedPage !== undefined && observedPage !== input.pageId) return { kind: "indeterminate", reason: "the read-back reply names a different page" };
	const ids: string[] = [];
	for (const record of records(unwrapReply(reply))) {
		const id = attachmentRecord(record, input.file as string);
		if (id !== undefined) ids.push(id);
	}
	return newEffects("confluence-attachment", ids, baseline.effectIds);
}

// Whether an observed revision is the one the preview bound. The apply flow
// compares values; adjudication compares against the persisted digest.
export type RevisionMatch = (observed: string) => boolean;

// The read-back plan's reply, judged against the neutral input: the effect
// found, proven absent (only an unchanged revision proves absence after a
// send), or indeterminate.
export function readBackEvidence(operation: WriteOperation, input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline = EMPTY_BASELINE): ReadBack {
	switch (operation) {
		case "issue.create":
			return issueCreateEvidence(input, reply, baseline);
		case "issue.update":
			return issueUpdateEvidence(input, revisionMatches, reply, baseline);
		case "issue.comment":
			return issueCommentEvidence(input, reply, baseline);
		case "issue.comment.update":
			return issueCommentUpdateEvidence(input, revisionMatches, reply);
		case "issue.attach":
			return issueAttachEvidence(input, revisionMatches, reply, baseline);
		case "issue.transition":
			return issueStateEvidence(input, revisionMatches, reply, baseline, statusHolds(input));
		case "issue.assign":
			return issueStateEvidence(input, revisionMatches, reply, baseline, assigneeHolds(input));
		case "issue.delete":
			return issueDeleteEvidence(input, revisionMatches, reply);
		case "page.create":
			return pageCreateEvidence(input, reply, baseline);
		case "page.update":
			return pageUpdateEvidence(input, revisionMatches, reply, baseline);
		case "page.comment":
			return pageCommentEvidence(input, reply, baseline);
		case "page.attach":
			return pageAttachEvidence(input, reply, baseline);
		case "page.attachment.delete":
			return pageAttachmentDeleteEvidence(input, reply);
		case "page.delete":
			return pageDeleteEvidence(input, revisionMatches, reply);
	}
}

// What the preparatory read established: the baseline to compare against, a
// refusal when the write would change nothing, or an indeterminate reply.
export type BaselineObservation = { kind: "observed"; baseline: WriteBaseline } | { kind: "refused"; reason: string } | { kind: "indeterminate"; reason: string };

function evidenceIds(evidence: ReadBack): string[] {
	return evidence.kind === "found" ? evidence.effects.map((effect) => effect.id) : [];
}

function baselineWithEffectIds(evidence: ReadBack): BaselineObservation {
	if (evidence.kind === "indeterminate") return evidence;
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: evidenceIds(evidence) } };
}

function baselineWithCommentIds(evidence: ReadBack): BaselineObservation {
	if (evidence.kind === "indeterminate") return evidence;
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, commentIds: evidenceIds(evidence) } };
}

// Timestamps and text snapshots enter the persisted baseline only as a digest,
// which fits the journal's stable-revision shape.
const digest = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

type Indeterminate = { kind: "indeterminate"; reason: string };

function issueFor(input: WriteInput, reply: unknown): IssueObservation | Indeterminate {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the Jira reply names no issue key" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the Jira reply names a different issue" };
	return issue;
}

const isIndeterminate = <T>(value: T | Indeterminate): value is Indeterminate => typeof value === "object" && value !== null && "kind" in value;

function issueCommentBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const issue = issueFor(input, reply);
	if (isIndeterminate(issue)) return issue;
	const observed = baselineWithCommentIds(commentEvidence("jira-comment", input.body as string, issue.comments, EMPTY_BASELINE, issue.browseOrigin));
	return observed.kind !== "observed" ? observed : { kind: "observed", baseline: { ...observed.baseline, effectIds: [issue.key as string] } };
}

function issueCommentUpdateBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const issue = issueFor(input, reply);
	if (isIndeterminate(issue)) return issue;
	const comment = issue.comments.find((entry) => entry.id === input.commentId);
	if (comment === undefined) return { kind: "indeterminate", reason: "the Jira reply names no such comment on this issue" };
	if (comment.updated === undefined) return { kind: "indeterminate", reason: "the comment read exposes no updated timestamp to bind the revision" };
	if (jiraCommentNormalised(comment.text, issue.browseOrigin) === jiraCommentNormalised(input.body as string, issue.browseOrigin)) return { kind: "refused", reason: "the comment already holds the requested body; nothing to change" };
	return { kind: "observed", baseline: { effectIds: [issue.key as string], commentIds: [comment.id], revision: digest(comment.updated) } };
}

function pageCommentBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const observed = baselineWithCommentIds(pageCommentEvidence(input, reply, EMPTY_BASELINE));
	return observed.kind !== "observed" ? observed : { kind: "observed", baseline: { ...observed.baseline, effectIds: [input.pageId as string] } };
}

// The requested values must differ from the current ones, so a later
// read-back that shows them proves this write and not the status quo. The
// baseline revision is a digest of the current values of the requested fields.
function issueUpdateBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const issue = issueFor(input, reply);
	if (isIndeterminate(issue)) return issue;
	if (issue.revision === null) return { kind: "indeterminate", reason: "the Jira reply carries no revision" };
	const wanted = wantedFields(input);
	if (fieldsHold(issue, wanted)) return { kind: "refused", reason: "the issue already holds every requested value; nothing to change" };
	const snapshot = Object.fromEntries(Object.keys(wanted).map((key) => [key, issue.fields[key] ?? null]));
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [issue.key as string], revision: digest(JSON.stringify(snapshot)) } };
}

// A state change must change state: the current status or assignee is
// digested as the baseline revision and a target already there is refused.
function issueStateBaseline(input: WriteInput, reply: unknown, holds: (issue: IssueObservation) => boolean, field: string, what: string): BaselineObservation {
	const issue = issueFor(input, reply);
	if (isIndeterminate(issue)) return issue;
	if (issue.revision === null) return { kind: "indeterminate", reason: "the Jira reply carries no revision" };
	if (holds(issue)) return { kind: "refused", reason: `the issue already has the requested ${what}; nothing to change` };
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [issue.key as string], revision: digest(JSON.stringify(issue.fields[field] ?? null)) } };
}

function pageAttachmentDeleteBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const observedPage = pageIdentity(reply, false);
	if (observedPage !== undefined && observedPage !== input.pageId) return { kind: "indeterminate", reason: "the attachment listing names a different page" };
	const present = records(unwrapReply(reply)).some((record) => attachmentId(record) === input.attachmentId);
	if (!present) return { kind: "refused", reason: "the page has no attachment with that id" };
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [input.attachmentId as string] } };
}

function issueDeleteBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const issue = issueFor(input, reply);
	if (isIndeterminate(issue)) return issue;
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [issue.key as string], revision: issue.revision === null ? null : digest(issue.revision) } };
}

function pageRevisionBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const page = observePage(reply);
	if (page.id === undefined) return { kind: "indeterminate", reason: "the page read names no page id" };
	if (page.id !== input.pageId) return { kind: "indeterminate", reason: "the page read names a different page" };
	if (page.version === null) return { kind: "indeterminate", reason: "the page read exposes no stable version" };
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [input.pageId as string], revision: page.version } };
}

// Capture only the pre-existing candidates that could otherwise be mistaken
// for this write. The later read-back must name a different stable identifier,
// or, for an update, the requested values that were absent before.
export function baselineFromReply(operation: WriteOperation, input: WriteInput, reply: unknown): BaselineObservation {
	switch (operation) {
		case "issue.create":
			return baselineWithEffectIds(issueCreateEvidence(input, reply, EMPTY_BASELINE));
		case "issue.update":
			return issueUpdateBaseline(input, reply);
		case "issue.comment":
			return issueCommentBaseline(input, reply);
		case "issue.comment.update":
			return issueCommentUpdateBaseline(input, reply);
		case "issue.attach":
			return baselineWithEffectIds(issueAttachEvidence(input, () => false, reply, EMPTY_BASELINE));
		case "issue.transition":
			return issueStateBaseline(input, reply, statusHolds(input), "status", "status");
		case "issue.assign":
			return issueStateBaseline(input, reply, assigneeHolds(input), "assignee", "assignee");
		case "issue.delete":
			return issueDeleteBaseline(input, reply);
		case "page.create":
			return baselineWithEffectIds(pageCreateEvidence(input, reply, EMPTY_BASELINE));
		case "page.update":
		case "page.delete":
			return pageRevisionBaseline(input, reply);
		case "page.comment":
			return pageCommentBaseline(input, reply);
		case "page.attach": {
			// Confluence replaces a same-named attachment under its existing id rather
			// than creating a new one, which no later read-back can tell apart from no
			// upload at all. Refuse here, before the write leaves the operator with an
			// unresolvable receipt; SKILL.md already directs page.attachment.delete first.
			const existing = pageAttachEvidence(input, reply, EMPTY_BASELINE);
			if (existing.kind === "indeterminate") return existing;
			if (records(unwrapReply(reply)).some((record) => attachmentNameMatches(record, input.file as string))) {
				return { kind: "refused", reason: "the page already has an attachment with this file name; run page.attachment.delete first" };
			}
			return baselineWithEffectIds(existing);
		}
		case "page.attachment.delete":
			return pageAttachmentDeleteBaseline(input, reply);
	}
}
