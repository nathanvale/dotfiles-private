---
status: proposed
---

# Admit Figma's MCP catalog by effect class

## Context and Problem

[ADR 0003](0003-scope-native-mcporter-oauth-to-figma.md) admitted `whoami` alone for the Figma connection slice and left design reads to later ticket gates. On 5 October 2026 Nathan asked that every Figma MCP tool be allowed, with parity between Codex and Claude Code through this route.

Figma's [tool catalog](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) (read 5 October 2026) documents 35 tools: 18 read, 11 write, and 6 Weave tools, plus one MCP prompt, `create_design_system_rules`, which is not a tool. Weave runs spend paid Weave credits; Figma says the agent shows the cost and asks for confirmation. Figma's server instructions also name `get_figma_skill`, which the catalog does not list.

The plugin's `AGENTS.md` requires any write capability to follow the Atlassian pattern: preview and apply through a durable journal, exact provider write tools, and an operator adjudication path. The plain Provider Route forwards a call directly to MCPorter and has no preview, journal, or adjudication. Nathan's request does not waive that owner. How does the route reach the whole catalog without unguarded writes or credit spend?

## Decision Drivers

- Reach every documented catalog tool from Codex and Claude Code through one owned route.
- Keep the existing write contract: preview, durable journal, exact write tools, adjudication.
- Keep paid Weave runs behind an explicit, per-run cost acknowledgement.
- Keep the fixed endpoint, MCPorter OAuth custody, and borrowed client identity from ADR 0003.
- Admit tools by exact name from a test-owned catalog oracle, never by wildcard or implicit widening.

## Considered Options

- A. Admit all 35 tools on the plain Provider Route.
- B. Admit the 18 read tools on the plain route now; reach the 11 write and 6 Weave tools only through a packaged Figma adapter with preview and apply.
- C. Keep `whoami` alone until the write adapter exists.

## Decision

We will choose Option B because it delivers every read now, keeps the write contract and the Weave cost gate intact, and leaves one bounded adapter as the only path to the remaining 17 tools.

- Now: `skills/figma/config/mcporter.json` admits exactly the 18 read tools. Real MCPorter refuses the write, Weave, prompt, and uncatalogued names with `blocked by configuration` before any server starts.
- Next, to complete the catalog: a packaged `figma` adapter on the `bin/connectors` front door, modelled on the Mermaid adapter (`skills/mermaid/adapter.ts`, `scripts/journal.ts`, `scripts/writes.ts`). Its route becomes `dispatcherOwned`, and the registry then admits all 35 names. Reads pass through; each write needs `--preview` then `--apply <previewId>` with identical input, bound to a durable journal receipt and an `effect-unknown` adjudication path; each Weave run additionally needs the previewed credit cost acknowledged at apply. Free Weave reads (`weave_list_tools`, `weave_get_tool_inputs`, `weave_get_tool_run_output`) may pass through as reads once the adapter owns the route.

## Consequences

- Positive: design context, screenshots, variables, metadata, assets, libraries, and Code Connect reads work through the route today.
- Positive: no write or credit spend can leave the route before a journal and an adjudication path exist.
- Negative: canvas writes and Weave remain unreachable until the adapter lands, so full catalog parity is two changes, not one.
- Negative: making the route `dispatcherOwned` later replaces the direct `provider-route figma -- call` reads with `connectors run figma`; the skill's read steps change again then.
- Neutral: rate limits by seat apply to every read except `whoami`. They gate how many reads succeed, not which tools are admitted.

## Options and Tradeoffs

### A. All 35 on the plain route

- Good: one-line parity; every catalog tool is reachable today.
- Bad: forwards `use_figma`, file creation, uploads, and paid Weave runs with no preview, journal, or adjudication, contrary to the plugin's write contract.
- Bad: the cost gate becomes a prose instruction that can fail late in a long session.

### B. Reads now, writes and Weave through an adapter

- Good: every read now; writes keep the existing contract; the cost gate becomes a refusal, not a clause.
- Bad: the adapter is a larger bounded change with its own design, tests, and live write qualification.

### C. Identity only

- Good: no new exposure.
- Bad: blocks the design reads Nathan and the Design System Feedback Uplift need, with no path to parity.

## Confirmation

- `skills/figma/tests/figma.test.ts` pins the catalog from a test-owned literal (18, 11, 6), asserts the registry admits exactly the 18 read names, and drives the installed MCPorter against a stdio probe that advertises the full catalog plus `create_design_system_rules`, `get_figma_skill`, and `executeWrite`: the listing returns exactly the 18 reads, `get_screenshot` reaches the server, and every write, Weave, prompt, and uncatalogued name is refused before the server starts.
- A cached-grant schema listing through the exact candidate confirms which admitted reads the hosted server returns for Nathan's account.
- Revisit when Figma changes its catalog, when the adapter ticket lands, or when Figma documents a Connectors-specific client or write-confirmation contract.

## References

- [ADR 0003](0003-scope-native-mcporter-oauth-to-figma.md): the connection slice this decision widens; its history and evidence stand.
- [ADR 0001](0001-route-atlassian-through-mcporter.md): the write contract.
- `skills/mermaid/SKILL.md`: the nearest preview, apply, and recover precedent.
- [Spec #67](https://github.com/nathanvale/dotfiles-private/issues/67): its "never expose Figma write tools through this route" direction needs amendment for the adapter path.
- [Figma rate limits and access](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/).
