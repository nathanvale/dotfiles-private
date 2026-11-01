# Monash

Monash is a private dotfiles plugin and the broad home for Nathan's Monash
skills and tools. `monash-foundry` is its first skill; future Monash skills
can live beside it under `skills/`.

The package identity is `monash` at version `0.1.0`. Keep that identity and
version aligned in both plugin manifests and the `personal` marketplace entry.
The package is source-owned by the inline dotfiles marketplace. Installing the
plugin exposes the skill; it does not run the Foundry launcher installer.

## Plugin root

Run source commands from the plugin root: the directory containing this
`README.md`, `.claude-plugin/`, `.codex-plugin/`, `skills/`, and `scripts/`.
In this checkout, that is `config/agents/plugins/monash/`.

The Foundry implementation payload lives at `scripts/foundry/`. Its installed
CLI names are `foundry`, `monash-foundry`, and `monash`; read
[`scripts/foundry/README.md`](scripts/foundry/README.md) for the launcher
contract and [`skills/monash-foundry/SKILL.md`](skills/monash-foundry/SKILL.md)
for the agent-facing workflow.

Runtime placement comes from the sealed `host_profiles` registry in
`scripts/foundry/config.json`. Outside Herdr, `foundry --host PROFILE_ID`
attaches the selected profile's dedicated Herdr session; its declared `local`
or `ssh` transport controls placement. The current `mini` profile is the
initial SSH profile. `monash launch` selects the host profile, model, native
agent, and working directory.

## Source checks and disposable discovery

From the plugin root:

```sh
jq empty .claude-plugin/plugin.json .codex-plugin/plugin.json \
  ../.claude-plugin/marketplace.json
claude plugin validate --strict .
claude plugin validate --json ../.claude-plugin/marketplace.json
PYTHONDONTWRITEBYTECODE=1 \
  python3 -m unittest discover -s scripts/foundry -p 'test_*.py' -v
```

The Harnesses can inspect this checkout without a live registration. Claude
loads the package for one command with `--plugin-dir`:

```sh
claude --plugin-dir "$PWD" plugin details monash
claude --plugin-dir "$PWD" plugin list --json
```

Codex discovery must use a disposable `CODEX_HOME`; the commands below write
only to the temporary Harness state and install no live plugin:

```sh
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/monash-codex-discovery.XXXXXX")"
CODEX_HOME="$probe_dir" codex plugin marketplace add \
  "$(cd .. && pwd)" --json
CODEX_HOME="$probe_dir" codex plugin list --available --json \
  --marketplace personal
CODEX_HOME="$probe_dir" codex plugin add monash@personal --json
CODEX_HOME="$probe_dir" codex plugin list --json --marketplace personal
```

Remove the exact temporary directory after inspection. Do not point these
commands at the live Codex home.

The repository marketplace currently has an unrelated strict-validation
warning: the `my-second-brain-playground` entry declares `0.9.5`, while its
Claude manifest declares `0.11.0`. Do not repair that entry in the Monash
package change. The live Codex configuration also has a stale
`my-second-brain-dev` local marketplace whose root has no supported manifest;
the disposable discovery above deliberately avoids that registration.

## Install from the inline marketplace

Set the paths to the reviewed dotfiles checkout. On a normal dotfiles install,
the marketplace root is `~/.config/agents/plugins`:

```sh
DOTFILES_ROOT="${DOTFILES_ROOT:-$HOME/code/dotfiles}"
MARKETPLACE_ROOT="$DOTFILES_ROOT/config/agents/plugins"
PLUGIN_ROOT="$MARKETPLACE_ROOT/monash"
```

Claude Code, user scope:

```sh
claude plugin validate --strict "$PLUGIN_ROOT"
claude plugin marketplace list --json
# Add only when `personal` is absent:
claude plugin marketplace add "$MARKETPLACE_ROOT"
claude plugin install monash@personal --scope user
claude plugin list --json
claude plugin details monash@personal
```

When `personal` is already registered to this checkout, skip `marketplace
add`. Refresh it with `claude plugin marketplace update personal` before
installing or updating `monash`. Restart Claude Code before invoking the
skill after an install or update.

Codex, user scope:

Codex discovers its default personal marketplace implicitly from
`~/.agents/plugins/marketplace.json`. Its plugin sources live under
`~/plugins/`; do not register the dotfiles marketplace with `codex plugin
marketplace add`. On the first install, use Codex's plugin-creator command to
append the required marketplace entry, then point the personal plugin source
at this reviewed checkout:

```sh
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
PLUGIN_CREATOR="$CODEX_ROOT/skills/.system/plugin-creator/scripts/create_basic_plugin.py"
MARKETPLACE_READER="$CODEX_ROOT/skills/.system/plugin-creator/scripts/read_marketplace_name.py"
PERSONAL_MARKETPLACE="$HOME/.agents/plugins/marketplace.json"
PERSONAL_PLUGIN="$HOME/plugins/monash"
SCAFFOLD_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/monash/plugin-creator"

# Run once when PERSONAL_MARKETPLACE has no `monash` entry. The generated
# scaffold stays in private runtime state; the marketplace entry addresses
# PERSONAL_PLUGIN.
python3 "$PLUGIN_CREATOR" monash \
  --path "$SCAFFOLD_STATE" \
  --with-marketplace \
  --category "Developer Tools"

# Refuse and reconcile first if PERSONAL_PLUGIN already exists at another
# target. Otherwise create the source address expected by the marketplace.
mkdir -p "$HOME/plugins"
ln -s "$PLUGIN_ROOT" "$PERSONAL_PLUGIN"

test "$(python3 "$MARKETPLACE_READER" \
  --marketplace-path "$PERSONAL_MARKETPLACE")" = personal
codex plugin add monash@personal --json
codex plugin list --json --marketplace personal
```

Do not rerun the plugin-creator command when the `monash` entry already exists.
On later source updates, verify that `PERSONAL_PLUGIN` is still the exact link
to `PLUGIN_ROOT`, then use the remove and add sequence below. The plugin install
is separate from the host-specific Foundry payload install described by
`monash-foundry`.

`codex plugin marketplace upgrade` is not a refresh operation for the implicit
personal marketplace. Codex 0.153.4 refreshes configured Git snapshots only.
To refresh or replace the cached Monash package, keep the `personal`
marketplace entry and remove only the installed plugin before adding it again:

```sh
codex plugin remove monash@personal --json
codex plugin add monash@personal --json
```

Run the remove command only when `monash@personal` is installed. A fresh
`codex plugin add` reads the registered local source; the disposable probe
verified that remove and re-add installs the changed source bytes.

## Rollback

### First-install rollback

This is the rollback for the first Monash release, when no earlier dotfiles
revision contains a Monash package. Remove only the installed `monash` plugin,
and leave the inline `personal` marketplace registration in place for other
plugins:

```sh
# Claude Code
claude plugin uninstall monash@personal --scope user -y

# Codex
codex plugin remove monash@personal --json
```

Run each command only when that Harness lists `monash` as installed. If the
plugin was never installed, there is nothing to remove. These commands do not
remove the marketplace, Foundry runtime files, Herdr configuration, sessions,
or history.

### Rollback to an earlier Monash revision

Use this path only when an earlier reviewed dotfiles revision already contains
the Monash package. Restore that source revision first, then refresh each
Harness cache from the restored source:

```sh
# Claude Code
claude plugin uninstall monash@personal --scope user -y
claude plugin marketplace update personal
claude plugin install monash@personal --scope user

# Codex local marketplace
codex plugin remove monash@personal --json
codex plugin add monash@personal --json
```

Run uninstall or remove only when the current plugin is installed. Do not
remove the `personal` marketplace during either rollback if another personal
plugin uses it. Use `claude plugin disable monash@personal` when the package
should remain installed but inactive.

Removing the plugin does not remove `foundry`, `monash-foundry`, or the private
Herdr configuration. This README does not claim a runtime installer rollback
procedure; no exact one is documented by this package. Treat any separate
`scripts/foundry/install.py` installation as an independent operation.
