# Planning and research kind

Revision 1, 21 September 2026. The Bead records this file's plugin path,
`skills/beads-workflow/references/planning-research.md`, and this revision
verbatim as its workflow reference, beside the accepted Spec revision. A new
revision here starts a new run; it never rewrites an active one.

Journey: actual question, workflow selection, claimed source gathering and
comparison, evidence, human decision Gate, checkpoint, fresh-context resume,
accepted Handback or Retirement, board readback. The run ends at Retirement,
not at implementation; follow-on engineering is a new Bead of the engineering
kind.

Apply the shared rules in [`SKILL.md`](../SKILL.md) at every step: the store
gate before each write, `--actor <role>`, the checkpoint shape, the
board-comment route, and recovery through `msb-workflow`.

## 1. Freeze the question

One real, bounded question that primary sources can answer. Write the Bead
body file with the question; this workflow reference and revision; the
accepted Spec revision; the vault owner that will hold the note and the
decision, chosen through `work-placement.md`; and the performing Cast Role.
Create the Bead under the dispatched parent with the GitHub issue as
`--external-ref` and the Spec as `--spec-id`, then read it back and compare
the description with the file.

Done when the Bead exists, its description equals the file, and
`bd show <id> --readonly --json` carries the dispatched parent, external
reference, and Spec link.

## 2. Gate the decision at entry

Create exactly one Gate: `bd gate create --type=human --blocks <id> --reason
"<the decision Nathan will make>"`. The Gate exists before any research so the
Bead cannot close on prose alone.

Done when `bd gate list <id> --readonly --json` shows one open human Gate and
no `gh:pr` Gate, and `bd gate list --all --readonly --json` taken before and
after differs only by this Gate.

## 3. Claim and bind

`bd update <id> --claim` by the performing Cast Member. Then, from a Git
working directory, bind the session once with `msb-workflow bind` as
`SKILL.md` shows. Post the entry checkpoint: the capability request, the
selected lane in the label form `cast.md` prescribes, the question, and the
next safe action.

Done when `bd show <id> --readonly --json` reports `in_progress` with the
role as assignee and the bind envelope reports success.

## 4. Gather, compare, record

Primary sources only, each linked. Compare at least two alternatives against
the question. The research note lives in the vault owner named on the Bead,
written by the Vault Steward under explicit write authority; it holds the
alternatives, the sources, and the recommendation. A summary is an index:
recover the original source before judging it.

Done when a checkpoint's Evidence names the note path and its commit.

## 5. Decide

Nathan, or the Stage Manager on his decision, runs `bd gate resolve <gate>
--reason "<decision and rationale>"`. The decision is also recorded in the
vault owner. Nobody else resolves, and no comment substitutes for it.

Done when `bd gate list <id> --readonly --json` shows no open Gate and the
vault decision cites the Gate ID.

## 6. Resume from a fresh context

One real compaction, or one fresh session bound to the same Bead. The Harness
hook delivers one Resume Panel; an independent `msb-workflow recover` panel
for the same session matches it. Continue from the panel's next safe action.

Done when the two panels compare equal and the prompt after delivery is
silent.

## 7. Hand back

Post the closeout checkpoint: the decision and rationale, remaining work,
next owner, next safe action, and one recovery lesson cited from its existing
vault owner with path and `updated` date. Transient checkpoint comments are
not lessons and are not promoted.

## 8. Retire

After independent review against the Ticket's criteria, close with
`bd close <id> --reason-file <file>`.

Done when `bd show <id> --readonly --json --include-comments` returns the
closed Bead with every checkpoint body, the rendered board shows the decision
and those bodies, and every other run's Bead and Gate list are byte-equal to
their pre-run reads.
