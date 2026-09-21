---
name: beads-workflow
description: Run or resume one bounded planning or research journey on native Beads through direct bd 1.3.0 commands, with the msb-workflow helper used for recovery only. Use when a Stage Manager dispatch, a Cast Member, or a fresh-context resume names a Bead, a workflow kind, or a bd write on the isolated store; use for the store gate before any bd write, the human Gate, checkpoint comments, session binding, and the engineering kind's precedent pointer.
---

# Beads Workflow

Native `bd` is the whole work graph: Beads, parent membership, dependencies,
ready queries, claims, human Gates, checkpoint comments, and closeout. This is
the procedure skill a Cast Member follows to run one bounded journey on it;
role skills invoke it and stay unchanged by workflow selection. The
`msb-workflow` helper takes part only in recovery: private session binding,
Compaction Refresh, the Resume Panel, and diagnostics. Nothing here wraps
`bd`, and nothing here is a second task store.

Each workflow kind has one reference with its own revision. The Bead records
that path and revision verbatim beside the accepted Spec revision, so a later
selection cannot rewrite an active run.

| Kind | Reference | State |
| --- | --- | --- |
| Planning and research | [`references/planning-research.md`](references/planning-research.md) | Revision 1 |
| Engineering | [Ticket #52](https://github.com/nathanvale/dotfiles-private/issues/52) revision 3 and its receipts in the rollout packet | Precedent only; its procedure is a later unit |

Read the shared rules below, then the kind's reference.

## Dispatch

The Stage Manager's dispatch names the store root, the `bd` executable, the
parent Bead, the GitHub issue, the Spec revision, the workflow kind with its
reference revision from the table above, the performing Cast Role, and the
writes it authorizes. Capability resolution lives with the Stage
Manager and the vault's `projects/engineering-workflow/cast.md`; this skill
names no model or Harness, and the same role runs under any lane. A dispatch
that grants no write authority yields a proposed command file (the
`proposed-commands.sh` pattern in the rollout packet) and stops before the
first write. On an unsupported workflow kind or reference revision, end the
run and reply only with a refusal and one next action: ask the Stage Manager
for a new dispatch naming a supported kind and revision.

## Store gate before every write

Prove the selected store with the dispatched executable, then refuse on any
mismatch with one repair:

```sh
export BEADS_DIR=<store root>/.beads
bd version                          # version 1.3.0, revision f45b249ce6b4
bd where --readonly --json          # .path equals $BEADS_DIR; .prefix as dispatched
bd config list --readonly --json    # prefix agrees
bd context --readonly --json        # in a Git working directory: same store, not redirected
```

A missing or wrong `BEADS_DIR` can fall back silently to a store above the
working directory, so `path` equality is the guard, never the exit status.
`msb-workflow inspect --workspace <store root>` runs the same reads and prints
the accepted executable digest; a wrong or ancestor store is
`DOMAIN_STORE_MISMATCH`. A strict `--readonly` read still rewrites the store's
`last-touched` hint; that is a `bd` side effect, not a write.

## Native primitives, bd 1.3.0

Syntax comes from `bd <command> --help` on the pinned executable. Pass
`--actor <role>` on every write and `--author <role>` on every comment so the
audit trail names the Cast Role. Read with `--readonly --json`.

| Move | Command |
| --- | --- |
| Create | `bd create "<title>" --parent <bead> --external-ref <issue> --spec-id <spec> --body-file <file>` |
| Depend | `bd dep add <blocked> <blocker>` |
| Ready | `bd ready --readonly --json`; `bd blocked --readonly --json` |
| Claim | `bd update <id> --claim` |
| Gate | `bd gate create --type=human --blocks <id> --reason "<why>"`; `bd gate list <id> --readonly --json` |
| Checkpoint | `bd comments add <id> -f <file> --author <role>` |
| Read back | `bd show <id> --readonly --json --include-comments` |
| Resolve | `bd gate resolve <gate> --reason "<decision and rationale>"` |
| Close | `bd close <id> --reason-file <file>` |

After every write, read the Bead back and compare with the file you wrote.

## Gate authority

A `type=human` Gate is resolved by Nathan, or by the Stage Manager on his
decision, and by nobody else. A checkpoint comment, a Board Projection, or a
Handback never grants that permission. Planning carries no `gh:pr` Gate, and
selecting a new kind leaves every existing run's Bead, Gates, comments, and
claims byte-equal.

## Checkpoint comments

Every checkpoint is one GitHub-flavoured Markdown comment with five
sentence-case `##` headings in this order: `## Checkpoint: <outcome>`,
`## Evidence`, `## Remaining`, `## Next owner`, `## Next safe action`. That is
Spec #51's `CHECKPOINT: outcome` shape rendered under the board-comment
policy; bare `Label:` lines collapse into one paragraph on the board. A
comment cannot claim or close a Bead or resolve a Gate. Board text follows the
board-comment policy in the rollout packet: the evidence owner supplies exact
facts and a receipt pointer, the Ledger Steward drafts and applies the Unslop
skill the policy names, the Stage Manager approves that exact draft, then the
comment is posted and read back by ID. Raw receipts stay in private state.

## Recovery through the helper only

```sh
<plugin root>/bin/msb-workflow --help
MSB_WORKFLOW_BD_EXECUTABLE=<bd> <plugin root>/bin/msb-workflow bind --workspace <store root> --bead <id> --session <id> --json   # once per session, from a Git working directory
<plugin root>/bin/msb-workflow recover --workspace <store root> --session <id> --json   # on resume
MSB_WORKFLOW_BD_EXECUTABLE=<bd> <plugin root>/bin/msb-workflow inspect --workspace <store root> --session <id> --json   # on doubt
```

The plugin root is `../..` from this skill's directory. The helper's `--discover
--json` and `packages/workflow-cli/README.md` own its contract. After a
compaction the Harness hook delivers the Resume Panel; continue from its next
safe action. The legacy `hooks/recovery-checkpoint` launcher is provenance,
not a route, and the helper never runs a `bd` write.

## Owners this skill points to

- Rollout packet: `$XDG_STATE_HOME/my-second-brain-playground/legacy-kit-rollout-20260916/lkr-195/`, holding `board-comment-policy.md`, `m2-entry-checkpoint/proposed-commands.sh`, and the Ticket #52 receipts.
- Beads source gate and upstream docs: dotfiles `docs/agents/beads.md`.
- Vault owner choice for a note or decision: dotfiles `docs/agents/work-placement.md`, then the vault's own entry rules.
