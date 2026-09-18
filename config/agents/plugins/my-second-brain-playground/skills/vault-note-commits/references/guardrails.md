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

`begin` and `finish` refuse `GUARD_INCOMPATIBLE` when the installed hook
denies a ref the helper must write. `begin` refuses before any effect (no
worktree is created: `changedState` `none`, `sideEffects` `[]`, retry
`begin` after the repair). `finish` refuses after the manifest read and
before the checker, the candidate commit, and the integration lock:
`changedState` is `none`, `sideEffects` is
`["candidate-worktree-preserved"]`, and `retrySafe` is `true`. Have the hook
repaired in the vault (`bun run guard:install`), then rerun the same command.

## Rebase refusals restore the candidate (A8)

When a candidate is rebased onto a moved `main` and a check on the rebased
commit then refuses (`CHECK_FAILED`, `FORMAT_FAILED`, or a rebased path-set
mismatch), the helper restores the candidate's own commit before refusing
(`git checkout --detach <commit>` moves the candidate's `HEAD`, index, and
working tree; it writes no guarded ref, so `refs/heads/main` and
`refs/vault-note-commits/*` are untouched and the gate never sees it). The
candidate is unchanged; once `main` is fixed, the same `finish`
(or a new `finish --preview` for the Vault Steward CLI) rebases again and
integrates. 0.12.0 left the rebased commit behind, which every later
`finish` refused as `CANDIDATE_HISTORY_INVALID`.

## One state home

Candidates, receipts, and previews live under
`${XDG_STATE_HOME:-~/.local/state}/my-second-brain/vault-note-commits/`.
Foreign-worktree classification (this helper's `FOREIGN_WORKTREE_PRESENT`
and the vault audit's `foreign-worktree`) is relative to the caller's state
home, so run every agent and the audit with one state home; a candidate
created under another state home is reported as foreign. The CLI resolves
`vault.json` under `${XDG_CONFIG_HOME:-~/.config}`, while the session-start
guard line reads `~/.config` only (it mirrors the recovery hook's owner), so
set the config under `~/.config` when `XDG_CONFIG_HOME` points elsewhere.

## Known limitation: stale-lock reclaim

Stale-lock reclaim uses a sibling, empty `mkdir`-exclusive reclaim mutex
before it re-judges and renames a dead lock, so healthy protocol-following
contenders cannot reclaim a lock another contender has already published.
The mutex closes that pathname race; `main` still moves only by a proven
`git merge --ff-only`. The residual is a mutex holder killed after creating
the mutex and before removing it: after 10 seconds it is stale and two new
contenders can race to remove it, so a kernel-backed identity lock remains a
future hardening option.

## Completion recovery

A `finish` that fast-forwarded `main` but lost its receipt is recognised on
retry: when the candidate is clean, its own HEAD reflog shows it produced
the commit (`commit` on top of the base, or a rebase pick performed there), and Git proves `main`
contains that commit with exactly the admitted paths, the retry records the
completion and returns `INTEGRATED` with `sideEffects`
`["completion-reference-written", "completion-receipt-written",
"candidate-worktree-removed"]` (no `canonical-main-fast-forwarded`: that
effect belongs to the crashed run). A candidate HEAD merely moved onto a
commit of `main` is refused with the usual codes. See
[completion recovery](completion-recovery.md).
