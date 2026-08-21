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

- The code-review contract below runs at the end of every stage; supervisor
  re-runs gate proof independently before merging.

## Code-review contract (every stage, before merge)

1. **Order**: agent handback → supervisor re-runs the stage gate (bun test,
   typecheck, biome) independently → review → repair → re-verify → merge.
   Gate mechanics are preconditions, not review findings.
2. **Fixed point**: the commit the stage branch forked from the feature
   branch; diff is three-dot against it. Review is invalid if the worktree
   HEAD moves while reviewers run.
3. **Two axes, parallel, isolated** (Opus sub-agents, report-only, read-only;
   findings never merged or reranked across axes):
   - **Standards**: repo AGENTS.md, package CONTEXT.md (vocabulary is
     contract surface; Avoid terms are refusals, including in diagnostics),
     neighbouring-package idiom, and the Fowler smell baseline (judgement
     calls; documented repo standards override; tooling-enforced rules
     skipped).
   - **Spec**: issue 55 body plus the plan comment's rulings, scoped to the
     stage's row. Must verify gate proofs are real (fixtures genuinely
     falsifiable, nothing passing for the wrong reason), hunt scope creep
     (invented schema surface, facade edits, new dependencies, next-stage
     work), and re-derive questionable implementations from the spec text.
4. **Disposition** is the supervisor's, per finding: must-fix (blocks
   merge), should-fix (done unless it destabilizes a green gate), or
   record-only (deferred with a named owning stage, written into this file).
   The implementing agent may decline a finding with reasons in HANDBACK.md;
   the supervisor arbitrates and records the ruling.
5. **One repair cycle** per stage unless Nathan approves more, delivered as
   one consolidated packet to the same stage agent. After repair the
   supervisor re-runs the gate before merging.
6. **pattern-referee** joins only when a diff defends structure by pattern
   name; **cli-execution-auditor** joins at stage 4 and 5 reviews.
- pattern-referee only if a diff defends structure by pattern name;
  cli-execution-auditor at stage 4/5 review.
- Vault edits for this project exist uncommitted in the vault (another
  session holds 25 staged files there); committing them is `vault-git` work.
