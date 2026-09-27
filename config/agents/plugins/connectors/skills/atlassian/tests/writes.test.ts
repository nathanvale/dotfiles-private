// Pure write policy: neutral input contracts, the Community argument adapter,
// preparatory reads, effect extraction, and read-back evidence. Expected
// values are literals from the mcp-atlassian v0.23.1 source read on
// 22 September 2026 and reply shapes observed live on 23 September 2026.
import { describe, expect, test } from "bun:test";
import { OPERATION_SPECS } from "../scripts/dispatch/contract.ts";
import { accountIdOf, baselineFromReply, effectsFromReply, normalised, observeRestComment, preparation, readBackEvidence, readBackPlan, renderedImagesPresent, resolveMediaAttachments, sameWikiBody, transitionTo, uploadFailed, wikiImageReferences, wikiParts, WRITE_OPERATIONS, writeArguments, writeInput } from "../scripts/dispatch/writes.ts";

const never = () => false;
const CREATE = { projectKey: "PROJ", issueType: "Bug", summary: "Billing broken", description: "first\nsecond" };
const PAGE = { spaceKey: "ENG", title: "Roadmap", body: "b" };
const ATTACH = { issueKey: "PROJ-1", file: "/tmp/evidence/report.pdf" };
const PAGE_ATTACH = { pageId: "123", file: "/tmp/evidence/report.pdf" };
const COMMENT_UPDATE = { issueKey: "PROJ-1", commentId: "454166", body: "edited body" };
// MCPorter --output json wraps the tool text as one JSON string under result.
const wrapped = (value: unknown) => ({ result: JSON.stringify(value) });

describe("neutral write inputs", () => {
	test("every write operation has a contract; unknown keys, bad shapes, and missing required keys refuse", () => {
		expect(WRITE_OPERATIONS).toEqual(["issue.create", "issue.update", "issue.comment", "issue.comment.update", "issue.comment.media", "issue.comment.media.update", "issue.attach", "issue.transition", "issue.assign", "issue.delete", "page.create", "page.update", "page.comment", "page.attach", "page.attachment.delete", "page.delete"]);
		expect(writeInput("issue.transition", { issueKey: "PROJ-1", toStatus: "In Progress" })).toEqual({ ok: true, input: { issueKey: "PROJ-1", toStatus: "In Progress" } });
		expect(writeInput("issue.transition", { issueKey: "PROJ-1", transitionId: "31" }).ok).toBe(false);
		expect(writeInput("issue.assign", { issueKey: "PROJ-1" })).toEqual({ ok: true, input: { issueKey: "PROJ-1" } });
		expect(writeInput("issue.assign", { issueKey: "PROJ-1", assignee: "" }).ok).toBe(false);
		expect(writeInput("page.attachment.delete", { pageId: "123", attachmentId: "att900" })).toEqual({ ok: true, input: { pageId: "123", attachmentId: "att900" } });
		expect(writeInput("page.attachment.delete", { pageId: "123", attachmentId: "att 900" }).ok).toBe(false);
		expect(writeInput("issue.create", CREATE)).toEqual({ ok: true, input: CREATE });
		expect(writeInput("issue.create", { ...CREATE, labels: ["x"] })).toEqual({ ok: false, reason: "unknown input key labels" });
		expect(writeInput("issue.create", { ...CREATE, projectKey: "proj" })).toEqual({ ok: false, reason: "input key projectKey is invalid" });
		expect(writeInput("issue.update", { issueKey: "PROJ-1" })).toEqual({ ok: false, reason: "input key fields is required" });
		expect(writeInput("issue.update", { issueKey: "PROJ-1", fields: { nested: { a: 1 } } })).toEqual({ ok: false, reason: "input key fields is invalid" });
		expect(writeInput("issue.update", { issueKey: "PROJ-1", fields: {} })).toEqual({ ok: false, reason: "input key fields is invalid" });
		expect(writeInput("issue.comment", { issueKey: "PROJ-1", body: "  " })).toEqual({ ok: false, reason: "input key body is invalid" });
		expect(writeInput("issue.comment.update", COMMENT_UPDATE)).toEqual({ ok: true, input: COMMENT_UPDATE });
		expect(writeInput("issue.comment.update", { ...COMMENT_UPDATE, commentId: "abc" }).ok).toBe(false);
		expect(writeInput("issue.attach", ATTACH)).toEqual({ ok: true, input: ATTACH });
		for (const file of ["relative/report.pdf", "/tmp/a.pdf,/tmp/b.pdf", "/tmp/line\nbreak.pdf", "/", ""]) expect([file, writeInput("issue.attach", { issueKey: "PROJ-1", file }).ok]).toEqual([file, false]);
		expect(writeInput("issue.delete", { issueKey: "PROJ-1" })).toEqual({ ok: true, input: { issueKey: "PROJ-1" } });
		expect(writeInput("issue.delete", { issueKey: "PROJ-1", cascade: true }).ok).toBe(false);
		expect(writeInput("page.create", PAGE).ok).toBe(true);
		for (const spaceKey of ["", "bad key", { key: "ENG" }, 12]) expect(writeInput("page.create", { spaceKey, title: "T", body: "b" }).ok).toBe(false);
		expect(writeInput("page.create", { space: { key: "ENG" }, title: "T", body: "b" })).toEqual({ ok: false, reason: "unknown input key space" });
		expect(writeInput("page.update", { pageId: "abc", body: "b" }).ok).toBe(false);
		expect(writeInput("page.comment", { pageId: "123", body: "b", extra: 1 }).ok).toBe(false);
		expect(writeInput("page.attach", PAGE_ATTACH)).toEqual({ ok: true, input: PAGE_ATTACH });
		expect(writeInput("page.delete", { pageId: "123" })).toEqual({ ok: true, input: { pageId: "123" } });
		expect(writeInput("page.comment", [] as unknown)).toEqual({ ok: false, reason: "input must be a JSON object" });
	});
});

describe("preparation and provider arguments", () => {
	test("each operation names the read it needs", () => {
		expect(preparation("issue.create", CREATE)).toEqual({ kind: "none" });
		expect(preparation("issue.comment", { issueKey: "PROJ-1", body: "x" })).toEqual({ kind: "none" });
		expect(preparation("issue.attach", ATTACH)).toEqual({ kind: "issue", issueKey: "PROJ-1" });
		expect(preparation("issue.update", { issueKey: "PROJ-1", fields: { summary: "x" } })).toEqual({ kind: "issue", issueKey: "PROJ-1" });
		expect(preparation("issue.delete", { issueKey: "PROJ-1" })).toEqual({ kind: "issue", issueKey: "PROJ-1" });
		expect(preparation("issue.assign", { issueKey: "PROJ-1", assignee: "a@b" })).toEqual({ kind: "issue", issueKey: "PROJ-1" });
		expect(preparation("issue.transition", { issueKey: "PROJ-1", toStatus: "Done" })).toEqual({ kind: "transition", issueKey: "PROJ-1", toStatus: "Done" });
		expect(preparation("page.attachment.delete", { pageId: "123", attachmentId: "att900" })).toEqual({ kind: "page", pageId: "123" });
		expect(preparation("issue.comment.update", COMMENT_UPDATE)).toEqual({ kind: "comment", issueKey: "PROJ-1", commentId: "454166" });
		expect(preparation("page.create", PAGE)).toEqual({ kind: "none" });
		expect(preparation("page.attach", PAGE_ATTACH)).toEqual({ kind: "page", pageId: "123" });
		expect(preparation("page.update", { pageId: "123", body: "x" })).toEqual({ kind: "page", pageId: "123" });
		expect(preparation("page.comment", { pageId: "123", body: "x" })).toEqual({ kind: "page", pageId: "123" });
		expect(preparation("page.delete", { pageId: "123" })).toEqual({ kind: "page", pageId: "123" });
	});

	test("arguments use the v0.23.1 names; fields are a JSON string, an omitted title keeps the read one, and bound equals sent", () => {
		const ctx = { revision: "7", baseline: { effectIds: [], commentIds: [], revision: "7" }, currentTitle: "Old" };
		expect(writeArguments(OPERATION_SPECS["issue.create"], CREATE, ctx).args).toEqual({ project_key: "PROJ", issue_type: "Bug", summary: "Billing broken", description: "first\nsecond" });
		expect(writeArguments(OPERATION_SPECS["issue.update"], { issueKey: "PROJ-1", fields: { summary: "x" } }, ctx).args).toEqual({ issue_key: "PROJ-1", fields: '{"summary":"x"}' });
		expect(writeArguments(OPERATION_SPECS["issue.comment"], { issueKey: "PROJ-1", body: "hi" }, ctx).args).toEqual({ issue_key: "PROJ-1", body: "hi" });
		expect(writeArguments(OPERATION_SPECS["issue.comment.update"], COMMENT_UPDATE, ctx).args).toEqual({ issue_key: "PROJ-1", comment_id: "454166", body: "edited body" });
		expect(writeArguments(OPERATION_SPECS["issue.attach"], ATTACH, ctx).args).toEqual({ issue_key: "PROJ-1", fields: "{}", attachments: "/tmp/evidence/report.pdf" });
		expect(writeArguments(OPERATION_SPECS["issue.delete"], { issueKey: "PROJ-1" }, ctx).args).toEqual({ issue_key: "PROJ-1" });
		expect(writeArguments(OPERATION_SPECS["issue.transition"], { issueKey: "PROJ-1", toStatus: "Done" }, { ...ctx, transitionId: "31" }).args).toEqual({ issue_key: "PROJ-1", transition_id: "31" });
		expect(writeArguments(OPERATION_SPECS["issue.assign"], { issueKey: "PROJ-1", assignee: "a@b" }, ctx).args).toEqual({ issue_key: "PROJ-1", assignee: "a@b" });
		expect(writeArguments(OPERATION_SPECS["issue.assign"], { issueKey: "PROJ-1" }, ctx).args).toEqual({ issue_key: "PROJ-1", assignee: "" });
		expect(writeArguments(OPERATION_SPECS["page.attachment.delete"], { pageId: "123", attachmentId: "att900" }, ctx).args).toEqual({ attachment_id: "att900" });
		expect(writeArguments(OPERATION_SPECS["page.create"], { ...PAGE, parentId: "77", title: "T" }, ctx).args).toEqual({ space_key: "ENG", title: "T", content: "b", parent_id: "77", content_format: "markdown" });
		const update = writeArguments(OPERATION_SPECS["page.update"], { pageId: "123", body: "b" }, ctx);
		expect(update.args).toEqual({ page_id: "123", title: "Old", content: "b", content_format: "markdown" });
		expect(update.bound).toEqual({ page_id: "123", title: "Old", content: "b", content_format: "markdown" });
		expect(writeArguments(OPERATION_SPECS["page.update"], { pageId: "123", body: "b", title: "New", versionMessage: "m" }, ctx).args).toEqual({ page_id: "123", title: "New", content: "b", version_comment: "m", content_format: "markdown" });
		expect(writeArguments(OPERATION_SPECS["page.comment"], { pageId: "123", body: "hi" }, ctx).args).toEqual({ page_id: "123", body: "hi" });
		expect(writeArguments(OPERATION_SPECS["page.attach"], PAGE_ATTACH, ctx).args).toEqual({ content_id: "123", file_path: "/tmp/evidence/report.pdf" });
		expect(writeArguments(OPERATION_SPECS["page.delete"], { pageId: "123" }, ctx).args).toEqual({ page_id: "123" });
	});
});

describe("effects and read-back", () => {
	test("effects come from the reply for creates, comments, and attachments; from the target for updates; from the success message for deletes", () => {
		expect(effectsFromReply("issue.create", CREATE, { message: "Issue created successfully", issue: { id: "10009", key: "PROJ-9" } })).toEqual([{ kind: "jira-issue", id: "PROJ-9" }]);
		expect(effectsFromReply("issue.create", CREATE, { content: [{ type: "text", text: JSON.stringify({ key: "PROJ-9", id: "1" }) }] })).toEqual([{ kind: "jira-issue", id: "PROJ-9" }]);
		expect(effectsFromReply("issue.create", CREATE, wrapped({ message: "Issue created successfully", issue: { id: "10009", key: "PROJ-9" } }))).toEqual([{ kind: "jira-issue", id: "PROJ-9" }]);
		expect(effectsFromReply("issue.create", CREATE, { result: "not json" })).toEqual([]);
		expect(effectsFromReply("issue.create", CREATE, { result: JSON.stringify({ key: "PROJ-9" }), extra: true })).toEqual([]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { id: "10001", body: "x", author: { id: "acc-1" } })).toEqual([{ kind: "jira-comment", id: "10001" }]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { ok: true })).toEqual([]);
		// jira_edit_comment returns the edited comment (observed live).
		expect(effectsFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ id: "454166", body: "edited body", updated: "2026-09-23T04:20:00.000+0000" }))).toEqual([{ kind: "jira-comment", id: "454166" }]);
		expect(effectsFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ id: "999", body: "edited body" }))).toEqual([]);
		expect(effectsFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ id: "454166", body: "other body" }))).toEqual([]);
		expect(effectsFromReply("issue.update", { issueKey: "PROJ-1", fields: {} }, null)).toEqual([{ kind: "jira-issue", id: "PROJ-1" }]);
		expect(effectsFromReply("issue.attach", ATTACH, wrapped({ message: "Issue updated successfully", issue: { key: "PROJ-1", attachments: [{ id: "10500", filename: "report.pdf" }, { id: "10501", filename: "other.pdf" }] } }))).toEqual([{ kind: "jira-attachment", id: "10500" }]);
		expect(effectsFromReply("issue.attach", ATTACH, wrapped({ message: "Issue updated successfully", issue: { key: "PROJ-1" } }))).toEqual([]);
		expect(effectsFromReply("issue.delete", { issueKey: "PROJ-1" }, wrapped({ message: "Issue PROJ-1 has been deleted successfully" }))).toEqual([{ kind: "jira-issue", id: "PROJ-1" }]);
		expect(effectsFromReply("issue.transition", { issueKey: "PROJ-1", toStatus: "Done" }, wrapped({ message: "Issue PROJ-1 transitioned successfully" }))).toEqual([{ kind: "jira-issue", id: "PROJ-1" }]);
		expect(effectsFromReply("issue.assign", { issueKey: "PROJ-1", assignee: "a@b" }, wrapped({ message: "Issue PROJ-1 assigned successfully", issue: { key: "PROJ-1" } }))).toEqual([{ kind: "jira-issue", id: "PROJ-1" }]);
		expect(effectsFromReply("issue.assign", { issueKey: "PROJ-1", assignee: "a@b" }, wrapped({ issue: { key: "PROJ-2" } }))).toEqual([]);
		expect(effectsFromReply("page.attachment.delete", { pageId: "123", attachmentId: "att900" }, wrapped({ success: true, message: "Attachment deleted successfully" }))).toEqual([{ kind: "confluence-attachment", id: "att900" }]);
		expect(effectsFromReply("page.attachment.delete", { pageId: "123", attachmentId: "att900" }, wrapped({ success: false, error: "nope" }))).toEqual([]);
		expect(effectsFromReply("issue.delete", { issueKey: "PROJ-1" }, wrapped({ message: "Error deleting issue PROJ-1" }))).toEqual([]);
		expect(effectsFromReply("issue.delete", { issueKey: "PROJ-1" }, wrapped({ message: "Issue PROJ-2 has been deleted successfully", key: "PROJ-2" }))).toEqual([]);
		expect(effectsFromReply("page.create", PAGE, { message: "Page created successfully", page: { id: "556", title: "Roadmap" } })).toEqual([{ kind: "confluence-content", id: "556" }]);
		expect(effectsFromReply("page.update", { pageId: "123", body: "b" }, {})).toEqual([{ kind: "confluence-content", id: "123" }]);
		expect(effectsFromReply("page.comment", { pageId: "123", body: "b" }, { success: true, comment: { id: "42", body: "b" } })).toEqual([{ kind: "confluence-comment", id: "42" }]);
		expect(effectsFromReply("page.attach", PAGE_ATTACH, wrapped({ message: "Attachment uploaded successfully", attachment: { id: "att900", title: "report.pdf" } }))).toEqual([{ kind: "confluence-attachment", id: "att900" }]);
		expect(effectsFromReply("page.delete", { pageId: "123" }, wrapped({ success: true, message: "Page 123 deleted successfully" }))).toEqual([{ kind: "confluence-content", id: "123" }]);
		expect(effectsFromReply("page.delete", { pageId: "123" }, wrapped({ success: false, message: "Unable to delete page 123. API request completed but deletion unsuccessful." }))).toEqual([]);
		expect(effectsFromReply("issue.create", CREATE, { key: "not a key" })).toEqual([]);
		expect(effectsFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "x" } }, { key: "PROJ-2" })).toEqual([]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { id: "10002", body: "x", issueKey: "PROJ-2" })).toEqual([]);
		expect(effectsFromReply("issue.comment", { issueKey: "PROJ-1", body: "x" }, { id: "10003", body: "before x after" })).toEqual([]);
		expect(effectsFromReply("page.update", { pageId: "123", body: "b" }, { id: "999" })).toEqual([]);
		expect(effectsFromReply("page.update", { pageId: "123", body: "b" }, { page: { id: "999" } })).toEqual([]);
		expect(effectsFromReply("page.comment", { pageId: "123", body: "b" }, { id: "43", body: "b", pageId: "999" })).toEqual([]);
		expect(effectsFromReply("page.comment", { pageId: "123", body: "b" }, { id: "44", body: "b", container: { id: "999" } })).toEqual([]);
	});

	test("read-back plans name the Community read and escape search strings", () => {
		expect(readBackPlan("issue.create", { ...CREATE, summary: 'Say "hi"' })).toEqual({ tool: "jira_search", args: { jql: 'project = "PROJ" AND summary ~ "Say \\"hi\\"" ORDER BY created DESC', limit: 20, fields: "summary,issuetype,created" } });
		expect(readBackPlan("issue.update", { issueKey: "PROJ-1", fields: { summary: "x", assignee: "a@b" } })).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "summary,assignee,updated" } });
		expect(readBackPlan("issue.comment", { issueKey: "PROJ-1", body: "x" })).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 } });
		expect(readBackPlan("issue.comment.update", COMMENT_UPDATE)).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 } });
		expect(readBackPlan("issue.attach", ATTACH)).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "attachment,updated" } });
		expect(readBackPlan("issue.delete", { issueKey: "PROJ-1" })).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "summary,updated" } });
		expect(readBackPlan("issue.transition", { issueKey: "PROJ-1", toStatus: "Done" })).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "status,updated" } });
		expect(readBackPlan("issue.assign", { issueKey: "PROJ-1" })).toEqual({ tool: "jira_get_issue", args: { issue_key: "PROJ-1", fields: "assignee,updated" } });
		expect(readBackPlan("page.attachment.delete", { pageId: "123", attachmentId: "att900" })).toEqual({ tool: "confluence_get_attachments", args: { content_id: "123" } });
		// The transition is chosen by the status it leads to (Community list shape: id, name, to_status).
		const transitions = wrapped([{ id: "11", name: "Start Progress", to_status: { name: "In Progress", category: "In Progress" } }, { id: "31", name: "Done", to_status: { name: "Done", category: "Done" } }]);
		expect(transitionTo(transitions, "in progress")).toBe("11");
		expect(transitionTo(transitions, "Done")).toBe("31");
		expect(transitionTo(transitions, "Cancelled")).toBeUndefined();
		// Observed live: numeric ids and no destination, so the name is the status reached.
		expect(transitionTo(wrapped([{ id: 2, name: "Backlog", to_status: null }, { id: 4, name: "In Progress", to_status: null }]), "in progress")).toBe("4");
		expect(transitionTo(wrapped([{ id: 4, name: "In Progress", to_status: null }]), "Done")).toBeUndefined();
		// A destination's category is not its name: a same-category "In Review" listed
		// first must not shadow the real "In Progress" destination.
		const sameCategoryTransitions = wrapped([{ id: "21", name: "Send to Review", to_status: { name: "In Review", category: "In Progress" } }, { id: "11", name: "Start Progress", to_status: { name: "In Progress", category: "In Progress" } }]);
		expect(transitionTo(sameCategoryTransitions, "In Progress")).toBe("11");
		expect(readBackPlan("page.create", { ...PAGE, title: 'T "quoted"' })).toEqual({ tool: "confluence_search", args: { query: 'type = page AND space = "ENG" AND title = "T \\"quoted\\""', limit: 20 } });
		expect(readBackPlan("page.update", { pageId: "123", body: "b" })).toEqual({ tool: "confluence_get_page", args: { page_id: "123", include_metadata: true } });
		expect(readBackPlan("page.delete", { pageId: "123" })).toEqual({ tool: "confluence_get_page", args: { page_id: "123", include_metadata: true } });
		expect(readBackPlan("page.comment", { pageId: "123", body: "b" })).toEqual({ tool: "confluence_get_comments", args: { page_id: "123" } });
		expect(readBackPlan("page.attach", PAGE_ATTACH)).toEqual({ tool: "confluence_get_attachments", args: { content_id: "123" } });
	});

	test("page.create confines the first 20 search results to its requested space", () => {
		expect(readBackPlan("page.create", { spaceKey: "DOCS", title: "Roadmap", body: "b" })).toEqual({
			tool: "confluence_search",
			args: { query: 'type = page AND space = "DOCS" AND title = "Roadmap"', limit: 20 },
		});
	});

	test("transition preview treats a category match as a different status", () => {
		expect(baselineFromReply("issue.transition", { issueKey: "PROJ-1", toStatus: "In Progress" }, wrapped({
			key: "PROJ-1",
			status: { name: "In Review", category: "In Progress" },
			updated: "u1",
		}))).toMatchObject({ kind: "observed", baseline: { effectIds: ["PROJ-1"] } });
	});

	test("read-back evidence is found, absent, or indeterminate, and only an unchanged revision proves absence after a send", () => {
		const created = readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-8", fields: { summary: "Other" } }, { key: "PROJ-9", fields: { summary: "billing   BROKEN", issuetype: { name: "Bug" } } }] });
		expect(created).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-9" }] });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "OTHER-9", fields: { summary: "Billing broken", issuetype: { name: "Bug" } } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue key" });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9" }] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: "Task" } } }] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		// Community v0.23.1 jira_search through MCPorter --output json, as observed live on 2026-09-23: flat summary and issue_type beside the key.
		const community = wrapped({ total: -1, start_at: 0, max_results: 20, issues: [{ id: "501422", key: "PROJ-9", summary: CREATE.summary, browse_url: "https://example.atlassian.net/browse/PROJ-9", issue_type: { name: "Bug" }, created: "2026-09-23 14:03:55 AEST" }] });
		expect(readBackEvidence("issue.create", CREATE, never, community)).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-9" }] });
		expect(readBackEvidence("issue.create", CREATE, never, community, { effectIds: ["PROJ-9"], commentIds: [], revision: null })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ id: "1", key: "PROJ-9", summary: CREATE.summary }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		expect(readBackEvidence("issue.create", { ...CREATE, issueType: "!!!" }, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: "Bug" } } }] })).toEqual({ kind: "indeterminate", reason: "the requested issue type has no stable read-back representation" });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: "!!!" } } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		expect(readBackEvidence("issue.create", CREATE, never, { issues: [{ key: "PROJ-9", fields: { summary: CREATE.summary, issuetype: { name: 42 } } }] })).toEqual({ kind: "indeterminate", reason: "a matching issue search result carries no stable issue type" });
		// issue.update: the requested values present prove the write (the preview refused a no-op); otherwise only an unchanged `updated` proves absence.
		const updateInput = { issueKey: "PROJ-1", fields: { summary: "new", labels: ["a", "b"] } };
		const updateBaseline = { effectIds: ["PROJ-1"], commentIds: [], revision: "0".repeat(64) };
		expect(readBackEvidence("issue.update", updateInput, never, { key: "PROJ-1", fields: { summary: "New", labels: ["a", "b"], updated: "t2" } }, updateBaseline)).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-1" }] });
		expect(readBackEvidence("issue.update", updateInput, (observed) => observed === "t1", { key: "PROJ-1", fields: { summary: "old", labels: [], updated: "t1" } }, updateBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("issue.update", updateInput, (observed) => observed === "t1", { key: "PROJ-1", fields: { summary: "old", labels: [], updated: "t2" } }, updateBaseline)).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.update", updateInput, never, { key: "PROJ-1", fields: { summary: "new", labels: ["a", "b"], updated: "t2" } })).toEqual({ kind: "indeterminate", reason: "the Jira reply carries no revision" });
		expect(readBackEvidence("issue.update", updateInput, never, { error: "not an issue" })).toEqual({ kind: "indeterminate", reason: "the read-back reply is not an issue" });
		expect(readBackEvidence("issue.update", updateInput, never, { key: "PROJ-2", fields: { summary: "new", labels: ["a", "b"], version: 2 } }, updateBaseline)).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different issue" });
		// An assignee named by email matches the Community user record (observed live shape).
		const assign = { issueKey: "PROJ-1", fields: { assignee: "service@example.invalid" } };
		expect(readBackEvidence("issue.update", assign, never, wrapped({ key: "PROJ-1", assignee: { display_name: "Service Account", email: "service@example.invalid" }, updated: "t2" }), updateBaseline)).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-1" }] });
		expect(readBackEvidence("issue.update", assign, (observed) => observed === "t2", wrapped({ key: "PROJ-1", assignee: { display_name: "Unassigned" }, updated: "t2" }), updateBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		const comment = { issueKey: "PROJ-1", body: "Quarterly numbers are down; see the sheet" };
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "hello" }, { id: "2", body: { content: [{ type: "text", text: "Quarterly numbers are down; see the sheet" }] } }] } } })).toEqual({ kind: "found", effects: [{ kind: "jira-comment", id: "2" }] });
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "hello" }] } } })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-2", fields: { comment: { comments: [{ id: "2", body: comment.body }] } } })).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different issue" });
		expect(readBackEvidence("issue.comment", comment, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "3", body: `Context before ${comment.body} context after` }] } } })).toEqual({ kind: "absent", revisionUnchanged: false });
		// issue.comment.update: the named comment holds the body, or its own updated timestamp proves it did not move.
		const comments = (body: string, updated: string) => wrapped({ key: "PROJ-1", comments: [{ id: "454166", body, updated }, { id: "454167", body: "edited body", updated: "u9" }] });
		expect(readBackEvidence("issue.comment.update", COMMENT_UPDATE, never, comments("Edited body", "u2"))).toEqual({ kind: "found", effects: [{ kind: "jira-comment", id: "454166" }] });
		expect(readBackEvidence("issue.comment.update", COMMENT_UPDATE, (observed) => observed === "u1", comments("old body", "u1"))).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("issue.comment.update", COMMENT_UPDATE, (observed) => observed === "u1", comments("old body", "u2"))).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.comment.update", COMMENT_UPDATE, never, wrapped({ key: "PROJ-1", comments: [{ id: "1", body: "edited body" }] }))).toEqual({ kind: "indeterminate", reason: "the read-back reply names no such comment" });
		// Attachments: a new id carrying the file's basename, outside the baseline.
		const attachments = wrapped({ key: "PROJ-1", updated: "t1", attachments: [{ id: "10500", filename: "report.pdf" }, { id: "10499", filename: "report.pdf" }, { id: "10501", filename: "other.pdf" }] });
		expect(readBackEvidence("issue.attach", ATTACH, never, attachments, { effectIds: ["10499"], commentIds: [], revision: null })).toEqual({ kind: "found", effects: [{ kind: "jira-attachment", id: "10500" }] });
		expect(readBackEvidence("issue.attach", ATTACH, never, attachments, { effectIds: ["10499", "10500"], commentIds: [], revision: null })).toEqual({ kind: "absent", revisionUnchanged: false });
		// The live Community record has no id field; the id is the last segment of the content url.
		const live = wrapped({ key: "PROJ-1", updated: "t2", attachments: [{ filename: "report.pdf", size: 72, url: "https://example.atlassian.net/rest/api/2/attachment/content/201891", author: { display_name: "Service" } }] });
		expect(readBackEvidence("issue.attach", ATTACH, never, live)).toEqual({ kind: "found", effects: [{ kind: "jira-attachment", id: "201891" }] });
		expect(readBackEvidence("issue.attach", ATTACH, never, live, { effectIds: ["201891"], commentIds: [], revision: null })).toEqual({ kind: "absent", revisionUnchanged: false });
		// An upload moves the issue's updated timestamp, so an unchanged one proves the upload never landed.
		expect(readBackEvidence("issue.attach", ATTACH, (observed) => observed === "t1", wrapped({ key: "PROJ-1", updated: "t1" }))).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(uploadFailed(wrapped({ message: "Issue updated successfully", issue: { key: "PROJ-1", attachment_results: { success: false, uploaded: [], failed: [{ path: "/tmp/x", error: "nope" }] } } }))).toBe(true);
		expect(uploadFailed(wrapped({ message: "Issue updated successfully", issue: { key: "PROJ-1", attachment_results: { success: true, uploaded: [{ id: "1" }], failed: [] } } }))).toBe(false);
		expect(uploadFailed(wrapped({ message: "Issue updated successfully", issue: { key: "PROJ-1" } }))).toBe(false);
		expect(readBackEvidence("issue.attach", ATTACH, never, wrapped({ key: "PROJ-2", attachments: [{ id: "10500", filename: "report.pdf" }] }))).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different issue" });
		expect(readBackEvidence("page.attach", PAGE_ATTACH, never, wrapped({ attachments: [{ id: "att900", title: "report.pdf" }], total: 1 }))).toEqual({ kind: "found", effects: [{ kind: "confluence-attachment", id: "att900" }] });
		expect(readBackEvidence("page.attach", PAGE_ATTACH, never, wrapped({ attachments: [{ id: "att900", title: "report.pdf" }] }), { effectIds: ["att900"], commentIds: [], revision: null })).toEqual({ kind: "absent", revisionUnchanged: false });
		// Transition and assign: the requested state present proves the write; otherwise only an unchanged `updated` proves absence.
		const stateBaseline = { effectIds: ["PROJ-1"], commentIds: [], revision: "0".repeat(64) };
		expect(readBackEvidence("issue.transition", { issueKey: "PROJ-1", toStatus: "In Progress" }, never, wrapped({ key: "PROJ-1", status: { name: "In Progress", category: "In Progress", color: "yellow" }, updated: "t2" }), stateBaseline)).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-1" }] });
		expect(readBackEvidence("issue.transition", { issueKey: "PROJ-1", toStatus: "In Progress" }, (observed) => observed === "t1", wrapped({ key: "PROJ-1", status: { name: "Backlog" }, updated: "t1" }), stateBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		// A live status's category equalling the requested text must not settle the transition: "In Review" is in the "In Progress" category, but it is not "In Progress".
		expect(readBackEvidence("issue.transition", { issueKey: "PROJ-1", toStatus: "In Progress" }, (observed) => observed === "t1", wrapped({ key: "PROJ-1", status: { name: "In Review", category: "In Progress" }, updated: "t1" }), stateBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("issue.assign", { issueKey: "PROJ-1", assignee: "service@example.invalid" }, never, wrapped({ key: "PROJ-1", assignee: { display_name: "Service", email: "service@example.invalid" }, updated: "t2" }), stateBaseline)).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-1" }] });
		expect(readBackEvidence("issue.assign", { issueKey: "PROJ-1" }, never, wrapped({ key: "PROJ-1", assignee: { display_name: "Unassigned" }, updated: "t2" }), stateBaseline)).toEqual({ kind: "found", effects: [{ kind: "jira-issue", id: "PROJ-1" }] });
		expect(readBackEvidence("issue.assign", { issueKey: "PROJ-1" }, (observed) => observed === "t1", wrapped({ key: "PROJ-1", assignee: { display_name: "Service" }, updated: "t1" }), stateBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		// Attachment removal is proven by the listing no longer carrying the id; a listing that still does proves nothing landed.
		expect(readBackEvidence("page.attachment.delete", { pageId: "123", attachmentId: "att900" }, never, wrapped({ attachments: [{ id: "att901", title: "other.pdf" }] }))).toEqual({ kind: "found", effects: [{ kind: "confluence-attachment", id: "att900" }] });
		expect(readBackEvidence("page.attachment.delete", { pageId: "123", attachmentId: "att900" }, never, wrapped({ attachments: [{ id: "att900", title: "report.pdf" }] }))).toEqual({ kind: "absent", revisionUnchanged: true });
		// Deletes: a successful read-back means the object is still there; the dispatcher maps a not-found refusal to the found effect before this seam.
		expect(readBackEvidence("issue.delete", { issueKey: "PROJ-1" }, (observed) => observed === "t1", wrapped({ key: "PROJ-1", summary: "x", updated: "t1" }))).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("issue.delete", { issueKey: "PROJ-1" }, never, wrapped({ key: "PROJ-1", summary: "x", updated: "t2" }))).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.delete", { issueKey: "PROJ-1" }, never, wrapped({ key: "PROJ-2" }))).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different issue" });
		expect(readBackEvidence("page.delete", { pageId: "123" }, (observed) => observed === "7", { id: "123", version: 7 })).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("page.delete", { pageId: "123" }, never, { id: "999", version: 7 })).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different page" });
		// page.create matches by space key, the only space identity Community exposes.
		expect(readBackEvidence("page.create", PAGE, never, { results: [{ id: "556", title: "Roadmap", space: { key: "ENG", name: "Engineering" } }] })).toEqual({ kind: "found", effects: [{ kind: "confluence-content", id: "556" }] });
		expect(readBackEvidence("page.create", PAGE, never, { results: [{ id: "556", title: "Roadmap", space: { key: "OTHER" } }] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("page.create", PAGE, never, { results: [{ id: "556", title: "Roadmap" }] })).toEqual({ kind: "indeterminate", reason: "a matching title was found but the reply names no space" });
		const update = { pageId: "123", body: "# New body" };
		const pageBaseline = { effectIds: ["123"], commentIds: [], revision: "7" };
		expect(readBackEvidence("page.update", update, (observed) => observed === "7", { id: "123", version: 7, content: { value: "old" } }, pageBaseline)).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("page.update", update, (observed) => observed === "7", { id: "123", metadata: { version: 8 }, body: { value: "# New body\nmore" } }, pageBaseline)).toEqual({ kind: "indeterminate", reason: "the page moved to another version whose content is not this update" });
		expect(readBackEvidence("page.update", update, never, { id: "999", version: 8, content: { value: "# New body" } }, pageBaseline)).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different page" });
		expect(readBackEvidence("page.update", update, (observed) => observed === "7", { id: "123", version: 8, content: { value: "someone else" } }, pageBaseline)).toEqual({ kind: "indeterminate", reason: "the page moved to another version whose content is not this update" });
		expect(readBackEvidence("page.update", update, never, { id: "123" })).toEqual({ kind: "indeterminate", reason: "the read-back reply carries no stable version" });
		// Live Community shape with include_metadata: the page under metadata, body as converted markdown.
		const livePage = wrapped({ metadata: { id: "123", title: "Roadmap", version: 8, space: { key: "ENG" }, attachments: [], content: { value: "New body\n========\n\nmore", format: "markdown" } } });
		expect(readBackEvidence("page.update", { pageId: "123", body: "# New body\n\nmore" }, (observed) => observed === "7", livePage, pageBaseline)).toEqual({ kind: "found", effects: [{ kind: "confluence-content", id: "123" }] });
		expect(baselineFromReply("page.update", update, livePage)).toEqual({ kind: "observed", baseline: { effectIds: ["123"], commentIds: [], revision: "8" } });
		expect(baselineFromReply("page.update", update, wrapped({ metadata: { id: "999", version: 8 } }))).toEqual({ kind: "indeterminate", reason: "the page read names a different page" });
		expect(readBackEvidence("page.comment", { pageId: "123", body: "hello there" }, never, [{ id: "42", body: "Hello, there!" }])).toEqual({ kind: "found", effects: [{ kind: "confluence-comment", id: "42" }] });
		const pageComment = "Quarterly numbers are down; see the sheet";
		expect(readBackEvidence("page.comment", { pageId: "123", body: pageComment }, never, [{ id: "43", body: `Before ${pageComment} after` }])).toEqual({ kind: "absent", revisionUnchanged: false });
	});

	test("baselines record every pre-existing matching identifier, snapshot update targets, and refuse a no-op", () => {
		expect(normalised("你好，世界")).toBe("你好 世界");
		expect(readBackEvidence("issue.comment", { issueKey: "PROJ-1", body: "!!!" }, never, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "???" }] } } })).toEqual({ kind: "indeterminate", reason: "the requested comment has no stable read-back representation" });
		expect(baselineFromReply("issue.create", CREATE, { issues: [{ key: "PROJ-1", fields: { summary: CREATE.summary, issuetype: { name: "Bug" } } }, { key: "PROJ-2", fields: { summary: CREATE.summary, issuetype: { name: "Bug" } } }] })).toEqual({ kind: "observed", baseline: { effectIds: ["PROJ-1", "PROJ-2"], commentIds: [], revision: null } });
		expect(baselineFromReply("issue.comment", { issueKey: "PROJ-1", body: "same comment" }, { key: "PROJ-1", fields: { comment: { comments: [{ id: "1", body: "same comment" }, { id: "2", body: "same comment" }] } } })).toEqual({ kind: "observed", baseline: { effectIds: ["PROJ-1"], commentIds: ["1", "2"], revision: null } });
		expect(baselineFromReply("issue.comment", { issueKey: "PROJ-1", body: "same comment" }, { key: "PROJ-2", fields: { comment: { comments: [{ id: "3", body: "same comment" }] } } })).toEqual({ kind: "indeterminate", reason: "the Jira reply names a different issue" });
		// issue.update: the current values of the requested fields are digested; a target already holding them is a refused no-op.
		const updateBaseline = baselineFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "new" } }, wrapped({ key: "PROJ-1", summary: "old", updated: "t1" }));
		expect(updateBaseline).toMatchObject({ kind: "observed", baseline: { effectIds: ["PROJ-1"], commentIds: [] } });
		expect((updateBaseline as { baseline: { revision: string } }).baseline.revision).toMatch(/^[0-9a-f]{64}$/);
		expect(baselineFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "old" } }, wrapped({ key: "PROJ-1", summary: "Old", updated: "t1" }))).toEqual({ kind: "refused", reason: "the issue already holds every requested value; nothing to change" });
		expect(baselineFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "new" } }, wrapped({ key: "PROJ-1", summary: "old" }))).toEqual({ kind: "indeterminate", reason: "the Jira reply carries no revision" });
		expect(baselineFromReply("issue.update", { issueKey: "PROJ-1", fields: { summary: "new" } }, { key: "PROJ-2", fields: { version: 7 } })).toEqual({ kind: "indeterminate", reason: "the Jira reply names a different issue" });
		// issue.comment.update: the named comment's current text and updated timestamp.
		const commentBaseline = baselineFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ key: "PROJ-1", comments: [{ id: "454166", body: "old body", updated: "u1" }] }));
		expect(commentBaseline).toMatchObject({ kind: "observed", baseline: { effectIds: ["PROJ-1"], commentIds: ["454166"] } });
		expect((commentBaseline as { baseline: { revision: string } }).baseline.revision).toMatch(/^[0-9a-f]{64}$/);
		expect(baselineFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ key: "PROJ-1", comments: [{ id: "454166", body: "Edited body!", updated: "u1" }] }))).toEqual({ kind: "refused", reason: "the comment already holds the requested body; nothing to change" });
		expect(baselineFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ key: "PROJ-1", comments: [{ id: "1", body: "x" }] }))).toEqual({ kind: "indeterminate", reason: "the Jira reply names no such comment on this issue" });
		expect(baselineFromReply("issue.attach", ATTACH, wrapped({ key: "PROJ-1", attachments: [{ id: "10499", filename: "report.pdf" }, { id: "10501", filename: "other.pdf" }] }))).toEqual({ kind: "observed", baseline: { effectIds: ["10499"], commentIds: [], revision: null } });
		expect(baselineFromReply("issue.delete", { issueKey: "PROJ-1" }, wrapped({ key: "PROJ-1", summary: "x", updated: "t1" }))).toMatchObject({ kind: "observed", baseline: { effectIds: ["PROJ-1"], commentIds: [] } });
		expect(baselineFromReply("issue.transition", { issueKey: "PROJ-1", toStatus: "Done" }, wrapped({ key: "PROJ-1", status: { name: "Backlog" }, updated: "t1" }))).toMatchObject({ kind: "observed", baseline: { effectIds: ["PROJ-1"] } });
		expect(baselineFromReply("issue.transition", { issueKey: "PROJ-1", toStatus: "Backlog" }, wrapped({ key: "PROJ-1", status: { name: "Backlog" }, updated: "t1" }))).toEqual({ kind: "refused", reason: "the issue already has the requested status; nothing to change" });
		expect(baselineFromReply("issue.assign", { issueKey: "PROJ-1" }, wrapped({ key: "PROJ-1", assignee: { display_name: "Unassigned" }, updated: "t1" }))).toEqual({ kind: "refused", reason: "the issue already has the requested assignee; nothing to change" });
		expect(baselineFromReply("issue.assign", { issueKey: "PROJ-1", assignee: "a@b" }, wrapped({ key: "PROJ-1", assignee: { display_name: "Unassigned" }, updated: "t1" }))).toMatchObject({ kind: "observed", baseline: { effectIds: ["PROJ-1"] } });
		expect(baselineFromReply("page.attachment.delete", { pageId: "123", attachmentId: "att900" }, wrapped({ attachments: [{ id: "att900", title: "report.pdf" }] }))).toEqual({ kind: "observed", baseline: { effectIds: ["att900"], commentIds: [], revision: null } });
		expect(baselineFromReply("page.attachment.delete", { pageId: "123", attachmentId: "att900" }, wrapped({ attachments: [] }))).toEqual({ kind: "refused", reason: "the page has no attachment with that id" });
		expect(baselineFromReply("page.create", { ...PAGE, title: "Same page" }, { results: [{ id: "556", title: "Same page", space: { key: "ENG" } }, { id: "557", title: "Same page", space: { key: "ENG" } }] })).toEqual({ kind: "observed", baseline: { effectIds: ["556", "557"], commentIds: [], revision: null } });
		expect(baselineFromReply("page.update", { pageId: "123", body: "new" }, { id: "999", version: 7 })).toEqual({ kind: "indeterminate", reason: "the page read names a different page" });
		expect(baselineFromReply("page.delete", { pageId: "123" }, { id: "123", version: 7 })).toEqual({ kind: "observed", baseline: { effectIds: ["123"], commentIds: [], revision: "7" } });
		expect(baselineFromReply("page.comment", { pageId: "123", body: "same comment" }, [{ id: "4", body: "same comment" }])).toEqual({ kind: "observed", baseline: { effectIds: ["123"], commentIds: ["4"], revision: null } });
		// Confluence versions a same-named attachment under its existing id, which no read-back could ever tell apart from "nothing uploaded"; refuse before that write is sent.
		expect(baselineFromReply("page.attach", PAGE_ATTACH, wrapped({ attachments: [{ id: "att1", title: "report.pdf" }] }))).toEqual({ kind: "refused", reason: "the page already has an attachment with this file name; run page.attachment.delete first" });
		expect(baselineFromReply("page.attach", PAGE_ATTACH, wrapped({ attachments: [{ id: "att1", title: "other.pdf" }] }))).toEqual({ kind: "observed", baseline: { effectIds: [], commentIds: [], revision: null } });
	});

	test("comment edit baseline requires the named comment's updated timestamp", () => {
		const missingTimestamp = wrapped({ key: "PROJ-1", updated: "issue-u1", comments: [{ id: "454166", body: "old body" }] });
		expect(baselineFromReply("issue.comment.update", COMMENT_UPDATE, missingTimestamp)).toEqual({
			kind: "indeterminate",
			reason: "the comment read exposes no updated timestamp to bind the revision",
		});
	});

	test("page attachment preview refuses an existing file name even when its id is missing", () => {
		expect(baselineFromReply("page.attach", PAGE_ATTACH, wrapped({ attachments: [{ title: "report.pdf" }] }))).toEqual({
			kind: "refused",
			reason: "the page already has an attachment with this file name; run page.attachment.delete first",
		});
	});
});

// The wiki-comment exception: Jira wiki bodies whose image macros name
// attachments already on the issue, through the owned REST route. Rendered
// HTML shapes are the ones the prototype observed on SMSTX-364 (28 September
// 2026): <img> elements whose src names the attachment id and whose alt names
// the file.
describe("wiki media comments", () => {
	const MEDIA = { issueKey: "PROJ-1", body: "Before:\n\n!before.png|width=600!\n\nAfter:\n\n!after.png!", images: ["before.png", "after.png"] };
	const MEDIA_UPDATE = { ...MEDIA, commentId: "454771" };
	const IDS = { effectIds: ["202456", "202457"], commentIds: [], revision: null };
	const rendered = (...ids: string[]) => ids.map((id) => `<p><span class="image-wrap"><img src="/rest/api/3/attachment/content/${id}" alt="${id === "202456" ? "before.png" : "after.png"}" /></span></p>`).join("");
	const BOTH = rendered("202456", "202457");
	// Jira's wiki read-back of the stored comment: image macros carry the
	// parameters Jira adds, and the text is otherwise the same.
	const STORED = MEDIA.body.replace("!before.png|width=600!", '!before.png|width=600,alt="before.png"!').replace("!after.png!", '!after.png|alt="after.png"!');

	test("images must be exactly the files the body references as wiki image macros, and each name must be a plain attachment name", () => {
		expect(writeInput("issue.comment.media", MEDIA)).toEqual({ ok: true, input: MEDIA });
		expect(writeInput("issue.comment.media.update", MEDIA_UPDATE)).toEqual({ ok: true, input: MEDIA_UPDATE });
		expect(writeInput("issue.comment.media", { ...MEDIA, images: ["before.png"] })).toEqual({ ok: false, reason: "the body references an image that images does not name" });
		expect(writeInput("issue.comment.media", { ...MEDIA, images: [...MEDIA.images, "states.png"] })).toEqual({ ok: false, reason: "images names a file the body does not reference as !name! or !name|params!" });
		expect(writeInput("issue.comment.media", { ...MEDIA, images: ["before.png", "before.png", "after.png"] })).toEqual({ ok: false, reason: "input key images is invalid" });
		expect(writeInput("issue.comment.media", { issueKey: "PROJ-1", body: "no images here", images: [] })).toEqual({ ok: false, reason: "input key images is invalid" });
		for (const name of ["a|b.png", "a!b.png", "dir/a.png", "a\nb.png", ""]) expect([name, writeInput("issue.comment.media", { ...MEDIA, images: [name, "after.png"] }).ok]).toEqual([name, false]);
		expect(writeInput("issue.comment.media", { ...MEDIA, images: Array.from({ length: 21 }, (_entry, index) => `${index}.png`) }).ok).toBe(false);
		expect(writeInput("issue.comment.media", { ...MEDIA, file: "/tmp/x.png" })).toEqual({ ok: false, reason: "unknown input key file" });
		expect(writeInput("issue.comment.media.update", { ...MEDIA_UPDATE, commentId: "abc" }).ok).toBe(false);
		expect(writeInput("issue.comment.media.update", MEDIA)).toEqual({ ok: false, reason: "input key commentId is required" });
		// Prose exclamation marks are not references; a macro needs a file extension.
		expect(wikiImageReferences("Great! See !shot.png|thumbnail! and !shot.png! again! Done!")).toEqual(["shot.png"]);
		expect(wikiImageReferences("!SMSTX-364-after-crop.png|width=600!\n!SMSTX-364-after-states.png!")).toEqual(["SMSTX-364-after-crop.png", "SMSTX-364-after-states.png"]);
	});

	test("the REST route receives the wiki body only; images bind attachment ids in the preparation, and read-back reads rendered comments", () => {
		const ctx = { revision: null, baseline: IDS };
		expect(preparation("issue.comment.media", MEDIA)).toEqual({ kind: "media", issueKey: "PROJ-1", images: MEDIA.images });
		expect(preparation("issue.comment.media.update", MEDIA_UPDATE)).toEqual({ kind: "media-comment", issueKey: "PROJ-1", commentId: "454771", images: MEDIA.images });
		expect(writeArguments(OPERATION_SPECS["issue.comment.media"], MEDIA, ctx).args).toEqual({ issue_key: "PROJ-1", body: MEDIA.body });
		expect(writeArguments(OPERATION_SPECS["issue.comment.media.update"], MEDIA_UPDATE, ctx).args).toEqual({ issue_key: "PROJ-1", comment_id: "454771", body: MEDIA.body });
		expect(readBackPlan("issue.comment.media", MEDIA)).toEqual({ tool: "jira_rest_comments_list", args: { issue_key: "PROJ-1" } });
		expect(readBackPlan("issue.comment.media.update", MEDIA_UPDATE)).toEqual({ tool: "jira_rest_comment_get", args: { issue_key: "PROJ-1", comment_id: "454771" } });
		const attachments = [{ id: "202457", name: "after.png", contentType: "image/png" }, { id: "202456", name: "before.png" }, { id: "1", name: "notes.pdf", contentType: "application/pdf" }];
		expect(resolveMediaAttachments(attachments, MEDIA.images)).toEqual({ ok: true, ids: ["202456", "202457"] });
		expect(resolveMediaAttachments(attachments, ["before.png", "missing.png"])).toEqual({ ok: false, cause: "not-found", reason: "an image named in images is not attached to the issue" });
		expect(resolveMediaAttachments([...attachments, { id: "202499", name: "after.png" }], MEDIA.images)).toEqual({ ok: false, cause: "input-invalid", reason: "an image named in images matches more than one attachment on the issue; remove the duplicate first" });
		// Only images render inline: the MIME type decides when Jira reports one; otherwise the extension does.
		const notImage = { ok: false as const, cause: "input-invalid" as const, reason: "an image named in images is not an image attachment; only image content renders inline" };
		expect(resolveMediaAttachments(attachments, ["notes.pdf", "after.png"])).toEqual(notImage);
		expect(resolveMediaAttachments([{ id: "2", name: "shot.png", contentType: "application/octet-stream" }], ["shot.png"])).toEqual(notImage);
		expect(resolveMediaAttachments([{ id: "3", name: "report.pdf" }], ["report.pdf"])).toEqual(notImage);
		expect(resolveMediaAttachments([{ id: "4", name: "Diagram.JPG" }, { id: "5", name: "x.webp", contentType: "IMAGE/WEBP" }], ["Diagram.JPG", "x.webp"])).toEqual({ ok: true, ids: ["4", "5"] });
		expect(accountIdOf(wrapped({ accountId: "712020:me", emailAddress: "me@example.invalid" }))).toBe("712020:me");
		expect(accountIdOf({ self: "x" })).toBeUndefined();
		expect(observeRestComment({ id: "454771", author: { accountId: "712020:me" }, updated: "u1", renderedBody: "<p>x</p>", body: "x" })).toEqual({ id: "454771", authorAccountId: "712020:me", updated: "u1", renderedBody: "<p>x</p>" });
		expect(observeRestComment({ error: "gone" })).toEqual({ id: undefined, authorAccountId: undefined, updated: undefined, renderedBody: undefined });
	});

	test("rendered HTML proves an image only by the bound attachment id as a path segment of an <img> source; alt text and other attributes never count", () => {
		expect(renderedImagesPresent(BOTH, IDS.effectIds)).toBe(true);
		expect(renderedImagesPresent(rendered("202456"), IDS.effectIds)).toBe(false);
		expect(renderedImagesPresent('<img src="https://example.atlassian.net/secure/attachment/202456/before.png"><img src=\'https://example.atlassian.net/secure/thumbnail/202457/after.png?default=false#x\'>', IDS.effectIds)).toBe(true);
		expect(renderedImagesPresent('<img alt="x" src=/secure/attachment/202456/before.png><img src=/secure/attachment/202457/after.png>', IDS.effectIds)).toBe(true);
		// A longer id that merely starts with the bound one is a different attachment.
		expect(renderedImagesPresent('<img src="/rest/api/3/attachment/content/2024567"><img src="/rest/api/3/attachment/content/202457">', IDS.effectIds)).toBe(false);
		// The old id in alt while the source points at another attachment is a moved image, not this one.
		expect(renderedImagesPresent('<img alt="/202456" title="attachment/202456" src="/rest/api/3/attachment/content/999"><img src="/rest/api/3/attachment/content/202457">', IDS.effectIds)).toBe(false);
		// The id in the query string or as part of a longer segment is not a path segment.
		expect(renderedImagesPresent('<img src="/rest/api/3/attachment/content/999?attachment=202456"><img src="/rest/api/3/attachment/content/202457">', IDS.effectIds)).toBe(false);
		expect(renderedImagesPresent('<img src="/a/id-202456/x"><img src="/rest/api/3/attachment/content/202457">', IDS.effectIds)).toBe(false);
		expect(renderedImagesPresent("<p>Before: before.png after.png 202456 202457</p>", IDS.effectIds)).toBe(false);
		expect(renderedImagesPresent(BOTH, [])).toBe(false);
		expect(renderedImagesPresent("", IDS.effectIds)).toBe(false);
	});

	test("wiki bodies match by prose, exact image names and requested parameters, exact link and mention targets; a parameter Jira added is tolerated", () => {
		const full = "Hi [~accountid:712020:abc], see !shot.png|width=600! and [the story|https://x.example/a/b]. Done.";
		expect(wikiParts(full)).toEqual([
			{ kind: "text", value: "hi" },
			{ kind: "mention", id: "712020:abc" },
			{ kind: "text", value: "see" },
			{ kind: "image", name: "shot.png", params: new Map([["width", "600"]]) },
			{ kind: "text", value: "and" },
			{ kind: "link", label: "the story", target: "https://x.example/a/b" },
			{ kind: "text", value: "done" },
		]);
		expect(sameWikiBody(MEDIA.body, STORED)).toBe(true);
		expect(sameWikiBody(full, full.replace("[the story|", "[The Story |"))).toBe(true);
		expect(sameWikiBody(full, full.replace("width=600", 'alt="shot.png",width=600'))).toBe(true);
		// Re-review cases: a changed width and a changed link target are other content.
		expect(sameWikiBody(full, full.replace("width=600", "width=100"))).toBe(false);
		expect(sameWikiBody(full, full.replace("https://x.example/a/b", "https://x.example/a?b"))).toBe(false);
		expect(sameWikiBody(full, full.replace("width=600", "thumbnail"))).toBe(false);
		expect(sameWikiBody(full, full.replace("712020:abc", "712020:abd"))).toBe(false);
		expect(sameWikiBody(full, full.replace("!shot.png|width=600!", "!other.png|width=600!"))).toBe(false);
		expect(sameWikiBody(full, full.replace("Done.", "Done. More."))).toBe(false);
		expect(sameWikiBody(full, `${full}\n\n!extra.png!`)).toBe(false);
		expect(sameWikiBody("!!!", "!!!")).toBe(false);
	});

	test("a reply proves a media comment only when it holds this write's body and renders every bound image; an edit reply must name the edited comment", () => {
		expect(sameWikiBody(MEDIA.body, "Other text\n\n!before.png!\n\n!after.png!")).toBe(false);
		expect(effectsFromReply("issue.comment.media", MEDIA, { id: "10077", author: { accountId: "712020:me" }, body: STORED, renderedBody: BOTH, updated: "u1" }, IDS)).toEqual([{ kind: "jira-comment", id: "10077" }]);
		expect(effectsFromReply("issue.comment.media", MEDIA, { id: "10077", body: STORED, renderedBody: rendered("202456") }, IDS)).toEqual([]);
		expect(effectsFromReply("issue.comment.media", MEDIA, { id: "10077", body: MEDIA.body }, IDS)).toEqual([]);
		// The same images under different text is another write, never this one.
		expect(effectsFromReply("issue.comment.media", MEDIA, { id: "10077", body: "Other text\n\n!before.png!\n\n!after.png!", renderedBody: BOTH }, IDS)).toEqual([]);
		expect(effectsFromReply("issue.comment.media", MEDIA, { id: "10077", renderedBody: BOTH }, IDS)).toEqual([]);
		expect(effectsFromReply("issue.comment.media.update", MEDIA_UPDATE, { id: "454771", body: STORED, renderedBody: BOTH, updated: "u2" }, IDS)).toEqual([{ kind: "jira-comment", id: "454771" }]);
		expect(effectsFromReply("issue.comment.media.update", MEDIA_UPDATE, { id: "454772", body: STORED, renderedBody: BOTH, updated: "u2" }, IDS)).toEqual([]);
	});

	test("read-back finds a new rendering comment outside the baseline; an edit is found only after its own updated moved and it renders the images", () => {
		const list = (...comments: Record<string, unknown>[]) => ({ startAt: 0, maxResults: 100, total: comments.length, comments });
		const historical = { id: "900", author: { accountId: "712020:me" }, body: STORED, renderedBody: BOTH, updated: "u0" };
		const fresh = { id: "10078", author: { accountId: "712020:me" }, body: STORED, renderedBody: BOTH, updated: "u1" };
		// Another author's comment with the same images and other text is not this write.
		const sameImagesOtherText = { id: "10080", author: { accountId: "712020:other" }, body: "Looks good.\n\n!before.png!\n\n!after.png!", renderedBody: BOTH, updated: "u1" };
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list(historical, fresh, sameImagesOtherText), { ...IDS, commentIds: ["900"] })).toEqual({ kind: "found", effects: [{ kind: "jira-comment", id: "10078" }] });
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list(historical, sameImagesOtherText), { ...IDS, commentIds: ["900"] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list(historical), { ...IDS, commentIds: ["900"] })).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list({ id: "10079", body: STORED, renderedBody: rendered("202456") }), IDS)).toEqual({ kind: "absent", revisionUnchanged: false });
		// An old id in alt while the source moved to another attachment is not proof (re-review case).
		const altDecoy = `<img alt="/202456" src="/rest/api/3/attachment/content/999">${rendered("202457")}`;
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list({ id: "10082", body: STORED, renderedBody: altDecoy }), IDS)).toEqual({ kind: "absent", revisionUnchanged: false });
		// Two new comments holding this write's content cannot be attributed; the receipt stays open.
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list(fresh, { ...fresh, id: "10081" }), IDS)).toEqual({ kind: "indeterminate", reason: "more than one new comment holds this write's content; resolve the receipt by hand" });
		const unmoved = (observed: string) => observed === "u1";
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454771", updated: "u1", body: "old", renderedBody: "<p>old</p>" }, IDS)).toEqual({ kind: "absent", revisionUnchanged: true });
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454771", updated: "u2", body: STORED, renderedBody: BOTH }, IDS)).toEqual({ kind: "found", effects: [{ kind: "jira-comment", id: "454771" }] });
		// The same text with a changed image width or link target is other content (re-review cases).
		const widthChanged = STORED.replace("width=600", "width=100");
		expect(readBackEvidence("issue.comment.media", MEDIA, never, list({ id: "10083", body: widthChanged, renderedBody: BOTH }), IDS)).toEqual({ kind: "absent", revisionUnchanged: false });
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454771", updated: "u2", body: widthChanged, renderedBody: BOTH }, IDS)).toEqual({ kind: "indeterminate", reason: "the comment moved to a version that does not hold this write's content" });
		const LINKED = { ...MEDIA, body: `${MEDIA.body}\n\nLive: [open the story|https://x.example/a/b]` };
		const linkedStored = `${STORED}\n\nLive: [open the story|https://x.example/a/b]`;
		expect(readBackEvidence("issue.comment.media", LINKED, never, list({ id: "10084", body: linkedStored, renderedBody: BOTH }), IDS)).toEqual({ kind: "found", effects: [{ kind: "jira-comment", id: "10084" }] });
		expect(readBackEvidence("issue.comment.media", LINKED, never, list({ id: "10085", body: linkedStored.replace("/a/b", "/a?b"), renderedBody: BOTH }), IDS)).toEqual({ kind: "absent", revisionUnchanged: false });
		// A competing edit with the same images but other text moved the comment; it is not this write.
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454771", updated: "u2", body: "Competing edit.\n\n!before.png!\n\n!after.png!", renderedBody: BOTH }, IDS)).toEqual({ kind: "indeterminate", reason: "the comment moved to a version that does not hold this write's content" });
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454771", updated: "u2", body: STORED, renderedBody: rendered("202456") }, IDS)).toEqual({ kind: "indeterminate", reason: "the comment moved to a version that does not hold this write's content" });
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454772", updated: "u2", body: STORED, renderedBody: BOTH }, IDS)).toEqual({ kind: "indeterminate", reason: "the read-back reply names a different comment" });
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { id: "454771", renderedBody: BOTH }, IDS)).toEqual({ kind: "indeterminate", reason: "the comment read exposes no updated timestamp" });
		expect(readBackEvidence("issue.comment.media.update", MEDIA_UPDATE, unmoved, { errorMessages: ["gone"] }, IDS)).toEqual({ kind: "indeterminate", reason: "the read-back reply names no comment" });
		// Baselines: existing comments rendering the same files are candidates; an edit binds the comment's own updated.
		// Candidates are matched by the bound attachment ids in the image sources; a comment whose sources carry the ids without the file names is still a candidate.
		const idsOnly = { id: "902", body: STORED, renderedBody: '<img src="/secure/attachment/202456/x"><img src="/secure/attachment/202457/y">' };
		expect(baselineFromReply("issue.comment.media", MEDIA, list(historical, sameImagesOtherText, idsOnly, { id: "901", body: STORED, renderedBody: rendered("202456") }), undefined, IDS)).toEqual({ kind: "observed", baseline: { effectIds: [], commentIds: ["900", "902"], revision: null } });
		const editBaseline = baselineFromReply("issue.comment.media.update", MEDIA_UPDATE, { id: "454771", author: { accountId: "712020:me" }, updated: "u1", renderedBody: "<p>old</p>" });
		expect(editBaseline).toMatchObject({ kind: "observed", baseline: { effectIds: [], commentIds: ["454771"] } });
		expect((editBaseline as { baseline: { revision: string } }).baseline.revision).toMatch(/^[0-9a-f]{64}$/);
		expect(baselineFromReply("issue.comment.media.update", MEDIA_UPDATE, { id: "454771", renderedBody: "<p>old</p>" })).toEqual({ kind: "indeterminate", reason: "the comment read exposes no updated timestamp to bind the revision" });
		expect(baselineFromReply("issue.comment.media.update", MEDIA_UPDATE, { id: "1", updated: "u1" })).toEqual({ kind: "indeterminate", reason: "the comment read names a different comment" });
	});
});
