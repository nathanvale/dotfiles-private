---
name: timesheets
description: "Prepare Nathan's weekly FastTrack360 and OnCore drafts in personal Chrome, show screenshots, and submit only after approval."
---

# Timesheets

Prepare a requested portal or both Friday drafts. Nathan has standing draft
authority for normal working weeks: Monday through Friday, OnCore one Standard
Day per day, FastTrack360 Standard 09:00 to 17:00 with no breaks, 40 hours total.
Keep submission separate. For a scheduled run, read
[references/friday.md](references/friday.md) before opening either portal.

## Portal

- FastTrack360: read [references/fasttrack.md](references/fasttrack.md).
- OnCore: read [references/oncore.md](references/oncore.md).
- Both portals or Friday run: process each separately, then present one approval
  request naming each ready portal. Load each reference before that portal.
- Unknown portal outside the Friday run: ask which portal.

## Native browser

Use the browser surface supplied by the active Harness:

- Codex Desktop: use connected personal `@Chrome`, profile `nathanvale.com`.
  Reuse its matching tab or create one visible task tab. Verify the actual
  browser inventory before claiming a tab is open. Use `@Browser` only on an
  explicit request; never silently fall back to another profile or surface.
- Claude Code: use the native Claude in Chrome tools. If browser tools are
  unavailable, stop and ask Nathan to relaunch Claude Code with `--chrome`.

Stay in the visible task tab, except for a child tab explicitly opened by the
selected portal workflow. Keep that child in the same native browser and task.

For a login wall, use the composable [one-password browser-login route](../one-password/references/browser-login.md).
Select `timesheets.oncore` or `timesheets.fasttrack` from its local whitelist.
Use only its exact allowlisted login in the same visible native tab. CAPTCHA,
passkey, MFA, device-trust and recovery remain exceptional handoffs. Take a fresh
page observation after navigation, page replacement, or any action that can
invalidate earlier references.

## Checkpoint

Keep one private checkpoint in the current task. Record the portal, period,
account identity, contract or placement, confirmed entries, current phase, and
next safe action. Initialize `authorized_attempts: 0`. Exclude credentials,
cookies, authentication-bearing URLs, browser identifiers, and screenshots.

## State machine

1. `reading`: open the canonical page. Verify the exact origin and canonical
   signals before reading timesheet data.
2. `proposing`: identify the requested period from its canonical list row.
   Verify the contract or placement, editable state, and existing rows.
3. `draft authority`: for an ordinary current week, apply the standing pattern
   without another question. Obtain confirmation for exceptions or conflicting
   saved rows, not routine empty rows. An ad hoc supplied pattern also grants
   draft authority for its stated period.
4. `writing`: apply only the confirmed draft entries. Re-observe after an
   uncertain action. Repeat only after positive proof that it had no effect.
5. `reviewing`: save and reopen the draft through the canonical list. Verify
   every entry and total.
6. `awaiting submission approval`: capture the selected portal's required
   screenshot(s) as an ordered evidence set. One screenshot is a one-item set;
   follow the portal reference when it requires more. The complete set must
   visibly show the period, entries, mapped notes where displayed, total, and
   untouched submission control. Hash each item in display order.
7. Show the saved screenshots inline, with the exact week and totals, then ask
   once: "Submit both?" or name the one ready portal. Complete evidence capture
   before asking. Keep `authorized_attempts: 0` until Nathan approves that set.
8. `dispatching`: after approval, set `authorized_attempts: 1`, then dispatch
   one Submit click. Treat the portal's native confirmation as part of that
   single authorized attempt.
9. `proving`: re-observe the same tab and prove the final submitted state.

Before dispatch, any draft edit invalidates the entire evidence set and its
approval. Return to `writing`, restore `authorized_attempts: 0`, then repeat the
review and approval phases with a fresh complete evidence set.

## Write gates

- Before every write, verify the origin, displayed account, period, and
  contract or placement against the checkpoint.
- Stop on a missing or mismatched identity, duplicate row, wrong period,
  unexplained state, or unknown write outcome.
- Keep the approval receipt private. Record the normalized entries, mapped
  notes, total, ordered evidence hashes, approval text and time, and current
  `authorized_attempts` value.
- Dispatch Submit at most once for the current approval. Stop on an uncertain
  result. Do not retry under the same approval.
- Report submission only from final portal proof tied to the approved identity,
  period, entries, total, and evidence set.

## Stop boundary

Without separate submission approval, stop at the verified saved draft and show
Nathan the approval evidence set. A request to prepare or fill a timesheet does
not authorize submission.
