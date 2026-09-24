import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertCustody, createHarness, type Harness } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const CONFIG = path.join(SKILL, "config", "mcporter.json");
const ROUTE = path.join(SKILL, "config", "route.json");
const realMcporter = Bun.which("mcporter");

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("Figma hosted Provider", () => {
	test("registry fixes the hosted endpoint and admits only identity", () => {
		const registry = JSON.parse(readFileSync(CONFIG, "utf8"));
		expect(registry.imports).toEqual([]);
		expect(registry.mcpServers).toEqual({
			"figma-connectors": {
				description: "Figma hosted MCP, attended local OAuth",
				baseUrl: "https://mcp.figma.com/mcp",
				auth: "oauth",
				clientName: "Claude Code",
				allowedTools: ["whoami"],
			},
		});
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
});
