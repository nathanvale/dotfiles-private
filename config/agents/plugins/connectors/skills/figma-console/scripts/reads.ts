import path from "node:path";
import { publishPrivateFileOnce, readPrivateFile } from "../../../bin/private-state.ts";
import { snapshotScript } from "./canvas.ts";
import { bare, canonical, ConsoleRefusal, type Data, NODE_ID, record } from "./model.ts";
import { type Profile, profileRoot } from "./profile.ts";
import { currentSnapshot, type ConsoleCaller } from "./transport.ts";
import type { SchemaRequest } from "../../../bin/adapters/contract.ts";

export const READS = ["status", "read_node", "read_variables", "export_tokens", "read_file", "read_component", "analyze_variants", "lint", "audit_accessibility", "read_changes", "read_history", "screenshot", "session_status"] as const;
// Upstream tools that take the file itself as an argument.
const FILE_BOUND = new Set(["export_tokens", "read_file", "read_history"]);
const NODE_READS = new Set(["read_node", "read_component", "analyze_variants", "lint", "audit_accessibility", "screenshot"]);

export function readInput(operation: string, input: Data): boolean {
	if (!(READS as readonly string[]).includes(operation)) return false;
	if (NODE_READS.has(operation)) return Object.keys(input).join(",") === "nodeId" && bare(input.nodeId, NODE_ID);
	if (operation === "export_tokens") return Object.keys(input).join(",") === "format" && (input.format === "dtcg" || input.format === "css-vars");
	return Object.keys(input).length === 0;
}

// Upstream freshness is not a contract, so any stale, cache, fallback or
// warning mark at any depth refuses: a singular or plural warning that is not
// empty, a truthy stale or cache flag, or a source naming a cache or fallback.
// Only a `warning` or `warnings` key may hold an object, and only a DTCG token
// or group (a token is `$value` with `$` keys only), so `color.warning` is
// data while `{warning:{message}}` and any object flag still refuse.
const STALE_KEY = /^(?:warnings?|cached|stale|isStale|fallback|usedFallback|fromCache|cacheHit|usedCache)$/i;
const STALE_SOURCE = /cache|fallback|stale/i;
const TOKEN_NAME = /^warnings?$/i;
const dtcgToken = (value: unknown): boolean => record(value) && "$value" in value && Object.keys(value).every((key) => key.startsWith("$"));
const tokenGroup = (value: unknown): boolean => record(value) && (dtcgToken(value) || (!("$value" in value) && Object.keys(value).some((key) => !key.startsWith("$")) && Object.entries(value).every(([key, item]) => key.startsWith("$") || tokenGroup(item))));
const empty = (value: unknown): boolean => value === undefined || value === null || value === false || value === "" || (Array.isArray(value) && value.length === 0);
export function rejectFallback(value: unknown): void {
	if (Array.isArray(value)) { for (const item of value) rejectFallback(item); return; }
	if (!record(value)) return;
	for (const [key, item] of Object.entries(value)) {
		if ((STALE_KEY.test(key) && !empty(item) && !(TOKEN_NAME.test(key) && tokenGroup(item))) || (key === "source" && typeof item === "string" && STALE_SOURCE.test(item))) throw new ConsoleRefusal("stale-or-warning-result");
		rejectFallback(item);
	}
}

async function exportTokens(request: SchemaRequest, profile: Profile, transport: ConsoleCaller, format: unknown): Promise<unknown> {
	const configPath = path.join(profileRoot(request.env, profile), "tokens.config.json");
	const content = `${canonical({ figmaFile: profile.fileKey })}\n`;
	// The private config names only this file; whichever publisher won, its
	// bytes must be exactly these.
	const prior = readPrivateFile(configPath), published = prior.ok ? null : publishPrivateFileOnce(configPath, content);
	const exact = prior.ok ? prior.text === content : published?.ok === true && (published.published || published.existing === content);
	if (!exact) throw new ConsoleRefusal("export-config-invalid");
	const refreshed = await transport.call("figma_get_variables", { fileUrl: `https://www.figma.com/design/${profile.fileKey}`, refreshCache: true, format: "full", includePublished: false });
	rejectFallback(refreshed);
	const result = await transport.call("figma_export_tokens", { format, configPath, scope: "file", modes: "all", resolveAliases: false, sizeUnit: "px" });
	rejectFallback(result);
	return result;
}

export async function read(request: SchemaRequest, profile: Profile, transport: ConsoleCaller, operation: string, input: Data): Promise<Data> {
	if (operation === "session_status") return { session: await transport.daemon("status") };
	// No guard runs for status: it names the selection, not a verified file.
	if (operation === "status") return { provider: await transport.call("figma_get_status", { probe: true }), qualification: "connection-only", selected: { account: profile.account, fileKey: profile.fileKey }, fileVerified: false };
	const fileUrl = `https://www.figma.com/design/${profile.fileKey}`;
	// Fixed execute reads bind the file in both dispatch and the Plugin API.
	const before = await currentSnapshot(transport, profile, snapshotScript(profile, input));
	if (operation === "read_node" || operation === "read_variables") return { snapshot: before, qualification: "diagnostic", coverage: operation === "read_node" ? "bounded-subtree-and-all-local-variables" : "all-current-local-variables" };
	let result: unknown;
	switch (operation) {
		case "export_tokens": result = await exportTokens(request, profile, transport, input.format); break;
		case "read_file": result = await transport.call("figma_get_file_data", { fileUrl, depth: 2, verbosity: "standard", enrich: false }); break;
		case "read_component": result = await transport.call("figma_get_component", { fileUrl, nodeId: input.nodeId, enrich: false }); break;
		case "analyze_variants": result = await transport.call("figma_analyze_component_set", { nodeId: input.nodeId }); break;
		case "lint": result = await transport.call("figma_lint_design", { nodeId: input.nodeId, maxDepth: 10, maxFindings: 100 }); break;
		case "audit_accessibility": result = await transport.call("figma_audit_component_accessibility", { nodeId: input.nodeId, targetSize: 24 }); break;
		case "read_changes": result = await transport.call("figma_get_design_changes", { count: 100, clear: false }); break;
		case "read_history": result = await transport.call("figma_get_file_versions", { fileUrl, max_versions: 20, include_autosaves: true }); break;
		case "screenshot": result = await transport.call("figma_take_screenshot", { nodeId: input.nodeId, scale: 1, format: "png" }); break;
		default: throw new ConsoleRefusal("operation-not-admitted");
	}
	const after = await currentSnapshot(transport, profile, snapshotScript(profile, input));
	const changedDuringRead = canonical(before) !== canonical(after);
	// Tokens exported while variables changed cannot name one file state.
	if (operation === "export_tokens" && changedDuringRead) throw new ConsoleRefusal("changed-during-export");
	// The guards prove the bridge's selected file before and after; an upstream
	// tool without a file argument may still read another open file.
	return { result, account: profile.userId, fileKey: profile.fileKey, qualification: "diagnostic", binding: FILE_BOUND.has(operation) ? "file-argument-and-guards" : "guards-only-upstream-active-file", changedDuringRead, acceptance: "not-evaluated" };
}
