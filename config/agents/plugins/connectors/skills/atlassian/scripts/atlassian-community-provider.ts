#!/usr/bin/env bun
// Community mcp-atlassian Provider, one product per route. Reads the selected
// product's item (username, credential, and preferred site_url) through the
// credential helper inside this process, accepts a strictly validated legacy
// url only when site_url is absent, and execs the pinned package with only
// that product's environment triplet.
import {
	cleanEnvironment,
	executableOnPath,
	fail,
	type Product,
	productFromEnvironment,
	productItemTitle,
	readItemFields,
	refuseArguments,
	replaceProcess,
	singleLine,
	SITE_URL_FIELD,
	siteOrigins,
	tenantFromEnvironment,
} from "./atlassian-provider-common.ts";

const PACKAGE_PIN = "mcp-atlassian==0.23.1";

function productEnvironment(product: Product, username: string, credential: string, siteUrl: string): Record<string, string> {
	const origins = siteOrigins(siteUrl);
	if (product === "jira") return { JIRA_URL: origins.jira, JIRA_USERNAME: username, JIRA_API_TOKEN: credential };
	return { CONFLUENCE_URL: origins.confluence, CONFLUENCE_USERNAME: username, CONFLUENCE_API_TOKEN: credential };
}

function main(argv: string[]): never {
	refuseArguments(argv);
	const tenant = tenantFromEnvironment();
	const product = productFromEnvironment();
	const itemTitle = productItemTitle(product, tenant);
	const uvx = executableOnPath("uvx");
	const fields = readItemFields(itemTitle);
	const username = fields.get("username");
	const credential = fields.get("credential");
	const siteUrl = fields.get(SITE_URL_FIELD) ?? fields.get("url");
	if (!username || !credential || !siteUrl) {
		fail("community-fields-missing", `${itemTitle} needs username, credential, and a ${SITE_URL_FIELD} or compatible url field`);
	}
	if (!singleLine(username) || !singleLine(credential)) fail("credential-invalid", `${itemTitle} has malformed fields`);
	const environment = { ...cleanEnvironment(), ...productEnvironment(product, username, credential, siteUrl) };
	replaceProcess(uvx, ["uvx", "--system-certs", "--no-env-file", "--from", PACKAGE_PIN, "mcp-atlassian"], environment);
}

main(process.argv.slice(2));
