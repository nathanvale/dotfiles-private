#!/usr/bin/env bun
// Owned Jira REST v2 Provider for the wiki-comment capability exception
// (ADR 0001 amendment). One process per request: recovers the invocation from
// the dispatcher's internal channel, re-reads the bound Jira item inside this
// process, reads exactly one {tool, args} request from stdin, makes that one
// HTTPS request against the item's Trusted Site Origin, and writes one
// {status, body} line. The credential exists only in this process's memory
// and in the Authorization header; it is never printed and never an argument.
import { boundItem, providerInvocation } from "./custody/index.ts";
import { authorGuardVerdict, editGuardRequests, type RestReply, type RestRequest, restRequest } from "./dispatch/rest.ts";
import { atlassianProcess, singleLine } from "./provider-process.ts";

const TIMEOUT_MS = 30_000;
const REQUEST_LIMIT = 300_000;
const EDIT_TOOL = "jira_rest_comment_edit";

interface StdinRequest {
	tool: string;
	args: unknown;
	request: RestRequest;
}

function requestFromStdin(text: string): StdinRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return atlassianProcess.fail("arguments-invalid", "stdin must carry one JSON request", 2);
	}
	const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	const request = record && typeof record.tool === "string" && Object.keys(record).length === 2 ? restRequest(record.tool, record.args) : null;
	if (!record || !request) return atlassianProcess.fail("arguments-invalid", "the request names no REST tool in the closed vocabulary, or its arguments are outside it", 2);
	return { tool: record.tool as string, args: record.args, request };
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// One HTTPS request against the Trusted Site Origin. A transport failure ends
// the process with its class on stderr (timeout, connection); the text never
// carries a header. The dispatcher translates it to a closed cause.
async function perform(origin: string, authorization: string, request: RestRequest): Promise<RestReply> {
	try {
		const response = await fetch(`${origin}${request.path}`, {
			method: request.method,
			headers: { Authorization: authorization, Accept: "application/json", ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: request.body === undefined ? null : JSON.stringify(request.body),
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return { status: response.status, body: parseBody(await response.text()) };
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : "request failed";
		process.stderr.write(`atlassian-rest-provider:transport:${detail.replace(/[\r\n]+/g, " ").slice(0, 300)}\n`);
		return process.exit(3);
	}
}

const emit = (reply: RestReply): never => {
	process.stdout.write(`${JSON.stringify(reply)}\n`);
	return process.exit(0);
};

const succeeded = (reply: RestReply): boolean => reply.status >= 200 && reply.status <= 299;

// The edit guard at the credential boundary: read the principal and the
// comment first; a failed read is reported as that read's status, another
// author or an unreadable id refuses, and only a match reaches the PUT.
async function guardEdit(origin: string, authorization: string, args: unknown): Promise<void> {
	const guard = editGuardRequests(args);
	if (!guard) atlassianProcess.fail("arguments-invalid", "the edit names no issue and comment to guard", 2);
	const myself = await perform(origin, authorization, guard.myself);
	if (!succeeded(myself)) emit(myself);
	const comment = await perform(origin, authorization, guard.comment);
	if (!succeeded(comment)) emit(comment);
	const verdict = authorGuardVerdict(myself.body, comment.body);
	if (verdict === "mismatch") atlassianProcess.fail("author-mismatch", "the comment was authored by another account", 3);
	if (verdict === "unverifiable") atlassianProcess.fail("author-unverifiable", "the principal or the comment author could not be read", 3);
}

async function main(argv: string[]): Promise<never> {
	atlassianProcess.refuseArguments(argv);
	const invocation = providerInvocation();
	if (invocation.product !== "jira") atlassianProcess.fail("product-invalid", "the REST route serves Jira only", 2);
	// The full-item read and comparison happen before stdin is consumed or any
	// request is shaped.
	const item = boundItem(invocation);
	if (item.credential === undefined) atlassianProcess.fail("community-fields-missing", `${invocation.itemTitle} needs username, credential, and a site_url field`);
	if (!singleLine(item.credential)) atlassianProcess.fail("credential-invalid", `${invocation.itemTitle} has malformed fields`);
	const stdin = await Bun.stdin.text();
	if (stdin.length > REQUEST_LIMIT) atlassianProcess.fail("arguments-invalid", "the request is too large", 2);
	const { tool, args, request } = requestFromStdin(stdin);
	const authorization = `Basic ${Buffer.from(`${item.principal}:${item.credential}`).toString("base64")}`;
	if (tool === EDIT_TOOL) await guardEdit(item.origin, authorization, args);
	return emit(await perform(item.origin, authorization, request));
}

await main(process.argv.slice(2));
