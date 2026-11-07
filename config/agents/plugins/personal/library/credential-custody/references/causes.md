# Route a blocked doctor

The doctor emits one JSON result and exits 0 for observed matching metadata or
2 for a blocked check. `--help` exits 0 without probing. It prints no raw tool
output, paths, environment values, or credential values.

| Cause | Next action |
| --- | --- |
| `invalid-arguments` | Read the executable's help and supply the known target expectations. |
| `unsupported-platform` | Use the platform's native credential owner. This verifier supports macOS. |
| `unsupported-user-context` | Return to the intended non-root account without a changed effective UID. |
| `host-mismatch`, `user-mismatch`, `expected-home-mismatch` | Reconcile the target record and actual process before any credential operation. |
| `environment-home-mismatch`, `account-home-not-canonical` | Repair the launch context through its harness owner. Preserve the account's credential stores. |
| `transport-hint-mismatch` | Inspect the launch context. SSH markers are hints that callers can alter. |
| `login-keychain-missing`, `login-keychain-file-context` | Hand the filesystem observation to the account's macOS Keychain owner. Preserve existing files and settings. |
| `keychain-selection-differs` | Inspect the default and search list in the intended account. This doctor requires the normal login database for this journey. A deliberate alternate selection needs its own owner decision. |
| `metadata-command-unavailable`, `metadata-query-timeout`, `keychain-metadata-query-failed` | Preserve the refusal in this context. Inspect the native metadata command's availability or session through the owner. |
| `unexpected-keychain-metadata`, `metadata-inspection-unavailable` | Keep the result blocked. Investigate the observation method without printing captured bytes. |

The doctor checks regular-file type and ownership, without prescribing a mode
for Apple's database. It does not inspect file contents or apply the private
application-journal `0600` rule to an OS Keychain.
