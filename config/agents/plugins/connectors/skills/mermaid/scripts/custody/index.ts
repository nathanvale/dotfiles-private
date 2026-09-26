// Mermaid account custody. This is the only import path into the module.
//
// `auth configure` records the one 1Password item ID that holds the Mermaid
// API token. Every account command passes registeredAccount first, then
// starts the Provider role with that ID on the internal invocation channel;
// the Provider alone reads the item and holds the token.
import { INTERNAL_INVOCATION_CONTEXT_ENV, type EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { isItemId } from "./registration.ts";

export { CREDENTIAL_VAULT, itemHandoff, OP_SETUP_REPAIR, readCredential, SERVICE_TOKEN_HANDOFF } from "./one-password.ts";
export { configureAccount, isItemId, ITEM_ID_REPAIR, mermaidDirectory, registeredAccount } from "./registration.ts";

// The one channel shape: exactly {"item"} with a strict item ID.
export const accountContext = (item: string): string => JSON.stringify({ item });

export function contextItem(env: EnvironmentSource): string | null {
	try {
		const parsed = JSON.parse(env[INTERNAL_INVOCATION_CONTEXT_ENV] ?? "") as Record<string, unknown> | null;
		return parsed !== null && typeof parsed === "object" && Object.keys(parsed).join(",") === "item" && isItemId(parsed.item) ? parsed.item : null;
	} catch {
		return null;
	}
}
