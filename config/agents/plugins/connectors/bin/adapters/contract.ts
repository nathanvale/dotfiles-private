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
// preparation, runs the plan, and after a read asks settle() what the child
// changed in adapter-owned state. An adapter never reads a credential value,
// never spawns MCPorter itself, and its refusal text never echoes caller input.
import type { ConnectorManifest } from "../manifest.ts";
import type { EnvironmentSource } from "../safe-environment.ts";

export interface AuthAttempt {
	readonly outcome: "success" | "refused";
	readonly cause?: string;
	readonly detail?: string;
}

export type AdapterAction =
	| { readonly kind: "auth"; readonly verb: string }
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

export type Prepared =
	| { readonly kind: "refused"; readonly refusal: AdapterRefusal }
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

export interface Adapter {
	readonly id: string;
	attemptAuth?(manifest: ConnectorManifest): Promise<AuthAttempt>;
	prepare?(request: AdapterRequest): Prepared;
}
