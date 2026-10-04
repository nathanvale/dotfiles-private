// Figma's packaged adapter for the generic `connectors auth`, `run`, `schema`,
// and `recover` commands. Figma's route is dispatcher-owned: this adapter is
// the only way to the hosted server. MCPorter owns the OAuth grant in Figma's
// own vault root (scripts/vault.ts) with ADR 0003's fixed endpoint and
// borrowed client name. Reads pass through as one cached-grant call. Writes
// go through the journaled preview, apply, and recover flows in
// scripts/writes.ts (ADR 0005).
//
// Every prepare step validates the request purely, and no refusal echoes
// caller input.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRefusal, AdapterRequest, Executed, LocalEffect, LoginOption, Prepared, RecoverRequest, SchemaRequest, WriteRequest } from "../../bin/adapters/contract.ts";
import { planDispatcherRoute, RouteError } from "../../bin/provider-route.ts";
import { safeEnvironment } from "../../bin/safe-environment.ts";
import { acceptedKeys, OPERATION_CATALOGUE, OPERATION_NAMES, operationKind, SERVER, writeInput } from "./scripts/catalogue.ts";
import { FIGMA_ENDPOINT } from "./scripts/endpoint.ts";
import { type Journal, openJournal, PREVIEW_ID, type Receipt, RUN_ID } from "./scripts/journal.ts";
import { figmaCaller, INTERNAL_CONTEXT } from "./scripts/transport.ts";
import { adjudicateUpload, applyUpload, previewUpload } from "./scripts/uploads.ts";
import { directoryStamp, figmaVault, prepareVault, vaultStamp } from "./scripts/vault.ts";
import { adjudicate, applyWrite, JOURNAL_CORRUPT, previewWrite, unlockWrite } from "./scripts/writes.ts";

type RefusalKind = AdapterRefusal["kind"];

const REPAIR: Readonly<Record<RefusalKind, string>> = {
	usage: "Check the connectors run, recover, auth, or schema arguments against connectors --help",
	domain: "Resolve the named Figma precondition, then retry",
	schema: "Restore skills/figma/config/mcporter.json to the packaged Figma registry",
	"verb-unsupported": "Figma supports auth status and auth login",
	"operation-unknown": `Use one Figma operation: ${OPERATION_NAMES.join(", ")}`,
	"client-mode-not-admitted": "Figma has no client mode",
};
const WRITE_PHASE_REPAIR = "A Figma write needs --preview first, then --apply <previewId> with the identical --input";
const READ_PHASE_REPAIR = "A Figma read takes neither --preview nor --apply; run it without them";
const ENTRY_KEYS = "allowedTools,auth,baseUrl,clientName,description";
const AUTH_VERBS = new Set(["status", "login"]);
const VAULT_REPAIR = "Figma's MCPorter vault root under Connectors state is not a private owned directory; make it an owner-only (0700) directory this user owns, then retry";
const MCPORTER_LOGIN_FLAGS: Readonly<Record<LoginOption, string>> = { "no-browser": "--no-browser", reset: "--reset" };

function refused(kind: RefusalKind, connectorCause: string, repair: string = REPAIR[kind]): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}

// The packaged registry, exactly: one server on the fixed endpoint, MCPorter
// OAuth under the borrowed client name, and an allow-list equal to the
// catalogue. Anything else would widen or redirect the route.
function registryValid(skillsRoot: string): boolean {
	try {
		const registry = JSON.parse(readFileSync(path.join(skillsRoot, "figma", "config", "mcporter.json"), "utf8")) as { imports?: unknown; mcpServers?: Record<string, Record<string, unknown>> };
		const servers = registry.mcpServers ?? {};
		const entry = servers[SERVER];
		if (!Array.isArray(registry.imports) || registry.imports.length !== 0 || Object.keys(servers).join(",") !== SERVER || entry === undefined) return false;
		const tools = Array.isArray(entry.allowedTools) ? [...(entry.allowedTools as string[])].sort() : [];
		return Object.keys(entry).sort().join(",") === ENTRY_KEYS && entry.baseUrl === FIGMA_ENDPOINT && entry.auth === "oauth" && entry.clientName === "Claude Code" && JSON.stringify(tools) === JSON.stringify([...OPERATION_NAMES].sort());
	} catch {
		return false;
	}
}

// The route stays the only MCPorter argv composer; its refusal names a fixed
// code, never the caller's input.
function transport(request: SchemaRequest, mcporterArgs: readonly string[], effect: "read" | "attended-login", data: Record<string, unknown>): Prepared {
	if (!registryValid(request.skillsRoot)) return refused("schema", "registry-invalid");
	let argv: readonly string[];
	let env: Readonly<Record<string, string>>;
	try {
		({ argv, env } = planDispatcherRoute(["figma", "--", ...mcporterArgs], request.skillsRoot, safeEnvironment(request.env), INTERNAL_CONTEXT));
	} catch (error) {
		if (error instanceof RouteError) return refused(error.exitCode === 2 ? "usage" : "schema", `route-${error.code}`);
		throw error;
	}
	const vault = figmaVault(request.env);
	let before: string | null = null;
	return {
		kind: "transport",
		effect,
		argv,
		env: { ...env, ...vault.env },
		data: { server: SERVER, endpoint: FIGMA_ENDPOINT, ...data },
		commit() {
			const directories = directoryStamp(vault);
			if (!prepareVault(vault)) return { refusal: { kind: "domain", connectorCause: "vault-root-invalid", repair: VAULT_REPAIR }, completed: [] };
			before = vaultStamp(vault);
			return { refusal: null, completed: directoryStamp(vault) === directories ? [] : ["account-vault"] };
		},
		settle(): readonly LocalEffect[] {
			return vaultStamp(vault) === before ? [] : ["mcporter-vault-file"];
		},
	};
}

function prepareAuth(request: AdapterRequest, verb: string, options: readonly LoginOption[]): Prepared {
	if (!AUTH_VERBS.has(verb)) return refused("verb-unsupported", "auth-verb-unsupported");
	if (verb === "status") {
		// A present vault may hold only MCPorter's grant-free index.
		const present = vaultStamp(figmaVault(request.env)) !== null;
		return { kind: "inspected", data: { server: SERVER, endpoint: FIGMA_ENDPOINT, custody: "mcporter-native-vault", vault: "connectors-figma", vaultIndex: present ? "present" : "absent", grant: present ? "unknown" : "absent", nextStep: "connectors auth login figma" } };
	}
	return transport(request, ["auth", ...options.map((option) => MCPORTER_LOGIN_FLAGS[option])], "attended-login", {});
}

function prepareRun(request: AdapterRequest, operation: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	const kind = operationKind(operation);
	if (kind === null) return refused("operation-unknown", "operation-not-allowed");
	if (kind === "write") return refused("usage", "write-phase-required", WRITE_PHASE_REPAIR);
	const flags = input === null ? [] : ["--args", JSON.stringify(input)];
	return transport(request, ["call", operation, ...flags, "--output", "json"], "read", { operation });
}

function journaled(request: SchemaRequest, step: (journal: Journal | null, caller: ReturnType<typeof figmaCaller>) => Promise<Executed>): Prepared {
	if (!registryValid(request.skillsRoot)) return refused("schema", "registry-invalid");
	return { kind: "execute", execute: (capabilities) => step(openJournal(request.env), figmaCaller(request.env, request.skillsRoot, capabilities)) };
}

function prepareWrite(request: WriteRequest): Prepared {
	const kind = operationKind(request.operation);
	if (kind === null) return refused("operation-unknown", "operation-not-allowed");
	if (kind !== "write") return refused("usage", "read-takes-no-phase", READ_PHASE_REPAIR);
	const write = writeInput(request.operation, request.input);
	if (write === null) return refused("schema", "input-invalid", acceptedKeys(request.operation) ?? REPAIR.schema);
	const { phase } = request;
	if (write.spec.evidence === "upload") return journaled(request, (journal, caller) => (phase.kind === "preview" ? previewUpload(write, request.env, caller, journal) : applyUpload(write, phase.previewId, request.env, caller, journal)));
	return journaled(request, (journal, caller) => (phase.kind === "preview" ? previewWrite(write, caller, journal) : applyWrite(write, phase.previewId, caller, journal)));
}

// Inspection and unlock touch the journal alone; only adjudication reads
// Figma. Every recovery refuses while any receipt is unreadable or malformed.
function prepareRecover(request: RecoverRequest): Prepared {
	const { runId, recovery } = request;
	if (runId !== null && !RUN_ID.test(runId) && !(recovery.kind === "unlock" && PREVIEW_ID.test(runId))) return refused("usage", "run-invalid");
	const unavailable: Executed = { kind: "refused", refusal: { kind: "domain", connectorCause: "journal-unavailable", repair: REPAIR.domain } };
	const journalOnly = (step: (journal: Journal, receipts: Receipt[]) => Executed): Prepared => ({
		kind: "execute",
		async execute(): Promise<Executed> {
			const journal = openJournal(request.env);
			if (journal === null) return unavailable;
			const scan = journal.receipts();
			return scan.ok ? step(journal, scan.receipts) : JOURNAL_CORRUPT;
		},
	});
	if (runId === null) return journalOnly((_journal, receipts) => ({ kind: "success", data: { receipts: receipts.filter((receipt) => receipt.status === "sending" || receipt.status === "unknown") } }));
	const missing: Executed = { kind: "refused", refusal: { kind: "domain", connectorCause: "run-unknown", repair: "Run connectors recover figma to list open receipts" } };
	if (recovery.kind === "inspect") return journalOnly((journal) => journal.receipt(runId) === null ? missing : { kind: "success", data: { receipt: journal.receipt(runId) } });
	if (recovery.kind === "unlock") return journalOnly((journal) => unlockWrite(journal, runId));
	const { input } = recovery;
	return journaled(request, async (journal, caller) => {
		if (journal === null) return unavailable;
		const scan = journal.receipts();
		if (!scan.ok) return JOURNAL_CORRUPT;
		const receipt = journal.receipt(runId);
		if (receipt === null) return missing;
		const write = writeInput(receipt.operation, input);
		if (write?.spec.evidence === "upload") return adjudicateUpload(receipt, write, request.env, caller, journal);
		return adjudicate(receipt, write, caller, journal);
	});
}

// The live schema is a cached-grant read; the whole read and write catalogue
// rides beside it, declared rather than live-listed.
function prepareSchema(request: SchemaRequest): Prepared {
	return transport(request, ["list", "--schema", "--json"], "read", { allowedTools: OPERATION_NAMES, operations: OPERATION_CATALOGUE });
}

export const figmaAdapter: Adapter = {
	id: "figma",
	prepare(request) {
		const { action } = request;
		return action.kind === "auth" ? prepareAuth(request, action.verb, action.loginOptions) : prepareRun(request, action.operation, action.input);
	},
	prepareSchema,
	prepareWrite,
	prepareRecover,
};
