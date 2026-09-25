---
status: accepted
supersedes: 0002-own-canva-per-user-oauth-below-mcporter.md
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
- Existing Canva Session files are preserved until the replacement login is
  proven for their account; retirement removes only that file in an
  attended, recorded step, never automatically.
- No claim about the vault's cryptographic properties.

## Decision

The Canva registry declares one hosted OAuth server, `canva-connectors`, on
`https://mcp.canva.com/mcp` with `clientName: "Connectors plugin"` and the
four read tools. Its route declares `oauth: "mcporter"` and
`dispatcherOwned: true`, so the public shared route refuses Canva.

`skills/canva/adapter.ts` is the packaged Canva adapter behind the front
door's `bin/connectors auth`, `run`, and `schema`, which reach the verified
MCPorter the front door selects. The adapter takes the shared route's own plan
through `planCanvaRoute`, which sets MCPorter's `XDG_DATA_HOME` and
`XDG_CACHE_HOME` to the Account Vault
`<state root>/connectors/canva-mcporter/<account>/{data,cache}`, created as
owned 0700 directories only after every check and the MCPorter selection
pass. `auth login` runs MCPorter `auth` (attended, `--no-browser` and
`--reset` only); `run` and `schema` carry `--no-oauth`; `auth status` reports
only file existence.

`config/client.json` holds the Client Mode. `dcr` is admitted. `approved` is
reserved and refuses every login and read with `client-mode-not-admitted`.
The Canva server entry may carry only `description`, `baseUrl`, `auth`,
`clientName`, and `allowedTools`; the custody interface refuses every other key.
MCPorter accepts camelCase and snake_case spellings of client, secret,
metadata-document, token-cache, bearer, header, env, and command options, and
any of them would change identity, fall back from a metadata document to
registration, or move the grant. Refusal messages are fixed text and never
quote caller argv or the shared route's argv-bearing message. It refuses when `~/.mcporter/canva-connectors` exists, because
MCPorter would import it into the selected account.

The custody interface is `skills/canva/scripts/custody/index.ts`;
`planCanvaRoute` is the seam the packaged adapter calls for every Canva
login, schema, and read. No other Canva route exists; the public shared route
refuses Canva.

### Legacy Canva Session retirement

A legacy Canva Session file
(`<state root>/connectors/canva/<account>/session.json`, written under ADR
0002 and holding that account's access and refresh tokens) stays on disk,
unopened and unused, until both conditions hold for that account on that
machine:

1. Its attended MCPorter `auth login` under `dcr` has succeeded.
2. Live-only steps 1 through 3 under Confirmation have passed for the same
   account through the packaged adapter.

Then Nathan retires that one file in an attended, target-specific step: one
account on one machine, naming the exact path. To retire is to remove
exactly that one file. The step never opens, reads, copies, moves, renames,
backs up, or prints the file, because any surviving copy still holds the
tokens, and it touches no other file in the account folder. Absence is then
confirmed by metadata only: an existence check on the named path, such as
`auth status` reporting `legacySession` as `absent`, never a read of the
file. Any other legacy file stays until its own account meets both
conditions.

Each retirement receipt names the account, machine, path, the proof it
relied on, the absence check, and the outcome, and never any file content.
Its owner is private runtime evidence under
`$XDG_STATE_HOME/my-second-brain-playground/connectors-portable-cli/evidence/`,
reached from Bead `cpc-dep.6`; neither this record nor the repository holds
a receipt.

No Connectors command, adapter, test, setup step, or automation opens,
moves, or deletes a legacy file. `auth status` may check whether the legacy
path exists, by `lstat` alone, and never opens it. This record adds no
automated deletion path. Retiring the local file does not revoke the grant
at Canva; Connectors carries no remote revocation. Remote revocation stays a
separate decision Nathan takes in Canva connected apps, and this record
makes no claim about how Canva groups the legacy and replacement grants
there.

This policy records timing and method only. It claims no login, live proof, or
retirement has happened.

## Consequences

- Positive: MCPorter's own refresh and refresh lock serve each account
  independently; no Connectors code handles a token.
- Positive: the grant leaves argv, envelopes, and ordinary configuration
  entirely; only MCPorter's vault and its exchange with Canva hold it.
- Negative: MCPorter now holds Canva tokens above the former credential line,
  with its own storage format and refresh semantics.
- Negative: logout is not yet carried; `login --reset` clears the local grant
  and remote revocation stays in Canva connected apps.
- Negative: old Canva Session files, each holding access and refresh tokens,
  remain on disk until their account's recorded retirement step. While one
  remains on a machine, Spec #87 AC8 evidence cannot pass on that machine,
  because an ordinary token file still holds a provider credential.
  Removing it is necessary, not sufficient: the account folder also keeps
  `registration.json`, `hyper-mcp-remote/`, and `refresh.lock`, and AC8 still
  needs a full on-disk inspection showing no token file ever holds a
  credential. This record claims no AC8 pass.
- Negative: retirement is manual, per account, and live-proof dependent;
  fixtures prove only that Connectors preserves legacy files, never that one
  was retired.
- Neutral: the pinned `hyper-mcp-remote` bridge has no remaining Canva consumer.

## Options and Tradeoffs

### Keep ADR 0002's below-MCPorter session

- Good: keeps an owned logout receipt and principal binding.
- Bad: contradicts accepted Spec #87 Q5.

### One MCPorter entry through the shared route

- Good: no Canva-owned code.
- Bad: every account shares one home vault key; isolation fails.

### Per-account Account Vault through a packaged Canva adapter

- Good: independent vault per account with no shared-route change.
- Good: the generic front door carries Canva with no service-name branch.
- Bad: Canva keeps one service-owned adapter in the closed packaged registry.

## Confirmation

Fixture-proven in `tests/canva-packaged.test.ts` through the packaged
`bin/connectors` with network denied and the official MCPorter 0.14.0 it
verifies: attended `auth` argv with `--no-browser` and `--reset`, per-account
vault reads and `--reset`, `--no-oauth` on `run` and `schema`, per-account
private vault roots in MCPorter's environment with ambient Canva secrets
absent, the approved-mode refusal with no MCPorter selection, camelCase,
snake_case, and unknown registry keys refusing, home cache and symlinked
vault root refusals, the grant sentinel confined to its vault, preserved
legacy files, and a secret-shaped argv sentinel absent from every refusal.
`skills/canva/tests/canva.test.ts` pins the registry, route, and client
switch, and the public route's refusal of Canva;
`skills/figma/tests/figma.test.ts` pins Figma's unchanged route environment.

Live-only, each separately authorised, in order:

1. Attended `auth login` for one account under MCPorter 0.14.0 with `dcr`.
2. `auth status`, then `schema`; reconcile the four admitted names.
3. One `run` of `search-designs` and one of `get-design` for a known design.
4. A second account's login, confirming separate vault files.
5. A refresh after access-token expiry, confirming silent MCPorter rotation.

Legacy retirement, outside that order: for each
account and machine that holds a legacy Canva Session file, once steps 1
through 3 pass for that account, the retirement step under Decision, then
the metadata-only absence check and that account's `auth status` and one
read still succeeding. It never waits for steps 4 or 5, so a machine with one
Canva Account can retire its file.

## Authority

Decision authority: Nathan, who accepted this record on 2026-09-25, including
that v1 carries no Connectors Canva logout or remote revocation command. On
the same date Nathan chose to retire each unused legacy Canva Session file
after its account's new login, as the conditional local policy under
Decision records; this amendment keeps the record accepted. It
supersedes ADR 0002, which is `status: superseded` with `superseded_by`
pointing back.

## References

- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/v0.14.0/docs/config.md)
- [MCPorter vault source](https://github.com/openclaw/mcporter/blob/v0.14.0/src/oauth-vault.ts)
- [Canva MCP access and permissions](https://www.canva.dev/docs/apps/mcp/access/)
- [ADR 0002](0002-own-canva-per-user-oauth-below-mcporter.md), [ADR 0003](0003-scope-native-mcporter-oauth-to-figma.md)
