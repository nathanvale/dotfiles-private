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
3. If the existing wrapper uses its desktop route, retain its source, bounded
   result, and owned-job cleanup evidence. Keep direct and desktop results
   separate. Confirm no owned helper remains.

## Gotchas

- A GUI unlock report or an existing GUI domain does not prove worker access.
- The 1Password wrapper's desktop retry is a specific owner interface. Do not
  copy it into native harness auth or a different connector.
- Natural expiry, logout, reboot, and foreground execution are separate cases.
