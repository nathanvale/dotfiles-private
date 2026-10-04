---
name: figma
description: Read Figma designs through Figma's hosted MCP on the Connectors plugin's MCPorter route, with attended OAuth and identity checks. Use for design context, screenshots, variables, metadata, assets, libraries, Code Connect reads, or connecting and reauthorizing this route; not for canvas writes, Weave runs, or the native Figma MCP.
---

# Figma hosted MCP

Use the shared route at `<plugin-root>/bin/provider-route.ts` with the `figma` skill name. This route uses MCPorter's own OAuth cache. It is separate from Codex or Claude's Figma MCP session.

1. Check `mcporter --version`. The qualified local route used MCPorter 0.14.0.
2. For a new session, ask Nathan to complete the browser consent opened by `bun <plugin-root>/bin/provider-route.ts figma -- auth`. Run this attended command only when Nathan requests connection or reauthorization.
3. Discover the admitted tools with `bun <plugin-root>/bin/provider-route.ts figma -- list --schema --json --timeout 15000`. The route uses cached credentials and does not start browser login on a read. Take argument names from this live schema.
4. Before the first design read in a session, run `bun <plugin-root>/bin/provider-route.ts figma -- call whoami --output json` and compare the principal with the intended account.
5. Read with `bun <plugin-root>/bin/provider-route.ts figma -- call <tool> --args '<json>' --output json`, for example `get_design_context`, `get_screenshot`, or `get_variable_defs` with the `fileKey` and `nodeId` from the Figma URL (`node-id=1-2` becomes `1:2`).

## Admitted tools

The registry admits the 18 read tools in [Figma's tool catalog](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/): `whoami`, `get_metadata`, `get_design_context`, `get_screenshot`, `get_variable_defs`, `download_assets`, `get_motion_context`, `get_figjam`, `get_libraries`, `search_design_system`, `get_code_connect_map`, `get_code_connect_suggestions`, `get_context_for_code_connect`, `list_generative_plugins`, `get_generative_plugin`, `list_shaders`, `get_shader`, and `list_file_shaders`.

Figma's 11 write tools (including `use_figma`) and 6 Weave tools wait for a preview and apply adapter; read [ADR 0005](../../docs/adr/0005-admit-figma-catalog-by-effect-class.md). MCPorter refuses them with `blocked by configuration`. Report that refusal; the route has no fallback.

## Rate limits

Figma rate-limits design reads by seat: View and Collab seats get a few calls per month, while `whoami` is exempt. A successful `whoami` proves identity, not file access or remaining quota. Stop at the first rate-limit or access error and report it with the file and node.

## Auth

When Nathan requests a fresh grant, run `bun <plugin-root>/bin/provider-route.ts figma -- auth --reset` with attended consent. MCPorter clears this route's local cached grant before reauthorization. This does not prove Figma revoked the old grant.

- Use `--no-browser` for an attended handoff when the execution host cannot open a browser Nathan can use.
- Expect MCPorter to print an authorization URL or loopback redirect during auth. Agent-captured terminal output may retain those values.
- Keep auth output out of chat and additional logs. A captured terminal transcript remains possible.

The fixed endpoint is `https://mcp.figma.com/mcp`. The local OAuth registration identifies MCPorter to Figma as `Claude Code` because MCPorter's own name received a registration refusal in the local test. This is an interoperability workaround, not approval of a Connectors client identity. Report authentication, live schema, and live content reads as separate evidence.

On an auth refusal, report the failure and the next attended step. Do not retry registration automatically, switch client names, use a personal access token, or infer MCP behavior from Figma REST APIs. The existing personal Figma skill owns broader design and canvas workflows; this skill owns only the plugin route.
