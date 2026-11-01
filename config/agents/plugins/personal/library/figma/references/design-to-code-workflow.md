# Design-to-Code Workflow

Agent workflow for implementing UI from a Figma design source of truth.

## Prerequisites

- Figma MCP state is `ready` (see `references/figma-mcp-state-machine.md`).
- User has provided a Figma URL with a node ID, or a file URL with a target
  selection.

## Steps

1. **Extract node ID** from the Figma URL. The `node-id` query parameter
   contains the target node (e.g., `node-id=13883-23258` → node `13883:23258`).

2. **Fetch design context** — call `get_design_context` with the Figma URL.
   Returns structured layout and styling data (spacing, colors, typography,
   auto-layout constraints).

3. **Fetch screenshot** — call `get_screenshot` with the Figma URL. Returns a
   visual reference image for comparison during and after implementation.

4. **Fetch design tokens** — call `get_variable_defs` with the Figma URL.
   Returns variable definitions with code syntax for colors, spacing, and
   typography tokens.

5. **Check Code Connect mappings** — call `get_code_connect_map` to see if
   components in the design already map to codebase components. If mappings
   exist, compose from those components instead of building from scratch.

6. **Implement** using existing codebase components and design tokens. Prefer
   the project's component library over raw HTML/CSS.

7. **Compare** using the measured [design parity check](#design-parity-check)
   below. Patch discrepancies against the approved reference and repeat the proof.

8. **Test** — run relevant component tests with accessibility enabled.

## Tool Combo Reference

The standard read combo for design-to-code:

| Tool | Returns | Use for |
|------|---------|---------|
| `get_design_context` | Layout, styling, constraints | Implementation structure |
| `get_screenshot` | Visual image | Comparison reference |
| `get_variable_defs` | Design tokens with code syntax | Token usage |
| `get_code_connect_map` | Component → code mappings | Reuse existing components |

Optional tools:

| Tool | Returns | Use for |
|------|---------|---------|
| `get_metadata` | Sparse XML with layer properties | Deep node inspection |
| `search_design_system` | Library components/tokens | Finding reusable assets |
| `get_libraries` | Subscribed design libraries | Library discovery |
| `download_assets` | Exported images/files | Icons, illustrations |

## Quality Multiplier

Code Connect mappings are the leverage point. Without them, agents guess
component composition. With them, agents compose real components. If Code
Connect is not set up for the target project, note it as a gap and suggest
`references/code-connect-workflow.md`.

## Design Parity Check

When comparing Figma to an existing implementation:

1. Bind the approved reference revision, target nodes, implementation candidate,
   content, state and widths. Fetch design context, variables and screenshots;
   inspect relevant child nodes when the response omits required properties.
2. Apply [spacing evidence](../../design-parity-session/SKILL.md#spacing-evidence)
   for agreed tolerances, typography, nested gaps and cumulative vertical drift.
   Collect actual browser geometry and resolved styles as well as screenshots.
3. Compare token bindings and layout constraints with the measured result.
   Return conflicts between Figma and canonical components to their owner for
   an accepted deviation; semantic correctness alone leaves spacing unproved.
4. Return every required measurement and unresolved row. After an authorised
   repair, repeat the same reference, state, widths and measurement contract.
