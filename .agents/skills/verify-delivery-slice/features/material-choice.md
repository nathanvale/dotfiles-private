# Material choice

Verify material choice through the user conversation.

## Sub-features

- F3.1: Sharing remains visible but blocked on read-only versus edit access, with the owning question identified.
- F3.2: The local accepted queue outcome can be drafted without guessing the sharing answer or treating unrelated search fog as a blocker.
- F3.3: No sharing implementation acceptance or readiness is invented.

## How to get to it (user POV)

Ask delivery-slice to turn the supplied Wayfinder outcome into draft delivery
artifacts. This is the skill invocation entry point; automatic selection is
a separate untested entry point.

## Driving it with native candidate sessions

Preconditions: Launch and Doctor pass; use the private run directory.

- Action: write a prompt invoking candidate `delivery-slice` through the Harness read/Skill mechanism and
  requesting: "Read branch.md and material-choice.md. The user requests the accepted queue outcome plus the proposed sharing extension. Draft what is settled and identify the next decision." Resolve every fixture mentioned under
  `$candidate_root/.agents/skills/verify-delivery-slice/fixtures/`.
- Drive: run the exact native command in the verifier. Require a successful
  final result, candidate selection and installed composition-owner reads. Use
  the linked Codex recipe when selecting that Harness.
- Observe: judge each F3 sub-feature against the response and tool events;
  retain evidence and complete Cleanup.

## Gotchas

Supplied records prove reasoning over an offline input boundary. They do not
prove live source acceptance or publication. A missing source, failed invocation
or incomplete transcript is a failure or partial result, not a passing substitute.
