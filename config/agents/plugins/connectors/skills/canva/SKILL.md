---
name: canva
description: Find designs and inspect design pages or content in Canva for one named Canva Account through the plugin's MCPorter-native OAuth route. Use for Canva design discovery, design links, or "what designs do I have"; not for generation, editing, export, comments, assets, folders, or brand operations.
---

# Canva Design Discovery

Reads only. One Canva Account per call, selected by slug. MCPorter holds each
account's OAuth grant in its own native vault, under a private per-account
data root this skill selects. Keep native Harness MCP tools, direct Canva API
calls, bare `mcporter`, and browser automation outside this route.

The plugin's compiled front door at `../../bin/connectors` does not yet carry
Canva auth or reads; use the launcher below.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CANVA="$SKILL_DIR/scripts/canva.ts"
```

## Account

Require an explicit lowercase account slug for every run (`personal`,
`work`). If the request does not name one and more than one account exists,
ask the operator. Never infer an account from a design link. `--account
<slug>` always follows the command directly.

## Login and status

```sh
bun "$CANVA" status --account <slug>
bun "$CANVA" login  --account <slug> [--no-browser] [--reset]
```

- `status` is inspect: one JSON object naming the client mode, whether the
  account's vault file exists, and whether an older session file is
  preserved. It never reads either file and never proves a live grant.
- `login` is Attended Login through MCPorter's own `auth`: it opens the
  system browser for Nathan to grant access. Run it only when Nathan asks to
  connect or reauthorize. With `--no-browser`, MCPorter prints the
  authorization URL; show it to Nathan and wait. Keep that output out of chat
  and logs. `--reset` asks MCPorter to clear this account's local grant
  before consent; it does not revoke the grant at Canva.
- To remove a grant entirely, Nathan revokes the Connectors plugin in Canva
  connected apps.

Client identity is the `mode` in `config/client.json`. `dcr` (dynamic client
registration) is the working first-release mode. `approved` names the future
Developer Portal or metadata-document client; it is not built, and every
login or read refuses while it is selected. Leave the mode as Nathan set it.

## Reads

```sh
bun "$CANVA" list --account <slug> --schema --json
bun "$CANVA" call --account <slug> search-designs --args '{"query":"onboarding"}'
bun "$CANVA" call --account <slug> get-design --args '{"designId":"..."}'
```

The four admitted tools are `search-designs`, `get-design`,
`get-design-pages`, and `get-design-content`, exactly as `config/mcporter.json`
lists them; argument names come from the live `list --schema`, never from
memory. Reads always use the cached grant; MCPorter refreshes it itself and
never opens a browser on a read. Report the design's Canva edit URL when a
reply carries one.

## Refusals

Each prints `canva:error:<cause>:<message>` on stderr:

- `account-invalid`, `arguments-invalid`, `command-invalid`, `flag-forbidden`
  (exit 2): fix the invocation.
- `route-invalid` (exit 2 to 4): the shared route refused a flag or tool; the
  message names the route's cause code, never the argument itself.
- `client-mode-not-admitted` (exit 3): `approved` is selected. Report it; do
  not change the mode or try another route.
- `legacy-cache-present` (exit 3): a MCPorter cache for `canva-connectors`
  exists under `~/.mcporter`. Ask Nathan to move it aside; Connectors never
  imports it.
- `vault-root-invalid` (exit 3): the account's private data root is a
  symlink, foreign-owned, or not a directory. Stop and report.
- `client-mode-invalid`, `registry-identity-invalid` (exit 4): the Canva
  config is damaged. Stop and report.
- `executable-missing` (exit 4): `mcporter` is not on PATH. No vault
  directory was created.
- `execve-unavailable`, `exec-failed` (exit 4): MCPorter could not start.
  Stop and report.

An MCPorter auth failure on a read means the grant is missing or expired:
report it and offer an attended `login`.

## Proof states

Report which state each claim reached:

- Configured: registry, route, client mode, and launcher named.
- Fixture-tested: launcher, vault placement, and refusals under the fake MCPorter.
- Authenticated: a live attended `login` completed for the account.
- Schema-qualified: the live `list --schema` named the four admitted tools.
- Live-read-proven: one `search-designs` and one `get-design` returned a known design.

Official references: [Canva MCP](https://www.canva.dev/docs/apps/mcp/),
[access and permissions](https://www.canva.dev/docs/apps/mcp/access/),
[tools and rate limits](https://www.canva.dev/docs/apps/mcp/tools/),
[usage policy](https://www.canva.dev/docs/apps/mcp/usage-policy/).

## Completion

Report the account, tools called, exact designs read, the proof state
reached, verified links when a URL was returned, and every refusal cause met.
