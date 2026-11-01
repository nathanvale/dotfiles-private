import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, PLUGIN_ROOT, runBundle } from "../../../tests/harness.ts";

const ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_ID = "22222222-2222-2222-2222-222222222222";
const SELECT = ["--select", "profile=default"];
// CI supplies the existing independently fetched official release fixture.
// Local qualification may instead select an installed, integrity-checked copy.
// Without either fixture these hosted-transport tests are explicitly skipped;
// a source-only run then proves neither the protocol nor process behavior.
const selectedRelease = process.env.CONNECTORS_NOTEBOOKLM_RELEASE;
const officialRelease = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
const processTest = test.skipIf(!selectedRelease && !officialRelease);
const args = (value: unknown): string[] => ["--input", JSON.stringify(value)];
function machine() {
	const release = selectedRelease ?? officialRelease;
	if (!release) throw new Error("NotebookLM protocol proof requires the pinned official MCPorter release fixture");
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	const bin = path.join(bundle.root, "path");
	mkdirSync(home); mkdirSync(bin);
	cpSync(path.join(PLUGIN_ROOT, "skills/notebooklm/config"), path.join(bundle.skillsRoot, "notebooklm/config"), { recursive: true });
	const current = path.join(state, "connectors/mcporter/current");
	mkdirSync(current, { recursive: true, mode: 0o700 });
	for (const file of ["mcporter", "provenance.json"]) cpSync(path.join(release, file), path.join(current, file));
	chmodSync(path.join(current, "mcporter"), 0o700); chmodSync(path.join(current, "provenance.json"), 0o600);
	writeFileSync(path.join(current, "release.json"), '{"version":"0.14.0"}', { mode: 0o600 });
	symlinkSync(process.execPath, path.join(bin, "bun"));
	writeFileSync(path.join(bin, "notebooklm-mcp"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "fixtures/server.ts")}'\n`, { mode: 0o700 });
	const stateFile = path.join(home, "fixture.json");
	const change = (fields: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify({ title: "Synthetic notebook", sourceTitle: "Synthetic source", mode: "normal", auth: "configured", version: "0.15.8", ...(existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}), ...fields }));
	change({});
	return {
		bundle, home, state, change,
		calls: (): { name: string; args: Record<string, unknown>; profile: string; debug: string; ambient: boolean }[] => existsSync(path.join(home, "calls.jsonl")) ? readFileSync(path.join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
		async run(argv: string[]) {
			const result = await runBundle(bundle, argv, { home, binDir: bin, extraEnv: { XDG_STATE_HOME: state, PRIVATE_SENTINEL: "SENTINEL_AMBIENT_SECRET", NOTEBOOKLM_MCP_DEBUG: "true" }, timeoutMs: 90000 });
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			expect(result.stdout).not.toContain("SENTINEL_");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.envelopeVersion).toBe(2);
			expect(envelope.result.exitCode).toBe(result.code);
			return { ...result, result: envelope.result };
		},
		dispose: () => bundle.dispose(),
	};
}
processTest("readiness projects safe status without enumerating and scrubs the vendor environment", async () => {
	const m = machine(); try {
		const status = await m.run(["auth", "status", "notebooklm", ...SELECT]);
		expect([status.code, status.result.data.result]).toEqual([0, { version: "0.15.8", update_available: false, auth_status: "configured", status: "ready", statusMaxAgeSeconds: 30, schemaQualifiedVersion: "0.15.8" }]);
		expect(m.calls()).toEqual([{ name: "server_info", args: {}, profile: "default", debug: "false", ambient: false }]);
	} finally { m.dispose(); }
});
processTest("all seven read operations expose only their qualified fields", async () => {
	const m = machine(); try {
		const cases = [
			["notebook_list", { max_results: 5 }, { notebooks: [{ id: ID, title: "Synthetic notebook" }], returned: 1 }],
			["notebook_get", { notebook_id: ID }, { notebook: { id: ID, title: "Synthetic notebook", source_count: 1 }, sources: [{ id: SOURCE_ID, title: "Synthetic source" }] }],
			["notebook_describe", { notebook_id: ID }, { summary: "Synthetic summary", suggested_topics: [{ question: "Synthetic question", prompt: "Synthetic prompt" }] }],
			["source_describe", { source_id: SOURCE_ID }, { summary: "Source summary", keywords: ["Synthetic"] }],
			["source_get_content", { source_id: SOURCE_ID }, { title: "Synthetic source", content: "Synthetic content", source_type: "text", char_count: 17 }],
			["studio_status", { notebook_id: ID }, { artifacts: [{ artifact_id: SOURCE_ID, title: "Synthetic audio", type: "audio", status: "completed" }] }],
		] satisfies [string, Record<string, unknown>, Record<string, unknown>][];
		for (const [name, input, expected] of cases) {
			const read = await m.run(["run", "notebooklm", ...SELECT, name, ...args(input)]);
			expect([read.code, read.result.data.result]).toEqual([0, expected]);
		}
		expect(m.calls()).toHaveLength(12);
	} finally { m.dispose(); }
}, 180000);
processTest("unsafe read actions, missing targets and unqualified effects refuse before starting the vendor", async () => {
	const m = machine(); try {
		const rows = [
			["studio_status", { notebook_id: ID, action: "rename", new_title: "Hidden write" }, 4, "input-invalid"],
			["studio_status", { notebook_id: ID, include_details: true }, 4, "input-invalid"],
			["notebook_get", {}, 4, "input-invalid"],
			["notebook_get", { notebook_id: "a title" }, 4, "input-invalid"],
			["notebook_list", {}, 4, "input-invalid"],
			["notebook_list", { max_results: 21 }, 4, "input-invalid"],
			["save_auth_tokens", { cookies: "SENTINEL_INPUT_SECRET" }, 3, "auth-tool-forbidden"],
			["notebook_query", { notebook_id: ID, query: "query" }, 3, "capability-not-qualified"],
			["notebook_rename", { notebook_id: ID, new_title: "New" }, 3, "capability-not-qualified"],
		] satisfies [string, Record<string, unknown>, number, string][];
		for (const [name, input, code, cause] of rows) {
			const result = await m.run(["run", "notebooklm", ...SELECT, name, ...args(input)]);
			expect([result.code, result.result.data.connectorCause]).toEqual([code, cause]);
		}
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});
processTest("degraded authentication and unqualified versions block content without listing", async () => {
	const m = machine(); try {
		for (const auth of ["unverified", "stale", "not_configured", "error"]) {
			m.change({ auth });
			const result = await m.run(["run", "notebooklm", ...SELECT, "notebook_get", ...args({ notebook_id: ID })]);
			expect([result.code, result.result.data.connectorCause]).toEqual([3, "authentication-unready"]);
		}
		m.change({ auth: "configured", version: "99.0.0" });
		const version = await m.run(["run", "notebooklm", ...SELECT, "notebook_get", ...args({ notebook_id: ID })]);
		expect(version.result.data.connectorCause).toBe("runtime-version-unqualified");
		expect(m.calls().map((call) => call.name)).toEqual(Array(5).fill("server_info"));
	} finally { m.dispose(); }
}, 180000);
processTest("malformed replies and wrong notebook identities withhold results", async () => {
	const m = machine(); try {
		for (const [mode, cause] of [["malformed", "projection-shape-mismatch"], ["wrong-target", "target-mismatch"], ["expired", "authentication-expired"]]) {
			m.change({ mode });
			const result = await m.run(["run", "notebooklm", ...SELECT, "notebook_get", ...args({ notebook_id: ID })]);
			expect([result.code, result.result.data.connectorCause]).toEqual([3, cause]);
		}
	} finally { m.dispose(); }
}, 180000);
processTest("live schema qualification matches independent synthetic vendor schemas", async () => {
	const m = machine(); try {
		const result = await m.run(["schema", "notebooklm", ...SELECT]);
		expect([result.code, result.result.data.compatible, result.result.data.operations.length]).toEqual([0, true, 53]);
		expect(m.calls()).toHaveLength(0);
	} finally { m.dispose(); }
});
processTest("registry widening refuses before any vendor process", async () => {
	const m = machine(); try {
		const file = path.join(m.bundle.skillsRoot, "notebooklm/config/mcporter.json");
		const registry = JSON.parse(readFileSync(file, "utf8")); registry.mcpServers["notebooklm-connectors"].allowedTools.push("save_auth_tokens"); writeFileSync(file, JSON.stringify(registry));
		const result = await m.run(["auth", "status", "notebooklm", ...SELECT]);
		expect([result.code, result.result.data.connectorCause]).toEqual([3, "registry-invalid"]);
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

processTest("renames and recovery refuse without starting the vendor or creating journal state", async () => {
	const m = machine(); try {
		for (const name of ["notebook_rename", "source_rename"]) {
			const input = args({ notebook_id: ID, ...(name === "source_rename" ? { source_id: SOURCE_ID } : {}), new_title: "Requested title" });
			for (const phase of [[], ["--preview"], ["--apply", "lp-11111111-1111-1111-1111-111111111111"]]) {
				const result = await m.run(["run", "notebooklm", ...SELECT, name, ...input, ...phase]);
				expect([result.code, result.result.data.connectorCause]).toEqual([3, phase.length === 0 ? "capability-not-qualified" : "adapter-has-no-writes"]);
			}
		}
		for (const recovery of [[], ["--run", "lr-11111111-1111-1111-1111-111111111111"], ["--run", "lr-11111111-1111-1111-1111-111111111111", "--unlock"], ["--run", "lr-11111111-1111-1111-1111-111111111111", "--adjudicate", ...args({})]]) {
			const result = await m.run(["recover", "notebooklm", ...SELECT, ...recovery]);
			expect([result.code, result.result.data.connectorCause]).toEqual([3, "adapter-has-no-writes"]);
		}
		expect(m.calls()).toEqual([]);
		expect(existsSync(path.join(m.state, "connectors/notebooklm"))).toBe(false);
	} finally { m.dispose(); }
});
processTest("capability discovery admits exactly seven safe operations and withholds both renames", async () => {
	const m = machine(); try {
		const result = await m.run(["run", "notebooklm", ...SELECT, "capabilities"]);
		const operations = result.result.data.operations;
		expect(operations).toHaveLength(53);
		expect(operations.filter((item: { admission: string }) => item.admission === "admitted").map((item: { name: string }) => item.name).sort()).toEqual(["notebook_describe", "notebook_get", "notebook_list", "server_info", "source_describe", "source_get_content", "studio_status"]);
		expect(operations.filter((item: { name: string }) => ["notebook_rename", "source_rename"].includes(item.name)).map((item: { name: string; admission: string; effect: string }) => [item.name, item.admission, item.effect])).toEqual([["notebook_rename", "blocked", "write"], ["source_rename", "blocked", "write"]]);
		const registry = JSON.parse(readFileSync(path.join(m.bundle.skillsRoot, "notebooklm/config/mcporter.json"), "utf8"));
		expect(registry.imports).toEqual([]);
		expect(registry.mcpServers["notebooklm-connectors"].allowedTools.slice().sort()).toEqual(["notebook_describe", "notebook_get", "notebook_list", "server_info", "source_describe", "source_get_content", "studio_status"]);
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});
