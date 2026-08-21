# Issue-55 orchestration state (supervisor resume anchor)

Supervisor state for the Agent-Native State Machine Generator build
(dotfiles-private issue 55), branch feat/issue-55-state-machine-generator.

Resume sources, in order:

1. This file. On disagreement about the queue, this file wins; write the
   vault packet back to match.
2. The vault project packet `projects/agent-native-state-machine-generator/`
   (GOAL.md stage gates; README.md current state). Resolve the vault root
   per `$HOME/.config/context/vault.md`.
3. Issue 55's body and its single plan comment (accepted rulings, stage
   table, facade contract). Fetch route: package AGENTS.md Authority
   section.

Resume step 0: run `git status` in this worktree and reconcile every dirty
file against the queue head before any other action, then check
`.worktrees/issue-55-*` for a stage worktree holding an AGENT-BRIEF.md
without a HANDBACK.md (a live stage run; never re-charter over one). Work
can be in flight; the ledger lags the tree, and the in-flight block under
Next holds the pipeline position.

## Before committing an edit to this file (every edit)

Structural rewrite (sections reordered, a contract changed): invoke
writing-for-agents first. Routine status edits run this checklist alone.

1. Each fact this edit touches is stated in exactly one place: edit the
   existing line, then grep the fact's key term and delete survivors.
2. Each numeral this edit writes is an observed receipt (a gate run, a
   merge hash) or is replaced by a pointer to the list, glob, or receipt
   that owns it; recount any that remain against their source now.
3. Recorded lines carry closed state with a hash or date. Mutable state
   (git status, other sessions' work, counts elsewhere on disk) appears
   only as an instruction to look, resume-step-0 style.
4. Every item under Next is live: work this edit closed moved to the
   ledger or was deleted.
5. A new ledger entry matches the shape rule at the Ledger heading, or
   this edit rewrites that rule to match precedent and says so.

## At merge (checklist, in order)

1. Create backup branch `archive/issue-55-orchestration` at the current
   feature-branch HEAD, before step 4's deletion commit. Nathan's ruling
   2026-08-21: this file and `receipts/` feed a planned orchestration
   skill; keep both recoverable. `receipts/` is tracked and merges with
   the branch. Open design question for that harvest, 2026-08-21: the
   orchestration skill owns the outer loop (charter, brief, gates,
   review, ledger) and its stage briefs should name the existing
   `implement` and `tdd` skills as the stage agent's inner loop; this
   run's briefs bypassed `implement` entirely, so the composition is
   undecided.
2. Post the three out-of-scope repo defects as issues on
   nathanvale/dotfiles-private via ghh for Nathan: warm-chrome synthetic
   observed coverage, vault-git circular catalog oracle,
   browser-use-security grep-based custody proof. Evidence:
   receipts/standards-research-sibling-tests-browser.md and
   receipts/standards-research-sibling-tests-vault-git.md.
3. Migrate every unfinished item under Next, including the stage-5
   worklist and open findings, to the vault packet's Next safe action.
4. Delete this file on the feature branch; remove its pointer line from
   the package AGENTS.md Authority section. The vault packet becomes the
   build-state owner.

## Next

1. Awaiting Nathan: the stage 5 to 7 go-ahead, and the stage-5 decision
   packet rulings (receipts/stage5-decision-packet.md, posted to issue
   55).
2. Stage 5 carries the 13 unresolved decisions named in the plan
   comment's stage-5 row (drafted resolutions in
   receipts/stage5-decision-packet.md, posted to issue 55) plus the
   build-added worklist below, now strengthened by the Agent Worktree
   draft's 14 receipted schema gaps
   (receipts/agent-worktree-draft-gaps.md).

Stage-5 admission worklist (build-added; the plan comment owns the 13
base decisions):

- Three Input Schema v1 expressiveness gaps from stage 3: an
  execution-mode surface or per-command preview exemption; a
  blocker-to-command mapping or declared stations; a bare-invocation
  binding for no-argument behavior. Tests pin each gap and fail loudly
  when a later schema closes one.
- input_schema_version exact-match check (never landed in stage 2:
  schema.ts requires nonEmpty only; canonical.ts stamps the pinned
  constant regardless of the declared value).
- Bounded diagnostics (C15; F3 evidence: 200 unknown keys produced 214
  diagnostics, 21,303 message characters, no cap).
- F1 positive control: the durable-work token sweep is vacuous until a
  durable-machinery surface emits.
- expectations.ts `cause: string` column shares a name with the sealed
  refusal discriminants (pre-existing, digest-frozen).
- From the stage-4 review (evidence in receipts/stage4/): a
  fact-to-branch selection surface (the pilot's fact-to-station mapping
  stays handwritten because v1 declares none); a script/entry surface
  (the generated `script` field derives a convention wrong on disk for
  the pilot and absent from the rendered conventions header); banner
  wording asserting "Admitted" on unadmitted output (src/render.ts
  owner); root-level branches without stations (unknown command,
  front-door crash, help; v1 has no root-command surface); the crash
  path's undeclared exit-1 meaning; the never-fired blocker column in
  invalid-usage rows (name it inside the blocker-mapping decision);
  mechanical-auditor discoverability of the pilot's generated contract;
  a ruled mapping between the facade's `retryable` and Exact Same-Input
  Retry Safety; export STOP_SCOPES and sealed authority/completeness
  lists from the front door; the expectations.ts plural-blocker prose
  fix. From the findings repair: emit_expectation_action_unknown is
  structurally unreachable through the derivation seam (the catalog
  lookup and action resolution read the same ir.actions.catalog), which
  contradicts refusal.ts's "every cause here is reachable" header;
  decide between deleting the dead guard and its sealed cause (a
  Generator Contract change) or declaring the surface that makes it
  reachable. The pinned unproducible list in
  tests/support/refusal-producers.ts fails loudly when a src change
  makes it producible.

Open findings, dispositions only (evidence at
receipts/standards-fit-review-2026-08.md, "Findings for the supervisor"):

- F2, cheap: the generated banner has no proving test.
- F4, half closed at de1789d: tests/ joined the typecheck project and
  its one error is repaired. The two strictness flags stay off,
  measured 2026-08-21: enabling them surfaces seven errors in the
  read-only cli-command-facade source and nine in the throwaway
  prototype, both outside this package's authority. The facade errors
  are real facade defects; route them to stage 5's separately reviewed
  facade work.
- F5, defect: the version-envelope assertion in
  tests/digest-determinism.test.ts restates the constants it checks. The
  global independent-oracle rule owns the policy; enforcement is missing.
- F6, defect: two second copies of single-owner fixtures (amend() in
  tests/derivation-cross-validation.test.ts with a false doc comment; the
  second durable-work term list in tests/generation-mechanics.test.ts,
  delete per F1).
- F8, low: the tests/rendered-typecheck.test.ts scratch file lands inside
  the package while its header claims outside.
- F9, defect: four sealed causes have no fixture
  (structure_missing_required, structure_type_mismatch,
  emit_expectation_action_unknown, emit_retry_posture_unresolved). The
  sealed-cause iteration rule in CODING_STANDARDS.md has no implementing
  test yet.

## Topology

- Integration worktree: `.worktrees/issue-55-integration`, branch
  feat/issue-55-state-machine-generator. Supervisor merges stage branches
  here; nothing is pushed anywhere without Nathan's approval.
- Stage worktrees branch from the feature branch at
  `.worktrees/issue-55-<unit>`, one background agent each, opened in VS
  Code for Nathan. Create them with an absolute path from the repo
  root: a cwd-relative `git worktree add` nested one checkout inside
  the integration package tree on 2026-08-21 (recovered; the branch
  was unaffected). Launch recipe: historically `claude --bg --model
  claude-opus-5 --effort high`; stage 4 runs on the supervisor
  session's inherited model after the harness rejected that
  model-effort combination on 2026-08-21. Review axes run as
  report-only background sub-agents. Agent contract: AGENT-BRIEF.md at
  the stage worktree root; completion signal: HANDBACK.md. Both are
  untracked during the run, then archived at `receipts/<unit>/`
  (stages 1 to 3 hold brief and handback only; their reviews were
  delivered inline; consolidation/ also holds the review reports and
  repair packet).

## Ledger (merged units)

Bare filenames resolve under
`.agents/runtime/agent-native-state-machine-generator/`. An entry records
closed state only: merge hash, gate counts, the AC lines satisfied or
left open, declines and repairs on record, receipts path. Open work moves
to Next or the stage-5 worklist.

- Stage 1, validator plus canonical digest: MERGED 98c9d8d. Gate: 25
  tests, typecheck, Biome. Decline on record: the `then` retry-rule key
  stays (candidate Input Schema surface). The deferred-item audit at
  915c122 left only input_schema_version outstanding (stage-5 worklist).
  Receipts at receipts/stage1/.
- Stage 2, generation mechanics: MERGED 6196783. Gate: 51 tests. Repair
  closed the delete-before-rename fail-closed defect (replacement renames
  first). The output directory is generator-owned; Handwritten Extensions
  live beside it. regenerateArtifactSet refuses a target with no manifest.
  Decline on record: verify keeps temp-dir regeneration. Receipts at
  receipts/stage2/.
- Stage 3, facade contracts: MERGED 598f801. Gate: 94 tests alone, 120
  merged. Repair derived semantics from declared tables and removed
  invented policy; consequence: both spike candidates refuse emission via
  sealed causes, and the three gaps seed the stage-5 worklist. Positive
  gates run against an amended IR in tests/support/emission.ts (IR-side
  only). Receipts at receipts/stage3/.
- Consolidation unit (coherence gate): MERGED 3acce98, repair e8bec06.
  Gate: 127 tests; fixture digests byte-identical to 915c122; 19 src
  files, 18 index.ts export statements. Review reproduced every gate
  proof and caught the write-preview oracle tautology; six should-fix
  landed; generation_emit_refused and EmissionResult arbitrated in scope.
  The stage agent's session stalled and was stopped; the supervisor
  executed the repair. Receipts at receipts/consolidation/.
- Standards fit review plus amendment: 9c9ae9d, 1f1d55d. All 34 research
  candidates ruled: 10 admit, 11 already covered, 8 reject, 5 defer. Ten
  rules entered CODING_STANDARDS.md. Receipt:
  receipts/standards-fit-review-2026-08.md; research evidence in the four
  receipts/standards-research*.md files.
- Standards repair unit 1, codepoint order and NFC/LF digest input:
  8b7efa4. compareCodepoints in canonical.ts is the one comparator owner;
  every string reaching the digest, keys included, normalizes to NFC with
  LF. Two new digest guards went RED with normalization gutted. Gate: 129
  tests, typecheck, Biome. Charter correction: fixture digests did not
  move; both spike candidates were already NFC with LF (digests:
  vault-git 7f85428e, fallow c26764f0).
- Standards repair unit 2, switch exhaustiveness, closes F7: ede5d87.
  structural.ts walk and jsonc.ts toPlainValue end in `const _: never`
  checks. RED probes: a dummy variant in each sealed union fails
  typecheck at exactly the new check. Gate: 129 tests, digests unchanged.
- Standards repair unit 3, staging sweep, admits candidates 12 and V6:
  a3b642f. sweepStaleStagingSiblings runs before each staging mkdtemp;
  the plant-both-kinds test proves the deleted half and the survivor
  half; RED observed with the sweep disabled. Receipt verdicts moved
  DEFER to ADMIT-PACKAGE (totals 12 admit, 11 already covered, 8
  reject, 3 defer); candidates 11 and V2 found no stage-4 evidence and
  stay unadmitted. Twelve rules now in CODING_STANDARDS.md. Gate: 140
  tests, typecheck, Biome, pilot verify clean, spike digests
  byte-identical.
- Agent Worktree draft candidate (schema insurance, plan-comment
  parallel track): MERGED c01d7d9 (unit commit 8ca6420, pure
  additions). The draft compiles under frozen Input Schema v1 (digest
  5052805..) and derivation refuses fail-closed with 44 sealed
  refusals, pinned by six tests with an observed RED. Fourteen schema
  gaps receipted (receipts/agent-worktree-draft-gaps.md), including
  surfaces the product already declares that v1 cannot express
  (dry_run execution modes), blocker-to-action mapping, a fourth retry
  class (inspect_first), and the changed_state recovery column. The
  candidate stays UNADMITTED; 16 unresolved_decisions surfaced, none
  invented. Gate: 182 tests, typecheck, Biome, pilot verify clean,
  spike digests byte-identical. Receipts at receipts/aw-draft/.
- Stage-5 decision packet (parallel track): delivered 2026-08-21. All
  13 decisions grounded in the vault-git spike candidate's
  unresolved_decisions array; archived at
  receipts/stage5-decision-packet.md; posted to issue 55.
- Pilot Specification Admission: 657045e, Nathan's explicit act
  2026-08-21 ("admit the pilot", this supervisor session; recorded in
  the candidate header and on issue 55). Bundled digest-moving edits:
  the arbitrated invariant-prose fix and spec_meta identities to
  revision 1. Set regenerated under admitted digest af827747..b3e99a
  after the stale-set refusal fired correctly. Gate: 176 tests,
  typecheck, Biome, verify clean, raw smoke exit 0. The pilot's
  generated Admitted banner is now true; the pilot still claims nothing
  toward qualification.
- Findings repair (F2, F5, F6, F8, F9): MERGED 7dcd47c (five unit
  commits, fork 7062fb1, tests and fixtures only). Gate: 176 tests,
  typecheck, Biome, pilot verify clean, spike digests byte-identical;
  RED proven for the iteration test both ways (removed fixture row and
  removed producer each fail naming their cause). Bound to the admitted
  candidate-10, V3, V4, and independent-oracle rules: the sealed-cause
  iteration now runs in-suite over both vocabularies with a shared
  CASES registry and live refusal producers; two new negative fixtures
  close structure_missing_required and structure_type_mismatch; the
  vacuous durable-machinery sweep and the false-commented amendment
  copy are deleted; the version envelope pins literal oracles; the
  rendered-typecheck scratch lives outside the repository. Arbitrated
  decline accepted: emit_expectation_action_unknown unreachable (queued
  as a stage-5 worklist decision). Receipts at receipts/findings-repair/.
- Stage 4, Vault Git Reimagined pilot (learning only): MERGED 30d5bff
  (five stage commits 0eb9f12 through repair 070dc90, fixed point
  fbd2931). Gate: 139 tests, typecheck, Biome, verify clean (5
  outputs), pilot digest 8e7ea8c0..9736 unchanged through repair; the
  supervisor re-ran the gate and the raw smoke independently, twice.
  AC outcome: all three bound lines satisfied (pilot separated from
  qualification with generated checks plus one real-process smoke;
  fast feedback only, no qualification evidence; smoke matched the
  generated Branch Station expectation with verify clean after).
  Review: no must-fix on any axis; repair packet R1-R5 closed; all
  agent declines stood (no plain mode, one smoked station, retryable
  decoupling, no git init in the fixture, no src edits). Record-only
  findings moved to the stage-5 worklist. Headline on record: the
  pilot emits within frozen Input Schema v1, by design. Receipts at
  receipts/stage4/.
- Package AGENTS.md reconciliation from the 2026-08-21 review: closed at
  432f243. Stage-4 reconciliation (pilot Map row, Checks) landed with
  the receipts archive at 1c7aec3.

## Standing supervisor rules

- Ground every unit in the tracker acceptance criteria before chartering
  it: re-read the issue 55 body and the plan comment row the unit sits
  under. The unit's brief quotes its gate-proof row and the AC lines it
  binds; both review axes receive those lines verbatim. AC ticking
  happens in the queue's in-flight block; at merge the ledger entry
  records the AC outcome. GitHub Issues stays the mutable status owner.
  Standards-compliance units bind instead to the admitted
  CODING_STANDARDS.md rules that chartered them.
- Every stage brief opens with "read the package CONTEXT.md first"
  (vocabulary is contract surface). Model briefs:
  receipts/stage3/AGENT-BRIEF.md (feature stage),
  receipts/consolidation/AGENT-BRIEF.md (supervisor-chartered gate
  unit).
- Maintain the package CODING_STANDARDS.md as the harvest of supervision:
  one rule per witnessed defect class, with its lesson. Rules enter only
  from witnessed findings; delete a rule once tooling enforces it. Naming
  stays in AGENTS.md, vocabulary in CONTEXT.md; the standards file points
  rather than copies.
- After every merged unit, reconcile the package AGENTS.md: correct Map
  rows, Invariants, and Checks; delete stale rows. Invoke
  writing-for-agents before editing; scan for U+2014, U+2013, U+2019,
  U+2026.
- After every merged unit and any material change of plan, write the
  vault packet back. Route: resolve the vault root per
  `$HOME/.config/context/vault.md` and follow its entry protocol; invoke
  ultragoal (continue mode) and writing-for-agents. GOAL.md takes one
  Progress entry per merged unit (gate proof observed; lesson with
  witness) and a rewritten Next safe action; README.md takes summary,
  Current state, and Next safe action; update both `updated:` fields.
  Check `git status` in the vault first and preserve other sessions'
  work; leave edits uncommitted (`vault-git` owns vault commits).
- After every merged unit, post a progress comment on issue 55 via ghh:
  the observed gate proof, stated plainly as sitting on the unpushed
  local feature branch. Keep the spec-family issues (linked from the
  issue body and plan comment) honest; close a satisfied issue with its
  verdict.

## Code-review contract (every stage, before merge)

1. Order: agent handback, then the supervisor re-runs the stage gate
   (bun test, typecheck, biome) independently, then review, then repair,
   then re-verify, then merge. Gate mechanics are preconditions, not
   review findings.
2. Fixed point: the commit the stage branch forked from the feature
   branch; diff is three-dot against it. Review is invalid if the
   worktree HEAD moves while reviewers run.
3. Two axes, parallel, isolated, report-only, read-only; findings never
   merged or reranked across axes:
   - Standards: repo AGENTS.md, package CONTEXT.md (an Avoid term
     appearing anywhere, including diagnostic text, is a finding),
     package CODING_STANDARDS.md, neighbouring-package idiom, and the
     Fowler smell baseline. Documented repo standards override; rules
     tooling enforces are skipped.
   - Spec: issue 55 body plus the plan comment's rulings, scoped to the
     stage's row and the AC lines quoted in the brief. Verify gate
     proofs are real (fixtures genuinely falsifiable, nothing passing
     for the wrong reason), hunt scope creep (invented schema surface,
     facade edits, new dependencies, next-stage work), re-derive
     questionable implementations from the spec text. Model reports:
     receipts/consolidation/review-spec.md and review-standards.md
     (differential probes; verified-claims table).
4. Disposition is the supervisor's, per finding: must-fix (blocks
   merge), should-fix (done unless it destabilizes a green gate), or
   record-only (deferred with a named owning stage, written into this
   file). The implementing agent may decline a finding with reasons in
   HANDBACK.md; the supervisor arbitrates and records the ruling.
5. One repair cycle per stage unless Nathan approves more, delivered as
   one consolidated packet to the same stage agent. Model packet:
   receipts/consolidation/REPAIR-PACKET.md. The supervisor re-runs the
   gate after repair, before merging.
6. pattern-referee joins only when a diff defends structure by pattern
   name; cli-execution-auditor joins stage 4 and stage 5 reviews.
7. Coherence gate, supervisor-owned; ran once at 3acce98, re-run after
   any future parallel-stage merge. One consolidation unit with its own
   brief and review, checking:
   - one meaning per name;
   - one owner per sealed vocabulary consumed cross-stage;
   - one refusal idiom (sealed cause, named subject, prose message);
   - zero dead guards;
   - every export with a real caller;
   - helper duplicates hoisted.
   Names ground in CONTEXT.md terms: grepping a contract term must land
   in the file that owns it, and a name using a term CONTEXT.md does not
   define is renamed or the term is added to CONTEXT.md first. The
   package keeps one front door (src/index.ts); a new file must own a
   meaning no existing file owns. Track src file and export counts in
   the ledger; unexplained growth is a finding, not a fact.

## Gate-run note

The root AGENTS.md on this branch predates main's 513ff2f and still
claims `bun run lint` fails in `.worktrees/` checkouts; verified false
here (lint completes). The package AGENTS.md Checks section owns the
gate commands.
