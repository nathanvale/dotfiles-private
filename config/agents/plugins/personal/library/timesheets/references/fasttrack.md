# FastTrack360

Expected origin: `https://manpowergroup.fasttrack360.com.au`.

Canonical target: the authenticated Candidate Portal timesheet list with a
visible period row and status, or its explicit empty state. A login page,
historical detail, or opened period detail is not the canonical target.

## Automatic login

Start through [1Password's owned-session startup](../../one-password/references/agent-browser.md#installed-route),
then use the existing token-backed `timesheets.fasttrack` binding with its
[staged credential-fill route](../../one-password/references/agent-browser.md#staged-login).
Reuse only that task's known safely created owned session, after verifying its
protected account.

1. At the username-first screen, observe its unique username input and Next
   button. The observed input on 2 November 2026 was `#lgUserName`.
2. Fill `username` through the plugin. On a confirmed filled result, click Next
   once and wait for the password stage.
3. Verify the unique password input is masked. The observed input was
   `#lgPassword`. Fill `password` through the same plugin and session.
4. Observe and click Login once. The observed control was `button.btn-login`.
5. Verify Candidate Portal's protected name and candidate number against the
   private approved binding before opening Time And Attendance.

Re-observe controls when the page changes. A different account, rejected login,
missing binding or uncertain fill stops that attempt. Native complete-form
`auth login` does not handle FastTrack's intermediate Next screen.

The dedicated browser needs the approved FastTrack origin and Google Maps
runtime hosts `maps.google.com`, `maps.googleapis.com` and `maps.gstatic.com`.
Without them, the app can redirect after login but fail before rendering the
protected account. Keep credential delivery restricted to the FastTrack origin.

FastTrack permits one active browser or device for this account. Run its login
and timesheet work sequentially across Macs and harnesses. A new login can
invalidate the other session. If the site explicitly says it signed out this
session because another browser or device signed in, acknowledge its Ok control
once, observe the login form, then use the same approved staged route. Reopen
and recheck the saved draft before relying on an earlier screenshot approval.

## Navigation and state

- Click Quick Access once. Inspect the tab list and switch to its new child tab.
- Repeat Quick Access only after the tab list proves no new tab opened.
- Wait for asynchronous state to settle. Continue only when the tab count,
  visible section heading, and matching grid row count agree with the intended
  view.
- Use `timeAndAttendanceGridAvailable` for the available-timesheets grid.
- Use `timeAndAttendanceGridHistorical` for the historical-timesheets grid.
- Use `timeAndAttendanceGridIncomplete` for the incomplete-timesheets grid.
- Use `timesheetAttendanceGrid` for the opened attendance grid.

## Read and propose

- For a Friday run, use the standing normal-week pattern and exception gate in
  [friday.md](friday.md). Ask only about a detected exception or conflicting row.
- Select the requested period from the canonical list. Record its contract or
  placement before opening it.
- Use the closest prior `Submitted` row only when its contract or placement
  matches. Offer its work days, attendance type, start and end times, and
  breaks as suggestions.
- Ask Nathan only for required values absent from the standing or explicitly
  supplied pattern. Submitted history is optional for a normal-week draft.
- Use standing draft authority for the normal pattern; confirm only a changed
  pattern or an exception.
- Interpret `9 to 5` as `09:00` to `17:00`. Interpret `no breaks` as no break
  entries.

## Draft

- Verify the opened detail shows the selected contract or placement, exact
  period, and editable state.
- Fill confirmed work days only. Leave every other day empty.
- Remove an already saved row only with its Delete control. Clearing its fields
  can restore the saved values.
- Blur the active control or press Tab before verifying every daily total and
  the weekly total.
- Re-read all seven rows and calculate the visible total before saving once.
- Return to the canonical list. Prove the matching row is `Incomplete`, then
  reopen that row from the list.
- Recheck the identity, period, normalized entries, editable state, and total.

## Approval evidence

- Capture the reopened draft as an ordered approval evidence set.
- Use one screenshot only when the header and period, all daily rows, totals,
  and untouched submission control are legible in one viewport.
- Otherwise capture ordered screenshots: header and period first, then all daily
  rows and totals. Include the untouched submission control in the set; add a
  final screenshot if needed.
- Hash each screenshot in order. Retain every hash in the private approval
  receipt.
- Any draft edit invalidates the entire set and its approval. Recapture the
  complete set after rechecking the draft.

## Submitted proof

Return to the canonical list after submission. Open the matching `Submitted`
detail for the same contract or placement and period. Use that detail for final
proof.
