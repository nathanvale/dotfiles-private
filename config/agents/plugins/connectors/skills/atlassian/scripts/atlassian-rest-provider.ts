#!/usr/bin/env bun
// Owned Jira REST v2 Provider for the wiki-comment capability exception
// (ADR 0001 amendment). One process per request: recovers the invocation from
// the dispatcher's internal channel, re-reads the bound Jira item inside this
// process, reads exactly one {tool, args} request from stdin, makes that one
// HTTPS request against the item's Trusted Site Origin, and writes one
// {status, body} line. The credential exists only in this process's memory
// and in the Authorization header; it is never printed and never an argument.
import { boundItem, providerInvocation } from "./custody/index.ts";
import { type RestRequest, restRequest } from "./dispatch/rest.ts";
import { atlassianProcess, singleLine } from "./provider-process.ts";

const TIMEOUT_MS = 30_000;
const REQUEST_LIMIT = 300_000;

function requestFromStdin(text: string): RestRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return atlassianProcess.fail("arguments-invalid", "stdin must carry one JSON request", 2);
	}
	const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	const request = record && typeof record.tool === "string" && Object.keys(record).length === 2 ? restRequest(record.tool, record.args) : null;
	if (!request) return atlassianProcess.fail("arguments-invalid", "the request names no REST tool in the closed vocabulary, or its arguments are outside it", 2);
	return request;
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
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
	const request = requestFromStdin(stdin);
	const authorization = `Basic ${Buffer.from(`${item.principal}:${item.credential}`).toString("base64")}`;
	let response: Response;
	try {
		response = await fetch(`${item.origin}${request.path}`, {
			method: request.method,
			headers: { Authorization: authorization, Accept: "application/json", ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: request.body === undefined ? null : JSON.stringify(request.body),
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		// The error text names the failure class (timeout, connection); it never
		// carries a header. The dispatcher translates it to a closed cause.
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : "request failed";
		process.stderr.write(`atlassian-rest-provider:transport:${detail.replace(/[\r\n]+/g, " ").slice(0, 300)}\n`);
		process.exit(3);
	}
	const text = await response.text();
	process.stdout.write(`${JSON.stringify({ status: response.status, body: parseBody(text) })}\n`);
	process.exit(0);
}

await main(process.argv.slice(2));
