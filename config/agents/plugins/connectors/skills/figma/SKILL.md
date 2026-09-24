---
name: figma
description: Connect to Figma's hosted MCP through the Connectors plugin for attended OAuth and identity discovery. Use only to connect, reauthorize, or verify identity for the MCPorter Figma route; not for design reads, canvas work, or the native Figma MCP.
---

# Figma hosted MCP

Use the shared route at `<plugin-root>/bin/provider-route.ts` with the `figma` skill name. This route uses MCPorter's own OAuth cache. It is separate from Codex or Claude's Figma MCP session.

1. Check `mcporter --version`. The qualified local route used MCPorter 0.14.0.
2. For a new session, ask Nathan to complete the browser consent opened by `bun <plugin-root>/bin/provider-route.ts figma -- auth`. Run this attended command only when Nathan requests connection or reauthorization.
3. Discover the admitted identity tool with `bun <plugin-root>/bin/provider-route.ts figma -- list --schema --json --timeout 15000`. The route uses cached credentials and does not start browser login on a read.
4. When Nathan requests identity verification, use `bun <plugin-root>/bin/provider-route.ts figma -- call whoami --output json`. Compare the returned principal with the intended account before any later design-read workflow. The registry admits no design-content tools in this connection slice.

When Nathan requests a fresh grant, run `bun <plugin-root>/bin/provider-route.ts figma -- auth --reset` with attended consent. MCPorter clears this route's local cached grant before reauthorization. This does not prove Figma revoked the old grant.

## Auth output

- Use `--no-browser` for an attended handoff when the execution host cannot open a browser Nathan can use.
- Expect MCPorter to print an authorization URL or loopback redirect during auth. Agent-captured terminal output may retain those values.
- Keep auth output out of chat and additional logs. A captured terminal transcript remains possible.

The fixed endpoint is `https://mcp.figma.com/mcp`. The local OAuth registration identifies MCPorter to Figma as `Claude Code` because MCPorter's own name received a registration refusal in the local test. This is an interoperability workaround, not approval of a Connectors client identity. Report authentication, live schema, and live content reads as separate evidence.

On an auth refusal, report the failure and the next attended step. Do not retry registration automatically, switch client names, use a personal access token, or infer MCP behavior from Figma REST APIs. The existing personal Figma skill owns broader design and canvas workflows; this skill owns only the plugin route.
