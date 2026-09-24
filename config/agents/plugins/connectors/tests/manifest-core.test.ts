// T2 (Ticket #89 under Spec #87): the generic command core (list, config
// validate/show, status, doctor, schema) reaches every connector through its
// manifest and transport registry alone, spawning the compiled binary as a
// real child process. Expected values are independent literals, never
// re-derived from bin/connectors.ts's own envelope-building code.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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

	test("pins the exact evidence map for both known connectors and reports exactly two, never zero", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["status"], { home: bundle.root });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.data.connectors).toEqual([
				{ id: "context7", evidence: KEYLESS_EVIDENCE },
				{ id: "firecrawl", evidence: KEYLESS_EVIDENCE },
			]);
			expect(envelope.result.data.problems).toEqual([]);
		} finally {
			bundle.dispose();
		}
	});

	test("both status forms refuse one malformed packaged requirements file before dependency effects", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			writeFileSync(path.join(bundle.root, "requirements.json"), '{"schemaVersion":1,"pins":{"mcporter":14}}');
			for (const argv of [["status"], ["status", "context7"]]) {
				const result = await runBundle(bundle, argv, { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
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
				expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

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
					const result = await runBundle(bundle, argv, { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
					expect(result.code).toBe(4);
					expect(result.stderr).toBe("");
					expect(result.stdout).not.toContain(sentinel);
					const envelope = JSON.parse(result.stdout);
					expect(envelope.result.outcome).toBe("refused");
					expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
					expect(envelope.result.data).toBeNull();
					expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
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
				const result = await runBundle(bundle, ["config", "show", "keyless-fixture-skill", "--resolved", "--json"], { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
				expect(result.code).toBe(4);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(sentinel);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.result.outcome).toBe("refused");
				expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
				expect(envelope.result.data).toBeNull();
				expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
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
				const result = await runBundle(bundle, argv, { home: bundle.root, binDir: mcporterBin.binDir, extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel } });
				expect(result.code).toBe(4);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(sentinel);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.result.commandIdentity).toBe(identity);
				expect(envelope.result.outcome).toBe("refused");
				expect(envelope.result.causeCode).toBe("SCHEMA_REQUIREMENTS_INVALID");
				expect(envelope.result.data).toBeNull();
				expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
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

	test("an adapter declaration does not promote doctor into custody or authentication proof", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["doctor", "adapter-fixture-skill"], { home: bundle.root });
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout).result.data).toEqual({
				connector: "adapter-fixture-skill",
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

	test("drains more than pipe capacity from MCPorter stderr and returns one clean schema envelope", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		try {
			writeFileSync(path.join(bundle.root, "mcporter-noisy-stderr-request.json"), JSON.stringify({ bytes: NOISY_STDERR_BYTES }));
			const result = await runBundle(bundle, ["schema", "context7"], {
				home: bundle.root,
				binDir: mcporterBin.binDir,
				timeoutMs: 10_000,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: sentinel, AMBIENT_SENTINEL: sentinel },
			});
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(sentinel);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.envelopeVersion).toBe(2);
			expect(envelope.message).toBe("schema evidence fetched for context7");
			expect(envelope.result).toEqual({
				runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
				commandIdentity: "connectors.schema",
				outcome: "success",
				failureClass: null,
				exitCode: 0,
				data: {
					connector: "context7",
					server: "context7",
					allowedTools: ["resolve-library-id", "query-docs"],
					schema: { fake: true, kind: "http", server: "context7", url: "https://mcp.context7.com/mcp" },
				},
				retryable: false,
				repairAction: null,
				nextAction: "connectors.status",
				effectClass: "inspect",
				transactionState: "unchanged",
				causeCode: "SUCCESS_UNCHANGED",
				effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
			});
			const receipt = JSON.parse(readFileSync(path.join(bundle.root, "mcporter.json"), "utf8"));
			expect(receipt.kind).toBe("http");
			expect(receipt.argv.slice(-4)).toEqual(["list", "context7", "--json", "--no-oauth"]);
			expect(receipt.env.MCPORTER_NO_KEEPALIVE).toBe("*");
			expect(receipt.env).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
			expect(receipt.env).not.toHaveProperty("AMBIENT_SENTINEL");
			expect(JSON.parse(readFileSync(path.join(bundle.root, "mcporter-noisy-stderr-receipt.json"), "utf8"))).toEqual({ bytesWritten: NOISY_STDERR_BYTES });
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("reaches Context7 and Firecrawl through the identical generic code path, unbypassed by any connector-name branch", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			expect(Object.keys(REAL_KEYLESS_CONNECTORS)).toEqual(["context7", "firecrawl"]);
			for (const [id, expected] of Object.entries(REAL_KEYLESS_CONNECTORS)) {
				const result = await runBundle(bundle, ["schema", id], { home: bundle.root, binDir: mcporterBin.binDir });
				const envelope = JSON.parse(result.stdout);
				expect(result.code).toBe(0);
				expect(result.stderr).toBe("");
				expect(envelope.result.outcome).toBe("success");
				expect(envelope.result.data.connector).toBe(id);
				expect(envelope.result.data.server).toBe(id);
				expect(envelope.result.data.allowedTools).toEqual(expected.allowedTools);
				// mcporter-fake.ts's documented http-branch contract (unmodified
				// shared test infrastructure, not this Ticket's own code): its
				// stdout is exactly {fake:true, kind:"http", server, url}, so the
				// live envelope's schema field is checked against that exact
				// external shape, not merely "is an object".
				expect(envelope.result.data.schema).toEqual({ fake: true, kind: "http", server: id, url: expected.url });
				// The fake mcporter's own receipt (an observable process fact,
				// independent of connectors.ts) proves this run actually spawned
				// a process against the connector's real declared endpoint,
				// through the identical schema() code path for both ids.
				const receipt = JSON.parse(await Bun.file(`${bundle.root}/mcporter.json`).text());
				expect(receipt.kind).toBe("http");
				expect(receipt.url).toBe(expected.url);
				expect(receipt.argv).toContain("--config");
				expect(receipt.argv.some((token: string) => token.endsWith(`/skills/${id}/config/mcporter.json`))).toBe(true);
			}
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("reaches a manifest-only keyless fixture Skill through the same generic path via a real stdio child", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const result = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home: bundle.root, binDir: mcporterBin.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(envelope.result.data.connector).toBe("keyless-fixture-skill");
			// Independent literal, hand-copied from the checked-in fixture's own
			// config/mcporter.json, not read from disk at test time: its one
			// declared tool name.
			expect(envelope.result.data.allowedTools).toEqual(["probe"]);
			// Independent of connectors.ts's own output: the fake mcporter's own
			// receipt proves it actually spawned the fixture's declared stdio
			// child (never an http branch, never a different server), through
			// the identical schema() code path used for context7/firecrawl above.
			const receipt = JSON.parse(await Bun.file(`${bundle.root}/mcporter.json`).text());
			expect(receipt.kind).toBe("stdio");
			expect(receipt.command.endsWith("/skills/stdio-probe-server.ts")).toBe(true);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("refuses for a credential-bearing connector with a clear domain cause, never a silent or crashed attempt", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["schema", "adapter-fixture-skill"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(envelope.result.causeCode).toBe("DOMAIN_CUSTODY_NOT_SUPPORTED");
		} finally {
			bundle.dispose();
		}
	});
});
