---
name: design-parity-session
description: "Run live design parity when comparing Figma, Storybook, or MATest against an approved component or page reference."
---

# Design Parity Session

Drive one visual parity loop while keeping design extraction, live browser
setup, component measurement, and durable evidence with their existing owners.

## Source Split

- Figma owns approved page composition, content, spacing, and placement.
- The canonical component story owns component appearance, variants, states,
  and behaviour.
- Storybook or MATest is the implementation surface being proved.

Stop when the reference pair or ownership class is ambiguous. Never use a
one-off page instance to redefine a canonical component.

## Dependencies

- `figma`: hard dependency when Figma is a source. Missing state: blocked for
  Figma comparison. Next repair: follow its MCP state route.
- Native Harness browser (`$HOME/code/dotfiles/docs/agents/browser-automation.md`):
  hard dependency for live browser proof. Missing state: blocked. Next repair:
  Claude Code: relaunch with `--chrome`; Codex: use `@Browser`.
- `path-component-parity`: optional handoff for component-level Path parity.
  Missing state: collect the required geometry through the native browser;
  report unavailable measurements as incomplete.

## Workflow

1. Resolve the approved reference, implementation surface, viewport, and
   target page or component. Bind source revision, candidate, content and state.
2. Classify the task as page composition, component parity, or both. Keep the
   evidence and fixes separate when both apply.
3. Hand Figma extraction to `figma`. Use the native Harness browser for
   Storybook or the prepared live surface.
4. Map reference nodes to rendered elements and bind the agreed tolerances in
   [spacing evidence](#spacing-evidence) before judging parity. For component
   parity, include that contract with the canonical story pair and selectors
   handed to `path-component-parity` when available.
5. Collect spacing evidence with equivalent screenshots, rendered geometry and
   resolved styles. Trace each discrepancy to the narrowest owner before editing.
6. Fix one owned delta, reload the real code path, and repeat the identical
   proof. Temporary browser overrides are experiment evidence only.
7. Return the measurement rows, state verdicts, screenshots and residuals through
   the repository's parity ledger or tracker when one exists; otherwise include
   them in the handoff. Keep missing measurements and undecided tolerances incomplete.

## Spacing evidence

Reuse tolerances already accepted for this scope. Otherwise record proposed
tolerances and obtain agreement before a pass verdict; measurements may proceed
while agreement is pending. Name each metric, unit and covered states, including
separate limits for local gaps and accumulated drift. Apply each limit to the
absolute difference consistently. Record accepted deviations with their decision
reference; changing a limit after a failure requires a new accepted decision.

For each required state and width:

- Extract expectations from the approved reference, independently of the
  candidate. Map each relevant container and child to its rendered counterpart.
  Record token bindings and numeric values separately.
- Match content, loaded fonts and variant. Record viewport, zoom, capture scale
  and coordinate units; normalize browser geometry to CSS pixels and reference
  geometry to the same scale before comparing.
- Collect rendered bounds with `getBoundingClientRect()` and resolved values
  with `getComputedStyle()`, or equivalent browser measurements. Identify which
  box or text bounds each row represents.
- Measure four-sided padding and actual sibling intervals at each relevant
  nested stack, including the parent composition. For a vertical stack, compare
  `next.top - previous.bottom` in matching coordinates. Collect resolved gap,
  margins and wrapper padding to explain differences in rendered bounds.
- Compare every relevant text role's font family, weight, size, line height,
  letter and paragraph spacing, wrapping, line count and text-box height.
  Inspect painted text as well; report baseline or optical alignment as
  unmeasured when the evidence cannot establish it.
- Check cumulative vertical drift from one mapped anchor. For each successive
  element, compare its top offset from that anchor in both renderings; also
  compare the final bottom offset and total stack height. Record anchor placement
  separately so relative alignment cannot conceal a shifted composition.

Return one row per metric and state with reference node/rendered selector,
expected value, observed value, signed delta (`observed - expected`), agreed
tolerance and unit, pass/fail/unmeasured verdict, and evidence pointer. Include
the drift anchor in position rows. For categorical properties such as font or
token identity, record the exact-match result and mark delta/tolerance
not applicable. Give explicit not-applicable reasons for absent properties.
A matching token, computed gap or aggregate score cannot close missing rows.
Keep screenshot pixel/color thresholds separate from geometry
tolerances. Repeat the same measurements after an authorised fix.

## Next Safe Action

With no arguments, inspect the current Figma URL and live surface, classify
page versus component ownership, then choose one reference pair to prove.
