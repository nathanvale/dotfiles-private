import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { notionMachine } from "./fixtures/notion-machine.ts";

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for Notion schema process proof");

test.skipIf(!official)("packaged schema reports full discovery and drift without admitting calls to new tools", async () => {
	const machine = notionMachine(["notion-fetch", "notion-fixture-new"]);
	try {
		const result = await machine.run(["schema", "notion", "--select", "account=personal"]);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		expect(result.stdout).not.toContain("SENTINEL_AMBIENT_NOTION");
		const data = result.envelope.result.data as { live: { tools: { name: string }[] }; comparison: { extraTools: string[]; missingTools: string[]; requiredKeyDrift: unknown[]; status: string }; availability: unknown };
		expect(data.live.tools.map((tool: { name: string }) => tool.name)).toEqual(["notion-fetch", "notion-fixture-new"]);
		expect(data.comparison.extraTools).toEqual(["notion-fixture-new"]);
		expect(data.comparison.missingTools).toHaveLength(43);
		expect(data.comparison.missingTools).toContain("notion-update-page");
		expect(data.comparison.requiredKeyDrift).toEqual([{ tool: "notion-fetch", added: [], removed: ["id"], declared: ["id"], live: [] }]);
		expect(data.comparison.status).toBe("drifted");
		expect(data.availability).toMatchObject({ toolListing: "observed", planAndPermissionAccess: "not-inspected" });
		expect(machine.calls).toEqual([]);
		expect(result.envelope.result.effects.completed).toContain("account-vault");
		expect(result.envelope.result.effects.completed).toContain("mcporter-vault-file");
		const cache = path.join(machine.state, "connectors/notion-mcporter/personal/cache");
		expect(readdirSync(cache).filter((name) => name.startsWith("schema-"))).toEqual([]);
		const registry = JSON.parse(readFileSync(path.join(machine.root, "plugin/skills/notion/config/mcporter.json"), "utf8"));
		expect(registry.mcpServers["notion-connectors"].allowedTools).toHaveLength(44);
		expect(existsSync(path.join(machine.home, ".mcporter/credentials.json"))).toBe(false);
		const refused = await machine.run(["run", "notion", "--select", "account=personal", "notion-fixture-new", "--input", "{}"]);
		expect([refused.code, refused.stderr, refused.envelope.result.data?.connectorCause]).toEqual([2, "", "operation-not-allowed"]);
		expect(machine.calls).toEqual([]);
	} finally { machine.dispose(); }
}, 180000);

test.skipIf(!official)("schema reports a partial vault preparation effect when an unsafe data root refuses", async () => {
	const machine = notionMachine(["notion-fetch"]);
	try {
		const account = path.join(machine.state, "connectors/notion-mcporter/personal");
		mkdirSync(account, { recursive: true, mode: 0o755 });
		const unsafe = path.join(account, "data");
		writeFileSync(unsafe, "SENTINEL_UNSAFE_VAULT");
		const result = await machine.run(["schema", "notion", "--select", "account=personal"]);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		expect(result.stdout).toContain("vault-root-invalid");
		expect(result.stdout).not.toContain("SENTINEL_UNSAFE_VAULT");
		expect(result.envelope.result.effects.completed).toContain("account-vault");
		expect(result.envelope.result.effects.completed).not.toContain("mcporter-vault-file");
		expect(result.envelope.result.effects.uncertain).toEqual([]);
		expect(readFileSync(unsafe, "utf8")).toBe("SENTINEL_UNSAFE_VAULT");
		expect(machine.calls).toEqual([]);
	} finally { machine.dispose(); }
}, 180000);
