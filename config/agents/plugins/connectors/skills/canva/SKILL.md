---
name: canva
description: Find designs and inspect design pages or content in Canva for one named Canva Account through the plugin's OAuth session Provider. Use for Canva design discovery, design links, or "what designs do I have"; not for generation, editing, export, comments, assets, folders, or brand operations.
---

# Canva Design Discovery

Reads only. One Canva Account per call, selected by slug; each account holds
its own Canva Session in private state, and no organisation or service
identity exists. Keep native Harness MCP tools, direct Canva API calls,
`mcporter auth`, and browser automation outside this route.

The plugin also ships a compiled front door at `../../bin/connectors`,
resolved from this skill directory, no global command and no dotfiles path
required. It answers only `--discover --json`, `--help`, and `--help --json` today; it does not yet carry
this skill's operations, which still go through the route below.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
ROUTE="$SKILL_DIR/../../bin/provider-route.ts"
AUTH="$SKILL_DIR/scripts/canva-auth.ts"
```

## Account

Require an explicit lowercase account slug for every run (`personal`,
`work`). If the request does not name one and more than one session exists,
ask the operator. Never infer an account from a design link.

## Session

```sh
bun "$AUTH" status --account <slug> --json
bun "$AUTH" login  --account <slug> [--no-browser]
bun "$AUTH" logout --account <slug> --json
```

- `status` is inspect: exit 0 with the nonsecret session view;
  `DOMAIN_PRECONDITION_UNMET` (exit 3) means no session, run `login`;
  `SCHEMA_INVALID_INPUT` (exit 4) means a damaged session, run `logout` then `login`.
- `login` is Attended Login: it opens the system browser once and waits up to
  five minutes for Nathan to grant access. With `--no-browser` the URL is
  written to stdout the moment it exists, before the wait. Human mode is
  required because `--no-browser --json` is refused so machine completion
  keeps stderr empty. Show Nathan that URL and wait; never drive the browser.
  An existing session refuses before authorization; run `logout` before a new
  login. Registered mode requires scoped `CANVA_CLIENT_SECRET`; restore the
  secret matching the client in `oauth.json` before retrying. Consent denied
  or a callback that is not this login's is
  `DOMAIN_AUTHORITY_REQUIRED`; a missed window is `DOMAIN_DEADLINE_UNCHANGED`;
  a grant that could not be stored is `DOMAIN_RECOVERY_HANDOFF_REQUIRED`.
- `logout` revokes the grant when Canva confirms it and removes the local
  session. `DOMAIN_RECOVERY_HANDOFF_REQUIRED` means the local session is gone
  but Canva did not confirm revocation: tell Nathan to revoke the Connectors
  plugin in Canva connected apps. `DOMAIN_PRECONDITION_UNMET` with
  `client-secret-unavailable` preserves a registered session: restore the
  scoped `CANVA_CLIENT_SECRET` and matching registered client in `oauth.json`,
  then retry.
- `--discover --json` and `--discover-command <identity> --json` publish the
  full contract and every possible outcome.

## Reads

```sh
bun "$ROUTE" canva --select account=<slug> -- list --schema --json
bun "$ROUTE" canva --select account=<slug> -- call search-designs --args '{"query":"onboarding"}'
bun "$ROUTE" canva --select account=<slug> -- call get-design --args '{"designId":"..."}'
```

The four admitted tools are `search-designs`, `get-design`,
`get-design-pages`, and `get-design-content`, exactly as `config/mcporter.json`
lists them; argument names come from the live `list --schema`, never from
memory. Every other Canva tool stays excluded. Report the design's Canva edit
URL when a reply carries one.

Refusals to state as met:

- `canva-provider:error:auth-required` (exit 3): no session for the slug; run `login`.
- `canva-provider:error:auth-expired` (exit 3): Canva revoked or expired the
  grant and the session was removed; run `login`.
- `canva-provider:error:client-secret-unavailable` (exit 3): a stored
  registered session cannot authenticate because scoped `CANVA_CLIENT_SECRET`
  is missing or does not match the registered client in `oauth.json`. Restore
  both and retry. The session is preserved; never put the secret in config,
  session state, arguments, or output.
- `canva-provider:error:auth-busy` (exit 3): another process is rotating the
  token. Retry once after one second. If the lock remains, stop all
  `canva-auth` and Canva Provider processes for that account, remove only
  `<state root>/connectors/canva/<slug>/refresh.lock`, then run `status`; the
  state root is absolute `$XDG_STATE_HOME` or `~/.local/state`.
- `canva-provider:error:refresh-uncertain` (exit 3): the refresh request may
  have consumed its single-use token and the session was removed. Inspect
  Canva connected apps, then run `login`; never retry the old session.
- `canva-provider:error:bridge-version-invalid` (exit 4): the pinned
  `hyper-mcp-remote` 0.5.0 is not on PATH.
- `provider-route:error:select-missing` (exit 2): `--select account=<slug>` is required.

## Custody

The Provider refreshes the access token under a per-account lock before each
call and passes only that token to the pinned bridge as a Bearer header;
the refresh token never leaves the session module. MCPorter, the route, and
this skill hold no credential. Background enumeration, bulk extraction,
prefetching, indexing, and cross-account caching stay outside this workflow.

## Proof states

Report which state each claim reached:

- Configured: registry, route, and Provider named; proven by the tests here.
- Fixture-tested: session, Provider, CLI, and route behaviour under fakes.
- Authenticated: a live `login` stored a session and `status` showed it.
- Schema-qualified: the live `list --schema` named the four admitted tools.
- Live-read-proven: one `search-designs` and one `get-design` returned a known design.

Official references: [Canva MCP](https://www.canva.dev/docs/apps/mcp/),
[access and permissions](https://www.canva.dev/docs/apps/mcp/access/),
[tools and rate limits](https://www.canva.dev/docs/apps/mcp/tools/),
[usage policy](https://www.canva.dev/docs/apps/mcp/usage-policy/).

## Completion

Report the account, tools called, exact designs read, the proof state
reached, verified links when a URL was returned, and every refusal cause met.
