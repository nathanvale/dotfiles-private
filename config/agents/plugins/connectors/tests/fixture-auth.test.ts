// T2 (Ticket #89, Spec AC23): the compiled CLI consults a separate fixture
// authority process. Its fixed accepted identity is owned by that process;
// neither the adapter nor these assertions derives acceptance from the
// manifest's input shape.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, createFixtureAuthorityBinDir, runBundle } from "./harness.ts";

const SECRET_SENTINEL = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
const AMBIENT_SENTINEL = "SENTINEL_AMBIENT_AUTHORITY_VALUE";
const EFFECTS_UNCHANGED = { completed: [], remaining: [], uncertain: [], inventoryComplete: true };

describe("connectors fixture-auth: Spec AC23 independent authority", () => {
	test("accepted identity succeeds only after the authority writes an affirmative receipt", async () => {
		const bundle = createBundle();
		const authority = createFixtureAuthorityBinDir(bundle);
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["fixture-auth", "adapter-fixture-skill"], {
				home: bundle.root,
				binDir: authority.binDir,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET_SENTINEL, AMBIENT_SENTINEL },
			});
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(SECRET_SENTINEL);
			expect(result.stdout).not.toContain(AMBIENT_SENTINEL);
			const envelope = JSON.parse(result.stdout);
			expect(Object.keys(envelope).sort()).toEqual(["availablePaths", "contractVersion", "envelopeVersion", "message", "result"]);
			expect(envelope.envelopeVersion).toBe(2);
			expect(envelope.contractVersion).toBe("2.0.0");
			expect(envelope.message).toBe("adapter-fixture-skill fixture auth succeeded");
			expect(envelope.availablePaths).toContain("connectors.fixtureAuth");
			expect(envelope.result).toEqual({
				runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
				commandIdentity: "connectors.fixtureAuth",
				outcome: "success",
				failureClass: null,
				exitCode: 0,
				data: { connector: "adapter-fixture-skill", outcome: "success", fixtureTested: true },
				retryable: false,
				repairAction: null,
				nextAction: "connectors.status",
				effectClass: "inspect",
				transactionState: "unchanged",
				causeCode: "SUCCESS_UNCHANGED",
				effects: EFFECTS_UNCHANGED,
			});
			const receiptText = readFileSync(path.join(bundle.root, "fixture-authority.json"), "utf8");
			expect(JSON.parse(receiptText)).toEqual({
				identity: "1Password:API Credentials/fixture-item",
				accepted: true,
				ambientSentinelPresent: false,
				credentialSentinelPresent: false,
			});
			expect(receiptText).not.toContain(SECRET_SENTINEL);
			expect(receiptText).not.toContain(AMBIENT_SENTINEL);
		} finally {
			authority.dispose();
			bundle.dispose();
		}
	});

	test("a different nonsecret identity is refused by the authority with a negative receipt", async () => {
		const bundle = createBundle();
		const authority = createFixtureAuthorityBinDir(bundle);
		try {
			bundle.addSkill("adapter-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "adapter-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.credentials.reference = "1Password:API Credentials/wrong-item";
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const result = await runBundle(bundle, ["fixture-auth", "adapter-fixture-skill"], {
				home: bundle.root,
				binDir: authority.binDir,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET_SENTINEL, AMBIENT_SENTINEL },
			});
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(SECRET_SENTINEL);
			expect(result.stdout).not.toContain(AMBIENT_SENTINEL);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.envelopeVersion).toBe(2);
			expect(envelope.contractVersion).toBe("2.0.0");
			expect(envelope.message).toBe("connectors: adapter-fixture-skill fixture auth was refused: the independent fixture authority refused the declared identity");
			expect(envelope.result).toEqual({
				runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
				commandIdentity: "connectors.fixtureAuth",
				outcome: "refused",
				failureClass: "domain",
				exitCode: 3,
				data: null,
				retryable: false,
				repairAction: "the independent fixture authority refused the declared identity",
				nextAction: "connectors.status",
				effectClass: "inspect",
				transactionState: "unchanged",
				causeCode: "DOMAIN_FIXTURE_AUTH_REFUSED",
				effects: EFFECTS_UNCHANGED,
			});
			const receiptText = readFileSync(path.join(bundle.root, "fixture-authority.json"), "utf8");
			expect(JSON.parse(receiptText)).toEqual({
				identity: "1Password:API Credentials/wrong-item",
				accepted: false,
				ambientSentinelPresent: false,
				credentialSentinelPresent: false,
			});
			expect(receiptText).not.toContain(SECRET_SENTINEL);
			expect(receiptText).not.toContain(AMBIENT_SENTINEL);
		} finally {
			authority.dispose();
			bundle.dispose();
		}
	});

	test("a secret-shaped malformed reference refuses before the fixture authority can observe it", async () => {
		const bundle = createBundle();
		const authority = createFixtureAuthorityBinDir(bundle);
		try {
			bundle.addSkill("adapter-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "adapter-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			for (const invalidReference of [SECRET_SENTINEL, "1Password:API Credentials/fixture-item\n"]) {
				manifest.credentials.reference = invalidReference;
				writeFileSync(manifestPath, JSON.stringify(manifest));
				const result = await runBundle(bundle, ["fixture-auth", "adapter-fixture-skill"], { home: bundle.root, binDir: authority.binDir });
				expect(result.code).toBe(3);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(invalidReference);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.result.commandIdentity).toBe("connectors.fixtureAuth");
				expect(envelope.result.outcome).toBe("refused");
				expect(envelope.result.causeCode).toBe("DOMAIN_FIXTURE_AUTH_REFUSED");
				expect(envelope.result.repairAction).toBe("credentials.reference must be a nonsecret 1Password:API Credentials/<item-slug> reference");
				expect(existsSync(path.join(bundle.root, "fixture-authority.json"))).toBe(false);
			}
		} finally {
			authority.dispose();
			bundle.dispose();
		}
	});

	test("an unavailable authority refuses without an authority effect", async () => {
		const bundle = createBundle();
		try {
			bundle.addSkill("adapter-fixture-skill");
			const result = await runBundle(bundle, ["fixture-auth", "adapter-fixture-skill"], {
				home: bundle.root,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET_SENTINEL, AMBIENT_SENTINEL },
			});
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(SECRET_SENTINEL);
			expect(result.stdout).not.toContain(AMBIENT_SENTINEL);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.envelopeVersion).toBe(2);
			expect(envelope.contractVersion).toBe("2.0.0");
			expect(envelope.message).toBe("connectors: adapter-fixture-skill fixture auth was refused: connectors-fixture-authority is not installed; this route is fixture-tested only and never available outside that proof");
			expect(envelope.result).toEqual({
				runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
				commandIdentity: "connectors.fixtureAuth",
				outcome: "refused",
				failureClass: "domain",
				exitCode: 3,
				data: null,
				retryable: false,
				repairAction: "connectors-fixture-authority is not installed; this route is fixture-tested only and never available outside that proof",
				nextAction: "connectors.status",
				effectClass: "inspect",
				transactionState: "unchanged",
				causeCode: "DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE",
				effects: EFFECTS_UNCHANGED,
			});
			expect(existsSync(path.join(bundle.root, "fixture-authority.json"))).toBe(false);
		} finally {
			bundle.dispose();
		}
	});

	test("a same-named PATH executable cannot forge fixture-tested evidence", async () => {
		const bundle = createBundle();
		const attacker = createFixtureAuthorityBinDir(bundle);
		const authorityPath = path.join(bundle.root, "tests", "fixture-authority");
		try {
			bundle.addSkill("adapter-fixture-skill");
			// Remove the test-owned authority and place an always-successful impostor
			// on PATH. Its marker is an independent effect oracle.
			rmSync(authorityPath);
			const impostorPath = path.join(attacker.binDir, "connectors-fixture-authority");
			writeFileSync(impostorPath, `#!/bin/sh\nprintf 'invoked' > '${bundle.root}/attacker-invoked'\nexit 0\n`);
			chmodSync(impostorPath, 0o755);
			const result = await runBundle(bundle, ["fixture-auth", "adapter-fixture-skill"], {
				home: bundle.root,
				binDir: attacker.binDir,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET_SENTINEL, AMBIENT_SENTINEL },
			});
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(SECRET_SENTINEL);
			expect(result.stdout).not.toContain(AMBIENT_SENTINEL);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result).toEqual({
				runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
				commandIdentity: "connectors.fixtureAuth",
				outcome: "refused",
				failureClass: "domain",
				exitCode: 3,
				data: null,
				retryable: false,
				repairAction: "connectors-fixture-authority is not installed; this route is fixture-tested only and never available outside that proof",
				nextAction: "connectors.status",
				effectClass: "inspect",
				transactionState: "unchanged",
				causeCode: "DOMAIN_FIXTURE_AUTHORITY_UNAVAILABLE",
				effects: EFFECTS_UNCHANGED,
			});
			expect(existsSync(path.join(bundle.root, "attacker-invoked"))).toBe(false);
			expect(existsSync(path.join(bundle.root, "fixture-authority.json"))).toBe(false);
		} finally {
			attacker.dispose();
			bundle.dispose();
		}
	});
});
