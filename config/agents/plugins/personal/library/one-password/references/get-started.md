# Authentication modes

## Desktop app integration

Enable CLI integration in the unlocked 1Password desktop app. On macOS, use Settings > Developer > Integrate with 1Password CLI. Run an account-scoped native command directly; the app handles authentication. `op whoami` provides a metadata-only check without listing vaults. Separate shells can use app integration without retaining an `OP_SESSION_*` variable.

## Standalone session

When app integration is unavailable, native `op account add` and `op signin` provide standalone authentication. Authorize this user-present path first. Capture the session value inside one trusted shell and retain it there for subsequent commands. Session output contains a credential; keep it out of agent output and logs. This persistence requirement belongs to standalone authentication.

## Unattended SSH and services

Use the declared service-account route through `$HOME/code/dotfiles/bin/with-one-password-token`. Its `check` command and `--help` own Keychain selection, the protected file fallback, and repair guidance. Desktop authentication does not establish unattended service access.

For multiple accounts, pass `--account` explicitly. Consult the [official app-integration documentation](https://www.1password.dev/cli/app-integration/) for platform prerequisites and settings.
