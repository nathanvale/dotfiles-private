// Pure dispatch policy: input validation, provider argument shaping, and live
// schema confirmation. No I/O and no provider text; the runtime supplies a
// Transport that has already translated every failure into a closed cause.
import type { BindResult, CredentialBinding } from "../custody/index.ts";
import { type CauseCode, OPERATION_SPECS, type OperationId, type OperationSpec, type Product } from "./contract.ts";
import type { StageResult } from "../outbox.ts";
import type { Journal } from "./journal.ts";
import type { ProviderFailure } from "./translate.ts";

export interface SchemaTool {
	name: string;
	inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
}

export type TransportResult = { ok: true; data: unknown } | ({ ok: false } & ProviderFailure);
export type TransportFailure = Exclude<TransportResult, { ok: true }>;

export interface Transport {
	listTools(binding: CredentialBinding, server: string): Promise<TransportResult>;
	call(binding: CredentialBinding, server: string, tool: string, args: Record<string, unknown>): Promise<TransportResult>;
}

export interface Dependencies {
	transport: Transport;
	// One complete exact-item read supplies an immutable nonsecret binding for
	// every schema list and provider call in one semantic operation, or a
	// closed refusal cause.
	bindCredential(tenant: string, product: Product): Promise<BindResult>;
	journal(tenant: string): Journal;
	// Copy one local file into the tenant's private outbox and name it the way
	// the Provider, which starts in that outbox, can read it.
	stage(tenant: string, file: string): StageResult;
	now(): number;
}

export type Input = Record<string, string | number | string[]>;
export type Validation = { ok: true; input: Input } | { ok: false; reason: string };

export type Field = { kind: "text"; required: boolean } | { kind: "count"; required: boolean } | { kind: "names"; required: boolean };

// Neutral input per read operation; unknown keys are refused so a caller
// cannot smuggle provider-specific arguments through the semantic seam.
export const READ_INPUTS: Partial<Record<OperationId, Record<string, Field>>> = {
	"issue.get": { issueKey: { kind: "text", required: true }, fields: { kind: "names", required: false } },
	"issue.search": { jql: { kind: "text", required: true }, maxResults: { kind: "count", required: false }, fields: { kind: "names", required: false } },
	"page.get": { pageId: { kind: "text", required: true } },
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

// Provider argument shaping for the Community read tools. Argument names come
// from the v0.23.1 Community source and are confirmed only by the live schema.
export function providerArguments(spec: OperationSpec, input: Input): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const names = Array.isArray(input.fields) ? input.fields : undefined;
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
	"input-invalid": "correct the input object",
	"site-unresolved": "the tenant's credential item must expose a valid site_url field",
	"refused-preview": "the preview is unknown, consumed, expired, or no longer matches the input, provider arguments, or target revision; preview again",
	"refused-write-blocked": "an unresolved write or a held lock blocks this object; run receipts, then adjudicate or unlock only after confirming no live writer",
	"refused-state": "the private journal state is corrupt or its meta-lock is held; inspect the state directory before any write",
	"refused-evidence": "read-back did not prove the effect or its absence; the receipt stays open until read-back can",
	"outcome-unknown": "the write may have reached the provider without a confirmed effect; run adjudicate with the same input before any retry",
	"refused-auth": "the provider refused authentication or permission; verify the credential type, scopes, and product permissions with their owner",
	"not-found": "the target object was not found or is not visible to this principal",
	"refused-precondition": "a provider precondition failed before any request; run the provider readiness checks",
	"capability-unavailable": "the live schema does not expose the operation as expected; inspect the provider schema before retrying",
	"failed-transport": "the provider did not answer; inspect provider status before retrying the read",
	"failed-unknown": "the provider failed for an unclassified reason; inspect provider diagnostics",
};

export const specFor = (operation: string): OperationSpec | undefined => (OPERATION_SPECS as Record<string, OperationSpec>)[operation];
