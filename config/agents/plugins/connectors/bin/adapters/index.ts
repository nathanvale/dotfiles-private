// The one packaged adapter registry (T2, Ticket #89 under Spec #87). Adding
// a genuinely new authentication mechanism means adding a module beside this
// one and registering it here; bin/connectors.ts only ever looks an adapter
// up by the id a Connector Manifest declares, so it never changes for a new
// registration. No arbitrary user-supplied executable adapter is admitted:
// this map is the complete, closed set.
import type { Adapter } from "./contract.ts";
import { testAuthAdapter } from "./test-auth.ts";

export const ADAPTERS: Readonly<Record<string, Adapter>> = {
	[testAuthAdapter.id]: testAuthAdapter,
};

export const ADAPTER_IDS: ReadonlySet<string> = new Set(Object.keys(ADAPTERS));
