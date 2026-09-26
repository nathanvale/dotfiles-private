// Mermaid's binding of the shared 1Password custody mode
// (bin/one-password-custody.ts), as Atlassian proved it: the item read
// through this skill's own Keychain leaf, then its one credential field. The
// credential returns to the caller process and nowhere else. Nothing here
// creates, rotates, imports, prints, or logs a token.
import { CREDENTIAL_VAULT, type OnePasswordFailure, readOnePasswordItem } from "../../../../bin/one-password-custody.ts";
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { readKeychain } from "./keychain-read.ts";

export { CREDENTIAL_VAULT, OP_SETUP_REPAIR, SERVICE_TOKEN_HANDOFF } from "../../../../bin/one-password-custody.ts";

export type CustodyFailure = OnePasswordFailure;

export const itemHandoff = (itemId: string): string =>
	`create the Mermaid API token in your Mermaid account settings and store it yourself in the credential field of the 1Password item with ID ${itemId}, the ID auth configure recorded, in the ${CREDENTIAL_VAULT} vault; Connectors never creates, rotates, or imports a token`;

// The one credential field of the item op returned, only when the item is
// the one requested: its top-level id equals itemId, and exactly one field
// labelled credential holds a single-line value.
function credentialOf(item: unknown, itemId: string): string | null {
	if (typeof item !== "object" || item === null || (item as { id?: unknown }).id !== itemId) return null;
	const fields = (item as { fields?: unknown }).fields;
	if (!Array.isArray(fields)) return null;
	const values = fields.filter((field) => typeof field === "object" && field !== null && String((field as { label?: unknown }).label ?? "").toLowerCase() === "credential").map((field) => (field as { value?: unknown }).value);
	const [value] = values;
	return values.length === 1 && typeof value === "string" && value !== "" && !/[\r\n]/.test(value) ? value : null;
}

export function readCredential(itemId: string, env: EnvironmentSource): { ok: true; credential: string } | { ok: false; cause: CustodyFailure } {
	const read = readOnePasswordItem(itemId, env, readKeychain);
	if (!read.ok) return read;
	const credential = credentialOf(read.item, itemId);
	return credential === null ? { ok: false, cause: "credential-invalid" } : { ok: true, credential };
}
