# Evidence interpretation

A user can review supplied records without mistaking a Done claim for a usable outcome.

## Sub-features

- E1: Represent six supplied outcomes across every proposed horizon.
- E2: Distinguish accepted answers and merged source from runtime qualification.
- E3: Report C blocking D without promoting children, related links, or prose to blockers.

## How to get to it (user POV)

Ask for an ecosystem review using a supplied offline source packet.

## Driving it with Codex

Preconditions: Launch and Doctor pass. Use [records.md](../fixtures/records.md)
as the bounded supplied artifact input. No remote fixture or live record changes.

- Action: Replace the normal prompt with: "Where are we with the agent ecosystem,
  and what needs me next? Use ecosystem-review from the candidate catalogue.
  Review only the supplied offline records at
  .agents/skills/verify-ecosystem-review/fixtures/records.md. Return a snapshot
  with no baseline. Keep this read-only. Identify the loaded skill path."
  Use the verifier's same `codex exec` command and separate evidence filenames.
- Observe: The installed skill and the supplied packet are read. The answer
  links its evidence and labels the snapshot offline.
- Judge: A's discovery is proven only on the test laptop at abc123. B's merged
  design note at def456 proves neither an installed nor working Pilot. The
  private-home answer remains accepted and the Pilot project remains open.
  C blocks D; D's single-state answer stays accepted and its read interface open.
  E and F remain represented, preserving their proposed Later placement.
- Sensitivity: In a disposable copy of the answer, replace B's qualification
  caveat with a claim that its Pilot is runtime-proven. The same independent
  judgment must fail that copy and pass the actual answer. Retain both verdicts.
  This tests the judge, not a second production run or live Linear state.

## Gotchas

A status-to-usability inference fails E2. A fixture run cannot prove connector,
authentication, or live current-state coverage. Interpret six as this packet's
count, not an invariant of the real initiative.
