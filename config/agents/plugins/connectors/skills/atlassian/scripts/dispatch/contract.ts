// Atlassian dispatch contract: the ten semantic operations, their exact
// provider tools, the allow-lists the registry must mirror, the operator
// commands, and the closed cause and exit vocabulary. Tool names are
// documented, not live-verified; the engine binds one only after live schema
// confirmation.

export const OPERATIONS = [
	"issue.get",
	"issue.search",
	"issue.create",
	"issue.update",
	"issue.comment",
	"page.get",
	"page.search",
	"page.create",
	"page.update",
	"page.comment",
] as const;
export type OperationId = (typeof OPERATIONS)[number];
export type ProviderName = "official" | "community";

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
// The default Official endpoint cannot expose this exact tool under the sealed
// allow-list, but the semantic operation still needs its documented identity.
export const OFFICIAL_PAGE_COMMENT_TOOL = "createConfluenceComment";

export interface OperationSpec {
	id: OperationId;
	kind: "read" | "write";
	product: "jira" | "confluence";
	// A tool that the default Official endpoint only reaches through its broad
	// executeWrite dispatcher is unreachable here: the exact-name allow-list
	// cannot bind executeWrite to one operation.
	official: { tool: string; reachable: boolean };
	community: { tool: string };
}

function exactTool(server: ServerName, tool: string): string {
	if (!ALLOWED_TOOLS[server].includes(tool)) throw new Error(`registry-invalid: ${server} lacks ${tool}`);
	return tool;
}

const spec = (id: OperationId, kind: "read" | "write", officialTool: string, communityTool: string, reachable = true): OperationSpec => ({
	id,
	kind,
	product: id.startsWith("issue.") ? "jira" : "confluence",
	official: { tool: reachable ? exactTool(id.startsWith("issue.") ? "atlassian-official-jira" : "atlassian-official-confluence", officialTool) : officialTool, reachable },
	community: { tool: exactTool(id.startsWith("issue.") ? "atlassian-community-jira" : "atlassian-community-confluence", communityTool) },
});

export const OPERATION_SPECS: Record<OperationId, OperationSpec> = {
	"issue.get": spec("issue.get", "read", "getJiraIssue", "jira_get_issue"),
	"issue.search": spec("issue.search", "read", "searchJiraIssuesUsingJql", "jira_search"),
	"issue.create": spec("issue.create", "write", "createJiraIssue", "jira_create_issue"),
	"issue.update": spec("issue.update", "write", "editJiraIssue", "jira_update_issue"),
	"issue.comment": spec("issue.comment", "write", "addOrEditJiraIssueComment", "jira_add_comment"),
	"page.get": spec("page.get", "read", "getConfluenceContent", "confluence_get_page"),
	"page.search": spec("page.search", "read", "searchConfluence", "confluence_search"),
	"page.create": spec("page.create", "write", "createConfluenceContent", "confluence_create_page"),
	"page.update": spec("page.update", "write", "updateConfluenceContent", "confluence_update_page"),
	// Deferred on the default Official endpoint (reachable only through
	// executeWrite, or as a direct tool on the unqualified `?tools=all`
	// endpoint), so Official refuses it and Community carries it.
	"page.comment": spec("page.comment", "write", OFFICIAL_PAGE_COMMENT_TOOL, "confluence_add_comment", false),
};

// Operator commands beside the operations; each is a canonical command path.
export const COMMANDS = ["receipts", "receipt", "adjudicate", "unlock", "parity"] as const;
export type CommandId = (typeof COMMANDS)[number];

export const OFFICIAL_RESOURCES_TOOL = exactTool("atlassian-official-jira", "getAccessibleAtlassianResources");
export const OFFICIAL_USER_TOOL = exactTool("atlassian-official-jira", "atlassianUserInfo");
export type Product = OperationSpec["product"];

// Four static routes: each provider is split by product because the API
// token, the credential item, and the tool surface are product-specific.
export const SERVERS = [...SERVER_NAMES];

export function serverFor(provider: ProviderName, product: Product): ServerName {
	return `atlassian-${provider}-${product}`;
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
		// inspect reads; local changes only private journal or attestation state;
		// external reaches the provider with a write.
		effectClass: "inspect" | "local" | "external";
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
