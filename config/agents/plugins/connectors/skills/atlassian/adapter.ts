// Atlassian's packaged adapter for the generic `connectors auth check` and
// `run` commands (Ticket #92 under Spec #87). prepare validates the action with
// the dispatcher's own pure parser and read-input contract, so a bad request
// refuses before any dependency, credential, or Provider capability. execute
// runs the unchanged dispatcher in this process with the front door's
// MCPorter selection and its own internal-role command, so credential custody
// happens only in the internal custody and Provider roles below. Reads only:
// writes and the operator commands stay on the dispatcher's own entry until
// their stations exist.
import type { Adapter, AdapterRefusal, AdapterRequest, Executed, ExecutionCapabilities, InternalRole, Prepared } from "../../bin/adapters/contract.ts";
import { runProvider } from "./scripts/atlassian-community-provider.ts";
import { parseArgv, run } from "./scripts/atlassian-dispatch.ts";
import { ATLASSIAN_ADAPTER_ID, type AtlassianInternalRole, bindCredential, PRODUCTS, runCustodyChild } from "./scripts/custody/index.ts";
import { type CauseCode, COMMANDS, type Envelope } from "./scripts/dispatch/contract.ts";
import { readInput, specFor } from "./scripts/dispatch/engine.ts";
import { productionDependencies } from "./scripts/dispatch/runtime.ts";

type RefusalKind = Extract<AdapterRefusal["kind"], "usage" | "schema" | "verb-unsupported" | "operation-unknown">;

const REPAIR: Readonly<Record<RefusalKind, string>> = {
	usage: "Check the connectors run arguments against connectors --help",
	schema: "Correct the --input object to the operation's declared read input",
	"verb-unsupported": "Atlassian supports auth check only; run connectors auth check atlassian --select tenant=<value>",
	"operation-unknown": "Use one Atlassian read operation: issue.get, issue.search, issue.transitions, page.get, or page.search",
};
// Not yet a run station: writes need preview and apply, and the operator
// commands need recovery.
const WRITE_PHASE_REPAIR = "Atlassian writes and receipt commands are not reachable through connectors run yet; use a read operation";

function refused(kind: RefusalKind, connectorCause: string, repair: string = REPAIR[kind]): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}

// Dispatcher causes a read may end with, by the core refusal or failure they
// become. Anything else from a read is an adapter defect.
const DOMAIN_REFUSALS: ReadonlySet<CauseCode> = new Set(["refused-credential-unconfigured", "refused-precondition", "site-unresolved", "refused-auth"]);
const READ_FAILURES: ReadonlySet<CauseCode> = new Set(["failed-transport", "capability-unavailable", "not-found", "failed-unknown"]);

// The dispatcher's envelope is never forwarded: its result and provenance
// become adapter data, and its closed cause and fixed repair text map to one
// executed outcome.
function executedRead(envelope: Envelope, operation: string): Executed {
	const { causeCode, transactionState, repairAction } = envelope.result;
	if (transactionState !== "unchanged") throw new Error("an Atlassian read reported a state change");
	if (causeCode === "success") return { kind: "success", data: { operation, result: envelope.result.data ?? null, provenance: envelope.result.provenance } };
	if (repairAction === null) throw new Error("an Atlassian refusal carried no repair");
	if (causeCode === "usage-invalid" || causeCode === "input-invalid") {
		const kind = causeCode === "usage-invalid" ? "usage" : "schema";
		return { kind: "refused", refusal: { kind, connectorCause: causeCode, repair: REPAIR[kind] } };
	}
	if (DOMAIN_REFUSALS.has(causeCode)) return { kind: "refused", refusal: { kind: "domain", connectorCause: causeCode, repair: repairAction } };
	if (READ_FAILURES.has(causeCode)) return { kind: "failed", connectorCause: causeCode, repair: repairAction };
	throw new Error("an Atlassian read ended with a write cause");
}

function prepareRun(request: AdapterRequest, tenant: string, operation: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	const spec = specFor(operation);
	if ((COMMANDS as readonly string[]).includes(operation) || spec?.kind === "write") return refused("usage", "write-phase-unavailable", WRITE_PHASE_REPAIR);
	if (!spec) return refused("operation-unknown", "operation-unknown");
	const argv = ["--tenant", tenant, operation, ...(input === null ? [] : ["--input", JSON.stringify(input)])];
	const parsed = parseArgv(argv);
	if (!parsed.ok) return refused(parsed.cause === "usage-invalid" ? "usage" : "schema", parsed.cause);
	if (!readInput(spec.id, parsed.value.input).ok) return refused("schema", "input-invalid");
	return {
		kind: "execute",
		async execute(capabilities: ExecutionCapabilities): Promise<Executed> {
			const envelope = await run(argv, (slug) => productionDependencies(slug, request.env, { skillsRoot: request.skillsRoot, capabilities }));
			return executedRead(envelope, operation);
		},
	};
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
	internalRoles: INTERNAL_ROLES,
};
