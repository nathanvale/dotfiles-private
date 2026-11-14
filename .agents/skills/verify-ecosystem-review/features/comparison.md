# Baseline-aware comparison

A user receives a change summary tied to a supplied baseline or dated window
rather than invented history.

## Sub-features

- B1: Without a baseline, return a snapshot with no "since last time" claims.
- B2: With a supplied baseline, identify it and substantiate observed changes.
- B3: With an explicit time window, use dated evidence and expose comparison gaps.

## How to get to it (user POV)

Ask for a snapshot, supply a previous review, or ask what changed in a date window.

## Driving it with Codex

Preconditions: Launch and Doctor pass for each fresh session. Use the supplied
[records](../fixtures/records.md) and [previous review](../fixtures/previous-review.md).
Replace the entire prompt per journey. Do not append a comparison request to
one that asks for no baseline.

- B1 action: Run the evidence journey's no-baseline prompt unchanged.
- B1 observe: The answer calls itself an offline snapshot and invents no prior state.
- B2 action: Use this whole prompt: "Where are we with the agent ecosystem,
  what changed, and what needs me next? Use ecosystem-review from the candidate
  catalogue. Review only .agents/skills/verify-ecosystem-review/fixtures/records.md
  and .agents/skills/verify-ecosystem-review/fixtures/previous-review.md as supplied
  offline records. Use previous-review.md as the comparison baseline. Keep this
  read-only and identify the loaded skill path."
- B2 observe: The answer names the 2026-11-12 baseline. B's status and merged
  design note changed, but the Pilot remains unproven and its project choice
  open. F gained conflicting comments and intake. A's discovery, C blocking D,
  and D's accepted answer are unchanged, not new progress.
- B3 action: Use this whole prompt: "Where are we with the agent ecosystem,
  what changed from 13 November 2026 through 14 November 2026 inclusive in
  Australia/Melbourne, and what needs me next? Use ecosystem-review from the
  candidate catalogue. Review only the supplied offline records at
  .agents/skills/verify-ecosystem-review/fixtures/records.md. Use that explicit
  date window; no previous review is supplied. Keep this read-only and identify
  the loaded skill path."
- B3 observe: The dated B design-note merge falls within the window; A's
  12 November discovery does not. F's updated date does not date each comment
  or intake event. The answer identifies that comparison gap instead of
  claiming all current F content was added inside the window. B's earlier
  status is not inferred from this source set. Usable runtime proof stays absent.

## Gotchas

An inaccessible baseline or undated event is a comparison gap. A current
record's updated timestamp does not establish its earlier contents. The explicit
window covers whole local dates; narrower boundaries need their stated timezone.
Do not persist review history or update Linear to support this test.
