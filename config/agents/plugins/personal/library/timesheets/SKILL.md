---
name: timesheets
description: "Log in automatically, prepare Nathan's weekly FastTrack360 and OnCore drafts, show screenshots, and submit only after approval."
---

# Timesheets

Prepare a requested portal or both Friday drafts. Nathan has standing draft
authority for normal working weeks: Monday through Friday, OnCore one Standard
Day per day, FastTrack360 Standard 09:00 to 17:00 with no breaks, 40 hours total.
Keep submission separate. Before using standing draft authority, read
[references/friday.md](references/friday.md) and complete its exception check.

## Portal

- FastTrack360: read [references/fasttrack.md](references/fasttrack.md).
- OnCore: read [references/oncore.md](references/oncore.md).
- Both portals or Friday run: process each separately, then present one approval
  request naming each ready portal. Load each reference before that portal.
- Unknown portal outside the Friday run: ask which portal.

## Browser and automatic login

In Pi, Claude Code and Codex, use the installed dedicated Agent Browser route
from [one-password](../one-password/references/agent-browser.md). Use one short,
unique task session per portal and include its dedicated configuration on every
command. Keep login, draft preparation and review in that same session.

Reuse a signed-in session only after verifying the intended account. At a login
wall, read the portal reference and check its enabled dedicated-browser binding.
Use native auth login for `timesheets.oncore`, or the staged credential-fill
route for `timesheets.fasttrack`, on the binding's exact HTTPS origin.
The one-password reference owns credential delivery and login checks. Verify
the protected account before opening a timesheet. Keep credentials outside
model-visible commands and screenshots.

Use the portal reference for navigation, entries, saving and screenshots.
Observe child tabs before switching to them. Take a fresh page observation
after navigation or a page replacement. CAPTCHA, passkey, MFA, device-trust and
recovery are exceptional handoffs. A missing binding or failed custody check
blocks that portal; report its concrete repair instead of repeatedly asking
Nathan to sign in.

Keep the owned session open while awaiting approval when the runtime permits.
On resumption, recheck the account, period, contract and saved entries against
the approval receipt. If the session expired, repeat the approved login route
and reopen the saved draft. Obtain fresh evidence and approval when the draft
changed or its identity cannot be established. Close only the owned session
after completion or explicit abandonment.

## User-present fallback

Use a native personal browser when Nathan explicitly selects that route:

- Codex Desktop: use connected personal `@Chrome`, profile `nathanvale.com`.
  Reuse its matching tab or create one visible task tab. Verify the actual
  browser inventory before claiming a tab is open. Use `@Browser` only on an
  explicit request; never silently fall back to another profile or surface.
- Claude Code: use the native Claude in Chrome tools. If browser tools are
  unavailable, stop and ask Nathan to relaunch Claude Code with `--chrome`.

Stay in the visible task tab, except for a child tab explicitly opened by the
selected portal workflow. Keep that child in the same native browser and task.

For a native login wall, follow the supported fallback in
[one-password browser login](../one-password/references/browser-login.md).
Keep the fallback separate from unattended login proof.

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
3. `draft authority`: after checking exceptions, apply the standing pattern
   for an ordinary requested week without another question. Obtain confirmation
   for exceptions or conflicting saved rows, not routine empty rows. An ad hoc
   supplied pattern also grants draft authority for its stated period.
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
approval. Restore `authorized_attempts: 0`. Preserve conflicting saved rows and
obtain the portal's required decision before editing. Repeat review and approval
with a fresh complete evidence set after any authorised changes.

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
