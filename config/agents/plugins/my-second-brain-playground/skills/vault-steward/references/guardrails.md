# Guardrails

The vault installs a `reference-transaction` Git hook that allows writes to
`refs/heads/main` and `refs/vault-note-commits/*` and denies every other
branch creation. The Vault Steward CLI observes that gate on every `begin`,
`finish`, `inspect`, and `recover`; it never installs, edits, or removes it.
Install, audit, and uninstall belong to the vault (`bun run guard:install`,
`bun run guard:audit --json`).

## Guard fields in `data`

Every success envelope that ran the self-test carries two fields in
`result.data`:

- `guard`: `{installed, executable, hookPath, current, selfTest,
  hooksPathOverride, branches, worktrees}`. `current` is `null` when the vault
  has no `scripts/git-hooks/reference-transaction` to compare against.
  `selfTest` is `pass`, `incompatible`, `probe-allowed`, `error`, `skipped`
  (no `refs/heads/main` to test against), or `missing`.
- `warnings`: an array of `{code, detail}`, empty when there is nothing to
  report. Human mode prints each as `warning: <CODE> <detail>` on stderr;
  `--json` keeps stderr empty.

The receipt short-circuit (`SUCCESS_UNCHANGED` with `data.completion`) is
read-only and carries neither field: retries make no hook spawn. `inspect`
reports `guard` and `warnings` without ever refusing.

## Warnings

| Code | Meaning | Action |
| --- | --- | --- |
| `GUARD_MISSING` | No executable hook at the effective hooks path. | Ask for `bun run guard:install` in the vault. |
| `GUARD_STALE` | Installed hook differs from the vault source. | Same. |
| `GUARD_PROBE_ALLOWED` | The hook allowed a branch creation it should deny. | Same; the audit names the cause. |
| `GUARD_SELFTEST_ERROR` | The hook timed out (2 s), failed to start, or exited with an unknown verdict. | Proceeds fail-open; report the detail. |
| `BRANCH_SPRAWL_PRESENT` | Heads other than `main` exist (`guard.branches`). | Report; never delete branches from this CLI. |
| `FOREIGN_WORKTREE_PRESENT` | Worktrees outside the vault and its candidates (`guard.worktrees`). | Report. |
| `HOOKS_PATH_OVERRIDE` | `core.hooksPath` is set, so `.git/hooks` is ignored. | Report; the effective path is `guard.hookPath`. |

Warnings never block a command.

## DOMAIN_GUARD_INCOMPATIBLE

`begin`, `finish --preview`, `finish --apply`, and `recover` refuse
`DOMAIN_GUARD_INCOMPATIBLE` (exit 3, `transactionState` `unchanged`) when the
installed hook denies a ref the CLI must write. `begin` refuses before any
effect (no worktree is created). `finish --preview` refuses before the
candidate commit and the preview record; `finish --apply` and `recover`
refuse before the integration lock. The message names the denied ref. Have
the hook repaired in the vault (`bun run guard:install`), then rerun the same
command; a preview stays valid across the repair.

## Rebase refusals restore the candidate (A8)

When `finish --apply` rebases a candidate onto a moved `main` and a check on
the rebased commit then refuses (`DOMAIN_REBASED_CHECK_FAILED`,
`DOMAIN_FORMAT_FAILED`, or `DOMAIN_CANDIDATE_INVALID` for a rebased path
set that differs from the admitted set), the CLI restores the candidate's own
commit before refusing (`git checkout --detach <commit>` moves the candidate's
`HEAD`, index, and working tree; it writes no guarded ref, so
`refs/heads/main` and `refs/vault-note-commits/*` are untouched and the gate
never sees it). The candidate is unchanged and `inspect` reports
`not-started`; once `main` is fixed, a new `finish --preview` plans the
rebase again and the apply integrates.

## One state home

Candidates, receipts, and previews live under
`${XDG_STATE_HOME:-~/.local/state}/my-second-brain/vault-note-commits/`.
Foreign-worktree classification (this CLI's `FOREIGN_WORKTREE_PRESENT` and
the vault audit's `foreign-worktree`) is relative to the caller's state home,
so run every agent and the audit with one state home; a candidate created
under another state home is reported as foreign. The CLI resolves
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

Receipts live under
`${XDG_STATE_HOME:-~/.local/state}/my-second-brain/vault-note-commits/receipts/`
(mode `0600` in a `0700` directory) and a local `refs/vault-note-commits/<runId>`
reference anchors each completion; keep those local references out of remote
publication. After a lost response or a crash, run `inspect --worktree <path>`
and follow `data.recovery.nextCommand`. `recover` records completion only
when the candidate is clean, its own HEAD reflog shows it produced its commit
(a `commit` on top of the base, or a rebase pick performed there), and Git
proves `main` contains that commit with exactly the admitted paths; it never
replays the fast-forward. A candidate HEAD merely moved onto a commit of
`main` (for example `git checkout --detach main`) is never completion
evidence: `recover` hands off to a human and `finish --preview` refuses.
Nathan owns retention: keep a receipt and its matching local reference
together while retries may occur.
