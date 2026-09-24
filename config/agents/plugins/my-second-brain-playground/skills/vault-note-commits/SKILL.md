---
name: vault-note-commits
description: "Legacy alias of vault-steward. Use only to finish a candidate already begun through vault-note-commits; start new vault commits with my-second-brain-playground:vault-steward."
---

# Vault Note Commits

Start in the directory containing this `SKILL.md`; go up twice (`../..`) to
resolve the installed plugin root. Inspect the helper contract with
`<plugin-root>/bin/vault-note-commits --help`.
The helper discovers the synthetic vault through
`~/.config/my-second-brain-playground/vault.json`. When configuration is
missing or invalid, read [configuration](references/configuration.md).
`vault-note-commits` is an alias of the Vault Steward CLI (`vault-steward`); read
[guardrails](references/guardrails.md) when a result carries `warnings`, a
`guard` field, or `GUARD_INCOMPATIBLE`.

## Begin

After choosing the complete intended file set, run `begin --json` with one
repeated `--path` per repository-relative file. Use the returned worktree for
every read and write in the update. Keep the canonical checkout unchanged.

## Finish

Inspect the candidate diff and choose one concise commit subject describing the
durable meaning. Run `finish --json` with the returned worktree and subject.
Report the result. Local integration completes the vault write; remote sync is
a separate workflow.

Treat `NO_CHANGES` as successful completion without a note commit. It confirms
no authored candidate changes, not the freshness of canonical notes. If only
some declared files changed, follow the path-set refusal instead.

After a lost finish response, retry the same command with the exact original
worktree path, even after cleanup. `ALREADY_COMPLETED` reports the original
outcome and commit without a new write. Keep the original run identity; do not
start another candidate to discover whether the previous one completed.

On refusal, preserve the returned worktree and follow its `nextAction`. Resolve
semantic overlap with Nathan. Disjoint candidates rebase onto the latest local
`main`, rerun the checker, and integrate under one lock. The helper owns path
fencing, candidate checks including new-file whitespace, the exact-path commit,
canonical-state validation, fast-forward integration, and successful cleanup.
Use reported file/line diagnostics to fix whitespace. Open `diagnosticsPath`
only for checker failures; keep its raw output outside the vault.

For receipt retention or an interrupted finish before a receipt exists, read
[completion recovery](references/completion-recovery.md).
