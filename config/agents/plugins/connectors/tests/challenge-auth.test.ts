import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, createChallengeAuthorityBinDir, runBundle } from "./harness.ts";

const SECRET = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
const AMBIENT = "SENTINEL_AMBIENT_AUTHORITY_VALUE";
const EFFECTS = { completed: [], remaining: [], uncertain: [], inventoryComplete: true };

async function runChallenge(reference: string) {
	const bundle = createBundle();
	const authority = createChallengeAuthorityBinDir(bundle);
	try {
		bundle.addSkill("challenge-fixture-skill");
		const manifestPath = path.join(bundle.skillsRoot, "challenge-fixture-skill", "config", "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.credentials.reference = reference;
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const result = await runBundle(bundle, ["fixture-auth", "challenge-fixture-skill"], {
			home: bundle.root,
			binDir: authority.binDir,
			extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET, AMBIENT_SENTINEL: AMBIENT },
		});
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain(SECRET);
		expect(result.stdout).not.toContain(AMBIENT);
		const envelope = JSON.parse(result.stdout);
		expect(Object.keys(envelope).sort()).toEqual(["availablePaths", "contractVersion", "envelopeVersion", "message", "result"]);
		expect(envelope.envelopeVersion).toBe(2);
		expect(envelope.contractVersion).toBe("2.0.0");
		const receiptText = readFileSync(path.join(bundle.root, "challenge-authority.json"), "utf8");
		expect(receiptText).not.toContain(SECRET);
		expect(receiptText).not.toContain(AMBIENT);
		return { result, envelope, receipt: JSON.parse(receiptText) };
	} finally {
		authority.dispose();
		bundle.dispose();
	}
}

describe("Spec AC23: a second packaged challenge adapter", () => {
	test.each([
		["secret-shaped malformed", "fixture-challenge/SENTINEL_PRIVATE_CREDENTIAL_VALUE"],
		["missing", null],
	])("%s reference refuses before challenge authority starts", async (_case, reference) => {
		const bundle = createBundle();
		const authority = createChallengeAuthorityBinDir(bundle);
		try {
			bundle.addSkill("challenge-fixture-skill");
			const manifestPath = path.join(bundle.skillsRoot, "challenge-fixture-skill", "config", "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.credentials = reference === null ? null : { reference };
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const before = readdirSync(bundle.root, { recursive: true, encoding: "utf8" }).sort();
			const result = await runBundle(bundle, ["fixture-auth", "challenge-fixture-skill"], {
				home: bundle.root,
				binDir: authority.binDir,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET, AMBIENT_SENTINEL: AMBIENT },
			});
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain(SECRET);
			expect(result.stdout).not.toContain(AMBIENT);
			const envelope = JSON.parse(result.stdout);
			expect(Object.keys(envelope).sort()).toEqual(["availablePaths", "contractVersion", "envelopeVersion", "message", "result"]);
			expect(envelope.message).toBe("connectors: challenge-fixture-skill fixture auth was refused: declare a nonsecret fixture-challenge/<item-slug> reference");
			expect(envelope.result).toEqual({
				runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
				commandIdentity: "connectors.fixtureAuth", outcome: "refused", failureClass: "domain", exitCode: 3,
				data: null, retryable: false, repairAction: "declare a nonsecret fixture-challenge/<item-slug> reference",
				nextAction: "connectors.status", effectClass: "inspect", transactionState: "unchanged",
				causeCode: "DOMAIN_FIXTURE_AUTH_REFUSED", effects: EFFECTS,
			});
			expect(readdirSync(bundle.root, { recursive: true, encoding: "utf8" }).sort()).toEqual(before);
		} finally {
			authority.dispose();
			bundle.dispose();
		}
	});

	test("literal authority policy accepts a matching stdin challenge", async () => {
		const { result, envelope, receipt } = await runChallenge("fixture-challenge/allowed");
		expect(result.code).toBe(0);
		expect(envelope.message).toBe("challenge-fixture-skill fixture auth succeeded");
		expect(envelope.availablePaths).toContain("connectors.fixtureAuth");
		expect(envelope.result).toEqual({
			runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
			commandIdentity: "connectors.fixtureAuth", outcome: "success", failureClass: null, exitCode: 0,
			data: { connector: "challenge-fixture-skill", outcome: "success", fixtureTested: true },
			retryable: false, repairAction: null, nextAction: "connectors.status", effectClass: "inspect",
			transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", effects: EFFECTS,
		});
		expect(receipt).toEqual({
			reference: "fixture-challenge/allowed", nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), accepted: true,
			ambientSentinelPresent: false, credentialSentinelPresent: false,
		});
	});

	test("Spec AC21: fixture auth success does not promote fresh status or doctor evidence", async () => {
		const bundle = createBundle();
		const authority = createChallengeAuthorityBinDir(bundle);
		try {
			bundle.addSkill("challenge-fixture-skill");
			const before = readdirSync(bundle.root, { recursive: true, encoding: "utf8" }).sort();
			const env = {
				home: bundle.root,
				binDir: authority.binDir,
				extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: SECRET, AMBIENT_SENTINEL: AMBIENT },
			};
			const auth = await runBundle(bundle, ["fixture-auth", "challenge-fixture-skill"], env);
			expect(auth.code).toBe(0);
			expect(auth.stderr).toBe("");
			expect(auth.stdout).not.toContain(SECRET);
			expect(auth.stdout).not.toContain(AMBIENT);
			const authEnvelope = JSON.parse(auth.stdout);
			expect(authEnvelope.result.commandIdentity).toBe("connectors.fixtureAuth");
			expect(authEnvelope.result.data).toEqual({ connector: "challenge-fixture-skill", outcome: "success", fixtureTested: true });
			const authorityReceipt = readFileSync(path.join(bundle.root, "challenge-authority.json"), "utf8");
			expect(JSON.parse(authorityReceipt).accepted).toBe(true);
			expect(authorityReceipt).not.toContain(SECRET);
			expect(authorityReceipt).not.toContain(AMBIENT);
			expect(readdirSync(bundle.root, { recursive: true, encoding: "utf8" }).sort()).toEqual([...before, "challenge-authority.json"].sort());

			const expectedEvidence = {
				configured: true,
				localReady: null,
				custodyChecked: null,
				authenticated: false,
				schemaQualified: false,
				liveReadProven: false,
				liveWriteProven: false,
				fixtureTested: null,
			};
			const status = await runBundle(bundle, ["status", "challenge-fixture-skill"], env);
			const doctor = await runBundle(bundle, ["doctor", "challenge-fixture-skill"], env);
			for (const result of [status, doctor]) {
				expect(result.code).toBe(0);
				expect(result.stderr).toBe("");
				expect(result.stdout).not.toContain(SECRET);
				expect(result.stdout).not.toContain(AMBIENT);
			}
			const statusEnvelope = JSON.parse(status.stdout);
			expect(statusEnvelope.result.commandIdentity).toBe("connectors.status");
			expect(statusEnvelope.result.data).toEqual({
				connectors: [{ id: "challenge-fixture-skill", evidence: expectedEvidence }],
				problems: [],
			});
			const doctorEnvelope = JSON.parse(doctor.stdout);
			expect(doctorEnvelope.result.commandIdentity).toBe("connectors.doctor");
			expect(doctorEnvelope.result.data).toEqual({ connector: "challenge-fixture-skill", ...expectedEvidence });
			expect(readdirSync(bundle.root, { recursive: true, encoding: "utf8" }).sort()).toEqual([...before, "challenge-authority.json"].sort());
			expect(readFileSync(path.join(bundle.root, "challenge-authority.json"), "utf8")).toBe(authorityReceipt);
		} finally {
			authority.dispose();
			bundle.dispose();
		}
	});

	test("literal authority policy refuses a different reference", async () => {
		const { result, envelope, receipt } = await runChallenge("fixture-challenge/denied");
		expect(result.code).toBe(3);
		expect(envelope.message).toBe("connectors: challenge-fixture-skill fixture auth was refused: the challenge authority refused the declared reference");
		expect(envelope.result).toEqual({
			runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
			commandIdentity: "connectors.fixtureAuth", outcome: "refused", failureClass: "domain", exitCode: 3,
			data: null, retryable: false, repairAction: "the challenge authority refused the declared reference",
			nextAction: "connectors.status", effectClass: "inspect", transactionState: "unchanged",
			causeCode: "DOMAIN_FIXTURE_AUTH_REFUSED", effects: EFFECTS,
		});
		expect(receipt).toEqual({
			reference: "fixture-challenge/denied", nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), accepted: false,
			ambientSentinelPresent: false, credentialSentinelPresent: false,
		});
	});

	test("an affirmative response with the wrong nonce is refused", async () => {
		const { result, envelope, receipt } = await runChallenge("fixture-challenge/replay");
		expect(result.code).toBe(3);
		expect(envelope.message).toBe("connectors: challenge-fixture-skill fixture auth was refused: the challenge authority response did not match the nonce");
		expect(envelope.result.commandIdentity).toBe("connectors.fixtureAuth");
		expect(envelope.result.outcome).toBe("refused");
		expect(envelope.result.causeCode).toBe("DOMAIN_FIXTURE_AUTH_REFUSED");
		expect(envelope.result.effects).toEqual(EFFECTS);
		expect(receipt).toEqual({
			reference: "fixture-challenge/replay", nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), accepted: false,
			ambientSentinelPresent: false, credentialSentinelPresent: false,
		});
	});
});
