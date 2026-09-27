// Ticket #141 (F-c) under Spec #87 AC21: status and doctor report eight
// distinct evidence states from checks the packaged process actually performs
// in that invocation, each naming its verdict, basis, observation time, and
// boundary. Local checks and fixtures never promote a connector to a live
// state, and no write is proven without an exact effect receipt. Every case
// spawns the bundle's compiled binary with its own HOME, XDG state, and PATH.
// Expected tables are hand-written literals from the accepted state table in
// cli-proposal.md, never read from the production module.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { plantWrongOp } from "./deps-sandbox.ts";
import { createBundle, createChallengeAuthorityBinDir, createFakeMcporterBinDir, runBundle, type Bundle } from "./harness.ts";

const SENTINEL = "evidence-state-secret-sentinel-91d4";
const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");
const T = "<observed-at>";

// Independent oracle: the accepted AC21 vocabulary, deliberately restated.
const STATES = ["configured", "localReady", "custodyChecked", "authenticated", "schemaQualified", "liveReadProven", "liveWriteProven", "fixtureTested"];
const CONFIGURED = { verdict: "proven", basis: "manifest-registry-requirements-validated", observedAt: T, boundary: "local" };
const NO_PROVIDER = { verdict: "unobserved", basis: "status-contacts-no-provider", observedAt: null, boundary: null };
const NO_FIXTURE = { verdict: "unobserved", basis: "status-retains-no-fixture-observation", observedAt: null, boundary: null };
const NO_WRITES = { verdict: "not-applicable", basis: "no-write-capability", observedAt: T, boundary: "local" };
const KEYLESS_MANIFEST = { verdict: "not-applicable", basis: "effective-custody-keyless", observedAt: T, boundary: "local", custody: { mode: "keyless", source: "packaged-manifest-default" } };
const KEYLESS_UNREGISTERED = { verdict: "not-applicable", basis: "effective-custody-keyless", observedAt: T, boundary: "local", custody: { mode: "keyless", source: "plugin-state:registration-absent" } };
const ready = (dependencies: unknown[] = []) => ({ verdict: "proven", basis: "declared-dependencies-ready-and-selection-resolved", observedAt: T, boundary: "local", dependencies });
const notReady = (dependencies: unknown[]) => ({ verdict: "not-proven", basis: "declared-dependencies-not-ready", observedAt: T, boundary: "local", dependencies });
const ABSENT = (tool: string) => ({ tool, state: "absent", cause: null });

const context7Evidence = (localReady: unknown) => ({
	configured: CONFIGURED, localReady, custodyChecked: KEYLESS_UNREGISTERED, authenticated: KEYLESS_UNREGISTERED,
	schemaQualified: NO_PROVIDER, liveReadProven: NO_PROVIDER, liveWriteProven: NO_WRITES, fixtureTested: NO_FIXTURE,
});
const keylessFixtureEvidence = (localReady: unknown) => ({
	configured: CONFIGURED, localReady, custodyChecked: KEYLESS_MANIFEST, authenticated: KEYLESS_MANIFEST,
	schemaQualified: NO_PROVIDER, liveReadProven: NO_PROVIDER, liveWriteProven: NO_WRITES, fixtureTested: NO_FIXTURE,
});

interface Box {
	bundle: Bundle;
	home: string;
	state: string;
}

function box(): Box {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	mkdirSync(home);
	return { bundle, home, state: path.join(bundle.root, "state") };
}

function snapshot(root: string): string[] {
	if (!existsSync(root)) return ["<absent>"];
	return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
		const file = path.join(root, name);
		const stat = lstatSync(file);
		return `${name} ${(stat.mode & 0o7777).toString(8)} ${stat.isFile() ? readFileSync(file, "hex") : ""}`;
	});
}

// Replaces every observedAt with one token after proving all of them are the
// same instant inside this invocation's own wall-clock window.
function normalizeTimes(value: unknown, window: { from: number; to: number }, seen: Set<string>): unknown {
	if (Array.isArray(value)) return value.map((entry) => normalizeTimes(entry, window, seen));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
		if (key !== "observedAt" || entry === null) return [key, normalizeTimes(entry, window, seen)];
		expect(typeof entry).toBe("string");
		const instant = Date.parse(entry as string);
		expect(instant).toBeGreaterThanOrEqual(window.from);
		expect(instant).toBeLessThanOrEqual(window.to);
		seen.add(entry as string);
		return [key, T];
	}));
}

async function inspect(b: Box, argv: string[], binDir?: string) {
	const before = { home: snapshot(b.home), state: snapshot(b.state) };
	const from = Math.floor(Date.now() / 1000) * 1000;
	const run = await runBundle(b.bundle, argv, { home: b.home, ...(binDir ? { binDir } : {}), extraEnv: { XDG_STATE_HOME: b.state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL }, timeoutMs: 15_000 });
	const to = Date.now();
	expect(run.stderr).toBe("");
	for (const forbidden of [SENTINEL, b.home, b.state, b.bundle.root]) expect(run.stdout).not.toContain(forbidden);
	expect({ home: snapshot(b.home), state: snapshot(b.state) }).toEqual(before);
	const envelope = JSON.parse(run.stdout);
	const seen = new Set<string>();
	const result = normalizeTimes(envelope.result, { from, to }, seen) as Record<string, unknown>;
	expect(seen.size).toBeLessThanOrEqual(1);
	return { code: run.code, result };
}

function statusRows(result: Record<string, unknown>) {
	expect(result.commandIdentity).toBe("connectors.status");
	expect(result.outcome).toBe("success");
	expect(result.causeCode).toBe("SUCCESS_UNCHANGED");
	expect(result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
	return (result.data as { connectors: { id: string; selection: unknown; evidence: Record<string, unknown> }[] }).connectors;
}

test("fresh state: status checks declared dependencies now and reports every live state unobserved, writing nothing", async () => {
	const b = box();
	try {
		const { code, result } = await inspect(b, ["status"]);
		expect(code).toBe(0);
		const rows = statusRows(result);
		expect(rows.map((row) => row.id)).toEqual(["context7", "firecrawl"]);
		for (const row of rows) {
			expect(Object.keys(row.evidence)).toEqual(STATES);
			expect(row.selection).toEqual({});
			expect(row.evidence).toEqual(context7Evidence(notReady([ABSENT("mcporter"), ABSENT("op")])));
		}
	} finally {
		b.bundle.dispose();
	}
});

test("a damaged plugin-owned op selection is reported not ready with its cause, and nothing adopts ambient PATH tools", async () => {
	const b = box();
	const hostile = path.join(b.bundle.root, "hostile-bin");
	const marker = path.join(b.bundle.root, "ambient-invoked");
	mkdirSync(hostile);
	for (const tool of ["mcporter", "op"]) writeFileSync(path.join(hostile, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\n`, { mode: 0o755 });
	try {
		plantWrongOp(b.state);
		const { code, result } = await inspect(b, ["status", "context7"], hostile);
		expect(code).toBe(0);
		const rows = statusRows(result);
		expect(rows.map((row) => row.id)).toEqual(["context7"]);
		expect(rows[0]?.evidence).toEqual(context7Evidence(notReady([ABSENT("mcporter"), { tool: "op", state: "not-ready", cause: "selection-invalid" }])));
		expect(existsSync(marker)).toBe(false);
	} finally {
		b.bundle.dispose();
	}
});

test("local readiness moves from unobserved to proven only when the required selection is supplied and valid", async () => {
	const b = box();
	try {
		b.bundle.addSkill("keyless-fixture-skill");
		const without = await inspect(b, ["status", "keyless-fixture-skill"]);
		expect(without.code).toBe(0);
		const [unselected] = statusRows(without.result);
		expect(unselected?.selection).toEqual({});
		expect(unselected?.evidence).toEqual(keylessFixtureEvidence({ verdict: "unobserved", basis: "selection-not-supplied", observedAt: T, boundary: "local", dependencies: [] }));

		const selected = await inspect(b, ["status", "keyless-fixture-skill", "--select", "region=eu-west"]);
		expect(selected.code).toBe(0);
		const [row] = statusRows(selected.result);
		expect(row?.selection).toEqual({ region: { value: "eu-west", source: "invocation-selector" } });
		expect(row?.evidence).toEqual(keylessFixtureEvidence(ready()));

		const invalid = await inspect(b, ["status", "keyless-fixture-skill", "--select", `region=${SENTINEL.toUpperCase()}`]);
		expect(invalid.code).toBe(4);
		expect(invalid.result).toMatchObject({ outcome: "refused", causeCode: "SCHEMA_SELECTOR_INVALID", data: null, transactionState: "unchanged" });
		expect(JSON.stringify(invalid.result)).not.toContain(SENTINEL.toUpperCase());
	} finally {
		b.bundle.dispose();
	}
});

test("doctor reports the same scoped evidence and never claims its local checks passed when a dependency is absent", async () => {
	const b = box();
	try {
		const { code, result } = await inspect(b, ["doctor", "context7"]);
		expect(code).toBe(0);
		expect(result.commandIdentity).toBe("connectors.doctor");
		expect(result.data).toEqual({ connector: "context7", ...context7Evidence(notReady([ABSENT("mcporter"), ABSENT("op")])) });
	} finally {
		b.bundle.dispose();
	}
});

test("a successful fixture auth stays a fixture: status keeps custody, authentication, and fixture evidence unobserved", async () => {
	const b = box();
	const authority = createChallengeAuthorityBinDir(b.bundle);
	try {
		b.bundle.addSkill("challenge-fixture-skill");
		const auth = await runBundle(b.bundle, ["fixture-auth", "challenge-fixture-skill"], { home: b.home, binDir: authority.binDir, extraEnv: { XDG_STATE_HOME: b.state } });
		expect(auth.code).toBe(0);
		expect(JSON.parse(auth.stdout).result.data).toEqual({ connector: "challenge-fixture-skill", outcome: "success", fixtureTested: true });
		const { code, result } = await inspect(b, ["status", "challenge-fixture-skill"], authority.binDir);
		expect(code).toBe(0);
		const [row] = statusRows(result);
		const unresolvable = { verdict: "unobserved", basis: "custody-not-resolvable", observedAt: null, boundary: null, custody: null };
		expect(row?.evidence).toEqual({
			configured: CONFIGURED, localReady: ready(), custodyChecked: unresolvable, authenticated: unresolvable,
			schemaQualified: NO_PROVIDER, liveReadProven: NO_PROVIDER, liveWriteProven: NO_WRITES, fixtureTested: NO_FIXTURE,
		});
	} finally {
		authority.dispose();
		b.bundle.dispose();
	}
});

// The one positive dependency transition: the real first-use bootstrap of
// the verified official MCPorter release, observed by the next status. The
// schema success in the same run must not promote schema qualification.
test.skipIf(!official)("a real MCPorter bootstrap makes local readiness proven, and a real schema success still promotes no live state", async () => {
	const b = box();
	const hostile = createFakeMcporterBinDir();
	try {
		b.bundle.addSkill("keyless-fixture-skill");
		const manifestPath = path.join(b.bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
		writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), requirements: ["mcporter"] }));
		const argv = ["status", "keyless-fixture-skill", "--select", "region=eu-west"];
		const before = await inspect(b, argv, hostile.binDir);
		expect(statusRows(before.result)[0]?.evidence).toEqual(keylessFixtureEvidence(notReady([ABSENT("mcporter")])));

		const schema = await runBundle(b.bundle, ["schema", "keyless-fixture-skill"], { home: b.home, binDir: hostile.binDir, timeoutMs: 30_000, extraEnv: { XDG_STATE_HOME: b.state, CONNECTORS_TEST_RELEASE_DIR: official ?? "" } });
		expect(schema.code).toBe(0);
		expect(JSON.parse(schema.stdout).result).toMatchObject({ commandIdentity: "connectors.schema", causeCode: "SUCCESS_BOOTSTRAPPED", effects: { completed: ["mcporter-bootstrap"] } });

		const after = await inspect(b, argv, hostile.binDir);
		expect(statusRows(after.result)[0]?.evidence).toEqual(keylessFixtureEvidence(ready()));
	} finally {
		hostile.dispose();
		b.bundle.dispose();
	}
}, 60_000);
