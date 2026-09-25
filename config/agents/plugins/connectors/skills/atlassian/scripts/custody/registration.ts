// The Atlassian tenant registration (D2a): the nonsecret record, made by
// `auth configure`, of which 1Password item ID holds each product's
// credential for one tenant. It lives at
// <stateRoot>/connectors/atlassian/<tenant>/registration.json, exact 0600 in
// the owned 0700 tenant directory, as the one literal registrationText
// renders. Nothing here reads Keychain or 1Password, and nothing resolves an
// item name: Nathan copies each ID himself.
//
// A registration never changes in place: configure publishes it once and an
// identical configure changes nothing. Previews and receipts record no item,
// so a hand re-point is safe only once no open receipt and no live preview
// could still act through the old items (REPOINT_STEPS). No CLI command
// enforces that re-point yet.
import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot } from "../../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { isItemId, type Product } from "./item.ts";
import { CREDENTIAL_VAULT } from "./one-password.ts";

export type RegisteredItems = Readonly<Record<Product, string>>;

const CONFIGURE_KEYS = "jiraItem,confluenceItem";
const TENANT_DIRECTORY_MODE = 0o700;

// Fixed texts. None carries a caller value, and none asks for a secret.
export const ITEM_ID_REPAIR = `expected a 26-character 1Password item ID from the ${CREDENTIAL_VAULT} vault; copy each ID yourself outside Connectors, for example from op item get "<name>" --vault "${CREDENTIAL_VAULT}" --format json in your own op session, or from the item's link in the 1Password app; Connectors never resolves an item name`;
export const CONFIGURE_INPUT_REPAIR = `auth configure needs --input '{"jiraItem":"<id>","confluenceItem":"<id>"}' with exactly those two keys; ${ITEM_ID_REPAIR}`;
const CONFIGURE_COMMAND = `connectors auth configure atlassian --select tenant=<value> --input '{"jiraItem":"<id>","confluenceItem":"<id>"}'`;
const REPOINT_STEPS = `confirm connectors recover atlassian --select tenant=<value> lists no open receipt and wait 15 minutes after the tenant's last preview, so no receipt or preview made under the old items can still act; then remove registration.json from the tenant's Connectors state directory by hand and run ${CONFIGURE_COMMAND} again`;
const REGISTRATION_EXISTS_REPAIR = `the tenant is already registered with different item IDs, and a registration never changes in place; to re-point it, ${REPOINT_STEPS}`;
const UNREGISTERED_REPAIR = `register the tenant first with ${CONFIGURE_COMMAND}, giving the two 26-character 1Password item IDs from the ${CREDENTIAL_VAULT} vault`;
const REGISTRATION_INVALID_REPAIR = `the tenant's registration.json is not the exact private file auth configure writes; to replace it, ${REPOINT_STEPS}`;
const REGISTRATION_UNAVAILABLE_REPAIR = "the tenant's private Connectors state directory could not be prepared; check that it is an owned, non-symlink directory";

export type ConfigureInput = { ok: true; items: RegisteredItems } | { ok: false; cause: "input-invalid" | "item-reference-invalid" };

// The pure check of configure's --input: exactly jiraItem and confluenceItem,
// in either order, each a strict item ID. The value is never returned in a
// refusal.
export function configureInput(input: Readonly<Record<string, unknown>> | null): ConfigureInput {
	if (input === null || Object.keys(input).sort().join(",") !== CONFIGURE_KEYS.split(",").sort().join(",")) return { ok: false, cause: "input-invalid" };
	const { jiraItem, confluenceItem } = input;
	if (!isItemId(jiraItem) || !isItemId(confluenceItem)) return { ok: false, cause: "item-reference-invalid" };
	return { ok: true, items: { jira: jiraItem, confluence: confluenceItem } };
}

const tenantDirectory = (tenant: string, env: EnvironmentSource): string => path.join(stateRoot(env), "connectors", "atlassian", tenant);
const registrationFile = (tenant: string, env: EnvironmentSource): string => path.join(tenantDirectory(tenant, env), "registration.json");

// The one registration literal: these keys in this order and a trailing newline.
function registrationText(tenant: string, items: RegisteredItems): string {
	return `${JSON.stringify({ schemaVersion: 1, tenant, vault: CREDENTIAL_VAULT, items: { jira: items.jira, confluence: items.confluence } })}\n`;
}

export type Configured = { kind: "published" | "unchanged" } | { kind: "refused"; cause: "registration-exists" | "registration-invalid" | "registration-unavailable"; repair: string };

// Publish the registration once. An identical registration is unchanged; any
// other existing file is never replaced. Of two racing configures with
// different IDs, exactly one publishes.
export function configureTenant(tenant: string, items: RegisteredItems, env: EnvironmentSource): Configured {
	const text = registrationText(tenant, items);
	if (!ownedDirectory(tenantDirectory(tenant, env)).ok) return { kind: "refused", cause: "registration-unavailable", repair: REGISTRATION_UNAVAILABLE_REPAIR };
	const published = publishPrivateFileOnce(registrationFile(tenant, env), text);
	if (!published.ok) return published.reason === "write-failed" ? { kind: "refused", cause: "registration-unavailable", repair: REGISTRATION_UNAVAILABLE_REPAIR } : { kind: "refused", cause: "registration-invalid", repair: REGISTRATION_INVALID_REPAIR };
	if (published.published) return { kind: "published" };
	return published.existing === text ? { kind: "unchanged" } : { kind: "refused", cause: "registration-exists", repair: REGISTRATION_EXISTS_REPAIR };
}

export type Registered = { ok: true; items: RegisteredItems } | { ok: false; cause: "tenant-unregistered" | "registration-invalid"; repair: string };

const invalid: Registered = { ok: false, cause: "registration-invalid", repair: REGISTRATION_INVALID_REPAIR };

function ownedPrivateDirectory(directory: string): boolean {
	try {
		const metadata = lstatSync(directory);
		return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === os.userInfo().uid && (metadata.mode & 0o7777) === TENANT_DIRECTORY_MODE;
	} catch {
		return false;
	}
}

function parsedItems(text: string): RegisteredItems | null {
	try {
		const items = (JSON.parse(text) as { items?: { jira?: unknown; confluence?: unknown } } | null)?.items;
		return isItemId(items?.jira) && isItemId(items?.confluence) ? { jira: items.jira, confluence: items.confluence } : null;
	} catch {
		return null;
	}
}

// The gate every custody-reading command passes first, before any Keychain or
// 1Password read: the tenant's registration, validated exactly. Absent is
// unregistered. Anything but the exact literal configure writes for this
// tenant (key set and order, schemaVersion 1, this tenant, the credential
// vault, two strict IDs, exact 0600 in an owned 0700 directory, no symlink)
// is invalid. The file's contents are never echoed.
export function registeredTenant(tenant: string, env: EnvironmentSource): Registered {
	const read = readPrivateFile(registrationFile(tenant, env));
	if (!read.ok) return read.reason === "absent" ? { ok: false, cause: "tenant-unregistered", repair: UNREGISTERED_REPAIR } : invalid;
	if (!ownedPrivateDirectory(tenantDirectory(tenant, env))) return invalid;
	const items = parsedItems(read.text);
	return items !== null && read.text === registrationText(tenant, items) ? { ok: true, items } : invalid;
}
