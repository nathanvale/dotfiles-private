# Issue-55 orchestration state (supervisor resume anchor)

Supervisor state for the Agent-Native State Machine Generator build
(dotfiles-private issue 55). A fresh supervisor session resumes from this
file plus the vault project
(`projects/agent-native-state-machine-generator/GOAL.md`, staged plan and
gates) and the issue's single plan comment (accepted rulings).

Delete this file when the feature branch is ready to merge to `main`.

## Topology

- Integration worktree: `.worktrees/issue-55-integration`, branch
  `feat/issue-55-state-machine-generator`. Supervisor merges stage branches
  here; nothing is pushed anywhere without Nathan's approval.
- Stage worktrees branch from the feature branch, one Opus 5 background
  agent each (`claude --bg --model claude-opus-5 --effort high`), each opened
  in VS Code for Nathan. Agent contract lives in `AGENT-BRIEF.md` at each
  stage worktree root (untracked); completion signal is `HANDBACK.md`
  (untracked).
- Draft briefs for stages 2 and 3:
  `~/.claude/jobs/6b90cd9c/tmp/stage{2,3}-brief.md` (job-temporary; regenerate
  from the plan comment if gone). Briefs must open with "read the package
  CONTEXT.md first" (vocabulary is contract surface).

## Stage ledger

- Stage 1 (validator + canonical digest): built on
  `feat/issue-55-stage1-validator` in `.worktrees/issue-55-stage1`, gate
  passed (21 tests), two-axis review done. Repair cycle 1 in progress:
  6 must-fix (biome, CONTEXT.md vocabulary in diagnostics, unsafe-retry
  guarded-clause escape + new negative fixture, sealed no_argument_behavior,
  bidirectional version_custody, dead seenEntities check), 4 should-fix
  (typed build-ir access, dedup extractions, selectors ruling,
  competing-invoke detection). Deferred on record: input_schema_version
  exact-match (stage 2 admission/provenance), typed-IR widening (stage 2).
- Stages 2 ∥ 3: fan out after stage-1 merge (generation mechanics ∥ facade
  emitters). Zero facade modification before stage 5; ADD-1/ADD-2 are
  separately reviewed stage-5 prerequisites.
- Stage 4 pilot, then stages 5-7 only with Nathan's go-ahead (stage 5 carries
  the 13-decision admission worklist).

## Standing supervisor rules

- Two-axis code-review (Standards + Spec sub-agents) before every merge;
  one repair cycle per stage unless Nathan approves more; supervisor re-runs
  gate proof independently before merging.
- pattern-referee only if a diff defends structure by pattern name;
  cli-execution-auditor at stage 4/5 review.
- Vault edits for this project exist uncommitted in the vault (another
  session holds 25 staged files there); committing them is `vault-git` work.
