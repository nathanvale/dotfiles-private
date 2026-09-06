# My Second Brain Playground

Build new My Second Brain skills here, one usable vertical slice at a time.
Use [playground-slice](skills/playground-slice/SKILL.md) to resume the baseline,
choose the next experiment, and prove an agreed improvement through real use.
Use [evaluate-slice](skills/evaluate-slice/SKILL.md) to define observable criteria
and obtain independent process, persistence, and recovery evidence. Agent Ledger
adoption starts with Tasks; the slice skill owns the route for later capabilities.
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

The installed plugin exposes one checkpoint contract and a read-only
`SessionStart` hook for `compact` events. Resolve the installed plugin root
from the selected Harness metadata, assign it to `PLUGIN_ROOT`, then inspect
or write the private checkpoint through its executable owner. Inspect recovery
traces through the separate read-only view and scoped cleanup owner:

```sh
"${PLUGIN_ROOT}/hooks/recovery-checkpoint" --help
"${PLUGIN_ROOT}/bin/recovery-traces" --help
```

For missing, stale, uncertain, or refused recovery context, follow the configured
playground's `docs/agents/recovery.md`; command help owns binding syntax.

The writer validates the configured playground, project files, Agent Ledger
Register, and accepted Task before replacing the checkpoint. The hook delivers
verified pointers and one fixed recovery action. Raw transcripts remain with
their Harness and never become checkpoint input.

Recovery traces are private operational evidence under XDG state. They do not
own project knowledge, task state, decisions, or completion proof. Follow the
slice skill's [trace inspection and cleanup route](skills/playground-slice/references/compaction-recovery.md#inspect-recovery-traces)
for storage limits, excluded content, deletion ownership, and interpretation.

For delegated task tracking and evidence-based reconciliation, use the slice
skill's [Ledger Steward route](skills/playground-slice/references/tasks-first.md#ledger-steward).
The [specification](specs/ledger-steward.md) records this role's boundary and proof.
