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
- Consolidation unit (task 7, coherence gate): MERGED at 3acce98 (repair
  commit e8bec06). Full receipts (brief, handback with repair section,
  repair packet, both review reports) at receipts/consolidation/. Two-axis
  review reproduced every gate proof independently; must-fix M1
  (write-preview oracle tautology) plus six should-fix items all landed;
  generation_emit_refused and EmissionResult arbitrated IN SCOPE. Repair
  was executed by the supervisor because the stage agent's session stalled
  on a cross-session message approval and was stopped. Post-repair gate:
  127 tests, 0 fail, typecheck and Biome clean, fixture digests
  byte-identical to 915c122. Ledger counts: 19 src files, 18 index.ts
  export statements, 127 tests. DEFAULT_EMITTERS is now front-door;
  BaselineExitCode deleted (zero callers); GenerationFailure carries
  subject.
- NEXT (in order): (a) DONE 2026-08-21: package AGENTS.md reconciled (worklist below closed);
  (b) DONE 2026-08-21: vault packet written back (GOAL.md progress and
  next action, README.md current state; edits uncommitted in the vault,
  vault-git owns the commit); (c) DONE 2026-08-21: standards fit review complete
  (receipts/standards-fit-review-2026-08.md; verdicts 9 admit, 11 already
  covered, 9 reject, 5 defer). Nine rules entered CODING_STANDARDS.md.
  (d) stage 4 pilot. Stages 5-7 still need Nathan's go-ahead.
- Standards compliance debt opened by the fit review (the admitted rules
  name target idioms the code currently violates; repairs need their own
  gated unit because they move fixture digests): five localeCompare sites
  (build-ir.ts:96, branch-stations.ts:312, render.ts:299,
  diagnostics.ts:70, refusal.ts:92) swap to codepoint order, and
  canonical.ts normalizes digest input to NFC with LF (proven divergent by
  probe). Findings for follow-up: F1 the eleven-token stateless sweep is
  vacuous (positive control blocked until durable-machinery surface emits,
  stage-5 worklist); F2 the generated banner has no proving test (cheap);
  F4 tests/ sits outside the typecheck project and the two strictness
  flags are free to enable (one error in tests would surface). Defers with
  owning stages: fsync (11), staging sweep (12) and fixture self-test (V6)
  and mechanized RED (V2) at stage 4; bounded diagnostics (C15) at stage
  5. F3 on record: 200 unknown keys produced 214 diagnostics, 21,303
  message characters, no cap.
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
  also validates exits at compile); (6) point the package
  CODING_STANDARDS.md at the new global standards Branch Document
  (docs/agents/coding-standards.md on main, admitted 2d9b4c4) and drop any
  package rule the global file now owns (one-owner-per-sealed-vocabulary
  overlaps). Also record for stage 5:
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
  (new tsc --init enables both by default). Sibling-suite audits
  2026-08-21 added seven candidates from vault-git-transaction-manager
  (V1 to V7, receipts/standards-research-sibling-tests-vault-git.md) and
  seven from browser-connect + warm-chrome + browser-use-security (B1 to
  B7, receipts/standards-research-sibling-tests-browser.md). Pending: one
  fit review over all 34 candidates validating each against witnessed
  in-package evidence before any enters CODING_STANDARDS.md (three claimed
  live hits to verify first: localeCompare in diagnostics.ts/build-ir.ts
  (semantic.ts hit now stale), missing generated banner, missing tsconfig
  strictness flags). The two sibling receipts also record defects in the
  audited packages themselves (warm-chrome ships synthetic Observed
  Branch Coverage on its public API; vault-git has one circular catalog
  oracle; browser-use-security's custody proof is a source grep) - repo
  repair items outside issue-55 scope, kept there for Nathan.
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
  state back to the vault project packet. The route:
  1. Resolve the vault root through `$HOME/.config/context/vault.md`, then
     follow its entry protocol (vault root AGENTS.md, root README, the
     `projects/` family README) before writing. The packet is
     `projects/agent-native-state-machine-generator/`.
  2. Invoke the `ultragoal` skill (continue mode) and `writing-for-agents`
     before editing; both disciplines bind: durable state in the packet,
     evidence over narration, no running activity log, single source of
     truth, link owners rather than copying, never store mutable git-state
     snapshots (branch, HEAD, ahead/behind, PR/check status).
  3. GOAL.md: add one Progress entry per merged unit stating the gate
     proof observed (test count, digest stability) and any lesson worth a
     rule, with its witness; rewrite Next safe action to the queue head.
  4. README.md: correct the frontmatter `summary:` line if stage state
     moved, extend Current state with what is now true, rewrite Next safe
     action to match GOAL.md. Update `updated:` in both frontmatters.
  5. Check `git status` in the vault first and preserve other sessions'
     staged or modified files; leave edits uncommitted. Commits are
     `vault-git` work only.

- The supervisor is the progress tracker. After every stage merge (and any
  material disposition), post a progress comment on issue 55 via `ghh`
  summarizing the merged unit and its observed gate proof, and keep the
  spec-family issues honest: close a satisfied issue with its verdict
  (precedent: #75 closed 2026-08-21). State plainly in each comment that
  the work sits on the unpushed local feature branch. GitHub Issues owns
  mutable tracker state; never mirror issue status back into this file or
  the vault.
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
