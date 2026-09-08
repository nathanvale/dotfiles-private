# Browser adapter contender

## Goal and authority

- Competition run ID and mode:
- Workflow and one current app:
- Assigned adapter and skill:
- Lane entry guidance:
- Exact approved task inputs (private attachment):
- Authority reference and any later restriction:
- Starting state and success evidence:
- Allowed effects and stopping boundary:
- Attempt number, budget, private output directory:
- Cumulative own prior learning and script artifacts, if any:
- Requested routing, observed model/effort, unavailable fields and any explicit
  applicable user exception:
- Release state: hold browser work until the coordinator confirms route,
  baseline, and lane readiness; the attempt timer starts at release.

Work out an efficient solution using the assigned adapter. Use page JavaScript
when it helps; state script intent, inputs, effects, outputs, and repeat safety.
Verify the complete requested result against the application's persisted state.
For a saved draft, finish your own reopen verification before claiming success.
An action-boundary error may follow successful navigation; follow lane-entry
recovery, inspect the effect and do not replay an uncertain Save. After an attempt, explain
what to change to make the next attempt faster.

Perform browser work yourself; return concrete blockers directly. Stop browser
work between released attempts. Only one operator may use the lane at a time.

Read only the supplied task inputs, assigned adapter/lane guidance,
observed page evidence, and your own prior artifacts. Withhold
other contenders' artifacts, existing site solution runbooks, and coordinator
history. This is an instruction boundary, not a filesystem sandbox claim.

## Runtime evidence

Use the coordinator's supplied routing evidence and applicable user exception.
Keep unavailable fields unverified. An applicable exception resolves that
missing-evidence decision; continue through the normal release checks.

Additional runtime evidence is needed only when the run explicitly requires it.
Inspect only this worker through a supported exact-scope filter. Agent and task status can
include completed summaries: an unfiltered listing can expose competing
solutions. If the available surface cannot exclude other contenders and
coordinator history, report the missing evidence through the existing handoff.

If competing material is exposed, stop before another browser action and report
the exposure source to the coordinator without reproducing the material.
The coordinator owns replacement and attempt accounting.

## Return

Every handback includes these fields, even when the outcome is blocked.

- Outcome and independently observed assertions:
- Elapsed/active time, script time, human waiting, worker usage:
- New routing evidence or changes from the run's declared policy, if any:
- Browser run IDs and cleanup evidence:
- Script/recipe files and hashes:
- Changes from the preceding attempt and next optimization:
- Failure cause, uncertain effects, or required handoff:
- Application effect, uncertain effect, cleanup state, and exact next safe action:
