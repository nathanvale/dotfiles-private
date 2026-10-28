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
so pyenv and Homebrew fallbacks continue to work. No other Node manager is
configured: fnm is retired (ADR 0012), and Mise reads project `.nvmrc` and
`.node-version` files itself.

The repository is configured and hermetically tested for installation and
activation. That is not evidence that this machine is already installed or
activated. Live launch-context and clean no-cache Mac qualification remain
separate. Git remains blocked and exact reconstruction remains unqualified.

`../husky/toolchain-guard.sh` runs after the bootstrap in Husky's init. For a
checkout with exact pins (`engines.node` or `.nvmrc`; `packageManager`
`pnpm@x.y.z`) it refuses (exit 1, cause and repair on stderr) before any hook
effect unless the pinned tools are what will run. Mise 2026.9.10 can fall back
to the ambient PATH with auto-install off, and an ambient pnpm (Homebrew's 12)
forwards to the project's pin inside a project, so its reported version proves
nothing about the executable that ran. The guard therefore binds each tool:

- Node must be the Mise shim, report the pin, and run from the Mise install.
  `mise trust --show` (run through the executable the shim chain ends at,
  with helpers taken from the system directories) must not report untrusted,
  and must positively name a checkout that carries a Mise config. Mise's path
  trust keeps accepting a trusted file after it is edited (real 2026.9.10), so
  every TOML config Mise loads for the checkout, ancestors included, must also
  have its exact sha256 recorded by `bin/dotfiles/mise-config-review <file>`
  after it is read; a changed file needs a new review. Reviews are by content,
  so the same reviewed file is accepted in every linked worktree.
- A Node version file (`.nvmrc`, `.node-version`) pins Node even without a
  `package.json`; it still needs the applied Mise state.
- pnpm must be `$MISE_INSTALLS_DIR/pnpm/<pin>/pnpm`, a regular executable
  that reports the pin with manager switching off. The hook exports that
  setting, puts the file's directory behind Husky's `node_modules/.bin`, and
  refuses if `pnpm` resolves to anything else (a repo-local shadow, an
  ambient pnpm). It never downloads.

A checkout can instead opt into the direct route with a regular file
`.husky/direct-pins`. Husky's init then sources `../husky/direct-pins.sh`
before the Mise bootstrap and returns: it reads the exact `engines.node`,
`.nvmrc` and `packageManager` pins with `plutil`, requires the regular
executables under `~/.local/share/mise/installs` to report them, exports
`HUSKY_PINNED_NODE` and `HUSKY_PINNED_PNPM` with manager switching and
Corepack network off, and never runs Mise. A direct-route hook body calls
pnpm by that absolute path; a bare `pnpm` is unsupported there. Contract:
`bin/test/husky-direct-pins-test.sh`.

Both routes refuse a `node`, `pnpm`, `pnpx`, `npm`, `npx` or `corepack` in
the `node_modules/.bin` of any package directory Git lists (tracked or
untracked, not ignored) or of any directory above one, up to `/`, inside the
checkout or not. Husky puts the root's first, lint-staged runs each workspace
package's tasks with that directory's and every ancestor's ahead of PATH, and
pnpm bin wrappers run a sibling `node` or else the first on PATH. Not covered:
a dependency's own nested `node_modules/.pnpm/**/node_modules/.bin`, which
only that dependency's child processes reach.

In a checkout that can pin tools, a missing or linked Mise bootstrap or guard
is a partial installation and refuses rather than running ambient tools.

Provision a pin explicitly, once per version: `bin/dotfiles/pnpm-provision
<x.y.z>` (Mise install from a private empty configuration, then a version
check). The guard never trusts config: a checkout's `mise.toml` needs an
explicit `mise trust <exact reviewed file>` first.

Inspect the declared change without modifying the machine or repository:

```sh
bin/dotfiles/toolchain update --preview --json
bin/dotfiles/toolchain update --apply --json
```
