// Mermaid's packaged adapter for the generic `connectors auth`, `run`,
// `schema`, and `recover` commands (Ticket #94 under Spec #87). Two tiers:
//
// keyless: a read of one allow-listed hosted tool, planned through the shared
// route with no selector, header, or credential.
// account: the optional tier. `auth configure` records one 1Password item
// ID; every other account command passes that registration first, before any
// Keychain, 1Password, MCPorter, or Provider start. Its tools run through the
// account server, whose stdio command is this adapter's Provider role, the
// only process that reads the item and holds the token. Its writes go
// through the journaled preview, apply, and recover flows in scripts/writes.ts.
//
// Every prepare step validates the request purely, and no refusal echoes
// caller input.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRefusal, AdapterRequest, ExecutionCapabilities, Executed, Prepared, RecoverRequest, SchemaRequest, WriteRequest } from "../../bin/adapters/contract.ts";
import { planDispatcherRoute, RouteError } from "../../bin/provider-route.ts";
import { safeEnvironment } from "../../bin/safe-environment.ts";
import { ACCOUNT_SERVER, KEYLESS_SERVER, OPERATION_CATALOGUE, OPERATION_NAMES, operationSpec, writeInput } from "./scripts/catalogue.ts";
import { configureAccount, CREDENTIAL_VAULT, isItemId, ITEM_ID_REPAIR, registeredAccount } from "./scripts/custody/index.ts";
import { type Journal, openJournal, type Receipt } from "./scripts/journal.ts";
import { runProvider } from "./scripts/provider.ts";
import { accountCaller, providerPreflight } from "./scripts/transport.ts";
import { adjudicate, applyWrite, JOURNAL_CORRUPT, previewWrite, unlockWrite } from "./scripts/writes.ts";

const INTERNAL_CONTEXT = "mermaid-tier=keyless";
const RUN_ID = /^mr-[0-9a-f-]{36}$/;
// Unlock alone also takes the preview ID of an apply that died before its receipt.
const PREVIEW_ID = /^mp-[0-9a-f-]{36}$/;
// A keyless entry carries only these keys. A header, auth, env, or command
// key would move a credential into MCPorter, which neither tier ever does
// (Spec AC11).
const KEYLESS_ENTRY_KEYS: ReadonlySet<string> = new Set(["description", "baseUrl", "allowedTools"]);

type RefusalKind = AdapterRefusal["kind"];

const REPAIR: Readonly<Record<RefusalKind, string>> = {
	usage: "Check the connectors run, recover, or schema arguments against connectors --help",
	domain: "Resolve the named Mermaid precondition, then retry",
	schema: "Restore skills/mermaid/config/mcporter.json to a keyless entry with baseUrl and allowedTools only",
	"verb-unsupported": "Mermaid supports auth configure, status, and check for its optional account tier; the keyless tier needs no auth",
	"operation-unknown": `Use one Mermaid operation: ${OPERATION_NAMES.join(", ")}`,
	"client-mode-not-admitted": "Mermaid has no client mode",
};
const WRITE_INPUT_REPAIR = "create needs projectID, title, and clientName, with optional code; update needs documentID, projectID, clientName, and at least one of title or code; every value is a non-empty string and no other key is admitted";
const WRITE_PHASE_REPAIR = "A Mermaid write needs --preview first, then --apply <previewId> with the identical --input";
const READ_PHASE_REPAIR = "A Mermaid read takes neither --preview nor --apply; run it without them";

function refused(kind: RefusalKind, connectorCause: string, repair: string = REPAIR[kind]): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}

type RegistryServers = Record<string, Record<string, unknown>>;

const registryServers = (request: SchemaRequest): RegistryServers => (JSON.parse(readFileSync(path.join(request.skillsRoot, "mermaid", "config", "mcporter.json"), "utf8")) as { mcpServers: RegistryServers }).mcpServers;

// The keyless entry's own allow-list, or null when the entry is not keyless.
function keylessAllowedTools(request: SchemaRequest, servers: RegistryServers = registryServers(request)): readonly string[] | null {
	const entry = servers[KEYLESS_SERVER];
	if (!entry || !Object.keys(entry).every((key) => KEYLESS_ENTRY_KEYS.has(key))) return null;
	return entry.allowedTools as readonly string[];
}

// The route stays the only MCPorter argv composer; its refusal names a fixed
// code, never the caller's input.
function keylessRead(request: SchemaRequest, mcporterArgs: readonly string[], data: Record<string, unknown>): Prepared {
	let argv: readonly string[];
	let env: Readonly<Record<string, string>>;
	try {
		({ argv, env } = planDispatcherRoute([KEYLESS_SERVER, "--", ...mcporterArgs], request.skillsRoot, safeEnvironment(request.env), INTERNAL_CONTEXT));
	} catch (error) {
		if (error instanceof RouteError) return refused(error.exitCode === 2 ? "usage" : "schema", `route-${error.code}`);
		throw error;
	}
	return { kind: "transport", effect: "read", argv, env, data: { tier: "keyless", ...data }, commit: () => ({ refusal: null, completed: [] }), settle: () => [] };
}

// The registration gate, then an execute step holding the registered item.
function accountPlan(request: SchemaRequest, step: (item: string, capabilities: ExecutionCapabilities) => Promise<Executed>): Prepared {
	const registered = registeredAccount(request.env);
	if (!registered.ok) return refused("domain", registered.cause, registered.repair);
	return { kind: "execute", execute: (capabilities) => step(registered.item, capabilities) };
}

const caller = (request: SchemaRequest, item: string, capabilities: ExecutionCapabilities) => accountCaller(request.env, request.skillsRoot, item, capabilities);

function accountRead(request: SchemaRequest, operation: string, input: Readonly<Record<string, unknown>>): Prepared {
	return accountPlan(request, async (item, capabilities) => {
		const result = await caller(request, item, capabilities).call(operation, input);
		if (result.ok) return { kind: "success", data: { operation, tier: "account", result: result.data } };
		if (!result.sent) return { kind: "refused", refusal: { kind: "domain", connectorCause: result.cause, repair: result.repair } };
		return { kind: "failed", connectorCause: result.cause, repair: "The Mermaid account read did not complete; check the input against connectors schema, then run it again" };
	});
}

function prepareRun(request: AdapterRequest, operation: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	const spec = operationSpec(operation);
	if (spec === null) return refused("operation-unknown", "operation-not-allowed");
	const allowedTools = keylessAllowedTools(request);
	if (allowedTools === null) return refused("schema", "registry-not-keyless");
	if (spec.kind === "write") return refused("usage", "write-phase-required", WRITE_PHASE_REPAIR);
	if (spec.tier === "account") return accountRead(request, operation, input ?? {});
	if (!allowedTools.includes(operation)) return refused("operation-unknown", "operation-not-allowed");
	const flags = input === null ? [] : ["--args", JSON.stringify(input)];
	return keylessRead(request, ["call", operation, ...flags, "--output", "json"], {});
}

// Configure records the item ID only: no Keychain, 1Password, MCPorter, or
// Provider. Check proves custody through the Provider's own preflight, never
// starting MCPorter, so it never claims authentication.
function prepareAuth(request: AdapterRequest, verb: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	if (verb === "configure") {
		const item = input !== null && Object.keys(input).join(",") === "item" && isItemId(input.item) ? input.item : null;
		if (item === null) return refused("schema", "item-reference-invalid", ITEM_ID_REPAIR);
		return {
			kind: "execute",
			async execute(): Promise<Executed> {
				const configured = configureAccount(item, request.env);
				if (configured.kind === "refused") return { kind: "refused", refusal: { kind: "domain", connectorCause: configured.cause, repair: configured.repair } };
				const data = { vault: CREDENTIAL_VAULT, item, nextStep: "connectors auth check mermaid" };
				return configured.kind === "published" ? { kind: "recorded", effect: "custody-registration", data } : { kind: "success", data };
			},
		};
	}
	if (verb === "status") {
		const registered = registeredAccount(request.env);
		if (registered.ok) return { kind: "inspected", data: { registration: "registered", vault: CREDENTIAL_VAULT, item: registered.item, nextStep: "connectors auth check mermaid" } };
		if (registered.cause === "registration-invalid") return refused("domain", registered.cause, registered.repair);
		return { kind: "inspected", data: { registration: "absent", nextStep: registered.repair } };
	}
	if (verb === "check") {
		return accountPlan(request, async (item, capabilities) => {
			const unready = providerPreflight(request.env, item, capabilities);
			if (unready) return { kind: "refused", refusal: { kind: "domain", connectorCause: unready.cause, repair: unready.repair } };
			return { kind: "success", data: { custodyChecked: true, vault: CREDENTIAL_VAULT, item } };
		});
	}
	return refused("verb-unsupported", "auth-verb-unsupported");
}

function prepareWrite(request: WriteRequest): Prepared {
	const spec = operationSpec(request.operation);
	if (spec === null) return refused("operation-unknown", "operation-not-allowed");
	if (spec.kind !== "write") return refused("usage", "read-takes-no-phase", READ_PHASE_REPAIR);
	const write = writeInput(request.operation, request.input);
	if (write === null) return refused("schema", "input-invalid", WRITE_INPUT_REPAIR);
	const { phase } = request;
	return accountPlan(request, (item, capabilities) => {
		const journal = openJournal(request.env);
		const account = caller(request, item, capabilities);
		return phase.kind === "preview" ? previewWrite(write, account, journal) : applyWrite(write, phase.previewId, account, journal);
	});
}

// Inspection and unlock touch the journal alone; only adjudication reads the
// account, so only it passes the registration gate. Every recovery refuses
// while any receipt is unreadable or malformed.
function prepareRecover(request: RecoverRequest): Prepared {
	const { runId, recovery } = request;
	if (runId !== null && !RUN_ID.test(runId) && !(recovery.kind === "unlock" && PREVIEW_ID.test(runId))) return refused("usage", "run-invalid");
	const journalOnly = (step: (journal: Journal, receipts: Receipt[]) => Executed): Prepared => ({
		kind: "execute",
		async execute(): Promise<Executed> {
			const journal = openJournal(request.env);
			if (journal === null) return { kind: "refused", refusal: { kind: "domain", connectorCause: "journal-unavailable", repair: REPAIR.domain } };
			const scan = journal.receipts();
			return scan.ok ? step(journal, scan.receipts) : JOURNAL_CORRUPT;
		},
	});
	if (runId === null) return journalOnly((_journal, receipts) => ({ kind: "success", data: { receipts: receipts.filter((receipt) => receipt.status === "sending" || receipt.status === "unknown") } }));
	const missing: Executed = { kind: "refused", refusal: { kind: "domain", connectorCause: "run-unknown", repair: "Run connectors recover mermaid to list open receipts" } };
	if (recovery.kind === "inspect") return journalOnly((journal) => { const receipt = journal.receipt(runId); return receipt === null ? missing : { kind: "success", data: { receipt } }; });
	if (recovery.kind === "unlock") return journalOnly((journal) => unlockWrite(journal, runId));
	const { input } = recovery;
	return accountPlan(request, async (item, capabilities) => {
		const journal = openJournal(request.env);
		const scan = journal?.receipts();
		if (scan && !scan.ok) return JOURNAL_CORRUPT;
		const receipt = journal?.receipt(runId) ?? null;
		if (journal === null || receipt === null) return missing;
		return adjudicate(receipt, writeInput(receipt.operation, input), caller(request, item, capabilities), journal);
	});
}

// The live schema is the keyless server's, which needs no credential. The
// account server's declared allow-list and the whole read and write
// catalogue ride beside it, declared rather than live-listed.
function prepareSchema(request: SchemaRequest): Prepared {
	const servers = registryServers(request);
	const allowedTools = keylessAllowedTools(request, servers);
	if (allowedTools === null) return refused("schema", "registry-not-keyless");
	const accountTools = servers[ACCOUNT_SERVER]?.allowedTools ?? [];
	return keylessRead(request, ["list", "--schema", "--json"], { server: KEYLESS_SERVER, allowedTools, accountServer: ACCOUNT_SERVER, accountTools, operations: OPERATION_CATALOGUE });
}

export const mermaidAdapter: Adapter = {
	id: "mermaid",
	prepare(request) {
		const { action } = request;
		return action.kind === "auth" ? prepareAuth(request, action.verb, action.input) : prepareRun(request, action.operation, action.input);
	},
	prepareSchema,
	prepareWrite,
	prepareRecover,
	internalRoles: { provider: { run: (argv) => runProvider(argv) } },
};
