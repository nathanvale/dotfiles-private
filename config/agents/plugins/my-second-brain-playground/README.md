# My Second Brain Playground

Build new My Second Brain skills here, one usable vertical slice at a time.
Use [playground-slice](skills/playground-slice/SKILL.md) to resume the baseline,
choose the next experiment, and prove an agreed improvement through real use.
Use [evaluate-slice](skills/evaluate-slice/SKILL.md) to define observable criteria
and obtain independent process, persistence, and recovery evidence. New work
tracks Tasks in Beads through beads-workflow and msb-workflow; Agent Ledger
remains the tracked owner only for a Task an already-adopted legacy project
has not yet cut over, and the slice skill owns that legacy route.
The first slice gives Codex and Claude Code isolated Git commits for concurrent
playground-vault work.

The playground repository selected by the user-local vault configuration below
owns the synthetic vault fixtures and exercises. This plugin owns the skills
that will operate on those fixtures. Add each skill from scratch under
`skills/<name>/SKILL.md` when its slice is ready to implement and exercise.

The source lives beside `browser-lanes` in the personal plugin directory.
Harness installation and fresh-session discovery are separate from source
creation. `vault-note-commits` lets parallel agents prepare isolated note
commits and integrates disjoint candidates onto local `main` one at a time.
It checks new files as well as existing edits, reports unchanged candidates
as successful no-ops, and retains private completion receipts for safe retries.

Use the playground's `bun run list --family <name>` to discover current notes.
New notes appear through their metadata; family indexes remain curated
navigation rather than a file every writer must update.

User-local vault selection lives at
`~/.config/my-second-brain-playground/vault.json`. Production vault
configuration remains separate.

## Compaction recovery

Both hook manifests (`hooks/claude/hooks.json`, `hooks/codex/hooks.json`)
register `bin/msb-workflow hook`;
[`packages/workflow-cli/README.md`](packages/workflow-cli/README.md) owns
that hook's contract and the source-only boundary (installation, hook trust,
and activation are Ticket #52 evidence, not claims here). The
[beads-workflow](skills/beads-workflow/SKILL.md) skill owns the LKR Beads
route.

The legacy checkpoint contract (`hooks/recovery-checkpoint`,
`hooks/recover-context`, the Python owner, schema-v2 checkpoints) is provenance
under Spec #57: kept byte-identical, registered by no manifest, never read by
the registered hook. It remains a manual route whose help owns its syntax, and
recovery traces record only that legacy route. Resolve the installed plugin
root from the selected Harness metadata, assign it to `PLUGIN_ROOT`, then:

```sh
"${PLUGIN_ROOT}/hooks/recovery-checkpoint" --help
"${PLUGIN_ROOT}/bin/recovery-traces" --help
```

For a legacy manual checkpoint on note work that is missing, stale, uncertain,
or refused, follow the configured playground's `docs/agents/recovery.md`; the
legacy launcher's help owns its binding syntax. For an LKR schema-v3 binding,
refusal, or missing Resume Panel, use `bin/msb-workflow --help` and the
[workflow-cli README](packages/workflow-cli/README.md#recovery-and-rollback),
not that vault document.

The legacy writer validates the configured playground, project files, Agent
Ledger Register, and accepted Task before replacing its checkpoint; the legacy
hook delivered verified pointers and one fixed recovery action. Raw transcripts
remain with their Harness and never become checkpoint or binding input.

Recovery traces are private operational evidence under XDG state. They do not
own project knowledge, task state, decisions, or completion proof. Follow the
slice skill's [trace inspection and cleanup route](skills/playground-slice/references/compaction-recovery.md#inspect-recovery-traces)
for storage limits, excluded content, deletion ownership, and interpretation.

For delegated task tracking and evidence-based reconciliation on an
already-adopted legacy project's Agent Ledger Task, use the slice skill's
[Ledger Steward route](skills/playground-slice/references/tasks-first.md#ledger-steward).
The [specification](specs/ledger-steward.md) records this role's boundary and
proof. New work tracks Tasks in Beads through
[beads-workflow](skills/beads-workflow/SKILL.md) instead.
