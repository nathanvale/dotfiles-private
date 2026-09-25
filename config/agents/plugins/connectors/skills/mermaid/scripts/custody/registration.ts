// The Mermaid account registration: the nonsecret record, made by
// `auth configure`, of which 1Password item ID holds the Mermaid API token.
// It lives at <stateRoot>/connectors/mermaid/registration.json, exact 0600 in
// the owned 0700 Mermaid directory, as the one literal registrationText
// renders. Nothing here reads Keychain or 1Password or resolves an item name.
// A registration never changes in place; an identical configure changes
// nothing.
import path from "node:path";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot } from "../../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { CREDENTIAL_VAULT } from "./one-password.ts";

// A 1Password item ID: 26 lowercase letters and digits. An allowlist, so an
// item name, op:// reference, URL, or token shape never passes, and a value
// that does is safe to store, pass in a context, and print.
export const isItemId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{26}$/.test(value);

export const ITEM_ID_REPAIR = `auth configure needs --input '{"item":"<id>"}' with exactly that key: the 26-character 1Password item ID from the ${CREDENTIAL_VAULT} vault, copied yourself outside Connectors; Connectors never resolves an item name`;
const CONFIGURE_COMMAND = `connectors auth configure mermaid --input '{"item":"<id>"}'`;
const UNREGISTERED_REPAIR = `the Mermaid account tier needs a registration first: run ${CONFIGURE_COMMAND}`;
const REPOINT = `confirm connectors recover mermaid lists no open receipt, remove registration.json from the Mermaid Connectors state directory by hand, and run ${CONFIGURE_COMMAND} again`;
const EXISTS_REPAIR = `Mermaid is already registered with a different item ID, and a registration never changes in place; to re-point it, ${REPOINT}`;
const INVALID_REPAIR = `the Mermaid registration.json is not the exact private file auth configure writes; to replace it, ${REPOINT}`;
const UNAVAILABLE_REPAIR = "the Mermaid private Connectors state directory could not be prepared; check that it is an owned, non-symlink directory";

export const mermaidDirectory = (env: EnvironmentSource): string => path.join(stateRoot(env), "connectors", "mermaid");
const registrationFile = (env: EnvironmentSource): string => path.join(mermaidDirectory(env), "registration.json");
const registrationText = (item: string): string => `${JSON.stringify({ schemaVersion: 1, vault: CREDENTIAL_VAULT, item })}\n`;

export type Configured = { kind: "published" | "unchanged" } | { kind: "refused"; cause: "registration-exists" | "registration-invalid" | "registration-unavailable"; repair: string };

export function configureAccount(item: string, env: EnvironmentSource): Configured {
	const text = registrationText(item);
	if (!ownedDirectory(mermaidDirectory(env)).ok) return { kind: "refused", cause: "registration-unavailable", repair: UNAVAILABLE_REPAIR };
	const published = publishPrivateFileOnce(registrationFile(env), text);
	if (!published.ok) return published.reason === "write-failed" ? { kind: "refused", cause: "registration-unavailable", repair: UNAVAILABLE_REPAIR } : { kind: "refused", cause: "registration-invalid", repair: INVALID_REPAIR };
	if (published.published) return { kind: "published" };
	return published.existing === text ? { kind: "unchanged" } : { kind: "refused", cause: "registration-exists", repair: EXISTS_REPAIR };
}

export type Registered = { ok: true; item: string } | { ok: false; cause: "account-unregistered" | "registration-invalid"; repair: string };

// The gate every custody-reading command passes before any Keychain,
// 1Password, MCPorter, or Provider start. The file's contents are never echoed.
export function registeredAccount(env: EnvironmentSource): Registered {
	const read = readPrivateFile(registrationFile(env));
	if (!read.ok) return read.reason === "absent" ? { ok: false, cause: "account-unregistered", repair: UNREGISTERED_REPAIR } : { ok: false, cause: "registration-invalid", repair: INVALID_REPAIR };
	let item: unknown;
	try {
		item = (JSON.parse(read.text) as { item?: unknown } | null)?.item;
	} catch {
		item = undefined;
	}
	return isItemId(item) && read.text === registrationText(item) ? { ok: true, item } : { ok: false, cause: "registration-invalid", repair: INVALID_REPAIR };
}
