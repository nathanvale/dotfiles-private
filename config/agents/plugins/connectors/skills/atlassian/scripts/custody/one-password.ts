// Atlassian's binding of the shared 1Password custody mode
// (bin/one-password-custody.ts): the item read through this skill's own
// Keychain leaf, and the Atlassian item handoff. The item returned stays in
// the caller process.
import { CREDENTIAL_VAULT, type OnePasswordRead, readOnePasswordItem as readItem } from "../../../../bin/one-password-custody.ts";
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { readKeychain } from "./keychain-read.ts";

export { CREDENTIAL_VAULT, type OnePasswordFailure, OP_SETUP_REPAIR, SERVICE_TOKEN_ACCOUNT, SERVICE_TOKEN_HANDOFF, SERVICE_TOKEN_SERVICE } from "../../../../bin/one-password-custody.ts";

export const itemHandoff = (itemId: string): string =>
	`create the Atlassian API token in your Atlassian account settings and store it yourself in the 1Password item with ID ${itemId}, the ID auth configure recorded, in the ${CREDENTIAL_VAULT} vault; Connectors never creates, rotates, or imports a token`;

export const readAtlassianItem = (itemId: string, env: EnvironmentSource): OnePasswordRead => readItem(itemId, env, readKeychain);
