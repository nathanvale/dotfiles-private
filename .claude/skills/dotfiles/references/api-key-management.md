# API Key Management Reference

Deep dive on 1Password integration and the `bin/env/` tools for managing API keys.

---

## Architecture

API keys are stored in 1Password and synced to a local `.env.1password` file.
This keeps secrets out of git while making them available in the shell.

```
1Password Vault "API Credentials"
        |
        | (sync-api-keys)
        v
~/code/dotfiles/.env.1password  (git-ignored, auto-generated)
        |
        | (sourced by .zshrc)
        v
Shell environment variables
```

---

## Prerequisites

1. 1Password account with an "API Credentials" vault
2. A service account token stored in `~/code/dotfiles/.env`:
   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN="ops_..."
   ```
3. 1Password CLI (`op`) installed via Brewfile: `cask "1password-cli"`

---

## Tools (bin/env/)

### sync-api-keys

Pull all keys from 1Password and regenerate `.env.1password`.

```bash
sync-api-keys            # Full sync
sync-api-keys --dry-run  # Preview without writing
```

- Reads from 1Password vault "API Credentials"
- Writes to `~/code/dotfiles/.env.1password`
- The output file is auto-generated -- don't edit manually
- Supports `.env.ignore` for excluding specific keys

### ls-api-keys

List all synced API keys by provider.

```bash
ls-api-keys
```

### add-api-key

Add or update a key in 1Password.

```bash
add-api-key
```

### sync-docker-mcp

Sync Docker MCP server environment variables.

```bash
sync-docker-mcp
```

---

## .env File Roles

| File | Committed | Source | Purpose |
|------|-----------|--------|---------|
| `.env` | Yes | Manual | Bootstrap token (`OP_SERVICE_ACCOUNT_TOKEN`) |
| `.env.1password` | No | `sync-api-keys` | All API keys from 1Password |
| `.env.ignore` | Yes | Manual | Keys to exclude from sync |
| `~/.env.secrets` | No | Manual | Machine-specific secrets (`WORK_PROFILE`) |

---

## Adding a New API Key

1. Add the key to 1Password vault "API Credentials"
2. Run `sync-api-keys` to pull it locally
3. Verify with `ls-api-keys`
4. The key is now available in new shell sessions (after `source ~/.zshrc`)

---

## Common Issues

| Issue | Fix |
|-------|-----|
| `sync-api-keys` fails with auth error | Check `OP_SERVICE_ACCOUNT_TOKEN` in `.env` |
| Key not available in shell | Run `source ~/.zshrc` or open new terminal |
| Key appears in `git diff` | Check `.gitignore` includes `.env.1password` |
| `op` command not found | Run `brew install --cask 1password-cli` |
