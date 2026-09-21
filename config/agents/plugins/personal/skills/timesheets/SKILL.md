---
name: timesheets
description: "Prepare, review, and optionally submit one FastTrack360 or OnCore timesheet in the native Codex or Claude Code browser."
---

# Timesheets

Prepare one FastTrack360 or OnCore timesheet only when Nathan explicitly invokes
this skill. Nathan controls authentication, draft writes, and submission.

## Portal

- FastTrack360: read [references/fasttrack.md](references/fasttrack.md).
- OnCore: read [references/oncore.md](references/oncore.md).
- Unknown portal: ask which portal. Load one portal reference only.

## Native browser

Use the browser surface supplied by the active Harness:

- Codex Desktop: use the native in-app `@Browser` provider. Keep the task in one
  visible in-app tab. Use `@Chrome` only when Nathan explicitly requests his
  Chrome profile.
- Claude Code: use the native Claude in Chrome tools. If browser tools are
  unavailable, stop and ask Nathan to relaunch Claude Code with `--chrome`.

Let Nathan complete sign-in, 1Password, CAPTCHA, passkey, device-trust, and
recovery prompts. Resume only after Nathan returns the same visible tab. Take a
fresh page observation after navigation, page replacement, or any action that
can invalidate earlier references.

## Checkpoint

Keep one private checkpoint in the current task. Record the portal, period,
account identity, contract or placement, confirmed entries, current phase, and
next safe action. Exclude credentials, cookies, authentication-bearing URLs,
browser identifiers, and screenshots.

## Workflow

1. Open the portal's canonical page in the native browser. Verify the exact
   origin and canonical-page signals before reading timesheet data.
2. Identify the requested period from its canonical list row. Verify the
   contract or placement, editable state, and existing rows.
3. Present the exact period and proposed entries. Obtain confirmation before
   the first draft write.
4. Apply only the confirmed draft entries. Re-observe after each action whose
   outcome is uncertain. Repeat an action only after positive proof that its
   first attempt had no effect.
5. Save and re-open the draft through the portal's canonical list. Verify every
   entry and total.
6. Capture a fresh screenshot showing the period, entries, mapped notes where
   displayed, total, and untouched submission control.
7. Obtain separate approval for that exact screenshot. Any draft change voids
   the approval.
8. Dispatch one Submit click. Treat the portal's native confirmation as part of
   that single authorized attempt. Re-observe the same tab and prove the final
   submitted state.

## Write gates

- Before every write, verify the origin, displayed account, period, and
  contract or placement against the checkpoint.
- Stop on a missing or mismatched identity, duplicate row, wrong period,
  unexplained state, or unknown write outcome.
- Keep the approval receipt private. Record the normalized entries, mapped
  notes, total, screenshot hash, approval text and time, and
  `authorized_attempts: 1`.
- Report submission only from final portal proof tied to the approved identity,
  period, entries, total, and screenshot.

## Stop boundary

Without separate submission approval, stop at the verified saved draft and show
Nathan the screenshot. A request to prepare or fill a timesheet does not
authorize submission.
