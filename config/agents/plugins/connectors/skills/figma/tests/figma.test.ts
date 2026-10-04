import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertCustody, createHarness, FIXTURES, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const CONFIG = path.join(SKILL, "config", "mcporter.json");
const ROUTE = path.join(SKILL, "config", "route.json");
const realMcporter = Bun.which("mcporter");

// Independent oracle: Figma's documented MCP tool catalog, transcribed from
// https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/ on
// 2026-10-05. The registry must admit exactly these names; never derive them
// from config/mcporter.json.
const FIGMA_READ_TOOLS = [
	"download_assets",
	"get_code_connect_map",
	"get_code_connect_suggestions",
	"get_context_for_code_connect",
	"get_design_context",
	"get_figjam",
	"get_generative_plugin",
	"get_libraries",
	"get_metadata",
	"get_motion_context",
	"get_screenshot",
	"get_shader",
	"get_variable_defs",
	"list_file_shaders",
	"list_generative_plugins",
	"list_shaders",
	"search_design_system",
	"whoami",
];
const FIGMA_WRITE_TOOLS = [
	"add_code_connect_map",
	"create_generative_plugin",
	"create_new_file",
	"create_shader",
	"generate_diagram",
	"generate_figma_design",
	"send_code_connect_mappings",
	"update_generative_plugin",
	"update_shader",
	"upload_assets",
	"use_figma",
];
const FIGMA_WEAVE_TOOLS = ["weave_list_tools", "weave_get_tool_inputs", "weave_upload_asset", "weave_run_tool", "weave_get_tool_run_output", "weave_cancel_tool_run"];
const FIGMA_CATALOG = [...FIGMA_READ_TOOLS, ...FIGMA_WRITE_TOOLS, ...FIGMA_WEAVE_TOOLS];
// The direct route admits the read class only. Write and Weave calls wait for
// a preview/apply adapter (connectors AGENTS.md, adding a connector, step 6).
const FIGMA_ROUTE_TOOLS = [...FIGMA_READ_TOOLS].sort();
// Names an upstream server can expose outside the catalog: the MCP prompt, a
// tool named only in server instructions, and a broad dispatcher.
const FIGMA_UNCATALOGUED = ["create_design_system_rules", "get_figma_skill", "executeWrite"];

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("Figma hosted Provider", () => {
	test("the documented catalog oracle holds 18 read, 11 write, and 6 Weave tools", () => {
		expect([FIGMA_READ_TOOLS.length, FIGMA_WRITE_TOOLS.length, FIGMA_WEAVE_TOOLS.length]).toEqual([18, 11, 6]);
		expect(new Set(FIGMA_CATALOG).size).toBe(35);
	});

	test("registry fixes the hosted endpoint and admits exactly the documented read tools", () => {
		const registry = JSON.parse(readFileSync(CONFIG, "utf8"));
		expect(registry.imports).toEqual([]);
		const { allowedTools, ...server } = registry.mcpServers["figma-connectors"];
		expect(Object.keys(registry.mcpServers)).toEqual(["figma-connectors"]);
		expect(server).toEqual({
			description: "Figma hosted MCP, attended local OAuth",
			baseUrl: "https://mcp.figma.com/mcp",
			auth: "oauth",
			clientName: "Claude Code",
		});
		expect(allowedTools).toHaveLength(18);
		expect([...allowedTools].sort()).toEqual(FIGMA_ROUTE_TOOLS);
	});

	test("attended auth targets only the declared Figma server", async () => {
		const result = await harness.run(["figma", "--", "auth"]);
		expect(result.code).toBe(0);
		const receipt = harness.receipt<{ argv: string[]; env: Record<string, string>; pid: number; kind: string; url: string }>("mcporter.json");
		expect(receipt.argv).toEqual(["--config", CONFIG, "auth", "figma-connectors"]);
		expect(receipt.pid).toBe(result.pid);
		expect(receipt.kind).toBe("http");
		expect(receipt.url).toBe("https://mcp.figma.com/mcp");
		expect(receipt.env).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
		expect(receipt.env).not.toHaveProperty("AMBIENT_SENTINEL");
	});

	test("attended reset targets only the isolated Figma server", async () => {
		const result = await harness.run(["figma", "--", "auth", "--reset"]);
		expect(result.code).toBe(0);
		const receipt = harness.receipt<{ argv: string[] }>("mcporter.json");
		expect(receipt.argv).toEqual(["--config", CONFIG, "auth", "figma-connectors", "--reset"]);
	});

	// Canva moves MCPorter's data and cache homes into a per-account vault;
	// Figma's route must keep MCPorter's default vault and gain no Canva selector.
	test("attended auth keeps MCPorter's default vault with no Canva data root", async () => {
		const result = await harness.run(["figma", "--", "auth", "--no-browser"]);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const receipt = harness.receipt<{ argv: string[]; env: Record<string, string> }>("mcporter.json");
		expect(receipt.argv).toEqual(["--config", CONFIG, "auth", "figma-connectors", "--no-browser"]);
		expect([receipt.env.XDG_DATA_HOME, receipt.env.XDG_CACHE_HOME, receipt.env.CANVA_ACCOUNT]).toEqual([undefined, undefined, undefined]);
	});

	test("routine discovery uses cached OAuth without starting login", async () => {
		const result = await harness.run(["figma", "--", "list", "--schema", "--json"]);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, []);
		expect(receipt.kind).toBe("http");
		expect(receipt.url).toBe("https://mcp.figma.com/mcp");
		expect(receipt.argv).toEqual(["--config", CONFIG, "list", "figma-connectors", "--schema", "--json", "--no-oauth"]);
	});

	test("read-tool call stays on the Figma server and uses cached OAuth", async () => {
		const result = await harness.run(["figma", "--", "call", "whoami", "--output", "json"]);
		expect(result.code).toBe(0);
		expect(assertCustody(harness, result, []).argv).toEqual(["--config", CONFIG, "call", "figma-connectors.whoami", "--output", "json", "--no-oauth"]);
	});

	test("a design-read call forwards its arguments to the Figma server with cached OAuth", async () => {
		const result = await harness.run(["figma", "--", "call", "get_design_context", "fileKey=example", "nodeId=1:2", "--output", "json"]);
		expect(result.code).toBe(0);
		expect(assertCustody(harness, result, []).argv).toEqual(["--config", CONFIG, "call", "figma-connectors.get_design_context", "fileKey=example", "nodeId=1:2", "--output", "json", "--no-oauth"]);
	});

	test("route cannot select the ambient figma server", async () => {
		const result = await harness.run(["figma", "--provider", "figma", "--", "auth"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("provider-route:error:provider-invalid:");
		expect(harness.has("mcporter.json")).toBe(false);
	});

	test.skipIf(!realMcporter)("installed MCPorter isolates the route grant and reset from ambient figma", async () => {
		const executable = realMcporter ?? "mcporter";
		const version = Bun.spawnSync([executable, "--version"]);
		expect(version.exitCode).toBe(0);
		expect(version.stdout.toString().trim()).toBe("0.14.0");

		const dist = path.dirname(realpathSync(executable));
		const vault = await import(pathToFileURL(path.join(dist, "oauth-vault.js")).href);
		const persistence = await import(pathToFileURL(path.join(dist, "oauth-persistence.js")).href);
		const runtime = await import(pathToFileURL(path.join(dist, "runtime", "environment.js")).href);
		const dataHome = path.join(harness.root, "xdg-data");
		await runtime.withRuntimeEnvironment({ HOME: harness.home, XDG_DATA_HOME: dataHome }, async () => {
			expect(vault.getOAuthVaultPath()).toBe(path.join(dataHome, "mcporter", "credentials.json"));
			const ambient = { name: "figma", command: { kind: "http", url: new URL("https://mcp.figma.com/mcp") } };
			const route = JSON.parse(readFileSync(ROUTE, "utf8")) as { defaultProvider: string };
			const selected = { ...ambient, name: route.defaultProvider };
			await vault.saveVaultEntry(ambient, { tokens: { access_token: "synthetic-ambient-token", token_type: "Bearer" } });
			expect((await vault.loadVaultEntry(ambient))?.tokens?.access_token).toBe("synthetic-ambient-token");
			expect(await vault.loadVaultEntry(selected)).toBeUndefined();
			await vault.saveVaultEntry(selected, { tokens: { access_token: "synthetic-route-token", token_type: "Bearer" } });
			await persistence.clearOAuthCaches(selected);
			expect(await vault.loadVaultEntry(selected)).toBeUndefined();
			expect((await vault.loadVaultEntry(ambient))?.tokens?.access_token).toBe("synthetic-ambient-token");
		});
	});

	// A stdio probe stands in for the hosted server under the real Figma
	// allow-list, so filtering and reachability are observed without a network
	// call, OAuth, or a canvas effect.
	function probeRegistry(): string {
		const registry = JSON.parse(readFileSync(CONFIG, "utf8")) as { mcpServers: Record<string, { allowedTools: string[] }> };
		const allowedTools = registry.mcpServers["figma-connectors"]?.allowedTools ?? [];
		const advertised = [...FIGMA_CATALOG, ...FIGMA_UNCATALOGUED].join(",");
		harness.write(
			"figma-probe-registry.json",
			JSON.stringify({ imports: [], mcpServers: { "figma-connectors": { command: path.join(FIXTURES, "stdio-probe-server.ts"), env: { PROBE_TOOL_NAMES: advertised }, allowedTools } } }),
		);
		return path.join(harness.root, "figma-probe-registry.json");
	}

	function runRealMcporter(args: string[]): { code: number; stdout: string } {
		const result = Bun.spawnSync([realMcporter ?? "mcporter", "--config", probeRegistry(), ...args, "--no-oauth"], {
			env: { HOME: harness.home, PATH: process.env.PATH ?? "", TMPDIR: harness.root, XDG_STATE_HOME: harness.root, MCPORTER_NO_KEEPALIVE: "*" },
		});
		return { code: result.exitCode, stdout: result.stdout.toString() };
	}

	test.skipIf(!realMcporter)("installed MCPorter lists exactly the documented read tools from a full advertised catalog", () => {
		const listed = runRealMcporter(["list", "figma-connectors", "--json", "--timeout", "20000"]);
		expect(listed.code).toBe(0);
		const names = (JSON.parse(listed.stdout) as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort();
		expect(names).toEqual(FIGMA_ROUTE_TOOLS);
	}, 30_000);

	test.skipIf(!realMcporter)("installed MCPorter reaches an admitted design-read tool", () => {
		const called = runRealMcporter(["call", "figma-connectors.get_screenshot", "--output", "json", "--timeout", "20000"]);
		expect(called.code).toBe(0);
		expect((JSON.parse(called.stdout) as { calledTool: unknown }).calledTool).toBe("get_screenshot");
	}, 30_000);

	test.skipIf(!realMcporter)("installed MCPorter blocks write, Weave, and uncatalogued names before the server starts", () => {
		for (const tool of [...FIGMA_WRITE_TOOLS, ...FIGMA_WEAVE_TOOLS, ...FIGMA_UNCATALOGUED]) {
			const refused = runRealMcporter(["call", `figma-connectors.${tool}`, "--output", "json", "--timeout", "20000"]);
			expect([tool, refused.code]).toEqual([tool, 1]);
			expect(JSON.parse(refused.stdout)).toMatchObject({ error: `Tool '${tool}' is not accessible on server 'figma-connectors' (blocked by configuration).` });
		}
		expect(harness.has("probe-spawned")).toBe(false);
	}, 30_000);
});
