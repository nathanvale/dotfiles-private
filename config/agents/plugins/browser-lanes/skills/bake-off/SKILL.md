---
name: bake-off
description: "Compare Browser Lanes adapters, list and run reusable browser runbooks, or evaluate and repair them after bake-offs and day-to-day workflows."
---

# Browser Bake-Off

Read [Global mode](../../references/lane-entry.md#global-mode) first. When
`free_mode` is true, use that free workflow; the secured instructions below
apply only when it is false.

Produce a tested Markdown recipe with linked JavaScript. Give agents goals,
step contracts, and observable success; let them discover and improve the
technique. Use the existing lane runner and dashboard.

## Choose the work

- New comparison or continuation: read
  [coordinator.md](references/coordinator.md), choose the run mode, and maintain
  its private brief and checkpoint in [report.md](assets/report.md).
- Runbook execution or repair, including calls from another skill: follow
  [runbook-execution.md](references/runbook-execution.md). Select a compatible
  recipe, execute within caller authority, and return supported improvements to its repair
  loop. This route does not start an adapter competition.
- Stop: apply the stop contract in `coordinator.md`, update the checkpoint, and
  leave the competition stopped until the user explicitly resumes it.
- Planning or missing prerequisites: return the brief and exact unresolved
  prerequisite. A request to build this skill does not launch live trials.

## Prepare a comparison

Resolve one current application target and its applicable authority before tab
preparation. Use [contender.md](assets/contender.md) as the shared brief. Give
every adapter identical task inputs and success criteria. Keep site solution
runbooks, competing results, and coordinator history out of contender context.

Recommend Terra / High for the coordinator of a new run. A skill cannot change
the current session model; report a mismatch and offer that setting for the
next run without silently starting another task. Preserve an explicit model
choice for a continuing run. Use the dedicated
`browser_bakeoff_worker` role for one contender per adapter and fresh recipe
acceptance. The coordinator's [worker routing and budget](references/coordinator.md#worker-routing-and-budget)
owns model selection, escalation, attempt limits, and unavailable-role handling.
Do not wrap each browser worker in another planning agent.

Create each adapter's worker with fresh context, then reuse it for its later
attempts. Pass only the brief, assigned adapter skill, ordinary lane guidance,
and its own prior artifacts. Preserve concise learning in private per-adapter
notes for replacement or interruption. Keep one browser operator active.

Enter browser work through [browser-use](../browser-use/SKILL.md). Keep lane
identity, human admission, authentication, and cleanup with their existing
owners. Read [scripts.md](../../references/scripts.md) before executing authored
JavaScript or deciding whether capability qualification can be reused. The
qualification policy in `scripts.md` is the single owner of that decision.

## Run and learn

Dispatch one eligible contender at a time. Verify the recorded starting state
before starting its timer. Let it inspect, experiment, author scripts, recover,
and revise its approach within its budget and authorized effects.

Record every attempt with [report.md](assets/report.md), including failures,
unknown effects, time, and intervention. Stop the attempt on timeout;
retire its browser work, then inspect uncertain page effects before
reset or retry. A disconnected session does not undo page changes or prove
that page JavaScript has stopped.

Update the report checkpoint after qualification, every attempt or reset, and
every stop. At meaningful transitions, report phase, current app, contender and
attempt when active, completed allocation, and next action. Identify setup as
unscored; dashboard activity alone is not competition progress.

Use a non-sensitive `--scenario` value to group equivalent browser calls in
the existing dashboard. One agent attempt may contain several lane runs; the
report owns their mapping and complete timing. The dashboard's last 20 runs
cannot serve as the whole competition record.

## Deliver a reusable recipe

Use [recipe.md](assets/recipe.md). Include the effective technique, starting
conditions, script inputs/effects/results/repeat safety, and evidence limits.
Keep exploration history in the report. A mixed-adapter recommendation needs
its own complete-workflow proof; fastest isolated steps do not prove a recipe.

Give an independent fresh agent only the selected recipe, scripts, task inputs,
and ordinary lane guidance. Report the handoff test separately. A failed
handoff leaves the recipe a candidate. Name corrections and new evidence needed
before calling it verified.

For an Agent Browser-first repair, read
[hybrid-recipes.md](references/hybrid-recipes.md). Before report closeout, run
`node scripts/report-closeout.mjs --file REPORT.md` from this skill directory.

Every bake-off and runbook invocation ends with
[post-run evaluation](references/post-run-evaluation.md), including success,
failure, and stop. Keep task outcome separate from recipe improvement and
acceptance; the retro may conclude that no supported change is needed.

For retention, promotion, inspection, or reuse, apply the available
`context-advisor` skill and [storage.md](references/storage.md). Context Advisor
recommends placement; the authorized foreground driver owns the write. Return
recipe and report paths, verification scope, limitations, and next action.
