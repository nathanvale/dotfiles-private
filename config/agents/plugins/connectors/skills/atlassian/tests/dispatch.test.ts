// Atlassian dispatcher: nineteen semantic operations over two static product
// routes on the one Community Provider, every read and write behind live
// schema confirmation, writes behind the durable preview and apply journal,
// and the operator path. Policy is proved in-process through the typed
// invocationFor and dispatch seam with an in-memory transport and a real
// journal in a temp state root; the public route is
// proved through the packaged front door in packaged.test.ts, and one
// process row here proves the module is no longer an entry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionCapabilities } from "../../../bin/adapters/contract.ts";
import { OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { type Dispatched, dispatch, invocationFor, type Request } from "../scripts/atlassian-dispatch.ts";
import { ALLOWED_TOOLS, OPERATION_SPECS, type OperationId, type OperationSpec, productFor, PROVIDER, type ProviderName, registryToolVocabulary, REST_SERVER, SERVERS, serverFor } from "../scripts/dispatch/contract.ts";
import { type Dependencies, readInput, type SchemaTool, type Transport, type TransportResult } from "../scripts/dispatch/engine.ts";
import { openJournal } from "../scripts/dispatch/journal.ts";
import { writeInput } from "../scripts/dispatch/writes.ts";
import { stageFile } from "../scripts/outbox.ts";
import type { ProviderFailureCause } from "../scripts/dispatch/translate.ts";
import { CustodyFixture, PROVIDER_TOKEN } from "./fixtures/custody-fixture.ts";
import { substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const ORIGIN = "https://example.atlassian.net";
const CJ = "atlassian-community-jira";
const CC = "atlassian-community-confluence";
// The owned REST route of the wiki-comment exception (ADR 0001 amendment).
const RJ = "atlassian-rest-jira";
const PRINCIPAL = "service@example.invalid";
const ITEM_VERSION = "onepassword-item-version:1";
// The binding's configured 1Password item ID (a 26-character ID).
const ITEM_ID = "jiraitem0000000000000000aa";
const NOW = 1_700_000_000_000;
// The retired Provider name as persisted records still carry it. It is a
// string here, not a type, because no active code may name it.
const RETIRED = "official";
// Independent oracle: the accepted fixed repair text per cause, restated from
// the dispatch contract. Never import the engine's table here: an expected
// value read from the code under test cannot catch a wrong repair text.
const REPAIR = {
	"refused-auth": "the provider refused authentication or permission; verify the credential type, scopes, and product permissions with their owner",
	"not-found": "the target object was not found or is not visible to this principal",
	"failed-transport": "the provider did not answer; inspect provider status before retrying the read",
	"failed-unknown": "the provider failed for an unclassified reason; inspect provider diagnostics",
	"capability-unavailable": "the live schema does not expose the operation as expected; inspect the provider schema before retrying",
	"refused-precondition": "a provider precondition failed before any request; run the provider readiness checks",
	"refused-state": "the private journal state is corrupt or its meta-lock is held; inspect the state directory before any write",
	"refused-preview": "the preview is unknown, consumed, expired, or no longer matches the input, provider arguments, or target revision; preview again",
} as const;

// Test-owned digest oracle. It deliberately does not import the journal
// serializer, so persisted journal representation changes fail this suite.
function testCanonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(testCanonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${testCanonical(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const testDigest = (value: unknown): string => new Bun.CryptoHasher("sha256").update(testCanonical(value)).digest("hex");
const EXPECTED_OPERATIONS = ["issue.get", "issue.search", "issue.transitions", "issue.create", "issue.update", "issue.comment", "issue.comment.update", "issue.comment.media", "issue.comment.media.update", "issue.attach", "issue.attachment.delete", "issue.transition", "issue.assign", "issue.delete", "page.get", "page.search", "page.create", "page.update", "page.comment", "page.attach", "page.attachment.delete", "page.delete"] as const;

// Independent oracle: the exact Community tool and product per operation,
// from the v0.23.1 Community reference.
const EXPECTED_TOOLS: Record<string, [string, "read" | "write", "jira" | "confluence"]> = {
	"issue.get": ["jira_get_issue", "read", "jira"],
	"issue.search": ["jira_search", "read", "jira"],
	"issue.transitions": ["jira_get_transitions", "read", "jira"],
	"issue.create": ["jira_create_issue", "write", "jira"],
	"issue.update": ["jira_update_issue", "write", "jira"],
	"issue.comment": ["jira_add_comment", "write", "jira"],
	"issue.comment.update": ["jira_edit_comment", "write", "jira"],
	"issue.comment.media": ["jira_rest_comment_add", "write", "jira"],
	"issue.comment.media.update": ["jira_rest_comment_edit", "write", "jira"],
	"issue.attach": ["jira_update_issue", "write", "jira"],
	"issue.attachment.delete": ["jira_rest_attachment_delete", "write", "jira"],
	"issue.transition": ["jira_transition_issue", "write", "jira"],
	"issue.assign": ["jira_assign_issue", "write", "jira"],
	"issue.delete": ["jira_delete_issue", "write", "jira"],
	"page.get": ["confluence_get_page", "read", "confluence"],
	"page.search": ["confluence_search", "read", "confluence"],
	"page.create": ["confluence_create_page", "write", "confluence"],
	"page.update": ["confluence_update_page", "write", "confluence"],
	"page.comment": ["confluence_add_comment", "write", "confluence"],
	"page.attach": ["confluence_upload_attachment", "write", "confluence"],
	"page.attachment.delete": ["confluence_delete_attachment", "write", "confluence"],
	"page.delete": ["confluence_delete_page", "write", "confluence"],
};
// Exactly the tools the live 2026-09-23 tools/list exposed under these names
// (mcp-atlassian 0.23.1 has no confluence_get_space and no comment deletion).
const EXPECTED_ALLOW_LISTS = {
	[CJ]: ["jira_get_issue", "jira_search", "jira_get_transitions", "jira_create_issue", "jira_update_issue", "jira_add_comment", "jira_edit_comment", "jira_transition_issue", "jira_assign_issue", "jira_delete_issue"],
	[CC]: ["confluence_get_page", "confluence_search", "confluence_get_comments", "confluence_get_attachments", "confluence_create_page", "confluence_update_page", "confluence_add_comment", "confluence_upload_attachment", "confluence_delete_attachment", "confluence_delete_page"],
};

const tool = (name: string, required: string[], optional: string[] = []): SchemaTool => ({
	name,
	inputSchema: { required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, {}])) },
});
const SCHEMAS: Record<string, SchemaTool[]> = {
	[CJ]: [
		tool("jira_get_issue", ["issue_key"], ["fields", "comment_limit"]),
		tool("jira_search", ["jql"], ["limit", "fields"]),
		tool("jira_create_issue", ["project_key", "summary", "issue_type"], ["description", "assignee", "components", "additional_fields"]),
		tool("jira_update_issue", ["issue_key", "fields"], ["additional_fields", "components", "attachments", "return_fields"]),
		tool("jira_add_comment", ["issue_key", "body"], ["visibility", "public"]),
		tool("jira_edit_comment", ["issue_key", "comment_id", "body"], ["visibility"]),
		tool("jira_get_transitions", ["issue_key"]),
		tool("jira_transition_issue", ["issue_key", "transition_id"], ["fields", "comment"]),
		tool("jira_assign_issue", ["issue_key"], ["assignee"]),
		tool("jira_delete_issue", ["issue_key"]),
	],
	[RJ]: [tool("jira_rest_myself", []), tool("jira_rest_issue_attachments", ["issue_key"]), tool("jira_rest_comments_list", ["issue_key"]), tool("jira_rest_comment_get", ["issue_key", "comment_id"]), tool("jira_rest_comment_add", ["issue_key", "body"]), tool("jira_rest_comment_edit", ["issue_key", "comment_id", "body"]), tool("jira_rest_attachment_head", ["attachment_id"]), tool("jira_rest_issue_attachment_context", ["issue_key"]), tool("jira_rest_attachment_delete", ["issue_key", "attachment_id"])],
	[CC]: [
		tool("confluence_get_page", [], ["page_id", "title", "space_key", "include_metadata", "convert_to_markdown"]),
		tool("confluence_search", ["query"], ["limit", "spaces_filter"]),
		tool("confluence_get_comments", ["page_id"]),
		tool("confluence_get_attachments", ["content_id"], ["start", "limit", "filename", "media_type"]),
		tool("confluence_create_page", ["space_key", "title"], ["content", "parent_id", "content_format"]),
		tool("confluence_update_page", ["page_id", "title"], ["content", "version_comment", "content_format"]),
		tool("confluence_add_comment", ["page_id", "body"]),
		tool("confluence_upload_attachment", ["content_id"], ["file_path", "file_content", "filename", "comment"]),
		tool("confluence_delete_attachment", ["attachment_id"]),
		tool("confluence_delete_page", ["page_id"]),
	],
};

interface Call {
	server: string;
	tool: string;
	args: Record<string, unknown>;
}

function fakeTransport(results: Record<string, TransportResult | ((args: Record<string, unknown>) => TransportResult)> = {}, schemas: Record<string, SchemaTool[] | TransportResult> = {}, observe?: (call: Call) => void) {
	const calls: Call[] = [];
	const bindings: unknown[] = [];
	const transport: Transport = {
		async listTools(binding, server) {
			bindings.push(binding);
			const schema = schemas[server] ?? SCHEMAS[server] ?? [];
			return Array.isArray(schema) ? { ok: true, data: schema } : schema;
		},
		async call(binding, server, name, args) {
			bindings.push(binding);
			const call = { server, tool: name, args };
			calls.push(call);
			observe?.(call);
			const canned = results[`${server}.${name}`];
			if (typeof canned === "function") return canned(args);
			if (canned) return canned;
			if (name === "jira_get_issue") return { ok: true, data: { key: args.issue_key, fields: { comment: { comments: [] } } } };
			return { ok: true, data: { fake: `${server}.${name}` } };
		},
	};
	return { transport, calls, bindings };
}

let stateRoot: string;
let tenants: string[];
beforeEach(() => {
	stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
	tenants = [];
});
afterEach(() => rmSync(stateRoot, { recursive: true, force: true }));

const seen: { tenant: string; product: string }[] = [];
function deps(overrides: Partial<Dependencies> = {}): Dependencies {
	return {
		transport: fakeTransport().transport,
		bindCredential: async (tenant, product) => {
			seen.push({ tenant, product });
			return { ok: true, binding: { principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN, item: ITEM_ID } };
		},
		journal: (tenant) => openJournal(tenant, { stateRoot, now: () => NOW }),
		stage: (_tenant, file) => ({ ok: true, relative: `staged/${path.basename(file)}` }),
		now: () => NOW,
		...overrides,
	};
}

// Typed requests through the dispatcher's own validation, then one dispatch.
// A request the validator refuses never builds dependencies, as in production.
const TENANT = "example";
type Step = Request extends infer R ? (R extends { tenant: string } ? Omit<R, "tenant"> : never) : never;
async function send(step: Step, dependencies: Dependencies, tenant = TENANT): Promise<Dispatched> {
	const validated = invocationFor({ tenant, ...step } as Request);
	if (!validated.ok) throw new Error(`the typed request was refused: ${validated.cause}`);
	tenants.push(validated.invocation.tenant);
	return dispatch(validated.invocation, dependencies);
}
const specOf = (operation: string): OperationSpec => OPERATION_SPECS[operation as OperationId];
const readOp = (operation: string, input: unknown, dependencies: Dependencies, tenant?: string) => send({ kind: "read", spec: specOf(operation), input }, dependencies, tenant);
const previewOp = (operation: string, input: unknown, dependencies: Dependencies) => send({ kind: "preview", spec: specOf(operation), input }, dependencies);
const applyOp = (operation: string, input: unknown, previewId: string, dependencies: Dependencies) => send({ kind: "apply", spec: specOf(operation), input, previewId }, dependencies);
const listReceipts = (dependencies: Dependencies) => send({ kind: "receipts" }, dependencies);
const showReceipt = (runId: string, dependencies: Dependencies) => send({ kind: "receipt", runId }, dependencies);
const unlockRun = (runId: string, dependencies: Dependencies) => send({ kind: "unlock", runId }, dependencies);
const adjudicateRun = (runId: string, input: unknown, dependencies: Dependencies) => send({ kind: "adjudicate", runId, input }, dependencies);
const stateDir = (name: string) => path.join(stateRoot, "connectors", "atlassian", "example", name);
const receiptsDir = () => stateDir("receipts");
const previewsDir = () => stateDir("previews");
const readJsonDir = (directory: string) => (existsSync(directory) ? readdirSync(directory) : []).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>);
// The in-memory transport emits translated failures, exactly as the runtime
// adapter does after translate.ts; raw provider text never enters policy.
const failure = (cause: ProviderFailureCause, hint: string | null = null): TransportResult => ({ ok: false, cause, hint });
// The effects a settled outcome names, as kind:id; none when it names none.
const effectIds = (dispatched: Dispatched): string[] => ((dispatched.outcome.data as { effects?: { kind: string; id: string }[] } | null)?.effects ?? []).map((effect) => `${effect.kind}:${effect.id}`);
// The object an open, unknown receipt blocks.
const blockedObject = (dispatched: Dispatched): unknown => (dispatched.outcome.data as { objectIdentity?: unknown } | null)?.objectIdentity;
// What the typed validator says of a request: its refusal cause, or accepted.
const refusal = (request: Request) => {
	const validated = invocationFor(request);
	return validated.ok ? "accepted" : validated.cause;
};
const previewData = (dispatched: Dispatched) => dispatched.outcome.data as { previewId: string; provider: string; objectIdentity: string; revision: string | null; baseline: { effectIds: string[]; commentIds: string[]; revision: string | null }; arguments: Record<string, unknown>; tool: string; server: string };

describe("operation contract and routes", () => {
	test("maps every operation to its exact Community tool, kind, and product", () => {
		expect(Object.keys(OPERATION_SPECS)).toEqual([...EXPECTED_OPERATIONS]);
		for (const [id, [community, kind, product]] of Object.entries(EXPECTED_TOOLS)) {
			const spec = OPERATION_SPECS[id as keyof typeof OPERATION_SPECS];
			expect([id, spec.tool, spec.kind, spec.product]).toEqual([id, community, kind, product]);
		}
		expect(PROVIDER).toBe("community");
	});

	test("only the two wiki-comment operations and the attachment delete name the rest Provider on the owned REST server; every other operation is Community on its product route", () => {
		expect(REST_SERVER).toBe(RJ);
		const routes = Object.values(OPERATION_SPECS).map((spec) => [spec.id, spec.provider, spec.server]);
		expect(routes.filter(([, provider]) => provider === "rest")).toEqual([["issue.comment.media", "rest", RJ], ["issue.comment.media.update", "rest", RJ], ["issue.attachment.delete", "rest", RJ]]);
		expect(routes.filter(([, provider]) => provider !== "rest").every(([id, , server]) => server === serverFor(EXPECTED_TOOLS[id as string]?.[2] as "jira" | "confluence"))).toBe(true);
	});

	test("two static routes, one per product, with exact allow-lists and no broad dispatchers", () => {
		expect([...SERVERS]).toEqual([CJ, CC]);
		expect([serverFor("jira"), serverFor("confluence")]).toEqual([CJ, CC]);
		expect([productFor(CJ), productFor(CC), productFor("atlassian-official-jira"), productFor("atlassian-community-bitbucket")]).toEqual(["jira", "confluence", null, null]);
		expect(ALLOWED_TOOLS).toEqual(EXPECTED_ALLOW_LISTS);
		for (const tools of Object.values(ALLOWED_TOOLS)) for (const broad of ["executeWrite", "executeRead", "executeDestructive", "discover"]) expect(tools).not.toContain(broad);
	});

	test("the registry and its derived runtime vocabulary have exact independent allow-lists and one Community command per route", () => {
		const registry = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8")) as { imports: unknown[]; mcpServers: Record<string, { allowedTools: string[]; env: Record<string, string>; command: string; args: string[] }> };
		expect(registry.imports).toEqual([]);
		expect(Object.fromEntries(Object.entries(registry.mcpServers).map(([server, entry]) => [server, entry.allowedTools]))).toEqual(EXPECTED_ALLOW_LISTS);
		expect(ALLOWED_TOOLS).toEqual(EXPECTED_ALLOW_LISTS);
		for (const server of SERVERS) {
			const entry = registry.mcpServers[server];
			expect([server, entry?.env.ATLASSIAN_PRODUCT ?? null]).toEqual([server, productFor(server)]);
			expect([server, entry?.env.ATLASSIAN_TENANT]).toEqual([server, "${ATLASSIAN_TENANT}"]);
			// The compiled front door's internal Provider role, never a .ts entry.
			expect([server, entry?.command, entry?.args]).toEqual([server, "../../../bin/connectors", ["__internal", "atlassian", "provider"]]);
		}
		const route = JSON.parse(readFileSync(path.join(SKILL, "config", "route.json"), "utf8")) as { defaultProvider: string; dispatcherOwned: boolean };
		expect([route.defaultProvider, route.dispatcherOwned]).toEqual([CJ, true]);
	});

	test("registry vocabulary parsing fails closed for a broad dispatcher, an incomplete server set, or a re-added retired route", () => {
		const registry = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8")) as { mcpServers: Record<string, { allowedTools: string[] }> };
		const broad = structuredClone(registry);
		broad.mcpServers[CJ]!.allowedTools = ["executeRead"];
		expect(() => registryToolVocabulary(broad)).toThrow(/registry-invalid/);
		const incomplete = structuredClone(registry);
		delete incomplete.mcpServers[CC];
		expect(() => registryToolVocabulary(incomplete)).toThrow(/registry-invalid/);
		const retired = structuredClone(registry);
		retired.mcpServers["atlassian-official-jira"] = { allowedTools: ["getJiraIssue"] };
		expect(() => registryToolVocabulary(retired)).toThrow(/registry-invalid/);
	});
});

describe("typed invocation validation", () => {
	const issueGet = { kind: "read", spec: OPERATION_SPECS["issue.get"], input: { issueKey: "PROJ-1" } } as const;

	test("a malformed tenant or identifier is a usage refusal, whatever the input holds", () => {
		for (const tenant of ["", "Example", "example team", "a/b", "../x", "-example"]) expect([tenant, refusal({ tenant, ...issueGet })]).toEqual([tenant, "usage-invalid"]);
		const comment = { spec: OPERATION_SPECS["issue.comment"], input: { issueKey: "PROJ-1", body: "x" } };
		for (const previewId of ["", "-lead", "has space", "x".repeat(129)]) expect([previewId, refusal({ tenant: TENANT, kind: "apply", previewId, ...comment })]).toEqual([previewId, "usage-invalid"]);
		for (const runId of ["", "-lead", "has space", "../receipt"]) {
			expect([runId, refusal({ tenant: TENANT, kind: "receipt", runId }), refusal({ tenant: TENANT, kind: "unlock", runId }), refusal({ tenant: TENANT, kind: "adjudicate", runId, input: {} })]).toEqual([runId, "usage-invalid", "usage-invalid", "usage-invalid"]);
		}
		// Identifiers are checked before input, so a bad id wins over a bad input.
		expect(refusal({ tenant: "Example", ...issueGet, input: { issueKey: "" } })).toBe("usage-invalid");
	});

	test("an input the operation's contract refuses is a schema refusal; well-formed requests are accepted", () => {
		for (const input of [{ issueKey: "" }, { issueKey: "PROJ-1", issue_key: "OTHER-1" }, {}, [], null, "PROJ-1"]) expect([JSON.stringify(input), refusal({ tenant: TENANT, ...issueGet, input })]).toEqual([JSON.stringify(input), "input-invalid"]);
		expect(refusal({ tenant: TENANT, ...issueGet, kind: "read" })).toBe("accepted");
		expect(refusal({ tenant: TENANT, kind: "receipts" })).toBe("accepted");
		expect(refusal({ tenant: TENANT, kind: "receipt", runId: "run-1.a_b" })).toBe("accepted");
	});
});

describe("tenant identity", () => {
	test("the validated tenant is the one the credential binding and the journal receive", async () => {
		seen.length = 0;
		const { transport } = fakeTransport();
		await readOp("issue.get", { issueKey: "PROJ-1" }, deps({ transport }), "example-team");
		expect(tenants).toEqual(["example-team"]);
		expect(seen).toEqual([{ tenant: "example-team", product: "jira" }]);
	});
});

describe("Community reads", () => {
	test("issue.get binds the Jira product credential, confirms the live schema, then calls the exact tool on the Jira route", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { summary: "hello" } } } });
		seen.length = 0;
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
		expect([dispatched.outcome.cause]).toEqual(["success"]);
		expect(dispatched.outcome.data).toEqual({ key: "PROJ-1", fields: { summary: "hello" } });
		expect(calls).toEqual([{ server: CJ, tool: "jira_get_issue", args: { issue_key: "PROJ-1" } }]);
		expect(dispatched.provenance).toEqual([{ provider: CJ, tool: "jira_get_issue", status: "success" }]);
		expect([dispatched.outcome.transactionState]).toEqual(["unchanged"]);
		expect(seen).toEqual([{ tenant: "example", product: "jira" }]);
	});

	test("one semantic operation binds one immutable credential context through the schema list and every call", async () => {
		const { transport, bindings } = fakeTransport();
		let binds = 0;
		const binding = Object.freeze({ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN, item: ITEM_ID });
		await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport, bindCredential: async () => ({ ok: true, binding: { ...binding, itemVersion: `${ITEM_VERSION}:${++binds}` } }) }));
		expect(binds).toBe(1);
		expect(bindings).toHaveLength(2);
		expect(bindings.every((entry) => entry === bindings[0])).toBe(true);
		expect(bindings[0]).toEqual({ ...binding, itemVersion: `${ITEM_VERSION}:1` });
	});

	test("issue.search, page.get, and page.search shape their arguments per Community tool on the product route", async () => {
		const { transport, calls } = fakeTransport();
		seen.length = 0;
		await readOp("issue.search", {"jql":"project = PROJ","maxResults":5,"fields":["summary"]}, deps({ transport }));
		await readOp("page.get", {"pageId":"123"}, deps({ transport }));
		await readOp("page.search", {"cql":"type=page","maxResults":3}, deps({ transport }));
		await readOp("issue.transitions", {"issueKey":"PROJ-1"}, deps({ transport }));
		expect(calls.map((call) => [call.server, call.tool, call.args])).toEqual([
			[CJ, "jira_search", { jql: "project = PROJ", limit: 5, fields: "summary" }],
			[CC, "confluence_get_page", { page_id: "123" }],
			[CC, "confluence_search", { query: "type=page", limit: 3 }],
			[CJ, "jira_get_transitions", { issue_key: "PROJ-1" }],
		]);
		expect(seen.map((entry) => entry.product)).toEqual(["jira", "confluence", "confluence", "jira"]);
	});

	test("product swap is impossible: a Jira operation never touches the Confluence route, even when only that route has the tool", async () => {
		const { transport, calls } = fakeTransport({}, { [CJ]: [], [CC]: [tool("jira_get_issue", ["issue_key"])] });
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
		expect([dispatched.outcome.cause]).toEqual(["capability-unavailable"]);
		expect(calls).toEqual([]);
	});
});

describe("refusals and failures are final: no second Provider, no retry", () => {
	test("an unresolved site origin refuses before any provider call", async () => {
		const { transport, calls } = fakeTransport();
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport, bindCredential: async () => ({ ok: false, cause: "site-unresolved", detail: "the tenant's credential item must expose a valid site_url field" }) }));
		expect([dispatched.outcome.cause]).toEqual(["site-unresolved"]);
		expect(dispatched.outcome.detail).toBe("the tenant's credential item must expose a valid site_url field");
		expect(calls).toEqual([]);
	});

	test("credential custody failures preserve a precondition refusal instead of claiming the site is unresolved", async () => {
		const { transport, calls } = fakeTransport();
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport, bindCredential: async () => ({ ok: false, cause: "refused-precondition", detail: "a provider precondition failed before any request; run the provider readiness checks" }) }));
		expect([dispatched.outcome.cause, dispatched.outcome.detail]).toEqual(["refused-precondition", "a provider precondition failed before any request; run the provider readiness checks"]);
		expect(calls).toEqual([]);
	});

	test("auth, not-found, and transport failures end the operation after exactly one attempt on the product route", async () => {
		for (const [cause, outcome] of [
			["refused-auth", "refused"],
			["not-found", "failed"],
			["failed-transport", "failed"],
			["failed-unknown", "failed"],
		] as const) {
			const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: failure(cause) });
			const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
			expect([cause, dispatched.outcome.cause]).toEqual([cause, cause]);
			expect([cause, dispatched.outcome.detail]).toEqual([cause, REPAIR[cause]]);
			expect([cause, calls.map((call) => [call.server, call.tool])]).toEqual([cause, [[CJ, "jira_get_issue"]]]);
			expect(dispatched.provenance).toEqual([{ provider: CJ, tool: "jira_get_issue", status: cause }]);
		}
	});

	test("a failed schema list is reported as the list step and makes no call", async () => {
		const { transport, calls } = fakeTransport({}, { [CJ]: failure("failed-transport") });
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
		expect([dispatched.outcome.cause]).toEqual(["failed-transport"]);
		expect(dispatched.provenance).toEqual([{ provider: CJ, tool: "list", status: "failed-transport" }]);
		expect(calls).toEqual([]);
	});

	test("schema mismatch: the live schema lacks the tool or a required argument", async () => {
		const missingTool = fakeTransport({}, { [CJ]: [tool("jira_search", ["jql"])] });
		const absent = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport: missingTool.transport }));
		expect([absent.outcome.cause]).toEqual(["capability-unavailable"]);
		expect(missingTool.calls).toEqual([]);
		const renamed = fakeTransport({}, { [CJ]: [tool("jira_get_issue", ["issueKey"])] });
		const mismatch = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport: renamed.transport }));
		expect([mismatch.outcome.cause]).toEqual(["capability-unavailable"]);
		// Fixed text only; never a schema name and never a fallback verdict.
		expect(mismatch.outcome.detail).toBe(REPAIR["capability-unavailable"]);
		expect(renamed.calls).toEqual([]);
	});

	test("a hostile live schema cannot smuggle text into the outcome through required or property names", async () => {
		const hostile = ["customer SSN 123-45-6789", `token ${OP_TOKEN_SENTINEL}`, "op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential"];
		for (const name of hostile) {
			const { transport, calls } = fakeTransport({}, { [CJ]: [{ name: "jira_get_issue", inputSchema: { required: ["issue_key", name], properties: { issue_key: {}, [name]: {} } } }] });
			const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
			expect([dispatched.outcome.cause]).toEqual(["capability-unavailable"]);
			expect(JSON.stringify(dispatched)).not.toContain(name);
			expect(calls).toEqual([]);
		}
	});

	test("a Provider precondition carries its fixed hint after the fixed repair text", async () => {
		const translated = failure("refused-precondition", "add a username field to the tenant's product credential item");
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: translated });
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
		expect([dispatched.outcome.cause]).toEqual(["refused-precondition"]);
		expect(dispatched.outcome.detail).toBe(`${REPAIR["refused-precondition"]}; add a username field to the tenant's product credential item`);
		expect(calls).toHaveLength(1);
	});

	test("a live schema without a real object schema, or with a malformed required list, fails closed without a call", async () => {
		const cases: [string, SchemaTool[]][] = [
			["no inputSchema", [{ name: "jira_get_issue" }]],
			["required is a string", [{ name: "jira_get_issue", inputSchema: { required: "issue_key" as unknown as string[], properties: { issue_key: {} } } }]],
			["properties is not an object", [{ name: "jira_get_issue", inputSchema: { required: [], properties: "issue_key" as unknown as Record<string, unknown> } }]],
			["listing is not a tool array", []],
		];
		for (const [label, schema] of cases) {
			const { transport, calls } = fakeTransport({}, { [CJ]: schema });
			const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
			expect([label, dispatched.outcome.cause]).toEqual([label, "capability-unavailable"]);
			expect([label, calls]).toEqual([label, []]);
		}
	});

	test("invalid input is a schema refusal before any provider call", async () => {
		const { transport, calls } = fakeTransport();
		const read = (input: unknown): Request => ({ tenant: TENANT, kind: "read", spec: OPERATION_SPECS["issue.get"], input });
		expect([refusal(read({ issueKey: "" })), refusal(read({ issueKey: "PROJ-1", issue_key: "OTHER-1" }))]).toEqual(["input-invalid", "input-invalid"]);
		// The contract names the offending key in its reason; the adapter never forwards it.
		expect(readInput("issue.get", { issueKey: "PROJ-1", issue_key: "OTHER-1" })).toEqual({ ok: false, reason: "unknown input key issue_key" });
		expect([tenants, calls]).toEqual([[], []]);
	});
});

describe("provider text never reaches the outcome", () => {
	const PRIVATE = ["fixture-secret-value", "customer SSN 123-45-6789", "PROJ-99 confidential merger", OP_TOKEN_SENTINEL, "op://", "Bearer", "Basic "];
	const leak = `token=fixture-secret-value Authorization: Basic ${OP_TOKEN_SENTINEL} Bearer x op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential; issue PROJ-99 confidential merger; customer SSN 123-45-6789; connect ETIMEDOUT`;

	test("translated failures carry fixed repair text and provenance; a hint is fixed text, never a message", async () => {
		const precondition = failure("refused-precondition", "add a username field to the tenant's product credential item");
		for (const [translated, cause, detail] of [
			[failure("failed-transport"), "failed-transport", "the provider did not answer; inspect provider status before retrying the read"],
			[failure("refused-auth"), "refused-auth", "the provider refused authentication or permission; verify the credential type, scopes, and product permissions with their owner"],
			[precondition, "refused-precondition", "a provider precondition failed before any request; run the provider readiness checks; add a username field to the tenant's product credential item"],
		] as const) {
			const { transport } = fakeTransport({ [`${CJ}.jira_get_issue`]: translated });
			const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport }));
			expect([dispatched.outcome.cause, dispatched.outcome.detail]).toEqual([cause, detail]);
			expect(dispatched.provenance.at(-1)).toEqual({ provider: CJ, tool: "jira_get_issue", status: cause });
		}
	});

	test("an unexpected transport throw becomes a fixed failed-unknown outcome", async () => {
		const throwing: Transport = {
			async listTools() {
				return { ok: true, data: SCHEMAS[CJ] ?? [] };
			},
			async call() {
				throw new Error(`boom ${leak}`);
			},
		};
		const dispatched = await readOp("issue.get", {"issueKey":"PROJ-1"}, deps({ transport: throwing }));
		expect([dispatched.outcome.cause]).toEqual(["failed-unknown"]);
		const serialized = JSON.stringify(dispatched);
		for (const fragment of ["boom", ...PRIVATE]) expect(serialized).not.toContain(fragment);
		expect(dispatched.provenance.map((entry) => entry.status)).toEqual(["failed-unknown"]);
	});
});

describe("journaled writes", () => {
	const COMMENT = { issueKey: "PROJ-1", body: "Quarterly numbers are down; see the attached sheet" };
	const commentReply = { ok: true as const, data: { id: "10001", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: COMMENT.body }] }] } } };
	const BASELINE_READ = { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 };

	test("preview records a durable Community preview bound to the exact provider arguments and touches no write tool", async () => {
		const { transport, calls } = fakeTransport();
		const dispatched = await previewOp("issue.comment", COMMENT, deps({ transport }));
		expect(dispatched.outcome.cause).toBe("success");
		const data = previewData(dispatched);
		expect([data.provider, data.server, data.tool, data.objectIdentity, data.revision]).toEqual(["community", CJ, "jira_add_comment", "issue:PROJ-1", null]);
		expect(data.arguments).toEqual({ issue_key: "PROJ-1", body: COMMENT.body });
		expect(calls).toEqual([{ server: CJ, tool: "jira_get_issue", args: BASELINE_READ }]);
		const previews = readJsonDir(previewsDir());
		expect(previews.map((entry) => [entry.previewId, entry.provider, entry.status, entry.argsDigest])).toEqual([[data.previewId, "community", "open", testDigest(data.arguments)]]);
		expect(JSON.stringify(previews)).not.toContain("Quarterly");
	});

	test("apply marks sending on disk before the request, sends exactly the journal-bound arguments, and completes with the provider's effect", async () => {
		const sendStates: string[] = [];
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: commentReply }, {}, (call) => {
			if (call.tool === "jira_add_comment") sendStates.push(...readJsonDir(receiptsDir()).map((entry) => `${entry.status}:${entry.send}`));
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", COMMENT, dependencies));
		const dispatched = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		expect([dispatched.outcome.transactionState]).toEqual(["completed"]);
		expect(effectIds(dispatched)).toEqual(["jira-comment:10001"]);
		expect(sendStates).toEqual(["intent:possible"]);
		const sent = calls.filter((call) => call.tool === "jira_add_comment");
		expect(sent).toHaveLength(1);
		// The outbound object is the receipt-bound one: its digest is the preview's argsDigest.
		const stored = readJsonDir(previewsDir())[0];
		expect(testDigest(sent[0]?.args)).toBe(stored?.argsDigest as string);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.provider, entry.status, entry.send, entry.effects])).toEqual([["community", "completed", "possible", [{ kind: "jira-comment", id: "10001" }]]]);
		// The same preview cannot be applied twice.
		const again = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		expect([again.outcome.cause, again.outcome.detail?.endsWith("preview-consumed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("changed input or a foreign preview id refuse the apply before any send", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: commentReply });
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", COMMENT, dependencies));
		const changed = await applyOp("issue.comment", { ...COMMENT, body: "edited" }, preview.previewId, dependencies);
		expect([changed.outcome.cause, changed.outcome.detail?.endsWith("preview-input-mismatch")]).toEqual(["refused-preview", true]);
		const unknown = await applyOp("issue.comment", COMMENT, "nope", dependencies);
		expect([unknown.outcome.cause, unknown.outcome.detail?.endsWith("preview-unknown")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
	});

	test("a lost reply after the send mark is an unknown outcome that blocks the object; read-back proof through adjudicate releases it", async () => {
		const lost = failure("failed-transport");
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: lost, [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "t1", comment: { comments: [{ id: "777", body: "unrelated" }] } } } } });
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", COMMENT, dependencies));
		const dispatched = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		expect([dispatched.outcome.cause, dispatched.outcome.transactionState]).toEqual(["outcome-unknown", "unknown"]);
		expect([effectIds(dispatched), blockedObject(dispatched)]).toEqual([[], "issue:PROJ-1"]);
		// Preview and apply both bind the matching-comment baseline before the
		// possible send. The immediate read-back found nothing, which proves
		// nothing after a possible send, and the dispatcher never retries.
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_add_comment", "jira_get_issue"]);
		const runId = (dispatched.outcome.data as { runId: string }).runId;
		const receipts = await listReceipts(dependencies);
		expect((receipts.outcome.data as { open: { runId: string; status: string; send: string }[] }).open.map((entry) => [entry.runId, entry.status, entry.send])).toEqual([[runId, "unknown", "possible"]]);
		// Any write on the object is blocked while the receipt is open.
		const blockedInput = { issueKey: "PROJ-1", body: "a separate comment" };
		const blockedPreview = previewData(await previewOp("issue.comment", blockedInput, dependencies));
		const blocked = await applyOp("issue.comment", blockedInput, blockedPreview.previewId, dependencies);
		expect([blocked.outcome.cause, blocked.outcome.detail?.endsWith("write-blocked-open-receipt")]).toEqual(["refused-write-blocked", true]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
		// Adjudication with the wrong input is refused; with read-back still absent the receipt stays open.
		const wrong = await adjudicateRun(runId, {"issueKey":"PROJ-1","body":"other"}, dependencies);
		expect(wrong.outcome.cause).toBe("input-invalid");
		const absent = await adjudicateRun(runId, COMMENT, dependencies);
		expect([absent.outcome.cause, absent.outcome.detail?.endsWith("evidence-insufficient")]).toEqual(["refused-evidence", true]);
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["unknown"]);
		// Read-back now finds the comment: the receipt completes with the found effect.
		const found = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "10001", body: { content: [{ type: "text", text: COMMENT.body }] } }] } } } } });
		const resolved = await adjudicateRun(runId, COMMENT, deps({ transport: found.transport }));
		expect([resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["completed", ["jira-comment:10001"]]);
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["completed"]);
	});

	test("a failed object-lock release after the durable intent answers with the recorded, unsent receipt and never sends", async () => {
		let armed = false;
		const tampered: string[] = [];
		const journal: Dependencies["journal"] = (tenant) =>
			openJournal(tenant, {
				stateRoot,
				now: () => NOW,
				hooks: {
					// Once armed, a foreign holder replaces the object lock before its release; the meta-lock is left alone.
					beforeRelease: (lockFile) => {
						if (!armed || lockFile.endsWith(".meta")) return;
						tampered.push(path.basename(lockFile));
						writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockId: "foreign", at: NOW }), { mode: 0o600 });
					},
				},
			});
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: commentReply });
		const dependencies = deps({ transport, journal });
		const preview = previewData(await previewOp("issue.comment", COMMENT, dependencies));
		armed = true;
		const dispatched = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		armed = false;
		expect(tampered).toHaveLength(1);
		// Disk oracle, read without the journal: one open receipt, never marked sent, and the preview consumed.
		const receipts = readJsonDir(receiptsDir());
		expect(receipts.map((entry) => [entry.previewId, entry.status, entry.send, entry.effects])).toEqual([[preview.previewId, "intent", "unsent", []]]);
		expect(readJsonDir(previewsDir()).map((entry) => [entry.previewId, entry.status])).toEqual([[preview.previewId, "consumed"]]);
		// The outcome acknowledges that recorded receipt as an unchanged failure, never an external or uncertain effect.
		const data = dispatched.outcome.data as { runId: string; previewId: string; status: string; send: string };
		expect([data.runId, data.previewId, data.status, data.send]).toEqual([receipts[0]?.runId as string, preview.previewId, "intent", "unsent"]);
		expect([dispatched.outcome.transactionState]).toEqual(["unchanged"]);
		expect(dispatched.outcome.cause).toBe("refused-state");
		expect(effectIds(dispatched)).toEqual([]);
		expect(dispatched.outcome.detail).toEqual(expect.stringContaining("unlock"));
		// The Provider write tool was never called, and a second apply of the same preview cannot send either.
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toEqual([]);
		const again = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		expect(again.outcome.cause).toBe("refused-write-blocked");
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toHaveLength(1);
	});

	test("adjudication does not count an identical historical Jira comment as a newly completed effect", async () => {
		const historical = { ok: true as const, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "777", body: COMMENT.body }] } } } };
		const { transport } = fakeTransport({ [`${CJ}.jira_add_comment`]: failure("failed-transport"), [`${CJ}.jira_get_issue`]: historical });
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", COMMENT, dependencies));
		const applied = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		expect([applied.outcome.cause, applied.outcome.transactionState]).toEqual(["outcome-unknown", "unknown"]);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const adjudicated = await adjudicateRun(runId, COMMENT, dependencies);
		expect(adjudicated.outcome.cause).toBe("refused-evidence");
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["unknown"]);
	});

	test("a Jira comment adjudication completes only when a new comment id appears after its baseline", async () => {
		let reads = 0;
		const { transport } = fakeTransport({
			[`${CJ}.jira_add_comment`]: failure("failed-transport"),
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", fields: { comment: { comments: reads++ >= 3 ? [{ id: "778", body: COMMENT.body }] : [] } } } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", COMMENT, dependencies));
		const applied = await applyOp("issue.comment", COMMENT, preview.previewId, dependencies);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const resolved = await adjudicateRun(runId, COMMENT, dependencies);
		expect([applied.outcome.transactionState, resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["unknown", "completed", ["jira-comment:778"]]);
	});

	test("a Jira mention comment adjudicates from a new id when read-back renders the account as User:id", async () => {
		const accountId = "712020:00000000-0000-4000-8000-000000000001";
		const input = { issueKey: "PROJ-1", body: `Mention test. @[Test Person](accountid:${accountId}) No action needed.` };
		let reads = 0;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_add_comment`]: failure("failed-transport"),
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", comments: reads++ >= 3 ? [{ id: "778", body: `Mention test. User:${accountId} No action needed.` }] : [] } }),
		});
		const dependencies = deps({ transport });
		const previewed = await previewOp("issue.comment", input, dependencies);
		expect(previewed.outcome.cause).toBe("success");
		const preview = previewData(previewed);
		const applied = await applyOp("issue.comment", input, preview.previewId, dependencies);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const resolved = await adjudicateRun(runId, input, dependencies);
		expect([applied.outcome.transactionState, resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["unknown", "completed", ["jira-comment:778"]]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("Jira adjudicates a new formatted mention comment when it auto-links a matching issue key", async () => {
		const accountId = "712020:00000000-0000-4000-8000-000000000001";
		const input = { issueKey: "PROJ-1", body: `**Bold** for @[Test Person](accountid:${accountId}). See PROJ-1.` };
		let reads = 0;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_add_comment`]: failure("failed-transport"),
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", comments: reads++ >= 3 ? [{ id: "779", body: `**Bold** for User:${accountId}. See [PROJ-1](https://example.atlassian.net/browse/PROJ-1).` }] : [] } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", input, dependencies));
		const applied = await applyOp("issue.comment", input, preview.previewId, dependencies);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const adjudicated = await adjudicateRun(runId, input, dependencies);
		expect([adjudicated.outcome.transactionState, effectIds(adjudicated)]).toEqual(["completed", ["jira-comment:779"]]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("a Jira comment preview binds historical autolinks to the credential origin", async () => {
		const input = { issueKey: "PROJ-1", body: "See PROJ-1." };
		const { transport } = fakeTransport({
			[`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", browse_url: "https://other.atlassian.net/browse/PROJ-1", comments: [{ id: "781", body: "See [PROJ-1](https://example.atlassian.net/browse/PROJ-1)." }] } },
		});
		const preview = previewData(await previewOp("issue.comment", input, deps({ transport })));
		expect(preview.baseline.commentIds).toEqual(["781"]);
	});

	test.each([
		["different target key", "https://example.atlassian.net/browse/PROJ-2", "https://example.atlassian.net/browse/PROJ-1"],
		["external target host", "https://example.invalid/browse/PROJ-1", "https://example.atlassian.net/browse/PROJ-1"],
		["another Atlassian tenant", "https://other.atlassian.net/browse/PROJ-1", "https://example.atlassian.net/browse/PROJ-1"],
		["provider-reported other tenant", "https://other.atlassian.net/browse/PROJ-1", "https://other.atlassian.net/browse/PROJ-1"],
	])("Jira adjudication rejects an auto-link with %s", async (_case, link, browseUrl) => {
		const input = { issueKey: "PROJ-1", body: "See PROJ-1." };
		let reads = 0;
		const { transport } = fakeTransport({
			[`${CJ}.jira_add_comment`]: failure("failed-transport"),
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", browse_url: browseUrl, comments: reads++ >= 3 ? [{ id: "780", body: `See [PROJ-1](${link}).` }] : [] } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", input, dependencies));
		const applied = await applyOp("issue.comment", input, preview.previewId, dependencies);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const adjudicated = await adjudicateRun(runId, input, dependencies);
		expect([adjudicated.outcome.cause, effectIds(adjudicated)]).toEqual(["refused-evidence", []]);
		expect((await showReceipt(runId, dependencies)).outcome.data).toMatchObject({ status: "unknown" });
	});

	test.each([
		["another account", "Mention test. User:712020:00000000-0000-4000-8000-000000000002 No action needed.", false],
		["an account with different separators", "Mention test. User:712020-00000000-0000-4000-8000-000000000001 No action needed.", false],
		["different surrounding text", "Different test. User:712020:00000000-0000-4000-8000-000000000001 No action needed.", false],
		["a historical matching comment", "Mention test. User:712020:00000000-0000-4000-8000-000000000001 No action needed.", true],
	])("Jira mention adjudication rejects %s", async (_case, observedBody, historical) => {
		const accountId = "712020:00000000-0000-4000-8000-000000000001";
		const input = { issueKey: "PROJ-1", body: `Mention test. @[Test Person](accountid:${accountId}) No action needed.` };
		let reads = 0;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_add_comment`]: failure("failed-transport"),
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", comments: historical || reads++ >= 3 ? [{ id: "778", body: observedBody }] : [] } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment", input, dependencies));
		const applied = await applyOp("issue.comment", input, preview.previewId, dependencies);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const adjudicated = await adjudicateRun(runId, input, dependencies);
		expect([adjudicated.outcome.cause, adjudicated.outcome.transactionState, effectIds(adjudicated)]).toEqual(["refused-evidence", "unchanged", []]);
		const receipt = await showReceipt(runId, dependencies);
		expect((receipt.outcome.data as { status: string }).status).toBe("unknown");
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("Jira create adjudication rejects a historical title and accepts only a new issue key", async () => {
		const input = { projectKey: "PROJ", issueType: "Bug", summary: "Baseline-safe create" };
		const historical = { ok: true as const, data: { issues: [{ key: "PROJ-9", fields: { summary: input.summary, issuetype: { name: input.issueType } } }] } };
		const old = fakeTransport({ [`${CJ}.jira_create_issue`]: failure("failed-transport"), [`${CJ}.jira_search`]: historical });
		const oldDeps = deps({ transport: old.transport });
		const oldPreview = previewData(await previewOp("issue.create", input, oldDeps));
		expect([oldPreview.tool, oldPreview.arguments]).toEqual(["jira_create_issue", { project_key: "PROJ", issue_type: "Bug", summary: input.summary }]);
		expect(old.calls[0]).toEqual({ server: CJ, tool: "jira_search", args: { jql: 'project = "PROJ" AND summary ~ "Baseline-safe create" ORDER BY created DESC', limit: 20, fields: "summary,issuetype,created" } });
		const oldApply = await applyOp("issue.create", input, oldPreview.previewId, oldDeps);
		const oldRun = (oldApply.outcome.data as { runId: string }).runId;
		expect((await adjudicateRun(oldRun, input, oldDeps)).outcome.cause).toBe("refused-evidence");

		const freshInput = { ...input, summary: "Baseline-safe create two" };
		let reads = 0;
		const fresh = fakeTransport({ [`${CJ}.jira_create_issue`]: failure("failed-transport"), [`${CJ}.jira_search`]: () => ({ ok: true, data: { issues: reads++ >= 3 ? [{ key: "PROJ-10", fields: { summary: freshInput.summary, issuetype: { name: freshInput.issueType } } }] : [] } }) });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await previewOp("issue.create", freshInput, freshDeps));
		const freshApply = await applyOp("issue.create", freshInput, freshPreview.previewId, freshDeps);
		const freshRun = (freshApply.outcome.data as { runId: string }).runId;
		const freshResolved = await adjudicateRun(freshRun, freshInput, freshDeps);
		expect([freshApply.outcome.transactionState, freshResolved.outcome.transactionState, effectIds(freshResolved)]).toEqual(["unknown", "completed", ["jira-issue:PROJ-10"]]);
	});

	test("Confluence comment adjudication rejects a historical body and accepts only a new comment id", async () => {
		const input = { pageId: "123", body: "baseline-safe comment" };
		const page = { ok: true as const, data: { id: "123", metadata: { version: 7, hasSpaceInstructions: false } } };
		const historical = fakeTransport({ [`${CC}.confluence_get_page`]: page, [`${CC}.confluence_add_comment`]: failure("failed-transport"), [`${CC}.confluence_get_comments`]: { ok: true, data: [{ id: "42", body: input.body }] } });
		const historicalDeps = deps({ transport: historical.transport });
		const oldPreview = previewData(await previewOp("page.comment", input, historicalDeps));
		const oldApply = await applyOp("page.comment", input, oldPreview.previewId, historicalDeps);
		const oldRun = (oldApply.outcome.data as { runId: string }).runId;
		expect((await adjudicateRun(oldRun, input, historicalDeps)).outcome.cause).toBe("refused-evidence");

		const freshInput = { pageId: "124", body: "baseline-safe comment two" };
		const freshPage = { ok: true as const, data: { id: "124", metadata: { version: 7, hasSpaceInstructions: false } } };
		let reads = 0;
		const fresh = fakeTransport({ [`${CC}.confluence_get_page`]: freshPage, [`${CC}.confluence_add_comment`]: failure("failed-transport"), [`${CC}.confluence_get_comments`]: () => ({ ok: true, data: reads++ >= 3 ? [{ id: "43", body: freshInput.body }] : [] }) });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await previewOp("page.comment", freshInput, freshDeps));
		const freshApply = await applyOp("page.comment", freshInput, freshPreview.previewId, freshDeps);
		const freshRun = (freshApply.outcome.data as { runId: string }).runId;
		const freshResolved = await adjudicateRun(freshRun, freshInput, freshDeps);
		expect([freshApply.outcome.transactionState, freshResolved.outcome.transactionState, effectIds(freshResolved)]).toEqual(["unknown", "completed", ["confluence-comment:43"]]);
	});

	test("Confluence create adjudication rejects a historical title and accepts only a new content id", async () => {
		const input = { spaceKey: "ENG", title: "Baseline-safe page", body: "body" };
		const historical = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [{ id: "556", title: input.title, space: { key: "ENG", name: "Engineering" } }] } }, [`${CC}.confluence_create_page`]: failure("failed-transport") });
		const historicalDeps = deps({ transport: historical.transport });
		const oldPreview = previewData(await previewOp("page.create", input, historicalDeps));
		expect(oldPreview.objectIdentity).toMatch(/^space:ENG:create:root:[0-9a-f]{16}$/);
		expect(historical.calls).toEqual([{ server: CC, tool: "confluence_search", args: { query: 'type = page AND space = "ENG" AND title = "Baseline-safe page"', limit: 20 } }]);
		const oldApply = await applyOp("page.create", input, oldPreview.previewId, historicalDeps);
		const oldRun = (oldApply.outcome.data as { runId: string }).runId;
		expect((await adjudicateRun(oldRun, input, historicalDeps)).outcome.cause).toBe("refused-evidence");

		const freshInput = { spaceKey: "ENG", title: "Baseline-safe page two", body: "body" };
		const fresh = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [] } }, [`${CC}.confluence_create_page`]: failure("failed-transport") });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await previewOp("page.create", freshInput, freshDeps));
		expect(freshPreview.arguments).toEqual({ space_key: "ENG", title: freshInput.title, content: "body", content_format: "markdown" });
		const freshApply = await applyOp("page.create", freshInput, freshPreview.previewId, freshDeps);
		const freshRun = (freshApply.outcome.data as { runId: string }).runId;
		// A new, stable content id appears only during operator read-back.
		const resolvedTransport = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [{ id: "557", title: freshInput.title, space: { key: "ENG" } }] } } });
		const freshResolved = await adjudicateRun(freshRun, freshInput, deps({ transport: resolvedTransport.transport }));
		expect([freshApply.outcome.transactionState, freshResolved.outcome.transactionState, effectIds(freshResolved)]).toEqual(["unknown", "completed", ["confluence-content:557"]]);
	});

	test("a schema mismatch before the send mark makes no call and records no preview", async () => {
		const { transport, calls } = fakeTransport({}, { [CJ]: [tool("jira_get_issue", ["issue_key"], ["fields", "comment_limit"]), tool("jira_add_comment", ["issue_key", "body", "visibility"])] });
		const dependencies = deps({ transport });
		const preview = await previewOp("issue.comment", COMMENT, dependencies);
		expect([preview.outcome.cause]).toEqual(["capability-unavailable"]);
		expect(calls).toEqual([]);
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	test("page.update reads the page with full detail, binds its version and current title, and refuses when the version moved", async () => {
		let version = 7;
		let body = "old";
		const page = () => ({ ok: true as const, data: { id: "123", title: "Roadmap", metadata: { version, hasSpaceInstructions: false }, body: { format: "markdown", value: body } } });
		const { transport, calls } = fakeTransport({
			[`${CC}.confluence_get_page`]: () => page(),
			[`${CC}.confluence_update_page`]: () => {
				version = 8;
				body = "# New body";
				return { ok: true, data: { ok: true } };
			},
		});
		const dependencies = deps({ transport });
		const input = { pageId: "123", body: "# New body", versionMessage: "connectors update" };
		const preview = previewData(await previewOp("page.update", input, dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity]).toEqual(["confluence_update_page", "7", "page:123"]);
		expect(preview.arguments).toEqual({ page_id: "123", title: "Roadmap", content: "# New body", version_comment: "connectors update", content_format: "markdown" });
		expect(calls.find((call) => call.tool === "confluence_get_page")?.args).toEqual({ page_id: "123", include_metadata: true });
		version = 8;
		const moved = await applyOp("page.update", input, preview.previewId, dependencies);
		expect([moved.outcome.cause, moved.outcome.detail?.endsWith("preview-revision-changed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "confluence_update_page")).toEqual([]);
		version = 7;
		const applied = await applyOp("page.update", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["confluence-content:123"]]);
		expect(calls.find((call) => call.tool === "confluence_update_page")?.args).toEqual(preview.arguments);
	});

	test("issue.update binds the issue's updated timestamp and refuses a preparatory or baseline reply for another issue before any write", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "2026-09-23 14:07:13 AEST", summary: "old" } } } });
		const preview = previewData(await previewOp("issue.update", {"issueKey":"PROJ-1","fields":{"summary":"new"}}, deps({ transport })));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual(["jira_update_issue", "2026-09-23 14:07:13 AEST", "issue:PROJ-1", { issue_key: "PROJ-1", fields: '{"summary":"new"}' }]);
		expect(calls.map((call) => call.args)).toEqual([{ issue_key: "PROJ-1", fields: "summary,updated" }, { issue_key: "PROJ-1", fields: "summary,updated" }]);
		for (const wrongRead of [1, 2]) {
			let reads = 0;
			const wrong = fakeTransport({
				[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: ++reads === wrongRead ? "PROJ-2" : "PROJ-1", fields: { version: 7, summary: "old" } } }),
			});
			const dispatched = await previewOp("issue.update", {"issueKey":"PROJ-1","fields":{"summary":"new"}}, deps({ transport: wrong.transport }));
			expect([wrongRead, dispatched.outcome.cause, dispatched.outcome.detail?.includes("different issue")]).toEqual([wrongRead, "capability-unavailable", true]);
			expect(wrong.calls.map((call) => call.tool)).not.toContain("jira_update_issue");
		}
	});

	test("page.update refuses a preparatory or baseline reply for another page before any write", async () => {
		for (const wrongRead of [1, 2]) {
			let reads = 0;
			const { transport, calls } = fakeTransport({
				[`${CC}.confluence_get_page`]: () => ({ ok: true, data: { id: ++reads === wrongRead ? "999" : "123", title: "Roadmap", metadata: { version: 7, hasSpaceInstructions: false }, body: { value: "old" } } }),
			});
			const dispatched = await previewOp("page.update", {"pageId":"123","body":"new"}, deps({ transport }));
			expect([wrongRead, dispatched.outcome.cause, dispatched.outcome.detail?.includes("different page")]).toEqual([wrongRead, "capability-unavailable", true]);
			expect(calls.map((call) => call.tool)).not.toContain("confluence_update_page");
		}
	});

	test("page.update stays unknown when a hostile provider reply and adjudication read name another page", async () => {
		let reads = 0;
		const { transport, calls } = fakeTransport({
			[`${CC}.confluence_get_page`]: () => {
				reads += 1;
				return reads <= 4
					? { ok: true, data: { id: "123", title: "Roadmap", metadata: { version: 7, hasSpaceInstructions: false }, body: { value: "old" } } }
					: { ok: true, data: { id: "999", title: "Roadmap", metadata: { version: 8, hasSpaceInstructions: false }, body: { value: "new" } } };
			},
			[`${CC}.confluence_update_page`]: { ok: true, data: { id: "999", version: 8 } },
		});
		const dependencies = deps({ transport });
		const input = { pageId: "123", body: "new" };
		const preview = previewData(await previewOp("page.update", input, dependencies));
		const applied = await applyOp("page.update", input, preview.previewId, dependencies);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const adjudicated = await adjudicateRun(runId, input, dependencies);
		expect([applied.outcome.cause, applied.outcome.transactionState]).toEqual(["outcome-unknown", "unknown"]);
		expect([adjudicated.outcome.cause, adjudicated.outcome.detail?.includes("different page")]).toEqual(["refused-evidence", true]);
		expect((await showReceipt(runId, dependencies)).outcome.data).toMatchObject({ status: "unknown", effects: [] });
		expect(calls.filter((call) => call.tool === "confluence_update_page")).toHaveLength(1);
	});

	test("page.create binds the space key as the container, previews from a title search, and completes from the create reply", async () => {
		const { transport, calls } = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [{ id: "555", title: "Home", space: { key: "ENG" } }] } }, [`${CC}.confluence_create_page`]: { ok: true, data: { message: "Page created successfully", page: { id: "556", title: "Roadmap draft" } } } });
		const dependencies = deps({ transport });
		const input = { spaceKey: "ENG", title: "Roadmap draft", body: "x" };
		const preview = previewData(await previewOp("page.create", input, dependencies));
		expect(preview.objectIdentity).toMatch(/^space:ENG:create:root:[0-9a-f]{16}$/);
		expect(preview.arguments).toEqual({ space_key: "ENG", title: "Roadmap draft", content: "x", content_format: "markdown" });
		expect(calls.map((call) => [call.tool, call.args])).toEqual([["confluence_search", { query: 'type = page AND space = "ENG" AND title = "Roadmap draft"', limit: 20 }]]);
		const applied = await applyOp("page.create", input, preview.previewId, dependencies);
		expect([effectIds(applied)]).toEqual([["confluence-content:556"]]);
		const legacy = { space: { key: "ENG" }, title: "Roadmap draft", body: "x" };
		expect([refusal({ tenant: TENANT, kind: "preview", spec: OPERATION_SPECS["page.create"], input: legacy }), writeInput("page.create", legacy)]).toEqual(["input-invalid", { ok: false, reason: "unknown input key space" }]);
	});

	test("issue.update refuses a no-op before any write, and a reply without updated or a version fails closed", async () => {
		const held = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "t1", summary: "new" } } }, [`${CJ}.jira_update_issue`]: failure("failed-transport") });
		const noop = await previewOp("issue.update", {"issueKey":"PROJ-1","fields":{"summary":"new"}}, deps({ transport: held.transport }));
		expect([noop.outcome.cause, noop.outcome.detail]).toEqual(["input-invalid", "the issue already holds every requested value; nothing to change"]);
		expect(held.calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue"]);
		const bare = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { summary: "old" } } } });
		const closed = await previewOp("issue.update", {"issueKey":"PROJ-1","fields":{"summary":"new"}}, deps({ transport: bare.transport }));
		expect([closed.outcome.cause, closed.outcome.detail?.includes("no revision")]).toEqual(["capability-unavailable", true]);
		expect(bare.calls.map((call) => call.tool)).toEqual(["jira_get_issue"]);
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	test("issue.update completes from the read-back when the requested values land, including an assignee named by email", async () => {
		let assignee: Record<string, unknown> = { display_name: "Unassigned" };
		let updated = "t1";
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", summary: "old", assignee, updated }) } }),
			[`${CJ}.jira_update_issue`]: () => {
				assignee = { display_name: "Service Account", email: PRINCIPAL };
				updated = "t2";
				return { ok: true, data: { result: JSON.stringify({ message: "Issue updated successfully", issue: { key: "PROJ-1" } }) } };
			},
		});
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", fields: { assignee: PRINCIPAL } };
		const preview = previewData(await previewOp("issue.update", input, dependencies));
		expect([preview.revision, preview.arguments]).toEqual(["t1", { issue_key: "PROJ-1", fields: JSON.stringify({ assignee: PRINCIPAL }) }]);
		const applied = await applyOp("issue.update", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-issue:PROJ-1"]]);
		// Preview and apply each read twice (revision, then baseline); the update is always read back.
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_update_issue", "jira_get_issue"]);
		// A moved timestamp between preview and apply refuses.
		updated = "t3";
		const secondInput = { issueKey: "PROJ-1", fields: { summary: "renamed" } };
		const secondPreview = previewData(await previewOp("issue.update", secondInput, dependencies));
		updated = "t4";
		const moved = await applyOp("issue.update", secondInput, secondPreview.previewId, dependencies);
		expect([moved.outcome.cause, moved.outcome.detail?.endsWith("preview-revision-changed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_update_issue")).toHaveLength(1);
	});

	test("issue.comment.update binds the comment's own updated timestamp, refuses a no-op or a missing comment, and completes from the reply", async () => {
		let comments = [{ id: "454166", body: "first body", updated: "u1" }, { id: "454167", body: "second body", updated: "u2" }];
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", comments }) } }),
			[`${CJ}.jira_edit_comment`]: () => {
				comments = comments.map((entry) => (entry.id === "454166" ? { ...entry, body: "edited body", updated: "u3" } : entry));
				return { ok: true, data: { result: JSON.stringify({ id: "454166", body: "edited body", updated: "u3" }) } };
			},
		});
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", commentId: "454166", body: "edited body" };
		const preview = previewData(await previewOp("issue.comment.update", input, dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual(["jira_edit_comment", "u1", "issue:PROJ-1", { issue_key: "PROJ-1", comment_id: "454166", body: "edited body" }]);
		expect(calls.map((call) => call.args)).toEqual([{ issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 }, { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 }]);
		const applied = await applyOp("issue.comment.update", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-comment:454166"]]);
		// The edit is proven by read-back, never by the reply alone.
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_edit_comment", "jira_get_issue"]);
		const noop = await previewOp("issue.comment.update", { ...input, commentId: "454167", body: "Second body" }, dependencies);
		expect([noop.outcome.cause, noop.outcome.detail]).toEqual(["input-invalid", "the comment already holds the requested body; nothing to change"]);
		const missing = await previewOp("issue.comment.update", { ...input, commentId: "1" }, dependencies);
		expect([missing.outcome.cause, missing.outcome.detail]).toEqual(["not-found", "the issue has no comment with that id among its first 100 comments"]);
		expect(calls.filter((call) => call.tool === "jira_edit_comment")).toHaveLength(1);
	});

	test("a Jira mention edit completes from its named comment and refuses a second identical edit", async () => {
		const accountId = "712020:00000000-0000-4000-8000-000000000001";
		const input = { issueKey: "PROJ-1", commentId: "454166", body: `**Updated** for @[Test Person](accountid:${accountId}).` };
		let body = "Original text";
		let updated = "u1";
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", comments: [{ id: "454166", body, updated }] } }),
			[`${CJ}.jira_edit_comment`]: () => {
				body = `Updated for User:${accountId}.`;
				updated = "u2";
				return { ok: true, data: { id: "454166", body, updated } };
			},
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment.update", input, dependencies));
		const applied = await applyOp("issue.comment.update", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-comment:454166"]]);
		const noop = await previewOp("issue.comment.update", input, dependencies);
		expect(noop.outcome.cause).toBe("input-invalid");
		expect(calls.filter((call) => call.tool === "jira_edit_comment")).toHaveLength(1);
	});

	test("issue.comment.update refuses a missing comment timestamp at preview and apply before a write", async () => {
		let updated: string | undefined;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", comments: [{ id: "454166", body: "old", ...(updated === undefined ? {} : { updated }) }] }) } }),
		});
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", commentId: "454166", body: "edited" };
		const missingAtPreview = await previewOp("issue.comment.update", input, dependencies);
		expect([missingAtPreview.outcome.cause, missingAtPreview.outcome.detail]).toEqual(["capability-unavailable", "the comment read exposes no updated timestamp to bind the revision"]);
		updated = "u1";
		const preview = previewData(await previewOp("issue.comment.update", input, dependencies));
		updated = undefined;
		const missingAtApply = await applyOp("issue.comment.update", input, preview.previewId, dependencies);
		expect([missingAtApply.outcome.cause, missingAtApply.outcome.detail]).toEqual(["capability-unavailable", "the comment read exposes no updated timestamp to bind the revision"]);
		expect(calls.some((call) => call.tool === "jira_edit_comment")).toBe(false);
	});

	test("issue.attach sends one absolute local file on the update tool and completes only from a new attachment id in read-back", async () => {
		let attachments = [{ id: "10499", filename: "report.pdf" }];
		let updated = "t1";
		let uploadWorks = true;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", updated, attachments }) } }),
			[`${CJ}.jira_update_issue`]: () => {
				if (!uploadWorks) return { ok: true, data: { result: JSON.stringify({ message: "Issue updated successfully", issue: { key: "PROJ-1", attachment_results: { success: false, uploaded: [], failed: [{ path: "/tmp/evidence/report.pdf", error: "forbidden" }] } } }) } };
				attachments = [...attachments, { id: "10500", filename: "report.pdf" }];
				updated = "t2";
				return { ok: true, data: { result: JSON.stringify({ message: "Issue updated successfully", issue: { key: "PROJ-1" } }) } };
			},
		});
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", file: "/tmp/evidence/report.pdf" };
		const preview = previewData(await previewOp("issue.attach", input, dependencies));
		// The Provider reads uploads only from the tenant outbox, so the bound argument is the staged relative path.
		expect([preview.tool, preview.objectIdentity, preview.revision, preview.baseline, preview.arguments]).toEqual(["jira_update_issue", "issue:PROJ-1", "t1", { effectIds: ["10499"], commentIds: [], revision: null }, { issue_key: "PROJ-1", fields: "{}", attachments: "staged/report.pdf" }]);
		expect(calls.map((call) => call.args)).toEqual([{ issue_key: "PROJ-1", fields: "summary,updated" }, { issue_key: "PROJ-1", fields: "attachment,updated" }]);
		const applied = await applyOp("issue.attach", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-attachment:10500"]]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_update_issue", "jira_get_issue"]);
		// A failed upload reported inside a successful reply leaves the issue's timestamp unmoved: proven unchanged, object freed, cause named.
		uploadWorks = false;
		const secondInput = { issueKey: "PROJ-1", file: "/tmp/evidence/second.pdf" };
		const secondPreview = previewData(await previewOp("issue.attach", secondInput, dependencies));
		const refusedUpload = await applyOp("issue.attach", secondInput, secondPreview.previewId, dependencies);
		expect([refusedUpload.outcome.cause, refusedUpload.outcome.transactionState, refusedUpload.outcome.detail]).toEqual(["failed-unknown", "unchanged", `${REPAIR["failed-unknown"]}; the Provider reported the upload failed: check the file path and the Create Attachments permission`]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.status, entry.basis]).sort()).toEqual([["completed", undefined], ["unchanged", "revision-unchanged"]]);
		const relative = { issueKey: "PROJ-1", file: "evidence/report.pdf" };
		expect([refusal({ tenant: TENANT, kind: "preview", spec: OPERATION_SPECS["issue.attach"], input: relative }), writeInput("issue.attach", relative)]).toEqual(["input-invalid", { ok: false, reason: "input key file is invalid" }]);
		const unreadable = await previewOp("issue.attach", input, deps({ transport, stage: () => ({ ok: false, reason: "file-unreadable" }) }));
		expect([unreadable.outcome.cause, unreadable.outcome.detail]).toEqual(["input-invalid", "input key file names no readable regular file"]);
		expect(calls.filter((call) => call.tool === "jira_update_issue")).toHaveLength(2);
	});

	test("page.attach uploads one file to the page and completes from a new attachment id in the attachment listing", async () => {
		let listed: { id: string; title: string }[] = [];
		const { transport, calls } = fakeTransport({
			[`${CC}.confluence_get_page`]: { ok: true, data: { result: JSON.stringify({ id: "123", title: "Roadmap", version: 7 }) } },
			[`${CC}.confluence_get_attachments`]: () => ({ ok: true, data: { result: JSON.stringify({ attachments: listed, total: listed.length }) } }),
			[`${CC}.confluence_upload_attachment`]: () => {
				listed = [{ id: "att900", title: "report.pdf" }];
				return { ok: true, data: { result: JSON.stringify({ message: "Attachment uploaded successfully", attachment: { id: "att900", title: "report.pdf" } }) } };
			},
		});
		const dependencies = deps({ transport });
		const input = { pageId: "123", file: "/tmp/evidence/report.pdf" };
		const preview = previewData(await previewOp("page.attach", input, dependencies));
		expect([preview.tool, preview.objectIdentity, preview.revision, preview.arguments]).toEqual(["confluence_upload_attachment", "page:123", "7", { content_id: "123", file_path: "staged/report.pdf" }]);
		const applied = await applyOp("page.attach", input, preview.previewId, dependencies);
		expect([effectIds(applied)]).toEqual([["confluence-attachment:att900"]]);
		expect(calls.map((call) => call.tool)).toEqual(["confluence_get_page", "confluence_get_attachments", "confluence_get_page", "confluence_get_attachments", "confluence_upload_attachment"]);
		expect(calls.at(-1)?.args).toEqual({ content_id: "123", file_path: "staged/report.pdf" });
	});

	test("issue.transition resolves the transition by destination status at preview and apply, refuses a no-op or an unavailable status, and completes from read-back", async () => {
		let status = "Backlog";
		let updated = "t1";
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", status: { name: status, category: status }, updated }) } }),
			[`${CJ}.jira_get_transitions`]: { ok: true, data: { result: JSON.stringify([{ id: "11", name: "Start Progress", to_status: { name: "In Progress" } }, { id: "31", name: "Done", to_status: { name: "Done" } }]) } },
			[`${CJ}.jira_transition_issue`]: (args) => {
				status = args.transition_id === "11" ? "In Progress" : "Done";
				updated = "t2";
				return { ok: true, data: { result: JSON.stringify({ message: "Issue PROJ-1 transitioned successfully" }) } };
			},
		});
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", toStatus: "In Progress" };
		const preview = previewData(await previewOp("issue.transition", input, dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual(["jira_transition_issue", "t1", "issue:PROJ-1", { issue_key: "PROJ-1", transition_id: "11" }]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_transitions", "jira_get_issue"]);
		const applied = await applyOp("issue.transition", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-issue:PROJ-1"]]);
		expect(calls.map((call) => call.tool).slice(3)).toEqual(["jira_get_issue", "jira_get_transitions", "jira_get_issue", "jira_transition_issue", "jira_get_issue"]);
		const noop = await previewOp("issue.transition", input, dependencies);
		expect([noop.outcome.cause, noop.outcome.detail]).toEqual(["input-invalid", "the issue already has the requested status; nothing to change"]);
		const unavailable = await previewOp("issue.transition", {"issueKey":"PROJ-1","toStatus":"Cancelled"}, dependencies);
		expect([unavailable.outcome.cause, unavailable.outcome.detail]).toEqual(["not-found", "no transition available to this principal leads to that status"]);
		expect(calls.filter((call) => call.tool === "jira_transition_issue")).toHaveLength(1);
	});

	test("issue.assign assigns by identifier or unassigns when none is given, refusing a no-op", async () => {
		let assignee: Record<string, unknown> = { display_name: "Unassigned" };
		let updated = "t1";
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", assignee, updated }) } }),
			[`${CJ}.jira_assign_issue`]: (args) => {
				assignee = args.assignee === "" ? { display_name: "Unassigned" } : { display_name: "Service Account", email: String(args.assignee) };
				updated = `${updated}+`;
				return { ok: true, data: { result: JSON.stringify({ message: "Issue PROJ-1 assigned successfully", issue: { key: "PROJ-1" } }) } };
			},
		});
		const dependencies = deps({ transport });
		const assign = { issueKey: "PROJ-1", assignee: PRINCIPAL };
		const preview = previewData(await previewOp("issue.assign", assign, dependencies));
		expect([preview.tool, preview.revision, preview.arguments]).toEqual(["jira_assign_issue", "t1", { issue_key: "PROJ-1", assignee: PRINCIPAL }]);
		const applied = await applyOp("issue.assign", assign, preview.previewId, dependencies);
		expect([effectIds(applied)]).toEqual([["jira-issue:PROJ-1"]]);
		const unassignPreview = previewData(await previewOp("issue.assign", {"issueKey":"PROJ-1"}, dependencies));
		expect(unassignPreview.arguments).toEqual({ issue_key: "PROJ-1", assignee: "" });
		const unassigned = await applyOp("issue.assign", {"issueKey":"PROJ-1"}, unassignPreview.previewId, dependencies);
		expect([effectIds(unassigned)]).toEqual([["jira-issue:PROJ-1"]]);
		const noop = await previewOp("issue.assign", {"issueKey":"PROJ-1"}, dependencies);
		expect([noop.outcome.cause, noop.outcome.detail]).toEqual(["input-invalid", "the issue already has the requested assignee; nothing to change"]);
		expect(calls.filter((call) => call.tool === "jira_assign_issue").map((call) => call.args.assignee)).toEqual([PRINCIPAL, ""]);
	});

	test("page.attachment.delete needs the attachment on the page and completes when the listing no longer carries it", async () => {
		let listed = [{ id: "att900", title: "report.pdf" }, { id: "att901", title: "other.pdf" }];
		const { transport, calls } = fakeTransport({
			[`${CC}.confluence_get_page`]: { ok: true, data: { result: JSON.stringify({ metadata: { id: "123", title: "Roadmap", version: 7 } }) } },
			[`${CC}.confluence_get_attachments`]: () => ({ ok: true, data: { result: JSON.stringify({ attachments: listed }) } }),
			[`${CC}.confluence_delete_attachment`]: () => {
				listed = listed.filter((entry) => entry.id !== "att900");
				return { ok: true, data: { result: JSON.stringify({ success: true, message: "Attachment deleted successfully" }) } };
			},
		});
		const dependencies = deps({ transport });
		const input = { pageId: "123", attachmentId: "att900" };
		const preview = previewData(await previewOp("page.attachment.delete", input, dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.baseline.effectIds, preview.arguments]).toEqual(["confluence_delete_attachment", "7", "page:123", ["att900"], { attachment_id: "att900" }]);
		const applied = await applyOp("page.attachment.delete", input, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["confluence-attachment:att900"]]);
		expect(calls.map((call) => call.tool)).toEqual(["confluence_get_page", "confluence_get_attachments", "confluence_get_page", "confluence_get_attachments", "confluence_delete_attachment", "confluence_get_attachments"]);
		const missing = await previewOp("page.attachment.delete", input, dependencies);
		expect([missing.outcome.cause, missing.outcome.detail]).toEqual(["input-invalid", "the page has no attachment with that id"]);
	});

	test("deletes bind the target's revision and complete only when the Provider's read-back refuses with not-found", async () => {
		// Jira: the reply message is not trusted alone; the read-back must fail to find the issue.
		let gone = false;
		const jira = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => (gone ? failure("not-found") : { ok: true, data: { result: JSON.stringify({ key: "PROJ-1", summary: "x", updated: "t1" }) } }),
			[`${CJ}.jira_delete_issue`]: () => {
				gone = true;
				return { ok: true, data: { result: JSON.stringify({ message: "Issue PROJ-1 has been deleted successfully" }) } };
			},
		});
		const jiraDeps = deps({ transport: jira.transport });
		const issuePreview = previewData(await previewOp("issue.delete", {"issueKey":"PROJ-1"}, jiraDeps));
		expect([issuePreview.tool, issuePreview.revision, issuePreview.objectIdentity, issuePreview.arguments]).toEqual(["jira_delete_issue", "t1", "issue:PROJ-1", { issue_key: "PROJ-1" }]);
		const issueDeleted = await applyOp("issue.delete", {"issueKey":"PROJ-1"}, issuePreview.previewId, jiraDeps);
		expect([issueDeleted.outcome.transactionState, effectIds(issueDeleted)]).toEqual(["completed", ["jira-issue:PROJ-1"]]);
		expect(jira.calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_delete_issue", "jira_get_issue"]);
		// Confluence: a delete that leaves the page in place at the same version settles unchanged and frees the object.
		const confluence = fakeTransport({
			[`${CC}.confluence_get_page`]: { ok: true, data: { result: JSON.stringify({ id: "123", title: "Roadmap", version: 7 }) } },
			[`${CC}.confluence_delete_page`]: { ok: true, data: { result: JSON.stringify({ success: false, message: "Unable to delete page 123. API request completed but deletion unsuccessful." }) } },
		});
		const confluenceDeps = deps({ transport: confluence.transport });
		const pagePreview = previewData(await previewOp("page.delete", {"pageId":"123"}, confluenceDeps));
		expect([pagePreview.tool, pagePreview.revision, pagePreview.objectIdentity]).toEqual(["confluence_delete_page", "7", "page:123"]);
		const pageKept = await applyOp("page.delete", {"pageId":"123"}, pagePreview.previewId, confluenceDeps);
		expect([pageKept.outcome.cause, pageKept.outcome.transactionState]).toEqual(["failed-unknown", "unchanged"]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.operation, entry.status, entry.basis]).sort()).toEqual([["issue.delete", "completed", undefined], ["page.delete", "unchanged", "revision-unchanged"]]);
		// A second attempt on the freed page can proceed.
		const again = previewData(await previewOp("page.delete", {"pageId":"123"}, confluenceDeps));
		expect(again.objectIdentity).toBe("page:123");
	});

	test("page.comment previews and applies through the Confluence route with the page's version bound", async () => {
		const { transport, calls } = fakeTransport({ [`${CC}.confluence_get_page`]: { ok: true, data: { id: "123", metadata: { version: 7, hasSpaceInstructions: false } } }, [`${CC}.confluence_add_comment`]: { ok: true, data: { success: true, comment: { id: "42", body: "hello" } } } });
		const input = { pageId: "123", body: "hello" };
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("page.comment", input, dependencies));
		expect([preview.server, preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual([CC, "confluence_add_comment", "7", "page:123", { page_id: "123", body: "hello" }]);
		expect(calls.map((call) => call.tool)).toEqual(["confluence_get_page", "confluence_get_comments"]);
		const applied = await applyOp("page.comment", input, preview.previewId, dependencies);
		expect([effectIds(applied)]).toEqual([["confluence-comment:42"]]);
	});

	test("unlock clears a dead holder's lock through the receipt or its preview and refuses an unknown reference", async () => {
		const dependencies = deps();
		const journal = dependencies.journal("example");
		const preview = journal.recordPreview({ operation: "issue.comment", provider: PROVIDER, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null });
		const receipt = await journal.apply({ previewId: preview.previewId, provider: PROVIDER, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null }, async () => ({ proof: "unknown" }));
		const lock = path.join(stateDir("locks"), "issue_PROJ-1.lock");
		writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: NOW }), { mode: 0o600 });
		const unlocked = await unlockRun(receipt.runId, dependencies);
		expect([unlocked.outcome.data]).toEqual([{ runId: receipt.runId, objectIdentity: "issue:PROJ-1", unlocked: true }]);
		expect(readdirSync(stateDir("locks"))).toEqual([]);
		const preIntentPreview = journal.recordPreview({ operation: "issue.comment", provider: PROVIDER, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null });
		writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: NOW }), { mode: 0o600 });
		const recovered = await unlockRun(preIntentPreview.previewId, dependencies);
		expect([recovered.outcome.data]).toEqual([{ previewId: preIntentPreview.previewId, objectIdentity: "issue:PROJ-1", unlocked: true }]);
		const missing = await unlockRun("nope", dependencies);
		expect([missing.outcome.cause, missing.outcome.detail?.endsWith("preview-unknown")]).toEqual(["refused-preview", true]);
		const shown = await showReceipt(receipt.runId, dependencies);
		expect((shown.outcome.data as { status: string }).status).toBe("unknown");
	});
});

// The wiki-comment exception: preview binds the REST arguments and the ids of
// the attachments the body references; apply refuses when either moved;
// read-back proves an <img> per bound attachment in the rendered HTML; an
// edit is guarded to the principal's own comments. Reply shapes are Jira REST
// v2 as the prototype observed them on SMSTX-364 (28 September 2026).
describe("wiki media comments through the owned REST route", () => {
	const MEDIA = { issueKey: "PROJ-1", body: "Before:\n\n!before.png|width=600!\n\nAfter:\n\n!after.png!", images: ["before.png", "after.png"] };
	const ME = "712020:00000000-0000-4000-8000-00000000000a";
	const img = (id: string, name: string) => `<p><span class="image-wrap"><img src="/rest/api/3/attachment/content/${id}" alt="${name}" /></span></p>`;
	const BOTH = `${img("202456", "before.png")}${img("202457", "after.png")}`;
	const attachmentsReply = (beforeId = "202456") => ({ ok: true as const, data: { key: "PROJ-1", fields: { updated: "t1", attachment: [{ id: beforeId, filename: "before.png", mimeType: "image/png", content: `https://example.atlassian.net/rest/api/2/attachment/content/${beforeId}` }, { id: "202457", filename: "after.png", mimeType: "image/png" }, { id: "1", filename: "notes.pdf", mimeType: "application/pdf" }] } } });
	const comments = (...entries: Record<string, unknown>[]) => ({ ok: true as const, data: { startAt: 0, maxResults: 100, total: entries.length, comments: entries } });
	const myself = { ok: true as const, data: { accountId: ME, emailAddress: PRINCIPAL } };
	const ATTACH_READ = { server: RJ, tool: "jira_rest_issue_attachments", args: { issue_key: "PROJ-1" } };
	const LIST_READ = { server: RJ, tool: "jira_rest_comments_list", args: { issue_key: "PROJ-1" } };

	test("preview binds the wiki body as the REST arguments and the attachment ids as the baseline; apply refuses when an attachment was replaced, and completes from a reply rendering every image", async () => {
		let beforeId = "202456";
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachments`]: () => attachmentsReply(beforeId),
			[`${RJ}.jira_rest_comments_list`]: comments({ id: "900", renderedBody: "<p>no images</p>", updated: "u0" }),
			[`${RJ}.jira_rest_comment_add`]: { ok: true, data: { id: "10077", author: { accountId: ME }, body: MEDIA.body, renderedBody: BOTH, updated: "u1" } },
		});
		const dependencies = deps({ transport });
		const dispatched = await previewOp("issue.comment.media", MEDIA, dependencies);
		expect(dispatched.outcome.cause).toBe("success");
		const preview = previewData(dispatched);
		expect([preview.provider, preview.server, preview.tool, preview.objectIdentity, preview.revision]).toEqual(["rest", RJ, "jira_rest_comment_add", "issue:PROJ-1", null]);
		expect(preview.arguments).toEqual({ issue_key: "PROJ-1", body: MEDIA.body });
		// The baseline binds the attachment ids and a digest of their verified image types.
		expect(preview.baseline).toMatchObject({ effectIds: ["202456", "202457"], commentIds: [] });
		expect(preview.baseline.revision).toMatch(/^[0-9a-f]{64}$/);
		expect(calls).toEqual([ATTACH_READ, LIST_READ]);
		expect(readJsonDir(previewsDir()).map((entry) => [entry.provider, entry.status, entry.baseline])).toEqual([["rest", "open", preview.baseline]]);
		// before.png was deleted and re-attached under a new id: the bound identifiers moved, so nothing is sent.
		beforeId = "202499";
		const moved = await applyOp("issue.comment.media", MEDIA, preview.previewId, dependencies);
		expect([moved.outcome.cause, moved.outcome.detail?.endsWith("preview-baseline-changed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_rest_comment_add")).toEqual([]);
		beforeId = "202456";
		const applied = await applyOp("issue.comment.media", MEDIA, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-comment:10077"]]);
		const sent = calls.filter((call) => call.tool === "jira_rest_comment_add");
		expect(sent).toEqual([{ server: RJ, tool: "jira_rest_comment_add", args: { issue_key: "PROJ-1", body: MEDIA.body } }]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.provider, entry.status, entry.effects])).toEqual([["rest", "completed", [{ kind: "jira-comment", id: "10077" }]]]);
		expect(applied.provenance.every((entry) => entry.provider === RJ)).toBe(true);
	});

	test("a lost reply blocks the issue until adjudication finds a new comment rendering every bound image; a historical rendering comment never counts", async () => {
		let reads = 0;
		const historical = { id: "900", body: MEDIA.body, renderedBody: BOTH, updated: "u0" };
		// Another comment with the same images under other text lands in the same window; it is not this write.
		const decoy = { id: "10080", body: "Looks good.\n\n!before.png!\n\n!after.png!", renderedBody: BOTH, updated: "u1" };
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachments`]: attachmentsReply(),
			[`${RJ}.jira_rest_comment_add`]: failure("failed-transport"),
			[`${RJ}.jira_rest_comments_list`]: () => (reads++ >= 3 ? comments(historical, decoy, { id: "10078", body: MEDIA.body, renderedBody: BOTH, updated: "u1" }, { id: "10079", body: MEDIA.body, renderedBody: img("202456", "before.png"), updated: "u1" }) : comments(historical, decoy)),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment.media", MEDIA, dependencies));
		expect(preview.baseline).toMatchObject({ effectIds: ["202456", "202457"], commentIds: ["900"] });
		const applied = await applyOp("issue.comment.media", MEDIA, preview.previewId, dependencies);
		expect([applied.outcome.cause, applied.outcome.transactionState, blockedObject(applied)]).toEqual(["outcome-unknown", "unknown", "issue:PROJ-1"]);
		const runId = (applied.outcome.data as { runId: string }).runId;
		const resolved = await adjudicateRun(runId, MEDIA, dependencies);
		expect([resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["completed", ["jira-comment:10078"]]);
		expect(calls.filter((call) => call.tool === "jira_rest_comment_add")).toHaveLength(1);
	});

	test("an image the issue does not carry, or carries twice, refuses the preview before any write; a body reference outside images is an input refusal before any read", async () => {
		const { transport, calls } = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: attachmentsReply() });
		const dependencies = deps({ transport });
		const undeclared = { ...MEDIA, images: ["before.png"] };
		expect([refusal({ tenant: TENANT, kind: "preview", spec: OPERATION_SPECS["issue.comment.media"], input: undeclared }), writeInput("issue.comment.media", undeclared)]).toEqual(["input-invalid", { ok: false, reason: "the body references an image that images does not name" }]);
		expect(calls).toEqual([]);
		const missing = await previewOp("issue.comment.media", { issueKey: "PROJ-1", body: "!states.png!", images: ["states.png"] }, dependencies);
		expect([missing.outcome.cause, missing.outcome.detail]).toEqual(["not-found", "an image named in images is not attached to the issue"]);
		// An attached file that is not an image cannot render inline; the preview refuses it before any write.
		const pdf = await previewOp("issue.comment.media", { issueKey: "PROJ-1", body: "See !notes.pdf!", images: ["notes.pdf"] }, dependencies);
		expect([pdf.outcome.cause, pdf.outcome.detail]).toEqual(["input-invalid", "an image named in images is not an image attachment; only image content renders inline"]);
		const duplicated = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: { ok: true, data: { key: "PROJ-1", fields: { attachment: [{ id: "202456", filename: "before.png" }, { id: "202499", filename: "before.png" }, { id: "202457", filename: "after.png" }] } } } });
		const duplicate = await previewOp("issue.comment.media", MEDIA, deps({ transport: duplicated.transport }));
		expect([duplicate.outcome.cause, duplicate.outcome.detail]).toEqual(["input-invalid", "an image named in images matches more than one attachment on the issue; remove the duplicate first"]);
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	test("an attachment Jira reports no type for is established from its first bytes before any write: a PNG is accepted and its type bound in the preview, a PDF is refused, and a failed read refuses", async () => {
		const untypedAttachments = { ok: true as const, data: { key: "PROJ-1", fields: { attachment: [{ id: "202456", filename: "before.png" }, { id: "202457", filename: "after.png", mimeType: "image/png" }] } } };
		// Jira serves the redirect=false content as a JSON string of base64 (live, 28 September 2026): a 64-byte Range read.
		const PNG = { ok: true as const, data: { bytes: "226956424f5277304b47676f414141414e53556845556741414174413d" } };
		const PDF = { ok: true as const, data: { bytes: "224a564245526930784c6a514b4a513d3d" } };
		const HEAD_READ = { server: RJ, tool: "jira_rest_attachment_head", args: { attachment_id: "202456" } };
		const accepted = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: untypedAttachments, [`${RJ}.jira_rest_attachment_head`]: PNG, [`${RJ}.jira_rest_comments_list`]: comments() });
		const dispatched = await previewOp("issue.comment.media", MEDIA, deps({ transport: accepted.transport }));
		expect(dispatched.outcome.cause).toBe("success");
		const preview = previewData(dispatched);
		expect(preview.baseline.effectIds).toEqual(["202456", "202457"]);
		expect(preview.baseline.revision).toMatch(/^[0-9a-f]{64}$/);
		expect((dispatched.outcome.data as { imageTypes: Record<string, string> }).imageTypes).toEqual({ "202456": "image/png", "202457": "image/png" });
		expect(accepted.calls).toEqual([ATTACH_READ, HEAD_READ, LIST_READ]);
		const refusedPdf = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: untypedAttachments, [`${RJ}.jira_rest_attachment_head`]: PDF });
		const pdf = await previewOp("issue.comment.media", MEDIA, deps({ transport: refusedPdf.transport }));
		expect([pdf.outcome.cause, pdf.outcome.detail]).toEqual(["input-invalid", "an image named in images is not an image attachment; only image content renders inline"]);
		expect(refusedPdf.calls.map((call) => call.tool)).toEqual(["jira_rest_issue_attachments", "jira_rest_attachment_head"]);
		const unreadable = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: untypedAttachments, [`${RJ}.jira_rest_attachment_head`]: failure("not-found") });
		const failedRead = await previewOp("issue.comment.media", MEDIA, deps({ transport: unreadable.transport }));
		expect([failedRead.outcome.cause]).toEqual(["not-found"]);
		expect(unreadable.calls.map((call) => call.tool)).toEqual(["jira_rest_issue_attachments", "jira_rest_attachment_head"]);
		// A 303 to the media host: the Provider refuses to follow it, so the transport reports an unclassified failure; a redirect page served as content is not an image either.
		const redirected = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: untypedAttachments, [`${RJ}.jira_rest_attachment_head`]: failure("failed-unknown") });
		const redirect = await previewOp("issue.comment.media", MEDIA, deps({ transport: redirected.transport }));
		expect([redirect.outcome.cause]).toEqual(["failed-unknown"]);
		const page = fakeTransport({ [`${RJ}.jira_rest_issue_attachments`]: untypedAttachments, [`${RJ}.jira_rest_attachment_head`]: { ok: true, data: { bytes: "3c21444f43545950452068746d6c3e3c68746d6c3e3c686561643e3c7469746c653e33303320536565204f746865723c2f7469746c653e" } } });
		const served = await previewOp("issue.comment.media", MEDIA, deps({ transport: page.transport }));
		expect([served.outcome.cause, served.outcome.detail]).toEqual(["input-invalid", "an image named in images is not an image attachment; only image content renders inline"]);
		expect(readJsonDir(previewsDir()).map((entry) => entry.previewId)).toEqual([preview.previewId]);
	});

	test("an edit refuses a comment another account authored before any send, binds the comment's updated, and completes only when read-back shows it moved and renders every image", async () => {
		const EDIT = { ...MEDIA, commentId: "454771" };
		let author = "712020:00000000-0000-4000-8000-00000000000b";
		let updated = "u1";
		let rendered = "<p>old text</p>";
		let body = "old text";
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachments`]: attachmentsReply(),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comment_get`]: () => ({ ok: true, data: { id: "454771", author: { accountId: author }, updated, body, renderedBody: rendered } }),
			[`${RJ}.jira_rest_comment_edit`]: () => {
				updated = "u2";
				rendered = BOTH;
				body = MEDIA.body;
				return { ok: true, data: { id: "454771", author: { accountId: ME }, updated, body, renderedBody: rendered } };
			},
		});
		const dependencies = deps({ transport });
		const guarded = await previewOp("issue.comment.media.update", EDIT, dependencies);
		expect([guarded.outcome.cause, guarded.outcome.detail]).toEqual(["input-invalid", "commentId names a comment another account authored; the media update edits only the principal's own comments"]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_rest_issue_attachments", "jira_rest_myself", "jira_rest_comment_get"]);
		expect(readJsonDir(previewsDir())).toEqual([]);
		author = ME;
		const preview = previewData(await previewOp("issue.comment.media.update", EDIT, dependencies));
		expect([preview.provider, preview.tool, preview.revision, preview.arguments]).toEqual(["rest", "jira_rest_comment_edit", "u1", { issue_key: "PROJ-1", comment_id: "454771", body: MEDIA.body }]);
		expect(preview.baseline).toMatchObject({ effectIds: ["202456", "202457"], commentIds: ["454771"] });
		const applied = await applyOp("issue.comment.media.update", EDIT, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-comment:454771"]]);
		// The edit reply alone never settles an update; the read-back after it did.
		expect(calls.map((call) => call.tool).slice(-2)).toEqual(["jira_rest_comment_edit", "jira_rest_comment_get"]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.provider, entry.status])).toEqual([["rest", "completed"]]);
	});

	test("an edit whose comment moved between preview and apply is refused before any send", async () => {
		const EDIT = { ...MEDIA, commentId: "454771" };
		let updated = "u1";
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachments`]: attachmentsReply(),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comment_get`]: () => ({ ok: true, data: { id: "454771", author: { accountId: ME }, updated, renderedBody: "<p>old</p>" } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.comment.media.update", EDIT, dependencies));
		updated = "u1b";
		const moved = await applyOp("issue.comment.media.update", EDIT, preview.previewId, dependencies);
		expect([moved.outcome.cause, moved.outcome.detail?.endsWith("preview-revision-changed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_rest_comment_edit")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
	});
});

// The attachment-delete exception: one attachment by id through the owned
// REST route. The preview binds the issue's updated, the attachment's
// filename, size, author, and created time; the author and reference guards
// refuse before any preview or send; completion comes only from the issue's
// attachment list no longer carrying the id. Reply shapes are Jira REST v2
// issue and comment reads as the media route observed them.
describe("attachment delete through the owned REST route", () => {
	const DELETE = { issueKey: "PROJ-1", attachmentId: "202456" };
	const ME = "712020:00000000-0000-4000-8000-00000000000a";
	const OTHER = "712020:00000000-0000-4000-8000-00000000000b";
	const record = (overrides: Record<string, unknown> = {}) => ({ id: "202456", filename: "before.png", size: 48123, mimeType: "image/png", created: "2026-09-28T01:02:03.000+1000", author: { accountId: ME, displayName: "Service" }, ...overrides });
	const other = { id: "202457", filename: "after.png", size: 10, created: "c2", author: { accountId: ME } };
	type IssueShape = { updated?: string; attachments?: unknown[]; description?: unknown; renderedDescription?: string | undefined; omitDescription?: boolean };
	const issue = ({ updated = "t1", attachments = [record(), other], description = "Plain description.", renderedDescription = "<p>Plain description.</p>", omitDescription = false }: IssueShape = {}) => ({
		ok: true as const,
		data: { key: "PROJ-1", fields: omitDescription ? { updated, attachment: attachments } : { updated, attachment: attachments, description }, ...(renderedDescription === undefined ? {} : { renderedFields: { description: renderedDescription } }) },
	});
	const comments = (...entries: Record<string, unknown>[]) => ({ ok: true as const, data: { startAt: 0, maxResults: 100, total: entries.length, comments: entries } });
	const myself = { ok: true as const, data: { accountId: ME, emailAddress: PRINCIPAL } };
	const CONTEXT_READ = { server: RJ, tool: "jira_rest_issue_attachment_context", args: { issue_key: "PROJ-1" } };
	const ME_READ = { server: RJ, tool: "jira_rest_myself", args: {} };
	const LIST_READ = { server: RJ, tool: "jira_rest_comments_list", args: { issue_key: "PROJ-1" } };
	const ATTACH_READ = { server: RJ, tool: "jira_rest_issue_attachments", args: { issue_key: "PROJ-1" } };
	const SEND = { server: RJ, tool: "jira_rest_attachment_delete", args: { issue_key: "PROJ-1", attachment_id: "202456" } };
	const attachmentsOf = (data: { data: { key: string; fields: { updated: string; attachment: unknown[] } } }) => ({ ok: true as const, data: { key: data.data.key, fields: { updated: data.data.fields.updated, attachment: data.data.fields.attachment } } });

	test("preview binds the issue's updated and the attachment's facts, reports the reference check, and sends nothing; apply refuses when the attachment or the issue moved, then completes only from a read-back that no longer lists the id", async () => {
		let live = issue();
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachment_context`]: () => live,
			[`${RJ}.jira_rest_issue_attachments`]: () => attachmentsOf(live),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comments_list`]: comments({ id: "900", body: "Looks fine.", renderedBody: "<p>Looks fine.</p>" }),
			// Jira answers a delete with 204 and no body; the reply proves nothing on its own.
			[`${RJ}.jira_rest_attachment_delete`]: () => {
				live = issue({ updated: "t2", attachments: [other] });
				return { ok: true, data: null };
			},
		});
		const dependencies = deps({ transport });
		const dispatched = await previewOp("issue.attachment.delete", DELETE, dependencies);
		expect(dispatched.outcome.cause).toBe("success");
		const preview = previewData(dispatched);
		expect([preview.provider, preview.server, preview.tool, preview.objectIdentity, preview.revision, preview.arguments]).toEqual(["rest", RJ, "jira_rest_attachment_delete", "issue:PROJ-1", "t1", { issue_key: "PROJ-1", attachment_id: "202456" }]);
		expect(preview.baseline).toMatchObject({ effectIds: ["202456"], commentIds: [] });
		expect(preview.baseline.revision).toMatch(/^[0-9a-f]{64}$/);
		const data = dispatched.outcome.data as { attachment: unknown; referenceCheck: unknown };
		expect(data.attachment).toEqual({ id: "202456", filename: "before.png", size: 48123, authorAccountId: ME, created: "2026-09-28T01:02:03.000+1000" });
		expect(data.referenceCheck).toEqual({ description: true, commentsRead: 1, commentsTotal: 1, references: [] });
		expect(calls).toEqual([CONTEXT_READ, ME_READ, LIST_READ, ATTACH_READ]);
		expect(readJsonDir(previewsDir()).map((entry) => [entry.provider, entry.status, entry.baseline])).toEqual([["rest", "open", preview.baseline]]);
		// The attachment was replaced under the same id with other bytes: a bound fact moved, so nothing is sent.
		live = issue({ attachments: [record({ size: 99 }), other] });
		const resized = await applyOp("issue.attachment.delete", DELETE, preview.previewId, dependencies);
		expect([resized.outcome.cause, resized.outcome.detail?.endsWith("preview-baseline-changed")]).toEqual(["refused-preview", true]);
		// The issue moved (another edit): the bound updated moved, so nothing is sent.
		live = issue({ updated: "t1b" });
		const movedIssue = await applyOp("issue.attachment.delete", DELETE, preview.previewId, dependencies);
		expect([movedIssue.outcome.cause, movedIssue.outcome.detail?.endsWith("preview-revision-changed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_rest_attachment_delete")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
		live = issue();
		const applied = await applyOp("issue.attachment.delete", DELETE, preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-attachment:202456"]]);
		expect(calls.filter((call) => call.tool === "jira_rest_attachment_delete")).toEqual([SEND]);
		// The delete reply never settles the write; the read-back after it did.
		expect(calls.slice(-2)).toEqual([SEND, ATTACH_READ]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.provider, entry.status, entry.effects])).toEqual([["rest", "completed", [{ kind: "jira-attachment", id: "202456" }]]]);
		expect(applied.provenance.every((entry) => entry.provider === RJ)).toBe(true);
	});

	test("an attachment another account uploaded is refused before any comment is read, at preview and at apply, and no preview or receipt is recorded", async () => {
		let author = OTHER;
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachment_context`]: () => issue({ attachments: [record({ author: { accountId: author } }), other] }),
			[`${RJ}.jira_rest_issue_attachments`]: () => issue({ attachments: [record({ author: { accountId: author } }), other] }),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comments_list`]: comments(),
		});
		const dependencies = deps({ transport });
		const guarded = await previewOp("issue.attachment.delete", DELETE, dependencies);
		expect([guarded.outcome.cause, guarded.outcome.detail]).toEqual(["input-invalid", "attachmentId names an attachment another account uploaded; the attachment delete removes only the principal's own uploads"]);
		expect(calls).toEqual([CONTEXT_READ, ME_READ]);
		expect(readJsonDir(previewsDir())).toEqual([]);
		// The upload is the principal's at preview, then Jira reports another author at apply: refused again, before any send.
		author = ME;
		const preview = previewData(await previewOp("issue.attachment.delete", DELETE, dependencies));
		author = OTHER;
		const applied = await applyOp("issue.attachment.delete", DELETE, preview.previewId, dependencies);
		expect(applied.outcome.cause).toBe("input-invalid");
		expect(calls.filter((call) => call.tool === "jira_rest_attachment_delete")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
		// A principal read without an account id cannot decide; nothing is sent.
		const unverifiable = fakeTransport({ [`${RJ}.jira_rest_issue_attachment_context`]: issue(), [`${RJ}.jira_rest_myself`]: { ok: true, data: { emailAddress: PRINCIPAL } } });
		const undecided = await previewOp("issue.attachment.delete", DELETE, deps({ transport: unverifiable.transport }));
		expect([undecided.outcome.cause, undecided.outcome.detail]).toEqual(["capability-unavailable", "the principal read exposes no account id for the author guard"]);
	});

	test("an attachment still referenced by the description or a comment, by file name or by id, refuses before any send; an incomplete comment list refuses rather than clears", async () => {
		const attempt = async (shape: IssueShape, ...listed: Record<string, unknown>[]) => {
			const { transport, calls } = fakeTransport({ [`${RJ}.jira_rest_issue_attachment_context`]: issue(shape), [`${RJ}.jira_rest_issue_attachments`]: attachmentsOf(issue(shape)), [`${RJ}.jira_rest_myself`]: myself, [`${RJ}.jira_rest_comments_list`]: comments(...listed) });
			const dispatched = await previewOp("issue.attachment.delete", DELETE, deps({ transport }));
			return [dispatched.outcome.cause, dispatched.outcome.detail, calls.map((call) => call.tool)];
		};
		const clean = { id: "900", body: "Looks fine.", renderedBody: "<p>Looks fine.</p>" };
		const reads = ["jira_rest_issue_attachment_context", "jira_rest_myself", "jira_rest_comments_list"];
		// A wiki image macro in a comment names the file.
		expect(await attempt({}, clean, { id: "901", body: "Before:\n\n!before.png|width=600!", renderedBody: '<p>Before:</p><p><img src="/rest/api/3/attachment/content/202456" alt="before.png"></p>' })).toEqual(["input-invalid", "the attachment is still referenced by comment 901; remove the reference first", reads]);
		// A rendered ADF media reference carries the id but not the name.
		expect(await attempt({}, { id: "902", body: "See the shot.", renderedBody: '<p>See the shot.</p><span class="image-wrap"><img src="https://example.atlassian.net/secure/attachment/202456/x"></span>' })).toEqual(["input-invalid", "the attachment is still referenced by comment 902; remove the reference first", reads]);
		// The description in wiki text, and every referencing source is named.
		expect(await attempt({ description: "Repro: [^before.png]" }, clean, { id: "903", body: "!before.png!", renderedBody: "" })).toEqual(["input-invalid", "the attachment is still referenced by description, comment 903; remove the reference first", reads]);
		// The rendered description alone counts too.
		expect(await attempt({ renderedDescription: '<a href="/secure/attachment/202456/before.png">shot</a>' })).toEqual(["input-invalid", "the attachment is still referenced by description; remove the reference first", reads]);
		// Another file's name that merely contains this one, another id, and the bare number in prose are not references.
		expect((await attempt({}, { id: "904", body: "See !new-before.png! and !before.png.bak! (build 202456 passed; /rest/api/3/attachment/content/2024567)", renderedBody: '<img src="/rest/api/3/attachment/content/202457">' }))[0]).toBe("success");
		// Repair round 1, finding 1: an ADF media node in the description or a comment, with no rendered HTML, still names the attachment.
		const adf = (attrs: Record<string, unknown>) => ({ type: "doc", version: 1, content: [{ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs }] }] });
		expect(await attempt({ description: adf({ id: "202456", type: "file", collection: "jira-10001" }), renderedDescription: undefined }, clean)).toEqual(["input-invalid", "the attachment is still referenced by description; remove the reference first", reads]);
		expect(await attempt({}, clean, { id: "905", body: adf({ id: "9f1b3f0a-0000-4000-8000-000000000001", type: "file", collection: "jira-10001", alt: "before.png" }) })).toEqual(["input-invalid", "the attachment is still referenced by comment 905; remove the reference first", reads]);
		expect((await attempt({ description: adf({ id: "202457", type: "file", collection: "jira-10001", alt: "after.png" }), renderedDescription: undefined }, { id: "906", body: adf({ id: "1", type: "file", collection: "c" }) }))[0]).toBe("success");
		// Repair round 1, finding 2: content that was not read never counts as checked.
		expect(await attempt({ omitDescription: true, renderedDescription: undefined }, clean)).toEqual(["capability-unavailable", "the issue read exposes no description field; the reference guard cannot clear the attachment", ["jira_rest_issue_attachment_context"]]);
		expect(await attempt({}, clean, { id: "907", updated: "u1" })).toEqual(["capability-unavailable", "comment 907 carries no body; the reference guard cannot clear the attachment", reads]);
		expect((await attempt({ description: null, renderedDescription: undefined }, clean, { id: "908", body: "" }))[0]).toBe("success");
		// More comments than the guard read: it cannot clear the attachment.
		const truncated = fakeTransport({ [`${RJ}.jira_rest_issue_attachment_context`]: issue(), [`${RJ}.jira_rest_myself`]: myself, [`${RJ}.jira_rest_comments_list`]: { ok: true, data: { startAt: 0, maxResults: 100, total: 101, comments: Array.from({ length: 100 }, (_entry, index) => ({ id: String(1000 + index), body: "x", renderedBody: "<p>x</p>" })) } } });
		const incomplete = await previewOp("issue.attachment.delete", DELETE, deps({ transport: truncated.transport }));
		expect([incomplete.outcome.cause, incomplete.outcome.detail]).toEqual(["capability-unavailable", "the issue has 101 comments and the reference guard read 100; it cannot clear the attachment"]);
		expect(readJsonDir(previewsDir()).map((entry) => entry.objectIdentity)).toEqual(["issue:PROJ-1", "issue:PROJ-1", "issue:PROJ-1"]);
	});

	test("an attachment the issue does not carry refuses as not-found; a record missing a bound fact refuses before any guard read; a filename or bulk form is an input refusal before any read", async () => {
		const { transport, calls } = fakeTransport({ [`${RJ}.jira_rest_issue_attachment_context`]: issue({ attachments: [other, { id: "202456", filename: "before.png" }] }), [`${RJ}.jira_rest_myself`]: myself });
		const dependencies = deps({ transport });
		const missing = await previewOp("issue.attachment.delete", { issueKey: "PROJ-1", attachmentId: "999" }, dependencies);
		expect([missing.outcome.cause, missing.outcome.detail]).toEqual(["not-found", "the issue has no attachment with that id"]);
		const unbound = await previewOp("issue.attachment.delete", DELETE, dependencies);
		expect([unbound.outcome.cause, unbound.outcome.detail]).toEqual(["capability-unavailable", "the attachment record exposes no filename, size, author account id, or created time to bind"]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_rest_issue_attachment_context", "jira_rest_issue_attachment_context"]);
		for (const input of [{ issueKey: "PROJ-1", filename: "before.png" }, { issueKey: "PROJ-1", attachmentId: ["202456", "202457"] }, { issueKey: "PROJ-1", attachmentId: "*" }, { issueKey: "PROJ-1" }, { attachmentId: "202456" }]) {
			expect([input, refusal({ tenant: TENANT, kind: "preview", spec: OPERATION_SPECS["issue.attachment.delete"], input })]).toEqual([input, "input-invalid"]);
		}
		expect(calls).toHaveLength(2);
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	// Repair round 1, finding 3: a lost reply whose read-back succeeds settles
	// unchanged only when the attachment is still listed and the issue's
	// updated is the bound one; a moved issue keeps the receipt open for
	// adjudication, and a vanished attachment completes it.
	test("a lost reply with a successful read-back settles unchanged only at the bound issue updated, stays unknown when the issue moved, and completes when the attachment is gone", async () => {
		let updated = "t1";
		let listed = true;
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachment_context`]: () => issue({ updated }),
			[`${RJ}.jira_rest_issue_attachments`]: () => attachmentsOf(issue({ updated, attachments: listed ? [record(), other] : [other] })),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comments_list`]: comments(),
			[`${RJ}.jira_rest_attachment_delete`]: failure("failed-transport"),
		});
		const dependencies = deps({ transport });
		// Still listed at the bound updated: nothing landed, and the receipt closes.
		const first = previewData(await previewOp("issue.attachment.delete", DELETE, dependencies));
		const unchanged = await applyOp("issue.attachment.delete", DELETE, first.previewId, dependencies);
		expect([unchanged.outcome.cause, unchanged.outcome.transactionState, effectIds(unchanged)]).toEqual(["failed-transport", "unchanged", []]);
		const closed = await showReceipt((unchanged.outcome.data as { runId: string }).runId, dependencies);
		expect([(closed.outcome.data as { status: string; basis: string; send: string }).status, (closed.outcome.data as { basis: string }).basis, (closed.outcome.data as { send: string }).send]).toEqual(["unchanged", "revision-unchanged", "possible"]);
		expect((await listReceipts(dependencies)).outcome.data).toEqual({ open: [] });
		// Still listed but the issue moved during the send: presence alone is not proof, so the receipt stays open and blocks the issue.
		const second = previewData(await previewOp("issue.attachment.delete", DELETE, dependencies));
		const { transport: moving } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachment_context`]: () => issue({ updated }),
			[`${RJ}.jira_rest_issue_attachments`]: () => attachmentsOf(issue({ updated, attachments: listed ? [record(), other] : [other] })),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comments_list`]: comments(),
			[`${RJ}.jira_rest_attachment_delete`]: () => {
				updated = "t2";
				return failure("failed-transport");
			},
		});
		const moved = await applyOp("issue.attachment.delete", DELETE, second.previewId, deps({ transport: moving }));
		expect([moved.outcome.cause, moved.outcome.transactionState, blockedObject(moved)]).toEqual(["outcome-unknown", "unknown", "issue:PROJ-1"]);
		const runId = (moved.outcome.data as { runId: string }).runId;
		const stillMoved = await adjudicateRun(runId, DELETE, dependencies);
		expect([stillMoved.outcome.cause, stillMoved.outcome.detail?.endsWith("evidence-insufficient")]).toEqual(["refused-evidence", true]);
		expect((await listReceipts(dependencies)).outcome.data).toEqual({ open: [expect.objectContaining({ runId, status: "unknown" })] });
		// The attachment is gone on a later read: the effect is found and the receipt completes.
		listed = false;
		const resolved = await adjudicateRun(runId, DELETE, dependencies);
		expect([resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["completed", ["jira-attachment:202456"]]);
		expect(calls.filter((call) => call.tool === "jira_rest_attachment_delete")).toHaveLength(1);
	});

	test("a lost reply with a failed read-back blocks the issue as outcome-unknown; adjudication completes only when the attachment list no longer carries the id, and settles unchanged while it still does", async () => {
		let listed = true;
		// The transport drops from the delete onward: the delete reply is lost and the immediate read-back fails too.
		let dropped = false;
		const { transport, calls } = fakeTransport({
			[`${RJ}.jira_rest_issue_attachment_context`]: () => issue(),
			[`${RJ}.jira_rest_issue_attachments`]: () => (dropped ? failure("failed-transport") : attachmentsOf(issue({ attachments: listed ? [record(), other] : [other] }))),
			[`${RJ}.jira_rest_myself`]: myself,
			[`${RJ}.jira_rest_comments_list`]: comments(),
			[`${RJ}.jira_rest_attachment_delete`]: () => {
				dropped = true;
				return failure("failed-transport");
			},
		});
		const dependencies = deps({ transport });
		const preview = previewData(await previewOp("issue.attachment.delete", DELETE, dependencies));
		const applied = await applyOp("issue.attachment.delete", DELETE, preview.previewId, dependencies);
		expect([applied.outcome.cause, applied.outcome.transactionState, blockedObject(applied)]).toEqual(["outcome-unknown", "unknown", "issue:PROJ-1"]);
		const runId = (applied.outcome.data as { runId: string }).runId;
		// Every write on the issue is blocked while the receipt is open.
		const blocked = await previewOp("issue.comment.media", { issueKey: "PROJ-1", body: "!after.png!", images: ["after.png"] }, dependencies);
		expect(blocked.outcome.cause).not.toBe("outcome-unknown");
		const stillOpen = await listReceipts(dependencies);
		expect((stillOpen.outcome.data as { open: { runId: string }[] }).open.map((entry) => entry.runId)).toEqual([runId]);
		// The list still carries the id: the delete did not land, and the receipt settles unchanged.
		dropped = false;
		const unchanged = await adjudicateRun(runId, DELETE, dependencies);
		expect([unchanged.outcome.transactionState, effectIds(unchanged), (unchanged.outcome.data as { basis: string }).basis]).toEqual(["unchanged", [], "revision-unchanged"]);
		// A second lost delete, then the list no longer carries the id: adjudication completes it.
		const again = previewData(await previewOp("issue.attachment.delete", DELETE, dependencies));
		const lost = await applyOp("issue.attachment.delete", DELETE, again.previewId, dependencies);
		expect(lost.outcome.cause).toBe("outcome-unknown");
		dropped = false;
		listed = false;
		const resolved = await adjudicateRun((lost.outcome.data as { runId: string }).runId, DELETE, dependencies);
		expect([resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["completed", ["jira-attachment:202456"]]);
		expect(calls.filter((call) => call.tool === "jira_rest_attachment_delete")).toHaveLength(2);
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status).sort()).toEqual(["completed", "unchanged"]);
	});
});

describe("issue.create under a parent", () => {
	const CHILD = { projectKey: "PROJ", issueType: "Story", summary: "Path Design System Components/ErrorBanner", parentKey: "PROJ-546" };
	// Independent oracles: the literal provider arguments, reads, and bound parent.
	const PARENT_READ = { issue_key: "PROJ-546", fields: "summary,issuetype,project" };
	const SCOPED_SEARCH = { jql: 'project = "PROJ" AND parent = "PROJ-546" AND summary ~ "Path Design System Components/ErrorBanner" ORDER BY created DESC', limit: 20, fields: "summary,issuetype,created,parent" };
	const CREATE_ARGS = { project_key: "PROJ", issue_type: "Story", summary: CHILD.summary, additional_fields: '{"parent":"PROJ-546"}' };
	const CREATED_READ = { issue_key: "PROJ-9", fields: "summary,issuetype,project,parent" };
	const BOUND = { key: "PROJ-546", id: "10546", issueType: "Epic" };
	const BOUND_DIGEST = new Bun.CryptoHasher("sha256").update(JSON.stringify(["PROJ-546", "10546", "Epic"])).digest("hex");
	const epic = (type = "Epic") => ({ ok: true as const, data: { id: "10546", key: "PROJ-546", summary: "Path Design System", issue_type: { name: type }, project: { key: "PROJ" } } });
	const created = (parent: unknown) => ({ ok: true as const, data: { id: "10009", key: "PROJ-9", summary: CHILD.summary, issue_type: { name: "Story" }, project: { key: "PROJ" }, ...(parent === null ? {} : { parent }) } });
	const search = (issues: unknown[], page: Record<string, unknown> = {}) => ({ ok: true as const, data: { total: -1, start_at: 0, max_results: 20, issues, ...page } });
	const listed = (parent: unknown) => ({ id: "10009", key: "PROJ-9", summary: CHILD.summary, issue_type: { name: "Story" }, ...(parent === null ? {} : { parent }) });
	const CREATE_REPLY = { ok: true as const, data: { message: "Issue created successfully", issue: { id: "10009", key: "PROJ-9", summary: CHILD.summary, issue_type: { name: "Story" }, parent: { key: "PROJ-546" } } } };
	const byKey = (replies: Record<string, TransportResult | (() => TransportResult)>) => (args: Record<string, unknown>): TransportResult => {
		const reply = replies[args.issue_key as string];
		if (reply === undefined) return failure("not-found");
		return typeof reply === "function" ? reply() : reply;
	};
	const createPreview = (dependencies: Dependencies, input: unknown = CHILD) => previewOp("issue.create", input, dependencies);
	const createApply = (previewId: string, dependencies: Dependencies, input: unknown = CHILD) => applyOp("issue.create", input, previewId, dependencies);

	test("preview reads and binds the parent, runs the parent-scoped duplicate search, keeps the unchanged create identity, and sends nothing", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": epic() }), [`${CJ}.jira_search`]: search([]) });
		const dispatched = await createPreview(deps({ transport }));
		expect([dispatched.outcome.cause]).toEqual(["success"]);
		const data = previewData(dispatched) as ReturnType<typeof previewData> & { parent: unknown };
		expect([data.tool, data.arguments, data.parent, data.baseline]).toEqual(["jira_create_issue", CREATE_ARGS, BOUND, { effectIds: [], commentIds: [], revision: BOUND_DIGEST }]);
		// The Object Identity is the pre-parent create identity: parent is not part of it.
		const { parentKey: _omitted, ...plain } = CHILD;
		expect(data.objectIdentity).toBe(`project:PROJ:create:story:${new Bun.CryptoHasher("sha256").update("path design system components/errorbanner").digest("hex").slice(0, 16)}`);
		expect(data.objectIdentity).toBe(previewData(await createPreview(deps({ transport: fakeTransport({ [`${CJ}.jira_search`]: { ok: true, data: { issues: [] } } }).transport }), plain)).objectIdentity);
		expect(calls).toEqual([{ server: CJ, tool: "jira_get_issue", args: PARENT_READ }, { server: CJ, tool: "jira_search", args: SCOPED_SEARCH }]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
	});

	test("apply sends the parent once and completes only from the created issue's own read showing its summary, type, and parent", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": epic(), "PROJ-9": created({ id: "10546", key: "PROJ-546" }) }), [`${CJ}.jira_search`]: search([]), [`${CJ}.jira_create_issue`]: CREATE_REPLY });
		const dependencies = deps({ transport });
		const preview = previewData(await createPreview(dependencies));
		const applied = await createApply(preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-issue:PROJ-9"]]);
		const tools = calls.map((call) => call.tool);
		expect(calls.filter((call) => call.tool === "jira_create_issue")).toEqual([{ server: CJ, tool: "jira_create_issue", args: CREATE_ARGS }]);
		expect(calls.slice(tools.indexOf("jira_create_issue") + 1)).toEqual([{ server: CJ, tool: "jira_get_issue", args: CREATED_READ }]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.status, entry.send, entry.effects])).toEqual([["completed", "possible", [{ kind: "jira-issue", id: "PROJ-9" }]]]);
	});

	test("a reply that names no key settles from the parent-scoped search read-back", async () => {
		let searches = 0;
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": epic() }), [`${CJ}.jira_search`]: () => (searches++ >= 2 ? search([listed({ key: "PROJ-546" })]) : search([])), [`${CJ}.jira_create_issue`]: { ok: true, data: { message: "Issue created successfully" } } });
		const dependencies = deps({ transport });
		const preview = previewData(await createPreview(dependencies));
		const applied = await createApply(preview.previewId, dependencies);
		expect([applied.outcome.transactionState, effectIds(applied)]).toEqual(["completed", ["jira-issue:PROJ-9"]]);
		const tools = calls.map((call) => call.tool);
		expect(calls.slice(tools.indexOf("jira_create_issue") + 1)).toEqual([{ server: CJ, tool: "jira_search", args: SCOPED_SEARCH }]);
	});

	test.each([
		["carries no parent", null],
		["names another parent", { key: "PROJ-600" }],
	])("a created issue that %s leaves the receipt outcome-unknown, blocks a retry, and adjudicates only once the scoped search shows the parent", async (_case, parent) => {
		let adjudicating = false;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": epic(), "PROJ-9": created(parent) }),
			[`${CJ}.jira_search`]: () => (adjudicating ? search([listed({ key: "PROJ-546" })]) : search([])),
			[`${CJ}.jira_create_issue`]: CREATE_REPLY,
		});
		const dependencies = deps({ transport });
		const preview = previewData(await createPreview(dependencies));
		const applied = await createApply(preview.previewId, dependencies);
		expect([applied.outcome.cause, applied.outcome.transactionState, effectIds(applied)]).toEqual(["outcome-unknown", "unknown", []]);
		const runId = (applied.outcome.data as { runId: string }).runId;
		expect((await showReceipt(runId, dependencies)).outcome.data).toMatchObject({ status: "unknown", send: "possible" });
		// A retry of the same create is refused before any second send.
		const retry = previewData(await createPreview(dependencies));
		const blocked = await createApply(retry.previewId, dependencies);
		expect([blocked.outcome.cause, blocked.outcome.detail?.endsWith("write-blocked-open-receipt")]).toEqual(["refused-write-blocked", true]);
		expect(calls.filter((call) => call.tool === "jira_create_issue")).toHaveLength(1);
		// Adjudication without the parent in the scoped search leaves the object blocked.
		const unresolved = await adjudicateRun(runId, CHILD, dependencies);
		expect(unresolved.outcome.cause).toBe("refused-evidence");
		adjudicating = true;
		const resolved = await adjudicateRun(runId, CHILD, dependencies);
		expect([resolved.outcome.transactionState, effectIds(resolved)]).toEqual(["completed", ["jira-issue:PROJ-9"]]);
	});

	test("a missing parent refuses as not-found before any search, preview, or send", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({}) });
		const refused = await createPreview(deps({ transport }));
		expect([refused.outcome.cause, refused.outcome.detail]).toEqual(["not-found", REPAIR["not-found"]]);
		expect(calls).toEqual([{ server: CJ, tool: "jira_get_issue", args: PARENT_READ }]);
		expect([readJsonDir(previewsDir()), readJsonDir(receiptsDir())]).toEqual([[], []]);
	});

	test("a parent retyped or deleted between preview and apply refuses the apply before any send", async () => {
		let parent: TransportResult = epic();
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": () => parent }), [`${CJ}.jira_search`]: search([]), [`${CJ}.jira_create_issue`]: CREATE_REPLY });
		const dependencies = deps({ transport });
		const preview = previewData(await createPreview(dependencies));
		parent = epic("Feature");
		const retyped = await createApply(preview.previewId, dependencies);
		expect([retyped.outcome.cause, retyped.outcome.detail?.endsWith("preview-baseline-changed")]).toEqual(["refused-preview", true]);
		parent = failure("not-found");
		const deleted = await createApply(preview.previewId, dependencies);
		expect(deleted.outcome.cause).toBe("not-found");
		expect(calls.filter((call) => call.tool === "jira_create_issue")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
	});

	test("the duplicate check refuses a same-parent match by key and a truncated search; a match elsewhere in the project does not refuse", async () => {
		const duplicate = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": epic() }), [`${CJ}.jira_search`]: search([{ ...listed({ key: "PROJ-546" }), key: "PROJ-12" }]) });
		const refused = await createPreview(deps({ transport: duplicate.transport }));
		expect([refused.outcome.cause, refused.outcome.detail]).toEqual(["input-invalid", "the parent already has a Story with this summary: PROJ-12; reuse it instead of creating a duplicate"]);
		const truncated = fakeTransport({ [`${CJ}.jira_get_issue`]: byKey({ "PROJ-546": epic() }), [`${CJ}.jira_search`]: search([], { next_page_token: "next" }) });
		const partial = await createPreview(deps({ transport: truncated.transport }));
		expect([partial.outcome.cause, partial.outcome.detail?.startsWith("the parent's issue search returned only part of its matches")]).toEqual(["capability-unavailable", true]);
		expect([...duplicate.calls, ...truncated.calls].filter((call) => call.tool === "jira_create_issue")).toEqual([]);
		expect(readJsonDir(previewsDir())).toEqual([]);
		// Control: the scoped search is the Provider's filter; without a parent the same project match is only a baseline id.
		const { parentKey: _omitted, ...plain } = CHILD;
		const project = fakeTransport({ [`${CJ}.jira_search`]: search([{ ...listed(null), key: "PROJ-12" }]) });
		const planned = previewData(await createPreview(deps({ transport: project.transport }), plain));
		expect(planned.baseline.effectIds).toEqual(["PROJ-12"]);
	});

	test("a live schema without additional_fields refuses a parent create before any call", async () => {
		const withoutParent = SCHEMAS[CJ]!.map((entry) => (entry.name === "jira_create_issue" ? tool("jira_create_issue", ["project_key", "summary", "issue_type"], ["description", "assignee"]) : entry));
		const { transport, calls } = fakeTransport({}, { [CJ]: withoutParent });
		const refused = await createPreview(deps({ transport }));
		expect([refused.outcome.cause, refused.outcome.detail]).toEqual(["capability-unavailable", REPAIR["capability-unavailable"]]);
		expect(calls).toEqual([]);
	});
});

describe("historical records from the retired Official route", () => {
	const COMMENT = { issueKey: "PROJ-1", body: "recorded through the retired route" };
	const OFFICIAL_ARGS = { cloudId: "cloud-example", issueIdOrKey: "PROJ-1", commentBody: COMMENT.body };
	const fileBytes = (directory: string) => Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]));

	// A preview and an unresolved receipt persisted the way the retired route
	// persisted them: the journal writes what it is given, and only reads
	// validate the Provider name against the closed persisted vocabulary.
	async function historical(dependencies: Dependencies) {
		const journal = dependencies.journal("example");
		const retired = RETIRED as unknown as ProviderName;
		const preview = journal.recordPreview({ operation: "issue.comment", provider: retired, canonicalInput: COMMENT, providerArgs: OFFICIAL_ARGS, revision: null });
		const receipt = await journal.apply({ previewId: preview.previewId, provider: retired, canonicalInput: COMMENT, providerArgs: OFFICIAL_ARGS, revision: null }, async (_intent, sending) => {
			sending();
			return { proof: "unknown" };
		});
		const openPreview = journal.recordPreview({ operation: "issue.comment", provider: retired, canonicalInput: { ...COMMENT, body: "a second retired preview" }, providerArgs: { ...OFFICIAL_ARGS, commentBody: "a second retired preview" }, revision: null });
		return { preview, receipt, openPreview };
	}

	test("an unresolved Official receipt stays readable, keeps blocking its object, and is refused by adjudicate and unlock without any provider call", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "10001", body: COMMENT.body }] } } } } });
		seen.length = 0;
		const dependencies = deps({ transport });
		const { receipt } = await historical(dependencies);
		const before = { receipts: fileBytes(receiptsDir()), previews: fileBytes(previewsDir()) };
		const listed = await listReceipts(dependencies);
		expect((listed.outcome.data as { open: { runId: string; provider: string; status: string; send: string }[] }).open.map((entry) => [entry.runId, entry.provider, entry.status, entry.send])).toEqual([[receipt.runId, RETIRED, "unknown", "possible"]]);
		const shown = await showReceipt(receipt.runId, dependencies);
		expect([(shown.outcome.data as { provider: string; status: string }).provider, (shown.outcome.data as { status: string }).status]).toEqual([RETIRED, "unknown"]);
		// Adjudication would read back through the active route with the
		// active tool vocabulary; the receipt names a route that no longer
		// exists, so it is refused before any binding or call.
		const adjudicated = await adjudicateRun(receipt.runId, COMMENT, dependencies);
		expect([adjudicated.outcome.cause, adjudicated.outcome.detail]).toEqual(["refused-state", `${REPAIR["refused-state"]}; receipt-provider-retired`]);
		const unlocked = await unlockRun(receipt.runId, dependencies);
		expect([unlocked.outcome.cause, unlocked.outcome.detail]).toEqual(["refused-state", `${REPAIR["refused-state"]}; receipt-provider-retired`]);
		expect(calls).toEqual([]);
		expect(seen).toEqual([]);
		// A new Community write on the same object is blocked by the open receipt.
		const blockedPreview = previewData(await previewOp("issue.comment", { issueKey: "PROJ-1", body: "a new community comment" }, dependencies));
		expect(blockedPreview.provider).toBe("community");
		const blocked = await applyOp("issue.comment", { issueKey: "PROJ-1", body: "a new community comment" }, blockedPreview.previewId, dependencies);
		expect([blocked.outcome.cause, blocked.outcome.detail?.endsWith("write-blocked-open-receipt")]).toEqual(["refused-write-blocked", true]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue"]);
		// The historical records are byte-for-byte untouched.
		expect(fileBytes(receiptsDir())).toEqual(before.receipts);
		for (const [name, bytes] of Object.entries(before.previews)) expect(fileBytes(previewsDir())[name]).toBe(bytes);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.provider, entry.status])).toEqual([[RETIRED, "unknown"]]);
	});

	test("an open Official preview is refused by apply and unlock, never re-shaped for the Community tool", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: { ok: true, data: { id: "10002", body: COMMENT.body } } });
		const dependencies = deps({ transport });
		const { openPreview } = await historical(dependencies);
		const before = fileBytes(previewsDir());
		const secondInput = { ...COMMENT, body: "a second retired preview" };
		const applied = await applyOp("issue.comment", secondInput, openPreview.previewId, dependencies);
		expect([applied.outcome.cause, applied.outcome.detail]).toEqual(["refused-preview", `${REPAIR["refused-preview"]}; preview-provider-retired`]);
		// Refused before any binding or provider call: the retired provider is read
		// from the preview itself, ahead of the preparatory jira_get_issue read.
		expect(calls).toEqual([]);
		const unlocked = await unlockRun(openPreview.previewId, dependencies);
		expect([unlocked.outcome.cause, unlocked.outcome.detail]).toEqual(["refused-preview", `${REPAIR["refused-preview"]}; preview-provider-retired`]);
		expect(fileBytes(previewsDir())).toEqual(before);
		expect(readJsonDir(previewsDir()).map((entry) => [entry.provider, entry.status]).sort()).toEqual([[RETIRED, "consumed"], [RETIRED, "open"]]);
		expect(readJsonDir(receiptsDir()).filter((entry) => entry.provider === "community")).toEqual([]);
	});
});

describe("production adapters", () => {
	// Public processes and the copy's own modules over the 1Password custody
	// fixture, all from the substituted plugin copy (see plugin-copy.ts): the
	// test Keychain reader and plugin-owned op and uv fakes. Every packaged
	// route claim lives in packaged.test.ts; these rows own the route registry
	// gate, staging, and the retired Bun entry.
	let fixture: CustodyFixture;
	// The copy's transport, so any Provider preflight it could start is the copy's.
	let routeTransport: typeof import("../scripts/dispatch/runtime.ts").routeTransport;
	beforeEach(async () => {
		({ routeTransport } = (await import(path.join(substitutedPluginRoot(), "skills", "atlassian", "scripts", "dispatch", "runtime.ts"))) as typeof import("../scripts/dispatch/runtime.ts"));
		fixture = new CustodyFixture().installAll();
		for (const [product, server] of [["jira", CJ], ["confluence", CC]] as const) fixture.canned(product, "list", (SCHEMAS[server] ?? []).map((entry) => ({ ...entry, description: entry.name, inputSchema: { type: "object", ...entry.inputSchema } })));
	});
	afterEach(() => fixture.dispose());
	const env = () => fixture.environment();
	const capabilities = (): ExecutionCapabilities => ({
		selectMcporter: async () => { throw new Error("this supporting test must refuse before MCPorter selection"); },
		internalCommand: (role) => [path.join(fixture.pluginRoot, "bin", "connectors"), "__internal", "atlassian", role],
	});

	// No-bypass: dispatcher and REST modules are no longer entries. Bun running them
	// directly on a fully provisioned, registered machine (Keychain token, op,
	// uv, item, and canned schema all present, so a live entry would reach each)
	// prints nothing, exits 0, and reads no credential or starts no route.
	test.each(["atlassian-dispatch.ts", "atlassian-rest-provider.ts"])("no-bypass: bun running retired %s as an entry does nothing on a provisioned, registered machine", async (script) => {
		fixture.writeItem({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN });
		fixture.canned("jira", "jira_get_issue", { key: "EX-1", summary: "canned" });
		const proc = Bun.spawn([process.execPath, path.join(fixture.skill, "scripts", script), "--tenant", "example", "issue.get", "--input", '{"issueKey":"EX-1"}'], { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		expect([code, stdout, stderr]).toEqual([0, "", ""]);
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl"), fixture.lines("effects.jsonl")]).toEqual([[], [], [], []]);
		expect([fixture.lines("hostile-mcporter.jsonl"), fixture.lines("hostile-recorders.jsonl")]).toEqual([[], []]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
	}, 30_000);

	test("route registry and selector planning refuse before a Provider preflight process starts", async () => {
		const binding = { principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN, item: ITEM_ID };
		const validRegistry = { imports: [], mcpServers: { [CJ]: { allowedTools: ["jira_search"] } } };
		const validRoute = { defaultProvider: CJ, dispatcherOwned: true, selectors: { tenant: "ATLASSIAN_TENANT" } };
		for (const [label, registry, route] of [
			["imports", { ...validRegistry, imports: ["ambient"] }, validRoute],
			["allow-list", { imports: [], mcpServers: { [CJ]: {} } }, validRoute],
			["selectors", validRegistry, { ...validRoute, selectors: { account: "ATLASSIAN_TENANT" } }],
		] as const) {
			const skillsRoot = path.join(fixture.root, `skills-${label}`);
			const config = path.join(skillsRoot, "atlassian", "config");
			mkdirSync(config, { recursive: true });
			writeFileSync(path.join(config, "mcporter.json"), JSON.stringify(registry));
			writeFileSync(path.join(config, "route.json"), JSON.stringify(route));
			const result = await routeTransport(env(), "example", skillsRoot, capabilities()).listTools(binding, CJ);
			expect([label, result]).toEqual([label, { ok: false, cause: "refused-precondition", hint: "repair the Connector Skill route registry" }]);
		}
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
	});

	test("the REST route lists its owned schema without a process, and a call reaches the REST Provider, which refuses before any request when the item is unreadable or the tool is outside the vocabulary", async () => {
		const binding = { principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN, item: ITEM_ID };
		const transport = routeTransport(env(), "example", path.join(fixture.pluginRoot, "skills"), capabilities());
		const listed = await transport.listTools(binding, RJ);
		expect(listed.ok && (listed.data as { name: string }[]).map((tool) => tool.name)).toEqual(["jira_rest_myself", "jira_rest_issue_attachments", "jira_rest_comments_list", "jira_rest_comment_get", "jira_rest_comment_add", "jira_rest_comment_edit", "jira_rest_attachment_head", "jira_rest_issue_attachment_context", "jira_rest_attachment_delete"]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
		// No item: the Provider's own item read fails closed before stdin is consumed.
		expect(await transport.call(binding, RJ, "jira_rest_myself", {})).toEqual({ ok: false, cause: "refused-precondition", hint: "the product credential item is not in 1Password; its owner must create and store it" });
		const secret = "fixture-rest-secret";
		fixture.writeItemText(ITEM_ID, JSON.stringify({ id: ITEM_ID, version: 1, fields: Object.entries({ username: PRINCIPAL, credential: secret, site_url: ORIGIN }).map(([label, value]) => ({ id: label, label, value })) }));
		// A tool outside the closed vocabulary is refused after the item read and before any request leaves.
		expect(await transport.call(binding, RJ, "jira_delete_comment", { issue_key: "PROJ-1" })).toEqual({ ok: false, cause: "refused-precondition", hint: "the provider was invoked with unexpected arguments" });
		expect(JSON.stringify(fixture.lines("op-calls.jsonl"))).not.toContain(secret);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
	});

	// The packaged front door owns the public process boundary; the retired Bun
	// dispatcher cannot prove this refusal or write-journal behavior.
	test("the packaged front door refuses invalid attachment deletes before any journal effect", async () => {
		const command = (attachmentId: string, phase: string[]) => fixture.frontDoor(["run", "atlassian", "--select", "tenant=example", "issue.attachment.delete", "--input", JSON.stringify({ issueKey: "PROJ-1", attachmentId }), ...phase]);
		const resultOf = (stdout: string) => (JSON.parse(stdout) as { result: { outcome: string; causeCode: string; data?: { connectorCause?: string }; repairAction?: string; effects: { completed: string[] } } }).result;
		const byName = await command("before.png", ["--preview"]);
		const invalid = resultOf(byName.stdout);
		expect([byName.code, byName.stderr, invalid.outcome, invalid.causeCode, invalid.data?.connectorCause]).toEqual([4, "", "refused", "SCHEMA_ADAPTER_REFUSED", "input-invalid"]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);

		fixture.writeItem({ username: PRINCIPAL, site_url: ORIGIN });
		const unreadable = await command("202456", ["--preview"]);
		const refusedItem = resultOf(unreadable.stdout);
		expect([unreadable.code, unreadable.stderr, refusedItem.outcome, refusedItem.data?.connectorCause]).toEqual([3, "", "refused", "refused-precondition"]);
		const applied = await command("202456", ["--apply", "00000000-0000-4000-8000-000000000000"]);
		const refusedApply = resultOf(applied.stdout);
		expect([applied.code, applied.stderr, refusedApply.outcome, refusedApply.data?.connectorCause, refusedApply.effects.completed]).toEqual([3, "", "refused", "refused-preview", []]);
		expect([readJsonDir(path.join(fixture.state, "connectors", "atlassian", "example", "previews")), readJsonDir(path.join(fixture.state, "connectors", "atlassian", "example", "receipts"))]).toEqual([[], []]);
		for (const stream of [byName.stdout, unreadable.stdout, applied.stdout]) expect(stream).not.toContain(OP_TOKEN_SENTINEL);
	});

	test("staging copies an upload into the tenant's 0700 outbox under its content digest and refuses a missing or non-regular file", async () => {
		const source = path.join(fixture.root, "evidence.txt");
		writeFileSync(source, "evidence bytes");
		const digest = new Bun.CryptoHasher("sha256").update("evidence bytes").digest("hex");
		const staged = stageFile("example", env(), source);
		expect(staged).toEqual({ ok: true, relative: `${digest}/evidence.txt` });
		const outbox = path.join(fixture.state, "connectors", "atlassian", "example", "outbox");
		expect(readFileSync(path.join(outbox, digest, "evidence.txt"), "utf8")).toBe("evidence bytes");
		for (const directory of [outbox, path.join(outbox, digest)]) expect((statSync(directory).mode & 0o777).toString(8)).toBe("700");
		expect(stageFile("example", env(), source)).toEqual(staged);
		expect(stageFile("example", env(), path.join(fixture.root, "missing.txt"))).toEqual({ ok: false, reason: "file-unreadable" });
		expect(stageFile("example", env(), fixture.root)).toEqual({ ok: false, reason: "file-unreadable" });
		// Digest directories untouched for over an hour are pruned by the next staging; the fresh one and foreign entries stay.
		const stale = path.join(outbox, "f".repeat(64));
		mkdirSync(stale, { recursive: true });
		writeFileSync(path.join(stale, "old.txt"), "old");
		const foreign = path.join(outbox, "notes");
		mkdirSync(foreign);
		const later = Date.now() + 2 * 60 * 60 * 1000;
		expect(stageFile("example", env(), source, later)).toEqual(staged);
		expect(readdirSync(outbox).sort()).toEqual([digest, "notes"].sort());
	});
});
