---
name: canva
description: Find designs and inspect design pages or content in Canva for one named Canva Account through the plugin's MCPorter-native OAuth route. Use for Canva design discovery, design links, or "what designs do I have"; not for generation, editing, export, comments, assets, folders, or brand operations.
---

# Canva Design Discovery

Reads only. One Canva Account per call, selected by slug. MCPorter holds each
account's OAuth grant in its own native vault, under a private per-account
data root the packaged Canva adapter selects. Keep native Harness MCP tools,
direct Canva API calls, bare `mcporter`, and browser automation outside this
route.

Use the plugin's packaged front door, resolved from this skill directory: no
global `connectors` command, no dotfiles path.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
```

Each command prints one JSON envelope on stdout. Read `result.outcome`,
`result.causeCode`, `result.data`, and `result.repairAction`;
`result.data.connectorCause` names the Canva cause.

## Account

Require an explicit lowercase account slug for every run (`personal`,
`work`). If the request does not name one and more than one account exists,
ask the operator. Never infer an account from a design link. Pass it as
`--select account=<slug>` directly after `canva`.

## Status and login

```sh
"$CONNECTORS" auth status canva --select account=<slug>
"$CONNECTORS" auth login canva --select account=<slug> [--no-browser] [--reset]
```

- `auth status` is inspect: `custody`, `clientMode`, `clientModeAdmitted`,
  `vaultIndex` (`present` or `absent`), `grant` (`absent` or `unknown`), and
  `legacySession`. It never reads the vault file; `grant: "unknown"` is not
  a live grant.
- `auth login` is Attended Login through MCPorter's own `auth`; it opens the
  system browser for Nathan to grant access. It needs his terminal, so a run
  without one refuses with `DOMAIN_ATTENDED_REQUIRED`. When Nathan asks to
  connect or reauthorize, give him the exact command to run himself.
- `--no-browser` makes MCPorter print the consent URL in Nathan's terminal
  instead of opening a browser. The URL never reaches the envelope or the
  agent; never ask Nathan to paste it into chat.
- `--reset` clears only this account's local grant before consent; other
  accounts keep theirs. It does not revoke the grant at Canva.
- `SUCCESS_AUTH_LOGIN` means MCPorter's `auth` exited cleanly, nothing more.
  `DOMAIN_AUTH_LOGIN_UNKNOWN` leaves the grant uncertain: run `auth status`
  before any retry.
- Canva carries only `status` and `login`; every other verb, `logout`
  included, refuses with `DOMAIN_AUTH_VERB_UNSUPPORTED`. To remove a grant,
  Nathan revokes the Connectors plugin in Canva connected apps.

Client identity is the `mode` in `config/client.json`. `dcr` (dynamic client
registration) is the working first-release mode. `approved` names the future
Developer Portal or metadata-document client; it is not built, and every
login, schema, and read refuses with `DOMAIN_CLIENT_MODE_NOT_ADMITTED` while
it is selected. Leave the mode as Nathan set it.

## Schema and reads

```sh
"$CONNECTORS" schema canva --select account=<slug>
"$CONNECTORS" run canva --select account=<slug> search-designs --input '{"query":"onboarding"}'
"$CONNECTORS" run canva --select account=<slug> get-design --input '<json-object>'
```

The four admitted operations are `search-designs`, `get-design`,
`get-design-pages`, and `get-design-content`, exactly as
`config/mcporter.json` lists them. Take argument names from `schema canva`,
never from memory: the tool list is `result.data.schema`, beside
`result.data.allowedTools`. Schema and reads always use the cached grant;
MCPorter refreshes it itself and never starts OAuth or opens a browser on
either. The tool reply is `result.data.result`; report the design's Canva
edit URL when it carries one.

## Refusals

Follow `result.repairAction`. By cause:

- `USAGE_MALFORMED_ARGUMENTS` (exit 2): the arguments do not parse. `--json`,
  unknown options, and `--no-browser` or `--reset` anywhere but `auth login`
  all refuse here. Fix the invocation.
- `account-invalid` (`USAGE_ADAPTER_REFUSED`), `operation-not-allowed`
  (`USAGE_OPERATION_UNKNOWN`), or `SCHEMA_SELECTOR_INVALID`: fix the
  invocation.
- `client-mode-not-admitted`: `approved` is selected. Report it; do not
  change the mode or try another route.
- `legacy-cache-present`: a MCPorter cache for `canva-connectors` exists
  under `~/.mcporter`. Ask Nathan to move it aside; Connectors never
  imports it.
- `vault-root-invalid`: the account's private data root is a symlink,
  foreign-owned, or not a directory. Stop and report.
- `client-mode-invalid`, `registry-identity-invalid`
  (`SCHEMA_ADAPTER_REFUSED`): the Canva config is damaged. Stop and report.
- `route-invalid`: the shared route refused the planned MCPorter arguments.
  Stop and report.
- `DOMAIN_MCPORTER_REPAIR_*` or `INTERNAL_MCPORTER_SELECTION_UNKNOWN`:
  MCPorter selection did not complete. Report the repair; Nathan runs it.
- `TRANSIENT_PROVIDER_*` (exit 75): offline or unreachable; retryable.
- `DOMAIN_PROVIDER_CALL_FAILED*` on `schema` or `run`: the grant may be
  missing or expired, or a read's input is wrong. Check the input against the
  schema; otherwise report it and offer Nathan an attended login. Only a
  later successful read proves a grant.

## Proof states

Report which state each claim reached:

- Configured: manifest, registry, route, client mode, and adapter named.
- Fixture-tested: packaged front door, vault placement, and refusals
  through the verified MCPorter 0.14.0 with network denied.
- Authenticated: a live attended login completed for the account.
- Schema-qualified: the live schema named the four admitted tools.
- Live-read-proven: one `search-designs` and one `get-design` returned a
  known design.

Fixture proof is not login, schema, or read proof. Each machine and Harness
needs its own run; one never implies another.

Official references: [Canva MCP](https://www.canva.dev/docs/apps/mcp/),
[access and permissions](https://www.canva.dev/docs/apps/mcp/access/),
[tools and rate limits](https://www.canva.dev/docs/apps/mcp/tools/),
[usage policy](https://www.canva.dev/docs/apps/mcp/usage-policy/).

## Completion

Report the account, commands and tools called, exact designs read, the proof
state reached, verified links when a URL was returned, and every cause met.
