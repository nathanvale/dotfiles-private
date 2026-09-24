// T2 (Ticket #89 under Spec #87): the generic command core (list, config
// validate/show, status, doctor, schema) reaches every connector through its
// manifest and transport registry alone, spawning the compiled binary as a
// real child process. Expected values are independent literals, never
// re-derived from bin/connectors.ts's own envelope-building code.
import { describe, expect, test } from "bun:test";
import { createBundle, createFakeMcporterBinDir, runBundle } from "./harness.ts";

describe("connectors list", () => {
	test("lists the real keyless Skills declared by a manifest, sorted", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["list"], { home: bundle.root });
			expect(result.code).toBe(0);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.data.connectors).toEqual([
				{ id: "context7", adapter: null, keyless: true, requirements: [] },
				{ id: "firecrawl", adapter: null, keyless: true, requirements: [] },
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
	const KEYLESS_EVIDENCE = { configured: true, localReady: true, custodyChecked: null, authenticated: false, schemaQualified: false, liveReadProven: false, liveWriteProven: false, fixtureTested: null };

	test("pins the exact evidence map for both known connectors and reports exactly two, never zero", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["status"], { home: bundle.root });
			expect(result.code).toBe(0);
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

	test("an unknown connector id refuses with a usage cause naming the exact repair, never a crash", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["status", "not-a-real-connector"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(2);
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.causeCode).toBe("USAGE_CONNECTOR_UNKNOWN");
		} finally {
			bundle.dispose();
		}
	});
});

describe("connectors config show: Spec AC24 resolved provenance", () => {
	test("identifies the source of every effective nonsecret value, distinguishing packaged defaults from invocation selectors", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const result = await runBundle(bundle, ["config", "show", "keyless-fixture-skill", "--resolved", "--json", "--select", "region=au"], { home: bundle.root });
			expect(result.code).toBe(0);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.data.values.custodyMode).toEqual({ value: "keyless", source: "packaged-manifest-default" });
			expect(envelope.result.data.values.region).toEqual({ value: "au", source: "invocation-selector" });
		} finally {
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
			expect(result.stdout).not.toContain(sentinel);
			expect(result.stderr).not.toContain(sentinel);
		} finally {
			bundle.dispose();
		}
	});
});

describe("connectors doctor", () => {
	test("a keyless connector is locally ready with no custody claim", async () => {
		const bundle = createBundle();
		try {
			const result = await runBundle(bundle, ["doctor", "firecrawl"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(0);
			expect(envelope.result.data).toEqual({ connector: "firecrawl", localReady: true, custodyChecked: null });
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

	test("reaches Context7 and Firecrawl through the identical generic code path, unbypassed by any connector-name branch", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			for (const [id, expected] of Object.entries(REAL_KEYLESS_CONNECTORS)) {
				const result = await runBundle(bundle, ["schema", id], { home: bundle.root, binDir: mcporterBin.binDir });
				const envelope = JSON.parse(result.stdout);
				expect(result.code).toBe(0);
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
			expect(envelope.result.causeCode).toBe("DOMAIN_CUSTODY_NOT_SUPPORTED");
		} finally {
			bundle.dispose();
		}
	});
});
