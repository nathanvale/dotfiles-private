// Write policy for the six Atlassian write operations, pure and I/O free.
// One neutral input contract per operation; provider argument adapters for
// Official and Community; the preparatory read each write needs (revision,
// snapshot token, space identity); effect extraction from a provider reply;
// and read-back evidence for operator adjudication. Provider names are taken
// from current provider documentation and are confirmed only by the live
// schema at dispatch time; nothing here assumes a reply shape without checking.
import { WRITE_OPERATION_IDS, type OperationSpec, type ProviderName } from "./contract.ts";
import { collectInput } from "./engine.ts";
import type { Effect, WriteBaseline, WriteOperation } from "./journal.ts";

export type WriteInput = Record<string, unknown>;
export type WriteValidation = { ok: true; input: WriteInput } | { ok: false; reason: string };

type Field =
	| { kind: "text"; required: boolean; pattern?: RegExp }
	| { kind: "body"; required: boolean }
	| { kind: "fields"; required: boolean }
	| { kind: "space"; required: boolean };

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const SPACE_KEY = /^[A-Za-z0-9~][A-Za-z0-9_.-]{0,254}$/;
const BODY_LIMIT = 200_000;

// Neutral input per write operation. Unknown keys are refused so a caller
// cannot smuggle provider arguments through the semantic seam. `space` takes
// the numeric id, the key, or both; the id is the one canonical container.
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
	"page.create": {
		space: { kind: "space", required: true },
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
};

export const WRITE_OPERATIONS = WRITE_OPERATION_IDS;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown, pattern?: RegExp): value is string =>
	typeof value === "string" && value.trim().length > 0 && !value.includes("\n") && value.length <= 1024 && (pattern === undefined || pattern.test(value));

function validSpace(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length === 0 || keys.some((key) => key !== "id" && key !== "key")) return false;
	if ("id" in value && !(typeof value.id === "string" && NUMERIC_ID.test(value.id))) return false;
	if ("key" in value && !(typeof value.key === "string" && SPACE_KEY.test(value.key))) return false;
	return true;
}

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
		case "space":
			return validSpace(value);
	}
}

export function writeInput(operation: WriteOperation, raw: unknown): WriteValidation {
	return collectInput(raw, WRITE_INPUTS[operation], validField);
}

export const spaceOf = (input: WriteInput): { id?: string; key?: string } => (isRecord(input.space) ? (input.space as { id?: string; key?: string }) : {});

// What a write needs to read before it can be previewed or applied. The read
// is repeated at apply so the revision and token are current, and the journal
// refuses the apply when the revision moved. Comments and Jira creates bind no
// revision: a changed issue is still the same comment target.
export type Preparation =
	| { kind: "none" }
	| { kind: "issue"; issueKey: string }
	| { kind: "page"; pageId: string }
	| { kind: "space"; key?: string; id?: string }
	| { kind: "refused"; reason: string };

export function preparation(operation: WriteOperation, provider: ProviderName, input: WriteInput): Preparation {
	switch (operation) {
		case "issue.create":
		case "issue.comment":
			return { kind: "none" };
		case "issue.update":
			return { kind: "issue", issueKey: input.issueKey as string };
		case "page.update":
		case "page.comment":
			return { kind: "page", pageId: input.pageId as string };
		case "page.create": {
			const space = spaceOf(input);
			if (space.key !== undefined) return space.id === undefined ? { kind: "space", key: space.key } : { kind: "space", key: space.key, id: space.id };
			if (space.id !== undefined && provider === "official") return { kind: "space", id: space.id };
			return { kind: "refused", reason: "the Community route needs space.key; supply space as {id, key}" };
		}
	}
}

export interface PreparedContext {
	cloudId?: string;
	// Revision of the target as observed by the preparatory read; null when the
	// operation binds none.
	revision: string | null;
	// Official Confluence updates must carry the snapshot token of the version
	// that was read; it is sent but never digested, because the revision
	// already binds it.
	snapshotToken?: string;
	// Current title of a page, needed by Community updates that keep it.
	currentTitle?: string;
	// Space resolved from a key when the input carried none.
	spaceId?: string;
	// An exact false observation is durable preview evidence. It is re-read at
	// apply; true, absent, and malformed never reach a provider write.
	spaceInstructions?: false;
	// Provider identifiers and stable revisions observed before the write. This
	// is persisted with the preview and compared by read-back, not inferred from
	// text that may have existed before the preview.
	baseline: WriteBaseline;
}

export interface ShapedArguments {
	args: Record<string, unknown>;
	// The subset of args the journal digests: everything except tokens that are
	// implied by the bound revision.
	bound: Record<string, unknown>;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

// Fields both providers take under the same name for a Jira create.
function assignIssueCreateCommon(args: Record<string, unknown>, input: WriteInput): void {
	for (const key of ["summary", "description", "assignee"]) assign(args, key, input[key]);
}

function officialArguments(operation: WriteOperation, input: WriteInput, ctx: PreparedContext): ShapedArguments {
	const args: Record<string, unknown> = {};
	assign(args, "cloudId", ctx.cloudId);
	switch (operation) {
		case "issue.create":
			assign(args, "projectKey", input.projectKey);
			assign(args, "issueType", input.issueType);
			assignIssueCreateCommon(args, input);
			break;
		case "issue.update":
			assign(args, "issueIdOrKey", input.issueKey);
			assign(args, "fields", input.fields);
			if (isRecord(input.fields) && "description" in input.fields) args.contentFormat = "markdown";
			break;
		case "issue.comment":
			assign(args, "issueIdOrKey", input.issueKey);
			assign(args, "commentBody", input.body);
			break;
		case "page.create": {
			const parent: Record<string, unknown> = { spaceId: spaceOf(input).id ?? ctx.spaceId };
			assign(parent, "parentContentId", input.parentId);
			args.parent = parent;
			args.contentType = "page";
			assign(args, "title", input.title);
			args.body = { format: "markdown", value: input.body };
			break;
		}
		case "page.update": {
			assign(args, "contentId", input.pageId);
			assign(args, "title", input.title);
			args.body = { format: "markdown", value: input.body };
			assign(args, "versionMessage", input.versionMessage);
			assign(args, "snapshotToken", ctx.snapshotToken);
			return { args, bound: args };
		}
		case "page.comment":
			// Deferred on the default Official endpoint; the contract marks it
			// unavailable there, so this arm is never reached in dispatch.
			assign(args, "pageId", input.pageId);
			assign(args, "body", input.body);
			break;
	}
	return { args, bound: args };
}

function communityArguments(operation: WriteOperation, input: WriteInput, ctx: PreparedContext): ShapedArguments {
	const args: Record<string, unknown> = {};
	switch (operation) {
		case "issue.create":
			assign(args, "project_key", input.projectKey);
			assign(args, "issue_type", input.issueType);
			assignIssueCreateCommon(args, input);
			break;
		case "issue.update":
			assign(args, "issue_key", input.issueKey);
			args.fields = JSON.stringify(input.fields);
			break;
		case "issue.comment":
			assign(args, "issue_key", input.issueKey);
			assign(args, "body", input.body);
			break;
		case "page.create":
			assign(args, "space_key", spaceOf(input).key);
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
	}
	return { args, bound: args };
}

export function writeArguments(spec: OperationSpec, provider: ProviderName, input: WriteInput, ctx: PreparedContext): ShapedArguments {
	const operation = spec.id as WriteOperation;
	return provider === "official" ? officialArguments(operation, input, ctx) : communityArguments(operation, input, ctx);
}

// Effect kinds per operation; the id comes from the provider reply.
const EFFECT_KIND: Record<WriteOperation, Effect["kind"]> = {
	"issue.create": "jira-issue",
	"issue.update": "jira-issue",
	"issue.comment": "jira-comment",
	"page.create": "confluence-content",
	"page.update": "confluence-content",
	"page.comment": "confluence-comment",
};

const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

// MCPorter returns tool text content; a JSON string inside a text block is
// unwrapped once so provider replies serialised as text still yield records.
export function unwrapReply(data: unknown): unknown {
	if (!isRecord(data) || !Array.isArray(data.content)) return data;
	const texts = data.content.filter((entry): entry is { type: "text"; text: string } => isRecord(entry) && entry.type === "text" && typeof entry.text === "string");
	if (texts.length !== 1) return data;
	try {
		return JSON.parse(texts[0]?.text ?? "");
	} catch {
		return data;
	}
}

// The identifier of the object a write created or changed, read from the
// provider reply. Updates fall back to the target the caller named, because
// an update reply may carry no identifier at all.
export function effectsFromReply(operation: WriteOperation, input: WriteInput, reply: unknown): Effect[] {
	const kind = EFFECT_KIND[operation];
	const target = operation === "issue.update" ? (input.issueKey as string) : operation === "page.update" ? (input.pageId as string) : undefined;
	if (target !== undefined) return [{ kind, id: target }];
	for (const record of records(unwrapReply(reply))) {
		const id = operation === "issue.create" ? stringAt(record, "key") : stringAt(record, "id");
		if (id !== undefined && EFFECT_ID.test(id) && (operation !== "issue.create" || ISSUE_KEY.test(id))) {
			// A created issue or page appears as its own record; a comment id
			// must come from a record that also carries a body.
			if (kind.endsWith("-comment") && !("body" in record)) continue;
			return [{ kind, id }];
		}
	}
	return [];
}

// Normalised text for read-back matching: case, whitespace, and punctuation
// are not part of a comment's or title's identity across providers.
export const normalised = (value: string): string =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

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
	snapshotToken: string | undefined;
	title: string | undefined;
	spaceId: string | undefined;
	spaceInstructions: false | true | undefined;
	body: string;
}

type PageObservationState = Omit<PageObservation, "body">;

function pageVersion(record: Record<string, unknown>): string | undefined {
	const own = record.version;
	if (typeof own === "number" && Number.isInteger(own) && own > 0) return String(own);
	if (isRecord(own) && typeof own.number === "number") return String(own.number);
	return undefined;
}

function pageSpaceId(record: Record<string, unknown>): string | undefined {
	const direct = stringAt(record, "spaceId");
	if (direct !== undefined) return direct;
	return isRecord(record.space) ? stringAt(record.space, "id") : undefined;
}

function pageSpaceInstructions(record: Record<string, unknown>): false | true | undefined {
	const metadata = record.metadata;
	if (!isRecord(metadata) || !("hasSpaceInstructions" in metadata)) return undefined;
	const value = metadata.hasSpaceInstructions;
	return value === false || value === true ? value : undefined;
}

function observePageRecord(previous: PageObservationState, record: Record<string, unknown>): PageObservationState {
	return {
		id: previous.id,
		version: previous.version ?? pageVersion(record) ?? null,
		snapshotToken: previous.snapshotToken ?? stringAt(record, "snapshotToken"),
		title: previous.title ?? stringAt(record, "title"),
		spaceId: previous.spaceId ?? pageSpaceId(record),
		spaceInstructions: previous.spaceInstructions ?? pageSpaceInstructions(record),
	};
}

export function observePage(reply: unknown): PageObservation {
	const data = unwrapReply(reply);
	const top = isRecord(data) ? data : {};
	let observation: PageObservationState = { id: stringAt(top, "id"), version: null, snapshotToken: undefined, title: undefined, spaceId: undefined, spaceInstructions: undefined };
	for (const record of records(data)) {
		observation = observePageRecord(observation, record);
	}
	return { ...observation, body: bodyText(data) };
}

export function observeSpaceInstructions(reply: unknown): false | true | undefined {
	const data = unwrapReply(reply);
	if (!isRecord(data) || !isRecord(data.metadata) || !("hasSpaceInstructions" in data.metadata)) return undefined;
	const value = data.metadata.hasSpaceInstructions;
	return value === false || value === true ? value : undefined;
}

export interface IssueObservation {
	key: string | undefined;
	// Jira's `updated` timestamp is not a stable revision and is never evidence
	// for an unknown write. A provider must expose an explicit version/revision.
	revision: string | null;
	fields: Record<string, unknown>;
	comments: { id: string; text: string }[];
}

export function observeIssue(reply: unknown): IssueObservation {
	const data = unwrapReply(reply);
	const top = isRecord(data) ? data : {};
	const fields = isRecord(top.fields) ? { ...top, ...top.fields } : top;
	const comments: { id: string; text: string }[] = [];
	for (const record of records(data)) {
		const id = stringAt(record, "id");
		if (id !== undefined && "body" in record && EFFECT_ID.test(id) && !("key" in record)) comments.push({ id, text: normalised(bodyText(record.body)) });
	}
	return { key: stringAt(top, "key"), revision: stringAt(fields, "version", "revision") ?? null, fields, comments };
}

export type ReadBack =
	| { kind: "found"; effects: Effect[] }
	| { kind: "absent"; revisionUnchanged: boolean }
	| { kind: "indeterminate"; reason: string };

// Which read proves a write's effect, per provider. The dispatcher runs it and
// hands the reply back to readBackEvidence.
export type ReadBackPlan = { tool: string; args: Record<string, unknown> } | { refused: string };

const jqlString = (value: string) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
const cqlString = jqlString;

export function readBackPlan(operation: WriteOperation, provider: ProviderName, input: WriteInput, cloudId: string | undefined): ReadBackPlan {
	const official = provider === "official";
	const withCloud = (args: Record<string, unknown>) => (official ? { cloudId, ...args } : args);
	switch (operation) {
		case "issue.create": {
			const jql = `project = ${jqlString(input.projectKey as string)} AND summary ~ ${jqlString(input.summary as string)} ORDER BY created DESC`;
			return official ? { tool: "searchJiraIssuesUsingJql", args: withCloud({ jql, maxResults: 20, fields: ["summary", "issuetype", "created"] }) } : { tool: "jira_search", args: { jql, limit: 20, fields: "summary,issuetype,created" } };
		}
		case "issue.update":
			return official
				? { tool: "getJiraIssue", args: withCloud({ issueIdOrKey: input.issueKey, fields: [...Object.keys(input.fields as Record<string, unknown>), "version"] }) }
				: { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: [...Object.keys(input.fields as Record<string, unknown>), "version"].join(",") } };
		case "issue.comment":
			return official ? { tool: "getJiraIssue", args: withCloud({ issueIdOrKey: input.issueKey, fields: ["comment", "updated"] }) } : { tool: "jira_get_issue", args: { issue_key: input.issueKey, fields: "comment,updated", comment_limit: 100 } };
		case "page.create": {
			const cql = `type = page AND title = ${cqlString(input.title as string)}`;
			return official ? { tool: "searchConfluence", args: withCloud({ cql, maxResults: 20 }) } : { tool: "confluence_search", args: { query: cql, limit: 20 } };
		}
		case "page.update":
			return official ? { tool: "getConfluenceContent", args: withCloud({ content_id: input.pageId, content_format: "markdown", detail: "full", include_metadata: true }) } : { tool: "confluence_get_page", args: { page_id: input.pageId, include_metadata: true } };
		case "page.comment":
			return official ? { refused: "Official exposes no comment read on the default endpoint" } : { tool: "confluence_get_comments", args: { page_id: input.pageId } };
	}
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

function issueCreateMatch(record: Record<string, unknown>, wanted: string, wantedType: string, projectKey: string): IssueCreateMatch {
	if (!isRecord(record.fields)) return undefined;
	const fields = record.fields;
	const summary = stringAt(fields, "summary");
	if (summary === undefined || normalised(summary) !== wanted) return undefined;
	const observedType = issueTypeName(fields.issuetype);
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

const sameValue = (wanted: unknown, observed: unknown): boolean => {
	if (typeof wanted === "string") {
		const normalisedWanted = normalised(wanted);
		if (normalisedWanted.length === 0) return false;
		return typeof observed === "string" ? normalised(observed) === normalisedWanted : isRecord(observed) && (sameValue(wanted, observed.name) || sameValue(wanted, observed.value) || normalised(bodyText(observed)) === normalisedWanted);
	}
	if (Array.isArray(wanted)) return Array.isArray(observed) && wanted.length === observed.length && wanted.every((entry, index) => sameValue(entry, observed[index]));
	return observed === wanted || String(observed) === String(wanted);
};

function issueUpdateEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline): ReadBack {
	const issue = observeIssue(reply);
	if (issue.key === undefined) return { kind: "indeterminate", reason: "the read-back reply is not an issue" };
	if (issue.key !== input.issueKey) return { kind: "indeterminate", reason: "the read-back reply names a different issue" };
	if (issue.revision === null || baseline.revision === null) return { kind: "indeterminate", reason: "the Jira reply carries no stable revision; live qualification is required" };
	const wanted = input.fields as Record<string, unknown>;
	const observedAll = Object.entries(wanted).every(([key, value]) => key in issue.fields && sameValue(value, issue.fields[key]));
	if (observedAll && !revisionMatches(issue.revision)) return { kind: "found", effects: [{ kind: "jira-issue", id: issue.key }] };
	if (revisionMatches(issue.revision)) return { kind: "absent", revisionUnchanged: true };
	return { kind: "absent", revisionUnchanged: false };
}

function commentEvidence(kind: Effect["kind"], body: string, comments: { id: string; text: string }[], baseline: WriteBaseline): ReadBack {
	const wanted = normalised(body);
	if (wanted.length === 0) return { kind: "indeterminate", reason: "the requested comment has no stable read-back representation" };
	return newEffects(
		kind,
		comments.filter((comment) => comment.text === wanted || (wanted.length >= 24 && comment.text.includes(wanted))).map((comment) => comment.id),
		baseline.commentIds,
	);
}

function pageCreateRecordEvidence(record: Record<string, unknown>, wanted: string, space: { id?: string; key?: string }): { id: string } | { reason: string } | undefined {
	const title = stringAt(record, "title");
	if (title === undefined || normalised(title) !== wanted) return undefined;
	if (!("id" in record) && !("space" in record) && !("spaceId" in record)) return undefined;
	const id = stringAt(record, "id");
	if (id === undefined || !NUMERIC_ID.test(id)) return { reason: "a matching page search result carries no stable content id" };
	const spaceRecord = isRecord(record.space) ? record.space : {};
	const observedId = stringAt(record, "spaceId") ?? stringAt(spaceRecord, "id");
	const observedKey = stringAt(spaceRecord, "key");
	if ((space.id !== undefined && observedId === space.id) || (space.key !== undefined && observedKey === space.key)) return { id };
	if (observedId === undefined && observedKey === undefined) return { reason: "a matching title was found but the reply names no space" };
	return undefined;
}

function pageCreateEvidence(input: WriteInput, reply: unknown, baseline: WriteBaseline): ReadBack {
	const wanted = normalised(input.title as string);
	if (wanted.length === 0) return { kind: "indeterminate", reason: "the requested page title has no stable read-back representation" };
	const space = spaceOf(input);
	const ids = new Set<string>();
	for (const record of records(unwrapReply(reply))) {
		const evidence = pageCreateRecordEvidence(record, wanted, space);
		if (evidence === undefined) continue;
		if ("reason" in evidence) return { kind: "indeterminate", reason: evidence.reason };
		ids.add(evidence.id);
	}
	return newEffects("confluence-content", ids, baseline.effectIds);
}

function pageUpdateEvidence(input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline): ReadBack {
	const page = observePage(reply);
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
	const comments: { id: string; text: string }[] = [];
	for (const record of records(unwrapReply(reply))) {
		const id = stringAt(record, "id");
		if (id !== undefined && EFFECT_ID.test(id) && "body" in record) comments.push({ id, text: normalised(bodyText(record.body)) });
	}
	return commentEvidence("confluence-comment", input.body as string, comments, baseline);
}

// Whether an observed revision is the one the preview bound. The apply flow
// compares values; adjudication compares against the persisted digest.
export type RevisionMatch = (observed: string) => boolean;

// Read-back proof after a write with a lost or uncertain reply. `found` names
// the effect; `absent` with revisionUnchanged proves no effect through a
// monotonic revision; plain `absent` proves nothing after a possible send.
export function readBackEvidence(operation: WriteOperation, input: WriteInput, revisionMatches: RevisionMatch, reply: unknown, baseline: WriteBaseline = EMPTY_BASELINE): ReadBack {
	switch (operation) {
		case "issue.create":
			return issueCreateEvidence(input, reply, baseline);
		case "issue.update":
			return issueUpdateEvidence(input, revisionMatches, reply, baseline);
		case "issue.comment":
			return commentEvidence("jira-comment", input.body as string, observeIssue(reply).comments, baseline);
		case "page.create":
			return pageCreateEvidence(input, reply, baseline);
		case "page.update":
			return pageUpdateEvidence(input, revisionMatches, reply, baseline);
		case "page.comment":
			return pageCommentEvidence(input, reply, baseline);
	}
}

export type BaselineObservation = { kind: "observed"; baseline: WriteBaseline } | { kind: "indeterminate"; reason: string };

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

function issueCreateBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	return baselineWithEffectIds(issueCreateEvidence(input, reply, EMPTY_BASELINE));
}

function pageCreateBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	return baselineWithEffectIds(pageCreateEvidence(input, reply, EMPTY_BASELINE));
}

function issueCommentBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	return baselineWithCommentIds(commentEvidence("jira-comment", input.body as string, observeIssue(reply).comments, EMPTY_BASELINE));
}

function pageCommentBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	return baselineWithCommentIds(pageCommentEvidence(input, reply, EMPTY_BASELINE));
}

function issueUpdateBaseline(_input: WriteInput, reply: unknown): BaselineObservation {
	const issue = observeIssue(reply);
	if (issue.key === undefined || issue.revision === null) return { kind: "indeterminate", reason: "the Jira reply carries no stable revision; live qualification is required" };
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [issue.key], revision: issue.revision } };
}

function pageUpdateBaseline(input: WriteInput, reply: unknown): BaselineObservation {
	const page = observePage(reply);
	if (page.version === null) return { kind: "indeterminate", reason: "the page read exposes no stable version" };
	return { kind: "observed", baseline: { ...EMPTY_BASELINE, effectIds: [input.pageId as string], revision: page.version } };
}

// Capture only the pre-existing candidates that could otherwise be mistaken
// for this write. The later read-back must name a different stable identifier,
// or, for an update, a different stable revision.
export function baselineFromReply(operation: WriteOperation, input: WriteInput, reply: unknown): BaselineObservation {
	switch (operation) {
		case "issue.create":
			return issueCreateBaseline(input, reply);
		case "issue.update":
			return issueUpdateBaseline(input, reply);
		case "issue.comment":
			return issueCommentBaseline(input, reply);
		case "page.create":
			return pageCreateBaseline(input, reply);
		case "page.update":
			return pageUpdateBaseline(input, reply);
		case "page.comment":
			return pageCommentBaseline(input, reply);
	}
}

// Space resolution from a key, through a Confluence search reply: any page in
// the space names its numeric space id. No primary Official or Community tool
// lists spaces directly, so a space with no readable page cannot be resolved.
export function spaceIdFromSearch(key: string, reply: unknown): string | undefined {
	for (const record of records(unwrapReply(reply))) {
		const spaceRecord = isRecord(record.space) ? record.space : undefined;
		const observedKey = spaceRecord ? stringAt(spaceRecord, "key") : stringAt(record, "spaceKey");
		const observedId = (spaceRecord ? stringAt(spaceRecord, "id") : undefined) ?? stringAt(record, "spaceId");
		if (observedKey === key && observedId !== undefined && NUMERIC_ID.test(observedId)) return observedId;
	}
	return undefined;
}

export function spaceSearchPlan(key: string, provider: ProviderName, cloudId: string | undefined): { tool: string; args: Record<string, unknown> } {
	const cql = `type = page AND space = ${cqlString(key)}`;
	return provider === "official" ? { tool: "searchConfluence", args: { cloudId, cql, maxResults: 5 } } : { tool: "confluence_search", args: { query: cql, limit: 5 } };
}
