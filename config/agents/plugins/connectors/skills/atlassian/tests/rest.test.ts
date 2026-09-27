// The owned Jira REST v2 route for the wiki-comment exception: the exact
// request each tool makes, the closed argument vocabulary, the owned schema,
// and the Provider's reply line. Expected paths are literals from the Jira
// Cloud REST v2 reference and the prototype run on SMSTX-364 (28 September
// 2026).
import { describe, expect, test } from "bun:test";
import { authorGuardVerdict, editGuardRequests, HEAD_BYTES, readLeadingBytes, restReply, restRequest, restSchema } from "../scripts/dispatch/rest.ts";

const RENDERED = "expand=renderedBody";

describe("REST requests", () => {
	test("each tool maps to one method and path under the origin; comment writes carry the wiki body and ask for the rendered HTML", () => {
		expect(restRequest("jira_rest_myself", {})).toEqual({ method: "GET", path: "/rest/api/2/myself" });
		expect(restRequest("jira_rest_issue_attachments", { issue_key: "PROJ-1" })).toEqual({ method: "GET", path: "/rest/api/2/issue/PROJ-1?fields=attachment,updated" });
		expect(restRequest("jira_rest_comments_list", { issue_key: "PROJ-1" })).toEqual({ method: "GET", path: `/rest/api/2/issue/PROJ-1/comment?${RENDERED}&orderBy=-created&maxResults=100` });
		expect(restRequest("jira_rest_comment_get", { issue_key: "PROJ-1", comment_id: "454771" })).toEqual({ method: "GET", path: `/rest/api/2/issue/PROJ-1/comment/454771?${RENDERED}` });
		expect(restRequest("jira_rest_comment_add", { issue_key: "PROJ-1", body: "!a.png!" })).toEqual({ method: "POST", path: `/rest/api/2/issue/PROJ-1/comment?${RENDERED}`, body: { body: "!a.png!" } });
		expect(restRequest("jira_rest_comment_edit", { issue_key: "PROJ-1", comment_id: "454771", body: "!a.png!" })).toEqual({ method: "PUT", path: `/rest/api/2/issue/PROJ-1/comment/454771?${RENDERED}`, body: { body: "!a.png!" } });
		// The head read asks Jira to serve the bytes itself and bounds them to the signature length.
		expect(restRequest("jira_rest_attachment_head", { attachment_id: "202456" })).toEqual({ method: "GET", path: "/rest/api/2/attachment/content/202456?redirect=false", range: "bytes=0-63" });
		expect(restRequest("jira_rest_attachment_head", { attachment_id: "202456/../1" })).toBeNull();
		expect(restRequest("jira_rest_attachment_head", { issue_key: "PROJ-1" })).toBeNull();
	});

	test("a tool outside the vocabulary, a missing, extra, or malformed argument, and an oversized body are refused as null", () => {
		expect(restRequest("jira_rest_comment_delete", { issue_key: "PROJ-1", comment_id: "1" })).toBeNull();
		expect(restRequest("jira_add_comment", { issue_key: "PROJ-1", body: "x" })).toBeNull();
		expect(restRequest("jira_rest_comment_add", { issue_key: "PROJ-1" })).toBeNull();
		expect(restRequest("jira_rest_comment_add", { issue_key: "PROJ-1", body: "x", visibility: "{}" })).toBeNull();
		expect(restRequest("jira_rest_myself", { issue_key: "PROJ-1" })).toBeNull();
		for (const issueKey of ["proj-1", "PROJ-1/../x", "PROJ-1?x=1", "", 7]) expect([issueKey, restRequest("jira_rest_issue_attachments", { issue_key: issueKey })]).toEqual([issueKey, null]);
		for (const commentId of ["abc", "0", "454771/../1", ""]) expect([commentId, restRequest("jira_rest_comment_get", { issue_key: "PROJ-1", comment_id: commentId })]).toEqual([commentId, null]);
		expect(restRequest("jira_rest_comment_add", { issue_key: "PROJ-1", body: "   " })).toBeNull();
		expect(restRequest("jira_rest_comment_add", { issue_key: "PROJ-1", body: "x".repeat(200_001) })).toBeNull();
		expect(restRequest("jira_rest_comment_add", null)).toBeNull();
		expect(restRequest("jira_rest_comment_add", ["PROJ-1"])).toBeNull();
	});

	test("the owned schema names every REST tool with exactly its required arguments", () => {
		expect(restSchema().map((tool) => [tool.name, tool.inputSchema?.required, Object.keys(tool.inputSchema?.properties ?? {})])).toEqual([
			["jira_rest_myself", [], []],
			["jira_rest_issue_attachments", ["issue_key"], ["issue_key"]],
			["jira_rest_comments_list", ["issue_key"], ["issue_key"]],
			["jira_rest_comment_get", ["issue_key", "comment_id"], ["issue_key", "comment_id"]],
			["jira_rest_comment_add", ["issue_key", "body"], ["issue_key", "body"]],
			["jira_rest_comment_edit", ["issue_key", "comment_id", "body"], ["issue_key", "comment_id", "body"]],
			["jira_rest_attachment_head", ["attachment_id"], ["attachment_id"]],
		]);
	});

	test("the edit guard reads the principal and the exact comment first, and only two present, equal account ids are a match", () => {
		expect(editGuardRequests({ issue_key: "PROJ-1", comment_id: "454771", body: "x" })).toEqual({ myself: { method: "GET", path: "/rest/api/2/myself" }, comment: { method: "GET", path: `/rest/api/2/issue/PROJ-1/comment/454771?${RENDERED}` } });
		expect(editGuardRequests({ issue_key: "PROJ-1", body: "x" })).toBeNull();
		expect(editGuardRequests({ issue_key: "PROJ-1", comment_id: "1/../2" })).toBeNull();
		const me = { accountId: "712020:me", emailAddress: "me@example.invalid" };
		expect(authorGuardVerdict(me, { id: "454771", author: { accountId: "712020:me" } })).toBe("match");
		expect(authorGuardVerdict(me, { id: "454771", author: { accountId: "712020:other" } })).toBe("mismatch");
		expect(authorGuardVerdict(me, { id: "454771", author: { displayName: "Someone" } })).toBe("unverifiable");
		expect(authorGuardVerdict({ emailAddress: "me@example.invalid" }, { id: "454771", author: { accountId: "712020:me" } })).toBe("unverifiable");
		expect(authorGuardVerdict(null, null)).toBe("unverifiable");
		expect(authorGuardVerdict({ accountId: "" }, { author: { accountId: "" } })).toBe("unverifiable");
	});

	test("the head read takes only the leading bytes from a body and cancels the rest, even when the server ignores Range and streams a large body", async () => {
		// An endless stream of 1 KiB chunks stands in for a server that ignored Range on a large attachment.
		let pulls = 0;
		let cancelled = false;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(1024).fill(pulls));
			},
			cancel() {
				cancelled = true;
			},
		});
		const leading = await readLeadingBytes(endless, HEAD_BYTES);
		expect([leading.byteLength, cancelled, pulls <= 2]).toEqual([HEAD_BYTES, true, true]);
		expect(leading[0]).toBe(1);
		// Small bodies come back whole; several small chunks are joined in order; a missing body is empty.
		const chunks = (...parts: number[][]) => new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new Uint8Array(part)); controller.close(); } });
		expect([...(await readLeadingBytes(chunks([1, 2], [3]), HEAD_BYTES))]).toEqual([1, 2, 3]);
		expect([...(await readLeadingBytes(chunks([1, 2, 3, 4, 5]), 4))]).toEqual([1, 2, 3, 4]);
		expect((await readLeadingBytes(null, HEAD_BYTES)).byteLength).toBe(0);
	});

	test("the Provider reply is a status and a body, and nothing else", () => {
		expect(restReply({ status: 200, body: { id: "1" } })).toEqual({ status: 200, body: { id: "1" } });
		expect(restReply({ status: 404, body: null })).toEqual({ status: 404, body: null });
		for (const malformed of [{ status: 200 }, { status: "200", body: {} }, { status: 99, body: {} }, { status: 200, body: {}, extra: 1 }, "ok", null, []]) expect(restReply(malformed)).toBeNull();
	});
});
