#!/usr/bin/env bun
// Community mcp-atlassian Provider, one product per route. Reads the selected
// product's item (username, credential, and site_url) through the credential
// helper inside this process, and execs the pinned package with only that
// product's environment triplet.
import {
	cleanEnvironment,
	executableOnPath,
	fail,
	type Product,
	readBoundItem,
	refuseArguments,
	replaceProcess,
	singleLine,
	SITE_URL_FIELD,
	siteOrigins,
	selectedProviderInvocation,
} from "./atlassian-provider-common.ts";

const PACKAGE_PIN = "mcp-atlassian==0.23.1";

function productEnvironment(product: Product, username: string, credential: string, siteUrl: string): Record<string, string> {
	const origins = siteOrigins(siteUrl);
	if (product === "jira") return { JIRA_URL: origins.jira, JIRA_USERNAME: username, JIRA_API_TOKEN: credential };
	return { CONFLUENCE_URL: origins.confluence, CONFLUENCE_USERNAME: username, CONFLUENCE_API_TOKEN: credential };
}

function main(argv: string[]): never {
	refuseArguments(argv);
	const { product, itemTitle, context } = selectedProviderInvocation();
	// This full-item read and comparison happens before uvx is probed or spawned.
	const fields = readBoundItem(itemTitle, context);
	const uvx = executableOnPath("uvx");
	const username = fields.get("username");
	const credential = fields.get("credential");
	const siteUrl = fields.get(SITE_URL_FIELD);
	if (!username || !credential || !siteUrl) {
		fail("community-fields-missing", `${itemTitle} needs username, credential, and a ${SITE_URL_FIELD} field`);
	}
	if (!singleLine(username) || !singleLine(credential)) fail("credential-invalid", `${itemTitle} has malformed fields`);
	const environment = { ...cleanEnvironment(), ...productEnvironment(product, username, credential, siteUrl) };
	replaceProcess(uvx, ["uvx", "--system-certs", "--no-env-file", "--from", PACKAGE_PIN, "mcp-atlassian"], environment);
}

main(process.argv.slice(2));
