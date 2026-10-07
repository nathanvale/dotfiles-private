import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DENY_NETWORK, heldMcporter, ownedVault } from "../../../tests/fixtures/native-oauth.ts";
import { createBundle, runBundle, PLUGIN_ROOT, createHarness, runInteractiveBundle } from "../../../tests/harness.ts";
import { afterCall, writeInput } from "../scripts/catalogue.ts";
import { openJournal } from "../scripts/journal.ts";
import { notionCaller, type Caller } from "../scripts/transport.ts";
import { adjudicate, applyWrite, previewWrite } from "../scripts/writes.ts";
import { notionMachine } from "./fixtures/notion-machine.ts";

// Independent live-schema oracle observed on 6 October 2026. It is deliberately
// not imported from the connector catalogue or registry under test.
const READS = ["notion-search", "notion-ai-search", "notion-get-tool-access", "notion-fetch", "notion-download-attachment", "notion-download-skill", "notion-get-comments", "notion-get-async-task", "notion-get-teams", "notion-get-users", "notion-query-data-sources", "notion-query-multiple-data-sources", "notion-query-meeting-notes", "notion-list-private-pages", "notion-list-shared-pages", "notion-list-favorite-pages", "notion-list-recent-pages", "notion-search-agents", "notion-search-sessions", "notion-query-sessions", "notion-get-session-status", "notion-wait-session", "notion-list-session-events", "notion-read-session-event", "notion-show-advanced-analysis-next-steps", "notion-check-mcp-next-steps"];
const WRITES = ["notion-create-attachment", "notion-create-file-upload", "notion-create-pages", "notion-update-page", "notion-convert-page-to-skill", "notion-upload-skill", "notion-move-pages", "notion-restore-pages", "notion-duplicate-page", "notion-create-database", "notion-create-folder", "notion-update-folder", "notion-update-data-source", "notion-create-comment", "notion-spawn-session", "notion-stop-session", "notion-send-message-to-session", "notion-create-view", "notion-update-view"];
const TOOLS = [...READS, ...WRITES].sort();
const SELECT = ["--select", "account=personal"];
const input = (value: unknown) => ["--input", JSON.stringify(value)];
const write = (value = "Requested value") => ({ page_id: "page-1", command: "replace_content", new_str: value, _verify: { before: { tool: "notion-fetch", args: { id: "page-1" } }, after: { tool: "notion-fetch", args: { id: "page-1" } }, contains: [value] } });

test("packaged Notion lists the complete 45-tool route and refuses an unjournaled write before creating state", async () => {
	const bundle = createBundle();const home = path.join(bundle.root, "home");mkdirSync(home);
	cpSync(path.join(PLUGIN_ROOT, "skills/notion/config"), path.join(bundle.skillsRoot, "notion/config"), { recursive: true });
	const run = (argv: string[]) => runBundle(bundle, argv, { home, extraEnv: { XDG_STATE_HOME: path.join(bundle.root, "state") } });
	try {
		const shown = await run(["config", "show", "notion", "--resolved", "--json", ...SELECT]);
		expect(shown.code).toBe(0);expect(shown.stderr).toBe("");
		const registry = JSON.parse(readFileSync(path.join(bundle.skillsRoot, "notion/config/mcporter.json"), "utf8"));
		expect([READS.length, WRITES.length, TOOLS.length]).toEqual([26, 19, 45]);
		expect(registry.imports).toEqual([]);expect(registry.mcpServers["notion-connectors"].allowedTools.sort()).toEqual(TOOLS);
		for (const operation of WRITES) {
			const result = await run(["run", "notion", ...SELECT, operation, ...input({ secret: "SENTINEL_REFUSAL_VALUE" })]);
			expect([result.code, result.stderr]).toEqual([2, ""]);expect(result.stdout).not.toContain("SENTINEL_REFUSAL_VALUE");expect(JSON.parse(result.stdout).result.data.connectorCause).toBe("write-phase-required");
		}
		const missingIds = await run(["run", "notion", ...SELECT, "notion-restore-pages", ...input({ _verify: write()._verify }), "--preview"]);
		expect([missingIds.code, missingIds.stderr, JSON.parse(missingIds.stdout).result.data.connectorCause]).toEqual([4, "", "input-invalid"]);
		expect(existsSync(path.join(bundle.root, "state"))).toBe(false);
		const status = await run(["auth", "status", "notion", ...SELECT]);expect(JSON.parse(status.stdout).result.data).toMatchObject({ account: "personal", grant: "absent" });
		for (const flags of [[], ["--no-browser", "--reset"]]) {
			const login = await run(["auth", "login", "notion", ...SELECT, ...flags]);
			expect([login.code, login.stderr, JSON.parse(login.stdout).result.causeCode]).toEqual([3, "", "DOMAIN_ATTENDED_REQUIRED"]);
		}
	} finally { bundle.dispose(); }
});

test("the public transport refuses Notion so no call can use the caller's HOME grant", async () => {
	const harness = createHarness({});try { const result = await harness.run(["notion", "--select", "account=personal", "--", "call", "notion-fetch"]);expect(result.code).toBe(3);expect(result.stderr).toContain("dispatcher-owned");expect(harness.has("mcporter.json")).toBe(false); } finally { harness.dispose(); }
});

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for Notion packaged process proof");

test.skipIf(!official)("compiled Notion routes every admitted read and preserves raw transcript arguments", async () => {
	const machine = notionMachine(TOOLS);try {
		for (const operation of READS) {
			const result = await machine.run(["run", "notion", ...SELECT, operation, ...input({ id: "page-1", include_transcript: true })]);
			expect([operation, result.code, result.stderr]).toEqual([operation, 0, ""]);expect(result.stdout).not.toContain("SENTINEL_AMBIENT_NOTION");
		}
		expect(machine.calls.map((call) => call.tool)).toEqual(READS);
		expect(machine.calls.find((call) => call.tool === "notion-fetch")?.args).toEqual({ id: "page-1", include_transcript: true });
		const vault = path.join(machine.state, "connectors/notion-mcporter/personal/data/mcporter/credentials.json");expect(existsSync(vault)).toBe(true);expect(existsSync(path.join(machine.home, ".mcporter/credentials.json"))).toBe(false);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("previewed Notion writes send once with identical input, and read-back must confirm the change", async () => {
	const machine = notionMachine(TOOLS);try {
		const value = write();
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);expect(preview.code).toBe(0);const id = preview.envelope.result.data?.previewId as string;
		const mismatch = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(write("Different value")), "--apply", id]);expect(mismatch.code).toBe(3);expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(0);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", id]);expect([applied.code, applied.stderr]).toEqual([0, ""]);expect(applied.envelope.result.data?.receipt?.status).toBe("completed");
		expect(machine.calls.filter((call) => call.tool === "notion-update-page").map((call) => call.args)).toEqual([{ page_id: "page-1", command: "replace_content", new_str: "Requested value" }]);
		const again = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", id]);expect([again.code, again.envelope.result.data?.connectorCause]).toEqual([3, "preview-consumed"]);
		machine.setText("Original page");machine.setSilent(true);
		const p = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const unknown = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", p.envelope.result.data?.previewId as string]);expect(unknown.envelope.result.transactionState).toBe("unknown");
		const blocked = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);expect(blocked.code).toBe(3);
		machine.setText("Requested value");
		const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", unknown.envelope.result.data?.runId as string, "--adjudicate", ...input(value)]);expect(recovered.code).toBe(0);expect(recovered.envelope.result.data?.receipt?.status).toBe("completed");
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("pending async Notion work recovers through task status without replaying the write", async () => {
	const machine = notionMachine(TOOLS);try {
		const value = { ...write(), _verify: { ...write()._verify, after: { tool: "notion-fetch", args: { id: "$reply.pages.0.id" } } } };
		machine.setPending(true);
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", preview.envelope.result.data?.previewId as string]);
		expect(applied.envelope.result.transactionState).toBe("unknown");
		machine.setPending(false);machine.setText("Requested value");
		const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", applied.envelope.result.data?.runId as string, "--adjudicate", ...input(value)]);
		expect(recovered.code).toBe(0);expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
		expect(machine.calls.filter((call) => call.tool === "notion-get-async-task").map((call) => call.args)).toEqual([{ task_id: "task-1" }, { task_id: "task-1" }]);
		expect(machine.calls.at(-1)).toEqual({ tool: "notion-fetch", args: { id: "created-page" } });
	} finally { machine.dispose(); }
}, 180000);


test.skipIf(!official)("terminal Notion rejection proves unchanged while partial errors stay unknown", async () => {
	const machine = notionMachine(TOOLS);
	try {
		const value = write();
		machine.setFailure("tool-error");
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const result = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect([result.code, result.stderr, result.envelope.result.data?.receipt?.status]).toEqual([3, "", "unchanged"]);
		// Fails if an unchanged rejection leaves its preview reusable.
		const reused = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect([reused.code, reused.stderr, reused.envelope.result.data?.connectorCause]).toEqual([3, "", "preview-consumed"]);
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
		machine.setFailure("partial-error");
		const next = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const partial = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(next.envelope.result.data?.previewId)]);
		expect(partial.envelope.result.transactionState).toBe("unknown");
		const receiptFile = path.join(machine.state, "connectors/notion/personal/journal/receipts", `${partial.envelope.result.data?.runId}.json`);
		expect(JSON.parse(readFileSync(receiptFile, "utf8")).terminalFailure).toBe("tool-error");
		machine.setText("Original page");
		const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", String(partial.envelope.result.data?.runId), "--adjudicate", ...input(value)]);
		expect([recovered.code, recovered.stderr, recovered.envelope.result.data?.receipt?.status]).toEqual([0, "", "unchanged"]);
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(2);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("Notion removal evidence verifies absence and fixed after reads reject preexisting or stale text", async () => {
	const machine = notionMachine(TOOLS);
	try {
		const value = { ...write("Replacement"), _verify: { before: write()._verify.before, after: write()._verify.after, absent: ["Original page"] } };
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		expect(preview.code).toBe(0);
		const result = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect(result.envelope.result.data?.receipt?.status).toBe("completed");
		machine.setText("Original page");machine.setObject("sibling", "Requested value");
		const unrelated = { ...write(), _verify: { ...write()._verify, after: { tool: "notion-fetch", args: { id: "sibling" } } } };
		const refused = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(unrelated), "--preview"]);
		expect(refused.envelope.result.data?.connectorCause).toBe("already-present");
		machine.setObject("sibling", "Unrelated original");
		const fresh = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(unrelated), "--preview"]);
		machine.setObject("sibling", "Unrelated changed");
		const stale = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(unrelated), "--apply", String(fresh.envelope.result.data?.previewId)]);
		expect(stale.envelope.result.data?.connectorCause).toBe("preview-stale");
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
	} finally { machine.dispose(); }
}, 180000);


test.skipIf(!official)("Notion prepared handles complete only preparation and permit the next real write without persisting grants", async () => {
	const machine = notionMachine(TOOLS);
	try {
		const verification = { before: { tool: "notion-fetch", args: { id: "page-1" } }, reply: "prepared-handle" };
		const preparations = [
			{ operation: "notion-create-file-upload", args: { filename: "report.pdf" } },
			{ operation: "notion-create-attachment", args: { filename: "notes.md", content: "Private notes" } },
			{ operation: "notion-upload-skill", args: { action: "prepare", page_id: "page-1", content_length: 123, checksum_crc32: "AAAAAA==" } },
		];
		for (const preparation of preparations) {
			const value = { ...preparation.args, _verify: verification };
			const preview = await machine.run(["run", "notion", ...SELECT, preparation.operation, ...input(value), "--preview"]);
			expect(preview.code).toBe(0);
			const applied = await machine.run(["run", "notion", ...SELECT, preparation.operation, ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
			expect([applied.code, applied.stderr, applied.envelope.result.data?.receipt?.status, applied.envelope.result.data?.verifiedEffect]).toEqual([0, "", "completed", "prepared-handle"]);
			const durable = readFileSync(path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`), "utf8");
			expect(durable).not.toContain("SENTINEL_");expect(durable).not.toContain("upload.example.test");expect(durable).not.toContain("Private notes");
		}
		const value = write("Attached page content");
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect(applied.envelope.result.data?.receipt?.status).toBe("completed");
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("Notion failed wrapped async tasks settle unchanged and persist the terminal task identity", async () => {
	const machine = notionMachine(TOOLS);
	try {
		machine.setFailure("task-failed");
		const value = write();
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect([applied.code, applied.stderr, applied.envelope.result.data?.receipt?.status, applied.envelope.result.data?.connectorCause]).toEqual([3, "", "unchanged", "task-failed"]);
		const durable = JSON.parse(readFileSync(path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`), "utf8"));
		expect(durable).toMatchObject({ taskId: "task-1", taskState: "failed", terminalFailure: "task-failed", status: "unchanged" });
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("Notion missing reply references nested in arrays refuse readback and keep the write unknown", async () => {
	const machine = notionMachine(TOOLS);
	try {
		const value = { ...write(), _verify: { ...write()._verify, after: { tool: "notion-fetch", args: { filter: { ids: ["$reply.missing.id"] } } } } };
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect(applied.envelope.result.transactionState).toBe("unknown");
		expect(machine.calls.at(-1)?.tool).toBe("notion-update-page");
		const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", String(applied.envelope.result.data?.runId), "--adjudicate", ...input(value)]);
		expect(recovered.envelope.result.data?.connectorCause).toBe("evidence-insufficient");
		expect(machine.calls.at(-1)?.tool).toBe("notion-update-page");
	} finally { machine.dispose(); }
}, 180000);


test.skipIf(!official)("Notion transport failures remain unknown on matching baselines and never replay during recovery", async () => {
	const machine = notionMachine(TOOLS);
	try {
		machine.setFailure("transport-error");
		const value = write();
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect([applied.code, applied.stderr, applied.envelope.result.transactionState]).toEqual([3, "", "unknown"]);
		const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", String(applied.envelope.result.data?.runId), "--adjudicate", ...input(value)]);
		expect(recovered.envelope.result.data?.connectorCause).toBe("evidence-insufficient");
		const durable = JSON.parse(readFileSync(path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`), "utf8"));
		expect(durable).toMatchObject({ status: "unknown", replied: false, terminalFailure: null });
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
	} finally { machine.dispose(); }
}, 180000);

// Supporting transport proof: an executable disappearing between selection and
// synchronous spawn is not a controllable hosted MCP response. The packaged
// transport-failure test above owns the public-envelope claim.
test("a Notion spawn exception after durable intent remains unknown without recovery replay", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");mkdirSync(home);
	const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(bundle.root, "state") };
	const transport = notionCaller(env, path.join(PLUGIN_ROOT, "skills"), "personal", { async selectMcporter() { return path.join(bundle.root, "missing-mcporter"); }, internalCommand() { return []; } });
	const caller: Caller = { prepare: transport.prepare, async call() { return { ok: true, data: { text: "Original page" } }; } };
	try {
		const intent = writeInput("notion-update-page", write());
		const journal = openJournal(env, "personal");
		if (intent === null || journal === null) throw new Error("test precondition failed");
		const preview = await previewWrite(intent, caller, journal, "personal");
		if (preview.kind !== "recorded" || typeof preview.data.previewId !== "string") throw new Error("preview missing");
		const applied = await applyWrite(intent, preview.data.previewId, caller, journal, "personal");
		expect(applied.kind).toBe("effect-unknown");
		const scan = journal.receipts();
		if (!scan.ok) throw new Error("journal scan failed");
		expect(scan.receipts).toHaveLength(1);
		const receipt = scan.receipts[0];
		if (receipt === undefined) throw new Error("receipt missing");
		expect(receipt).toMatchObject({ status: "unknown", replied: false, terminalFailure: null });
		const recovered = await adjudicate(intent, receipt, caller, journal);
		expect(recovered).toMatchObject({ kind: "refused", refusal: { connectorCause: "evidence-insufficient" } });
	} finally { bundle.dispose(); }
});


test.skipIf(!official)("Notion spawned session URLs reach status verification as stable entity handles", async () => {
	const machine = notionMachine(TOOLS);
	try {
		const value = { agent_url: "agent://space-1/agent-1", initial_message: "Requested value", _verify: { before: { tool: "notion-get-session-status", args: { session_url: "session://space-1/baseline-session" } }, after: { tool: "notion-get-session-status", args: { session_url: "$reply.session_url" } }, contains: ["Requested value"] } };
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-spawn-session", ...input(value), "--preview"]);
		expect(preview.code).toBe(0);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-spawn-session", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect([applied.code, applied.stderr, applied.envelope.result.data?.receipt?.status]).toEqual([0, "", "completed"]);
		expect(machine.calls.at(-1)).toEqual({ tool: "notion-get-session-status", args: { session_url: "session://space-1/session-1" } });
		const durable = JSON.parse(readFileSync(path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`), "utf8"));
		expect(durable.readBack).toEqual({ tool: "notion-get-session-status", args: { session_url: "session://space-1/session-1" } });
	} finally { machine.dispose(); }
}, 180000);

// Supporting pure-contract proof supplements the packaged session workflow.
// Each literal is an independent allowed entity or forbidden grant specimen.
test("Notion reply references accept stable entities and reject nested credentials or signed URLs", () => {
	const intent = writeInput("notion-update-page", { ...write(), _verify: { ...write()._verify, after: { tool: "notion-fetch", args: { id: "$reply.result" } } } });
	if (intent === null) throw new Error("test intent missing");
	const safe = ["https://notion.so/Entity-0123456789abcdef0123456789abcdef", "https://www.notion.so/0123456789abcdef0123456789abcdef?pvs=4", "notion://page/page-1", "collection://data-source-1", "view://view-1", "session://space-1/session-1", "thread://session-1"];
	for (const value of safe) expect(afterCall(intent, { result: value })).toEqual({ tool: "notion-fetch", args: { id: value } });
	const unsafe = [
		{ nested: [{ upload_url: "https://upload.example.test/file?signature=SENTINEL_GRANT" }] },
		{ nested: [{ upload_headers: { Authorization: "SENTINEL_HEADER" } }] },
		{ nested: [{ upload_token: "SENTINEL_TOKEN" }] },
		["https://notion.so/0123456789abcdef0123456789abcdef?token=SENTINEL_TOKEN"],
		"https://user:SENTINEL_TOKEN@notion.so/0123456789abcdef0123456789abcdef",
		"https://notion.so/signed/file?signature=SENTINEL_GRANT",
		"https://notion.so/download/file",
		"https://notion.so.evil.test/0123456789abcdef0123456789abcdef",
		"https://upload.example.test/file",
		"  https://upload.example.test/file?signature=SENTINEL_GRANT  ",
	];
	for (const value of unsafe) expect(afterCall(intent, { result: value })).toBeNull();
});


for (const failure of ["delayed-response", "post-send-drop"] as const) {
	test.skipIf(!official)(`Notion ${failure} after send remains unknown and blocks replay on matching baselines`, async () => {
		const machine = notionMachine(TOOLS);
		try {
			machine.setFailure(failure);
			const value = write();
			const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
			expect(preview.code).toBe(0);
			const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
			expect([applied.code, applied.stderr, applied.envelope.result.transactionState]).toEqual([3, "", "unknown"]);
			const receiptFile = path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`);
			expect(JSON.parse(readFileSync(receiptFile, "utf8"))).toMatchObject({ status: "unknown", replied: false, terminalFailure: null });
			const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", String(applied.envelope.result.data?.runId), "--adjudicate", ...input(value)]);
			expect(recovered.envelope.result.data?.connectorCause).toBe("evidence-insufficient");
			const blocked = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
			expect(blocked.envelope.result.data?.connectorCause).toBe("account-write-blocked");
			expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
			if (failure === "delayed-response") {
				machine.releaseDelayed();
				const completed = await machine.run(["recover", "notion", ...SELECT, "--run", String(applied.envelope.result.data?.runId), "--adjudicate", ...input(value)]);
				expect([completed.code, completed.stderr, completed.envelope.result.data?.receipt?.status]).toEqual([0, "", "completed"]);
				expect(JSON.parse(readFileSync(receiptFile, "utf8"))).toMatchObject({ status: "completed", replied: false, terminalFailure: null });
				expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
			}
		} finally { machine.dispose(); }
	}, 180000);
}


// Supporting output-contract proof isolates unknown valid JSON from MCPorter's
// positively observed validation error. The packaged delayed-response and
// post-send-drop tests above own the real provider transport and envelope.
// Its one executable is written and first run at load, so the host's one-time
// first-exec assessment stays outside the test budget; each case changes only
// the data the executable prints.
const outputRoot = mkdtempSync(path.join(os.tmpdir(), "connectors-notion-output-"));
const output = path.join(outputRoot, "output.json");
const binary = path.join(outputRoot, "output-fixture");
writeFileSync(output, "{}\n");
writeFileSync(binary, `#!/bin/sh\n/bin/cat '${output}'\nexit 1\n`, { mode: 0o700 });
Bun.spawnSync([binary], { stdout: "ignore", stderr: "ignore" });
afterAll(() => rmSync(outputRoot, { recursive: true, force: true }));
test("Notion nonzero JSON without positive tool-error evidence remains indeterminate", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");mkdirSync(home);
	const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(bundle.root, "state") };
	const caller = notionCaller(env, path.join(PLUGIN_ROOT, "skills"), "personal", { async selectMcporter() { return binary; }, internalCommand() { return []; } });
	try {
		const indeterminate = [
			{ server: "fixture", tool: "notion-update-page", error: "reply deadline" },
			{ message: "lost reply" },
			{ isError: true },
			{ isError: true, content: [{ type: "text", text: "provider timed out" }] },
			{ isError: true, content: [{ type: "text", text: JSON.stringify({ status: 504, code: "request_timeout", message: "provider timeout" }) }] },
			{ isError: true, structuredContent: { status: 500, code: "internal_server_error", message: "provider internal failure" } },
			{ isError: true, content: [{ type: "text", text: JSON.stringify({ message: "provider failure" }) }] },
		];
		for (const data of indeterminate) {
			writeFileSync(output, `${JSON.stringify(data)}\n`);
			expect(await caller.call({ tool: "notion-update-page", args: {} })).toEqual({ ok: false, sent: true, cause: "transport-failed" });
		}
		const validation = { status: 400, code: "validation_error", message: "fixture validation rejection" };
		const qualified = [validation, { isError: true, structuredContent: validation }, { isError: true, content: [{ type: "text", text: JSON.stringify(validation) }] }];
		for (const data of qualified) {
			writeFileSync(output, `${JSON.stringify(data)}\n`);
			expect(await caller.call({ tool: "notion-update-page", args: {} })).toEqual({ ok: false, sent: true, cause: "tool-error", data });
		}
	} finally { bundle.dispose(); }
});


// Regression oracles use literal refusal causes and independently read files.
// An accepted unsafe argument, leaked provider reply, or erased bound target
// makes these public-process checks fail.
test("Notion verification refuses malformed declarations and fixed capabilities before effects", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(home);
	cpSync(path.join(PLUGIN_ROOT, "skills/notion/config"), path.join(bundle.skillsRoot, "notion/config"), { recursive: true });
	const before = { tool: "notion-fetch", args: { id: "page-1" } };
	const after = { tool: "notion-fetch", args: { id: "page-1" } };
	const declarations = [
		{ before: { tool: "notion-update-page", args: { page_id: "page-1" } }, after, contains: ["Requested value"] },
		{ before, after: { tool: "notion-update-page", args: { page_id: "page-1" } }, contains: ["Requested value"] },
		{ before, after, contains: [] },
		{ before, after, contains: [""] },
		{ before, after, contains: ["   "] },
		{ before, after, contains: "Requested value" },
		{ before, after, absent: [17] },
		{ before: { tool: "notion-fetch", args: { id: "$reply.page_id" } }, after, contains: ["Requested value"] },
		{ before, reply: "prepared-handle" },
		{ before, after, contains: ["Requested value"], reply: "prepared-handle" },
		{ before, after: { tool: "notion-fetch", args: { id: "https://upload.example.test/file?signature=SENTINEL_FIXED_GRANT" } }, contains: ["Requested value"] },
		{ before, after: { tool: "notion-fetch", args: { filter: { nested: [{ Authorization: "SENTINEL_FIXED_HEADER" }] } } }, contains: ["Requested value"] },
		{ before, after: { tool: "notion-fetch", args: { id: "page-1", token: "SENTINEL_FIXED_TOKEN" } }, contains: ["Requested value"] },
	];
	try {
		for (const declaration of declarations) {
			const value = { ...write(), _verify: declaration };
			const result = await runBundle(bundle, ["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"], { home, extraEnv: { XDG_STATE_HOME: state } });
			expect([result.code, result.stderr, JSON.parse(result.stdout).result.data?.connectorCause]).toEqual([4, "", "input-invalid"]);
			expect(result.stdout).not.toContain("SENTINEL_FIXED");
			expect(existsSync(state)).toBe(false);
		}
	} finally { bundle.dispose(); }
}, 180000);

test.skipIf(!official)("Notion malformed prepared handle stays unknown without exposing raw capability replies", async () => {
	const machine = notionMachine(TOOLS);
	try {
		machine.setMutationReply({ upload_url: "https://upload.example.test/file?signature=SENTINEL_UNKNOWN_GRANT", upload_token: "SENTINEL_UNKNOWN_TOKEN" });
		const value = { filename: "report.pdf", _verify: { before: { tool: "notion-fetch", args: { id: "page-1" } }, reply: "prepared-handle" } };
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-create-file-upload", ...input(value), "--preview"]);
		expect(preview.code).toBe(0);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-create-file-upload", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect([applied.code, applied.stderr, applied.envelope.result.transactionState]).toEqual([3, "", "unknown"]);
		expect(applied.stdout).not.toContain("SENTINEL_UNKNOWN");
		expect(applied.stdout).not.toContain("upload.example.test");
		expect(applied.envelope.result.data).not.toHaveProperty("reply");
		const durable = readFileSync(path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`), "utf8");
		expect(durable).not.toContain("SENTINEL_UNKNOWN");
		expect(durable).not.toContain("upload.example.test");
		expect(JSON.parse(durable).status).toBe("unknown");
		expect(machine.calls.filter((call) => call.tool === "notion-create-file-upload")).toHaveLength(1);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("Notion successful task preserves an earlier bound readback when its result omits the reference", async () => {
	const machine = notionMachine(TOOLS);
	try {
		machine.setPending(true);
		machine.setMutationReply({ async_task: { task_id: "task-1" }, pages: [{ id: "created-page" }] });
		machine.setTaskResult({ finished: true });
		const value = { ...write(), _verify: { ...write()._verify, after: { tool: "notion-fetch", args: { id: "$reply.pages.0.id" } } } };
		const preview = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--preview"]);
		expect(preview.code).toBe(0);
		const applied = await machine.run(["run", "notion", ...SELECT, "notion-update-page", ...input(value), "--apply", String(preview.envelope.result.data?.previewId)]);
		expect(applied.envelope.result.transactionState).toBe("unknown");
		machine.setPending(false);
		machine.setText("Requested value");
		const recovered = await machine.run(["recover", "notion", ...SELECT, "--run", String(applied.envelope.result.data?.runId), "--adjudicate", ...input(value)]);
		expect([recovered.code, recovered.stderr, recovered.envelope.result.data?.receipt?.status]).toEqual([0, "", "completed"]);
		const durable = JSON.parse(readFileSync(path.join(machine.state, "connectors/notion/personal/journal/receipts", `${applied.envelope.result.data?.runId}.json`), "utf8"));
		expect(durable.readBack).toEqual({ tool: "notion-fetch", args: { id: "created-page" } });
		expect(machine.calls.at(-1)).toEqual({ tool: "notion-fetch", args: { id: "created-page" } });
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toHaveLength(1);
	} finally { machine.dispose(); }
}, 180000);


// Hosted registry, native pinned MCPorter, fixture-only empty vaults, and
// denied outbound network prove the attended process handoff without OAuth.
test.skipIf(!official)("Notion attended login forwards native auth flags inside only its selected account vault", async () => {
	if (official === undefined) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for Notion attended process proof");
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(home);
	cpSync(path.join(PLUGIN_ROOT, "skills/notion/config"), path.join(bundle.skillsRoot, "notion/config"), { recursive: true });
	const other = ownedVault(path.join(state, "connectors/notion-mcporter/other"));
	const otherContents = JSON.stringify({ version: 2, entries: {}, fixture: "OTHER_ACCOUNT_INDEX" });
	writeFileSync(other, otherContents, { mode: 0o600 });
	const rows = [
		{ account: "bare", flags: [], expected: ["auth", "notion-connectors"] },
		{ account: "flagged", flags: ["--reset", "--no-browser"], expected: ["auth", "notion-connectors", "--no-browser", "--reset"] },
	];
	try {
		for (const row of rows) {
			const vaultRoot = path.join(state, "connectors/notion-mcporter", row.account);
			const fifo = ownedVault(vaultRoot);
			execFileSync("/usr/bin/mkfifo", [fifo]);
			const running = runInteractiveBundle({ ...bundle, binary: "/usr/bin/sandbox-exec" }, ["-p", DENY_NETWORK, bundle.binary, "auth", "login", "notion", ...row.flags.slice(0, 1), "--select", `account=${row.account}`, ...row.flags.slice(1)], { home, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: official, NOTION_TOKEN: "SENTINEL_AUTH_AMBIENT" }, timeoutMs: 60000 });
			const held = await heldMcporter(fifo, state, "auth", running);
			const result = await running;
			expect(held?.argv).toEqual(row.expected);
			expect(held?.env.filter((value) => /^(?:XDG_DATA_HOME|XDG_CACHE_HOME|MCPORTER_NO_KEEPALIVE)=/.test(value)).sort()).toEqual(["MCPORTER_NO_KEEPALIVE=*", `XDG_CACHE_HOME=${vaultRoot}/cache`, `XDG_DATA_HOME=${vaultRoot}/data`]);
			expect(held?.env.some((value) => value.startsWith("NOTION_TOKEN=") || value.includes("SENTINEL_AUTH_AMBIENT"))).toBe(false);
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			expect(JSON.parse(result.stdout).result).toMatchObject({ causeCode: "DOMAIN_AUTH_LOGIN_UNKNOWN", transactionState: "unknown", data: { connector: "notion", account: row.account }, effects: { uncertain: ["account-grant"] } });
			for (const output of [result.stdout, result.terminal]) expect(output).not.toContain("SENTINEL_AUTH_AMBIENT");
			expect(readFileSync(other, "utf8")).toBe(otherContents);
			expect(existsSync(path.join(home, ".mcporter"))).toBe(false);
			expect(existsSync(path.join(state, "connectors/mcporter-keyless"))).toBe(false);
		}
	} finally { bundle.dispose(); }
}, 180000);
