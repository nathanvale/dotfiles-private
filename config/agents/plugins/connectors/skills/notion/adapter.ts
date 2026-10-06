import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRequest, AdapterRefusal, CustodyResolution, Executed, LocalEffect, Prepared, SchemaRequest, RecoverRequest, WriteRequest } from "../../bin/adapters/contract.ts";
import { OPERATION_NAMES, operationKind, writeInput } from "./scripts/catalogue.ts";
import { accountVault, checkAccount, inspectVault, planNotionRoute, prepareVault } from "./scripts/custody.ts";
import { NotionError } from "./scripts/contract.ts";
import { NOTION_ENDPOINT } from "./scripts/endpoint.ts";
import { openJournal, PREVIEW_ID, RUN_ID, type Journal, type Receipt } from "./scripts/journal.ts";
import { notionCaller } from "./scripts/transport.ts";
import { prepareSchema } from "./scripts/schema.ts";
import { adjudicate, applyWrite, JOURNAL_CORRUPT, previewWrite, refused, unlockWrite } from "./scripts/writes.ts";

const REPAIR = "Inspect connectors schema notion --select account=<slug> and the Notion skill's write verification guide";
function refusal(kind: AdapterRefusal["kind"], connectorCause: string, repair = REPAIR): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}
function fromError(error: NotionError): AdapterRefusal {
	return { kind: error.exitCode === 2 ? "usage" : error.exitCode === 3 ? "domain" : "schema", connectorCause: error.code, repair: REPAIR };
}
function registryValid(skillsRoot: string): boolean {
	try {
		const registry = JSON.parse(readFileSync(path.join(skillsRoot, "notion/config/mcporter.json"), "utf8"));
		const entry = registry.mcpServers["notion-connectors"];
		const serverKeys = Object.keys(registry.mcpServers);
		const identity = entry.baseUrl === NOTION_ENDPOINT && entry.auth === "oauth" && entry.clientName === "Connectors plugin";
		const keys = Object.keys(entry).sort().join(",") === "allowedTools,auth,baseUrl,clientName,description";
		const tools = JSON.stringify([...entry.allowedTools].sort()) === JSON.stringify([...OPERATION_NAMES].sort());
		return Array.isArray(registry.imports) && registry.imports.length === 0 && serverKeys.join(",") === "notion-connectors" && identity && keys && tools;
	} catch { return false; }
}
function stamp(file: string): string | null {
	try { const stat = lstatSync(file, { bigint: true }); return `${stat.ino}:${stat.mtimeNs}:${stat.size}`; } catch { return null; }
}
function transport(request: SchemaRequest, args: string[], effect: "read" | "attended-login", data: Record<string, unknown>): Prepared {
	const account = checkAccount(request.selectors.account);
	const { plan, vault } = planNotionRoute(request.env, account, args, request.skillsRoot);
	let before: string | null = null;
	const directories = () => [vault.root, vault.dataHome, vault.cacheHome].map((directory) => { try { return lstatSync(directory).mode; } catch { return "absent"; } }).join(",");
	return {
		kind: "transport", effect, argv: plan.argv, env: plan.env, data: { account, ...data },
		commit() {
			const original = directories();
			try { prepareVault(vault); } catch (error) {
				if (!(error instanceof NotionError)) throw error;
				return { refusal: fromError(error), completed: directories() === original ? [] : ["account-vault"] };
			}
			before = stamp(path.join(vault.dataHome, "mcporter/credentials.json"));
			return { refusal: null, completed: directories() === original ? [] : ["account-vault"] };
		},
		settle(): readonly LocalEffect[] { return before === stamp(path.join(vault.dataHome, "mcporter/credentials.json")) ? [] : ["mcporter-vault-file"]; },
	};
}
function prepare(request: AdapterRequest): Prepared {
	const account = checkAccount(request.selectors.account);
	if (request.action.kind === "auth") {
		const { verb, loginOptions } = request.action;
		if (verb === "status") {
			const present = inspectVault(accountVault(request.env, account)).vaultFile === "present";
			return { kind: "inspected", data: { account, custody: "mcporter-native-vault", vaultIndex: present ? "present" : "absent", grant: present ? "unknown" : "absent" } };
		}
		return verb === "login" ? transport(request, ["auth", ...loginOptions.map((flag) => flag === "reset" ? "--reset" : "--no-browser")], "attended-login", {}) : refusal("verb-unsupported", "auth-verb-unsupported", "Notion supports auth status and attended auth login");
	}
	const { operation, input } = request.action;
	const kind = operationKind(operation);
	if (kind === null) return refusal("operation-unknown", "operation-not-allowed");
	if (kind === "write") return refusal("usage", "write-phase-required", "Use --preview, then --apply <previewId> with the identical input and _verify");
	if (input?._verify !== undefined) return refusal("usage", "read-takes-no-verification");
	return transport(request, ["call", operation, "--args", JSON.stringify(input ?? {}), "--output", "json"], "read", { operation });
}
function journaled(request: SchemaRequest, step: (journal: Journal | null, caller: ReturnType<typeof notionCaller>, account: string) => Promise<Executed>): Prepared {
	const account = checkAccount(request.selectors.account);
	return { kind: "execute", execute: (capabilities) => step(openJournal(request.env, account), notionCaller(request.env, request.skillsRoot, account, capabilities), account) };
}
function prepareWrite(request: WriteRequest): Prepared {
	const kind = operationKind(request.operation);
	if (kind === null) return refusal("operation-unknown", "operation-not-allowed");
	if (kind !== "write") return refusal("usage", "read-takes-no-phase");
	const write = writeInput(request.operation, request.input);
	if (write === null) return refusal("schema", "input-invalid", "Supply required tool arguments and _verify with admitted before/after reads and contains or absent criteria, or the permitted prepared-handle declaration; inspect the Notion skill guide");
	return journaled(request, (journal, caller, account) => request.phase.kind === "preview" ? previewWrite(write, caller, journal, account) : applyWrite(write, request.phase.previewId, caller, journal, account));
}
function prepareRecover(request: RecoverRequest): Prepared {
	const account = checkAccount(request.selectors.account);
	const { runId, recovery } = request;
	if (runId !== null && !RUN_ID.test(runId) && !(recovery.kind === "unlock" && PREVIEW_ID.test(runId))) return refusal("usage", "run-invalid");
	const journalOnly = (step: (journal: Journal, receipts: Receipt[]) => Executed): Prepared => ({
		kind: "execute", async execute() {
			const journal = openJournal(request.env, account);
			if (journal === null) return refused("journal-unavailable", REPAIR);
			const scan = journal.receipts();
			return scan.ok ? step(journal, scan.receipts) : JOURNAL_CORRUPT;
		},
	});
	if (runId === null) return journalOnly((_journal, receipts) => ({ kind: "success", data: { receipts: receipts.filter((item) => item.status === "sending" || item.status === "unknown") } }));
	if (recovery.kind === "unlock") return journalOnly((journal) => unlockWrite(journal, runId));
	if (recovery.kind === "inspect") return journalOnly((journal) => { const receipt = journal.receipt(runId); return receipt === null ? refused("run-unknown", REPAIR) : { kind: "success", data: { receipt } }; });
	return journaled(request, async (journal, caller) => {
		if (journal === null) return refused("journal-unavailable", REPAIR);
		if (!journal.receipts().ok) return JOURNAL_CORRUPT;
		const receipt = journal.receipt(runId);
		const write = receipt === null ? null : writeInput(receipt.operation, recovery.input);
		return receipt === null ? refused("run-unknown", REPAIR) : write === null ? refused("input-invalid", REPAIR) : adjudicate(write, receipt, caller, journal);
	});
}
function checked<T extends SchemaRequest>(step: (request: T) => Prepared): (request: T) => Prepared {
	return (request) => {
		if (!registryValid(request.skillsRoot)) return refusal("schema", "registry-invalid");
		try { return step(request); } catch (error) { if (error instanceof NotionError) return { kind: "refused", refusal: fromError(error) }; throw error; }
	};
}
function resolveCustody(request: SchemaRequest): CustodyResolution {
	try {
		const account = checkAccount(request.selectors.account);
		const value = inspectVault(accountVault(request.env, account)).vaultFile === "present";
		return { kind: "resolved", effective: value ? { mode: "mcporter-native-vault", source: "plugin-state:account-vault-index" } : null, notYetEffective: value ? null : { mode: "mcporter-native-vault", source: "plugin-state:account-vault-absent" }, subject: { selector: "account", value: account, source: "invocation-selector" } };
	} catch (error) { if (!(error instanceof NotionError)) throw error; const refusal = fromError(error); return { kind: "refused", refusal: { ...refusal, kind: error.exitCode === 2 ? "usage" : "domain" } }; }
}
export const notionAdapter: Adapter = {
	id: "notion", prepare: checked(prepare), prepareWrite: checked(prepareWrite), prepareRecover: checked(prepareRecover), resolveCustody,
	prepareSchema: checked(prepareSchema),
};
