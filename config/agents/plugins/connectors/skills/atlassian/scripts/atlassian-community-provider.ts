// Community mcp-atlassian Provider, one product per route, run only as the
// Atlassian adapter's internal Provider role of the compiled front door. Re-reads the
// selected product's bound item (username, credential, and site_url) inside
// this process through 1Password custody, and execs the pinned package through
// the plugin-owned uv with only that product's environment triplet, started in
// the tenant's private outbox so the package can read staged uploads and
// nothing else. The credential enters only this process and its replacement.
import { ownedDirectory } from "../../../bin/private-state.ts";
import { type BoundItem, boundItem, type Product, providerInvocation, selectedUv, UV_SETUP_REPAIR } from "./custody/index.ts";
import { outboxDirectory } from "./outbox.ts";
import { atlassianProcess, type ProviderProcess, singleLine } from "./provider-process.ts";

const { cleanEnvironment, refuseArguments } = atlassianProcess;
const fail: ProviderProcess["fail"] = atlassianProcess.fail;
const replaceProcess: ProviderProcess["replaceProcess"] = atlassianProcess.replaceProcess;
const PACKAGE_PIN = "mcp-atlassian==0.23.1";

function productEnvironment(product: Product, item: BoundItem, credential: string): Record<string, string> {
	if (product === "jira") return { JIRA_URL: item.origin, JIRA_USERNAME: item.principal, JIRA_API_TOKEN: credential };
	return { CONFLUENCE_URL: `${item.origin}/wiki`, CONFLUENCE_USERNAME: item.principal, CONFLUENCE_API_TOKEN: credential };
}

function prerequisites(): { invocation: ReturnType<typeof providerInvocation>; item: BoundItem; credential: string; uv: string } {
	const invocation = providerInvocation();
	// uv is verified before the item read, so a missing or changed uv never
	// costs a credential read; the same verified path is the one exec'd.
	const uv = selectedUv(process.env);
	if (uv === null) fail("uv-unavailable", UV_SETUP_REPAIR);
	const item = boundItem(invocation);
	if (item.credential === undefined) fail("community-fields-missing", `${invocation.itemTitle} needs username, credential, and a site_url field`);
	if (!singleLine(item.credential)) fail("credential-invalid", `${invocation.itemTitle} has malformed fields`);
	return { invocation, item, credential: item.credential, uv };
}

// MCPorter starts this role with no arguments; the dispatcher's readiness
// probe starts it with --preflight alone.
export function runProvider(argv: readonly string[]): never {
	const preflight = argv.length === 1 && argv[0] === "--preflight";
	if (!preflight) refuseArguments([...argv]);
	// uv is verified, then the full item is read and compared, before uv starts.
	const ready = prerequisites();
	const outbox = outboxDirectory(ready.invocation.tenant, process.env);
	if (!ownedDirectory(outbox).ok) fail("outbox-unavailable", "the tenant's private upload outbox could not be prepared");
	if (preflight) process.exit(0);
	process.chdir(outbox);
	const environment = { ...cleanEnvironment(), ...productEnvironment(ready.invocation.product, ready.item, ready.credential) };
	replaceProcess(ready.uv, ["uv", "tool", "run", "--system-certs", "--no-env-file", "--from", PACKAGE_PIN, "mcp-atlassian"], environment);
}
