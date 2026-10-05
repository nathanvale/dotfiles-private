// ADR 0005: Figma's catalog through the packaged front door. Every process is
// the compiled bin/connectors of a verified substituted plugin copy
// (fixtures/figma-machine.ts) under a loopback-only sandbox; MCPorter is the
// official 0.14.0 release the front door verifies, and a hostile mcporter sits
// first on PATH. The hosted endpoint is replaced by a stateful loopback stub
// that advertises the whole documented catalog. Expected values are
// test-owned literals. Substituted-source packaged process proof only: no
// Figma account, canvas, upload, or Weave credit is reached.
//
// Each test names the behavior it protects and one wrong behavior that fails it:
// - admission: the front door reaches exactly the admitted tools. Fails if a
//   blocked tool reaches the stub or the registry widens.
// - writes: every admitted write sends once, after a preview, and completes
//   only on read-back. Fails if a write leaves without a preview, twice, or is
//   reported applied while read-back cannot find it.
// - Weave cost: a run acknowledges only a cost Figma quoted. Fails if an
//   unquoted or different acknowledgedCost reaches the stub.
// - unknown effects: an unreplied write blocks its object and settles only on
//   found evidence; a partial-view write is never settled unchanged.
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FIGMA_ENDPOINT } from "../scripts/endpoint.ts";
import { createBundle, runBundle, runInteractiveBundle } from "../../../tests/harness.ts";
import { heldMcporter, ownedVault } from "../../../tests/fixtures/native-oauth.ts";
import { type Envelope, FigmaMachine, OFFICIAL_MCPORTER } from "./fixtures/figma-machine.ts";
import { type FigmaStub, startFigmaStub, UPLOAD_CAPABILITY } from "./fixtures/figma-stub.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for the packaged Figma proof");

// Independent oracles, restated from ADR 0005 and Figma's catalog.
const HOSTED_ENDPOINT = "https://mcp.figma.com/mcp";
const ADMITTED_READS = ["whoami", "get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "download_assets", "get_motion_context", "get_figjam", "get_libraries", "search_design_system", "get_code_connect_map", "get_code_connect_suggestions", "get_context_for_code_connect", "list_generative_plugins", "get_generative_plugin", "list_shaders", "get_shader", "list_file_shaders", "weave_list_tools", "weave_get_tool_inputs", "weave_get_tool_run_output"];
const ADMITTED_WRITES = ["add_code_connect_map", "send_code_connect_mappings", "create_generative_plugin", "create_shader", "update_generative_plugin", "update_shader", "create_new_file", "generate_diagram", "use_figma", "upload_assets", "weave_cancel_tool_run", "weave_run_tool"];
const NOT_ADMITTED = ["generate_figma_design", "weave_upload_asset"];
const AMBIENT_SENTINEL = "SENTINEL_AMBIENT_FIGMA_TOKEN";

interface Context {
	readonly machine: FigmaMachine;
	readonly stub: FigmaStub;
	run(argv: string[]): Promise<{ code: number; result: Envelope["result"] }>;
}

async function withFigma(body: (context: Context) => Promise<void>): Promise<void> {
	const stub = startFigmaStub();
	const machine = new FigmaMachine(stub.url);
	const outputs: string[] = [];
	const context: Context = {
		machine, stub,
		async run(argv) {
			const run = await machine.run(argv);
			outputs.push(run.stdout, run.stderr);
			expect({ argv, stderr: run.stderr }).toEqual({ argv, stderr: "" });
			return { code: run.code, result: run.envelope.result };
		},
	};
	try {
		// The first command bootstraps the verified MCPorter; later ones read.
		expect((await machine.run(["schema", "figma"])).code).toBe(0);
		await body(context);
		for (const surface of [...outputs, JSON.stringify(stub.calls), machine.stateText()]) {
			expect(surface).not.toContain(AMBIENT_SENTINEL);
			expect(surface).not.toContain(UPLOAD_CAPABILITY);
		}
		expect(machine.hostileCalls()).toEqual([]);
	} finally {
		stub.stop();
		machine.dispose();
	}
}

const station = (run: { code: number; result: Envelope["result"] }) => ({ code: run.code, cause: run.result.causeCode, connectorCause: run.result.data?.connectorCause ?? null });
const callsOf = (stub: FigmaStub, tool: string) => stub.calls.filter((call) => call.tool === tool);
const input = (value: unknown) => ["--input", JSON.stringify(value)];

async function previewApply(run: Context["run"], operation: string, value: unknown) {
	const preview = await run(["run", "figma", operation, ...input(value), "--preview"]);
	expect([operation, station(preview)]).toEqual([operation, { code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null }]);
	return run(["run", "figma", operation, ...input(value), "--apply", preview.result.data?.previewId as string]);
}

// Fails if the shipped tree, or the front door compiled from it, could reach
// any origin but Figma's. Routine tests substitute this leaf in a copy.
test("the shipped Figma adapter names only the hosted endpoint", () => {
	expect(FIGMA_ENDPOINT).toBe(HOSTED_ENDPOINT);
	expect(readFileSync(path.resolve(import.meta.dir, "..", "..", "..", "bin", "connectors")).includes(HOSTED_ENDPOINT)).toBe(true);
});

test.skipIf(!OFFICIAL_MCPORTER)("schema and reads reach exactly the admitted tools; blocked and write-shaped requests send nothing", async () => {
	await withFigma(async ({ run, stub }) => {
		const schema = await run(["schema", "figma"]);
		expect(station(schema)).toEqual({ code: 0, cause: "SUCCESS_UNCHANGED", connectorCause: null });
		// The live listing went through MCPorter's allow-list from a stub that
		// advertises all 35 catalog tools.
		const live = ((schema.result.data?.schema?.tools ?? []) as { name: string }[]).map((tool) => tool.name).sort();
		expect(live).toEqual([...ADMITTED_READS, ...ADMITTED_WRITES].sort());
		expect(live).toHaveLength(33);
		expect([...(schema.result.data?.allowedTools as string[])].sort()).toEqual(live);

		const whoami = await run(["run", "figma", "whoami"]);
		expect(station(whoami)).toEqual({ code: 0, cause: "SUCCESS_UNCHANGED", connectorCause: null });
		expect(JSON.stringify(whoami.result.data)).toContain("team::1");
		const metadata = await run(["run", "figma", "get_metadata", ...input({ fileKey: "FileKeyExisting01", nodeId: "1:1" })]);
		expect(station(metadata)).toEqual({ code: 0, cause: "SUCCESS_UNCHANGED", connectorCause: null });
		expect(callsOf(stub, "get_metadata")).toEqual([{ tool: "get_metadata", args: { fileKey: "FileKeyExisting01", nodeId: "1:1" } }]);

		const before = stub.calls.length;
		for (const tool of [...NOT_ADMITTED, "create_design_system_rules", "get_figma_skill"]) {
			expect([tool, station(await run(["run", "figma", tool]))]).toEqual([tool, { code: 2, cause: "USAGE_OPERATION_UNKNOWN", connectorCause: "operation-not-allowed" }]);
		}
		expect(station(await run(["run", "figma", "use_figma", ...input({ fileKey: "FileKeyExisting01" })]))).toEqual({ code: 2, cause: "USAGE_ADAPTER_REFUSED", connectorCause: "write-phase-required" });
		expect(station(await run(["run", "figma", "whoami", "--preview"]))).toEqual({ code: 2, cause: "USAGE_ADAPTER_REFUSED", connectorCause: "read-takes-no-phase" });
		expect(station(await run(["run", "figma", "use_figma", ...input({ fileKey: "FileKeyExisting01", code: "x", description: "d" }), "--preview"]))).toEqual({ code: 4, cause: "SCHEMA_ADAPTER_REFUSED", connectorCause: "input-invalid" });
		expect(stub.calls.length).toBe(before);
	});
}, 120_000);

// Writes in an order where each one's precondition was made by an earlier one.
// The stub numbers new objects 0001 onward in creation order. 13 flows cover
// the 12 admitted write tools: generate_diagram runs twice (new board, then
// into an existing file). An input given as a function receives the machine's
// asset directory.
const WRITES: { operation: string; input: unknown | ((assets: string) => unknown); effects: string[] }[] = [
	{ operation: "add_code_connect_map", input: { fileKey: "FileKeyExisting01", nodeId: "1:1", source: "src/Button.tsx", componentName: "Button", label: "React" }, effects: ["figma-node:FileKeyExisting01:1:1"] },
	{ operation: "send_code_connect_mappings", input: { fileKey: "FileKeyExisting01", nodeId: "1:2", mappings: [{ nodeId: "1:3", componentName: "Card", source: "src/Card.tsx", label: "React" }] }, effects: ["figma-node:FileKeyExisting01:1:2"] },
	{ operation: "create_generative_plugin", input: { name: "Squares", description: "draws squares", planKey: "team::1" }, effects: ["gp-0001"] },
	{ operation: "update_generative_plugin", input: { id: "gp-0001", commitMessage: "more squares", files: [{ path: "code.ts", content: "figma.closePlugin()" }] }, effects: ["figma-generative-plugin:gp-0001"] },
	{ operation: "create_shader", input: { name: "Glow", description: "a glow", planKey: "team::1", kind: "effect" }, effects: ["sh-0002"] },
	{ operation: "update_shader", input: { id: "sh-0002", commitMessage: "brighter", kind: "effect" }, effects: ["figma-shader:sh-0002"] },
	{ operation: "create_new_file", input: { fileName: "Fixture file", planKey: "team::1", editorType: "design" }, effects: ["FileKeyNewFile0003"] },
	{ operation: "generate_diagram", input: { name: "Flow", mermaidSyntax: "flowchart LR\n  A --> B", planKey: "team::1" }, effects: ["BoardKeyNewOne0004"] },
	{ operation: "generate_diagram", input: { name: "Second flow", mermaidSyntax: "flowchart LR\n  C --> D", fileKey: "FileKeyExisting01" }, effects: ["FileKeyExisting01"] },
	{ operation: "use_figma", input: { fileKey: "FileKeyExisting01", code: 'add("Hero banner")', description: "add a banner", verify: { tool: "get_metadata", nodeId: "0:1", contains: ["Hero banner"] } }, effects: ["figma-file:FileKeyExisting01"] },
	{ operation: "upload_assets", input: (assets: string) => ({ fileKey: "FileKeyExisting01", currentPageId: "0:1", assets: [{ path: path.join(assets, "hero.png"), contentType: "image/png" }] }), effects: ["1:4"] },
	{ operation: "weave_run_tool", input: { recipeId: "recipe-1", inputs: [{ nodeId: "prompt", value: "a cat" }] }, effects: ["run-0006"] },
	{ operation: "weave_cancel_tool_run", input: { recipeId: "recipe-1", runIds: ["run-0006"] }, effects: ["run-0006"] },
];

test.skipIf(!OFFICIAL_MCPORTER)("every admitted write sends once after its preview and applies only on read-back", async () => {
	await withFigma(async ({ run, stub, machine }) => {
		expect([WRITES.length, new Set(WRITES.map((write) => write.operation)).size]).toEqual([13, 12]);
		expect([...new Set(WRITES.map((write) => write.operation))].sort()).toEqual([...ADMITTED_WRITES].sort());
		const assets = machine.assets({ "hero.png": "PNG-HERO" });
		for (const write of WRITES) {
			const sentBefore = callsOf(stub, write.operation).length;
			const value = typeof write.input === "function" ? write.input(assets) : write.input;
			const applied = await previewApply(run, write.operation, value);
			expect([write.operation, station(applied)]).toEqual([write.operation, { code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null }]);
			expect([write.operation, (applied.result.data?.receipt?.effects as { id: string }[]).map((effect) => effect.id)]).toEqual([write.operation, write.effects]);
			expect([write.operation, callsOf(stub, write.operation).length - sentBefore]).toEqual([write.operation, 1]);
		}
		// use_figma's verify key is the adapter's own read-back; Figma never sees it.
		expect(Object.keys(callsOf(stub, "use_figma")[0]?.args ?? {}).sort()).toEqual(["code", "description", "fileKey"]);
		expect(((await run(["recover", "figma"])).result.data?.receipts as unknown[]).length).toBe(0);
	});
}, 300_000);

test.skipIf(!OFFICIAL_MCPORTER)("a preview applies once, with its identical input, and a present value is never rewritten", async () => {
	await withFigma(async ({ run, stub }) => {
		const value = { fileKey: "FileKeyExisting01", nodeId: "1:1", source: "src/Button.tsx", componentName: "Button", label: "React" };
		const preview = await run(["run", "figma", "add_code_connect_map", ...input(value), "--preview"]);
		const previewId = preview.result.data?.previewId as string;
		expect(station(await run(["run", "figma", "add_code_connect_map", ...input({ ...value, label: "Vue" }), "--apply", previewId]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-input-mismatch" });
		expect(station(await run(["run", "figma", "add_code_connect_map", ...input(value), "--apply", previewId]))).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		expect(station(await run(["run", "figma", "add_code_connect_map", ...input(value), "--apply", previewId]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-consumed" });
		expect(station(await run(["run", "figma", "add_code_connect_map", ...input(value), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "already-present" });
		expect(callsOf(stub, "add_code_connect_map")).toHaveLength(1);
	});
}, 120_000);

test.skipIf(!OFFICIAL_MCPORTER)("a Weave run acknowledges a quoted cost once, refusing reuse through future and existing previews", async () => {
	await withFigma(async ({ run, stub }) => {
		stub.weaveCost = 3;
		const value = { recipeId: "recipe-1", inputs: [{ nodeId: "prompt", value: "a cat" }] };
		const quoted = await previewApply(run, "weave_run_tool", value);
		expect(station(quoted)).toEqual({ code: 3, cause: "DOMAIN_RUN_FAILED_RECORDED", connectorCause: "cost-confirmation-required" });
		expect(quoted.result.data?.quote).toEqual({ status: "cost_confirmation_required", cost: 3 });
		expect(callsOf(stub, "weave_run_tool").map((call) => call.args.acknowledgedCost)).toEqual([undefined]);
		for (const cost of [5, 0]) expect(station(await run(["run", "figma", "weave_run_tool", ...input({ ...value, acknowledgedCost: cost }), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "cost-not-quoted" });
		expect(station(await run(["run", "figma", "weave_run_tool", ...input({ recipeId: "recipe-1", acknowledgedCost: 3 }), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "cost-not-quoted" });
		const paid = { ...value, acknowledgedCost: 3 };
		const first = await run(["run", "figma", "weave_run_tool", ...input(paid), "--preview"]);
		const second = await run(["run", "figma", "weave_run_tool", ...input(paid), "--preview"]);
		for (const preview of [first, second]) expect(station(preview)).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null });
		const ran = await run(["run", "figma", "weave_run_tool", ...input(paid), "--apply", first.result.data?.previewId as string]);
		expect(station(ran)).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		expect(ran.result.data?.receipt?.status).toBe("completed");
		expect(station(await run(["run", "figma", "weave_run_tool", ...input(paid), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "cost-not-quoted" });
		expect(station(await run(["run", "figma", "weave_run_tool", ...input(paid), "--apply", second.result.data?.previewId as string]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "cost-not-quoted" });
		expect(callsOf(stub, "weave_run_tool").map((call) => call.args.acknowledgedCost)).toEqual([undefined, 3]);
	});
}, 120_000);

// A terminal run cannot become CANCELED. Refuse the mixed set before sending
// a cancellation that can no longer meet the every-named-run read-back rule.
test.skipIf(!OFFICIAL_MCPORTER)("cancellation previews refuse any terminal run alongside a running run before sending a write", async () => {
	await withFigma(async ({ run, stub }) => {
		const started = await previewApply(run, "weave_run_tool", { recipeId: "recipe-1", numberOfRuns: 2 });
		expect(station(started)).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		expect((started.result.data?.receipt?.effects as { id: string }[]).map((effect) => effect.id)).toEqual(["run-0001", "run-0002"]);
		stub.finishRun("run-0001", "FAILED");
		const before = callsOf(stub, "weave_cancel_tool_run").length;
		for (const runIds of [["run-0"], ["run-0", "run-0002"], ["run-0001", "run-0002"]]) {
			const preview = await run(["run", "figma", "weave_cancel_tool_run", ...input({ recipeId: "recipe-1", runIds }), "--preview"]);
			expect([runIds, station(preview)]).toEqual([runIds, { code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "runs-finished" }]);
			expect(preview.result.data?.previewId).toBeUndefined();
		}
		expect(callsOf(stub, "weave_cancel_tool_run").length).toBe(before);
		const canceled = await previewApply(run, "weave_cancel_tool_run", { recipeId: "recipe-1", runIds: ["run-0002"] });
		expect(station(canceled)).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		expect(canceled.result.data?.receipt?.status).toBe("completed");
		expect(station(await run(["run", "figma", "weave_cancel_tool_run", ...input({ recipeId: "recipe-1", runIds: ["run-0002"] }), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "runs-finished" });
		expect(callsOf(stub, "weave_cancel_tool_run").map((call) => call.args.runIds)).toEqual([["run-0002"]]);
	});
}, 120_000);

test.skipIf(!OFFICIAL_MCPORTER)("an unreplied write blocks its object and settles only on found evidence", async () => {
	await withFigma(async ({ run, stub }) => {
		const value = { fileKey: "FileKeyExisting01", nodeId: "1:1", source: "src/Button.tsx", componentName: "Button", label: "React" };
		// A request whose effect landed before the failed reply is found at once.
		stub.failNext = { tool: "add_code_connect_map", skipEffect: false };
		expect(station(await previewApply(run, "add_code_connect_map", { ...value, nodeId: "1:5" }))).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		// One that has not landed yet stays unknown until read-back finds it.
		stub.failNext = { tool: "add_code_connect_map", skipEffect: true };
		const unknown = await previewApply(run, "add_code_connect_map", value);
		expect(station(unknown)).toEqual({ code: 3, cause: "DOMAIN_RUN_EFFECT_UNKNOWN", connectorCause: null });
		const runId = unknown.result.data?.runId as string;
		expect(((await run(["recover", "figma"])).result.data?.receipts as { runId: string }[]).map((receipt) => receipt.runId)).toEqual([runId]);
		expect(station(await run(["run", "figma", "add_code_connect_map", ...input({ ...value, label: "Vue" }), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "object-blocked" });
		expect(station(await run(["recover", "figma", "--run", runId, "--adjudicate", ...input(value)]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "evidence-insufficient" });
		stub.landMapping("FileKeyExisting01", "1:1", "Button", "src/Button.tsx");
		const settled = await run(["recover", "figma", "--run", runId, "--adjudicate", ...input(value)]);
		expect(station(settled)).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null });
		expect(settled.result.data?.receipt?.status).toBe("completed");

		const other = { ...value, nodeId: "1:4", componentName: "Badge" };
		stub.failNext = { tool: "add_code_connect_map", skipEffect: true };
		const lost = await previewApply(run, "add_code_connect_map", other);
		expect(station(lost)).toEqual({ code: 3, cause: "DOMAIN_RUN_EFFECT_UNKNOWN", connectorCause: null });
		expect(station(await run(["recover", "figma", "--run", lost.result.data?.runId as string, "--adjudicate", ...input(other)]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "evidence-insufficient" });
		expect(callsOf(stub, "add_code_connect_map")).toHaveLength(3);
	});
}, 120_000);

test.skipIf(!OFFICIAL_MCPORTER)("use_figma succeeds only when its declared read-back shows the change, and never settles unchanged", async () => {
	await withFigma(async ({ run, stub }) => {
		const value = { fileKey: "FileKeyExisting01", code: 'add("Footer")', description: "add a footer", verify: { tool: "get_metadata", nodeId: "0:1", contains: ["Footer"] } };
		stub.silentUseFigma = true;
		const unknown = await previewApply(run, "use_figma", value);
		expect(station(unknown)).toEqual({ code: 3, cause: "DOMAIN_RUN_EFFECT_UNKNOWN", connectorCause: null });
		expect(station(await run(["recover", "figma", "--run", unknown.result.data?.runId as string, "--adjudicate", ...input(value)]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "evidence-insufficient" });
		expect(callsOf(stub, "use_figma")).toHaveLength(1);
	});
}, 120_000);

// Auth runs on a bundle of the source-compiled front door with the shipped
// Figma config, because the route admits attended OAuth only on the hosted
// HTTPS endpoint. No MCPorter, network, or grant is reached.
test("auth status reads only the vault's presence, and login needs Nathan's own terminal", async () => {
	const bundle = createBundle();
	cpSync(path.resolve(import.meta.dir, "..", "config"), path.join(bundle.skillsRoot, "figma", "config"), { recursive: true });
	const home = path.join(bundle.root, "home");
	mkdirSync(home);
	try {
		const run = async (argv: string[]) => {
			const result = await runBundle(bundle, argv, { home, extraEnv: { XDG_STATE_HOME: path.join(bundle.root, "state") } });
			expect({ argv, stderr: result.stderr }).toEqual({ argv, stderr: "" });
			return { code: result.code, result: (JSON.parse(result.stdout) as Envelope).result };
		};
		const status = await run(["auth", "status", "figma"]);
		expect(station(status)).toEqual({ code: 0, cause: "SUCCESS_UNCHANGED", connectorCause: null });
		expect(status.result.data).toMatchObject({ server: "figma-connectors", endpoint: HOSTED_ENDPOINT, custody: "mcporter-native-vault", vault: "connectors-figma", vaultIndex: "absent", grant: "absent" });
		for (const argv of [["auth", "login", "figma"], ["auth", "login", "figma", "--no-browser", "--reset"]]) {
			expect([argv, station(await run(argv))]).toEqual([argv, { code: 3, cause: "DOMAIN_ATTENDED_REQUIRED", connectorCause: null }]);
		}
		expect(station(await run(["auth", "configure", "figma", "--input", "{}"]))).toEqual({ code: 3, cause: "DOMAIN_AUTH_VERB_UNSUPPORTED", connectorCause: "auth-verb-unsupported" });
		expect(existsSync(path.join(home, ".mcporter"))).toBe(false);
	} finally {
		bundle.dispose();
	}
}, 120_000);

// A real pseudo-terminal reaches the verified MCPorter's attended auth, with
// every outbound connection and Keychain command denied by the sandbox.
// Fails if login drops either flag or routes into a shared OAuth vault.
test.skipIf(!OFFICIAL_MCPORTER)("attended Figma login forwards no-browser and reset to MCPorter in only Figma's vault", async () => {
	const bundle = createBundle();
	cpSync(path.resolve(import.meta.dir, "..", "config"), path.join(bundle.skillsRoot, "figma", "config"), { recursive: true });
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(home);
	mkdirSync(state);
	const sandbox = path.join(bundle.root, "attended-sandbox");
	const exitFile = path.join(bundle.root, "attended-exit");
	const profile = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(deny process-exec (literal "/usr/bin/security"))';
	writeFileSync(sandbox, `#!/bin/sh\n/usr/bin/sandbox-exec -p '${profile}' '${bundle.binary}' "$@"\nauth_exit=$?\nprintf '%s\\n' "$auth_exit" > '${exitFile}'\nexit "$auth_exit"\n`, { mode: 0o700 });
	const vault = path.join(state, "connectors", "figma-mcporter");
	try {
		const cases = [
			{ flags: [], expected: ["auth", "figma-connectors"] },
			{ flags: ["--reset", "--no-browser"], expected: ["auth", "figma-connectors", "--no-browser", "--reset"] },
		];
		expect(cases).toHaveLength(2);
		for (const { flags, expected } of cases) {
			const fifo = ownedVault(vault);
			rmSync(fifo, { force: true });
			execFileSync("/usr/bin/mkfifo", [fifo]);
			const running = runInteractiveBundle({ ...bundle, binary: sandbox }, ["auth", "login", "figma", ...flags], {
				home, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: OFFICIAL_MCPORTER as string, FIGMA_ACCESS_TOKEN: AMBIENT_SENTINEL }, timeoutMs: 30_000,
			});
			const held = await heldMcporter(fifo, state, "auth", running);
			const login = await running;
			expect(Number(readFileSync(exitFile, "utf8"))).toBe(3);
			expect({ flags, argv: held?.argv ?? null }).toEqual({ flags, argv: expected });
			const env = held?.env ?? [];
			expect(env.filter((entry) => ["XDG_DATA_HOME=", "XDG_CACHE_HOME=", "MCPORTER_NO_KEEPALIVE="].some((name) => entry.startsWith(name))).sort()).toEqual(["MCPORTER_NO_KEEPALIVE=*", `XDG_CACHE_HOME=${vault}/cache`, `XDG_DATA_HOME=${vault}/data`]);
			expect(env.some((entry) => entry.startsWith("FIGMA_ACCESS_TOKEN=") || entry.includes(AMBIENT_SENTINEL))).toBe(false);
			expect(login.stderr).toBe("");
			expect(login.stdout.trim().split("\n")).toHaveLength(1);
			expect((JSON.parse(login.stdout) as Envelope).result).toMatchObject({ commandIdentity: "connectors.auth", outcome: "failed", causeCode: "DOMAIN_AUTH_LOGIN_UNKNOWN", exitCode: 3, transactionState: "unknown", effects: { uncertain: ["account-grant"] } });
			for (const output of [login.stdout, login.stderr, login.terminal]) expect(output).not.toContain(AMBIENT_SENTINEL);
		}
		expect(existsSync(path.join(vault, "data", "mcporter", "credentials.json"))).toBe(true);
		expect(existsSync(path.join(state, "connectors", "mcporter-keyless"))).toBe(false);
		expect(existsSync(path.join(home, ".mcporter"))).toBe(false);
	} finally {
		bundle.dispose();
	}
}, 120_000);

// MCPorter records each hosted server in its vault even without a grant, so the
// vault a read touches is observable. The Figma grant must live only in Figma's
// own vault root: never in the keyless root other connectors' children share,
// and never in the caller's HOME vault.
test.skipIf(!OFFICIAL_MCPORTER)("reads, schema, and writes use only Figma's own MCPorter vault root", async () => {
	await withFigma(async ({ run, machine }) => {
		expect(station(await run(["run", "figma", "whoami"]))).toEqual({ code: 0, cause: "SUCCESS_UNCHANGED", connectorCause: null });
		await previewApply(run, "add_code_connect_map", { fileKey: "FileKeyExisting01", nodeId: "1:1", source: "src/Button.tsx", componentName: "Button", label: "React" });
		const vault = (root: string) => path.join(machine.state, "connectors", root, "data", "mcporter", "credentials.json");
		expect(existsSync(vault("figma-mcporter"))).toBe(true);
		expect(existsSync(vault("mcporter-keyless")) && readFileSync(vault("mcporter-keyless"), "utf8").includes("figma-connectors")).toBe(false);
		expect(existsSync(path.join(machine.home, ".mcporter"))).toBe(false);
	});
}, 120_000);

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// The upload URLs are capabilities: the adapter alone holds and POSTs them,
// and withFigma sweeps every output and the whole state root for the token.
test.skipIf(!OFFICIAL_MCPORTER)("upload_assets posts the previewed bytes itself and applies only when read-back shows the placement", async () => {
	await withFigma(async ({ run, stub, machine }) => {
		const assets = machine.assets({ "a.png": "PNG-A", "b.png": "PNG-B" });
		const page = await previewApply(run, "upload_assets", { fileKey: "FileKeyExisting01", currentPageId: "0:1", assets: [{ path: path.join(assets, "a.png"), contentType: "image/png" }, { path: path.join(assets, "b.png"), contentType: "image/png" }] });
		expect(station(page)).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		expect((page.result.data?.receipt?.effects as { id: string }[]).map((effect) => effect.id)).toEqual(["1:2", "1:3"]);
		expect(stub.posts.map((post) => [post.contentType, post.sha256])).toEqual([["image/png", sha256("PNG-A")], ["image/png", sha256("PNG-B")]]);
		expect(callsOf(stub, "upload_assets").map((call) => call.args)).toEqual([{ fileKey: "FileKeyExisting01", count: 2, currentPageId: "0:1" }]);

		const fill = await previewApply(run, "upload_assets", { fileKey: "FileKeyExisting01", nodeIds: ["1:1"], assets: [{ path: path.join(assets, "a.png"), contentType: "image/png" }], scaleMode: "FIT" });
		expect(station(fill)).toEqual({ code: 0, cause: "SUCCESS_RUN_APPLIED", connectorCause: null });
		expect((fill.result.data?.receipt?.effects as { id: string }[]).map((effect) => effect.id)).toEqual(["1:1"]);
		expect(callsOf(stub, "upload_assets")[1]?.args).toEqual({ fileKey: "FileKeyExisting01", count: 1, nodeIds: ["1:1"], scaleMode: "FIT" });
		expect(stub.posts).toHaveLength(3);
	});
}, 180_000);

test.skipIf(!OFFICIAL_MCPORTER)("upload_assets refuses changed bytes, unreadable sources, bad shapes, and any upload URL off Figma's origin", async () => {
	await withFigma(async ({ run, stub, machine }) => {
		const assets = machine.assets({ "a.png": "PNG-A", "logo.svg": "<svg/>" });
		const value = { fileKey: "FileKeyExisting01", currentPageId: "0:1", assets: [{ path: path.join(assets, "a.png"), contentType: "image/png" }] };
		const preview = await run(["run", "figma", "upload_assets", ...input(value), "--preview"]);
		machine.assets({ "a.png": "PNG-A-CHANGED" });
		expect(station(await run(["run", "figma", "upload_assets", ...input(value), "--apply", preview.result.data?.previewId as string]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "preview-input-mismatch" });
		expect(station(await run(["run", "figma", "upload_assets", ...input({ ...value, assets: [{ path: assets, contentType: "image/png" }] }), "--preview"]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "file-unreadable" });
		for (const bad of [
			{ ...value, assets: [{ path: "a.png", contentType: "image/png" }] },
			{ ...value, assets: [{ path: path.join(assets, "a.png"), contentType: "application/pdf" }] },
			{ fileKey: "FileKeyExisting01", assets: value.assets },
			{ fileKey: "FileKeyExisting01", nodeIds: ["1:1", "1:2"], assets: value.assets },
			{ fileKey: "FileKeyExisting01", nodeIds: ["1:1"], assets: [{ path: path.join(assets, "logo.svg"), contentType: "image/svg+xml" }] },
		]) expect(station(await run(["run", "figma", "upload_assets", ...input(bad), "--preview"]))).toEqual({ code: 4, cause: "SCHEMA_ADAPTER_REFUSED", connectorCause: "input-invalid" });
		expect(callsOf(stub, "upload_assets")).toHaveLength(0);

		stub.uploadOrigin = "https://uploads.example.test";
		const fresh = machine.assets({ "c.png": "PNG-C" });
		const refused = await previewApply(run, "upload_assets", { ...value, assets: [{ path: path.join(fresh, "c.png"), contentType: "image/png" }] });
		expect(station(refused)).toEqual({ code: 3, cause: "DOMAIN_RUN_FAILED_RECORDED", connectorCause: "upload-url-refused" });
		expect([callsOf(stub, "upload_assets").length, stub.posts.length]).toEqual([1, 0]);
	});
}, 180_000);
