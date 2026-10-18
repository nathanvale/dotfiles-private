---
status: proposed
---

# Compose approved login custody with native browser workflows

## Context and Problem

ADR-0011 chooses native Harness browsers and attended sign-in. Nathan requested
unattended Friday timesheet preparation on 9 October 2026, then explicitly
requested a generic whitelist rather than a timesheet-specific login system.
This reopens the attended-login branch, not native browser attachment.

## Decision Drivers

- Reuse native Chrome and existing 1Password token custody.
- Add future approved logins through data, not per-portal credential code.
- Keep business actions and submission authority with the consuming skill.
- Keep secrets out of model output, clipboard, source and evidence.

## Considered Options

- Attended extension filling: preserves native attachment and secret custody,
  but requires weekly handholding and cannot meet unattended preparation.
- Per-portal login helpers: meet unattended preparation and action separation,
  but duplicate credential checks and require code for each future login.
- Shared whitelist-backed filling Module: meets all drivers while leaving
  each workflow's navigation and business effects in its skill.

## Decision

Recommend the shared Module under `one-password`, with the user-owned local
whitelist at `~/.local/state/browser-automation/logins.json`. The Interface fills
approved username/password fields through a native Harness Tab. It neither
opens a second browser connection nor performs a business submission.

Nathan authorised the two initial live login bindings. This candidate does not
supersede ADR-0011 or claim a production plugin release is accepted.

## Consequences

- Positive: one implementation owns destination checks and token custody.
- Positive: consuming skills compose login without learning secret values.
- Negative: native Chrome must be connected, and MFA or recovery may still
  require a human. Local weekly execution needs the Mac and Codex available.
- Neutral: the local whitelist limits use of existing grants; it cannot grant
  the token access to another vault.

## Confirmation

Prove unapproved origin/profile and duplicate-field refusals, sanitised errors,
staged login, copied-payload execution and a third config-only login fixture.
Prove real OnCore and FastTrack login through the native browser independently
of draft preparation. Verify the Friday schedule separately from a completed
scheduled run. Revisit if native browser changes break the Interface.

## References

- [Native browser decision](0011-native-harness-browsers.md).
- [Generic login owner](../../config/agents/plugins/personal/library/one-password/references/browser-login.md).
- [Timesheet consumer](../../config/agents/plugins/personal/library/timesheets/SKILL.md).
