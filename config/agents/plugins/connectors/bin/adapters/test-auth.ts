// Packaged, tested test-only auth adapter (T2, Ticket #89 under Spec #87,
// Spec AC23). attemptAuth rejects malformed references before process spawn;
// valid syntax never counts as authentication. It presents the manifest's
// nonsecret credentials.reference as an identity to an independent fixture
// authority process and maps that process's verdict.
// The authority is absent from a real install by design (fixture-tested
// only); this adapter never reads, holds, or transmits a credential value,
// and never claims T5's real 1Password custody.
//
// prepare (Ticket #93, Spec AC19) gives the generic run path a keyless
// fixture read, admitted only where that same test-bundle authority exists.
// It plans MCPorter through the shared route with a private per-account data
// root, and reports only effects it observes on disk; the core composes the
// cause and the effect inventory.
import { safeEnvironment } from "../safe-environment.ts";
import { accessSync, constants, lstatSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRefusal, AdapterRequest, AuthAttempt, Committed, LocalEffect, Prepared } from "./contract.ts";
import type { ConnectorManifest } from "../manifest.ts";
import { ownedDirectory, stateRoot } from "../private-state.ts";
import { planDispatcherRoute, RouteError } from "../provider-route.ts";

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

const ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function refused(kind: AdapterRefusal["kind"], connectorCause: string, repair: string): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}

// Metadata only; MCPorter replaces its vault file by rename.
function stamp(file: string): string | null {
	try {
		const stat = lstatSync(file, { bigint: true });
		return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
	} catch {
		return null;
	}
}

// commit reports account-vault only when it created the account root; settle
// reports mcporter-vault-file only when MCPorter changed its vault file.
function accountEffects(root: string): { commit(): Committed; settle(): readonly LocalEffect[] } {
	const vaultFile = path.join(root, "data", "mcporter", "credentials.json");
	let before: string | null = null;
	return {
		commit() {
			const existed = stamp(root) !== null;
			const failed = [root, path.join(root, "data"), path.join(root, "cache")].some((directory) => !ownedDirectory(directory).ok);
			before = stamp(vaultFile);
			const refusal: AdapterRefusal | null = failed ? { kind: "domain", connectorCause: "vault-root-invalid", repair: "Remove the fixture account root so it can be recreated as a private directory" } : null;
			return { refusal, completed: existed || stamp(root) === null ? [] : ["account-vault"] };
		},
		settle() {
			return stamp(vaultFile) === before ? [] : ["mcporter-vault-file"];
		},
	};
}

function prepare(request: AdapterRequest): Prepared {
	try {
		accessSync(AUTHORITY_PATH, constants.X_OK);
	} catch {
		return refused("domain", "fixture-authority-unavailable", "This adapter runs only inside the Connectors packaged-process test bundle");
	}
	const { action } = request;
	if (action.kind === "auth") return refused("verb-unsupported", "auth-verb-unsupported", "The fixture adapter supports run only");
	const account = request.selectors.account;
	if (account === undefined || ACCOUNT_PATTERN.exec(account)?.[0] !== account) return refused("usage", "account-invalid", "Pass --select account=<lowercase-slug>");
	const flags = action.input === null ? [] : ["--args", JSON.stringify(action.input)];
	let plan: ReturnType<typeof planDispatcherRoute>;
	try {
		plan = planDispatcherRoute([request.manifest.id, "--select", `account=${account}`, "--", "call", action.operation, ...flags, "--output", "json"], request.skillsRoot, safeEnvironment(request.env), `test-auth-account=${account}`);
	} catch (error) {
		if (error instanceof RouteError) return refused("schema", "route-invalid", "Fix the fixture skill's registry or route declaration");
		throw error;
	}
	const root = path.join(stateRoot(request.env), "connectors", "test-auth-mcporter", account);
	const env = { ...plan.env, XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache") };
	return { kind: "transport", effect: "read", argv: plan.argv, env, data: {}, ...accountEffects(root) };
}

export const testAuthAdapter: Adapter = { id: "test-auth", attemptAuth, prepare };
