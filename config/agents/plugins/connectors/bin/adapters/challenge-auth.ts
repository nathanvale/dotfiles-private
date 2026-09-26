// A second packaged, fixture-only adapter. Its test-owned authority uses a
// nonce-bound JSON exchange over stdin; no executable path comes from a
// manifest or ambient PATH, and no credential value crosses this seam.
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { safeEnvironment } from "../safe-environment.ts";
import type { ConnectorManifest } from "../manifest.ts";
import type { Adapter, AuthAttempt } from "./contract.ts";

const AUTHORITY_PATH = path.resolve(path.dirname(process.execPath), "..", "tests", "challenge-authority");
const REFERENCE_PATTERN = /^fixture-challenge\/[a-z][a-z0-9-]{0,63}$/;

async function attemptAuth(manifest: ConnectorManifest): Promise<AuthAttempt> {
	const reference = manifest.credentials?.reference;
	if (typeof reference !== "string" || REFERENCE_PATTERN.exec(reference)?.[0] !== reference) {
		return { outcome: "refused", cause: "CREDENTIAL_REFERENCE_INVALID", detail: "declare a nonsecret fixture-challenge/<item-slug> reference" };
	}
	try {
		accessSync(AUTHORITY_PATH, constants.X_OK);
	} catch {
		return { outcome: "refused", cause: "FIXTURE_AUTHORITY_UNAVAILABLE", detail: "challenge authority is unavailable; this adapter is fixture-tested only" };
	}
	const nonce = randomUUID();
	const proc = Bun.spawn([AUTHORITY_PATH], {
		env: safeEnvironment(process.env),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(JSON.stringify({ nonce, reference }));
	proc.stdin.end();
	const [stdout, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	let response: unknown;
	try {
		response = JSON.parse(stdout);
	} catch {
		return { outcome: "refused", cause: "CHALLENGE_RESPONSE_INVALID", detail: "the challenge authority response was malformed" };
	}
	if (typeof response !== "object" || response === null || !("nonce" in response) || response.nonce !== nonce) {
		return { outcome: "refused", cause: "CHALLENGE_NONCE_MISMATCH", detail: "the challenge authority response did not match the nonce" };
	}
	if (exitCode === 0 && "decision" in response && response.decision === "allow") {
		return { outcome: "success", detail: "the challenge authority accepted the declared reference" };
	}
	return { outcome: "refused", cause: "CHALLENGE_REFUSED", detail: "the challenge authority refused the declared reference" };
}

export const challengeAuthAdapter: Adapter = { id: "challenge-auth", attemptAuth };
