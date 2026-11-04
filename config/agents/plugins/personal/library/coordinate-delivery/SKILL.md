---
name: coordinate-delivery
description: Coordinate an authorized task through worker dispatch, handback, independent review, repair and closeout. Use when owning delivery, resuming coordination or clearing a stalled handoff.
---

# Coordinate delivery

Carry the selected task to its agreed stop boundary through its existing owners.
This skill guides coordination. The selected application's role rules, supported
interfaces and the user's grant determine which actions you can perform.

## Recover the current assignment

1. Read the current task, accepted scope, dependencies and latest evidence.
   Keep its outcome and observable completion condition visible.
2. Verify the acting coordinator, execution host, worker and worktree against
   live records. Continue the existing assignment when it still fits.
3. Identify the permitted operations, explicit holds, spending and repair limits,
   authority expiry and stop boundary. Carry valid approvals forward within
   their scope. Resolve conflicts before the affected action.

Continue when the current owner, candidate, next action and authority are known.
A historical handoff or a board label alone establishes none of these facts.

## Dispatch bounded work

- Answer small read-only questions directly. Delegate implementation and
  independent review when the assignment calls for them.
- Check the current task, active worker and PR for overlapping work before
  dispatch. Reuse the existing conversation and preserve its branch and work.
- Give the worker its outcome, owned scope, acceptance, source pointers,
  required evidence, report destination and stop boundary.
- Verify both dependency completion and availability of admitted prerequisite
  code in the assigned checkout before dependent implementation.
- Pass the new delta and readable pointers rather than entire transcripts.
  Qualify remote paths by host. Pair checksums with artifact paths and types.
- Use the selected execution route's supported commands. Read installed help
  for unfamiliar operations. Select skills for the actual gap; use an available
  skill router when needed. A missing optional skill does not block a working route.

Dispatch is complete when the intended existing owner has accepted the assignment
or you have recorded a pending delivery with a concrete reconciliation action.
Queue acceptance alone does not prove that a worker started.

## Act on each handback

Read the exact candidate and evidence before selecting the next action.

- Review needed. Request the existing independent review owner through an
  authorized route and verify its return route. A sent request is not a verdict.
- Acceptance failure. Return a bounded Repair to the same worker with the
  finding, affected criterion, evidence and required check.
- Repeated failure. Diagnose why the earlier Repair missed the cause before
  another attempt. Preserve consumed repair allowance across handoffs.
- Evidence complete. Perform only the authorized next lifecycle operation.
  Review PASS, ready, merged and cleaned up are distinct claims.
- Hold or missing authority. Record the next owner, release condition and last
  proved state in the existing task. Continue unrelated authorized work when safe.

Revalidate the candidate after changes. Reuse evidence only for content and
identities it still covers. Keep native review evidence with its owning mechanism;
an external verdict does not become native evidence by being pasted into chat.
Inspect an uncertain external operation before retrying against the same target.

## Route attention to its owner

Distinguish a human decision from a coordinator action, a worker action or an
observable fact. For ambiguous cards and decision wording, read
[attention examples](references/attention.md).

- Handle review requests, prerequisite integration and routine worker
  continuation within existing authority. Report these as coordination work.
- Ask the human for a material choice, missing authority or authentication they
  own. Explain the blockage, recommendation, consequences and why prior approval
  does not cover it. Keep identifiers and commands in supporting detail.
- Preserve native permission, trust, secret and merge controls and their exact
  action. Use supported interfaces rather than replacing those controls.
- Verify the actual state behind a stale report and update it through its owner.
  Describe a UI classification defect honestly while routing the real work.
- Report meaningful transitions, changed blockers and needed decisions.
  Use the application's no-reply convention for unchanged status.

The next step is owned when its owner and release condition are recorded and the
required request has a verified delivery or a named unresolved delivery gap.
A read acknowledgement does not establish acceptance of implementation or review.

## Close out and retain knowledge

- Verify the task's acceptance, required checks, independent review and authorized
  commit or lifecycle operation before reporting completion.
- Keep candidate revision, evidence pointers, gaps and next action together in
  the existing task or report. Maintain its execution labels through reassignment.
- Preserve conversations and work through the declared retention or cleanup
  procedure. A completed turn alone is not permission to remove resources.
- Keep dated decisions and recurring friction in the existing knowledge owner.
  Bind code claims to a repository and commit. Cite raw execution receipts
  rather than copying them into knowledge notes.
- On resume, refresh live state before acting on retained knowledge.
  Repair contradictions and broken pointers in material used for this task.

## Improve the next task without delaying this one

At a meaningful handback or repeated failure, identify the smallest change that
would help a named next task. Use observed friction, not speculative cleanup.

Apply an improvement only when current authority covers it and it is necessary
for delivery or fits an existing improvement mandate without delaying ready work.
Otherwise record the proposal with its owner and continue delivery. For a new
deterministic check, prove it rejects the observed failure and accepts the valid
case. Broader audits, schedules and third-party maintenance retain their own scope.

## Return the result

Report the proved outcome, exact candidate, remaining gaps, next owner and any
human decision. Distinguish implementation, review, CI, installation and live
qualification. Stop at the agreed boundary.

Adapted from Matt Pocock's [chief-of-staff](https://github.com/mattpocock/skills/blob/main/skills/in-progress/chief-of-staff/SKILL.md).

