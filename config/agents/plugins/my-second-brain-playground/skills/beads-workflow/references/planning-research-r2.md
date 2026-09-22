# Planning and research kind

Revision 2, 22 September 2026. Record on the Bead as its workflow reference:
`skills/beads-workflow/references/planning-research-r2.md`, revision 2.
Supersedes revision 1 for every new run; a Bead that records revision 1 keeps
it. The one change is Step 6, bound to the panel-only Resume Panel of
[Spec #57](https://github.com/nathanvale/dotfiles-private/issues/57)
revision 5 on every Harness.

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
`"$BD_EXECUTABLE" show <id> --readonly --json` carries the dispatched parent, external
reference, and Spec link.

## 2. Gate the decision at entry

Create exactly one Gate: `"$BD_EXECUTABLE" gate create --type=human --blocks
<id> --reason "<the decision Nathan will make>" --actor <role>`. The Gate exists before any research so the
Bead cannot close on prose alone.

Done when `"$BD_EXECUTABLE" gate list <id> --readonly --json` shows one open
human Gate and no `gh:pr` Gate, and `"$BD_EXECUTABLE" gate list --all
--readonly --json` taken before and after differs only by this Gate.

## 3. Claim and bind

The performing Cast Member runs `"$BD_EXECUTABLE" update <id> --claim --actor
<role>`. Then, from a Git working directory, bind the session once with
`msb-workflow bind` as `SKILL.md` shows. Post the entry checkpoint: the
capability request, the selected lane in the label form `cast.md` prescribes,
the question, and the next safe action.

Done when `"$BD_EXECUTABLE" show <id> --readonly --json` reports `in_progress`
with the role as assignee and the bind envelope reports success.

## 4. Gather, compare, record

Primary sources only, each linked. Compare at least two alternatives against
the question. The research note lives in the vault owner named on the Bead,
written by the Vault Steward under explicit write authority; it holds the
alternatives, the sources, and the recommendation. A summary is an index:
recover the original source before judging it.

Done when a checkpoint's Evidence names the note path and its commit.

## 5. Decide

Nathan, or the Stage Manager on his decision, runs `"$BD_EXECUTABLE" gate
resolve <gate> --reason "<decision and rationale>" --actor <role>`. The
decision is also recorded in the vault owner.

Done when `"$BD_EXECUTABLE" gate list <id> --readonly --json` shows no open
Gate and the vault decision cites the Gate ID.

## 6. Resume from a fresh context

Two routes. After one real compaction the Harness hook delivers the Resume
Panel exactly once, alone, and an independent `msb-workflow recover` panel
for the same session equals it. In one fresh session bound to the same Bead
the start hook delivers at most session guidance: bind as Step 3 shows, then
run `msb-workflow recover`; its panel is the Resume Panel. On either route,
continue from the panel's next safe action.

Done when, on the compaction route, the compaction yielded exactly one hook
delivery and a `recover` panel for the same session, taken before the next
write, equals it; or, on the fresh-session route, the bind envelope reports
success and the `recover` panel for that session names the same Bead and one
next safe action.

## 7. Hand back

Post the closeout checkpoint: the decision and rationale, remaining work,
next owner, next safe action, and one recovery lesson cited from its existing
vault owner with path and `updated` date. Transient checkpoint comments are
not lessons and are not promoted.

Done when `"$BD_EXECUTABLE" show <id> --readonly --json --include-comments` returns the
closeout checkpoint with all five headings and the cited lesson's vault path
and `updated` date, and a `msb-workflow recover --json` panel for the bound
session, or a fresh session bound to the same Bead, taken after the post,
reports no open human Gate, shows the checkpoint's `## Checkpoint:` heading
as the last of `result.recentComments`, and lists that native `show` read among
its read-only commands. The panel quotes at most 1024 bytes per comment and
derives its own next safe action; read the full Handback with
`"$BD_EXECUTABLE" show`.

## 8. Retire

After independent review against the Ticket's criteria, close with
`"$BD_EXECUTABLE" close <id> --reason-file <file> --actor <role>`.

Done when `"$BD_EXECUTABLE" show <id> --readonly --json --include-comments` returns the
closed Bead with every checkpoint body, the rendered board shows the decision
and those bodies, and every other run's Bead and Gate list are byte-equal to
their pre-run reads.
