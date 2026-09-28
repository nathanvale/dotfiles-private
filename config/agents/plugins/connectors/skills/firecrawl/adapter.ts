// Firecrawl's packaged adapter: the shared account-key shape (bin/account-key)
// bound to this Skill's fixed endpoint and Keychain leaf. Keyless until
// `connectors auth configure firecrawl` records a 1Password item ID; then the key
// is read only by this adapter's Provider role (Ticket #137, Spec #87 AC26).
import { accountKeyAdapter } from "../../bin/account-key/index.ts";
import { ACCOUNT_ENDPOINT } from "./scripts/endpoint.ts";
import { readKeychain } from "./scripts/keychain-read.ts";

export const firecrawlAdapter = accountKeyAdapter({ id: "firecrawl", label: "Firecrawl", endpoint: ACCOUNT_ENDPOINT, readKeychain });
