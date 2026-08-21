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

- Stage 1 (validator + canonical digest): MERGED at 98c9d8d. Gate 25 tests,
  typecheck, Biome clean; repair cycle 1 complete. Reasoned decline on
  record: the `then` retry-rule key stays (candidate schema surface),
  noThenProperty suppressed with reason. Root biome.json now includes the
  package (blanket `!.agents` replaced by explicit sibling excludes).
  Deferred to stage 2 on record: input_schema_version exact-match check,
  typed-IR widening (acknowledgement/waits/cancellation/authority/versioning
  absent from SpecificationIr; ir.canonical is complete), dedup extraction of
  the three duplicate-id loops in semantic.ts.
- Stages 2 ∥ 3: RUNNING in `.worktrees/issue-55-stage2`
  (`feat/issue-55-stage2-generation`) and `.worktrees/issue-55-stage3`
  (`feat/issue-55-stage3-contracts`), one Opus 5 bg agent each. Expected
  merge conflict: both add exports to the package `src/index.ts`; supervisor
  resolves at integration and wires stage 3 emitters into stage 2 generation
  with a joint proof. Zero facade modification before stage 5; ADD-1/ADD-2
  are separately reviewed stage-5 prerequisites.
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
