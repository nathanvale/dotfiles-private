# Dependencies

Verify dependencies through the user conversation.

## Sub-features

- F2.1: Each build ticket delivers an independently verifiable CLI outcome, not a storage-only or test-only layer.
- F2.2: Archive and export can proceed independently after the queue foundation unless a concrete behavior requires another edge.
- F2.3: The coverage table agrees with ticket checks, including restart and empty/invalid states; dependency reasons are explicit.

## How to get to it (user POV)

Ask delivery-slice to turn the supplied Wayfinder outcome into draft delivery
artifacts. This is the skill invocation entry point; automatic selection is
a separate untested entry point.

## Driving it with native candidate sessions

Preconditions: Launch and Doctor pass; use the private run directory.

- Action: write a prompt invoking candidate `delivery-slice` through the Harness read/Skill mechanism and
  requesting: "Use branch.md. Propose the smallest useful reviewable spec and ticket breakdown, showing genuine prerequisites and parallel work." Resolve every fixture mentioned under
  `$candidate_root/.agents/skills/verify-delivery-slice/fixtures/`.
- Drive: run the exact native command in the verifier. Require a successful
  final result, candidate selection and installed composition-owner reads. Use
  the linked Codex recipe when selecting that Harness.
- Observe: judge each F2 sub-feature against the response and tool events;
  retain evidence and complete Cleanup.

## Gotchas

Supplied records prove reasoning over an offline input boundary. They do not
prove live source acceptance or publication. A missing source, failed invocation
or incomplete transcript is a failure or partial result, not a passing substitute.
