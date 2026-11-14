# Proposal audit

Verify proposal audit through the user conversation.

## Sub-features

- F4.1: Identify the DRAFT-2/DRAFT-3 cycle and remove the unjustified mutual blockers.
- F4.2: Identify duplicate archive outcome and nonexistent AC-99; preserve criterion identities while correcting coverage.
- F4.3: Cover missing restart persistence AC-03 with observable checks; return an acyclic justified graph and complete coverage.

## How to get to it (user POV)

Ask delivery-slice to turn the supplied Wayfinder outcome into draft delivery
artifacts. This is the skill invocation entry point; automatic selection is
a separate untested entry point.

## Driving it with native candidate sessions

Preconditions: Launch and Doctor pass; use the private run directory.

- Action: write a prompt invoking candidate `delivery-slice` through the Harness read/Skill mechanism and
  requesting: "Read branch.md and flawed-proposal.md. Audit and repair the supplied proposed spec/ticket breakdown for review only." Resolve every fixture mentioned under
  `$candidate_root/.agents/skills/verify-delivery-slice/fixtures/`.
- Drive: run the exact native command in the verifier. Require a successful
  final result, candidate selection and installed composition-owner reads. Use
  the linked Codex recipe when selecting that Harness.
- Observe: judge each F4 sub-feature against the response and tool events;
  retain evidence and complete Cleanup.

## Gotchas

Supplied records prove reasoning over an offline input boundary. They do not
prove live source acceptance or publication. A missing source, failed invocation
or incomplete transcript is a failure or partial result, not a passing substitute.
