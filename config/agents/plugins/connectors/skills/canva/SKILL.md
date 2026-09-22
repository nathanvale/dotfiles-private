---
name: canva
description: Find designs and inspect design pages or content in Canva. Use for authenticated Canva design discovery, not generation, editing, export, comments, assets, folders, or brand operations.
---

# Canva Design Discovery

## Current status

Treat this as a configured capability, not an available Provider Route.

Canva Official requires per-user OAuth. The shared route gives MCPorter transport while Connector credentials must remain below MCPorter. No accepted Module currently owns that OAuth custody, so `config/route.json` marks the route dispatcher-owned and the launcher refuses before MCPorter starts.

For a Canva request, report this exact state in plain language: Canva design discovery is configured but unavailable until the Connectors Plugin has an accepted per-user OAuth custody route. Do not imply that configuration proves authentication, authorization, or live access.

## Configured scope

The registry admits only these read operations:

- Search the authenticated user's accessible designs.
- Get one accessible design.
- List a design's pages.
- Read a design's content.

The exact tool allow-list lives in `config/mcporter.json`. Generation, editing, export, comments, assets, folders, Brand Kits, templates, uploads, resizing, and every other effectful Canva tool stay excluded.

Canva permissions remain per user and per object. Canva does not support an organization-wide or service-account identity for this route. A future live response that touches a design must surface its Canva edit URL so the user can open it directly.

## Guardrails

- Keep `https://mcp.canva.com/mcp` as the configured Streamable HTTP endpoint.
- Keep OAuth tokens and authorization flows out of plugin config, arguments, output, and tests.
- Keep `mcporter auth`, `mcporter vault`, service-account substitution, credential-free discovery, and direct endpoint calls outside this workflow.
- Keep background enumeration, bulk extraction, prefetching, indexing, and cross-user caching outside this workflow.
- Stop on the fail-closed route refusal. Do not bypass it through another MCP registration, ad hoc URL, browser login, or retry.

## Acceptance frontier

Before this route can become available, accept an architecture decision that owns Canva's per-user OAuth custody without silently moving credentials above MCPorter. Then qualify, in order, authenticated tool discovery, the exact four-tool schema, per-user isolation, one known design search, one known design read, and fresh Harness discovery. Treat those as separate evidence states.

Official references:

- [About Canva MCP](https://www.canva.dev/docs/apps/mcp/)
- [Access and permissions](https://www.canva.dev/docs/apps/mcp/access/)
- [Tools and rate limits](https://www.canva.dev/docs/apps/mcp/tools/)
- [Verify a Canva MCP app](https://www.canva.dev/docs/apps/mcp/verify-app/)
- [Usage policy](https://www.canva.dev/docs/apps/mcp/usage-policy/)
