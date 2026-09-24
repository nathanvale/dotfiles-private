---
name: playground-slice
description: Grow or resume the My Second Brain playground through small, proven vertical slices. Use to continue an existing Task's note work, choose the next experiment, implement an agreed slice, or assess what a completed slice taught us.
---

# Playground Slice

Build a useful baseline cumulatively. Each slice answers one concrete question
through a complete user or agent journey, then leaves evidence the next session
can recover. Preserve working behavior while testing the next uncertainty.

## Routine note work

For an authorized note update under an existing Task, use this short route.

1. Use the goal named by the caller or valid session panel. If only a project
   is named, read its README to locate the goal. Read that goal and the canonical
   note; follow the family README for note rules. Find an unknown note with
   `bun run list --family <family>`. Preserve the accepted Task and scope.
2. For a missing session binding, use this installed playground plugin. Its
   root is `../..` from this SKILL.md's directory. Assign that resolved absolute
   path to `PLUGIN_ROOT`. New work binds through
   [beads-workflow](../beads-workflow/SKILL.md) and `bin/msb-workflow bind`.
   Main and dev My Second Brain plugins are separate owners. Use the legacy
   manual binding below only for a Task an already-adopted legacy project
   still tracks in Agent Ledger; it is not the route for new adoption. That
   legacy binding, run once from the configured playground root, returns its
   control panel synchronously:

   ```sh
   "${PLUGIN_ROOT}/hooks/recovery-checkpoint" bind projects/<project>/GOAL.md --agent-ledger /absolute/path/to/agent-ledger
   ```

   On this source no registered hook reads that legacy checkpoint, so note
   work without a Bead gets no hook-delivered refresh after compaction; the
   installed manifest is Ticket #52 evidence, not this skill's claim.
   [`packages/workflow-cli/README.md`](../../packages/workflow-cli/README.md)
   owns the registered hook. Codex uses
   `CODEX_SESSION_ID`; Claude adds `--session` with the exact
   identity delivered by its startup hook. Native workers first compare the
   exposed session ID with their independently supplied thread identity: a missing
   identity or inherited parent ID leaves worker binding unavailable. Preserve the saved checkpoint and report
   that gap; the caller's explicit goal still scopes independent note work.
   A refused bind is not permission to replace another owner's checkpoint.
   Continue from the returned control panel; after compaction, re-read the
   goal. On refusal or uncertain context,
   follow the configured vault's `docs/agents/recovery.md` before effects.
3. Before editing, use the Task's own store. For a Task tracked in Beads, read
   and claim it with native `bd` per [beads-workflow](../beads-workflow/SKILL.md).
   For a Task an already-adopted legacy project still tracks in Agent Ledger,
   use [Ledger Steward](references/tasks-first.md#ledger-steward) to inspect
   it and record this execution's start, or resume its owned active run. Keep
   a simple transition in this session. Binding verifies Task identity; it
   does not start work or transfer another agent's execution.
4. With a valid panel, read the goal and affected artifact as needed; inspect
   uncertain prior effects before retrying. For evidence-derived edits, compare
   each changed claim with its source before saving: preserve who or what it
   refers to, scope, uncertainty, and whether it is a suggestion, decision, or
   observed action. Retain source links. Edit only the authorized note, run
   `bun run check`. Keep existing READMEs unchanged.
5. Before returning, close out by the Task's owner. A Beads Task closes with
   native `bd close` per [beads-workflow](../beads-workflow/SKILL.md); an
   already-adopted legacy project's Agent Ledger Task follows
   [tracking closeout](references/tasks-first.md#closeout); a vault-native
   project without an adopted execution store closes with no invented Task.
   Compare the Task's full acceptance with available independent evidence; a
   note edit may cover only part of it. When acceptance is pending, hand back
   the evidence and preserve the active run for continuation. When its verdict
   arrives, resume closeout without waiting for a separate synchronization request.

Finish here for routine note work. Open the branches below only for a new or
changed slice, missing Task ownership, implementation, or requested evaluation.
Source discovery, product research, baseline loading, and slice qualification
are not prerequisites for an existing Task's bounded note update.

## Recover the starting point

For continuation after compaction, use the delivered control panel and read the
goal for the next action. The full entry route below is for new work or a missing
work binding; compaction alone does not require repeating it.

- Resolve the synthetic vault from the caller or
  `~/.config/my-second-brain-playground/vault.json`. Read its `AGENTS.md`,
  root README, baseline, and the family or project involved in this slice.
- Follow its `docs/agents/` branch routes for storage, project maps, and
  post-compaction recovery. Those accepted local rules govern the baseline.
- Before changing plugin implementation, resolve its source through installed
  metadata and the source README. Use installed commands for routine operation.
- Research grounding: when choosing or changing note structure, retrieval,
  goal history, dashboards, recovery, evaluation, or people workflows, use the
  [research routes](references/system-direction.md#research-routes). Read only
  the topic needed to resolve the slice's question.
- On a new session or a lifecycle, dashboard, storage, or integration slice,
  read [the system direction](references/system-direction.md).
- For implementation or evaluation, resume the Task by its owner. A Beads
  Task resumes through native `bd` per
  [beads-workflow](../beads-workflow/SKILL.md); an already-adopted legacy
  project's Agent Ledger Task follows
  [Tasks and checkpoint use](references/tasks-first.md#use-tasks-and-checkpoints-for-the-slice).
  Use the installed checkpoint at meaningful boundaries for either Task owner;
  future Notes and Progress need no substitute. A vault-native project without
  an adopted execution store resumes no Task and has no installed checkpoint;
  recover instead from its canonical `GOAL.md`, README, and latest proof, Git
  history for a prior revision, and ask when context stays uncertain.
- After compaction, recover by the Task's owner. A Beads Task recovers
  through `bin/msb-workflow` session binding and native `bd` state per
  [beads-workflow](../beads-workflow/SKILL.md); an already-adopted legacy
  project uses the installed
  [recovery control panel](references/tasks-first.md#recover-with-the-control-panel).
  Re-read authoritative state and regain the next safe action.
- For a compaction-recovery slice, read
  [recovery checkpoints and qualification](references/compaction-recovery.md).
  Refresh its bounded checkpoint at meaningful work boundaries and recover
  authority before continuing a write.
- Inspect current source, installed behavior, existing tests, and the latest
  completion evidence. Resolve disagreements before building on a claim.
  Name the baseline, relevant uncertainty, selected owners, and available proof.

## Choose one slice

Match the user's request: planning yields a proposal; implementation advances
the agreed slice; a retro examines evidence and recommends the next experiment.
Reading this skill does not activate a Codex goal or authorize a new roadmap.

Describe the slice compactly in the conversation or the existing work owner:

- **Question:** What observed friction or unresolved assumption are we testing?
- **Journey:** Who starts with what, performs which action, and gets what result?
- **Boundary:** Which files and stores change, and what remains future work?
- **Proof:** What would pass, fail, or remain unknown, and who checks it?
- **Stop:** What completed outcome or experimental result ends this slice?

Planning-only requests create no Tasks or goals automatically. For an authorized
implementation or evaluation slice, bind its accepted Task identity in the
readable `GOAL.md` and existing proof, never the README, by the project's
declared owner: a Beads Task binds its native `bd` identity; an
already-adopted legacy project's Task binds its Agent Ledger Register and
Task; a vault-native project without an adopted execution store invents no
Task ID. Preserve that identity across sessions; unavailable commands cannot
create an accepted ID.

Prefer the smallest journey that removes the largest observed obstacle. Include
creation, persistence, retrieval, and later use when the question crosses those
boundaries. A UI, schema, or helper alone cannot prove the full journey.

Reuse the existing command, schema, and storage owner before adding machinery.
New abstractions need pressure from this slice. Build a skill from scratch when
its actual workflow earns one; reuse proven runtime behavior underneath it.
Keep speculative platform work as a candidate in the existing planning owner.

Track a new Task by its project's declared owner. A Beads-adopted project
creates and tracks its Task in Beads: follow
[beads-workflow](../beads-workflow/SKILL.md) for creation, dependencies, and
lifecycle through native `bd`. An already-adopted legacy project uses
[Ledger Steward](references/tasks-first.md#ledger-steward) for lifecycle
changes, batch reconciliation, or a bounded new Task the legacy route already
covers; do not newly adopt Agent Ledger for a project that has not already
adopted it. Use that branch before work begins and at closeout. A vault-native
project without an adopted execution store invents no Task; keep simple
updates in the current session.

## Build and exercise

Choose the least costly sufficient evidence using
[evidence selection](../evaluate-slice/SKILL.md#choose-the-evidence).

Before delegating vault work or selecting a baseline participant/evaluator, use
[the vault agent routes](references/vault-agents.md). Choose the responsibility
and smallest suitable role; keep expected answers out of participant prompts.


- Work in the explicit playground and plugin source. Use synthetic people and
  evidence. Production rollout and owner migration need their own named slice.
- Reproduce a reported defect before fixing it. Use the repository's check and
  test workflows, with public command or durable-state proof for the claim.
- Exercise the installed skill or command when delivery is part of the slice.
  Distinguish source tests, installed bytes, and fresh-session discovery.
- For usability or multi-agent claims, use fresh agents when delegation is
  authorized. Give ordinary task requests, normal entry instructions, bounded
  ownership, and a clean starting context. Keep the intended solution out of
  their prompt. State any unavailable fresh-agent proof as a gap.
- For concurrent writes, use the owning commit skill and independently inspect
  exact committed paths, preserved content, and main state. Prove actual overlap
  for a concurrency claim; separate sessions or same-base candidates alone do
  not establish simultaneous execution.
- Have a fresh reader recover the result when discoverability is in scope.
  Check supported facts, uncertainty, provenance, and the route actually used.
- Inspect the affected state after an uncertain command outcome before retrying.
  A passing fixture supports only the behavior and boundary it actually tested.
- For qualification, use [evaluate-slice](../evaluate-slice/SKILL.md). Freeze the
  request-aligned criteria privately before the run and give a fresh evaluator
  the permitted artifacts and interfaces. Keep the implementer's conclusions out of its prompt.

## Ceremony Smell Check

During the ordinary journey, observe files and commands before the first useful
action; manual ID, path, or fact copying; duplicated state; dependence on raw
SQL, logs, or hidden implementation knowledge; interruptions for trust, recovery,
or verification; and fresh-agent navigation from one entry point.

Record only observed friction in the existing slice proof, using columns
`smell | affected user | evidence | severity | smallest removal`. Separate
product friction from evaluation-harness friction. If none is observed, say so
briefly. Propose a smell as a future slice only when it blocks the journey or
recurs; keep isolated minor friction as evidence.

## Keep the result recoverable

New work tracks Tasks, dependencies, and coordination decisions in Beads
through native `bd`, per [beads-workflow](../beads-workflow/SKILL.md), for a
project that has adopted Beads, with recovery through `bin/msb-workflow`.
Agent Ledger remains the tracked owner, including a new Task, for an
already-adopted legacy project until its explicit cutover; retain that named
existing owner for each responsibility not yet transferred, and do not newly
adopt Agent Ledger for a new Task, Note, or Progress record in a project that
has not already adopted it.
Discover each executable's actual commands and use its public process
contract against the same store. Keep readable artifact bodies in Markdown
and raw receipts in private runtime state.

Reuse the project's goal and evidence view through its project-map contract.
Keep evaluation runs in private runtime state; another test run does not earn
another project packet. Preserve uncommitted goals until their committed bodies
and exact revision pointers make reuse recoverable.

Keep product intent, readable research, and durable synthesis with their packet.
Keep source, schemas, tests, and implementation-binding contracts with code.
Keep raw runs, logs, and receipts in private XDG state with a named retention and
deletion owner. A skill owns this workflow, never the project's live backlog.

Keep the README a small dashboard: purpose, owner routes, verified live queries,
and links to current work and evidence. Store changing task state in its tracker.
Treat an unavailable query as unavailable; retain the current owner until a
replacement works. Build template enforcement only when it is the selected slice.

Before claiming completion, reconcile the slice's Tasks: close a Beads Task
with native `bd close` per [beads-workflow](../beads-workflow/SKILL.md), or
reconcile an already-adopted legacy Agent Ledger Task through
[tracking closeout](references/tasks-first.md#closeout). Report unavailable
Ledger updates explicitly; a completed note alone does not establish
synchronization.

Close with what changed, evidence against each criterion, remaining limits,
exact source/result pointers, and one recommended next slice. Persist accepted
outcomes through the selected owner without appending session narration to the
README. Distinguish implemented, tested, installed, committed, and published.
Continue only within the user's authorized scope.
