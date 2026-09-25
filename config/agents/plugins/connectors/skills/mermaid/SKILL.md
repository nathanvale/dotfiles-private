---
name: mermaid
description: Render and validate Mermaid diagrams, title or summarize one, search Mermaid icons, or fetch a diagram type's syntax through the plugin's keyless Mermaid route. Use for Mermaid rendering, syntax checks, and diagram-type reference; account, GitHub, Jira, and Notion operations are outside this skill.
---

# Mermaid

Keyless reads only. The plugin's packaged front door reaches the hosted
Mermaid MCP with no credential, for the five tools its registry allows. Keep
native Harness MCP tools, raw MCPorter calls, and direct HTTP requests outside
this route.

Resolve the front door from this skill directory: no global `connectors`
command, no dotfiles path.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
```

Each command prints one JSON envelope on stdout. Read `result.outcome`,
`result.causeCode`, and `result.repairAction`. On success the Provider reply
is `result.data.result`; on a refusal `result.data.connectorCause` names the
Mermaid cause. The first command that needs MCPorter bootstraps the
plugin-pinned release and reports `mcporter-bootstrap` in
`result.effects.completed`.

## Steps

1. Confirm the live tool shapes: `"$CONNECTORS" schema mermaid`. The tools and
   their input schemas are in `result.data.schema.tools`.
2. Run one tool with a JSON object. Every tool requires `clientName`; pass
   `"connectors"`.

```sh
"$CONNECTORS" run mermaid validate_and_render_mermaid_diagram --input '{"prompt":"<what it shows>","mermaidCode":"<code>","diagramType":"flowchart","clientName":"connectors"}'
"$CONNECTORS" run mermaid get_mermaid_syntax_document --input '{"diagramType":"sequenceDiagram","clientName":"connectors"}'
```

| Tool | Use |
| --- | --- |
| `validate_and_render_mermaid_diagram` | Render code; a validation error comes back for fixing |
| `get_diagram_title` | Suggest a title for diagram code |
| `get_diagram_summary` | Summarize diagram code |
| `search_mermaid_icons` | Find AWS, Azure, GCP, or Font Awesome icon names |
| `get_mermaid_syntax_document` | Syntax reference for one diagram type |

On a render validation error, fix the code from the returned details and run
again. A step is done when `result.outcome` is `success` and the reply answers
the request.

## Refusals and limits

- `USAGE_OPERATION_UNKNOWN` (`operation-not-allowed`): the tool is outside
  the five above. The hosted server also lists GitHub, Jira, and Notion tools;
  they need credentials this route does not hold.
- `DOMAIN_ADAPTER_REFUSED` (`adapter-has-no-writes`): Mermaid has no write
  station yet, so `--preview` and `--apply` refuse.
- `DOMAIN_AUTH_VERB_UNSUPPORTED`: the keyless tier has no auth step.
- `SCHEMA_ADAPTER_REFUSED` (`registry-not-keyless`): the registry entry gained
  a header or credential key; restore it rather than retry.
- A transient cause means the hosted server was unreachable; report it with
  the envelope's `repairAction`.

`connectors status mermaid` reports the evidence state. Fixture tests prove
this route; live Mermaid reads and every write stay unproven until a live
receipt exists, so report results as coming from the hosted server and claim
no stored diagram or account effect.
