---
status: superseded
superseded_by: 0006-private-handoff-token-and-explicit-recovery.md
---

# Reserve a browser lane across attended login

## Context and Problem

ADR-0004 keeps browser credentials with Nathan and the visible 1Password
extension. A single command lease, however, ends before that human login
interval. Another compliant agent could then take the same profile while the
login page, CAPTCHA, passkey, recovery, or post-login navigation is in progress.
The router needs a durable, secret-neutral handoff without becoming a
credential broker or claiming control over clients that bypass it.

Nathan accepted this decision on 4 September 2026.

## Decision Drivers

- Keep credentials inside the visible 1Password browser extension.
- Reserve one declared lane across an unbounded human interval.
- Require explicit, possession-based handback or abort.
- Never unlock merely because time passed.
- Re-prove lane health, single-tab admission, selection, and site origin.
- Keep output and state free of full URLs, titles, page IDs, and account data.
- Preserve truthful limits around non-compliant same-user clients.

## Considered Options

- Option A: End automation at the login wall and rely on social coordination.
- Option B: Build a credential bridge from 1Password into an automation engine.
- Option C: Add a durable attended-login reservation to `browser-lane`.

## Decision

Choose Option C. `browser-lane handoff open` writes one private reservation per
lane while holding the ordinary command lease. It returns a random nonce once
and stores only its SHA-256 digest. Open and stale reservations refuse targeted
inspection, adapter runs, recovery creation or expiry, and a second open.

The human completes login visibly through the 1Password extension. `handoff
resume` requires the nonce and removes the reservation only after fresh health,
one selected admitted page, and the recorded scheme/host/port origin are
re-proved. `handoff release` requires the nonce and aborts without page
inspection. `handoff status` exposes only sanitized coordination state. Expiry
marks a reservation stale but never restores access.

## Accepted revision: reserve before tab admission

Nathan accepted this revision on 6 September 2026. Keep the admitted-page
behavior above available for compatibility.

The original decision made tab admission a prerequisite for reserving a lane.
That ordering exposes a login page to automation before the human has finished
authentication and turns an ordinary visible sign-in into a sharing ceremony.
The revision must preserve exclusive custody, human credential entry, exact
application-origin handback, and the existing security non-claims while moving
reservation ahead of opening and admission.

Consider three options:

- Keep admission before reservation.
- Add a separate pre-login command and state machine.
- Extend `browser-lane handoff open` with an ordinary application URL.

Choose the third option. `handoff open --page-url URL` validates the declared
profile and account role, derives only the intended application origin, writes
the private reservation, and then asks LaunchServices to open that URL in the
declared Chrome profile. It performs no OpenClaw discovery, relay health check,
tab inventory, grant, or adapter work. Omitting `--page-url` keeps the accepted
admitted-page flow for compatibility.

The reservation records `start_mode: pre_admission` and a digest of the exact
declared profile directory alongside the existing task reference, lane,
account role, application origin, timestamps, and nonce digest.
Identity-provider redirects occur outside router observation during the human
interval; the reservation retains only the application origin supplied at
start. `handoff resume` still succeeds only after fresh lane health and one
selected admitted page at the reserved application origin. `handoff release`
cancels without page inspection.

If LaunchServices fails or the command receives a signal after reservation,
the opening effect is uncertain and the reservation remains active. The error
returns the original one-time nonce in its private command result so the
originating task can inspect the visible profile, then resume or release. It
forbids replay because a task tab may already exist. A second task sees either
the short command lease during dispatch or the durable reservation afterward.

This option adds the least caller knowledge because profile opening, reservation,
and interruption recovery remain behind one existing handoff interface. Its
cost is a compatibility field and an error result that must carry the one-time
nonce when opening is uncertain. A separate command would duplicate lifecycle
and recovery rules. Keeping the current order does not satisfy sign-in before
sharing.

Confirm the revision with the public-process rows in
`bin/test/browser-lane-test.sh`: reservation-before-dispatch evidence, zero
relay calls, overlapping attempts, stale state, invalid nonce, process signal,
uncertain launcher exit, explicit cancellation, application-origin handback,
legacy admitted-page compatibility, and secret-shaped URL sanitation. Complete
separately approved visible sign-in journeys in the personal and work
profiles before calling the installed behavior qualified.

## Consequences

- Positive: Compliant agents cannot overlap the human login interval.
- Positive: The router stores no credential or authentication-bearing URL.
- Positive: A lost or stale ceremony fails closed until explicitly resolved.
- Negative: The originating task must retain the one-time nonce long enough to
  resume or release the handoff.
- Negative: A lost nonce requires deliberate operator recovery rather than an
  automatic timeout unlock.
- Neutral: This coordinates callers that obey `browser-lane`. OpenClaw and
  MCPorter expose no attached-client inventory, so the design does not claim
  continuous exclusion of arbitrary same-user clients that bypass the router.

## Options and Tradeoffs

### Option A

- Adds no code but leaves the lane available during its most sensitive human
  interval.
- Depends on every agent and human remembering informal state.

### Option B

- Could remove the human step but expands secret custody into shell processes,
  adapter plans, page scripts, and logs.
- Contradicts the accepted visible-1Password boundary.

### Option C

- Adds durable private state and explicit lifecycle commands.
- Keeps credential entry human-visible and makes stale state a safe stop.
- Cannot control clients that deliberately bypass the router.

## Confirmation

Run `bash bin/test/browser-lane-test.sh`; the public-process contract proves
usage validation, private state modes and schema, nonce hashing, output
sanitation, open and stale refusal, explicit resume and release, same-origin
handback, and command-lease ordering. Validate and activate Browser Lanes
version 0.3.0 in both Harnesses. A real login ceremony remains a separately
approved live pilot.

Authority: Nathan.

## References

- ADR-0004 and `docs/agents/browser-automation.md`.
