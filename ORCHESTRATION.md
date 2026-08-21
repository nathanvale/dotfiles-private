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
- Stage 2 (generation mechanics): MERGED at 6196783. Post-repair gate 51
  tests, typecheck, Biome clean. Repair closed the delete-before-rename
  fail-closed defect and applied the generator-owned outputDir ruling
  (Handwritten Extensions live beside, never inside, the output directory).
  `regenerateArtifactSet` now refuses a target with no manifest
  (`generation_no_existing_set`). Reasoned decline on record: verify keeps
  its temp-dir regeneration (matches the spec's "regenerating in isolation"
  literally). Ledger counts at this merge: 11 src files, 11 index.ts
  export statements.
- Stage 3 (facade contracts): MERGED at 598f801. Post-repair gate 94 tests
  alone, 120 merged, typecheck and Biome clean. Repair removed invented
  policy and derived semantics from declared tables; consequence on record:
  BOTH candidates now refuse emission via sealed causes
  (emit_write_preview_undeclarable, emit_expectation_column_underivable, one
  unbound no-argument binding). Three Input Schema v1 expressiveness gaps =
  the stage-5 admission worklist: execution-mode surface (or per-command
  previewExemption), blocker-to-command mapping (or declared stations),
  bare-invocation binding. Positive gates run against an amended IR in
  tests/support/emission.ts; amendment is IR-side only. Merge resolution:
  stage 2 kept src/emit.ts, stage 3's front door is src/emit-facade.ts
  pending the consolidation unit's contract-term rename. Ledger counts:
  19 src files, 18 index.ts export statements.
- RUNNING: the consolidation unit (task 7, coherence gate) launched
  2026-08-21 before stage 4. Worktree `.worktrees/issue-55-consolidation`,
  branch `feat/issue-55-consolidation-coherence` (forked at 915c122), Opus 5
  background job `8645262c`, brief at the worktree root (AGENT-BRIEF.md).
  Scope: wire stage-3 emitters into DEFAULT_EMITTERS with a joint
  generate/verify proof, contract-term renames (emit-facade.ts and the
  emit-* family), vocabulary hoists, dedupe residue (semantic.ts
  duplicate-id loops confirmed still present at fork). Completion signal
  HANDBACK.md; then supervisor gate re-run, review, repair, merge. Review
  complete 2026-08-21: gate proofs all reproduced independently; repair
  cycle 1 dispatched (REPAIR-PACKET.md at the consolidation worktree root:
  must-fix M1 write-preview oracle tautology, six should-fix items;
  generation_emit_refused and EmissionResult arbitrated in scope).
- Post-merge AGENTS.md reconciliation worklist (package AGENTS.md, from the
  2026-08-21 writing-for-agents review; the unit already reconciled the Map
  rows for the renamed files): (1) delete the Checks sentence claiming
  repo-level `bun run lint` fails (claim false, and the root AGENTS.md Proof
  bullet it cites was deleted on main at 513ff2f); (2) replace the two
  U+2014 em dashes in the generate.ts Map row; (3) reword the refusal.ts
  row: it owns the artifact refusal shape and the idiom others converge on,
  not "the shape every module reports in"; (4) reword "Generator Contract"
  in the diagnostics.ts row (term undefined in CONTEXT.md); (5) drop "sole"
  from the command-surface-contract.ts baseline-exit wording (semantic.ts
  also validates exits at compile). Also record for stage 5:
  expectations.ts `cause: string` column shares a name with the sealed
  refusal discriminants (pre-existing, digest-frozen).
- Deferred-item audit at 915c122: the input_schema_version exact-match
  check never landed in stage 2 (schema.ts requires nonEmpty only;
  canonical.ts stamps the pinned constant regardless of the declared
  value). Reassigned to the stage-5 admission worklist. For the standards
  fit review: the localeCompare claim is now stale for semantic.ts (0
  hits); diagnostics.ts (2) and build-ir.ts (1) remain live.
- Standards research: twelve unfitted candidates archived at
  receipts/standards-research.md, plus eight community-sourced candidates
  (C13 to C20, last30days pass 2026-08-21) at
  receipts/standards-research-community-2026-08.md. No community evidence
  contradicts the original twelve; candidate 7
  (exactOptionalPropertyTypes + noUncheckedIndexedAccess) is strengthened
  (new tsc --init enables both by default). Pending: one fit review over
  all twenty candidates validating each against witnessed in-package
  evidence before any enters CODING_STANDARDS.md (three claimed live hits
  to verify first: localeCompare in diagnostics.ts/build-ir.ts (semantic.ts
  hit now stale), missing generated banner, missing tsconfig strictness
  flags).
- Stage 4 pilot, then stages 5-7 only with Nathan's go-ahead (stage 5 carries
  the 13-decision admission worklist).

## Standing supervisor rules

- Maintain the package `CODING_STANDARDS.md` as the harvest of supervision:
  when a review or repair cycle surfaces a defect class a written rule would
  have prevented, add one rule stating the idiom (with the lesson it came
  from), and point every subsequent Standards reviewer at the file. Rules
  enter only from witnessed findings, never speculation; a rule tooling
  starts enforcing is deleted. Naming stays in AGENTS.md, vocabulary in
  CONTEXT.md; the standards file points rather than copies.
- After every stage merge, reconcile the package
  `AGENTS.md` (`.agents/runtime/agent-native-state-machine-generator/AGENTS.md`):
  add or correct Map rows for files the stage introduced, update Invariants
  and Checks that changed, and delete stale rows. It is a site map with
  triggers, not a changelog; vocabulary stays in CONTEXT.md, contracts stay in
  code. Invoke `writing-for-agents` before editing it, and scan for U+2014,
  U+2013, U+2019, U+2026. At cycle end, remove the ORCHESTRATION.md pointer
  from its Authority section and reassign its maintenance line.
- After every stage merge (and any material change of plan), write the new
  state back to the vault project packet
  (`projects/agent-native-state-machine-generator/` in the configured vault):
  GOAL.md progress and next safe action, README.md current state. Follow the
  `ultragoal` packet discipline (durable state in the packet, evidence over
  narration, no running activity log) and `writing-for-agents` prose rules
  (single source of truth, no mutable git-state snapshots, link owners).
  Leave vault commits to `vault-git`.

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
7. **Coherence gate (anti-slop), supervisor-owned.** Per-stage reviewers see
   one diff; coherence debt lives between diffs. After merging parallel
   stages, run one consolidation unit before the next stage starts, with its
   own tight brief and review: one meaning per name (no two files or types
   sharing a name with different meanings), one owner per sealed vocabulary
   consumed cross-stage, one idiom for refusals/causes/discriminated unions,
   zero dead guards, every export with a real caller, helper duplicates
   hoisted. Ground every file, type, function, and sealed-vocabulary name in
   CONTEXT.md language: grepping a contract term (Branch Station, Generated
   Artifact Set, Projection Composer, Extension Registry) must land in the
   file that owns it, and a name using a term CONTEXT.md does not define is
   either renamed to the contract term or the term is added to CONTEXT.md
   first (the Progress Owner precedent). The package keeps ONE front door
   (`src/index.ts`); internal file fan-out is challenged at each merge (a new
   file must own a meaning no existing file owns). Track src file and export counts in the stage ledger;
   unexplained growth is a finding, not a fact.
- pattern-referee only if a diff defends structure by pattern name;
  cli-execution-auditor at stage 4/5 review.
- Vault edits for this project exist uncommitted in the vault (another
  session holds 25 staged files there); committing them is `vault-git` work.
