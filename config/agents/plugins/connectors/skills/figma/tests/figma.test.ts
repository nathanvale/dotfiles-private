import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planDispatcherRoute } from "../../../bin/provider-route.ts";
import { createHarness, FIXTURES, type Harness } from "../../../tests/harness.ts";
import { OPERATION_NAMES } from "../scripts/catalogue.ts";
import { INTERNAL_CONTEXT } from "../scripts/transport.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const CONFIG = path.join(SKILL, "config", "mcporter.json");
const ROUTE = path.join(SKILL, "config", "route.json");
const SKILLS = path.dirname(SKILL);
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
// ADR 0005: the adapter reaches every catalog tool except three whose effect
// no admitted read can observe or whose capability would leave the adapter.
const FIGMA_NOT_ADMITTED = ["generate_figma_design", "upload_assets", "weave_upload_asset"];
const FIGMA_ADMITTED = FIGMA_CATALOG.filter((tool) => !FIGMA_NOT_ADMITTED.includes(tool)).sort();
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
		expect(FIGMA_ADMITTED).toHaveLength(32);
	});

	test("registry fixes the hosted endpoint and admits exactly the adapter's catalog", () => {
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
		expect(allowedTools).toHaveLength(32);
		expect([...allowedTools].sort()).toEqual(FIGMA_ADMITTED);
		expect([...OPERATION_NAMES].sort()).toEqual(FIGMA_ADMITTED);
		expect(JSON.parse(readFileSync(ROUTE, "utf8"))).toEqual({ defaultProvider: "figma-connectors", oauth: "mcporter", dispatcherOwned: true });
	});

	// The plain route would forward a write with no preview or journal, so it
	// reaches nothing: auth, list, and call refuse before MCPorter starts.
	test("the plain route refuses every Figma verb as dispatcher-owned", async () => {
		for (const argv of [["figma", "--", "auth"], ["figma", "--", "list", "--schema", "--json"], ["figma", "--", "call", "whoami"], ["figma", "--", "call", "use_figma"]]) {
			const result = await harness.run(argv);
			expect([argv, result.code]).toEqual([argv, 3]);
			expect(result.stderr).toContain("provider-route:error:dispatcher-owned:");
		}
		expect(harness.has("mcporter.json")).toBe(false);
	});

	// Canva moves MCPorter's data and cache homes into a per-account vault;
	// Figma's adapter keeps MCPorter's default vault and cached-grant reads.
	test("the adapter's route plans attended auth and cached calls on the declared server with the default vault", () => {
		const env = { HOME: harness.home, PATH: "/usr/bin:/bin", XDG_DATA_HOME: "/must-not-cross", AMBIENT_SENTINEL: "x" };
		const auth = planDispatcherRoute(["figma", "--", "auth", "--no-browser", "--reset"], SKILLS, env, INTERNAL_CONTEXT);
		expect(auth.argv).toEqual(["--config", CONFIG, "auth", "figma-connectors", "--no-browser", "--reset"]);
		expect([auth.env.XDG_DATA_HOME, auth.env.XDG_CACHE_HOME, auth.env.AMBIENT_SENTINEL]).toEqual([undefined, undefined, undefined]);
		const call = planDispatcherRoute(["figma", "--", "call", "get_design_context", "--args", "{}", "--output", "json"], SKILLS, env, INTERNAL_CONTEXT);
		expect(call.argv).toEqual(["--config", CONFIG, "call", "figma-connectors.get_design_context", "--args", "{}", "--output", "json", "--no-oauth"]);
		expect(() => planDispatcherRoute(["figma", "--provider", "figma", "--", "auth"], SKILLS, env, INTERNAL_CONTEXT)).toThrow("provider figma is not declared");
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

	test.skipIf(!realMcporter)("installed MCPorter lists exactly the admitted tools from a full advertised catalog", () => {
		const listed = runRealMcporter(["list", "figma-connectors", "--json", "--timeout", "20000"]);
		expect(listed.code).toBe(0);
		const names = (JSON.parse(listed.stdout) as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort();
		expect(names).toEqual(FIGMA_ADMITTED);
	}, 30_000);

	test.skipIf(!realMcporter)("installed MCPorter reaches an admitted read and an admitted write", () => {
		for (const tool of ["get_screenshot", "use_figma"]) {
			const called = runRealMcporter(["call", `figma-connectors.${tool}`, "--output", "json", "--timeout", "20000"]);
			expect([tool, called.code]).toEqual([tool, 0]);
			expect((JSON.parse(called.stdout) as { calledTool: unknown }).calledTool).toBe(tool);
		}
	}, 30_000);

	test.skipIf(!realMcporter)("installed MCPorter blocks unadmitted and uncatalogued names before the server starts", () => {
		for (const tool of [...FIGMA_NOT_ADMITTED, ...FIGMA_UNCATALOGUED]) {
			const refused = runRealMcporter(["call", `figma-connectors.${tool}`, "--output", "json", "--timeout", "20000"]);
			expect([tool, refused.code]).toEqual([tool, 1]);
			expect(JSON.parse(refused.stdout)).toMatchObject({ error: `Tool '${tool}' is not accessible on server 'figma-connectors' (blocked by configuration).` });
		}
		expect(harness.has("probe-spawned")).toBe(false);
	}, 30_000);
});
