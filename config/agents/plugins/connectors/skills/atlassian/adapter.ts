// Atlassian's packaged adapter for the generic `connectors auth check`, `run`,
// and `recover` commands (Ticket #92 under Spec #87). Every prepare step
// validates the request with the dispatcher's own pure parser and input
// contracts, so a bad request refuses before any dependency, credential, or
// Provider capability. execute runs the unchanged dispatcher in this process
// with the front door's MCPorter selection and its own internal-role command,
// so credential custody happens only in the internal custody and Provider
// roles below. Writes go through the dispatcher's durable preview and apply
// journal; recover reaches its receipts, adjudicate, and unlock commands.
import type { Adapter, AdapterRefusal, AdapterRequest, Executed, ExecutionCapabilities, InternalRole, Prepared, RecordedEffect, Recovery, RecoverRequest, SchemaRequest, WriteRequest } from "../../bin/adapters/contract.ts";
import { runProvider } from "./scripts/atlassian-community-provider.ts";
import { parseArgv, run } from "./scripts/atlassian-dispatch.ts";
import { ATLASSIAN_ADAPTER_ID, type AtlassianInternalRole, bindCredential, PRODUCTS, runCustodyChild } from "./scripts/custody/index.ts";
import { type CauseCode, COMMANDS, type Envelope, OPERATIONS, type WriteOperation } from "./scripts/dispatch/contract.ts";
import { readInput, specFor } from "./scripts/dispatch/engine.ts";
import { productionDependencies } from "./scripts/dispatch/runtime.ts";
import { writeInput } from "./scripts/dispatch/writes.ts";

type RefusalKind = Extract<AdapterRefusal["kind"], "usage" | "schema" | "verb-unsupported" | "operation-unknown">;

const REPAIR: Readonly<Record<RefusalKind, string>> = {
	usage: "Check the connectors run or recover arguments against connectors --help",
	schema: "Correct the --input object to the operation's declared input",
	"verb-unsupported": "Atlassian supports auth check only; run connectors auth check atlassian --select tenant=<value>",
	"operation-unknown": `Use one Atlassian operation: ${OPERATIONS.join(", ")}`,
};
const WRITE_PHASE_REPAIR = "An Atlassian write needs --preview first, then --apply <previewId> with the identical --input";
const READ_PHASE_REPAIR = "An Atlassian read takes neither --preview nor --apply; run it without them";
const RECOVER_REPAIR = "Receipts, adjudication, and unlock are recover commands: run connectors recover atlassian --select tenant=<value> [--run <runId>]";

function refused(kind: RefusalKind, connectorCause: string, repair: string = REPAIR[kind]): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}

// What one dispatcher invocation was asked to do, and so which outcomes it
// may end with. journal: receipts or one receipt, read from the journal only.
type Station = "read" | "preview" | "apply" | "journal" | "adjudicate" | "unlock";

const RECORDED: Partial<Readonly<Record<Station, RecordedEffect>>> = { preview: "write-preview", adjudicate: "write-adjudication", unlock: "write-unlock" };

// Dispatcher causes that end a request with nothing recorded or sent, by the
// core refusal or failure they become. A journal refusal cannot end a read.
const DOMAIN_REFUSALS: ReadonlySet<CauseCode> = new Set(["refused-credential-unconfigured", "refused-precondition", "site-unresolved", "refused-auth"]);
const JOURNAL_REFUSALS: ReadonlySet<CauseCode> = new Set(["refused-preview", "refused-write-blocked", "refused-state", "refused-evidence"]);
const READ_FAILURES: ReadonlySet<CauseCode> = new Set(["failed-transport", "capability-unavailable", "not-found", "failed-unknown"]);

function adapterDefect(what: string): never {
	throw new Error(`an Atlassian ${what}`);
}

// A refusal or failure that changed nothing. Its fixed repair text is the
// dispatcher's, never caller input; usage and schema refusals use this
// adapter's own text because the dispatcher's reason may name caller keys.
function unchanged(result: Envelope["result"], station: Station): Executed {
	const { causeCode, repairAction } = result;
	if (result.transactionState !== "unchanged") adapterDefect("refusal reported a state change");
	if (repairAction === null) adapterDefect("refusal carried no repair");
	if (causeCode === "usage-invalid" || causeCode === "input-invalid") {
		const kind = causeCode === "usage-invalid" ? "usage" : "schema";
		return { kind: "refused", refusal: { kind, connectorCause: causeCode, repair: REPAIR[kind] } };
	}
	if (DOMAIN_REFUSALS.has(causeCode) || (station !== "read" && JOURNAL_REFUSALS.has(causeCode))) return { kind: "refused", refusal: { kind: "domain", connectorCause: causeCode, repair: repairAction } };
	if (READ_FAILURES.has(causeCode)) return { kind: "failed", connectorCause: causeCode, repair: repairAction };
	return adapterDefect(`${station} ended with an unmapped cause`);
}

const receiptRunId = (data: unknown): string | null => {
	const runId = typeof data === "object" && data !== null ? (data as { runId?: unknown }).runId : undefined;
	return typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId) ? runId : null;
};

// An apply either never reached its receipt (a refusal or read failure that
// changed nothing), or recorded one: completed, unknown, or unchanged after
// the receipt. The receipt's runId is what recover needs.
function applied(result: Envelope["result"], data: Record<string, unknown>): Executed {
	const runId = receiptRunId(result.data);
	if (result.causeCode === "success" && result.transactionState === "completed" && runId) return { kind: "applied", data };
	if (result.causeCode === "outcome-unknown" && result.transactionState === "unknown" && runId) {
		return { kind: "effect-unknown", data, repair: `Do not retry the write. Run connectors recover atlassian --select tenant=<value> --run ${runId} to inspect it, then settle it with --adjudicate --input and the identical input` };
	}
	if (result.transactionState === "unchanged" && runId && result.repairAction !== null) return { kind: "failed-after-record", connectorCause: result.causeCode, data, repair: result.repairAction };
	return unchanged(result, "apply");
}

// An unlock that found no lock removed nothing, so it records no write.
const removedLock = (data: unknown): boolean => typeof data === "object" && data !== null && (data as { unlocked?: unknown }).unlocked === true;

// The dispatcher's envelope is never forwarded: its result and provenance
// become adapter data, and its closed cause and fixed repair text map to one
// executed outcome for the station. Anything outside this table is a defect.
function translate(envelope: Envelope, station: Station, label: Record<string, string>): Executed {
	const { result } = envelope;
	const data = { ...label, result: result.data ?? null, provenance: result.provenance };
	if (station === "apply") return applied(result, data);
	if (result.causeCode !== "success") return unchanged(result, station);
	const effect = station === "unlock" && !removedLock(result.data) ? undefined : RECORDED[station];
	if (effect) return { kind: "recorded", effect, data };
	if (result.transactionState !== "unchanged") adapterDefect(`${station} reported a state change`);
	return { kind: "success", data };
}

function executePlan(request: SchemaRequest, argv: string[], station: Station, label: Record<string, string>): Prepared {
	return {
		kind: "execute",
		async execute(capabilities: ExecutionCapabilities): Promise<Executed> {
			const envelope = await run(argv, (slug) => productionDependencies(slug, request.env, { skillsRoot: request.skillsRoot, capabilities }));
			return translate(envelope, station, label);
		},
	};
}

const inputArgs = (input: Readonly<Record<string, unknown>> | null): string[] => (input === null ? [] : ["--input", JSON.stringify(input)]);

function prepareRun(request: AdapterRequest, tenant: string, operation: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	if ((COMMANDS as readonly string[]).includes(operation)) return refused("usage", "recover-command", RECOVER_REPAIR);
	const spec = specFor(operation);
	if (!spec) return refused("operation-unknown", "operation-unknown");
	if (spec.kind === "write") return refused("usage", "write-phase-required", WRITE_PHASE_REPAIR);
	const argv = ["--tenant", tenant, operation, ...inputArgs(input)];
	const parsed = parseArgv(argv);
	if (!parsed.ok) return refused(parsed.cause === "usage-invalid" ? "usage" : "schema", parsed.cause);
	if (!readInput(spec.id, parsed.value.input).ok) return refused("schema", "input-invalid");
	return executePlan(request, argv, "read", { operation });
}

function prepareWrite(request: WriteRequest): Prepared {
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return refused("usage", "tenant-required");
	const spec = specFor(request.operation);
	if (!spec) return refused("operation-unknown", "operation-unknown");
	if (spec.kind !== "write") return refused("usage", "read-takes-no-phase", READ_PHASE_REPAIR);
	const phase = request.phase.kind === "preview" ? ["--preview"] : ["--apply", request.phase.previewId];
	const argv = ["--tenant", tenant, request.operation, ...inputArgs(request.input), ...phase];
	const parsed = parseArgv(argv);
	if (!parsed.ok) return refused(parsed.cause === "usage-invalid" ? "usage" : "schema", parsed.cause);
	if (!writeInput(spec.id as WriteOperation, parsed.value.input).ok) return refused("schema", "input-invalid");
	return executePlan(request, argv, request.phase.kind, { operation: request.operation });
}

const RECOVERY_STATION: Readonly<Record<Recovery["kind"], Station>> = { inspect: "journal", adjudicate: "adjudicate", unlock: "unlock" };

function recoveryCommand(runId: string, recovery: Recovery): string[] {
	switch (recovery.kind) {
		case "inspect":
			return ["receipt", "--run", runId];
		case "adjudicate":
			return ["adjudicate", "--run", runId, ...inputArgs(recovery.input)];
		case "unlock":
			return ["unlock", "--run", runId];
	}
}

// Without a runId only the open-receipt listing exists.
function prepareRecover(request: RecoverRequest): Prepared {
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return refused("usage", "tenant-required");
	const { runId, recovery } = request;
	if (runId === null && recovery.kind !== "inspect") return refused("usage", "run-required");
	const command = runId === null ? ["receipts"] : recoveryCommand(runId, recovery);
	const argv = ["--tenant", tenant, ...command];
	const parsed = parseArgv(argv);
	if (!parsed.ok) return refused(parsed.cause === "usage-invalid" ? "usage" : "schema", parsed.cause);
	return executePlan(request, argv, RECOVERY_STATION[recovery.kind], { command: command[0] ?? "receipts" });
}

// The core accepts any role name; this narrows the adapter's own calls to
// the roles it registers.
const roleCommand = (capabilities: ExecutionCapabilities, role: AtlassianInternalRole): readonly string[] => capabilities.internalCommand(role);

// A custody check binds both products through the custody role. It proves the
// items and the service token are in custody; it never starts MCPorter or a
// Provider, so it never claims authentication.
function prepareAuthCheck(request: AdapterRequest, tenant: string): Prepared {
	return {
		kind: "execute",
		async execute(capabilities: ExecutionCapabilities): Promise<Executed> {
			const bindings: Record<string, string>[] = [];
			for (const product of PRODUCTS) {
				const bound = bindCredential(tenant, product, request.env, roleCommand(capabilities, "custody-child"));
				if (!bound.ok) return { kind: "refused", refusal: { kind: "domain", connectorCause: bound.cause, repair: bound.detail } };
				bindings.push({ product, ...bound.binding });
			}
			return { kind: "success", data: { custodyChecked: true, bindings } };
		},
	};
}

function prepareAtlassian(request: AdapterRequest): Prepared {
	const { action } = request;
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return refused("usage", "tenant-required");
	if (action.kind === "auth") return action.verb === "check" ? prepareAuthCheck(request, tenant) : refused("verb-unsupported", "auth-verb-unsupported");
	return prepareRun(request, tenant, action.operation, action.input);
}

const INTERNAL_ROLES: Readonly<Record<AtlassianInternalRole, InternalRole>> = {
	"custody-child": { run: (argv) => runCustodyChild(argv) },
	provider: { run: (argv) => runProvider(argv) },
};

export const atlassianAdapter: Adapter = {
	id: ATLASSIAN_ADAPTER_ID,
	prepare: prepareAtlassian,
	prepareWrite,
	prepareRecover,
	internalRoles: INTERNAL_ROLES,
};
