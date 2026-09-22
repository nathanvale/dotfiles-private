// Atlassian dispatcher: ten semantic operations over four static product
// routes, Official default, Community only behind live-parity attestation,
// writes behind the durable preview and apply journal, and the operator path.
// Policy is proved in-process with an in-memory transport and a real journal in
// a temp state root; public-process cases cross the real route.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertCustody, createHarness, itemJson, type Harness, OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { run } from "../scripts/atlassian-dispatch.ts";
import { ALLOWED_TOOLS, OPERATION_SPECS, registryToolVocabulary, SERVERS, serverFor } from "../scripts/dispatch/contract.ts";
import { attestationMatches, type Dependencies, type ParityAttestation, type ParityEvidence, REPAIR_TEXT, type SchemaTool, type Transport, type TransportResult } from "../scripts/dispatch/engine.ts";
import { openJournal } from "../scripts/dispatch/journal.ts";
import { parityStore, resolveCredentialContext } from "../scripts/dispatch/runtime.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const DISPATCH = path.join(SKILL, "scripts", "atlassian-dispatch.ts");
const CREDENTIAL_BINDING = path.join(SKILL, "scripts", "atlassian-credential-binding.ts");
const ORIGIN = "https://example.atlassian.net";
const MANAGEMENT_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const OJ = "atlassian-official-jira";
const OC = "atlassian-official-confluence";
const CJ = "atlassian-community-jira";
const CC = "atlassian-community-confluence";
const PRINCIPAL = "service@example.invalid";
const ITEM_VERSION = "onepassword-item-version:1";
const NOW = 1_700_000_000_000;

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
const EXPECTED_OPERATIONS = ["issue.get", "issue.search", "issue.create", "issue.update", "issue.comment", "page.get", "page.search", "page.create", "page.update", "page.comment"] as const;
const EXPECTED_PATHS = ["atlassian.adjudicate", "atlassian.issue.comment", "atlassian.issue.create", "atlassian.issue.get", "atlassian.issue.search", "atlassian.issue.update", "atlassian.page.comment", "atlassian.page.create", "atlassian.page.get", "atlassian.page.search", "atlassian.page.update", "atlassian.parity", "atlassian.receipt", "atlassian.receipts", "atlassian.unlock"];

// Independent oracle: the exact provider tool per operation and whether the
// default Official endpoint reaches it as a primary tool, from the Stage
// Manager decision, the Atlassian supported-tools page, and the v0.23.1
// Community reference.
const EXPECTED_TOOLS: Record<string, [string, boolean, string, "jira" | "confluence"]> = {
	"issue.get": ["getJiraIssue", true, "jira_get_issue", "jira"],
	"issue.search": ["searchJiraIssuesUsingJql", true, "jira_search", "jira"],
	"issue.create": ["createJiraIssue", true, "jira_create_issue", "jira"],
	"issue.update": ["editJiraIssue", true, "jira_update_issue", "jira"],
	"issue.comment": ["addOrEditJiraIssueComment", true, "jira_add_comment", "jira"],
	"page.get": ["getConfluenceContent", true, "confluence_get_page", "confluence"],
	"page.search": ["searchConfluence", true, "confluence_search", "confluence"],
	"page.create": ["createConfluenceContent", true, "confluence_create_page", "confluence"],
	"page.update": ["updateConfluenceContent", true, "confluence_update_page", "confluence"],
	"page.comment": ["createConfluenceComment", false, "confluence_add_comment", "confluence"],
};

const tool = (name: string, required: string[], optional: string[] = []): SchemaTool => ({
	name,
	inputSchema: { required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, {}])) },
});
const GUARD = tool("getAccessibleAtlassianResources", []);
const USER = tool("atlassianUserInfo", []);
const SCHEMAS: Record<string, SchemaTool[]> = {
	[OJ]: [
		GUARD,
		USER,
		tool("getJiraIssue", ["cloudId", "issueIdOrKey"], ["fields"]),
		tool("searchJiraIssuesUsingJql", ["cloudId", "jql"], ["maxResults", "fields"]),
		tool("createJiraIssue", ["cloudId", "projectKey", "issueType", "summary"], ["description", "assignee"]),
		tool("editJiraIssue", ["cloudId", "issueIdOrKey", "fields"], ["contentFormat"]),
		tool("addOrEditJiraIssueComment", ["cloudId", "issueIdOrKey", "commentBody"]),
	],
	[OC]: [
		GUARD,
		USER,
		tool("getConfluenceContent", ["cloudId", "content_id"], ["content_format", "detail", "include_metadata"]),
		tool("searchConfluence", ["cloudId", "cql"], ["maxResults"]),
		tool("getConfluenceSpace", ["cloudId", "spaceId"]),
		tool("createConfluenceContent", ["cloudId", "parent", "contentType", "title", "body"]),
		tool("updateConfluenceContent", ["cloudId", "contentId", "snapshotToken", "body"], ["title", "versionMessage"]),
	],
	[CJ]: [
		tool("jira_get_issue", ["issue_key"], ["fields", "comment_limit"]),
		tool("jira_search", ["jql"], ["limit", "fields"]),
		tool("jira_create_issue", ["project_key", "summary", "issue_type"], ["description", "assignee"]),
		tool("jira_update_issue", ["issue_key", "fields"]),
		tool("jira_add_comment", ["issue_key", "body"]),
	],
	[CC]: [
		tool("confluence_get_page", ["page_id"], ["detail", "include_metadata"]),
		tool("confluence_search", ["query"], ["limit"]),
		tool("confluence_get_space", ["space_key"]),
		tool("confluence_get_comments", ["page_id"]),
		tool("confluence_create_page", ["space_key", "title"], ["content", "parent_id", "content_format"]),
		tool("confluence_update_page", ["page_id", "title"], ["content", "version_comment", "content_format"]),
		tool("confluence_add_comment", ["page_id", "body"]),
	],
};
const RESOURCES = [
	{ id: "cloud-other", url: "https://other.atlassian.net", name: "other" },
	{ id: "cloud-example", url: "https://example.atlassian.net", name: "example" },
];
const UNPROVEN: ParityEvidence = { status: "unproven" };
const attested = (operation: ParityAttestation["operation"], inputShape: string[], overrides: Partial<ParityAttestation> = {}): ParityEvidence => ({
	status: "attested",
	attestation: {
		tenant: "example",
		product: operation.startsWith("issue.") ? "jira" : "confluence",
		operation,
		inputShape,
		origin: ORIGIN,
		credentialDigest: testDigest({ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN }),
		objectSemantics: ({ "issue.get": "issue:key+id", "issue.search": "issues:key-set", "page.get": "page:id+version+title", "page.search": "pages:id-set" } as Record<string, string>)[operation] ?? "",
		recordedAt: NOW - 1000,
		expiresAt: NOW + 1000,
		source: "test-fixture",
		...overrides,
	},
});

interface Call {
	server: string;
	tool: string;
	args: Record<string, unknown>;
}

function fakeTransport(results: Record<string, TransportResult | ((args: Record<string, unknown>) => TransportResult)> = {}, schemas: Record<string, SchemaTool[] | TransportResult> = {}, observe?: (call: Call) => void) {
	const calls: Call[] = [];
	const transport: Transport = {
		async listTools(_context, server) {
			const schema = schemas[server] ?? SCHEMAS[server] ?? [];
			return Array.isArray(schema) ? { ok: true, data: schema } : schema;
		},
		async call(_context, server, name, args) {
			const call = { server, tool: name, args };
			calls.push(call);
			observe?.(call);
			const canned = results[`${server}.${name}`];
			if (typeof canned === "function") return canned(args);
			if (canned) return canned;
			if (name === "getAccessibleAtlassianResources") return { ok: true, data: RESOURCES };
			if (name === "atlassianUserInfo") return { ok: true, data: { account_id: "acc-1", email: PRINCIPAL } };
			return { ok: true, data: { fake: `${server}.${name}` } };
		},
	};
	return { transport, calls };
}

let stateRoot: string;
let tenants: string[];
const attestations: ParityAttestation[] = [];
beforeEach(() => {
	stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
	tenants = [];
	attestations.length = 0;
});
afterEach(() => rmSync(stateRoot, { recursive: true, force: true }));

const seen: { tenant: string; product: string }[] = [];
function deps(overrides: Partial<Dependencies> = {}): Dependencies {
	return {
		transport: fakeTransport().transport,
		credentialContext: async (tenant, product) => {
			seen.push({ tenant, product });
			return { principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN };
		},
		parity: async () => UNPROVEN,
		attestParity: async (attestation) => {
			attestations.push(attestation);
		},
		journal: (tenant) => openJournal(tenant, { stateRoot, now: () => NOW }),
		now: () => NOW,
		...overrides,
	};
}

const dispatch = (argv: string[], dependencies: Dependencies) =>
	run(["--tenant", "example", ...argv], (tenant) => {
		tenants.push(tenant);
		return dependencies;
	});
const receiptsDir = () => path.join(stateRoot, "connectors", "atlassian", "example", "receipts");
const previewsDir = () => path.join(stateRoot, "connectors", "atlassian", "example", "previews");
const readJsonDir = (directory: string) => (existsSync(directory) ? readdirSync(directory) : []).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>);
const process_ = (kind: "process", exitCode: number, stderr: string, stdout = ""): TransportResult => ({ ok: false, kind, exitCode, stderr, stdout, contentObserved: stdout.trim().length > 0 });
const toolError = (message: string): TransportResult => ({ ok: false, kind: "tool-error", message, contentObserved: true });

describe("operation contract and routes", () => {
	test("maps every operation to its exact provider tools and marks the deferred Official comment unreachable", () => {
		expect(Object.keys(OPERATION_SPECS)).toEqual([...EXPECTED_OPERATIONS]);
		for (const [id, [official, reachable, community, product]] of Object.entries(EXPECTED_TOOLS)) {
			const spec = OPERATION_SPECS[id as keyof typeof OPERATION_SPECS];
			expect([id, spec.official.tool, spec.official.reachable, spec.community.tool]).toEqual([id, official, reachable, community]);
			expect([id, spec.product]).toEqual([id, product]);
		}
	});

	test("four static routes, product-specific exact allow-lists, no broad dispatchers", () => {
		expect([...SERVERS]).toEqual([OJ, OC, CJ, CC]);
		expect(serverFor("official", "jira")).toBe(OJ);
		expect(serverFor("community", "confluence")).toBe(CC);
		expect(ALLOWED_TOOLS).toEqual({
			[OJ]: ["atlassianUserInfo", "getAccessibleAtlassianResources", "getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "editJiraIssue", "addOrEditJiraIssueComment"],
			[OC]: ["atlassianUserInfo", "getAccessibleAtlassianResources", "getConfluenceContent", "searchConfluence", "getConfluenceSpace", "createConfluenceContent", "updateConfluenceContent"],
			[CJ]: ["jira_get_issue", "jira_search", "jira_create_issue", "jira_update_issue", "jira_add_comment"],
			[CC]: ["confluence_get_page", "confluence_search", "confluence_get_space", "confluence_get_comments", "confluence_create_page", "confluence_update_page", "confluence_add_comment"],
		});
		for (const tools of Object.values(ALLOWED_TOOLS)) for (const broad of ["executeWrite", "executeRead", "executeDestructive", "discover", "createConfluenceComment"]) expect(tools).not.toContain(broad);
	});

	test("the registry and its derived runtime vocabulary have exact independent allow-lists", () => {
		const registry = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8")) as { mcpServers: Record<string, { allowedTools: string[]; env: Record<string, string>; command: string }> };
		const expected = {
			[OJ]: ["atlassianUserInfo", "getAccessibleAtlassianResources", "getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "editJiraIssue", "addOrEditJiraIssueComment"],
			[OC]: ["atlassianUserInfo", "getAccessibleAtlassianResources", "getConfluenceContent", "searchConfluence", "getConfluenceSpace", "createConfluenceContent", "updateConfluenceContent"],
			[CJ]: ["jira_get_issue", "jira_search", "jira_create_issue", "jira_update_issue", "jira_add_comment"],
			[CC]: ["confluence_get_page", "confluence_search", "confluence_get_space", "confluence_get_comments", "confluence_create_page", "confluence_update_page", "confluence_add_comment"],
		};
		expect(Object.fromEntries(Object.entries(registry.mcpServers).map(([server, entry]) => [server, entry.allowedTools]))).toEqual(expected);
		expect(ALLOWED_TOOLS).toEqual(expected);
		for (const server of SERVERS) {
			const entry = registry.mcpServers[server];
			expect([server, entry?.env.ATLASSIAN_PRODUCT]).toEqual([server, server.endsWith("-jira") ? "jira" : "confluence"]);
			expect([server, entry?.env.ATLASSIAN_TENANT]).toEqual([server, "${ATLASSIAN_TENANT}"]);
			expect([server, entry?.command]).toEqual([server, server.includes("official") ? "../scripts/atlassian-official-provider.ts" : "../scripts/atlassian-community-provider.ts"]);
		}
	});

	test("registry vocabulary parsing fails closed for a broad dispatcher or an incomplete server set", () => {
		const registry = JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8")) as { mcpServers: Record<string, { allowedTools: string[] }> };
		registry.mcpServers[OJ]!.allowedTools = ["executeRead"];
		expect(() => registryToolVocabulary(registry)).toThrow(/registry-invalid/);
		delete registry.mcpServers[CC];
		expect(() => registryToolVocabulary(registry)).toThrow(/registry-invalid/);
	});

	test("discovery lists every operation and command with the exit meanings, without a tenant", async () => {
		const envelope = await run(["--discover"], () => {
			throw new Error("no dependencies for discovery");
		});
		expect([envelope.result.outcome, envelope.result.exitCode, envelope.result.commandIdentity]).toEqual(["success", 0, "atlassian.discover"]);
		const data = envelope.result.data as { operations: { id: string }[]; commands: string[]; exitMeanings: Record<string, string> };
		expect(data.operations.map((entry) => entry.id)).toEqual([...EXPECTED_OPERATIONS]);
		expect(data.commands).toEqual(["receipts", "receipt", "adjudicate", "unlock", "parity"]);
		expect(Object.keys(data.exitMeanings)).toEqual(["0", "2", "3", "4"]);
		expect(envelope.availablePaths).toEqual(EXPECTED_PATHS);
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

describe("Official reads", () => {
	test("issue.get resolves the Jira product origin, matches the cloudId by site origin, then calls the exact tool on the Jira route", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: { ok: true, data: { key: "PROJ-1" } } });
		seen.length = 0;
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect(envelope.result.outcome).toBe("success");
		expect(envelope.result.exitCode).toBe(0);
		expect(envelope.result.effectClass).toBe("inspect");
		expect(envelope.result.transactionState).toBe("unchanged");
		expect(envelope.result.data).toEqual({ key: "PROJ-1" });
		expect(seen).toEqual([{ tenant: "example", product: "jira" }]);
		expect(calls).toEqual([
			{ server: OJ, tool: "getAccessibleAtlassianResources", args: {} },
			{ server: OJ, tool: "getJiraIssue", args: { cloudId: "cloud-example", issueIdOrKey: "PROJ-1" } },
		]);
		expect(envelope.result.provenance).toEqual([
			{ provider: OJ, tool: "getAccessibleAtlassianResources", status: "success" },
			{ provider: OJ, tool: "getJiraIssue", status: "success" },
		]);
	});

	test("one semantic operation binds one immutable context through schema list and every call", async () => {
		const contexts: { principal: string; itemVersion: string; origin: string }[] = [];
		let reads = 0;
		const transport: Transport = {
			async listTools(context, server) {
				contexts.push(context);
				return { ok: true, data: SCHEMAS[server] ?? [] };
			},
			async call(context, _server, tool) {
				contexts.push(context);
				if (tool === "getAccessibleAtlassianResources") return { ok: true, data: RESOURCES };
				return { ok: true, data: { key: "PROJ-1" } };
			},
		};
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({
			transport,
			credentialContext: async () => {
				reads += 1;
				return { principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN };
			},
		}));
		expect([envelope.result.causeCode, reads, contexts]).toEqual(["success", 1, [
			{ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN },
			{ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN },
			{ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN },
		]]);
	});

	test("issue.search, page.get, and page.search shape their arguments per tool on the product route", async () => {
		const { transport, calls } = fakeTransport();
		seen.length = 0;
		await dispatch(["issue.search", "--input", '{"jql":"project = PROJ","maxResults":5,"fields":["summary"]}'], deps({ transport }));
		await dispatch(["page.get", "--input", '{"pageId":"123","detail":"full"}'], deps({ transport }));
		await dispatch(["page.search", "--input", '{"cql":"type=page","maxResults":3}'], deps({ transport }));
		expect(calls.filter((call) => call.tool !== "getAccessibleAtlassianResources").map((call) => [call.server, call.tool, call.args])).toEqual([
			[OJ, "searchJiraIssuesUsingJql", { cloudId: "cloud-example", jql: "project = PROJ", maxResults: 5, fields: ["summary"] }],
			[OC, "getConfluenceContent", { cloudId: "cloud-example", content_id: "123", detail: "full" }],
			[OC, "searchConfluence", { cloudId: "cloud-example", cql: "type=page", maxResults: 3 }],
		]);
		expect(seen.map((entry) => entry.product)).toEqual(["jira", "confluence", "confluence"]);
	});

	test("product swap is impossible: a Jira operation never touches a Confluence route, even when only that route has the tool", async () => {
		const { transport, calls } = fakeTransport({}, { [OJ]: [GUARD], [CJ]: [], [OC]: [GUARD, tool("getJiraIssue", ["cloudId", "issueIdOrKey"])], [CC]: [tool("jira_get_issue", ["issue_key"])] });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		expect(calls).toEqual([]);
	});

	test("a write without --preview or --apply is a usage refusal that touches no provider", async () => {
		const { transport, calls } = fakeTransport();
		for (const operation of ["issue.create", "issue.update", "issue.comment", "page.create", "page.update", "page.comment"]) {
			const envelope = await dispatch([operation, "--input", "{}"], deps({ transport }));
			expect([operation, envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual([operation, "refused", "usage-invalid", 2]);
		}
		const both = await dispatch(["issue.comment", "--input", "{}", "--preview", "--apply", "p1"], deps({ transport }));
		expect(both.result.causeCode).toBe("usage-invalid");
		expect(calls).toEqual([]);
		expect(readJsonDir(previewsDir()).length).toBe(0);
	});
});

describe("refusals that never fall back", () => {
	test("tenant mismatch: no accessible resource shares the trusted site origin", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getAccessibleAtlassianResources`]: { ok: true, data: [RESOURCES[0]] } });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["refused", "refused-tenant", 3]);
		expect(calls.map((call) => call.tool)).toEqual(["getAccessibleAtlassianResources"]);
		expect(JSON.stringify(envelope)).not.toContain("cloud-other");
	});

	test("an unresolved site origin refuses before any provider call", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, credentialContext: async () => { throw new Error("site-unresolved: no site_url"); } }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["refused", "site-unresolved"]);
		expect(envelope.result.repairAction).toBe("the tenant's credential item must expose a valid site_url field");
		expect(calls).toEqual([]);
	});

	test("credential custody failures preserve a precondition refusal instead of claiming the site is unresolved", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, credentialContext: async () => { throw new Error("credential-context-unavailable"); } }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.repairAction]).toEqual(["refused", "refused-precondition", "a provider precondition failed before any request; run the provider readiness checks"]);
		expect(calls).toEqual([]);
	});

	test("auth and permission failures refuse without Community, even with an attestation", async () => {
		for (const failure of [toolError("Authentication failed for Jira (403). Token may be expired"), process_("process", 1, "HTTP 401 Unauthorized")]) {
			const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: failure });
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
			expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["refused", "refused-auth"]);
			expect(calls.map((call) => call.server)).not.toContain(CJ);
		}
	});

	test("schema mismatch: the live schema lacks the tool or a required argument", async () => {
		const missingTool = fakeTransport({}, { [OJ]: [GUARD, tool("searchJiraIssuesUsingJql", ["cloudId", "jql"])] });
		const absent = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: missingTool.transport }));
		expect([absent.result.outcome, absent.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		expect(missingTool.calls).toEqual([]);
		const renamed = fakeTransport({}, { [OJ]: [GUARD, tool("getJiraIssue", ["cloudId", "issueKey"])] });
		const mismatch = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: renamed.transport }));
		expect([mismatch.result.outcome, mismatch.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		// Fixed text plus the engine-authored fallback reason; never a schema name.
		expect(mismatch.result.repairAction).toBe(`${REPAIR_TEXT["capability-unavailable"]}; fallback-ineligible:parity-unproven`);
		expect(renamed.calls).toEqual([]);
	});

	test("a hostile live schema cannot smuggle text into the envelope through required or property names", async () => {
		const hostile = ["customer SSN 123-45-6789", `token ${OP_TOKEN_SENTINEL}`, "op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential"];
		for (const name of hostile) {
			const { transport, calls } = fakeTransport({}, { [OJ]: [GUARD, { name: "getJiraIssue", inputSchema: { required: ["cloudId", "issueIdOrKey", name], properties: { cloudId: {}, issueIdOrKey: {}, [name]: {} } } }] });
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
			expect(JSON.stringify(envelope)).not.toContain(name);
			expect(calls).toEqual([]);
		}
	});

	test("a missing username is a precondition refusal with fixed guidance and no fallback", async () => {
		const failure = process_("process", 4, "atlassian-provider:error:username-missing:JIRA_EXAMPLE_API_TOKEN needs a username field");
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: failure });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["refused", "refused-precondition"]);
		expect(envelope.result.repairAction).toContain("username");
		expect(envelope.result.repairAction).not.toContain("JIRA_EXAMPLE_API_TOKEN needs");
		expect(calls.map((call) => call.server)).not.toContain(CJ);
	});

	test("a live schema without a real object schema, or with a malformed required list, fails closed without a call", async () => {
		const cases: [string, SchemaTool[]][] = [
			["no inputSchema", [GUARD, { name: "getJiraIssue" }]],
			["required is a string", [GUARD, { name: "getJiraIssue", inputSchema: { required: "cloudId" as unknown as string[], properties: { cloudId: {}, issueIdOrKey: {} } } }]],
			["properties is not an object", [GUARD, { name: "getJiraIssue", inputSchema: { required: [], properties: "cloudId" as unknown as Record<string, unknown> } }]],
			["zero-argument guard tool without an object schema", [{ name: "getAccessibleAtlassianResources" }, tool("getJiraIssue", ["cloudId", "issueIdOrKey"])]],
		];
		for (const [label, schema] of cases) {
			const { transport, calls } = fakeTransport({}, { [OJ]: schema });
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			expect([label, envelope.result.outcome, envelope.result.causeCode]).toEqual([label, "failed", "capability-unavailable"]);
			expect([label, calls]).toEqual([label, []]);
		}
	});

	test("invalid input is a schema refusal before any provider call", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":""}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["refused", "input-invalid", 4]);
		expect(calls).toEqual([]);
	});
});

describe("read fallback gate", () => {
	const transportFailure = process_("process", 1, "connect ETIMEDOUT mcp.atlassian.com");

	test("without an attestation a transport failure stays on Official and reports why", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: transportFailure });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.failureClass]).toEqual(["failed", "failed-transport", "domain"]);
		expect(envelope.result.repairAction).toContain("parity-unproven");
		expect(calls.map((call) => call.server)).not.toContain(CJ);
	});

	test("with an exact attestation and a confirmed Community tool, a read fails over once to the same product's Community route", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: transportFailure, [`${CJ}.jira_get_issue`]: { ok: true, data: { key: "PROJ-1", via: "community" } } });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect(envelope.result.outcome).toBe("success");
		expect(envelope.result.data).toEqual({ key: "PROJ-1", via: "community" });
		expect(calls.map((call) => [call.server, call.tool, call.args])).toEqual([
			[OJ, "getAccessibleAtlassianResources", {}],
			[OJ, "getJiraIssue", { cloudId: "cloud-example", issueIdOrKey: "PROJ-1" }],
			[CJ, "jira_get_issue", { issue_key: "PROJ-1" }],
		]);
		expect(envelope.result.provenance.map((entry) => [entry.provider, entry.tool, entry.status])).toEqual([
			[OJ, "getAccessibleAtlassianResources", "success"],
			[OJ, "getJiraIssue", "failed-transport"],
			[CJ, "jira_get_issue", "success"],
		]);
	});

	test("an attestation must match tenant, product, operation, input shape, origin, semantics, and expiry exactly", async () => {
		const cases: [string, ParityEvidence][] = [
			["other operation", attested("issue.search", ["jql"])],
			["other input shape", attested("issue.get", ["issueKey", "fields"])],
			["other tenant", attested("issue.get", ["issueKey"], { tenant: "other" })],
			["other origin", attested("issue.get", ["issueKey"], { origin: "https://other.atlassian.net" })],
			["stale semantics", attested("issue.get", ["issueKey"], { objectSemantics: "issue:key" })],
			["expired", attested("issue.get", ["issueKey"], { expiresAt: NOW })],
			["no credential binding", attested("issue.get", ["issueKey"], { credentialDigest: "" })],
		];
		for (const [label, evidence] of cases) {
			const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: transportFailure });
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => evidence }));
			expect([label, envelope.result.causeCode]).toEqual([label, "failed-transport"]);
			expect([label, calls.map((call) => call.server).includes(CJ)]).toEqual([label, false]);
			expect([label, /parity-(mismatch|expired)/.test(envelope.result.repairAction ?? "")]).toEqual([label, true]);
		}
	});

	test("a failure that produced provider content is never fallback-safe, even with an attestation", async () => {
		const partial = process_("process", 1, "connect ETIMEDOUT mid-stream", '{"partial":"answer"}');
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: partial });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "failed-transport"]);
		expect(envelope.result.repairAction).toContain("content-observed");
		expect(calls.map((call) => call.server)).not.toContain(CJ);
		expect(JSON.stringify(envelope)).not.toContain("partial");
	});

	test("an attestation without a confirmed Community tool refuses the fallback", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: transportFailure }, { [CJ]: [tool("jira_search", ["jql"])] });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect([envelope.result.outcome, envelope.result.causeCode]).toEqual(["failed", "failed-transport"]);
		expect(envelope.result.repairAction).toContain("community-schema");
		expect(calls.map((call) => call.server)).not.toContain(CJ);
	});

	test("a Community failure after fallover is final: no second provider retry", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: transportFailure, [`${CJ}.jira_get_issue`]: transportFailure });
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect(envelope.result.outcome).toBe("failed");
		expect(calls.filter((call) => call.tool === "jira_get_issue")).toHaveLength(1);
	});

	test("an explicit --provider community read is refused without the same exact attestation, and allowed with it", async () => {
		const refused = fakeTransport();
		const envelope = await dispatch(["--provider", "community", "page.get", "--input", '{"pageId":"123"}'], deps({ transport: refused.transport }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["refused", "refused-parity", 3]);
		expect(envelope.result.repairAction).toContain("parity-unproven");
		expect(refused.calls).toEqual([]);
		const allowed = fakeTransport();
		const ok = await dispatch(["--provider", "community", "page.get", "--input", '{"pageId":"123"}'], deps({ transport: allowed.transport, parity: async () => attested("page.get", ["pageId"]) }));
		expect(ok.result.outcome).toBe("success");
		expect(allowed.calls).toEqual([{ server: CC, tool: "confluence_get_page", args: { page_id: "123" } }]);
	});
});

describe("provider text never reaches the envelope", () => {
	const PRIVATE = ["fixture-secret-value", "customer SSN 123-45-6789", "PROJ-99 confidential merger", OP_TOKEN_SENTINEL, "op://", "Bearer", "Basic "];
	const leak = `token=fixture-secret-value Authorization: Basic ${OP_TOKEN_SENTINEL} Bearer x op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential; issue PROJ-99 confidential merger; customer SSN 123-45-6789; connect ETIMEDOUT`;

	test("classified failures carry fixed repair text, never stderr or stdout", async () => {
		for (const failure of [process_("process", 1, leak), process_("process", 1, "", leak), toolError(leak)]) {
			const { transport } = fakeTransport({ [`${OJ}.getJiraIssue`]: failure });
			const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
			const serialized = JSON.stringify(envelope);
			for (const fragment of PRIVATE) expect(serialized).not.toContain(fragment);
			expect(envelope.result.causeCode).toBe("failed-transport");
		}
	});

	test("an unexpected transport throw becomes a fixed failed-unknown envelope", async () => {
		const throwing: Transport = {
			async listTools() {
				return { ok: true, data: SCHEMAS[OJ] ?? [] };
			},
			async call() {
				throw new Error(`boom ${leak}`);
			},
		};
		const envelope = await dispatch(["issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: throwing, parity: async () => attested("issue.get", ["issueKey"]) }));
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.exitCode]).toEqual(["failed", "failed-unknown", 3]);
		const serialized = JSON.stringify(envelope);
		for (const fragment of ["boom", ...PRIVATE]) expect(serialized).not.toContain(fragment);
		expect(envelope.result.provenance.map((entry) => entry.status)).toEqual(["failed-unknown"]);
	});
});

describe("journaled writes", () => {
	const COMMENT = { issueKey: "PROJ-1", body: "Quarterly numbers are down; see the attached sheet" };
	const commentReply = { ok: true as const, data: { id: "10001", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: COMMENT.body }] }] } } };
	const previewData = (envelope: Awaited<ReturnType<typeof run>>) => envelope.result.data as { previewId: string; objectIdentity: string; revision: string | null; arguments: Record<string, unknown>; tool: string; server: string };

	test("preview records a durable preview bound to the exact provider arguments and touches no write tool", async () => {
		const { transport, calls } = fakeTransport();
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.exitCode, envelope.result.effectClass, envelope.result.commandIdentity]).toEqual(["success", 0, "local", "atlassian.issue.comment.preview"]);
		const data = previewData(envelope);
		expect([data.server, data.tool, data.objectIdentity, data.revision]).toEqual([OJ, "addOrEditJiraIssueComment", "issue:PROJ-1", null]);
		expect(data.arguments).toEqual({ cloudId: "cloud-example", issueIdOrKey: "PROJ-1", commentBody: COMMENT.body });
		expect(calls.map((call) => call.tool)).toEqual(["getAccessibleAtlassianResources", "getJiraIssue"]);
		const previews = readJsonDir(previewsDir());
		expect(previews.map((entry) => [entry.previewId, entry.status, entry.argsDigest])).toEqual([[data.previewId, "open", testDigest(data.arguments)]]);
		expect(JSON.stringify(previews)).not.toContain("Quarterly");
	});

	test("apply marks sending on disk before the request, sends exactly the journal-bound arguments, and completes with the provider's effect", async () => {
		const sendStates: string[] = [];
		const { transport, calls } = fakeTransport({ [`${OJ}.addOrEditJiraIssueComment`]: commentReply }, {}, (call) => {
			if (call.tool === "addOrEditJiraIssueComment") sendStates.push(...readJsonDir(receiptsDir()).map((entry) => `${entry.status}:${entry.send}`));
		});
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([envelope.result.outcome, envelope.result.exitCode, envelope.result.effectClass, envelope.result.transactionState]).toEqual(["success", 0, "external", "completed"]);
		expect(envelope.result.effects).toEqual({ completed: ["jira-comment:10001"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(sendStates).toEqual(["intent:possible"]);
		const sent = calls.filter((call) => call.tool === "addOrEditJiraIssueComment");
		expect(sent).toHaveLength(1);
		// The outbound object is the receipt-bound one: its digest is the preview's argsDigest.
		const stored = readJsonDir(previewsDir())[0];
		expect(testDigest(sent[0]?.args)).toBe(stored?.argsDigest as string);
		expect(readJsonDir(receiptsDir()).map((entry) => [entry.status, entry.send, entry.effects])).toEqual([["completed", "possible", [{ kind: "jira-comment", id: "10001" }]]]);
		// The same preview cannot be applied twice.
		const again = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([again.result.causeCode, again.result.repairAction?.endsWith("preview-consumed")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "addOrEditJiraIssueComment")).toHaveLength(1);
	});

	test("changed input, changed provider, or a foreign preview id refuse the apply before any send", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.addOrEditJiraIssueComment`]: commentReply });
		const dependencies = deps({ transport, parity: async () => attested("issue.get", ["issueKey"]) });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const changed = await dispatch(["issue.comment", "--input", JSON.stringify({ ...COMMENT, body: "edited" }), "--apply", preview.previewId], dependencies);
		expect([changed.result.causeCode, changed.result.repairAction?.endsWith("preview-input-mismatch")]).toEqual(["refused-preview", true]);
		const unknown = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", "nope"], dependencies);
		expect([unknown.result.causeCode, unknown.result.repairAction?.endsWith("preview-unknown")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "addOrEditJiraIssueComment")).toEqual([]);
		expect(readJsonDir(receiptsDir())).toEqual([]);
	});

	test("a lost reply after the send mark is an unknown outcome that blocks the object; read-back proof through adjudicate releases it", async () => {
		const lost = process_("process", 1, "connect ECONNRESET");
		const { transport, calls } = fakeTransport({ [`${OJ}.addOrEditJiraIssueComment`]: lost, [`${OJ}.getJiraIssue`]: { ok: true, data: { key: "PROJ-1", fields: { updated: "t1", comment: { comments: [{ id: "777", body: "unrelated" }] } } } } });
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const envelope = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([envelope.result.outcome, envelope.result.causeCode, envelope.result.transactionState, envelope.result.exitCode]).toEqual(["failed", "outcome-unknown", "unknown", 3]);
		expect(envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: ["issue:PROJ-1"], inventoryComplete: false });
		expect(envelope.result.nextAction).toContain("adjudicate");
		// Preview and apply both bind the matching-comment baseline before the
		// possible send. The immediate read-back found nothing, which proves
		// nothing after a possible send.
		expect(calls.map((call) => call.tool)).toEqual(["getAccessibleAtlassianResources", "getJiraIssue", "getAccessibleAtlassianResources", "getJiraIssue", "addOrEditJiraIssueComment", "getJiraIssue"]);
		const runId = (envelope.result.data as { runId: string }).runId;
		const receipts = await dispatch(["receipts"], dependencies);
		expect((receipts.result.data as { open: { runId: string; status: string; send: string }[] }).open.map((entry) => [entry.runId, entry.status, entry.send])).toEqual([[runId, "unknown", "possible"]]);
		// Any write on the object is blocked while the receipt is open.
		const blockedInput = { issueKey: "PROJ-1", body: "a separate comment" };
		const blockedPreview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(blockedInput), "--preview"], dependencies));
		const blocked = await dispatch(["issue.comment", "--input", JSON.stringify(blockedInput), "--apply", blockedPreview.previewId], dependencies);
		expect([blocked.result.causeCode, blocked.result.repairAction?.endsWith("write-blocked-open-receipt")]).toEqual(["refused-write-blocked", true]);
		expect(calls.filter((call) => call.tool === "editJiraIssue")).toEqual([]);
		// Adjudication with the wrong input is refused; with read-back still absent the receipt stays open.
		const wrong = await dispatch(["adjudicate", "--run", runId, "--input", '{"issueKey":"PROJ-1","body":"other"}'], dependencies);
		expect(wrong.result.causeCode).toBe("input-invalid");
		const absent = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect([absent.result.outcome, absent.result.causeCode, absent.result.repairAction?.endsWith("evidence-insufficient")]).toEqual(["refused", "refused-evidence", true]);
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["unknown"]);
		// Read-back now finds the comment: the receipt completes with the found effect.
		const found = fakeTransport({ [`${OJ}.getJiraIssue`]: { ok: true, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "10001", body: { content: [{ type: "text", text: COMMENT.body }] } }] } } } } });
		const resolved = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], deps({ transport: found.transport }));
		expect([resolved.result.outcome, resolved.result.transactionState, resolved.result.effects.completed]).toEqual(["success", "completed", ["jira-comment:10001"]]);
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["completed"]);
	});

	test("a public adjudication does not count an identical historical Jira comment as a newly completed effect", async () => {
		const historical = { ok: true as const, data: { key: "PROJ-1", fields: { comment: { comments: [{ id: "777", body: COMMENT.body }] } } } };
		const { transport } = fakeTransport({ [`${OJ}.addOrEditJiraIssueComment`]: process_("process", 1, "connect ECONNRESET"), [`${OJ}.getJiraIssue`]: historical });
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		expect([applied.result.causeCode, applied.result.transactionState]).toEqual(["outcome-unknown", "unknown"]);
		const runId = (applied.result.data as { runId: string }).runId;
		const adjudicated = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect(adjudicated.result.causeCode).toBe("refused-evidence");
		expect(readJsonDir(receiptsDir()).map((entry) => entry.status)).toEqual(["unknown"]);
	});

	test("a public Jira comment adjudication completes only when a new comment id appears after its baseline", async () => {
		let reads = 0;
		const { transport } = fakeTransport({
			[`${OJ}.addOrEditJiraIssueComment`]: process_("process", 1, "connect ECONNRESET"),
			[`${OJ}.getJiraIssue`]: () => ({ ok: true, data: { key: "PROJ-1", fields: { comment: { comments: reads++ >= 3 ? [{ id: "778", body: COMMENT.body }] : [] } } } }),
		});
		const dependencies = deps({ transport });
		const preview = previewData(await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies));
		const applied = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--apply", preview.previewId], dependencies);
		const runId = (applied.result.data as { runId: string }).runId;
		const resolved = await dispatch(["adjudicate", "--run", runId, "--input", JSON.stringify(COMMENT)], dependencies);
		expect([applied.result.transactionState, resolved.result.transactionState, resolved.result.effects.completed]).toEqual(["unknown", "completed", ["jira-comment:778"]]);
	});

	test("public Jira create adjudication rejects a historical title and accepts only a new issue key", async () => {
		const input = { projectKey: "PROJ", issueType: "Bug", summary: "Baseline-safe create" };
		const historical = { ok: true as const, data: { issues: [{ key: "PROJ-9", fields: { summary: input.summary, issuetype: { name: input.issueType } } }] } };
		const old = fakeTransport({ [`${OJ}.createJiraIssue`]: process_("process", 1, "connect ECONNRESET"), [`${OJ}.searchJiraIssuesUsingJql`]: historical });
		const oldDeps = deps({ transport: old.transport });
		const oldPreview = previewData(await dispatch(["issue.create", "--input", JSON.stringify(input), "--preview"], oldDeps));
		const oldApply = await dispatch(["issue.create", "--input", JSON.stringify(input), "--apply", oldPreview.previewId], oldDeps);
		const oldRun = (oldApply.result.data as { runId: string }).runId;
		expect((await dispatch(["adjudicate", "--run", oldRun, "--input", JSON.stringify(input)], oldDeps)).result.causeCode).toBe("refused-evidence");

		const freshInput = { ...input, summary: "Baseline-safe create two" };
		let reads = 0;
		const fresh = fakeTransport({ [`${OJ}.createJiraIssue`]: process_("process", 1, "connect ECONNRESET"), [`${OJ}.searchJiraIssuesUsingJql`]: () => ({ ok: true, data: { issues: reads++ >= 3 ? [{ key: "PROJ-10", fields: { summary: freshInput.summary, issuetype: { name: freshInput.issueType } } }] : [] } }) });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await dispatch(["issue.create", "--input", JSON.stringify(freshInput), "--preview"], freshDeps));
		const freshApply = await dispatch(["issue.create", "--input", JSON.stringify(freshInput), "--apply", freshPreview.previewId], freshDeps);
		const freshRun = (freshApply.result.data as { runId: string }).runId;
		const freshResolved = await dispatch(["adjudicate", "--run", freshRun, "--input", JSON.stringify(freshInput)], freshDeps);
		expect([freshApply.result.transactionState, freshResolved.result.transactionState, freshResolved.result.effects.completed]).toEqual(["unknown", "completed", ["jira-issue:PROJ-10"]]);
	});

	test("public Confluence comment adjudication rejects a historical body and accepts only a new comment id", async () => {
		const input = { pageId: "123", body: "baseline-safe comment" };
		const page = { ok: true as const, data: { id: "123", metadata: { version: 7, hasSpaceInstructions: false } } };
		const gate = async () => attested("page.get", ["pageId"]);
		const historical = fakeTransport({ [`${CC}.confluence_get_page`]: page, [`${CC}.confluence_add_comment`]: process_("process", 1, "connect ECONNRESET"), [`${CC}.confluence_get_comments`]: { ok: true, data: [{ id: "42", body: input.body }] } });
		const historicalDeps = deps({ transport: historical.transport, parity: gate });
		const oldPreview = previewData(await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(input), "--preview"], historicalDeps));
		const oldApply = await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(input), "--apply", oldPreview.previewId], historicalDeps);
		const oldRun = (oldApply.result.data as { runId: string }).runId;
		expect((await dispatch(["adjudicate", "--run", oldRun, "--input", JSON.stringify(input)], historicalDeps)).result.causeCode).toBe("refused-evidence");

		const freshInput = { pageId: "124", body: "baseline-safe comment two" };
		const freshPage = { ok: true as const, data: { id: "124", metadata: { version: 7, hasSpaceInstructions: false } } };
		let reads = 0;
		const fresh = fakeTransport({ [`${CC}.confluence_get_page`]: freshPage, [`${CC}.confluence_add_comment`]: process_("process", 1, "connect ECONNRESET"), [`${CC}.confluence_get_comments`]: () => ({ ok: true, data: reads++ >= 3 ? [{ id: "43", body: freshInput.body }] : [] }) });
		const freshDeps = deps({ transport: fresh.transport, parity: gate });
		const freshPreview = previewData(await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(freshInput), "--preview"], freshDeps));
		const freshApply = await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(freshInput), "--apply", freshPreview.previewId], freshDeps);
		const freshRun = (freshApply.result.data as { runId: string }).runId;
		const freshResolved = await dispatch(["adjudicate", "--run", freshRun, "--input", JSON.stringify(freshInput)], freshDeps);
		expect([freshApply.result.transactionState, freshResolved.result.transactionState, freshResolved.result.effects.completed]).toEqual(["unknown", "completed", ["confluence-comment:43"]]);
	});

	test("public Confluence create adjudication rejects a historical title and accepts only a new content id", async () => {
		const input = { space: { id: "9001", key: "ENG" }, title: "Baseline-safe page", body: "body" };
		const space = { ok: true as const, data: { results: [{ id: "555", space: { id: "9001", key: "ENG" } }] } };
		const instructions = { ok: true as const, data: { metadata: { hasSpaceInstructions: false } } };
		const response = (newAfter: number | null) => {
			let reads = 0;
			return (args: Record<string, unknown>) => {
				if (String(args.cql).includes('space = "ENG"')) return space;
				const id = newAfter !== null && reads++ >= newAfter ? "557" : "556";
			return { ok: true as const, data: { results: [{ id, title: input.title, space: { id: "9001", key: "ENG" } }] } };
			};
		};
		const historical = fakeTransport({ [`${OC}.searchConfluence`]: response(null), [`${OC}.getConfluenceSpace`]: instructions, [`${OC}.createConfluenceContent`]: process_("process", 1, "connect ECONNRESET") });
		const historicalDeps = deps({ transport: historical.transport });
		const oldPreview = previewData(await dispatch(["page.create", "--input", JSON.stringify(input), "--preview"], historicalDeps));
		const oldApply = await dispatch(["page.create", "--input", JSON.stringify(input), "--apply", oldPreview.previewId], historicalDeps);
		const oldRun = (oldApply.result.data as { runId: string }).runId;
		expect((await dispatch(["adjudicate", "--run", oldRun, "--input", JSON.stringify(input)], historicalDeps)).result.causeCode).toBe("refused-evidence");

		const freshInput = { space: { key: "ENG" }, title: "Baseline-safe page two", body: "body" };
		const fresh = fakeTransport({ [`${OC}.searchConfluence`]: (args) => {
			if (String(args.cql).includes('space = "ENG"')) return space;
			return { ok: true, data: { results: [] } };
		}, [`${OC}.getConfluenceSpace`]: instructions, [`${OC}.createConfluenceContent`]: process_("process", 1, "connect ECONNRESET") });
		const freshDeps = deps({ transport: fresh.transport });
		const freshPreview = previewData(await dispatch(["page.create", "--input", JSON.stringify(freshInput), "--preview"], freshDeps));
		const freshApply = await dispatch(["page.create", "--input", JSON.stringify(freshInput), "--apply", freshPreview.previewId], freshDeps);
		const freshRun = (freshApply.result.data as { runId: string }).runId;
		// A new, stable content id appears only during operator read-back.
		const resolvedTransport = fakeTransport({ [`${OC}.searchConfluence`]: (args) => String(args.cql).includes('space = "ENG"') ? space : { ok: true, data: { results: [{ id: "557", title: freshInput.title, space: { id: "9001", key: "ENG" } }] } }, [`${OC}.getConfluenceSpace`]: instructions });
		const freshResolved = await dispatch(["adjudicate", "--run", freshRun, "--input", JSON.stringify(freshInput)], deps({ transport: resolvedTransport.transport }));
		expect([freshApply.result.transactionState, freshResolved.result.transactionState, freshResolved.result.effects.completed]).toEqual(["unknown", "completed", ["confluence-content:557"]]);
	});

	test("a refusal before the send mark settles unchanged and keeps the object free", async () => {
		const { transport, calls } = fakeTransport({}, { [OJ]: [GUARD, tool("addOrEditJiraIssueComment", ["cloudId", "issueIdOrKey", "commentBody", "visibility"])] });
		const dependencies = deps({ transport });
		// The preview confirms the schema before even the tenant guard runs, so the mismatch makes no call at all.
		const preview = await dispatch(["issue.comment", "--input", JSON.stringify(COMMENT), "--preview"], dependencies);
		expect([preview.result.outcome, preview.result.causeCode]).toEqual(["failed", "capability-unavailable"]);
		expect(calls).toEqual([]);
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	test("Official page.update reads the page with full detail, binds its version and snapshot token, and refuses when the version moved", async () => {
		let version = 7;
		let body = "old";
		const page = () => ({ ok: true as const, data: { id: "123", title: "Roadmap", snapshotToken: `snap-${version}`, metadata: { version, hasSpaceInstructions: false }, body: { format: "markdown", value: body } } });
		const { transport, calls } = fakeTransport({ [`${OC}.getConfluenceContent`]: () => page(), [`${OC}.updateConfluenceContent`]: () => {
			version = 8;
			body = "# New body";
			return { ok: true, data: { ok: true } };
		} });
		const dependencies = deps({ transport });
		const input = { pageId: "123", body: "# New body", versionMessage: "connectors update" };
		const preview = previewData(await dispatch(["page.update", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect([preview.tool, preview.revision, preview.objectIdentity]).toEqual(["updateConfluenceContent", "7", "page:123"]);
		expect(preview.arguments).toEqual({ cloudId: "cloud-example", contentId: "123", body: { format: "markdown", value: "# New body" }, versionMessage: "connectors update", snapshotToken: "snap-7" });
		expect(calls.find((call) => call.tool === "getConfluenceContent")?.args).toEqual({ cloudId: "cloud-example", content_id: "123", content_format: "markdown", detail: "full", include_metadata: true });
		version = 8;
		const moved = await dispatch(["page.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([moved.result.causeCode, moved.result.repairAction?.endsWith("preview-args-mismatch")]).toEqual(["refused-preview", true]);
		expect(calls.filter((call) => call.tool === "updateConfluenceContent")).toEqual([]);
		version = 7;
		const applied = await dispatch(["page.update", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.transactionState, applied.result.effects.completed]).toEqual(["success", "completed", ["confluence-content:123"]]);
		expect(calls.find((call) => call.tool === "updateConfluenceContent")?.args).toEqual({ ...preview.arguments, snapshotToken: "snap-7" });
	});

	test("Official page.create resolves a space key to its numeric id through a page search before previewing; an unresolvable key refuses", async () => {
		const search = { ok: true as const, data: { results: [{ id: "555", title: "Home", space: { id: "9001", key: "ENG" } }] } };
		const { transport, calls } = fakeTransport({ [`${OC}.searchConfluence`]: search, [`${OC}.getConfluenceSpace`]: { ok: true, data: { metadata: { hasSpaceInstructions: false } } }, [`${OC}.createConfluenceContent`]: { ok: true, data: { id: "556", title: "Roadmap draft" } } });
		const dependencies = deps({ transport });
		const input = { space: { key: "ENG" }, title: "Roadmap draft", body: "x" };
		const preview = previewData(await dispatch(["page.create", "--input", JSON.stringify(input), "--preview"], dependencies));
		expect(preview.objectIdentity).toMatch(/^space:9001:create:root:[0-9a-f]{16}$/);
		expect(preview.arguments).toEqual({ cloudId: "cloud-example", parent: { spaceId: "9001" }, contentType: "page", title: "Roadmap draft", body: { format: "markdown", value: "x" } });
		expect(calls.find((call) => call.tool === "searchConfluence")?.args).toEqual({ cloudId: "cloud-example", cql: 'type = page AND space = "ENG"', maxResults: 5 });
		const applied = await dispatch(["page.create", "--input", JSON.stringify(input), "--apply", preview.previewId], dependencies);
		expect([applied.result.outcome, applied.result.effects.completed]).toEqual(["success", ["confluence-content:556"]]);
		const empty = fakeTransport({ [`${OC}.searchConfluence`]: { ok: true, data: { results: [] } } });
		const unresolved = await dispatch(["page.create", "--input", JSON.stringify(input), "--preview"], deps({ transport: empty.transport }));
		expect([unresolved.result.outcome, unresolved.result.causeCode]).toEqual(["refused", "space-unresolved"]);
		expect(readJsonDir(previewsDir())).toHaveLength(1);
	});

	test("Confluence writes require the current authoritative false instruction observation before preview or any write call", async () => {
		const input = { pageId: "123", body: "# New body" };
		for (const metadata of [{ hasSpaceInstructions: true }, {}, { hasSpaceInstructions: "false" }]) {
			const { transport, calls } = fakeTransport({
				[`${OC}.getConfluenceContent`]: { ok: true, data: { id: "123", title: "Roadmap", snapshotToken: "snap-7", metadata: { version: 7, ...metadata }, body: { format: "markdown", value: "old" } } },
			});
			const refused = await dispatch(["page.update", "--input", JSON.stringify(input), "--preview"], deps({ transport }));
			expect([refused.result.causeCode, refused.result.repairAction?.includes("getConfluenceSpace retrieval")]).toEqual(["capability-unavailable", true]);
			expect(calls.map((call) => call.tool)).not.toContain("updateConfluenceContent");
			expect(readJsonDir(previewsDir())).toEqual([]);
		}
	});

	test("Confluence create and Community comment do not create previews or call write tools without authoritative false instructions", async () => {
		const create = fakeTransport({ [`${OC}.searchConfluence`]: { ok: true, data: { results: [{ id: "555", space: { id: "9001", key: "ENG" } }] } } });
		const createEnvelope = await dispatch(["page.create", "--input", '{"space":{"key":"ENG"},"title":"Roadmap","body":"x"}', "--preview"], deps({ transport: create.transport }));
		expect(createEnvelope.result.causeCode).toBe("capability-unavailable");
		expect(create.calls.map((call) => call.tool)).not.toContain("createConfluenceContent");
		expect(readJsonDir(previewsDir())).toEqual([]);

		const comment = fakeTransport();
		const current = attested("page.get", ["pageId"]) as { status: "attested"; attestation: ParityAttestation };
		const commentEnvelope = await dispatch(["--provider", "community", "page.comment", "--input", '{"pageId":"123","body":"hello"}', "--preview"], deps({ transport: comment.transport, parity: async () => current }));
		expect(commentEnvelope.result.causeCode).toBe("capability-unavailable");
		expect(comment.calls.map((call) => call.tool)).not.toContain("confluence_add_comment");
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	test("issue.update fails closed until the selected Provider exposes a stable revision, never treating updated as one", async () => {
		const issue = { ok: true as const, data: { key: "PROJ-1", fields: { updated: "2026-09-22T01:00:00.000+0000", summary: "old" } } };
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: issue, [`${OJ}.editJiraIssue`]: process_("process", 1, "connect ECONNRESET") });
		const dependencies = deps({ transport });
		const input = { issueKey: "PROJ-1", fields: { summary: "new" } };
		const preview = await dispatch(["issue.update", "--input", JSON.stringify(input), "--preview"], dependencies);
		expect([preview.result.outcome, preview.result.causeCode, preview.result.repairAction?.includes("stable revision")]).toEqual(["failed", "capability-unavailable", true]);
		expect(calls.map((call) => call.tool)).toEqual(["getAccessibleAtlassianResources", "getJiraIssue"]);
		expect(readJsonDir(previewsDir())).toEqual([]);
	});

	test("Official page.comment is unavailable by contract; Community carries it only behind the product's base-read attestation", async () => {
		const { transport, calls } = fakeTransport({ [`${CC}.confluence_get_page`]: { ok: true, data: { id: "123", metadata: { version: 7, hasSpaceInstructions: false } } }, [`${CC}.confluence_add_comment`]: { ok: true, data: { success: true, comment: { id: "42", body: "hello" } } } });
		const input = { pageId: "123", body: "hello" };
		const official = await dispatch(["page.comment", "--input", JSON.stringify(input), "--preview"], deps({ transport }));
		expect([official.result.outcome, official.result.causeCode, official.result.exitCode]).toEqual(["refused", "operation-unavailable", 3]);
		expect(official.result.repairAction).toContain("executeWrite");
		const ungated = await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(input), "--preview"], deps({ transport }));
		expect([ungated.result.causeCode, ungated.result.repairAction?.includes("parity-unproven")]).toEqual(["refused-parity", true]);
		expect(calls).toEqual([]);
		const gated = deps({ transport, parity: async (request) => (request.operation === "page.get" && request.inputShape.join() === "pageId" ? attested("page.get", ["pageId"]) : UNPROVEN) });
		const preview = previewData(await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(input), "--preview"], gated));
		expect([preview.server, preview.tool, preview.arguments]).toEqual([CC, "confluence_add_comment", { page_id: "123", body: "hello" }]);
		const applied = await dispatch(["--provider", "community", "page.comment", "--input", JSON.stringify(input), "--apply", preview.previewId], gated);
		expect([applied.result.outcome, applied.result.effects.completed]).toEqual(["success", ["confluence-comment:42"]]);
	});

	test("unlock clears a dead holder's lock through the receipt or its preview and refuses an unknown reference", async () => {
		const dependencies = deps();
		const journal = dependencies.journal("example");
		const preview = journal.recordPreview({ operation: "issue.comment", provider: "official", canonicalInput: COMMENT, providerArgs: COMMENT, revision: null });
		const receipt = await journal.apply({ previewId: preview.previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: null }, async () => ({ proof: "unknown" }));
		writeFileSync(path.join(stateRoot, "connectors", "atlassian", "example", "locks", "issue_PROJ-1.lock"), JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: NOW }), { mode: 0o600 });
		const unlocked = await dispatch(["unlock", "--run", receipt.runId], dependencies);
		expect([unlocked.result.outcome, unlocked.result.effectClass, unlocked.result.data]).toEqual(["success", "local", { runId: receipt.runId, objectIdentity: "issue:PROJ-1", unlocked: true }]);
		expect(readdirSync(path.join(stateRoot, "connectors", "atlassian", "example", "locks"))).toEqual([]);
		const preIntentPreview = journal.recordPreview({ operation: "issue.comment", provider: "official", canonicalInput: COMMENT, providerArgs: COMMENT, revision: null });
		writeFileSync(path.join(stateRoot, "connectors", "atlassian", "example", "locks", "issue_PROJ-1.lock"), JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: NOW }), { mode: 0o600 });
		const recovered = await dispatch(["unlock", "--run", preIntentPreview.previewId], dependencies);
		expect([recovered.result.outcome, recovered.result.effectClass, recovered.result.data]).toEqual(["success", "local", { previewId: preIntentPreview.previewId, objectIdentity: "issue:PROJ-1", unlocked: true }]);
		const missing = await dispatch(["unlock", "--run", "nope"], dependencies);
		expect([missing.result.causeCode, missing.result.repairAction?.endsWith("preview-unknown")]).toEqual(["refused-preview", true]);
		const shown = await dispatch(["receipt", "--run", receipt.runId], dependencies);
		expect((shown.result.data as { status: string }).status).toBe("unknown");
	});
});

describe("parity attestation", () => {
	const OFFICIAL_ISSUE = { ok: true as const, data: { id: "10001", key: "PROJ-1", fields: { summary: "x" } } };
	const COMMUNITY_ISSUE = { ok: true as const, data: { id: "10001", key: "PROJ-1", summary: "x" } };

	test("attests only when the Official principal is the item's username and both providers name the same object", async () => {
		const { transport, calls } = fakeTransport({ [`${OJ}.getJiraIssue`]: OFFICIAL_ISSUE, [`${CJ}.jira_get_issue`]: COMMUNITY_ISSUE });
		const envelope = await dispatch(["parity", "--operation", "issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport }));
		expect([envelope.result.outcome, envelope.result.effectClass, envelope.result.commandIdentity]).toEqual(["success", "local", "atlassian.parity"]);
		expect(calls.map((call) => [call.server, call.tool])).toEqual([
			[OJ, "getAccessibleAtlassianResources"],
			[OJ, "atlassianUserInfo"],
			[OJ, "getJiraIssue"],
			[CJ, "jira_get_issue"],
		]);
		expect(attestations).toEqual([
			{
				tenant: "example",
				product: "jira",
				operation: "issue.get",
				inputShape: ["issueKey"],
				origin: ORIGIN,
				credentialDigest: testDigest({ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN }),
				objectSemantics: "issue:key+id",
				recordedAt: NOW,
				expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
				source: "parity-attest",
			},
		]);
		expect(JSON.stringify(envelope)).not.toContain(PRINCIPAL);
	});

	test("refuses page parity when only nested ids agree", async () => {
		const { transport } = fakeTransport({
			[`${OC}.getConfluenceContent`]: { ok: true, data: { id: "9002", title: "Roadmap", version: 7, space: { id: "100" } } },
			[`${CC}.confluence_get_page`]: { ok: true, data: { id: "9003", title: "Roadmap", version: 7, space: { id: "100" } } },
		});
		const envelope = await dispatch(["parity", "--operation", "page.get", "--input", '{"pageId":"123"}'], deps({ transport }));
		expect([envelope.result.causeCode, envelope.result.repairAction?.endsWith("object-mismatch")]).toEqual(["refused-parity", true]);
		expect(attestations).toEqual([]);
	});

	test("credential revision and principal changes invalidate stored parity before Community is spawned", async () => {
		const { transport, calls } = fakeTransport();
		const stale = attested("issue.get", ["issueKey"]);
		const envelope = await dispatch(["--provider", "community", "issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({
			transport,
			parity: async () => stale,
			credentialContext: async () => ({ principal: "other@example.invalid", itemVersion: "onepassword-item-version:2", origin: ORIGIN }),
		}));
		expect([envelope.result.causeCode, envelope.result.repairAction?.includes("parity-mismatch")]).toEqual(["refused-parity", true]);
		expect(calls).toEqual([]);
	});

	test("a principal mismatch or an object mismatch records nothing", async () => {
		const otherUser = fakeTransport({ [`${OJ}.atlassianUserInfo`]: { ok: true, data: { email: "someone-else@example.invalid" } }, [`${OJ}.getJiraIssue`]: OFFICIAL_ISSUE, [`${CJ}.jira_get_issue`]: COMMUNITY_ISSUE });
		const principal = await dispatch(["parity", "--operation", "issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: otherUser.transport }));
		expect([principal.result.causeCode, principal.result.repairAction?.endsWith("principal-mismatch")]).toEqual(["refused-parity", true]);
		expect(otherUser.calls.map((call) => call.server)).not.toContain(CJ);
		const otherObject = fakeTransport({ [`${OJ}.getJiraIssue`]: OFFICIAL_ISSUE, [`${CJ}.jira_get_issue`]: { ok: true, data: { id: "10002", key: "PROJ-1" } } });
		const object = await dispatch(["parity", "--operation", "issue.get", "--input", '{"issueKey":"PROJ-1"}'], deps({ transport: otherObject.transport }));
		expect([object.result.causeCode, object.result.repairAction?.endsWith("object-mismatch")]).toEqual(["refused-parity", true]);
		expect(attestations).toEqual([]);
		const write = await dispatch(["parity", "--operation", "issue.comment", "--input", "{}"], deps());
		expect(write.result.causeCode).toBe("usage-invalid");
	});

	test("the durable attestation store round-trips through the file it owns and ignores foreign files", async () => {
		const env = { XDG_STATE_HOME: stateRoot };
		const store = parityStore(env);
		const attestation = (attested("issue.get", ["issueKey"]) as { attestation: ParityAttestation }).attestation;
		await store.attestParity(attestation);
		const request = { tenant: "example", product: "jira" as const, operation: "issue.get" as const, inputShape: ["issueKey"], origin: ORIGIN, credentialDigest: testDigest({ principal: PRINCIPAL, itemVersion: ITEM_VERSION, origin: ORIGIN }), now: NOW };
		expect(await store.parity(request)).toEqual({ status: "attested", attestation });
		const directory = path.join(stateRoot, "connectors", "atlassian", "example", "parity");
		const [file] = readdirSync(directory);
		chmodSync(path.join(directory, file ?? ""), 0o640);
		expect(await store.parity(request)).toEqual({ status: "unproven" });
		chmodSync(path.join(directory, file ?? ""), 0o4600);
		expect(await store.parity(request)).toEqual({ status: "unproven" });
		chmodSync(path.join(directory, file ?? ""), 0o600);
		expect(await store.parity({ ...request, inputShape: ["issueKey", "fields"] })).toEqual({ status: "unproven" });
		for (const file of readdirSync(directory)) writeFileSync(path.join(directory, file), '{"tenant":"example"}');
		expect(await store.parity(request)).toEqual({ status: "unproven" });
	});
});

describe("production adapters", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = createHarness({});
	});
	afterEach(() => harness.dispose());
	const env = () => ({ HOME: harness.home, PATH: process.env.PATH ?? "", TMPDIR: harness.root, XDG_STATE_HOME: harness.root });
	const fields = itemJson;

	test("the custody child performs one complete read and returns only the typed nonsecret context", async () => {
		harness.write("item.json", fields({ username: PRINCIPAL, credential: "x", site_url: "https://Example.atlassian.net/" }, 42));
		expect(await resolveCredentialContext("example", "confluence", env())).toEqual({ principal: PRINCIPAL, itemVersion: "onepassword-item-version:42", origin: ORIGIN });
		expect(readFileSync(path.join(harness.root, "wrapper.log"), "utf8").trim()).toBe("op item get CONFLUENCE_EXAMPLE_API_TOKEN --vault API Credentials --format json");
	});

	test("the credential-binding custody child reads a full item but emits only a nonsecret version binding", async () => {
		const secret = "fixture-custody-secret";
		harness.write("item.json", fields({ username: PRINCIPAL, credential: secret, site_url: ORIGIN }, 42));
		const result = await harness.run(["--tenant", "example", "--product", "jira"], {}, CREDENTIAL_BINDING);
		expect([result.code, result.stdout, result.stderr]).toEqual([0, '{"principal":"service@example.invalid","itemVersion":"onepassword-item-version:42","origin":"https://example.atlassian.net"}\n', ""]);
		const log = readFileSync(path.join(harness.root, "wrapper.log"), "utf8");
		expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr, log, argv: ["--tenant", "example", "--product", "jira"] })).not.toContain(secret);
		expect(log.trim()).toBe("op item get JIRA_EXAMPLE_API_TOKEN --vault API Credentials --format json");
	});

	test("the custody child reports a fixed wrapper repair cause without secret output", async () => {
		const result = await harness.run(["--tenant", "example", "--product", "jira"], { HOME: path.join(harness.root, "missing-wrapper-home") }, CREDENTIAL_BINDING);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "atlassian-credential-binding:error:credential-wrapper-missing:restore the dotfiles 1Password wrapper\n"]);
		expect(`${result.stdout}${result.stderr}`).not.toContain(OP_TOKEN_SENTINEL);
	});

	test("the dispatcher receives only the custody binding, and a missing item version refuses before Community starts", async () => {
		const secret = "fixture-custody-secret";
		harness.write("item.json", fields({ username: PRINCIPAL, site_url: ORIGIN, credential: secret }, 42));
		const bound = await resolveCredentialContext("example", "jira", env());
		expect(bound).toEqual({ principal: PRINCIPAL, itemVersion: "onepassword-item-version:42", origin: ORIGIN });
		const configured = await harness.run(["--tenant", "example", "--provider", "community", "issue.get", "--input", '{"issueKey":"PROJ-1"}', "--json"], {}, DISPATCH);
		const log = readFileSync(path.join(harness.root, "wrapper.log"), "utf8");
		for (const value of [secret, OP_TOKEN_SENTINEL]) {
			expect(configured.stdout).not.toContain(value);
			expect(configured.stderr).not.toContain(value);
			expect(log).not.toContain(value);
			expect(JSON.stringify(["--tenant", "example", "--provider", "community", "issue.get"])).not.toContain(value);
		}
		expect(harness.has("mcporter.json")).toBe(false);
		harness.write("item.json", fields({ username: PRINCIPAL, site_url: ORIGIN, credential: secret }));
		await expect(resolveCredentialContext("example", "jira", env())).rejects.toThrow(/credential-context-unavailable/);
	});

	test("a top-level item version change invalidates durable parity evidence", async () => {
		harness.write("item.json", fields({ username: PRINCIPAL, credential: "fixture-custody-secret", site_url: ORIGIN }, 42));
		const first = await resolveCredentialContext("example", "jira", env());
		const store = parityStore(env());
		const attestation = (attested("issue.get", ["issueKey"], { credentialDigest: testDigest(first) }) as { attestation: ParityAttestation }).attestation;
		await store.attestParity(attestation);
		harness.write("item.json", fields({ username: PRINCIPAL, credential: "fixture-custody-secret", site_url: ORIGIN }, 43));
		const rotated = await resolveCredentialContext("example", "jira", env());
		const request = { tenant: "example", product: "jira" as const, operation: "issue.get" as const, inputShape: ["issueKey"], origin: ORIGIN, credentialDigest: testDigest(rotated), now: NOW };
		expect(attestationMatches(await store.parity(request), request)).toEqual({ ok: false, reason: "fallback-ineligible:parity-mismatch" });
	});

	test("the token-management url is never used as the origin, and bad site urls are refused", async () => {
		harness.write("item.json", fields({ url: MANAGEMENT_URL }));
		await expect(resolveCredentialContext("example", "jira", env())).rejects.toThrow(/credential-context-unavailable/);
		for (const url of [MANAGEMENT_URL, "https://example.example.com", "https://user@example.atlassian.net", "https://example.atlassian.net/wiki", "https://example.atlassian.net?x=1", "https://example.atlassian.net#frag", "https://example.atlassian.net:8443"]) {
			harness.write("item.json", fields({ site_url: url, url: ORIGIN }));
			await expect(resolveCredentialContext("example", "jira", env())).rejects.toThrow(/credential-context-unavailable/);
		}
	});

	test("the public process stops before MCPorter when both site origin fields are absent", async () => {
		harness.write("item.json", fields({ username: PRINCIPAL }));
		const result = await harness.run(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}', "--json"], {}, DISPATCH);
		expect(result.code).toBe(3);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout) as { result: { causeCode: string; repairAction: string } };
		expect(envelope.result.causeCode).toBe("site-unresolved");
		expect(envelope.result.repairAction).toBe("the tenant's credential item must expose a valid site_url field");
		expect(harness.has("mcporter.json")).toBe(false);
});

	test("the public process refuses a legacy url when site_url is absent before MCPorter", async () => {
		const canned = path.join(harness.root, "canned", OJ);
		mkdirSync(canned, { recursive: true });
		writeFileSync(path.join(canned, "list.json"), JSON.stringify({ tools: SCHEMAS[OJ] }));
		writeFileSync(path.join(canned, "getAccessibleAtlassianResources.json"), JSON.stringify(RESOURCES));
		writeFileSync(path.join(canned, "getJiraIssue.json"), JSON.stringify({ key: "PROJ-1", summary: "legacy" }));
		harness.write("item.json", fields({ username: PRINCIPAL, url: "https://Example.atlassian.net/" }));
		const result = await harness.run(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}', "--json"], {}, DISPATCH);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = JSON.parse(result.stdout) as { result: { causeCode: string } };
		expect(envelope.result.causeCode).toBe("site-unresolved");
		expect(harness.has("mcporter.json")).toBe(false);
	});

	test("an invalid site_url wins over a valid legacy url and stops before MCPorter", async () => {
		harness.write("item.json", fields({ username: PRINCIPAL, site_url: "https://example.atlassian.net/wiki", url: ORIGIN }));
		const result = await harness.run(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}', "--json"], {}, DISPATCH);
		expect(result.code).toBe(3);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout) as { result: { causeCode: string; repairAction: string } };
		expect(envelope.result.causeCode).toBe("site-unresolved");
		expect(envelope.result.repairAction).toBe("the tenant's credential item must expose a valid site_url field");
		expect(harness.has("mcporter.json")).toBe(false);
	});

	test("the public process crosses the real route on the Jira product server with canned MCPorter responses", async () => {
		const canned = path.join(harness.root, "canned", OJ);
		mkdirSync(canned, { recursive: true });
		writeFileSync(path.join(canned, "list.json"), JSON.stringify({ tools: SCHEMAS[OJ] }));
		writeFileSync(path.join(canned, "getAccessibleAtlassianResources.json"), JSON.stringify(RESOURCES));
		writeFileSync(path.join(canned, "getJiraIssue.json"), JSON.stringify({ key: "PROJ-1", summary: "canned" }));
		harness.write("item.json", fields({ username: PRINCIPAL, url: MANAGEMENT_URL, site_url: ORIGIN }, 1));
		const result = await harness.run(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}', "--json"], {}, DISPATCH);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const custody = assertCustody(harness, result, ["fixture-atlassian-api-key", "fixture-community-secret"], "child");
		const envelope = JSON.parse(result.stdout) as { result: { outcome: string; data: unknown; provenance: { provider: string; tool: string }[] } };
		expect(envelope.result.outcome).toBe("success");
		expect(envelope.result.data).toEqual({ key: "PROJ-1", summary: "canned" });
		expect(envelope.result.provenance.map((entry) => [entry.provider, entry.tool])).toEqual([[OJ, "getAccessibleAtlassianResources"], [OJ, "getJiraIssue"]]);
		expect(custody.argv.slice(2)).toEqual(["call", `${OJ}.getJiraIssue`, "--args", '{"cloudId":"cloud-example","issueIdOrKey":"PROJ-1"}', "--output", "json", "--timeout", "30000", "--no-oauth"]);
	});

	test("a public-process write previews and applies through the real route and the private journal under XDG_STATE_HOME", async () => {
		const canned = path.join(harness.root, "canned", OJ);
		mkdirSync(canned, { recursive: true });
		writeFileSync(path.join(canned, "list.json"), JSON.stringify({ tools: SCHEMAS[OJ] }));
		writeFileSync(path.join(canned, "getAccessibleAtlassianResources.json"), JSON.stringify(RESOURCES));
		writeFileSync(path.join(canned, "getJiraIssue.json"), JSON.stringify({ key: "PROJ-1", fields: { comment: { comments: [] } } }));
		writeFileSync(path.join(canned, "addOrEditJiraIssueComment.json"), JSON.stringify({ id: "10001", body: "canned" }));
		harness.write("item.json", fields({ username: PRINCIPAL, url: MANAGEMENT_URL, site_url: ORIGIN }, 1));
		const input = '{"issueKey":"PROJ-1","body":"canned"}';
		const preview = await harness.run(["--tenant", "example", "issue.comment", "--input", input, "--preview"], {}, DISPATCH);
		expect([preview.code, preview.stderr]).toEqual([0, ""]);
		const previewId = (JSON.parse(preview.stdout) as { result: { data: { previewId: string } } }).result.data.previewId;
		const apply = await harness.run(["--tenant", "example", "issue.comment", "--input", input, "--apply", previewId], {}, DISPATCH);
		expect([apply.code, apply.stderr]).toEqual([0, ""]);
		const envelope = JSON.parse(apply.stdout) as { result: { transactionState: string; effects: { completed: string[] } } };
		expect([envelope.result.transactionState, envelope.result.effects.completed]).toEqual(["completed", ["jira-comment:10001"]]);
		expect(harness.receipt<{ argv: string[] }>("mcporter.json").argv.slice(2, 5)).toEqual(["call", `${OJ}.addOrEditJiraIssueComment`, "--args"]);
		const receipts = readJsonDir(path.join(harness.root, "connectors", "atlassian", "example", "receipts"));
		expect(receipts.map((entry) => [entry.status, entry.send])).toEqual([["completed", "possible"]]);
	});
});
