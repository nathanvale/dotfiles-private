// Atlassian dispatcher: nineteen semantic operations over two static product
// routes on the one Community Provider, every read and write behind live
// schema confirmation, writes behind the durable preview and apply journal,
// and the operator path. Policy is proved in-process with an in-memory
// transport and a real journal in a temp state root; the public route is
// proved through the packaged front door in packaged.test.ts, and one
// process row here proves the module is no longer an entry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { run } from "../scripts/atlassian-dispatch.ts";
import { ALLOWED_TOOLS, OPERATION_SPECS, productFor, PROVIDER, type ProviderName, registryToolVocabulary, SERVERS, serverFor } from "../scripts/dispatch/contract.ts";
import { type Dependencies, type SchemaTool, type Transport, type TransportResult } from "../scripts/dispatch/engine.ts";
import { openJournal } from "../scripts/dispatch/journal.ts";
import { stageFile } from "../scripts/outbox.ts";
import type { ProviderFailureCause } from "../scripts/dispatch/translate.ts";
import { CustodyFixture, PROVIDER_TOKEN } from "./fixtures/custody-fixture.ts";
import { substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const ORIGIN = "https://example.atlassian.net";
const CJ = "atlassian-community-jira";
const CC = "atlassian-community-confluence";
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
const EXPECTED_OPERATIONS = ["issue.get", "issue.search", "issue.transitions", "issue.create", "issue.update", "issue.comment", "issue.comment.update", "issue.attach", "issue.transition", "issue.assign", "issue.delete", "page.get", "page.search", "page.create", "page.update", "page.comment", "page.attach", "page.attachment.delete", "page.delete"] as const;
const WRITE_OPERATIONS = EXPECTED_OPERATIONS.filter((id) => !id.endsWith(".get") && !id.endsWith(".search") && id !== "issue.transitions");

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
	"issue.attach": ["jira_update_issue", "write", "jira"],
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
		tool("jira_create_issue", ["project_key", "summary", "issue_type"], ["description", "assignee"]),
		tool("jira_update_issue", ["issue_key", "fields"], ["additional_fields", "components", "attachments", "return_fields"]),
		tool("jira_add_comment", ["issue_key", "body"], ["visibility", "public"]),
		tool("jira_edit_comment", ["issue_key", "comment_id", "body"], ["visibility"]),
		tool("jira_get_transitions", ["issue_key"]),
		tool("jira_transition_issue", ["issue_key", "transition_id"], ["fields", "comment"]),
		tool("jira_assign_issue", ["issue_key"], ["assignee"]),
		tool("jira_delete_issue", ["issue_key"]),
	],
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

const dispatch = (argv: string[], dependencies: Dependencies) =>
	run(["--tenant", "example", ...argv], (tenant) => {
		tenants.push(tenant);
		return dependencies;
	});
const stateDir = (name: string) => path.join(stateRoot, "connectors", "atlassian", "example", name);
const receiptsDir = () => stateDir("receipts");
const previewsDir = () => stateDir("previews");
const readJsonDir = (directory: string) => (existsSync(directory) ? readdirSync(directory) : []).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>);
// The in-memory transport emits translated failures, exactly as the runtime
// adapter does after translate.ts; raw provider text never enters policy.
const failure = (cause: ProviderFailureCause, hint: string | null = null): TransportResult => ({ ok: false, cause, hint });
const previewData = (envelope: Awaited<ReturnType<typeof run>>) => envelope.result.data as { previewId: string; provider: string; objectIdentity: string; revision: string | null; baseline: { effectIds: string[]; commentIds: string[]; revision: string | null }; arguments: Record<string, unknown>; tool: string; server: string };

describe("operation contract and routes", () => {
	test("maps every operation to its exact Community tool, kind, and product", () => {
		expect(Object.keys(OPERATION_SPECS)).toEqual([...EXPECTED_OPERATIONS]);
		for (const [id, [community, kind, product]] of Object.entries(EXPECTED_TOOLS)) {
			const spec = OPERATION_SPECS[id as keyof typeof OPERATION_SPECS];
			expect([id, spec.tool, spec.kind, spec.product]).toEqual([id, community, kind, product]);
		}
		expect(PROVIDER).toBe("community");
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

	test("the retired provider selector and parity command are usage refusals before any dependency is built", async () => {
		for (const argv of [
			["--tenant", "example", "--provider", "community", "issue.get", "--input", '{"issueKey":"PROJ-1"}'],
			["--tenant", "example", "--provider", "official", "issue.get", "--input", '{"issueKey":"PROJ-1"}'],
			["--tenant", "example", "parity", "--input", '{"operation":"issue.get"}'],
		]) {
			const envelope = await run(argv, (tenant) => {
				tenants.push(tenant);
				return deps();
			});
			expect([argv[2], envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual([argv[2], "refused", "usage-invalid", 2]);
		}
		expect(tenants).toEqual([]);
	});
});

describe("tenant is parsed exactly once", () => {
	test("a repeated --tenant is a usage refusal before any dependency is built", async () => {
		const envelope = await run(["--tenant", "example", "--tenant", "other", "issue.get", "--input", '{"issueKey":"PROJ-1"}'], (tenant) => {
			tenants.push(tenant);
			return deps();
		});
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["refused", "usage-invalid", 2]);
		expect(envelope.result.repairAction).toBe("--tenant may appear only once");
		expect(tenants).toEqual([]);
	});

	test("the validated tenant is the one the dependency factory receives, wherever the option sits", async () => {
		seen.length = 0;
		await run(["issue.get", "--input", '{"issueKey":"PROJ-1"}', "--tenant", "example-team"], (tenant) => {
			tenants.push(tenant);
			return deps();
		});
		expect(tenants).toEqual(["example-team"]);
		expect(seen).toEqual([{ tenant: "example-team", product: "jira" }]);
	});
});

describe("Community reads", () => {
	test("issue.get binds the Jira product credential, confirms the live schema, then calls the exact tool on the Jira route", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { summary: "hello" } } } });
		seen.length = 0;
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode, envelope.result.effectClass, envelope.result.commandIdentity]).toEqual(["success", "success", 0, "inspect", "atlassian.issue.get"]);
		expect(envelope.result.data).toEqual({ key: "PROJ-1", fields: { summary: "hello" } });
		expect(calls).toEqual([{ server: CJ, tool: "jira_get_issue", args: { issue_key: "PROJ-1" } }]);
		expect(envelope.result.provenance).toEqual([{ provider: CJ, tool: "jira_get_issue", status: "success" }]);
		expect([envelope.result.retryable, envelope.result.transactionState, envelope.result.nextAction]).toEqual([false, "unchanged", "use the data"]);
		expect(seen).toEqual([{ tenant: "example", product: "jira" }]);
	});

	test("one semantic operation binds one immutable credential context through the schema list and every call", async () => {
		const { transport, bindings } = fakeTransport();
		let binds = 0;
		const binding = Object.freeze({ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN, item: ITEM_ID });
		await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, bindCredential: async () => ({ ok: true, binding: { ...binding, itemVersion: `${ITEM_VERSION}:${++binds}` } }) }));
		expect(binds).toBe(1);
		expect(bindings).toHaveLength(2);
		expect(bindings.every((entry) => entry === bindings[0])).toBe(true);
		expect(bindings[0]).toEqual({ ...binding, itemVersion: `${ITEM_VERSION}:1` });
	});

	test("issue.search, page.get, and page.search shape their arguments per Community tool on the product route", async () => {
		const { transport, calls } = fakeTransport();
		seen.length = 0;
		await dispatch(["issue.search", "--input", '{"jql":"project = PROJ","maxResults":5,"fields":["summary"]}'], deps({ transport }));
		await dispatch(["page.get", "--input", '{"pageId":"123"}'], deps({ transport }));
		await dispatch(["page.search", "--input", '{"cql":"type=page","maxResults":3}'], deps({ transport }));
		await dispatch(["issue.transitions", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
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
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		expect(calls).toEqual([]);
	});

	test("a write without --preview or --apply is a usage refusal that touches no provider", async () => {
		const { transport, calls } = fakeTransport();
		for (const operation of WRITE_OPERATIONS) {
			const envelope = await dispatch([operation, "--input", "{}"], deps({ transport }));
			expect([operation, envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual([operation, "refused", "usage-invalid", 2]);
		}
		const both = await dispatch(["issue.comment", "--input", "{}", "--preview", "--apply", "p1"], deps({ transport }));
		expect(both.result.causeCode).toBe("usage-invalid");
		expect(calls).toEqual([]);
		expect(readJsonDir(previewsDir()).length).toBe(0);
	});
});

describe("refusals and failures are final: no second Provider, no retry", () => {
	test("an unresolved site origin refuses before any provider call", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, bindCredential: async () => ({ ok: false, cause: "site-unresolved", detail: "the tenant's credential item must expose a valid site_url field" }) }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["refused", "site-unresolved"]);
		expect(envelope.result.repairAction).toBe("the tenant's credential item must expose a valid site_url field");
		expect(calls).toEqual([]);
	});

	test("credential custody failures preserve a precondition refusal instead of claiming the site is unresolved", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, bindCredential: async () => ({ ok: false, cause: "refused-precondition", detail: "a provider precondition failed before any request; run the provider readiness checks" }) }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.repairAction]).toEqual(["refused", "refused-precondition", "a provider precondition failed before any request; run the provider readiness checks"]);
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
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			expect([cause, envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode, envelope.result.retryable]).toEqual([cause, outcome, cause, 3, false]);
			expect([cause, envelope.result.repairAction]).toEqual([cause, REPAIR[cause]]);
			expect([cause, calls.map((call) => [call.server, call.tool])]).toEqual([cause, [[CJ, "jira_get_issue"]]]);
			expect(envelope.result.provenance).toEqual([{ provider: CJ, tool: "jira_get_issue", status: cause }]);
		}
	});

	test("a failed schema list is reported as the list step and makes no call", async () => {
		const { transport, calls } = fakeTransport({}, { [CJ]: failure("failed-transport") });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "failed-transport"]);
		expect(envelope.result.provenance).toEqual([{ provider: CJ, tool: "list", status: "failed-transport" }]);
		expect(calls).toEqual([]);
	});

	test("schema mismatch: the live schema lacks the tool or a required argument", async () => {
		const missingTool = fakeTransport({}, { [CJ]: [tool("jira_search", ["jql"])] });
		const absent = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: missingTool.transport }));
		expect([absent.result.outcome, absent.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		expect(missingTool.calls).toEqual([]);
		const renamed = fakeTransport({}, { [CJ]: [tool("jira_get_issue", ["issueKey"])] });
		const mismatch = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: renamed.transport }));
		expect([mismatch.result.outcome, mismatch.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		// Fixed text only; never a schema name and never a fallback verdict.
		expect(mismatch.result.repairAction).toBe(REPAIR["capability-unavailable"]);
		expect(renamed.calls).toEqual([]);
	});

	test("a hostile live schema cannot smuggle text into the envelope through required or property names", async () => {
		const hostile = ["customer SSN 123-45-6789", `token ${OP_TOKEN_SENTINEL}`, "op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential"];
		for (const name of hostile) {
			const { transport, calls } = fakeTransport({}, { [CJ]: [{ name: "jira_get_issue", inputSchema: { required: ["issue_key", name], properties: { issue_key: {}, [name]: {} } } }] });
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
			expect(JSON.stringify(envelope)).not.toContain(name);
			expect(calls).toEqual([]);
		}
	});

	test("a Provider precondition carries its fixed hint after the fixed repair text", async () => {
		const translated = failure("refused-precondition", "add a username field to the tenant's product credential item");
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: translated });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["refused", "refused-precondition"]);
		expect(envelope.result.repairAction).toBe(`${REPAIR["refused-precondition"]}; add a username field to the tenant's product credential item`);
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
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			expect([label, envelope.result.outcome, envelope.result.causeCode]).toEqual([label, "failed", "capability-unavailable"]);
			expect([label, calls]).toEqual([label, []]);
		}
	});

	test("invalid input is a schema refusal before any provider call", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":""}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["refused", "input-invalid", 4]);
		const smuggled = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1","issue_key":"OTHER-1"}'], deps({ transport }));
		expect([smuggled.result.causeCode, smuggled.result.repairAction]).toEqual(["input-invalid", "unknown input key issue_key"]);
		expect(calls).toEqual([]);
	});
});

describe("provider text never reaches the envelope", () => {
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
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			expect([envelope.result.causeCode, envelope.result.repairAction]).toEqual([cause, detail]);
			expect(envelope.result.provenance.at(-1)).toEqual({ provider: CJ, tool: "jira_get_issue", status: cause });
		}
	});

	test("an unexpected transport throw becomes a fixed failed-unknown envelope", async () => {
		const throwing: Transport = {
			async listTools() {
				return { ok: true, data: SCHEMAS[CJ] ?? [] };
			},
			async call() {
				throw new Error(`boom ${leak}`);
			},
		};
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: throwing }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["failed", "failed-unknown", 3]);
		const serialized = JSON.stringify(envelope);
		for (const fragment of ["boom", ...PRIVATE]) expect(serialized).not.toContain(fragment);
		expect(envelope.result.provenance.map((entry) => entry.status)).toEqual(["failed-unknown"]);
	});
});

describe("journaled writes", () => {
	const COMMENT = { issueKey: "PROJ-1", body: "Quarterly numbers are down; see the attached sheet" };
	const commentReply = { ok: true as const, data: { id: "10001", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: COMMENT.body }] }] } } };
	const BASELINE_READ = { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 };

	test("preview records a durable Community preview bound to the exact provider arguments and touches no write tool", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.exitCode, envelope.result.effectClass, envelope.result.commandIdentity]).toEqual(["success", 0, "repository-local", "atlassian.issue.comment.preview"]);
		const data = previewData(envelope);
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
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([envelope.result.outcome, envelope.result.exitCode, envelope.result.effectClass, envelope.result.transactionState]).toEqual(["success", 0, "external", "completed"]);
		expect(envelope.result.effects).toEqual({ completed: ["jira-comment:10001"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(sendStates).toEqual(["intent:possible"]);
		const sent = calls.filter((call) => call.tool === "jira_add_comment");
		expect(sent).toHaveLength(1);
		// The outbound object is the receipt-bound one: its digest is the preview's argsDigest.
		const stored = readJsonDir(previewsDir())[0];
		expect(testDigest(sent[0]?.args)).toBe(stored?.argsDigest as string);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.provider, entry.status, entry.send, entry.effects])).toEqual([["community", "completed", "possible", [{ kind: "jira-comment", id: "10001" }]]]);
		// The same preview cannot be applied twice.
		const again = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([again.result.causeCode, again.result.repairAction?.endsWith("preview-consumed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("changed input or a foreign preview id refuse the apply before any send", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: commentReply });
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const changed = await dispatch(["issue.comment", "--input", JSON.stringify({ ...COMMENT, body: "edited" }), "--apply", preview.previewId], dependencies);
		expect([changed.result.causeCode, changed.result.repairAction?.endsWith("preview-input-mismatch")]).toEqual(["refused-preview", true]);
		const unknown = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", "nope"], dependencies);
		expect([unknown.result.causeCode, unknown.result.repairAction?.endsWith("preview-unknown")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
	});

	test("a lost reply after the send mark is an unknown outcome that blocks the object; read-back proof through adjudicate releases it", async () => {
		const lost = failure("failed-transport");
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_add_comment`]: lost, [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "t1", comment: { comments: [{ id: "777", body: "unrelated" }] } } } } });
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.transactionState, envelope.result.exitCode, envelope.result.retryable]).toEqual(["failed", "outcome-unknown", "unknown", 3, false]);
		expect(envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: ["issue:PROJ-1"], inventoryComplete: false });
		expect(envelope.result.nextAction).toBe("run adjudicate --run <result.data.runId> with the same input; never retry the write before it resolves");
		// Preview and apply both bind the matching-comment baseline before the
		// possible send. The immediate read-back found nothing, which proves
		// nothing after a possible send, and the dispatcher never retries.
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_add_comment", "jira_get_issue"]);
		const runId = (envelope.result.data as { runId: string }).runId;
		const receipts = await dispatch(["receipts"], dependencies);
		expect((receipts.result.data as { open: { runId: string; status: string; send: string }[] }).open.map((entry) => [entry.runId, entry.status, entry.send])).toEqual([[runId, "unknown", "possible"]]);
		// Any write on the object is blocked while the receipt is open.
		const blockedInput = { issueKey: "PROJ-1", body: "a separate comment" };
		const blockedPreview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(blockedInput), "--preview"], dependencies));
		const blocked = await dispatch(["issue.comment", "--input", JSON.stringify(blockedInput), "--apply", blockedPreview.previewId], dependencies);
		expect([blocked.result.causeCode, blocked.result.repairAction?.endsWith("write-blocked-open-receipt")]).toEqual(["refused-write-blocked", true]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
		// Adjudication with the wrong input is refused; with read-back still absent the receipt stays open.
		const wrong = await dispatch(["adjudicate", "--run", runId, "--input", '{"issueKey":"PROJ-1","body":"other"}'], dependencies);
		expect(wrong.result.causeCode).toBe("input-invalid");
		const absent = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect([absent.result.outcome, absent.result.causeCode, absent.result.repairAction?.endsWith("evidence-insufficient")]).toEqual(["refused", "refused-evidence", true]);
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["unknown"]);
		// Read-back now finds the comment: the receipt completes with the found effect.
		const found = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "10001", body: { content: [{ type: "text", text: COMMENT.body }] } }] } } } } });
		const resolved = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], deps({ transport: found.transport }));
		expect([resolved.result.outcome, resolved.result.effectClass, resolved.result.transactionState, resolved.result.effects.completed]).toEqual(["success", "repository-local", "completed", ["jira-comment:10001"]]);
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
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		armed = true;
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		armed = false;
		expect(tampered).toHaveLength(1);
		// Disk oracle, read without the journal: one open receipt, never marked sent, and the preview consumed.
		const receipts = readJsonDir(receiptsDir());
		expect(receipts.map((entry) => [entry.previewId, entry.status, entry.send, entry.effects])).toEqual([[preview.previewId, "intent", "unsent", []]]);
		expect(readJsonDir(previewsDir()).map((entry) => [entry.previewId, entry.status])).toEqual([[preview.previewId, "consumed"]]);
		// The envelope acknowledges that recorded receipt as an unchanged failure, never an external or uncertain effect.
		const data = envelope.result.data as { runId: string; previewId: string; status: string; send: string };
		expect([data.runId, data.previewId, data.status, data.send]).toEqual([receipts[0]?.runId as string, preview.previewId, "intent", "unsent"]);
		expect([envelope.result.outcome, envelope.result.transactionState, envelope.result.retryable]).toEqual(["refused", "unchanged", false]);
		expect(envelope.result.causeCode).toBe("refused-state");
		expect(envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
		expect(envelope.result.repairAction).toEqual(expect.stringContaining("unlock"));
		// The Provider write tool was never called, and a second apply of the same preview cannot send either.
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toEqual([]);
		const again = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect(again.result.outcome).toBe("refused");
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toHaveLength(1);
	});

	test("adjudication does not count an identical historical Jira comment as a newly completed effect", async () => {
		const historical = { ok: true as const, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "777", body: COMMENT.body }] } } } };
		const { transport } = fakeTransport({ [`${CJ}.jira_add_comment`]: failure("failed-transport"), [`${CJ}.jira_get_issue`]: historical });
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([applied.result.causeCode, applied.result.transactionState]).toEqual(["outcome-unknown", "unknown"]);
		const runId = (applied.result.data as { runId: string }).runId;
		const adjudicated = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect(adjudicated.result.causeCode).toBe("refused-evidence");
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["unknown"]);
	});

	test("a Jira comment adjudication completes only when a new comment id appears after its baseline", async () => {
		let reads = 0;
		const { transport } = fakeTransport({
			[`${CJ}.jira_add_comment`]: failure("failed-transport"),
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: "PROJ-1", fields: { comment: { comments: reads++ >= 3 ? [{ id: "778", body: COMMENT.body }] : [] } } } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const resolved = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect([applied.result.transactionState, resolved.result.transactionState, resolved.result.effects.completed]).toEqual(["unknown", "completed", ["jira-comment:778"]]);
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
		const previewEnvelope = await dispatch(["issue.comment", "--input", JSON.stringify(input), "--preview"], dependencies);
		expect(previewEnvelope.result.causeCode).toBe("success");
		const preview = previewData(previewEnvelope);
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const resolved = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(input)], dependencies);
		expect([applied.result.transactionState, resolved.result.transactionState, resolved.result.effects.completed]).toEqual(["unknown", "completed", ["jira-comment:778"]]);
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
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(input), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const adjudicated = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(input)], dependencies);
		expect([adjudicated.result.transactionState, adjudicated.result.effects.completed]).toEqual(["completed", ["jira-comment:779"]]);
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("a Jira comment preview binds historical autolinks to the credential origin", async () => {
		const input = { issueKey: "PROJ-1", body: "See PROJ-1." };
		const { transport } = fakeTransport({
			[`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", browse_url: "https://other.atlassian.net/browse/PROJ-1", comments: [{ id: "781", body: "See [PROJ-1](https://example.atlassian.net/browse/PROJ-1)." }] } },
		});
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(input), "--preview"], deps({ transport })));
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
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(input), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const adjudicated = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(input)], dependencies);
		expect([adjudicated.result.causeCode, adjudicated.result.effects.completed]).toEqual(["refused-evidence", []]);
		expect((await dispatch(["receipt", "--run", runId], dependencies)).result.data).toMatchObject({ status: "unknown" });
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
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(input), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const adjudicated = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(input)], dependencies);
		expect([adjudicated.result.causeCode, adjudicated.result.transactionState, adjudicated.result.effects.completed]).toEqual(["refused-evidence", "unchanged", []]);
		const receipt = await dispatch(["receipt", "--run", runId], dependencies);
		expect((receipt.result.data as { status: string }).status).toBe("unknown");
		expect(calls.filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
	});

	test("Jira create adjudication rejects a historical title and accepts only a new issue key", async () => {
		const input = { projectKey: "PROJ", issueType: "Bug", summary: "Baseline-safe create" };
		const historical = { ok: true as const, data: { issues: [{ key: "PROJ-9", fields: { summary: input.summary, issuetype: { name: input.issueType } } }] } };
		const old = fakeTransport({ [`${CJ}.jira_create_issue`]: failure("failed-transport"), [`${CJ}.jira_search`]: historical });
		const oldDeps = deps({ transport: old.transport });
		const oldPreview = previewData(await dispatch(["issue.create", "--input", JSON.stringify(input), "--preview"], oldDeps));
		expect([oldPreview.tool, oldPreview.arguments]).toEqual(["jira_create_issue", { project_key: "PROJ", issue_type: "Bug", summary: input.summary }]);
		expect(old.calls[0]).toEqual({ server: CJ, tool: "jira_search", args: { jql: 'project = "PROJ" AND summary ~ "Baseline-safe create" ORDER BY created DESC', limit: 20, fields: "summary,issuetype,created" } });
		const oldApply = await dispatch(["issue.create", "--input", JSON.stringify(input), "--apply", oldPreview.previewId], oldDeps);
		const oldRun = (oldApply.result.data as { runId: string }).runId;
		expect((await dispatch(["adjudicate", "--run", oldRun, "--input", JSON.stringify(input)], oldDeps)).result.causeCode).toBe("refused-evidence");

		const freshInput = { ...input, summary: "Baseline-safe create two" };
		let reads = 0;
		const fresh = fakeTransport({ [`${CJ}.jira_create_issue`]: failure("failed-transport"), [`${CJ}.jira_search`]: () => ({ ok: true, data: { issues: reads++ >= 3 ? [{ key: "PROJ-10", fields: { summary: freshInput.summary, issuetype: { name: freshInput.issueType } } }] : [] } }) });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await dispatch(["issue.create", "--input", JSON.stringify(freshInput), "--preview"], freshDeps));
		const freshApply = await dispatch(["issue.create", "--input", JSON.stringify(freshInput), "--apply", freshPreview.previewId], freshDeps);
		const freshRun = (freshApply.result.data as { runId: string }).runId;
		const freshResolved = await dispatch(["adjudicate", "--run", freshRun, "--input", JSON.stringify(freshInput)], freshDeps);
		expect([freshApply.result.transactionState, freshResolved.result.transactionState, freshResolved.result.effects.completed]).toEqual(["unknown", "completed", ["jira-issue:PROJ-10"]]);
	});

	test("Confluence comment adjudication rejects a historical body and accepts only a new comment id", async () => {
		const input = { pageId: "123", body: "baseline-safe comment" };
		const page = { ok: true as const, data: { id: "123", metadata: { version: 7, hasSpaceInstructions: false } } };
		const historical = fakeTransport({ [`${CC}.confluence_get_page`]: page, [`${CC}.confluence_add_comment`]: failure("failed-transport"), [`${CC}.confluence_get_comments`]: { ok: true, data: [{ id: "42", body: input.body }] } });
		const historicalDeps = deps({ transport: historical.transport });
		const oldPreview = previewData(await dispatch(["page.comment", "--input", JSON.stringify(input), "--preview"], historicalDeps));
		const oldApply = await dispatch(["page.comment", "--input", JSON.stringify(input), "--apply", oldPreview.previewId], historicalDeps);
		const oldRun = (oldApply.result.data as { runId: string }).runId;
		expect((await dispatch(["adjudicate", "--run", oldRun, "--input", JSON.stringify(input)], historicalDeps)).result.causeCode).toBe("refused-evidence");

		const freshInput = { pageId: "124", body: "baseline-safe comment two" };
		const freshPage = { ok: true as const, data: { id: "124", metadata: { version: 7, hasSpaceInstructions: false } } };
		let reads = 0;
		const fresh = fakeTransport({ [`${CC}.confluence_get_page`]: freshPage, [`${CC}.confluence_add_comment`]: failure("failed-transport"), [`${CC}.confluence_get_comments`]: () => ({ ok: true, data: reads++ >= 3 ? [{ id: "43", body: freshInput.body }] : [] }) });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await dispatch(["page.comment", "--input", JSON.stringify(freshInput), "--preview"], freshDeps));
		const freshApply = await dispatch(["page.comment", "--input", JSON.stringify(freshInput), "--apply", freshPreview.previewId], freshDeps);
		const freshRun = (freshApply.result.data as { runId: string }).runId;
		const freshResolved = await dispatch(["adjudicate", "--run", freshRun, "--input", JSON.stringify(freshInput)], freshDeps);
		expect([freshApply.result.transactionState, freshResolved.result.transactionState, freshResolved.result.effects.completed]).toEqual(["unknown", "completed", ["confluence-comment:43"]]);
	});

	test("Confluence create adjudication rejects a historical title and accepts only a new content id", async () => {
		const input = { spaceKey: "ENG", title: "Baseline-safe page", body: "body" };
		const historical = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [{ id: "556", title: input.title, space: { key: "ENG", name: "Engineering" } }] } }, [`${CC}.confluence_create_page`]: failure("failed-transport") });
		const historicalDeps = deps({ transport: historical.transport });
		const oldPreview = previewData(await dispatch(["page.create", "--input", JSON.stringify(input), "--preview"], historicalDeps));
		expect(oldPreview.objectIdentity).toMatch(/^space:ENG:create:root:[0-9a-f]{16}$/);
		expect(historical.calls).toEqual([{ server: CC, tool: "confluence_search", args: { query: 'type = page AND space = "ENG" AND title = "Baseline-safe page"', limit: 20 } }]);
		const oldApply = await dispatch(["page.create", "--input", JSON.stringify(input), "--apply", oldPreview.previewId], historicalDeps);
		const oldRun = (oldApply.result.data as { runId: string }).runId;
		expect((await dispatch(["adjudicate", "--run", oldRun, "--input", JSON.stringify(input)], historicalDeps)).result.causeCode).toBe("refused-evidence");

		const freshInput = { spaceKey: "ENG", title: "Baseline-safe page two", body: "body" };
		const fresh = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [] } }, [`${CC}.confluence_create_page`]: failure("failed-transport") });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await dispatch(["page.create", "--input", JSON.stringify(freshInput), "--preview"], freshDeps));
		expect(freshPreview.arguments).toEqual({ space_key: "ENG", title: freshInput.title, content: "body", content_format: "markdown" });
		const freshApply = await dispatch(["page.create", "--input", JSON.stringify(freshInput), "--apply", freshPreview.previewId], freshDeps);
		const freshRun = (freshApply.result.data as { runId: string }).runId;
		// A new, stable content id appears only during operator read-back.
		const resolvedTransport = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [{ id: "557", title: freshInput.title, space: { key: "ENG" } }] } } });
		const freshResolved = await dispatch(["adjudicate", "--run", freshRun, "--input", JSON.stringify(freshInput)], deps({ transport: resolvedTransport.transport }));
		expect([freshApply.result.transactionState, freshResolved.result.transactionState, freshResolved.result.effects.completed]).toEqual(["unknown", "completed", ["confluence-content:557"]]);
	});

	test("a schema mismatch before the send mark makes no call and records no preview", async () => {
		const { transport, calls } = fakeTransport({}, { [CJ]: [tool("jira_get_issue", ["issue_key"], ["fields", "comment_limit"]), tool("jira_add_comment", ["issue_key", "body", "visibility"])] });
		const dependencies = deps({ transport });
		const preview = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies);
		expect([preview.result.outcome, preview.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
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
		const preview = previewData(await dispatch(["page.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity]).toEqual(["confluence_update_page", "7", "page:123"]);
		expect(preview.arguments).toEqual({ page_id: "123", title: "Roadmap", content: "# New body", version_comment: "connectors update", content_format: "markdown" });
		expect(calls.find((call) => call.tool === "confluence_get_page")?.args).toEqual({ page_id: "123", include_metadata: true });
		version = 8;
		const moved = await dispatch(["page.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([moved.result.causeCode, moved.result.repairAction?.endsWith("preview-revision-changed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "confluence_update_page")).toEqual([]);
		version = 7;
		const applied = await dispatch(["page.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["confluence-content:123"]]);
		expect(calls.find((call) => call.tool === "confluence_update_page")?.args).toEqual(preview.arguments);
	});

	test("issue.update binds the issue's updated timestamp and refuses a preparatory or baseline reply for another issue before any write", async () => {
		const { transport, calls } = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "2026-09-23 14:07:13 AEST", summary: "old" } } } });
		const preview = previewData(await dispatch(["issue.update", "--input", '{"issueKey":"PROJ-1","fields":{"summary":"new"}}', "--preview"], deps({ transport })));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual(["jira_update_issue", "2026-09-23 14:07:13 AEST", "issue:PROJ-1", { issue_key: "PROJ-1", fields: '{"summary":"new"}' }]);
		expect(calls.map((call) => call.args)).toEqual([{ issue_key: "PROJ-1", fields: "summary,updated" }, { issue_key: "PROJ-1", fields: "summary,updated" }]);
		for (const wrongRead of [1, 2]) {
			let reads = 0;
			const wrong = fakeTransport({
				[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { key: ++reads === wrongRead ? "PROJ-2" : "PROJ-1", fields: { version: 7, summary: "old" } } }),
			});
			const envelope = await dispatch(["issue.update", "--input", '{"issueKey":"PROJ-1","fields":{"summary":"new"}}', "--preview"], deps({ transport: wrong.transport }));
			expect([wrongRead, envelope.result.causeCode, envelope.result.repairAction?.includes("different issue")]).toEqual([wrongRead, "capability-unavailable", true]);
			expect(wrong.calls.map((call) => call.tool)).not.toContain("jira_update_issue");
		}
	});

	test("page.update refuses a preparatory or baseline reply for another page before any write", async () => {
		for (const wrongRead of [1, 2]) {
			let reads = 0;
			const { transport, calls } = fakeTransport({
				[`${CC}.confluence_get_page`]: () => ({ ok: true, data: { id: ++reads === wrongRead ? "999" : "123", title: "Roadmap", metadata: { version: 7, hasSpaceInstructions: false }, body: { value: "old" } } }),
			});
			const envelope = await dispatch(["page.update", "--input", '{"pageId":"123","body":"new"}', "--preview"], deps({ transport }));
			expect([wrongRead, envelope.result.causeCode, envelope.result.repairAction?.includes("different page")]).toEqual([wrongRead, "capability-unavailable", true]);
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
		const preview = previewData(await dispatch(["page.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		const applied = await dispatch(["page.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const adjudicated = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(input)], dependencies);
		expect([applied.result.causeCode, applied.result.transactionState]).toEqual(["outcome-unknown", "unknown"]);
		expect([adjudicated.result.causeCode, adjudicated.result.repairAction?.includes("different page")]).toEqual(["refused-evidence", true]);
		expect((await dispatch(["receipt", "--run", runId], dependencies)).result.data).toMatchObject({ status: "unknown", effects: [] });
		expect(calls.filter((call) => call.tool === "confluence_update_page")).toHaveLength(1);
	});

	test("page.create binds the space key as the container, previews from a title search, and completes from the create reply", async () => {
		const { transport, calls } = fakeTransport({ [`${CC}.confluence_search`]: { ok: true, data: { results: [{ id: "555", title: "Home", space: { key: "ENG" } }] } }, [`${CC}.confluence_create_page`]: { ok: true, data: { message: "Page created successfully", page: { id: "556", title: "Roadmap draft" } } } });
		const dependencies = deps({ transport });
		const input = { spaceKey: "ENG", title: "Roadmap draft", body: "x" };
		const preview = previewData(await dispatch(["page.create", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect(preview.objectIdentity).toMatch(/^space:ENG:create:root:[0-9a-f]{16}$/);
		expect(preview.arguments).toEqual({ space_key: "ENG", title: "Roadmap draft", content: "x", content_format: "markdown" });
		expect(calls.map((call) => [call.tool, call.args])).toEqual([["confluence_search", { query: 'type = page AND space = "ENG" AND title = "Roadmap draft"', limit: 20 }]]);
		const applied = await dispatch(["page.create", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.effects.completed]).toEqual(["success", ["confluence-content:556"]]);
		const legacy = await dispatch(["page.create", "--input", '{"space":{"key":"ENG"},"title":"Roadmap draft","body":"x"}', "--preview"], dependencies);
		expect([legacy.result.causeCode, legacy.result.repairAction]).toEqual(["input-invalid", "unknown input key space"]);
	});

	test("issue.update refuses a no-op before any write, and a reply without updated or a version fails closed", async () => {
		const held = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "t1", summary: "new" } } }, [`${CJ}.jira_update_issue`]: failure("failed-transport") });
		const noop = await dispatch(["issue.update", "--input", '{"issueKey":"PROJ-1","fields":{"summary":"new"}}', "--preview"], deps({ transport: held.transport }));
		expect([noop.result.outcome, noop.result.causeCode, noop.result.exitCode, noop.result.repairAction]).toEqual(["refused", "input-invalid", 4, "the issue already holds every requested value; nothing to change"]);
		expect(held.calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue"]);
		const bare = fakeTransport({ [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", fields: { summary: "old" } } } });
		const closed = await dispatch(["issue.update", "--input", '{"issueKey":"PROJ-1","fields":{"summary":"new"}}', "--preview"], deps({ transport: bare.transport }));
		expect([closed.result.outcome, closed.result.causeCode, closed.result.repairAction?.includes("no revision")]).toEqual(["failed", "capability-unavailable", true]);
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
		const preview = previewData(await dispatch(["issue.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.revision, preview.arguments]).toEqual(["t1", { issue_key: "PROJ-1", fields: JSON.stringify({ assignee: PRINCIPAL }) }]);
		const applied = await dispatch(["issue.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["jira-issue:PROJ-1"]]);
		// Preview and apply each read twice (revision, then baseline); the update is always read back.
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_update_issue", "jira_get_issue"]);
		// A moved timestamp between preview and apply refuses.
		updated = "t3";
		const secondInput = { issueKey: "PROJ-1", fields: { summary: "renamed" } };
		const secondPreview = previewData(await dispatch(["issue.update", "--input", JSON.stringify(secondInput), "--preview"], dependencies));
		updated = "t4";
		const moved = await dispatch(["issue.update", "--input", JSON.stringify(secondInput), "--apply", secondPreview.previewId], dependencies);
		expect([moved.result.causeCode, moved.result.repairAction?.endsWith("preview-revision-changed")]).toEqual(["refused-preview", true]);
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
		const preview = previewData(await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual(["jira_edit_comment", "u1", "issue:PROJ-1", { issue_key: "PROJ-1", comment_id: "454166", body: "edited body" }]);
		expect(calls.map((call) => call.args)).toEqual([{ issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 }, { issue_key: "PROJ-1", fields: "comment,updated", comment_limit: 100 }]);
		const applied = await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["jira-comment:454166"]]);
		// The edit is proven by read-back, never by the reply alone.
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_edit_comment", "jira_get_issue"]);
		const noop = await dispatch(["issue.comment.update", "--input", JSON.stringify({ ...input, commentId: "454167", body: "Second body" }), "--preview"], dependencies);
		expect([noop.result.causeCode, noop.result.repairAction]).toEqual(["input-invalid", "the comment already holds the requested body; nothing to change"]);
		const missing = await dispatch(["issue.comment.update", "--input", JSON.stringify({ ...input, commentId: "1" }), "--preview"], dependencies);
		expect([missing.result.outcome, missing.result.causeCode, missing.result.repairAction]).toEqual(["failed", "not-found", "the issue has no comment with that id among its first 100 comments"]);
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
		const preview = previewData(await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.transactionState, applied.result.effects.completed]).toEqual(["completed", ["jira-comment:454166"]]);
		const noop = await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--preview"], dependencies);
		expect(noop.result.causeCode).toBe("input-invalid");
		expect(calls.filter((call) => call.tool === "jira_edit_comment")).toHaveLength(1);
	});

	test("issue.comment.update refuses a missing comment timestamp at preview and apply before a write", async () => {
		let updated: string | undefined;
		const { transport, calls } = fakeTransport({
			[`${CJ}.jira_get_issue`]: () => ({ ok: true, data: { result: JSON.stringify({ key: "PROJ-1", comments: [{ id: "454166", body: "old", ...(updated === undefined ? {} : { updated }) }] }) } }),
		});
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", commentId: "454166", body: "edited" };
		const missingAtPreview = await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--preview"], dependencies);
		expect([missingAtPreview.result.causeCode, missingAtPreview.result.repairAction]).toEqual(["capability-unavailable", "the comment read exposes no updated timestamp to bind the revision"]);
		updated = "u1";
		const preview = previewData(await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		updated = undefined;
		const missingAtApply = await dispatch(["issue.comment.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([missingAtApply.result.causeCode, missingAtApply.result.repairAction]).toEqual(["capability-unavailable", "the comment read exposes no updated timestamp to bind the revision"]);
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
		const preview = previewData(await dispatch(["issue.attach", "--input", JSON.stringify(input), "--preview"], dependencies));
		// The Provider reads uploads only from the tenant outbox, so the bound argument is the staged relative path.
		expect([preview.tool, preview.objectIdentity, preview.revision, preview.baseline, preview.arguments]).toEqual(["jira_update_issue", "issue:PROJ-1", "t1", { effectIds: ["10499"], commentIds: [], revision: null }, { issue_key: "PROJ-1", fields: "{}", attachments: "staged/report.pdf" }]);
		expect(calls.map((call) => call.args)).toEqual([{ issue_key: "PROJ-1", fields: "summary,updated" }, { issue_key: "PROJ-1", fields: "attachment,updated" }]);
		const applied = await dispatch(["issue.attach", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["jira-attachment:10500"]]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_update_issue", "jira_get_issue"]);
		// A failed upload reported inside a successful reply leaves the issue's timestamp unmoved: proven unchanged, object freed, cause named.
		uploadWorks = false;
		const secondInput = { issueKey: "PROJ-1", file: "/tmp/evidence/second.pdf" };
		const secondPreview = previewData(await dispatch(["issue.attach", "--input", JSON.stringify(secondInput), "--preview"], dependencies));
		const refusedUpload = await dispatch(["issue.attach", "--input", JSON.stringify(secondInput), "--apply", secondPreview.previewId], dependencies);
		expect([refusedUpload.result.outcome, refusedUpload.result.causeCode, refusedUpload.result.transactionState, refusedUpload.result.repairAction]).toEqual(["failed", "failed-unknown", "unchanged", `${REPAIR["failed-unknown"]}; the Provider reported the upload failed: check the file path and the Create Attachments permission`]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.status, entry.basis]).sort()).toEqual([["completed", undefined], ["unchanged", "revision-unchanged"]]);
		const relative = await dispatch(["issue.attach", "--input", '{"issueKey":"PROJ-1","file":"evidence/report.pdf"}', "--preview"], dependencies);
		expect([relative.result.causeCode, relative.result.repairAction]).toEqual(["input-invalid", "input key file is invalid"]);
		const unreadable = await dispatch(["issue.attach", "--input", JSON.stringify(input), "--preview"], deps({ transport, stage: () => ({ ok: false, reason: "file-unreadable" }) }));
		expect([unreadable.result.causeCode, unreadable.result.repairAction]).toEqual(["input-invalid", "input key file names no readable regular file"]);
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
		const preview = previewData(await dispatch(["page.attach", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.tool, preview.objectIdentity, preview.revision, preview.arguments]).toEqual(["confluence_upload_attachment", "page:123", "7", { content_id: "123", file_path: "staged/report.pdf" }]);
		const applied = await dispatch(["page.attach", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.effects.completed]).toEqual(["success", ["confluence-attachment:att900"]]);
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
		const preview = previewData(await dispatch(["issue.transition", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual(["jira_transition_issue", "t1", "issue:PROJ-1", { issue_key: "PROJ-1", transition_id: "11" }]);
		expect(calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_transitions", "jira_get_issue"]);
		const applied = await dispatch(["issue.transition", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["jira-issue:PROJ-1"]]);
		expect(calls.map((call) => call.tool).slice(3)).toEqual(["jira_get_issue", "jira_get_transitions", "jira_get_issue", "jira_transition_issue", "jira_get_issue"]);
		const noop = await dispatch(["issue.transition", "--input", JSON.stringify(input), "--preview"], dependencies);
		expect([noop.result.causeCode, noop.result.repairAction]).toEqual(["input-invalid", "the issue already has the requested status; nothing to change"]);
		const unavailable = await dispatch(["issue.transition", "--input", '{"issueKey":"PROJ-1","toStatus":"Cancelled"}', "--preview"], dependencies);
		expect([unavailable.result.outcome, unavailable.result.causeCode, unavailable.result.repairAction]).toEqual(["failed", "not-found", "no transition available to this principal leads to that status"]);
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
		const preview = previewData(await dispatch(["issue.assign", "--input", JSON.stringify(assign), "--preview"], dependencies));
		expect([preview.tool, preview.revision, preview.arguments]).toEqual(["jira_assign_issue", "t1", { issue_key: "PROJ-1", assignee: PRINCIPAL }]);
		const applied = await dispatch(["issue.assign", "--input", JSON.stringify(assign), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.effects.completed]).toEqual(["success", ["jira-issue:PROJ-1"]]);
		const unassignPreview = previewData(await dispatch(["issue.assign", "--input", '{"issueKey":"PROJ-1"}', "--preview"], dependencies));
		expect(unassignPreview.arguments).toEqual({ issue_key: "PROJ-1", assignee: "" });
		const unassigned = await dispatch(["issue.assign", "--input", '{"issueKey":"PROJ-1"}', "--apply", unassignPreview.previewId], dependencies);
		expect([unassigned.result.outcome, unassigned.result.effects.completed]).toEqual(["success", ["jira-issue:PROJ-1"]]);
		const noop = await dispatch(["issue.assign", "--input", '{"issueKey":"PROJ-1"}', "--preview"], dependencies);
		expect([noop.result.causeCode, noop.result.repairAction]).toEqual(["input-invalid", "the issue already has the requested assignee; nothing to change"]);
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
		const preview = previewData(await dispatch(["page.attachment.delete", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity, preview.baseline.effectIds, preview.arguments]).toEqual(["confluence_delete_attachment", "7", "page:123", ["att900"], { attachment_id: "att900" }]);
		const applied = await dispatch(["page.attachment.delete", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["confluence-attachment:att900"]]);
		expect(calls.map((call) => call.tool)).toEqual(["confluence_get_page", "confluence_get_attachments", "confluence_get_page", "confluence_get_attachments", "confluence_delete_attachment", "confluence_get_attachments"]);
		const missing = await dispatch(["page.attachment.delete", "--input", JSON.stringify(input), "--preview"], dependencies);
		expect([missing.result.causeCode, missing.result.repairAction]).toEqual(["input-invalid", "the page has no attachment with that id"]);
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
		const issuePreview = previewData(await dispatch(["issue.delete", "--input", '{"issueKey":"PROJ-1"}', "--preview"], jiraDeps));
		expect([issuePreview.tool, issuePreview.revision, issuePreview.objectIdentity, issuePreview.arguments]).toEqual(["jira_delete_issue", "t1", "issue:PROJ-1", { issue_key: "PROJ-1" }]);
		const issueDeleted = await dispatch(["issue.delete", "--input", '{"issueKey":"PROJ-1"}', "--apply", issuePreview.previewId], jiraDeps);
		expect([issueDeleted.result.outcome, issueDeleted.result.transactionState, issueDeleted.result.effects.completed]).toEqual(["success", "completed", ["jira-issue:PROJ-1"]]);
		expect(jira.calls.map((call) => call.tool)).toEqual(["jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_get_issue", "jira_delete_issue", "jira_get_issue"]);
		// Confluence: a delete that leaves the page in place at the same version settles unchanged and frees the object.
		const confluence = fakeTransport({
			[`${CC}.confluence_get_page`]: { ok: true, data: { result: JSON.stringify({ id: "123", title: "Roadmap", version: 7 }) } },
			[`${CC}.confluence_delete_page`]: { ok: true, data: { result: JSON.stringify({ success: false, message: "Unable to delete page 123. API request completed but deletion unsuccessful." }) } },
		});
		const confluenceDeps = deps({ transport: confluence.transport });
		const pagePreview = previewData(await dispatch(["page.delete", "--input", '{"pageId":"123"}', "--preview"], confluenceDeps));
		expect([pagePreview.tool, pagePreview.revision, pagePreview.objectIdentity]).toEqual(["confluence_delete_page", "7", "page:123"]);
		const pageKept = await dispatch(["page.delete", "--input", '{"pageId":"123"}', "--apply", pagePreview.previewId], confluenceDeps);
		expect([pageKept.result.outcome, pageKept.result.causeCode, pageKept.result.transactionState]).toEqual(["failed", "failed-unknown", "unchanged"]);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.operation, entry.status, entry.basis]).sort()).toEqual([["issue.delete", "completed", undefined], ["page.delete", "unchanged", "revision-unchanged"]]);
		// A second attempt on the freed page can proceed.
		const again = previewData(await dispatch(["page.delete", "--input", '{"pageId":"123"}', "--preview"], confluenceDeps));
		expect(again.objectIdentity).toBe("page:123");
	});

	test("page.comment previews and applies through the Confluence route with the page's version bound", async () => {
		const { transport, calls } = fakeTransport({ [`${CC}.confluence_get_page`]: { ok: true, data: { id: "123", metadata: { version: 7, hasSpaceInstructions: false } } }, [`${CC}.confluence_add_comment`]: { ok: true, data: { success: true, comment: { id: "42", body: "hello" } } } });
		const input = { pageId: "123", body: "hello" };
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["page.comment", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.server, preview.tool, preview.revision, preview.objectIdentity, preview.arguments]).toEqual([CC, "confluence_add_comment", "7", "page:123", { page_id: "123", body: "hello" }]);
		expect(calls.map((call) => call.tool)).toEqual(["confluence_get_page", "confluence_get_comments"]);
		const applied = await dispatch(["page.comment", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.effects.completed]).toEqual(["success", ["confluence-comment:42"]]);
	});

	test("unlock clears a dead holder's lock through the receipt or its preview and refuses an unknown reference", async () => {
		const dependencies = deps();
		const journal = dependencies.journal("example");
		const preview = journal.recordPreview({ operation: "issue.comment", provider: PROVIDER, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null });
		const receipt = await journal.apply({ previewId: preview.previewId, provider: PROVIDER, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null }, async () => ({ proof: "unknown" }));
		const lock = path.join(stateDir("locks"), "issue_PROJ-1.lock");
		writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: NOW }), { mode: 0o600 });
		const unlocked = await dispatch(["unlock", "--run", receipt.runId], dependencies);
		expect([unlocked.result.outcome, unlocked.result.effectClass, unlocked.result.data]).toEqual(["success", "repository-local", { runId: receipt.runId, objectIdentity: "issue:PROJ-1", unlocked: true }]);
		expect(readdirSync(stateDir("locks"))).toEqual([]);
		const preIntentPreview = journal.recordPreview({ operation: "issue.comment", provider: PROVIDER, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null });
		writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: NOW }), { mode: 0o600 });
		const recovered = await dispatch(["unlock", "--run", preIntentPreview.previewId], dependencies);
		expect([recovered.result.outcome, recovered.result.effectClass, recovered.result.data]).toEqual(["success", "repository-local", { previewId: preIntentPreview.previewId, objectIdentity: "issue:PROJ-1", unlocked: true }]);
		const missing = await dispatch(["unlock", "--run", "nope"], dependencies);
		expect([missing.result.causeCode, missing.result.repairAction?.endsWith("preview-unknown")]).toEqual(["refused-preview", true]);
		const shown = await dispatch(["receipt", "--run", receipt.runId], dependencies);
		expect((shown.result.data as { status: string }).status).toBe("unknown");
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
		const listed = await dispatch(["receipts"], dependencies);
		expect((listed.result.data as { open: { runId: string; provider: string; status: string; send: string }[] }).open.map((entry) => [entry.runId, entry.provider, entry.status, entry.send])).toEqual([[receipt.runId, RETIRED, "unknown", "possible"]]);
		const shown = await dispatch(["receipt", "--run", receipt.runId], dependencies);
		expect([shown.result.outcome, (shown.result.data as { provider: string; status: string }).provider, (shown.result.data as { status: string }).status]).toEqual(["success", RETIRED, "unknown"]);
		// Adjudication would read back through the active route with the
		// active tool vocabulary; the receipt names a route that no longer
		// exists, so it is refused before any binding or call.
		const adjudicated = await dispatch(["adjudicate", "--run", receipt.runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect([adjudicated.result.outcome, adjudicated.result.causeCode, adjudicated.result.exitCode, adjudicated.result.repairAction]).toEqual(["refused", "refused-state", 3, `${REPAIR["refused-state"]}; receipt-provider-retired`]);
		const unlocked = await dispatch(["unlock", "--run", receipt.runId], dependencies);
		expect([unlocked.result.outcome, unlocked.result.causeCode, unlocked.result.repairAction]).toEqual(["refused", "refused-state", `${REPAIR["refused-state"]}; receipt-provider-retired`]);
		expect(calls).toEqual([]);
		expect(seen).toEqual([]);
		// A new Community write on the same object is blocked by the open receipt.
		const blockedPreview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify({ issueKey: "PROJ-1", body: "a new community comment" }), "--preview"], dependencies));
		expect(blockedPreview.provider).toBe("community");
		const blocked = await dispatch(["issue.comment", "--input", JSON.stringify({ issueKey: "PROJ-1", body: "a new community comment" }), "--apply", blockedPreview.previewId], dependencies);
		expect([blocked.result.causeCode, blocked.result.repairAction?.endsWith("write-blocked-open-receipt")]).toEqual(["refused-write-blocked", true]);
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
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(secondInput), "--apply", openPreview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.causeCode, applied.result.exitCode, applied.result.repairAction]).toEqual(["refused", "refused-preview", 3, `${REPAIR["refused-preview"]}; preview-provider-retired`]);
		// Refused before any binding or provider call: the retired provider is read
		// from the preview itself, ahead of the preparatory jira_get_issue read.
		expect(calls).toEqual([]);
		const unlocked = await dispatch(["unlock", "--run", openPreview.previewId], dependencies);
		expect([unlocked.result.outcome, unlocked.result.causeCode, unlocked.result.repairAction]).toEqual(["refused", "refused-preview", `${REPAIR["refused-preview"]}; preview-provider-retired`]);
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

	// No-bypass: the dispatcher module is no longer an entry. Bun running it
	// directly on a fully provisioned, registered machine (Keychain token, op,
	// uv, item, and canned schema all present, so a live entry would reach each)
	// prints nothing, exits 0, and reads no credential or starts no route.
	test("no-bypass: bun running the retired dispatcher script as an entry does nothing on a provisioned, registered machine", async () => {
		fixture.writeItem({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN });
		fixture.canned("jira", "jira_get_issue", { key: "EX-1", summary: "canned" });
		const proc = Bun.spawn([process.execPath, path.join(fixture.skill, "scripts", "atlassian-dispatch.ts"), "--tenant", "example", "issue.get", "--input", '{"issueKey":"EX-1"}'], { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
			const result = await routeTransport(env(), "example", skillsRoot).listTools(binding, CJ);
			expect([label, result]).toEqual([label, { ok: false, cause: "refused-precondition", hint: "repair the Connector Skill route registry" }]);
		}
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
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
