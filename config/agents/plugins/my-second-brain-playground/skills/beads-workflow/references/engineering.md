# Engineering kind

Revision 2, 22 September 2026, repairing `F-55-2`, `F-55-3`, and `F-55-4`
found in revision 1 of 21 September 2026 at
`36572abc762ba13b6eec2e41d96426690e73eac5`. Record on the Bead as its
workflow reference: `skills/beads-workflow/references/engineering.md`,
revision 2.

Journey: accepted intent, an A and B to C fan-in with one human Gate on C,
claimed candidates, independent two-axis review, one actual finding, one
repair prerequisite as a native `blocks` edge, per-finding attempt accounting,
one mid-repair Handback to a replacement lane and its resume, focused
re-review, accepted Handback, join, Retirement, board readback at three
moments. The run ends at Retirement of the join; a merge, activation, or
release is never claimed by it. Ticket #52 revision 3 and its receipts in the
rollout packet are the single-lane precedent; this reference adds what that
run did not exercise.

Apply the shared rules in [`SKILL.md`](../SKILL.md) at every step: the store
gate before each write, `--actor <role>`, the checkpoint shape, the
board-comment route, and recovery through `msb-workflow`.

## Identities every checkpoint carries

- Candidate: base commit, task branch, candidate commit, and dirty bytes by
  path and hash or `none`.
- Finding: `F-<run>-<seq>`, minted in the run's `findings.md` when a defect is
  first reported and matched afterwards by failure behaviour, source anchor,
  and candidate together. A rename records a new anchor, a split gives each
  child its own ID with `split-from`, and a replacement lane, session, or
  candidate never mints a second ID for the same defect.
- Attempts: `attempt <consumed> of <allowed>` per finding, copied from
  `findings.md`. The allowance is quoted at entry from its accepted owner, the
  vault's `projects/engineering-workflow/specs/engineering-loop.md`; an attempt
  is consumed when its repair is dispatched, and a replacement lane, session,
  or candidate inherits the count. Nathan approves any extension.
- Lane: the `Role • Model` label `cast.md` prescribes. The run's supported set
  is the rows `cast.md` declares for the dispatched roles, recorded once at
  entry; a substitution is a different declared lane for the same role.

The run's packet under the rollout packet owner holds `findings.md` (one row
per finding: ID, axis, anchor, failure behaviour, candidate, attempts,
disposition, next action), every checkpoint file, and the receipts, sealed
with `SHA256SUMS`.

A board witness is one read-only visit to the rendered board at a named
moment, in the shape of the rollout packet's
`board-rendered-witness-20260921.md`, saved in the packet. The `bd ready` and
`bd blocked` reads taken beside it are native graph facts, recorded with it.

## Guards

- Uncertain effect: before any retry, read the owner. A Beads write:
  `bd show <id> --readonly --json --include-comments`. A binding:
  `msb-workflow inspect`. Retry only when the read proves the first attempt
  left nothing; a claim, comment, close, or dispatch that already landed is
  accepted as it is.
- Guarded writes: `--if-assignee <holder>` or `--if-status <status>` on a
  `bd update` field write other than `--claim`, and `--if-assignee <holder>`
  on `bd unclaim`, write nothing on a mismatch and exit non-zero naming the
  current holder or status. A mismatch is a fact to read, never a guard to
  repeat.
- Ownership: `bd close` refuses an actor other than the assignee and refuses
  while a `blocks` dependency is open. The assignee closes, after acceptance.
- Frontier exit: a Bead leaves the actionable frontier by one of two native
  moves. `bd unclaim <id> --if-assignee <holder>` when the Bead stays live
  and only its holder changes; `bd supersede <old> --with <new>` when the
  Bead itself is replaced, which closes `<old>` with a `supersedes` edge to
  `<new>`, keeps its comments and edges readable, and drops it from
  `bd blocked`, while `<new>` carries the same finding ID and count. Neither
  move claims delivery. `--force`, `reclaim`, `prune`, `purge`, and `delete`
  stay outside a run.

## 1. Wire the graph

One body file each for A, B, and C: the intent, the workflow reference and
revision the dispatch names for that Bead (this reference, or
`planning-research-r2.md` when B is the planning continuation), the accepted
Spec revision, the base commit, the owned paths, the performing Cast Role,
the packet path, and the allowance with its owner. Create each under
the dispatched parent with the GitHub issue as `--external-ref` and the Spec
as `--spec-id`. Then `bd dep add <C> <A>`, `bd dep add <C> <B>`, and exactly
one Gate: `bd gate create --type=human --blocks <C> --reason "<the decision
Nathan makes to admit the join>"`. Read each Bead back and compare with its
file.

Done when `bd show <C> --readonly --json` lists A, B, and the Gate as `blocks`
dependencies, `bd blocked --readonly --json` lists C with all three in
`blocked_by`, `bd ready --readonly --json` lists A and B and omits C,
`bd gate list <C> --readonly --json` shows one open human Gate, and
`bd gate list --all --readonly --json` taken before and after differs only by
this Gate.

## 2. Route and claim

The Stage Manager's run entry checkpoint on the dispatched parent names the
Spec revision, this reference and revision, the supported lane set, the
allowance and its owner, the packet path, each prerequisite's
`Role • Model`, and the role-skill identity: the role skill each dispatched
role loads and this reference, each by resolved absolute path and SHA-256,
saved as one list in the packet. Each performing Cast Member then runs
`bd update <id> --claim`, binds once with `msb-workflow bind` from a Git
working directory, and posts its entry checkpoint: the lane label, the
candidate base, the worktree, the owned paths, and the next safe action.

Done when the parent's last comment is the run entry checkpoint with the lane
set and the role-skill identity list, `bd show <A> --readonly --json` reports
`in_progress` with the role as assignee, and the bind envelope reports
success.

## 3. Build the candidate

A and B run in parallel on disjoint owned paths; overlapping paths serialize.
A prerequisite of the planning and research kind follows its own reference
from claim to Retirement and joins here only as a closed Bead. Each performer
works in an isolated worktree on a task branch from the base commit, edits
only its owned paths, passes the focused checks and then the repository
gates, and commits one candidate. Its Handback checkpoint names the candidate
identity, each check with its receipt, remaining work, the reviewer as next
owner, and the next safe action.

Done when the Handback checkpoint names the candidate commit and
`git diff --stat <base>..<candidate>` touches only the owned paths.

## 4. Review and mint the finding

Two fresh reviewer contexts, one per axis, each pinned to the candidate
commit, the Spec revision, and the standards identity. The first applicable
material finding on either axis is the run's finding. From here, A names
the prerequisite that carries it, whichever of the two Step 1 created, and B
names the other. Add the row to `findings.md` at `attempt 0 of <allowed>`,
disposition `not-proved`, and post a checkpoint on A naming the ID, anchor,
candidate, and count. A prerequisite whose review returns no material
finding is accepted on its Handback and its assignee closes it with
`bd close <id> --reason-file <file>`. A run with no material finding on
either prerequisite records that; Steps 5 to 10 stay unexercised and the
closeout reports the gap. A finding is observed, never manufactured.

Done when the row exists, A's checkpoint carries the same ID, candidate
commit, and count as the row, and each accepted prerequisite without a
finding reports `closed`.

## 5. Block the join on the repair

Create R under the dispatched parent: its body names the finding ID, anchor,
failure behaviour, the candidate commit as R's base, the allowance, and this
reference. Then `bd dep add <C> <R>`, `bd dep add <A> <R>`, and
`bd dep add <R> <A> -t discovered-from`. Read back, then take board witness
one: R open, A and C blocked.

Done when `bd blocked --readonly --json` lists C and A with R in `blocked_by`,
`bd ready --readonly --json` lists R and omits A and C, and `bd show <R>
--readonly --json` carries the `discovered-from` edge to A. From here `bd
close <A>` is refused natively until R closes.

## 6. Repair

The dispatched performer claims R, binds under its own session, and posts R's
entry checkpoint with the finding ID, the candidate, the lane label, and
`attempt 1 of <allowed>`; the row moves to the same count. In a worktree from
the candidate commit: RED with a focused check that fails on the finding,
then GREEN, then the focused checks and the repository gates, then one repair
commit.

Done when R's entry checkpoint and the row agree on the ID, candidate, and
count, and the RED receipt is in the packet.

## 7. Hand back mid-repair

The sender commits or names its partial state by path and hash, posts the
Handback checkpoint on R with the finding ID, candidate, and count verbatim,
the exact next repair action under `## Remaining`, the Stage Manager as next
owner, and stops. The Stage Manager releases the claim with `bd unclaim <R>
--if-assignee <sender>` and no `--reason`, so the Handback stays the last
comment.

Done when `bd show <R> --readonly --json --include-comments` reports `open`,
no assignee, and the Handback as the last comment. A non-zero exit names the
current holder; read, then decide.

## 8. Substitute the lane

The Stage Manager refuses one request for a lane outside the recorded
supported set before any launch, with one next action, then selects a
supported lane from the same role's row. One checkpoint on R records the
`Role • Model` before, the refused request with its next action, and the
`Role • Model` after. Role skills and this reference are unchanged by the
selection.

Done when that checkpoint is on R, `shasum -a 256 -c` over the role-skill
identity list from the run entry checkpoint passes, proving the role skill
and this reference byte-equal to entry whether a change were committed or
dirty, and the pane listing shows one launch, for the selected lane only.

## 9. Resume on the replacement lane

The receiver runs `bd update <R> --claim`, binds under its own session, and
takes `msb-workflow recover --json` as the resume witness. Its entry
checkpoint copies the finding ID, candidate, and count from the Handback and
the row, never re-derived, and names the lane label. It continues from the
Handback's exact next action to GREEN, the focused checks, the repository
gates, and one repair commit, then posts R's Handback checkpoint.

Done when the `recover` panel reports `in_progress` with the receiver's role
as assignee, no open blocker or human Gate, and the sender's Handback among
`result.recentComments`, and the receiver's entry checkpoint and the row carry
the same ID and count as before the transfer.

## 10. Re-review and accept

One fresh reviewer context per affected axis receives the repair candidate,
the unchanged Spec and standards identities, the finding ID, the changed
paths, and the repair evidence, and reviews only that finding and regression
on the changed paths. The verdict keeps the ID: `proved` sets the row's
disposition; a new distinct defect takes a new ID with `related-to` or
`split-from`; `not-proved` leaves the row's disposition and count unchanged,
and only the next dispatched repair consumes the next attempt, while the
allowance allows, otherwise the run hands back. On `proved`, R's assignee
closes R with `bd close <R> --reason-file <file>` naming the ID, candidate,
count, and verdict receipt; then A's assignee supplies the facts for A's
accepted Handback, the repaired candidate identity (the repair commit with
dirty bytes `none`) beside the ID, count, and verdict receipt, the Ledger
Steward posts it by the board-comment route, and A's assignee closes A on
that Handback, so C joins the proved candidate.

Done when `bd show <R>` and `bd show <A>` report `closed`, A's last
checkpoint is its accepted Handback naming the same candidate commit as R's
close reason, the row reads `proved` with the re-review receipt, and
`bd blocked --readonly --json` lists C blocked by the Gate only.

## 11. Admit and join

Nathan, or the Stage Manager on his decision, runs `bd gate resolve <gate>
--reason "<decision and rationale>"`. Read `bd ready --readonly --json` now,
before the claim, and record it, then take board witness two: C ready. The
performing Cast Member claims C, binds, confirms with `git rev-parse` that
the commit it integrates for each prerequisite is the candidate commit that
prerequisite's accepted Handback names, verifies the integrated result of A
and B against both accepted Handbacks with focused checks, and supplies the
facts for C's closeout checkpoint, which the Ledger Steward posts by the
board-comment route, with `## Evidence` recording both compared commits and
`## Remaining` naming the merge, activation, and release as unproved.

Done when `bd gate list <C> --readonly --json` shows no open Gate, the
`bd ready` read between the resolve and the claim listed C, and
`bd show <C> --readonly --json --include-comments` returns the closeout
checkpoint with all five headings.

## 12. Retire and read the board

After independent review against the Ticket's criteria, C's assignee closes
it with `bd close <C> --reason-file <file>`. Take board witness three: C
closed, its closeout body visible. Seal the packet.

Done when `bd show <C> --readonly --json --include-comments` returns the
closed Bead with every checkpoint body, the three board witnesses show R
open with C blocked, then C ready, then C closed with the merge unproved,
`findings.md` retains every attempt row, every Bead that left the frontier
did so by a listed move, and every other run's Bead and Gate list are
byte-equal to their pre-run reads.
