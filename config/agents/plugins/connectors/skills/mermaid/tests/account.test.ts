// Ticket #94 under Spec #87 (AC11, AC15, AC16, AC20, AC21): Mermaid's
// optional account tier and its journaled writes through the packaged front
// door. Every process is the compiled bin/connectors of the verified
// substituted plugin copy (fixtures/account-fixture.ts) under a loopback-only
// sandbox that denies the real Keychain tool. MCPorter is the official 0.14.0
// release the production bootstrap selects; a hostile mcporter, bun, node, op,
// uv, and uvx sit first on PATH. The hosted account endpoint is replaced by a
// stateful loopback stub, and the token by a sentinel. Expected values are
// test-owned literals from the accepted contract and the 2026-09-26
// authenticated schema receipt. Substituted-source packaged process proof
// only: no real Keychain, op, Mermaid account, or live write is reached.
//
// Authoring gate. Each test names the behavior it protects and one wrong
// behavior that fails it:
// - custody: the token reaches only the hosted request header. Fails if the
//   route carried the token into MCPorter, an argument, an environment, a
//   file, or an output, or if a gate refusal still read custody.
// - writes: an apply sends only the previewed input, at most once, and an
//   unknown effect is never retried and settles only on found evidence.
//   Fails if a second apply, a stale preview, or a re-preview of a blocked
//   object sends a write, or if adjudication marks success without evidence.
// - concurrency: two applies of one preview make one write and one refusal.
// - recovery: an apply killed before its request can leave never blocks its
//   object with a receipt, and its lock is released by the preview ID. Fails
//   if the receipt precedes the Provider preflight, or if no product route
//   removes a lock that has no receipt.
// - fail closed: an unreadable or malformed receipt refuses every write,
//   preview, and recovery. Fails if the journal skips it and lets a second
//   write reach the Provider while the first effect is unknown.
// No existing test reaches the account tier, its Provider role, or its
// journal, and none needs a production seam beyond the two substituted leaves.
import { expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_ENDPOINT } from "../scripts/endpoint.ts";
import { AccountMachine, type Envelope, ITEM_ID, OFFICIAL_MCPORTER, PROVIDER_TOKEN, SERVICE_TOKEN } from "./fixtures/account-fixture.ts";
import { type AccountStub, startAccountStub } from "./fixtures/account-stub.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for the packaged Mermaid account proof");

// Independent oracles, restated from the accepted contract.
const REGISTRATION_LITERAL = `{"schemaVersion":1,"vault":"API Credentials","item":"${ITEM_ID}"}\n`;
const OP_READ = { argv: ["item", "get", ITEM_ID, "--vault", "API Credentials", "--format", "json"], envKeys: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], serviceTokenMatches: true };
const UNPROVEN_EVIDENCE = { configured: true, localReady: null, custodyChecked: null, authenticated: false, schemaQualified: false, liveReadProven: false, liveWriteProven: false, fixtureTested: null };
const KEYCHAIN_HANDOFF = "store the Connectors 1Password service-account token in the login Keychain yourself: security add-generic-password -s connectors.1password.service-account -a connectors -w (it prompts for the value; Connectors never receives it)";
const UNREGISTERED_REPAIR = `the Mermaid account tier needs a registration first: run connectors auth configure mermaid --input '{"item":"<id>"}'`;
const INPUT_SENTINEL = "SENTINEL_MERMAID_INPUT_VALUE";
const AMBIENT_SENTINEL = "SENTINEL_AMBIENT_MERMAID_TOKEN";
const RENAMED_SENTINEL = "SENTINEL_RENAMED_RECEIPT_ops_secret";
const SEED = [{ documentID: "doc-1", title: "Seed", code: "flowchart LR\n  A --> B" }];
// Independent oracle: the one hosted origin the Mermaid API token may reach.
const HOSTED_ENDPOINT = "https://mcp.mermaid.ai/mcp";
const CLIENT = "connectors";

interface Context {
	readonly machine: AccountMachine;
	readonly stub: AccountStub;
	readonly outputs: string[];
	run(argv: string[]): Promise<{ code: number; result: Envelope["result"] }>;
}

async function withAccount(body: (context: Context) => Promise<void>, register = true): Promise<void> {
	const stub = startAccountStub(PROVIDER_TOKEN, SEED);
	const machine = new AccountMachine(stub.url).installCustody();
	const outputs: string[] = [];
	const context: Context = {
		machine, stub, outputs,
		async run(argv) {
			const run = await machine.run(argv);
			outputs.push(run.stdout, run.stderr);
			expect({ argv, stderr: run.stderr }).toEqual({ argv, stderr: "" });
			expect(run.stdout.trim().split("\n")).toHaveLength(1);
			return { code: run.code, result: (JSON.parse(run.stdout) as Envelope).result };
		},
	};
	try {
		if (register) expect((await context.run(["auth", "configure", "mermaid", "--input", JSON.stringify({ item: ITEM_ID })])).result.causeCode).toBe("SUCCESS_RUN_RECORDED");
		await body(context);
		// The token and the service token never reach any output or file; the
		// sweep must have read the fakes' own logs, or it proves nothing.
		const sweep = machine.sweepText();
		expect(sweep).toContain('"serviceTokenMatches"');
		for (const surface of [...outputs, sweep]) for (const secret of [PROVIDER_TOKEN, SERVICE_TOKEN, AMBIENT_SENTINEL, INPUT_SENTINEL]) expect(surface).not.toContain(secret);
		expect(machine.lines("hostile-recorders.jsonl")).toEqual([]);
		expect(machine.lines("hostile-mcporter.jsonl")).toEqual([]);
	} finally {
		stub.stop();
		machine.dispose();
	}
}

const station = (run: { code: number; result: Envelope["result"] }) => ({ code: run.code, cause: run.result.causeCode, connectorCause: run.result.data?.connectorCause ?? null, completed: run.result.effects.completed.filter((effect) => effect !== "mcporter-bootstrap"), uncertain: run.result.effects.uncertain });
const openReceipts = async (run: Context["run"]) => ((await run(["recover", "mermaid"])).result.data?.receipts as { runId: string }[]).map((receipt) => receipt.runId);
const writeCalls = (stub: AccountStub) => stub.calls.filter((call) => call.name.startsWith("create_") || call.name.startsWith("update_"));

// Fails if the shipped Provider, or the front door compiled from it, would
// relay the token to any other origin. Routine process tests substitute this
// leaf in a copy, so only this test observes the shipped value.
test("the shipped account Provider relays only to the hosted Mermaid endpoint", () => {
	expect(ACCOUNT_ENDPOINT).toBe(HOSTED_ENDPOINT);
	expect(readFileSync(path.resolve(import.meta.dir, "..", "..", "..", "bin", "connectors")).includes(HOSTED_ENDPOINT)).toBe(true);
});

test.skipIf(!OFFICIAL_MCPORTER)("account custody gates on the registration and confines the token to the Provider's hosted request", async () => {
	await withAccount(async ({ machine, stub, run }) => {
		// Before configure: refusals that read no custody and start nothing.
		const unregistered = await run(["run", "mermaid", "list_mermaid_chart_projects", "--input", JSON.stringify({ clientName: CLIENT })]);
		expect({ ...station(unregistered), repair: unregistered.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "account-unregistered", completed: [], uncertain: [], repair: UNREGISTERED_REPAIR });
		const badItem = await run(["auth", "configure", "mermaid", "--input", JSON.stringify({ item: INPUT_SENTINEL })]);
		expect(station(badItem)).toEqual({ code: 4, cause: "SCHEMA_ADAPTER_REFUSED", connectorCause: "item-reference-invalid", completed: [], uncertain: [] });
		expect(machine.lines("op-calls.jsonl")).toEqual([]);
		expect(machine.lines("keychain-reads.jsonl")).toEqual([]);
		expect(stub.authorized).toEqual([]);

		const configured = await run(["auth", "configure", "mermaid", "--input", JSON.stringify({ item: ITEM_ID })]);
		expect(station(configured)).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["custody-registration"], uncertain: [] });
		expect(readFileSync(machine.registrationFile(), "utf8")).toBe(REGISTRATION_LITERAL);
		expect(statSync(machine.registrationFile()).mode & 0o777).toBe(0o600);
		expect((await run(["auth", "status", "mermaid"])).result.data).toEqual({ connector: "mermaid", registration: "registered", vault: "API Credentials", item: ITEM_ID, nextStep: "connectors auth check mermaid" });

		// The custody check reads the item once, in the Provider's preflight,
		// and starts no MCPorter or hosted request.
		const checked = await run(["auth", "check", "mermaid"]);
		expect({ code: checked.code, data: checked.result.data }).toEqual({ code: 0, data: { connector: "mermaid", custodyChecked: true, vault: "API Credentials", item: ITEM_ID } });
		expect(machine.lines("op-calls.jsonl")).toEqual([OP_READ]);
		expect(stub.authorized).toEqual([]);

		const read = await run(["run", "mermaid", "list_mermaid_chart_projects", "--input", JSON.stringify({ clientName: CLIENT })]);
		expect({ code: read.code, data: read.result.data }).toEqual({ code: 0, data: { connector: "mermaid", operation: "list_mermaid_chart_projects", tier: "account", result: [{ projectID: "proj-1", title: "Fixture project" }] } });
		expect(stub.calls).toEqual([{ name: "list_mermaid_chart_projects", arguments: { clientName: CLIENT } }]);
		// Every hosted request carried exactly the item's token.
		expect(stub.authorized.length).toBeGreaterThan(0);
		expect(stub.authorized.every(Boolean)).toBe(true);
		// Each op call's grandparent: the front door that ran each preflight,
		// then the selected MCPorter that started the Provider. MCPorter's own
		// argv and environment, read from the kernel, hold neither token.
		const frontDoor = realpathSync(path.join(machine.pluginRoot, "bin", "connectors"));
		const mcporter = realpathSync(path.join(machine.state, "connectors", "mcporter", "current", "mcporter"));
		const label = (executable: string) => (realpathSync(executable) === frontDoor ? "front-door" : realpathSync(executable) === mcporter ? "mcporter" : executable);
		expect(machine.lines<Record<string, unknown>>("op-parents.jsonl").map((row) => [label(row.grandparentExecutable as string), row.grandparentEnvironmentVisible, row.grandparentHoldsServiceToken, row.grandparentHoldsProviderToken])).toEqual([
			["front-door", true, false, false],
			["front-door", true, false, false],
			["mcporter", true, false, false],
		]);
		// The check, then the read's preflight and Provider: three item reads,
		// each by an internal Provider role holding neither token in its argv
		// or environment.
		expect(machine.lines("op-calls.jsonl")).toEqual([OP_READ, OP_READ, OP_READ]);
		expect(machine.lines<Record<string, unknown>>("op-parents.jsonl").map((parent) => [parent.parentRole, parent.parentEnvironmentVisible, parent.parentHoldsServiceToken, parent.parentHoldsProviderToken])).toEqual([
			[["__internal", "mermaid", "provider", "--preflight"], true, false, false],
			[["__internal", "mermaid", "provider", "--preflight"], true, false, false],
			[["__internal", "mermaid", "provider"], true, false, false],
		]);

		// A missing service token is a handoff, and no request leaves.
		machine.removeKeychainToken();
		const handoff = await run(["run", "mermaid", "get_mermaid_chart_diagram", "--input", JSON.stringify({ documentID: "doc-1", clientName: CLIENT })]);
		expect({ ...station(handoff), repair: handoff.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "service-token-missing", completed: [], uncertain: [], repair: KEYCHAIN_HANDOFF });
		expect(stub.calls).toHaveLength(1);

		expect((await run(["status", "mermaid"])).result.data?.connectors).toEqual([{ id: "mermaid", evidence: UNPROVEN_EVIDENCE }]);
	}, false);
}, 120_000);

test.skipIf(!OFFICIAL_MCPORTER)("writes apply only a fresh preview, once; an unknown effect blocks its object and settles only on found evidence", async () => {
	await withAccount(async ({ machine, stub, run }) => {
		const update = (title: string) => JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title, clientName: CLIENT });
		const preview = async (operation: string, input: string) => {
			const recorded = await run(["run", "mermaid", operation, "--input", input, "--preview"]);
			expect(station(recorded)).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["write-preview"], uncertain: [] });
			return recorded.result.data?.previewId as string;
		};
		const apply = (operation: string, input: string, previewId: string) => run(["run", "mermaid", operation, "--input", input, "--apply", previewId]);

		// A preview sends nothing; an apply with other input is refused unsent.
		const first = await preview("update_mermaid_chart_diagram", update("Renamed"));
		expect(writeCalls(stub)).toEqual([]);
		expect(station(await apply("update_mermaid_chart_diagram", update("Other"), first))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-input-mismatch", completed: [], uncertain: [] });
		const applied = await apply("update_mermaid_chart_diagram", update("Renamed"), first);
		expect(station(applied)).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null, completed: ["write-receipt", "provider-write"], uncertain: [] });
		expect(applied.result.data?.receipt).toMatchObject({ status: "completed", effects: [{ kind: "mermaid-diagram", id: "doc-1" }] });
		expect(station(await apply("update_mermaid_chart_diagram", update("Renamed"), first))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-consumed", completed: [], uncertain: [] });
		expect(writeCalls(stub)).toEqual([{ name: "update_mermaid_chart_diagram", arguments: JSON.parse(update("Renamed")) }]);

		// A diagram changed after its preview refuses the stale apply unsent.
		const stale = await preview("update_mermaid_chart_diagram", update("Stale"));
		(stub.diagrams[0] as { code: string }).code = "flowchart TD\n  X --> Y";
		expect(station(await apply("update_mermaid_chart_diagram", update("Stale"), stale))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-stale", completed: [], uncertain: [] });

		// A Provider refusal that left the diagram at its baseline is recorded
		// unchanged.
		const rejected = await preview("update_mermaid_chart_diagram", update("Rejected"));
		stub.mode = "reject-write";
		expect(station(await apply("update_mermaid_chart_diagram", update("Rejected"), rejected))).toEqual({ code: 3, cause: "DOMAIN_RUN_FAILED_RECORDED", connectorCause: "provider-refused", completed: ["write-receipt"], uncertain: [] });

		// A create whose reply is lost and whose effect is not yet visible is
		// unknown: never retried, and its object stays blocked.
		const create = JSON.stringify({ projectID: "proj-1", title: "Created", code: "flowchart LR\n  C --> D", clientName: CLIENT });
		const created = await preview("create_mermaid_chart_diagram", create);
		stub.mode = "lose-write";
		const unknown = await apply("create_mermaid_chart_diagram", create, created);
		expect(station(unknown)).toEqual({ code: 3, cause: "DOMAIN_RUN_EFFECT_UNKNOWN", connectorCause: null, completed: ["write-receipt"], uncertain: ["provider-write"] });
		const runId = unknown.result.data?.runId as string;
		expect(unknown.result.repairAction).toBe(`Do not retry the write. Run connectors recover mermaid --run ${runId} to inspect it, then settle it with connectors recover mermaid --run ${runId} --adjudicate --input and the identical input`);
		stub.mode = "normal";
		expect(station(await apply("create_mermaid_chart_diagram", create, created))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-consumed", completed: [], uncertain: [] });
		expect(station(await run(["run", "mermaid", "create_mermaid_chart_diagram", "--input", create, "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "object-blocked", completed: [], uncertain: [] });
		expect(writeCalls(stub).map((call) => call.name)).toEqual(["update_mermaid_chart_diagram", "update_mermaid_chart_diagram", "create_mermaid_chart_diagram"]);

		// Recovery lists it; adjudication with other input, or before the
		// effect is visible, settles nothing; once the delayed create lands,
		// adjudication with the identical input completes it on found evidence.
		expect(((await run(["recover", "mermaid"])).result.data?.receipts as { runId: string }[]).map((receipt) => receipt.runId)).toEqual([runId]);
		const other = JSON.stringify({ projectID: "proj-1", title: "Other", clientName: CLIENT });
		expect(station(await run(["recover", "mermaid", "--run", runId, "--adjudicate", "--input", other]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "adjudicate-input-mismatch", completed: [], uncertain: [] });
		expect(station(await run(["recover", "mermaid", "--run", runId, "--adjudicate", "--input", create]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "evidence-insufficient", completed: [], uncertain: [] });
		stub.landPending();
		const settled = await run(["recover", "mermaid", "--run", runId, "--adjudicate", "--input", create]);
		expect(station(settled)).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["write-adjudication"], uncertain: [] });
		expect(settled.result.data?.receipt).toMatchObject({ status: "completed", effects: [{ kind: "mermaid-diagram", id: "doc-2" }] });
		expect((await run(["recover", "mermaid"])).result.data?.receipts).toEqual([]);
		expect(writeCalls(stub)).toHaveLength(3);

		// Journal records hold identifiers and digests, never diagram content,
		// and a completed fixture write never promotes the live state.
		expect(machine.sweepText()).not.toContain("C --> D");
		expect((await run(["status", "mermaid"])).result.data?.connectors).toEqual([{ id: "mermaid", evidence: UNPROVEN_EVIDENCE }]);
	});
}, 180_000);

// The apply's own blocked-object guard, apart from the preview's: both
// previews exist before the first write turns unknown, so only the apply can
// refuse the second. Fails if an apply sends to an object whose earlier write
// is unresolved.
test.skipIf(!OFFICIAL_MCPORTER)("an apply refuses an object an earlier unresolved write blocks, sending nothing", async () => {
	await withAccount(async ({ stub, run }) => {
		const first = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title: "First", clientName: CLIENT });
		const second = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", code: "flowchart LR\n  S --> T", clientName: CLIENT });
		const previewIds: string[] = [];
		for (const input of [first, second]) {
			const recorded = await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--preview"]);
			expect(station(recorded)).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["write-preview"], uncertain: [] });
			previewIds.push(recorded.result.data?.previewId as string);
		}
		stub.mode = "lose-write";
		const unknown = await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", first, "--apply", previewIds[0] as string]);
		expect(station(unknown)).toEqual({ code: 3, cause: "DOMAIN_RUN_EFFECT_UNKNOWN", connectorCause: null, completed: ["write-receipt"], uncertain: ["provider-write"] });
		const runId = unknown.result.data?.runId as string;

		// A Provider that would accept the second write, so only the guard stops it.
		stub.mode = "normal";
		const blocked = await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", second, "--apply", previewIds[1] as string]);
		expect({ ...station(blocked), repair: blocked.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "object-blocked", completed: [], uncertain: [], repair: `an earlier write to this object has an unresolved receipt; run connectors recover mermaid --run ${runId}` });
		expect(writeCalls(stub)).toEqual([{ name: "update_mermaid_chart_diagram", arguments: JSON.parse(first) }]);
		expect(((await run(["recover", "mermaid"])).result.data?.receipts as { runId: string }[]).map((receipt) => receipt.runId)).toEqual([runId]);
	});
}, 120_000);

test.skipIf(!OFFICIAL_MCPORTER)("two concurrent applies of one preview make exactly one write and one refusal", async () => {
	await withAccount(async ({ machine, stub, run }) => {
		const input = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", code: "flowchart LR\n  P --> Q", clientName: CLIENT });
		const previewId = (await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--preview"])).result.data?.previewId as string;
		const racers = await Promise.all([0, 1].map(() => machine.run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--apply", previewId])));
		const causes = racers.map((racer) => {
			const result = (JSON.parse(racer.stdout) as Envelope).result;
			return result.data?.connectorCause ? `${result.causeCode}:${result.data.connectorCause}` : result.causeCode;
		});
		expect(causes.filter((cause) => cause === "SUCCESS_RUN_APPLIED")).toHaveLength(1);
		expect(causes.filter((cause) => cause !== "SUCCESS_RUN_APPLIED")).toHaveLength(1);
		const loser = causes.find((cause) => cause !== "SUCCESS_RUN_APPLIED") ?? "";
		expect(["DOMAIN_ADAPTER_REFUSED:write-locked", "DOMAIN_ADAPTER_REFUSED:preview-consumed"]).toContain(loser);
		for (const racer of racers) expect(racer.stderr).toBe("");
		expect(writeCalls(stub)).toHaveLength(1);
	});
}, 120_000);

// A stale lock with no receipt: the apply died holding the lock while its
// own read was in flight, so nothing was sent and no receipt names the lock.
// Fails if the only unlock route needs a receipt, or if the recovered
// preview sends more than once.
test.skipIf(!OFFICIAL_MCPORTER)("an apply killed before its receipt leaves a lock its preview ID releases; the preview then applies once", async () => {
	await withAccount(async ({ machine, stub, run }) => {
		const input = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title: "Recovered", clientName: CLIENT });
		const previewId = (await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--preview"])).result.data?.previewId as string;
		const read = stub.hold("get_mermaid_chart_diagram");
		const apply = machine.start(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--apply", previewId]);
		await read.reached;
		apply.kill();
		await apply.exited;
		read.release();

		// The dead apply's lock, and nothing else: no receipt, no write.
		const locks = path.join(machine.journalDirectory(), "locks");
		expect(readdirSync(locks).map((name) => JSON.parse(readFileSync(path.join(locks, name), "utf8")))).toEqual([{ pid: apply.pid }]);
		expect(readdirSync(path.join(machine.journalDirectory(), "receipts"))).toEqual([]);
		expect(await openReceipts(run)).toEqual([]);
		const locked = await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--apply", previewId]);
		expect({ ...station(locked), repair: locked.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "write-locked", completed: [], uncertain: [], repair: `another apply holds this object's lock; if no apply is running, release it with connectors recover mermaid --run ${previewId} --unlock, then apply again` });

		const unlocked = await run(["recover", "mermaid", "--run", previewId, "--unlock"]);
		expect({ ...station(unlocked), data: unlocked.result.data }).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["write-unlock"], uncertain: [], data: { connector: "mermaid", previewId, unlocked: true } });
		expect(readdirSync(locks)).toEqual([]);
		expect(station(await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--apply", previewId]))).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null, completed: ["write-receipt", "provider-write"], uncertain: [] });
		expect(writeCalls(stub)).toEqual([{ name: "update_mermaid_chart_diagram", arguments: JSON.parse(input) }]);
		expect(stub.diagrams[0]?.title).toBe("Recovered");
	});
}, 120_000);

// The write's own Provider preflight (an op read) is held, then the apply is
// killed: the request never left. Fails if the receipt is already durable as
// sending, which no adjudication can ever settle, blocking the object.
test.skipIf(!OFFICIAL_MCPORTER)("an apply killed in its write's Provider preflight leaves no open receipt, so its object is not blocked", async () => {
	await withAccount(async ({ machine, stub, run }) => {
		const input = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title: "Preflight", clientName: CLIENT });
		const previewId = (await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--preview"])).result.data?.previewId as string;
		// Hold the apply's own read, gate op behind it, then let the read finish:
		// the next op call is the write's preflight.
		const read = stub.hold("get_mermaid_chart_diagram");
		const apply = machine.start(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--apply", previewId]);
		await read.reached;
		const preflight = machine.holdOpCalls();
		read.release();
		await preflight.reader();
		apply.kill();
		await apply.exited;
		preflight.release();

		expect(writeCalls(stub)).toEqual([]);
		expect(readdirSync(path.join(machine.journalDirectory(), "receipts"))).toEqual([]);
		expect(await openReceipts(run)).toEqual([]);
		expect(station(await run(["recover", "mermaid", "--run", previewId, "--unlock"]))).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["write-unlock"], uncertain: [] });
		expect(station(await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--apply", previewId]))).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null, completed: ["write-receipt", "provider-write"], uncertain: [] });
		expect(writeCalls(stub)).toEqual([{ name: "update_mermaid_chart_diagram", arguments: JSON.parse(input) }]);
		expect(stub.diagrams[0]?.title).toBe("Preflight");
	});
}, 120_000);

// An open receipt that cannot be read or trusted may hide an unknown effect
// on any object, so every write, preview, and recovery refuses until it is
// restored, with a fixed repair that never echoes state-controlled names.
// Fails if the journal skips it (including under a renamed file) and a
// second write is sent, or if a refusal repeats the renamed file's name.
test.skipIf(!OFFICIAL_MCPORTER)("an unreadable or malformed receipt fails closed: nothing writes, previews, or recovers past it", async () => {
	await withAccount(async ({ machine, stub, run, outputs }) => {
		const first = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title: "First", clientName: CLIENT });
		const second = JSON.stringify({ documentID: "doc-1", projectID: "proj-1", title: "Second", clientName: CLIENT });
		const elsewhere = JSON.stringify({ projectID: "proj-1", title: "Elsewhere", clientName: CLIENT });
		const previewIds: string[] = [];
		for (const input of [first, second]) previewIds.push((await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", input, "--preview"])).result.data?.previewId as string);
		stub.mode = "lose-write";
		const runId = (await run(["run", "mermaid", "update_mermaid_chart_diagram", "--input", first, "--apply", previewIds[0] as string])).result.data?.runId as string;
		stub.mode = "normal";
		const receipt = path.join(machine.journalDirectory(), "receipts", `${runId}.json`);
		const original = readFileSync(receipt, "utf8");
		expect(JSON.parse(original)).toMatchObject({ runId, status: "unknown" });
		const corrupt = { code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "journal-corrupt", completed: [], uncertain: [], repair: "a Mermaid write receipt is unreadable, malformed, or misnamed, so no write can prove its object is clear; restore it in the Mermaid journal's receipts directory as <runId>.json, an owner-only (0600) file holding its recorded JSON, then run connectors recover mermaid" };
		// A state-controlled name: secret-shaped, with a newline.
		const renamed = path.join(path.dirname(receipt), `${RENAMED_SENTINEL}\n.json`);
		const corruptions: [string, () => void][] = [
			["owner-only mode lost", () => chmodSync(receipt, 0o644)],
			["truncated", () => writeFileSync(receipt, original.slice(0, 40))],
			["status outside the closed set", () => writeFileSync(receipt, original.replace('"status":"unknown"', '"status":"resolved"'))],
			["renamed to a secret-shaped name", () => renameSync(receipt, renamed)],
		];
		for (const [label, corruptReceipt] of corruptions) {
			corruptReceipt();
			for (const argv of [
				["run", "mermaid", "update_mermaid_chart_diagram", "--input", second, "--apply", previewIds[1] as string],
				["run", "mermaid", "create_mermaid_chart_diagram", "--input", elsewhere, "--preview"],
				["recover", "mermaid"],
				["recover", "mermaid", "--run", runId, "--adjudicate", "--input", first],
			]) {
				const refused = await run(argv);
				expect({ label, argv, ...station(refused), repair: refused.result.repairAction }).toEqual({ label, argv, ...corrupt });
			}
			if (label.startsWith("renamed")) renameSync(renamed, receipt);
			writeFileSync(receipt, original);
			chmodSync(receipt, 0o600);
		}
		for (const surface of outputs) expect(surface).not.toContain(RENAMED_SENTINEL);
		// Only the first write left; restored, the receipt blocks and lists again.
		expect(writeCalls(stub)).toEqual([{ name: "update_mermaid_chart_diagram", arguments: JSON.parse(first) }]);
		expect(await openReceipts(run)).toEqual([runId]);
	});
}, 180_000);
