// Production adapters for the dispatcher: the route-backed MCPorter transport,
// trusted site origin and principal from the product item's metadata, the
// private write journal, and the durable live-parity attestation store.
import path from "node:path";
import { bindCredential, bindingChannel, type CredentialBinding, TENANT_PATTERN } from "../custody/index.ts";
import { OPERATIONS, PRODUCTS, type OperationId } from "./contract.ts";
import type { Dependencies, ParityAttestation, ParityEvidence, ParityRequest, Transport, TransportResult } from "./engine.ts";
import { canonicalDigest, openJournal } from "./journal.ts";
import { translateFailure } from "./translate.ts";
import { ownedDirectory, readPrivateFile, stateRoot, writePrivateFile } from "../../../../bin/private-state.ts";
import { planDispatcherRoute, type RoutePlan } from "../../../../bin/provider-route.ts";
import { safeEnvironment } from "../../../../bin/safe-environment.ts";

const CALL_TIMEOUT_MS = "30000";

export type Environment = Record<string, string | undefined>;

function scrubbed(env: Environment): Record<string, string> {
	return safeEnvironment(env);
}

// One route call at a time; the dispatcher never overlaps provider calls, so a
// synchronous spawn is sufficient and keeps the process tree simple.
function spawnRoute(env: Environment, tenant: string, binding: CredentialBinding, server: string, mcporterArgs: string[]): { code: number; stdout: string; stderr: string } {
	let plan: RoutePlan;
	try {
		plan = planDispatcherRoute(["atlassian", "--provider", server, "--select", `tenant=${tenant}`, "--", ...mcporterArgs], path.resolve(import.meta.dir, "..", "..", "..", "..", "skills"), scrubbed(env), bindingChannel(binding));
	} catch {
		return { code: 3, stdout: "", stderr: "internal dispatcher transport refused" };
	}
	const mcporter = Bun.which("mcporter", { PATH: plan.env.PATH ?? "" });
	if (!mcporter) return { code: 3, stdout: "", stderr: "mcporter is not available" };
	const run = Bun.spawnSync([mcporter, ...plan.argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// MCPorter's JSON shapes are not fully documented; a result that is not JSON is
// reported as malformed rather than guessed. Every failure records whether any
// provider content was observed, because a partial answer is never a clean
// transport failure. This adapter is the only place provider text is seen; it
// leaves here as a translated closed cause.
export function routeTransport(env: Environment, tenant: string): Transport {
	if (!TENANT_PATTERN.test(tenant)) throw new Error("tenant-invalid: the transport needs the validated tenant slug");
	const toResult = (run: { code: number; stdout: string; stderr: string }): TransportResult => {
		const contentObserved = run.stdout.trim().length > 0;
		if (run.code !== 0) return { ok: false, ...translateFailure({ kind: "process", exitCode: run.code, stderr: run.stderr, stdout: run.stdout, contentObserved }) };
		const data = parseJson(run.stdout);
		if (data === undefined) return { ok: false, ...translateFailure({ kind: "malformed", message: "MCPorter output was not JSON", contentObserved }) };
		if (typeof data === "object" && data !== null && (data as { isError?: unknown }).isError === true) {
			return { ok: false, ...translateFailure({ kind: "tool-error", message: JSON.stringify(data).slice(0, 2000), contentObserved: true }) };
		}
		return { ok: true, data };
	};
	return {
		async listTools(binding, server) {
			return toResult(spawnRoute(env, tenant, binding, server, ["list", "--schema", "--json", "--timeout", CALL_TIMEOUT_MS]));
		},
		async call(binding, server, tool, args) {
			return toResult(spawnRoute(env, tenant, binding, server, ["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS]));
		},
	};
}

// Attestations live beside the journal, one owned 0600 file per tenant,
// product, operation, and input shape. A record that fails validation is
// unproven, never repaired.
const HEX64 = /^[0-9a-f]{64}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function parityDirectory(env: Environment, tenant: string): string {
	return path.join(stateRoot(env), "connectors", "atlassian", tenant, "parity");
}

const attestationName = (request: Pick<ParityRequest, "product" | "operation" | "inputShape">) => `${request.product}.${request.operation}.${canonicalDigest(request.inputShape).slice(0, 16)}.json`;

function asAttestation(value: unknown): ParityAttestation | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const ok =
		typeof record.tenant === "string" &&
		TENANT_PATTERN.test(record.tenant) &&
		(typeof record.product === "string" && (PRODUCTS as readonly string[]).includes(record.product)) &&
		typeof record.operation === "string" &&
		(OPERATIONS as readonly string[]).includes(record.operation) &&
		Array.isArray(record.inputShape) &&
		record.inputShape.every((key) => typeof key === "string") &&
		typeof record.origin === "string" &&
		typeof record.credentialDigest === "string" &&
		HEX64.test(record.credentialDigest) &&
		typeof record.objectSemantics === "string" &&
		finite(record.recordedAt) &&
		finite(record.expiresAt) &&
		typeof record.source === "string";
	return ok ? (record as unknown as ParityAttestation) : null;
}

export function parityStore(env: Environment): Pick<Dependencies, "parity" | "attestParity"> {
	return {
		async parity(request) {
			const read = readPrivateFile(path.join(parityDirectory(env, request.tenant), attestationName(request)));
			if (!read.ok) return { status: "unproven" };
			const attestation = asAttestation(parseJson(read.text));
			const evidence: ParityEvidence = attestation ? { status: "attested", attestation } : { status: "unproven" };
			return evidence;
		},
		async attestParity(attestation) {
			const directory = parityDirectory(env, attestation.tenant);
			const owned = ownedDirectory(directory);
			if (!owned.ok) throw new Error(`state-invalid: the parity directory must be an owned directory (${owned.reason})`);
			const written = writePrivateFile(path.join(directory, attestationName(attestation)), `${JSON.stringify(attestation)}\n`);
			if (!written.ok) throw new Error(`state-invalid: the attestation could not be written (${written.reason})`);
		},
	};
}

export const isOperation = (value: string): value is OperationId => (OPERATIONS as readonly string[]).includes(value);

// The production dependency set for one validated tenant. Built exactly once
// per invocation from the parsed tenant, so the transport, the credential
// item, and the trusted origin can never name different tenants.
export function productionDependencies(tenant: string, env: Environment): Dependencies {
	return {
		transport: routeTransport(env, tenant),
		bindCredential: async (slug, product) => bindCredential(slug, product, env),
		...parityStore(env),
		journal: (slug) => openJournal(slug, { env }),
		now: Date.now,
	};
}
