# Issue-55 supervisor contract (fresh-context resume anchor)

Build: Agent-Native State Machine Generator, dotfiles-private issue 55,
branch feat/issue-55-state-machine-generator, supervised only from
`.worktrees/issue-55-integration`. Git history and `receipts/<unit>/` own
all evidence; this file owns the queue, the contracts, and the pointers.

## Owners, in authority order

1. This file. On queue disagreement this file wins; write the vault packet
   back to match.
2. The vault packet `projects/agent-native-state-machine-generator/`
   (README.md current state; GOAL.md objective and restart contract).
   Resolve the vault root per `$HOME/.config/context/vault.md`.
3. Issue 55: body, the single plan comment (accepted rulings, stage table,
   facade contract, appended "Resolved Vault Git semantic rulings"), and
   status comments (current: 5377353813). Fetch route: package AGENTS.md
   Authority section.

## Resume step 0 (before any other action)

1. `git status` here; reconcile every dirty file against this queue.
2. Check each `.worktrees/issue-55-*` for an AGENT-BRIEF.md without its
   named completion file: that is a live run; never re-charter over one.
   The tracked repo-root HANDBACK.md is inherited stale state, not a
   signal.
3. `claude agents`: confirm no issue-55 session is running or working.

## Current pipeline state (2026-08-22)

- Stage 5 is the active stage; stages 1 through 4 are closed (ledger).
- UNIT ACCEPTED (Nathan, 2026-08-22), COMMITTED, HELD UNMERGED: unit
  commit 9d1e91e on feat/issue-55-vault-git-candidate, parent a7fd5c6,
  exactly the two fixture files; git diff a7fd5c6 9d1e91e reproduces
  the frozen reviewed hash 42b86bec.. byte for byte, and the recompiled
  digest after the commit is 6cc10a52.. on both files, UNADMITTED.
  Full custody record and archived evidence:
  receipts/vault-git-candidate/ (archive commit 39dd4d5; packet issue
  comment 5378152063). Unit history below; dispatched 2026-08-22 after
  the pre-launch hold reconciliation.
  Worker: one claude background session "issue-55 vault-git candidate
  re-author", short ID 2add7804, session
  2add7804-f573-4bcd-ad2a-db994ddc68ec, cwd
  `.worktrees/issue-55-vault-git-candidate`, branch
  feat/issue-55-vault-git-candidate, fixed point a7fd5c6 (preserved on
  the unit branch; tree-identical to lineage commit 7d5ec53 after
  Nathan's 2026-08-22 VS Code rebase; see Notes), model
  claude-opus-5 at high effort (admission proof observed 2026-08-22:
  the session record resolves "model":"claude-opus-5" and the job
  banner reads "Opus 5 with high effort"). Charter: AGENT-BRIEF.md at
  that worktree root, allowed paths exactly the two vault-git fixture
  files. Completion signal: VAULT-GIT-CANDIDATE-HANDBACK.md at that
  worktree root, untracked. A first worker (1479e2c0) was stopped under
  Nathan's hold with an empty diff; see Notes.
  Handback received 2026-08-22 14:34 AEST and HELD unaccepted. The
  frozen worker diff is sha256 59b061a5.. (52514 bytes, two fixture
  files only). Supervisor gate re-run at a7fd5c6: core proof
  independently reproduced (candidate and permuted twin compile on the
  v2 path with no reader, identical digest af6cfef0.., exactly one
  refusal, commands.refused, returned as a product-decision gap;
  fallow, pilot and draft digests match their pins), typecheck, Biome
  and pilot verify clean, bun test 426 pass 20 fail with the 20
  matching the handback's enumerated identity-move consequences one
  for one. Three-axis review dispatched 2026-08-22, each admitted
  claude-opus-5 at high effort (session record plus banner observed):
  Spec 83571e69, Standards 5653c2a6, cli-execution-auditor 7fc4efd8
  (applicability ruling: the diff declares Command Surface Contract,
  execution-mode, preview-exemption and station-blocker surface, the
  source Station Maps derive from). Reviewers are read-only and
  report-only, writing REVIEW-SPEC.md, REVIEW-STANDARDS.md and
  REVIEW-CLI-EXECUTION.md at the unit worktree root; the tree must not
  move while they run.
  Review returned 2026-08-22 14:48; custody verified by all three
  lanes, the frozen diff hash unmoved. Findings: Spec one MAJOR
  (tidy/janitor rows declare human_kind "command" against their own
  catalog and next-safe-action.ts:858-864) plus two lesser; Standards
  one MINOR (three "earlier draft" provenance comment clauses) plus two
  record-only; cli-execution-auditor one BLOCKER (the activation.refused
  row names blocker activation_blocked, which that branch never emits)
  plus two MAJOR, one MINOR, one record-only positive. The Spec and
  auditor lanes contradicted each other on the activation row; the
  supervisor re-verified the citations and sided with the auditor
  (cli.ts:3040-3065 and :3261 emit human_capability_required on the
  activation refused branch; branch-station-catalog.ts:51;
  model.ts:123-126; the Spec lane's engine.ts:288 cite is the
  activation gate on other commands).
  Disposition (supervisor, 2026-08-22): must-fix R1 tidy/janitor
  human_kind to external_prerequisite; R2 activation.refused blocker to
  human_capability_required, target return_to_human_review, posture
  operator_required; R3 the cause_to_next_action row for
  human_capability_required reconciled to model.ts:123-126; R4 the
  activation preview-exemption row added per command-contract.ts:386.
  Should-fix R5 drop the three provenance clauses keeping each
  constraint; R6 restate the positional-route comment truthfully
  (review argv is shared by two catalog actions).
  R2 and R3 AMENDED pre-repair (Nathan's semantic check, 2026-08-22,
  delivered to the in-flight worker): human_capability_required is
  owned by activation.restriction_causes, not the blocker vocabulary,
  and station_blocker rows must resolve in blockers, so the worker
  must prove one source-backed disposition: (a) legitimately dual-role
  with direct schema, product and no-contrary-ruling evidence, or (b)
  the {activation, refused} row is removed and activation.refused
  returns as an exact Input Schema shape gap beside commands.refused
  (refusal count 2 is then truthful). R3 reconciles against the
  recorded rulings first, model.ts:123-126 second, and stops on
  conflict. Never papered over to make derivation green. Record-only with
  named owners: the handback's join-mutation prose slip (repair
  handback); the availability_evidence naming (Specification
  Admission); the stale spike-candidates README and package AGENTS.md
  v1 framing (supervisor merge-time reconciliation); the 20
  identity-move failures (the queued Nathan follow-up). Auditor
  findings 2 (owned-paths id split) and 4 (refusal coverage versus the
  handwritten catalog) are recorded and DECLINED as defects: the split
  and the eleven blocker mappings are Nathan's recorded ruling and
  grant scope, catalog widening is the closed runtime-adoption
  boundary, and the auditor's dissent rides to Specification Admission
  beside the known circular-catalog-oracle defect.
  Evidence correction (Nathan, 2026-08-22; supervisor-verified by
  exact-key count): the fixed point carries 13 unresolved_decisions
  rows and the current candidate 8. The five removals are
  single_action_vocabulary, vault_content_repair_gate_meaning,
  completion_task_observation_deadline, owner_pause_mode and
  observation_expired_blocker_overload, each citing its ruling;
  cancellation_scope was a features comment at the fixed point, never
  a row. The handback's "13 to 7" and "Removed 6, kept 7" and
  REVIEW-SPEC's "thirteen rows to seven" are false as counts; the
  Standards lane's "all 8 surviving rows" was correct. The
  shrink-only-by-rulings acceptance criterion holds substantively;
  stating the corrected delta is assigned to the repair handback, with
  the frozen handback and reviews left untouched as evidence.
  One repair cycle dispatched 2026-08-22 to replacement worker
  1ef64f9b (charter REPAIR-BRIEF.md at the unit root; completion
  signal VAULT-GIT-CANDIDATE-REPAIR-HANDBACK.md; admission proof
  observed: session record resolves "model":"claude-opus-5" and the
  job banner reads "with high effort") under the same two-file paths;
  the digest moves again and stays UNADMITTED.
  Repair handback received 2026-08-22 15:05 AEST and HELD. All six
  items applied; R2 landed as disposition (b) on the worker's proof
  (the product's closed vocabularies VAULT_GIT_BLOCKER_IDS,
  model.ts:1077-1080, and VAULT_GIT_ACTIVATION_RESTRICTION_CAUSES,
  model.ts:17-27, are disjoint on human_capability_required, and the
  activation refusal envelope carries an errorCode with no blockers
  field), so the {activation, refused} row is removed and
  activation.refused returns as a second exact shape gap beside
  commands.refused; both need one v2 shape addition, a refusal cause
  that is an error code rather than a lifecycle blocker. R3 encoded
  the product's return_to_human_review after proving no ruling
  speaks. The two assigned evidence corrections are stated in the
  repair handback; the mid-flight R2/R3 amendment was honored with a
  full revert of the pre-amendment edit (superseded intermediate
  digest 98ddbf64.., recorded nowhere). Post-repair frozen diff
  sha256 42b86bec.. (68219 bytes, two fixtures only). Supervisor
  rerun confirms independently: digest 6cc10a52.. identical on both
  files, refusal count 2, custody digests intact, typecheck, Biome
  (branch-snapshot only) and pilot verify clean, 426 pass 20 fail
  with the failing set set-identical to pre-repair. Digest pair
  af6cfef0.. and 6cc10a52.., both UNADMITTED, in no tracked file.
  Focused three-axis re-review of the repaired diff dispatched
  2026-08-22, each admitted claude-opus-5 at high effort (session
  record plus banner observed): Spec 3c23031c, Standards d65c778d,
  cli-execution-auditor 85b56894, writing REREVIEW-*.md at the unit
  root; the declined auditor findings 2 and 4 are out of their
  scope. Re-review returned 2026-08-22 15:15 AEST, custody held
  (42b86bec.. unmoved): Spec zero findings with every claim
  independently reproduced; cli-execution zero findings, the
  vocabulary disjointness proven in strong form (intersection empty)
  and no retry-posture change anywhere in the delta; Standards two
  MINOR comment-style rows in the R2 replacement block (a missing
  separator line and a narrating opening sentence), dispositioned
  record-only and carried to the next authorized candidate-touching
  unit, digest-neutral. Also recorded: the repair handback's
  canonical-length prose slip (51374 versus observed 29911, with the
  load-bearing equality claims verifying) and the REPAIR-BRIEF's own
  stale step-2 sentence, superseded by the R2 amendment. Nathan
  accepted 2026-08-22; the merge stays closed until the test-custody
  follow-up closes the 20 enumerated failures and the full gate runs
  green under the review contract. Last merges: facade
  dual
  coverage and cli-author dual-coverage teaching (merge commits e787db0
  and dbe8679, linearized off the lineage by Nathan's 2026-08-22 VS
  Code rebase; map in receipts/custody/rebase-2026-08-22-map.md).
- IN FLIGHT: the authorized test-custody follow-up unit, dispatched
  2026-08-22. Worker: one claude background session "issue-55
  test-custody worker", short ID c84f419e, cwd
  `.worktrees/issue-55-test-custody`, branch feat/issue-55-test-custody,
  fixed point 9d1e91e (the accepted candidate commit; forked from the
  unit branch, not the integration head, per the grant's in-scope
  note), model claude-opus-5 at high effort (admission proof observed
  2026-08-22: the session record resolves "model":"claude-opus-5" and
  the job banner reads "with high effort"). Charter: AGENT-BRIEF.md at
  that worktree root; grant: the Authorized grant section below;
  baseline at the fixed point 426 pass 20 fail. Completion signal:
  TEST-CUSTODY-HANDBACK.md at that worktree root, untracked. The unit
  stops at its reviewed handback.
  Handback received 2026-08-22 16:07 AEST (TEST-CUSTODY-HANDBACK.md,
  sha256 f8812efa.., 21177 bytes) and HELD unaccepted. The frozen
  worker diff is sha256 f115eb1f.. (34767 bytes, tracked files only:
  the 8 named test files, the 3 harness owners, the 2 fixture READMEs
  and the package AGENTS.md, +262/-95), preserved at the unit root as
  WORKER-DIFF-2026-08-22-c84f419e.patch; the one new untracked fixture
  fixtures/spike-candidates/vault-git.v1-frozen.state-machine.jsonc is
  sha256 676428c0.. (28912 bytes), byte-identical to the a7fd5c6
  candidate (git show piped to diff, supervisor-run). Supervisor gate
  re-run at the frozen tree, independent: full suite 446 pass 0 fail
  across 27 files (Agent Runner, exit 0), typecheck clean, Biome
  branch-snapshot clean (66 files), pilot verify clean, git grep
  6cc10a52 empty, and all six digest identities recomputed through the
  front door match their pins (candidate and twin 6cc10a52..,
  exemplar f22e836b.. via input-schema-spike-draft-1, fallow
  c26764f0.., pilot af827747.., draft 50528054..); candidate and twin
  byte-identical to 9d1e91e. Worker conduct verified from the session
  record: claude-opus-5 at high effort on every message, test-design
  (05:52:38Z) before the first edit (05:54:19Z), zero subagents, zero
  commits. The handback records a fresh-worktree baseline correction
  (bun install needed before the 426/20 baseline reproduces; bun.lock
  unmoved) and three source-material errata, all held for disposition
  with the review.
  Three-axis review dispatched 2026-08-22 16:20 AEST, each admitted
  claude-opus-5 at high effort (session record plus launch flags
  observed): Spec 49bc6ce4, Standards 411b337d, cli-execution-auditor
  3a0c40cd (applicability ruling: the new exemplar declares a full
  command_surface block and the harness now synthesizes
  station_blocker rows carrying retry-safety values; the prior
  cycle's declined auditor findings 2 and 4 and the two queued shape
  gaps are out of its scope). Reviewers are read-only and
  report-only, writing REVIEW-SPEC.md, REVIEW-STANDARDS.md and
  REVIEW-CLI-EXECUTION.md at the unit worktree root from the packets
  REVIEW-EVIDENCE.md and REVIEW-PACKET-*.md; the tree must not move
  while they run.
  Review returned 2026-08-22 16:26 AEST, custody verified by all three
  lanes (f115eb1f.. unmoved, every pin recomputed). Findings:
  cli-execution zero findings with two record-only rows (the supply's
  blocker column uniquely load-bearing; the borrowed target
  arbitrary); Standards one must-fix F1 (the harness supply hardcodes
  retrySafety operator_required, overriding the candidate's declared
  refusal rule same_input_unsafe through the routedPosture
  precedence) plus one should-fix F2 (the supply comment cites a pin
  that does not exist) and one record-only F3 (the v1SourceFor
  mapping duplicated across two test files); Spec one should-fix S-1
  (the supply is unbounded by absence, so a deleted genuine row is
  silently backfilled and no test pins the candidate's own unamended
  two-refusal gap) plus record-only S-2 (handback 5.1 and 12
  overstate the pin), with the chartered outcome judged satisfied and
  every decline legitimate. The supervisor independently re-verified
  the F1 and S-1 citations (candidate rule refusal to
  same_input_unsafe at fixture line 506; expectations.ts
  routedPosture precedence; emission.ts lines 125 to 127 fabricated
  values; the two cited v2-derivation tests run against synthetic
  fixtures, not the candidate).
  Disposition (supervisor, 2026-08-22): one must-fix repair R1 in the
  harness owner consolidating F1, S-1, F2/S-2 and auditor R2: (a)
  bound the supply to exactly the two reserved gaps, throwing on any
  other absence; (b) stop fabricating the retry posture so the
  declared rule answers; (c) omit or truthfully comment the borrowed
  target; (d) rewrite the supply comment truthfully; (e) add one pin
  test asserting the candidate's own unamended derivation refuses on
  exactly activation.refused:blocker and commands.refused:blocker
  (supervisor grant: placed in v2-derivation.test.ts under the
  original brief's new-coverage-welcome line). Record-only with named
  owners: F3 to the next candidate-touching test unit; auditor R1 to
  the queued Input Schema shape decision; the archived checklist
  mislabels (handback section 10) to the supervisor's archive-time
  correction note; the biome check --write process note,
  evidence-neutral per all three lanes, recorded here; the exemplar
  ASCII exception restated accurately (line 1 U+2014 and line 96
  U+2192, both byte-identity-required) to the repair handback; the
  missing docs/agents/coding-standards.md on this branch (exists on
  main at 2d9b4c4) to merge-time reconciliation.
  Repair cycle dispatched 2026-08-22 16:35 AEST to the same admitted
  worker, resumed as continuation session f6523298 (the c84f419e
  session had exited after its boundary and was resumed by session
  ID, carrying its full transcript forward; admission re-verified:
  the continuation record resolves "model":"claude-opus-5" with
  "effort":"high" on every message, launch flags --model opus
  --effort high). Charter: TEST-CUSTODY-REPAIR-BRIEF.md at the unit
  root; allowed paths exactly tests/support/emission.ts and
  tests/v2-derivation.test.ts; completion signal
  TEST-CUSTODY-REPAIR-HANDBACK.md, untracked. All digest custody
  constraints unchanged.
  Repair handback received 2026-08-22 16:40 AEST and HELD. All five R1
  items applied: the supply is bounded to the two reserved gaps with a
  sorted-comparison throwing guard; the fabricated retry posture is
  removed and both stations now emit the candidate's declared
  same_input_unsafe; the target borrow stays on a proven type-contract
  ground (RoutingRow.target is required in src/ir.ts and the
  omit-both build fails tsc, observed error quoted in the handback)
  with the comment stating the value arbitrary and unasserted; the
  supply comment is rewritten truthfully; and the new pin test derives
  the accepted candidate unamended asserting the exact cause and
  subject sets with restated-literal oracles and in-memory sensitivity
  controls on both axes. The frozen first handback is untouched
  (f8812efa.. unchanged); the corrected 5.1/12 statements and the
  widened exemplar ASCII exception (line 1 U+2014 plus line 96 U+2192,
  both byte-identity-required) live in the repair handback. Post-repair
  frozen diff sha256 d5a79e4d.. (38673 bytes, 14 files, +340/-95);
  supervisor-proven the repair delta is confined to the two allowed
  paths (the other 12 per-file diffs byte-identical to f115eb1f..).
  Supervisor rerun confirms independently: 447 pass 0 fail across 27
  files (446 plus the one new pin), typecheck, Biome (branch-snapshot
  only) and pilot verify clean, 6cc10a52 pinned nowhere, all six
  digest identities recomputed matching, candidate, twin and exemplar
  byte-identities intact, the guard and pin present in the claimed
  shapes.
  Focused three-axis re-review of the repair delta dispatched
  2026-08-22 16:44 AEST to the same three admitted reviewer sessions
  (transcripts continued, first-cycle context intact): Spec 49bc6ce4,
  Standards 411b337d, cli-execution-auditor 3a0c40cd, writing
  REREVIEW-*.md at the unit root from REREVIEW-PACKET.md; the tree
  must not move while they run.
  Re-review returned 2026-08-22 16:46 AEST, custody held (d5a79e4d..
  unmoved; each lane independently proved the 12 non-repair per-file
  diffs byte-identical to f115eb1f..). All three lanes recommend
  ACCEPT: Spec S-1 and S-2 CLOSED with zero new findings (the
  original failing probes reproduced against the repaired harness and
  now fail loudly; the pin is sensitive in both directions and
  oracle-independent); Standards F1 and F2 CLOSED, F3 correctly
  declined and carried record-only, one new record-only N1 (the
  throwing guard has no test of its own; loud failure mode, outside
  this cycle's paths); cli-execution R1 posture half CLOSED with the
  blocker residue record-only by design (owner: the queued shape
  decision), R2 CLOSED on the verified type-contract ground, Duty 1
  strengthened (no fabricated semantic value remains; zero
  unsafe-retry baseline intact; posture histogram moved exactly
  16/14/4 to 14/14/6, only the two reserved stations). The Standards
  lane disclosed two temporary counterfactual probes, each restored
  with the custody hash re-verified to d5a79e4d.. afterward. The unit
  is at its reviewed handback boundary, HELD for Nathan's
  accept-or-return; supervisor final custody check 16:47 AEST clean
  (HEAD 9d1e91e, diff d5a79e4d.., first handback f8812efa..,
  6cc10a52 pinned nowhere).
  EXTENDED GATE (Nathan, 2026-08-22, before accepting): the stop
  boundary is extended by one final whole-engine code-review gate;
  the prior accept-or-return is deferred behind it. Exactly two
  top-level reviewer sessions run SEQUENTIALLY, each brand-new and
  admitted claude-fable-5 at xhigh effort, each explicitly invoking
  the code-review skill on the complete engine at the repaired
  custody fixed point 9d1e91e through the skill's work-in-progress
  path (git diff 9d1e91e; the tree stays uncommitted; a reviewer
  blocked on a committed three-dot diff stops and reports rather
  than committing). The skill's own parallel Spec and Standards
  subagents are permitted. Common packet FINAL-REVIEW-PACKET.md at
  the unit root, sha256 14a02d82.. (repair handback hashed
  fa71442d.. and carried in it). Reviewer A dispatched 16:52 AEST:
  brand-new session "issue-55 final review A", short ID 2e42af86,
  session 2e42af86-0369-4d17-a111-2c47dfd98d5c, admission verified
  (launch flags --model fable --effort xhigh; the session record
  resolves "model":"claude-fable-5" with "effort":"xhigh"), sole
  write REVIEW-FINAL-A.md. Reviewer B launches only after A
  completes, receives the packet plus A's full report, and must
  verify, challenge, or extend A rather than repeat it, sole write
  REVIEW-FINAL-B.md.
  GATE CORRECTED (Nathan's staff audit, 2026-08-22 16:58 AEST): both
  reviewer-A attempts are REJECTED as non-evidence, reason unit-only
  Spec grounding and unit-only diff scope: session 2e42af86 (exited
  16:55 before invoking the skill, zero output) and its relaunch
  39f0dd7d (stopped before any report; supervisor confirmed no
  REVIEW-FINAL-A.md from either). The gate is a WHOLE ENGINE review
  over two layers reviewed as one result with layer-attributed
  findings: layer 1, the committed engine, git diff 8bbe012..9d1e91e
  (three-dot) over the package, supervisor-verified merge-base
  8bbe012aad7ed35e825bd265750b40872caab02d = git merge-base main
  9d1e91e, 134 files +31549/-25, diff sha256 5df34112.. (1230434
  bytes); layer 2, the uncommitted test-custody WIP, git diff 9d1e91e
  over the package plus the untracked frozen exemplar; no commit.
  Supervisor-owned immutable spec snapshot written at the unit root
  SPEC-SNAPSHOT-2026-08-22/ (fetched live via ghh: the full issue 55
  body plus comments 5362367950, 5365237090, 5368129900, 5377730080,
  5377751430, 5378226764, 5378270664, 5378677005 verbatim; the
  ORCHESTRATION snapshot at f14f867; vault GOAL.md and README.md; the
  main-branch repo coding standards; per-file sha256 in MANIFEST.md,
  manifest sha256 7937f64f..). The superseded packet is preserved as
  FINAL-REVIEW-PACKET-SUPERSEDED-14a02d82.md; the corrected packet
  FINAL-REVIEW-PACKET.md is sha256 15ff26cd.. and requires the
  code-review skill's Spec subagent prompt to name the snapshot, with
  the supervisor verifying that grounding from the reviewer's
  transcript before admitting output.
  Corrected reviewer A dispatched 2026-08-22 17:01 AEST: brand-new
  session "issue-55 final review A", short ID 891db3bf, session
  891db3bf-2dad-4a38-a450-79b8796b69f4, admission verified (launch
  flags --model fable --effort xhigh; the session record resolves
  "model":"claude-fable-5" with "effort":"xhigh"), sole write
  REVIEW-FINAL-A.md, two-layer whole-engine scope per the corrected
  packet. Reviewer B waits for A's completed, admitted report.
  Reviewer A returned 2026-08-22 17:15 AEST and is ADMITTED:
  REVIEW-FINAL-A.md sha256 7cfb91f3.. (24776 bytes); the supervisor
  verified from the session record that exactly one code-review Skill
  invocation ran, its two skill-owned parallel subagents were the Spec
  and Standards lanes, the Spec subagent's launched prompt names
  SPEC-SNAPSHOT-2026-08-22/, its MANIFEST.md, the issue body file and
  both layers, and the session resolves claude-fable-5 at xhigh on
  all 118 messages; custody re-verified after return (HEAD 9d1e91e,
  full diff d5a79e4d.. unmoved). A's result: custody and all four
  gates reproduced on its own probes; no must-fix survives its
  verification; four layer-1 should-fixes (render.ts banner asserting
  Admitted on unadmitted output, already carried; build-ir.ts
  totality-by-cast; generate.ts refusal-message voice with
  absolute-path leak risk; the semantic.ts alias rename), the
  Standards lane's sole reported must-fix (the pin-test title "the
  accepted candidate's") challenged down to record-only on chartered
  and recorded-vocabulary evidence, and six record-only rows;
  recommendation ACCEPT both layers.
  Reviewer B dispatched 2026-08-22 17:20 AEST, sequential, brand-new
  session "issue-55 final review B", short ID 5d3ed7a8, session
  5d3ed7a8-4c2a-4ab4-9ff5-fb3cf876b47e, admission verified (launch
  flags --model fable --effort xhigh; the session record resolves
  claude-fable-5 at xhigh), receiving the corrected packet plus A's
  full report with the duty to verify, challenge, or extend A, sole
  write REVIEW-FINAL-B.md, same Spec-grounding transcript check
  before admission.
  Reviewer B returned 2026-08-22 17:42 AEST and is ADMITTED:
  REVIEW-FINAL-B.md sha256 06c37a53.. ; transcript verified (one
  code-review Skill invocation, Spec subagent prompt names the
  snapshot, manifest and both layers; claude-fable-5 at xhigh on all
  149 messages); custody held (HEAD 9d1e91e, diff d5a79e4d..
  unmoved). B CONFIRMS all of A's custody, gates, findings and the
  title downgrade (B's own unseeded Standards lane declined to raise
  the title at all), and CONTRADICTS A's no-must-fix headline with
  one new verified layer-1 must-fix: the emitted Command Surface
  Contract omits the declared executionModes and previewExemption
  fields (src/command-surface-contract.ts contract literal), so the
  facade's own oracle on UNAMENDED v2 contracts returns 8
  command-write-preview-missing drift rows while Gate 3
  (tests/command-surface-contract.test.ts) reports green off
  amendment-recast evidence; the mask is
  tests/support/emission.ts withPreviewableMutations plus the
  entryScript overwrite applied unconditionally, erasing all 8
  write-implying mutations from every amended v2 suite. The
  supervisor re-verified the central citations directly in source
  (the refusal check reads the declared surface at
  command-surface-contract.ts:96-113; the emitted literal carries no
  executionModes or previewExemption; the facade type declares both
  optional at command-contract.ts:200,203; contractsFor derives from
  emitAmended; the recast and overwrite are unconditional at
  emission.ts:191,194). B attributes the defect to committed layer-1
  src, read-only under the unit's grant, latent today (the two
  reserved refusals block any full v2 set; the pilot is all-read),
  and recommends ACCEPT for the layer-2 unit with the must-fix
  recorded as a named engine precondition.
  Final gate dispositions (supervisor, 2026-08-22): the layer-1
  must-fix and its mask are assigned to a future bounded
  generator-hardening unit (its own Nathan ask; see Carried work),
  landed together because repairing the mask alone flips Gate 3 to
  its honest red. Standing evidentiary caveats until that unit
  closes: Gate 3 green is NOT proof of the write-preview obligation,
  and mutating-station properties computed over amended v2 evidence
  (including the zero-unsafe-retry leg of the first-cycle
  cli-execution review) are vacuous for vault-git; the baseline
  claim stands only as computed over recast evidence. Layer-2
  findings across both reviewers are all record-only or trivially
  additive and none touches the unit's semantics: the accepted
  candidate pin-test title rename question, F3, N1, the dead arm,
  the discriminants.command comment sentence, and the missing
  CONTEXT.md exemplar term are carried to the next
  candidate-touching test unit; the front-door deep imports in two
  test files and the stale emission.ts header ride with the
  hardening unit. Both reviewers recommend ACCEPT of the test-custody
  unit; B states returning it could not repair any new finding.
- The Vault Git qualification charter is recorded (Nathan, 2026-08-22):
  observational only, against the existing public vault-git CLI. Binding
  gate, owned by the plan comment's stage-5 row: `qualify:vault-git` with
  Declared Branch Coverage and Observed Branch Coverage reported
  separately and deliberately introduced drift caught. Real Process
  Fixtures prepare declared environments and invoke the public CLI, never
  supplying expected results; Proof Adapters collect declared durable
  evidence, never deciding pass, coverage, Authority, or continuation;
  generated contracts own every verdict; the zero unsafe-retry baseline
  (accepted facade ruling 2) is preserved.
- Qualification blocker PROVEN (2026-08-22 supervisor probe through the
  public front door): the vault-git spike candidate compiles clean at
  f22e836b.. under the v1 Registered Reader and derivation refuses
  fail-closed with 16 sealed refusals (emit_entry_undeclarable; eleven
  emit_expectation_column_underivable blocker rows, every *.refused
  station; emit_write_preview_undeclarable on begin, complete, join,
  repair). No Generated Artifact Set, so no Declared Branch Coverage,
  exists for Vault Git.

## Nathan decision state

ACCEPT RECORDED (Nathan, 2026-08-22): the re-authoring unit is
accepted, committed as 9d1e91e on its unit branch, and held unmerged.
AUTHORIZED (Nathan, 2026-08-22): the test-custody follow-up unit, one
bounded unit under the grant below; it has now reached its
independently re-reviewed handback. The extended whole-engine gate
(Nathan, 2026-08-22) is COMPLETE: both sequential fable-xhigh
reviewers admitted and returned, both recommend accepting the unit;
reviewer B surfaced one new layer-1 must-fix, dispositioned to the
carried Generator hardening unit as a named precondition for the
Command Surface Alignment Proof, Specification Admission, and
qualification. ONE FINAL DECISION WITH NATHAN (2026-08-22): accept
or return the test-custody unit at this fully reviewed boundary,
with the whole-engine result and the hardening-unit ask in view.
After that decision, the Input Schema shape decision for the two
surviving derivation gaps stays queued and the generator-hardening
grant becomes its own ask. The auditor output proposal below stays
parked.
Formal qualification stays blocked until both legs are ready: the
candidate path through its own later Specification Admission, and
truthful auditor output.

## Next safe supervisor action

STOPPED at the fully reviewed test-custody boundary: the extended
whole-engine gate is complete and dispositioned. Present the one
final accept-or-return to Nathan and wait. On accept, the supervisor
owns the unit commit, receipts archive, ledger entry, issue comment,
and vault write-back under the operational contract; the accepted
re-authoring merge precondition is then satisfied but the merge
itself stays a separate supervisor act after acceptance, and the
generator-hardening grant is its own next ask. Reconcile owners and
answer questions; nothing more.

## Authorized grant (Nathan, 2026-08-22): Vault Git test-custody follow-up

One bounded unit under the operational contract, recorded identically
here, on issue 55, and in the vault packet. Ultragoal shape:

- Objective, one observable outcome: the full package gate runs green
  on top of the accepted candidate (unit commit 9d1e91e), with
  historical Input Schema v1 evidence preserved as a frozen exemplar,
  exactly the 20 enumerated identity-move failures repaired
  (receipts/vault-git-candidate/VAULT-GIT-CANDIDATE-HANDBACK.md
  section 7), and the stale spike-candidates README and package
  AGENTS.md v1 framing corrected, without changing the accepted v2
  candidate semantics.
- Why now: the accepted unit's merge waits on exactly these failures,
  and their contract-preserving repairs are already designed in the
  archived handback.
- In scope, exact paths: one new frozen v1 exemplar fixture under the
  package fixtures/ tree (byte-identical to the a7fd5c6 candidate);
  the test files the 20 failures name (version-custody,
  registered-readers, registered-reader-boundary, v2-derivation's v1
  section, schema-v2-surfaces, transition-targets, generated-banner,
  expressiveness-gaps) and the harness owners tests/support/
  candidates.ts, emission.ts, refusal-producers.ts;
  fixtures/spike-candidates/README.md, fixtures/draft-candidates/
  README.md where it mirrors the claim, and the package AGENTS.md v1
  framing rows. The unit forks from 9d1e91e on the unit branch, not
  the integration head, because the failures exist only against the
  accepted candidate; the eventual integration merge takes both
  together.
- Exclusions, each its own later ask: no admission-owned version pin
  moves and no new pin for the unadmitted 6cc10a52.. digest (the
  f22e836b.. pin stays, repointed at frozen v1 history); no
  Specification Admission claim; no expectation rewritten to bless new
  behavior; no edit to the accepted candidate, its permuted twin,
  src/, pilot/, or the facade; no schema shape change or Generator
  Contract Version bump; no Input Schema shape work, auditor output
  repair, qualification claim, runtime adoption, Pause release,
  activation, extraction, push, main merge, stage 6, or stage 7; the
  active-main Biome owner untouched and Biome reported as
  branch-snapshot proof only; unrelated vault staging preserved.
- Acceptance checks: bun run test all-green with counts reported;
  typecheck, package Biome, and pilot verify clean; the frozen
  exemplar byte-identical to the a7fd5c6 candidate and compiling
  through the v1 Registered Reader to the pinned f22e836b.. identity;
  the accepted candidate and twin byte-identical to 9d1e91e with
  digest 6cc10a52.. recomputed unchanged and pinned nowhere; fallow,
  pilot, and draft digests byte-identical; each of the 20 failures
  repaired per its enumerated cause with no test deleted and no
  assertion weakened; test-design before test or fixture edits and
  test-runner for bun lanes.
- Verifier: supervisor gate re-run plus independent admitted review at
  the frozen fixed point under the code-review contract; one admitted
  claude-opus-5 high worker, no unadmitted subagents; STOP at the
  reviewed handback, accept-or-return returning to Nathan.
- Next safe action: charter the unit worktree from 9d1e91e and
  dispatch exactly one admitted worker.

## Dispatch boundary

The consumed re-authoring grant and the live test-custody grant each
cover exactly one unit worker plus admitted reviewers and one repair
cycle under the review contract. Beyond that, launch nothing: no other
worker, subagent, probe, security test, or qualification run. Never
infer authorization from a cleanup, reconciliation, or reporting
request.

## Authorized grant (Nathan, 2026-08-22): Vault Git candidate re-authoring

Scope, one unit under the operational contract below:

- Edit exactly two fixture files:
  `fixtures/spike-candidates/vault-git.state-machine.jsonc` and its
  permuted twin, re-authored to declare Input Schema Version 2 and state
  the recorded rulings (the plan comment's 13 decisions plus
  cancellation_scope, the seven vocabulary-collision rulings, the
  fourteen v2 requirements).
- Close the 16 proven refusals by declaring real surface, never invented
  policy: a command_surface entry, blocker-to-action mappings for the
  eleven *.refused stations, and Execution Modes or Preview Exemptions
  for begin, complete, join, and repair.
- Realize the three canonical IDs no catalog declares yet
  (correct_begin_owned_paths, correct_join_owned_paths,
  resume_interrupted_transaction), the parked candidate-authoring work
  the rulings named.
- Acceptance: the candidate compiles clean on the current v2 path;
  derivation emits a complete Generated Artifact Set with zero refusals,
  or each survivor returns to Nathan as an exact product-decision gap;
  unresolved_decisions shrinks only by rulings Nathan actually made.
- The vault-git digest moves deliberately and is recorded UNADMITTED;
  fallow, pilot, and Agent Worktree digests stay byte-identical; full
  package gate plus supervisor re-run before merge.

Exclusions, each its own later ask: no Specification Admission (that ask
returns on the observed validated digest); no Vault Git runtime edit or
adoption; no qualification claim or qualify:vault-git run as evidence; no
Real Process Fixture or Proof Adapter dispatch; no pilot edit, schema
shape change, or Generator Contract Version bump (a ruling v2 cannot
express stops the unit and returns the exact gap); no auditor source
edit; no Pause release, activation, extraction, push, main merge, stage
6, or stage 7.

Supervisor custody reading, corrected under Nathan's 2026-08-22
pre-launch hold: the worker edits exactly the two named fixture files
and nothing else. tests/version-custody.test.ts is NOT an allowed
worker edit under this grant; if its vault-git pin row or oracle prose
must move for the full gate, that move returns to Nathan as its own
separate follow-up ask after the handback. Every gate failure caused by
the identity move (the version-custody pin, the live-spike v1 exemplar
assertions in registered-readers.test.ts, the v1-refusal section of
v2-derivation.test.ts, the emitAmended harness) is enumerated in the
handback, never edited, and returns to Nathan as an exact follow-up
ask, never inferred scope. The unit reaches its handback boundary on
the focused core proof; the full package gate plus supervisor re-run
stays the merge precondition and waits on those follow-up rulings.

## Parked proposal, NOT A CURRENT ASK: auditor dual-coverage output

The next separate grant, raised after the authorized re-authoring unit
above closes.
Evidence: receipts/cli-author/REVIEW-CLI-EXECUTION.md findings 1 and 3,
supervisor-verified. auditor.ts surfaces only the deprecated Declared
claim (result type line 380, status literal
declared_branch_coverage_clean 438, summary field 445, plain rendering
481) while its JSON envelope's station_map carries both claims; the
auditor SKILL.md teaches declared-only at lines 30 and 65. The unit must
surface both claims in result type and plain output, distinguish absent
coverage from zero, stop asserting cleanliness on the Declared axis
alone, reconcile the SKILL.md lines in the same pass, and prove both the
plain summary and the JSON envelope per the Dual Coverage Design Gate.

## Closed boundaries (each its own later ask to Nathan)

Vault Git runtime edit or adoption; Specification Admission; any Product
Specification Candidate edit except the two vault-git fixture files
exactly as the 2026-08-22 grant above names them (every other candidate
file, and any edit to those two outside that grant, stays closed); Pause
release; activation; extraction; push; main merge; stage 6; stage 7. Standing version-identity custody: a
v2 shape change bumps the Input Schema Version; superseded input
compiles only through its Registered Reader; any new pilot digest needs
its own Specification Admission.

## Operational contract (every unit)

1. Authorization: crossing any separately gated boundary needs Nathan's
   exact grant with its exclusions, recorded identically in this file,
   issue 55, and the vault packet before any dispatch. Absent authority:
   stop and ask instead of launching.
2. Supervisor lane: one writer, this worktree only; resume step 0 before
   chartering.
3. Unit isolation: `.worktrees/issue-55-<unit>` from the current
   integration head; exactly one implementation writer per unit worktree.
4. Charter: AGENT-BRIEF.md at the unit root names authoritative sources,
   verbatim acceptance lines, gate proof, allowed paths, stop boundary, a
   collision-free completion file, and a no-subagents line (a subagent
   needs supervisor admission before launch). Every brief opens with
   "read the package CONTEXT.md first". Model briefs:
   receipts/stage3/AGENT-BRIEF.md, receipts/consolidation/AGENT-BRIEF.md.
5. Admission: every worker, reviewer, and subagent proves claude-opus-5
   at high effort in its resolved job state (session record plus banner)
   before any output is admitted; every other resolution is rejected.
   Launch background sessions with `--model opus --effort high` and
   record session name, short ID, cwd, fixed point, and completion
   signal in an in-flight block under Current pipeline state.
6. Worker boundary: workers never commit, push, merge, stash, or leave
   their unit worktree. The supervisor owns unit commits and integration
   merges. Replacement: stop the prior worker, preserve and hash its
   diff, then launch exactly one replacement.
7. Integration: supervisor re-runs the gate independently, applies the
   review contract, dispositions, repairs (one cycle), re-verifies,
   merges, archives brief plus handbacks plus reviews under
   `receipts/<unit>/`, updates the ledger, posts the issue 55 progress
   comment, and writes the vault packet back (Direct Git Mode:
   fail-closed shell edits to the two packet files only, explicit-path
   staging, `bun run check`, no vault commit; vault-git owns vault
   commits). Nothing pushes without a new Nathan approval.
8. Additive facade gates enumerate consumers from the workspace, never a
   hand list.

## Code-review contract (every unit, before merge)

1. Order: handback, supervisor gate re-run, review, disposition, one
   repair cycle, re-verify, merge. Gate mechanics are preconditions, not
   findings.
2. Fixed point: the commit the unit forked from; the diff is against it
   and the tree must not move while reviewers run. Reviewers verify
   custody (fixed point, preserved-diff hash) before reviewing.
3. Axes: Spec and Standards, parallel, isolated, read-only, report-only,
   never reranked across axes. Spec receives the direct authoritative
   sources (live issue body, plan comment rulings, the verbatim AC and
   exclusion lines from the brief) and quotes a source line per finding;
   an unavailable or ambiguous spec source blocks the launch. Standards
   receives repo and package standards, neighbouring idiom, and the
   Fowler smell baseline; tooling-enforced rules are skipped only where
   the tooling demonstrably ran. cli-execution-auditor joins any stage 4
   or 5 review whose diff touches CLI-execution, facade, or Station Map
   surface; pattern-referee joins only when a diff defends structure by
   pattern name. Model reports: receipts/consolidation/review-spec.md
   and review-standards.md.
4. Disposition per finding is the supervisor's: must-fix, should-fix, or
   record-only with a named owner written into this file. Workers may
   decline with reasons in the handback; the supervisor arbitrates and
   records the ruling.
5. Coherence gate, supervisor-owned: ran at 3acce98; re-run after any
   future parallel-stage merge (checklist in
   receipts/consolidation/AGENT-BRIEF.md).

## Editing this file

Structural rewrite: invoke writing-for-agents first. Every edit: one
place per fact; every numeral an observed receipt or a pointer to its
owner; closed lines carry a hash or date; mutable state appears only as
an instruction to look; every queue item stays live or moves to the
ledger; ledger entries match the shape rule at the Ledger heading; scan
for U+2014, U+2013, U+2019, U+2026 before committing.

## At branch merge to main (cleanup, in order)

1. Create backup branch `archive/issue-55-orchestration` at the
   feature-branch HEAD (Nathan's 2026-08-21 ruling: this file and
   `receipts/` feed a planned orchestration skill; open harvest
   question: that skill owns the outer loop and its briefs should name
   `implement` and `tdd` as the inner loop, a composition this run never
   exercised).
2. Post the three out-of-scope repo defects as dotfiles-private issues
   via ghh: warm-chrome synthetic observed coverage, vault-git circular
   catalog oracle, browser-use-security grep-based custody proof
   (evidence in the two receipts/standards-research-sibling-tests-*.md
   files).
3. Migrate every unfinished carried item to the vault packet's Next safe
   action.
4. Delete this file on the feature branch and its pointer line in the
   package AGENTS.md Authority section; the vault packet becomes the
   build-state owner.

## Carried work (one owner, one state each)

- Generator hardening unit (future chartered unit; carried; raised by
  the 2026-08-22 whole-engine final gate, REVIEW-FINAL-A.md and
  REVIEW-FINAL-B.md at the test-custody unit root): MUST-FIX, emit the
  declared executionModes and previewExemption into the Command
  Surface Contract (plan emit target 3) and make the emission
  harness's withPreviewableMutations and entryScript amendments
  supply-if-absent, landed together; until then Gate 3 green is not
  write-preview proof and amended-v2 mutating-station properties are
  vacuous for vault-git. Precondition for the stage-5 Command Surface
  Alignment Proof, Specification Admission, and any qualification
  claim. Should-fix riders: build-ir.ts totality-by-cast,
  generate.ts refusal-message voice with the describe(error)
  absolute-path leak channels, the U+2014 source-comment sweep (19
  lines, 5 files), the semantic.ts alias rename, and the
  branch-stations.ts ?? 'read' mutation default (needs a product
  ruling or a refusal cause; none found in the snapshot); record-only
  riders: front-door deep imports in two test files, the stale
  emission.ts header.
- Facade hardening unit (future chartered unit; carried): enforce the
  real_process stamp on CliProcessResult; sanitise drift action text;
  add the facade CONTEXT.md Station Map vocabulary. Evidence:
  receipts/facade-coverage/ reviews.
- Generator prose unit (future chartered unit; carried): em-dashes in
  artifact-set.ts, canonical.ts, generate.ts comments; schema.ts header
  still naming Input Schema v1; inherited `alias` Avoid-term prose (one
  REFUSALS row in tests/schema-v2-surfaces.test.ts plus a comment shared
  by the v2 fixtures); the measured `as` casts in build-ir.ts, each
  needing its own argument.
- Security follow-up (future chartered unit; carried): symlink-escape
  containment at the deletion site; lexical safety is proved, a realpath
  containment check is not. Evidence: receipts/manifest-path-safety/.
- Render truthfulness (candidate re-authoring or a generator unit;
  carried): the generated banner asserts "Admitted" on unadmitted output
  (src/render.ts).
- Facade strictness remainder, F4 (facade follow-up; carried): two
  tsconfig strictness flags stay off; enabling them surfaced facade and
  prototype errors outside the package's authority. Evidence:
  receipts/standards-fit-review-2026-08.md.
- Recorded before the v2 merges, re-verify at the next generator
  charter (that charter's step; carried): input_schema_version
  exact-match custody; bounded diagnostics cap (C15/F3); expectations.ts
  `cause` column name collision; STOP_SCOPES and sealed list exports
  from the front door; the plural-blocker prose fix; mechanical-auditor
  discoverability of the pilot's generated contract.

## Ledger (merged units)

An entry is one to three sentences: unit, merge hash (plus unit or
receipts hashes where recovery needs them), receipts path, and any
decline, pin, or ruling that still binds. Git history and
`receipts/<unit>/` own all further evidence. This shape rule was
rewritten by the 2026-08-22 cleanup; earlier verbose entries were
compressed to match. Hashes recorded before 2026-08-22 14:06 may no
longer sit on the branch lineage: Nathan's 2026-08-22 VS Code
pull-rebase linearized the last 22 commits and dropped the three unit
merge commits; each old
hash resolves through receipts/custody/rebase-2026-08-22-map.md and the
local archive branch archive/issue-55-pre-rebase-237efce.

- Stage 1, validator plus canonical digest: MERGED 98c9d8d; receipts at
  receipts/stage1/. Standing decline: the `then` retry-rule key stays.
- Stage 2, generation mechanics: MERGED 6196783; receipts/stage2/.
  Standing decline: verify keeps temp-dir regeneration.
- Stage 3, facade contracts: MERGED 598f801; receipts/stage3/.
- Consolidation coherence gate: MERGED 3acce98, repair e8bec06;
  receipts/consolidation/.
- Standards fit review plus amendment: 9c9ae9d, 1f1d55d; receipt
  receipts/standards-fit-review-2026-08.md.
- Standards repairs 1 to 3 (codepoint order and NFC/LF digest input;
  switch exhaustiveness; staging sweep): 8b7efa4, ede5d87, a3b642f.
- Agent Worktree draft candidate: MERGED c01d7d9; receipts/aw-draft/.
  The draft stays UNADMITTED; its refusal inventory is pinned by tests.
- Stage-5 decision packet: receipts/stage5-decision-packet.md;
  superseded by the rulings recorded in the plan comment.
- Pilot Specification Admission: 657045e, Nathan's explicit act
  2026-08-21; admitted digest af827747..b3e99a. The pilot claims nothing
  toward qualification.
- Findings repair (F2, F5, F6, F8, F9): MERGED 7dcd47c;
  receipts/findings-repair/.
- Stage 4, Vault Git Reimagined pilot: MERGED 30d5bff; receipts/stage4/.
- Input Schema v2: MERGED b2e427d; receipts/schema-v2/. Generator
  Contract Version 2; Registered Readers own each superseded version's
  frozen shape and digest path.
- Input Schema v2 derivation consumers: MERGED 0df63aa;
  receipts/derivation-consumers/. All fourteen v2 semantic rows reach
  derivation; v2 fixture digest 8c9717e0; the
  emit_expectation_action_unknown guard is reachable and live-produced
  (W18 deletion withdrawn).
- Manifest-read path safety: MERGED 276efd2;
  receipts/manifest-path-safety/. Sealed cause
  generation_unsafe_declared_output guards declared outputs where they
  enter.
- Package AGENTS.md reconciliations: 432f243, 1c7aec3, and the
  Contextual Rendering merge reconciliation.
- Contextual Rendering bare-string target validation: MERGED 623edb4;
  receipts/contextual-rendering/. The vault-git v1 pin is f22e836b..;
  realizing resume_interrupted_transaction was parked as
  candidate-authoring (now inside the proposed grant above). Harvested
  admission incident: briefs carry the no-subagents line.
- Facade dual coverage: MERGED e787db0 (unit commit 66ea98c, receipts at
  306eb62); receipts/facade-coverage/. aggregateStationMapCoverage is
  the single counting-rule owner (observed counts only real_process AND
  covered); StationMap.coverage and projected provenance are optional in
  type, always projector-populated. Standing declines carried above.
- cli-author dual-coverage teaching: MERGED dbe8679 (unit commit
  aefcf34, receipts at 1306128); receipts/cli-author/. The Dual Coverage
  Design Gate in cli-author/references/cli-command-facade.md owns the
  facade design proof, including each coverage-reporting consumer's own
  output seam.

## Notes

- The root AGENTS.md on this branch predates main's 513ff2f and still
  claims `bun run lint` fails in `.worktrees/` checkouts; verified false
  here. The package AGENTS.md Checks section owns the gate commands.
- A prior resume attempt (job a19b6b4b, 2026-08-22) resolved at high
  rather than the required xhigh supervisor effort and was stopped
  before any edit or admitted output; it is non-evidence.
- Supervisor transfer (Nathan's order, 2026-08-22): the prior Fable
  supervisor session f866f2d3-b0f9-4d54-9133-a475060e6b3b was ordered
  stopped and replaced. The fresh supervisor is background session
  "issue-55 test-custody fresh supervisor", short ID 49ce1ea3, session
  49ce1ea3-5d56-4a88-b5fb-3fc8d1ab8b2a, this worktree, resolved
  claude-fable-5 at xhigh effort (session record and launch flags
  observed 2026-08-22). A direct relinquish notice was attempted at
  16:06 AEST and was undeliverable: the prior session is absent from
  the session registry and unreachable, so it is treated as already
  stopped; any later output from it is non-authoritative. The fresh
  supervisor completed resume step 0 (clean tree at 91f546e, exactly
  one live unit brief, in .worktrees/issue-55-test-custody, and worker
  c84f419e verified live on its own branch) before any queue action.
- Dispatch incident (2026-08-22): worker session 1479e2c0 launched at
  13:52 AEST, crossed by Nathan's pre-dispatch hold, stopped at 13:59
  with zero file changes (tracked diff empty, sha256 e3b0c442.., only
  the supervisor-authored AGENT-BRIEF.md present, untracked). All its
  output is unadmitted non-evidence. The owner contradictions it
  exposed (the candidate-edit closed boundary versus the grant; the
  version-custody pin misread as a worker path) are reconciled in this
  commit, an issue 55 correction comment posted with it, and the staged
  vault packet.
- Custody event (2026-08-22, 14:05:57 to 14:06:01 AEST): Nathan's own
  VS Code sync click (his confirmation, 2026-08-22: "the push was me i
  clicked it in vscode"; window23 exthost Git log) ran
  `git pull --tags` on this branch, linearizing the 22 local commits
  (dropping the three unit merge commits) and pushing the result,
  advancing origin fa1dd9f..ab81eaa. Not a supervisor act; the
  supervisor transcript contains no pull or push. Verified: range-diff
  all patch-identical; the a7fd5c6 and
  237efce trees byte-identical to 7d5ec53 and ab81eaa; worker 2add7804
  unaffected on its own branch, its 14:13 diff snapshot hashed
  021f0be1.. (13755 bytes). Pre-rebase history preserved at local
  branch archive/issue-55-pre-rebase-237efce, never pushed. The
  "nothing is pushed" statements in issue comments 5377730080 and
  5377751430 are false as of 14:06 through Nathan's own sync action;
  the supervisor no-push rule was not crossed and still binds. Full
  receipt: receipts/custody/rebase-2026-08-22-map.md.
- Biome owner boundary (Nathan, 2026-08-22): the canonical Biome
  contract moved concurrently in the dotfiles main checkout (the
  archived Claude Code Config contract selected; lint-only, read-only
  semantics; exact .agents re-inclusion only for Browser Use, Browser
  Connect and Warm Chrome; an authorized main writer holds uncommitted
  changes there, which are not publication authority and are never
  copied here). Every "66 files" Biome result this unit records is
  truthful only for this frozen branch snapshot and is not proof
  against the newer canonical main contract, under which this package
  sits outside root re-inclusion. Integration boundary at merge time:
  re-evaluate the package's Biome gate claim under the canonical
  contract; do not reintroduce formatter-write gates.
  Addendum (Nathan, 2026-08-22, read-only awareness): active biome.json
  also excludes !**/actions/assets (Browser Use reviewed-action assets
  are content-addressed; explicit check:write or lint:fix must not
  mutate bytes without renaming SHA-derived filenames or registry
  entries). Current-main evidence: root bun run validate GREEN, 389
  files no fixes; Browser Use exact check 251 files no fixes; the
  reviewed-action asset path is a 0-file ignored control; Browser Use
  diff hash unchanged 4e957d7b..; the canonical docs now state both
  bun run validate and bun run check are read-only and only bun run
  check:write formats; git diff --check GREEN. None of that
  uncommitted active-main work is copied here; the issue-branch
  66-file result stays branch-snapshot evidence only.
- Known pre-existing failures a gate must not count as new: two ANSI
  stderr tests in cli-command-facade tests/process-testing.test.ts; one
  cli-execution-auditor station-asset test; two test-runner typecheck
  errors. Each reproduces at the fixed points recorded in the ledger
  units that observed them.
