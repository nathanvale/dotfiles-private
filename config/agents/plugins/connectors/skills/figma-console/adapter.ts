import { readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, Executed, Prepared, RecoverRequest, SchemaRequest } from "../../bin/adapters/contract.ts";
import { validateWrite, WRITES, type CanvasWrite } from "./scripts/canvas.ts";
import { adjudicate, Journal, RECEIPT_ID, write } from "./scripts/journal.ts";
import { adjudicateSession, lifecycle } from "./scripts/lifecycle.ts";
import { canonical, ConsoleRefusal, record } from "./scripts/model.ts";
import { configurationInput, configure, configured, selection, VERSIONS } from "./scripts/profile.ts";
import { runProvider } from "./scripts/provider.ts";
import { READS, read, readInput } from "./scripts/reads.ts";
import { caller, SERVER, TOOLS } from "./scripts/transport.ts";

const REPAIR = "Inspect the named precondition and the figma-console skill; do not bypass account/file guards or replay an attempted write";
function refused(reason: string): Prepared { return { kind: "refused", refusal: { kind: "domain", connectorCause: reason, repair: REPAIR } }; }
function reason(error: unknown): string { return error instanceof ConsoleRefusal ? error.reason : "connector-unavailable"; }

// No added server, ambient import, executable, environment key, route
// declaration, or generic dispatcher call may widen this route. The internal
// execute tool is reachable only through the fixed source-owned scripts,
// never as a public operation.
function registryValid(request: SchemaRequest): boolean {
	try {
		const config = (name: string): unknown => JSON.parse(readFileSync(path.join(request.skillsRoot, "figma-console", "config", name), "utf8"));
		if (canonical(config("route.json")) !== canonical({ defaultProvider: SERVER, dispatcherOwned: true, ownedDaemon: true, selectors: { account: "FIGMA_CONSOLE_ACCOUNT", file: "FIGMA_CONSOLE_FILE" } })) return false;
		const registry = config("mcporter.json");
		if (!record(registry) || canonical(registry.imports) !== "[]" || !record(registry.mcpServers) || Object.keys(registry.mcpServers).join() !== SERVER) return false;
		const entry = registry.mcpServers[SERVER];
		return canonical(entry) === canonical({ description: "Pinned local-only Figma Console; owned lifecycle", command: "../../../bin/connectors", args: ["__internal", "figma-console", "provider"], env: { FIGMA_CONSOLE_ACCOUNT: "${FIGMA_CONSOLE_ACCOUNT}", FIGMA_CONSOLE_FILE: "${FIGMA_CONSOLE_FILE}", CONNECTORS_INTERNAL_INVOCATION_CONTEXT: "${CONNECTORS_INTERNAL_INVOCATION_CONTEXT}" }, lifecycle: { mode: "keep-alive" }, allowedTools: TOOLS });
	} catch { return false; }
}

function execute(request: SchemaRequest, step: (transport: ReturnType<typeof caller>, profile: ReturnType<typeof configured>) => Promise<Executed>): Prepared {
	if (!registryValid(request)) return refused("registry-invalid");
	return { kind: "execute", async execute(capabilities) {
		try {
			const profile = configured(request.env, request.selectors);
			return await step(caller(request, profile, capabilities), profile);
		} catch (error) { return { kind: "refused", refusal: { kind: "domain", connectorCause: reason(error), repair: REPAIR } }; }
	} };
}

function recovery(request: RecoverRequest): Prepared {
	if (request.runId !== null && !RECEIPT_ID.test(request.runId)) return refused("receipt-invalid");
	if (request.recovery.kind === "adjudicate" && Object.keys(request.recovery.input).length !== 0) return refused("recovery-input-invalid");
	return execute(request, async (transport, profile) => {
		// Recovery reads around a malformed receipt; writes still refuse on it.
		const journal = new Journal(request, profile, false), id = request.runId;
		if (id === null) return { kind: "success", data: journal.scan() };
		if (request.recovery.kind === "unlock") return { kind: "recorded", effect: "write-unlock", data: { receipt: journal.cancel(id) } };
		const receipt = journal.read(id);
		if (request.recovery.kind === "inspect") return { kind: "success", data: { receipt } };
		if (receipt.status !== "unknown" && receipt.status !== "sending") return { kind: "refused", refusal: { kind: "domain", connectorCause: "receipt-not-open", repair: REPAIR } };
		return receipt.operation === "session_start" || receipt.operation === "session_stop" ? adjudicateSession(journal, receipt, transport) : adjudicate(journal, receipt, transport);
	});
}

export const figmaConsoleAdapter: Adapter = {
	id: "figma-console",
	internalRoles: { provider: { run: runProvider } },
	prepare(request) {
		try { selection(request.selectors); } catch (error) { return refused(reason(error)); }
		const { action } = request;
		if (action.kind === "auth") {
			if (action.verb === "status") return { kind: "inspected", data: { configured: (() => { try { configured(request.env, request.selectors); return true; } catch { return false; } })(), versions: VERSIONS, qualification: "registration-only", connection: "not-probed", desktopAccount: "not-probed" } };
			if (action.verb !== "configure" || action.input === null) return refused("auth-verb-unsupported");
			if (!configurationInput({ ...action.input })) return refused("configuration-input-invalid");
			return { kind: "execute", async execute() {
				try {
					const data = { configured: true, qualification: "registration-only", versions: VERSIONS };
					return configure(request.env, request.selectors, { ...action.input }, request.skillsRoot).published ? { kind: "recorded", effect: "custody-registration", data } : { kind: "success", data: { ...data, unchanged: true } };
				} catch (error) { return { kind: "refused", refusal: { kind: "domain", connectorCause: reason(error), repair: REPAIR } }; }
			} };
		}
		const input = { ...action.input };
		if (!readInput(action.operation, input)) return refused(validateWrite(action.operation, input) ? "write-phase-required" : "operation-or-input-not-admitted");
		return execute(request, async (transport, profile) => ({ kind: "success", data: await read(request, profile, transport, action.operation, input) }));
	},
	prepareSchema() { return { kind: "inspected", data: { operations: { reads: READS, writes: [...WRITES, "session_start", "session_stop"] }, versions: VERSIONS, live: false, quarantined: ["generate_documentation", "check_design_parity"], unsupported: ["code_connect"], reason: "Use existing parity owner with complete measured fields; empty/missing fields never establish acceptance" } }; },
	prepareWrite(request) {
		const input = { ...request.input }, operation = request.operation;
		if (!validateWrite(operation, input)) return refused("write-input-invalid");
		return execute(request, (transport, profile) => operation === "session_start" || operation === "session_stop" ? lifecycle(request, profile, transport, operation, request.phase) : write(request, profile, transport, operation as CanvasWrite, input, request.phase));
	},
	prepareRecover: recovery,
};
