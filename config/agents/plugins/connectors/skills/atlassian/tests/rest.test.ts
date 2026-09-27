// The owned Jira REST v2 route for the wiki-comment exception: the exact
// request each tool makes, the closed argument vocabulary, the owned schema,
// and the Provider's reply line. Expected paths are literals from the Jira
// Cloud REST v2 reference and the prototype run on SMSTX-364 (28 September
// 2026).
import { describe, expect, test } from "bun:test";
import { authorGuardVerdict, editGuardRequests, restReply, restRequest, restSchema } from "../scripts/dispatch/rest.ts";

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
		expect(restRequest("jira_rest_attachment_head", { attachment_id: "202456" })).toEqual({ method: "GET", path: "/rest/api/2/attachment/content/202456?redirect=false", range: "bytes=0-15" });
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

	test("the Provider reply is a status and a body, and nothing else", () => {
		expect(restReply({ status: 200, body: { id: "1" } })).toEqual({ status: 200, body: { id: "1" } });
		expect(restReply({ status: 404, body: null })).toEqual({ status: 404, body: null });
		for (const malformed of [{ status: 200 }, { status: "200", body: {} }, { status: 99, body: {} }, { status: 200, body: {}, extra: 1 }, "ok", null, []]) expect(restReply(malformed)).toBeNull();
	});
});
