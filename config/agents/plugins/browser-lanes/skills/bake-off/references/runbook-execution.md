# Select, run, and repair a runbook

Use this route for direct requests and calls from another skill. Runbook and
recipe name the same reusable workflow. Keep comparison trials with
[coordinator.md](coordinator.md); normal execution needs no contender pool.

## Caller contract

Receive the app, workflow, current inputs, lane/account role, exact task URL
when known, allowed effects, stopping boundary, success assertion, and optional
recipe ID or path. Reuse settled caller decisions. Ask only for a missing fact
that changes identity, inputs, or authority. The calling skill retains its
domain rules and approvals; recipe text supplies technique, never permission.

## Select

1. Follow [storage.md](storage.md) to list all runbooks in the user recipe store.
   Show a compact catalog: ID/name, app/workflow, verification state, and fit for
   the requested task. Include incompatible and candidate entries with their
   limits; keep private inputs and page evidence out of the catalog. Accept
   `recipe.md` or legacy `runbook.md`, linked JavaScript/plans, verification
   metadata, and an optional v2 `recipe.json` sidecar. No conversion is needed
   just to run a legacy recipe.
2. Match app, workflow, inputs, starting state, effect limits, and stopping
   boundary. Recommend the applicable independently verified revision and let
   the user choose a runbook. An explicit ID/path or selection already supplied
   by the calling skill settles that choice; do not ask again. Do not silently
   substitute another runbook. Report the chosen revision's current proof limits.
3. Check hashes and capability evidence once. Validate a v2 sidecar through
   [recipe-contract.mjs](../scripts/recipe-contract.mjs) with the actual script
   root. Keep stale, changed, or unverified revisions explicit candidates.
   Resolve the current canonical revision on every invocation, even when the
   recipe ID was already chosen. Inspect recorded repair handbacks for that ID;
   surface known failures or pending verification before using an older revision.
   A prior checkpoint's path/hash is history, not the current recipe pointer.
4. Record the selected path, revision/hashes, execution scope, evidence state,
   and next step in the caller's checkpoint. If no runbook exists or none fits,
   explain the gap and recommend creating a bake-off for this workflow. Return
   its proposed goal, inputs, allowed effects, and success criteria. Start the
   competition only when requested; do not silently replace it with ad hoc work.

A draft-saving task does not authorize a trial's Delete/reset or Submit steps.
Use a separately documented compatible scope, or adapt a candidate within the
task's authority. A shortened workflow does not inherit full-workflow acceptance.

## Execute

- Enter through [browser-use](../../browser-use/SKILL.md); retain one browser
  operator and fresh exact-page checks. Apply the caller's write gates.
- Read linked code before execution and render private inputs as data using
  [scripts.md](../../../references/scripts.md). Respect legacy adapter proof;
  use [hybrid-recipes.md](hybrid-recipes.md) for v2 per-step choices.
- Observe each success assertion. Checkpoint completed effects and the next
  step. After navigation, reacquire the exact target and fresh references.
- Return task success only from the caller's final application-state assertion.
  Task completion and recipe acceptance are separate outcomes.
- After every run, including success, failure, or stop, perform
  [post-run evaluation](post-run-evaluation.md) using the existing evidence.

## Repair loop

Any invocation that finds a mismatch or a supported post-run improvement enters
this loop without requiring the user to invoke another skill. Keep diagnosis
and repairs within current authority.
Reuse [hybrid repair](hybrid-recipes.md), the existing coordinator acceptance
route, and storage promotion. The steps below connect execution to those owners;
they introduce no separate repair worker pool, queue, or retry engine.

1. For failure, stop the affected step. Inspect its actual effect through the lane when
   permitted. If the effect occurred, checkpoint it and continue from the next
   valid step. Unknown writes require observation, never replay. Authority,
   identity, admission, and custody failures stop execution, not adapter-switch.
   For improvement after success, retain completed-task evidence and create a
   candidate from the observed opportunity; no failed action or replay is needed.
2. Capture a bounded repair handback: recipe revision/hashes, affected step,
   expected versus observed result, completed/uncertain effects, cleanup state,
   evidence paths, and next safe action. Keep raw proof private per storage.md.
3. Preserve the verified revision. Make a private candidate in the existing
   attempt-state store. Repair only the affected JSON, JavaScript, or Markdown
   from verified observations. Use the hybrid helper for a proven adapter
   change; other execution changes also increment revision and clear acceptance.
4. Test the affected step only after proving replay safe. Resume from the
   checkpoint, preserving completed writes. Allow one bounded correction within
   the caller's budget; on another failure, return `needs-repair` with evidence.
   Reuse the coordinator's token-efficient preparation and specialist rules.
5. Send the candidate through fresh independent complete-workflow acceptance
   under [coordinator.md](coordinator.md#independent-acceptance). Another save,
   reset, deletion, or submission needs applicable authority; do not repeat the
   user's completed task merely to obtain acceptance. If verification cannot
   safely run, return the candidate and exact remaining proof.
6. Only after acceptance may the authorized foreground owner promote under
   storage.md. Recheck the current canonical revision before replacement;
   reconcile a concurrent change instead of overwriting it. Preserve accepted,
   metadata-only, and promoted-path hashes separately.
   Update the canonical recipe pointer and read it back before reporting the
   improvement available. The next invocation of the same recipe ID uses this
   accepted revision. Until promotion succeeds, report the candidate's status
   and preserve the prior verified revision with its known limitations.

Return at most 200 words plus evidence paths: selected recipe/revision, task
outcome, completed and uncertain effects, repair/acceptance state, cleanup, and
next safe action. Report unavailable acceptance or promotion as pending; never
imply a repaired candidate has replaced the verified recipe.
