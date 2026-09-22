// Atlassian dispatch contract: ten semantic operations, selected exact tools,
// the registry allow-list, operator commands, and closed cause vocabulary.
// Unqualified Official operations have no callable tool here.

import { PRODUCTS, type Product } from "../custody/index.ts";

export { PRODUCTS, type Product } from "../custody/index.ts";
export const PROVIDERS = ["official", "community"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

import { readFileSync } from "node:fs";
import path from "node:path";

// Server identities are a small static type boundary. Tool vocabularies live
// only in config/mcporter.json and are parsed from those exact bytes.
const SERVER_NAMES = ["atlassian-official-jira", "atlassian-official-confluence", "atlassian-community-jira", "atlassian-community-confluence"] as const;
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

// This is the operation descriptor registry: route selection, product, write
// policy admission, and exact provider tool identity live behind this one
// interface. Consumers must not infer product from a string prefix.
interface OperationDescriptor {
	id: string;
	kind: "read" | "write";
	product: Product;
	// Reachability includes both live tool presence and safe preparation. A
	// missing qualified tool uses null; an exposed tool may still be unreachable
	// when its prerequisites cannot be prepared safely.
	official: { tool: string | null; reachable: boolean };
	community: { tool: string };
}

// This registry is the sole semantic catalog. The public operation list,
// write-operation type, route choice, and provider-tool binding are derived
// from it rather than separately maintained by policy modules.
const OPERATION_REGISTRY = [
	{ id: "issue.get", kind: "read", product: "jira", official: { tool: "getJiraIssue", reachable: true }, community: { tool: "jira_get_issue" } },
	{ id: "issue.search", kind: "read", product: "jira", official: { tool: "searchJiraIssuesUsingJql", reachable: true }, community: { tool: "jira_search" } },
	{ id: "issue.create", kind: "write", product: "jira", official: { tool: "createJiraIssue", reachable: true }, community: { tool: "jira_create_issue" } },
	{ id: "issue.update", kind: "write", product: "jira", official: { tool: "editJiraIssue", reachable: true }, community: { tool: "jira_update_issue" } },
	{ id: "issue.comment", kind: "write", product: "jira", official: { tool: "addOrEditJiraIssueComment", reachable: true }, community: { tool: "jira_add_comment" } },
	{ id: "page.get", kind: "read", product: "confluence", official: { tool: "getConfluenceContent", reachable: true }, community: { tool: "confluence_get_page" } },
	{ id: "page.search", kind: "read", product: "confluence", official: { tool: "searchConfluence", reachable: true }, community: { tool: "confluence_search" } },
	// The live schema has createConfluenceContent, but lacks the space read
	// needed to prepare this write safely on Official.
	{ id: "page.create", kind: "write", product: "confluence", official: { tool: "createConfluenceContent", reachable: false }, community: { tool: "confluence_create_page" } },
	{ id: "page.update", kind: "write", product: "confluence", official: { tool: "updateConfluenceContent", reachable: true }, community: { tool: "confluence_update_page" } },
	// No page comment name was qualified in the live Official catalog.
	{ id: "page.comment", kind: "write", product: "confluence", official: { tool: null, reachable: false }, community: { tool: "confluence_add_comment" } },
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
	official: { tool: string | null; reachable: boolean };
	community: { tool: string };
}

function exactTool(server: ServerName, tool: string): string {
	if (!ALLOWED_TOOLS[server].includes(tool)) throw new Error(`registry-invalid: ${server} lacks ${tool}`);
	return tool;
}

function admittedSpec(spec: (typeof OPERATION_REGISTRY)[number]): OperationSpec {
	return {
		...spec,
		official: { tool: spec.official.reachable && spec.official.tool !== null ? exactTool(serverFor("official", spec.product), spec.official.tool) : spec.official.tool, reachable: spec.official.reachable },
		community: { tool: exactTool(serverFor("community", spec.product), spec.community.tool) },
	};
}

export const OPERATION_SPECS: Record<OperationId, OperationSpec> = Object.freeze(Object.fromEntries(OPERATION_REGISTRY.map((spec) => [spec.id, admittedSpec(spec)])) as Record<OperationId, OperationSpec>);

// Operator commands beside the operations; each is a canonical command path.
export const COMMANDS = ["receipts", "receipt", "adjudicate", "unlock", "parity"] as const;
export type CommandId = (typeof COMMANDS)[number];

export const OFFICIAL_RESOURCES_TOOL = exactTool("atlassian-official-jira", "getAccessibleAtlassianResources");
export const OFFICIAL_USER_TOOL = exactTool("atlassian-official-jira", "atlassianUserInfo");

// Four static routes: each provider is split by product because the API
// token, the credential item, and the tool surface are product-specific.
export const SERVERS = [...SERVER_NAMES];

export function serverFor(provider: ProviderName, product: Product): ServerName {
	return `atlassian-${provider}-${product}`;
}

export function providerRouteFor(server: string): { provider: ProviderName; product: Product } | null {
	for (const provider of PROVIDERS) {
		for (const product of PRODUCTS) {
			if (serverFor(provider, product) === server) return { provider, product };
		}
	}
	return null;
}


export type CauseCode =
	| "success"
	| "usage-invalid"
	| "operation-unavailable"
	| "input-invalid"
	| "site-unresolved"
	| "space-unresolved"
	| "refused-tenant"
	| "refused-auth"
	| "refused-preview"
	| "refused-write-blocked"
	| "refused-state"
	| "refused-evidence"
	| "refused-parity"
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
	"operation-unavailable": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"input-invalid": { outcome: "refused", failureClass: "schema", exitCode: 4 },
	"site-unresolved": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"space-unresolved": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-tenant": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-auth": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-preview": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-write-blocked": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-state": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-evidence": { outcome: "refused", failureClass: "domain", exitCode: 3 },
	"refused-parity": { outcome: "refused", failureClass: "domain", exitCode: 3 },
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
		// inspect reads; repository-local changes only private journal or
		// attestation state; external reaches the provider with a write.
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
