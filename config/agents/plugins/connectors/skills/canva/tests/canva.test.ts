// Public-process proof of Canva's MCPorter-native custody (Ticket #93 under
// Spec #87): the Canva launcher crosses the shared route plan into the fake
// MCPorter with a private per-account vault root, the client-mode switch
// admits only dynamic registration, and no secret sentinel reaches argv,
// output, or MCPorter's environment. Proof stops at the fake MCPorter: real
// registration, consent, vault writes, and refresh stay live-only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAUSE_EXIT } from "../scripts/contract.ts";
import { planCanvaRoute, readClientMode } from "../scripts/custody/index.ts";
import { assertCustody, createHarness, type Harness, type McporterReceipt, PLUGIN_ROOT, ROUTE } from "../../../tests/harness.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const LAUNCHER = path.join(SKILL, "scripts", "canva.ts");
// Independent oracles, restated from Canva's documented read-only discovery
// tools and the accepted Spec so configuration cannot validate itself.
const EXPECTED_ALLOWED_TOOLS = ["search-designs", "get-design", "get-design-pages", "get-design-content"];
const EXPECTED_SERVER = "canva-connectors";
const GRANT_SENTINEL = "fixture-canva-grant-must-stay-in-vault";
const LEGACY_SENTINEL = "fixture-canva-legacy-refresh-token";
const AMBIENT_SECRETS = { CANVA_CLIENT_SECRET: "fixture-canva-client-secret", CANVA_ACCESS_TOKEN: "fixture-canva-ambient-access-token" };
const ARGV_SENTINEL = "sk-fixture-canva-argv-secret";
const ALL_SECRETS = [GRANT_SENTINEL, LEGACY_SENTINEL, ARGV_SENTINEL, ...Object.values(AMBIENT_SECRETS)];

let harness: Harness;
beforeEach(() => {
	harness = createHarness({});
});
afterEach(() => harness.dispose());

const vaultRoot = (account: string) => path.join(harness.root, "connectors", "canva-mcporter", account);
const canva = (argv: string[], entry = LAUNCHER, env: Record<string, string> = {}) => harness.run(argv, { ...AMBIENT_SECRETS, ...env }, entry);

function assertPrivateDirectory(directory: string): void {
	const stat = lstatSync(directory);
	expect([stat.isDirectory(), stat.isSymbolicLink(), stat.uid, stat.mode & 0o777]).toEqual([true, false, os.userInfo().uid, 0o700]);
}

function assertNoSecret(result: { stdout: string; stderr: string }, receipt?: McporterReceipt): void {
	const serialized = receipt === undefined ? "" : JSON.stringify(receipt);
	for (const secret of ALL_SECRETS) {
		expect(result.stdout).not.toContain(secret);
		expect(result.stderr).not.toContain(secret);
		expect(serialized).not.toContain(secret);
	}
}

// A test-owned copy of the plugin's Canva source and shared bin helpers, so a
// configuration perturbation never touches the real skill.
function pluginCopy(): { launcher: string; config: string } {
	const copy = path.join(harness.root, "plugin");
	cpSync(path.join(PLUGIN_ROOT, "bin"), path.join(copy, "bin"), { recursive: true, filter: (source) => path.basename(source) !== "connectors" });
	cpSync(SKILL, path.join(copy, "skills", "canva"), { recursive: true });
	return { launcher: path.join(copy, "skills", "canva", "scripts", "canva.ts"), config: path.join(copy, "skills", "canva", "config") };
}

describe("Canva launcher contract", () => {
	test("help and the cause catalogue match the accepted command and exit set", async () => {
		// Independent oracle: restated from SKILL.md's refusal list, not imported.
		expect(CAUSE_EXIT).toEqual({
			"command-invalid": 2,
			"account-invalid": 2,
			"arguments-invalid": 2,
			"flag-forbidden": 2,
			"route-invalid": 2,
			"client-mode-not-admitted": 3,
			"legacy-cache-present": 3,
			"vault-root-invalid": 3,
			"client-mode-invalid": 4,
			"registry-identity-invalid": 4,
			"executable-missing": 4,
			"execve-unavailable": 4,
			"exec-failed": 4,
		});
		const help = await canva(["--help"]);
		expect([help.code, help.stdout, help.stderr]).toEqual([0, "canva <login|status|list|call> --account <slug> [flags]\n", ""]);
	});
});

describe("Canva native custody configuration", () => {
	test("registry declares only dynamic-registration OAuth on the fixed endpoint with the four read tools", () => {
		expect(JSON.parse(readFileSync(path.join(SKILL, "config", "mcporter.json"), "utf8"))).toEqual({
			$schema: "https://raw.githubusercontent.com/openclaw/mcporter/main/mcporter.schema.json",
			imports: [],
			mcpServers: {
				[EXPECTED_SERVER]: {
					description: "Canva Official remote MCP, read-only design discovery, with the OAuth grant in MCPorter's per-account native vault",
					baseUrl: "https://mcp.canva.com/mcp",
					auth: "oauth",
					clientName: "Connectors plugin",
					allowedTools: EXPECTED_ALLOWED_TOOLS,
				},
			},
		});
	});

	test("route declares MCPorter OAuth behind the Canva launcher and the switch selects dcr", () => {
		expect(JSON.parse(readFileSync(path.join(SKILL, "config", "route.json"), "utf8"))).toEqual({
			defaultProvider: EXPECTED_SERVER,
			selectors: { account: "CANVA_ACCOUNT" },
			oauth: "mcporter",
			dispatcherOwned: true,
		});
		expect(JSON.parse(readFileSync(path.join(SKILL, "config", "client.json"), "utf8"))).toEqual({ mode: "dcr" });
	});
});

describe("Canva attended login and reads through MCPorter's vault", () => {
	test("login replaces itself with attended MCPorter auth under the account's own private vault root", async () => {
		const result = await canva(["login", "--account", "personal", "--no-browser"]);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const receipt = harness.receipt<McporterReceipt>("mcporter.json");
		expect(receipt.argv).toEqual(["--config", path.join(SKILL, "config", "mcporter.json"), "auth", EXPECTED_SERVER, "--no-browser"]);
		expect(receipt.pid).toBe(result.pid);
		expect([receipt.env.XDG_DATA_HOME, receipt.env.XDG_CACHE_HOME, receipt.env.CANVA_ACCOUNT, receipt.env.MCPORTER_NO_KEEPALIVE]).toEqual([
			path.join(harness.root, "connectors", "canva-mcporter", "personal", "data"),
			path.join(harness.root, "connectors", "canva-mcporter", "personal", "cache"),
			"personal",
			"*",
		]);
		for (const directory of ["", "data", "cache"]) assertPrivateDirectory(path.join(vaultRoot("personal"), directory));
		assertNoSecret(result, receipt);
	});

	test("two accounts receive independent vault roots, never a shared MCPorter data home", async () => {
		const personal = await canva(["login", "--account", "personal"]);
		const personalEnv = harness.receipt<McporterReceipt>("mcporter.json").env;
		const work = await canva(["login", "--account", "work"]);
		const workEnv = harness.receipt<McporterReceipt>("mcporter.json").env;
		expect([personal.code, work.code]).toEqual([0, 0]);
		expect([personalEnv.XDG_DATA_HOME, workEnv.XDG_DATA_HOME]).toEqual([path.join(vaultRoot("personal"), "data"), path.join(vaultRoot("work"), "data")]);
		assertPrivateDirectory(vaultRoot("work"));
	});

	test("a read uses the cached grant with --no-oauth and never the attended flow", async () => {
		const result = await canva(["call", "--account", "personal", "search-designs", "--args", '{"query":"onboarding"}']);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const receipt = assertCustody(harness, result, ALL_SECRETS);
		expect(receipt.argv).toEqual(["--config", path.join(SKILL, "config", "mcporter.json"), "call", `${EXPECTED_SERVER}.search-designs`, "--args", '{"query":"onboarding"}', "--no-oauth"]);
		expect([receipt.kind, receipt.env.XDG_DATA_HOME]).toEqual(["http", path.join(vaultRoot("personal"), "data")]);
		const list = await canva(["list", "--account", "personal", "--schema", "--json"]);
		expect(assertCustody(harness, list, ALL_SECRETS).argv).toEqual(["--config", path.join(SKILL, "config", "mcporter.json"), "list", EXPECTED_SERVER, "--schema", "--json", "--no-oauth"]);
	});

	test("a grant sentinel inside the account vault and a legacy session stay in place and never reach output or MCPorter argv", async () => {
		const vaultFile = path.join(vaultRoot("personal"), "data", "mcporter", "credentials.json");
		const legacyFile = path.join(harness.root, "connectors", "canva", "personal", "session.json");
		for (const [file, secret] of [[vaultFile, GRANT_SENTINEL], [legacyFile, LEGACY_SENTINEL]] as const) {
			mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			writeFileSync(file, JSON.stringify({ token: secret }), { mode: 0o600 });
		}
		const status = await canva(["status", "--account", "personal"]);
		expect([status.code, status.stderr]).toEqual([0, ""]);
		expect(JSON.parse(status.stdout)).toEqual({ account: "personal", custody: "mcporter-native", clientMode: "dcr", clientModeAdmitted: true, vaultFile: "present", legacySession: "preserved" });
		const read = await canva(["call", "--account", "personal", "get-design", "--args", '{"designId":"D1"}']);
		assertNoSecret(status);
		assertNoSecret(read, harness.receipt<McporterReceipt>("mcporter.json"));
		expect([readFileSync(vaultFile, "utf8"), readFileSync(legacyFile, "utf8")]).toEqual([JSON.stringify({ token: GRANT_SENTINEL }), JSON.stringify({ token: LEGACY_SENTINEL })]);
		expect(existsSync(path.join(harness.root, "connectors", "canva-mcporter", "work"))).toBe(false);
	});

	test("status of a fresh account is inspect-only and creates no vault root", async () => {
		const result = await canva(["status", "--account", "work"]);
		expect([result.code, result.stderr, JSON.parse(result.stdout)]).toEqual([0, "", { account: "work", custody: "mcporter-native", clientMode: "dcr", clientModeAdmitted: true, vaultFile: "absent", legacySession: "absent" }]);
		expect([existsSync(vaultRoot("work")), harness.has("mcporter.json")]).toEqual([false, false]);
	});
});

describe("Canva refusals before MCPorter or vault state", () => {
	test("the reserved approved client mode refuses every non-inspect command with no fallback", async () => {
		const copy = pluginCopy();
		writeFileSync(path.join(copy.config, "client.json"), JSON.stringify({ mode: "approved" }));
		for (const argv of [["login", "--account", "personal"], ["call", "--account", "personal", "search-designs"], ["list", "--account", "personal"]]) {
			const result = await canva(argv, copy.launcher);
			expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "canva:error:client-mode-not-admitted:client mode approved is not yet built or admitted; select dcr in config/client.json\n"]);
		}
		const status = await canva(["status", "--account", "personal"], copy.launcher);
		expect([status.code, JSON.parse(status.stdout).clientMode, JSON.parse(status.stdout).clientModeAdmitted]).toEqual([0, "approved", false]);
		expect([harness.has("mcporter.json"), existsSync(vaultRoot("personal"))]).toEqual([false, false]);
	});

	test("an unknown client mode and a registry client override both refuse as configuration defects", async () => {
		const copy = pluginCopy();
		writeFileSync(path.join(copy.config, "client.json"), JSON.stringify({ mode: "cimd" }));
		const unknown = await canva(["login", "--account", "personal"], copy.launcher);
		expect([unknown.code, unknown.stderr]).toEqual([4, "canva:error:client-mode-invalid:config/client.json mode must be dcr or approved\n"]);
		writeFileSync(path.join(copy.config, "client.json"), JSON.stringify({ mode: "dcr" }));
		const registryPath = path.join(copy.config, "mcporter.json");
		const registry = JSON.parse(readFileSync(registryPath, "utf8"));
		// MCPorter's camelCase and snake_case identity, token-cache, bearer, and
		// command spellings, plus an unknown key: each must refuse.
		const overrides = [
			{ oauthClientMetadataUrl: "https://example.test/client.json" },
			{ oauthClientId: "portal-client" },
			{ tokenCacheDir: "~/shared" },
			{ oauth_client_id: "portal-client" },
			{ oauth_client_metadata_url: "https://example.test/client.json" },
			{ token_cache_dir: "~/shared" },
			{ bearerToken: "fixture" },
			{ bearer_token_env: "CANVA_TOKEN" },
			{ oauthCommand: { args: ["login"] } },
			{ futureOption: true },
		];
		for (const override of overrides) {
			writeFileSync(registryPath, JSON.stringify({ ...registry, mcpServers: { [EXPECTED_SERVER]: { ...registry.mcpServers[EXPECTED_SERVER], ...override } } }));
			const result = await canva(["login", "--account", "personal"], copy.launcher);
			expect([Object.keys(override)[0], result.code, result.stdout, result.stderr]).toEqual([
				Object.keys(override)[0],
				4,
				"",
				"canva:error:registry-identity-invalid:the Canva server must declare OAuth on https://mcp.canva.com/mcp using only description, baseUrl, auth, clientName, and allowedTools\n",
			]);
		}
		expect([harness.has("mcporter.json"), existsSync(vaultRoot("personal"))]).toEqual([false, false]);
	});

	test("a pre-existing MCPorter home cache for the server refuses instead of migrating into an account", async () => {
		const legacy = path.join(harness.home, ".mcporter", EXPECTED_SERVER);
		mkdirSync(legacy, { recursive: true });
		writeFileSync(path.join(legacy, "tokens.json"), JSON.stringify({ access_token: GRANT_SENTINEL }));
		const result = await canva(["call", "--account", "personal", "search-designs"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", `canva:error:legacy-cache-present:a MCPorter cache for ${EXPECTED_SERVER} exists under HOME/.mcporter; move it aside, Connectors never imports it\n`]);
		expect([harness.has("mcporter.json"), existsSync(vaultRoot("personal")), existsSync(path.join(legacy, "tokens.json"))]).toEqual([false, false, true]);
	});

	test("missing, malformed, and misplaced account selections and machine-mode login refuse as usage", async () => {
		const cases: [string[], string][] = [
			[["login"], "canva:error:account-invalid:--account <slug> must follow the command\n"],
			[["call", "search-designs", "--account", "personal"], "canva:error:account-invalid:--account <slug> must follow the command\n"],
			[["status", "--account", "Personal"], "canva:error:account-invalid:--account needs a lowercase slug matching ^[a-z][a-z0-9-]{0,31}$\n"],
			[["login", "--account", "personal", "--json"], "canva:error:flag-forbidden:login accepts only --no-browser and --reset\n"],
			[["logout", "--account", "personal"], "canva:error:command-invalid:usage: canva <login|status|list|call> --account <slug> [flags]\n"],
		];
		for (const [argv, stderr] of cases) {
			const result = await canva(argv);
			expect([result.code, result.stdout, result.stderr]).toEqual([2, "", stderr]);
		}
		expect(harness.has("mcporter.json")).toBe(false);
	});

	test("a route-forbidden MCPorter flag refuses through the shared route's own vocabulary", async () => {
		const result = await canva(["call", "--account", "personal", "search-designs", "--config", "/tmp/other.json"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([2, "", "canva:error:route-invalid:the shared route refused the MCPorter arguments (flag-forbidden)\n"]);
		expect([harness.has("mcporter.json"), existsSync(vaultRoot("personal"))]).toEqual([false, false]);
	});

	test("a secret-shaped argv value never appears in any refusal", async () => {
		const cases: [string[], number, string][] = [
			[["login", "--account", "personal", ARGV_SENTINEL], 2, "canva:error:flag-forbidden:login accepts only --no-browser and --reset\n"],
			[["login", "--account", "personal", `--token=${ARGV_SENTINEL}`], 2, "canva:error:flag-forbidden:login accepts only --no-browser and --reset\n"],
			[["call", "--account", "personal", "search-designs", `--${ARGV_SENTINEL}`], 2, "canva:error:route-invalid:the shared route refused the MCPorter arguments (flag-forbidden)\n"],
			[["call", "--account", "personal", "search-designs", ARGV_SENTINEL], 2, "canva:error:route-invalid:the shared route refused the MCPorter arguments (argument-invalid)\n"],
			[["status", "--account", "personal", ARGV_SENTINEL], 2, "canva:error:arguments-invalid:status takes no further arguments\n"],
			[[ARGV_SENTINEL, "--account", "personal"], 2, "canva:error:command-invalid:usage: canva <login|status|list|call> --account <slug> [flags]\n"],
			[["status", "--account", `${ARGV_SENTINEL}_`], 2, "canva:error:account-invalid:--account needs a lowercase slug matching ^[a-z][a-z0-9-]{0,31}$\n"],
		];
		for (const [argv, code, stderr] of cases) {
			const result = await canva(argv);
			expect([result.code, result.stdout, result.stderr]).toEqual([code, "", stderr]);
			assertNoSecret(result);
		}
		expect([harness.has("mcporter.json"), existsSync(vaultRoot("personal"))]).toEqual([false, false]);
	});

	test("a symlinked account vault root refuses and never follows the link", async () => {
		const elsewhere = path.join(harness.root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(path.dirname(vaultRoot("personal")), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, vaultRoot("personal"));
		const result = await canva(["login", "--account", "personal"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "canva:error:vault-root-invalid:the account vault root is not a private owned directory (symlink)\n"]);
		expect([harness.has("mcporter.json"), readdirSync(elsewhere)]).toEqual([false, []]);
	});

	test("a missing MCPorter refuses as a dependency defect before any vault directory exists", async () => {
		const result = await canva(["login", "--account", "personal"], LAUNCHER, { PATH: "/usr/bin:/bin" });
		expect([result.code, result.stdout, result.stderr]).toEqual([4, "", "canva:error:executable-missing:mcporter is not available on PATH\n"]);
		expect([harness.has("mcporter.json"), existsSync(path.dirname(vaultRoot("personal")))]).toEqual([false, false]);
	});
});

describe("physical-path seam for a packaged adapter", () => {
	// Private-module proof: a compiled binary cannot use import.meta.dir, so the
	// adapter must be able to name the physical skills root and config dir.
	test("an explicit skills root and config dir are honoured and planning creates no vault", () => {
		const skillsRoot = path.join(harness.root, "physical", "skills");
		cpSync(SKILL, path.join(skillsRoot, "canva"), { recursive: true });
		const configDir = path.join(skillsRoot, "canva", "config");
		writeFileSync(path.join(configDir, "client.json"), JSON.stringify({ mode: "approved" }));
		const env = { HOME: harness.home, PATH: "/usr/bin:/bin", XDG_STATE_HOME: harness.root };
		const { plan, vault } = planCanvaRoute(env, "personal", ["list"], skillsRoot);
		expect([readClientMode(configDir), readClientMode(), plan.configPath, plan.env.XDG_DATA_HOME, vault.root]).toEqual([
			"approved",
			"dcr",
			path.join(skillsRoot, "canva", "config", "mcporter.json"),
			path.join(vaultRoot("personal"), "data"),
			vaultRoot("personal"),
		]);
		expect(existsSync(vaultRoot("personal"))).toBe(false);
	});
});

describe("shared route regression", () => {
	test("the public route refuses Canva, so no read can reach the shared HOME vault", async () => {
		const result = await harness.run(["canva", "--select", "account=personal", "--", "auth"]);
		expect([result.code, result.stdout, result.stderr]).toEqual([3, "", "provider-route:error:dispatcher-owned:skill canva accepts provider transport only through its semantic dispatcher\n"]);
		expect(harness.has("mcporter.json")).toBe(false);
	});

	test("Figma's standalone route keeps MCPorter's default vault and gains no Canva data root", async () => {
		const result = await harness.run(["figma", "--", "auth", "--no-browser"], {}, ROUTE);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const receipt = harness.receipt<McporterReceipt>("mcporter.json");
		expect(receipt.argv).toEqual(["--config", path.join(PLUGIN_ROOT, "skills", "figma", "config", "mcporter.json"), "auth", "figma-connectors", "--no-browser"]);
		expect([receipt.env.XDG_DATA_HOME, receipt.env.XDG_CACHE_HOME, receipt.env.CANVA_ACCOUNT]).toEqual([undefined, undefined, undefined]);
	});
});
