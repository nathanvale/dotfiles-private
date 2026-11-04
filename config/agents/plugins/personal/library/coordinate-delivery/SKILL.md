---
name: coordinate-delivery
description: Coordinate an authorized task through worker dispatch, handback, independent review, repair and closeout. Use when owning delivery, resuming coordination or clearing a stalled handoff.
---

# Coordinate delivery

## Contract

- **Inputs.** Resolve the current assignment, accepted outcome, existing owners,
  dependencies, candidate and evidence, applicable authority and agreed stop
  boundary. Include explicit holds, spending and repair limits, and authority expiry.
- **Responsibility.** Move authorized work through dispatch, independent review,
  Repair and closeout. Give every unfinished action a next owner and release
  condition through the existing task and execution routes.
- **Authority.** Act within the user's grant, application role rules and supported
  interfaces. Invocation grants no role, permission or budget. Hold the affected
  action when authority is missing, expired or conflicting. This is behavioral
  guidance; application controls remain responsible for enforcement.
- **Outputs.** Record the proved outcome, exact candidate when applicable,
  evidence pointers, remaining gaps, next action, owner and release condition in
  the existing task or report. Escalate only decisions the human owns. Keep
  implementation, review, CI, installation and live qualification distinct.
- **Completion.** End the coordination step at the verified stop boundary or a
  documented block with its owner and release condition. Keep an unknown delivery
  outcome unresolved. Mark the assignment complete only after its acceptance and
  every required check, review and authorized lifecycle operation are proved.

## Recover the current assignment

1. Read the current records for the contract's inputs. Refresh live state before
   acting on retained knowledge.
2. Verify the acting coordinator, execution host, worker and worktree against
   live records. Continue the existing assignment when it still fits.
3. Carry valid approvals forward within their scope.

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

Report dispatch as accepted only when the intended owner has accepted the
assignment. Record pending delivery with a concrete reconciliation action.
Neither a pending record nor queue acceptance proves that a worker started.

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
- Hold or missing authority. Return the contract's blocked output. Continue
  unrelated authorized work when safe.

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

- Apply the contract's completion criterion. Maintain execution labels through
  reassignment.
- Preserve conversations and work through the declared retention or cleanup
  procedure. A completed turn alone is not permission to remove resources.
- Keep dated decisions and recurring friction in the existing knowledge owner.
  Bind code claims to a repository and commit. Cite raw execution receipts
  rather than copying them into knowledge notes.
- Repair contradictions and broken pointers used for this task within its scope
  and authority.

## Improve the next task without delaying this one

At a meaningful handback or repeated failure, identify the smallest change that
would help a named next task. Use observed friction, not speculative cleanup.

Apply an improvement only when current authority covers it and it is necessary
for delivery or fits an existing improvement mandate without delaying ready work.
Otherwise record the proposal with its owner and continue delivery. For a new
deterministic check, prove it rejects the observed failure and accepts the valid
case. Broader audits, schedules and third-party maintenance retain their own scope.

Adapted from Matt Pocock's [chief-of-staff](https://github.com/mattpocock/skills/blob/main/skills/in-progress/chief-of-staff/SKILL.md).

