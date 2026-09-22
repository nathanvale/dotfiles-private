#!/usr/bin/env bun
// The custody child. This is the only dispatcher-adjacent process allowed to
// read a complete 1Password item; its stdout is one nonsecret binding line and
// its stderr codes are internal to the custody module.
import { encodeBinding } from "./channel.ts";
import { type BindingFailure, isProduct, type ItemReadFailure, itemBinding, type Product, productItemTitle, readItem, TENANT_PATTERN } from "./item.ts";

function fail(cause: "arguments-invalid" | ItemReadFailure | BindingFailure, repair?: string): never {
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
	if (!tenant || !TENANT_PATTERN.test(tenant) || product === undefined || !isProduct(product)) fail("arguments-invalid");
	return { tenant, product };
}

const invocation = parseInvocation(process.argv.slice(2));
if (!process.env.HOME) fail("credential-unavailable");
const read = readItem(productItemTitle(invocation.product, invocation.tenant), process.env);
if (!read.ok) fail(read.cause, read.cause === "credential-wrapper-missing" ? "restore the dotfiles 1Password wrapper" : undefined);
const resolved = itemBinding(read.item);
if ("cause" in resolved) fail(resolved.cause);
process.stdout.write(`${encodeBinding(resolved.binding)}\n`);
