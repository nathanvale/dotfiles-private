---
name: figma
description: Connect to Figma's hosted MCP through the Connectors plugin for attended OAuth, read-tool discovery, and requested design reads.
---

# Figma hosted MCP

Use the shared route at `<plugin-root>/bin/provider-route.ts` with the `figma` skill name. This route uses MCPorter's own OAuth cache. It is separate from Codex or Claude's Figma MCP session.

1. Check `mcporter --version`. The qualified local route used MCPorter 0.14.0.
2. For a new session, ask Nathan to complete the browser consent opened by `bun <plugin-root>/bin/provider-route.ts figma -- auth`. Run this attended command only when Nathan requests connection or reauthorization. Keep the authorization URL and callback out of chat and logs.
3. Discover the read tools with `bun <plugin-root>/bin/provider-route.ts figma -- list --schema --json --timeout 15000`. The route uses cached credentials and does not start browser login on a read.
4. Use `bun <plugin-root>/bin/provider-route.ts figma -- call <tool> --args '<JSON object>' --output json` only for a tool in the registry's exact allow-list and only when Nathan requests the corresponding Figma read.

The fixed endpoint is `https://mcp.figma.com/mcp`. The local OAuth registration identifies MCPorter to Figma as `Claude Code` because MCPorter's own name received a registration refusal in the local test. This is an interoperability workaround, not approval of a Connectors client identity. Report authentication, live schema, and live content reads as separate evidence.

On an auth refusal, report the failure and the next attended step. Do not retry registration automatically, switch client names, use a personal access token, or infer MCP behavior from Figma REST APIs. The existing personal Figma skill owns broader design and canvas workflows; this skill owns only the plugin route.
