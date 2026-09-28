// AC20: three REST writes cross the compiled front door, custody child,
// dispatcher and journal. Only the REST Provider is replaced in a private
// plugin copy. This is fixture process proof, not real REST or live Jira proof.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileFrontDoor } from "../../../tests/compile-front-door.ts";
import { CustodyFixture, PROVIDER_TOKEN, SERVICE_TOKEN } from "./fixtures/custody-fixture.ts";
import { changedPaths, copyWithFakeReader, FRONT_DOOR, KEYCHAIN_LEAF, REQUIREMENTS, SHIPPED_ROOT, verifySubstitutedCopy } from "./fixtures/plugin-copy.ts";

const PROVIDER_PATH = path.join("skills", "atlassian", "scripts", "atlassian-rest-provider.ts");
const FAKE_PROVIDER = path.join(import.meta.dir, "fixtures", "rest-provider-fake.ts");
const TENANT = ["--select", "tenant=example"];
const BODY = "Before:\n\n!before.png|width=600!\n\nAfter:\n\n!after.png!";
const RENDERED = '<p><img src="/rest/api/3/attachment/content/202456" alt="before.png"></p><p><img src="/rest/api/3/attachment/content/202457" alt="after.png"></p>';
const PRINCIPAL = "712020:00000000-0000-4000-8000-00000000000a";
const attachments = [
	{ id: "202456", filename: "before.png", size: 48123, mimeType: "image/png", created: "2026-09-28T01:02:03.000+1000", author: { accountId: PRINCIPAL } },
	{ id: "202457", filename: "after.png", size: 10, mimeType: "image/png", created: "c2", author: { accountId: PRINCIPAL } },
];
const ok = (body: unknown, status = 200) => ({ status, body });
const attachmentReply = (items: unknown[] = attachments, updated = "t1") => ok({ key: "PROJ-1", fields: { updated, attachment: items } });
const commentsReply = (...comments: unknown[]) => ok({ startAt: 0, maxResults: 100, total: comments.length, comments });
const mediaInput = { issueKey: "PROJ-1", body: BODY, images: ["before.png", "after.png"] };

type ResponsePlan = Record<string, { before?: ReturnType<typeof ok>; after?: ReturnType<typeof ok>; write?: ReturnType<typeof ok> }>;
type Result = { code: number; stdout: string; stderr: string };
type Envelope = { result: { commandIdentity: string; outcome: string; causeCode: string; transactionState: string; effects: { completed: string[]; uncertain: string[] }; data: { result: Record<string, unknown> } | null } };
const envelope = (run: Result): Envelope => JSON.parse(run.stdout) as Envelope;

let copiedPlugin: string;
let fixture: CustodyFixture | undefined;

beforeAll(() => {
	copiedPlugin = copyWithFakeReader("connectors-rest-process-");
	verifySubstitutedCopy(copiedPlugin);
	copyFileSync(FAKE_PROVIDER, path.join(copiedPlugin, PROVIDER_PATH));
	compileFrontDoor(path.join(copiedPlugin, "bin", "connectors.ts"), path.join(copiedPlugin, FRONT_DOOR));
	expect(changedPaths(SHIPPED_ROOT, copiedPlugin)).toEqual([FRONT_DOOR, REQUIREMENTS, PROVIDER_PATH, KEYCHAIN_LEAF].sort());
	expect(readFileSync(path.join(copiedPlugin, PROVIDER_PATH))).toEqual(readFileSync(FAKE_PROVIDER));
}, 120_000);
afterAll(() => { if (copiedPlugin) rmSync(copiedPlugin, { recursive: true, force: true }); });
afterEach(() => { fixture?.dispose(); fixture = undefined; });

async function run(operation: string, input: unknown, phase: string[]): Promise<Result> {
	if (!fixture) throw new Error("fixture absent");
	return fixture.frontDoor(["run", "atlassian", ...TENANT, operation, "--input", JSON.stringify(input), ...phase], { binary: path.join(copiedPlugin, FRONT_DOOR) });
}

function prepare(responses: ResponsePlan): CustodyFixture {
	fixture = new CustodyFixture().installAll();
	fixture.writeItem({ username: "service@example.invalid", credential: PROVIDER_TOKEN, site_url: "https://example.atlassian.net" });
	writeFileSync(path.join(fixture.root, "rest-responses.json"), JSON.stringify(responses));
	return fixture;
}

function calls(machine: CustodyFixture): { tool: string; args: unknown }[] {
	const file = path.join(machine.root, "rest-calls.jsonl");
	return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { tool: string; args: unknown });
}

async function prove(operation: string, input: unknown, writeTool: string, expectedArgs: unknown, effect: { kind: string; id: string }): Promise<void> {
	const machine = fixture;
	if (!machine) throw new Error("fixture absent");
	const previewRun = await run(operation, input, ["--preview"]);
	expect([previewRun.code, previewRun.stderr]).toEqual([0, ""]);
	const preview = envelope(previewRun).result;
	expect([preview.commandIdentity, preview.outcome, preview.causeCode]).toEqual(["connectors.run.preview", "success", "SUCCESS_RUN_RECORDED"]);
	const previewData = preview.data?.result;
	expect([previewData?.provider, previewData?.tool, previewData?.arguments]).toEqual(["rest", writeTool, expectedArgs]);
	expect(calls(machine).filter((call) => call.tool === writeTool)).toEqual([]);
	const previewId = previewData?.previewId;
	if (typeof previewId !== "string") throw new Error("preview did not return an id");
	const applyRun = await run(operation, input, ["--apply", previewId]);
	expect([applyRun.code, applyRun.stderr]).toEqual([0, ""]);
	const applied = envelope(applyRun).result;
	expect([applied.commandIdentity, applied.outcome, applied.causeCode, applied.transactionState, applied.effects.completed]).toEqual(["connectors.run.apply", "success", "SUCCESS_RUN_APPLIED", "completed", ["write-receipt", "provider-write"]]);
	expect(calls(machine).filter((call) => call.tool === writeTool)).toEqual([{ tool: writeTool, args: expectedArgs }]);
	const receipt = applied.data?.result as { runId: string; previewId: string; provider: string; status: string; effects: { kind: string; id: string }[] };
	expect([receipt.previewId, receipt.provider, receipt.status, receipt.effects]).toEqual([previewId, "rest", "completed", [effect]]);
	const durable = JSON.parse(readFileSync(path.join(machine.state, "connectors", "atlassian", "example", "receipts", `${receipt.runId}.json`), "utf8")) as typeof receipt;
	expect([durable.previewId, durable.provider, durable.status, durable.effects]).toEqual([previewId, "rest", "completed", [effect]]);
	for (const text of [previewRun.stdout, previewRun.stderr, applyRun.stdout, applyRun.stderr, machine.sweepText()]) {
		expect(text).not.toContain(SERVICE_TOKEN);
		expect(text).not.toContain(PROVIDER_TOKEN);
	}
	expect(machine.lines("hostile-recorders.jsonl")).toEqual([]);
	expect(machine.lines("hostile-mcporter.jsonl")).toEqual([]);
}

describe("packaged Atlassian REST write routing with a substituted REST Provider", () => {
	test("issue.comment.media completes only after a read-back renders both attached images", async () => {
		prepare({
			jira_rest_issue_attachments: { before: attachmentReply() },
			jira_rest_comments_list: { before: commentsReply(), after: commentsReply({ id: "10077", body: BODY, renderedBody: RENDERED, updated: "u1" }) },
			jira_rest_comment_add: { write: ok({ id: "10077", body: BODY, renderedBody: RENDERED }) },
		});
		await prove("issue.comment.media", mediaInput, "jira_rest_comment_add", { issue_key: "PROJ-1", body: BODY }, { kind: "jira-comment", id: "10077" });
	});

	test("issue.comment.media.update edits the principal's comment and completes after a newer rendered read-back", async () => {
		const own = { id: "454771", author: { accountId: PRINCIPAL }, updated: "u1", body: "old text", renderedBody: "<p>old text</p>" };
		prepare({
			jira_rest_issue_attachments: { before: attachmentReply() },
			jira_rest_myself: { before: ok({ accountId: PRINCIPAL, emailAddress: "service@example.invalid" }) },
			jira_rest_comment_get: { before: ok(own), after: ok({ ...own, updated: "u2", body: BODY, renderedBody: RENDERED }) },
			jira_rest_comment_edit: { write: ok({ ...own, updated: "u2", body: BODY, renderedBody: RENDERED }) },
		});
		await prove("issue.comment.media.update", { ...mediaInput, commentId: "454771" }, "jira_rest_comment_edit", { issue_key: "PROJ-1", comment_id: "454771", body: BODY }, { kind: "jira-comment", id: "454771" });
	});

	test("issue.attachment.delete completes only after read-back omits the owned and unreferenced attachment", async () => {
		prepare({
			jira_rest_issue_attachment_context: { before: ok({ key: "PROJ-1", fields: { updated: "t1", attachment: attachments, description: "Plain description." }, renderedFields: { description: "<p>Plain description.</p>" } }) },
			jira_rest_issue_attachments: { before: attachmentReply(), after: attachmentReply([attachments[1]], "t2") },
			jira_rest_myself: { before: ok({ accountId: PRINCIPAL, emailAddress: "service@example.invalid" }) },
			jira_rest_comments_list: { before: commentsReply({ id: "900", body: "Looks fine.", renderedBody: "<p>Looks fine.</p>" }) },
			jira_rest_attachment_delete: { write: ok(null, 204) },
		});
		await prove("issue.attachment.delete", { issueKey: "PROJ-1", attachmentId: "202456" }, "jira_rest_attachment_delete", { issue_key: "PROJ-1", attachment_id: "202456" }, { kind: "jira-attachment", id: "202456" });
	});
});
