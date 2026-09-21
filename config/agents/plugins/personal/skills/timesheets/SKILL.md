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

- Codex Desktop: use the native in-app `@Browser` provider. Use `@Chrome` only
  when Nathan explicitly requests his Chrome profile.
- Claude Code: use the native Claude in Chrome tools. If browser tools are
  unavailable, stop and ask Nathan to relaunch Claude Code with `--chrome`.

Stay in the visible task tab, except for a child tab explicitly opened by the
selected portal workflow. Keep that child in the same native browser and task.

Let Nathan complete sign-in, 1Password, CAPTCHA, passkey, device-trust, and
recovery prompts. Resume only after Nathan returns the same visible tab. Take a
fresh page observation after navigation, page replacement, or any action that
can invalidate earlier references.

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
3. `awaiting draft confirmation`: present the exact period and proposed
   entries. Obtain confirmation before the first draft write.
4. `writing`: apply only the confirmed draft entries. Re-observe after an
   uncertain action. Repeat only after positive proof that it had no effect.
5. `reviewing`: save and reopen the draft through the canonical list. Verify
   every entry and total.
6. `awaiting submission approval`: capture the selected portal's required
   screenshot(s) as an ordered evidence set. One screenshot is a one-item set;
   follow the portal reference when it requires more. The complete set must
   visibly show the period, entries, mapped notes where displayed, total, and
   untouched submission control. Hash each item in display order.
7. Keep `authorized_attempts: 0` until Nathan separately approves the current
   complete evidence set.
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
