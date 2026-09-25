---
status: accepted
---

# Retire fnm; Mise is the only configured Node owner

## Context and Problem

[ADR 0007](0007-apply-mise-toolchains-through-verified-revisions.md) selected
Mise as the owner of exact Node, Bun, Python, and Beads defaults and kept fnm,
pyenv, and Homebrew as installed fallbacks "until replacement behavior is
independently qualified", to be retired "only through a later explicit and
destructive cleanup decision backed by live evidence". This record is that
later decision for fnm only. It changes configuration; it does not delete
machine state.

Live read-only probes on 25 September 2026 (dotfiles `93981e62`, Mise
2026.9.10, fnm 1.39.0) found that Mise already wins `node`, `npm`, and `npx`
in all four zsh startup modes, in the Claude Code Bash lane, and in the POSIX
Git-hook lane, with the fnm bootstrap still sourced first and then shadowed.
In the Git-hook lane that win depended on the fnm bootstrap's side effect:
its first action prepended `/opt/homebrew/bin` and `/usr/local/bin`, which is
what let the Mise bootstrap find `mise` under a launchd PATH.
fnm's interactive `--use-on-cd` hook was already gated off whenever Mise was
active. fnm's version-file support duplicated Mise's own
`idiomatic_version_file_enable_tools`. The fnm rows in `verify_install.sh`
were red on the desktop because fnm never received Node 26.9.0; only Mise did.
Every Node version bump therefore had to be made twice, in
`config/node/version` for fnm and in `config/mise/source.toml` for Mise.

Two global CLIs, `agent-browser` and `playwright-cli`, resolved only from fnm's
default Node installation. Their destination is outside this decision.

## Decision Drivers

- One exact desired version and one selected owner for Node.
- No double maintenance on a Node bump.
- Shell startup, Git hooks, setup, and verification agree on the owner.
- Machine data and any still-needed CLI stay recoverable by explicit path.
- Preserve every other 0007 fallback until its own qualification.

## Considered Options

- Keep fnm configured as a fallback beside Mise.
- Retire fnm from configuration and keep the installed copy on disk.
- Retire fnm from configuration and delete the installed copy and formula.

## Decision

Retire fnm from active configuration. Mise is the only configured Node owner.

- `setup.sh` Phase 4 installs no fnm and runs no `fnm install` or
  `fnm default`; Node arrives through `bin/dotfiles/toolchain update --apply`.
- `verify_install.sh` checks Node, npm, and npx by resolving each through the
  shared POSIX Mise bootstrap in a fresh environment and requiring a path under
  the selected Mise layout; the fnm rows and the separate Node declaration file
  are gone.
- `config/node/version` is deleted. `config/mise/source.toml` is the single
  Node declaration, with `config/toolchain/versions.tsv` as its manifest.
- `.zshenv`, `.zshrc`, and `config/husky/init.sh` no longer source
  `config/fnm/bootstrap.sh`, which is deleted; `.zshrc` no longer prepends the
  fnm default alias, installs the `--use-on-cd` hook, or wraps its chpwd hook.
  `config/husky/init.sh` keeps the Homebrew prefix PATH guard the fnm
  bootstrap used to supply, so Mise stays selectable under a launchd PATH.
- `bin/tmux/worktree-ai.sh` no longer runs `fnm use --install-if-missing`
  for a new worktree; Mise reads `.nvmrc` and `.node-version` itself.
- `config/toolchain/versions.tsv` may no longer declare `fnm` as a selected
  owner: `bin/dotfiles/toolchain` rejects it as `manifest_invalid`. Only the
  observer that classifies an already-resolved path keeps the `fnm` label.
- `config/brew/Brewfile` no longer declares `fnm`.
- `bin/dotfiles/toolchain` keeps its fnm owner detection as an observer: when a
  path still resolves under `~/.local/share/fnm`, status names the owner `fnm`
  instead of `unknown`, which is the diagnostic that proves this retirement on
  a live host.

Machine state is preserved: `~/.local/share/fnm`, `~/.local/state/fnm_multishells`,
and the Homebrew `fnm` formula stay installed as an inert recovery copy.
`brew bundle` stops managing the formula but does not remove it. Any CLI that
lived only under fnm's default Node remains reachable by explicit path at
`~/.local/share/fnm/aliases/default/bin/<name>`; where such a CLI belongs next
is a separate decision.

Corepack is not carried across. Node 26.9.0 as installed by Mise does not
ship a `corepack` executable, so the former `fnm install --corepack-enabled`
guarantee has no Mise equivalent without declaring a new tool, which this
decision does not do. pnpm and yarn remain Homebrew-owned.

## Consequences

- Positive: one Node declaration; a bump is one edit plus one apply.
- Positive: setup, verification, startup, and hooks name the same owner.
- Positive: startup no longer launches fnm, so the `--use-on-cd` failure
  wrapper and its test lane are deleted rather than maintained.
- Negative: `corepack` is no longer on PATH in a fresh shell.
- Negative: `agent-browser` and `playwright-cli` leave PATH until their owner
  is decided; both stay runnable by explicit path.
- Neutral: 1.6 GB of fnm Node installations stay on disk until a separate
  destructive cleanup decision.
- Neutral: pyenv and Homebrew fallbacks are unchanged; ADR 0007 remains
  accepted, with its fnm fallback clause narrowed by this record.

## Options and Tradeoffs

### Keep fnm configured

- Good: no change; `corepack` and the two browser CLIs stay on PATH.
- Bad: two Node declarations, red verifier rows on every bump, and a runtime
  manager that startup sources only to shadow.

### Retire from configuration, keep the disk copy

- Good: one owner; every retired path is a reversible source edit; recovery is
  `git revert` plus the untouched installation.
- Bad: two CLIs and `corepack` leave PATH until re-homed.

### Retire and delete the installation

- Good: reclaims 1.6 GB and removes a stale formula.
- Bad: destructive, and it removes the only current copy of two CLIs before
  their owner is decided.

## Confirmation

- `bin/test/bun-core-install-test.sh`: Phase 4 launches no fnm process while a
  recording fnm stub is on PATH, and the Brewfile no longer declares `fnm`.
- `bin/test/toolchain-bootstrap-test.sh`: none of the four zsh startup modes
  nor the Husky init launches the recording fnm fake, with every tracked
  `config/*/bootstrap.sh` mirrored into the fixture HOME so a reintroduced
  source line would run; and the Husky init under a bare launchd PATH
  (`/usr/bin:/bin`) still selects the applied Mise state.
- `bin/test/toolchain-status-test.sh`: a manifest row that selects `fnm` as
  an owner is refused as `manifest_invalid`.
- `bin/test/setup-state-recovery-test.sh`: resumed Phase 4 reaches toolchain
  apply without an fnm stub.
- `verify_install.sh` on a host with an applied revision passes "Node (Mise)",
  "npm (Mise)", and "npx (Mise)".
- Revisit if a supported launch mode resolves `node` outside the selected Mise
  layout, or when the clean no-cache Mac qualification named in ADR 0007 runs.

## Authority

Nathan, Decision 6 of the shell test audit, relayed 25 September 2026 11:54
AEST: Mise is the single configured Node owner; retire fnm from setup and
shell configuration; preserve machine data. Browser CLI destination was
withdrawn from this scope at 11:56 and remains Nathan's separate decision.

## References

- [ADR 0007](0007-apply-mise-toolchains-through-verified-revisions.md).
- `config/mise/source.toml`, `config/toolchain/versions.tsv`.
- [Mise idiomatic version files](https://mise.jdx.dev/configuration.html#idiomatic-version-files).
- Decision 6, relayed 25 September 2026 (shell test audit ledger).
