// The owned Jira REST v2 route for the wiki-comment capability exception
// (ADR 0001 amendment): the exact request each REST tool makes, the static
// schema the dispatcher confirms arguments against, and the reply shape the
// REST Provider hands back. Pure and I/O free; the Provider script performs
// the request and the runtime transport translates the status.
import { isRestTool, REST_TOOLS, type RestTool } from "./contract.ts";
import type { SchemaTool } from "./engine.ts";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const BODY_LIMIT = 200_000;
// Comments render with expand=renderedBody so a reply or read-back can prove
// the <img> elements; the list is newest first and bounded to one page.
const RENDERED = "expand=renderedBody";

export interface RestRequest {
	method: "GET" | "POST" | "PUT";
	// Path and query relative to the Trusted Site Origin; the Provider joins
	// them to the origin its own credential item names, never to an argument.
	path: string;
	body?: { body: string };
	// A bounded binary read: the Provider sends this Range and returns the
	// first bytes as hex instead of parsing JSON.
	range?: string;
}

// How many leading bytes the attachment head read returns: enough for every
// supported image signature (WebP needs 12).
export const HEAD_BYTES = 16;

export interface RestReply {
	status: number;
	body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const issueKey = (value: unknown): value is string => typeof value === "string" && ISSUE_KEY.test(value);
const commentId = (value: unknown): value is string => typeof value === "string" && NUMERIC_ID.test(value);
const attachmentId = commentId;
const wikiBody = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= BODY_LIMIT;

function validArguments(tool: RestTool, args: Record<string, unknown>): boolean {
	const required = REST_TOOLS[tool];
	const keys = Object.keys(args);
	if (keys.length !== required.length || required.some((key) => !(key in args))) return false;
	return keys.every((key) => (key === "issue_key" ? issueKey(args[key]) : key === "comment_id" ? commentId(args[key]) : key === "attachment_id" ? attachmentId(args[key]) : key === "body" ? wikiBody(args[key]) : false));
}

// The exact request for one REST tool, or null when the tool or its arguments
// are outside the closed vocabulary. Every argument that enters a path is
// pattern-checked above, so nothing here can escape its path segment.
export function restRequest(tool: string, args: unknown): RestRequest | null {
	if (!isRestTool(tool) || !isRecord(args) || !validArguments(tool, args)) return null;
	const issue = `/rest/api/2/issue/${args.issue_key as string}`;
	switch (tool) {
		case "jira_rest_myself":
			return { method: "GET", path: "/rest/api/2/myself" };
		case "jira_rest_issue_attachments":
			return { method: "GET", path: `${issue}?fields=attachment,updated` };
		case "jira_rest_comments_list":
			return { method: "GET", path: `${issue}/comment?${RENDERED}&orderBy=-created&maxResults=100` };
		case "jira_rest_comment_get":
			return { method: "GET", path: `${issue}/comment/${args.comment_id as string}?${RENDERED}` };
		case "jira_rest_comment_add":
			return { method: "POST", path: `${issue}/comment?${RENDERED}`, body: { body: args.body as string } };
		case "jira_rest_comment_edit":
			return { method: "PUT", path: `${issue}/comment/${args.comment_id as string}?${RENDERED}`, body: { body: args.body as string } };
		case "jira_rest_attachment_head":
			// redirect=false makes Jira serve the bytes itself instead of a 303 to
			// the media store, which the Provider refuses to follow.
			return { method: "GET", path: `/rest/api/2/attachment/content/${args.attachment_id as string}?redirect=false`, range: `bytes=0-${HEAD_BYTES - 1}` };
	}
}

// The author guard the REST Provider enforces itself before any comment edit,
// whatever process asked for it: the principal and the comment, read through
// the same route, must name one account. The dispatcher runs the same guard
// earlier so a refusal is visible at preview; the Provider's copy is the one
// that binds the credential.
export interface EditGuard {
	myself: RestRequest;
	comment: RestRequest;
}

export function editGuardRequests(args: unknown): EditGuard | null {
	if (!isRecord(args) || !issueKey(args.issue_key) || !commentId(args.comment_id)) return null;
	const myself = restRequest("jira_rest_myself", {});
	const comment = restRequest("jira_rest_comment_get", { issue_key: args.issue_key, comment_id: args.comment_id });
	return myself && comment ? { myself, comment } : null;
}

export type AuthorVerdict = "match" | "mismatch" | "unverifiable";

// Both account ids must be present to decide; a missing one is never a match.
export function authorGuardVerdict(myself: unknown, comment: unknown): AuthorVerdict {
	const principal = isRecord(myself) && typeof myself.accountId === "string" && myself.accountId.length > 0 ? myself.accountId : undefined;
	const author = isRecord(comment) && isRecord(comment.author) && typeof comment.author.accountId === "string" && comment.author.accountId.length > 0 ? comment.author.accountId : undefined;
	if (principal === undefined || author === undefined) return "unverifiable";
	return principal === author ? "match" : "mismatch";
}

// The schema the dispatcher confirms REST arguments against. It is owned, not
// live: the REST Provider refuses the same vocabulary independently.
export function restSchema(): SchemaTool[] {
	return Object.entries(REST_TOOLS).map(([name, required]) => ({ name, inputSchema: { required: [...required], properties: Object.fromEntries(required.map((key) => [key, {}])) } }));
}

// The Provider's one stdout line: an HTTP status and the parsed JSON body, or
// null when the body was not JSON. Anything else is a malformed reply.
export function restReply(value: unknown): RestReply | null {
	if (!isRecord(value) || Object.keys(value).length !== 2 || !("body" in value)) return null;
	const status = value.status;
	if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return null;
	return { status, body: value.body };
}
