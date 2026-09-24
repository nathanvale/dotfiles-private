---
status: proposed
---

# Move Canva custody into MCPorter's native vault

## Context and Problem

ADR 0002 kept Canva's OAuth grant below MCPorter in a Bun session module and
Provider. Accepted Spec #87 (Q5, AC8, AC12, AC14, AC25) instead places the
grant in MCPorter's own declared vault, keeps Attended Login, per-account
isolation, and safe refresh, and makes dynamic client registration the
first-release client behind an explicit switch.

MCPorter 0.14.0 source (`src/oauth-vault.ts`, `src/runtime/environment.ts`)
keys each grant by server name plus URL inside one `credentials.json` under
`$XDG_DATA_HOME/mcporter`, else `~/.mcporter`. One registry entry therefore
cannot separate Canva Accounts, and the shared route forwards `HOME` but no
`XDG_DATA_HOME`, so a Canva grant through it would land in the same home
vault as every other MCPorter grant. MCPorter also migrates a
`~/.mcporter/<server>` directory into whichever vault it opens.

## Decision Drivers

- MCPorter owns the grant, its refresh, and its refresh lock; Connectors never
  reads, writes, imports, or deletes one.
- Each Canva Account has an independently selected vault.
- Login is attended and separate from reads; reads never open a browser.
- Client identity changes only through one declared switch, with no fallback.
- Existing Canva Session files are preserved until an explicit migration
  policy exists.
- No claim about the vault's cryptographic properties.

## Decision

The Canva registry declares one hosted OAuth server, `canva-connectors`, on
`https://mcp.canva.com/mcp` with `clientName: "Connectors plugin"` and the
four read tools. Its route declares `oauth: "mcporter"` and
`dispatcherOwned: true`, so the public shared route refuses Canva.

`skills/canva/scripts/canva.ts` is the Canva launcher. It takes the shared
route's own plan through `planDispatcherRoute`, then sets MCPorter's
`XDG_DATA_HOME` and `XDG_CACHE_HOME` to the Account Vault
`<state root>/connectors/canva-mcporter/<account>/{data,cache}`, created as
owned 0700 directories only after every check and the MCPorter lookup pass,
and replaces itself with MCPorter. `login` runs
MCPorter `auth` (attended, `--no-browser` and `--reset` only); `list` and
`call` carry `--no-oauth`; `status` reports only file existence.

`config/client.json` holds the Client Mode. `dcr` is admitted. `approved` is
reserved and refuses every login and read with `client-mode-not-admitted`.
The Canva server entry may carry only `description`, `baseUrl`, `auth`,
`clientName`, and `allowedTools`; the launcher refuses every other key.
MCPorter accepts camelCase and snake_case spellings of client, secret,
metadata-document, token-cache, bearer, header, env, and command options, and
any of them would change identity, fall back from a metadata document to
registration, or move the grant. Refusal messages are fixed text and never
quote caller argv or the shared route's argv-bearing message. It refuses when `~/.mcporter/canva-connectors` exists, because
MCPorter would import it into the selected account.

The custody interface is `skills/canva/scripts/custody/index.ts`;
`planCanvaRoute` is the seam a generic `connectors run` calls for Canva.

## Consequences

- Positive: MCPorter's own refresh and refresh lock serve each account
  independently; no Connectors code handles a token.
- Positive: the grant leaves argv, envelopes, and ordinary configuration
  entirely; only MCPorter's vault and its exchange with Canva hold it.
- Negative: MCPorter now holds Canva tokens above the former credential line,
  with its own storage format and refresh semantics.
- Negative: logout is not yet carried; `login --reset` clears the local grant
  and remote revocation stays in Canva connected apps.
- Negative: old Canva Session files
  (`<state root>/connectors/canva/<account>/session.json`, which hold a
  refresh token) remain on disk, unread and unused. No retirement or
  revocation policy is decided; Spec #87 AC8 evidence waits on that decision.
- Neutral: the pinned `hyper-mcp-remote` bridge has no remaining Canva consumer.

## Options and Tradeoffs

### Keep ADR 0002's below-MCPorter session

- Good: keeps an owned logout receipt and principal binding.
- Bad: contradicts accepted Spec #87 Q5.

### One MCPorter entry through the shared route

- Good: no launcher.
- Bad: every account shares one home vault key; isolation fails.

### Per-account Account Vault through a Canva launcher

- Good: independent vault per account with no shared-route change.
- Bad: one more service-owned launcher until the generic run carries it.

## Confirmation

Fixture-proven in `skills/canva/tests/canva.test.ts` through the real
launcher process and the shared MCPorter fake: exact registry and route,
attended `auth` argv, per-account private vault roots, `--no-oauth` reads,
the approved-mode refusal with no MCPorter start, identity-override and home
cache refusals, secret sentinels absent from argv, output, and MCPorter's
environment, preserved legacy files, the public route's refusal of Canva,
Figma's unchanged route environment, snake_case and unknown registry keys
refusing, a secret-shaped argv sentinel absent from every refusal, a
symlinked vault root refusing, and a missing MCPorter refusing before any
vault directory exists.

Live-only, each separately authorised, in order:

1. Attended `login` for one account under MCPorter 0.14.0 with `dcr`.
2. `status`, then `list --schema --json`; reconcile the four admitted names.
3. One `search-designs` and one `get-design` of a known design.
4. A second account's login, confirming separate vault files.
5. A refresh after access-token expiry, confirming silent MCPorter rotation.

## Authority

Decision authority: Nathan. This record stays `proposed` until Nathan accepts
it. Acceptance adds `supersedes: 0002-own-canva-per-user-oauth-below-mcporter.md`
here and, in the same change, sets ADR 0002 to `status: superseded` with
`superseded_by` pointing back.

## References

- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/v0.14.0/docs/config.md)
- [MCPorter vault source](https://github.com/openclaw/mcporter/blob/v0.14.0/src/oauth-vault.ts)
- [Canva MCP access and permissions](https://www.canva.dev/docs/apps/mcp/access/)
- [ADR 0002](0002-own-canva-per-user-oauth-below-mcporter.md), [ADR 0003](0003-scope-native-mcporter-oauth-to-figma.md)
