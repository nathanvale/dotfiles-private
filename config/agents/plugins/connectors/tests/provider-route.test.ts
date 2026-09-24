import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { planDispatcherRoute, planRoute, RouteError } from "../bin/provider-route.ts";
import { INTERNAL_INVOCATION_CONTEXT_ENV } from "../bin/safe-environment.ts";
import { AMBIENT_SENTINEL, assertCustody, createHarness, FIXTURE_ROUTE, FIXTURES, type Harness, PLUGIN_ROOT, ROUTE } from "./harness.ts";

// Independent oracle: the MCPorter release qualified by the real process canaries below.
const PINNED_MCPORTER_VERSION = "0.14.0";
const SKILLS_ROOT = path.join(PLUGIN_ROOT, "skills");
const realMcporter = Bun.which("mcporter");

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

describe("route plan (in-process)", () => {
	test("composes the explicit config, verb, target, and disabled OAuth", () => {
		const plan = planRoute(["probe-skill", "--select", "selection=example", "--", "list", "--status", "--json"], FIXTURES, { PATH: "/bin", AMBIENT_SENTINEL });
		expect(plan.server).toBe("probe");
		expect(plan.argv).toEqual(["--config", path.join(FIXTURES, "probe-skill", "config", "mcporter.json"), "list", "probe", "--status", "--json", "--no-oauth"]);
		expect(plan.env).toEqual({ MCPORTER_NO_KEEPALIVE: "*", PATH: "/bin", PROBE_SELECTION: "example" });
	});

	test("call composes server.tool from a bare tool name and keeps named tool arguments", () => {
		const plan = planRoute(
			["probe-skill", "--select", "selection=example", "--", "call", "probe", "limit=1", "query:bun", "note=@@literal", "--output", "json", "--timeout=5000", "--args", '{"a":1}'],
			FIXTURES,
			{},
		);
		expect(plan.argv.slice(2)).toEqual(["call", "probe.probe", "limit=1", "query:bun", "note=@@literal", "--output", "json", "--timeout=5000", "--args", '{"a":1}', "--no-oauth"]);
	});

	test("the private dispatcher seam accepts one fixed context channel and rejects old environment-map collisions", () => {
		const argv = ["probe-skill", "--select", "selection=example", "--", "list", "--json"];
		const plan = planDispatcherRoute(argv, FIXTURES, { PATH: "/safe/bin" }, "context-v1");
		expect(plan.env).toEqual({ MCPORTER_NO_KEEPALIVE: "*", PATH: "/safe/bin", PROBE_SELECTION: "example", [INTERNAL_INVOCATION_CONTEXT_ENV]: "context-v1" });
		const rejectionCode = (attemptedMetadata: unknown) => {
			try {
				planDispatcherRoute(argv, FIXTURES, { PATH: "/safe/bin" }, attemptedMetadata as string);
			} catch (error) {
				if (error instanceof RouteError) return error.code;
				throw error;
			}
			return "accepted";
		};
		for (const attemptedMetadata of [
			{ PATH: "/attacker/bin" },
			{ PROBE_SELECTION: "other" },
			{ MCPORTER_NO_KEEPALIVE: "off" },
		] as const) {
			expect(rejectionCode(attemptedMetadata)).toBe("internal-context-invalid");
		}
	});

	test("refusals carry a closed cause and a Contract Core exit class", () => {
		const attempt = (argv: string[]) => {
			try {
				planRoute(argv, FIXTURES, {});
			} catch (error) {
				if (error instanceof RouteError) return { code: error.code, exit: error.exitCode };
				throw error;
			}
			return null;
		};
		expect(attempt(["missing-skill", "--", "list"])).toEqual({ code: "skill-config-missing", exit: 3 });
		expect(attempt(["probe-skill", "--select", "selection=a b", "--", "list"])).toEqual({ code: "select-invalid", exit: 2 });
		expect(attempt(["probe-skill", "--", "list"])).toEqual({ code: "select-missing", exit: 2 });
		// A registry server without an explicit array allow-list is a configuration defect, refused before anything runs.
		expect(attempt(["no-allowlist-skill", "--", "list"])).toEqual({ code: "allowlist-missing", exit: 4 });
	});
});

describe("public process refusals: nothing reaches MCPorter or the credential helper", () => {
	const cases: [string, string[]][] = [
		["provider-invalid", ["probe-skill", "--provider", "probe-unknown", "--select", "selection=x", "--", "list"]],
		["tool-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe-unknown.executeRead"]],
		["tool-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "https://example.invalid/mcp.tool"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "list", "--http-url=https://example.invalid/mcp"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "list", "--config", "/etc/other.json"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "list", "--root", "/"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--header", "Authorization=Bearer x"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--env", "X=1"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--stdio", "sh"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--persist", "/tmp/x"]],
		// A value flag must never let the next option token skip the allow-list.
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--timeout", "--config", "/tmp/other.json"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--args", "--header", "Authorization=Bearer x"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "list", "--timeout", "--http-url", "https://example.invalid/mcp"]],
		["flag-forbidden", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--output", "--env", "X=1"]],
		["flag-invalid", ["probe-skill", "--select", "selection=x", "--", "list", "--timeout"]],
		["flag-invalid", ["probe-skill", "--select", "selection=x", "--", "list", "--timeout", "soon"]],
		["flag-invalid", ["probe-skill", "--select", "selection=x", "--", "list", "--json=yes"]],
		["flag-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--output", "xml"]],
		["flag-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--args", "[1]"]],
		["flag-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "--args=@/etc/hosts"]],
		// Tool arguments are named only; a leading @ would read a local file into the payload.
		["argument-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "query=@/etc/hosts"]],
		["argument-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "query:@/etc/hosts"]],
		["argument-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "bare-positional"]],
		["argument-invalid", ["probe-skill", "--select", "selection=x", "--", "call", "probe", "=empty-key"]],
		["command-invalid", ["probe-skill", "--select", "selection=x", "--", "auth", "probe"]],
		["command-invalid", ["probe-skill", "--select", "selection=x", "--", "generate-cli"]],
		["arguments-invalid", ["probe-skill", "--select", "selection=x", "--", "list", "https://example.invalid/mcp"]],
		["arguments-invalid", ["probe-skill", "--select", "selection=x", "list"]],
		["select-invalid", ["probe-skill", "--select", "selection=Example Team", "--", "list"]],
		["select-invalid", ["probe-skill", "--select", "selection=../other", "--", "list"]],
		["select-missing", ["probe-skill", "--", "list"]],
		["select-undeclared", ["probe-skill", "--select", "selection=x", "--select", "other=y", "--", "list"]],
		["skill-invalid", ["../skills", "--", "list"]],
		["skill-config-missing", ["figma", "--", "list"]],
		["allowlist-missing", ["no-allowlist-skill", "--", "call", "open"]],
	];
	for (const [code, argv] of cases) {
		test(`${code}: ${argv.join(" ")}`, async () => {
			const result = await harness.run(argv, {}, FIXTURE_ROUTE);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`provider-route:error:${code}:`);
			expect(harness.has("mcporter.json")).toBe(false);
			expect(harness.has("wrapper.log")).toBe(false);
		});
	}
});

describe("public process route", () => {
	test("replaces itself with MCPorter under a scrubbed environment", async () => {
		const result = await harness.run(["probe-skill", "--select", "selection=example", "--", "list", "--status", "--json"], {}, FIXTURE_ROUTE);
		expect(result.code).toBe(0);
		const receipt = assertCustody(harness, result, []);
		expect(receipt.kind).toBe("stdio");
		expect(receipt.cwd).toBe(path.join(FIXTURES, "probe-skill", "config"));
		expect(Object.keys(receipt.env).sort()).toEqual(["HOME", "MCPORTER_NO_KEEPALIVE", "PATH", "PROBE_SELECTION", "TMPDIR", "XDG_STATE_HOME"]);
	});

	test("an explicit --no-oauth is not duplicated", async () => {
		const result = await harness.run(["probe-skill", "--select", "selection=example", "--", "list", "--no-oauth"], {}, FIXTURE_ROUTE);
		expect(result.code).toBe(0);
		assertCustody(harness, result, []);
	});

	test("a missing mcporter executable is a precondition refusal", async () => {
		const result = await harness.run(["probe-skill", "--select", "selection=example", "--", "list"], { PATH: "/nonexistent" }, FIXTURE_ROUTE);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("provider-route:error:executable-missing:");
	});

	test("the production entry resolves only the plugin's own skills, whatever the environment says", async () => {
		const result = await harness.run(["probe-skill", "--select", "selection=example", "--", "list"], { PROVIDER_ROUTE_SKILLS_ROOT: FIXTURES, CONNECTOR_SKILLS_ROOT: FIXTURES });
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("provider-route:error:skill-config-missing:");
		expect(result.stderr).toContain(path.join(PLUGIN_ROOT, "skills", "probe-skill"));
		expect(harness.has("mcporter.json")).toBe(false);
	});

	test("a dispatcher-owned Atlassian tool refuses before MCPorter or the Provider process can start", async () => {
		const secret = "fixture-community-secret";
		const result = await harness.run(["atlassian", "--provider", "atlassian-community-jira", "--select", "tenant=example", "--", "call", "jira_create_issue", "--args", '{"project_key":"PROJ","issue_type":"Bug","summary":"must not spawn"}'], { FIXTURE_SECRET: secret });
		expect([result.code, result.stdout, result.stderr.includes("provider-route:error:dispatcher-owned:")]).toEqual([3, "", true]);
		expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
		expect(harness.has("mcporter.json")).toBe(false);
		expect(harness.has("wrapper.log")).toBe(false);
	});

	test("a dispatcher-owned Atlassian registry list also refuses before MCPorter or the Provider process can start", async () => {
		const secret = "fixture-community-secret";
		const result = await harness.run(["atlassian", "--provider", "atlassian-community-jira", "--select", "tenant=example", "--", "list", "--json"], { FIXTURE_SECRET: secret });
		expect([result.code, result.stdout, result.stderr.includes("provider-route:error:dispatcher-owned:")]).toEqual([3, "", true]);
		expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
		expect(harness.has("mcporter.json")).toBe(false);
		expect(harness.has("wrapper.log")).toBe(false);
	});
});

describe("route source and skill registries", () => {
	test("the shared route names no service", () => {
		const source = readFileSync(ROUTE, "utf8").toLowerCase();
		for (const word of ["atlassian", "context7", "firecrawl", "tenant", "jira", "confluence", "1password", "op://", "firecrawl"]) {
			expect(source).not.toContain(word);
		}
	});

	test("every skill declares an explicit registry with imports disabled and a default provider it owns", () => {
		const skills = readdirSync(SKILLS_ROOT)
			.filter((name) => existsSync(path.join(SKILLS_ROOT, name, "config", "mcporter.json")))
			.sort();
		expect(skills).toEqual(["atlassian", "canva", "context7", "firecrawl"]);
		for (const skill of skills) {
			const registry = JSON.parse(readFileSync(path.join(SKILLS_ROOT, skill, "config", "mcporter.json"), "utf8")) as { imports: unknown; mcpServers: Record<string, unknown> };
			const route = JSON.parse(readFileSync(path.join(SKILLS_ROOT, skill, "config", "route.json"), "utf8")) as { defaultProvider: string };
			expect(registry.imports).toEqual([]);
			expect(Object.keys(registry.mcpServers)).toContain(route.defaultProvider);
		}
	});
});

describe("real MCPorter seam (credential-free)", () => {
	test.skipIf(!realMcporter)("the installed MCPorter is the required release", () => {
		const version = Bun.spawnSync(["mcporter", "--version"]).stdout.toString().trim();
		expect(version).toBe(PINNED_MCPORTER_VERSION);
	});

	test.skipIf(!realMcporter)("an excluded tool call is refused before the provider starts", () => {
		const executable = realMcporter ?? "mcporter";
		const version = Bun.spawnSync([executable, "--version"]).stdout.toString().trim();
		expect(version).toBe(PINNED_MCPORTER_VERSION);
		const marker = path.join(harness.root, "provider-started");
		const config = path.join(harness.root, "excluded-registry.json");
		harness.write(
			"excluded-registry.json",
			JSON.stringify({
				imports: [],
				mcpServers: {
					probe: {
						command: path.join(FIXTURES, "stdio-probe-server.ts"),
						env: { PROBE_SPAWN_MARKER: marker },
						allowedTools: ["some-other-tool"],
					},
				},
			}),
		);
		const result = Bun.spawnSync([executable, "--config", config, "call", "probe.probe", "--output", "json", "--timeout", "15000", "--no-oauth"], {
			env: { HOME: harness.home, PATH: process.env.PATH ?? "", TMPDIR: harness.root, XDG_STATE_HOME: harness.root, MCPORTER_NO_KEEPALIVE: "*" },
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			server: "probe",
			tool: "probe",
			error: "Tool 'probe' is not accessible on server 'probe' (blocked by configuration).",
		});
		expect(existsSync(marker)).toBe(false);
	});

	test.skipIf(!realMcporter)("every skill registry loads under config doctor without spawning a provider", () => {
		const skills = readdirSync(SKILLS_ROOT).filter((name) => existsSync(path.join(SKILLS_ROOT, name, "config", "mcporter.json")));
		for (const skill of skills) {
			const route = JSON.parse(readFileSync(path.join(SKILLS_ROOT, skill, "config", "route.json"), "utf8")) as { selectors?: Record<string, string> };
			const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: harness.home, MCPORTER_NO_KEEPALIVE: "*" };
			for (const envKey of Object.values(route.selectors ?? {})) env[envKey] = "example";
			const doctor = Bun.spawnSync(["mcporter", "config", "doctor", "--config", path.join(SKILLS_ROOT, skill, "config", "mcporter.json")], { env });
			expect({ skill, code: doctor.exitCode, ok: doctor.stdout.toString().includes("Config looks good.") }).toEqual({ skill, code: 0, ok: true });
		}
	});

	test.skipIf(!realMcporter)("a real stdio child receives the selection and the config directory, never ambient authority", async () => {
		// PATH is replaced wholesale, so the fake bin directory is absent and the
		// installed MCPorter runs; the absent fake receipt proves it.
		const result = await harness.run(
			["probe-skill", "--select", "selection=example", "--", "list", "--schema", "--json", "--timeout", "20000"],
			{ PATH: process.env.PATH ?? "" },
			FIXTURE_ROUTE,
		);
		expect(result.code).toBe(0);
		expect(harness.has("mcporter.json")).toBe(false);
		const match = /stdio child probe: (\{.*?\})\\?"/.exec(result.stdout.replaceAll('\\"', '"'));
		expect(match).not.toBeNull();
		const probe = JSON.parse(match?.[1] ?? "{}") as { cwd: string; selection: string | null; ambientSentinelPresent: boolean; envKeys: string[] };
		expect(probe.cwd).toBe(path.join(FIXTURES, "probe-skill", "config"));
		expect(probe.selection).toBe("example");
		expect(probe.ambientSentinelPresent).toBe(false);
		expect(probe.envKeys).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
	}, 30_000);
});
