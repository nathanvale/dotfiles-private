---
status: proposed
---

# Own Canva per-user OAuth below MCPorter

## Context and Problem

Canva Official is a remote MCP endpoint (`https://mcp.canva.com/mcp`) that
authenticates every user individually with OAuth 2.1: PKCE S256, a loopback
redirect, single-use refresh tokens, and a client identity that Canva
recognises through Dynamic Client Registration (deprecated but available), a
Developer Portal registration (waitlisted, with a client secret), or a hosted
client metadata document (CIMD, waitlisted). No organisation or service
identity exists. The plugin's credential rule keeps every credential below
MCPorter, inside a Provider process, and the shared route stays
service-neutral. Until now the Canva skill was a configured capability whose
route refused before MCPorter because nothing owned that OAuth custody.

Which module owns the login, the tokens, and the refresh, and how does the
authenticated transport reach Canva without moving a credential above
MCPorter?

## Decision Drivers

- Credentials stay below MCPorter; MCPorter never holds or refreshes a token.
- Each Canva Account has one private session that never crosses users.
- Attended Login opens the system browser once and is never automated.
- Refresh tokens are single use, so concurrent Providers must rotate exactly once.
- Client identity must be able to change mode without changing the session or Provider.
- Authored connector code is Bun and TypeScript; a pinned bridge may carry the transport.
- No generic OAuth framework while Canva is the only OAuth owner.

## Considered Options

- MCPorter's own `oauth` or `refreshable_bearer` server modes.
- Letting the pinned `hyper-mcp-remote` bridge own OAuth with its keyring.
- A Bun session module below MCPorter owning discovery, login, custody, and
  refresh, with the pinned bridge as transport. Recommended.

## Decision

The Canva skill owns `scripts/session/` (interface `index.ts`: `login`,
`accessToken`, `status`, `logout`), `scripts/canva-provider.ts`, and
`scripts/canva-auth.ts`. Sessions live under
`XDG_STATE_HOME/connectors/canva/<account>/` as owned 0700 directories with
exact-0600 files on `bin/private-state.ts`. The Provider probes the pinned
bridge, obtains a token that is fresh now (rotating under a per-account lock
and removing the session on `invalid_grant`), and execs `hyper-mcp-remote`
with `--no-auth` and a literal Bearer header template. Client identity is an
adapter (`dcr` first, `registered` and `cimd` behind it) selected in
`config/oauth.json`. The registry runs the Provider as a stdio server with
the nonsecret `account` selector; the route no longer defers to a dispatcher.

## Consequences

- Positive: OAuth knowledge concentrates in one module with injected fetch,
  browser, clock, randomness, and store, so the contract is proved offline
  against a fake authorization server that computes S256 itself.
- Positive: the refresh token never reaches MCPorter, the bridge, argv, logs,
  stdout, or stderr; the bridge sees one access token per process.
- Positive: `canva-auth` gives login a receipt, status a nonsecret view, and
  logout a revocation outcome, outside any MCPorter call timeout.
- Negative: every call spawns a Provider that reads the session and may
  refresh; a Provider holds no resident token cache.
- Negative: Dynamic Client Registration is deprecated at Canva; the first
  live slice depends on it until a registered or CIMD client is admitted.
- Neutral: the bridge's `--no-auth` and Bearer expansion are qualified only by
  the shared bridge fake until the live canaries run.

## Options and Tradeoffs

### MCPorter OAuth modes

- Good: no Provider process.
- Bad: MCPorter would hold and refresh the token above the credential line,
  and its state is not per-account.

### Bridge-owned OAuth

- Good: no session module.
- Bad: custody moves into the bridge's keyring with no principal binding, no
  logout receipt, and an attended login inside a timed MCPorter call.

### Bun session module below MCPorter

- Good: satisfies every driver; two adapters at every injected seam.
- Bad: more authored code; DCR dependency for the first slice.

## Confirmation

Fixture-proven: `skills/canva/tests/{session,canva-provider,canva-auth,canva}.test.ts`
(discovery, PKCE, state, timeout, exchange, rotation with exactly one request
under concurrency, invalid_grant cleanup, tampered and symlinked state,
Provider custody through the shared bridge fake, the cli-design-check
matrix, and the activated route).

Live-only, each separately authorised, in order, no writes:

1. Fetch the Canva OAuth discovery documents without credentials.
2. Client registration in the decided mode.
3. Attended `canva-auth login` for one account, then `status`.
4. `list --schema --json` through the route; reconcile the four admitted names.
5. One `search-designs`; then one `get-design` of a known design.
6. A refresh canary with a forced expiry skew, confirming one silent rotation.
7. `logout`, then confirm `auth-required`.
8. Fresh Claude Code and Codex discovery per `docs/agents/skills.md`.

Revisit when Canva admits the registered or CIMD client, or when a second
connector needs OAuth (then, and only then, consider a shared owner).

## References

- [Canva MCP access and permissions](https://www.canva.dev/docs/apps/mcp/access/)
- [Canva Connect authentication](https://www.canva.dev/docs/connect/authentication/)
- [Pinned stdio-to-HTTP bridge](https://github.com/hyper-mcp-rs/hyper-mcp-remote/tree/v0.5.0)
- [ADR 0001](0001-route-atlassian-through-mcporter.md)
