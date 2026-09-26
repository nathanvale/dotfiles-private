---
name: mermaid
description: Render and validate Mermaid diagrams, title or summarize one, search Mermaid icons, fetch a diagram type's syntax, or list, read, create, and update diagrams in a Mermaid account through the plugin's Mermaid route. Use for Mermaid rendering, syntax checks, diagram-type reference, and Mermaid Chart projects and diagrams; GitHub, Jira, and Notion operations are outside this skill.
---

# Mermaid

Two tiers behind the plugin's packaged front door. The keyless tier needs no
credential. The optional account tier reads the Mermaid API token from one
1Password item inside its own Provider process; the token never reaches
MCPorter, an argument, a file, or any output. Keep native Harness MCP tools,
raw MCPorter calls, and direct HTTP requests outside this route.

Resolve the front door from this skill directory: no global `connectors`
command, no dotfiles path.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
```

Each command prints one JSON envelope on stdout. Read `result.outcome`,
`result.causeCode`, and `result.repairAction`. On success the Provider reply
is `result.data.result`; on a refusal `result.data.connectorCause` names the
Mermaid cause. Every tool requires `clientName`; pass `"connectors"`.

## Tools

| Tool | Tier | Kind | Use |
| --- | --- | --- | --- |
| `validate_and_render_mermaid_diagram` | keyless | read | Render code; a validation error comes back for fixing |
| `get_diagram_title` | keyless | read | Suggest a title for diagram code |
| `get_diagram_summary` | keyless | read | Summarize diagram code |
| `search_mermaid_icons` | keyless | read | Find AWS, Azure, GCP, or Font Awesome icon names |
| `get_mermaid_syntax_document` | keyless | read | Syntax reference for one diagram type |
| `list_mermaid_chart_projects` | account | read | The account's projects |
| `list_mermaid_chart_diagrams` | account | read | One project's diagrams (`projectID`) |
| `get_mermaid_chart_diagram` | account | read | One diagram (`documentID`) |
| `create_mermaid_chart_diagram` | account | write | New diagram: `projectID`, `title`, optional `code` |
| `update_mermaid_chart_diagram` | account | write | Change `title` or `code` of `documentID` in `projectID` |

## Keyless reads

1. `"$CONNECTORS" schema mermaid` lists the keyless tools and their input
   schemas in `result.data.schema.tools`.
2. Run one read with a JSON object:

```sh
"$CONNECTORS" run mermaid validate_and_render_mermaid_diagram --input '{"prompt":"<what it shows>","mermaidCode":"<code>","diagramType":"flowchart","clientName":"connectors"}'
```

On a render validation error, fix the code from the returned details and run
again. Validate code this way before any account write.

## Account setup

Nathan creates the Mermaid API token in his Mermaid account and stores it in
the `credential` field of an item in the `API Credentials` 1Password vault.
Connectors never creates, imports, or rotates it.

1. `"$CONNECTORS" auth status mermaid` shows whether an item is registered.
2. Absent: `"$CONNECTORS" auth configure mermaid --input '{"item":"<26-character item ID>"}'`
   with the ID Nathan gives you.
3. `"$CONNECTORS" auth check mermaid` reads the item once to prove custody.
   It never contacts Mermaid.

## Account reads

```sh
"$CONNECTORS" run mermaid list_mermaid_chart_diagrams --input '{"projectID":"<id>","clientName":"connectors"}'
```

## Account writes

A write is two commands with the identical `--input`:

1. `run mermaid <write tool> --input <json> --preview` reads the object and
   records `result.data.previewId`. Nothing is sent. A preview lasts 15
   minutes and applies at most once.
2. `run mermaid <write tool> --input <json> --apply <previewId>` sends it and
   reads the object back.

An apply ends one of three ways:

- `SUCCESS_RUN_APPLIED`: the read-back found every requested value.
- `DOMAIN_RUN_FAILED_RECORDED` (`provider-refused`): Mermaid refused and the
  object is unchanged; correct the input and preview again.
- `DOMAIN_RUN_EFFECT_UNKNOWN`: the write may have happened. Leave it
  unresolved; the object stays blocked. Run
  `recover mermaid --run <runId>` to inspect it, then
  `recover mermaid --run <runId> --adjudicate --input <identical json>`,
  which settles it when the read-back finds the effect. If the request may
  have left without a reply, an absent effect is inconclusive and the object
  remains blocked.

`recover mermaid` lists unresolved receipts. `recover mermaid --run <runId>
--unlock` releases a lock only after its holder has exited. An apply that
died before its receipt existed sent nothing; `write-locked` names its
`previewId`, and `recover mermaid --run <previewId> --unlock` releases it.

## Refusals

- `USAGE_OPERATION_UNKNOWN` (`operation-not-allowed`): the tool is outside
  the table. The hosted server also lists GitHub, Jira, Notion, and repair
  tools this route does not admit.
- `USAGE_ADAPTER_REFUSED`: `write-phase-required` (a write needs `--preview`
  then `--apply`) or `read-takes-no-phase`.
- `SCHEMA_ADAPTER_REFUSED` (`input-invalid`): the write input has a missing,
  empty, or extra key; the repair names the accepted keys.
- `DOMAIN_ADAPTER_REFUSED`: `account-unregistered` (run the setup above),
  `service-token-missing` or `item-missing` (the repair is Nathan's handoff),
  `preview-stale` or `preview-consumed` (preview again), `update-no-change`,
  `title-exists`, `object-blocked` or `write-locked` (recover first),
  `evidence-insufficient` (the receipt stays unresolved), `journal-corrupt`
  (a receipt is unreadable, malformed, or misnamed; every write and recovery
  refuses until it is restored as `<runId>.json`, an owner-only 0600 file
  with its recorded JSON).
- `SCHEMA_ADAPTER_REFUSED` (`registry-not-keyless`): the keyless registry
  entry gained a credential key; restore it rather than retry.

## Evidence

`connectors status mermaid` reports the evidence state. Fixture tests prove
both tiers and the write journal; authentication, live reads, and every live
write stay unproven until a live receipt exists. Report results as coming
from the hosted server, and report a write's outcome exactly as its envelope
states it.
