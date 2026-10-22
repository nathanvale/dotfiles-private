# Proof

Proof 0.2.2 provides Biome and TypeScript quality hooks for Claude Code and
Codex. Each hook runs only in repositories carrying its tool locally.

Fallow uses its upstream-managed hooks instead. Install those with the pinned
Fallow CLI's `hooks install --target agent --agent claude --user` and
`hooks install --target agent --agent codex --user` commands. Preview with
`--dry-run`, inspect with `hooks status --format json`, and verify activation
in a fresh harness session. Follow the repository's Fallow comparison-base policy.
Native Fallow hooks run before commit or push, not on Stop. Proof no longer
registers its custom Fallow handlers; their source remains for historical tests.

Keep version identity aligned across both plugin manifests, `package.json`,
and both personal marketplace entries.

## Plugin root

Run source commands from the plugin root: the directory containing this
`README.md`, `.claude-plugin/`, `.codex-plugin/`, and `hooks/`. In this
checkout, that is `config/agents/plugins/proof/`.

## What each hook does

- `biome-ci`: PostToolUse lints edited files and informs. Stop lints the changed
  file delta and blocks on failure.
- `typecheck-ci`: Stop runs whole-program TypeScript checking. Diagnostics in
  changed files block. Untouched-file diagnostics remain context, except global
  errors when a TypeScript configuration changed.

Codex apply_patch payloads carry no file_path, so Biome's PostToolUse handler
cannot identify those files. Its Stop handler checks them.

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
