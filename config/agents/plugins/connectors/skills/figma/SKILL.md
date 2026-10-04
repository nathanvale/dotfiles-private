---
name: figma
description: Read and write Figma designs through Figma's hosted MCP on the Connectors plugin's packaged route, with attended OAuth. Use for design context, screenshots, variables, metadata, assets, libraries, Code Connect reads and mappings, use_figma canvas edits, new files and FigJam diagrams, generative plugins and shaders, Weave tool runs, or connecting this route; not for the native Figma MCP or Figma's own plugin skills.
---

# Figma hosted MCP

One packaged route to Figma's hosted MCP (`https://mcp.figma.com/mcp`). MCPorter holds the OAuth grant in its own default vault; the route never prints it. Keep native Harness MCP tools, raw MCPorter calls, and Figma REST requests outside this route.

Resolve the front door from this skill directory: no global `connectors` command, no dotfiles path.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
```

Each command prints one JSON envelope on stdout. Read `result.outcome`, `result.causeCode`, and `result.repairAction`. On success Figma's reply is in `result.data`; on a refusal `result.data.connectorCause` names the Figma cause.

## Connect

1. `"$CONNECTORS" auth status figma` reports whether MCPorter's vault exists. A present vault may hold no grant.
2. Ask Nathan to run `"$CONNECTORS" auth login figma` in his own terminal (`--no-browser` when the host cannot open his browser; `--reset` for a fresh grant). An agent cannot complete browser consent.
3. `"$CONNECTORS" run figma whoami` names the principal and plans. Compare it with the intended account before the first design read or write.

The registration identifies MCPorter to Figma as `Claude Code` because MCPorter's own name was refused. This is a local interoperability workaround, not approval of a Connectors client. `--reset` clears only the local grant.

## Reads

`"$CONNECTORS" schema figma` lists every admitted tool with its live input schema in `result.data.schema.tools`. Take argument names from it. A Figma URL's `node-id=1-2` becomes `nodeId` `1:2`.

```sh
"$CONNECTORS" run figma get_design_context --input '{"fileKey":"<key>","nodeId":"1:2"}'
```

The reads are `whoami`, `get_metadata`, `get_design_context`, `get_screenshot`, `get_variable_defs`, `download_assets`, `get_motion_context`, `get_figjam`, `get_libraries`, `search_design_system`, `get_code_connect_map`, `get_code_connect_suggestions`, `get_context_for_code_connect`, `list_generative_plugins`, `get_generative_plugin`, `list_shaders`, `get_shader`, `list_file_shaders`, `weave_list_tools`, `weave_get_tool_inputs`, and `weave_get_tool_run_output`.

Figma rate-limits reads by seat: a View or Collab seat gets a few per month, and `whoami` is exempt. Stop at the first rate-limit or access error and report it with the file and node.

## Writes

A write changes Nathan's Figma account. Run one only when Nathan asked for that change. Each is two commands with the identical `--input`:

1. `"$CONNECTORS" run figma <tool> --input '<json>' --preview` reads the object and records `result.data.previewId`. Nothing is sent. A preview lasts 15 minutes and applies at most once.
2. `"$CONNECTORS" run figma <tool> --input '<json>' --apply <previewId>` sends it once and reads the object back.

| Tool | Read-back that proves it |
| --- | --- |
| `add_code_connect_map`, `send_code_connect_mappings` | `get_code_connect_map` on `fileKey` and `nodeId` shows each `componentName` and `source` |
| `create_generative_plugin`, `create_shader` | One new id with the requested `name` in the library list; names must be new |
| `update_generative_plugin`, `update_shader` | The object's `version` moved |
| `create_new_file` | The reply's file key reads back; `planKey` must be one of `whoami`'s plans |
| `generate_diagram` | The reply's board reads back; into an existing `fileKey`, its `name` appears there |
| `use_figma` | Your `verify` read shows every `contains` value (below) |
| `weave_cancel_tool_run` | Every named run reports `CANCELED` |
| `weave_run_tool` | The runs the reply names read back (Weave costs below) |

`use_figma` runs arbitrary Plugin API code, so its input adds `"verify": {"tool": "get_metadata" | "get_design_context" | "get_variable_defs", "nodeId": "<existing node>", "contains": ["<value the code will make visible>"]}`. The route strips `verify` before sending. Choose a node and values the change will certainly show; a change it cannot show stays unknown and blocks the file.

### Weave costs

A Weave run spends Nathan's paid Weave credits. A free tool runs at once.

1. Apply the run without `acknowledgedCost`. Figma quotes and spends nothing: the cause is `cost-confirmation-required`, with the cost in `result.data.quote.cost` and its `costDisclosure` in the reply.
2. Show Nathan the cost and the disclosure, and ask for an explicit approve or cancel.
3. Only on approval, preview and apply again with `acknowledgedCost` set to that exact cost within 15 minutes. Any other cost refuses as `cost-not-quoted`.

### Outcomes

- `SUCCESS_RUN_APPLIED`: the read-back found the change.
- `DOMAIN_RUN_FAILED_RECORDED`: Figma refused and the object is unchanged (`provider-refused`), or a Weave quote or input request spent nothing.
- `DOMAIN_RUN_EFFECT_UNKNOWN`: the write may have happened. Never retry it. Its object stays blocked. Run `"$CONNECTORS" recover figma --run <runId>`, then `recover figma --run <runId> --adjudicate --input <identical json>`, which settles only when a read-back finds the change or, after a reply, proves the object unchanged.

`"$CONNECTORS" recover figma` lists unresolved receipts. `recover figma --run <runId|previewId> --unlock` releases a lock only after its holder has exited.

## Not admitted

`generate_figma_design`, `upload_assets`, and `weave_upload_asset` refuse as `operation-not-allowed`; read [ADR 0005](../../docs/adr/0005-admit-figma-catalog-by-effect-class.md). Report the refusal; the route has no fallback.
