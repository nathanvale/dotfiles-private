# Dotfiles Coding Standards

Code and test rules: [shared coding standards](docs/agents/coding-standards.md).

## Before editing

- Accepted-behavior change: reconcile with the relevant [ADRs](docs/adr/).
- Setup or profile work: run `./setup.sh --help` and
  `./verify_install.sh --help`, then read the closest subsystem owner.

## Packages

- Edit `config/brew/profile-requirements.tsv` for profile-owned package
  requirements; `config/brew/Brewfile` is the derived Homebrew entrypoint.
- Set `dotfiles_profile=desktop` (or `server`), then apply and verify:

  ```sh
  HOMEBREW_DOTFILES_PROFILE="$dotfiles_profile" brew bundle --file=config/brew/Brewfile
  HOMEBREW_DOTFILES_PROFILE="$dotfiles_profile" brew bundle check --file=config/brew/Brewfile
  ```

## Proof

- Behavior change: pass the smallest covering check before broader checks.
- Setup: complete only when every affected profile passes available checks;
  list unavailable machine-specific checks.
- Workspace package work: run `bun run typecheck`, `bun run lint`, and
  `bun run test` there. Root `bun run check` is the complete gate.
- Code change: end the turn with all three checks green before handoff,
  review, or commit; repair a red result before proceeding:

  ```sh
  bun run --silent quality:fallow --changed-since <task-start-commit>
  bun run biome:check
  bun run typecheck
  ```

  Use the immutable task-start commit. Read [Fallow](docs/agents/fallow.md)
  before running or diagnosing the gate.
