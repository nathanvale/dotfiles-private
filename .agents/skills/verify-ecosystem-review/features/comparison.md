# Baseline-aware comparison

A user receives a change summary tied to a supplied baseline rather than invented history.

## Sub-features

- B1: Without a baseline, return a snapshot with no "since last time" claims.
- B2: With a supplied baseline, identify it and substantiate only observed changes.

## How to get to it (user POV)

Ask for a snapshot, or supply a previous review and ask what changed.

## Driving it with Codex

Preconditions: Launch and Doctor pass. Use the same offline packet as the evidence journey.

- Action: Run the evidence journey unchanged for B1.
- Observe: The answer calls itself an offline snapshot and invents no prior state.
- Action: In a new session, append to that prompt: "Compare against the supplied
  previous review at .agents/skills/verify-ecosystem-review/fixtures/previous-review.md."
- Observe: The answer names the 2026-11-12 baseline. B's status and merged design
  note changed, but the Pilot is still unproven and its human project choice
  remains open. F gained conflicting comments and intake. A's discovery,
  C blocking D, and D's accepted answer did not become new progress.

## Gotchas

A time-window request needs accessible dated records for that window. An
unavailable baseline is a comparison gap, not permission to infer change.
Do not persist a review history or update Linear to support this test.
