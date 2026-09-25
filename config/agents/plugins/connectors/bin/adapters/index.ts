// The one packaged adapter registry (Spec #87 AC20, AC23). Adding a genuinely
// new authentication mechanism means adding a packaged adapter module and
// registering it here; bin/connectors.ts only ever looks an adapter up by the
// id a Connector Manifest declares, so it never changes for a new
// registration. No arbitrary user-supplied executable adapter is admitted:
// this map is the complete, closed set. A connector's own adapter lives beside
// its Skill under skills/<id>/adapter.ts.
import { atlassianAdapter } from "../../skills/atlassian/adapter.ts";
import { canvaAdapter } from "../../skills/canva/adapter.ts";
import type { Adapter } from "./contract.ts";
import { challengeAuthAdapter } from "./challenge-auth.ts";
import { testAuthAdapter } from "./test-auth.ts";

export const ADAPTERS: Readonly<Record<string, Adapter>> = {
	[atlassianAdapter.id]: atlassianAdapter,
	[canvaAdapter.id]: canvaAdapter,
	[challengeAuthAdapter.id]: challengeAuthAdapter,
	[testAuthAdapter.id]: testAuthAdapter,
};

export const ADAPTER_IDS: ReadonlySet<string> = new Set(Object.keys(ADAPTERS));
