# My Second Brain playground direction

Use this brief to recover the intent behind the experiment. It records Nathan's
2026-09-05 direction and questions for trials, not a replacement for production
contracts or a live roadmap. Refresh product capabilities from their owners.

## What the playground is for

Grow a personal knowledge system through useful, proven increments. Let humans
read their knowledge in ordinary files and let agents find, update, and reuse it
without repairing a sprawling dashboard every session.

Nathan reported excessive complexity in the earlier Vault Git manager, README
drift, unclear goal history, and a reference folder that mixed unrelated kinds of
documents. The playground's smaller commit workflow has bounded proof. Use those
observations to choose experiments; they do not prove production readiness.

The existing `prototype` skill covers throwaway logic or UI questions. This
workflow retains a tested baseline across slices and checks persistence,
retrieval, and agent use. Reach for a throwaway prototype when a specific design
question benefits from it; keep its result distinct from delivered capability.

## Owner boundaries

| Content or behavior | Intended owner |
| --- | --- |
| Skills and plugin implementation | Playground plugin source; later qualified Agent Plugin Kit integration |
| Human-readable knowledge, research, and synthesis | Canonical Markdown notes in the appropriate family or project |
| Accepted tasks, dependencies, coordination choices, and lessons | Agent Ledger where its supported contract and adopted integration cover them |
| Repository issues, implementation contracts, code, and checks | Owning repository and its declared issue tracker |
| Agent launch and supervision | Execution harness or workflow adapter |
| Dashboard | Read-only projection and navigation over those owners |
| File revisions and committed evidence | Git, reached through stable record-to-revision pointers |

Agent Plugin Kit and Agent Ledger have separate responsibilities. Confirm which
product the caller means by "AgentKit" before an integration change that depends
on it. Agent Ledger records coordination meaning; it does not execute agents.
Its coordination Notes are distinct from long-form vault research notes.

Keep tasks and decisions in their current owner until the replacement commands,
selected Register, recovery, and ownership transfer are proved. Discover command
support from the exact executable. A repository checkout or built binary can lag
a delivered result elsewhere. Report this mismatch and find the qualified
artifact; do not silently downgrade the product or invent missing commands.

## Projects and multiple goals: trial recommendation

Reuse a project when purpose, ownership, and context remain coherent across
several bounded outcomes. A new goal does not by itself require a new project.
Create a separate project when an independently finishable outcome needs its own
ownership or lifecycle. Keep ongoing responsibilities distinct from bounded work.

Test one active `GOAL.md` and one latest `result.md` as readable views, with stable
goal/task identities and a completion pointer to the exact Git revision and
paths. Commit goal and matching result before reusing those paths, subject to
the current task's commit authority. Keep the old result identifiable while a
new goal is active. Concurrent goals need separate identities and addressed
views; a shared file cannot represent all their mutable state.

Git can preserve earlier goal and result bodies, but agents need a discoverable
entry to them. A Ledger record or existing tracker should link the goal identity
to the exact commit and path. A commit message search alone is a weak index.
Retrieve an archived body with `git show <commit>:<path>` after verifying that
revision and path. Preserve repository reachability and backup ownership.

This layout is a candidate, not an accepted migration. Prove it by finishing
goal A, starting goal B in the same project, then asking a fresh agent to recover
A's purpose, result, decision rationale, and evidence while identifying B as
current. Compare separate goal files if retrieval or parallel goals justify them.
Include an uncommitted completion and unavailable Ledger in the trial: neither
permits overwriting the only copy of prior evidence.

## README dashboard: trial target

Keep a stable shape with:

1. Purpose and scope.
2. Canonical owners and repository links.
3. Supported queries for current work, next action, and accepted decisions.
4. Links to readable research, the active goal, and completion evidence.

Query live state when the dashboard is used. If a snapshot is needed, identify it
as generated and show its observation time. A projection remains rebuildable
from its owner and does not become a second editable tracker.

Test drift by advancing a task and recording a decision through the actual owner,
then opening the dashboard in a new session without manually rewriting its
status prose. A template alone does not prove this behavior. Test unavailable
queries and distinguish unavailable state from an empty project.

## Readable knowledge and topology

Keep the existing shallow family map as the baseline. Within projects, distinguish
research that answers questions, plans that propose work, and reference material
that explains reusable concepts. Use the existing schema and create a directory
only when there is content for it. Improve navigation by document kind before
considering new top-level families or a bulk move.

Test whether a fresh agent and a human can find the research behind a decision,
separate a proposal from accepted work, and read the full research without a
database. Ledger records can point to those files rather than absorb their bodies.

People remain a future slice. Read the existing people research before designing
it: concise canonical person facts, provenance-bearing current context, linked
ongoing care, and separately reviewed interpretations. Begin with fictional
people; real relationship evidence needs its own bounded authority.

## Research routes

Use this map when a slice needs research grounding or Nathan asks to revisit
our findings. Resolve paths under the vault named by `~/.config/context/vault.md`.
Read the selected section and its evidence or limits as needed; keep the source
research in the vault.

The main synthesis is
`projects/my-second-brain/research/agent-native-second-brain-patterns.md`.
It combines a six-month primary-source review and a 180-day `last30days`
community scan, including findings from the final seven days.

| Slice question | Section in the main synthesis |
| --- | --- |
| Note provenance, freshness, canonical ownership | `Evidence`, `Ownership boundaries` |
| Research, plans, references, conflicting or stale retrieval | `Search and retrieval contract`, `Recommended vertical slices` |
| Multiple goals and completed-goal retrieval | `Project, goal, and history model` |
| Stable README and live queries | `README dashboard contract` |
| Recovery, evaluation, compounding lessons | `Evidence`, `Recommended vertical slices` |
| Strength of community evidence | `Community signal`, `Uncertainty and limits` |

For people notes, read
`projects/my-second-brain/research/people-note-relationship-patterns.md`,
starting at `Project recommendation` and `Remaining uncertainty`.
For shaping bounded work, read
`projects/my-second-brain/research/shape-up-project-operating-model.md`,
starting at `Proposal` and `Smallest useful trial`.

Treat research recommendations as design evidence. Apply current accepted
playground rules and the evaluate-slice evidence policy, including proportional
trials; the synthesis's older repeated-trial recommendation is not a standing
requirement. Verify current Ledger capabilities through their executable owner.
Use external sources when the selected question needs renewed verification;
report a missing local research route rather than inventing its findings.

## Grounding routes

Resolve these packet paths under the configured knowledge vault. Read only the
ones relevant to the slice; they are evidence and design context, not proof of
the current playground or installed runtime.

- `projects/my-second-brain/README.md` and its relevant decisions: product intent
  and earlier accepted packet rules. Flag conflict with the new trial direction.
- `projects/agent-dojo-orchestration-register/README.md` and `result.md`:
  Agent Ledger delivery evidence, dashboard direction, and code-owner routes.
- `projects/plugin-lifecycle-shared-kit-bootstrap/README.md`:
  Agent Plugin Kit ownership and successor routes.

For the synthetic vault and plugin, resolve local paths from the caller,
playground configuration, and plugin metadata. Keep machine-specific addresses
and current task state out of this reusable brief.
