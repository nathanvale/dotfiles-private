---
status: proposed
---

# Route Atlassian through the Connectors plugin and MCPorter

## Context and Problem

Jira and Confluence need one shared route for Codex and Claude Code. Registering
Atlassian separately in each Harness duplicates transport, credential, and
troubleshooting state.

Two Providers were candidates: Atlassian Official, the Atlassian-operated
hosted MCP reached through a pinned stdio-to-HTTP bridge, and Atlassian
Community, the independent `sooperset/mcp-atlassian` package run locally with
an API token. The first candidate injected provider credentials into MCPorter.
The dotfiles credential rule instead requires provider-specific wrappers below
MCPorter. Official live status attempts returned HTTP 401, its `page.comment`
was reachable only through a broad dispatcher tool, and keeping both Providers
active required a parity attestation store, a read fallback gate, and a
per-Provider argument shape for every write, none of which could be qualified
without live Official access.

Where should the route live, how does one Provider keep credentials below
MCPorter, and how can writes avoid duplicate or silently lost effects when a
provider reply is uncertain?

## Decision Drivers

- Use MCPorter as the transport layer.
- Keep the skill, deterministic MCPorter config, and provider policy together.
- Keep credential values below MCPorter and in the 1Password process lane.
- Run exactly one active Provider, so every operation has one tool, one
  argument shape, and one live schema to qualify.
- Never automatically retry a write, and never let a lost reply become a
  duplicate write.
- Bind every call to one tenant's product credential item and Trusted Site
  Origin; never infer a site from a provider reply.
- Keep persisted records from a removed Provider readable and blocking, and
  never reinterpret them through the active Provider.
- Avoid generated code until stable repeated workflows justify it.

## Considered Options

- Configure Atlassian separately in each Harness.
- Put Atlassian in the repository-wide MCPorter registry.
- Encapsulate the route in a Connectors plugin skill with a semantic
  dispatcher over Atlassian Community only. Recommended.
- The same plugin skill with Official as default and Community behind parity
  evidence. Superseded by the one-Provider recommendation on 23 September 2026.

Direct credential injection into MCPorter violates the credential rule. A
dynamic MCPorter header helper would need a separate upstream change. A
generated standalone CLI is an optional later interface, not a route owner.

## Recommendation

The Connectors plugin's `atlassian` skill owns:

- `config/mcporter.json`, with imports disabled;
- two static stdio server definitions, one per product:
  `atlassian-community-jira` and `atlassian-community-confluence`, because
  API tokens, credential items, and tool surfaces are product-specific; each
  carries an exact-name `allowedTools` list of primary read and write tools
  and never a broad dispatcher; the contract refuses a registry naming any
  other server;
- one Bun/TypeScript Community Provider process and one custody child below
  MCPorter;
- a Bun semantic dispatcher (`scripts/atlassian-dispatch.ts`) that is the only
  supported entrypoint: fifteen Atlassian Operations (four reads; create,
  update, comment, comment edit, attach, and delete per product), tenant and
  origin binding, live schema confirmation, the Upload Outbox, the write
  journal, and the operator commands `receipts`, `receipt`, `adjudicate`, and
  `unlock`;
- the write policy below.

Every call passes the plugin config explicitly through the shared
`bin/provider-route.ts` launcher. MCPorter therefore uses only that file and
cannot merge an ambient home, project, Codex, or Claude server. The launcher
accepts only list/call on the selected provider, rejects ad-hoc server, config,
header, environment, and stdio overrides, and refuses a registry whose servers
lack an explicit `allowedTools` array.

The launcher passes only the non-secret tenant slug to MCPorter. Each product
route maps the slug and its static product to the 1Password item
`JIRA_<TENANT>_API_TOKEN` or `CONFLUENCE_<TENANT>_API_TOKEN`; that mapping has
one owner in the custody module (`scripts/custody/`, imported only through its
`index.ts`). The dispatcher invokes the module's custody child with only that
tenant and product; the child reads the complete mapped item, validates its
top-level positive `version`, exact `username`, and custom `site_url`, and
returns only a nonsecret principal, item revision, and Trusted Site Origin
(the Credential Binding). The dispatcher never reads the complete item. The
Community Provider recovers the binding through the same module, re-reads the
item and refuses a stale binding, and execs pinned `mcp-atlassian` 0.23.1
through `uvx` with only the selected product's environment triplet, built
from the item's `username`, `credential`, and `site_url` fields, failing
closed when any is absent. The credential value never leaves that process.

Before each MCPorter list or call, the dispatcher runs the Provider's local
`--preflight`. The Provider revalidates the bound item and its required
executable, then exits without downstream process startup or network
transport. A refusal is translated before MCPorter starts. This keeps
prerequisite knowledge inside the Provider while preventing MCPorter 0.13.13
from flattening a child refusal into `offline / Connection closed`. MCPorter
remains the only data transport after readiness passes.

Every failure is final. A read makes one attempt on its product route;
authentication, permission, not-found, transport, and schema failures are
reported with a fixed cause and fixed repair text, and the dispatcher never
retries or selects another route.

Writes are journaled. A preview binds the exact input, the shaped provider
arguments, the Object Identity, the Provider name, and the target's current
revision (Confluence page version; for Jira, which exposes no monotonic issue
revision, the issue or comment `updated` timestamp, which detects a moved
target but never proves an effect) in a private 0700 state directory. An apply re-reads the target, refuses on any change, records
durable intent and a send mark before the request leaves the process, hands
the dispatcher the journal-bound arguments, and settles from the provider
reply or an immediate read-back. A write whose effect cannot be confirmed is
an unknown outcome that blocks the object until `adjudicate` proves the effect
found or proven absent through the product route; read-back absence releases
an object only before the send mark or when the bound revision did not move.
An update completes only when the requested values, which the preview proved
absent, are found; a delete completes only when the read-back afterwards is
refused as not-found. Uploads are staged into the tenant's Upload Outbox under
a content digest, and the Provider starts in that outbox because the Community
package confines upload sources to its working directory.

Persisted previews and receipts name their Provider. The journal reads
`official` as a retired name: such records list and display normally and keep
blocking their object, while apply, adjudicate, and unlock refuse them
(`preview-provider-retired`, `receipt-provider-retired`) before any binding or
provider call. They are resolved by hand against the live object.

Do not generate an Atlassian CLI initially. Revisit a narrow generated CLI only
after two to four stable workflows emerge.

The Connectors plugin was selected for a credential-safe repair on
21 September 2026. Nathan approved the one-Provider direction on 23 September
2026. This ADR remains proposed until the Community route is live-qualified.

## Options and Tradeoffs

| Driver | Separate Harness routes | Repository-wide registry | Plugin, Official plus Community | Plugin, Community only |
| --- | --- | --- | --- | --- |
| MCPorter transport | Duplicated in each Harness | Shared | Shared | Shared |
| Skill, config, and policy together | No | No, policy remains elsewhere | Yes | Yes |
| One active Provider per operation | Per Harness choice | Central config, separate policy | No: parity store and fallback gate | Yes: one tool and schema per operation |
| Credentials below MCPorter | Possible with wrappers | Possible with wrappers | Two Provider wrappers and a bridge | One Provider wrapper |
| No duplicate or retried write | Repeated policy | Policy outside registry | Journal owns it; two argument shapes | Journal owns it; one argument shape |
| Retired records safe | Not applicable | Not applicable | Not applicable | Readable, blocking, refused |
| Avoid generated CLI initially | Yes | Yes | Yes | Yes |

The plugin adds a dependency on a packaged skill and its dispatcher, but gives
both Harnesses one inspectable owner. Dropping Official removes the bridge,
the parity store, and the fallback gate, and gives up the hosted Provider's
own authorization model; it does not itself establish that Community accepts
the existing credentials.

## Consequences

- Positive: Codex and Claude Code consume the same skill and registry.
- Positive: explicit config, `imports: []`, and mandatory allow-lists prevent
  stale route merging and any broad dispatcher exposure.
- Positive: 1Password remains the credential source of truth; provider
  credentials never reach MCPorter or the envelope.
- Positive: a lost write reply cannot become a duplicate, and an unknown
  outcome is visible and adjudicable.
- Positive: one Provider means one tool vocabulary, one argument shape, and one
  live schema to qualify per operation, and no cross-Provider retry surface.
- Negative: every Harness depends on local MCPorter, Bun, and `uvx`.
- Negative: there is no second Provider to reach when Community is down or
  refuses; the operation fails closed and says so.
- Negative: a possibly-sent write with no read-back proof, or a stale journal
  meta-lock, blocks its object until an operator acts; this is the fail-closed
  posture and the refusal text says so.
- Negative: an unresolved receipt recorded through the retired Official route
  blocks its object until resolved by hand.
- Negative: a receipt that binds no revision and whose read-back stays absent
  after a possible send can only be resolved by hand; every operation now
  binds one where the Provider exposes it.
- Neutral: a staged upload lives in the Upload Outbox until the next staging
  finds it untouched for over an hour and prunes it.
- Neutral: each product item needs `username`, `credential`, and a custom
  `site_url` field.
- Deferred: a generated CLI.

## Known Limitations

- MCP output schemas can be absent or inconsistent. The dispatcher confirms
  every tool against the live schema before a call and fails closed; it never
  assumes a reply shape beyond the fields it checks.
- MCPorter 0.13.13 omits child stderr from its JSON startup failure. The
  Provider readiness operation therefore owns local prerequisite failures;
  MCPorter's own offline JSON is transport metadata and never counts as
  provider content.
- Tool argument names come from the v0.23.1 Community source, not from a
  published schema. A live `tools/list` must confirm them; an unrecognized
  argument is refused at confirmation, not silently dropped.
- Jira exposes no issue revision; `updated` has second resolution and is used
  only to detect a moved target. Update proof rests on the preview's no-op
  refusal plus the requested values being found afterwards.
- Community v0.23.1 has no comment deletion, no `confluence_get_space`, and no
  space instruction metadata; the Confluence instruction gate of the earlier
  two-Provider design is therefore gone.
- The Community Jira attachment record carries no id; the id is taken from its
  content url.
- `page.create` knows the space only by key, the one identity the Community
  route exposes; the Object Identity uses it.
- Read-back matching normalises text and inspects a bounded set of reply
  shapes; a reply that names neither the field nor the object is
  indeterminate and leaves the receipt open.

## Confirmation

Offline, fixture-proven (plugin test suite, 23 September 2026):

- Both Connectors plugin manifests and marketplace versions validate.
- `config/mcporter.json` is the runtime allow-list source; its validated
  vocabulary drives the contract, which refuses a broad tool, a missing
  product route, or a re-added Official route; the launcher refuses missing
  allow-lists, ad-hoc overrides, and undeclared selectors.
- MCPorter and the dispatcher hold no credential value. The custody child may
  inspect the selected complete item only to emit its nonsecret binding; the
  Provider receives the credential inside its own process and never on a
  public stream.
- The Provider fails closed without `username`, `credential`, or `site_url`;
  the built-in `url` is never a tenant origin.
- Dispatcher tenant parsing, origin binding, schema confirmation, single-attempt
  reads, fixed repair text, journaled preview and apply, send-mark ordering,
  receipt-bound outbound arguments, unknown outcome blocking, adjudication,
  unlock, and refusal of retired Official previews and receipts by apply,
  adjudicate, and unlock with their records byte-for-byte unchanged.
- The Provider's silent local readiness operation validates the selected
  binding and `uvx` without starting the package, and the public dispatcher
  preserves that refusal even when MCPorter would discard the child stderr.

Live, Jira route, one configured tenant, 23 September 2026:

- Authenticated and schema-qualified: the live `tools/list` named the five
  allow-listed Jira tools with the contract's argument names; `issue.search`
  and `issue.get` returned known objects for the item's principal.
- Live-write-proven under Nathan's authorization: `issue.create` of a
  disposable task and two `issue.comment` writes on it completed through
  preview and apply, each with a receipt-bound effect id.
- The first apply settled `outcome-unknown` and blocked the object: MCPorter
  `--output json` returns the tool text as one JSON string under `result`,
  and Community search results carry `summary` and `issue_type` beside the
  key, so neither the reply nor the read-back yielded an effect. `adjudicate`
  with the identical input, after the reply helpers learned both shapes,
  completed the receipt with the created key. Both shapes are now fixture
  tests. The fail-closed path behaved as designed: no duplicate was sent.
- Not exposed on the route: comment deletion (absent from mcp-atlassian at
  every version), attachment deletion, transitions, and links.

Live, both products, one configured tenant, later on 23 September 2026, all
under Nathan's authorization against disposable objects:

- Jira: `issue.update` (summary and description, then assignee by email),
  `issue.comment.update`, and `issue.attach` completed with receipt-bound
  effects. `issue.delete` was refused by the site (`refused-auth`, the
  principal lacks Delete Issues in that project) and settled unchanged.
- Confluence: `page.search`, `page.get`, `page.create`, `page.update`,
  `page.comment`, `page.attach`, and `page.delete` completed; the delete was
  adjudicated to completed from the not-found read-back.
- Three reply-shape gaps surfaced and were fixed with fixture tests: the
  Community package confines uploads to its working directory (hence the
  Upload Outbox), its Jira attachment record has no id, and its page read
  wraps the page under `metadata` and reports a missing page in band as
  `{error}`. One attachment receipt from before the outbox bound no revision
  and was resolved by hand (moved aside) after read-back proved no upload.

Live-only, still required before acceptance:

1. `issue.delete` against a project where the principal holds Delete Issues.
2. Fresh Claude Code and Codex skill-discovery canaries per
   `docs/agents/skills.md`.
3. A second tenant, to prove the route selection and outbox are per tenant.

## References

- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/main/docs/config.md)
- [MCPorter agent skill pattern](https://github.com/openclaw/mcporter/blob/main/docs/agent-skills.md)
- [MCPorter tool calling](https://github.com/openclaw/mcporter/blob/main/docs/tool-calling.md)
- [MCPorter known issues](https://github.com/openclaw/mcporter/blob/main/docs/known-issues.md)
- [Atlassian Community v0.23.1](https://github.com/sooperset/mcp-atlassian/tree/v0.23.1)
- [Credential process lane](../../../../../../.agents/skills/dotfiles/references/sensitive-material-access.md)
- [Skill ownership topology](../../../../../../docs/adr/0003-agent-skills-topology.md)
