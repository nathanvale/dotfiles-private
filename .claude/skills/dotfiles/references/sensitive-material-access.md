# Sensitive Material Access

Authoritative for every kind of sensitive material on this machine: API keys and
tokens, website login credentials, payment cards, contact and identity
profiles, and release signing credentials.

1Password owns the values. This document owns how one reaches a destination.

---

## Material classes and their lanes

The lane is chosen by what the material is, not by which tool wants it. Each
lane decides who may observe the value.

| Material | Lane | Who may observe it |
|---|---|---|
| API keys, service tokens | Process | Only the one child process that needs it |
| Website login credentials | Browser | 1Password fill inside the browser; never the agent |
| Payment cards, contact and identity profiles | Human-present | Nathan, live, approving each fill |
| Signing, notarization, publication credentials | Release | Only the admitted release workflow |

An agent receives status and redacted receipts from every lane. It never
receives a raw value.

Delivery varies inside the process lane. A command takes its value through
`inject`; an HTTP or SSE MCP server has no command to wrap and takes it through
a [headers helper](#http-mcp-servers-the-headers-lane). A router such as
MCPorter adds no lane at all: whatever it launches still reaches its value
through the lane above, as
[MCPorter and the process lane](#mcporter-and-the-process-lane) describes.

---

## Process lane

For an API key or token reaching a CLI, MCP server, or any executable.

```bash
with-one-password-token inject <ENV_KEY> <op://reference> -- <command> [args...]
```

One value, one child. The launcher resolves the reference, removes the
service-account token from the environment, then execs the target, so a child
never inherits broker authority.

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

`op run` is rejected because it can forward the token to a child. A config that
calls `op run` directly bypasses this launcher and hands the child the
service-account token. Treat one as a defect to migrate, not a working route.

### Prerequisites

1. A 1Password service account with read access to the required vault.
2. Its token in `~/code/dotfiles/.env` as `OP_SERVICE_ACCOUNT_TOKEN`. That file
   is git-ignored, a regular non-symlink file, owned by you, mode 0600.
3. The `op` CLI on PATH.

Check custody without touching a value:

```bash
with-one-password-token check
```

---

## HTTP MCP servers: the headers lane

An HTTP or SSE MCP server has no launch command to wrap, so `inject` does not
reach it. Its credential travels in a request header instead.

Claude Code runs a `headersHelper` at connection time and reads one JSON object
of headers from its stdout. That is the seam: the helper reads through the
governed launcher and writes only to stdout, so the value stays out of the
config, the shell environment, and argv.

```json
"test-mcp-server": {
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headersHelper": "/Users/nathanvale/code/dotfiles/bin/cloudflare-access-headers"
}
```

The helper owns the reference and emits the pair:

```bash
"$CREDENTIAL_WRAPPER" op item get "$ITEM_TITLE" --vault "$VAULT_NAME" \
  --fields 'label=client_id,label=client_secret' --reveal --format json
```

`bin/cloudflare-access-headers` is the worked example. It serves any Cloudflare
Access service token: point `CLOUDFLARE_ACCESS_HEADERS_ITEM` at a 1Password item
holding `client_id` and `client_secret` fields.

Rules for a headers helper:

- Print one JSON object of headers to stdout and exit 0. Any other output fails
  the connection.
- Emit nothing on any failure path, so a partial credential never reaches a
  header.
- Parse and emit in `python3` rather than a shell string, so no value is
  interpolated into a command line.
- Read through `with-one-password-token op`, which strips the broker token.

Claude Code re-runs the helper and reconnects when a call returns 401 or 403,
so a rotated credential is picked up without editing the config.

Static `headers` values expand `${VAR}` in current builds, but that route puts
the value in the shell environment where every child inherits it. Prefer the
helper.

---

## MCPorter and the process lane

MCPorter routes tools. It never owns, resolves, or holds a credential. A server
it launches reaches its value through the process lane like any other child, so
the boundary is unchanged: 1Password owns values, MCPorter owns routing.

The credential is injected *below* MCPorter, by the provider's own wrapper:

```text
harness -> bridge -> mcporter serve -> provider wrapper -> inject -> provider
```

An MCPorter server definition therefore names a wrapper, never an `op://`
reference and never a raw command:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "firecrawl-mcp",
      "lifecycle": "keep-alive",
      "allowedTools": ["firecrawl_search"]
    }
  }
}
```

The wrapper it names owns the reference and the exec:

```bash
exec "$CREDENTIAL_WRAPPER" inject FIRECRAWL_API_KEY \
  'op://API Credentials/FIRECRAWL_API_KEY/credential' -- <provider command>
```

Because the wrapper execs through `inject`, the MCPorter process and every
sibling server stay outside the value's blast radius. One server's credential
never becomes another server's ambient authority.

Rules for adding an MCPorter route:

- Put the `op://` reference in the provider wrapper, never in MCPorter config.
- Give each provider its own wrapper. Do not share one wrapper across providers.
- Set `allowedTools` to the exact tools the route needs.
- Never place a credential in a MCPorter definition's `env` block.

MCPorter's own `~/.mcporter/credentials.json` holds OAuth state for servers that
authenticate in a browser. It is not a place to put an API key.

---

## Browser lane

For signing in to a website. The credential goes from 1Password into the page.
The agent drives the browser and reads the resulting page state; it never
receives the credential and never types one.

Route browser work through the native Harness browser;
`$HOME/code/dotfiles/docs/agents/browser-automation.md` owns that rule. When
confidential fill is unavailable for a site, the run blocks or hands off to
Nathan rather than falling back to passing a value through the agent.

---

## Human-present lane

For payment cards, contact details, and the personal identity profile.

These require Nathan present and approving each fill. The canonical identity
lives in the built-in `Personal` vault, which cannot be granted to a service
account, so unattended access does not exist by design.

The working model:

1. The agent inspects the destination form and reports which field classes it
   needs.
2. Nathan selects the item and approves 1Password's confirmation prompt.
3. Nathan submits the form himself.
4. The agent inspects only the value-free terminal state.

Agent browser inspection stops while personal values are on screen.

---

## Release lane

For signing, notarization, and publication. Prefer job-scoped workload identity
where the platform supports it. The workflow owns its own approval, cleanup,
and postcondition proof.

Publishing to npm needs `NPM_TOKEN`, which `.npmrc` reads from the environment:

```bash
with-one-password-token inject NPM_TOKEN "op://API Credentials/NPM_TOKEN/credential" -- npm publish
```

---

## Where values live

| Location | Holds | Committed |
|---|---|---|
| 1Password `API Credentials` vault | API keys, service tokens | n/a |
| 1Password `Personal` vault | Identity, payment cards, personal logins | n/a |
| `~/code/dotfiles/.env` | The service-account token, nothing else | No, git-ignored, mode 0600 |

No file on this machine holds a projected set of secret values, and shell
startup sources none of them. Contract:
`bin/test/codex-ambient-credential-boundary-test.sh`.

---

## Adding or changing a credential

Edit the item in the 1Password app, or with `op item edit`. There is no wrapper
script for this, deliberately: a helper that takes the value as a command
argument writes a live credential into `~/.zsh_history`.

Then point the consumer at an exact `op://` reference. No sync step exists, so
there is nothing to regenerate and no new shell session needed.

---

## Common issues

| Issue | Fix |
|-------|-----|
| `check` reports blocked | Read the redacted JSON repair envelope on stderr; it names the cause |
| Child cannot see the key | Confirm the `ENV_KEY` argument matches what the program reads |
| `op://` reference fails | Verify vault, item title, and field label with `op item list` |
| A config still calls `with-env` | Migrate it to `inject` with an exact reference |
| `${NPM_TOKEN}` warning from npm | Expected for unauthenticated reads; inject it for `npm publish` |

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
