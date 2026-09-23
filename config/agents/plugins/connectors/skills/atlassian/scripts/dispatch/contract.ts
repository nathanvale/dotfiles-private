// Atlassian dispatch contract: the fifteen semantic operations, their exact
// Community provider tools, the allow-lists the registry must mirror, the
// operator commands, and the closed cause and exit vocabulary. Tool names are
// documented, not live-verified; the engine binds one only after live schema
// confirmation.

import { PRODUCTS, type Product } from "../custody/index.ts";

export { PRODUCTS, type Product } from "../custody/index.ts";

import { readFileSync } from "node:fs";
import path from "node:path";

// The one active Provider. The journal persists this name on every preview
// and receipt so a record from a retired Provider is recognised, never
// reinterpreted.
export const PROVIDER = "community" as const;
export type ProviderName = typeof PROVIDER;

// Server identities are a small static type boundary: one Community server per
// product. Tool vocabularies live only in config/mcporter.json and are parsed
// from those exact bytes.
const SERVER_NAMES = ["atlassian-community-jira", "atlassian-community-confluence"] as const;
export type ServerName = (typeof SERVER_NAMES)[number];
export type ToolVocabulary = Record<ServerName, readonly string[]>;
const BROAD_TOOLS = new Set(["discover", "executeRead", "executeWrite", "executeDestructive"]);

function registryInvalid(): never {
	throw new Error("registry-invalid: mcporter.json must declare every exact non-broad Atlassian tool allow-list");
}

export function registryToolVocabulary(registry: unknown): ToolVocabulary {
	if (typeof registry !== "object" || registry === null || Array.isArray(registry)) registryInvalid();
	const servers = (registry as { mcpServers?: unknown }).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) registryInvalid();
	const entries = servers as Record<string, unknown>;
	if (Object.keys(entries).length !== SERVER_NAMES.length || SERVER_NAMES.some((server) => !(server in entries))) registryInvalid();
	const vocabulary = {} as Record<ServerName, readonly string[]>;
	for (const server of SERVER_NAMES) {
		const entry = entries[server];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) registryInvalid();
		const tools = (entry as { allowedTools?: unknown }).allowedTools;
		if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => typeof tool !== "string" || tool.length === 0 || BROAD_TOOLS.has(tool)) || new Set(tools).size !== tools.length) registryInvalid();
		vocabulary[server] = Object.freeze([...tools] as string[]);
	}
	return Object.freeze(vocabulary);
}

function registrySource(): unknown {
	try {
		return JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "..", "config", "mcporter.json"), "utf8"));
	} catch {
		return registryInvalid();
	}
}

export const ALLOWED_TOOLS = registryToolVocabulary(registrySource());

// This is the operation descriptor registry: product, write policy admission,
// and exact provider tool identity live behind this one interface. Consumers
// must not infer product from a string prefix.
interface OperationDescriptor {
	id: string;
	kind: "read" | "write";
	product: Product;
	tool: string;
}

// This registry is the sole semantic catalog. The public operation list,
// write-operation type, route choice, and tool binding are derived from it
// rather than separately maintained by policy modules.
const OPERATION_REGISTRY = [
	{ id: "issue.get", kind: "read", product: "jira", tool: "jira_get_issue" },
	{ id: "issue.search", kind: "read", product: "jira", tool: "jira_search" },
	{ id: "issue.create", kind: "write", product: "jira", tool: "jira_create_issue" },
	{ id: "issue.update", kind: "write", product: "jira", tool: "jira_update_issue" },
	{ id: "issue.comment", kind: "write", product: "jira", tool: "jira_add_comment" },
	{ id: "issue.comment.update", kind: "write", product: "jira", tool: "jira_edit_comment" },
	{ id: "issue.attach", kind: "write", product: "jira", tool: "jira_update_issue" },
	{ id: "issue.delete", kind: "write", product: "jira", tool: "jira_delete_issue" },
	{ id: "page.get", kind: "read", product: "confluence", tool: "confluence_get_page" },
	{ id: "page.search", kind: "read", product: "confluence", tool: "confluence_search" },
	{ id: "page.create", kind: "write", product: "confluence", tool: "confluence_create_page" },
	{ id: "page.update", kind: "write", product: "confluence", tool: "confluence_update_page" },
	{ id: "page.comment", kind: "write", product: "confluence", tool: "confluence_add_comment" },
	{ id: "page.attach", kind: "write", product: "confluence", tool: "confluence_upload_attachment" },
	{ id: "page.delete", kind: "write", product: "confluence", tool: "confluence_delete_page" },
] as const satisfies readonly OperationDescriptor[];

export type OperationId = (typeof OPERATION_REGISTRY)[number]["id"];
export type WriteOperation = Extract<(typeof OPERATION_REGISTRY)[number], { readonly kind: "write" }>["id"];
export const OPERATIONS: readonly OperationId[] = Object.freeze(OPERATION_REGISTRY.map(({ id }) => id));
export const WRITE_OPERATION_IDS: readonly WriteOperation[] = Object.freeze(OPERATION_REGISTRY.filter(({ kind }) => kind === "write").map(({ id }) => id as WriteOperation));

// Public consumers receive this fully declared boundary; the descriptor that
// validates the registry remains an implementation detail.
export interface OperationSpec {
	id: OperationId;
	kind: "read" | "write";
	product: Product;
	tool: string;
}

function exactTool(server: ServerName, tool: string): string {
	if (!ALLOWED_TOOLS[server].includes(tool)) throw new Error(`registry-invalid: ${server} lacks ${tool}`);
	return tool;
}

function admittedSpec(spec: (typeof OPERATION_REGISTRY)[number]): OperationSpec {
	return { ...spec, tool: exactTool(serverFor(spec.product), spec.tool) };
}

export const OPERATION_SPECS: Record<OperationId, OperationSpec> = Object.freeze(Object.fromEntries(OPERATION_REGISTRY.map((spec) => [spec.id, admittedSpec(spec)])) as Record<OperationId, OperationSpec>);

// Operator commands beside the operations; each is a canonical command path.
export const COMMANDS = ["receipts", "receipt", "adjudicate", "unlock"] as const;
export type CommandId = (typeof COMMANDS)[number];

// Two static routes: one per product, because the API token, the credential
// item, and the tool surface are product-specific.
export const SERVERS = [...SERVER_NAMES];

export function serverFor(product: Product): ServerName {
	return `atlassian-community-${product}`;
}

export function productFor(server: string): Product | null {
	for (const product of PRODUCTS) {
		if (serverFor(product) === server) return product;
	}
	return null;
}

export type CauseCode =
	| "success"
	| "usage-invalid"
	| "input-invalid"
	| "site-unresolved"
	| "refused-auth"
	| "refused-preview"
	| "refused-write-blocked"
	| "refused-state"
	| "refused-evidence"
	| "not-found"
	| "refused-precondition"
	| "capability-unavailable"
	| "failed-transport"
	| "failed-unknown"
	| "outcome-unknown";

export type Outcome = "success" | "refused" | "failed";
export type FailureClass = "usage" | "domain" | "schema" | "internal" | null;
export type TransactionState = "unchanged" | "completed" | "unknown";

export interface CauseRow {
	outcome: Outcome;
	failureClass: FailureClass;
	exitCode: 0 | 2 | 3 | 4;
}

// Exit meanings follow Contract Core 2.0: 2 usage, 3 domain, 4 schema.
export const CAUSES: Record<CauseCode, CauseRow> = {
	success: { outcome: "success", failureClass: null, exitCode: 0 },
	"usage-invalid": { outcome: "refused", failureClass: "usage", exitCode: 2 },
	"input-invalid": { outcome: "refused", failureClass: "schema", exitCode: 4 },
	"site-unresolved": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-auth": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-preview": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-write-blocked": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-state": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-evidence": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"not-found": { outcome: "failed", failureClass: "domain", exitCode: 3 },
	"refused-precondition": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"capability-unavailable": { outcome: "failed", failureClass: "domain", exitCode: 3 },
	"failed-transport": { outcome: "failed", failureClass: "domain", exitCode: 3 },
	"failed-unknown": { outcome: "failed", failureClass: "domain", exitCode: 3 },
	// A write whose effect could not be confirmed: failed outcome, unknown
	// transaction state, nonretryable, blocked until adjudicated.
	"outcome-unknown": { outcome: "failed", failureClass: "domain", exitCode: 3 },
};

export interface Provenance {
	provider: string;
	tool: string;
	status: "success" | Exclude<CauseCode, "success">;
}

export interface Envelope {
	envelopeVersion: 2;
	contractVersion: "2.0.0";
	message: string;
	availablePaths: string[];
	result: {
		runId: string;
		commandIdentity: string;
		outcome: Outcome;
		// inspect reads; repository-local changes only private journal state;
		// external reaches the provider with a write.
		effectClass: "inspect" | "repository-local" | "external";
		transactionState: TransactionState;
		causeCode: CauseCode;
		failureClass: FailureClass;
		exitCode: number;
		data: unknown;
		retryable: false;
		repairAction: string | null;
		effects: { completed: string[]; remaining: string[]; uncertain: string[]; inventoryComplete: boolean };
		nextAction: string;
		provenance: Provenance[];
	};
}
