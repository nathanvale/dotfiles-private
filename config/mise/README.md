# Mise toolchain declaration

`source.toml` is the canonical tracked declaration for Node, Bun, Python, and
the Beads `bd` CLI. Beads uses Mise's GitHub backend with the exact
`github:gastownhall/beads` 1.3.0 source.
npm is deliberately absent as a standalone Mise tool: its expected version is
recorded in `../toolchain/versions.tsv` and verified from the selected Node
installation. Read-only status also requires `mise which npm` to resolve that
Node-sibling executable, which detects stale revisions that still route to a
standalone npm installation. This file is not Mise's auto-discovered global
`config.toml` path.
`bin/dotfiles/toolchain update --apply` copies it into an immutable verified
revision, generates its lock, verifies the Mise-managed subset, then atomically
selects that revision. Apply and recovery isolate every config-sensitive Mise
process from the caller's working directory: they run in a private empty
operation capsule below validated state, use that capsule as
`MISE_CEILING_PATHS`, load only the exact staged or selected
`MISE_GLOBAL_CONFIG_FILE`, and scrub inherited Node, Bun, Python, npm, and
alternate-config selectors. Cleanup owns capsule removal across completion,
failure, handled signals, and stale-lock takeover.

Mise resolves a project-local `mise.toml` above this personal configuration, so
an explicit project runtime continues to win. Beads remains a personal global
CLI unless a project explicitly overrides its Mise source. The configuration also enables
the existing Node and Python idiomatic version files when no project
`mise.toml` is present. Git is intentionally absent: no supported exact Git
owner has been selected or proved.

The source refuses automatic missing-tool installation and system fallback. The
generated global lock lives only in the selected revision.

`bootstrap.sh` is the shared POSIX activation seam. It clears inherited global
configuration plus data, installs, and shims directory redirection; removes empty, relative,
and duplicate PATH entries; accepts only a contained
`~/.dotfiles_state/toolchain/current` link naming a lowercase SHA-256 revision,
and selects that revision's regular readable `config.toml` only when Mise is
available. A valid selection exports the resolved-HOME
`~/.local/share/mise` data, installs, and shims layout plus exactly one
canonical shim entry. Every public toolchain Mise invocation uses that same
explicit directory layout.
Noninteractive, login, and Git-hook launches use the selected Mise shims.
Interactive zsh additionally runs normal `mise activate zsh` after its other
PATH owners. Missing or invalid applied state leaves the Mise variables unset,
so fnm, pyenv, and Homebrew fallbacks continue to work.

The repository is configured and hermetically tested for installation and
activation. That is not evidence that this machine is already installed or
activated. Live launch-context and clean no-cache Mac qualification remain
separate. Git remains blocked and exact reconstruction remains unqualified.

Inspect the declared change without modifying the machine or repository:

```sh
bin/dotfiles/toolchain update --preview --json
bin/dotfiles/toolchain update --apply --json
```
