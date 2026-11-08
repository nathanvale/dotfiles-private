# Verify the receiving SSH worker

Complete a handoff only when the receiving process can perform its operation.

## Sub-features

- `handoff-receiver` verifies target account and the exact consumer operation.
- `handoff-desktop` qualifies the owner's desktop delivery when that route runs.

## How to get to it (user POV)

Start the authorized worker through its existing trusted host route. Use the
[handoff fields](../../credential-custody/references/handoff.md).

## Driving it with the receiving owner

Preconditions:

- The receiver and credential-read authority are named.
- A desktop session is available when the existing owner requires it.

1. Run the metadata doctor inside the receiver with `--context ssh` and the
   known target expectations. Keep SSH-marker and GUI-domain limits explicit.
2. Run the authorized credential owner's check and exact consumer operation
   inside that receiver. Require its observed outcome, not the sender's report.
3. Record evidence of the route the owner actually selected, separately from
   the receiver's launch context. Keep direct refusals and desktop results
   separate; metadata and a GUI-domain observation cannot establish that route.
4. Require the owner's independent completeness check for the consumer result:
   exact fixture bytes, expected identities, or pagination completion as
   appropriate. Exit 0 or parseable partial output alone is insufficient.
5. For a temporary desktop route, follow the owner's qualification recipe for
   its supported interruption, deadline, and output-limit cases. Identify all
   temporary resources owned by the request before the failure. Observe their
   absence before the verifier's emergency teardown; parent exit or a successful
   removal command alone does not prove cleanup. Keep inconclusive probes
   unresolved and retain evidence after teardown. Keep mechanism-specific
   commands with that owner.

## Gotchas

- A GUI unlock report or an existing GUI domain does not prove worker access.
- The 1Password wrapper's desktop retry is a specific owner interface. Do not
  copy it into native harness auth or a different connector.
- Natural expiry, logout, reboot, and foreground execution are separate cases.
