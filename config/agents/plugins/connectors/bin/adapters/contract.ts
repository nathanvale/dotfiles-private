// Packaged authentication adapter contract (T2, Ticket #89 under Spec #87,
// contributes to Spec AC23). An adapter is admitted only by id through the
// fixed registry in ./index.ts: there is no user-supplied executable adapter
// path in v1. inspectLocal is local-only (no network, no process spawn),
// matching doctor's own "no network, refresh, directory creation, or cache
// population" rule in cli-proposal.md.
import type { ConnectorManifest } from "../manifest.ts";

export interface AdapterInspection {
	readonly ready: boolean;
	readonly cause?: string;
	readonly detail?: string;
}

export interface Adapter {
	readonly id: string;
	inspectLocal(manifest: ConnectorManifest): AdapterInspection;
}
