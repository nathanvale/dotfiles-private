---
name: atlassian
description: Read, search, create, update, or comment on Jira issues and Confluence pages for one named tenant through the skill's Bun dispatcher. Use for Jira tickets, Confluence pages, Atlassian links, JQL, or CQL. Atlassian Official is the default; Atlassian Community only behind live parity evidence. Deletion and administration are outside this skill.
---

# Atlassian

The dispatcher is the only supported entrypoint. It owns tenant selection, the
trusted-origin guard, live schema confirmation, provider selection, and the
write journal. Keep native Harness MCP tools, direct REST calls, other Jira
CLIs, raw MCPorter calls, and browser automation outside this route.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
DISPATCH="bun $SKILL_DIR/scripts/atlassian-dispatch.ts"
$DISPATCH --discover
```

Every call prints one JSON envelope on stdout and exits 0 on success, 2 for a
usage refusal, 3 for a domain refusal or failure, 4 for a schema refusal. Read
`result.causeCode`, `result.transactionState`, `result.effects`, and
`result.repairAction`; `result.provenance` lists every provider call made.

## Tenant

Require an explicit lowercase tenant slug for every run. If the request does
not identify the site unambiguously, ask the operator which tenant to use. Never
infer one tenant from issue keys, page titles, or the last call.

The tenant's product credential items (`JIRA_<TENANT>_API_TOKEN`,
`CONFLUENCE_<TENANT>_API_TOKEN` in the `API Credentials` vault) must carry a
`username` field and a custom `site_url` field naming the site, for example
`https://example.atlassian.net`. The dispatcher reads only those two fields as
metadata; the built-in `url` field is token management and is never used. A
missing or malformed `site_url` stops every operation with `site-unresolved`
before any provider call. Official requests proceed only when the provider's
accessible resources include that exact origin (`refused-tenant` otherwise).

## Reads

```sh
$DISPATCH --tenant <tenant> issue.get    --input '{"issueKey":"PROJ-1","fields":["summary"]}'
$DISPATCH --tenant <tenant> issue.search --input '{"jql":"project = PROJ","maxResults":10}'
$DISPATCH --tenant <tenant> page.get     --input '{"pageId":"123","detail":"full"}'
$DISPATCH --tenant <tenant> page.search  --input '{"cql":"type = page AND title ~ \"roadmap\"","maxResults":10}'
```

- Inputs are the neutral keys above only; unknown keys refuse with `input-invalid`.
- Start searches at 10 results. Fetch the issue or page after search; a snippet is not the source.
- `capability-unavailable` means the live schema did not expose the tool or its
  arguments as documented. Report it; do not guess another tool.
- Provider text never reaches the envelope. Repair guidance is fixed per cause.

## Writes

Every write is two calls with identical input. The preview binds the exact
provider arguments, stable candidate or comment identifiers, and the target's
current revision; the apply refuses when any of that evidence moved.

```sh
$DISPATCH --tenant <tenant> issue.comment --input '{"issueKey":"PROJ-1","body":"..."}' --preview
$DISPATCH --tenant <tenant> issue.comment --input '{"issueKey":"PROJ-1","body":"..."}' --apply <previewId>
```

| Operation | Input keys | Revision bound |
| --- | --- | --- |
| `issue.create` | `projectKey`, `issueType`, `summary`, `description?`, `assignee?` | none |
| `issue.update` | `issueKey`, `fields` (flat object) | provider stable revision, never `updated` alone |
| `issue.comment` | `issueKey`, `body` | none |
| `page.create` | `space` (`{id}`, `{key}`, or both), `title`, `body`, `parentId?` | none |
| `page.update` | `pageId`, `body`, `title?`, `versionMessage?` | page version |
| `page.comment` | `pageId`, `body` | none |

Rules the dispatcher enforces; state them when they refuse:

- An explicit request for one named create, update, or comment authorizes that
  operation. For an inferred target, ambiguous content, or a batch, show the
  preview envelope and wait for confirmation before `--apply`.
- A preview expires after 15 minutes and is consumed by one apply
  (`refused-preview`).
- `page.create` needs the space's numeric id. A key alone is resolved from any
  readable page in that space; if none is found, `space-unresolved` asks for
  `space: {"id": "...", "key": "..."}` from the space settings page.
- `page.update` reads the page with full detail first and sends the Official
  snapshot token of the version it read. Community keeps the current title when
  `title` is omitted.
- `page.comment` is unavailable on Official (`operation-unavailable`): the
  default Official endpoint reaches it only through a broad dispatcher this
  route never exposes. It runs on Community only, behind parity.
- Never retry a write through the other provider. Never fan one write out to both.

### Unknown outcomes and adjudication

`transactionState: "unknown"` with `causeCode: "outcome-unknown"` means the
request may have reached the provider without a confirmed effect. The object is
blocked for every write until the receipt resolves. Do not retry. Run:

```sh
$DISPATCH --tenant <tenant> receipts
$DISPATCH --tenant <tenant> receipt    --run <runId>
$DISPATCH --tenant <tenant> adjudicate --run <runId> --input '<the identical input>'
```

Adjudicate reads the object back through the receipt's own provider. It settles
`completed` only when a new stable effect id or revision is observed after the
preview baseline. A historical matching title, summary, or comment is not an
effect. `unchanged` needs a stable revision that did not move or an unsent
receipt; plain absence after a possible send remains unknown. A route that
does not expose the needed stable ids or revision is `capability-unavailable`
until live schema qualification proves it. It never marks success by hand. `unlock --run <runId>` clears a dead process's lock only;
`refused-state` names a journal condition an operator must inspect by hand.

## Community and parity

Official is the default. Community is selectable with `--provider community`,
and reads may fall over to it automatically, only when an unexpired Parity
Attestation exists for the same tenant, product, operation, input shape,
trusted origin, and principal. Record one with a read that both providers can
answer:

```sh
$DISPATCH --tenant <tenant> parity --operation issue.get --input '{"issueKey":"PROJ-1"}'
$DISPATCH --tenant <tenant> parity --operation page.get  --input '{"pageId":"123"}'
```

Parity is refused (`refused-parity`) unless Official's user info names the
item's `username` and both providers return the same object identity.
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

Prerequisites are declared by the provider runtime and its pinned registry.

## Completion

Report the tenant, provider, operation, and exact objects read or changed; the
proof state reached; verified links when a URL was returned; every refusal
cause met; and any receipt left open with its `runId`.
