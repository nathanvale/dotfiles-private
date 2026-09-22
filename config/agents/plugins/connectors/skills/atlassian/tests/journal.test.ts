// Private Atlassian write journal, redesigned. Every case here falsifies one
// of the review findings: identities derived from input, one object-scoped
// lock around preview reread, revision bound at apply, durable intent before
// dispatch, consumed only after intent, fail-closed corrupt state, no
// automatic lock reclaim, closed effect vocabulary, and no private content.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JournalError, objectIdentity, openJournal } from "../scripts/dispatch/journal.ts";

const WORKER = path.resolve(import.meta.dir, "fixtures", "journal-worker.ts");
const PRIVATE = ["fixture-secret-value", "Quarterly numbers are down", "https://example.atlassian.net", "Billing broken", "Roadmap draft"];
const COMMENT = { issueKey: "PROJ-1", body: "Quarterly numbers are down; fixture-secret-value; https://example.atlassian.net" };
const CREATE = { projectKey: "PROJ", issueType: "Bug", summary: "Billing broken", description: "first" };
const PAGE = { space: { id: "123" }, parentId: "77", title: "Roadmap draft", body: "x" };

// Test-owned stable digest oracle. Journal representation changes must be
// observable here without calculating an expected digest through production.
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
// The same space named by its key alongside its id: one space, one identity.
const PAGE_ALIAS = { ...PAGE, space: { id: "123", key: "ENG" }, body: "y" };

let root: string;
let now: number;
beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "journal-test-"));
	mkdirSync(path.join(root, "markers"));
	now = 1_700_000_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const clock = () => now;
const journal = (options: Parameters<typeof openJournal>[1] = {}) => openJournal("example", { stateRoot: root, now: clock, ...options });
const tenantDir = () => path.join(root, "connectors", "atlassian", "example");
const dir = (name: string) => path.join(tenantDir(), name);
const listing = (name: string) => readdirSync(dir(name)).filter((entry) => !entry.startsWith("."));
const stored = () => ["previews", "receipts", "locks"].flatMap((name) => listing(name).map((entry) => readFileSync(path.join(dir(name), entry), "utf8"))).join("\n");
const markers = () => readdirSync(path.join(root, "markers")).length;
const comment = (j = journal(), input: unknown = COMMENT, revision: string | null = "v7") => j.recordPreview({ operation: "issue.comment", provider: "official", canonicalInput: input, providerArgs: input, revision });
const ok = { proof: "completed" as const, effects: [{ kind: "jira-comment" as const, id: "10001" }] };
const unknown = { proof: "unknown" as const };
const applyOk = (j: ReturnType<typeof journal>, previewId: string, input: unknown = COMMENT, revision: string | null = "v7") =>
	j.apply({ previewId, canonicalInput: input, providerArgs: input, revision }, async () => ok);

describe("identity is a pure function of input", () => {
	test("update and comment identities are the object; creates use container, discriminator, and subject digest", () => {
		expect(objectIdentity("issue.comment", COMMENT)).toBe("issue:PROJ-1");
		expect(objectIdentity("issue.update", { issueKey: "PROJ-1", fields: { summary: "x" } })).toBe("issue:PROJ-1");
		expect(objectIdentity("page.update", { pageId: "123", body: "x" })).toBe("page:123");
		expect(objectIdentity("issue.create", CREATE)).toMatch(/^project:PROJ:create:bug:[0-9a-f]{16}$/);
		expect(objectIdentity("issue.create", { ...CREATE, description: "edited", issueType: " BUG " , summary: " billing   BROKEN" })).toBe(objectIdentity("issue.create", CREATE));
		expect(objectIdentity("issue.create", { ...CREATE, summary: "Invoice missing" })).not.toBe(objectIdentity("issue.create", CREATE));
		expect(objectIdentity("page.create", PAGE)).toMatch(/^space:123:create:77:[0-9a-f]{16}$/);
		expect(objectIdentity("page.create", { ...PAGE, parentId: undefined })).toMatch(/^space:123:create:root:/);
		expect(objectIdentity("page.create", PAGE_ALIAS)).toBe(objectIdentity("page.create", PAGE));
		for (const bad of [{}, { issueKey: "PROJ 1" }, { ...CREATE, summary: "  " }, { ...PAGE, space: {} }]) {
			expect(() => objectIdentity("issue.comment", bad)).toThrow(JournalError);
		}
		// A space key alone, a non-canonical id, or a numeric id are not one canonical container.
		for (const space of [{ key: "ENG" }, { id: "0123" }, { id: 123 }, { id: "ENG" }, {}]) {
			expect(() => objectIdentity("page.create", { ...PAGE, space })).toThrow(/input-invalid/);
		}
		expect(() => objectIdentity("issue.get" as never, COMMENT)).toThrow(/operation-invalid/);
	});
});

describe("private state and privacy", () => {
	test("directories are owned 0700, files 0600, temp names unpredictable, and no private content is stored", async () => {
		const j = journal();
		const p = comment(j);
		await applyOk(j, p.previewId);
		j.recordPreview({ operation: "issue.create", provider: "official", canonicalInput: CREATE, providerArgs: CREATE, revision: null });
		j.recordPreview({ operation: "page.create", provider: "community", canonicalInput: PAGE, providerArgs: PAGE, revision: null });
		for (const name of ["previews", "receipts", "locks"]) {
			expect(lstatSync(dir(name)).mode & 0o777).toBe(0o700);
			for (const entry of readdirSync(dir(name))) {
				expect(entry.endsWith(".tmp")).toBe(false);
				expect(lstatSync(path.join(dir(name), entry)).mode & 0o777).toBe(0o600);
			}
		}
		const text = stored();
		for (const fragment of PRIVATE) expect(text).not.toContain(fragment);
		expect(text).toContain(testDigest(COMMENT));
		expect(text).not.toContain("v7");
	});

	test("falls back from XDG_STATE_HOME to HOME", () => {
		const home = path.join(root, "home");
		openJournal("example", { env: { HOME: home } }).recordPreview({ operation: "issue.comment", provider: "official", canonicalInput: COMMENT, providerArgs: COMMENT, revision: "1" });
		expect(existsSync(path.join(home, ".local", "state", "connectors", "atlassian", "example", "previews"))).toBe(true);
	});

	test("a symlinked state directory or file, or a wrong mode, fails closed without repair", async () => {
		const j = journal();
		comment(j);
		const receipts = dir("receipts");
		rmSync(receipts, { recursive: true });
		mkdirSync(path.join(root, "elsewhere"));
		symlinkSync(path.join(root, "elsewhere"), receipts);
		expect(() => journal()).toThrow(/state-invalid/);
		rmSync(receipts);
		mkdirSync(receipts, { mode: 0o700 });
		const j2 = journal();
		const p = comment(j2);
		const previewFile = path.join(dir("previews"), `${p.previewId}.json`);
		rmSync(previewFile);
		symlinkSync(path.join(root, "elsewhere", "target.json"), previewFile);
		await expect(j2.apply({ previewId: p.previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => ok)).rejects.toThrow(/state-invalid/);
		chmodSync(dir("locks"), 0o755);
		expect(() => journal()).toThrow(/state-invalid/);
		expect(markers()).toBe(0);
	});
});

describe("preview binding at apply", () => {
	test("exact input and the revision supplied at apply are checked; expiry and unknown ids refuse", async () => {
		const j = journal();
		const p = comment(j);
		await expect(j.apply({ previewId: p.previewId, canonicalInput: { ...COMMENT, body: "changed" }, providerArgs: { ...COMMENT, body: "changed" }, revision: "v7" }, async () => ok)).rejects.toThrow(/preview-input-mismatch/);
		await expect(j.apply({ previewId: p.previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v8" }, async () => ok)).rejects.toThrow(/preview-revision-changed/);
		// The provider arguments are bound too: an apply may send only what was previewed.
		await expect(j.apply({ previewId: p.previewId, canonicalInput: COMMENT, providerArgs: { ...COMMENT, extra: "smuggled" }, revision: "v7" }, async () => ok)).rejects.toThrow(/preview-args-mismatch/);
		await expect(j.apply({ previewId: "nope", canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => ok)).rejects.toThrow(/preview-unknown/);
		now += 15 * 60 * 1000 + 1;
		await expect(j.apply({ previewId: p.previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => ok)).rejects.toThrow(/preview-expired/);
		expect(listing("receipts")).toEqual([]);
		expect(markers()).toBe(0);
	});

	test("one preview dispatches at most once", async () => {
		const j = journal();
		const p = comment(j);
		const first = await applyOk(j, p.previewId);
		expect(first.status).toBe("completed");
		await expect(applyOk(j, p.previewId)).rejects.toThrow(/preview-consumed/);
	});

	test("receipt timestamps never move backward when the clock is adjusted", async () => {
		const j = journal();
		const p = comment(j);
		now += 10;
		const receipt = await j.apply({ previewId: p.previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async (_intent, sending) => {
			sending();
			now -= 20;
			return ok;
		});
		expect(receipt.updatedAt).toBe(1_700_000_000_010);
	});

	test("persisted preview digest uses the canonical input, independent of key order", () => {
		const reordered = { body: COMMENT.body, issueKey: COMMENT.issueKey };
		const preview = journal().recordPreview({ operation: "issue.comment", provider: "official", canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" });
		expect(preview.inputDigest).toBe(testDigest(reordered));
		expect(preview.inputDigest).not.toBe(testDigest({ ...COMMENT, body: "changed" }));
	});
});

describe("intent, settlement, and evidence", () => {
	test("the intent receipt is on disk before dispatch runs; completion needs a closed-vocabulary effect", async () => {
		const j = journal();
		const p = comment(j);
		const seen: string[] = [];
		const receipt = await j.apply({ previewId: p.previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async (intent) => {
			seen.push((JSON.parse(readFileSync(path.join(dir("receipts"), `${intent.runId}.json`), "utf8")) as { status: string }).status);
			seen.push((JSON.parse(readFileSync(path.join(dir("previews"), `${p.previewId}.json`), "utf8")) as { status: string }).status);
			return ok;
		});
		expect(seen).toEqual(["intent", "consumed"]);
		expect(receipt.status).toBe("completed");
		expect(receipt.effects).toEqual([{ kind: "jira-comment", id: "10001" }]);
		expect(j.openReceipts()).toEqual([]);
	});

	test("unknown, thrown, and private or malformed evidence all leave an unresolved receipt with nothing private stored", async () => {
		const j = journal();
		const a = await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => unknown);
		const b = await j.apply({ previewId: comment(j, { issueKey: "PROJ-2", body: "b" }).previewId, canonicalInput: { issueKey: "PROJ-2", body: "b" }, providerArgs: { issueKey: "PROJ-2", body: "b" }, revision: "v7" }, async () => {
			throw new Error("died fixture-secret-value");
		});
		const c = await j.apply({ previewId: comment(j, { issueKey: "PROJ-3", body: "c" }).previewId, canonicalInput: { issueKey: "PROJ-3", body: "c" }, providerArgs: { issueKey: "PROJ-3", body: "c" }, revision: "v7" }, async () => ({
			proof: "completed",
			effects: [{ kind: "jira-comment", id: "Quarterly numbers are down" }],
		}));
		const d = await j.apply({ previewId: comment(j, { issueKey: "PROJ-4", body: "d" }).previewId, canonicalInput: { issueKey: "PROJ-4", body: "d" }, providerArgs: { issueKey: "PROJ-4", body: "d" }, revision: "v7" }, async () => ({
			proof: "completed",
			effects: [{ kind: "customer-record" as never, id: "1" }],
		}));
		expect([a.status, b.status, c.status, d.status]).toEqual(["unknown", "unknown", "unknown", "unknown"]);
		expect(j.openReceipts()).toHaveLength(4);
		for (const fragment of PRIVATE) expect(stored()).not.toContain(fragment);
	});

	test("an unresolved receipt blocks any write operation on the same object, across operations, but not another object", async () => {
		const j = journal();
		await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => unknown);
		const update = j.recordPreview({ operation: "issue.update", provider: "official", canonicalInput: { issueKey: "PROJ-1", fields: { summary: "x" } }, providerArgs: { issueKey: "PROJ-1", fields: { summary: "x" } }, revision: "v7" });
		await expect(j.apply({ previewId: update.previewId, canonicalInput: { issueKey: "PROJ-1", fields: { summary: "x" } }, providerArgs: { issueKey: "PROJ-1", fields: { summary: "x" } }, revision: "v7" }, async () => ok)).rejects.toThrow(/write-blocked-open-receipt/);
		const pageUpdate = j.recordPreview({ operation: "page.update", provider: "official", canonicalInput: { pageId: "123", body: "a" }, providerArgs: { pageId: "123", body: "a" }, revision: "3" });
		await j.apply({ previewId: pageUpdate.previewId, canonicalInput: { pageId: "123", body: "a" }, providerArgs: { pageId: "123", body: "a" }, revision: "3" }, async () => unknown);
		const pageComment = j.recordPreview({ operation: "page.comment", provider: "official", canonicalInput: { pageId: "123", body: "c" }, providerArgs: { pageId: "123", body: "c" }, revision: null });
		await expect(j.apply({ previewId: pageComment.previewId, canonicalInput: { pageId: "123", body: "c" }, providerArgs: { pageId: "123", body: "c" }, revision: null }, async () => ok)).rejects.toThrow(/write-blocked-open-receipt/);
		const other = comment(j, { issueKey: "PROJ-2", body: "b" });
		expect((await j.apply({ previewId: other.previewId, canonicalInput: { issueKey: "PROJ-2", body: "b" }, providerArgs: { issueKey: "PROJ-2", body: "b" }, revision: "v7" }, async () => ok)).status).toBe("completed");
		expect(markers()).toBe(0);
	});

	test("a space alias cannot open a second write path around a pending page create", async () => {
		const j = journal();
		const create = (input: unknown) => j.recordPreview({ operation: "page.create", provider: "official", canonicalInput: input, providerArgs: input, revision: null });
		expect(() => create({ ...PAGE, space: { key: "ENG" } })).toThrow(/input-invalid/);
		await j.apply({ previewId: create(PAGE).previewId, canonicalInput: PAGE, providerArgs: PAGE, revision: null }, async () => unknown);
		await expect(j.apply({ previewId: create(PAGE_ALIAS).previewId, canonicalInput: PAGE_ALIAS, providerArgs: PAGE_ALIAS, revision: null }, async () => ok)).rejects.toThrow(/write-blocked-open-receipt/);
		expect(markers()).toBe(0);
		expect(j.openReceipts()).toHaveLength(1);
		expect(listing("previews").length).toBe(2);
	});

	test("read-back absence releases an object only while the receipt is unsent; after the send mark it stays blocked until read-back finds the effect", async () => {
		const j = journal();
		// Refused before the request left: unchanged is still reachable.
		const unsent = await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => {
			throw new Error("blocked by configuration");
		});
		expect([unsent.status, unsent.send]).toEqual(["unknown", "unsent"]);
		expect(j.resolve(unsent.runId, { proof: "unchanged", basis: "readback-absent" }).status).toBe("unchanged");
		// Marked sending, then read back absent: not evidence of no effect.
		const input = { ...COMMENT, body: "sent" };
		const seen: string[] = [];
		const sent = await j.apply({ previewId: comment(j, input).previewId, canonicalInput: input, providerArgs: input, revision: "v7" }, async (intent, sending) => {
			sending();
			sending();
			seen.push((JSON.parse(readFileSync(path.join(dir("receipts"), `${intent.runId}.json`), "utf8")) as { send: string }).send);
			return { proof: "unchanged", basis: "readback-absent" };
		});
		expect(seen).toEqual(["possible"]);
		expect([sent.status, sent.send]).toEqual(["unknown", "possible"]);
		expect(() => j.resolve(sent.runId, { proof: "unchanged", basis: "readback-absent" })).toThrow(/evidence-insufficient/);
		expect(j.openReceipts().map((entry) => entry.runId)).toEqual([sent.runId]);
		expect(() => j.resolve(sent.runId, { proof: "unchanged", basis: "guess" as never })).toThrow(/evidence-invalid/);
		const again = { ...COMMENT, body: "again" };
		await expect(j.apply({ previewId: comment(j, again).previewId, canonicalInput: again, providerArgs: again, revision: "v7" }, async () => ok)).rejects.toThrow(/write-blocked-open-receipt/);
		expect(j.resolve(sent.runId, ok).status).toBe("completed");
		expect(j.openReceipts()).toEqual([]);
		expect(markers()).toBe(0);
	});

	test("a revision that did not move proves no effect even after a possible send, and the basis is persisted", async () => {
		const j = journal();
		const sent = await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async (_intent, sending) => {
			sending();
			return unknown;
		});
		expect([sent.status, sent.send]).toEqual(["unknown", "possible"]);
		const settled = j.resolve(sent.runId, { proof: "unchanged", basis: "revision-unchanged" });
		expect([settled.status, settled.send, settled.basis]).toEqual(["unchanged", "possible", "revision-unchanged"]);
		expect((JSON.parse(readFileSync(path.join(dir("receipts"), `${sent.runId}.json`), "utf8")) as { basis: string }).basis).toBe("revision-unchanged");
		expect(j.openReceipts()).toEqual([]);
		// The same basis inside apply settles unchanged directly.
		const direct = await j.apply({ previewId: comment(j, { ...COMMENT, body: "2" }).previewId, canonicalInput: { ...COMMENT, body: "2" }, providerArgs: { ...COMMENT, body: "2" }, revision: "v7" }, async (_intent, sending) => {
			sending();
			return { proof: "unchanged", basis: "revision-unchanged" };
		});
		expect([direct.status, direct.basis]).toEqual(["unchanged", "revision-unchanged"]);
		expect(markers()).toBe(0);
	});

	test("an edited body after an unknown create is still blocked; a different subject is not", async () => {
		const j = journal();
		const create = (input: unknown) => j.recordPreview({ operation: "issue.create", provider: "official", canonicalInput: input, providerArgs: input, revision: null });
		await j.apply({ previewId: create(CREATE).previewId, canonicalInput: CREATE, providerArgs: CREATE, revision: null }, async () => unknown);
		const edited = { ...CREATE, description: "edited" };
		await expect(j.apply({ previewId: create(edited).previewId, canonicalInput: edited, providerArgs: edited, revision: null }, async () => ok)).rejects.toThrow(/write-blocked-open-receipt/);
		const different = { ...CREATE, summary: "Invoice missing" };
		expect((await j.apply({ previewId: create(different).previewId, canonicalInput: different, providerArgs: different, revision: null }, async () => ({ proof: "completed", effects: [{ kind: "jira-issue", id: "PROJ-9" }] }))).status).toBe("completed");
	});

	test("corrupt or malformed local state fails closed for every entry point", async () => {
		const j = journal();
		const p = comment(j);
		writeFileSync(path.join(dir("receipts"), "garbage.json"), "{not json", { mode: 0o600 });
		expect(() => j.openReceipts()).toThrow(/state-corrupt/);
		await expect(applyOk(j, p.previewId)).rejects.toThrow(/state-corrupt/);
		rmSync(path.join(dir("receipts"), "garbage.json"));
		writeFileSync(path.join(dir("receipts"), "nostatus.json"), JSON.stringify({ runId: "nostatus", objectIdentity: "issue:PROJ-9" }), { mode: 0o600 });
		expect(() => j.openReceipts()).toThrow(/state-corrupt/);
		rmSync(path.join(dir("receipts"), "nostatus.json"));
		writeFileSync(path.join(dir("previews"), `${p.previewId}.json`), '{"previewId":"x"}', { mode: 0o600 });
		await expect(applyOk(j, p.previewId)).rejects.toThrow(/state-corrupt/);
		expect(markers()).toBe(0);
	});

	test("tampered persisted records fail closed at every entry point", async () => {
		const j = journal();
		const p = comment(j);
		const receipt = await j.apply({ previewId: comment(j, { ...COMMENT, body: "x" }).previewId, canonicalInput: { ...COMMENT, body: "x" }, providerArgs: { ...COMMENT, body: "x" }, revision: "v7" }, async () => unknown);
		const receiptFile = path.join(dir("receipts"), `${receipt.runId}.json`);
		const good = JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
		const tampered: [string, Record<string, unknown>][] = [
			["createdAt not finite", { ...good, createdAt: "soon" }],
			["updatedAt not finite", { ...good, updatedAt: Number.NaN }],
			["createdAt after updatedAt", { ...good, createdAt: good.updatedAt as number, updatedAt: (good.createdAt as number) - 1 }],
			["operation not a write", { ...good, operation: "issue.get" }],
			["provider unknown", { ...good, provider: "legacy" }],
			["identity shape does not fit the operation", { ...good, objectIdentity: "page:123" }],
			["identity well formed but another object than its preview", { ...good, objectIdentity: "issue:PROJ-2" }],
			["preview missing", { ...good, previewId: "missing" }],
			["operation differs from its preview", { ...good, operation: "issue.update" }],
			["provider differs from its preview", { ...good, provider: "community" }],
			["input digest differs from its preview", { ...good, inputDigest: "f".repeat(64) }],
			["revision digest differs from its preview", { ...good, revisionDigest: null }],
			["holder pid not a positive integer", { ...good, holder: { pid: "1" } }],
			["effects on an unresolved receipt", { ...good, effects: [{ kind: "jira-comment", id: "1" }] }],
			["send state outside the vocabulary", { ...good, send: "sent" }],
			["send state missing", { ...good, send: undefined }],
			["unchanged after a possible send on read-back absence", { ...good, status: "unchanged", send: "possible", basis: "readback-absent" }],
			["unchanged without a basis", { ...good, status: "unchanged" }],
			["unchanged with a basis outside the vocabulary", { ...good, status: "unchanged", basis: "guess" }],
			["a basis on an unresolved receipt", { ...good, basis: "readback-absent" }],
			["completed without effects", { ...good, status: "completed", effects: [] }],
			["effect outside the closed vocabulary", { ...good, status: "completed", effects: [{ kind: "customer-record", id: "1" }] }],
			["digest not hex", { ...good, inputDigest: "not-a-digest" }],
			["args digest differs from its preview", { ...good, argsDigest: "e".repeat(64) }],
			["args digest missing", { ...good, argsDigest: undefined }],
		];
		for (const [label, record] of tampered) {
			writeFileSync(receiptFile, JSON.stringify(record), { mode: 0o600 });
			expect([label, (() => { try { j.openReceipts(); return "accepted"; } catch (error) { return error instanceof JournalError ? error.code : "other"; } })()]).toEqual([label, "state-corrupt"]);
			expect([label, (() => { try { j.resolve(receipt.runId, { proof: "unchanged", basis: "readback-absent" }); return "accepted"; } catch (error) { return error instanceof JournalError ? error.code : "other"; } })()]).toEqual([label, "state-corrupt"]);
		}
		writeFileSync(receiptFile, JSON.stringify(good), { mode: 0o600 });
		const previewFile = path.join(dir("previews"), `${p.previewId}.json`);
		const goodPreview = JSON.parse(readFileSync(previewFile, "utf8")) as Record<string, unknown>;
		for (const [label, record] of [
			["preview expiresAt not finite", { ...goodPreview, expiresAt: Number.POSITIVE_INFINITY }],
			["preview expires before creation", { ...goodPreview, expiresAt: (goodPreview.createdAt as number) - 1 }],
			["preview identity shape mismatch", { ...goodPreview, objectIdentity: "project:PROJ:create:bug:0123456789abcdef" }],
			["preview identity well formed but not the previewed input's object", { ...goodPreview, objectIdentity: "issue:PROJ-2" }],
			["preview status unknown", { ...goodPreview, status: "applied" }],
			["preview revision digest not hex", { ...goodPreview, revisionDigest: "v7" }],
			["preview args digest not hex", { ...goodPreview, argsDigest: "v7" }],
		] as [string, Record<string, unknown>][]) {
			writeFileSync(previewFile, JSON.stringify(record), { mode: 0o600 });
			await expect(applyOk(j, p.previewId)).rejects.toThrow(/state-corrupt/);
		}
		expect(markers()).toBe(0);
	});

	test("a well-formed foreign identity on an unresolved receipt or on the preview never lets a same-object write dispatch", async () => {
		const j = journal();
		const open = await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => unknown);
		const receiptFile = path.join(dir("receipts"), `${open.runId}.json`);
		const good = JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
		// The open receipt now claims another object; a second write on PROJ-1 must not slip past it.
		writeFileSync(receiptFile, JSON.stringify({ ...good, objectIdentity: "issue:PROJ-2" }), { mode: 0o600 });
		const again = comment(j, { ...COMMENT, body: "again" });
		await expect(applyOk(j, again.previewId, { ...COMMENT, body: "again" })).rejects.toThrow(/state-corrupt/);
		expect(markers()).toBe(0);
		expect(listing("receipts")).toHaveLength(1);
		writeFileSync(receiptFile, JSON.stringify(good), { mode: 0o600 });
		// The preview being applied now claims another object; its input still names PROJ-1.
		const previewFile = path.join(dir("previews"), `${again.previewId}.json`);
		const goodPreview = JSON.parse(readFileSync(previewFile, "utf8")) as Record<string, unknown>;
		writeFileSync(previewFile, JSON.stringify({ ...goodPreview, objectIdentity: "issue:PROJ-2" }), { mode: 0o600 });
		await expect(applyOk(j, again.previewId, { ...COMMENT, body: "again" })).rejects.toThrow(/state-corrupt/);
		expect(markers()).toBe(0);
		expect(listing("receipts")).toHaveLength(1);
		expect(listing("locks")).toEqual([]);
		// Restored, the honest state still blocks on the unresolved receipt.
		writeFileSync(previewFile, JSON.stringify(goodPreview), { mode: 0o600 });
		await expect(applyOk(j, again.previewId, { ...COMMENT, body: "again" })).rejects.toThrow(/write-blocked-open-receipt/);
		expect(markers()).toBe(0);
	});

	test("completed evidence without effects is refused before settlement, and the journal still reloads", async () => {
		const j = journal();
		const receipt = await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => ({ proof: "completed", effects: [] }));
		expect(receipt.status).toBe("unknown");
		expect(receipt.effects).toEqual([]);
		expect(j.openReceipts().map((entry) => entry.runId)).toEqual([receipt.runId]);
		expect(() => j.resolve(receipt.runId, { proof: "completed", effects: [] })).toThrow(/evidence-invalid/);
		expect(j.receipt(receipt.runId).status).toBe("unknown");
		expect(markers()).toBe(0);
	});

	test("a stale meta-lock is never reclaimed automatically and has no programmatic recovery; the refusal names the file", async () => {
		const j = journal();
		const meta = path.join(dir("locks"), ".meta");
		writeFileSync(meta, JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: now }), { mode: 0o600 });
		await expect(applyOk(j, comment(j).previewId)).rejects.toThrow(/meta-locked/);
		await expect(applyOk(j, comment(j).previewId)).rejects.toThrow(meta);
		expect(() => j.unlock(objectIdentity("issue.comment", COMMENT))).toThrow(/meta-locked/);
		expect(markers()).toBe(0);
		expect("recoverMetaLock" in j).toBe(false);
		expect(existsSync(meta)).toBe(true);
		// Operator recovery is removing the file by hand once no process runs.
		rmSync(meta);
		expect((await applyOk(j, comment(j).previewId)).status).toBe("completed");
		expect(listing("locks")).toEqual([]);
	});

	test("release never unlinks an object lock whose lockId it did not write", async () => {
		const j = journal({
			hooks: {
				// Tamper with the object lock only; the meta-lock release must still verify its own id.
				beforeRelease: (lockFile) => {
					if (!lockFile.endsWith(".meta")) writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockId: "foreign", at: now }), { mode: 0o600 });
				},
			},
		});
		await expect(applyOk(j, comment(j).previewId)).rejects.toThrow(/lock-tampered/);
		const lockFile = path.join(dir("locks"), `${objectIdentity("issue.comment", COMMENT).replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
		expect((JSON.parse(readFileSync(lockFile, "utf8")) as { lockId: string }).lockId).toBe("foreign");
	});

	test("resolve needs evidence, never presumes no effect, refuses invalid evidence, and is final", async () => {
		const j = journal();
		const receipt = await j.apply({ previewId: comment(j).previewId, canonicalInput: COMMENT, providerArgs: COMMENT, revision: "v7" }, async () => unknown);
		expect(j.resolve(receipt.runId, unknown).status).toBe("unknown");
		expect(() => j.resolve(receipt.runId, { proof: "completed", effects: [{ kind: "jira-comment", id: "has space" }] })).toThrow(/evidence-invalid/);
		expect(j.resolve(receipt.runId, { proof: "unchanged", basis: "readback-absent" }).status).toBe("unchanged");
		expect(() => j.resolve(receipt.runId, unknown)).toThrow(/receipt-already-resolved/);
		expect(() => j.resolve("missing", unknown)).toThrow(/receipt-unknown/);
		expect(j.openReceipts()).toEqual([]);
	});
});

describe("cross-process safety", () => {
	// Workers run on the real clock, so previews here are recorded with it too.
	const real = () => openJournal("example", { stateRoot: root });
	const spawnWorker = (previewId: string, mode: string, holdMs = "300", input: unknown = COMMENT, revision: string | null = "v7") =>
		Bun.spawn([process.execPath, WORKER, root, previewId, mode, holdMs], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "", HOME: root, JOURNAL_INPUT: JSON.stringify(input), ...(revision === null ? {} : { JOURNAL_REVISION: revision }) },
		});
	const finish = async (proc: ReturnType<typeof spawnWorker>) => {
		const [stdout, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
		return { lines: stdout.trim().split("\n"), code };
	};
	// For a stream already peeked by untilDispatching: read the remainder.
	const drain = async (proc: ReturnType<typeof spawnWorker>) => {
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		let text = "";
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += new TextDecoder().decode(chunk.value);
		return { lines: text.trim().split("\n"), code: await proc.exited };
	};
	const untilDispatching = async (proc: ReturnType<typeof spawnWorker>) => {
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		let text = "";
		while (!text.includes("dispatching")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
		}
		reader.releaseLock();
		return text;
	};

	test("same preview in two processes with a barrier: exactly one intent and one dispatch", async () => {
		const p = comment(real());
		const first = spawnWorker(p.previewId, "barrier");
		expect(await untilDispatching(first)).toContain("dispatching");
		const second = await finish(spawnWorker(p.previewId, "hold", "10"));
		expect(second.lines.at(-1)).toMatch(/^error (preview-consumed|write-blocked-open-receipt)$/);
		writeFileSync(path.join(root, "barrier"), "");
		expect(await first.exited).toBe(0);
		expect(markers()).toBe(1);
		expect(listing("receipts")).toHaveLength(1);
		expect(listing("locks")).toEqual([]);
	});

	test("same object, different previews, racing: exactly one dispatch", async () => {
		const j = real();
		const a = comment(j);
		const b = comment(j, { ...COMMENT, body: "other" });
		const first = spawnWorker(a.previewId, "barrier");
		await untilDispatching(first);
		const second = await finish(spawnWorker(b.previewId, "hold", "10", { ...COMMENT, body: "other" }));
		expect(second.lines.at(-1)).toBe("error write-blocked-open-receipt");
		writeFileSync(path.join(root, "barrier"), "");
		expect(await first.exited).toBe(0);
		expect(markers()).toBe(1);
	});

	test("crash before intent: nothing dispatched, preview still open, a later apply proceeds once", async () => {
		const p = comment(real());
		expect((await finish(spawnWorker(p.previewId, "crash-before-intent"))).code).toBe(9);
		expect(listing("receipts")).toEqual([]);
		expect(markers()).toBe(0);
		expect(real().openReceipts()).toEqual([]);
		// The crashed holder's lock is never reclaimed automatically.
		expect((await finish(spawnWorker(p.previewId, "hold", "10"))).lines.at(-1)).toBe("error write-locked");
			real().unlock(real().preview(p.previewId).objectIdentity);
		const later = await finish(spawnWorker(p.previewId, "hold", "10"));
		expect(later.lines.at(-1)).toBe("done completed");
		expect(markers()).toBe(1);
	});

	test("crash after intent but before consumed: preview open, intent blocks the object, nothing dispatched", async () => {
		const p = comment(real());
		expect((await finish(spawnWorker(p.previewId, "crash-after-intent"))).code).toBe(9);
		expect(markers()).toBe(0);
		const j = real();
		expect(j.openReceipts().map((entry) => entry.status)).toEqual(["intent"]);
		expect((JSON.parse(readFileSync(path.join(dir("previews"), `${p.previewId}.json`), "utf8")) as { status: string }).status).toBe("open");
		expect((await finish(spawnWorker(p.previewId, "hold", "10"))).lines.at(-1)).toBe("error write-locked");
		j.unlock(objectIdentity("issue.comment", COMMENT));
		const retry = await finish(spawnWorker(p.previewId, "hold", "10"));
		expect(retry.lines.at(-1)).toBe("error preview-consumed");
		const receipt = j.openReceipts()[0];
		j.resolve(receipt?.runId ?? "", { proof: "unchanged", basis: "readback-absent" });
		const afterResolution = await finish(spawnWorker(p.previewId, "hold", "10"));
		expect(afterResolution.lines.at(-1)).toBe("error preview-consumed");
		expect(markers()).toBe(0);
	});

	test("crash in dispatch: the intent survives with a dead holder, resolve then unblocks the object", async () => {
		const p = comment(real());
		expect((await finish(spawnWorker(p.previewId, "crash-in-dispatch"))).code).toBe(9);
		expect(markers()).toBe(1);
		const j = real();
		const open = j.openReceipts();
		expect(open.map((entry) => entry.status)).toEqual(["intent"]);
		expect(listing("locks")).toEqual([]);
		expect(j.resolve(open[0]?.runId ?? "", { proof: "unchanged", basis: "readback-absent" }).status).toBe("unchanged");
		const next = await finish(spawnWorker(comment(j, { ...COMMENT, body: "again" }).previewId, "hold", "10", { ...COMMENT, body: "again" }));
		expect(next.lines.at(-1)).toBe("done completed");
	});

	// Test-owned inline worker: marks sending, writes its marker, then dies as
	// if the request had left the process. The shared worker fixture never
	// marks sending, so its crash-in-dispatch case stays the unsent path.
	const SENDING_WORKER = [
		'const { writeFileSync } = await import("node:fs");',
		"const { openJournal } = await import(process.env.JOURNAL_MODULE);",
		"const root = process.env.JOURNAL_ROOT;",
		'const journal = openJournal("example", { stateRoot: root });',
		"await journal.apply(",
		"  { previewId: process.env.JOURNAL_PREVIEW, canonicalInput: JSON.parse(process.env.JOURNAL_INPUT), providerArgs: JSON.parse(process.env.JOURNAL_INPUT), revision: process.env.JOURNAL_REVISION ?? null },",
		"  async (intent, sending) => { sending(); writeFileSync(`${root}/markers/${intent.runId}.marker`, \"\"); process.exit(9); },",
		");",
	].join("\n");

	test("a crash after the send mark: a fresh process cannot release the object on read-back absence, and a new write stays blocked", async () => {
		const p = comment(real());
		const crashed = Bun.spawn([process.execPath, "-e", SENDING_WORKER], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: root,
				JOURNAL_ROOT: root,
				JOURNAL_PREVIEW: p.previewId,
				JOURNAL_INPUT: JSON.stringify(COMMENT),
				JOURNAL_REVISION: "v7",
				JOURNAL_MODULE: path.resolve(import.meta.dir, "..", "scripts", "dispatch", "journal.ts"),
			},
		});
		const [stderr, code] = await Promise.all([new Response(crashed.stderr as ReadableStream).text(), crashed.exited]);
		expect([code, stderr]).toEqual([9, ""]);
		expect(markers()).toBe(1);
		const j = real();
		const open = j.openReceipts();
		expect(open.map((entry) => [entry.status, entry.send])).toEqual([["intent", "possible"]]);
		const runId = open[0]?.runId ?? "";
		expect(() => j.resolve(runId, { proof: "unchanged", basis: "readback-absent" })).toThrow(/evidence-insufficient/);
		expect(j.openReceipts()).toHaveLength(1);
		const again = { ...COMMENT, body: "again" };
		expect((await finish(spawnWorker(comment(j, again).previewId, "hold", "10", again))).lines.at(-1)).toBe("error write-blocked-open-receipt");
		expect(markers()).toBe(1);
		expect(j.resolve(runId, ok).status).toBe("completed");
		const after = { ...COMMENT, body: "after" };
		expect((await finish(spawnWorker(comment(j, after).previewId, "hold", "10", after))).lines.at(-1)).toBe("done completed");
		expect(markers()).toBe(2);
	});

	test("resolve refuses an in-flight apply while its holder is alive", async () => {
		const p = comment(real());
		const worker = spawnWorker(p.previewId, "barrier");
		await untilDispatching(worker);
		const j = real();
		const open = j.openReceipts();
		expect(open).toHaveLength(1);
		expect(() => j.resolve(open[0]?.runId ?? "", { proof: "unchanged", basis: "readback-absent" })).toThrow(/receipt-in-flight/);
		writeFileSync(path.join(root, "barrier"), "");
		expect(await worker.exited).toBe(0);
		expect(j.receipt(open[0]?.runId ?? "").status).toBe("completed");
	});

	test("two processes on different objects both complete: the meta-lock serialises transitions, not dispatch", async () => {
		const j = real();
		const a = comment(j);
		const b = comment(j, { issueKey: "PROJ-2", body: "b" });
		const first = spawnWorker(a.previewId, "barrier");
		await untilDispatching(first);
		const second = await finish(spawnWorker(b.previewId, "hold", "10", { issueKey: "PROJ-2", body: "b" }));
		expect(second.lines.at(-1)).toBe("done completed");
		writeFileSync(path.join(root, "barrier"), "");
		expect(await first.exited).toBe(0);
		expect(markers()).toBe(2);
		expect(listing("locks")).toEqual([]);
	});

	test("a receipt settled externally during dispatch is not overwritten: settle rereads under the lock", async () => {
		const p = comment(real());
		const worker = spawnWorker(p.previewId, "barrier");
		await untilDispatching(worker);
		const j = real();
		const open = j.openReceipts();
		const file = path.join(dir("receipts"), `${open[0]?.runId}.json`);
		const settledElsewhere = { ...(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>), status: "unknown" };
		writeFileSync(file, JSON.stringify(settledElsewhere), { mode: 0o600 });
		writeFileSync(path.join(root, "barrier"), "");
		const result = await drain(worker);
		expect(result.lines.at(-1)).toBe("error receipt-not-in-flight");
		expect((JSON.parse(readFileSync(file, "utf8")) as { status: string }).status).toBe("unknown");
	});

	test("a stale lock is never reclaimed automatically; unlock refuses a live holder and clears a dead one", async () => {
		const j = real();
		const identity = objectIdentity("issue.comment", COMMENT);
		const lockFile = path.join(dir("locks"), `${identity.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
		writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockId: "live", at: now }), { mode: 0o600 });
		await expect(applyOk(j, comment(j).previewId)).rejects.toThrow(/write-locked/);
		expect(() => j.unlock(identity)).toThrow(/lock-held/);
		writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_000, lockId: "dead", at: now }), { mode: 0o600 });
		await expect(applyOk(j, comment(j, { ...COMMENT, body: "2" }).previewId, { ...COMMENT, body: "2" })).rejects.toThrow(/write-locked/);
		j.unlock(identity);
		expect((await applyOk(j, comment(j, { ...COMMENT, body: "3" }).previewId, { ...COMMENT, body: "3" })).status).toBe("completed");
		expect(markers()).toBe(0);
	});
});
