# Agreed outcome

Verify agreed outcome through the user conversation.

## Sub-features

- F1.1: The spec identifies revision 3 and links accepted D1 through D5, with proposals and unknowns separate.
- F1.2: Observable stable criteria cover add/list, validation, restart persistence, archive, export and empty state.
- F1.3: Tickets reference the named spec revision and criterion IDs; unrelated sharing/search/phone fog stays open.

## How to get to it (user POV)

Ask delivery-slice to turn the supplied Wayfinder outcome into draft delivery
artifacts. This is the skill invocation entry point; automatic selection is
a separate untested entry point.

## Driving it with native candidate sessions

Preconditions: Launch and Doctor pass; use the private run directory.

- Action: write a prompt invoking candidate `delivery-slice` through the Harness read/Skill mechanism and
  requesting: "Use the supplied branch.md as the complete synthetic source. Draft the accepted local reading-queue outcome for review only." Resolve every fixture mentioned under
  `$candidate_root/.agents/skills/verify-delivery-slice/fixtures/`.
- Drive: run the exact native command in the verifier. Require a successful
  final result, candidate selection and installed composition-owner reads. Use
  the linked Codex recipe when selecting that Harness.
- Observe: judge each F1 sub-feature against the response and tool events;
  retain evidence and complete Cleanup.

## Gotchas

Supplied records prove reasoning over an offline input boundary. They do not
prove live source acceptance or publication. A missing source, failed invocation
or incomplete transcript is a failure or partial result, not a passing substitute.
