// T2 (Ticket #89 under Spec #87): the generic command core (list, config
// validate/show, status, doctor, schema) reaches every connector through its
// manifest and transport registry alone, spawning the compiled binary as a
// real child process. Expected values are independent literals, never
// re-derived from bin/connectors.ts's own envelope-building code.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startLoopbackMcpStub } from "./fixtures/loopback-mcp-stub.ts";
import { createBundle, createFakeMcporterBinDir, runBundle } from "./harness.ts";

describe("connectors list", () => {
	test("lists the real keyless Skills declared by a manifest, sorted", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["list"], { home: bundle.root });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.data.connectors).toEqual([
				{ id: "context7", adapter: null, keyless: true, requirements: ["mcporter"] },
				{ id: "firecrawl", adapter: null, keyless: true, requirements: ["mcporter"] },
			]);
			expect(envelope.result.data.problems).toEqual([]);
		} finally {
			bundle.dispose();
		}
	});
});

describe("connectors status: Spec AC21 truthful evidence states", () => {
	// Independent literal, pinned exactly: a passing assertion inside a loop
	// over an empty array would never fail even if status stopped reporting
	// anything, so the full two-connector map is asserted by toEqual instead
	// of iterated. Both ids and the complete evidence shape are hand-typed
	// here, never read back from the manifest or the live envelope.
	const KEYLESS_EVIDENCE = { configured: true, localReady: null, custodyChecked: null, authenticated: false, schemaQualified: false, liveReadProven: false, liveWriteProven: false, fixtureTested: null };

	test("both status forms refuse one malformed packaged requirements file before dependency effects", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			writeFileSync(path.join(bundle.root, "requirements.json"), '{"schemaVersion":1,"pins":{"mcporter":14}}');
			for (const argv of [["status"], ["status", "context7"]]) {
				const result = await runBundle(bundle, argv, { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { XDG_STATE_HOME: bundle.root, OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
				expect(result.code).toBe(4);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(sentinel);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.envelopeVersion).toBe(2);
				expect(envelope.result).toEqual({
					runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
					commandIdentity: "connectors.status",
					outcome: "refused",
					failureClass: "schema",
					exitCode: 4,
					data: null,
					retryable: false,
					repairAction: expect.any(String),
					nextAction: "connectors.config.validate",
					effectClass: "inspect",
					transactionState: "unchanged",
					causeCode: "SCHEMA_REQUIREMENTS_INVALID",
					effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
				});
				expect(envelope.result.repairAction.length).toBeGreaterThan(0);
				expect(existsSync(path.join(bundle.root, "connectors"))).toBe(false);
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	// Exactly two connectors, never zero: an empty list would pass a
	// row-by-row check vacuously, so the expected rows are pinned literally.
	test("valid and absent requirements preserve truthful status evidence in both forms", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			for (const requirements of ["valid", "absent"]) {
				if (requirements === "absent") rmSync(path.join(bundle.root, "requirements.json"));
				for (const [argv, expectedConnectors] of [
					[["status"], [{ id: "context7", evidence: KEYLESS_EVIDENCE }, { id: "firecrawl", evidence: KEYLESS_EVIDENCE }]],
					[["status", "context7"], [{ id: "context7", evidence: KEYLESS_EVIDENCE }]],
				] as const) {
					const result = await runBundle(bundle, [...argv], { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
					expect(result.code).toBe(0);
					expect(result.stderr).toBe("");
					expect(result.stdout).not.toContain(sentinel);
					const envelope = JSON.parse(result.stdout);
					expect(envelope.result.commandIdentity).toBe("connectors.status");
					expect(envelope.result.outcome).toBe("success");
					expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
					expect(envelope.result.data).toEqual({ connectors: expectedConnectors, problems: [] });
					expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
				}
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("an unknown connector id refuses with a usage cause naming the exact repair, never a crash", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["status", "not-a-real-connector"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(2);
			expect(result.stderr).toBe("");
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.causeCode).toBe("USAGE_CONNECTOR_UNKNOWN");
		} finally {
			bundle.dispose();
		}
	});
});

describe("connectors config show: Spec AC24 resolved provenance", () => {
	test("a packaged selector default yields to an invocation selector with distinct provenance", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.selectors.region.default = "us";
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const defaults = await runBundle(bundle, ["config", "show", "keyless-fixture-skill", "--resolved", "--json"], { home: bundle.root });
			expect(defaults.code).toBe(0);
			expect(defaults.stderr).toBe("");
			expect(JSON.parse(defaults.stdout).result.data.values).toEqual({
				connector: { value: "keyless-fixture-skill", source: "invocation" },
				adapter: { value: "none", source: "packaged-manifest-default" },
				custodyMode: { value: "keyless", source: "packaged-manifest-default" },
				transportRegistry: { value: "./mcporter.json", source: "packaged-manifest-default" },
				requirements: { value: [], source: "packaged-manifest-default" },
				region: { value: "us", source: "packaged-manifest-default" },
			});
			const selected = await runBundle(bundle, ["config", "show", "keyless-fixture-skill", "--resolved", "--json", "--select", "region=au"], { home: bundle.root });
			expect(selected.code).toBe(0);
			expect(selected.stderr).toBe("");
			expect(JSON.parse(selected.stdout).result.data.values.region).toEqual({ value: "au", source: "invocation-selector" });
		} finally {
			bundle.dispose();
		}
	});

	test("a packaged default outside its declared pattern refuses before becoming effective", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			for (const invalidDefault of ["AU", "au\n"]) {
				manifest.selectors.region.default = invalidDefault;
				writeFileSync(manifestPath, JSON.stringify(manifest));
				for (const argv of [
					["config", "validate", "keyless-fixture-skill"],
					["config", "show", "keyless-fixture-skill", "--resolved", "--json", "--select", "region=au"],
				]) {
					const result = await runBundle(bundle, argv, { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { XDG_STATE_HOME: bundle.root, OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
					expect(result.code).toBe(4);
					expect(result.stderr).toBe("");
					expect(result.stdout).not.toContain(sentinel);
					const envelope = JSON.parse(result.stdout);
					expect(envelope.result.outcome).toBe("refused");
					expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
					expect(envelope.result.data).toBeNull();
					expect(existsSync(path.join(bundle.root, "connectors"))).toBe(false);
				}
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("reserved selector names cannot replace resolved fields or dependency provenance", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const original = JSON.parse(readFileSync(manifestPath, "utf8"));
			for (const name of ["connector", "custodyMode", "dependency:mcporter"]) {
				writeFileSync(manifestPath, JSON.stringify({ ...original, selectors: { [name]: { default: "attacker" } } }));
				const result = await runBundle(bundle, ["config", "show", "keyless-fixture-skill", "--resolved", "--json"], { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { XDG_STATE_HOME: bundle.root, OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
				expect(result.code).toBe(4);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(sentinel);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.result.outcome).toBe("refused");
				expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
				expect(envelope.result.data).toBeNull();
				expect(existsSync(path.join(bundle.root, "connectors"))).toBe(false);
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("conflicting repeated selections refuse while an identical repeat stays effective", async () => {
		const bundle = createBundle();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			bundle.addSkill("keyless-fixture-skill");
			const base = ["config", "show", "keyless-fixture-skill", "--resolved", "--json", "--select", "region=au", "--select"];
			const conflicting = await runBundle(bundle, [...base, "region=us"], { home: bundle.root, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
			expect(conflicting.code).toBe(2);
			expect(conflicting.stderr).toBe("");
			expect(conflicting.stdout).not.toContain(sentinel);
			const refusal = JSON.parse(conflicting.stdout);
			expect(refusal.result.commandIdentity).toBe("connectors.config.show");
			expect(refusal.result.outcome).toBe("refused");
			expect(refusal.result.causeCode).toBe("USAGE_MALFORMED_ARGUMENTS");
			expect(refusal.result.data).toBeNull();
			const identical = await runBundle(bundle, [...base, "region=au"], { home: bundle.root });
			expect(identical.code).toBe(0);
			expect(identical.stderr).toBe("");
			expect(JSON.parse(identical.stdout).result.data.values.region).toEqual({ value: "au", source: "invocation-selector" });
			const help = await runBundle(bundle, ["--help"], { home: bundle.root });
			expect(help.code).toBe(0);
			expect(help.stderr).toBe("");
			expect(help.stdout).toContain("Repeated --select names must carry identical values");
			const discovery = await runBundle(bundle, ["--discover", "--json"], { home: bundle.root });
			expect(discovery.code).toBe(0);
			expect(discovery.stderr).toBe("");
			expect(JSON.parse(discovery.stdout).result.data.commands.filter((command: { commandIdentity: string }) => command.commandIdentity === "connectors.config.show")).toEqual([
				{
					commandIdentity: "connectors.config.show",
					route: ["config", "show"],
					effectClass: "inspect",
					summary: "Show resolved nonsecret values and provenance; conflicting repeated selectors refuse",
				},
			]);
		} finally {
			bundle.dispose();
		}
	});

	test("an adapter without a credential reference has no effective custody mode", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			bundle.addSkill("adapter-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "adapter-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.credentials = null;
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const result = await runBundle(bundle, ["config", "show", "adapter-fixture-skill", "--resolved", "--json"], { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(sentinel);
			expect(JSON.parse(result.stdout).result.data).toEqual({
				connector: "adapter-fixture-skill",
				values: {
					connector: { value: "adapter-fixture-skill", source: "invocation" },
					adapter: { value: "test-auth", source: "packaged-manifest-default" },
					custodyMode: { value: null, source: "not-yet-effective" },
					transportRegistry: { value: "./mcporter.json", source: "packaged-manifest-default" },
					requirements: { value: [], source: "packaged-manifest-default" },
				},
			});
			expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("a credential reference does not declare an effective custody mode", async () => {
		const bundle = createBundle();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["config", "show", "adapter-fixture-skill", "--resolved", "--json"], {
				home: bundle.root,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel },
			});
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(sentinel);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.commandIdentity).toBe("connectors.config.show");
			expect(envelope.result.outcome).toBe("success");
			expect(envelope.result.data).toEqual({
				connector: "adapter-fixture-skill",
				values: {
					connector: { value: "adapter-fixture-skill", source: "invocation" },
					adapter: { value: "test-auth", source: "packaged-manifest-default" },
					custodyMode: { value: null, source: "not-yet-effective" },
					transportRegistry: { value: "./mcporter.json", source: "packaged-manifest-default" },
					requirements: { value: [], source: "packaged-manifest-default" },
				},
			});
			expect(existsSync(path.join(bundle.root, "fixture-authority.json"))).toBe(false);
		} finally {
			bundle.dispose();
		}
	});

	test("reports the packaged dependency pin and every effective Context7 value from literal sources", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["config", "show", "context7", "--resolved", "--json"], { home: bundle.root });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout).result.data).toEqual({
				connector: "context7",
				values: {
					connector: { value: "context7", source: "invocation" },
					adapter: { value: "none", source: "packaged-manifest-default" },
					custodyMode: { value: "keyless", source: "packaged-manifest-default" },
					transportRegistry: { value: "./mcporter.json", source: "packaged-manifest-default" },
					requirements: { value: ["mcporter"], source: "packaged-manifest-default" },
					"dependency:mcporter": { value: "0.14.0", source: "packaged-requirements-pin" },
				},
			});
		} finally {
			bundle.dispose();
		}
	});

	test("an absent requirements file reports an unpinned dependency without inventing a version", async () => {
		const bundle = createBundle();
		try {
			rmSync(path.join(bundle.root, "requirements.json"));
			const result = await runBundle(bundle, ["config", "show", "context7", "--resolved", "--json"], { home: bundle.root });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout).result.data.values["dependency:mcporter"]).toEqual({ value: null, source: "not-yet-effective" });
		} finally {
			bundle.dispose();
		}
	});

	test("a malformed requirements pin refuses instead of appearing unpinned", async () => {
		const bundle = createBundle();
		try {
			writeFileSync(path.join(bundle.root, "requirements.json"), '{"schemaVersion":1,"pins":{"mcporter":14}}');
			const result = await runBundle(bundle, ["config", "show", "context7", "--resolved", "--json"], { home: bundle.root });
			expect(result.code).toBe(4);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.causeCode).toBe("SCHEMA_REQUIREMENTS_INVALID");
			expect(envelope.result.data).toBeNull();
		} finally {
			bundle.dispose();
		}
	});

	test("config validate and doctor refuse a malformed packaged requirements pin without dependency effects", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			writeFileSync(path.join(bundle.root, "requirements.json"), '{"schemaVersion":1,"pins":{"mcporter":14}}');
			const cases: [string[], string][] = [
				[["config", "validate"], "connectors.config.validate"],
				[["config", "validate", "context7"], "connectors.config.validate"],
				[["doctor", "context7"], "connectors.doctor"],
			];
			for (const [argv, identity] of cases) {
				const result = await runBundle(bundle, argv, { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { XDG_STATE_HOME: bundle.root, OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
				expect(result.code).toBe(4);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(sentinel);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.result.commandIdentity).toBe(identity);
				expect(envelope.result.outcome).toBe("refused");
				expect(envelope.result.causeCode).toBe("SCHEMA_REQUIREMENTS_INVALID");
				expect(envelope.result.data).toBeNull();
				expect(existsSync(path.join(bundle.root, "connectors"))).toBe(false);
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("a missing required selector refuses instead of silently omitting it", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const result = await runBundle(bundle, ["config", "show", "keyless-fixture-skill", "--resolved", "--json"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(result.stderr).toBe("");
			expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
		} finally {
			bundle.dispose();
		}
	});

	test("a secret-shaped sentinel in the process environment never appears anywhere in output", async () => {
		const bundle = createBundle();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			const result = await runBundle(bundle, ["config", "show", "context7", "--resolved", "--json"], { home: bundle.root, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(sentinel);
			expect(result.stderr).not.toContain(sentinel);
		} finally {
			bundle.dispose();
		}
	});
});

describe("connectors doctor", () => {
	test("a keyless manifest check leaves readiness and custody unproved", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["doctor", "firecrawl"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(envelope.result.data).toEqual({
				connector: "firecrawl",
				configured: true,
				localReady: null,
				custodyChecked: null,
				authenticated: false,
				schemaQualified: false,
				liveReadProven: false,
				liveWriteProven: false,
				fixtureTested: null,
			});
		} finally {
			bundle.dispose();
		}
	});

});

describe("connectors schema: Spec AC20 contribution (Context7 and Firecrawl reachable through the generic layer)", () => {
	// Independent literals, hand-copied from each Skill's own committed
	// config/mcporter.json (not read from disk at test time, and not
	// re-derived from connectors.ts): the exact hosted endpoint and exact
	// allow-listed tool names each real connector declares. A fake mcporter
	// returning arbitrary JSON for either id would fail this table, where a
	// bare "did it return something" assertion could not.
	const REAL_KEYLESS_CONNECTORS: Record<string, { url: string; allowedTools: readonly string[] }> = {
		context7: { url: "https://mcp.context7.com/mcp", allowedTools: ["resolve-library-id", "query-docs"] },
		firecrawl: { url: "https://mcp.firecrawl.dev/v2/mcp", allowedTools: ["firecrawl_search", "firecrawl_scrape"] },
	};
	const NOISY_STDERR_BYTES = 2_097_152;

	const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
	if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");
	function releaseEnv(root: string): Record<string, string> {
		if (!official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE must name verified official MCPorter fixture bytes");
		return { XDG_STATE_HOME: root, CONNECTORS_TEST_RELEASE_DIR: official };
	}

	test.skipIf(!official)("drains more than pipe capacity from MCPorter stderr and returns one clean schema envelope", async () => {
		const bundle = createBundle();
		const hostile = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			bundle.addSkill("keyless-fixture-skill");
			writeFileSync(path.join(bundle.root, "mcporter-noisy-stderr-request.json"), JSON.stringify({ bytes: NOISY_STDERR_BYTES }));
			const result = await runBundle(bundle, ["schema", "keyless-fixture-skill"], {
				home: bundle.root,
				binDir: hostile.binDir,
				timeoutMs: 30_000,
				extraEnv: { ...releaseEnv(bundle.root), OP_SERVICE_ACCOUNT_TOKEN: sentinel, AMBIENT_SENTINEL: sentinel },
			});
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			expect(result.stdout).not.toContain(sentinel);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.commandIdentity).toBe("connectors.schema");
			expect(envelope.result.causeCode).toBe("SUCCESS_BOOTSTRAPPED");
			expect(envelope.result.effects.completed).toEqual(["mcporter-bootstrap"]);
			expect(envelope.result.data.allowedTools).toEqual(["probe"]);
			expect(JSON.stringify(envelope.result.data.schema)).toContain("probe");
			expect(JSON.parse(readFileSync(path.join(bundle.root, "mcporter-noisy-stderr-receipt.json"), "utf8"))).toEqual({ bytesWritten: NOISY_STDERR_BYTES });
			expect(readFileSync(path.join(bundle.root, "probe-spawned"), "utf8")).toBe("spawned\n");
			expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
		} finally {
			hostile.dispose();
			bundle.dispose();
		}
	}, 30_000);

	test.skipIf(!official)("keeps Context7 and Firecrawl exact registries while the generic schema path uses selected MCPorter", async () => {
		const bundle = createBundle();
		const hostile = createFakeMcporterBinDir();
		try {
			const home = path.join(bundle.root, "hostile-home");
			const cwd = path.join(bundle.root, "hostile-cwd");
			mkdirSync(home); mkdirSync(cwd);
			const ambientRegistry = JSON.stringify({ imports: ["ambient-import"], mcpServers: { "keyless-fixture-skill": { baseUrl: "http://127.0.0.1:1/hostile", allowedTools: ["ambient-tool"] } } });
			writeFileSync(path.join(home, "mcporter.json"), ambientRegistry);
			writeFileSync(path.join(cwd, "mcporter.json"), ambientRegistry);
			writeFileSync(path.join(hostile.binDir, "mcporter"), '#!/bin/sh\nprintf "called\\n" > "$TMPDIR/ambient-shim-called"\nexit 91\n');
			expect(Object.keys(REAL_KEYLESS_CONNECTORS)).toEqual(["context7", "firecrawl"]);
			for (const [id, expected] of Object.entries(REAL_KEYLESS_CONNECTORS)) {
				const registry = JSON.parse(readFileSync(path.join(bundle.skillsRoot, id, "config", "mcporter.json"), "utf8"));
				expect(registry.imports).toEqual([]);
				expect(Object.keys(registry.mcpServers)).toEqual([id]);
				expect(registry.mcpServers[id].baseUrl).toBe(expected.url);
				expect(registry.mcpServers[id].allowedTools).toEqual(expected.allowedTools);
				const validation = await runBundle(bundle, ["config", "validate", id], { home: bundle.root });
				expect(validation.code).toBe(0);
				expect(validation.stderr).toBe("");
			}
			bundle.addSkill("keyless-fixture-skill");
			const result = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, cwd, binDir: hostile.binDir, extraEnv: releaseEnv(bundle.root), timeoutMs: 30_000 });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const data = JSON.parse(result.stdout).result.data;
			expect(data.connector).toBe("keyless-fixture-skill");
			expect(data.server).toBe("keyless-fixture-skill");
			expect(data.allowedTools).toEqual(["probe"]);
			expect(JSON.stringify(data.schema)).toContain('"name":"probe"');
			expect(JSON.stringify(data.schema)).not.toContain("ambient-tool");
			expect(readFileSync(path.join(bundle.root, "probe-spawned"), "utf8")).toBe("spawned\n");
			expect(existsSync(path.join(bundle.root, "ambient-shim-called"))).toBe(false);
			expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
		} finally {
			hostile.dispose();
			bundle.dispose();
		}
	}, 30_000);

	test.skipIf(!official)("schema reaches Context7 and Firecrawl through each one's own registry and the selected MCPorter, loopback only", async () => {
		const bundle = createBundle();
		const hostile = createFakeMcporterBinDir();
		const stub = startLoopbackMcpStub();
		try {
			writeFileSync(path.join(hostile.binDir, "mcporter"), '#!/bin/sh\nprintf "called\\n" > "$TMPDIR/ambient-shim-called"\nexit 91\n');
			expect(Object.keys(REAL_KEYLESS_CONNECTORS)).toEqual(["context7", "firecrawl"]);
			for (const [id, expected] of Object.entries(REAL_KEYLESS_CONNECTORS)) {
				// Only this id's registry reaches the stub; the other points at a
				// closed port, so a request routed through the wrong registry fails.
				for (const other of Object.keys(REAL_KEYLESS_CONNECTORS)) {
					const registryPath = path.join(bundle.skillsRoot, other, "config", "mcporter.json");
					const registry = JSON.parse(readFileSync(registryPath, "utf8"));
					registry.mcpServers[other].baseUrl = other === id ? stub.url : "http://127.0.0.1:1/mcp";
					writeFileSync(registryPath, JSON.stringify(registry));
				}
				const result = await runBundle(bundle, ["schema", id], { home: bundle.root, binDir: hostile.binDir, extraEnv: releaseEnv(bundle.root), timeoutMs: 30_000 });
				expect({ id, code: result.code, stderr: result.stderr, lines: result.stdout.trim().split("\n").length }).toEqual({ id, code: 0, stderr: "", lines: 1 });
				const envelope = JSON.parse(result.stdout);
				expect(envelope.result.commandIdentity).toBe("connectors.schema");
				expect({ connector: envelope.result.data.connector, server: envelope.result.data.server, allowedTools: envelope.result.data.allowedTools }).toEqual({ connector: id, server: id, allowedTools: expected.allowedTools });
				// MCPorter's own output: it listed this id's server from this id's
				// registry over the stub, and its allow-list hid the stub's "probe".
				const schema = envelope.result.data.schema;
				expect({ name: schema.name, status: schema.status, transport: schema.transport, source: schema.source, tools: schema.tools }).toEqual({
					name: id, status: "ok", transport: `HTTP ${stub.url}`, source: { kind: "local", path: expect.stringMatching(new RegExp(`/skills/${id}/config/mcporter\\.json$`)) }, tools: [],
				});
			}
			expect(existsSync(path.join(bundle.root, "ambient-shim-called"))).toBe(false);
			expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
		} finally {
			stub.stop();
			hostile.dispose();
			bundle.dispose();
		}
	}, 60_000);

	test("refuses for a credential-bearing connector with a clear domain cause, never a silent or crashed attempt", async () => {
		const bundle = createBundle();
		try {
			// challenge-auth declares a credential and has no prepareSchema step.
			bundle.addSkill("challenge-fixture-skill");
			const result = await runBundle(bundle, ["schema", "challenge-fixture-skill"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(envelope.result.causeCode).toBe("DOMAIN_CUSTODY_NOT_SUPPORTED");
		} finally {
			bundle.dispose();
		}
	});
});
