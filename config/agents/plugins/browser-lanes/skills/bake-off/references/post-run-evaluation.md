# Evaluate every run

Close every bake-off and day-to-day runbook execution with a brief evaluation
and retro, including failed or stopped runs. Use the existing report/checkpoint
and observed results. Evaluation after Stop is report-only; it authorizes no
browser action, retry, reset, or worker release.

Use the current coordinator or executing agent. Add no default reviewer pool.
Return at most 200 words plus evidence paths:

- Outcome: success assertions, completed and uncertain effects, cleanup limits.
- Friction: failed steps, fallbacks, repeated reads, user interventions, and
  active time or token usage only when measured; otherwise unknown.
- Improvement: one evidence-backed change and expected benefit, or
  `no supported improvement`. Prefer Agent Browser for ordinary steps while
  retaining proven per-step exceptions. Do not invent optimizations to fill a retro.
- Next action: retain the recipe, or create a repair candidate with its exact
  affected step, proof needed, and owner. Distinguish proposed from tested gains.

Record the result in the existing private run report or caller checkpoint;
retain durable repair evidence under [storage.md](storage.md). Do not create
another registry or duplicate the task's history. Reuse measured facts and exact
paths instead of passing full transcripts to another agent.

A supported improvement returns to the
[repair loop](runbook-execution.md#repair-loop), even when the task succeeded.
Use the existing hybrid repair, coordinator acceptance, and storage promotion
owners; do not start a second improvement pipeline.
Create and check a candidate within existing authority; keep the successful
verified revision available until independent complete-workflow acceptance.
Do not repeat Save, Insert, Delete, or Submit to optimize or qualify a recipe
without applicable authority. If testing cannot run safely now, return the
candidate and next verification action. No supported improvement ends the loop.
After successful promotion, record the canonical revision so the next caller
benefits from the improvement instead of rediscovering it.

After a candidate's later verification run, evaluate that run once too. This
is a loop across evidence-producing runs, not continuous polling or an unbounded
optimize/retest cycle in one task. Respect the caller's budget and the one
bounded correction limit.
