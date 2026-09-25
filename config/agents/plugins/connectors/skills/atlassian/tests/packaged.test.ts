// Ticket #92 U1, U2, and U3a: Atlassian reads, the custody check, journaled
// writes, recovery, and the tenant registration (auth configure and status,
// and the registration gate before any custody read) through the packaged
// front door (Spec #87 AC8, AC9, AC10 configure part, AC11, AC16, AC19, and
// AC20; D2a). Every row
// spawns the compiled bin/connectors of the verified substituted plugin copy
// (plugin-copy.ts), which is compiled from source whose Keychain-read leaf is
// the test-owned reader fake and whose manifest admits the fake op and uv;
// the production-anchor row spawns the shipped binary. PATH holds only
// hostile recorders before /usr/bin:/bin, so no Bun, Node, op, uv, uvx, or
// MCPorter is reachable through it. MCPorter is the verified official release
// selected by the production bootstrap. The only process-table reads are the
// fake uv's and the fake op's reads of their own parent: its executable path,
// op's also its role argv, and token booleans, never a token value.
// Substituted-source packaged process proof only: nothing here reads the real
// Keychain, runs the real op, or reaches a live Provider.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFrontDoor } from "../../../tests/compile-front-door.ts";
import { OPERATION_SPECS } from "../scripts/dispatch/contract.ts";
import { CONFLUENCE_ITEM_ID, CustodyFixture, JIRA_ITEM_ID, OFFICIAL_MCPORTER, PROVIDER_TOKEN, registrationLiteral, SERVICE_TOKEN, seedMcporter } from "./fixtures/custody-fixture.ts";
import { changedPaths, SHIPPED_ROOT, substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for the packaged Atlassian process proof");
// Taken at module scope so its removal binds to this file, not to the
// bootstrap hook below, which throws on failure.
substitutedPluginRoot();

// Test-owned literals of the accepted contract and fixture.
const PRINCIPAL = "service@example.invalid";
const ORIGIN = "https://example.atlassian.net";
const TENANT = ["--select", "tenant=example"];
const ITEM_READ = (item: string) => ["item", "get", item, "--vault", "API Credentials", "--format", "json"];
// The registered item IDs (custody-fixture.ts), distinct per product and
// unlike the retired tenant-derived titles JIRA_EXAMPLE_API_TOKEN and
// CONFLUENCE_EXAMPLE_API_TOKEN.
const JIRA_ITEM = JIRA_ITEM_ID;
const CONFLUENCE_ITEM = CONFLUENCE_ITEM_ID;
const OP_ENV_KEYS = ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"];
const ITEM_HANDOFF = "create the Atlassian API token in your Atlassian account settings and store it yourself in the 1Password item with ID jirafixtureitem00000000001, the ID auth configure recorded, in the API Credentials vault; Connectors never creates, rotates, or imports a token";
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
// The 14 accepted write operations. The write station sweep keys its rows by
// this literal; the ungated agreement row checks it against the contract.
const WRITE_OPERATIONS = ["issue.create", "issue.update", "issue.comment", "issue.comment.update", "issue.attach", "issue.transition", "issue.assign", "issue.delete", "page.create", "page.update", "page.comment", "page.attach", "page.attachment.delete", "page.delete"] as const;
type WriteOperation = (typeof WRITE_OPERATIONS)[number];
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
// The Confluence read tools in their v0.23.1 live shape: a page read also
// accepts a title and space instead of an id, and include_metadata for the
// preparatory reads of the write rows.
const CONFLUENCE_TOOLS = [tool("confluence_get_page", [], ["page_id", "title", "space_key", "include_metadata", "convert_to_markdown"]), tool("confluence_search", ["query"], ["limit", "spaces_filter"])];
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
// Independent oracles, restated from the accepted adapter mapping; never
// import them from production. A dispatcher domain refusal publishes
// DOMAIN_ADAPTER_REFUSED, and a dispatcher read failure
// DOMAIN_PROVIDER_CALL_FAILED; both exit 3 and change nothing. runStation
// projects an envelope onto the same fields.
const DOMAIN_REFUSED = ["connectors.run", "refused", "DOMAIN_ADAPTER_REFUSED", 3, "inspect", "unchanged", [], []];
const PROVIDER_CALL_FAILED = ["connectors.run", "failed", "DOMAIN_PROVIDER_CALL_FAILED", 3, "inspect", "unchanged", [], []];
const runStation = (result: Envelope["result"]) => [result.commandIdentity, result.outcome, result.causeCode, result.exitCode, result.effectClass, result.transactionState, result.effects.completed, result.effects.uncertain];

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
const fresh = (options: { seed?: boolean; manifest?: "fixture" | "shipped"; registered?: boolean } = {}): CustodyFixture => {
	fixture = new CustodyFixture({ manifest: options.manifest ?? "fixture", registered: options.registered !== false }).installAll();
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

// Every file under the Atlassian state root, relative to it: before any
// journal or outbox effect, only the seeded registration.
const atlassianFiles = (target: CustodyFixture): string[] => {
	const base = path.join(target.state, "connectors", "atlassian");
	return existsSync(base) ? (readdirSync(base, { recursive: true }) as string[]).filter((entry) => statSync(path.join(base, entry)).isFile()).sort() : [];
};

describe("refusals before any dependency, credential, or Provider", () => {
	test("an invalid read input refuses with the schema cause and starts nothing", async () => {
		fresh({ seed: false });
		const sentinel = "EX-input-sentinel-must-not-echo";
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", JSON.stringify({ issueKey: sentinel, bogus: 1 })]);
		expect([result.code, result.stderr]).toEqual([4, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.commandIdentity, envelope.outcome, envelope.causeCode, envelope.transactionState, envelope.data]).toEqual(["connectors.run", "refused", "SCHEMA_ADAPTER_REFUSED", "unchanged", { connector: "atlassian", connectorCause: "input-invalid" }]);
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
		expect([existsSync(path.join(fixture.state, "connectors", "mcporter")), atlassianFiles(fixture)]).toEqual([false, ["example/registration.json"]]);
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
	test("the shipped digests reject the fake uv before any Keychain read, and the custody role rejects the fake op at its official name", async () => {
		fresh({ seed: false, manifest: "shipped" });
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv);
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", UV_SETUP_REPAIR, { connector: "atlassian", connectorCause: "refused-precondition" }]);
		}
		// uv is checked first, so the op half is reached only through the custody
		// role, the only op caller. The fake op sits at the shipped revision name
		// with a matching record and mode, so only its digest can refuse it.
		expect(readFileSync(path.join(fixture.opDirectory, "op-selected"), "utf8")).toBe("op-2.39.0-7e17cbf4052393d2c55a59a7c3d05f0bbcdcb079d57785cff682f3bc994ba8ce");
		const child = await fixture.frontDoor(["__internal", "atlassian", "custody-child"], { extra: { CONNECTORS_INTERNAL_INVOCATION_CONTEXT: `{"tenant":"example","product":"jira","item":"${JIRA_ITEM}"}` } });
		// The role's closed stderr code, not an envelope.
		expect([child.code, child.stdout, child.stderr]).toEqual([3, "", "atlassian-credential-binding:error:op-unavailable\n"]);
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
		expectNoHostile(fixture);
	}, 90_000);

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
		expect([existsSync(path.join(fixture.state, "connectors", "mcporter")), atlassianFiles(fixture)]).toEqual([false, ["example/registration.json"]]);
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
				{ product: "jira", principal: PRINCIPAL, itemVersion: "onepassword-item-version:1", origin: ORIGIN, item: "jirafixtureitem00000000001" },
				{ product: "confluence", principal: PRINCIPAL, itemVersion: "onepassword-item-version:1", origin: ORIGIN, item: "conffixtureitem00000000002" },
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
		fixture.removeItems();
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv);
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", ITEM_HANDOFF, { connector: "atlassian", connectorCause: "refused-credential-unconfigured" }]);
			// op did receive the service token, so its streams and the fixture sweep must hold neither token.
			expectNoSecret(fixture, [result.stdout, result.stderr]);
		}
		expect(fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)).toEqual([ITEM_READ(JIRA_ITEM), ITEM_READ(JIRA_ITEM)]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expectNoHostile(fixture);
	});

	// Streams and the fixture sweep hold neither token nor the row's sentinels.
	// These rows start no fake, so the sweep's guard is the seeded registration.
	const expectNoTokenOutput = (streams: string[], sentinels: string[] = []) => {
		const sweep = fixture.sweepText();
		expect(sweep).toContain(registrationLiteral("example", JIRA_ITEM_ID, CONFLUENCE_ITEM_ID));
		for (const surface of [...streams, sweep]) for (const secret of [SERVICE_TOKEN, PROVIDER_TOKEN, ...sentinels]) expect(surface).not.toContain(secret);
	};

	test("a malformed Keychain value refuses run and auth check, is never handed to op, and is never echoed", async () => {
		fresh({ seed: false });
		const malformed = "not-a-service-account-token-sentinel";
		fixture.installKeychainToken(malformed);
		for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
			const result = await fixture.frontDoor(argv);
			expect([argv[0], result.code, result.stderr]).toEqual([argv[0], 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([argv[0], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([argv[0], "DOMAIN_ADAPTER_REFUSED", "credential custody could not produce a stable context", { connector: "atlassian", connectorCause: "refused-precondition" }]);
			expectNoTokenOutput([result.stdout, result.stderr], [malformed]);
		}
		// Each command read the Keychain once and stopped there.
		expect(fixture.lines("keychain-reads.jsonl")).toEqual([keychainRead(fixture), keychainRead(fixture)]);
		expect([fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl"), existsSync(path.join(fixture.state, "connectors", "mcporter"))]).toEqual([[], [], false]);
		expectNoHostile(fixture);
	}, 90_000);

	// Fixture manifest: the fakes' digests are admitted, so each row's damage is
	// the only reason to refuse. op is checked by the custody role before its
	// Keychain read; uv is checked before the custody role starts.
	test("setup-damage: a missing, unselected, or changed op or uv refuses run and auth check with its setup repair before any credential read", async () => {
		const OP_REPAIR = "the plugin-owned 1Password CLI is not set up; run connectors setup";
		const opExecutable = (target: CustodyFixture) => path.join(target.opDirectory, readFileSync(path.join(target.opDirectory, "op-selected"), "utf8"));
		const rows: [string, (target: CustodyFixture) => void, string][] = [
			["op missing record", (target) => rmSync(path.join(target.opDirectory, "op-selected")), OP_REPAIR],
			["op wrong record", (target) => writeFileSync(path.join(target.opDirectory, "op-selected"), "op-2.38.0-0000"), OP_REPAIR],
			["op wrong mode", (target) => chmodSync(opExecutable(target), 0o755), OP_REPAIR],
			// Name, owner, mode, and record still match, and the changed file
			// would still run; only its bytes differ.
			["op changed bytes", (target) => appendFileSync(opExecutable(target), "\n"), OP_REPAIR],
			["uv missing", (target) => rmSync(target.uvExecutable), UV_SETUP_REPAIR],
			["uv changed bytes", (target) => appendFileSync(target.uvExecutable, "\n"), UV_SETUP_REPAIR],
		];
		expect(rows).toHaveLength(6);
		for (const [label, damage, repair] of rows) {
			fresh({ seed: false });
			damage(fixture);
			for (const argv of [["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], ["auth", "check", "atlassian", ...TENANT]]) {
				const result = await fixture.frontDoor(argv);
				// One row key, so a failure's diff names its row and command.
				const row = `${label}: ${argv[0]}`;
				expect([row, result.code, result.stderr]).toEqual([row, 3, ""]);
				const envelope = parse(result.stdout).result;
				expect([row, envelope.causeCode, envelope.transactionState, envelope.repairAction, envelope.data]).toEqual([row, "DOMAIN_ADAPTER_REFUSED", "unchanged", repair, { connector: "atlassian", connectorCause: "refused-precondition" }]);
				expectNoTokenOutput([result.stdout, result.stderr]);
			}
			expect([label, fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl"), existsSync(path.join(fixture.state, "connectors", "mcporter"))]).toEqual([label, [], [], [], false]);
			expectNoHostile(fixture);
			fixture.dispose();
		}
	}, 90_000);
});

// T5 U3b-1c: the legacy Bun-route refusals of the Community credential item
// (dispatch.test.ts), migrated to the packaged front door. The expected
// tuple is DOMAIN_REFUSED with its connectorCause and the dispatcher's fixed
// repair text.
describe("migrated Community item refusals before MCPorter", () => {
	const PRECONDITION_REPAIR = "a provider precondition failed before any request; run the provider readiness checks";
	const SITE_REPAIR = "the tenant's credential item must expose a valid site_url field";
	const CREDENTIAL_SENTINEL = "credential-sentinel-must-not-echo";

	// The custody bind accepts the item (it never reads the credential); the
	// Provider preflight then refuses it before MCPorter is selected.
	test("a missing or malformed Community credential refuses at the Provider preflight with the precondition repair, never echoes it, and starts no Provider", async () => {
		const rows: [string, Record<string, string>, string][] = [
			["missing", { username: PRINCIPAL, site_url: ORIGIN }, "the product credential item needs username, credential, and a site_url field"],
			["malformed", { username: PRINCIPAL, site_url: ORIGIN, credential: `${CREDENTIAL_SENTINEL}\nsecond-line-sentinel` }, "the credential item has malformed fields"],
		];
		expect(rows).toHaveLength(2);
		for (const [label, entries, hint] of rows) {
			fresh({ seed: false });
			fixture.writeItem(entries);
			const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.search", "--input", '{"jql":"x"}']);
			expect([label, result.code, result.stderr]).toEqual([label, 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([label, ...runStation(envelope), envelope.repairAction, envelope.data]).toEqual([label, ...DOMAIN_REFUSED, `${PRECONDITION_REPAIR}; ${hint}`, { connector: "atlassian", connectorCause: "refused-precondition" }]);
			// One custody bind and one Provider preflight each read the item once.
			expect([label, fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)]).toEqual([label, [ITEM_READ(JIRA_ITEM), ITEM_READ(JIRA_ITEM)]]);
			expect([label, fixture.lines("community-starts.jsonl"), fixture.lines("effects.jsonl"), existsSync(path.join(fixture.state, "connectors", "mcporter")), atlassianFiles(fixture)]).toEqual([label, [], [], false, ["example/registration.json"]]);
			expectNoHostile(fixture);
			expectNoSecret(fixture, [result.stdout, result.stderr], [CREDENTIAL_SENTINEL, "second-line-sentinel"]);
			fixture.dispose();
		}
	});

	// The trusted origin is the site_url field only: custody refuses before
	// the Provider preflight reads the item.
	test("a site origin that is absent, legacy url only, or invalid beside a valid legacy url refuses at custody and starts no Provider", async () => {
		const rows: [string, Record<string, string>][] = [
			["absent", { username: PRINCIPAL, credential: PROVIDER_TOKEN }],
			["legacy url only", { username: PRINCIPAL, credential: PROVIDER_TOKEN, url: "https://Example.atlassian.net/" }],
			["invalid site_url beside a valid legacy url", { username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: "https://example.atlassian.net/wiki", url: ORIGIN }],
		];
		expect(rows).toHaveLength(3);
		for (const [label, entries] of rows) {
			fresh({ seed: false });
			fixture.writeItem(entries);
			const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}']);
			expect([label, result.code, result.stderr]).toEqual([label, 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([label, ...runStation(envelope), envelope.repairAction, envelope.data]).toEqual([label, ...DOMAIN_REFUSED, SITE_REPAIR, { connector: "atlassian", connectorCause: "site-unresolved" }]);
			expect([label, fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)]).toEqual([label, [ITEM_READ(JIRA_ITEM)]]);
			expect([label, fixture.lines("community-starts.jsonl"), fixture.lines("effects.jsonl"), existsSync(path.join(fixture.state, "connectors", "mcporter")), atlassianFiles(fixture)]).toEqual([label, [], [], false, ["example/registration.json"]]);
			expectNoHostile(fixture);
			expectNoSecret(fixture, [result.stdout, result.stderr]);
			fixture.dispose();
		}
	});
});

// T5 U3a (D2a, Q-import): the tenant registration. Independent literals of
// the accepted configure contract; the registration bytes come from the
// fixture's restated literal, never from the production renderer.
describe("tenant registration: configure, status, and the gate before custody", () => {
	const CONFIGURE_COMMAND = `connectors auth configure atlassian --select tenant=<value> --input '{"jiraItem":"<id>","confluenceItem":"<id>"}'`;
	const ITEM_ID_REPAIR = `expected a 26-character 1Password item ID from the API Credentials vault; copy each ID yourself outside Connectors, for example from op item get "<name>" --vault "API Credentials" --format json in your own op session, or from the item's link in the 1Password app; Connectors never resolves an item name`;
	const CONFIGURE_INPUT_REPAIR = `auth configure needs --input '{"jiraItem":"<id>","confluenceItem":"<id>"}' with exactly those two keys; ${ITEM_ID_REPAIR}`;
	const REPOINT = `confirm connectors recover atlassian --select tenant=<value> lists no open receipt and wait 15 minutes after the tenant's last preview, so no receipt or preview made under the old items can still act; then remove registration.json from the tenant's Connectors state directory by hand and run ${CONFIGURE_COMMAND} again`;
	const EXISTS_REPAIR = `the tenant is already registered with different item IDs, and a registration never changes in place; to re-point it, ${REPOINT}`;
	const INVALID_REPAIR = `the tenant's registration.json is not the exact private file auth configure writes; to replace it, ${REPOINT}`;
	const UNREGISTERED_REPAIR = `register the tenant first with ${CONFIGURE_COMMAND}, giving the two 26-character 1Password item IDs from the API Credentials vault`;
	const UNSTABLE_DETAIL = "credential custody could not produce a stable context";
	const STALE_HINT = "a provider precondition failed before any request; run the provider readiness checks; credential item metadata changed; restart the semantic operation";
	const OTHER_ID = "otheritemfixture0000000003";
	const REGISTRATION = registrationLiteral("example", JIRA_ITEM_ID, CONFLUENCE_ITEM_ID);
	const configure = (items: Record<string, unknown>, options: Parameters<CustodyFixture["frontDoor"]>[1] = {}) => fixture.frontDoor(["auth", "configure", "atlassian", ...TENANT, "--input", JSON.stringify(items)], options);
	const IDS = { jiraItem: JIRA_ITEM_ID, confluenceItem: CONFLUENCE_ITEM_ID };
	const noCapability = () => [fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl"), fixture.lines("effects.jsonl"), existsSync(path.join(fixture.state, "connectors", "mcporter"))];
	const NONE = [[], [], [], [], false];
	// The recorded configure envelope and its data, shared by every row that publishes.
	const recordedFields = (result: Envelope["result"]) => [result.commandIdentity, result.outcome, result.causeCode, result.effectClass, result.transactionState, result.effects.completed, result.effects.uncertain, result.nextAction];
	const RECORDED = ["connectors.auth", "success", "SUCCESS_RUN_RECORDED", "repository-local", "completed", ["custody-registration"], [], "connectors.auth"];
	const RECORDED_DATA = { connector: "atlassian", tenant: "example", vault: "API Credentials", items: { jira: "jirafixtureitem00000000001", confluence: "conffixtureitem00000000002" }, nextStep: "connectors auth check atlassian --select tenant=example" };
	const registration = () => {
		const file = fixture.registrationFile();
		return { text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o7777, parentMode: statSync(path.dirname(file)).mode & 0o7777, inode: statSync(file).ino };
	};

	test("configure publishes the exact registration once without reading stdin or starting anything, and an identical configure changes nothing", async () => {
		fresh({ seed: false, registered: false });
		const sentinel = "configure-stdin-sentinel-must-not-be-read";
		const first = await configure(IDS, { stdinSentinel: sentinel });
		expect([first.code, first.stderr]).toEqual([0, ""]);
		const published = parse(first.stdout).result;
		expect(recordedFields(published)).toEqual(RECORDED);
		expect(published.data).toEqual(RECORDED_DATA);
		const written = registration();
		expect([written.text, written.mode, written.parentMode]).toEqual([REGISTRATION, 0o600, 0o700]);
		expect(atlassianFiles(fixture)).toEqual(["example/registration.json"]);
		const again = await configure(IDS);
		expect([again.code, again.stderr]).toEqual([0, ""]);
		const unchanged = parse(again.stdout).result;
		expect([unchanged.causeCode, unchanged.effectClass, unchanged.transactionState, unchanged.effects.completed]).toEqual(["SUCCESS_UNCHANGED", "inspect", "unchanged", []]);
		expect(unchanged.data).toEqual(published.data);
		expect(registration()).toEqual(written);
		expect(noCapability()).toEqual(NONE);
		expectNoHostile(fixture);
		for (const stream of [first.stdout, again.stdout]) expect(stream).not.toContain(sentinel);
	});

	// S4/F2: once the link has published registration.json, a failed temp
	// removal or directory fsync must not deny the effect. The faulted front
	// door is this file's substituted plugin copy with one prologue in
	// bin/connectors.ts, compiled by the package build flags: inside that
	// process only, bun:test's module mock makes node:fs throw EIO at exactly
	// one post-link step and log that it fired.
	describe("after a post-link publication fault", () => {
		const ANCHOR = 'import { stateRoot } from "./private-state.ts";';
		const PROLOGUE = String.raw`
import { mock as faultMock } from "bun:test";
import * as faultFs from "node:fs";
const faultReal = { ...faultFs };
const faultStep = process.env.CONNECTORS_TEST_POST_LINK_FAULT;
const faultFire = (step: string): never => {
	faultReal.appendFileSync(FAULT_LOG, step + "\n");
	throw Object.assign(new Error("injected post-link fault"), { code: "EIO" });
};
faultMock.module("node:fs", () => ({
	...faultReal,
	rmSync: (target: string, options?: object) => (faultStep === "temp-removal" && /^\.registration\.json\..+\.tmp$/.test(path.basename(target)) ? faultFire(faultStep) : faultReal.rmSync(target, options)),
	openSync: (target: string, ...rest: never[]) => (faultStep === "directory-sync" && target.endsWith(path.join("atlassian", "example")) ? faultFire(faultStep) : faultReal.openSync(target, ...rest)),
}));
`;
		let faulted = "";
		let binary = "";
		let faultLog = "";
		beforeAll(() => {
			faulted = mkdtempSync(path.join(os.tmpdir(), "connectors-post-link-fault-"));
			chmodSync(faulted, 0o700);
			const substituted = substitutedPluginRoot();
			cpSync(substituted, faulted, { recursive: true, verbatimSymlinks: true });
			faultLog = path.join(faulted, "fault.log");
			const entry = path.join(faulted, "bin", "connectors.ts");
			const source = readFileSync(entry, "utf8");
			expect(source.split(ANCHOR)).toHaveLength(2);
			writeFileSync(entry, source.replace(ANCHOR, `${ANCHOR}${PROLOGUE.replace("FAULT_LOG", JSON.stringify(faultLog))}`));
			binary = path.join(faulted, "bin", "connectors");
			compileFrontDoor(entry, binary);
			// Fail closed: the faulted copy differs from the verified one only by the prologue and its build.
			expect(changedPaths(substituted, faulted)).toEqual(["bin/connectors", "bin/connectors.ts"]);
		}, 120_000);
		afterAll(() => {
			if (faulted !== "") rmSync(faulted, { recursive: true, force: true });
		});
		const TEMP = /^example\/\.registration\.json\.[0-9a-f-]{36}\.tmp$/;

		// The failed removal keeps one exact-0600 temp beside the registration;
		// a failed directory fsync follows a completed removal.
		for (const [step, leftovers] of [["temp-removal", 1], ["directory-sync", 0]] as const) {
			test(`a ${step} fault still reports the published registration as recorded and starts nothing`, async () => {
				fresh({ seed: false, registered: false });
				rmSync(faultLog, { force: true });
				const result = await configure(IDS, { binary, extra: { CONNECTORS_TEST_POST_LINK_FAULT: step } });
				expect(readFileSync(faultLog, "utf8")).toBe(`${step}\n`);
				expect([result.code, result.stderr]).toEqual([0, ""]);
				const recorded = parse(result.stdout).result;
				expect(recordedFields(recorded)).toEqual(RECORDED);
				expect(recorded.data).toEqual(RECORDED_DATA);
				const written = registration();
				expect([written.text, written.mode, written.parentMode]).toEqual([REGISTRATION, 0o600, 0o700]);
				const temps = atlassianFiles(fixture).filter((entry) => entry !== "example/registration.json");
				expect([atlassianFiles(fixture).includes("example/registration.json"), temps.length]).toEqual([true, leftovers]);
				for (const temp of temps) expect([TEMP.test(temp), statSync(path.join(fixture.state, "connectors", "atlassian", temp)).mode & 0o7777]).toEqual([true, 0o600]);
				expect(noCapability()).toEqual(NONE);
				expectNoHostile(fixture);
			});
		}
	});

	test("configure refuses anything but two strict item IDs, stores nothing, and never echoes the value", async () => {
		fresh({ seed: false, registered: false });
		const rows: [string, Record<string, unknown>, string, string][] = [
			["item name", { jiraItem: "JIRA_EXAMPLE_API_TOKEN", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["ATATT token", { jiraItem: JIRA_ITEM_ID, confluenceItem: "ATATT3xFfGF0configure-token-sentinel" }, "item-reference-invalid", ITEM_ID_REPAIR],
			["24-character mixed-case token", { jiraItem: "Ab3dEf6hIj9kLm2nOp5qRs8t", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["stdin form", { jiraItem: "-", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["25 characters", { jiraItem: "abcdefghijklmnopqrstuvwxy", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["27 characters", { jiraItem: "abcdefghijklmnopqrstuvwxyz1", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["uppercase ID", { jiraItem: "JIRAFIXTUREITEM00000000001", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["op reference", { jiraItem: "op://API Credentials/abcdefghijklmnopqrstuvwxyz/credential", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["share link", { jiraItem: "https://share.1password.com/s#abcdefghijklmnopqrstuvwxyz", confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["not a string", { jiraItem: 1234567890123, confluenceItem: CONFLUENCE_ITEM_ID }, "item-reference-invalid", ITEM_ID_REPAIR],
			["missing key", { jiraItem: JIRA_ITEM_ID }, "input-invalid", CONFIGURE_INPUT_REPAIR],
			["extra key", { ...IDS, token: "extra-key-sentinel-must-not-echo" }, "input-invalid", CONFIGURE_INPUT_REPAIR],
		];
		expect(rows).toHaveLength(12);
		for (const [label, items, connectorCause, repair] of rows) {
			const result = await configure(items);
			expect([label, result.code, result.stderr]).toEqual([label, 4, ""]);
			const envelope = parse(result.stdout).result;
			expect([label, envelope.commandIdentity, envelope.causeCode, envelope.transactionState, envelope.effects.completed, envelope.repairAction, envelope.data]).toEqual([label, "connectors.auth", "SCHEMA_ADAPTER_REFUSED", "unchanged", [], repair, { connector: "atlassian", connectorCause }]);
			// A one-character value such as "-" cannot be told apart from envelope text.
			for (const value of Object.values(items).filter((value) => value !== CONFLUENCE_ITEM_ID && value !== JIRA_ITEM_ID && String(value).length > 1)) expect(result.stdout).not.toContain(String(value));
		}
		const bare = await fixture.frontDoor(["auth", "configure", "atlassian", ...TENANT]);
		expect([bare.code, parse(bare.stdout).result.data]).toEqual([4, { connector: "atlassian", connectorCause: "input-invalid" }]);
		expect(existsSync(fixture.registrationFile())).toBe(false);
		expect(noCapability()).toEqual(NONE);
	});

	test("configure with different IDs for a registered tenant refuses with the re-point repair and never replaces the registration", async () => {
		fresh({ seed: false });
		const before = registration();
		const result = await configure({ jiraItem: OTHER_ID, confluenceItem: CONFLUENCE_ITEM_ID });
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.causeCode, envelope.transactionState, envelope.effects.completed, envelope.repairAction, envelope.data]).toEqual(["DOMAIN_ADAPTER_REFUSED", "unchanged", [], EXISTS_REPAIR, { connector: "atlassian", connectorCause: "registration-exists" }]);
		expect(registration()).toEqual(before);
		expect(before.text).toBe(REGISTRATION);
		expect(noCapability()).toEqual(NONE);
	});

	// One bounded real-concurrency sample; the deterministic proof is the
	// publish helper's EEXIST row and the sequential row above.
	test("two concurrent configures with different IDs produce exactly one registration and one refusal", async () => {
		fresh({ seed: false, registered: false });
		const results = await Promise.all([configure(IDS), configure({ jiraItem: OTHER_ID, confluenceItem: CONFLUENCE_ITEM_ID })]);
		const outcomes = results.map((result) => parse(result.stdout).result);
		expect(outcomes.map((envelope) => envelope.causeCode).sort()).toEqual(["DOMAIN_ADAPTER_REFUSED", "SUCCESS_RUN_RECORDED"]);
		const winner = outcomes[0]?.causeCode === "SUCCESS_RUN_RECORDED" ? 0 : 1;
		expect([results[winner]?.code, results[winner]?.stderr, results[1 - winner]?.code, results[1 - winner]?.stderr]).toEqual([0, "", 3, ""]);
		expect([outcomes[1 - winner]?.repairAction, outcomes[1 - winner]?.data]).toEqual([EXISTS_REPAIR, { connector: "atlassian", connectorCause: "registration-exists" }]);
		expect(noCapability()).toEqual(NONE);
		expect(registration().text).toBe(winner === 0 ? REGISTRATION : registrationLiteral("example", OTHER_ID, CONFLUENCE_ITEM_ID));
		expect(atlassianFiles(fixture)).toEqual(["example/registration.json"]);
	});

	test("auth status inspects the registration only: absent before configure, the recorded IDs after, with no Keychain or 1Password read", async () => {
		fresh({ seed: false, registered: false });
		const status = async () => {
			const result = await fixture.frontDoor(["auth", "status", "atlassian", ...TENANT]);
			expect([result.code, result.stderr]).toEqual([0, ""]);
			const envelope = parse(result.stdout).result;
			expect([envelope.commandIdentity, envelope.causeCode, envelope.effectClass, envelope.effects.completed]).toEqual(["connectors.auth", "SUCCESS_UNCHANGED", "inspect", []]);
			return envelope.data;
		};
		expect(await status()).toEqual({ connector: "atlassian", tenant: "example", registration: "absent", nextStep: UNREGISTERED_REPAIR });
		expect((await configure(IDS)).code).toBe(0);
		expect(await status()).toEqual({ connector: "atlassian", tenant: "example", registration: "registered", vault: "API Credentials", items: { jira: "jirafixtureitem00000000001", confluence: "conffixtureitem00000000002" }, nextStep: "connectors auth check atlassian --select tenant=example" });
		expect(noCapability()).toEqual(NONE);
	});

	test("an unregistered tenant refuses run, preview, apply, auth check, and adjudication before any Keychain, 1Password, MCPorter, or Provider start; inspection and unlock still answer", async () => {
		fresh({ seed: false, registered: false });
		const comment = JSON.stringify({ issueKey: "EX-1", body: "unregistered" });
		const rows: [string, string[], string][] = [
			["read", ["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}'], "connectors.run"],
			["preview", ["run", "atlassian", ...TENANT, "issue.comment", "--input", comment, "--preview"], "connectors.run.preview"],
			["apply", ["run", "atlassian", ...TENANT, "issue.comment", "--input", comment, "--apply", "preview-1"], "connectors.run.apply"],
			["auth check", ["auth", "check", "atlassian", ...TENANT], "connectors.auth"],
			["adjudicate", ["recover", "atlassian", ...TENANT, "--run", "run-1", "--adjudicate", "--input", comment], "connectors.recover.adjudicate"],
		];
		expect(rows).toHaveLength(5);
		for (const [label, argv, identity] of rows) {
			const result = await fixture.frontDoor(argv);
			expect([label, result.code, result.stderr]).toEqual([label, 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([label, envelope.commandIdentity, envelope.causeCode, envelope.transactionState, envelope.effects.completed, envelope.repairAction, envelope.data]).toEqual([label, identity, "DOMAIN_ADAPTER_REFUSED", "unchanged", [], UNREGISTERED_REPAIR, { connector: "atlassian", connectorCause: "tenant-unregistered" }]);
			expect([label, ...noCapability()]).toEqual([label, ...NONE]);
		}
		const listed = await fixture.frontDoor(["recover", "atlassian", ...TENANT]);
		expect([listed.code, parse(listed.stdout).result.causeCode, parse(listed.stdout).result.data]).toEqual([0, "SUCCESS_UNCHANGED", { connector: "atlassian", command: "receipts", result: { open: [] }, provenance: [] }]);
		const unlock = parse((await fixture.frontDoor(["recover", "atlassian", ...TENANT, "--run", "run-1", "--unlock"])).stdout).result;
		// The journal answers: it knows no such preview or receipt.
		expect([unlock.commandIdentity, unlock.data?.connectorCause]).toEqual(["connectors.recover.unlock", "refused-preview"]);
		expect(noCapability()).toEqual(NONE);
		expectNoHostile(fixture);
	});

	test("a registration that is not the exact private file configure writes refuses every gated command before any read and never echoes it", async () => {
		const sentinel = "registration-sentinel-must-not-echo";
		const valid = { schemaVersion: 1, tenant: "example", vault: "API Credentials", items: { jira: JIRA_ITEM_ID, confluence: CONFLUENCE_ITEM_ID } };
		const rows: [string, (target: CustodyFixture) => void][] = [
			["wrong mode", (target) => chmodSync(target.registrationFile(), 0o644)],
			["wide tenant directory", (target) => chmodSync(path.dirname(target.registrationFile()), 0o755)],
			["symlink", (target) => {
				const elsewhere = path.join(target.root, "elsewhere.json");
				writeFileSync(elsewhere, REGISTRATION, { mode: 0o600 });
				rmSync(target.registrationFile());
				symlinkSync(elsewhere, target.registrationFile());
			}],
			["bad JSON", (target) => target.writeRegistration(`{"schemaVersion":1,${sentinel}\n`)],
			["extra key", (target) => target.writeRegistration(`${JSON.stringify({ ...valid, note: sentinel })}\n`)],
			["reordered keys", (target) => target.writeRegistration(`${JSON.stringify({ tenant: "example", schemaVersion: 1, vault: "API Credentials", items: valid.items })}\n`)],
			["no trailing newline", (target) => target.writeRegistration(JSON.stringify(valid))],
			["schemaVersion 2", (target) => target.writeRegistration(`${JSON.stringify({ ...valid, schemaVersion: 2 })}\n`)],
			["other tenant", (target) => target.writeRegistration(registrationLiteral("other", JIRA_ITEM_ID, CONFLUENCE_ITEM_ID))],
			["other vault", (target) => target.writeRegistration(`${JSON.stringify({ ...valid, vault: "Private" })}\n`)],
			["bad ID", (target) => target.writeRegistration(registrationLiteral("example", "JIRA_EXAMPLE_API_TOKEN", CONFLUENCE_ITEM_ID))],
		];
		expect(rows).toHaveLength(11);
		for (const [label, damage] of rows) {
			fresh({ seed: false });
			damage(fixture);
			for (const argv of [["auth", "check", "atlassian", ...TENANT], ["auth", "status", "atlassian", ...TENANT], ["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}']]) {
				const result = await fixture.frontDoor(argv);
				expect([label, argv[1], result.code, result.stderr]).toEqual([label, argv[1], 3, ""]);
				const envelope = parse(result.stdout).result;
				expect([label, argv[1], envelope.causeCode, envelope.repairAction, envelope.data]).toEqual([label, argv[1], "DOMAIN_ADAPTER_REFUSED", INVALID_REPAIR, { connector: "atlassian", connectorCause: "registration-invalid" }]);
				expect(result.stdout).not.toContain(sentinel);
			}
			expect([label, ...noCapability()]).toEqual([label, ...NONE]);
			fixture.dispose();
		}
	});

	test("custody and the Provider read exactly the configured IDs, and a returned item whose id differs is refused at each", async () => {
		fresh({ seed: false });
		const item = (id: string) => JSON.stringify({ id, version: 1, fields: [{ label: "username", value: PRINCIPAL }, { label: "credential", value: PROVIDER_TOKEN }, { label: "site_url", value: ORIGIN }] });
		// The custody child's read returns another item: auth check refuses.
		fixture.writeItemText(JIRA_ITEM_ID, item(OTHER_ID));
		const check = await fixture.frontDoor(["auth", "check", "atlassian", ...TENANT]);
		expect([check.code, check.stderr]).toEqual([3, ""]);
		const refused = parse(check.stdout).result;
		expect([refused.causeCode, refused.repairAction, refused.data]).toEqual(["DOMAIN_ADAPTER_REFUSED", UNSTABLE_DETAIL, { connector: "atlassian", connectorCause: "refused-precondition" }]);
		expect(fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)).toEqual([ITEM_READ(JIRA_ITEM_ID)]);
		// The custody child's read matches; the Provider's re-read returns
		// another item: the read refuses stale before MCPorter or the package.
		// The fake counts reads per reference from its log, so start it afresh.
		rmSync(path.join(fixture.root, "op-calls.jsonl"));
		fixture.writeItemText(JIRA_ITEM_ID, item(JIRA_ITEM_ID));
		fixture.writeItemText(JIRA_ITEM_ID, item(OTHER_ID), "later");
		const run = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.get", "--input", '{"issueKey":"EX-1"}']);
		expect([run.code, run.stderr]).toEqual([3, ""]);
		const stale = parse(run.stdout).result;
		expect([stale.causeCode, stale.repairAction, stale.data]).toEqual(["DOMAIN_ADAPTER_REFUSED", STALE_HINT, { connector: "atlassian", connectorCause: "refused-precondition" }]);
		// The custody child's read, then the Provider preflight's re-read.
		expect(fixture.lines<{ argv: string[] }>("op-calls.jsonl").map((call) => call.argv)).toEqual([ITEM_READ(JIRA_ITEM_ID), ITEM_READ(JIRA_ITEM_ID)]);
		expect([fixture.lines("community-starts.jsonl"), fixture.lines("effects.jsonl"), existsSync(path.join(fixture.state, "connectors", "mcporter"))]).toEqual([[], [], false]);
		expectNoSecret(fixture, [check.stdout, run.stdout]);
	});
});

// Listing needs no MCPorter, so it runs wherever the packaged tests run.
describe("packaged connector listing", () => {
	test("list admits the Atlassian manifest beside the other packaged connectors", async () => {
		fresh();
		const envelope = parse((await fixture.frontDoor(["list"])).stdout).result;
		expect((envelope.data?.connectors as { id: string }[]).map((entry) => entry.id)).toEqual(["atlassian", "canva", "context7", "firecrawl", "mermaid"]);
	});
});

// Agreement needs no MCPorter or process, so it runs wherever this file runs.
// The literal proves the accepted set; agreement proves the contract declares
// exactly that set, so a write added to or dropped from the contract fails here.
describe("write operation catalogue agreement", () => {
	test("the write operations the dispatch contract declares are exactly the 14 accepted write operations", () => {
		const declared = Object.values(OPERATION_SPECS).filter((spec) => spec.kind === "write").map((spec) => spec.id);
		expect(WRITE_OPERATIONS).toHaveLength(14);
		expect([...declared].sort()).toEqual([...WRITE_OPERATIONS].sort());
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

	// T5 U3b-1c: the legacy Bun-route Provider failures (dispatch.test.ts),
	// migrated to the packaged front door. The expected tuples are
	// PROVIDER_CALL_FAILED with null data and DOMAIN_REFUSED with its
	// connectorCause; both carry the dispatcher's fixed repair text.
	const TRANSPORT_REPAIR = "the provider did not answer; inspect provider status before retrying the read";
	const UNKNOWN_REPAIR = "the provider failed for an unclassified reason; inspect provider diagnostics";
	const AUTH_REPAIR = "the provider refused authentication or permission; verify the credential type, scopes, and product permissions with their owner";

	// One attempt: the Provider started for the schema list dies before
	// serving, so MCPorter's own diagnostic ends the read and no call is sent.
	test("a Provider that dies at start is a provider-call failure with the transport repair, never its text, and sends nothing", async () => {
		fresh();
		writeFileSync(path.join(fixture.root, "community-crash"), "");
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, "issue.search", "--input", '{"jql":"x"}']);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([...runStation(envelope), envelope.repairAction, envelope.data]).toEqual([...PROVIDER_CALL_FAILED, TRANSPORT_REPAIR, null]);
		expect(fixture.lines("effects.jsonl")).toEqual([]);
		// How often MCPorter restarts a Provider that dies is its own; so the
		// counts are not pinned, but every read and every start is confined.
		const reads = fixture.lines("op-calls.jsonl");
		const starts = fixture.lines<CommunityStart>("community-starts.jsonl");
		expect([reads.length > 0, starts.length > 0]).toEqual([true, true]);
		expectConfinedRead(fixture, JIRA_ITEM, JIRA_PROVIDER_KEYS, { opReads: reads.length, providerStarts: starts.length });
		expect(result.stdout).not.toContain("fixture-private-crash-text");
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	}, 90_000);

	// [label, operation, input, product, tool, provider args, canned reply,
	// expected tuple, repair, data, fragments that must not reach a stream,
	// fragments that must not reach any file once the canned replies are gone]
	const HOSTILE = `HTTP 401 Unauthorized token=fixture-secret-value Authorization: Basic ${SERVICE_TOKEN} Bearer x op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential; issue PROJ-99 confidential merger; customer SSN 123-45-6789`;
	const IN_BAND = "Failed to retrieve page by ID '123': Error retrieving page content: There is no content with the given id, or the calling user does not have permission to view the content";
	const PROVIDER_ROWS: [string, string, Record<string, string>, "jira" | "confluence", string, Record<string, string>, unknown, unknown[], string, unknown, string[], string[]][] = [
		["in-band error payload", "page.get", { pageId: "123" }, "confluence", "confluence_get_page", { page_id: "123" }, { error: IN_BAND }, PROVIDER_CALL_FAILED, UNKNOWN_REPAIR, null, ["Failed to retrieve", "no content with the given id"], ["Failed to retrieve"]],
		["in-band failure with extra provider fields", "page.get", { pageId: "123" }, "confluence", "confluence_get_page", { page_id: "123" }, { success: false, error: "HTTP 403 Forbidden", requestId: "opaque-request-id-sentinel" }, DOMAIN_REFUSED, AUTH_REPAIR, { connector: "atlassian", connectorCause: "refused-auth" }, ["opaque-request-id-sentinel", "HTTP 403 Forbidden"], ["opaque-request-id-sentinel"]],
		["hostile tool error text", "issue.get", { issueKey: "PROJ-1" }, "jira", "jira_get_issue", { issue_key: "PROJ-1" }, { toolErrorText: HOSTILE }, DOMAIN_REFUSED, AUTH_REPAIR, { connector: "atlassian", connectorCause: "refused-auth" }, ["fixture-secret-value", "customer SSN 123-45-6789", "PROJ-99 confidential merger", "op://", "Bearer", "Basic "], ["fixture-secret-value", "123-45-6789", "PROJ-99 confidential merger"]],
	];
	test.each(PROVIDER_ROWS)("%s is translated at the transport seam to its published cause and never reaches a stream or file", async (_label, operation, input, product, providerTool, args, canned, tuple, repair, data, streamFragments, fileFragments) => {
		fresh();
		fixture.canned(product, providerTool, canned);
		const result = await fixture.frontDoor(["run", "atlassian", ...TENANT, operation, "--input", JSON.stringify(input)]);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect<unknown[]>([...runStation(envelope), envelope.repairAction, envelope.data]).toEqual([...tuple, repair, data]);
		// The one read call did reach the Provider; nothing else was sent.
		expect(fixture.lines("effects.jsonl")).toEqual([{ product, tool: providerTool, args }]);
		expectConfinedRead(fixture, product === "jira" ? JIRA_ITEM : CONFLUENCE_ITEM, product === "jira" ? JIRA_PROVIDER_KEYS : CONFLUENCE_PROVIDER_KEYS);
		for (const stream of [result.stdout, result.stderr]) for (const fragment of streamFragments) expect(stream).not.toContain(fragment);
		// The canned reply holds the Provider's text by design; without it, the
		// sweep proves no other file kept that text or a token.
		rmSync(path.join(fixture.root, "canned"), { recursive: true, force: true });
		expectNoSecret(fixture, [result.stdout, result.stderr], fileFragments);
	}, 90_000);

	// Journaled writes (U2). The oracle for every Provider write is the fake's
	// effects.jsonl, never an envelope. A comment binds no revision, so its
	// preview sends two MCPorter requests (the schema list and the baseline
	// issue read) and its apply three (those two, then the comment); each binds
	// its product once, and each request reads the item twice (preflight and
	// Provider).
	const COMMENT = { issueKey: "EX-1", body: "packaged comment" };
	const COMMENT_ARGS = { issue_key: "EX-1", body: "packaged comment" };
	const UPDATED = "2026-09-25 09:00:00 AEST";
	const MOVED = "2026-09-25 09:10:00 AEST";
	const issue = (fields: Record<string, unknown>, updated = UPDATED) => ({ key: "EX-1", fields: { updated, ...fields } });
	const issueWithComments = (comments: { id: string; body: string }[]) => issue({ comment: { comments } });
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

	// The write station sweep below owns the preview, apply, and receipt
	// contract for every write; this row keeps recovery inspection and the
	// credential confinement of the whole comment sequence.
	test("recover lists and shows a completed comment receipt, and inspection starts no custody, op, or Provider", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { id: "10001", body: "packaged comment" });
		const preview = await write("issue.comment", COMMENT, ["--preview"]);
		const previewed = parse(preview.stdout).result;
		expect(previewed.nextAction).toBe("connectors.run.apply");
		const apply = await write("issue.comment", COMMENT, ["--apply", record(previewed).previewId]);
		const receipt = record(parse(apply.stdout).result);
		expect([preview.code, apply.code, receipt.status]).toEqual([0, 0, "completed"]);
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

	// T5 U3b-1a: every write station through the packaged front door. Each row
	// is a test-owned literal of the accepted contract: its input, the Provider
	// replies it needs before and after the write, the exact write tool and
	// arguments, and the effect its receipt must carry. Updates, transitions,
	// assigns, comment edits, and deletes settle only from a read-back, so
	// their rows name the reply a read returns once the fake has recorded the
	// write (community-mcp-fake.ts post-write state).
	// Independent oracle: every Community read tool the dispatcher may call; any
	// other recorded call is a write.
	const READ_TOOLS = new Set(["jira_get_issue", "jira_search", "jira_get_transitions", "confluence_get_page", "confluence_search", "confluence_get_comments", "confluence_get_attachments"]);
	const WRITE_JIRA_TOOLS = [
		...JIRA_TOOLS,
		tool("jira_create_issue", ["project_key", "summary", "issue_type"], ["description", "assignee"]),
		tool("jira_edit_comment", ["issue_key", "comment_id", "body"], ["visibility"]),
		tool("jira_transition_issue", ["issue_key", "transition_id"], ["fields", "comment"]),
		tool("jira_assign_issue", ["issue_key"], ["assignee"]),
		tool("jira_delete_issue", ["issue_key"]),
	];
	const WRITE_CONFLUENCE_TOOLS = [
		...CONFLUENCE_TOOLS,
		tool("confluence_get_comments", ["page_id"]),
		tool("confluence_get_attachments", ["content_id"], ["start", "limit", "filename", "media_type"]),
		tool("confluence_create_page", ["space_key", "title"], ["content", "parent_id", "content_format"]),
		tool("confluence_update_page", ["page_id", "title"], ["content", "version_comment", "content_format"]),
		tool("confluence_add_comment", ["page_id", "body"]),
		tool("confluence_upload_attachment", ["content_id"], ["file_path", "file_content", "filename", "comment"]),
		tool("confluence_delete_attachment", ["attachment_id"]),
		tool("confluence_delete_page", ["page_id"]),
	];
	const page = (version: number, extra: Record<string, unknown> = {}) => ({ metadata: { id: "123", title: "Roadmap", version, ...extra } });
	const UPLOAD_NAME = "notes.txt";
	const UPLOAD_BYTES = "packaged upload bytes\n";
	interface WriteRow {
		product: "jira" | "confluence";
		input: Record<string, unknown>;
		// Replies before the write, by tool, and after it, by read tool.
		before: Record<string, unknown>;
		after: Record<string, unknown>;
		tool: string;
		args: Record<string, unknown>;
		reply: unknown;
		effects: { kind: string; id: string }[];
		// Independent oracle: the calls the apply makes after its write. A row
		// settled from the reply makes none; a row whose reply cannot prove its
		// effect reads the object back, and that read settles the receipt.
		readBack: string[];
		// The provider argument that names the staged copy of an upload, and
		// the Provider starts of the whole row: each MCPorter request starts
		// one. The preview sends three (schema list, target read, baseline
		// read); the apply repeats them, sends the write, and issue.attach
		// then reads the issue back (3 + 5 = 8), while page.attach settles
		// from its reply (3 + 4 = 7).
		upload?: { argument: string; providerStarts: number };
	}
	const WRITE_ROWS: Record<WriteOperation, WriteRow> = {
		"issue.create": {
			product: "jira",
			input: { projectKey: "EX", issueType: "Task", summary: "packaged create" },
			before: { jira_search: SEARCH_REPLY },
			after: {},
			tool: "jira_create_issue",
			args: { project_key: "EX", issue_type: "Task", summary: "packaged create" },
			reply: { message: "Issue created successfully", issue: { key: "EX-9", summary: "packaged create", issue_type: { name: "Task" } } },
			effects: [{ kind: "jira-issue", id: "EX-9" }],
			readBack: [],
		},
		"issue.update": {
			product: "jira",
			input: { issueKey: "EX-1", fields: { summary: "new summary" } },
			before: { jira_get_issue: issue({ summary: "old summary" }) },
			after: { jira_get_issue: issue({ summary: "new summary" }, MOVED) },
			tool: "jira_update_issue",
			args: { issue_key: "EX-1", fields: '{"summary":"new summary"}' },
			reply: { message: "Issue updated successfully", issue: { key: "EX-1" } },
			effects: [{ kind: "jira-issue", id: "EX-1" }],
			readBack: ["jira_get_issue"],
		},
		"issue.comment": {
			product: "jira",
			input: { issueKey: "EX-1", body: "packaged comment" },
			before: { jira_get_issue: issue({ comment: { comments: [] } }) },
			after: {},
			tool: "jira_add_comment",
			args: { issue_key: "EX-1", body: "packaged comment" },
			reply: { id: "10001", body: "packaged comment" },
			effects: [{ kind: "jira-comment", id: "10001" }],
			readBack: [],
		},
		"issue.comment.update": {
			product: "jira",
			input: { issueKey: "EX-1", commentId: "10001", body: "edited comment" },
			before: { jira_get_issue: issue({ comment: { comments: [{ id: "10001", body: "original comment", updated: UPDATED }] } }) },
			after: { jira_get_issue: issue({ comment: { comments: [{ id: "10001", body: "edited comment", updated: MOVED }] } }, MOVED) },
			tool: "jira_edit_comment",
			args: { issue_key: "EX-1", comment_id: "10001", body: "edited comment" },
			reply: { id: "10001", body: "edited comment" },
			effects: [{ kind: "jira-comment", id: "10001" }],
			readBack: ["jira_get_issue"],
		},
		"issue.attach": {
			product: "jira",
			input: { issueKey: "EX-1" },
			before: { jira_get_issue: issue({ attachment: [] }) },
			after: { jira_get_issue: issue({ attachment: [{ filename: UPLOAD_NAME, url: `${ORIGIN}/rest/api/3/attachment/content/10100` }] }, MOVED) },
			tool: "jira_update_issue",
			args: { issue_key: "EX-1", fields: "{}" },
			reply: { message: "Issue updated successfully", issue: { key: "EX-1" } },
			effects: [{ kind: "jira-attachment", id: "10100" }],
			readBack: ["jira_get_issue"],
			upload: { argument: "attachments", providerStarts: 8 },
		},
		"issue.transition": {
			product: "jira",
			input: { issueKey: "EX-1", toStatus: "Done" },
			before: { jira_get_issue: issue({ status: { name: "In Progress" } }), jira_get_transitions: TRANSITIONS_REPLY },
			after: { jira_get_issue: issue({ status: { name: "Done" } }, MOVED) },
			tool: "jira_transition_issue",
			args: { issue_key: "EX-1", transition_id: "31" },
			reply: { message: "Issue EX-1 transitioned successfully" },
			effects: [{ kind: "jira-issue", id: "EX-1" }],
			readBack: ["jira_get_issue"],
		},
		"issue.assign": {
			product: "jira",
			input: { issueKey: "EX-1", assignee: PRINCIPAL },
			before: { jira_get_issue: issue({ assignee: { display_name: "Unassigned" } }) },
			after: { jira_get_issue: issue({ assignee: { display_name: "Service Account", email: PRINCIPAL } }, MOVED) },
			tool: "jira_assign_issue",
			args: { issue_key: "EX-1", assignee: PRINCIPAL },
			reply: { message: "Issue EX-1 assigned successfully", issue: { key: "EX-1" } },
			effects: [{ kind: "jira-issue", id: "EX-1" }],
			readBack: ["jira_get_issue"],
		},
		"issue.delete": {
			product: "jira",
			input: { issueKey: "EX-1" },
			before: { jira_get_issue: issue({ summary: "disposable" }) },
			after: { jira_get_issue: { toolErrorText: "Issue EX-1 does not exist" } },
			tool: "jira_delete_issue",
			args: { issue_key: "EX-1" },
			reply: { message: "Issue EX-1 has been deleted successfully" },
			effects: [{ kind: "jira-issue", id: "EX-1" }],
			readBack: ["jira_get_issue"],
		},
		"page.create": {
			product: "confluence",
			input: { spaceKey: "EX", title: "Packaged page", body: "packaged page body" },
			before: { confluence_search: PAGE_SEARCH_REPLY },
			after: {},
			tool: "confluence_create_page",
			args: { space_key: "EX", title: "Packaged page", content: "packaged page body", content_format: "markdown" },
			reply: { message: "Page created successfully", page: { id: "789", title: "Packaged page" } },
			effects: [{ kind: "confluence-content", id: "789" }],
			readBack: [],
		},
		"page.update": {
			product: "confluence",
			input: { pageId: "123", body: "updated page body" },
			before: { confluence_get_page: page(7) },
			after: { confluence_get_page: page(8, { content: { value: "updated page body" } }) },
			tool: "confluence_update_page",
			// An omitted title keeps the one the preparatory read observed.
			args: { page_id: "123", title: "Roadmap", content: "updated page body", content_format: "markdown" },
			reply: { message: "Page updated successfully", page: { id: "123", title: "Roadmap" } },
			effects: [{ kind: "confluence-content", id: "123" }],
			readBack: ["confluence_get_page"],
		},
		"page.comment": {
			product: "confluence",
			input: { pageId: "123", body: "packaged page comment" },
			before: { confluence_get_page: page(7), confluence_get_comments: [] },
			after: {},
			tool: "confluence_add_comment",
			args: { page_id: "123", body: "packaged page comment" },
			reply: { id: "700", body: "packaged page comment" },
			effects: [{ kind: "confluence-comment", id: "700" }],
			readBack: [],
		},
		"page.attach": {
			product: "confluence",
			input: { pageId: "123" },
			before: { confluence_get_page: page(7), confluence_get_attachments: { attachments: [], total: 0 } },
			after: {},
			tool: "confluence_upload_attachment",
			args: { content_id: "123" },
			reply: { message: "Attachment uploaded successfully", attachment: { id: "att900", title: UPLOAD_NAME } },
			effects: [{ kind: "confluence-attachment", id: "att900" }],
			readBack: [],
			upload: { argument: "file_path", providerStarts: 7 },
		},
		"page.attachment.delete": {
			product: "confluence",
			input: { pageId: "123", attachmentId: "att900" },
			before: { confluence_get_page: page(7), confluence_get_attachments: { attachments: [{ id: "att900", title: "report.pdf" }] } },
			after: { confluence_get_attachments: { attachments: [] } },
			tool: "confluence_delete_attachment",
			args: { attachment_id: "att900" },
			reply: { success: true, message: "Attachment deleted successfully" },
			effects: [{ kind: "confluence-attachment", id: "att900" }],
			readBack: ["confluence_get_attachments"],
		},
		"page.delete": {
			product: "confluence",
			input: { pageId: "123" },
			before: { confluence_get_page: page(7) },
			after: { confluence_get_page: { toolErrorText: "Page 123 not found" } },
			tool: "confluence_delete_page",
			args: { page_id: "123" },
			reply: { success: true, message: "Page 123 deleted successfully" },
			effects: [{ kind: "confluence-content", id: "123" }],
			readBack: ["confluence_get_page"],
		},
	};
	const outbox = () => path.join(fixture.state, "connectors", "atlassian", "example", "outbox");
	const modeOf = (file: string) => statSync(file).mode & 0o7777;
	// One fresh fixture with every write tool listed and the row's replies.
	interface StagedUpload {
		digest: string;
		source: string;
		providerStarts: number;
	}
	function freshWrite(row: WriteRow, operation: string): { input: Record<string, unknown>; args: Record<string, unknown>; upload: StagedUpload | null } {
		fresh();
		fixture.canned("jira", "list", WRITE_JIRA_TOOLS);
		fixture.canned("confluence", "list", WRITE_CONFLUENCE_TOOLS);
		for (const [name, value] of Object.entries(row.before)) fixture.canned(row.product, name, value);
		for (const [name, value] of Object.entries(row.after)) fixture.canned(row.product, `${name}.after.${row.tool}`, value);
		fixture.canned(row.product, row.tool, row.reply);
		if (row.upload === undefined) return { input: row.input, args: row.args, upload: null };
		// Test-owned bytes; the expected staged path is computed here from them.
		const source = path.join(fixture.root, `upload-${operation}`, UPLOAD_NAME);
		mkdirSync(path.dirname(source));
		writeFileSync(source, UPLOAD_BYTES);
		const digest = createHash("sha256").update(UPLOAD_BYTES).digest("hex");
		return { input: { ...row.input, file: source }, args: { ...row.args, [row.upload.argument]: `${digest}/${UPLOAD_NAME}` }, upload: { digest, source, providerStarts: row.upload.providerStarts } };
	}
	const writeCalls = () => fixture.lines<{ product: string; tool: string; args: unknown }>("effects.jsonl").filter((call) => !READ_TOOLS.has(call.tool));

	test("write station sweep: the table names exactly the 14 accepted write operations", () => {
		expect(WRITE_OPERATIONS).toHaveLength(14);
		expect(Object.keys(WRITE_ROWS)).toEqual([...WRITE_OPERATIONS]);
	});

	test.each(WRITE_OPERATIONS.map((operation) => [operation] as const))(
		"write station sweep: %s previews without sending, applies its exact write once behind a completed durable receipt, and leaves no open receipt",
		async (operation) => {
			const row = WRITE_ROWS[operation];
			const { input, args, upload } = freshWrite(row, operation);
			const preview = await write(operation, input, ["--preview"]);
			expect([operation, preview.code, preview.stderr]).toEqual([operation, 0, ""]);
			const previewed = parse(preview.stdout).result;
			expect(station(previewed)).toEqual(["connectors.run.preview", "success", "SUCCESS_RUN_RECORDED", "repository-local", "completed", ["write-preview"], []]);
			const bound = record<{ previewId: string; tool: string; arguments: unknown }>(previewed);
			expect([bound.tool, bound.arguments]).toEqual([row.tool, args]);
			expect(writeCalls()).toEqual([]);
			const apply = await write(operation, input, ["--apply", bound.previewId]);
			expect([operation, apply.code, apply.stderr]).toEqual([operation, 0, ""]);
			const applied = parse(apply.stdout).result;
			expect(station(applied)).toEqual(["connectors.run.apply", "success", "SUCCESS_RUN_APPLIED", "external", "completed", ["write-receipt", "provider-write"], []]);
			expect(writeCalls()).toEqual([{ product: row.product, tool: row.tool, args }]);
			// What settled the receipt: the calls after the write, test-owned per row.
			const calls = fixture.lines<{ tool: string }>("effects.jsonl").map((call) => call.tool);
			expect([operation, calls.slice(calls.indexOf(row.tool) + 1)]).toEqual([operation, row.readBack]);
			const receipt = record(applied);
			expect([receipt.previewId, receipt.status, receipt.send, receipt.effects]).toEqual([bound.previewId, "completed", "possible", row.effects]);
			// The durable receipt, read from the journal file, not the envelope.
			const durable = JSON.parse(readFileSync(path.join(fixture.state, "connectors", "atlassian", "example", "receipts", `${receipt.runId}.json`), "utf8")) as JournalRecord;
			expect([durable.runId, durable.previewId, durable.status, durable.send, durable.effects]).toEqual([receipt.runId, bound.previewId, "completed", "possible", row.effects]);
			const listed = await recover();
			expect([listed.code, listed.stderr, record<{ open: JournalRecord[] }>(parse(listed.stdout).result)]).toEqual([0, "", { open: [] }]);
			if (upload !== null) {
				// The Upload Outbox holds exactly the test's bytes under their digest,
				// private; the write names the staged copy relative to the outbox, and
				// every Provider start runs in the outbox. The fake never opens the
				// file, so what the real package reads is not observed here.
				const staged = path.join(outbox(), upload.digest, UPLOAD_NAME);
				expect([readdirSync(outbox()), readdirSync(path.dirname(staged))]).toEqual([[upload.digest], [UPLOAD_NAME]]);
				expect([modeOf(outbox()), modeOf(path.dirname(staged)), modeOf(staged), readFileSync(staged, "utf8")]).toEqual([0o700, 0o700, 0o600, UPLOAD_BYTES]);
				const starts = fixture.lines<CommunityStart & { cwd: string }>("community-starts.jsonl");
				expect(starts).toHaveLength(upload.providerStarts);
				expect(new Set(starts.map((start) => start.cwd))).toEqual(new Set([realpathSync(outbox())]));
				expect(readFileSync(upload.source, "utf8")).toBe(UPLOAD_BYTES);
			}
			expectNoSecret(fixture, [preview.stdout, preview.stderr, apply.stdout, apply.stderr, listed.stdout, listed.stderr]);
		},
		90_000,
	);

	// SKILL.md: a file changed after its preview refuses the apply. The new
	// bytes stage under a new digest, so the journal-bound arguments differ.
	test("outbox: a file changed between preview and apply refuses the apply and sends nothing", async () => {
		const { input, upload } = freshWrite(WRITE_ROWS["issue.attach"], "issue.attach");
		if (upload === null) throw new Error("the issue.attach row stages an upload");
		const preview = await write("issue.attach", input, ["--preview"]);
		expect([preview.code, preview.stderr]).toEqual([0, ""]);
		const previewId = record(parse(preview.stdout).result).previewId;
		const changed = "changed after the preview\n";
		writeFileSync(upload.source, changed);
		const apply = await write("issue.attach", input, ["--apply", previewId]);
		expect([apply.code, apply.stderr]).toEqual([3, ""]);
		const refused = parse(apply.stdout).result;
		expect([...station(refused), refused.repairAction, refused.data]).toEqual([
			"connectors.run.apply", "refused", "DOMAIN_ADAPTER_REFUSED", "inspect", "unchanged", [], [],
			`${PREVIEW_REFUSED}; preview-args-mismatch`, { connector: "atlassian", connectorCause: "refused-preview" },
		]);
		expect(writeCalls()).toEqual([]);
		expect(atlassianFiles(fixture).filter((file) => file.startsWith("example/receipts/"))).toEqual([]);
		// Both versions were staged under their own digests; neither was sent.
		expect(readdirSync(outbox()).sort()).toEqual([upload.digest, createHash("sha256").update(changed).digest("hex")].sort());
		expectNoSecret(fixture, [preview.stdout, preview.stderr, apply.stdout, apply.stderr]);
	}, 90_000);

	// T5 U3b-1d (Spec AC10 and AC11): one fixture, one cumulative cycle through
	// every command and effect class. Every spawn holds its own token-shaped
	// stdin sentinel open until it exits. Each command's streams are checked
	// for every secret as soon as it exits, so a leak fails at its own command;
	// then the whole fixture, the op and Community argv, and (for the two
	// tokens only) the parents of op and of the Provider are checked once.
	// Positive controls: the Provider did receive its token, op did receive the
	// service token, and the sweep and process-table reads saw what they claim
	// to.
	test("capture sweep: across configure, check, reads, writes, an attachment, an unknown outcome, recovery, and refusals, no token reaches any stream, fixture file, or the exec-time argv and environment of op's parent or of each MCPorter that parented a Provider, and no stdin sentinel or mistyped token reaches any stream, fixture file, op argv, or Community argv, while the Provider still receives its token", async () => {
		fresh({ registered: false });
		fixture.canned("jira", "list", WRITE_JIRA_TOOLS);
		fixture.canned("confluence", "list", WRITE_CONFLUENCE_TOOLS);
		fixture.canned("jira", "jira_get_issue", issueWithComments([]));
		fixture.canned("jira", "jira_add_comment", { id: "10001", body: "sweep comment" });
		fixture.canned("confluence", "confluence_get_page", page(7));
		fixture.canned("confluence", "confluence_get_attachments", { attachments: [], total: 0 });
		fixture.canned("confluence", "confluence_upload_attachment", { message: "Attachment uploaded successfully", attachment: { id: "att901", title: UPLOAD_NAME } });
		const uploadBytes = "capture sweep upload bytes\n";
		const upload = path.join(fixture.root, "upload-sweep", UPLOAD_NAME);
		mkdirSync(path.dirname(upload));
		writeFileSync(upload, uploadBytes);
		// Independent oracle: an Atlassian API token pasted as an item ID. It
		// crosses the test's own spawn argv (F3 fact 2) and must reach nothing else.
		const MISTYPED = "ATATT3xFfGF0capture-sweep-mistyped-token";
		const sentinels: string[] = [];
		const streams: string[] = [];
		const observed: unknown[][] = [];
		const secrets = () => [SERVICE_TOKEN, PROVIDER_TOKEN, MISTYPED, ...sentinels];
		const step = async (label: string, argv: string[]): Promise<Envelope["result"]> => {
			const stdinSentinel = `ops_capture-stdin-sentinel-${String(sentinels.length + 1).padStart(2, "0")}-end`;
			sentinels.push(stdinSentinel);
			const result = await fixture.frontDoor(argv, { stdinSentinel });
			for (const secret of secrets()) expect([label, secret, result.stdout.includes(secret), result.stderr.includes(secret)]).toEqual([label, secret, false, false]);
			streams.push(result.stdout, result.stderr);
			const envelope = parse(result.stdout).result;
			observed.push([label, envelope.commandIdentity, envelope.causeCode, envelope.effectClass, result.code, result.stderr]);
			return envelope;
		};
		// A missing id stays a string, so a failed step fails in the matrix below.
		const idOf = (envelope: Envelope["result"], key: "previewId" | "runId") => String((envelope.data?.result as Record<string, unknown> | undefined)?.[key] ?? "missing");
		const run = ["run", "atlassian", ...TENANT];
		const auth = (verb: string) => ["auth", verb, "atlassian", ...TENANT];
		const recoverArgv = ["recover", "atlassian", ...TENANT];
		const ids = JSON.stringify({ jiraItem: JIRA_ITEM, confluenceItem: CONFLUENCE_ITEM });
		const comment = JSON.stringify({ issueKey: "EX-1", body: "sweep comment" });
		const attach = JSON.stringify({ pageId: "123", file: upload });
		const unknownComment = JSON.stringify({ issueKey: "EX-1", body: "sweep unknown comment" });

		await step("unregistered read", [...run, "issue.get", "--input", '{"issueKey":"EX-1"}']);
		await step("mistyped-token configure", [...auth("configure"), "--input", JSON.stringify({ jiraItem: MISTYPED, confluenceItem: CONFLUENCE_ITEM })]);
		await step("configure", [...auth("configure"), "--input", ids]);
		await step("identical configure", [...auth("configure"), "--input", ids]);
		await step("status", auth("status"));
		await step("auth check", auth("check"));
		await step("Jira read", [...run, "issue.get", "--input", '{"issueKey":"EX-1"}']);
		await step("Confluence read", [...run, "page.get", "--input", '{"pageId":"123"}']);
		const commentPreview = idOf(await step("issue.comment preview", [...run, "issue.comment", "--input", comment, "--preview"]), "previewId");
		const commentReceipt = idOf(await step("issue.comment apply", [...run, "issue.comment", "--input", comment, "--apply", commentPreview]), "runId");
		const attachPreview = idOf(await step("page.attach preview", [...run, "page.attach", "--input", attach, "--preview"]), "previewId");
		await step("page.attach apply", [...run, "page.attach", "--input", attach, "--apply", attachPreview]);
		fixture.canned("jira", "jira_add_comment", { exitAfterRecord: true });
		const unknownPreview = idOf(await step("unknown-outcome preview", [...run, "issue.comment", "--input", unknownComment, "--preview"]), "previewId");
		const unknownRun = idOf(await step("unknown-outcome apply", [...run, "issue.comment", "--input", unknownComment, "--apply", unknownPreview]), "runId");
		await step("recover list", recoverArgv);
		await step("recover run", [...recoverArgv, "--run", unknownRun]);
		fixture.canned("jira", "jira_get_issue", issueWithComments([{ id: "40004", body: "sweep unknown comment" }]));
		await step("adjudicate", [...recoverArgv, "--run", unknownRun, "--adjudicate", "--input", unknownComment]);
		await step("unlock", [...recoverArgv, "--run", unknownRun, "--unlock"]);
		await step("schema refusal", [...run, "issue.get", "--input", JSON.stringify({ issueKey: "EX-1", bogus: 1 })]);
		await step("unknown command", ["no-such-command"]);

		// Independent oracle: [label, command identity, cause, effect class, exit, stderr].
		const MATRIX = [
			["unregistered read", "connectors.run", "DOMAIN_ADAPTER_REFUSED", "inspect", 3, ""],
			["mistyped-token configure", "connectors.auth", "SCHEMA_ADAPTER_REFUSED", "inspect", 4, ""],
			["configure", "connectors.auth", "SUCCESS_RUN_RECORDED", "repository-local", 0, ""],
			["identical configure", "connectors.auth", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["status", "connectors.auth", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["auth check", "connectors.auth", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["Jira read", "connectors.run", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["Confluence read", "connectors.run", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["issue.comment preview", "connectors.run.preview", "SUCCESS_RUN_RECORDED", "repository-local", 0, ""],
			["issue.comment apply", "connectors.run.apply", "SUCCESS_RUN_APPLIED", "external", 0, ""],
			["page.attach preview", "connectors.run.preview", "SUCCESS_RUN_RECORDED", "repository-local", 0, ""],
			["page.attach apply", "connectors.run.apply", "SUCCESS_RUN_APPLIED", "external", 0, ""],
			["unknown-outcome preview", "connectors.run.preview", "SUCCESS_RUN_RECORDED", "repository-local", 0, ""],
			["unknown-outcome apply", "connectors.run.apply", "DOMAIN_RUN_EFFECT_UNKNOWN", "external", 3, ""],
			["recover list", "connectors.recover", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["recover run", "connectors.recover", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["adjudicate", "connectors.recover.adjudicate", "SUCCESS_RUN_RECORDED", "repository-local", 0, ""],
			["unlock", "connectors.recover.unlock", "SUCCESS_UNCHANGED", "inspect", 0, ""],
			["schema refusal", "connectors.run", "SCHEMA_ADAPTER_REFUSED", "inspect", 4, ""],
			["unknown command", "connectors.dispatch", "USAGE_UNKNOWN_COMMAND", "inspect", 2, ""],
		];
		expect(MATRIX).toHaveLength(20);
		expect(observed).toEqual(MATRIX);
		expect([...new Set(observed.map((row) => row[3]))].sort()).toEqual(["external", "inspect", "repository-local"]);
		expect(new Set(sentinels).size).toBe(20);

		// The fixture sweep, after the upload source is gone, so the upload bytes
		// can come only from the outbox copy. It must hold the fakes' logs, the
		// registration, the comment's preview and receipt, the outbox copy, and
		// op's parent records, or an empty sweep would pass.
		rmSync(path.dirname(upload), { recursive: true });
		const sweep = fixture.sweepText();
		for (const expected of ['"envKeys"', '"parentRole"', registrationLiteral("example", JIRA_ITEM_ID, CONFLUENCE_ITEM_ID), commentPreview, commentReceipt, uploadBytes]) expect([expected, sweep.includes(expected)]).toEqual([expected, true]);
		for (const surface of [...streams, sweep]) for (const secret of secrets()) expect([secret, surface.includes(secret)]).toEqual([secret, false]);

		// op: only item reads of the two registered IDs, with the service token
		// (positive control) and exactly its three environment keys.
		const opCalls = fixture.lines("op-calls.jsonl");
		const opRead = (item: string) => JSON.stringify({ argv: ITEM_READ(item), envKeys: OP_ENV_KEYS, serviceTokenMatches: true });
		expect(new Set(opCalls.map((call) => JSON.stringify(call)))).toEqual(new Set([opRead(JIRA_ITEM), opRead(CONFLUENCE_ITEM)]));
		expect(fixture.lines("keychain-reads.jsonl")).toEqual(Array.from({ length: opCalls.length }, () => keychainRead(fixture)));
		// The Provider's replacement: the pinned Community argv, the provider
		// token received (positive control), and MCPorter, its parent, visible
		// and holding neither token.
		const starts = fixture.lines<CommunityStart & { product: string }>("community-starts.jsonl");
		expect(new Set(starts.map((start) => start.product))).toEqual(new Set(["jira", "confluence"]));
		const selected = realpathSync(selectedMcporter(fixture));
		for (const start of starts) {
			expect(start.argv).toEqual(COMMUNITY_ARGV);
			expect([start.providerTokenMatches, start.serviceTokenInEnvironment]).toEqual([true, false]);
			expect(realpathSync(start.parentExecutable)).toBe(selected);
			expect([start.parentEnvironmentVisible, start.parentHoldsServiceToken, start.parentHoldsProviderToken]).toEqual([true, false, false]);
		}
		// op's parent, one record per op call: the copy's front door in each
		// custody role, its environment visible, and neither token in its argv
		// or environment.
		const opParents = readFileSync(path.join(fixture.root, "op-parents.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { parentExecutable: string; parentRole: string[]; parentEnvironmentVisible: boolean; parentHoldsServiceToken: boolean; parentHoldsProviderToken: boolean });
		expect(opParents).toHaveLength(opCalls.length);
		expect(new Set(opParents.map((parent) => parent.parentRole.join(" ")))).toEqual(new Set(["__internal atlassian custody-child", "__internal atlassian provider --preflight", "__internal atlassian provider"]));
		const frontDoor = realpathSync(path.join(fixture.pluginRoot, "bin", "connectors"));
		for (const parent of opParents) {
			expect([parent.parentRole, parent.parentEnvironmentVisible, parent.parentHoldsServiceToken, parent.parentHoldsProviderToken]).toEqual([parent.parentRole, true, false, false]);
			expect([parent.parentRole, realpathSync(parent.parentExecutable)]).toEqual([parent.parentRole, frontDoor]);
		}
		expectNoHostile(fixture);
	}, 180_000);
});
