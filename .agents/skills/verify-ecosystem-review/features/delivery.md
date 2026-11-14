# Delivery-stage recognition and handoff

A user sees where agreed work stands without the review accepting a spec,
publishing tickets, or starting execution.

## Sub-features

- D1: Trace intake, accepted outcome, draft spec checks, and proposed ticket coverage.
- D2: Keep spec acceptance, publication, execution, merge, and activation distinct.
- D3: Recommend a source-linked delivery-slice handoff without invoking it.
- D4: Carry the accepted Markdown handoff information without inventing authority.
- D5: Hand back missing or conflicting authority without fabricating acceptance.

## How to get to it (user POV)

Ask where an accepted idea stands and what needs human attention next.

## Driving it with Codex

Preconditions: Launch and Doctor pass. Use [delivery-flow.md](../fixtures/delivery-flow.md)
as the bounded supplied-artifact input. Leave live planning records untouched.

- Action: Use the verifier's fresh-session command with this prompt: "Where are
  we with this agent ecosystem outcome, and what needs me next? Use the candidate
  ecosystem-review skill from the available skill catalogue. If it is absent,
  report that discovery gap instead of substituting a source-tree skill. Review only .agents/skills/verify-ecosystem-review/fixtures/delivery-flow.md
  as an offline snapshot. Keep this read-only. Identify the loaded skill path."
- Observe: The answer connects I to accepted O, draft spec v1 and AC1 through
  AC3, and the proposed T1 through T3 aliases. It preserves their proposed edges.
- Judge: Spec review is the next human step. The recommendation names
  delivery-slice and links the accepted outcome, draft spec, constraints and
  workflow owner. It carries the concrete-task priority and exclusions forward.
  It leaves unrelated authentication fog open. Missing receipts are coverage
  gaps rather than proof of absent work. Review remains optional orientation.
- D4 judge: The handoff preserves source branch revision fixture-r3 separately
  from spec draft v1, observation time, bounded privacy/exclusions, the supplied
  Decision O acceptance reference, missing drafting/publication/execution
  authority and gaps with consequences. It names the next responsible owner.
  It does not treat the review as a prerequisite for direct accepted-outcome
  delivery. Validate meaning, not exact headings or a serialized schema.
- D5 action: In a separate fresh session, replace the supplied path in the D1
  prompt with `.agents/skills/verify-ecosystem-review/fixtures/handoff-gaps.md`.
- D5 judge: Return a partial review with the inaccessible acceptance source and
  conflicting spec claims, their effect on any handoff, and the next owner to
  recover or resolve them. No accepted outcome, spec approval, live identity or
  downstream authority is invented. Keep unrelated fog separate.
- Boundary: Inspect the event stream. No delivery-slice, to-spec or to-tickets
  invocation, Linear write, execution dispatch, or draft generation occurs.

## Gotchas

This packet has one outcome and no supplied Later or Next records. A review
must name that limit rather than invent outcomes. The example aliases are not
live keys, and proposed dependencies need supporting prerequisite evidence. Grouping alone
does not establish blockers.
Offline qualification proves stage interpretation and recommendation only.
The missing-authority variant is [handoff-gaps.md](../fixtures/handoff-gaps.md).
The integration owner separately proves direct accepted-outcome delivery and
combined composition. Exact headings, canonical shared-contract placement and
deterministic validation remain proposals, not implemented checks.
