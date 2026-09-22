// Production adapters for the dispatcher: the route-backed MCPorter transport,
// trusted site origin and principal from the product item's metadata, the
// private write journal, and the durable live-parity attestation store.
import path from "node:path";
import { bindCredential, bindingChannel, type CredentialBinding, invocationEnvironment, TENANT_PATTERN } from "../custody/index.ts";
import { OPERATIONS, PRODUCTS, providerRouteFor, type OperationId } from "./contract.ts";
import type { Dependencies, ParityAttestation, ParityEvidence, ParityRequest, Transport, TransportFailure, TransportResult } from "./engine.ts";
import { canonicalDigest, openJournal } from "./journal.ts";
import { translateFailure } from "./translate.ts";
import { ownedDirectory, readPrivateFile, stateRoot, writePrivateFile } from "../../../../bin/private-state.ts";
import { planDispatcherRoute, type RoutePlan } from "../../../../bin/provider-route.ts";
import { safeEnvironment } from "../../../../bin/safe-environment.ts";

const CALL_TIMEOUT_MS = "30000";
const SKILLS_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "skills");

export type Environment = Record<string, string | undefined>;

function scrubbed(env: Environment): Record<string, string> {
	return safeEnvironment(env);
}

// One route call at a time; the dispatcher never overlaps provider calls, so a
// synchronous spawn is sufficient and keeps the process tree simple.
function planRoute(env: Environment, tenant: string, binding: CredentialBinding, server: string, mcporterArgs: string[], skillsRoot: string): RoutePlan | TransportFailure {
	try {
		return planDispatcherRoute(["atlassian", "--provider", server, "--select", `tenant=${tenant}`, "--", ...mcporterArgs], skillsRoot, scrubbed(env), bindingChannel(binding));
	} catch {
		return { ok: false, cause: "refused-precondition", hint: "repair the Connector Skill route registry", contentObserved: false };
	}
}

function spawnRoute(plan: RoutePlan): { code: number; stdout: string; stderr: string } {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MCPorter 0.13.13 emits this envelope when a stdio Provider closes before
// answering and omits the Provider's stderr. It is transport metadata, not a
// partial provider answer, so it must not close the guarded fallback gate.
function isMcporterOfflineEnvelope(value: unknown, requestedServer: string): boolean {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "durationMs,error,issue,mode,name,status,transport") return false;
	const issue = value.issue;
	return (
		value.mode === "server" &&
		value.name === requestedServer &&
		value.status === "offline" &&
		typeof value.durationMs === "number" &&
		Number.isFinite(value.durationMs) &&
		value.durationMs >= 0 &&
		typeof value.transport === "string" &&
		/^STDIO .+$/.test(value.transport) &&
		isRecord(issue) &&
		Object.keys(issue).sort().join(",") === "kind,rawMessage" &&
		issue.kind === "offline" &&
		issue.rawMessage === "Connection closed" &&
		value.error === "offline"
	);
}

function providerReadiness(env: Environment, tenant: string, binding: CredentialBinding, server: string): TransportResult | null {
	const route = providerRouteFor(server);
	if (!route) return { ok: false, ...translateFailure({ kind: "malformed", message: "unknown Provider route", contentObserved: false }) };
	if (binding.product !== route.product) return { ok: false, cause: "refused-precondition", hint: "the credential binding does not match the Provider Route", contentObserved: false };
	const script = path.resolve(import.meta.dir, "..", route.provider === "official" ? "atlassian-official-provider.ts" : "atlassian-community-provider.ts");
	const run = Bun.spawnSync([process.execPath, script, "--preflight"], {
		env: { ...scrubbed(env), ...invocationEnvironment({ tenant, provider: route.provider, product: route.product, binding }) },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0) {
		return {
			ok: false,
			...translateFailure({ kind: "process", exitCode: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString(), contentObserved: false }),
		};
	}
	if (run.stdout.length > 0 || run.stderr.length > 0) {
		return { ok: false, ...translateFailure({ kind: "malformed", message: "Provider readiness emitted unexpected output", contentObserved: false }) };
	}
	return null;
}

// MCPorter's JSON shapes are not fully documented; a result that is not JSON is
// reported as malformed rather than guessed. Every failure records whether any
// provider content was observed, because a partial answer is never a clean
// transport failure. This adapter is the only place provider text is seen; it
// leaves here as a translated closed cause.
export function routeTransport(env: Environment, tenant: string, skillsRoot: string = SKILLS_ROOT): Transport {
	if (!TENANT_PATTERN.test(tenant)) throw new Error("tenant-invalid: the transport needs the validated tenant slug");
	const toResult = (server: string, run: { code: number; stdout: string; stderr: string }): TransportResult => {
		const parsed = parseJson(run.stdout);
		if (run.code !== 0 && isMcporterOfflineEnvelope(parsed, server)) {
			return { ok: false, cause: "failed-transport", hint: null, contentObserved: false };
		}
		const contentObserved = run.stdout.trim().length > 0;
		if (run.code !== 0) return { ok: false, ...translateFailure({ kind: "process", exitCode: run.code, stderr: run.stderr, stdout: run.stdout, contentObserved }) };
		const data = parsed;
		if (data === undefined) return { ok: false, ...translateFailure({ kind: "malformed", message: "MCPorter output was not JSON", contentObserved }) };
		if (typeof data === "object" && data !== null && (data as { isError?: unknown }).isError === true) {
			return { ok: false, ...translateFailure({ kind: "tool-error", message: JSON.stringify(data).slice(0, 2000), contentObserved: true }) };
		}
		return { ok: true, data };
	};
	const request = (binding: CredentialBinding, server: string, mcporterArgs: string[]): TransportResult => {
		const route = providerRouteFor(server);
		if (!route || binding.product !== route.product) return { ok: false, cause: "refused-precondition", hint: "the credential binding does not match the Provider Route", contentObserved: false };
		const planned = planRoute(env, tenant, binding, server, mcporterArgs, skillsRoot);
		if ("ok" in planned) return planned;
		const readiness = providerReadiness(env, tenant, binding, server);
		if (readiness) return readiness;
		return toResult(server, spawnRoute(planned));
	};
	return {
		async listTools(binding, server) {
			return request(binding, server, ["list", "--schema", "--json", "--timeout", CALL_TIMEOUT_MS]);
		},
		async call(binding, server, tool, args) {
			return request(binding, server, ["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS]);
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
		!("credentialSetDigest" in record) &&
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
