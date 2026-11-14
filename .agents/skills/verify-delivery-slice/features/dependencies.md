# Dependencies

Verify dependencies through the user conversation.

## Sub-features

- F2.1: Each build ticket delivers an independently verifiable CLI outcome, not a storage-only or test-only layer.
- F2.2: Archive and export can proceed independently after the queue foundation unless a concrete behavior requires another edge.
- F2.3: The coverage table agrees with ticket checks, including restart and empty/invalid states; dependency reasons are explicit, with no transitively redundant edges.

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
- Repeat with `independent-edits.md` in a separate fresh session. Its existing
  export/persistence behavior is supplied implementation evidence. Require
  independent rename and favorite slices without an invented serial edge.
- Observe: judge each F2 sub-feature against the response and tool events;
  retain evidence and complete Cleanup.

## Gotchas

Keep the audited verification-only follow-on output as a failing negative control.
Required cross-command acceptance must be owned and proved inside a usable
product slice, not deferred to a fourth verification ticket. Read the tickets
and checks themselves; a complete-looking coverage table does not override them.
The reading-queue fixture supplies command entry points, not proof that durable
add/list already works. A later slice using that newly delivered behavior must
retain its prerequisite. The case may justify grouping interacting behavior or
a real behavior-based prerequisite. The independent-edits case must preserve its
supplied independence. Reject edges added only for eventual joint proof, and
reject a direct edge already implied transitively.

Supplied records prove reasoning over an offline input boundary. They do not
prove live source acceptance or publication. A missing source, failed invocation
or incomplete transcript is a failure or partial result, not a passing substitute.
