---
name: vault-steward
description: "Commit declared playground-vault notes onto canonical main through the Vault Steward CLI: begin, preview, apply, inspect, recover."
---

# Vault Steward CLI

The Vault Steward CLI is the commit procedure; the Vault Steward role (the Cast
Role that maintains canonical notes) decides what to write and invokes it.
Start in the directory containing this `SKILL.md`; go up twice (`../..`) to
the installed plugin root. The CLI owns its contract: read
`<plugin-root>/bin/vault-steward --discover --json` first, and
`--discover-command <identity> --json` for the possible outcomes of one
command. Always pass `--json` and act on `result.nextAction`, `handoff`, and
`repairAction`. The vault comes from
`~/.config/my-second-brain-playground/vault.json` or `--vault`; when
configuration is missing or invalid, read
[configuration](../vault-note-commits/references/configuration.md).

## Journey

1. `begin --path <relative-path>...` creates a detached candidate worktree.
   Edit only the admitted paths there; keep the canonical checkout unchanged.
   `--preview` reports the plan and creates nothing.
2. `finish --preview --worktree <path> --message <subject>` validates the
   candidate, creates its one commit, and records a plan bound to the observed
   `main` revision. Read `data.previewId` and `data.plan`.
3. `finish --apply --preview-id <id> --worktree <path>` integrates under the
   lock. A stale, consumed, or superseded preview refuses before any effect;
   run the preview again and apply the new id. Completion is recorded in a
   receipt; remote sync is a separate workflow.
4. After a lost response or a crash, run `inspect --worktree <path>` and follow
   `data.recovery.nextCommand`. `recover` records completion only when Git
   proves `main` already contains the candidate's own commit; it never replays
   the fast-forward. Start no second candidate to learn whether the first one
   completed.

## Reading a result

- Match on `result.causeCode`, never on `message` text: it carries the
  product cause (for example `DOMAIN_PREVIEW_STALE`,
  `DOMAIN_GUARD_INCOMPATIBLE`, `TRANSIENT_INTEGRATION_BUSY`), and
  `--discover-command` lists every cause a command can emit with its exit,
  state, retry policy, and next actions.
- `data.guard` and `data.warnings` report the vault's Git gate; warnings never
  block. `DOMAIN_GUARD_INCOMPATIBLE` needs `bun run guard:install` in the vault.
  Codes and meanings: [guardrails](../vault-note-commits/references/guardrails.md).
- `bun run guard:audit --json`, run directly in the vault, is the on-demand
  route for a full guard report outside any `begin`/`finish`/`inspect`
  transaction: the accepted replacement for the retiring session-start (F3)
  guard line. Command and finding IDs: `docs/agents/git-guardrails.md` in the
  vault.
- Exit 75 with `retryDelayMilliseconds` is the only retry; partial and unknown
  states hand off through `inspect`.
- `diagnostics.file` names the private per-run JSONL under
  `~/.local/state/vault-steward/diagnostics/`; diagnostic loss never changes
  the result.

The alias `vault-note-commits` keeps the single-step `finish` and the
`schemaVersion: 1` envelope through the migration period; both front doors
share one run store, so a candidate begun by either finishes through the other.
