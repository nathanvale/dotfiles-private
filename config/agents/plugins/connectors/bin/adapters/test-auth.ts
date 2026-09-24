// Packaged, tested test-only auth adapter (T2, Ticket #89 under Spec #87,
// Spec AC23). attemptAuth rejects malformed references before process spawn;
// valid syntax never counts as authentication. It presents the manifest's
// nonsecret credentials.reference as an identity to an independent fixture
// authority process and maps that process's verdict.
// The authority is absent from a real install by design (fixture-tested
// only); this adapter never reads, holds, or transmits a credential value,
// and never claims T5's real 1Password custody.
import { safeEnvironment } from "../safe-environment.ts";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { Adapter, AuthAttempt } from "./contract.ts";
import type { ConnectorManifest } from "../manifest.ts";

const AUTHORITY_COMMAND = "connectors-fixture-authority";
// The fixture process is supplied only by the packaged-process test bundle.
// A same-named ambient PATH program has no authority to report fixture proof.
const AUTHORITY_PATH = path.resolve(path.dirname(process.execPath), "..", "tests", "fixture-authority");
// This fixture adapter accepts only item slugs in its declared, nonsecret
// 1Password namespace. Syntax is a pre-spawn safety gate, never auth proof:
// only the independent authority can accept an identity.
const REFERENCE_PATTERN = /^1Password:API Credentials\/[a-z][a-z0-9-]{0,63}$/;

async function attemptAuth(manifest: ConnectorManifest): Promise<AuthAttempt> {
	const reference = manifest.credentials?.reference;
	if (typeof reference !== "string" || reference.length === 0) {
		return { outcome: "refused", cause: "CREDENTIAL_REFERENCE_MISSING", detail: "declare credentials.reference in the connector manifest" };
	}
	// RegExp's $ may also match just before a final newline; require the
	// complete match so that character cannot cross into child argv.
	if (REFERENCE_PATTERN.exec(reference)?.[0] !== reference) {
		return { outcome: "refused", cause: "CREDENTIAL_REFERENCE_INVALID", detail: "credentials.reference must be a nonsecret 1Password:API Credentials/<item-slug> reference" };
	}
	const routeEnv: Record<string, string> = { ...safeEnvironment(process.env) };
	try {
		accessSync(AUTHORITY_PATH, constants.X_OK);
	} catch {
		return {
			outcome: "refused",
			cause: "FIXTURE_AUTHORITY_UNAVAILABLE",
			detail: `${AUTHORITY_COMMAND} is not installed; this route is fixture-tested only and never available outside that proof`,
		};
	}
	const proc = Bun.spawn([AUTHORITY_PATH, "--identity", reference], { env: routeEnv, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	// Drain both pipes concurrently: the same pipe-fill hang this Ticket
	// already repaired for the schema command applies to any spawned child.
	const [, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (exitCode === 0) {
		return { outcome: "success", detail: "the independent fixture authority accepted the declared identity" };
	}
	return { outcome: "refused", cause: "CREDENTIAL_REFERENCE_REJECTED", detail: "the independent fixture authority refused the declared identity" };
}

export const testAuthAdapter: Adapter = { id: "test-auth", attemptAuth };
