// Pure write policy: neutral input contracts, the Community argument adapter,
// preparatory reads, effect extraction, and read-back evidence. Expected
// values are literals from the mcp-atlassian v0.23.1 source read on
// 22 September 2026 and reply shapes observed live on 23 September 2026.
import { describe, expect, test } from "bun:test";
import { OPERATION_SPECS } from "../scripts/dispatch/contract.ts";
import { baselineFromReply, effectsFromReply, normalised, preparation, readBackEvidence, readBackPlan, transitionTo, uploadFailed, WRITE_OPERATIONS, writeArguments, writeInput } from "../scripts/dispatch/writes.ts";

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
		expect(WRITE_OPERATIONS).toEqual(["issue.create", "issue.update", "issue.comment", "issue.comment.update", "issue.attach", "issue.transition", "issue.assign", "issue.delete", "page.create", "page.update", "page.comment", "page.attach", "page.attachment.delete", "page.delete"]);
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
		expect(readBackPlan("page.create", { ...PAGE, title: 'T "quoted"' })).toEqual({ tool: "confluence_search", args: { query: 'type = page AND title = "T \\"quoted\\""', limit: 20 } });
		expect(readBackPlan("page.update", { pageId: "123", body: "b" })).toEqual({ tool: "confluence_get_page", args: { page_id: "123", include_metadata: true } });
		expect(readBackPlan("page.delete", { pageId: "123" })).toEqual({ tool: "confluence_get_page", args: { page_id: "123", include_metadata: true } });
		expect(readBackPlan("page.comment", { pageId: "123", body: "b" })).toEqual({ tool: "confluence_get_comments", args: { page_id: "123" } });
		expect(readBackPlan("page.attach", PAGE_ATTACH)).toEqual({ tool: "confluence_get_attachments", args: { content_id: "123" } });
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
		expect(baselineFromReply("issue.comment.update", COMMENT_UPDATE, wrapped({ key: "PROJ-1", comments: [{ id: "454166", body: "Edited body!" }] }))).toEqual({ kind: "refused", reason: "the comment already holds the requested body; nothing to change" });
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
		expect(baselineFromReply("page.attach", PAGE_ATTACH, wrapped({ attachments: [{ id: "att1", title: "report.pdf" }] }))).toEqual({ kind: "observed", baseline: { effectIds: ["att1"], commentIds: [], revision: null } });
	});
});
