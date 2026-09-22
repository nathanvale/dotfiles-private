# Dotfiles Repository Instructions

## Scope

- Edit in an isolated worktree on a branch.
- Keep employer identities, internal systems, and work configuration in the employer's private repository.

## Routes

- Moved Codex session or Scratch history register: read [`docs/agents/session-history.md`](docs/agents/session-history.md).
- Before editing, match task against [`docs/agents/README.md`](docs/agents/README.md) and read every matching document.
- Accepted-behavior change: reconcile with [`docs/adr/`](docs/adr/) before editing.
- Domain naming: use [`CONTEXT-MAP.md`](CONTEXT-MAP.md) to select the relevant
  glossary.
- Setup/profile: run `./setup.sh --help`, `./verify_install.sh --help`, then closest subsystem owner.
- Clean macOS VM qualification: read [`docs/agents/tart-vm-qualification.md`](docs/agents/tart-vm-qualification.md).
- Packages: edit `config/brew/profile-requirements.tsv` for profile-owned package requirements; `config/brew/Brewfile` is the derived Homebrew entrypoint. Set `dotfiles_profile=desktop` (or `server`); apply: `HOMEBREW_DOTFILES_PROFILE="$dotfiles_profile" brew bundle --file=config/brew/Brewfile`; verify: `HOMEBREW_DOTFILES_PROFILE="$dotfiles_profile" brew bundle check --file=config/brew/Brewfile`.
- Claude Gates: declare in `config/agents/claude/settings.json`; reserve `config/agents/claude/hooks.json` for `InstructionsLoaded`; Biome, Fallow, and TypeScript quality gates live in the `proof` plugin (`config/agents/plugins/proof/hooks/`).
- Running or diagnosing the `quality:fallow` gate: read [`docs/agents/fallow.md`](docs/agents/fallow.md).
- Working inside a workspace package: run `bun run typecheck`, `bun run lint`, `bun run test` there; root `bun run check` is the complete gate.

## Agent skills

### Issue tracker

Publish repository Specs and Tickets as GitHub Issues in
`nathanvale/dotfiles-private`. Read
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

Use the five canonical Matt Pocock triage roles. Read
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Use the repository's multi-context map and ADR layout. Read
[`docs/agents/domain.md`](docs/agents/domain.md).

## Proof

- Behavior change: smallest covering check must pass before broader checks.
- Setup: complete only when every affected profile passes available checks; list unavailable machine-specific checks.
- Code change: end the turn with `bun run --silent quality:fallow --changed-since <task-start-commit>`, `bun run biome:check`, and `bun run typecheck` green before handoff, review, or commit; repair a red result, never defer it; see `docs/agents/fallow.md` for comparison-base rules.
