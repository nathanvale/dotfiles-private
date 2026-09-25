// Packaged connector adapter contract (Spec #87 AC19, AC20, AC23). An adapter
// is admitted only by id through the fixed registry in ./index.ts: there is no
// user-supplied executable adapter path in v1.
//
// attemptAuth is the T2 fixture-auth seam: it may spawn an independent fixture
// authority after checking a nonsecret reference, and proves only fixture
// dispatch, never real custody.
//
// prepare is the generic auth and run seam. The core has already validated the
// manifest and selectors; the adapter answers with no dependency acquired yet:
// a refusal, an inspection result, or a MCPorter transport plan. The core then
// selects the verified MCPorter, calls commit() for the adapter's own state
// preparation, runs the plan, and after a read or attended login asks settle()
// what the child changed in adapter-owned state. An adapter never selects
// MCPorter, and its refusal text never echoes caller input. prepare stays
// pure: it refuses a bad action, selector, operation, or input before any
// dependency, credential, or Provider capability.
//
// An execute plan is for a connector whose semantics span several calls. Its
// execute step may start only the binary selectMcporter() returns, only with a
// planDispatcherRoute plan from bin/provider-route.ts, and reaches credential
// custody only through the adapter's own internal roles, so the front-door
// process never holds a credential value.
//
// prepareSchema is the optional live-schema seam for a connector that needs
// an adapter to reach its transport. It answers like prepare, and a transport
// plan must be a read: the core never runs attended login for schema. An
// adapter without it keeps credentialed schema unsupported.
import type { ConnectorManifest } from "../manifest.ts";
import type { EnvironmentSource } from "../safe-environment.ts";

export interface AuthAttempt {
	readonly outcome: "success" | "refused";
	readonly cause?: string;
	readonly detail?: string;
}

// The closed login options the core admits, only after `auth login`, in this
// fixed order; every other verb carries none. An adapter maps each to its own
// transport flag and never sees an unknown option.
export type LoginOption = "no-browser" | "reset";

export type AdapterAction =
	| { readonly kind: "auth"; readonly verb: string; readonly loginOptions: readonly LoginOption[] }
	| { readonly kind: "run"; readonly operation: string; readonly input: Readonly<Record<string, unknown>> | null };

export interface AdapterRequest {
	readonly action: AdapterAction;
	readonly manifest: ConnectorManifest;
	readonly selectors: Readonly<Record<string, string>>;
	// The physical packaged skills directory; a compiled adapter's own
	// import.meta.dir points into the virtual bundle instead.
	readonly skillsRoot: string;
	readonly env: EnvironmentSource;
}

export type SchemaRequest = Omit<AdapterRequest, "action">;

// Each kind maps to one core cause row; connectorCause is the adapter's own
// closed code and is reported beside it.
export type AdapterRefusalKind = "usage" | "domain" | "schema" | "verb-unsupported" | "operation-unknown" | "client-mode-not-admitted";

export interface AdapterRefusal {
	readonly kind: AdapterRefusalKind;
	readonly connectorCause: string;
	readonly repair: string;
}

// read: an ordinary MCPorter call whose stdout is the result.
// attended-login: MCPorter's own browser consent, run only on the user's
// terminal; the core refuses it without one.
export type TransportEffect = "read" | "attended-login";

// Local effects on connector-owned state, reported in the envelope's effect
// inventory. account-vault: commit created the account's private vault
// directories, or narrowed an existing one to owner-only.
// mcporter-vault-file: MCPorter wrote its vault file, which may hold a grant
// or only its index; the adapter observes metadata and never reads it.
export type LocalEffect = "account-vault" | "mcporter-vault-file";

// completed names each local effect commit caused, including beside a refusal.
export interface Committed {
	readonly refusal: AdapterRefusal | null;
	readonly completed: readonly LocalEffect[];
}

export interface ExecutionCapabilities {
	// The core's verified plugin-owned MCPorter, selected on the first call
	// only. null means selection failed; the core renders that failure itself.
	selectMcporter(): Promise<string | null>;
	// The compiled self in one of this adapter's internal roles. The core
	// checks no role name here; the adapter narrows its own calls to the
	// roles it registers, and an unregistered one is refused at the gate.
	internalCommand(role: string): readonly string[];
}

// failed: a read that did not complete, with no external effect.
export type Executed =
	| { readonly kind: "success"; readonly data: Record<string, unknown> }
	| { readonly kind: "refused"; readonly refusal: AdapterRefusal }
	| { readonly kind: "failed"; readonly connectorCause: string; readonly repair: string };

export type Prepared =
	| { readonly kind: "refused"; readonly refusal: AdapterRefusal }
	| { readonly kind: "execute"; execute(capabilities: ExecutionCapabilities): Promise<Executed> }
	| { readonly kind: "inspected"; readonly data: Record<string, unknown> }
	| {
		readonly kind: "transport";
		readonly effect: TransportEffect;
		readonly argv: readonly string[];
		readonly env: Readonly<Record<string, string>>;
		readonly data: Record<string, unknown>;
		commit(): Committed;
		settle(): readonly LocalEffect[];
	};

// A process the compiled front door becomes, reached only as
// `__internal <adapter> <role>` with a valid internal invocation context. It
// speaks its own line or MCP stdio protocol, then exits or replaces itself,
// and never emits a Contract Core envelope.
export interface InternalRole {
	run(argv: readonly string[]): void | Promise<void>;
}

export interface Adapter {
	readonly id: string;
	readonly internalRoles?: Readonly<Record<string, InternalRole>>;
	attemptAuth?(manifest: ConnectorManifest): Promise<AuthAttempt>;
	prepare?(request: AdapterRequest): Prepared;
	prepareSchema?(request: SchemaRequest): Prepared;
}
