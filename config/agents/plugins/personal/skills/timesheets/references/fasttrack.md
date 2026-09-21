# FastTrack360

Expected origin: `https://manpowergroup.fasttrack360.com.au`.

Canonical target: the authenticated Candidate Portal timesheet list with a
visible period row and status, or its explicit empty state. A login page,
historical detail, or opened period detail is not the canonical target.

## Read and propose

- Before proposing entries, ask Nathan about public holidays, leave, sickness,
  and changed working hours in the requested period.
- Select the requested period from the canonical list. Record its contract or
  placement before opening it.
- Use the closest prior `Submitted` row only when its contract or placement
  matches. Offer its work days, attendance type, start and end times, and
  breaks as suggestions.
- Ask Nathan for values when no matching prior submission exists.
- Confirm work days, attendance type, start and end times, and breaks.
- Interpret `9 to 5` as `09:00` to `17:00`. Interpret `no breaks` as no break
  entries.

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
- Use one screenshot only when the header and all daily rows are legible in one
  viewport.
- Otherwise capture two screenshots in order: the header first, then all daily
  rows and totals.
- Hash each screenshot in order. Retain both hashes for a two-image set in the
  private approval receipt.
- Any draft edit invalidates the entire set and its approval. Recapture the
  complete set after rechecking the draft.

## Submitted proof

Return to the canonical list after submission. Open the matching `Submitted`
detail for the same contract or placement and period. Use that detail for final
proof.
