// Pure write policy: neutral input contracts, provider argument adapters,
// preparatory reads, effect extraction, and read-back evidence. Expected
// values are literals from the provider documentation read on 22 September
// 2026 (Atlassian v2 skill examples; mcp-atlassian v0.23.1 source).
import { describe, expect, test } from "bun:test";
import { OPERATION_SPECS } from "../scripts/dispatch/contract.ts";
import { baselineFromReply, effectsFromReply, normalised, preparation, readBackEvidence, readBackPlan, spaceIdFromSearch, WRITE_OPERATIONS, writeArguments, writeInput } from "../scripts/dispatch/writes.ts";

const never = () => false;
const CREATE = { projectKey: "PROJ", issueType: "Bug", summary: "Billing broken", description: "first\nsecond" };

describe("neutral write inputs", () => {
	test("every write operation has a contract; unknown keys, bad shapes, and missing required keys refuse", () => {
		expect(WRITE_OPERATIONS).toEqual(["issue.create", "issue.update", "issue.comment", "page.create", "page.update", "page.comment"]);
		expect(writeInput("issue.create", CREATE)).toEqual({ ok: true, input: CREATE });
		expect(writeInput("issue.create", { ...CREATE, labels: ["x"] })).toEqual({ ok: false, reason: "unknown input key labels" });
		expect(writeInput("issue.create", { ...CREATE, projectKey: "proj" })).toEqual({ ok: false, reason: "input key projectKey is invalid" });
		expect(writeInput("issue.update", { issueKey: "PROJ-1" })).toEqual({ ok: false, reason: "input key fields is required" });
		expect(writeInput("issue.update", { issueKey: "PROJ-1", fields: { nested: { a: 1 } } })).toEqual({ ok: false, reason: "input key fields is invalid" });
		expect(writeInput("issue.update", { issueKey: "PROJ-1", fields: {} })).toEqual({ ok: false, reason: "input key fields is invalid" });
		expect(writeInput("issue.comment", { issueKey: "PROJ-1", body: "  " })).toEqual({ ok: false, reason: "input key body is invalid" });
		expect(writeInput("page.create", { space: { key: "ENG", id: "12" }, title: "T", body: "b" }).ok).toBe(true);
		for (const space of [{}, { id: "012" }, { id: 12 }, { key: "bad key" }, { other: "x" }, "ENG"]) expect(writeInput("page.create", { space, title: "T", body: "b" }).ok).toBe(false);
		expect(writeInput("page.update", { pageId: "abc", body: "b" }).ok).toBe(false);
		expect(writeInput("page.comment", { pageId: "123", body: "b", extra: 1 }).ok).toBe(false);
		expect(writeInput("page.comment", [] as unknown)).toEqual({ ok: false, reason: "input must be a JSON object" });
	});
});

describe("preparation and provider arguments", () => {
	test("each operation names the read it needs; page.create always resolves a supplied space key", () => {
		expect(preparation("issue.create", "official", CREATE)).toEqual({ kind: "none" });
		expect(preparation("issue.comment", "official", { issueKey: "PROJ-1", body: "x" })).toEqual({ kind: "none" });
		expect(preparation("issue.update", "community", { issueKey: "PROJ-1", fields: { summary: "x" } })).toEqual({ kind: "issue", issueKey: "PROJ-1" });
		expect(preparation("page.update", "official", { pageId: "123", body: "x" })).toEqual({ kind: "page", pageId: "123" });
		expect(preparation("page.create", "official", { space: { id: "9" }, title: "t", body: "b" })).toEqual({ kind: "space", id: "9" });
		expect(preparation("page.create", "official", { space: { key: "ENG" }, title: "t", body: "b" })).toEqual({ kind: "space", key: "ENG" });
		expect(preparation("page.create", "community", { space: { id: "9" }, title: "t", body: "b" })).toEqual({ kind: "refused", reason: "the Community route needs space.key; supply space as {id, key}" });
		expect(preparation("page.create", "community", { space: { id: "9", key: "ENG" }, title: "t", body: "b" })).toEqual({ kind: "space", id: "9", key: "ENG" });
	});

	test("Official arguments use the documented v2 names; the snapshot token is preview-bound", () => {
		const ctx = { cloudId: "c1", revision: "7", baseline: { effectIds: [], commentIds: [], revision: "7" }, snapshotToken: "snap", currentTitle: "Old" };
		expect(writeArguments(OPERATION_SPECS["issue.create"], "official", CREATE, ctx).args).toEqual({ cloudId: "c1", projectKey: "PROJ", issueType: "Bug", summary: "Billing broken", description: "first\nsecond" });
		expect(writeArguments(OPERATION_SPECS["issue.update"], "official", { issueKey: "PROJ-1", fields: { summary: "x", description: "d" } }, ctx).args).toEqual({ cloudId: "c1", issueIdOrKey: "PROJ-1", fields: { summary: "x", description: "d" }, contentFormat: "markdown" });
		expect(writeArguments(OPERATION_SPECS["issue.update"], "official", { issueKey: "PROJ-1", fields: { summary: "x" } }, ctx).args).toEqual({ cloudId: "c1", issueIdOrKey: "PROJ-1", fields: { summary: "x" } });
		expect(writeArguments(OPERATION_SPECS["issue.comment"], "official", { issueKey: "PROJ-1", body: "hi" }, ctx).args).toEqual({ cloudId: "c1", issueIdOrKey: "PROJ-1", commentBody: "hi" });
		expect(writeArguments(OPERATION_SPECS["page.create"], "official", { space: { id: "9", key: "ENG" }, parentId: "77", title: "T", body: "b" }, ctx).args).toEqual({ cloudId: "c1", parent: { spaceId: "9", parentContentId: "77" }, contentType: "page", title: "T", body: { format: "markdown", value: "b" } });
		expect(writeArguments(OPERATION_SPECS["page.create"], "official", { space: { key: "ENG" }, title: "T", body: "b" }, { ...ctx, spaceId: "9" }).args.parent).toEqual({ spaceId: "9" });
		const update = writeArguments(OPERATION_SPECS["page.update"], "official", { pageId: "123", body: "b", title: "New", versionMessage: "m" }, ctx);
		expect(update.args).toEqual({ cloudId: "c1", contentId: "123", title: "New", body: { format: "markdown", value: "b" }, versionMessage: "m", snapshotToken: "snap" });
		expect(update.bound).toEqual({ cloudId: "c1", contentId: "123", title: "New", body: { format: "markdown", value: "b" }, versionMessage: "m", snapshotToken: "snap" });
	});

	test("Community arguments use the v0.23.1 names; fields are a JSON string and an omitted title keeps the read one", () => {
		const ctx = { revision: "7", baseline: { effectIds: [], commentIds: [], revision: "7" }, currentTitle: "Old" };
		expect(writeArguments(OPERATION_SPECS["issue.create"], "community", CREATE, ctx).args).toEqual({ project_key: "PROJ", issue_type: "Bug", summary: "Billing broken", description: "first\nsecond" });
		expect(writeArguments(OPERATION_SPECS["issue.update"], "community", { issueKey: "PROJ-1", fields: { summary: "x" } }, ctx).args).toEqual({ issue_key: "PROJ-1", fields: '{"summary":"x"}' });
		expect(writeArguments(OPERATION_SPECS["issue.comment"], "community", { issueKey: "PROJ-1", body: "hi" }, ctx).args).toEqual({ issue_key: "PROJ-1", body: "hi" });
		expect(writeArguments(OPERATION_SPECS["page.create"], "community", { space: { id: "9", key: "ENG" }, parentId: "77", title: "T", body: "b" }, ctx).args).toEqual({ space_key: "ENG", title: "T", content: "b", parent_id: "77", content_format: "markdown" });
		const update = writeArguments(OPERATION_SPECS["page.update"], "community", { pageId: "123", body: "b" }, ctx);
		expect(update.args).toEqual({ page_id: "123", title: "Old", content: "b", content_format: "markdown" });
		expect(update.bound).toEqual(update.args);
		expect(writeArguments(OPERATION_SPECS["page.comment"], "community", { pageId: "123", body: "hi" }, ctx).args).toEqual({ page_id: "123", body: "hi" });
	});
});

describe("effects and read-back", () => {
	test("effects come from the reply for creates and comments, and from the target for updates; a reply without an id yields none", () => {
		expect(effectsFromReply("issue.create", CREATE, { message: "Issue created successfully", issue: { id: "10009", key: "PROJ-9" } })).toEqual([{ kind: "jira-issue", id: "PROJ-9" }]);
		expect(effectsFromReply("issue.create", CREATE, { content: [{ type: "text", text: JSON.stringify({ key: "PROJ-9", id: "1" }) }] })).toEqual([{ kind: "jira-issue", id: "PROJ-9" }]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { id: "10001", body: "x", author: { id: "acc-1" } })).toEqual([{ kind: "jira-comment", id: "10001" }]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { ok: true })).toEqual([]);
		expect(effectsFromReply("issue.update", { issueKey: "PROJ-1", fields: {} }, null)).toEqual([{ kind: "jira-issue", id: "PROJ-1" }]);
		expect(effectsFromReply("page.create", { space: { id: "9" }, title: "T", body: "b" }, { message: "Page created successfully", page: { id: "556", title: "T" } })).toEqual([{ kind: "confluence-content", id: "556" }]);
		expect(effectsFromReply("page.update", { pageId: "123", body: "b" }, {})).toEqual([{ kind: "confluence-content", id: "123" }]);
		expect(effectsFromReply("page.comment", { pageId: "123", body: "b" }, { success: true, comment: { id: "42", body: "b" } })).toEqual([{ kind: "confluence-comment", id: "42" }]);
		expect(effectsFromReply("issue.create", CREATE, { key: "not a key" })).toEqual([]);
		expect(effectsFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "x" } }, { key: "PROJ-2" })).toEqual([]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { id: "10002", body: "x", issueKey: "PROJ-2" })).toEqual([]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { id: "10003", body: "before x after" })).toEqual([]);
		expect(effectsFromReply("page.update", { pageId: "123", body: "b" }, { id: "999" })).toEqual([]);
		expect(effectsFromReply("page.update", { pageId: "123", body: "b" }, { page: { id: "999" } })).toEqual([]);
		expect(effectsFromReply("page.comment", { pageId: "123", body: "b" }, { id: "43", body: "b", pageId: "999" })).toEqual([]);
		expect(effectsFromReply("page.comment", { pageId: "123", body: "b" }, { id: "44", body: "b", container: { id: "999" } })).toEqual([]);
	});

	test("read-back plans name the provider read and escape search strings", () => {
		expect(readBackPlan("issue.create", "official", { ...CREATE, summary: 'Say "hi"' }, "c1")).toEqual({ tool: "searchJiraIssuesUsingJql", args: { cloudId: "c1", jql: 'project = "PROJ" AND summary ~ "Say \\"hi\\"" ORDER BY created DESC', maxResults: 20, fields: ["summary", "issuetype", "created"] } });
		expect(readBackPlan("issue.update", "community", { issueKey: "PROJ-1", fields: { summary: "x" } }, undefined)).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "summary,version" } });
		expect(readBackPlan("issue.comment", "community", { issueKey: "PROJ-1", body: "x" }, undefined)).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 } });
		expect(readBackPlan("page.create", "official", { space: { id: "9" }, title: "T", body: "b" }, "c1")).toEqual({ tool: "searchConfluence", args: { cloudId: "c1", cql: 'type = page AND title = "T"', maxResults: 20 } });
		expect(readBackPlan("page.update", "community", { pageId: "123", body: "b" }, undefined)).toEqual({ tool: "confluence_get_page", args: { page_id: "123", include_metadata: true } });
		expect(readBackPlan("page.comment", "community", { pageId: "123", body: "b" }, undefined)).toEqual({ tool: "confluence_get_comments", args: { page_id: "123" } });
		expect(readBackPlan("page.comment", "official", { pageId: "123", body: "b" }, "c1")).toEqual({ refused: "Official exposes no comment read on the default endpoint" });
	});

	test("read-back evidence is found, absent, or indeterminate, and only a monotonic revision proves absence after a send", () => {
		const created = readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-8", fields: { summary: "Other" } }, { key: "PROJ-9", fields: { summary: "billing   BROKEN", issuetype: { name: "Bug" } } }] });
		expect(created).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-9" }] });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "OTHER-9", fields: { summary: "Billing broken", issuetype: { name: "Bug" } } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue key" });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9" }] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: "Task" } } }] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		expect(readBackEvidence("issue.create", { ...CREATE, issueType: "!!!" }, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: "Bug" } } }] })).toEqual({ kind: "indeterminate", reason: "the requested issue type has no stable read-back representation" });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: "!!!" } } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: 42 } } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		const updateInput = { issueKey: "PROJ-1", fields: { summary: "new", labels: ["a", "b"] } };
		expect(readBackEvidence("issue.update", updateInput, never, { key: "PROJ-1", fields: { summary: "New", labels: ["a", "b"], updated: "t2" } })).toEqual({ kind: "indeterminate", reason: "the Jira reply carries no stable revision; live qualification is required" });
		expect(readBackEvidence("issue.update", updateInput, (observed) => observed === "t1", { key: "PROJ-1", fields: { summary: "old", labels: [], updated: "t1" } })).toEqual({ kind: "indeterminate", reason: "the Jira reply carries no stable revision; live qualification is required" });
		expect(readBackEvidence("issue.update", updateInput, (observed) => observed === "t1", { key: "PROJ-1", fields: { summary: "old", labels: [], updated: "t2" } })).toEqual({ kind: "indeterminate", reason: "the Jira reply carries no stable revision; live qualification is required" });
		expect(readBackEvidence("issue.update", updateInput, never, { error: "not an issue" })).toEqual({ kind: "indeterminate", reason: "the read-back reply is not an issue" });
		expect(readBackEvidence("issue.update", updateInput, never, { key: "PROJ-2", fields: { summary: "new", labels: ["a", "b"], version: 2 } }, { effectIds: ["PROJ-1"], commentIds: [], revision: "1" })).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different issue" });
		const comment = { issueKey: "PROJ-1", body: "Quarterly numbers are down; see the sheet" };
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "hello" }, { id: "2", body: { content: [{ type: "text", text: "Quarterly numbers are down; see the sheet" }] } }] } } })).toEqual({ kind: "found", effects: [{ kind: "jira-comment", id: "2" }] });
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "hello" }] } } })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-2", fields: { comment: { comments: [{ id: "2", body: comment.body }] } } })).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different issue" });
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "3", body: `Context before ${comment.body} context after` }] } } })).toEqual({ kind: "absent", revisionUnchanged: false });
		const page = { space: { id: "9", key: "ENG" }, title: "Roadmap", body: "b" };
		expect(readBackEvidence("page.create", page, never, { results: [{ id: "556", title: "Roadmap", space: { key: "ENG" } }] })).toEqual({ kind: "found", effects: [{ kind: "confluence-content", id: "556" }] });
		expect(readBackEvidence("page.create", page, never, { results: [{ id: "556", title: "Roadmap", spaceId: "10" }] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("page.create", page, never, { results: [{ id: "556", title: "Roadmap" }] })).toEqual({ kind: "indeterminate", reason: "a matching title was found but the reply names no space" });
		const update = { pageId: "123", body: "# New body" };
		const pageBaseline = { effectIds: ["123"], commentIds: [], revision: "7" };
		expect(readBackEvidence("page.update", update, (observed) => observed === "7", { id: "123", version: 7, content: { value: "old" } }, pageBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("page.update", update, (observed) => observed === "7", { id: "123", metadata: { version: 8 }, body: { value: "# New body\nmore" } }, pageBaseline)).toEqual({ kind: "indeterminate", reason: "the page moved to another version whose content is not this update" });
		expect(readBackEvidence("page.update", update, never, { id: "999", version: 8, content: { value: "# New body" } }, pageBaseline)).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different page" });
		expect(readBackEvidence("page.update", update, (observed) => observed === "7", { id: "123", version: 8, content: { value: "someone else" } }, pageBaseline)).toEqual({ kind: "indeterminate", reason: "the page moved to another version whose content is not this update" });
		expect(readBackEvidence("page.update", update, never, { id: "123" })).toEqual({ kind: "indeterminate", reason: "the read-back reply carries no stable version" });
		expect(readBackEvidence("page.comment", { pageId: "123", body: "hello there" }, never, [{ id: "42", body: "Hello, there!" }])).toEqual({ kind: "found", effects: [{ kind: "confluence-comment", id: "42" }] });
		const pageComment = "Quarterly numbers are down; see the sheet";
		expect(readBackEvidence("page.comment", { pageId: "123", body: pageComment }, never, [{ id: "43", body: `Before ${pageComment} after` }])).toEqual({ kind: "absent", revisionUnchanged: false });
	});

	test("read-back keeps Unicode text and records every pre-existing matching identifier", () => {
		expect(normalised("你好，世界")).toBe("你好 世界");
		expect(readBackEvidence("issue.update", { issueKey: "PROJ-1", fields: { summary: "你好" } }, never, { key: "PROJ-1", fields: { summary: "你好", version: 2 } }, { effectIds: ["PROJ-1"], commentIds: [], revision: "1" })).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-1" }] });
		expect(readBackEvidence("issue.comment", { issueKey: "PROJ-1", body: "!!!" }, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "???" }] } } })).toEqual({ kind: "indeterminate", reason: "the requested comment has no stable read-back representation" });
		expect(baselineFromReply("issue.create", CREATE, { issues: [{ key: "PROJ-1", fields: { summary: CREATE.summary, issuetype: { name: "Bug" } } }, { key: "PROJ-2", fields: { summary: CREATE.summary, issuetype: { name: "Bug" } } }] })).toEqual({ kind: "observed", baseline: { effectIds: ["PROJ-1", "PROJ-2"], commentIds: [], revision: null } });
		expect(baselineFromReply("issue.comment", { issueKey: "PROJ-1", body: "same comment" }, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "same comment" }, { id: "2", body: "same comment" }] } } })).toEqual({ kind: "observed", baseline: { effectIds: ["PROJ-1"], commentIds: ["1", "2"], revision: null } });
		expect(baselineFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "new" } }, { key: "PROJ-2", fields: { version: 7 } })).toEqual({ kind: "indeterminate", reason: "the Jira reply names a different issue" });
		expect(baselineFromReply("issue.comment", { issueKey: "PROJ-1", body: "same comment" }, { key: "PROJ-2", fields: { comment: { comments: [{ id: "3", body: "same comment" }] } } })).toEqual({ kind: "indeterminate", reason: "the Jira reply names a different issue" });
		expect(baselineFromReply("page.create", { space: { id: "9" }, title: "Same page", body: "body" }, { results: [{ id: "556", title: "Same page", space: { id: "9" } }, { id: "557", title: "Same page", space: { id: "9" } }] })).toEqual({ kind: "observed", baseline: { effectIds: ["556", "557"], commentIds: [], revision: null } });
		expect(baselineFromReply("page.update", { pageId: "123", body: "new" }, { id: "999", version: 7 })).toEqual({ kind: "indeterminate", reason: "the page read names a different page" });
		expect(baselineFromReply("page.comment", { pageId: "123", body: "same comment" }, [{ id: "4", body: "same comment" }])).toEqual({ kind: "observed", baseline: { effectIds: ["123"], commentIds: ["4"], revision: null } });
	});

	test("a space key resolves to its numeric id only from a page that names both", () => {
		expect(spaceIdFromSearch("ENG", { results: [{ id: "1", space: { id: "9001", key: "ENG" } }] })).toBe("9001");
		expect(spaceIdFromSearch("ENG", { results: [{ id: "1", spaceKey: "ENG", spaceId: "9001" }] })).toBe("9001");
		expect(spaceIdFromSearch("ENG", { results: [{ id: "1", space: { id: "9001", key: "OTHER" } }] })).toBeUndefined();
		expect(spaceIdFromSearch("ENG", { results: [{ id: "1", space: { key: "ENG" } }] })).toBeUndefined();
		expect(spaceIdFromSearch("ENG", { results: [{ id: "1", space: { id: "0", key: "ENG" } }] })).toBeUndefined();
	});
});
