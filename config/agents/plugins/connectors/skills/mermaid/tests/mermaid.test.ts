// Ticket #94 under Spec #87 (AC2, AC15, AC20, AC21): the packaged
// `bin/connectors` reaches Mermaid's keyless tier through the generic `run`
// and `schema` commands. Every process runs in a sandbox that allows loopback
// only and denies any Keychain command. MCPorter is the official 0.14.0
// release selected from local fixture bytes, a hostile `mcporter` sits first
// on PATH, and the hosted endpoint is replaced by this Skill's loopback stub.
// Expected values are test-owned literals: the tool names restate the
// 2026-09-26 live schema receipt, and causes restate the accepted contract.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, createFakeMcporterBinDir, PLUGIN_ROOT } from "../../../tests/harness.ts";
import { STUB_RENDER_RESULT, startMermaidStub } from "./fixtures/mermaid-mcp-stub.ts";

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

const LOOPBACK_ONLY = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "localhost:*"))(deny process-exec (literal "/usr/bin/security"))';
// Ambient credentials a leaky keyless route would carry toward MCPorter or
// the hosted server.
const TOKEN_SENTINEL = "SENTINEL_MERMAID_API_TOKEN_VALUE";
const OP_SENTINEL = "SENTINEL_MERMAID_OP_SERVICE_TOKEN";
// Independent oracle: the keyless Mermaid read tools in the live receipt.
const KEYLESS_TOOLS = ["validate_and_render_mermaid_diagram", "get_diagram_title", "get_diagram_summary", "search_mermaid_icons", "get_mermaid_syntax_document"];
// Independent oracle: the account tier's tools in the authenticated
// 2026-09-26 receipt, three reads then two writes, and the whole catalogue
// Ticket #94 declares, each with its tier and kind.
const ACCOUNT_TOOLS = ["list_mermaid_chart_projects", "list_mermaid_chart_diagrams", "get_mermaid_chart_diagram", "create_mermaid_chart_diagram", "update_mermaid_chart_diagram"];
const CATALOGUE = [
	...KEYLESS_TOOLS.map((name) => ({ name, tier: "keyless", kind: "read" })),
	{ name: "list_mermaid_chart_projects", tier: "account", kind: "read" },
	{ name: "list_mermaid_chart_diagrams", tier: "account", kind: "read" },
	{ name: "get_mermaid_chart_diagram", tier: "account", kind: "read" },
	{ name: "create_mermaid_chart_diagram", tier: "account", kind: "write" },
	{ name: "update_mermaid_chart_diagram", tier: "account", kind: "write" },
];
// Independent oracle: the accepted evidence state before any live proof.
const UNPROVEN_EVIDENCE = { configured: true, localReady: null, custodyChecked: null, authenticated: false, schemaQualified: false, liveReadProven: false, liveWriteProven: false, fixtureTested: null };

interface Fixture {
	readonly stub: ReturnType<typeof startMermaidStub>;
	readonly registry: string;
	run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	dispose(): void;
}

function mermaidFixture(): Fixture {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const stub = startMermaidStub();
	cpSync(path.join(PLUGIN_ROOT, "skills", "mermaid", "config"), path.join(bundle.skillsRoot, "mermaid", "config"), { recursive: true });
	const registry = path.join(bundle.skillsRoot, "mermaid", "config", "mcporter.json");
	const parsed = JSON.parse(readFileSync(registry, "utf8"));
	parsed.mcpServers.mermaid.baseUrl = stub.url;
	writeFileSync(registry, JSON.stringify(parsed));
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(home);
	mkdirSync(state);
	const env = {
		HOME: home, PATH: `${hostile.binDir}:/usr/bin:/bin`, TMPDIR: bundle.root, XDG_STATE_HOME: state,
		CONNECTORS_TEST_RELEASE_DIR: official ?? path.join(bundle.root, "no-release-fixture"),
		MERMAID_API_TOKEN: TOKEN_SENTINEL, OP_SERVICE_ACCOUNT_TOKEN: OP_SENTINEL,
	};
	return {
		stub, registry,
		async run(argv) {
			const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", LOOPBACK_ONLY, bundle.binary, ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { code, stdout, stderr };
		},
		dispose() {
			stub.stop();
			hostile.dispose();
			bundle.dispose();
		},
	};
}

function onlyEnvelope(result: { stdout: string; stderr: string }): { result: Record<string, any> } {
	expect(result.stderr).toBe("");
	expect(result.stdout.trim().split("\n")).toHaveLength(1);
	for (const sentinel of [TOKEN_SENTINEL, OP_SENTINEL]) expect(result.stdout).not.toContain(sentinel);
	return JSON.parse(result.stdout);
}

function expectNoCredentialSent(stub: Fixture["stub"]): void {
	expect(stub.headers.length).toBeGreaterThan(0);
	for (const headers of stub.headers) {
		const names = (JSON.parse(headers) as [string, string][]).map(([name]) => name.toLowerCase());
		expect(names).not.toContain("authorization");
		for (const sentinel of [TOKEN_SENTINEL, OP_SENTINEL]) expect(headers).not.toContain(sentinel);
	}
}

test.skipIf(!official)("keyless run reaches each allow-listed Mermaid read with no credential, and status stays unproven", async () => {
	const fixture = mermaidFixture();
	try {
		// [tool, --input], in invocation order; only the first bootstraps MCPorter.
		const rows: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
			["validate_and_render_mermaid_diagram", { prompt: "two steps", mermaidCode: "flowchart LR\n  A --> B", diagramType: "flowchart", clientName: "connectors" }],
			["get_diagram_title", { diagramContent: "flowchart LR\n  A --> B", clientName: "connectors" }],
			["get_diagram_summary", { diagramContent: "flowchart LR\n  A --> B", clientName: "connectors" }],
			["search_mermaid_icons", { query: "database", limit: 3, clientName: "connectors" }],
			["get_mermaid_syntax_document", { diagramType: "sequenceDiagram", clientName: "connectors" }],
		];
		for (const [index, [tool, input]] of rows.entries()) {
			const result = await fixture.run(["run", "mermaid", tool, "--input", JSON.stringify(input)]);
			expect({ index, code: result.code }).toEqual({ index, code: 0 });
			const envelope = onlyEnvelope(result).result;
			expect({ index, identity: envelope.commandIdentity, cause: envelope.causeCode, completed: envelope.effects.completed }).toEqual({
				index, identity: "connectors.run", cause: index === 0 ? "SUCCESS_BOOTSTRAPPED" : "SUCCESS_UNCHANGED", completed: index === 0 ? ["mcporter-bootstrap"] : [],
			});
			expect(envelope.data).toEqual({ connector: "mermaid", operation: tool, tier: "keyless", result: STUB_RENDER_RESULT });
		}
		expect(fixture.stub.calls).toEqual(rows.map(([name, input]) => ({ name, arguments: input })));
		expectNoCredentialSent(fixture.stub);
		// A fixture read never promotes Mermaid to any live state.
		const status = onlyEnvelope(await fixture.run(["status", "mermaid"])).result;
		expect(status.data.connectors).toEqual([{ id: "mermaid", evidence: UNPROVEN_EVIDENCE }]);
	} finally {
		fixture.dispose();
	}
}, 90_000);

test.skipIf(!official)("schema returns the keyless tools the hosted server lists and declares the account read and write tools", async () => {
	const fixture = mermaidFixture();
	try {
		const result = await fixture.run(["schema", "mermaid"]);
		expect(result.code).toBe(0);
		const data = onlyEnvelope(result).result.data;
		expect(data.allowedTools).toEqual(KEYLESS_TOOLS);
		expect((data.schema.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual([...KEYLESS_TOOLS].sort());
		expect({ connector: data.connector, tier: data.tier, server: data.server }).toEqual({ connector: "mermaid", tier: "keyless", server: "mermaid" });
		// Declared, not live-listed: the account schema needs the credential.
		expect({ accountServer: data.accountServer, accountTools: data.accountTools, operations: data.operations }).toEqual({ accountServer: "mermaid-account", accountTools: ACCOUNT_TOOLS, operations: CATALOGUE });
		expect(fixture.stub.calls).toEqual([]);
		expectNoCredentialSent(fixture.stub);
	} finally {
		fixture.dispose();
	}
}, 60_000);

test("undeclared tools, misphased or malformed writes, unsupported auth, and a credentialed registry refuse before any Provider contact", async () => {
	const fixture = mermaidFixture();
	try {
		const secretInput = JSON.stringify({ owner: "o", repo: "r", path: "a.mmd", content: TOKEN_SENTINEL, branch: "main", message: "m", clientName: "connectors" });
		const secretWrite = JSON.stringify({ projectID: "proj-1", title: "t", clientName: "connectors", color: TOKEN_SENTINEL });
		const update = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title: "t", clientName: "connectors" });
		// [argv, exit, cause, connectorCause]; the header row rewrites the registry first.
		const rows: ReadonlyArray<readonly [string[], number, string, string]> = [
			[["run", "mermaid", "push_file", "--input", secretInput], 2, "USAGE_OPERATION_UNKNOWN", "operation-not-allowed"],
			[["run", "mermaid", "repair_mermaid_chart_diagram", "--input", secretInput], 2, "USAGE_OPERATION_UNKNOWN", "operation-not-allowed"],
			[["run", "mermaid", "validate_and_render_mermaid_diagram", "--input", secretInput, "--preview"], 2, "USAGE_ADAPTER_REFUSED", "read-takes-no-phase"],
			[["run", "mermaid", "update_mermaid_chart_diagram", "--input", update], 2, "USAGE_ADAPTER_REFUSED", "write-phase-required"],
			[["run", "mermaid", "create_mermaid_chart_diagram", "--input", secretWrite, "--preview"], 4, "SCHEMA_ADAPTER_REFUSED", "input-invalid"],
			[["run", "mermaid", "update_mermaid_chart_diagram", "--input", JSON.stringify({ documentID: "doc-1", projectID: "proj-1", clientName: "connectors" }), "--preview"], 4, "SCHEMA_ADAPTER_REFUSED", "input-invalid"],
			[["recover", "mermaid", "--run", "not-a-run-id"], 2, "USAGE_ADAPTER_REFUSED", "run-invalid"],
			[["auth", "login", "mermaid"], 3, "DOMAIN_AUTH_VERB_UNSUPPORTED", "auth-verb-unsupported"],
			[["run", "mermaid", "get_diagram_title", "--input", secretInput], 4, "SCHEMA_ADAPTER_REFUSED", "registry-not-keyless"],
		];
		for (const [index, [argv, exit, cause, connectorCause]] of rows.entries()) {
			if (cause === "SCHEMA_ADAPTER_REFUSED") {
				const parsed = JSON.parse(readFileSync(fixture.registry, "utf8"));
				parsed.mcpServers.mermaid.headers = { Authorization: "${MERMAID_API_TOKEN}" };
				writeFileSync(fixture.registry, JSON.stringify(parsed));
			}
			const result = await fixture.run(argv);
			const envelope = onlyEnvelope(result).result;
			expect({ index, code: result.code, cause: envelope.causeCode, connectorCause: envelope.data.connectorCause, completed: envelope.effects.completed }).toEqual({ index, code: exit, cause, connectorCause, completed: [] });
		}
		expect(fixture.stub.headers).toEqual([]);
	} finally {
		fixture.dispose();
	}
}, 60_000);
