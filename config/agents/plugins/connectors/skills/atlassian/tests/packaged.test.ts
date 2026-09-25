// Ticket #92 U1 and U2: Atlassian reads, the custody check, journaled writes,
// and recovery through the packaged front door (Spec #87 AC8, AC9, AC11, AC16,
// AC19, and AC20; configure and status are U3's). Every row
// spawns the compiled bin/connectors of the verified substituted plugin copy
// (plugin-copy.ts), which is compiled from source whose Keychain-read leaf is
// the test-owned reader fake and whose manifest admits the fake op and uv;
// the production-anchor row spawns the shipped binary. PATH holds only
// hostile recorders before /usr/bin:/bin, so no Bun, Node, op, uv, uvx, or
// MCPorter is reachable through it. MCPorter is the verified official release
// selected by the production bootstrap. The only process-table read is the
// fake uv's own parent-pid booleans. Substituted-source packaged process proof
// only: nothing here reads the real Keychain, runs the real op, or reaches a
// live Provider.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CustodyFixture, OFFICIAL_MCPORTER, PROVIDER_TOKEN, SERVICE_TOKEN, seedMcporter } from "./fixtures/custody-fixture.ts";
import { SHIPPED_ROOT, substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for the packaged Atlassian process proof");
// Taken at module scope so its removal binds to this file, not to the
// bootstrap hook below, which throws on failure.
substitutedPluginRoot();

// Test-owned literals of the accepted contract and fixture.
const PRINCIPAL = "service@example.invalid";
const ORIGIN = "https://example.atlassian.net";
const TENANT = ["--select", "tenant=example"];
const ITEM_READ = (title: string) => ["item", "get", title, "--vault", "API Credentials", "--format", "json"];
const JIRA_ITEM = "JIRA_EXAMPLE_API_TOKEN";
const CONFLUENCE_ITEM = "CONFLUENCE_EXAMPLE_API_TOKEN";
const OP_ENV_KEYS = ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"];
const ITEM_HANDOFF = "create the Atlassian API token in your Atlassian account settings and store it yourself in the 1Password item JIRA_EXAMPLE_API_TOKEN in the API Credentials vault; Connectors never creates, rotates, or imports a token";
const KEYCHAIN_HANDOFF = "store the Connectors 1Password service-account token in the login Keychain yourself: security add-generic-password -s connectors.1password.service-account -a connectors -w (it prompts for the value; Connectors never receives it)";
const UV_SETUP_REPAIR = "the plugin-owned uv is not set up; run connectors setup";
const WRITE_PHASE_REPAIR = "An Atlassian write needs --preview first, then --apply <previewId> with the identical --input";
const READ_PHASE_REPAIR = "An Atlassian read takes neither --preview nor --apply; run it without them";
const RECOVER_REPAIR = "Receipts, adjudication, and unlock are recover commands: run connectors recover atlassian --select tenant=<value> [--run <runId>]";
const USAGE_REPAIR = "Check the connectors run or recover arguments against connectors --help";
const UNKNOWN_OPERATION_REPAIR =
	"Use one Atlassian operation: issue.get, issue.search, issue.transitions, issue.create, issue.update, issue.comment, issue.comment.update, issue.attach, issue.transition, issue.assign, issue.delete, page.get, page.search, page.create, page.update, page.comment, page.attach, page.attachment.delete, page.delete";
const MCPORTER_REPAIR = "Run connectors deps repair mcporter";
// The dispatcher's fixed repair text for a not-found read.
const NOT_FOUND_REPAIR = "the target object was not found or is not visible to this principal";
const COMMUNITY_ARGV = ["tool", "run", "--system-certs", "--no-env-file", "--from", "mcp-atlassian==0.23.1", "mcp-atlassian"];
const JIRA_PROVIDER_KEYS = ["HOME", "JIRA_API_TOKEN", "JIRA_URL", "JIRA_USERNAME", "PATH", "TMPDIR", "XDG_STATE_HOME"];
const CONFLUENCE_PROVIDER_KEYS = ["CONFLUENCE_API_TOKEN", "CONFLUENCE_URL", "CONFLUENCE_USERNAME", "HOME", "PATH", "TMPDIR", "XDG_STATE_HOME"];
// The official MCPorter 0.14.0 darwin arm64 binary, as CI pins it.
const OFFICIAL_MCPORTER_SHA256 = "01d99ede8b6a88dd282eaeda2afb7086dca5bdbc04c05c8c21744703575adb27";
const tool = (name: string, required: string[], optional: string[] = []) => ({ name, description: name, inputSchema: { type: "object", required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, { type: "string" }])) } });
const JIRA_TOOLS = [
	tool("jira_get_issue", ["issue_key"], ["fields", "comment_limit"]),
	tool("jira_search", ["jql"], ["limit", "fields"]),
	tool("jira_get_transitions", ["issue_key"]),
	tool("jira_add_comment", ["issue_key", "body"], ["visibility", "public"]),
	tool("jira_update_issue", ["issue_key", "fields"], ["additional_fields", "components", "attachments", "return_fields"]),
];
const CONFLUENCE_TOOLS = [tool("confluence_get_page", ["page_id"]), tool("confluence_search", ["query"], ["limit"])];
const JIRA_REPLY = { key: "EX-1", summary: "canned packaged issue" };
const CONFLUENCE_REPLY = { id: "123", title: "canned packaged page" };
const SEARCH_REPLY = { issues: [{ key: "EX-2", summary: "canned packaged search hit" }] };
const TRANSITIONS_REPLY = [{ id: "31", name: "Done" }];
const PAGE_SEARCH_REPLY = [{ id: "456", title: "canned packaged page hit" }];
// One read binds its product once, then sends two MCPorter requests (the
// live schema list and the call); each request runs the Provider preflight
// and then the Provider, and each of those reads the item once.
const READ_OP_CALLS = 1 + 2 * 2;
const READ_PROVIDER_STARTS = 2;

interface Envelope {
	result: { commandIdentity: string; outcome: string; causeCode: string; exitCode: number; repairAction: string | null; nextAction: string; effectClass: string; transactionState: string; data: Record<string, unknown> | null; effects: { completed: string[]; uncertain: string[] } };
}
// The journal record a write or recover envelope carries under data.result.
interface JournalRecord {
	previewId: string;
	runId: string;
	objectIdentity: string;
	status: string;
	send: string;
	effects: { kind: string; id: string }[];
}
interface CommunityStart {
	argv: string[];
	envKeys: string[];
	jiraUrl: string | null;
	confluenceUrl: string | null;
	providerTokenMatches: boolean;
	serviceTokenInEnvironment: boolean;
	parentExecutable: string;
	parentEnvironmentVisible: boolean;
	parentHoldsServiceToken: boolean;
	parentHoldsProviderToken: boolean;
}

const parse = (stdout: string): Envelope => {
	expect(stdout.trim().split("\n")).toHaveLength(1);
	return JSON.parse(stdout) as Envelope;
};
const keychainRead = (fixture: CustodyFixture) => ({ argv: ["find-generic-password", "-s", "connectors.1password.service-account", "-a", "connectors", "-w", path.join(fixture.home, "Library", "Keychains", "login.keychain-db")], envKeys: ["HOME", "PATH"] });
const selectedMcporter = (fixture: CustodyFixture) => path.join(fixture.state, "connectors", "mcporter", "current", "mcporter");

// Streams and every file under the fixture root except the declared secret
// holders. The sweep must have read the fakes' own logs, or it proves nothing.
function expectNoSecret(fixture: CustodyFixture, streams: string[], sentinels: string[] = []): void {
	const sweep = fixture.sweepText();
	expect(sweep).toContain('"envKeys"');
	for (const surface of [...streams, sweep]) for (const secret of [SERVICE_TOKEN, PROVIDER_TOKEN, ...sentinels]) expect(surface).not.toContain(secret);
}

// No PATH lookup reached a same-named tool, and no Provider package started.
function expectNoHostile(fixture: CustodyFixture): void {
	expect(fixture.lines("hostile-recorders.jsonl")).toEqual([]);
	expect(fixture.lines("hostile-mcporter.jsonl")).toEqual([]);
}

// The service token reached op and only op; the provider token reached the
// Provider's replacement and never MCPorter, the process that started it.
// Counts default to one read; a write row pins its own from its sequence.
function expectConfinedRead(fixture: CustodyFixture, item: string, providerKeys: string[], counts = { opReads: READ_OP_CALLS, providerStarts: READ_PROVIDER_STARTS }): CommunityStart[] {
	expect(fixture.lines("op-calls.jsonl")).toEqual(Array.from({ length: counts.opReads }, () => ({ argv: ITEM_READ(item), envKeys: OP_ENV_KEYS, serviceTokenMatches: true })));
	expect(fixture.lines("keychain-reads.jsonl")).toEqual(Array.from({ length: counts.opReads }, () => keychainRead(fixture)));
	const starts = fixture.lines<CommunityStart>("community-starts.jsonl");
	expect(starts).toHaveLength(counts.providerStarts);
	const selected = realpathSync(selectedMcporter(fixture));
	for (const start of starts) {
		expect([start.argv, start.envKeys]).toEqual([COMMUNITY_ARGV, providerKeys]);
		// Positive control first: the Provider's replacement did hold the token.
		expect([start.providerTokenMatches, start.serviceTokenInEnvironment]).toEqual([true, false]);
		expect(realpathSync(start.parentExecutable)).toBe(selected);
		// The process-table oracle must actually see MCPorter's environment.
		expect([start.parentEnvironmentVisible, start.parentHoldsServiceToken, start.parentHoldsProviderToken]).toEqual([true, false, false]);
	}
	expectNoHostile(fixture);
	return starts;
}

let template: CustodyFixture | undefined;
let fixture: CustodyFixture;
const fresh = (options: { seed?: boolean; manifest?: "fixture" | "shipped" } = {}): CustodyFixture => {
	fixture = new CustodyFixture({ manifest: options.manifest ?? "fixture" }).installAll();
	fixture.writeItem({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN });
	fixture.canned("jira", "list", JIRA_TOOLS);
	fixture.canned("confluence", "list", CONFLUENCE_TOOLS);
	fixture.canned("jira", "jira_get_issue", JIRA_REPLY);
	fixture.canned("confluence", "confluence_get_page", CONFLUENCE_REPLY);
	fixture.canned("jira", "jira_search", SEARCH_REPLY);
	fixture.canned("jira", "jira_get_transitions", TRANSITIONS_REPLY);
	fixture.canned("confluence", "confluence_search", PAGE_SEARCH_REPLY);
	if (options.seed !== false && template) seedMcporter(template, fixture);
	return fixture;
};
afterEach(() => fixture?.dispose());

describe("refusals before any dependency, credential, or Provider", () => {
	test("an invalid read input refuses with the schema cause and starts nothing", async () => {
		fresh({ seed: false });
		const sentinel = "EX-input-sentinel-must-not-echo";
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", JSON.stringify({ issueKey: sentinel, bogus: 1 })]);
		expect([result.code, result.stderr]).toEqual([4, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.outcome, envelope.causeCode, envelope.transactionState, envelope.data]).toEqual(["connectors.run", "refused", "SCHEMA_ADAPTER_REFUSED", "unchanged", { connector: "atlassian", connectorCause: "input-invalid" }]);
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
		expect([existsSync(path.join(fixture.state, "connectors", "mcporter")), existsSync(path.join(fixture.state, "connectors", "atlassian"))]).toEqual([false, false]);
		expectNoHostile(fixture);
		for (const stream of [result.stdout, result.stderr]) expect(stream).not.toContain(sentinel);
	});

	test("the internal roles answer only with a valid context and a registered role; otherwise they are an unknown command", async () => {
		fresh({ seed: false });
		const unknown = parse((await fixture.frontDoor(["no-such-command"])).stdout).result;
		const context = { CONNECTORS_INTERNAL_INVOCATION_CONTEXT: '{"tenant":"example","product":"jira"}' };
		for (const [argv, extra] of [
			[["__internal", "atlassian", "provider"], {}],
			[["__internal", "atlassian", "custody-child"], {}],
			[["__internal", "atlassian", "dispatch"], context],
			[["__internal", "canva", "provider"], context],
			[["__internal", "atlassian", "__proto__"], context],
		] as const) {
			const result = await fixture.frontDoor([...argv], { extra });
			expect([argv.join(" "), result.code, result.stderr]).toEqual([argv.join(" "), 2, ""]);
			expect({ ...parse(result.stdout).result, runId: null }).toEqual({ ...unknown, runId: null });
		}
		expect(unknown.causeCode).toBe("USAGE_UNKNOWN_COMMAND");
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
		expectNoHostile(fixture);
	});

	// The copy compiled with the shipped digests and the fake Keychain reader:
	// the same rejection as the shipped binary, and a reader that records every
	// read, so an empty read log is an ordering oracle here.
	test("the shipped digests reject the fake uv before any Keychain read", async () => {
		fresh({ seed: false, manifest: "shipped" });
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv);
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", UV_SETUP_REPAIR, { connector: "atlassian", connectorCause: "refused-precondition" }]);
		}
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
		expectNoHostile(fixture);
	});

	// The shipped binary carries the real reader, which records nothing, so
	// this row proves only its cause.
	test("the shipped front door refuses the fake uv at its official path with the setup repair", async () => {
		fresh({ seed: false, manifest: "shipped" });
		const shipped = path.join(SHIPPED_ROOT, "bin", "connectors");
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv, { binary: shipped });
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", UV_SETUP_REPAIR, { connector: "atlassian", connectorCause: "refused-precondition" }]);
		}
	});

	test("a write without a phase, a phase on a read, an operator command, a bad write input, a bad receipt id, and an unknown operation refuse by their literal causes and start nothing", async () => {
		fresh({ seed: false });
		const sentinel = "EX-write-sentinel-must-not-echo";
		// [argv after the tenant, identity, cause, exit, connectorCause, repair]
		for (const [argv, identity, cause, exit, connectorCause, repair] of [
			[["run", "issue.create", "--input", JSON.stringify({ projectKey: "EX", summary: sentinel, issueType: "Task" })], "connectors.run", "USAGE_ADAPTER_REFUSED", 2, "write-phase-required", WRITE_PHASE_REPAIR],
			[["run", "issue.get", "--input", JSON.stringify({ issueKey: sentinel }), "--preview"], "connectors.run.preview", "USAGE_ADAPTER_REFUSED", 2, "read-takes-no-phase", READ_PHASE_REPAIR],
			[["run", "receipts"], "connectors.run", "USAGE_ADAPTER_REFUSED", 2, "recover-command", RECOVER_REPAIR],
			[["run", "issue.comment", "--input", JSON.stringify({ issueKey: "EX-1", body: "x", bogus: sentinel }), "--preview"], "connectors.run.preview", "SCHEMA_ADAPTER_REFUSED", 4, "input-invalid", "Correct the --input object to the operation's declared input"],
			[["recover", "--run", `bad/${sentinel}`], "connectors.recover", "USAGE_ADAPTER_REFUSED", 2, "usage-invalid", USAGE_REPAIR],
			[["run", "issue.nuke", "--input", JSON.stringify({ issueKey: sentinel })], "connectors.run", "USAGE_OPERATION_UNKNOWN", 2, "operation-unknown", UNKNOWN_OPERATION_REPAIR],
		] as const) {
			const [command, ...rest] = argv;
			const result = await fixture.frontDoor([command, "atlassian", ...TENANT, ...rest]);
			expect([argv[1], result.code, result.stderr]).toEqual([argv[1], exit, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[1], envelope.commandIdentity, envelope.causeCode, envelope.repairAction, envelope.transactionState, envelope.effects.completed, envelope.data]).toEqual([argv[1], identity, cause, repair, "unchanged", [], { connector: "atlassian", connectorCause }]);
			for (const stream of [result.stdout, result.stderr]) expect(stream).not.toContain(sentinel);
		}
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
		expect([existsSync(path.join(fixture.state, "connectors", "mcporter")), existsSync(path.join(fixture.state, "connectors", "atlassian"))]).toEqual([false, false]);
		expectNoHostile(fixture);
	});

	// No official release is needed: the release source is an empty directory,
	// so first-use selection fails after custody binds and the preflight runs.
	test("a failed MCPorter selection refuses with the repair and starts no Provider", async () => {
		fresh({ seed: false });
		const empty = path.join(fixture.root, "empty-release");
		mkdirSync(empty);
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], { extra: { CONNECTORS_TEST_RELEASE_DIR: empty } });
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.causeCode, envelope.repairAction, envelope.data, envelope.effects.completed]).toEqual(["connectors.run", "DOMAIN_MCPORTER_REPAIR_REQUIRED", MCPORTER_REPAIR, null, []]);
		// One custody bind and one Provider preflight each read the item once.
		expect(fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)).toEqual([ITEM_READ(JIRA_ITEM), ITEM_READ(JIRA_ITEM)]);
		expect([fixture.lines("community-starts.jsonl"), fixture.lines("effects.jsonl")]).toEqual([[], []]);
		expect(existsSync(selectedMcporter(fixture))).toBe(false);
		expectNoHostile(fixture);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	});
});

describe("custody check and credential handoffs", () => {
	test("auth check binds both products through the custody role, starts no MCPorter or Provider, and never claims authentication", async () => {
		fresh({ seed: false });
		const result = await fixture.frontDoor(["auth", "check", "atlassian", ...TENANT]);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.causeCode, envelope.effects.completed]).toEqual(["connectors.auth", "SUCCESS_UNCHANGED", []]);
		expect(envelope.data).toEqual({
			connector: "atlassian",
			custodyChecked: true,
			bindings: [
				{ product: "jira", principal: PRINCIPAL, itemVersion: "onepassword-item-version:1", origin: ORIGIN },
				{ product: "confluence", principal: PRINCIPAL, itemVersion: "onepassword-item-version:1", origin: ORIGIN },
			],
		});
		expect(fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)).toEqual([ITEM_READ(JIRA_ITEM), ITEM_READ(CONFLUENCE_ITEM)]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expectNoHostile(fixture);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	});

	test("an absent Keychain service token is a handoff for run and auth check, before op starts", async () => {
		fresh({ seed: false });
		fixture.removeKeychainToken();
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv);
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", KEYCHAIN_HANDOFF, { connector: "atlassian", connectorCause: "refused-credential-unconfigured" }]);
			expectNoSecret(fixture, [result.stdout, result.stderr]);
		}
		expect(fixture.lines("keychain-reads.jsonl")).toEqual([keychainRead(fixture), keychainRead(fixture)]);
		expect([fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], []]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expectNoHostile(fixture);
	});

	test("an absent 1Password item is a handoff for run and auth check, and op is only ever asked to read", async () => {
		fresh({ seed: false });
		rmSync(path.join(fixture.root, "item.json"));
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv);
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", ITEM_HANDOFF, { connector: "atlassian", connectorCause: "refused-credential-unconfigured" }]);
		}
		expect(fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)).toEqual([ITEM_READ(JIRA_ITEM), ITEM_READ(JIRA_ITEM)]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expectNoHostile(fixture);
	});
});

describe.skipIf(!OFFICIAL_MCPORTER)("reads, writes, and recovery through the verified MCPorter", () => {
	let firstUse: { code: number; stdout: string; stderr: string } | undefined;
	beforeAll(async () => {
		// One production first-use bootstrap through the packaged front door;
		// later fixtures reuse its selection. Only the selection is required
		// here, so a broken read fails in its own named row below.
		const first = fresh({ seed: false });
		firstUse = await first.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}']);
		if (!existsSync(selectedMcporter(first))) {
			first.dispose();
			throw new Error("packaged first use did not select the verified MCPorter");
		}
		template = first;
		fixture = undefined as unknown as CustodyFixture;
	}, 120_000);
	afterAll(() => template?.dispose());

	test("the first read bootstraps the verified MCPorter and reports that effect with the read's data", () => {
		expect([firstUse?.code, firstUse?.stderr]).toEqual([0, ""]);
		const envelope = parse(firstUse?.stdout ?? "").result;
		expect([envelope.commandIdentity, envelope.outcome, envelope.causeCode, envelope.transactionState, envelope.effects.completed, envelope.effects.uncertain]).toEqual(["connectors.run", "success", "SUCCESS_BOOTSTRAPPED", "completed", ["mcporter-bootstrap"], []]);
		expect(envelope.data).toEqual({ connector: "atlassian", operation: "issue.get", result: JIRA_REPLY, provenance: [{ provider: "atlassian-community-jira", tool: "jira_get_issue", status: "success" }] });
	});

	test("list admits the Atlassian manifest beside the other packaged connectors", async () => {
		fresh();
		const envelope = parse((await fixture.frontDoor(["list"])).stdout).result;
		expect((envelope.data?.connectors as { id: string }[]).map((entry) => entry.id)).toEqual(["atlassian", "canva", "context7", "firecrawl"]);
	});

	test("a Jira read reaches the declared operation through the plugin-owned MCPorter and confines both tokens", async () => {
		fresh();
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}']);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.outcome, envelope.causeCode, envelope.effects.completed]).toEqual(["connectors.run", "success", "SUCCESS_UNCHANGED", []]);
		expect(envelope.data).toEqual({ connector: "atlassian", operation: "issue.get", result: JIRA_REPLY, provenance: [{ provider: "atlassian-community-jira", tool: "jira_get_issue", status: "success" }] });
		expect(fixture.lines("effects.jsonl")).toEqual([{ product: "jira", tool: "jira_get_issue", args: { issue_key: "EX-1" } }]);
		const starts = expectConfinedRead(fixture, JIRA_ITEM, JIRA_PROVIDER_KEYS);
		expect(starts.map((start) => start.jiraUrl)).toEqual([ORIGIN, ORIGIN]);
		// Selected-binary integrity: the Provider's parent is the official release.
		expect(createHash("sha256").update(readFileSync(selectedMcporter(fixture))).digest("hex")).toBe(OFFICIAL_MCPORTER_SHA256);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	}, 60_000);

	test("a Confluence read reaches the declared operation on the Confluence route with the wiki origin and confines both tokens", async () => {
		fresh();
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "page.get", "--input", '{"pageId":"123"}']);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.causeCode]).toEqual(["connectors.run", "SUCCESS_UNCHANGED"]);
		expect(envelope.data).toEqual({ connector: "atlassian", operation: "page.get", result: CONFLUENCE_REPLY, provenance: [{ provider: "atlassian-community-confluence", tool: "confluence_get_page", status: "success" }] });
		expect(fixture.lines("effects.jsonl")).toEqual([{ product: "confluence", tool: "confluence_get_page", args: { page_id: "123" } }]);
		const starts = expectConfinedRead(fixture, CONFLUENCE_ITEM, CONFLUENCE_PROVIDER_KEYS);
		expect(starts.map((start) => start.confluenceUrl)).toEqual([`${ORIGIN}/wiki`, `${ORIGIN}/wiki`]);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	}, 60_000);

	test.each([
		["issue.search", { jql: "project = EX" }, "jira", "jira_search", { jql: "project = EX" }, SEARCH_REPLY, "atlassian-community-jira"],
		["issue.transitions", { issueKey: "EX-1" }, "jira", "jira_get_transitions", { issue_key: "EX-1" }, TRANSITIONS_REPLY, "atlassian-community-jira"],
		["page.search", { cql: "space = EX" }, "confluence", "confluence_search", { query: "space = EX" }, PAGE_SEARCH_REPLY, "atlassian-community-confluence"],
	] as const)("the %s read reaches its declared tool and confines both tokens", async (operation, input, product, providerTool, args, reply, provider) => {
		fresh();
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, operation, "--input", JSON.stringify(input)]);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.causeCode, envelope.effects.completed]).toEqual(["connectors.run", "SUCCESS_UNCHANGED", []]);
		expect(envelope.data).toEqual({ connector: "atlassian", operation, result: reply, provenance: [{ provider, tool: providerTool, status: "success" }] });
		expect(fixture.lines("effects.jsonl")).toEqual([{ product, tool: providerTool, args }]);
		expectConfinedRead(fixture, product === "jira" ? JIRA_ITEM : CONFLUENCE_ITEM, product === "jira" ? JIRA_PROVIDER_KEYS : CONFLUENCE_PROVIDER_KEYS);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	}, 60_000);

	test("a failed Provider read is a provider-call failure with the fixed repair and never echoes the Provider's text", async () => {
		fresh();
		const sentinel = "provider-text-sentinel-must-not-echo";
		fixture.canned("jira", "jira_get_issue", { toolErrorText: `Issue EX-404 does not exist ${sentinel}` });
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-404"}']);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.outcome, envelope.causeCode, envelope.repairAction, envelope.transactionState, envelope.data, envelope.effects.completed]).toEqual(["connectors.run", "failed", "DOMAIN_PROVIDER_CALL_FAILED", NOT_FOUND_REPAIR, "unchanged", null, []]);
		expect(fixture.lines("effects.jsonl")).toEqual([{ product: "jira", tool: "jira_get_issue", args: { issue_key: "EX-404" } }]);
		expectConfinedRead(fixture, JIRA_ITEM, JIRA_PROVIDER_KEYS);
		// The canned reply file holds the Provider's text by design, so the
		// sentinel is checked on the streams and the sweep checks the tokens.
		for (const stream of [result.stdout, result.stderr]) expect(stream).not.toContain(sentinel);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	}, 60_000);

	// Journaled writes (U2). The oracle for every Provider write is the fake's
	// effects.jsonl, never an envelope. A comment binds no revision, so its
	// preview sends two MCPorter requests (the schema list and the baseline
	// issue read) and its apply three (those two, then the comment); each binds
	// its product once, and each request reads the item twice (preflight and
	// Provider).
	const COMMENT = { issueKey: "EX-1", body: "packaged comment" };
	const COMMENT_ARGS = { issue_key: "EX-1", body: "packaged comment" };
	const issueWithComments = (comments: { id: string; body: string }[]) => ({ key: "EX-1", fields: { updated: "2026-09-25 09:00:00 AEST", comment: { comments } } });
	const PREVIEW_OP_CALLS = 1 + 2 * 2;
	const APPLY_OP_CALLS = 1 + 3 * 2;
	const PREVIEW_REFUSED = "the preview is unknown, consumed, expired, or no longer matches the input, provider arguments, or target revision; preview again";
	const write = (operation: string, input: unknown, phase: string[]) => fixture.frontDoor(["run", "atlassian", ...TENANT, operation, "--input", JSON.stringify(input), ...phase]);
	const recover = (...argv: string[]) => fixture.frontDoor(["recover", "atlassian", ...TENANT, ...argv]);
	const record = <T = JournalRecord>(envelope: Envelope["result"]): T => envelope.data?.result as T;
	const writesTo = (name: string) => fixture.lines<{ product: string; tool: string; args: unknown }>("effects.jsonl").filter((call) => call.tool === name);
	const station = (envelope: Envelope["result"]) => [envelope.commandIdentity, envelope.outcome, envelope.causeCode, envelope.effectClass, envelope.transactionState, envelope.effects.completed, envelope.effects.uncertain];
	async function previewComment(input: { issueKey: string; body: string } = COMMENT): Promise<JournalRecord> {
		const result = await write("issue.comment", input, ["--preview"]);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		return record(parse(result.stdout).result);
	}

	test("a comment preview records it without sending, its apply sends it once behind a durable receipt, and recover shows that receipt", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { id: "10001", body: "packaged comment" });
		const preview = await write("issue.comment", COMMENT, ["--preview"]);
		expect([preview.code, preview.stderr]).toEqual([0, ""]);
		const previewed = parse(preview.stdout).result;
		expect(station(previewed)).toEqual(["connectors.run.preview", "success", "SUCCESS_RUN_RECORDED", "repository-local", "completed", ["write-preview"], []]);
		expect(previewed.nextAction).toBe("connectors.run.apply");
		expect(writesTo("jira_add_comment")).toEqual([]);
		const apply = await write("issue.comment", COMMENT, ["--apply", record(previewed).previewId]);
		expect([apply.code, apply.stderr]).toEqual([0, ""]);
		const applied = parse(apply.stdout).result;
		expect(station(applied)).toEqual(["connectors.run.apply", "success", "SUCCESS_RUN_APPLIED", "external", "completed", ["write-receipt", "provider-write"], []]);
		const receipt = record(applied);
		expect([receipt.previewId, receipt.status, receipt.send, receipt.effects]).toEqual([record(previewed).previewId, "completed", "possible", [{ kind: "jira-comment", id: "10001" }]]);
		expect(writesTo("jira_add_comment")).toEqual([{ product: "jira", tool: "jira_add_comment", args: COMMENT_ARGS }]);
		const listed = await recover();
		expect([listed.code, listed.stderr]).toEqual([0, ""]);
		const list = parse(listed.stdout).result;
		expect([list.commandIdentity, list.causeCode, list.effects.completed, list.data]).toEqual(["connectors.recover", "SUCCESS_UNCHANGED", [], { connector: "atlassian", command: "receipts", result: { open: [] }, provenance: [] }]);
		const shown = parse((await recover("--run", receipt.runId)).stdout).result;
		expect([shown.commandIdentity, shown.causeCode, record(shown).runId, record(shown).status]).toEqual(["connectors.recover", "SUCCESS_UNCHANGED", receipt.runId, "completed"]);
		// Recovery inspection reads only the journal: no custody, op, or Provider.
		expectConfinedRead(fixture, JIRA_ITEM, JIRA_PROVIDER_KEYS, { opReads: PREVIEW_OP_CALLS + APPLY_OP_CALLS, providerStarts: 5 });
		expectNoSecret(fixture, [preview.stdout, preview.stderr, apply.stdout, apply.stderr, listed.stdout, listed.stderr]);
	}, 90_000);

	test("a preview whose target revision moved is refused at apply and sends no write", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", { key: "EX-1", fields: { updated: "2026-09-25 09:00:00 AEST", summary: "old" } });
		fixture.canned("jira", "jira_update_issue", { key: "EX-1" });
		const input = { issueKey: "EX-1", fields: { summary: "new" } };
		const previewed = await write("issue.update", input, ["--preview"]);
		expect([previewed.code, parse(previewed.stdout).result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
		fixture.canned("jira", "jira_get_issue", { key: "EX-1", fields: { updated: "2026-09-25 09:05:00 AEST", summary: "changed elsewhere" } });
		const apply = await write("issue.update", input, ["--apply", record(parse(previewed.stdout).result).previewId]);
		expect([apply.code, apply.stderr]).toEqual([3, ""]);
		const refused = parse(apply.stdout).result;
		expect([...station(refused), refused.repairAction, refused.data]).toEqual([
			"connectors.run.apply", "refused", "DOMAIN_ADAPTER_REFUSED", "inspect", "unchanged", [], [],
			`${PREVIEW_REFUSED}; preview-revision-changed`, { connector: "atlassian", connectorCause: "refused-preview" },
		]);
		expect(writesTo("jira_update_issue")).toEqual([]);
		expectNoSecret(fixture, [apply.stdout, apply.stderr]);
	}, 90_000);

	// The Provider refuses the write, and its read-back shows the revision
	// the preview bound: the receipt settles unchanged and the object is free.
	test("an apply the Provider refused, with the revision unchanged on read-back, reports the recorded receipt and no Provider change", async () => {
		fresh();
		const sentinel = "EX-tool-error-sentinel-must-not-echo";
		fixture.canned("jira", "jira_get_issue", { key: "EX-1", fields: { updated: "2026-09-25 09:00:00 AEST", summary: "old" } });
		fixture.canned("jira", "jira_update_issue", { toolErrorText: sentinel });
		const input = { issueKey: "EX-1", fields: { summary: "new" } };
		const previewed = await write("issue.update", input, ["--preview"]);
		expect([previewed.code, parse(previewed.stdout).result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
		const apply = await write("issue.update", input, ["--apply", record(parse(previewed.stdout).result).previewId]);
		expect([apply.code, apply.stderr]).toEqual([3, ""]);
		const failed = parse(apply.stdout).result;
		expect([...station(failed), failed.nextAction, failed.data?.connectorCause]).toEqual(["connectors.run.apply", "failed", "DOMAIN_RUN_FAILED_RECORDED", "repository-local", "completed", ["write-receipt"], [], "connectors.recover", "failed-unknown"]);
		expect([record(failed).status, record(failed).send]).toEqual(["unchanged", "possible"]);
		expect(writesTo("jira_update_issue")).toEqual([{ product: "jira", tool: "jira_update_issue", args: { issue_key: "EX-1", fields: '{"summary":"new"}' } }]);
		expect(record<{ open: JournalRecord[] }>(parse((await recover()).stdout).result)).toEqual({ open: [] });
		for (const stream of [apply.stdout, apply.stderr]) expect(stream).not.toContain(sentinel);
		expectNoSecret(fixture, [apply.stdout, apply.stderr]);
	}, 90_000);

	// Spec AC16, Ticket #92 criterion 7: the accepted oracle, unchanged in
	// substance. The write count and both causes are one expectation, so a
	// failure reports how many writes the race produced.
	test("two competing applies of one preview produce exactly one provider write and one refusal", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { id: "20002", body: "once" });
		const input = { issueKey: "EX-1", body: "once" };
		const previewId = (await previewComment(input)).previewId;
		const [left, right] = await Promise.all([write("issue.comment", input, ["--apply", previewId]), write("issue.comment", input, ["--apply", previewId])]);
		const outcomes = [left, right].map((result) => parse(result.stdout).result).map((envelope) => [envelope.causeCode, envelope.effects.completed.join(","), String(envelope.data?.connectorCause ?? "")]).sort();
		expect({ writes: writesTo("jira_add_comment").length, causes: outcomes.map(([cause, effects]) => [cause, effects]), stderr: [left.stderr, right.stderr] }).toEqual({
			writes: 1,
			causes: [["DOMAIN_ADAPTER_REFUSED", ""], ["SUCCESS_RUN_APPLIED", "write-receipt,provider-write"]],
			stderr: ["", ""],
		});
		// The loser meets either the consumed preview or the winner's object lock.
		expect(["refused-preview", "refused-write-blocked"]).toContain(String(outcomes[0]?.[2]));
		expect(writesTo("jira_add_comment")).toEqual([{ product: "jira", tool: "jira_add_comment", args: { issue_key: "EX-1", body: "once" } }]);
		expectNoSecret(fixture, [left.stdout, left.stderr, right.stdout, right.stderr]);
	}, 90_000);

	// Regression for t5-competing-applies-diagnosis: the journal meta-lock held
	// after the write was sent. It was reported refused and unchanged; a sent
	// write must be reported unknown and stay recoverable.
	test("a meta-lock still held after the write was sent reports the effect unknown, never refused, and recover settles it on read-back", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { plantMetaLock: true, reply: { id: "30003", body: "packaged comment" } });
		const previewId = (await previewComment()).previewId;
		const apply = await write("issue.comment", COMMENT, ["--apply", previewId]);
		expect([apply.code, apply.stderr]).toEqual([3, ""]);
		const unknown = parse(apply.stdout).result;
		expect([...station(unknown), unknown.nextAction, writesTo("jira_add_comment").length]).toEqual(["connectors.run.apply", "failed", "DOMAIN_RUN_EFFECT_UNKNOWN", "external", "unknown", ["write-receipt"], ["provider-write"], "connectors.recover", 1]);
		const receipt = record(unknown);
		expect([receipt.status, receipt.send]).toEqual(["intent", "possible"]);
		expect(unknown.repairAction).toBe(`Do not retry the write. Run connectors recover atlassian --select tenant=<value> --run ${receipt.runId} to inspect it, then settle it with --adjudicate --input and the identical input`);
		expect(writesTo("jira_add_comment")).toHaveLength(1);
		const listed = record<{ open: JournalRecord[] }>(parse((await recover()).stdout).result);
		expect(listed.open.map((entry) => [entry.runId, entry.status, entry.send])).toEqual([[receipt.runId, "intent", "possible"]]);
		// Operator recovery of a stale meta-lock is by hand, once no process runs.
		rmSync(path.join(fixture.state, "connectors", "atlassian", "example", "locks", ".meta"));
		fixture.canned("jira", "jira_get_issue", issueWithComments([{ id: "30003", body: "packaged comment" }]));
		const adjudicate = await recover("--run", receipt.runId, "--adjudicate", "--input", JSON.stringify(COMMENT));
		expect([adjudicate.code, adjudicate.stderr]).toEqual([0, ""]);
		const settled = parse(adjudicate.stdout).result;
		expect([...station(settled), record(settled).status, record(settled).effects]).toEqual(["connectors.recover.adjudicate", "success", "SUCCESS_RUN_RECORDED", "repository-local", "completed", ["write-adjudication"], [], "completed", [{ kind: "jira-comment", id: "30003" }]]);
		expect(record<{ open: JournalRecord[] }>(parse((await recover()).stdout).result)).toEqual({ open: [] });
		expect(writesTo("jira_add_comment")).toHaveLength(1);
		expectNoSecret(fixture, [apply.stdout, apply.stderr, adjudicate.stdout, adjudicate.stderr]);
	}, 90_000);

	test("a Provider that dies after receiving the write leaves the effect unknown, the object blocked, and the receipt open for recovery", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { exitAfterRecord: true });
		const apply = await write("issue.comment", COMMENT, ["--apply", (await previewComment()).previewId]);
		expect([apply.code, apply.stderr]).toEqual([3, ""]);
		const unknown = parse(apply.stdout).result;
		expect(station(unknown)).toEqual(["connectors.run.apply", "failed", "DOMAIN_RUN_EFFECT_UNKNOWN", "external", "unknown", ["write-receipt"], ["provider-write"]]);
		expect([record(unknown).status, record(unknown).send]).toEqual(["unknown", "possible"]);
		// A different write to the same issue is blocked until recovery.
		const again = { issueKey: "EX-1", body: "second comment" };
		const blocked = parse((await write("issue.comment", again, ["--apply", (await previewComment(again)).previewId])).stdout).result;
		expect([...station(blocked), blocked.data]).toEqual(["connectors.run.apply", "refused", "DOMAIN_ADAPTER_REFUSED", "inspect", "unchanged", [], [], { connector: "atlassian", connectorCause: "refused-write-blocked" }]);
		const listed = record<{ open: JournalRecord[] }>(parse((await recover()).stdout).result);
		expect(listed.open.map((entry) => [entry.runId, entry.status])).toEqual([[record(unknown).runId, "unknown"]]);
		expect(writesTo("jira_add_comment")).toEqual([{ product: "jira", tool: "jira_add_comment", args: COMMENT_ARGS }]);
		// Adjudication checks its input against the receipt before any custody,
		// op, or Provider start: a different input and a malformed one refuse.
		const capabilityLogs = () => [fixture.lines("keychain-reads.jsonl").length, fixture.lines("op-calls.jsonl").length, fixture.lines("community-starts.jsonl").length];
		const before = capabilityLogs();
		const sentinel = "EX-adjudicate-sentinel-must-not-echo";
		for (const input of [{ issueKey: "EX-1", body: sentinel }, { issueKey: sentinel }]) {
			const refused = await recover("--run", record(unknown).runId, "--adjudicate", "--input", JSON.stringify(input));
			expect([refused.code, refused.stderr]).toEqual([4, ""]);
			const envelope = parse(refused.stdout).result;
			expect([...station(envelope), envelope.data]).toEqual(["connectors.recover.adjudicate", "refused", "SCHEMA_ADAPTER_REFUSED", "inspect", "unchanged", [], [], { connector: "atlassian", connectorCause: "input-invalid" }]);
			for (const stream of [refused.stdout, refused.stderr]) expect(stream).not.toContain(sentinel);
		}
		expect(capabilityLogs()).toEqual(before);
		expect(record<{ open: JournalRecord[] }>(parse((await recover()).stdout).result).open.map((entry) => entry.status)).toEqual(["unknown"]);
		expectNoSecret(fixture, [apply.stdout, apply.stderr]);
	}, 90_000);

	test("unlock releases a lock its holder left behind, and the blocked apply then sends once", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { id: "50005", body: "packaged comment" });
		const previewed = await previewComment();
		// A holder that exited before its intent leaves only its object lock.
		const lockName = `${previewed.objectIdentity.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`;
		writeFileSync(path.join(fixture.state, "connectors", "atlassian", "example", "locks", lockName), JSON.stringify({ pid: 2_147_483_000, lockId: "exited", at: 0 }), { mode: 0o600 });
		const blocked = parse((await write("issue.comment", COMMENT, ["--apply", previewed.previewId])).stdout).result;
		expect([blocked.causeCode, blocked.data]).toEqual(["DOMAIN_ADAPTER_REFUSED", { connector: "atlassian", connectorCause: "refused-write-blocked" }]);
		const unlock = await recover("--run", previewed.previewId, "--unlock");
		expect([unlock.code, unlock.stderr]).toEqual([0, ""]);
		expect(station(parse(unlock.stdout).result)).toEqual(["connectors.recover.unlock", "success", "SUCCESS_RUN_RECORDED", "repository-local", "completed", ["write-unlock"], []]);
		const applied = parse((await write("issue.comment", COMMENT, ["--apply", previewed.previewId])).stdout).result;
		expect(station(applied)).toEqual(["connectors.run.apply", "success", "SUCCESS_RUN_APPLIED", "external", "completed", ["write-receipt", "provider-write"], []]);
		expect(writesTo("jira_add_comment")).toHaveLength(1);
		// Unlock also takes the receipt's runId. The apply released its lock, so
		// this unlock removes nothing and reports no write.
		const noop = await recover("--run", record(applied).runId, "--unlock");
		expect([noop.code, noop.stderr]).toEqual([0, ""]);
		const unchanged = parse(noop.stdout).result;
		expect([...station(unchanged), record<{ runId: string; objectIdentity: string; unlocked: boolean }>(unchanged)]).toEqual(["connectors.recover.unlock", "success", "SUCCESS_UNCHANGED", "inspect", "unchanged", [], [], { runId: record(applied).runId, objectIdentity: previewed.objectIdentity, unlocked: false }]);
	}, 90_000);
});
