// Ticket #92: Atlassian under the 1Password custody mode, proved at the
// Atlassian dispatcher process (scripts/atlassian-dispatch.ts), not the
// packaged bin/connectors front door, so this is partial evidence toward
// Spec #87 AC8 to AC11, AC16, and AC20 only, and substituted-reader process
// proof: every process runs from the verified plugin copy (plugin-copy.ts)
// whose Keychain-read leaf is the test-owned reader fake, so no test here reads the macOS Keychain or the
// shipped reader (the real /usr/bin/security read is the gated attended
// suite's proof). The dispatcher runs as a real process; the verified
// official MCPorter is selected by the production bootstrap and starts the
// real Provider; op and uv are fakes at the paths setup publishes, admitted
// only by the copy's requirements.json naming their digests.
// The fakes and the process-table read report argv, key sets, and booleans, never values, so
// every sentinel check below reads an independent surface.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CustodyFixture, OFFICIAL_MCPORTER, PROVIDER_TOKEN, SERVICE_TOKEN, seedMcporter } from "./fixtures/custody-fixture.ts";
import { substitutedPluginRoot } from "./fixtures/plugin-copy.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for Atlassian custody process proof");
// The plugin copy is taken here, so its removal binds to this file: the
// MCPorter bootstrap hook below throws on failure, and Bun drops the removal
// of a copy that a throwing hook asked for first.
substitutedPluginRoot();

const PRINCIPAL = "service@example.invalid";
const ORIGIN = "https://example.atlassian.net";
const JIRA_ITEM_READ = ["item", "get", "JIRA_EXAMPLE_API_TOKEN", "--vault", "API Credentials", "--format", "json"];
// Test-owned literals of the accepted handoffs and repairs.
const ITEM_HANDOFF = "create the Atlassian API token in your Atlassian account settings and store it yourself in the 1Password item JIRA_EXAMPLE_API_TOKEN in the API Credentials vault; Connectors never creates, rotates, or imports a token";
const KEYCHAIN_HANDOFF = "store the Connectors 1Password service-account token in the login Keychain yourself: security add-generic-password -s connectors.1password.service-account -a connectors -w (it prompts for the value; Connectors never receives it)";
const KEYCHAIN_READ = (fixture: CustodyFixture) => ({ argv: ["find-generic-password", "-s", "connectors.1password.service-account", "-a", "connectors", "-w", path.join(fixture.home, "Library", "Keychains", "login.keychain-db")], envKeys: ["HOME", "PATH"] });
const PROVIDER_ENV_KEYS = ["HOME", "JIRA_API_TOKEN", "JIRA_URL", "JIRA_USERNAME", "PATH", "TMPDIR", "XDG_STATE_HOME"];
const tool = (name: string, required: string[], optional: string[] = []) => ({ name, description: name, inputSchema: { type: "object", required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, { type: "string" }])) } });
const JIRA_TOOLS = [
	tool("jira_get_issue", ["issue_key"], ["fields", "comment_limit"]),
	tool("jira_update_issue", ["issue_key", "fields"], ["additional_fields", "components", "attachments", "return_fields"]),
	tool("jira_add_comment", ["issue_key", "body"], ["visibility", "public"]),
];

interface Envelope {
	result: { outcome: string; causeCode: string; exitCode: number; repairAction: string | null; transactionState: string; effectClass: string; data: Record<string, unknown> | null; effects: { completed: string[] } };
}
interface CommunityStart {
	argv: string[];
	envKeys: string[];
	providerTokenMatches: boolean;
	serviceTokenInEnvironment: boolean;
	parentExecutable: string;
	parentEnvironmentVisible: boolean;
	parentHoldsServiceToken: boolean;
	parentHoldsProviderToken: boolean;
}
interface OpCall {
	argv: string[];
	envKeys: string[];
	serviceTokenMatches: boolean;
}

const parse = (stdout: string): Envelope => {
	expect(stdout.trim().split("\n")).toHaveLength(1);
	return JSON.parse(stdout) as Envelope;
};

// Streams plus every file under the fixture root: HOME, plugin and MCPorter
// state, TMPDIR, and the fakes' logs. Extra sentinels cover values a test
// planted itself.
function expectNoSecret(fixture: CustodyFixture, streams: string[], sentinels: string[] = []): void {
	const surfaces = [...streams, fixture.sweepText()];
	// The sweep must have read the Atlassian state, or it proves nothing.
	expect(surfaces.at(-1)).toContain(fixture.atlassianStateText());
	for (const surface of surfaces) for (const secret of [SERVICE_TOKEN, PROVIDER_TOKEN, ...sentinels]) expect(surface).not.toContain(secret);
}

// Each dispatcher invocation binds the credential once (one op read); each
// MCPorter request runs the Provider preflight (one op read) and then starts
// the Provider (one op read and one Community start).
const expectedOpReads = (requests: number) => 1 + 2 * requests;
// Preview, apply, receipts, and receipt: preview binds once and sends the
// schema list and the preparatory issue read; apply binds once and sends the
// schema list, the revision read, and the comment; receipts and receipt read
// only the journal.
const PREVIEW_APPLY_PROVIDER_STARTS = 5;
const PREVIEW_APPLY_OP_READS = expectedOpReads(2) + expectedOpReads(3);

// The service token reached op and only op; the provider token reached the
// Provider's replacement and never MCPorter, the process that started it.
// Counts are pinned per test from its fixed command and request sequence.
function expectConfined(fixture: CustodyFixture, counts: { opReads: number; providerStarts: number }): void {
	const opCalls = fixture.lines<OpCall>("op-calls.jsonl");
	expect(opCalls).toEqual(Array.from({ length: counts.opReads }, () => ({ argv: JIRA_ITEM_READ, envKeys: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], serviceTokenMatches: true })));
	// Every op read follows exactly one service-token read through the fake.
	expect(fixture.lines("keychain-reads.jsonl")).toEqual(Array.from({ length: counts.opReads }, () => KEYCHAIN_READ(fixture)));
	const starts = fixture.lines<CommunityStart>("community-starts.jsonl");
	expect(starts).toHaveLength(counts.providerStarts);
	const selected = realpathSync(path.join(fixture.state, "connectors", "mcporter", "current", "mcporter"));
	for (const start of starts) {
		expect(start.argv).toEqual(["tool", "run", "--system-certs", "--no-env-file", "--from", "mcp-atlassian==0.23.1", "mcp-atlassian"]);
		expect(start.envKeys).toEqual(PROVIDER_ENV_KEYS);
		expect([start.providerTokenMatches, start.serviceTokenInEnvironment]).toEqual([true, false]);
		expect(realpathSync(start.parentExecutable)).toBe(selected);
		// The process-table oracle must actually see MCPorter's environment to count.
		expect([start.parentEnvironmentVisible, start.parentHoldsServiceToken, start.parentHoldsProviderToken]).toEqual([true, false, false]);
	}
	expect(fixture.lines("hostile-mcporter.jsonl")).toEqual([]);
}

let template: CustodyFixture | undefined;
let fixture: CustodyFixture;
const fresh = (seed = true, serviceToken = SERVICE_TOKEN): CustodyFixture => {
	fixture = new CustodyFixture().installAll(serviceToken);
	fixture.writeItem({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN });
	fixture.canned("jira", "list", JIRA_TOOLS);
	if (seed && template) seedMcporter(template, fixture);
	return fixture;
};
afterEach(() => fixture?.dispose());

describe("refusals before any Provider or MCPorter start", () => {
	test("an absent 1Password item refuses with a handoff and never asks op to create anything", async () => {
		fresh();
		rmSync(path.join(fixture.root, "item.json"));
		const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.outcome, envelope.causeCode, envelope.repairAction, envelope.transactionState]).toEqual(["refused", "refused-credential-unconfigured", ITEM_HANDOFF, "unchanged"]);
		expect(fixture.lines<OpCall>("op-calls.jsonl").map((call) => call.argv)).toEqual([JIRA_ITEM_READ]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expect(fixture.lines("keychain-reads.jsonl")).toEqual([KEYCHAIN_READ(fixture)]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	});

	test("an absent Keychain service token refuses with a handoff before op starts", async () => {
		fresh();
		fixture.removeKeychainToken();
		const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.outcome, envelope.causeCode, envelope.repairAction, envelope.transactionState]).toEqual(["refused", "refused-credential-unconfigured", KEYCHAIN_HANDOFF, "unchanged"]);
		expect(fixture.lines("keychain-reads.jsonl")).toEqual([KEYCHAIN_READ(fixture)]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
		expect(fixture.lines("community-starts.jsonl")).toEqual([]);
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	});

	test("a malformed Keychain value is never handed to op or echoed", async () => {
		const malformed = "not-a-service-account-token-sentinel";
		fresh(true, malformed);
		const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.causeCode, envelope.repairAction]).toEqual(["refused-precondition", "credential custody could not produce a stable context"]);
		expect(fixture.lines("keychain-reads.jsonl")).toEqual([KEYCHAIN_READ(fixture)]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
		expectNoSecret(fixture, [result.stdout, result.stderr], [malformed]);
	});

	test("a missing, unselected, or changed plugin-owned op refuses with the setup repair before the token is read", async () => {
		for (const damage of ["missing record", "wrong record", "wrong mode", "changed bytes"] as const) {
			fresh();
			const record = path.join(fixture.opDirectory, "op-selected");
			if (damage === "missing record") rmSync(record);
			if (damage === "wrong record") writeFileSync(record, "op-2.38.0-0000");
			if (damage === "wrong mode") chmodSync(path.join(fixture.opDirectory, readFileSync(record, "utf8")), 0o755);
			// Name, owner, mode, and record still match; only the bytes differ,
			// and the changed file would still run.
			if (damage === "changed bytes") appendFileSync(path.join(fixture.opDirectory, readFileSync(record, "utf8")), "\n");
			const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
			const envelope = parse(result.stdout).result;
			expect([damage, result.code, result.stderr, envelope.causeCode, envelope.repairAction]).toEqual([damage, 3, "", "refused-precondition", "the plugin-owned 1Password CLI is not set up; run connectors setup"]);
			// op is checked first, so the service token is never read.
			expect([damage, fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl")]).toEqual([damage, [], []]);
			fixture.dispose();
		}
	});

	test("a missing or changed plugin-owned uv refuses with the setup repair before any credential read or process start", async () => {
		for (const damage of ["missing", "changed bytes"] as const) {
			fresh();
			if (damage === "missing") rmSync(fixture.uvExecutable);
			// Same path, owner, and mode; only the bytes differ, and the changed
			// file would still run with the provider token.
			if (damage === "changed bytes") appendFileSync(fixture.uvExecutable, "\n");
			const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
			expect([damage, result.code, result.stderr]).toEqual([damage, 3, ""]);
			const envelope = parse(result.stdout).result;
			expect([damage, envelope.causeCode, envelope.repairAction]).toEqual([damage, "refused-precondition", "the plugin-owned uv is not set up; run connectors setup"]);
			// uv is checked before the dispatcher binds the credential, so no
			// service token is read, op never starts, and no Provider starts.
			expect([damage, fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([damage, [], [], []]);
			expect([damage, existsSync(path.join(fixture.state, "connectors", "mcporter"))]).toEqual([damage, false]);
			expectNoSecret(fixture, [result.stdout, result.stderr]);
			fixture.dispose();
		}
	});

	test("the shipped requirements admit neither fake uv nor fake op, even at the official paths with a matching record and mode", async () => {
		// Production anchor: the copy's requirements.json is the shipped bytes,
		// so the fakes sit at the official uv path and op revision name.
		fixture = new CustodyFixture({ manifest: "shipped" }).installAll();
		expect(readFileSync(path.join(fixture.opDirectory, "op-selected"), "utf8")).toBe("op-2.39.0-7e17cbf4052393d2c55a59a7c3d05f0bbcdcb079d57785cff682f3bc994ba8ce");
		expect(fixture.uvExecutable.endsWith(path.join("aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin", "uv"))).toBe(true);
		fixture.writeItem({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN });
		// The dispatcher checks uv first, so it meets the shipped uv digest.
		const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
		const envelope = parse(result.stdout).result;
		expect([result.code, result.stderr, envelope.causeCode, envelope.repairAction]).toEqual([3, "", "refused-precondition", "the plugin-owned uv is not set up; run connectors setup"]);
		// The custody child, the only op caller, meets the shipped op digest. It
		// starts as the copy's compiled internal custody role.
		const child = Bun.spawnSync([path.join(fixture.pluginRoot, "bin", "connectors"), "__internal", "atlassian", "custody-child"], { env: fixture.environment({ CONNECTORS_INTERNAL_INVOCATION_CONTEXT: '{"tenant":"example","product":"jira"}' }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		expect([child.exitCode, child.stdout.toString(), child.stderr.toString()]).toEqual([3, "", "atlassian-credential-binding:error:op-unavailable\n"]);
		expect([fixture.lines("keychain-reads.jsonl"), fixture.lines("op-calls.jsonl"), fixture.lines("community-starts.jsonl")]).toEqual([[], [], []]);
	});
});

describe.skipIf(!OFFICIAL_MCPORTER)("the verified MCPorter route", () => {
	beforeAll(async () => {
		// One production first-use bootstrap; later fixtures reuse its selection.
		const first = new CustodyFixture().installAll();
		first.writeItem({ username: PRINCIPAL, credential: PROVIDER_TOKEN, site_url: ORIGIN });
		first.canned("jira", "list", JIRA_TOOLS);
		first.canned("jira", "jira_get_issue", { key: "PROJ-1", summary: "canned" });
		const result = await first.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
		if (result.code !== 0) {
			first.dispose();
			throw new Error(`template bootstrap failed: ${result.stdout}`);
		}
		template = first;
	}, 120_000);
	afterAll(() => template?.dispose());

	test("first use bootstraps the verified MCPorter, completes the read, and confines both tokens", async () => {
		fresh(false);
		fixture.canned("jira", "jira_get_issue", { key: "PROJ-1", summary: "canned" });
		const result = await fixture.dispatch(["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}']);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const envelope = parse(result.stdout).result;
		expect([envelope.causeCode, envelope.data]).toEqual(["success", { key: "PROJ-1", summary: "canned" }]);
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter", "current", "release.json"))).toBe(true);
		expect(fixture.lines("effects.jsonl")).toEqual([{ product: "jira", tool: "jira_get_issue", args: { issue_key: "PROJ-1" } }]);
		expectConfined(fixture, { opReads: expectedOpReads(2), providerStarts: 2 });
		expectNoSecret(fixture, [result.stdout, result.stderr]);
	}, 60_000);

	test("preview, apply, receipts, and receipt keep both tokens out of every output and journal", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", { key: "PROJ-1", fields: { updated: "t1", comment: { comments: [] } } });
		fixture.canned("jira", "jira_add_comment", { id: "10001", body: "canned" });
		const input = '{"issueKey":"PROJ-1","body":"canned"}';
		const preview = await fixture.dispatch(["--tenant", "example", "issue.comment", "--input", input, "--preview"]);
		const previewed = parse(preview.stdout).result;
		expect([preview.code, preview.stderr, previewed.effectClass]).toEqual([0, "", "repository-local"]);
		const apply = await fixture.dispatch(["--tenant", "example", "issue.comment", "--input", input, "--apply", String(previewed.data?.previewId)]);
		const applied = parse(apply.stdout).result;
		expect([apply.code, apply.stderr, applied.effectClass, applied.transactionState, applied.effects.completed]).toEqual([0, "", "external", "completed", ["jira-comment:10001"]]);
		const receipts = await fixture.dispatch(["--tenant", "example", "receipts"]);
		expect([receipts.code, receipts.stderr, parse(receipts.stdout).result.data]).toEqual([0, "", { open: [] }]);
		const runId = String(applied.data?.runId);
		const receipt = await fixture.dispatch(["--tenant", "example", "receipt", "--run", runId]);
		expect([receipt.code, receipt.stderr, parse(receipt.stdout).result.causeCode]).toEqual([0, "", "success"]);
		expect(fixture.lines<{ tool: string }>("effects.jsonl").filter((call) => call.tool === "jira_add_comment")).toHaveLength(1);
		const receiptsDirectory = path.join(fixture.state, "connectors", "atlassian", "example", "receipts");
		const stored = readdirSync(receiptsDirectory).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(receiptsDirectory, name), "utf8")) as { provider: string; status: string; send: string });
		expect(stored.map((entry) => [entry.provider, entry.status, entry.send])).toEqual([["community", "completed", "possible"]]);
		expectConfined(fixture, { opReads: PREVIEW_APPLY_OP_READS, providerStarts: PREVIEW_APPLY_PROVIDER_STARTS });
		expectNoSecret(fixture, [preview.stdout, preview.stderr, apply.stdout, apply.stderr, receipts.stdout, receipts.stderr, receipt.stdout, receipt.stderr]);
	}, 60_000);

	test("a preview whose target revision moved is refused at apply and sends no write", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", { key: "PROJ-1", fields: { updated: "2026-09-25 09:00:00 AEST", summary: "old" } });
		fixture.canned("jira", "jira_update_issue", { key: "PROJ-1" });
		const input = '{"issueKey":"PROJ-1","fields":{"summary":"new"}}';
		const preview = parse((await fixture.dispatch(["--tenant", "example", "issue.update", "--input", input, "--preview"])).stdout).result;
		expect([preview.causeCode, preview.data?.revision]).toEqual(["success", "2026-09-25 09:00:00 AEST"]);
		fixture.canned("jira", "jira_get_issue", { key: "PROJ-1", fields: { updated: "2026-09-25 09:05:00 AEST", summary: "changed elsewhere" } });
		const apply = await fixture.dispatch(["--tenant", "example", "issue.update", "--input", input, "--apply", String(preview.data?.previewId)]);
		expect([apply.code, apply.stderr]).toEqual([3, ""]);
		const refused = parse(apply.stdout).result;
		expect([refused.outcome, refused.causeCode, refused.transactionState, refused.repairAction?.endsWith("preview-revision-changed")]).toEqual(["refused", "refused-preview", "unchanged", true]);
		expect(fixture.lines<{ tool: string }>("effects.jsonl").map((call) => call.tool).filter((name) => name !== "jira_get_issue")).toEqual([]);
		expectNoSecret(fixture, [apply.stdout, apply.stderr]);
	}, 60_000);

	test("two competing applies of one preview produce exactly one provider write and one refusal", async () => {
		fresh();
		fixture.canned("jira", "jira_get_issue", { key: "PROJ-1", fields: { updated: "t1", comment: { comments: [] } } });
		fixture.canned("jira", "jira_add_comment", { id: "20002", body: "once" });
		const input = '{"issueKey":"PROJ-1","body":"once"}';
		const preview = parse((await fixture.dispatch(["--tenant", "example", "issue.comment", "--input", input, "--preview"])).stdout).result;
		const apply = ["--tenant", "example", "issue.comment", "--input", input, "--apply", String(preview.data?.previewId)];
		const [left, right] = await Promise.all([fixture.dispatch(apply), fixture.dispatch(apply)]);
		const outcomes = [parse(left.stdout).result, parse(right.stdout).result].map((result) => [result.outcome, result.causeCode, result.effects.completed.join(",")]).sort();
		// The loser meets either the consumed preview or the winner's object lock.
		expect([outcomes[0]?.slice(0, 1), outcomes[1]]).toEqual([["refused"], ["success", "success", "jira-comment:20002"]]);
		expect(["refused-preview", "refused-write-blocked"]).toContain(String(outcomes[0]?.[1]));
		expect([left.stderr, right.stderr]).toEqual(["", ""]);
		expect(fixture.lines<{ product: string; tool: string; args: unknown }>("effects.jsonl").filter((call) => call.tool === "jira_add_comment")).toEqual([{ product: "jira", tool: "jira_add_comment", args: { issue_key: "PROJ-1", body: "once" } }]);
		expectNoSecret(fixture, [left.stdout, left.stderr, right.stdout, right.stderr]);
	}, 90_000);
});
