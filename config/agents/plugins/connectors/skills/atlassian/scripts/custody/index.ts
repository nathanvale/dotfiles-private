// Atlassian credential custody. This is the only import path into the module.
//
// The dispatcher calls bindCredential once per tenant and product; a custody
// child reads the complete item and returns a nonsecret CredentialBinding
// (principal, item revision, Trusted Site Origin). The binding crosses the
// route on an internal channel. A Provider process recovers its invocation
// from that channel, re-reads the exact item immediately before any child
// executable can start, and refuses when the item no longer matches the
// binding. Secret values never leave boundItem's caller process.
import path from "node:path";
import { type EnvironmentSource, INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment } from "../../../../bin/safe-environment.ts";
import { atlassianProcess } from "../provider-process.ts";
import { type CredentialBinding, encodeBinding, parseBinding } from "./channel.ts";
import { CREDENTIAL_VAULT, credentialHelperPath, credentialHelperPresent, isProduct, itemBinding, itemFieldMap, type Product, productItemTitle, readItem, SITE_URL_FIELD, TENANT_PATTERN } from "./item.ts";

export { PRODUCTS, type Product, TENANT_PATTERN } from "./item.ts";
export type { CredentialBinding } from "./channel.ts";

const CHILD = path.resolve(import.meta.dir, "child.ts");
const CHILD_FAILURE = /^atlassian-credential-binding:error:([a-z-]+)(?::[^\n]*)?$/m;
const TENANT_ENV = "ATLASSIAN_TENANT";
const PRODUCT_ENV = "ATLASSIAN_PRODUCT";

export type BindResult = { ok: true; binding: CredentialBinding } | { ok: false; cause: "site-unresolved" | "refused-precondition"; detail: string };

// The dispatcher's only credential access. The child inspects the complete
// item; this process sees one JSON line or a closed cause.
export function bindCredential(tenant: string, product: Product, env: EnvironmentSource): BindResult {
	const read = Bun.spawnSync([process.execPath, CHILD, "--tenant", tenant, "--product", product], { env: safeEnvironment(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (read.exitCode !== 0) {
		const code = CHILD_FAILURE.exec(read.stderr.toString())?.[1];
		if (code === "site-url-invalid") return { ok: false, cause: "site-unresolved", detail: "the tenant's credential item must expose a valid site_url field" };
		return { ok: false, cause: "refused-precondition", detail: "credential custody could not produce a stable context" };
	}
	const binding = parseBinding(read.stdout.toString());
	return binding ? { ok: true, binding } : { ok: false, cause: "refused-precondition", detail: "credential custody returned an invalid context" };
}

// The single-line channel value the route carries for one binding.
export const bindingChannel = (binding: CredentialBinding): string => encodeBinding(binding);

export interface ProviderInvocation {
	tenant: string;
	product: Product;
	itemTitle: string;
	binding: CredentialBinding;
}

// A Provider's startup selection: tenant and product from the route, the
// binding from the internal channel. An injected relaunch also names the pair
// it was launched for, which must equal the selected pair before the channel
// is even read.
export function providerInvocation(env: EnvironmentSource = process.env, injected?: { tenant: string; product: string }): ProviderInvocation {
	const tenant = env[TENANT_ENV] ?? "";
	if (!TENANT_PATTERN.test(tenant)) atlassianProcess.fail("tenant-invalid", "expected a lowercase tenant slug", 2);
	const product = env[PRODUCT_ENV] ?? "";
	if (!isProduct(product)) atlassianProcess.fail("product-invalid", "expected ATLASSIAN_PRODUCT to be jira or confluence", 2);
	if (injected && (injected.tenant !== tenant || injected.product !== product)) atlassianProcess.fail("injection-mismatch", "the injected pair does not match the selected tenant and product", 2);
	const binding = parseBinding(env[INTERNAL_INVOCATION_CONTEXT_ENV]);
	if (!binding) atlassianProcess.fail("credential-context-invalid", "restart through the semantic dispatcher");
	return { tenant, product, itemTitle: productItemTitle(product, tenant), binding };
}

export interface BoundItem {
	principal: string;
	origin: string;
	credential: string | undefined;
}

// The exact item, re-read immediately before a downstream executable starts.
// A rotated item or changed site is a precondition failure, never a retry or
// a provider fallback. The credential value stays inside the calling process.
export function boundItem(invocation: ProviderInvocation, env: EnvironmentSource = process.env): BoundItem {
	const { itemTitle, binding } = invocation;
	const read = readItem(itemTitle, env);
	if (!read.ok) {
		if (read.cause === "credential-wrapper-missing") atlassianProcess.fail(read.cause, "restore the dotfiles 1Password wrapper");
		if (read.cause === "credential-unavailable") atlassianProcess.fail(read.cause, `cannot read ${itemTitle}; run with-one-password-token check`);
		atlassianProcess.fail(read.cause, `${itemTitle} returned invalid JSON`);
	}
	const actual = itemBinding(read.item);
	if ("cause" in actual) atlassianProcess.fail("credential-invalid", `${itemTitle} needs a valid version, username, and ${SITE_URL_FIELD}`);
	const fresh = actual.binding;
	if (fresh.principal !== binding.principal || fresh.itemVersion !== binding.itemVersion || fresh.origin !== binding.origin) {
		atlassianProcess.fail("credential-context-stale", "credential item changed; restart the semantic operation");
	}
	return { principal: fresh.principal, origin: fresh.origin, credential: itemFieldMap(read.item)?.get("credential") };
}

// The credential helper the Official Provider execs for injection, present
// and executable, or a fixed refusal.
export function credentialHelper(env: EnvironmentSource = process.env): string {
	const helper = credentialHelperPath(env.HOME);
	if (!credentialHelperPresent(helper)) atlassianProcess.fail("credential-wrapper-missing", "restore the dotfiles 1Password wrapper");
	return helper;
}

// The op:// reference for the item's secret field.
export const credentialReference = (invocation: ProviderInvocation): string => `op://${CREDENTIAL_VAULT}/${invocation.itemTitle}/credential`;

// The three variables an injected relaunch must re-supply so its phase two
// recovers the same invocation.
export function invocationEnvironment(invocation: Pick<ProviderInvocation, "tenant" | "product" | "binding">): Record<string, string> {
	return { [TENANT_ENV]: invocation.tenant, [PRODUCT_ENV]: invocation.product, [INTERNAL_INVOCATION_CONTEXT_ENV]: encodeBinding(invocation.binding) };
}
