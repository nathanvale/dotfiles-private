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
without its completion file (a live stage run; never re-charter over
one). The completion file is HANDBACK.md unless the in-flight block
under Next names a unit-specific signal; a tracked repo-root
HANDBACK.md is inherited stale state, not a signal. Work
can be in flight; the ledger lags the tree, and the in-flight block under
Next holds the pipeline position. Ways of work owns launch and
replacement.

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

1. Semantic frontier CLOSED 2026-08-21: all 13 Vault Git candidate
   decisions plus cancellation_scope, seven vocabulary collisions, and
   fourteen derived Input Schema v2 requirements are recorded in the
   issue 55 plan comment (appended under "Resolved Vault Git semantic
   rulings", comment id 5362367950). Source: the 2026-08-21 Vault Git
   specification grill outputs (decision ledger, doctor routing matrix,
   ADRs 0001 to 0006), Nathan-confirmed, supervisor-reconciled against
   runtime and candidate sources before recording. The record itself
   grants no authority: no Stage 5 work, runtime adoption, candidate
   edits, Specification Admission, commits toward stage 5, pushes, or
   activation.
2. Stage 5 STARTED 2026-08-21: Nathan's explicit go-ahead, recorded
   this session with two charter invariants. (a) The fourteen recorded
   requirements and the fourteen Agent Worktree gap rows are distinct
   sets; neither wholesale replaces the other; the first-unit charter
   dispositions every row of both plus the stage 3 and stage 4 schema
   worklist. (b) Exact version-identity custody: a v2 shape change
   bumps the Input Schema Version; v1 fails closed outside the
   registered reader and migration boundary; no silent pilot rewrite;
   any new pilot digest needs separate Specification Admission.
   Runtime adoption, Specification Admission, Pause release,
   activation, extraction, and stages 6 to 7 each remain a separate
   ask to Nathan.
3. Vault Git qualification CHARTERED 2026-08-22: Nathan's explicit Yes
   and Go, recorded this session. Stage 5's schema half is complete
   (Input Schema v2 declared, validated, canonicalized, fully derived,
   version-owned custody, safe manifest boundary; ledger below). The
   charter is observational qualification against the existing public
   vault-git CLI. Binding gate, owned by the plan comment's stage-5
   row: `qualify:vault-git` with Declared Branch Coverage and Observed
   Branch Coverage reported separately and deliberately introduced
   drift caught. Real Process Fixtures prepare declared environments
   and invoke the public CLI, never supplying expected results; Proof
   Adapters collect declared durable evidence, never deciding pass,
   coverage, Authority, or continuation; generated contracts own every
   verdict; the zero unsafe-retry regression baseline (accepted facade
   ruling 2) is preserved. Closed under this charter, each a separate
   ask to Nathan: Vault Git runtime edit or adoption, Specification
   Admission, any Product Specification Candidate edit, Pause release,
   activation, extraction, push, main merge, stage 6, stage 7. The
   carried follow-ups below stay parked.
4. Qualification blocker PROVEN 2026-08-22, supervisor probe through
   the public front door (compileSpecificationCandidate then
   deriveArtifactSet, probe kept outside the repo): the vault-git
   spike candidate compiles clean at f22e836b.. under the v1
   Registered Reader, and derivation refuses fail-closed with 16
   sealed refusals: emit_entry_undeclarable, eleven
   emit_expectation_column_underivable blocker rows (every *.refused
   station), and emit_write_preview_undeclarable on begin, complete,
   join, repair. No Generated Artifact Set exists for Vault Git, so no
   Declared Branch Coverage exists to observe against, and the formal
   qualify:vault-git gate cannot truthfully run inside this charter.
   Closing the refusals requires the candidate re-authored against
   Input Schema v2 per the recorded rulings (a Product Specification
   Candidate edit, closed) and Specification Admission of the
   resulting digest (closed). The current Nathan decision, exactly
   one: authorize or defer the Vault Git candidate re-authoring unit.
   Specification Admission stays its own later act on the validated
   digest that unit produces. Formal qualification stays blocked
   until both legs are ready: this candidate path through its own
   admission, and the truthful auditor output parked at item 5.
5. PROPOSED AND PARKED, not a current ask (the next separate grant,
   raised only after the item 4 decision is made): the auditor
   dual-coverage output unit, from the cli-author review's should-fix
   findings (receipts/cli-author/REVIEW-CLI-EXECUTION.md findings 1
   and 3, supervisor-verified at the named lines): auditor.ts still
   surfaces only the deprecated Declared claim in its result type
   (line 380), status literal declared_branch_coverage_clean (438),
   summary field (445), and plain rendering (481), while the JSON
   envelope's station_map now carries both claims; the auditor
   SKILL.md teaches declared-only at lines 30 and 65. The follow-up
   must surface both claims in the result type and plain output,
   distinguish absent coverage from zero (absent means the producer
   predates the block), stop asserting cleanliness on the Declared
   axis alone, reconcile the SKILL.md lines in the same pass, and
   prove both the plain summary and the JSON envelope per the new
   gate item 4. Bounded auditor source edit: a new grant, not covered
   by the consumed 2026-08-22 repair grant.
6. Carried follow-ups for whichever unit takes them next: the
   unenforced real_process stamp on CliProcessResult and drift-text
   sanitisation (facade hardening follow-up); the facade CONTEXT.md
   station-vocabulary gap; additive facade gates enumerate consumers
   from the workspace, never a hand list; the
   symlink-escape containment check at the
   deletion site (lexical safety is proved, symlink escape is not);
   em-dashes in artifact-set.ts, canonical.ts and generate.ts comments
   against the package ASCII rule; the 66 measured `as` casts in
   build-ir.ts, unassigned debt, each needing its own argument; the
   inherited `alias` Avoid-term prose (one REFUSALS row in
   tests/schema-v2-surfaces.test.ts and a comment shared by 30 v2
   fixtures, both predating the Contextual Rendering unit); and
   schema.ts's own header comment still naming Input Schema v1 while
   the file owns the v2 shapes (src comment, needs a chartered unit).
7. Stage 5 carries the 13 unresolved decisions named in the plan
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

## Ways of work

1. Authorization, only when crossing a stage or separately gated
   boundary (today: stage 6, stage 7, runtime adoption, Specification
   Admission, push, activation, Pause release, extraction; listing a
   boundary here grants nothing): quote or point to Nathan's exact
   grant with its exclusions, then record that narrow scope in issue
   55, this file, and the vault packet before any dispatch. When
   external or vault write authority is absent, stop and ask instead
   of launching. Complete when all three owners state the same
   authorized scope and the next closed boundary.
2. Supervisor lane: work only from `.worktrees/issue-55-integration` on
   feat/issue-55-state-machine-generator; reconcile resume step 0
   before chartering. Complete when integration status and every
   `.worktrees/issue-55-*` worktree are accounted for.
3. Unit isolation: create `.worktrees/issue-55-<unit>` from the current
   integration branch using an absolute path from the repo root.
   Complete when exactly one implementation writer owns that unit
   worktree.
4. Charter: write AGENT-BRIEF.md at the unit root naming authoritative
   sources, acceptance lines, gate proof, allowed paths, stop boundary,
   and a collision-free completion file. Complete when the supervisor
   has reviewed it, before launch.
5. Handoff: implementation writers launch through the claude-handoff
   skill (it owns the CLI mechanics) from their dedicated unit
   worktree, with a descriptive session name and
   `--model opus --effort high`. Reference the brief and owners rather
   than duplicating them, include a Suggested skills section, and
   record the real session name, short ID, cwd, model, effort, and
   completion signal in the in-flight block. Model admission, one rule
   for every issue-55 worker or subagent (implementation, mapping, and
   report-only review agents alike): its resolved job state proves
   claude-opus-5 at high effort before admission; any other
   resolution, Fable or an older Opus included, leaves the agent
   unadmitted. Complete when `claude agents` shows exactly one running
   implementation worker in the intended cwd with that proof in its
   job state.
6. Worker boundary: the worker edits only its unit worktree, writes the
   named completion file, and never commits, pushes, merges, edits
   integration, or edits main. The supervisor owns authorized unit
   commits and integration merges. Complete when the completion file
   exists and every mutation obeys those owners.
7. Replacement: stop the prior worker, inspect and preserve its diff,
   then launch exactly one replacement from the same unit worktree.
   Complete when implementation writers never overlapped.
8. Integration: verify the gate, commit the unit branch, apply the
   Code-review contract, repair and re-verify, merge accepted work into
   integration, archive the brief and completion receipt (untracked
   during the run) under `receipts/<unit>/`, and update the ledger.
   Complete when all of that is done with nothing pushed, absent
   Nathan's approval.

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
- Input Schema v2 (Stage 5, first unit): MERGED b2e427d (unit commit
  7b04ed7, receipts at 1baa94b). INCOMPLETE FOUNDATION, not a closed
  row: fourteen v2 surfaces are declared, validated, IR-carried and
  canonicalized, and five reach derivation (S5, S6, S7, S9, S8 in
  part). The other nine are declarable and emit nothing; the
  continuation unit owns their consumers. Gate: 382 tests, typecheck,
  Biome, pilot verify clean, four pinned digests byte-identical, pilot
  spec byte-identical. Generator Contract Version bumped to 2 with
  Registered Readers owning each superseded version's frozen accepted
  shape, frozen envelope identities and digest path. Agent Worktree
  draft re-pinned 44 to 45, deliberately: its undeclarable entry point
  was always a gap that a default naming a nonexistent file had hidden.
  Review: three axes, five must-fix and eight should-fix, all closed;
  one decline accepted (facade recoverability emission, record-only,
  owned by the facade ADD unit). AC outcome: stories 51 and 52
  satisfied; 5 and 6 satisfied for declared surfaces; gate 6 partial by
  record. Receipts at receipts/schema-v2/.
- Input Schema v2 derivation consumers (Stage 5): MERGED 0df63aa (unit
  commit ce8d4bf, receipts at 8a6c17d). GATE 6 NOW COMPLETE: 14 of 14
  semantic rows reach derivation, against 5 at the unit's start. Eight
  new modules emit only where a candidate declares the surface. Both
  custody blockers closed: Registered Readers own their frozen
  canonicalizer end to end (src/frozen-canonical-v1.ts), proven by a
  standing test computing a reader's digest from first principles
  outside the package, and a branch_station route resolves against the
  whole derived catalog rather than its command prefix. S4 remodelled
  to per-observation: the candidate-authored availability boolean is
  gone, a capability declares its evidence Extension Point and both
  routes, and missing routing now refuses structurally. W7's rename to
  bare_invocation_target landed; the v2 fixture digest moved
  deliberately to 8c9717e0. Gate: 443 tests (42 added), typecheck,
  Biome, pilot verify clean, four pinned digests byte-identical, draft
  inventory unmoved at 45, path-safety boundary re-verified by the
  supervisor. Receipts at receipts/derivation-consumers/.
- Two rulings from that unit. (a) W18 DELETION WITHDRAWN: the
  supervisor had ruled emit_expectation_action_unknown structurally
  unreachable and ordered its deletion; the worker reproduced the guard
  firing, because Input Schema v2 broke the old premise. A
  station_action row supplies its target directly, so the target
  reaches the catalog lookup without being drawn from it, and the guard
  is the only thing between an IR-level routing target and an emitted
  row naming an undeclared action. A live producer replaced the pin;
  UNPRODUCIBLE_REFUSAL_CAUSES is now empty. Supervisor verified the
  producer runs in the sealed-cause suite and accepts the decline.
  (b) outputDir is relativised out of all three generation refusal
  messages, per the standards rule that a message carries no absolute
  path; subject still carries it where a caller needs it.
- Manifest-read path safety (Stage 5, security boundary): MERGED
  276efd2 (unit commit cb86b6a, receipts at 565a661). A provenance
  manifest is untrusted input, and its declared outputs reached the
  delete call unvalidated, so a declared `../victim.txt` would remove a
  file outside the Generated Artifact Root. The merged tree refused only
  because a materialisation check happened to test path safety and
  answered "not present" to a question about safety; the worker proved
  deletion is one line away by removing that line and observing
  ok:true with the victim destroyed. Validation now happens where
  untrusted paths enter, before any stat, write or delete, refusing
  unsafe or duplicate entries with the new sealed cause
  generation_unsafe_declared_output naming the offending path, and the
  deletion site refuses again independently. Gate: 401 tests (19
  added), typecheck, Biome, pilot verify clean, four pinned digests
  byte-identical, draft inventory unchanged at 45. Supervisor attacked
  six further path shapes not in the worker's set, including a
  duplicate and a mid-path dot segment: all refuse with the victim
  byte-intact. Two follow-ups on record: symlink escape is unproved
  rather than safe (isSafeRelativePath is lexical; a realpath
  containment check at the deletion site would close it), and the
  second and third layers are fail-loud rather than
  fail-closed-with-a-cause by design, marking an upstream defect.
  Receipts at receipts/manifest-path-safety/.
- Lesson on record from that unit, five witnessed instances: a custody
  gate that trusts one signal it never cross-checks passes its own
  tests. The reader took its contract version from the global; the IR
  version was read without its digest; a manifest's existence stood in
  for its identity; repair privilege was earned by that same presence;
  and manifest identity stood in for the set existing. Each was green
  under a suite that checked the first signal only. The package's
  Control-flow rule already owns the class, so the harvest is
  executable coverage, not new prose.
- Package AGENTS.md reconciliation from the 2026-08-21 review: closed at
  432f243. Stage-4 reconciliation (pilot Map row, Checks) landed with
  the receipts archive at 1c7aec3. The 2026-08-22 Contextual Rendering
  merge reconciliation corrected the schema.ts Map row to v2 and added
  the six unmapped module rows and the fixtures/v2 row (inherited gap
  from the two schema-v2 merges).
- Contextual Rendering bare-string target validation (Stage 5,
  authorized repair): MERGED 623edb4 (unit commit 614f9f4, fixed point
  aa84864, receipts at 1f8f1d9). The compile seam validated rendering
  targets only for the array form (semantic.ts skipped every non-array
  value), so the vault-git spike's bare-string run_repair rendering
  named an action no catalog declares, compiled clean, and derivation
  silently dropped it: a published identifier resolving to nothing. The
  repair validates the bare-string form through the same resolveAction
  rule (bare string reports at the rendering key, array form at its
  indexed path, each side now held by its own boundary test after the
  one should-fix repair), removes the defective entry from the spike
  and its permuted twin per the ruling that parks
  resume_interrupted_transaction as future candidate-authoring, and
  moves the one vault-git pin to f22e836b..5142f with truthful oracle
  prose; 7f85428e is grep-empty across src, tests, fixtures and pilot.
  Removal-only invariant proven: the derived resolution table is
  identical before and after, re-derived independently by both review
  axes. Gate: 446 tests (443 base, 2 unit, 1 repair split), typecheck,
  Biome, pilot verify clean; pilot, fallow and draft digests
  byte-identical; draft inventory 45; zero facade edits; no new
  dependencies; no schema shape change; no version bump. Review: spec
  axis no findings, with the falsifiability positive control decisive
  (repairing only the fixture's one broken target compiles clean at the
  declared-surfaces identity); standards axis one MEDIUM should-fix
  (the asymmetry test held one side only), closed by RED both ways.
  cli-execution-auditor ruled out of this review: no CLI-execution,
  facade, or Station Map surface in the diff. Record-only notes carried
  to Next: the inherited alias Avoid-term prose and schema.ts's stale
  v1 header. Receipts at receipts/contextual-rendering/.
- Admission incident from that unit, on record. The worker launched one
  Explore subagent without pre-launch admission; the live monitor
  caught it, its report was ruled unadmitted and rejected after one
  consumption, and both consumed facts were re-established by the
  worker's direct observation, recorded in the handback. The subagent's
  own transcript resolves claude-opus-5 at high effort throughout, so
  the guarded risk never materialized; the process gap is the lesson.
  The original worker exited after handback; the R1 repair ran under
  one admitted Opus 5 high replacement (both admission proofs observed
  in session records). Harvest: unit briefs now carry an explicit
  no-subagents line unless the supervisor admits one before launch.

- Facade dual coverage (Stage 5, first chartered unit of the Vault
  Git qualification charter): MERGED e787db0 (unit commit 66ea98c,
  fixed point e318a4b, receipts at 306eb62). Plan ADD-1 and ADD-2
  landed additive in fact after one authorized repair cycle:
  StationMap.coverage and projected provenance are optional in type
  and always populated by the projector (the perturbation deleting
  the projector's coverage stayed typecheck-clean while 9 tests
  failed, proving the optionality real and the population claim
  test-carried); aggregateStationMapCoverage owns the one counting
  rule (observed counts only real_process AND covered) and the
  auditor's mergeStationMaps emits merged coverage through it under
  Nathan's bounded three-file grant; one literal owner for
  declared_branch_coverage; invalid provenance coerces to the
  fail-closed default with drift still recorded; the stale
  declared-coverage-runs limit note updated. Gate, supervisor re-run
  after repair: facade 322 pass with the two known ANSI fails, both
  typechecks clean; auditor typecheck clean (3 errors at review),
  suite 142 pass 1 known fail; workspace consumer sweep clean except
  test-runner's two pre-existing errors reproduced at the fixed
  point; skill verification observed the dual block in the auditor's
  real JSON envelope (vault-git target declared 23 of 23, observed 0;
  the worker's mixed temp target declared 2, observed 1); ASMG 446
  pass, typecheck clean. Review: three isolated report-only axes at
  e318a4b, all admitted Opus 5 high (Spec 814012ea, Standards
  39ba5305, cli-execution-auditor f666bc37); unanimous blocker was
  the required-field additive-optionality break plus the auditor
  merge discarding coverage; repair packet R1 to R7 closed it, with
  RED predictions recorded honestly (two misses reported as misses)
  and the original handback's RED record corrected, not rewritten.
  Declines on record: CliProcessResult branding, warm-chrome repair,
  root biome.json, the two ANSI stderr tests, facade CONTEXT.md
  vocabulary (all carried under Next). warm-chrome's synthetic
  coverage is now visible through the real front door: declared 18 of
  18, observed 0. Receipts at receipts/facade-coverage/.

- cli-author dual-coverage teaching (Stage 5 skill-document unit,
  Nathan's 2026-08-22 grant): MERGED dbe8679 (unit commit aefcf34,
  fixed point 5edb9ff, receipts at 1306128). Documents only, four
  files. The SKILL.md router gained one gate pointer and one Observed
  Coverage clause (3 insertions, 1 deletion); the facade reference
  carries the Dual Coverage Design Gate (separate claims;
  real-process provenance with the fail-closed default; workspace-
  enumerated consumer checks naming literal constructors and merge
  paths; truthful typecheck plus public-output proof); the
  behavior-regression checklist gained two markers and one gate row;
  the guardrails test-matrix "Declared Branch Coverage only" row
  became separate reporting plus the provenance rule. All five
  chartered contradiction sites reconciled plus three found by the
  worker's sweep; the declared-only grep returns zero across both
  skill trees. Review: three axes at 5edb9ff, all admitted Opus 5
  high (Spec 3b25f3b8, satisfied as delivered; Standards 1afe34a3,
  meets standards; auditor lane 733ebfa2, engine-faithful with
  probes matching all five counting rows). One in-path should-fix
  closed by supervisor repair before commit: gate item 4 now requires
  each coverage-reporting consumer's own public output to surface
  both claims, the seam the auditor defect escaped through; grep and
  ASCII proofs re-verified after the repair. Record-only accepted:
  the handback's owner-path prose imprecision; no enumeration recipe
  in the design gate (timelessness); the deprecated field described
  by role, not name (the boundary rule outranks convenience). The
  auditor's own output and SKILL.md remain declared-only, recorded
  as the proposed follow-up unit under Next. Receipts at
  receipts/cli-author/.

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
