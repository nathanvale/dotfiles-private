---
name: one-password
description: "1Password/op: scoped secret custody, approved allowlisted browser login, and interactive sign-in fallback."
metadata: {"clawdbot":{"emoji":"🔐","requires":{"bins":["op"]}}}
---

# 1Password CLI

Generic safe `op` workflow: pick the access path, run targeted reads/writes, verify shape only. Exact account, vault, item, and field mappings belong to the owning capability, never here.

No-args or unclear request: start at Workflow step 1 — name the owning capability and its declared mapping.

## Access Paths

1. **Scoped service-account read (preferred, unattended).** Run non-interactive `op` through `$HOME/code/dotfiles/bin/with-one-password-token`, with an explicit `--vault` from the owning capability. Read the wrapper's `--help` before use. Never route through tmux or a persistent PTY.
2. **Desktop app integration (user-present).** With CLI integration enabled, run the account-scoped native command directly. The app handles authentication; a separate `op signin` and persistent terminal are unnecessary. Verify authentication with an authorized exact-item operation whose consumer emits only status or shape. `op whoami` reports identity but can say the account is not signed in while app-backed reads succeed. Ask before switching to this path after a failed unattended check unless the user already authorized desktop verification.
3. **Standalone session authentication (user-present).** When app integration is unavailable and this path is authorized, use native `op signin` in one trusted shell. Keep its `OP_SESSION_*` value within that shell for subsequent commands. Read [get-started](references/get-started.md) for this branch; it does not provide unattended SSH credentials.

## Token custody

- Let `$HOME/code/dotfiles/bin/with-one-password-token` own token custody and process-scoped injection. Never read, source, create, or export its token source from this workflow; never place the token in shell rc, tmux/PTY environment, or ambient env.
- Browser login uses the extension or a specifically authorised capability's
  native-browser custody helper. Read [browser-login](references/browser-login.md)
  for that branch; it binds exact vault, item, origin and profile. Use its helper
  rather than returning secrets to an agent.
  Other browser logins remain Nathan's sign-in handoff under
  `$HOME/code/dotfiles/docs/agents/browser-automation.md`.
- Keep browser secrets out of clipboard, adapter plans and model output.
- Keep explicit vault listing and item create/update requests in this workflow.

## Workflow

1. Get the owning capability's declared mapping: account, vault, item, field, expected shape. Missing mapping: stop and ask; never enumerate to discover.
2. Choose the access path above.
3. Service-account read: run `$HOME/code/dotfiles/bin/with-one-password-token check`. On success, deliver the declared reference to its consumer through `inject` or `inject-stdin`. For item JSON needed by an approved operation, capture it inside the consumer and emit only a redacted receipt; use the scoped examples in `references/cli-examples.md`. On failure, retain the wrapper-owned repair code and hint, then ask before using the fallback. Never treat missing token custody as healthy access.
4. Process injection: run `$HOME/code/dotfiles/bin/with-one-password-token inject <ENV_KEY> <op://reference> -- <command>` when the declared capability needs one secret environment variable. The target receives the requested field, never the service-account token.
5. User-present access: for app integration, verify an authorized account-scoped operation directly and redact its result inside the consumer. For standalone authentication, retain the session in its trusted shell. If either path replaces a failed unattended check, report desktop success separately from the unresolved service-account failure and retain the wrapper repair hint.
6. Verify shape only: length, expected prefix, newline count. Never print values.

## Guardrails

- Never print secret values to logs, chat, or code; shape-only checks.
- Never enumerate accounts, vaults, or items to discover candidates. On an explicit user ask, search metadata only within the token-scoped vault (`references/cli-examples.md`).
- Never use `op run` through the dotfiles wrapper; it is rejected because the target could inherit `OP_SERVICE_ACCOUNT_TOKEN`. Use the wrapper's `inject` command instead of writing secrets to disk.
- Multiple accounts: pass `--account` explicitly; confirm names with `op account list` (metadata-only) when routing is unclear.
- `op --field` / `--fields label=` can return the wrong concealed field on items with duplicate or legacy fields. Capture item JSON inside an approved consumer, require exactly one matching label and type, and emit only shape or status.

## References

- Official docs: https://developer.1password.com/docs/cli/get-started/
- `references/get-started.md` — install, app integration, sign-in.
- `references/cli-examples.md` — safe create/edit, shape-only field reads, vault-scoped metadata search.
- Vocabulary: `CONTEXT.md`.
- Local compatibility owner: `$HOME/code/dotfiles/bin/with-one-password-token`; missing or failed `check` blocks unattended local access, not user-approved interactive fallback.
