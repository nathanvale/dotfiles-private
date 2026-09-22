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
Early Official status attempts returned HTTP 401. On 2026-09-23 both existing
Monash product items authenticated with Basic (initialize HTTP 200); direct
schema discovery returned the same 21-tool catalog for each.

Where should the route live, how can it support two providers without
duplicating secrets, and how can writes avoid duplicate or silently lost
effects when a provider reply is uncertain?

## Decision Drivers

- Use MCPorter as the transport layer.
- Keep the skill, deterministic MCPorter config, and provider policy together.
- Use scoped personal API tokens for Official with `Authorization: Basic
  base64(username:token)`, as Atlassian documents for that credential class.
  Service-account API keys sent as Bearer are a different class and are never
  auto-detected or used as a fallback.
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
  tool surfaces are product-specific; both Providers use the same product
  credential item for one tenant; each server
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

The launcher passes only the non-secret tenant slug to MCPorter. Custody alone
maps tenant and product to an item for both Providers: Jira uses
`JIRA_<TENANT>_API_TOKEN`; Confluence uses
`CONFLUENCE_<TENANT>_API_TOKEN`. The custody child reads the complete selected
item, validates its positive `version`, exact `username`, and trusted site,
then returns a nonsecret Credential Binding tagged with product.
The dispatcher never reads the complete item or maintains a revision field.
Each Provider process rejects a mismatched product before item or executable
effects. The Official Provider re-reads its item, refuses a stale binding,
injects only `credential` below MCPorter, composes Basic from the item's
username and personal token, then runs pinned `hyper-mcp-remote` v0.5.0 with a
literal Basic header template. The raw token never reaches the bridge. Neither
credential value nor header reaches MCPorter, argv, stdout, or stderr. The
endpoint is `https://mcp.atlassian.com/v2/mcp` with `--no-auth`. Community runs
pinned `mcp-atlassian` 0.23.1 with the selected product's environment triplet
from its own item's `username`, `credential`, and custom `site_url` fields.

The dispatcher resolves the Trusted Site Origin from the product item's
`site_url` field only, and accepts an Official `cloudId` only when the
provider's accessible resources include that exact origin.

Before each MCPorter list or call, the dispatcher runs the selected Provider's
local `--preflight`. The Provider revalidates the bound item and its required
executables, then exits without credential injection, downstream process
startup, or provider network transport. Bridge readiness may provision the
checksum-pinned executable from its public release before the Provider starts.
This keeps prerequisite knowledge inside each Provider while preventing
MCPorter 0.13.13 from flattening a child refusal into `offline / Connection
closed`, which would otherwise look like a fallback-eligible transport
failure. MCPorter remains the only data transport after readiness passes.

Writes are journaled. A preview binds the exact input, the shaped provider
selection and arguments, the Object Identity, and the target's current stable revision
(never Jira `updated`; Confluence version) in a private 0700 state directory. An apply
refuses a different resolved provider before custody or transport, re-reads the
target, refuses on any change, records durable intent and a send
mark before the request leaves the process, hands the dispatcher the
journal-bound arguments, and settles from the provider reply or an immediate
read-back. A write whose effect cannot be confirmed is an unknown outcome that
blocks the object until `adjudicate` proves the effect found or proven absent
through the receipt's own provider; read-back absence releases an object only
before the send mark or when a monotonic revision did not move.

Official is the default where the operation is supported. Atlassian Community
is reached directly before startup for `page.comment`, and
automatically for a
read that failed without producing content or explicitly with
`--provider community`, only when an unexpired Parity Attestation matches the
tenant, product, operation, input shape, Trusted Site Origin, normalized
principal, the shared product credential revision, and object semantics exactly.
The dispatcher binds one product item per operation. Eligible read fallback
starts Community only after the Official failure; explicit Community starts
only Community. The `parity` command records one only when Official's user info
names the item's `username` and both providers return the same object. Two-item
attestations from the discarded experiment are unproven and are not migrated.
Authentication, permission, tenant, precondition, partial-answer, and write
failures never fall over. Adjudication binds the receipt's Provider Route.

The live Official schema does not qualify a page comment operation name.
It exposes `createConfluenceContent` but lacks `getConfluenceSpace`, needed by
the current safe page-create preparation, and does not prove `contentType`.
`page.comment` selects Community directly by static capability before any
Official process starts, subject to the current Community write attestation.
Explicit Official selection refuses. No write switches providers after an
attempt or retries. The flat
`?tools=all` Official endpoint is a later,
separately qualified option.

The pinned [Community v0.23.1 Confluence server](https://github.com/sooperset/mcp-atlassian/blob/v0.23.1/src/mcp_atlassian/servers/confluence.py)
does not register `confluence_get_space`. Neither route can safely prepare
`page.create`; the dispatcher refuses it before custody, preview, or send,
including for `{id,key}` and an empty space. No alternate reply shape or
write route is assumed here.

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
- Neutral: the Official bridge uses `--no-auth` to avoid OAuth discovery and
  supplies the selected personal token as Basic. Direct live initialization
  and schema discovery succeeded on 2026-09-23; launcher live reads remain
  unproven.
- Negative: every Harness depends on local MCPorter and Bun.
- Negative: Official adds pinned `hyper-mcp-remote`, provisioned from a
  release with literal archive and extracted-executable SHA-256 digests into
  Connector-owned state by Bun. First-use download has a timeout and streaming
  byte cap; a tampered owned binary is refused, and PATH cannot substitute for
  the pinned bytes. Community depends on `uvx`.
- Negative: a possibly-sent write with no read-back proof, or a stale journal
  meta-lock, blocks its object until an operator acts; this is the fail-closed
  posture and the refusal text says so.
- Neutral: each selected item must carry a custom `site_url` field for the
  tenant guard. Direct Official authentication succeeded for both existing
  Monash product items; the public dispatcher read and live parity remain open.
- Deferred: `page.create` on both providers, Official `page.comment`, the `?tools=all` endpoint, and a generated
  CLI.

## Known Limitations

- Hosted MCP output schemas can be absent or inconsistent. The dispatcher
  confirms every tool against the live schema before a call and fails closed;
  it never assumes a reply shape beyond the fields it checks.
- MCPorter's `--no-oauth` does not control a child bridge. Qualify the pinned
  bridge's `--no-auth` behavior on HTTP 401 before live use.
- MCPorter 0.13.13 omits child stderr from its JSON startup failure. The
  Provider readiness operation therefore owns local prerequisite failures;
  MCPorter's own offline JSON is transport metadata and never counts as
  provider content.
- The 2026-09-23 live catalog names `executeWrite`,
  `createConfluenceContent`, and `updateConfluenceContent`; it does not qualify
  page comment or the `contentType` argument. Other write argument shapes
  still require schema confirmation at dispatch and a live-read canary.
- Read-back matching normalises text and inspects a bounded set of reply
  shapes; a reply that names neither the field nor the object is
  indeterminate and leaves the receipt open.
- The selected product item's title does not establish that its personal token has
  Rovo MCP V2 scopes or that organisation API-token authentication is enabled;
  only a live read-only canary can confirm authorization.
- Personal tokens are not bound to a `cloudId`; the dispatcher matches
  the requested site's origin before using any returned cloud identifier.

## Confirmation

On 22 September, a credential-free loopback probe of the pinned bridge
observed a dummy Basic header on the MCP request. A second probe
returned HTTP 401 and observed one request to the MCP endpoint and no OAuth
discovery request. A credential-free probe of installed MCPorter 0.13.13
showed an excluded `allowedTools` name refused before the stdio child spawned;
that probe is now a version-pinned regression test. These qualify local header,
`--no-auth`, and allow-list behavior only; they do not establish live
Atlassian authentication.

Earlier on 23 September, the checksum-verified `hyper-mcp-remote` v0.5.0 bridge reached
the live Official endpoint with Basic and received an HTTP 401 Bearer
challenge before any Atlassian tool ran. An uncommitted experiment then sent
the existing personal-token items as Bearer. Direct HEAD checks for four
configured Jira and Confluence items and one bridge initialization still
received HTTP 401. The Bearer experiment is rejected: the challenge does not
change the documented personal-token Basic scheme, and these failures do not
prove item type, Rovo MCP V2 scopes, organisation enablement, or product
permissions. The later two-item custody experiment was also rejected: both
Providers use the existing product item. Later on 2026-09-23, both existing
Monash product items initialized Official with Basic at HTTP 200 and returned
the same live 21-tool catalog. That directly proves authentication and schema
discovery for those items, not a public-launcher live read. The catalog lacks
`getConfluenceSpace`; the registry's earlier entry was stale and was removed.
The public launcher canary still stopped at its missing local pinned bridge.
This repair performs no new live provider call.

Offline, fixture-proven (plugin test suite):

- Both Connectors plugin manifests and marketplace versions validate.
- `config/mcporter.json` is the runtime allow-list source; its validated
  vocabulary drives the contract, and the launcher refuses missing allow-lists,
  ad-hoc overrides, and undeclared selectors.
- MCPorter and the dispatcher hold no credential value. The custody child may
  inspect the selected complete item only to emit its nonsecret binding; the
  selected provider receives its scoped value. The product-tagged binding
  selects one of two item titles; mismatches refuse before downstream effects. Official
  composes Basic below MCPorter; Bearer and the raw token are absent from the
  bridge environment.
- Each provider fails closed without `site_url`; the built-in `url` is never
  a tenant origin.
- Dispatcher tenant guard, schema confirmation, read fallback gate, explicit
  Community gate, content-observed refusal, journaled preview and apply,
  provider-stable apply refusal before custody, send-mark ordering, receipt-bound outbound arguments, unknown outcome
  blocking, adjudication, unlock, and parity attestation.
- Both Providers expose a silent readiness operation that validates the
  selected binding and executable prerequisites without injecting a token or
  starting the bridge or Community package. The public dispatcher preserves a
  readiness refusal even when MCPorter would discard the child stderr.

Earlier on 23 September, credential-safe read-only canaries for Jira and
Confluence on both configured tenants stopped before network access with
`refused-precondition`, named the missing pinned bridge, kept the transaction
unchanged, and refused Community fallback. This qualifies failure handling,
not authentication or a live read. The later temporary bridge and Bearer
experiment preceded the later successful Basic initialization and direct
schema discovery described above.

Live-only, still required before acceptance:

1. Confirm organisation API-token-auth enablement and the Official personal
   tokens' Rovo MCP V2 scopes and product permissions with their owners where
   required beyond the observed Monash initialization.
2. Public launcher and credential canary per tenant and product:
   `atlassianUserInfo` through the Official route returns the item's `username`.
3. Read canary per operation: `issue.get`, `issue.search`, `page.get`,
   `page.search` return the expected object for a known key or id.
4. Schema qualification per write tool: the live `tools/list` names each
   write tool and its arguments as the contract expects; record any drift.
5. Parity canary: `parity --operation issue.get` and `page.get` attest for
   one tenant using each product's current Credential Binding.
6. Fresh Claude Code and Codex skill-discovery canaries per
   `docs/agents/skills.md`.
7. A first write, only under separate authorization, against a disposable
   object, followed by read-back and receipt inspection.

## References

- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/main/docs/config.md)
- [MCPorter agent skill pattern](https://github.com/openclaw/mcporter/blob/main/docs/agent-skills.md)
- [MCPorter tool calling](https://github.com/openclaw/mcporter/blob/main/docs/tool-calling.md)
- [MCPorter known issues](https://github.com/openclaw/mcporter/blob/main/docs/known-issues.md)
- [Official Atlassian MCP server](https://github.com/atlassian/atlassian-mcp-server)
- [Atlassian Rovo MCP supported tools](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/)
- [Atlassian API-token authentication](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/)
- [Atlassian Community v0.23.1](https://github.com/sooperset/mcp-atlassian/tree/v0.23.1)
- [Pinned stdio-to-HTTP bridge](https://github.com/hyper-mcp-rs/hyper-mcp-remote/tree/v0.5.0)
- [Credential process lane](../../../../../../.agents/skills/dotfiles/references/sensitive-material-access.md)
- [Skill ownership topology](../../../../../../docs/adr/0003-agent-skills-topology.md)
