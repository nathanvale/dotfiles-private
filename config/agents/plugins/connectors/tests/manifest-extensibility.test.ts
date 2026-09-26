// T2 (Ticket #89 under Spec #87): proves manifest-only Connector Skill
// extensibility (Spec AC13) and packaged auth adapter extensibility (Spec
// AC23) through the compiled binary as a real child process. Per the
// accepted extensibility technique: run the exact same already-built binary
// file against an isolated bundle before and after a fixture is added to its
// own skills/ directory, never a git-diff or SHA assertion inside the test.
// Source-unchanged review of bin/connectors.ts itself is a separate, manual
// step reported alongside this evidence, not asserted here.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, createFixtureAuthorityBinDir, runBundle } from "./harness.ts";

// A rejected manifest must not start the plugin-owned dependency bootstrap.
function assertNoDependencyState(bundle: { root: string }): void {
	expect(existsSync(path.join(bundle.root, "connectors"))).toBe(false);
}

describe("Spec AC13: manifest-only Connector Skill addition", () => {
	test("the same compiled binary does not see a fixture Skill before it is added, and does after, with no rebuild between runs", async () => {
		const bundle = createBundle();
		try {
			const before = await runBundle(bundle, ["list"], { home: bundle.root });
			expect(before.code).toBe(0);
			const beforeIds = JSON.parse(before.stdout).result.data.connectors.map((c: { id: string }) => c.id);
			expect(beforeIds).not.toContain("keyless-fixture-skill");

			// Adds only data files (manifest.json + mcporter.json) to the
			// bundle's own skills/ directory; bundle.binary is untouched.
			bundle.addSkill("keyless-fixture-skill");

			const after = await runBundle(bundle, ["list"], { home: bundle.root });
			expect(after.code).toBe(0);
			const afterIds = JSON.parse(after.stdout).result.data.connectors.map((c: { id: string }) => c.id);
			expect(afterIds).toContain("keyless-fixture-skill");

			const validate = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root });
			expect(validate.code).toBe(0);
			expect(JSON.parse(validate.stdout).result.outcome).toBe("success");
		} finally {
			bundle.dispose();
		}
	});

	test("an incompatible schemaVersion refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }));

			const result = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root, extraEnv: { XDG_STATE_HOME: bundle.root } });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.failureClass).toBe("schema");
			expect(envelope.result.causeCode).toBe("SCHEMA_VERSION_UNSUPPORTED");
			assertNoDependencyState(bundle);
		} finally {
			bundle.dispose();
		}
	});

	test("an unknown adapter id refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, adapter: "not-a-packaged-adapter" }));

			const result = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root, extraEnv: { XDG_STATE_HOME: bundle.root } });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.causeCode).toBe("SCHEMA_ADAPTER_UNKNOWN");
			assertNoDependencyState(bundle);
		} finally {
			bundle.dispose();
		}
	});

	test("an invalid selector declaration refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, selectors: { region: { pattern: "(unterminated" } } }));

			const result = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root, extraEnv: { XDG_STATE_HOME: bundle.root } });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
			assertNoDependencyState(bundle);
		} finally {
			bundle.dispose();
		}
	});

	// PR #99 review defect: adapter null decides keyless reporting and the
	// keyless schema route, so a manifest that also declares credentials would
	// be treated as keyless. The reference carries a secret-shaped sentinel to
	// prove the refusal never echoes it.
	test("credentials without a packaged adapter refuse before the keyless route, while an unchanged keyless manifest stays valid", async () => {
		const bundle = createBundle();
		const sentinel = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
		const state = path.join(bundle.root, "state");
		mkdirSync(state);
		// A missing release source keeps any wrongly reached bootstrap offline.
		const extraEnv = { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: path.join(bundle.root, "missing-source") };
		try {
			bundle.addSkill("keyless-fixture-skill");
			const env = { home: bundle.root, extraEnv };
			const keyless = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], env);
			expect(keyless.code).toBe(0);
			expect(JSON.parse(keyless.stdout).result.causeCode).toBe("SUCCESS_UNCHANGED");

			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, adapter: null, credentials: { reference: sentinel } }));

			for (const [argv, commandIdentity] of [
				[["schema", "keyless-fixture-skill"], "connectors.schema"],
				[["config", "validate", "keyless-fixture-skill"], "connectors.config.validate"],
			] as const) {
				const result = await runBundle(bundle, [...argv], env);
				expect(result.code).toBe(4);
				expect(result.stderr).toBe("");
				expect(result.stdout.trim().split("\n")).toHaveLength(1);
				expect(result.stdout).not.toContain(sentinel);
				const envelope = JSON.parse(result.stdout).result;
				expect(envelope.commandIdentity).toBe(commandIdentity);
				expect(envelope.outcome).toBe("refused");
				expect(envelope.failureClass).toBe("schema");
				expect(envelope.causeCode).toBe("SCHEMA_MANIFEST_INVALID");
				expect(envelope.transactionState).toBe("unchanged");
				expect(envelope.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
			}

			const list = await runBundle(bundle, ["list"], env);
			expect(list.stdout).not.toContain(sentinel);
			const listed = JSON.parse(list.stdout).result.data;
			expect(listed.connectors.map((c: { id: string }) => c.id)).not.toContain("keyless-fixture-skill");
			expect(listed.problems.map((p: { id: string; code: string }) => [p.id, p.code])).toEqual([["keyless-fixture-skill", "manifest-invalid"]]);

			expect(existsSync(path.join(state, "connectors"))).toBe(false);
		} finally {
			bundle.dispose();
		}
	});

	test("a missing registry refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		try {
			mkdirSync(path.join(bundle.skillsRoot, "broken-fixture-skill", "config"), { recursive: true });
			writeFileSync(
				path.join(bundle.skillsRoot, "broken-fixture-skill", "config", "manifest.json"),
				JSON.stringify({ schemaVersion: 1, id: "broken-fixture-skill", transport: { registry: "./mcporter.json" }, selectors: {}, requirements: [], adapter: null, credentials: null }),
			);
			const result = await runBundle(bundle, ["config", "validate", "broken-fixture-skill"], { home: bundle.root, extraEnv: { XDG_STATE_HOME: bundle.root } });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.causeCode).toBe("SCHEMA_MANIFEST_INVALID");
			assertNoDependencyState(bundle);
		} finally {
			bundle.dispose();
		}
	});
});

describe("Spec AC23: packaged auth adapter extensibility", () => {
	test("doctor reports a declared adapter without claiming custody or authentication", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["doctor", "adapter-fixture-skill"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(envelope.result.outcome).toBe("success");
			expect(envelope.result.data).toEqual({
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

	test("a missing reference leaves doctor truthful and makes fixture-auth refuse before authority spawn", async () => {
		const bundle = createBundle();
		const authority = createFixtureAuthorityBinDir(bundle);
		try {
			bundle.addSkill("adapter-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "adapter-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, credentials: null }));

			const doctor = await runBundle(bundle, ["doctor", "adapter-fixture-skill"], { home: bundle.root, binDir: authority.binDir });
			expect(doctor.code).toBe(0);
			expect(doctor.stderr).toBe("");
			expect(JSON.parse(doctor.stdout).result.data.custodyChecked).toBeNull();
			const result = await runBundle(bundle, ["fixture-auth", "adapter-fixture-skill"], { home: bundle.root, binDir: authority.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.failureClass).toBe("domain");
			expect(envelope.result.causeCode).toBe("DOMAIN_FIXTURE_AUTH_REFUSED");
			expect(envelope.result.repairAction).toContain("credentials.reference");
			expect(existsSync(path.join(bundle.root, "fixture-authority.json"))).toBe(false);
		} finally {
			authority.dispose();
			bundle.dispose();
		}
	});
});
