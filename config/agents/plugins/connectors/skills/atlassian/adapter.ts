// Atlassian's packaged adapter for the generic `connectors auth configure`,
// `auth status`, `auth check`, `run`, and `recover` commands (Ticket #92 under
// Spec #87). Every prepare step validates the request into the dispatcher's
// typed Invocation, so a bad request refuses before any dependency,
// credential, or Provider capability. Every command that can read
// custody (run, auth check, and recover --adjudicate) then passes the tenant
// registration gate (D2a): an absent or invalid registration refuses before
// any Keychain, 1Password, MCPorter, or Provider start, and a valid one's item
// IDs are the only ones the invocation binds. execute dispatches the validated invocation in this process
// with the front door's MCPorter selection and its own internal-role command,
// so credential custody happens only in the internal custody and Provider
// roles below. Writes go through the dispatcher's durable preview and apply
// journal; recover reaches its receipts, adjudicate, and unlock commands.
import type { Adapter, AdapterRefusal, AdapterRequest, CustodyResolution, Executed, ExecutionCapabilities, InternalRole, Prepared, RecordedEffect, Recovery, RecoverRequest, SchemaRequest, WriteRequest } from "../../bin/adapters/contract.ts";
import { runProvider } from "./scripts/atlassian-community-provider.ts";
import { runRestProvider } from "./scripts/atlassian-rest-provider.ts";
import { type Dispatched, dispatch, type Invalid, type Invocation, invocationFor, type Request, type Validated } from "./scripts/atlassian-dispatch.ts";
import { ATLASSIAN_ADAPTER_ID, type AtlassianInternalRole, bindCredential, CONFIGURE_INPUT_REPAIR, configureInput, configureTenant, CREDENTIAL_VAULT, ITEM_ID_REPAIR, PRODUCTS, type RegisteredItems, registeredTenant, runCustodyChild } from "./scripts/custody/index.ts";
import { type CauseCode, COMMANDS, OPERATIONS } from "./scripts/dispatch/contract.ts";
import { specFor } from "./scripts/dispatch/engine.ts";
import type { Outcome } from "./scripts/dispatch/flows.ts";
import { productionDependencies } from "./scripts/dispatch/runtime.ts";

type RefusalKind = Extract<AdapterRefusal["kind"], "usage" | "schema" | "verb-unsupported" | "operation-unknown">;

const REPAIR: Readonly<Record<RefusalKind, string>> = {
	usage: "Check the connectors run or recover arguments against connectors --help",
	schema: "Correct the --input object to the operation's declared input",
	"verb-unsupported": "Atlassian supports auth configure, status, and check; run connectors auth status atlassian --select tenant=<value>",
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

// The registration gate. It reads only the registration, so its refusal
// comes before any Keychain, 1Password, MCPorter, or Provider start.
function gate(request: SchemaRequest, tenant: string): { ok: true; items: RegisteredItems } | { ok: false; prepared: Prepared } {
	const registered = registeredTenant(tenant, request.env);
	return registered.ok ? registered : { ok: false, prepared: { kind: "refused", refusal: { kind: "domain", connectorCause: registered.cause, repair: registered.repair } } };
}

// Dispatcher causes that end a request with nothing recorded or sent, by the
// core refusal or failure they become. A journal refusal cannot end a read.
const DOMAIN_REFUSALS: ReadonlySet<CauseCode> = new Set(["refused-credential-unconfigured", "refused-precondition", "site-unresolved", "refused-auth"]);
const JOURNAL_REFUSALS: ReadonlySet<CauseCode> = new Set(["refused-preview", "refused-write-blocked", "refused-state", "refused-evidence"]);
const READ_FAILURES: ReadonlySet<CauseCode> = new Set(["failed-transport", "capability-unavailable", "not-found", "failed-unknown"]);

function adapterDefect(what: string): never {
	throw new Error(`an Atlassian ${what}`);
}

// A refusal or failure that changed nothing. Its fixed repair text is the
// dispatcher's, never caller input; a schema refusal uses this adapter's own
// text because the dispatcher's reason may name caller keys.
function unchanged({ cause, detail, transactionState }: Outcome, station: Station): Executed {
	if (transactionState !== "unchanged") adapterDefect("refusal reported a state change");
	if (detail === null) adapterDefect("refusal carried no repair");
	if (cause === "input-invalid") return { kind: "refused", refusal: { kind: "schema", connectorCause: cause, repair: REPAIR.schema } };
	if (DOMAIN_REFUSALS.has(cause) || (station !== "read" && JOURNAL_REFUSALS.has(cause))) return { kind: "refused", refusal: { kind: "domain", connectorCause: cause, repair: detail } };
	if (READ_FAILURES.has(cause)) return { kind: "failed", connectorCause: cause, repair: detail };
	return adapterDefect(`${station} ended with an unmapped cause`);
}

const receiptRunId = (data: unknown): string | null => {
	const runId = typeof data === "object" && data !== null ? (data as { runId?: unknown }).runId : undefined;
	return typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId) ? runId : null;
};

// An apply either never reached its receipt (a refusal or read failure that
// changed nothing), or recorded one: completed, unknown, or unchanged after
// the receipt. The receipt's runId is what recover needs.
function applied(outcome: Outcome, data: Record<string, unknown>): Executed {
	const runId = receiptRunId(outcome.data);
	if (outcome.cause === "success" && outcome.transactionState === "completed" && runId) return { kind: "applied", data };
	if (outcome.cause === "outcome-unknown" && outcome.transactionState === "unknown" && runId) {
		return { kind: "effect-unknown", data, repair: `Do not retry the write. Run connectors recover atlassian --select tenant=<value> --run ${runId} to inspect it, then settle it with --adjudicate --input and the identical input` };
	}
	if (outcome.transactionState === "unchanged" && runId && outcome.detail !== null) return { kind: "failed-after-record", connectorCause: outcome.cause, data, repair: outcome.detail };
	return unchanged(outcome, "apply");
}

// An unlock that found no lock removed nothing, so it records no write.
const removedLock = (data: unknown): boolean => typeof data === "object" && data !== null && (data as { unlocked?: unknown }).unlocked === true;

// The dispatcher's outcome becomes adapter data with its provenance, and its
// closed cause and fixed repair text map to one executed outcome for the
// station. Anything outside this table is a defect.
function translate({ outcome, provenance }: Dispatched, station: Station, label: Record<string, string>): Executed {
	const data = { ...label, result: outcome.data ?? null, provenance };
	if (station === "apply") return applied(outcome, data);
	if (outcome.cause !== "success") return unchanged(outcome, station);
	const effect = station === "unlock" && !removedLock(outcome.data) ? undefined : RECORDED[station];
	if (effect) return { kind: "recorded", effect, data };
	if (outcome.transactionState !== "unchanged") adapterDefect(`${station} reported a state change`);
	return { kind: "success", data };
}

// items: the gated registration's item IDs, or null for a journal-only
// command that never binds a credential.
function executePlan(request: SchemaRequest, invocation: Invocation, station: Station, label: Record<string, string>, items: RegisteredItems | null): Prepared {
	return {
		kind: "execute",
		async execute(capabilities: ExecutionCapabilities): Promise<Executed> {
			const dependencies = productionDependencies(invocation.tenant, request.env, items === null ? null : { items }, { skillsRoot: request.skillsRoot, capabilities });
			return translate(await dispatch(invocation, dependencies), station, label);
		},
	};
}

// Validation refuses before any capability: a malformed tenant or identifier
// is a usage refusal, an input the operation's contract rejects a schema one.
const invalid = (cause: Invalid): Prepared => (cause === "usage-invalid" ? refused("usage", cause) : refused("schema", cause));

// Absent input is the empty object, which each operation's contract judges.
const inputOf = (input: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> => input ?? {};

// A credentialed invocation: validated, then past the registration gate, and
// only then planned, so each refusal precedes every capability.
function planGated(request: SchemaRequest, validated: Validated, station: Station, label: Record<string, string>): Prepared {
	if (!validated.ok) return invalid(validated.cause);
	const registered = gate(request, validated.invocation.tenant);
	return registered.ok ? executePlan(request, validated.invocation, station, label, registered.items) : registered.prepared;
}

function prepareRun(request: AdapterRequest, tenant: string, operation: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	if ((COMMANDS as readonly string[]).includes(operation)) return refused("usage", "recover-command", RECOVER_REPAIR);
	const spec = specFor(operation);
	if (!spec) return refused("operation-unknown", "operation-unknown");
	if (spec.kind === "write") return refused("usage", "write-phase-required", WRITE_PHASE_REPAIR);
	return planGated(request, invocationFor({ tenant, kind: "read", spec, input: inputOf(input) }), "read", { operation });
}

function prepareWrite(request: WriteRequest): Prepared {
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return refused("usage", "tenant-required");
	const spec = specFor(request.operation);
	if (!spec) return refused("operation-unknown", "operation-unknown");
	if (spec.kind !== "write") return refused("usage", "read-takes-no-phase", READ_PHASE_REPAIR);
	const { phase } = request;
	const input = inputOf(request.input);
	const validated = invocationFor(phase.kind === "preview" ? { tenant, kind: "preview", spec, input } : { tenant, kind: "apply", spec, input, previewId: phase.previewId });
	return planGated(request, validated, phase.kind, { operation: request.operation });
}

const RECOVERY_STATION: Readonly<Record<Recovery["kind"], Station>> = { inspect: "journal", adjudicate: "adjudicate", unlock: "unlock" };

function recoveryRequest(tenant: string, runId: string, recovery: Recovery): Request {
	switch (recovery.kind) {
		case "inspect":
			return { tenant, kind: "receipt", runId };
		case "adjudicate":
			return { tenant, kind: "adjudicate", runId, input: inputOf(recovery.input) };
		case "unlock":
			return { tenant, kind: "unlock", runId };
	}
}

// Without a runId only the open-receipt listing exists. Only adjudication
// reads custody, so only it passes the registration gate: inspection and
// unlock touch the journal alone, which a re-point needs while unregistered.
function prepareRecover(request: RecoverRequest): Prepared {
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return refused("usage", "tenant-required");
	const { runId, recovery } = request;
	if (runId === null && recovery.kind !== "inspect") return refused("usage", "run-required");
	const validated = invocationFor(runId === null ? { tenant, kind: "receipts" } : recoveryRequest(tenant, runId, recovery));
	if (!validated.ok) return invalid(validated.cause);
	const label = { command: validated.invocation.kind };
	if (recovery.kind !== "adjudicate") return executePlan(request, validated.invocation, RECOVERY_STATION[recovery.kind], label, null);
	return planGated(request, validated, "adjudicate", label);
}

// A custody check binds both products' registered items through the custody
// role. It proves the items and the service token are in custody; it never
// starts MCPorter or a Provider, so it never claims authentication.
function prepareAuthCheck(request: AdapterRequest, tenant: string): Prepared {
	const registered = gate(request, tenant);
	if (!registered.ok) return registered.prepared;
	const { items } = registered;
	return {
		kind: "execute",
		async execute(capabilities: ExecutionCapabilities): Promise<Executed> {
			const bindings: Record<string, string>[] = [];
			for (const product of PRODUCTS) {
				const bound = bindCredential(tenant, product, items[product], request.env, capabilities.internalCommand("custody-child" satisfies AtlassianInternalRole));
				if (!bound.ok) return { kind: "refused", refusal: { kind: "domain", connectorCause: bound.cause, repair: bound.detail } };
				bindings.push({ product, ...bound.binding });
			}
			return { kind: "success", data: { custodyChecked: true, bindings } };
		},
	};
}

const nextCheck = (tenant: string): string => `connectors auth check atlassian --select tenant=${tenant}`;

// Configure records the two item IDs as stored configuration: no stdin,
// Keychain, 1Password, MCPorter, or Provider. The input is checked here,
// before anything is written; publication happens at execute.
function prepareConfigure(request: AdapterRequest, tenant: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	const parsed = configureInput(input);
	if (!parsed.ok) return parsed.cause === "input-invalid" ? refused("schema", "input-invalid", CONFIGURE_INPUT_REPAIR) : refused("schema", "item-reference-invalid", ITEM_ID_REPAIR);
	const { items } = parsed;
	return {
		kind: "execute",
		async execute(): Promise<Executed> {
			const configured = configureTenant(tenant, items, request.env);
			if (configured.kind === "refused") return { kind: "refused", refusal: { kind: "domain", connectorCause: configured.cause, repair: configured.repair } };
			const data = { tenant, vault: CREDENTIAL_VAULT, items: { jira: items.jira, confluence: items.confluence }, nextStep: nextCheck(tenant) };
			return configured.kind === "published" ? { kind: "recorded", effect: "custody-registration", data } : { kind: "success", data };
		},
	};
}

// Status inspects the registration only; it never reads Keychain or 1Password.
function prepareStatus(request: AdapterRequest, tenant: string): Prepared {
	const registered = registeredTenant(tenant, request.env);
	if (registered.ok) return { kind: "inspected", data: { tenant, registration: "registered", vault: CREDENTIAL_VAULT, items: { jira: registered.items.jira, confluence: registered.items.confluence }, nextStep: nextCheck(tenant) } };
	if (registered.cause === "registration-invalid") return { kind: "refused", refusal: { kind: "domain", connectorCause: registered.cause, repair: registered.repair } };
	return { kind: "inspected", data: { tenant, registration: "absent", nextStep: registered.repair } };
}

function prepareAuth(request: AdapterRequest, tenant: string, verb: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	switch (verb) {
		case "configure":
			return prepareConfigure(request, tenant, input);
		case "status":
			return prepareStatus(request, tenant);
		case "check":
			return prepareAuthCheck(request, tenant);
		default:
			return refused("verb-unsupported", "auth-verb-unsupported");
	}
}

function prepareAtlassian(request: AdapterRequest): Prepared {
	const { action } = request;
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return refused("usage", "tenant-required");
	if (action.kind === "auth") return prepareAuth(request, tenant, action.verb, action.input);
	return prepareRun(request, tenant, action.operation, action.input);
}

// The tenant's 1Password custody becomes effective only through its Tenant
// Registration; the registration is read, never the items it names.
function resolveCustody(request: SchemaRequest): CustodyResolution {
	const tenant = request.selectors.tenant;
	if (tenant === undefined) return { kind: "refused", refusal: { kind: "usage", connectorCause: "tenant-required", repair: REPAIR.usage } };
	const subject = { selector: "tenant", value: tenant, source: "invocation-selector" } as const;
	const registered = registeredTenant(tenant, request.env);
	if (registered.ok) return { kind: "resolved", effective: { mode: "1password-below-mcporter", source: "plugin-state:registration" }, notYetEffective: null, subject };
	if (registered.cause === "registration-invalid") return { kind: "refused", refusal: { kind: "domain", connectorCause: registered.cause, repair: registered.repair } };
	return { kind: "resolved", effective: null, notYetEffective: { mode: "1password-below-mcporter", source: "plugin-state:registration-absent" }, subject };
}

const INTERNAL_ROLES: Readonly<Record<AtlassianInternalRole, InternalRole>> = {
	"custody-child": { run: (argv) => runCustodyChild(argv) },
	provider: { run: (argv) => runProvider(argv) },
	"rest-provider": { run: (argv) => runRestProvider(argv) },
};

export const atlassianAdapter: Adapter = {
	id: ATLASSIAN_ADAPTER_ID,
	prepare: prepareAtlassian,
	prepareWrite,
	prepareRecover,
	resolveCustody,
	internalRoles: INTERNAL_ROLES,
};
