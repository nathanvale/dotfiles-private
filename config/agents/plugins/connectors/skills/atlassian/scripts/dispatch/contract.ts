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

// The sole executable vocabulary owner. Every operation lookup and every
// server allow-list is derived from these literals; registry bytes are only a
// checked mirror. Keep independent test expectations literal.
export const TOOL_VOCABULARY = {
	"atlassian-official-jira": ["atlassianUserInfo", "getAccessibleAtlassianResources", "getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "editJiraIssue", "addOrEditJiraIssueComment"],
	"atlassian-official-confluence": ["atlassianUserInfo", "getAccessibleAtlassianResources", "getConfluenceContent", "searchConfluence", "getConfluenceSpace", "createConfluenceContent", "updateConfluenceContent"],
	"atlassian-community-jira": ["jira_get_issue", "jira_search", "jira_create_issue", "jira_update_issue", "jira_add_comment"],
	"atlassian-community-confluence": ["confluence_get_page", "confluence_search", "confluence_get_space", "confluence_get_comments", "confluence_create_page", "confluence_update_page", "confluence_add_comment"],
} as const;
export type ServerName = keyof typeof TOOL_VOCABULARY;
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

const toolAt = (server: ServerName, index: number): string => TOOL_VOCABULARY[server][index] ?? "";
const spec = (id: OperationId, kind: "read" | "write", officialIndex: number | string, communityIndex: number, reachable = true): OperationSpec => ({
	id,
	kind,
	product: id.startsWith("issue.") ? "jira" : "confluence",
	official: { tool: typeof officialIndex === "string" ? officialIndex : toolAt(id.startsWith("issue.") ? "atlassian-official-jira" : "atlassian-official-confluence", officialIndex), reachable },
	community: { tool: toolAt(id.startsWith("issue.") ? "atlassian-community-jira" : "atlassian-community-confluence", communityIndex) },
});

export const OPERATION_SPECS: Record<OperationId, OperationSpec> = {
	"issue.get": spec("issue.get", "read", 2, 0),
	"issue.search": spec("issue.search", "read", 3, 1),
	"issue.create": spec("issue.create", "write", 4, 2),
	"issue.update": spec("issue.update", "write", 5, 3),
	"issue.comment": spec("issue.comment", "write", 6, 4),
	"page.get": spec("page.get", "read", 2, 0),
	"page.search": spec("page.search", "read", 3, 1),
	"page.create": spec("page.create", "write", 5, 4),
	"page.update": spec("page.update", "write", 6, 5),
	// Deferred on the default Official endpoint (reachable only through
	// executeWrite, or as a direct tool on the unqualified `?tools=all`
	// endpoint), so Official refuses it and Community carries it.
	"page.comment": spec("page.comment", "write", OFFICIAL_PAGE_COMMENT_TOOL, 6, false),
};

// Operator commands beside the operations; each is a canonical command path.
export const COMMANDS = ["receipts", "receipt", "adjudicate", "unlock", "parity"] as const;
export type CommandId = (typeof COMMANDS)[number];

export const OFFICIAL_RESOURCES_TOOL = toolAt("atlassian-official-jira", 1);
export const OFFICIAL_USER_TOOL = toolAt("atlassian-official-jira", 0);
export type Product = OperationSpec["product"];

// Four static routes: each provider is split by product because the API
// token, the credential item, and the tool surface are product-specific.
export const SERVERS = Object.keys(TOOL_VOCABULARY) as ServerName[];

export function serverFor(provider: ProviderName, product: Product): ServerName {
	return `atlassian-${provider}-${product}`;
}

// Exact allow-lists the registry must mirror. Broad dispatchers (discover,
// executeRead, executeWrite, executeDestructive) are never listed: a name
// filter cannot bind them to one operation. Writes are exact tool names
// reached only through the journaled preview and apply flow; the extra reads
// serve read-back adjudication (comments) only.
export const ALLOWED_TOOLS: Record<ServerName, readonly string[]> = Object.fromEntries(SERVERS.map((server) => [server, [...TOOL_VOCABULARY[server]]])) as unknown as Record<ServerName, readonly string[]>;

export function registryMatchesVocabulary(registry: unknown): boolean {
	if (typeof registry !== "object" || registry === null || Array.isArray(registry)) return false;
	const servers = (registry as { mcpServers?: unknown }).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;
	const entries = servers as Record<string, unknown>;
	return Object.keys(entries).length === SERVERS.length && SERVERS.every((server) => {
		const candidate = entries[server];
		return typeof candidate === "object" && candidate !== null && Array.isArray((candidate as { allowedTools?: unknown }).allowedTools) && JSON.stringify((candidate as { allowedTools: unknown }).allowedTools) === JSON.stringify(ALLOWED_TOOLS[server]);
	});
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
