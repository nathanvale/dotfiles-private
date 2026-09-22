---
status: proposed
---

# Route Atlassian through the Connectors plugin and MCPorter

## Context and Problem

Jira and Confluence need one shared route for Codex and Claude Code. Registering
Atlassian separately in each Harness duplicates transport, credential, and
troubleshooting state. Atlassian Official is the hosted MCP; Atlassian Community
is the independent `sooperset/mcp-atlassian` connector.

The first candidate injected provider credentials into MCPorter. The dotfiles
credential rule instead requires provider-specific wrappers below MCPorter.
Official live status attempts also returned HTTP 401, so authenticated access
has not been proven.

Where should the route live, how can it support two providers without
duplicating secrets, and how can writes avoid duplicate or silently lost
effects when a provider reply is uncertain?

## Decision Drivers

- Use MCPorter as the transport layer.
- Keep the skill, deterministic MCPorter config, and provider policy together.
- Use Atlassian's v2 endpoint with API-token authentication as Atlassian
  documents it: `Authorization: Basic base64(username:api_token)`. A
  service-account API key sent as Bearer is a different credential type and is
  never auto-detected or used as a fallback.
- Keep credential values below MCPorter and in the 1Password process lane.
- Preserve `mcp-atlassian` as an explicit compatibility route.
- Never automatically retry a write through another provider, and never let a
  lost reply become a duplicate write.
- Fall a read over to the other provider only on exact live parity evidence.
- Avoid generated code until stable repeated workflows justify it.

## Considered Options

- Configure Atlassian separately in each Harness.
- Put Atlassian in the repository-wide MCPorter registry.
- Encapsulate both routes in a Connectors plugin skill with a semantic
  dispatcher. Recommended.

Direct credential injection into MCPorter violates the credential rule. A
dynamic MCPorter header helper would need a separate upstream change. A
generated standalone CLI is an optional later interface, not a route owner.

## Recommendation

The Connectors plugin's `atlassian` skill owns:

- `config/mcporter.json`, with imports disabled;
- four static stdio server definitions, one per provider and product:
  `atlassian-official-jira`, `atlassian-official-confluence`,
  `atlassian-community-jira`, and `atlassian-community-confluence`, because
  API tokens, credential items, and tool surfaces are product-specific; each
  carries an exact-name `allowedTools` list of primary read and write tools
  and never a broad dispatcher;
- Bun/TypeScript provider processes and one custody child below MCPorter;
- a Bun semantic dispatcher (`scripts/atlassian-dispatch.ts`) that is the only
  supported entrypoint: ten Atlassian Operations, tenant guard, live schema
  confirmation, provider selection, the write journal, and the operator
  commands `receipts`, `receipt`, `adjudicate`, `unlock`, and `parity`;
- the read fallback and write policy below.

Every call passes the plugin config explicitly through the shared
`bin/provider-route.ts` launcher. MCPorter therefore uses only that file and
cannot merge an ambient home, project, Codex, or Claude server. The launcher
accepts only list/call on the selected provider, rejects ad-hoc server, config,
header, environment, and stdio overrides, and refuses a registry whose servers
lack an explicit `allowedTools` array.

The launcher passes only the non-secret tenant slug to MCPorter. Each product
route maps the slug and its static product to the 1Password item
`JIRA_<TENANT>_API_TOKEN` or `CONFLUENCE_<TENANT>_API_TOKEN`; that mapping has
one owner in the provider common module. The dispatcher invokes a custody child
with only that tenant and product; the child reads the complete mapped item,
validates its top-level positive `version` and exact `username`, and returns
only a namespaced nonsecret principal/version binding. The dispatcher never
reads the complete item or asks an operator to maintain a revision field. The Official provider reads the
item's `username` as metadata, injects only the `credential` field into its own
injected phase through the credential helper, composes the Basic value inside
that process, and execs a pinned `hyper-mcp-remote` v0.5.0 child with a
literal header template that the bridge expands. The raw token never reaches
the bridge environment. The endpoint is `https://mcp.atlassian.com/v2/mcp`
with `--no-auth`. The Community route runs pinned `mcp-atlassian` 0.23.1 below
MCPorter with only the selected product's environment triplet, built from the
item's `username`, `credential`, and custom `site_url` fields, failing closed
when any is absent.

The dispatcher resolves the Trusted Site Origin from the product item's
`site_url` field only, and accepts an Official `cloudId` only when the
provider's accessible resources include that exact origin.

Writes are journaled. A preview binds the exact input, the shaped provider
arguments, the Object Identity, and the target's current stable revision
(never Jira `updated`; Confluence version) in a private 0700 state directory. An apply
re-reads the target, refuses on any change, records durable intent and a send
mark before the request leaves the process, hands the dispatcher the
journal-bound arguments, and settles from the provider reply or an immediate
read-back. A write whose effect cannot be confirmed is an unknown outcome that
blocks the object until `adjudicate` proves the effect found or proven absent
through the receipt's own provider; read-back absence releases an object only
before the send mark or when a monotonic revision did not move.

Official is the default. Atlassian Community is reached, automatically for a
read that failed without producing content or explicitly with
`--provider community`, only when an unexpired Parity Attestation matches the
tenant, product, operation, input shape, Trusted Site Origin, principal, and
object semantics exactly. The `parity` command records one only when Official's
user info names the item's `username` and both providers return the same
object. Authentication, permission, tenant, precondition, partial-answer, and
write failures never fall over.

`page.comment` is unavailable on Official: the default endpoint reaches
`createConfluenceComment` only through `executeWrite`, which the allow-list
policy excludes. Community carries it. The flat `?tools=all` Official endpoint
is a later, separately qualified option.

Do not generate an Atlassian CLI initially. Revisit a narrow generated CLI only
after two to four stable workflows emerge.

The Connectors plugin was selected for a credential-safe repair on
21 September 2026. This ADR remains proposed until the provider wrappers,
bridge, and live route are qualified.

## Options and Tradeoffs

| Driver | Separate Harness routes | Repository-wide registry | Connectors plugin |
| --- | --- | --- | --- |
| MCPorter transport | Possible, but duplicated in each Harness | Shared | Shared |
| Skill, config, and policy together | No | No, policy remains elsewhere | Yes |
| Official default with gated Community | Duplicated per Harness | Central config, separate skill policy | One dispatcher policy and two named providers |
| Credentials below MCPorter | Possible with two wrappers | Possible with wrappers | Provider wrappers beside the skill |
| No duplicate or cross-provider write | Repeated policy | Policy outside registry | Journal and dispatcher own it |
| Avoid generated CLI initially | Yes | Yes | Yes |

The plugin adds a dependency on a packaged skill and its dispatcher, but gives
both Harnesses one inspectable owner. It does not itself establish that either
provider accepts the existing credentials.

## Consequences

- Positive: Codex and Claude Code consume the same skill and registry.
- Positive: explicit config, `imports: []`, and mandatory allow-lists prevent
  stale route merging and any broad dispatcher exposure.
- Positive: 1Password remains the credential source of truth; provider
  credentials never reach MCPorter or the envelope.
- Positive: a lost write reply cannot become a duplicate, and an unknown
  outcome is visible and adjudicable.
- Neutral: the Official bridge uses `--no-auth` to avoid OAuth discovery; its
  credential-free loopback behavior is locally qualified, while live
  authentication, schemas, and content reads remain unproven.
- Negative: every Harness depends on local MCPorter and Bun.
- Negative: Official adds pinned `hyper-mcp-remote`; Community depends on `uvx`.
- Negative: a possibly-sent write with no read-back proof, or a stale journal
  meta-lock, blocks its object until an operator acts; this is the fail-closed
  posture and the refusal text says so.
- Neutral: Community and the Official tenant guard remain unavailable until each
  product item carries a custom `site_url` field.
- Deferred: Official `page.comment`, the `?tools=all` endpoint, and a generated
  CLI.

## Known Limitations

- Hosted MCP output schemas can be absent or inconsistent. The dispatcher
  confirms every tool against the live schema before a call and fails closed;
  it never assumes a reply shape beyond the fields it checks.
- MCPorter's `--no-oauth` does not control a child bridge. Qualify the pinned
  bridge's `--no-auth` behavior on HTTP 401 before live use.
- Write tool argument names come from Atlassian's v2 skill examples and the
  v0.23.1 Community source, not from a published schema. A live `tools/list`
  must confirm them; an unrecognized argument is refused at confirmation, not
  silently dropped.
- Read-back matching normalises text and inspects a bounded set of reply
  shapes; a reply that names neither the field nor the object is
  indeterminate and leaves the receipt open.
- The credential item's title does not establish that its value is an API
  token accepted with Basic authentication on the v2 endpoint; organisation
  admin enablement and scopes are prerequisites that only a live read-only
  canary can confirm.
- Service-account keys are not bound to a `cloudId`; the dispatcher matches
  the requested site's origin before using any returned cloud identifier.

## Confirmation

On 22 September, a credential-free loopback probe of the pinned bridge
observed the exact dummy Basic header on the MCP request. A second probe
returned HTTP 401 and observed one request to the MCP endpoint and no OAuth
discovery request. A credential-free probe of installed MCPorter 0.13.13
showed an excluded `allowedTools` name refused before the stdio child spawned;
that probe is now a version-pinned regression test. These qualify local header,
`--no-auth`, and allow-list behavior only; they do not establish live
Atlassian authentication.

Offline, fixture-proven (plugin test suite):

- Both Connectors plugin manifests and marketplace versions validate.
- `config/mcporter.json` is the runtime allow-list source; its validated
  vocabulary drives the contract, and the launcher refuses missing allow-lists,
  ad-hoc overrides, and undeclared selectors.
- MCPorter and the dispatcher hold no credential value. The custody child may
  inspect the selected complete item only to emit its nonsecret binding; the
  selected provider receives its scoped value. Official receives Basic and
  never Bearer or the raw token.
- Each provider fails closed without `site_url`; the built-in `url` is never
  a tenant origin.
- Dispatcher tenant guard, schema confirmation, read fallback gate, explicit
  Community gate, content-observed refusal, journaled preview and apply,
  send-mark ordering, receipt-bound outbound arguments, unknown outcome
  blocking, adjudication, unlock, and parity attestation.

Live-only, still required before acceptance:

1. Bridge and credential canary per tenant and product: `atlassianUserInfo`
   through the Official route returns the item's `username`.
2. Read canary per operation: `issue.get`, `issue.search`, `page.get`,
   `page.search` return the expected object for a known key or id.
3. Schema qualification per write tool: the live `tools/list` names each
   write tool and its arguments as the contract expects; record any drift.
4. Parity canary: `parity --operation issue.get` and `page.get` attest for
   one tenant; Community items carry `site_url`.
5. Fresh Claude Code and Codex skill-discovery canaries per
   `docs/agents/skills.md`.
6. A first write, only under separate authorization, against a disposable
   object, followed by read-back and receipt inspection.

## References

- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/main/docs/config.md)
- [MCPorter agent skill pattern](https://github.com/openclaw/mcporter/blob/main/docs/agent-skills.md)
- [MCPorter tool calling](https://github.com/openclaw/mcporter/blob/main/docs/tool-calling.md)
- [MCPorter known issues](https://github.com/openclaw/mcporter/blob/main/docs/known-issues.md)
- [Official Atlassian MCP server](https://github.com/atlassian/atlassian-mcp-server)
- [Atlassian Rovo MCP supported tools](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/)
- [Atlassian Community v0.23.1](https://github.com/sooperset/mcp-atlassian/tree/v0.23.1)
- [Pinned stdio-to-HTTP bridge](https://github.com/hyper-mcp-rs/hyper-mcp-remote/tree/v0.5.0)
- [Credential process lane](../../../../../../.agents/skills/dotfiles/references/sensitive-material-access.md)
- [Skill ownership topology](../../../../../../docs/adr/0003-agent-skills-topology.md)
