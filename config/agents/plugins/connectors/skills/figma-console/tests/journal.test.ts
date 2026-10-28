// Public-process proof of the journaled write path through the compiled front
// door of a verified private copy (see fixtures/plugin-copy.ts). Only the
// MCPorter process leaf is substituted; the guards, journal and settlement
// under test are shipped source. A guard counts as reached only when its own
// closed cause comes back from the executed script.
import { beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cause, consoleCli, document, textNode, UPDATE, USER } from "./fixtures/console-cli.ts";

const cli = consoleCli();
const FILES = ["guardsfile1", "applyfile01", "lostreply01", "storagefile", "crashfile01", "markerfile1", "concurrent1", "expiredfile", "corruptfile", "fencefile01", "unrelated01", "orphanfile1", "floatfile01", "lateapply01", "fontaxes01", "wrongfont1", "mixedfont1", "scopeorder1", "scopemiss1", "scopeextra", "scopewrong"];
beforeAll(async () => {
	for (const file of FILES) expect((await cli.configure(file)).code).toBe(0);
}, 120000);
const preview = async (file: string, input: unknown = UPDATE) => {
	const result = await cli.write(file, "update_text", input, "--preview");
	expect([result.code, result.envelope?.result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
	return result.envelope?.result.data?.previewId as string;
};
const apply = (file: string, id: string, input: unknown = UPDATE) => cli.write(file, "update_text", input, "--apply", id);
const adjudicate = (file: string, id: string) => cli.recover(file, "--run", id, "--adjudicate", "--input", "{}");

test("wrong file, absent currentuser permission and another Desktop account stop at the script guard before any preview, receipt or lock", async () => {
	const file = "guardsfile1";
	for (const [doc, expected] of [[document("anotherfile1"), "file-mismatch"], [document(file, { userId: undefined }), "desktop-identity-unverified"], [document(file, { userId: "999" }), "desktop-identity-mismatch"]] as const) {
		cli.setMachine({ document: doc });
		const refused = await cli.write(file, "update_text", UPDATE, "--preview");
		expect([refused.code, refused.stderr, cause(refused.envelope)]).toEqual([3, "", expected]);
		expect(cli.calls().map((call) => call.argv.slice(2, 4).join(" "))).toEqual(["daemon status", "call figma-console-local.figma_execute"]);
		expect([cli.state().effects, cli.state().document.node.characters, cli.entries(file)]).toEqual([0, "Before", []]);
	}
	// The same guard runs again before an apply consumes its preview.
	cli.setMachine({ document: document(file) });
	const id = await preview(file);
	cli.patch((machine) => { machine.document.fileKey = "anotherfile1"; });
	const switched = await apply(file, id);
	expect([switched.code, cause(switched.envelope)]).toEqual([3, "file-mismatch"]);
	expect([cli.mutations().length, cli.receipt(file, id).status, cli.entries(file).some((name) => name.endsWith(".used"))]).toEqual([0, "preview", false]);
	expect((await cli.recover(file, "--run", id, "--unlock")).code).toBe(0);
}, 60000);

test("preview binds exact input; one apply sends once and verifies real fields; changed input and replay refuse without a send", async () => {
	const file = "applyfile01";
	cli.setMachine({ document: document(file) });
	const id = await preview(file);
	expect(cli.mutations()).toHaveLength(0);
	const changed = await apply(file, id, { ...UPDATE, text: "Other" });
	expect([changed.code, cause(changed.envelope), cli.mutations().length]).toEqual([3, "preview-input-mismatch", 0]);
	const applied = await apply(file, id);
	expect([applied.code, applied.stderr, applied.envelope?.result.causeCode]).toEqual([0, "", "SUCCESS_RUN_APPLIED"]);
	expect([cli.state().effects, cli.state().document.node.characters, cli.mutations().length]).toEqual([1, "After", 1]);
	expect(cli.entries(file).filter((name) => name.endsWith(".lock"))).toEqual([]);
	expect(cli.receipt(file, id).status).toBe("applied");
	const replay = await apply(file, id);
	expect([replay.code, cause(replay.envelope), cli.mutations().length, cli.state().effects]).toEqual([3, "baseline-changed", 1, 1]);
}, 60000);

test("Figma font variation metadata preserves exact text success; wrong or mixed fonts stay unknown", async () => {
	for (const [file, fontReadback, expected] of [["fontaxes01", "variation", "SUCCESS_RUN_APPLIED"], ["wrongfont1", "wrong", "DOMAIN_RUN_EFFECT_UNKNOWN"], ["mixedfont1", "mixed", "DOMAIN_RUN_EFFECT_UNKNOWN"]] as const) {
		cli.setMachine({ document: document(file), faults: { fontReadback } });
		const id = await preview(file);
		const result = await apply(file, id);
		expect([result.code, result.envelope?.result.causeCode, cli.state().effects, cli.mutations().length]).toEqual([expected === "SUCCESS_RUN_APPLIED" ? 0 : 3, expected, 1, 1]);
		expect(cli.state().document.node.characters).toBe("After");
		expect(cli.receipt(file, id).status).toBe(expected === "SUCCESS_RUN_APPLIED" ? "applied" : "unknown");
	}
}, 60000);

test("created token scopes verify as an exact set after Figma reorders them", async () => {
	const input = { collection: "Fixture tokens", tokens: [{ name: "probe/spacing", type: "FLOAT", value: 24, scopes: ["GAP"] }, { name: "probe/color", type: "COLOR", value: { r: 0.12549, g: 0.309804, b: 0.533333, a: 1 }, scopes: ["TEXT_FILL", "FRAME_FILL"] }] };
	for (const [file, tokenScopeReadback, expected] of [["scopeorder1", "reorder", "SUCCESS_RUN_APPLIED"], ["scopemiss1", "missing", "DOMAIN_RUN_EFFECT_UNKNOWN"], ["scopeextra", "extra", "DOMAIN_RUN_EFFECT_UNKNOWN"], ["scopewrong", "wrong", "DOMAIN_RUN_EFFECT_UNKNOWN"]] as const) {
		cli.setMachine({ document: document(file), faults: { tokenScopeReadback } });
		const previewed = await cli.write(file, "create_tokens", input, "--preview");
		expect([previewed.code, previewed.envelope?.result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
		const id = previewed.envelope?.result.data?.previewId as string;
		const result = await cli.write(file, "create_tokens", input, "--apply", id);
		expect([result.code, result.envelope?.result.causeCode, cli.state().effects, cli.mutations().length]).toEqual([expected === "SUCCESS_RUN_APPLIED" ? 0 : 3, expected, 1, 1]);
		expect(cli.receipt(file, id).status).toBe(expected === "SUCCESS_RUN_APPLIED" ? "applied" : "unknown");
	}
}, 60000);

test("a lost reply after the effect stays unknown and blocks the object across fresh processes; adjudication reads without resending", async () => {
	const file = "lostreply01";
	cli.setMachine({ document: document(file), faults: { dropAfterEffect: true } });
	const id = await preview(file);
	const unknown = await apply(file, id);
	expect([unknown.code, unknown.envelope?.result.causeCode, unknown.envelope?.result.transactionState, unknown.envelope?.result.effects.uncertain]).toEqual([3, "DOMAIN_RUN_EFFECT_UNKNOWN", "unknown", ["provider-write"]]);
	expect([unknown.envelope?.result.data?.receiptStatus, cli.state().effects]).toEqual(["unknown", 1]);
	cli.patch((machine) => { machine.faults = {}; });
	const blocked = await cli.write(file, "update_text", { ...UPDATE, text: "Third" }, "--preview");
	expect([blocked.code, cause(blocked.envelope)]).toEqual([3, "object-blocked"]);
	const retry = await apply(file, id);
	expect([retry.code, cli.mutations().length]).toEqual([3, 1]);
	expect((await cli.recover(file, "--run", id)).envelope?.result.data?.receipt.status).toBe("unknown");
	const unlock = await cli.recover(file, "--run", id, "--unlock");
	expect([unlock.code, cause(unlock.envelope)]).toEqual([3, "attempted-receipt-cannot-unlock"]);
	const settled = await adjudicate(file, id);
	expect([settled.code, settled.envelope?.result.data?.status, cli.mutations().length, cli.state().effects]).toEqual([0, "applied", 1, 1]);
	expect(cli.entries(file).filter((name) => name.endsWith(".lock"))).toEqual([]);
	await preview(file, { ...UPDATE, text: "Third" });
}, 60000);

test("a journal that cannot record the outcome after a possible effect still reports effect-unknown, never a refusal", async () => {
	const file = "storagefile";
	cli.setMachine({ document: document(file), faults: { breakJournalAfterEffect: true } });
	const id = await preview(file);
	const unknown = await apply(file, id);
	expect([unknown.code, unknown.stderr, unknown.envelope?.result.causeCode, unknown.envelope?.result.data?.receiptStatus]).toEqual([3, "", "DOMAIN_RUN_EFFECT_UNKNOWN", "sending"]);
	expect([cli.state().effects, cli.receipt(file, id).status]).toEqual([1, "sending"]);
	cli.patch((machine) => { machine.faults = {}; });
	// A fresh process restores the owned 0700 journal, then reads the open receipt.
	expect((await cli.recover(file, "--run", id)).envelope?.result.data?.receipt.status).toBe("sending");
	const settled = await adjudicate(file, id);
	expect([settled.code, settled.envelope?.result.data?.status, cli.mutations().length]).toEqual([0, "applied", 1]);
}, 60000);

test("a front door killed after the send leaves an open receipt that no fresh process resends", async () => {
	const file = "crashfile01";
	cli.setMachine({ document: document(file), faults: { killAfterEffect: true } });
	const id = await preview(file);
	const killed = await apply(file, id);
	expect([killed.code === 0, killed.stdout, cli.state().effects]).toEqual([false, "", 1]);
	cli.patch((machine) => { machine.faults = {}; });
	expect((await cli.recover(file, "--run", id)).envelope?.result.data?.receipt.status).toBe("sending");
	const again = await apply(file, id);
	expect([again.code, cli.mutations().length]).toEqual([3, 1]);
	expect((await adjudicate(file, id)).envelope?.result.data?.status).toBe("applied");
}, 60000);

test("a crash after the one-attempt marker but before the sending record still reads as attempted, never as a fresh preview", async () => {
	const file = "markerfile1";
	cli.setMachine({ document: document(file) });
	const id = await preview(file);
	writeFileSync(path.join(cli.journal(file), `${id}.used`), "one-attempt\n", { mode: 0o600 });
	expect((await cli.recover(file, "--run", id)).envelope?.result.data?.receipt.status).toBe("sending");
	const consumed = await apply(file, id);
	expect([consumed.code, cause(consumed.envelope), cli.mutations().length]).toEqual([3, "preview-consumed", 0]);
	expect(cause((await cli.recover(file, "--run", id, "--unlock")).envelope)).toBe("attempted-receipt-cannot-unlock");
	const settled = await adjudicate(file, id);
	expect([settled.code, settled.envelope?.result.data?.status]).toEqual([0, "unchanged"]);
	expect(cli.entries(file).filter((name) => name.endsWith(".lock"))).toEqual([]);
}, 60000);

test("two concurrent applies of one preview send exactly once", async () => {
	const file = "concurrent1";
	cli.setMachine({ document: document(file) });
	const id = await preview(file);
	// Both processes pass the fresh baseline read before either attempts.
	cli.patch((machine) => { machine.faults = { snapshotDelayMs: 750 }; });
	const results = await Promise.all([apply(file, id), apply(file, id)]);
	expect(results.map((result) => result.envelope?.result.causeCode).sort()).toEqual(["DOMAIN_ADAPTER_REFUSED", "SUCCESS_RUN_APPLIED"].sort());
	expect(results.map((result) => cause(result.envelope)).filter(Boolean)).toEqual(["preview-consumed"]);
	expect([cli.mutations().length, cli.state().effects]).toEqual([1, 1]);
}, 60000);

test("an expired preview refuses before any send and keeps its lock until unlocked; a malformed receipt blocks every write before any call", async () => {
	const file = "expiredfile";
	cli.setMachine({ document: document(file) });
	const id = await preview(file);
	const receipt = cli.receipt(file, id);
	writeFileSync(path.join(cli.journal(file), `${id}.json`), `${JSON.stringify({ ...receipt, createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() })}\n`, { mode: 0o600 });
	const expired = await apply(file, id);
	expect([expired.code, cause(expired.envelope), cli.mutations().length]).toEqual([3, "preview-expired", 0]);
	expect(cli.entries(file).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
	const unlocked = await cli.recover(file, "--run", id, "--unlock");
	expect([unlocked.code, unlocked.envelope?.result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
	expect(cli.entries(file).filter((name) => name.endsWith(".lock"))).toEqual([]);
	// The unlock won the preview's one-use marker, so no later apply can send it.
	expect(readFileSync(path.join(cli.journal(file), `${id}.used`), "utf8")).toBe("cancelled\n");
	const cancelled = await cli.write(file, "update_text", UPDATE, "--apply", id);
	expect([cancelled.code, cause(cancelled.envelope), cli.mutations().length]).toEqual([3, "preview-consumed", 0]);

	const corrupt = "corruptfile";
	cli.setMachine({ document: { ...document(corrupt), node: textNode() } });
	await preview(corrupt);
	writeFileSync(path.join(cli.journal(corrupt), "fc-00000000-0000-4000-8000-000000000000.json"), "{not json\n", { mode: 0o600 });
	cli.setMachine({ document: document(corrupt) });
	const blocked = await cli.write(corrupt, "update_text", { ...UPDATE, nodeId: "7:286" }, "--preview");
	expect([blocked.code, cause(blocked.envelope), cli.calls()]).toEqual([3, "journal-corrupt", []]);
	// Recovery still reads around it, names it, and can end the open preview.
	const listing = await cli.recover(corrupt);
	expect([listing.code, listing.envelope?.result.data?.malformed, listing.envelope?.result.data?.receipts.length]).toEqual([0, ["fc-00000000-0000-4000-8000-000000000000.json"], 1]);
	const open = listing.envelope?.result.data?.receipts[0].id as string;
	expect((await cli.recover(corrupt, "--run", open, "--unlock")).code).toBe(0);
}, 60000);

test("an adjudication fences its receipt first, so a mutation still running in Desktop after a lost reply can never land after an unchanged verdict", async () => {
	const file = "fencefile01";
	cli.setMachine({ document: document(file), faults: { holdMutation: true } });
	const id = await preview(file);
	const unknown = await apply(file, id);
	expect([unknown.envelope?.result.causeCode, cli.state().effects, cli.state().held.length]).toEqual(["DOMAIN_RUN_EFFECT_UNKNOWN", 0, 1]);
	cli.patch((machine) => { machine.faults = {}; });
	const settled = await adjudicate(file, id);
	expect([settled.code, settled.envelope?.result.data?.status]).toEqual([0, "unchanged"]);
	expect(Object.keys(cli.state().storage)).toEqual([`figma-console-fence:${id}`]);
	// The held mutation now runs, as timed-out bridge code can, and must refuse.
	cli.patch((machine) => { machine.faults = { releaseHeld: true }; });
	expect((await cli.run(["run", "figma-console", ...cli.select(file), "read_node", "--input", JSON.stringify({ nodeId: "7:285" })])).code).toBe(0);
	expect([cli.state().heldOutcomes, cli.state().effects, cli.state().document.node.characters]).toEqual([["connector:fenced"], 0, "Before"]);
}, 60000);

test("an unchanged verdict reads only the receipt's own object, so an unrelated edit elsewhere in the file cannot block it forever", async () => {
	const file = "unrelated01";
	cli.setMachine({ document: document(file), faults: { holdMutation: true } });
	const id = await preview(file);
	expect((await apply(file, id)).envelope?.result.causeCode).toBe("DOMAIN_RUN_EFFECT_UNKNOWN");
	cli.patch((machine) => { machine.faults = {}; machine.document.variables.push({ id: "VariableID:5:5", name: "elsewhere", resolvedType: "FLOAT", scopes: ["GAP"], valuesByMode: { "1:0": 4 }, variableCollectionId: "VariableCollectionId:5:1" }); });
	expect((await adjudicate(file, id)).envelope?.result.data?.status).toBe("unchanged");
}, 60000);

test("a lock whose receipt never published is listed and releasable by its id, and only that lock", async () => {
	const file = "orphanfile1";
	cli.setMachine({ document: document(file) });
	const orphan = `fc-${randomUUID()}`;
	expect((await cli.recover(file)).envelope?.result.data).toEqual({ connector: "figma-console", receipts: [], malformed: [], orphanLocks: [] });
	// Independent oracle of the lock name: sha256 of the sorted canonical identity.
	const name = createHash("sha256").update(JSON.stringify({ account: USER, file, object: "node:7:285" })).digest("hex");
	writeFileSync(path.join(cli.journal(file), `${name}.lock`), `${orphan}\n`, { mode: 0o600 });
	expect(cause((await cli.write(file, "update_text", UPDATE, "--preview")).envelope)).toBe("object-blocked");
	expect((await cli.recover(file)).envelope?.result.data?.orphanLocks).toEqual([orphan]);
	expect(cause((await cli.recover(file, "--run", `fc-${randomUUID()}`, "--unlock")).envelope)).toBe("receipt-unavailable");
	const released = await cli.recover(file, "--run", orphan, "--unlock");
	expect([released.code, released.envelope?.result.data?.receipt]).toEqual([0, { id: orphan, orphanLock: "released" }]);
	await preview(file);
}, 60000);

test("values Figma stores as float32 or RGBA still verify their write", async () => {
	const file = "floatfile01";
	const variables = [{ id: "VariableID:8:1", name: "space/gap", resolvedType: "FLOAT", scopes: ["GAP"], valuesByMode: { "1:0": 4 }, variableCollectionId: "VariableCollectionId:8:0" }, { id: "VariableID:8:2", name: "color/action", resolvedType: "COLOR", scopes: ["FRAME_FILL"], valuesByMode: { "1:0": { r: 0, g: 0, b: 0, a: 1 } }, variableCollectionId: "VariableCollectionId:8:0" }];
	const collections = [{ id: "VariableCollectionId:8:0", name: "Fixture", modes: [{ modeId: "1:0", name: "Mode 1" }], defaultModeId: "1:0" }];
	for (const [variableId, value] of [["VariableID:8:1", 0.2], ["VariableID:8:2", { r: 0.1, g: 0.6, b: 0.3 }]] as const) {
		cli.setMachine({ document: document(file, { variables: structuredClone(variables), collections }) });
		const input = { variableId, modeId: "1:0", value };
		const previewed = await cli.write(file, "update_variable", input, "--preview");
		const applied = await cli.write(file, "update_variable", input, "--apply", previewed.envelope?.result.data?.previewId as string);
		expect([variableId, applied.code, applied.envelope?.result.causeCode, cli.state().effects]).toEqual([variableId, 0, "SUCCESS_RUN_APPLIED", 1]);
	}
}, 60000);

test("an apply still running when its receipt is adjudicated can neither reopen the verdict nor claim another write's effect", async () => {
	const file = "lateapply01";
	cli.setMachine({ document: document(file), faults: { mutationDelayMs: 4000 } });
	const id = await preview(file);
	const late = apply(file, id);
	for (let tries = 0; tries < 400 && cli.mutations().length === 0; tries += 1) await Bun.sleep(10);
	expect(cli.mutations()).toHaveLength(1);
	cli.patch((machine) => { machine.faults = {}; });
	expect((await adjudicate(file, id)).envelope?.result.data?.status).toBe("unchanged");
	// A second preview of the same change lands while the first send is late.
	const second = await preview(file);
	expect((await apply(file, second)).envelope?.result.causeCode).toBe("SUCCESS_RUN_APPLIED");
	const result = await late;
	expect([result.code, result.envelope?.result.causeCode, cause(result.envelope), cli.state().effects]).toEqual([3, "DOMAIN_RUN_FAILED_RECORDED", "settled-unchanged", 1]);
	expect(cli.receipt(file, id).status).toBe("unchanged");
	expect(readFileSync(path.join(cli.journal(file), `${id}.terminal`), "utf8")).toBe("unchanged\n");
	const again = await adjudicate(file, id);
	expect([again.code, cause(again.envelope)]).toEqual([3, "receipt-not-open"]);
}, 60000);
