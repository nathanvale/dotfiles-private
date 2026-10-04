---
status: proposed
---

# Admit Figma's MCP catalog by effect class

## Context and Problem

[ADR 0003](0003-scope-native-mcporter-oauth-to-figma.md) admitted `whoami` alone for the Figma connection slice and left design reads to later ticket gates. On 5 October 2026 Nathan asked that every Figma MCP tool be allowed, with parity between Codex and Claude Code through this route.

Figma's [tool catalog](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) (read 5 October 2026) documents 35 tools: 18 read, 11 write, and 6 Weave tools, plus one MCP prompt, `create_design_system_rules`, which is not a tool. An authenticated `tools/list` for Nathan's account on the same day returned exactly those 35 names. Weave runs spend paid Weave credits; Figma says a run without `acknowledgedCost` only quotes, and a free tool runs at once. Figma's server instructions also name `get_figma_skill`, which the catalog does not list.

The plugin's `AGENTS.md` requires any write capability to follow the Atlassian pattern: preview and apply through a durable journal, exact provider write tools, and an operator adjudication path that settles only on read-back evidence. The plain Provider Route forwards a call directly to MCPorter and has none of these. How does the route reach the whole catalog without unguarded writes or credit spend?

## Decision Drivers

- Reach every documented catalog tool from Codex and Claude Code through one owned route.
- Keep the existing write contract: preview, durable journal, exact write tools, adjudication on read-back evidence.
- Keep paid Weave runs behind a cost Figma itself quoted and Nathan approved.
- Keep the fixed endpoint, MCPorter OAuth custody, and borrowed client identity from ADR 0003.
- Admit tools by exact name from a test-owned catalog oracle, never by wildcard or implicit widening.

## Considered Options

- A. Admit all 35 tools on the plain Provider Route.
- B. A dispatcher-owned packaged `figma` adapter: reads pass through, and each write is journaled and admitted only with a read-back that can prove its effect.
- C. Keep `whoami` alone.

## Decision

We will choose Option B because it reaches every tool whose effect the route can prove, keeps the write contract and the Weave cost gate as refusals rather than clauses, and states exactly what blocks the rest.

- `skills/figma/config/route.json` is `dispatcherOwned`; the plain route refuses every Figma verb. `skills/figma/adapter.ts` serves `connectors auth status|login figma`, `run figma`, `schema figma`, and `recover figma`, and refuses any registry that is not exactly the packaged one.
- The registry admits exactly 32 names, equal to the catalogue in `skills/figma/scripts/catalogue.ts`.
- Custody moves from MCPorter's default HOME vault (ADR 0003) to Figma's own vault root under Connectors state (`scripts/vault.ts`), named in every plan. The front door otherwise runs a plan without its own data root in the keyless root other connectors share, which would put the Figma grant beside them. Activating this needs one attended `connectors auth login figma`; the old HOME-vault grant stays where it is until Nathan resets it.
- Writes follow the Mermaid flow in `scripts/writes.ts` and `scripts/journal.ts`. The read-back rule per tool lives in `scripts/evidence.ts`: an unfamiliar result shape yields no evidence, so an effect stays unknown and its object blocked; it never completes by assumption.

| Class | Tools | Read-back |
|---|---|---|
| Read | 18 documented reads, `weave_list_tools`, `weave_get_tool_inputs`, `weave_get_tool_run_output` | n/a |
| Write | `add_code_connect_map`, `send_code_connect_mappings` | `get_code_connect_map` shows each requested component and source |
| Write | `create_generative_plugin`, `create_shader` | one new id carrying the new name in the library list |
| Write | `update_generative_plugin`, `update_shader` | the object's version moved |
| Write | `create_new_file`, `generate_diagram` | the reply's file key reads back through `get_metadata`; into an existing board, its name appears |
| Write | `use_figma` | a caller-declared read (`verify`: tool, node, values) shows every value; the view is partial, so an unchanged read never proves no effect |
| Write | `weave_cancel_tool_run` | every named run reports `CANCELED` |
| Paid write | `weave_run_tool` | the reply's run ids read back. A quote reply with an unchanged run list settles unchanged and records the quoted cost; `acknowledgedCost` must equal a fresh recorded quote for the identical input |

### Not admitted, and the exact gap

- `generate_figma_design`: the effect is a provider-supplied capture script run in a browser against a web page, outside this adapter; only polling by `captureId` observes it. Admission needs a decision on executing that script (browser route and capability handling) and a captured-node read-back.
- `upload_assets`: returns single-use upload URLs; the upload is an out-of-band POST, and a fill on an existing node is not visible to `get_metadata`. Admission needs an adapter-owned outbox (as the Atlassian Upload Outbox) that performs the POST so no URL leaves the adapter, plus a read that shows the placed image (likely `get_design_context` on the target node), qualified against live output.
- `weave_upload_asset`: returns an upload URL and token; no admitted read observes a Weave asset afterwards, so an unreplied upload could never be adjudicated. Admission needs the same outbox and either a Weave asset read or an accepted rule that an asset is proven only by its use in a read-back run.

No operator-attested adjudication is assumed; settling by read-back evidence stays the contract.

## Consequences

- Positive: 32 of 35 catalog tools reach Codex and Claude Code through one route once installed, each write under preview, journal, and evidence-only settlement.
- Positive: a Weave spend needs a cost Figma quoted for that exact input within 15 minutes.
- Negative: reads move from `provider-route figma -- call` to `connectors run figma`; installed copies need the rebuilt front door, and Nathan needs one attended login into the new vault root.
- Negative: each write costs up to three rate-limited reads (preview, apply, read-back). On a View or Collab seat this exhausts the monthly allowance quickly; View seats may also lack edit rights on a file.
- Negative: an unprovable `use_figma` or create blocks its object until a read-back finds the change.
- Neutral: read-back parsers were built against the live input schemas and a stub, not against live write replies; their live behavior is unproved until an authorized write.

## Options and Tradeoffs

### A. All 35 on the plain route

- Good: one-line parity.
- Bad: forwards canvas edits, file creation, uploads, and paid Weave runs with no preview, journal, or adjudication, contrary to the plugin's write contract.

### B. Dispatcher-owned adapter by effect class

- Good: every provable tool admitted; the write contract and cost gate are enforced by refusals.
- Bad: three tools wait on the decisions above; reads change command.

### C. Identity only

- Good: no new exposure.
- Bad: blocks the design reads and writes Nathan asked for.

## Confirmation

- `skills/figma/tests/figma.test.ts`: the 35-tool catalog literal (18, 11, 6); the registry admits exactly 32 and equals the catalogue; the plain route refuses `auth`, `list`, and `call` as dispatcher-owned; and the installed MCPorter, given a stdio probe advertising all 35 names plus the prompt, `get_figma_skill`, and `executeWrite`, lists exactly the 32 and refuses the rest before the server starts.
- `skills/figma/tests/packaged.test.ts`: through the compiled front door and the official MCPorter 0.14.0 against a stateful loopback stub: the live listing is exactly 32; every admitted write applies once after its preview and only on read-back; a preview applies once with identical input; Weave acknowledges only a quoted cost; an unreplied write blocks its object and settles only on found evidence; `use_figma` never settles unchanged; auth status reads presence only and login needs an attended terminal; reads and writes touch only Figma's vault root, never the keyless root or HOME.
- Live, 5 October 2026: a cached-grant schema listing returned the 18 documented reads, and `get_metadata`, `get_screenshot`, and `get_variable_defs` read one Monash node. No live write, upload, or Weave run has been made.
- Revisit when Figma changes its catalog, when the decisions above are made, or when Figma documents a Connectors-specific client or write contract.

## References

- [ADR 0003](0003-scope-native-mcporter-oauth-to-figma.md): the connection slice this decision widens; its history and evidence stand.
- [ADR 0001](0001-route-atlassian-through-mcporter.md): the write contract and the Upload Outbox.
- `skills/mermaid/`: the preview, apply, and recover precedent this adapter follows.
- [Spec #67](https://github.com/nathanvale/dotfiles-private/issues/67): its "never expose Figma write tools through this route" direction needs amendment.
- [Figma rate limits and access](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/).
