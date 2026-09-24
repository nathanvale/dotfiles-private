// Packaged authentication adapter contract (T2, Ticket #89 under Spec #87,
// Spec AC23). An adapter is admitted only by id through the fixed registry
// in ./index.ts: there is no user-supplied executable adapter path in v1.
// attemptAuth may spawn an independent fixture authority process after
// checking that its manifest reference has the adapter's nonsecret item
// reference syntax. It never reads or transmits a credential value. The
// authority's verdict proves only the fixture auth-shaped dispatch through
// the compiled CLI, never T5's real 1Password custody.
import type { ConnectorManifest } from "../manifest.ts";

export interface AuthAttempt {
	readonly outcome: "success" | "refused";
	readonly cause?: string;
	readonly detail?: string;
}

export interface Adapter {
	readonly id: string;
	attemptAuth(manifest: ConnectorManifest): Promise<AuthAttempt>;
}
