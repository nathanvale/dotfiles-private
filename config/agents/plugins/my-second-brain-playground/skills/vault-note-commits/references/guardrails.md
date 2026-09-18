# Guardrails

The vault installs a `reference-transaction` Git hook that allows writes to
`refs/heads/main` and `refs/vault-note-commits/*` and denies every other
branch creation. The helper observes that gate on every `begin` and `finish`;
it never installs, edits, or removes it. Install, audit, and uninstall belong
to the vault (`bun run guard:install`, `bun run guard:audit --json`).

## Additive fields

`schemaVersion` stays `1`. Optional fields are additive: a consumer that reads
`code`, `changedState`, `sideEffects`, `retrySafe`, and `nextAction` keeps
working, and additive fields never bump `schemaVersion`.

- `guard`: `{installed, current, selfTest, hookPath, branches, worktrees}`.
  Present on `begin` success and on every `finish` result that ran the
  self-test. `current` is `null` when the vault has no
  `scripts/git-hooks/reference-transaction` to compare against. `selfTest` is
  `pass`, `incompatible`, `probe-allowed`, `error`, `skipped` (no
  `refs/heads/main` to test against), or `missing`.
- `warnings`: present only when non-empty, an array of codes. Human mode
  prints each as `warning: <CODE> <detail>` on stderr; `--json` keeps stderr
  empty.

The receipt short-circuit (`ALREADY_COMPLETED`) is read-only and carries
neither field: retries make no hook spawn.

## Warnings

| Code | Meaning | Action |
| --- | --- | --- |
| `GUARD_MISSING` | No executable hook at the effective hooks path. | Ask for `bun run guard:install` in the vault. |
| `GUARD_STALE` | Installed hook differs from the vault source. | Same. |
| `GUARD_PROBE_ALLOWED` | The hook allowed a branch creation it should deny. | Same; the audit names the cause. |
| `GUARD_SELFTEST_ERROR` | The hook timed out (2 s), failed to start, or exited with an unknown verdict. | Proceeds fail-open; report the detail. |
| `BRANCH_SPRAWL_PRESENT` | Heads other than `main` exist (`guard.branches`). | Report; never delete branches from this helper. |
| `FOREIGN_WORKTREE_PRESENT` | Worktrees outside the vault and its candidates (`guard.worktrees`). | Report. |
| `HOOKS_PATH_OVERRIDE` | `core.hooksPath` is set, so `.git/hooks` is ignored. | Report; the effective path is `guard.hookPath`. |

Warnings never block a finish.

## GUARD_INCOMPATIBLE

`finish` refuses `GUARD_INCOMPATIBLE` when the installed hook denies a ref the
helper must write. It fires after the manifest read and before the checker,
the candidate commit, and the integration lock: `changedState` is `none`,
`sideEffects` is `["candidate-worktree-preserved"]`, and `retrySafe` is
`true`. Have the hook repaired in the vault, then rerun `finish` with the same
worktree.

## Completion recovery

A `finish` that fast-forwarded `main` but lost its receipt is recognised on
retry: when the candidate is clean, its own HEAD reflog shows it produced
the commit (`commit` on top of the base, or `rebase`), and Git proves `main`
contains that commit with exactly the admitted paths, the retry records the
completion and returns `INTEGRATED` with `sideEffects`
`["completion-reference-written", "completion-receipt-written",
"candidate-worktree-removed"]` (no `canonical-main-fast-forwarded`: that
effect belongs to the crashed run). A candidate HEAD merely moved onto a
commit of `main` is refused with the usual codes. See
[completion recovery](completion-recovery.md).
