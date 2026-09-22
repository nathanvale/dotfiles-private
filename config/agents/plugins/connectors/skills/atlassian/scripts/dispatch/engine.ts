// Pure dispatch policy: input validation, provider argument shaping, live
// schema confirmation, and the read-only fallback gate. No I/O and no
// provider text; the runtime supplies a Transport that has already translated
// every failure into a closed cause.
import { type CauseCode, type OperationId, type OperationSpec, type Product, type ProviderName, OPERATION_SPECS } from "./contract.ts";
import { canonicalDigest, type Journal } from "./journal.ts";
import type { BindResult, CredentialBinding } from "../custody/index.ts";
import type { ProviderFailure } from "./translate.ts";

export interface SchemaTool {
	name: string;
	inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
}

// Every failure says whether provider content was observed: a nonzero exit or
// timeout that still produced output may have been answered, and is never
// treated as a clean transport failure.
export type TransportResult = { ok: true; data: unknown } | ({ ok: false } & ProviderFailure);
export type TransportFailure = Exclude<TransportResult, { ok: true }>;

export interface Transport {
	listTools(binding: CredentialBinding, server: string): Promise<TransportResult>;
	call(binding: CredentialBinding, server: string, tool: string, args: Record<string, unknown>): Promise<TransportResult>;
}

// Live-parity attestation: recorded only by the parity command after both
// providers answered the same read for the same tenant, product, operation,
// input shape, trusted origin, and principal with the same object identity.
// Every field is matched exactly before a read may fall over.
export interface ParityAttestation {
	tenant: string;
	product: Product;
	operation: OperationId;
	inputShape: string[];
	origin: string;
	// Digest of canonical, nonsecret credential evidence only. This binds the
	// current principal and the credential item's safe revision without storing
	// either value in the durable attestation.
	credentialDigest: string;
	objectSemantics: string;
	recordedAt: number;
	expiresAt: number;
	source: string;
}
export type ParityEvidence = { status: "unproven" } | { status: "attested"; attestation: ParityAttestation };

export interface ParityRequest {
	tenant: string;
	product: Product;
	operation: OperationId;
	inputShape: string[];
	origin: string;
	credentialDigest: string;
	now: number;
}

// Credential custody owns this narrow seam. `revision` must come from a
// nonsecret item revision or fingerprint supplied by that owner, never from a
// credential value. An unavailable revision makes parity unproven.
export function credentialDigest(binding: CredentialBinding): string {
	return canonicalDigest({ product: binding.product, principal: binding.principal.toLowerCase(), itemVersion: binding.itemVersion, origin: binding.origin.toLowerCase() });
}

// What the parity command compares per read operation; an attestation whose
// semantics differ from the current definition is stale.
export const OBJECT_SEMANTICS: Partial<Record<OperationId, string>> = {
	"issue.get": "issue:key+id",
	"issue.search": "issues:key-set",
	"page.get": "page:id+version+title",
	"page.search": "pages:id-set",
};

export interface Dependencies {
	transport: Transport;
	// One complete exact-item read supplies an immutable nonsecret binding for
	// every schema list and provider call in one semantic operation, or a
	// closed refusal cause.
	bindCredential(tenant: string, product: Product): Promise<BindResult>;
	parity(request: ParityRequest): Promise<ParityEvidence>;
	attestParity(attestation: ParityAttestation): Promise<void>;
	journal(tenant: string): Journal;
	now(): number;
}

export const inputShape = (input: Record<string, unknown>): string[] => Object.keys(input).sort();

export type Input = Record<string, string | number | string[]>;
export type Validation = { ok: true; input: Input } | { ok: false; reason: string };

export type Field = { kind: "text"; required: boolean } | { kind: "count"; required: boolean } | { kind: "names"; required: boolean } | { kind: "enum"; required: boolean; values: string[] };

// Neutral input per read operation; unknown keys are refused so a caller
// cannot smuggle provider-specific arguments through the semantic seam.
export const READ_INPUTS: Partial<Record<OperationId, Record<string, Field>>> = {
	"issue.get": { issueKey: { kind: "text", required: true }, fields: { kind: "names", required: false } },
	"issue.search": { jql: { kind: "text", required: true }, maxResults: { kind: "count", required: false }, fields: { kind: "names", required: false } },
	"page.get": { pageId: { kind: "text", required: true }, detail: { kind: "enum", required: false, values: ["full", "summary"] } },
	"page.search": { cql: { kind: "text", required: true }, maxResults: { kind: "count", required: false } },
};

function validField(field: Field, value: unknown): boolean {
	switch (field.kind) {
		case "text":
			return typeof value === "string" && value.trim().length > 0 && !value.includes("\n");
		case "count":
			return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 100;
		case "names":
			return Array.isArray(value) && value.every((entry) => typeof entry === "string" && /^[A-Za-z0-9_.-]+$/.test(entry));
		case "enum":
			return typeof value === "string" && field.values.includes(value);
	}
}

// One owner of the keyed-input walk shared by read and write contracts: every
// key must be declared, every value must satisfy its field, every required key
// must be present.
export function collectInput<F extends { required: boolean }>(raw: unknown, fields: Record<string, F>, valid: (field: F, value: unknown) => boolean): { ok: true; input: Record<string, unknown> } | { ok: false; reason: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "input must be a JSON object" };
	const input: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const field = fields[key];
		if (!field) return { ok: false, reason: `unknown input key ${key}` };
		if (!valid(field, value)) return { ok: false, reason: `input key ${key} is invalid` };
		input[key] = value;
	}
	for (const [key, field] of Object.entries(fields)) {
		if (field.required && !(key in input)) return { ok: false, reason: `input key ${key} is required` };
	}
	return { ok: true, input };
}

export function readInput(operation: OperationId, raw: unknown): Validation {
	const fields = READ_INPUTS[operation];
	if (!fields) return { ok: false, reason: `${operation} is a write; use the write input contract` };
	const collected = collectInput(raw, fields, validField);
	return collected.ok ? { ok: true, input: collected.input as Input } : collected;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

// Provider argument shaping. Official needs the matched cloudId first.
export function providerArguments(spec: OperationSpec, provider: ProviderName, input: Input, cloudId?: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const names = Array.isArray(input.fields) ? input.fields : undefined;
	if (provider === "official") {
		assign(args, "cloudId", cloudId);
		switch (spec.id) {
			case "issue.get":
				assign(args, "issueIdOrKey", input.issueKey);
				assign(args, "fields", names);
				break;
			case "issue.search":
				assign(args, "jql", input.jql);
				assign(args, "maxResults", input.maxResults);
				assign(args, "fields", names);
				break;
			case "page.get":
				// Documented by the v2 skill examples as content_id; confirmed only by the live schema.
				assign(args, "content_id", input.pageId);
				assign(args, "detail", input.detail);
				break;
			case "page.search":
				// Documented by the v2 skill examples as cql; confirmed only by the live schema.
				assign(args, "cql", input.cql);
				assign(args, "maxResults", input.maxResults);
				break;
		}
		return args;
	}
	switch (spec.id) {
		case "issue.get":
			assign(args, "issue_key", input.issueKey);
			assign(args, "fields", names?.join(","));
			break;
		case "issue.search":
			assign(args, "jql", input.jql);
			assign(args, "limit", input.maxResults);
			assign(args, "fields", names?.join(","));
			break;
		case "page.get":
			assign(args, "page_id", input.pageId);
			break;
		case "page.search":
			assign(args, "query", input.cql);
			assign(args, "limit", input.maxResults);
			break;
	}
	return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A tool is callable only when the live schema names it with a real object
// schema, declares every argument we would send, and we supply every argument
// it requires. A missing or malformed schema fails closed; it is never
// assumed permissive.
// Schema findings are a closed vocabulary. Provider-controlled names from the
// live schema never appear in them, so nothing a provider sends can reach the
// public envelope through a diagnostic.
export type SchemaFinding = "tool-absent" | "schema-not-object" | "required-malformed" | "argument-mismatch";

export function confirmSchema(tools: SchemaTool[], toolName: string, args: Record<string, unknown>): { ok: true } | { ok: false; finding: SchemaFinding } {
	const tool = tools.find((entry) => entry.name === toolName);
	if (!tool) return { ok: false, finding: "tool-absent" };
	const schema: unknown = tool.inputSchema;
	if (!isRecord(schema) || !isRecord(schema.properties)) return { ok: false, finding: "schema-not-object" };
	const properties = schema.properties;
	const requiredRaw: unknown = schema.required ?? [];
	if (!Array.isArray(requiredRaw) || !requiredRaw.every((key) => typeof key === "string")) return { ok: false, finding: "required-malformed" };
	const required = requiredRaw as string[];
	const unknown = Object.keys(args).some((key) => !(key in properties));
	const missing = required.some((key) => !(key in args));
	if (unknown || missing) return { ok: false, finding: "argument-mismatch" };
	return { ok: true };
}

export function readSchema(result: TransportResult): SchemaTool[] | null {
	if (!result.ok) return null;
	const data = result.data;
	const candidates = Array.isArray(data)
		? data
		: typeof data === "object" && data !== null && Array.isArray((data as { tools?: unknown }).tools)
			? (data as { tools: unknown[] }).tools
			: null;
	if (!candidates) return null;
	const tools: SchemaTool[] = [];
	for (const entry of candidates) {
		if (typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string") tools.push(entry as SchemaTool);
	}
	return tools;
}

// Public repair guidance is fixed per cause. Provider text is translated at
// the transport seam and never reaches this module, so no provider stdout,
// stderr, or tool message can carry a secret or private content into the
// envelope.
export const REPAIR_TEXT: Record<Exclude<CauseCode, "success">, string> = {
	"usage-invalid": "correct the invocation",
	"operation-unavailable": "this operation cannot be safely prepared on Official; use the default route or select --provider community with current parity evidence",
	"input-invalid": "correct the input object",
	"site-unresolved": "the tenant's credential item must expose a valid site_url field",
	"space-unresolved": "no readable page named the space's numeric id; supply space as {id, key} from the space settings page",
	"refused-preview": "the preview is unknown, consumed, expired, or no longer matches the input, provider arguments, or target revision; preview again",
	"refused-write-blocked": "an unresolved write or a held lock blocks this object; run receipts, then adjudicate or unlock only after confirming no live writer",
	"refused-state": "the private journal state is corrupt or its meta-lock is held; inspect the state directory before any write",
	"refused-evidence": "read-back did not prove the effect or its absence; the receipt stays open until read-back can",
	"refused-parity": "the two providers did not answer identically for this read, so no attestation was recorded",
	"outcome-unknown": "the write may have reached the provider without a confirmed effect; run adjudicate with the same input before any retry",
	"refused-tenant": "no accessible resource matches the trusted site origin; verify the tenant slug and the credential's site",
	"refused-auth": "the provider refused authentication or permission; verify the credential type, scopes, and product permissions with their owner",
	"not-found": "the target object was not found or is not visible to this principal",
	"refused-precondition": "a provider precondition failed before any request; run the provider readiness checks",
	"capability-unavailable": "the live schema does not expose the operation as expected; inspect the provider schema before retrying",
	"failed-transport": "the provider did not answer; inspect provider status before retrying the read",
	"failed-unknown": "the provider failed for an unclassified reason; inspect provider diagnostics",
};

// Only compatibility failures may fall over. A precondition failure (credential
// helper, bridge pin, item fields) is a local readiness problem, not a
// provider compatibility difference, so it stays on the default route.
const FALLBACK_CAUSES = new Set<CauseCode>(["capability-unavailable", "failed-transport"]);

const sameShape = (a: string[], b: string[]) => a.length === b.length && a.every((key, index) => key === b[index]);

// Reads may fail over only for compatibility failures and only with an exact
// live-parity attestation for this tenant, product, operation, input shape,
// trusted origin, principal, and object semantics that has not expired. Auth,
// permission, tenant, precondition, and uncertain outcomes never fall over.
export function fallbackDecision(spec: OperationSpec, cause: CauseCode, contentObserved: boolean, parity: ParityEvidence, request: ParityRequest): { eligible: boolean; reason: string } {
	const precondition = fallbackPrecondition(spec, cause, contentObserved);
	if (!precondition.eligible) return precondition;
	const attested = attestationMatches(parity, request);
	if (!attested.ok) return { eligible: false, reason: attested.reason };
	return { eligible: true, reason: `fallback-eligible:${attested.source}` };
}

export function fallbackPrecondition(spec: OperationSpec, cause: CauseCode, contentObserved: boolean): { eligible: boolean; reason: string } {
	if (spec.kind !== "read") return { eligible: false, reason: "fallback-ineligible:write" };
	if (!FALLBACK_CAUSES.has(cause)) return { eligible: false, reason: `fallback-ineligible:${cause}` };
	if (contentObserved) return { eligible: false, reason: "fallback-ineligible:content-observed" };
	return { eligible: true, reason: "fallback-eligible:cause" };
}

// The same exact-match policy gates an explicit Community selection: naming
// the provider by hand is not a way around live parity evidence.
export function attestationMatches(parity: ParityEvidence, request: ParityRequest): { ok: true; source: string } | { ok: false; reason: string } {
	if (parity.status !== "attested") return { ok: false, reason: "fallback-ineligible:parity-unproven" };
	const a = parity.attestation;
	if (typeof a.credentialDigest !== "string") return { ok: false, reason: "fallback-ineligible:parity-unproven" };
	const exact =
		a.tenant === request.tenant &&
		a.product === request.product &&
		a.operation === request.operation &&
		sameShape(a.inputShape, request.inputShape) &&
		a.origin === request.origin &&
		a.credentialDigest === request.credentialDigest &&
		a.objectSemantics === OBJECT_SEMANTICS[request.operation];
	if (!exact) return { ok: false, reason: "fallback-ineligible:parity-mismatch" };
	if (a.expiresAt <= request.now) return { ok: false, reason: "fallback-ineligible:parity-expired" };
	return { ok: true, source: a.source };
}

export function matchCloudId(resources: unknown, origin: string): string | null {
	if (!Array.isArray(resources)) return null;
	for (const resource of resources) {
		if (typeof resource !== "object" || resource === null) continue;
		const { id, url } = resource as { id?: unknown; url?: unknown };
		if (typeof id !== "string" || typeof url !== "string") continue;
		try {
			if (new URL(url).origin === origin) return id;
		} catch {
			// an unparsable resource url never matches
		}
	}
	return null;
}

export const specFor = (operation: string): OperationSpec | undefined => (OPERATION_SPECS as Record<string, OperationSpec>)[operation];
