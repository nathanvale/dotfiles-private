// Production adapters for the dispatcher: the route-backed MCPorter transport,
// trusted site origin and principal from the product item's metadata, the
// private write journal, and the durable live-parity attestation store.
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CREDENTIAL_VAULT, credentialWrapperPath, itemFieldMap, type Product, productItemTitle, SITE_URL_FIELD, TENANT_PATTERN, validSiteUrl } from "../atlassian-provider-common.ts";
import { OPERATIONS, type OperationId } from "./contract.ts";
import type { CredentialBinding, Dependencies, ParityAttestation, ParityEvidence, ParityRequest, Transport, TransportResult } from "./engine.ts";
import { canonicalDigest, openJournal } from "./journal.ts";
import { planDispatcherRoute, type RoutePlan } from "../../../../bin/provider-route.ts";

const SAFE_ENV = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_STATE_HOME"] as const;
const CALL_TIMEOUT_MS = "30000";

export type Environment = Record<string, string | undefined>;

function scrubbed(env: Environment): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of SAFE_ENV) {
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

// One route call at a time; the dispatcher never overlaps provider calls, so a
// synchronous spawn is sufficient and keeps the process tree simple.
function spawnRoute(env: Environment, tenant: string, server: string, mcporterArgs: string[]): { code: number; stdout: string; stderr: string } {
	let plan: RoutePlan;
	try {
		plan = planDispatcherRoute(["atlassian", "--provider", server, "--select", `tenant=${tenant}`, "--", ...mcporterArgs], path.resolve(import.meta.dir, "..", "..", "..", "..", "skills"), scrubbed(env));
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
// transport failure.
export function routeTransport(env: Environment, tenant: string): Transport {
	if (!TENANT_PATTERN.test(tenant)) throw new Error("tenant-invalid: the transport needs the validated tenant slug");
	const toResult = (run: { code: number; stdout: string; stderr: string }): TransportResult => {
		const contentObserved = run.stdout.trim().length > 0 || run.stderr.trim().length > 0;
		if (run.code !== 0) return { ok: false, kind: "process", exitCode: run.code, stderr: run.stderr, stdout: run.stdout, contentObserved };
		const data = parseJson(run.stdout);
		if (data === undefined) return { ok: false, kind: "malformed", message: "MCPorter output was not JSON", contentObserved };
		if (typeof data === "object" && data !== null && (data as { isError?: unknown }).isError === true) {
			return { ok: false, kind: "tool-error", message: JSON.stringify(data).slice(0, 2000), contentObserved: true };
		}
		return { ok: true, data };
	};
	return {
		async listTools(server) {
			return toResult(spawnRoute(env, tenant, server, ["list", "--schema", "--json", "--timeout", CALL_TIMEOUT_MS]));
		},
		async call(server, tool, args) {
			return toResult(spawnRoute(env, tenant, server, ["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS]));
		},
	};
}

// Metadata fields of the product's item, read through the credential helper;
// no secret value is ever requested. The error carries a cause, never a value.
function itemMetadataFields(tenant: string, product: Product, fields: readonly string[], env: Environment): Map<string, string> {
	const title = productItemTitle(product, tenant);
	const selector = fields.map((field) => `label=${field}`).join(",");
	const read = Bun.spawnSync([credentialWrapperPath(env.HOME), "op", "item", "get", title, "--vault", CREDENTIAL_VAULT, "--fields", selector, "--format", "json"], {
		env: scrubbed(env),
		stdin: "ignore",
	});
	if (read.exitCode !== 0) throw new Error(`site-unresolved: cannot read credential metadata for ${title}`);
	const values = itemFieldMap(parseJson(read.stdout.toString()));
	if (!values) throw new Error(`site-unresolved: ${title} returned invalid credential metadata`);
	return values;
}

function itemMetadata(tenant: string, product: Product, field: string, env: Environment): string {
	const value = itemMetadataFields(tenant, product, [field], env).get(field);
	if (value === undefined) throw new Error(`site-unresolved: ${productItemTitle(product, tenant)} has no ${field} field`);
	return value;
}

// Prefer the custom site_url field; accept the built-in url only as a
// strictly validated compatibility value when site_url is absent.
export async function resolveSiteOrigin(tenant: string, product: Product, env: Environment): Promise<string> {
	const fields = itemMetadataFields(tenant, product, [SITE_URL_FIELD, "url"], env);
	const url = fields.get(SITE_URL_FIELD) ?? fields.get("url");
	if (url === undefined) throw new Error(`site-unresolved: ${productItemTitle(product, tenant)} has no site_url or compatible url field`);
	if (!validSiteUrl(url)) throw new Error("site-url-invalid: the selected site_url or url field must be an https://*.atlassian.net origin");
	return `https://${new URL(url).hostname}`;
}

// The principal both routes authenticate as: the item's username. Official
// confirms it live through atlassianUserInfo; Community sends it as the Basic
// user, so it is the Community principal by construction.
export async function resolvePrincipal(tenant: string, product: Product, env: Environment): Promise<string> {
	const username = itemMetadata(tenant, product, "username", env);
	if (username.includes("\n") || username.includes(":")) throw new Error("credential-invalid: malformed username");
	return username;
}

// 1Password's currently-used metadata lane exposes the nonsecret username but
// no safe, stable item revision. Keep that limitation explicit: parity is
// unavailable until credential custody supplies this value. Never derive a
// revision or fingerprint from the credential field.
export async function resolveCredentialBinding(tenant: string, product: Product, env: Environment): Promise<CredentialBinding> {
	const principal = await resolvePrincipal(tenant, product, env);
	throw new Error(`credential-revision-unavailable: credential custody must supply a safe revision for ${productItemTitle(product, tenant)} (${principal.length})`);
}

// Attestations live beside the journal, one owned 0600 file per tenant,
// product, operation, and input shape. A record that fails validation is
// unproven, never repaired.
const HEX64 = /^[0-9a-f]{64}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function stateRoot(env: Environment): string {
	const xdg = env.XDG_STATE_HOME ?? "";
	if (path.isAbsolute(xdg)) return xdg;
	return path.join(env.HOME ?? os.homedir(), ".local", "state");
}

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
		(record.product === "jira" || record.product === "confluence") &&
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
			const file = path.join(parityDirectory(env, request.tenant), attestationName(request));
			let metadata: ReturnType<typeof lstatSync>;
			try {
				metadata = lstatSync(file);
			} catch {
				return { status: "unproven" };
			}
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== os.userInfo().uid) return { status: "unproven" };
			const attestation = asAttestation(parseJson(readFileSync(file, "utf8")));
			const evidence: ParityEvidence = attestation ? { status: "attested", attestation } : { status: "unproven" };
			return evidence;
		},
		async attestParity(attestation) {
			const directory = parityDirectory(env, attestation.tenant);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const metadata = lstatSync(directory);
			if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== os.userInfo().uid) throw new Error("state-invalid: the parity directory must be an owned directory");
			const temp = path.join(directory, `.${crypto.randomUUID()}.tmp`);
			writeFileSync(temp, `${JSON.stringify(attestation)}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temp, path.join(directory, attestationName(attestation)));
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
		siteOrigin: (slug, product) => resolveSiteOrigin(slug, product, env),
		credentialBinding: (slug, product) => resolveCredentialBinding(slug, product, env),
		...parityStore(env),
		journal: (slug) => openJournal(slug, { env }),
		now: Date.now,
	};
}
