// The one credential item a static-credential Provider reads, by platform.
// macOS reads the registered 1Password item through the plugin-owned op and
// the Keychain-held service-account token. The Linux pilot asks the
// operator's delivery receiver instead (bin/delivered-credential.ts), which
// answers with the same item record shape. Callers keep their own
// credential-field rules and repair text.
import { type DeliveredFailure, readDeliveredItem, usesDeliveredCredentials } from "./delivered-credential.ts";
import { type KeychainReader, type OnePasswordFailure, readOnePasswordItem } from "./one-password-custody.ts";
import type { EnvironmentSource } from "./safe-environment.ts";
import type { CustodyMode } from "./adapters/contract.ts";

export type CredentialItemFailure = OnePasswordFailure | DeliveredFailure;
export type CredentialItemRead = { ok: true; item: unknown } | { ok: false; cause: CredentialItemFailure };

export function readCredentialItem(connectorId: string, itemId: string, env: EnvironmentSource, readKeychain: KeychainReader): CredentialItemRead {
	return usesDeliveredCredentials() ? readDeliveredItem(connectorId, itemId, env) : readOnePasswordItem(itemId, env, readKeychain);
}

// The custody mode a registered account reports on this platform.
export const accountCustodyMode = (): CustodyMode => (usesDeliveredCredentials() ? "delivered-receiver-below-mcporter" : "1password-below-mcporter");
