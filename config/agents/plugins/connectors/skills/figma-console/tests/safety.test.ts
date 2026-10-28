// Production anchors on the shipped bytes (the packaged front door and an
// unmodified skill copy), plus source-script oracles that the process
// machine cannot express. Process proof of guards, journal, sessions and
// custody lives in journal.test.ts, session.test.ts and custody.test.ts.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, PLUGIN_ROOT, runBundle } from "../../../tests/harness.ts";
import { fenceScript, mutationScript, snapshotScript, validateWrite } from "../scripts/canvas.ts";
import { rejectFallback } from "../scripts/reads.ts";

const FILE = "disposablefixture123", USER = "1614063074302308556";
const SELECT = ["--select", "account=monash", "--select", `file=${FILE}`];
const INPUT = { nodeId: "7:285", text: "After", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16 };
const packaged = createBundle();
cpSync(path.join(PLUGIN_ROOT, "skills/figma-console"), path.join(packaged.skillsRoot, "figma-console"), { recursive: true });
const home = path.join(packaged.root, "home"), state = path.join(packaged.root, "state");
mkdirSync(home, { mode: 0o700 });
afterAll(() => { packaged.dispose(); });
const run = (argv: string[]) => runBundle(packaged, argv, { home, extraEnv: { XDG_STATE_HOME: state }, cwd: packaged.root });
const envelope = (stdout: string) => JSON.parse(stdout).result as { causeCode: string; data: Record<string, any> | null };
const READS = ["status", "read_node", "read_variables", "export_tokens", "read_file", "read_component", "analyze_variants", "lint", "audit_accessibility", "read_changes", "read_history", "screenshot", "session_status"];
const WRITES = ["create_text", "update_text", "create_variants", "create_tokens", "update_variable", "bind_fill", "session_start", "session_stop"];

test("the packaged front door exposes the closed catalogue and refuses raw execute, unphased writes and unadmitted input before any state or dependency", async () => {
	const schema = await run(["schema", "figma-console", ...SELECT]);
	expect([schema.code, schema.stderr]).toEqual([0, ""]);
	expect(envelope(schema.stdout).data).toMatchObject({ operations: { reads: READS, writes: WRITES }, live: false, unsupported: ["code_connect"], quarantined: ["generate_documentation", "check_design_parity"] });
	for (const [operation, input, expected] of [["figma_execute", { code: "figma.createFrame()" }, "operation-or-input-not-admitted"], ["update_text", INPUT, "write-phase-required"], ["read_node", { nodeId: "7:285", depth: 99 }, "operation-or-input-not-admitted"]] as const) {
		const refused = await run(["run", "figma-console", ...SELECT, operation, "--input", JSON.stringify(input)]);
		expect([operation, refused.code, refused.stderr, envelope(refused.stdout).data?.connectorCause]).toEqual([operation, 3, "", expected]);
		expect(refused.stdout).not.toContain("createFrame");
	}
	const status = await run(["auth", "status", "figma-console", ...SELECT]);
	expect(envelope(status.stdout).data).toMatchObject({ configured: false, connection: "not-probed", desktopAccount: "not-probed" });
	expect(existsSync(state)).toBe(false);
}, 60000);

test("shipped pins refuse a runtime closure other than the evaluated one, and an altered registry refuses before any call", async () => {
	const runtime = path.join(packaged.root, "runtime");
	mkdirSync(path.join(runtime, "figma-console-mcp/dist"), { recursive: true, mode: 0o700 });
	writeFileSync(path.join(runtime, "figma-console-mcp/dist/local.js"), "fixture-only\n", { mode: 0o600 });
	// An owned launcher, so the Node pin cannot refuse first on Bun's ownership.
	const nodeFile = path.join(packaged.root, "node");
	writeFileSync(nodeFile, `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o700 });
	const configured = await run(["auth", "configure", "figma-console", ...SELECT, "--input", JSON.stringify({ email: "fixture.user@example.test", userId: USER, itemId: "abcdefghijklmnopqrstuv1234", runtimeRoot: runtime, nodeFile })]);
	expect([configured.code, envelope(configured.stdout).data?.connectorCause]).toEqual([3, "runtime-pin-mismatch"]);
	expect(existsSync(path.join(state, "connectors/figma-console/monash", FILE, "profile.json"))).toBe(false);
	const tamper = async (name: string, change: (value: any) => void) => {
		const file = path.join(packaged.skillsRoot, "figma-console/config", name);
		const shipped = readFileSync(file, "utf8");
		const altered = JSON.parse(shipped);
		change(altered);
		writeFileSync(file, JSON.stringify(altered));
		try {
			const refused = await run(["run", "figma-console", ...SELECT, "read_node", "--input", JSON.stringify({ nodeId: "7:285" })]);
			expect([name, refused.code, envelope(refused.stdout).data?.connectorCause]).toEqual([name, 3, "registry-invalid"]);
		} finally { writeFileSync(file, shipped); }
	};
	await tamper("mcporter.json", (registry) => { registry.mcpServers["figma-console-local"].allowedTools.push("figma_create_child"); });
	await tamper("route.json", (route) => { route.ownedDaemon = false; });
}, 60000);

test("a stale cached 40 result and every fallback warning shape cannot qualify a fresh 24", () => {
	for (const stale of [{ source: "cache", cached: true, variables: [{ value: 40 }] }, { files: [], warnings: ["snapshot fallback"] }, { warning: "fallback" }, { nested: { stale: true } }, { source: "rest-fallback" }, { usedCache: 1 }]) {
		expect(() => rejectFallback(stale)).toThrow("stale-or-warning-result");
	}
	expect(() => rejectFallback({ cached: false, warnings: [], warning: null, variables: [{ value: 24 }] })).not.toThrow();
});

test("new tokens require explicit type-compatible scopes; no omitted/all-color fallback", () => {
	const token = { name: "space/stack", type: "FLOAT", value: 24, scopes: ["GAP"] };
	expect(validateWrite("create_tokens", { collection: "Fixture", tokens: [token] })).toBe(true);
	expect(validateWrite("create_tokens", { collection: "Fixture", tokens: [{ ...token, scopes: [] }] })).toBe(false);
	expect(validateWrite("create_tokens", { collection: "Fixture", tokens: [{ ...token, scopes: ["TEXT_FILL"] }] })).toBe(false);
	expect(validateWrite("update_text", { ...INPUT, code: "figma.root.remove()" })).toBe(false);
	expect(validateWrite("session_start", { force: true })).toBe(false);
});

test("guard removal is an observable negative control, not a duplicate expected-source assertion", async () => {
	const profile = { account: "monash", fileKey: FILE, userId: USER, email: "fixture@example.test", itemId: "abcdefghijklmnopqrstuv1234", runtimeRoot: "/fixture", nodeFile: "/fixture/node", nodeSha256: "0".repeat(64) };
	const baseline = { fileKey: FILE, source: "plugin-api-current", cached: false, variables: [], collections: [], node: { id: INPUT.nodeId, type: "TEXT", name: "text", characters: "Before", fontName: { family: "Inter", style: "Regular" }, fontSize: 16 } };
	const script = mutationScript(profile, "update_text", INPUT, baseline, "fc-00000000-0000-4000-8000-000000000001");
	const node = { ...baseline.node };
	const fences = new Set<string>();
	const figma = (fileKey: string, currentUser: unknown) => ({ fileKey, clientStorage: { async getAsync(key: string) { return fences.has(key) ? true : undefined; }, async setAsync(key: string) { fences.add(key); } }, get currentUser() { if (currentUser === undefined) throw new Error("permission absent"); return currentUser; }, variables: { async getLocalVariablesAsync() { return []; }, async getLocalVariableCollectionsAsync() { return []; } }, async getNodeByIdAsync() { return node; }, async loadFontAsync() {} });
	const execute = (code: string, target: ReturnType<typeof figma>) => new Function("figma", `return (async()=>{${code}})()`)(target);
	await expect(execute(script, figma("wrongfile", { id: USER }))).rejects.toThrow("connector:file-mismatch");
	await expect(execute(script, figma(FILE, undefined))).rejects.toThrow("connector:desktop-identity-unverified");
	await expect(execute(script, figma(FILE, { id: "999" }))).rejects.toThrow("connector:desktop-identity-mismatch");
	await expect(execute(snapshotScript(profile, INPUT, true), figma(FILE, { id: "999" }))).rejects.toThrow("connector:desktop-identity-mismatch");
	// An adjudication's fence stops this receipt's mutation before its effect.
	await execute(fenceScript(profile, INPUT, "fc-00000000-0000-4000-8000-000000000001"), figma(FILE, { id: USER }));
	await expect(execute(script, figma(FILE, { id: USER }))).rejects.toThrow("connector:fenced");
	expect(node.characters).toBe("Before");
	fences.clear();
	// Disable both the file guard and baseline comparison only in this mutant:
	// the oracle demonstrates the forbidden external outcome it protects.
	const mutant = script.replace('if (figma.fileKey !== expected.fileKey) throw new Error("connector:file-mismatch");', "").replace(/if\(stable\(await observe\(\)\)!==.*?throw new Error\("connector:baseline-changed"\);/, "");
	await execute(mutant, figma("wrongfile", { id: USER })); expect(node.characters).toBe("After");
}, 60000);
