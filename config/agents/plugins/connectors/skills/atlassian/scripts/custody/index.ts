// Atlassian credential custody. This is the only import path into the module.
//
// The tenant registration (registration.ts) records which 1Password item ID
// holds each product's credential; the packaged adapter validates it before
// any custody read. The dispatcher calls bindCredential once per tenant and
// product with that configured ID; a custody child reads exactly that item and
// returns a nonsecret CredentialBinding (principal, item revision, Trusted
// Site Origin, and the item ID). The binding crosses the route on an internal
// channel. A Provider process recovers its invocation from that channel,
// re-reads the exact item by the ID in the binding immediately before any
// child executable can start, and refuses when the item no longer matches the
// binding. Both reads refuse an item whose returned id is not the one
// requested. Secret values never leave boundItem's caller process. The child and
// the Provider start only as internal roles of the compiled front door. The Provider
// cannot start without the plugin-owned uv, so a missing or changed uv
// refuses before any credential is read.
import path from "node:path";
import { type EnvironmentSource, INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment } from "../../../../bin/safe-environment.ts";
import { atlassianProcess } from "../provider-process.ts";
import { type CredentialBinding, encodeBinding, parseBinding } from "./channel.ts";
import { custodyContext } from "./child.ts";
import { isItemId, isProduct, itemBinding, itemFieldMap, type Product, SITE_URL_FIELD, TENANT_PATTERN } from "./item.ts";
import { itemHandoff, OP_SETUP_REPAIR, readOnePasswordItem, SERVICE_TOKEN_HANDOFF } from "./one-password.ts";
import { selectedUv, UV_SETUP_REPAIR } from "./plugin-tools.ts";

export { runCustodyChild } from "./child.ts";
export { PRODUCTS, type Product, TENANT_PATTERN } from "./item.ts";
export { selectedUv, UV_SETUP_REPAIR } from "./plugin-tools.ts";
export { CREDENTIAL_VAULT } from "./one-password.ts";
export { CONFIGURE_INPUT_REPAIR, configureInput, configureTenant, ITEM_ID_REPAIR, type RegisteredItems, registeredTenant } from "./registration.ts";
export type { CredentialBinding } from "./channel.ts";

const CHILD_FAILURE = /^atlassian-credential-binding:error:([a-z-]+)(?::[^\n]*)?$/m;
const TENANT_ENV = "ATLASSIAN_TENANT";
const PRODUCT_ENV = "ATLASSIAN_PRODUCT";

export type BindResult = { ok: true; binding: CredentialBinding } | { ok: false; cause: "site-unresolved" | "refused-precondition" | "refused-credential-unconfigured"; detail: string };
type BindFailure = Extract<BindResult, { ok: false }>;

// Closed child codes to fixed public outcomes. An absent service token or
// item is a handoff to its owner, never a prompt to supply a value here.
function childFailure(code: string | undefined, itemId: string): BindFailure {
	switch (code) {
		case "site-url-invalid":
			return { ok: false, cause: "site-unresolved", detail: "the tenant's credential item must expose a valid site_url field" };
		case "service-token-missing":
			return { ok: false, cause: "refused-credential-unconfigured", detail: SERVICE_TOKEN_HANDOFF };
		case "item-missing":
			return { ok: false, cause: "refused-credential-unconfigured", detail: itemHandoff(itemId) };
		case "op-unavailable":
			return { ok: false, cause: "refused-precondition", detail: OP_SETUP_REPAIR };
		default:
			return { ok: false, cause: "refused-precondition", detail: "credential custody could not produce a stable context" };
	}
}

// The one owner of the Atlassian internal-role vocabulary: the adapter id
// and the role names the packaged adapter registers. The registry's
// mcporter.json restates the provider role as a literal, pinned by a test.
export const ATLASSIAN_ADAPTER_ID = "atlassian";
export type AtlassianInternalRole = "custody-child" | "provider";

// The plugin's compiled front door in one Atlassian internal role, reached
// from source through this module's own location. The packaged front door
// passes its own command instead, because its module location is virtual.
export function sourceInternalCommand(role: AtlassianInternalRole): readonly string[] {
	return [path.resolve(import.meta.dir, "..", "..", "..", "..", "bin", "connectors"), "__internal", ATLASSIAN_ADAPTER_ID, role];
}

// The dispatcher's only credential access, for the item ID the tenant's
// registration names for this product. The child inspects the complete item;
// this process sees one JSON line or a closed cause. A binding for any other
// item is refused.
export function bindCredential(tenant: string, product: Product, itemId: string, env: EnvironmentSource, custodyCommand: readonly string[] = sourceInternalCommand("custody-child")): BindResult {
	if (!isItemId(itemId)) throw new Error("an Atlassian binding needs a registered item ID");
	if (selectedUv(env) === null) return { ok: false, cause: "refused-precondition", detail: UV_SETUP_REPAIR };
	const read = Bun.spawnSync([...custodyCommand], { env: { ...safeEnvironment(env), [INTERNAL_INVOCATION_CONTEXT_ENV]: custodyContext(tenant, product, itemId) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (read.exitCode !== 0) return childFailure(CHILD_FAILURE.exec(read.stderr.toString())?.[1], itemId);
	const binding = parseBinding(read.stdout.toString());
	return binding && binding.item === itemId ? { ok: true, binding } : { ok: false, cause: "refused-precondition", detail: "credential custody returned an invalid context" };
}

// The single-line channel value the route carries for one binding.
export const bindingChannel = (binding: CredentialBinding): string => encodeBinding(binding);

export interface ProviderInvocation {
	tenant: string;
	product: Product;
	binding: CredentialBinding;
}

// A Provider's startup selection: tenant and product from the route, the
// binding, and so the item ID, from the internal channel.
export function providerInvocation(env: EnvironmentSource = process.env): ProviderInvocation {
	const tenant = env[TENANT_ENV] ?? "";
	if (!TENANT_PATTERN.test(tenant)) atlassianProcess.fail("tenant-invalid", "expected a lowercase tenant slug", 2);
	const product = env[PRODUCT_ENV] ?? "";
	if (!isProduct(product)) atlassianProcess.fail("product-invalid", "expected ATLASSIAN_PRODUCT to be jira or confluence", 2);
	const binding = parseBinding(env[INTERNAL_INVOCATION_CONTEXT_ENV]);
	if (!binding) atlassianProcess.fail("credential-context-invalid", "restart through the semantic dispatcher");
	return { tenant, product, binding };
}

export interface BoundItem {
	principal: string;
	origin: string;
	credential: string | undefined;
}

// The exact item, re-read by the binding's item ID immediately before a
// downstream executable starts. A rotated item, a changed site, or a returned
// item that is not the bound one is a stale context, never a retry. The
// credential value stays inside the calling process.
export function boundItem(invocation: ProviderInvocation, env: EnvironmentSource = process.env): BoundItem {
	const { binding } = invocation;
	const label = `1Password item ${binding.item}`;
	const read = readOnePasswordItem(binding.item, env);
	if (!read.ok) atlassianProcess.fail(read.cause, `${label} could not be read through 1Password custody`);
	const actual = itemBinding(read.item, binding.item);
	if ("cause" in actual && actual.cause === "item-id-mismatch") atlassianProcess.fail("credential-context-stale", "credential item changed; restart the semantic operation");
	if ("cause" in actual) atlassianProcess.fail("credential-invalid", `${label} needs a valid version, username, and ${SITE_URL_FIELD}`);
	const fresh = actual.binding;
	if (fresh.principal !== binding.principal || fresh.itemVersion !== binding.itemVersion || fresh.origin !== binding.origin || fresh.item !== binding.item) {
		atlassianProcess.fail("credential-context-stale", "credential item changed; restart the semantic operation");
	}
	return { principal: fresh.principal, origin: fresh.origin, credential: itemFieldMap(read.item)?.get("credential") };
}

// The three variables that select one Provider invocation: what the route
// registry supplies to the Provider, and what the dispatcher's readiness
// probe supplies when it runs the Provider's --preflight directly.
export function invocationEnvironment(invocation: Pick<ProviderInvocation, "tenant" | "product" | "binding">): Record<string, string> {
	return { [TENANT_ENV]: invocation.tenant, [PRODUCT_ENV]: invocation.product, [INTERNAL_INVOCATION_CONTEXT_ENV]: encodeBinding(invocation.binding) };
}
