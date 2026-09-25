// Proof of failure translation at the transport seam: raw provider text in,
// a closed cause and fixed hint out, and none of the text survives.
import { describe, expect, test } from "bun:test";
import { OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { type ObservedFailure, type ProviderFailureCause, translateFailure } from "../scripts/dispatch/translate.ts";

const process_ = (stderr: string, stdout = "", exitCode = 1): ObservedFailure => ({ kind: "process", exitCode, stderr, stdout });
const toolError = (message: string): ObservedFailure => ({ kind: "tool-error", message });
const malformed = (message: string): ObservedFailure => ({ kind: "malformed", message });

describe("translateFailure", () => {
	// Test-owned table: observed provider text and the cause it must become.
	const TABLE: [string, ObservedFailure, ProviderFailureCause][] = [
		["tool error naming 403", toolError("Authentication failed for Jira (403). Token may be expired"), "refused-auth"],
		["process stderr naming 401", process_("HTTP 401 Unauthorized"), "refused-auth"],
		["bare 403 status", process_("HTTP 403"), "refused-auth"],
		["bare 401 status", toolError("status 401"), "refused-auth"],
		["forbidden wording", process_("request forbidden by policy"), "refused-auth"],
		["permission wording", toolError("You do not have permission to view this issue"), "refused-auth"],
		["404", toolError("Issue does not exist or you do not have permission to see it."), "refused-auth"],
		["not found", process_("HTTP 404 Not Found"), "not-found"],
		["ambiguous Confluence absence or permission cannot prove a delete", toolError("Failed to retrieve page by ID '123': Error retrieving page content: There is no content with the given id, or the calling user does not have permission to view the content"), "failed-unknown"],
		["unambiguous Confluence absence", toolError("There is no content with the given id"), "not-found"],
		["unknown tool", toolError("unknown tool getJiraIssue"), "capability-unavailable"],
		["tool not exposed", toolError("tool searchConfluence is not exposed on this server"), "capability-unavailable"],
		["connection reset", process_("connect ECONNRESET"), "failed-transport"],
		["timeout", process_("request timed out after 30000ms"), "failed-transport"],
		["dns", process_("getaddrinfo ENOTFOUND mcp.atlassian.com"), "failed-transport"],
		["unclassified process", process_("segmentation fault"), "failed-unknown"],
		["malformed output", malformed("MCPorter output was not JSON"), "failed-unknown"],
		["malformed output that mentions a timeout", malformed("timed out while parsing"), "failed-unknown"],
		["precondition line", process_("atlassian-provider:error:username-missing:JIRA_EXAMPLE_API_TOKEN needs a username field", "", 4), "refused-precondition"],
		["precondition beats a 401 substring", process_("atlassian-provider:error:uv-unavailable:uv is required\nHTTP 401 Unauthorized", "", 4), "refused-precondition"],
		["precondition on stdout", process_("", "atlassian-provider:error:credential-context-stale:credential item changed", 4), "refused-precondition"],
		["auth beats not-found", toolError("401 Unauthorized: issue not found"), "refused-auth"],
		["not-found beats capability", toolError("unknown tool not found"), "not-found"],
		// Retired Official codes are no longer our own precondition lines.
		["retired bridge code", process_("atlassian-provider:error:bridge-version-invalid:hyper-mcp-remote 0.5.0 is required", "", 4), "failed-unknown"],
		["retired injection code", process_("atlassian-provider:error:injection-mismatch:pair differs", "", 4), "failed-unknown"],
	];
	for (const [label, observed, cause] of TABLE) {
		test(`${label} -> ${cause}`, () => {
			expect(translateFailure(observed).cause).toBe(cause);
		});
	}

	test("a precondition line yields the fixed hint for its code and nothing from the message", () => {
		const translated = translateFailure(process_("atlassian-provider:error:username-missing:JIRA_EXAMPLE_API_TOKEN needs a username field", "", 4));
		expect(translated).toEqual({ cause: "refused-precondition", hint: "add a username field to the tenant's product credential item" });
		expect(translateFailure(process_("atlassian-provider:error:credential-context-stale:credential item changed; restart the semantic operation", "", 4)).hint).toBe("credential item metadata changed; restart the semantic operation");
		for (const [code, hint] of [
			["uv-unavailable", "the plugin-owned uv is not set up; run connectors setup"],
			["op-unavailable", "the plugin-owned 1Password CLI is not set up; run connectors setup"],
			["item-missing", "the product credential item is not in 1Password; its owner must create and store it"],
			["community-fields-missing", "the product credential item needs username, credential, and a site_url field"],
			["execve-unavailable", "run the Provider with a Bun runtime that supports process replacement"],
			["exec-failed", "inspect the Provider executable and runtime"],
		] as const) {
			expect(translateFailure(process_(`atlassian-provider:error:${code}:untrusted provider detail`, "", 4))).toEqual({ cause: "refused-precondition", hint });
		}
	});

	test("every non-precondition cause carries a null hint", () => {
		for (const observed of [toolError("HTTP 401"), process_("HTTP 404 Not Found"), toolError("unknown tool"), process_("connect ECONNRESET"), malformed("x"), process_("boom")]) {
			expect(translateFailure(observed).hint).toBeNull();
		}
	});

	test("hostile provider text never survives translation on any path", () => {
		const PRIVATE = ["fixture-secret-value", "customer SSN 123-45-6789", "PROJ-99 confidential merger", OP_TOKEN_SENTINEL, "op://", "Bearer", "Basic "];
		const leak = `token=fixture-secret-value Authorization: Basic ${OP_TOKEN_SENTINEL} Bearer x op://API Credentials/JIRA_EXAMPLE_API_TOKEN/credential; issue PROJ-99 confidential merger; customer SSN 123-45-6789; connect ETIMEDOUT`;
		for (const observed of [process_(leak), process_("", leak), toolError(leak), malformed(leak), process_(`atlassian-provider:error:credential-invalid:${leak}`, "", 4), process_(`${leak} HTTP 401`), process_(`${leak} 404 not found`)]) {
			const serialized = JSON.stringify(translateFailure(observed));
			for (const fragment of PRIVATE) expect(serialized).not.toContain(fragment);
		}
	});
});
