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
import { createBundle, createFakeMcporterBinDir, runBundle } from "./harness.ts";

// A fake mcporter is put on PATH for every refusal test below so it could
// leave its own receipt if it were ever invoked; each refusal then asserts
// that receipt is absent, an observable process fact independent of
// connectors.ts's own output, proving the defect was caught before any
// dependency, credential, or provider access, not merely that mcporter was
// unavailable to try.
function assertNoProviderAttempt(bundle: { root: string }): void {
	expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
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
		const mcporterBin = createFakeMcporterBinDir();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }));

			const result = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root, binDir: mcporterBin.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.failureClass).toBe("schema");
			expect(envelope.result.causeCode).toBe("SCHEMA_VERSION_UNSUPPORTED");
			assertNoProviderAttempt(bundle);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("an unknown adapter id refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, adapter: "not-a-packaged-adapter" }));

			const result = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root, binDir: mcporterBin.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.causeCode).toBe("SCHEMA_ADAPTER_UNKNOWN");
			assertNoProviderAttempt(bundle);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("an invalid selector declaration refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			bundle.addSkill("keyless-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "keyless-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, selectors: { region: { pattern: "(unterminated" } } }));

			const result = await runBundle(bundle, ["config", "validate", "keyless-fixture-skill"], { home: bundle.root, binDir: mcporterBin.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.causeCode).toBe("SCHEMA_SELECTOR_INVALID");
			assertNoProviderAttempt(bundle);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});

	test("a missing registry refuses before any dependency, credential, or provider access", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			mkdirSync(path.join(bundle.skillsRoot, "broken-fixture-skill", "config"), { recursive: true });
			writeFileSync(
				path.join(bundle.skillsRoot, "broken-fixture-skill", "config", "manifest.json"),
				JSON.stringify({ schemaVersion: 1, id: "broken-fixture-skill", transport: { registry: "./mcporter.json" }, selectors: {}, requirements: [], adapter: null, credentials: null }),
			);
			const result = await runBundle(bundle, ["config", "validate", "broken-fixture-skill"], { home: bundle.root, binDir: mcporterBin.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(4);
			expect(envelope.result.causeCode).toBe("SCHEMA_MANIFEST_INVALID");
			assertNoProviderAttempt(bundle);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});
});

describe("Spec AC23: packaged auth adapter extensibility", () => {
	test("doctor succeeds through the compiled process when the adapter's local check is ready", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["doctor", "adapter-fixture-skill"], { home: bundle.root });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(0);
			expect(envelope.result.outcome).toBe("success");
			expect(envelope.result.data.custodyChecked).toBe(true);
		} finally {
			bundle.dispose();
		}
	});

	test("doctor refuses through the compiled process when the adapter's local check is not ready, with a repair action naming the exact defect", async () => {
		const bundle = createBundle();
		const mcporterBin = createFakeMcporterBinDir();
		try {
			bundle.addSkill("adapter-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "adapter-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(await Bun.file(manifestPath).text());
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, credentials: null }));

			const result = await runBundle(bundle, ["doctor", "adapter-fixture-skill"], { home: bundle.root, binDir: mcporterBin.binDir });
			const envelope = JSON.parse(result.stdout);
			expect(result.code).toBe(3);
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.failureClass).toBe("domain");
			expect(envelope.result.causeCode).toBe("DOMAIN_ADAPTER_REFUSED");
			expect(envelope.result.repairAction).toContain("credentials.reference");
			assertNoProviderAttempt(bundle);
		} finally {
			mcporterBin.dispose();
			bundle.dispose();
		}
	});
});
