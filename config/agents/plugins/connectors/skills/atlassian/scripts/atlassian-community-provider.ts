#!/usr/bin/env bun
// Community mcp-atlassian Provider, one product per route. Re-reads the
// selected product's bound item (username, credential, and site_url) inside
// this process through 1Password custody, and execs the pinned package through
// the plugin-owned uv with only that product's environment triplet, started in
// the tenant's private outbox so the package can read staged uploads and
// nothing else. The credential enters only this process and its replacement.
import { ownedDirectory } from "../../../bin/private-state.ts";
import { type BoundItem, boundItem, type Product, providerInvocation, selectedUv } from "./custody/index.ts";
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
	const item = boundItem(invocation);
	const uv = selectedUv(process.env);
	if (uv === null) fail("uv-unavailable", "the plugin-owned uv is not set up; run connectors setup");
	if (item.credential === undefined) fail("community-fields-missing", `${invocation.itemTitle} needs username, credential, and a site_url field`);
	if (!singleLine(item.credential)) fail("credential-invalid", `${invocation.itemTitle} has malformed fields`);
	return { invocation, item, credential: item.credential, uv };
}

function main(argv: string[]): never {
	const preflight = argv.length === 1 && argv[0] === "--preflight";
	if (!preflight) refuseArguments(argv);
	// This full-item read and comparison happens before uv is located or started.
	const ready = prerequisites();
	const outbox = outboxDirectory(ready.invocation.tenant, process.env);
	if (!ownedDirectory(outbox).ok) fail("outbox-unavailable", "the tenant's private upload outbox could not be prepared");
	if (preflight) process.exit(0);
	process.chdir(outbox);
	const environment = { ...cleanEnvironment(), ...productEnvironment(ready.invocation.product, ready.item, ready.credential) };
	replaceProcess(ready.uv, ["uv", "tool", "run", "--system-certs", "--no-env-file", "--from", PACKAGE_PIN, "mcp-atlassian"], environment);
}

main(process.argv.slice(2));
