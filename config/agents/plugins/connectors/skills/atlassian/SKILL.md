---
name: atlassian
description: Read and search Jira issues and Confluence pages; create, update, or comment on Jira issues; and update or comment on Confluence pages for one named tenant through the skill's Bun dispatcher. Use for Jira tickets, Confluence pages, Atlassian links, JQL, or CQL. Atlassian Official is the default; Atlassian Community only behind live parity evidence. Page creation, deletion, and administration are outside the available route.
---

# Atlassian

The dispatcher is the only supported entrypoint. It owns tenant selection, the
trusted-origin guard, live schema confirmation, provider selection, and the
write journal. Keep native Harness MCP tools, direct REST calls, other Jira
CLIs, raw MCPorter calls, and browser automation outside this route.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
DISPATCH="$SKILL_DIR/scripts/atlassian-dispatch.ts"
bun "$DISPATCH" --discover
```

Every call prints one JSON envelope on stdout and exits 0 on success, 2 for a
usage refusal, 3 for a domain refusal or failure, 4 for a schema refusal. Read
`result.causeCode`, `result.transactionState`, `result.effects`, and
`result.repairAction`; `result.provenance` lists every provider call made.

## Tenant

Require an explicit lowercase tenant slug for every run. If the request does
not identify the site unambiguously, ask the operator which tenant to use. Never
infer one tenant from issue keys, page titles, or the last call.

Both Providers select the same product item in the `API Credentials` vault:
Jira uses `JIRA_<TENANT>_API_TOKEN`; Confluence uses
`CONFLUENCE_<TENANT>_API_TOKEN`. Each item needs a `username` and custom
`site_url` naming the site, for example `https://example.atlassian.net`.
Custody returns only product-tagged, nonsecret metadata to the dispatcher. Official
uses the scoped personal token as Basic `username:token` below MCPorter. The
built-in `url` field is token management and is never used. A
missing or malformed `site_url` stops every operation with `site-unresolved`
before any provider call. Official requests proceed only when the provider's
accessible resources include that exact origin (`refused-tenant` otherwise).

## Reads

```sh
bun "$DISPATCH" --tenant <tenant> issue.get    --input '{"issueKey":"PROJ-1","fields":["summary"]}'
bun "$DISPATCH" --tenant <tenant> issue.search --input '{"jql":"project = PROJ","maxResults":10}'
bun "$DISPATCH" --tenant <tenant> page.get     --input '{"pageId":"123","detail":"full"}'
bun "$DISPATCH" --tenant <tenant> page.search  --input '{"cql":"type = page AND title ~ \"roadmap\"","maxResults":10}'
```

- Inputs are the neutral keys above only; unknown keys refuse with `input-invalid`.
- Start searches at 10 results. Fetch the issue or page after search; a snippet is not the source.
- `capability-unavailable` means the live schema did not expose the tool or its
  arguments as documented. Report it; do not guess another tool.
- Provider text never reaches the envelope. Repair guidance is fixed per cause.

## Writes

Every write is two calls with identical input. The preview binds the exact
provider selection and arguments, stable candidate or comment identifiers,
and the target's current revision; the apply refuses when that evidence or
the selected provider moved, before credential custody or a provider starts.
Preview, adjudication, unlock, and parity persistence use the canonical
`repository-local` effect class; apply uses `external`.

```sh
bun "$DISPATCH" --tenant <tenant> issue.comment --input '{"issueKey":"PROJ-1","body":"..."}' --preview
bun "$DISPATCH" --tenant <tenant> issue.comment --input '{"issueKey":"PROJ-1","body":"..."}' --apply <previewId>
```

| Operation | Input keys | Revision bound |
| --- | --- | --- |
| `issue.create` | `projectKey`, `issueType`, `summary`, `description?`, `assignee?` | none |
| `issue.update` | `issueKey`, `fields` (flat object) | provider stable revision, never `updated` alone |
| `issue.comment` | `issueKey`, `body` | none |
| `page.create` | `space` (`{key}` or `{id, key}`), `title`, `body`, `parentId?` | unavailable on both routes |
| `page.update` | `pageId`, `body`, `title?`, `versionMessage?` | page version |
| `page.comment` | `pageId`, `body` | page version |

Rules the dispatcher enforces; state them when they refuse:

- An explicit request for one named create, update, or comment authorizes that
  operation. For an inferred target, ambiguous content, or a batch, show the
  preview envelope and wait for confirmation before `--apply`.
- A preview expires after 15 minutes and is consumed by one apply
  (`refused-preview`).
- `page.create` refuses with `operation-unavailable` before custody, preview,
  or send on either route. Official lacks the qualified space read; pinned
  Community v0.23.1 does not register `confluence_get_space`. No empty-space
  creation path is qualified.
- `page.update` reads the page with full detail first and sends the Official
  snapshot token of the version it read. Community keeps the current title when
  `title` is omitted.
- `page.comment` selects Community before startup because the live Official
  schema has no qualified comment operation. Both Community page writes need
  current `page.get` parity. Explicit `--provider official` refuses with
  `operation-unavailable` before any process starts.
- Never retry a write through the other provider. Never fan one write out to both.

### Unknown outcomes and adjudication

`transactionState: "unknown"` with `causeCode: "outcome-unknown"` means the
request may have reached the provider without a confirmed effect. The object is
blocked for every write until the receipt resolves. Do not retry. Run:

```sh
bun "$DISPATCH" --tenant <tenant> receipts
bun "$DISPATCH" --tenant <tenant> receipt    --run <runId>
bun "$DISPATCH" --tenant <tenant> adjudicate --run <runId> --input '<the identical input>'
```

Adjudicate reads the object back through the receipt's own provider. It settles
`completed` only when a new stable effect id or revision is observed after the
preview baseline. A historical matching title, summary, or comment is not an
effect. `unchanged` needs a stable revision that did not move or an unsent
receipt; plain absence after a possible send remains unknown. A route that
does not expose the needed stable ids or revision is `capability-unavailable`
until live schema qualification proves it. It never marks success by hand. `unlock --run <runId-or-previewId>` clears a dead process's lock only;
`refused-state` names a journal condition an operator must inspect by hand.

## Community and parity

Official is the default for supported operations. Default `page.comment`
selects Community directly before startup. Community is also
selectable with `--provider community`,
and reads may fall over to it automatically, only when an unexpired Parity
Attestation exists for the same tenant, product, operation, input shape,
trusted origin, normalized principal, and current revision of the shared
product Credential Binding. The dispatcher binds that item once per operation.
Eligible fallback starts Community only after Official fails; explicit
Community selection starts only Community. Record an
attestation with a read that both Providers can answer:

```sh
bun "$DISPATCH" --tenant <tenant> parity --operation issue.get --input '{"issueKey":"PROJ-1"}'
bun "$DISPATCH" --tenant <tenant> parity --operation page.get  --input '{"pageId":"123"}'
```

Parity is refused (`refused-parity`) unless Official's user info names the
item's `username` and both Providers return the same object identity. Rotation
of the shared item invalidates the attestation; two-item records from the
discarded experiment are unproven.
Authentication, permission, tenant, precondition, and partial-answer failures
never fall over, with or without an attestation. Community writes require the
product's base-read attestation (`issue.get` or `page.get`).

## Proof states

Report which state each claim reached:

- Configured: registry, route, and items named; proven by tests here.
- Fixture-tested: dispatcher, journal, providers, and route behaviour under fakes.
- Schema-qualified: the live `tools/list` exposed the documented tool and arguments.
- Authenticated: a live `atlassianUserInfo` or Community profile succeeded.
- Live-read-proven, live-write-proven: external outcomes separately observed; a write needs separate authorization.

On 2026-09-23, both existing Monash product items authenticated to Official
with Basic (initialize HTTP 200), and direct schema discovery returned the same
21-tool catalog. It included `executeWrite`, `createConfluenceContent`, and
`updateConfluenceContent`, but not `getConfluenceSpace`. The catalog did not
qualify a page comment operation name or `contentType`. These are direct
authentication and schema observations; the public launcher has no live-read
proof. Its earlier preflight stopped at a missing local pinned bridge. The
Connectors runtime now provisions the archive- and executable-digest-pinned
bridge in its own state directory on first use, with a bounded download, or
through `bun run bridge:install` in the plugin. A PATH executable is not used.

Prerequisites are declared by the provider runtime and its pinned registry.

## Completion

Report the tenant, provider, operation, and exact objects read or changed; the
proof state reached; verified links when a URL was returned; every refusal
cause met; and any receipt left open with its `runId`.
