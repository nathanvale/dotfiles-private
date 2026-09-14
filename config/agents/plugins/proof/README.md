# Proof

Proof is a private dotfiles plugin that ships three self-gating, dependency-free
quality hooks for Claude Code and Codex: `biome-ci`, `fallow-ci`, and
`typecheck-ci`. Each hook fires only in a repository that already carries the
matching tool locally, so the plugin can be enabled globally without breaking
a repository that has no Biome, Fallow, or TypeScript installed.

The package identity is `proof` at version `0.1.0`. Keep that identity and
version aligned across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
and the `personal` marketplace entry in
`config/agents/plugins/.claude-plugin/marketplace.json`; a version bump touches
all three.

## Live proof

On 2026-09-12, fresh sessions proved the plugin live in both harnesses:
Claude Code with Sonnet 5 via Foundry and Codex with gpt-6-astra. Adding an
unused export blocked `Stop` with the plugin's `fallow-ci` envelope. The
plugin's `biome-ci` fired alongside the old repository Biome hook before those
hooks were removed. Codex recorded five trusted hook entries,
`proof@personal:hooks.json:*`, in `~/.codex/config.toml`. This change removes
the superseded repository Biome hooks.

## Plugin root

Run source commands from the plugin root: the directory containing this
`README.md`, `.claude-plugin/`, `.codex-plugin/`, and `hooks/`. In this
checkout, that is `config/agents/plugins/proof/`.

## What each hook does

- `biome-ci`: `PostToolUse` on `Write|Edit|MultiEdit` lints the files an agent
  just edited and only informs (the write already happened, so it cannot
  block). `Stop` lints the full changed-file delta and blocks with exit 2.
- `fallow-ci`: `PreToolUse` on `Bash` runs `fallow audit` before a `git commit`
  or `git push` and blocks only on a `fail` verdict for introduced findings,
  the official Fallow gate pattern. `Stop` runs the same audit against the
  working-tree delta.
- `typecheck-ci`: `Stop` only. `tsc` is whole-program, so gating it on every
  edit would produce false errors from mid-edit, multi-file states. Blocks
  only on diagnostics inside the changed-file set; an error in an untouched
  file surfaces as `suppressedCount` context, never a block, unless it is a
  global (file-less) error and a `tsconfig*.json` itself changed.

### Known limits

- Codex's `apply_patch` tool input carries no `file_path`, so `biome-ci`'s
  `PostToolUse` finds no edited file to lint there and is a silent no-op on
  Codex; only its `Stop` path lints Codex-driven edits.
- Codex's acceptance of empty stdout on a passing `PreToolUse` and
  `PostToolUse` exit 0 is unverified until the first Codex install; only the
  documented `Stop` contract (JSON required on exit 0) has a cited source.

### Self-disable marker

Every hook resolves the repository root, then requires both a repo-local
`node_modules/.bin/<tool>` binary and a marker config file (`biome.json` or
`biome.jsonc` for Biome, `.fallowrc.json` for Fallow, `tsconfig.json` for
TypeScript). Missing either one exits 0 silently: no error, no block, no
stderr. This is what lets the plugin stay enabled across every repository
Nathan works in.

### Dependency-free constraint

The plugin's `package.json` carries no `dependencies` key, and its hook
sources import only `node:*` modules and Bun globals. Claude Code and Codex
run plugin hook sources with `bun run "<script>"` directly from the installed
plugin cache, which has no `node_modules` of its own. A hook that needed a
real dependency would need a build step (bundling it in, or vendoring), which
is why the constraint is enforced by a test, not just a convention.

## Source checks

From the plugin root:

```sh
bun run lint
bun run test
bun run typecheck
jq empty .claude-plugin/plugin.json .codex-plugin/plugin.json \
  ../.claude-plugin/marketplace.json
claude plugin validate --strict .
```

## Install from the inline marketplace

Set the paths to the reviewed dotfiles checkout. On a normal dotfiles
install, the marketplace root is `~/.config/agents/plugins`:

```sh
DOTFILES_ROOT="${DOTFILES_ROOT:-$HOME/code/dotfiles}"
MARKETPLACE_ROOT="$DOTFILES_ROOT/config/agents/plugins"
PLUGIN_ROOT="$MARKETPLACE_ROOT/proof"
```

Claude Code, user scope:

```sh
claude plugin validate --strict "$PLUGIN_ROOT"
claude plugin marketplace list --json
# Add only when `personal` is absent:
claude plugin marketplace add "$MARKETPLACE_ROOT"
claude plugin install proof@personal --scope user
claude plugin list --json
claude plugin details proof@personal
```

When `personal` is already registered to this checkout, skip `marketplace
add`. Refresh it with `claude plugin marketplace update personal` before
installing or updating `proof`. Restart Claude Code before the new hooks take
effect after an install or update.

Codex, user scope:

```sh
codex plugin add proof@personal --json
```

To refresh the installed source after a hook edit, remove and re-add rather
than relying on an upgrade command that does not refresh a local marketplace
source:

```sh
codex plugin remove proof@personal --json
codex plugin add proof@personal --json
```

### Codex `trusted_hash` caveat

Codex hashes each configured hook command and stores the result as a
`trusted_hash` in `[hooks.state.*]` in `config.toml`. Editing any hook
source changes that hash, so the hook becomes `Modified` and stops running
silently until it is trusted again. There is no equivalent gate in Claude
Code: a hook edit takes effect there immediately. Every source edit to this
plugin's hooks needs a Codex re-approval step, or the affected hook silently
stops firing on Codex while continuing to run on Claude Code.

## Rollback

This is the rollback for the first Proof release, when no earlier dotfiles
revision contains a Proof package. Remove only the installed `proof` plugin,
and leave the inline `personal` marketplace registration in place for other
plugins:

```sh
# Claude Code
claude plugin uninstall proof@personal --scope user -y

# Codex
codex plugin remove proof@personal --json
```

Run each command only when that harness lists `proof` as installed. If the
plugin was never installed, there is nothing to remove. These commands do not
remove the marketplace or any other installed plugin. Use `claude plugin
disable proof@personal` when the package should remain installed but inactive.
