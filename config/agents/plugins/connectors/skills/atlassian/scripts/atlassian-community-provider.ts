#!/usr/bin/env bun
// Community mcp-atlassian Provider, one product per route. Re-reads the
// selected product's bound item (username, credential, and site_url) inside
// this process, and execs the pinned package with only that product's
// environment triplet.
import { type BoundItem, boundItem, type Product, providerInvocation } from "./custody/index.ts";
import { atlassianProcess, type ProviderProcess, singleLine } from "./provider-process.ts";

const { cleanEnvironment, executableOnPath, refuseArguments } = atlassianProcess;
const fail: ProviderProcess["fail"] = atlassianProcess.fail;
const replaceProcess: ProviderProcess["replaceProcess"] = atlassianProcess.replaceProcess;
const PACKAGE_PIN = "mcp-atlassian==0.23.1";

function productEnvironment(product: Product, item: BoundItem, credential: string): Record<string, string> {
	if (product === "jira") return { JIRA_URL: item.origin, JIRA_USERNAME: item.principal, JIRA_API_TOKEN: credential };
	return { CONFLUENCE_URL: `${item.origin}/wiki`, CONFLUENCE_USERNAME: item.principal, CONFLUENCE_API_TOKEN: credential };
}

function main(argv: string[]): never {
	refuseArguments(argv);
	const invocation = providerInvocation();
	// This full-item read and comparison happens before uvx is probed or spawned.
	const item = boundItem(invocation);
	const uvx = executableOnPath("uvx");
	if (item.credential === undefined) fail("community-fields-missing", `${invocation.itemTitle} needs username, credential, and a site_url field`);
	if (!singleLine(item.credential)) fail("credential-invalid", `${invocation.itemTitle} has malformed fields`);
	const environment = { ...cleanEnvironment(), ...productEnvironment(invocation.product, item, item.credential) };
	replaceProcess(uvx, ["uvx", "--system-certs", "--no-env-file", "--from", PACKAGE_PIN, "mcp-atlassian"], environment);
}

main(process.argv.slice(2));
