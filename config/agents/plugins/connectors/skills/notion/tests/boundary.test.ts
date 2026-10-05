import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { notionMachine } from "./fixtures/notion-machine.ts";

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for Notion boundary process proof");
const SELECT = ["--select", "account=personal"];
const value = { page_id: "page-1", command: "replace_content", new_str: "Requested value", _verify: { before: { tool: "notion-fetch", args: { id: "page-1" } }, after: { tool: "notion-fetch", args: { id: "page-1" } }, contains: ["Requested value"] } };
const INPUT = ["--input", JSON.stringify(value)];
const writeArgs = ["run", "notion", ...SELECT, "notion-update-page", ...INPUT];

test.skipIf(!official)("recover refuses malformed accounts before creating account state even without the manifest pattern", async () => {
	const machine = notionMachine(["notion-fetch"]);
	try {
		const manifestFile = path.join(machine.root, "plugin/skills/notion/config/manifest.json");
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		delete manifest.selectors.account.pattern;
		writeFileSync(manifestFile, JSON.stringify(manifest));
		const result = await machine.run(["recover", "notion", "--select", "account=Personal-SENTINEL"]);
		expect([result.code, result.stderr, result.envelope.result.data?.connectorCause]).toEqual([2, "", "account-invalid"]);
		expect(result.stdout).not.toContain("Personal-SENTINEL");
		expect(existsSync(path.join(machine.state, "connectors"))).toBe(false);
		expect(machine.calls).toEqual([]);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("changed registries and legacy HOME caches refuse before dependency or provider effects", async () => {
	const machine = notionMachine(["notion-fetch"]);
	try {
		const file = path.join(machine.root, "plugin/skills/notion/config/mcporter.json");
		const original = readFileSync(file, "utf8");
		const registry = JSON.parse(original);
		registry.mcpServers["notion-connectors"].allowedTools.push("notion-SENTINEL_UNADMITTED");
		writeFileSync(file, JSON.stringify(registry));
		const invalid = await machine.run(["schema", "notion", ...SELECT]);
		expect([invalid.code, invalid.stderr, invalid.envelope.result.data?.connectorCause]).toEqual([4, "", "registry-invalid"]);
		expect(invalid.stdout).not.toContain("SENTINEL_UNADMITTED");
		writeFileSync(file, original);
		mkdirSync(path.join(machine.home, ".mcporter/notion-connectors"), { recursive: true });
		const legacy = await machine.run(["schema", "notion", ...SELECT]);
		expect([legacy.code, legacy.stderr, legacy.envelope.result.data?.connectorCause]).toEqual([3, "", "legacy-cache-present"]);
		expect(existsSync(path.join(machine.state, "connectors"))).toBe(false);
		expect(machine.calls).toEqual([]);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("stale and expired previews, live locks and corrupt journals refuse without a write", async () => {
	const machine = notionMachine(["notion-fetch", "notion-update-page"]);
	try {
		const journal = path.join(machine.state, "connectors/notion/personal/journal");
		const preview = await machine.run([...writeArgs, "--preview"]);
		const id = preview.envelope.result.data?.previewId as string;
		machine.setText("Changed outside the preview");
		const stale = await machine.run([...writeArgs, "--apply", id]);
		expect([stale.code, stale.stderr, stale.envelope.result.data?.connectorCause]).toEqual([3, "", "preview-stale"]);
		machine.setText("Original page");
		const file = path.join(journal, "previews", `${id}.json`);
		const stored = JSON.parse(readFileSync(file, "utf8"));
		stored.expiresAt = Date.now() - 1000;
		writeFileSync(file, JSON.stringify(stored));
		const expired = await machine.run([...writeArgs, "--apply", id]);
		expect([expired.code, expired.stderr, expired.envelope.result.data?.connectorCause]).toEqual([3, "", "preview-expired"]);
		const fresh = await machine.run([...writeArgs, "--preview"]);
		const freshId = fresh.envelope.result.data?.previewId as string;
		const lockFile = path.join(journal, "locks", `${createHash("sha256").update("notion-account:personal").digest("hex")}.lock`);
		writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
		const locked = await machine.run([...writeArgs, "--apply", freshId]);
		expect([locked.code, locked.stderr, locked.envelope.result.data?.connectorCause]).toEqual([3, "", "write-locked"]);
		const unlock = await machine.run(["recover", "notion", ...SELECT, "--run", freshId, "--unlock"]);
		expect([unlock.code, unlock.stderr, unlock.envelope.result.data?.connectorCause]).toEqual([3, "", "holder-alive"]);
		expect(existsSync(lockFile)).toBe(true);
		writeFileSync(path.join(journal, "receipts/corrupt.json"), "SENTINEL_CORRUPT_RECEIPT", { mode: 0o600 });
		const corrupt = await machine.run(["recover", "notion", ...SELECT]);
		expect([corrupt.code, corrupt.stderr, corrupt.envelope.result.data?.connectorCause]).toEqual([3, "", "journal-corrupt"]);
		expect(corrupt.stdout).not.toContain("SENTINEL_CORRUPT_RECEIPT");
		expect(machine.calls.filter((call) => call.tool === "notion-update-page")).toEqual([]);
	} finally { machine.dispose(); }
}, 180000);
