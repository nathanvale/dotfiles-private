// The custody child. This is the only dispatcher-adjacent process allowed to
// read a complete 1Password item; its stdout is one nonsecret binding line and
// its stderr codes are internal to the custody module. It runs only as the
// Atlassian adapter's internal custody role of the compiled front door, takes
// no arguments, and reads its tenant and product from the internal invocation
// context the custody module sets.
import { type EnvironmentSource, INTERNAL_INVOCATION_CONTEXT_ENV } from "../../../../bin/safe-environment.ts";
import { encodeBinding } from "./channel.ts";
import { type BindingFailure, isProduct, itemBinding, type Product, productItemTitle, TENANT_PATTERN } from "./item.ts";
import { type OnePasswordFailure, readOnePasswordItem } from "./one-password.ts";

function fail(cause: "arguments-invalid" | OnePasswordFailure | BindingFailure): never {
	process.stderr.write(`atlassian-credential-binding:error:${cause}\n`);
	process.exit(3);
}

// The one context shape: exactly {"tenant","product"} in this order.
export function custodyContext(tenant: string, product: Product): string {
	return JSON.stringify({ tenant, product });
}

function parseInvocation(argv: readonly string[], env: EnvironmentSource): { tenant: string; product: Product } {
	if (argv.length !== 0) fail("arguments-invalid");
	let parsed: unknown;
	try {
		parsed = JSON.parse(env[INTERNAL_INVOCATION_CONTEXT_ENV] ?? "");
	} catch {
		fail("arguments-invalid");
	}
	const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	const tenant = record?.tenant;
	const product = record?.product;
	if (!record || Object.keys(record).join(",") !== "tenant,product" || typeof tenant !== "string" || !TENANT_PATTERN.test(tenant) || typeof product !== "string" || !isProduct(product)) fail("arguments-invalid");
	return { tenant, product };
}

export function runCustodyChild(argv: readonly string[], env: EnvironmentSource = process.env): void {
	const invocation = parseInvocation(argv, env);
	if (!env.HOME) fail("credential-unavailable");
	const read = readOnePasswordItem(productItemTitle(invocation.product, invocation.tenant), env);
	if (!read.ok) fail(read.cause);
	const resolved = itemBinding(read.item);
	if ("cause" in resolved) fail(resolved.cause);
	process.stdout.write(`${encodeBinding(resolved.binding)}\n`);
}
