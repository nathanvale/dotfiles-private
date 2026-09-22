#!/usr/bin/env bun
// Credential custody for the semantic dispatcher. This child is the only
// dispatcher-adjacent process allowed to read a complete 1Password item. Its
// stdout is a deliberately small nonsecret envelope.
import { CREDENTIAL_VAULT, credentialWrapperPath, credentialWrapperPresent, itemInvocationContext, PRODUCTS, productItemTitle, TENANT_PATTERN, type Product } from "./atlassian-provider-common.ts";
import { safeEnvironment } from "../../../bin/safe-environment.ts";

function fail(cause: "arguments-invalid" | "credential-wrapper-missing" | "credential-unavailable" | "credential-invalid" | "credential-revision-unavailable", repair?: string): never {
	process.stderr.write(`atlassian-credential-binding:error:${cause}${repair ? `:${repair}` : ""}\n`);
	process.exit(3);
}

function argumentValue(name: "--tenant" | "--product", argv: string[]): string | undefined {
	const position = argv.indexOf(name);
	if (position === -1 || argv.filter((value) => value === name).length !== 1) return undefined;
	const value = argv[position + 1];
	return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function parseInvocation(argv: string[]): { tenant: string; product: Product } {
	if (argv.length !== 4) fail("arguments-invalid");
	const tenant = argumentValue("--tenant", argv);
	const product = argumentValue("--product", argv);
	if (!tenant || !TENANT_PATTERN.test(tenant) || product === undefined || !(PRODUCTS as readonly string[]).includes(product)) fail("arguments-invalid");
	return { tenant, product: product as Product };
}

const invocation = parseInvocation(process.argv.slice(2));
const home = process.env.HOME;
if (!home) fail("credential-unavailable");
const wrapper = credentialWrapperPath(home);
if (!credentialWrapperPresent(wrapper)) fail("credential-wrapper-missing", "restore the dotfiles 1Password wrapper");
const read = Bun.spawnSync([wrapper, "op", "item", "get", productItemTitle(invocation.product, invocation.tenant), "--vault", CREDENTIAL_VAULT, "--format", "json"], {
	env: safeEnvironment(process.env),
	stdin: "ignore",
	stdout: "pipe",
	stderr: "pipe",
});
if (read.exitCode !== 0) fail("credential-unavailable");
let item: unknown;
try {
	item = JSON.parse(read.stdout.toString());
} catch {
	fail("credential-invalid");
}
const resolved = itemInvocationContext(item);
if (!resolved) fail("credential-revision-unavailable");
process.stdout.write(`${JSON.stringify(resolved)}\n`);
