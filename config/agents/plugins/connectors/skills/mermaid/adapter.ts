// Mermaid's packaged adapter for the generic `connectors run` and `schema`
// commands (Ticket #94 under Spec #87). It answers the keyless tier only: a
// read of one allow-listed hosted tool, planned through the shared route with
// no selector, header, or credential. The route is dispatcher-owned, so the
// public provider-route launcher cannot reach it. The optional account tier
// and every write stay unbuilt until their tools are verified against live
// schema; the core refuses writes because this adapter declares none.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRefusal, Prepared, SchemaRequest } from "../../bin/adapters/contract.ts";
import { planDispatcherRoute, RouteError } from "../../bin/provider-route.ts";
import { safeEnvironment } from "../../bin/safe-environment.ts";

const SERVER = "mermaid";
const INTERNAL_CONTEXT = "mermaid-tier=keyless";
// A keyless entry carries only these keys. A header, auth, env, or command
// key would move a credential into MCPorter, which the keyless tier never
// does and the account tier must not do (Spec AC11).
const KEYLESS_ENTRY_KEYS: ReadonlySet<string> = new Set(["description", "baseUrl", "allowedTools"]);

const REPAIR: Readonly<Record<AdapterRefusal["kind"], string>> = {
	usage: "Check the connectors run or schema arguments against connectors --help",
	domain: "Resolve the named Mermaid precondition, then retry",
	schema: "Restore skills/mermaid/config/mcporter.json to a keyless entry with baseUrl and allowedTools only",
	"verb-unsupported": "The Mermaid keyless tier needs no auth; use connectors run mermaid <tool> --input <json-object>",
	"operation-unknown": "Use one of the tools connectors schema mermaid lists as the run operation",
	"client-mode-not-admitted": "Mermaid has no client mode",
};

function refused(kind: AdapterRefusal["kind"], connectorCause: string): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair: REPAIR[kind] } };
}

// The keyless entry's own allow-list, or null when the entry is not keyless.
function keylessAllowedTools(registryPath: string): readonly string[] | null {
	const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
	const entry = registry.mcpServers[SERVER];
	if (!entry || !Object.keys(entry).every((key) => KEYLESS_ENTRY_KEYS.has(key))) return null;
	return entry.allowedTools as readonly string[];
}

// The route stays the only MCPorter argv composer; its refusal names a fixed
// code, never the caller's input.
function keylessRead(request: SchemaRequest, mcporterArgs: readonly string[], data: Record<string, unknown>): Prepared {
	let argv: readonly string[];
	let env: Readonly<Record<string, string>>;
	try {
		({ argv, env } = planDispatcherRoute([SERVER, "--", ...mcporterArgs], request.skillsRoot, safeEnvironment(request.env), INTERNAL_CONTEXT));
	} catch (error) {
		if (error instanceof RouteError) return refused(error.exitCode === 2 ? "usage" : "schema", `route-${error.code}`);
		throw error;
	}
	return {
		kind: "transport",
		effect: "read",
		argv,
		env,
		data: { tier: "keyless", ...data },
		commit: () => ({ refusal: null, completed: [] }),
		settle: () => [],
	};
}

function registryPath(request: SchemaRequest): string {
	return path.join(request.skillsRoot, SERVER, "config", "mcporter.json");
}

function prepareSchema(request: SchemaRequest): Prepared {
	const allowedTools = keylessAllowedTools(registryPath(request));
	if (allowedTools === null) return refused("schema", "registry-not-keyless");
	return keylessRead(request, ["list", "--schema", "--json"], { server: SERVER, allowedTools });
}

export const mermaidAdapter: Adapter = {
	id: "mermaid",
	prepare(request) {
		const { action } = request;
		if (action.kind === "auth") return refused("verb-unsupported", "keyless-tier-has-no-auth");
		const allowedTools = keylessAllowedTools(registryPath(request));
		if (allowedTools === null) return refused("schema", "registry-not-keyless");
		if (!allowedTools.includes(action.operation)) return refused("operation-unknown", "operation-not-allowed");
		const flags = action.input === null ? [] : ["--args", JSON.stringify(action.input)];
		return keylessRead(request, ["call", action.operation, ...flags, "--output", "json"], {});
	},
	prepareSchema,
};
