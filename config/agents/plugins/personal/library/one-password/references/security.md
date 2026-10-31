# Credential security boundary

## Verify the grant

Use the service account's identity to find its exact overview on 1Password.com.
Inspect its vault permissions, Environment access and vault-creation grant.
An authorised `op vault list` proves visible vault scope, not write or sharing
permissions. Verify the latter through the server's grant configuration and
the exact permissions supplied when creating a replacement account. Do not
modify a production item as a permission probe.

Use only `read_items` on the declared vaults for unattended agents. Leave
`write_items`, `share_items` and vault creation ungranted. Vault read-only access
does not restrict what a retrieved API key or signed-in website account can do.

Existing service-account vault grants cannot be edited. Inventory consumers
before an approved replacement, stage the new token separately, verify its
server-side grants and live reads, then cut over. Retain the old credential
until the agreed checks pass; report any remaining active old token rather
than claiming that its broader access has been removed.

## Rotate the service-account token

Use 1Password.com's native **Rotate Token** on the existing service account.
Rotation preserves its permissions and offers an overlap before the previous
token expires. The installed `op service-account` CLI has no rotate command.
Nathan owns the website confirmation and private custody of the replacement;
keep it outside chat, command arguments and captured terminal output.

Before rotation, identify every consumer and choose enough overlap to update
both Macs. The existing Connectors `setup --interactive` route accepts the token
privately in a trusted desktop terminal and stores and verifies the shared
Keychain item. Resolve that command from the installed Connectors skill. Do
not assume an SSH shell has the desktop's Keychain context.

After updating each Mac, verify the same service-account identity, exact vault
scope, real credential delivery and each consumer's own authentication check.
Connectors uses its own Keychain reader: a launcher pass does not prove its
SSH route. Let the previous token expire or revoke it only after the agreed
consumer checks pass. Rotating this service token does not rotate the API keys
or website passwords it reads, or change their item bindings. This is a
user-present maintenance procedure; unattended reads remain a separate route.

## Store and deliver

Use the existing native macOS Keychain. The launcher's `--help` owns executable
verification, token-source selection and its SSH desktop-context route. That
route uses existing noninteractive admin rights to enter the same user's
logged-in desktop context; it creates no permission and changes no lock policy.
An unlocked 1Password app does not prove an unlocked macOS login Keychain.
Desktop logout, Keychain lock or missing admin rights can block SSH reads.

Prefer encrypted Keychain custody over a plaintext fallback. After a verified
cutover, remove only the token declaration from the legacy fallback file while
preserving unrelated content. Do not store a Keychain unlock password to make
reboot or lock recovery automatic. Failed custody is a handoff.

Keep the service-account token in the `op` child only. Deliver the requested
credential to one trusted consumer through environment or stdin, according to
its supported interface. Both that consumer and a signed-in website necessarily
receive authority. The general `op` command can return raw secrets, so capture
its output privately and emit a redacted result.

## Define the agent's trust

The launcher prevents accidental inheritance and command-argument disclosure.
Fixed tools and vendor signature verification prevent PATH substitution in its
own credential-loading path. These are protections for trusted automation.

Same-user file modes, a user-writable login whitelist and a voluntary launcher
do not isolate a compromised agent. An unrestricted agent can invoke other
commands, change its own code, or misuse credentials delivered to its consumer.
Passwordless sudo also gives that agent root authority. Containment requires an
independently enforced restricted account, sandbox or credential broker.
Get Nathan's decision before changing execution isolation or introducing a
paid service; do not describe the existing wrapper as that boundary.

## Prefer supported capabilities

1Password Service Accounts and CLI support unattended reads with vault-scoped
permissions. Agent Browser uses its supported private credential-provider protocol for
approved unattended website logins. Native browser autofill is the user-present
fallback. Confirm
current compatibility before adopting another product: 1Password for Agents
has agent, vault and approval requirements; Credential Broker has workload
identity and account requirements. Neither is assumed to be a drop-in local
replacement across Pi, Claude Code and Codex.

- [Service-account permissions and management](https://www.1password.dev/service-accounts/manage-service-accounts)
- [Service-account security](https://www.1password.dev/service-accounts/security)
- [1Password for Agents](https://support.1password.com/1password-for-agents/)
- [Credential Broker](https://1password.com/product/credential-broker)
