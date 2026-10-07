# OnCore

Open `https://iteraterecruitment.oncoreservices.com/` for sign-in. After sign-in,
follow the site's redirect to authenticated `/pages/ContractorSummary.aspx`.
Do not open bare `/ContractorSummary.aspx`: it redirects to NotFound after login.
If an old sign-in return URL or bookmark lands on
`/Pages/NotFound.aspx?aspxerrorpath=/ContractorSummary.aspx`, open the site root
once and observe the result. Stop if the canonical target remains absent; do
not guess another path.

Canonical target: `/pages/ContractorSummary.aspx` showing Nathan's signed-in
identity, contract sections, and a link for the requested current or outstanding
period. A login page, report, or opened period detail is not the canonical target.

## Read and propose

- Select the requested outstanding period and record its contract or placement
  before opening it.
- In Reports > Submitted Timesheets, select the same contract or placement and
  run the report. Offer the closest prior submitted row's units, unit type, and
  rate as suggestions.
- Ask Nathan for values when no matching prior submission exists.
- Confirm the period, dates, units, rate, and each optional note mapped to its
  date or row.

## Draft

- Verify the opened detail shows the selected contract or placement, exact
  period, and editable state.
- Inspect the complete existing grid before writing.
- For an empty grid, add the confirmed rows.
- For an exact match, make no edit and continue to draft review.
- For a partial or different grid, show the exact delta and obtain confirmation
  before editing.
- Stop on a duplicate, unexplained row, wrong period, or mismatched total.
- For each confirmed absent date, select the rate, enter units and its mapped
  note, then issue one Insert.
- After every Insert result, including an error, observe the same tab again.
  Continue only when the matching row is present or the date remains positively
  absent.
- Use the Telerik date picker so the widget's selected date is set. Text in the
  visible date field alone can save an undated row.
- Verify final row count, dates, rates, units, mapped notes, editable state, and
  total. Capture the draft for screenshot approval.

## Native confirmation and proof

Tell Nathan to watch the visible browser during submission. After approval,
dispatch one Submit click and wait while the native dialog blocks the page.
Nathan accepts or declines the irreversible submission dialog. Stop on an
absent, unexpected, or declined dialog.

After acceptance, observe the same tab and verify the success message. Open
Reports > Submitted Timesheets, select the same contract or placement, and run
the report. Use its matching row, period, total, unit type, rate, and visible
notes for final proof.
