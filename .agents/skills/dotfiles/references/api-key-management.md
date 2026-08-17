# API Key Management Reference

How a secret reaches a process on this machine.

---

## Architecture

Secrets stay in 1Password. Nothing projects them to disk, and nothing sources
them into a shell. One value is delivered to one child process at the moment it
runs.

```
1Password Vault "API Credentials"
        |
        | (with-one-password-token inject)
        v
exactly one child process, one variable
```

The service-account token lives in `~/code/dotfiles/.env` and is readable only
by `with-one-password-token`. The launcher removes it from the environment
before exec'ing the target, so a child never inherits broker authority.

---

## Prerequisites

1. A 1Password service account with read access to the required vault.
2. Its token in `~/code/dotfiles/.env` as `OP_SERVICE_ACCOUNT_TOKEN`. The file
   must be git-ignored, a regular non-symlink file, owned by you, mode 0600.
3. The `op` CLI on PATH.

Check custody without touching a value:

```bash
with-one-password-token check
```

---

## Delivering a secret

```bash
with-one-password-token inject <ENV_KEY> <op://reference> -- <command> [args...]
```

Wiring an MCP server, from `~/.codex/config.toml`:

```toml
[mcp_servers.context7]
command = "/Users/nathanvale/code/dotfiles/bin/with-one-password-token"
args = ["inject", "CONTEXT7_API_KEY",
        "op://API Credentials/CONTEXT7_API_KEY/credential",
        "--", "env", "npx", "-y", "@upstash/context7-mcp"]
```

Run one `op` command with a scrubbed environment:

```bash
with-one-password-token op item list --vault "API Credentials"
```

`op run` is rejected because it can forward the token to a child.

---

## .env file roles

| File | Committed | Purpose |
|------|-----------|---------|
| `.env` | No, git-ignored, mode 0600 | Service-account token only |
| `~/.env.secrets` | No | Machine-specific non-secret settings |

---

## Adding or changing a key

Edit the item in the 1Password app, or with `op item edit`. There is no wrapper
script for this, deliberately: a helper that takes the value as a command
argument writes a live credential into `~/.zsh_history`.

Then reference the item from the consumer with an exact `op://` path. No sync
step exists, so there is nothing to regenerate and no new shell session needed.

---

## Common issues

| Issue | Fix |
|-------|-----|
| `check` reports blocked | Read the redacted JSON repair envelope on stderr; it names the cause |
| Child cannot see the key | Confirm the `ENV_KEY` argument matches what the program reads |
| `op://` reference fails | Verify vault, item title, and field label with `op item list` |
| A config still calls `with-env` | Migrate it to `inject` with an exact reference |

---

## Retired workflow

`add-api-key`, `sync-api-keys`, `ls-api-keys`, `with-env`, the `load-secrets`
shell function, and the generated `.env.1password` file were removed on
2026-08-18.

Do not reintroduce them. `add-api-key` took the secret as a positional
argument, so every invocation wrote a live credential into shell history, and
it projected all values into one plain-text file that at removal held 30 live
credentials, including supply-chain and billable keys. Any child of `with-env`
inherited the entire set.
