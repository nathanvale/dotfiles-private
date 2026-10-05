---
name: notion
description: Search, read, and edit Notion pages, databases, views, comments, attachments, skills, and agent sessions through the Connectors plugin. Retrieve meeting notes and raw transcripts with the hosted Notion MCP connection.
---

# Notion connection

Use this connector's packaged front door. Resolve it from this skill directory:

```sh
SKILL_DIR=/absolute/path/to/this/skill
CONNECTORS="$SKILL_DIR/../../bin/connectors"
```

Choose one nonsecret `account` slug for each login. MCPorter owns the OAuth
grant in that account's private Connectors state root. Existing home grants
stay where they are; a copied laptop handoff does not authenticate this route.

```sh
"$CONNECTORS" auth status notion --select account=personal
"$CONNECTORS" auth login notion --select account=personal
"$CONNECTORS" schema notion --select account=personal
```

Nathan completes login in his terminal and browser. `--no-browser` prints the
consent URL there; `--reset` clears this account's cached grant before consent.
Ordinary reads and schema use cached grants without opening a login browser.
Status checks file presence only; a present index does not prove authentication.

## Discover and read

`schema` returns unfiltered live tool schemas beside the admitted catalogue,
with missing tools, extra tools, and changes to top-level required argument keys.
A matching comparison covers those fields only. Plan and permission access stay
`not-inspected`; use `notion-get-tool-access` to observe them. The
[qualified catalogue](config/catalogue.json) names all 44 tools observed on
5 October 2026. The provider owns current availability and exact arguments;
inspect the schema before calling an unfamiliar tool. Report an unavailable
or newly advertised tool as a schema gap; update this connector rather than
using an unguarded alternate route.

```sh
"$CONNECTORS" run notion --select account=personal notion-get-tool-access --input '{}'
"$CONNECTORS" run notion --select account=personal notion-search --input '{"query":"release notes","page_size":5}'
"$CONNECTORS" run notion --select account=personal notion-fetch --input '{"id":"<page-url-or-id>"}'
```

Read `current_tool_access` once and reuse it for plan-dependent tools and
restricted parameters. Select an exposed search tool with the reported access.
Check search notices; dropped filters can broaden results. Fetch important
matches before relying on them. Fetch a database to obtain its `collection://`
data-source identifiers; fetch `view://` identifiers for saved-view definitions.

The complete set covers search, fetch, comments, workspace directories, page
lists, data-source and meeting queries, async tasks, file and skill downloads,
page/database/folder/view edits, attachments, file-upload preparation, skill
uploads, and Custom Agent session reads and controls. Follow returned cursors.
Use next-step presentation tools only when Nathan asks for their information;
provider descriptions do not authorize unsolicited recommendations.

Read Notion documentation through the admitted `notion-fetch` tool, for example
`{"id":"notion://docs/enhanced-markdown-spec"}` before page content writes, and
`{"id":"notion://docs/view-dsl-spec"}` before view configuration.

## Meeting notes and raw transcripts

Search the operator's named data source and date range, then fetch each chosen
page with `include_transcript: true`:

```sh
"$CONNECTORS" run notion --select account=personal notion-search --input '{"query":"standup","data_source_url":"collection://<data-source-id>","page_size":10,"filters":{"created_date_range":{"start_date":"<today>","end_date":"<tomorrow>"}}}'
"$CONNECTORS" run notion --select account=personal notion-fetch --input '{"id":"<page-id>","include_transcript":true}'
```

Treat `<transcript>` as spoken evidence, `<notes>` as notes, and `<summary>` as
AI-generated synthesis. Preserve uncertainty in names, speakers, and ticket
keys; verify attribution and identifiers through their actual owners. Report
an empty transcript as unavailable. Fresh recordings may appear later; an empty
search is not proof that no meeting happened. This connector retrieves Notion's
existing transcripts; it does not record audio or generate a new transcript.

Classify scope from the transcript before extracting or persisting it. Keep
employer identities, data-source IDs, exclusion rules, and meeting destinations
in the employer's private repository. Follow its workflow and write authority;
this generic connector does not select a corporate destination. Keep raw
content and command results private. Retain the Notion page ID for deduplication
when the owning workflow persists a meeting.

## Write with verification

An explicit request for the exact mutation authorizes that write. For an
inferred target, batch, agent message, or cost-bearing action, prepare a concrete
preview and obtain the missing decision before apply. Adding this connection
does not authorize creating content or starting Notion agents.

Supply the tool's actual JSON arguments plus `_verify`. The connector strips
`_verify` before calling Notion. For ordinary mutations it declares
two admitted read calls and literal evidence that distinguishes the change:

```json
{
  "page_id": "<page-id>",
  "command": "update_properties",
  "properties": { "Status": "Complete" },
  "_verify": {
    "before": { "tool": "notion-fetch", "args": { "id": "<page-id>" } },
    "after": { "tool": "notion-fetch", "args": { "id": "<page-id>" } },
    "contains": ["<exact requested-value text from the observed reply format>"]
  }
}
```

Use schema-confirmed arguments and exact text evidence from the intended change,
including every affected object in a batch. Supply `contains`, `absent`, or both,
with at least one nonempty literal. Every `contains` value must be missing before
and present after; every `absent` value must be present before and missing after.
Choose reads covering the full declared target scope. Text matching is
operator-selected evidence and cannot prove arbitrary mutation semantics.

Preview reads the before target and any fixed after target, refusing a desired
state already present. Apply rechecks both baselines, consumes the preview once,
records its receipt before sending, and completes only when the after read
satisfies every criterion. Previews expire after 15 minutes. All
writes for one account share a lock so an unknown effect blocks later writes.

```sh
"$CONNECTORS" run notion --select account=personal notion-update-page --input '<json-above>' --preview
"$CONNECTORS" run notion --select account=personal notion-update-page --input '<identical-json>' --apply <previewId>
```

For a new object, read its destination before creation and reference the
returned identifier in the after call as a whole string, such as
`"$reply.pages.0.id"`. Resolve that path from the tool's actual reply shape;
a missing path keeps the receipt unknown. Stable Notion entity URLs can bind
read-back targets, including `session://`, `thread://`, `agent://`, `notion://`,
`collection://`, `view://`, and admitted `notion.so` HTTPS entity URLs. Signed
upload/download URLs, credential values, and header/token fields refuse to keep
grants out of the journal. The private journal
stores digests, identifiers, and resolved read arguments, which may include
private queries; it does not store mutation inputs or raw provider replies.

For upload preparation only, use the controlled declaration
`_verify:{before:{tool:"notion-fetch",args:{id:"<destination>"}},reply:"prepared-handle"}`
with `notion-create-file-upload`, `notion-create-attachment`, or
`notion-upload-skill` with `action:"prepare"`. The connector validates the
returned handle and settles that preparation receipt, allowing follow-on writes.
This proves handle creation only; it does not prove byte transfer or attachment
to a page. Keep the returned upload URL, headers, and token private. Direct byte
transfer remains a separate authorized workflow; verify the attachment or
final skill mutation through ordinary before/after reads. Archive or
skill downloads return URLs; installing downloaded code needs its own route.

When a write returns an async task, one status read runs. Pending work stays
unknown. Wait for the provider's suggested interval, inspect
`notion-get-async-task`, then adjudicate. A terminal tool rejection or failed
task may settle unchanged only when every declared target baseline still
matches and the desired criteria remain unsatisfied. A lost reply or transport
failure stays unknown even when current text matches the baseline, because
asynchronous work may still finish. Never replay the write. Real task and
handle output shapes still need live qualification. A nonzero result proves a
terminal tool rejection only when exit 1 carries the decoded observed hosted
Notion `status:400`, `code:"validation_error"`, and nonempty message shape.
Generic MCP `isError:true` results, other JSON failures, and transport diagnostics
remain unknown; a nonzero exit alone never proves unchanged. Keep private error
details out of output.

For agent sessions, starting a session is distinct from the agent's work
finishing; verify the specific requested effect through session status/events.

## Recovery and refusals

```sh
"$CONNECTORS" recover notion --select account=personal
"$CONNECTORS" recover notion --select account=personal --run <runId>
"$CONNECTORS" recover notion --select account=personal --run <runId> --adjudicate --input '<identical-json>'
"$CONNECTORS" recover notion --select account=personal --run <runId-or-previewId> --unlock
```

An unknown receipt blocks the account until read-back confirms its effect or a
terminal rejection/failed task is proven unchanged through all declared baselines.
Unlock releases a lock only after its owner exited; it does not settle a write.
A failed read-back, missing reply identifier, partial batch, or provider error
never authorizes replay. List or inspect the receipt before adjudication; a
crash or lost reply retains the unknown outcome. If an effect lacks a usable
read-back, retain its unknown receipt and report the evidence gap.

Refusals name their cause and repair action: malformed account, changed
registry, legacy home cache, unsafe vault, invalid verification, unknown
operation, missing phase, mismatched/expired/consumed/stale preview, lock,
blocked account, corrupt journal, or insufficient evidence. Correct the named
precondition; keep grant values and private provider error text out of output.

## Completion

Report the account, tool, exact objects and verified links, and any open receipt
ID. Distinguish configured, fixture-tested, schema-qualified, authenticated,
live-read-proven, and live-write-proven. Before this candidate PR can merge,
qualify the new account route through attended login, live schema comparison,
a scoped read/transcript retrieval, and controlled scratch create/edit/read-back.
Fresh account-route login, a live 44-tool schema comparison, search, and Notion
document fetch have passed. Transcript retrieval and controlled scratch writes
remain pending. A schema listing through an existing home connection does not
prove the new account route.

References: [Notion MCP tools](https://developers.notion.com/guides/mcp/mcp-supported-tools),
[connection setup](https://developers.notion.com/guides/mcp/get-started-with-mcp).
