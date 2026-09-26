// An account-key connector's registration: the nonsecret record, made by
// `auth configure`, of which 1Password item ID holds that connector's API
// key. It lives at <stateRoot>/connectors/<id>/registration.json, exact 0600
// in the owned 0700 connector directory, as the one literal registrationText
// renders. Its presence alone selects account mode. Nothing here reads
// Keychain or 1Password or resolves an item name, and a registration never
// changes in place; an identical configure changes nothing.
import path from "node:path";
import { CREDENTIAL_VAULT } from "../one-password-custody.ts";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot } from "../private-state.ts";
import type { EnvironmentSource } from "../safe-environment.ts";

// A 1Password item ID: 26 lowercase letters and digits. An allowlist, so an
// item name, op:// reference, URL, or key shape never passes, and a value
// that does is safe to store, pass in a context, and print.
export const isItemId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{26}$/.test(value);

export const itemIdRepair = (id: string): string =>
	`auth configure ${id} needs --input '{"item":"<id>"}' with exactly that key: the 26-character 1Password item ID from the ${CREDENTIAL_VAULT} vault, copied yourself outside Connectors; Connectors never resolves an item name`;

const configureCommand = (id: string): string => `connectors auth configure ${id} --input '{"item":"<id>"}'`;
const repointRepair = (id: string, label: string): string =>
	`remove registration.json from the ${label} Connectors state directory by hand, then run ${configureCommand(id)} again; with no registration ${label} returns to keyless mode`;

const directory = (id: string, env: EnvironmentSource): string => path.join(stateRoot(env), "connectors", id);
const registrationFile = (id: string, env: EnvironmentSource): string => path.join(directory(id, env), "registration.json");
const registrationText = (item: string): string => `${JSON.stringify({ schemaVersion: 1, vault: CREDENTIAL_VAULT, item })}\n`;

export type Configured = { kind: "published" | "unchanged" } | { kind: "refused"; cause: "registration-exists" | "registration-invalid" | "registration-unavailable"; repair: string };

export function configureAccount(id: string, label: string, item: string, env: EnvironmentSource): Configured {
	const unavailable = `the ${label} private Connectors state directory could not be prepared; check that it is an owned, non-symlink directory`;
	const text = registrationText(item);
	if (!ownedDirectory(directory(id, env)).ok) return { kind: "refused", cause: "registration-unavailable", repair: unavailable };
	const published = publishPrivateFileOnce(registrationFile(id, env), text);
	if (!published.ok) {
		if (published.reason === "write-failed") return { kind: "refused", cause: "registration-unavailable", repair: unavailable };
		return { kind: "refused", cause: "registration-invalid", repair: `the ${label} registration.json is not the exact private file auth configure writes; ${repointRepair(id, label)}` };
	}
	if (published.published) return { kind: "published" };
	if (published.existing === text) return { kind: "unchanged" };
	return { kind: "refused", cause: "registration-exists", repair: `${label} is already registered with a different item ID, and a registration never changes in place; to re-point it, ${repointRepair(id, label)}` };
}

// keyless: no registration, so the connector keeps its keyless route.
// account: a valid registration names the item.
// invalid: a registration exists but is not the exact file configure
// writes; every command refuses rather than guess a mode.
export type Mode = { kind: "keyless" } | { kind: "account"; item: string } | { kind: "invalid"; repair: string };

// Every run, schema, and custody command resolves the mode first, before any
// Keychain, 1Password, MCPorter, or Provider start. Contents are never echoed.
export function accountMode(id: string, label: string, env: EnvironmentSource): Mode {
	const read = readPrivateFile(registrationFile(id, env));
	const invalid: Mode = { kind: "invalid", repair: `the ${label} registration.json is not the exact private file auth configure writes; ${repointRepair(id, label)}` };
	if (!read.ok) return read.reason === "absent" ? { kind: "keyless" } : invalid;
	let item: unknown;
	try {
		item = (JSON.parse(read.text) as { item?: unknown } | null)?.item;
	} catch {
		return invalid;
	}
	return isItemId(item) && read.text === registrationText(item) ? { kind: "account", item } : invalid;
}
