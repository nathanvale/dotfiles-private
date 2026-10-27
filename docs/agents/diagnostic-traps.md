# Diagnostic Traps

Commands and tools that report confident, wrong answers, or destroy state
while succeeding. Each caused a real misdiagnosis or loss. Prefer the correct
form; do not trust the naive one.

## Optional-value flags swallow the next argument

A flag declared as `--flag [<VALUE>]` takes its value with no `=`, so a
positional argument that follows it is consumed as that value and rejected.
In eza v0.23.5 this affects `--icons`, `--color`, `--classify` / `-F`,
`--hyperlink`, `--absolute`, and `--color-scale`.

Symptom: `ls <path>` failed with `invalid value '<path>' for '--icons
[<WHEN>]'` while bare `ls` worked. The usage error reads like a missing
directory, so a present directory was reported as absent.

- Bind the value: write `--icons=always`, never a bare `--icons` before a path.
- List the exposed flags for a tool with `<tool> --help | grep '\[<'`.
- Fixed in `.zshrc` aliases `ls`, `ll`, `lla`, `la`, `lt`.

## Broken-symlink scans report false positives

`find -type l ! -exec test -e {} \;` misreports resolvable links. It reported
87 broken links in `~/.claude` and 26 in dotfiles; the true counts were 2 and
0. Verify each candidate with a plain `[ -e "$link" ]` test instead.

```sh
find "$root" -type l | while IFS= read -r l; do
  [ -e "$l" ] || echo "DANGLING: $l -> $(readlink "$l")"
done
```

- A link whose target is its own path never resolves. Read `readlink` output
  before judging a link broken.
- Exclude `.worktrees` when scanning a repository. Its links are disposable.

## Claude rewrites its user settings file

Claude Code rewrites `~/.claude/settings.json` wholesale on every supported
settings write: plugin install, enable or disable, marketplace add, `/model`,
`/effort`. On a HOME without its one-time migration flags in
`~/.claude.json`, even `claude plugin list` rewrites it (2.1.311 changed
`model` to `opus[1m]` and dropped `skipAutoPermissionPrompt`).

While that path was a symlink into dotfiles, each write dirtied the tracked
file and blocked Herdr Projects merges with "Merge needs a clean checkout"
(FLS-3 and FLS-4, 27 October 2026). A 2026-08-19 `/plugin` session also lost
the whole `skillOverrides` block, 73 entries.

- Policy source: `config/agents/claude/settings.json`. Edit it there and run
  `./setup.sh symlinks`; `bin/dotfiles/claude-settings.py` merges it into the
  real machine-owned `~/.claude/settings.json`.
- Machine choices stay out of Git: `model`, `effortLevel`, `modelSettings`
  and `theme` (seeded only into a new file), plus plugin and marketplace
  entries the policy does not declare.
- Existing host still on the symlink: break it before cleaning or updating the
  checkout, or its machine writes are lost with the tracked diff. Confirm the
  last command prints `file`:

  ```sh
  cp ~/.claude/settings.json ~/.claude/settings.json.real && mv ~/.claude/settings.json.real ~/.claude/settings.json
  test -L ~/.claude/settings.json && echo symlink || echo file
  ```
- Hooks and permissions merge three ways against
  `~/.claude/settings.dotfiles-policy.json`, the last-applied policy: policy
  edits and retirements apply, a host's own hooks, rules and `defaultMode`
  stay, and a missing policy hook or rule is restored. A host's first run has
  no record, so it keeps every existing value.
- `./verify_install.sh` fails on unapplied or missing policy and warns when a
  host keeps a security value that differs from it. `claude-settings.py
  --check` prints each `Host keeps …` value; port an intended one to the
  tracked file or change it on the host.
- A host's in-place edit of a policy hook group leaves both groups after setup;
  `--check` names `hooks` first.
- Plugin state also lives in untracked runtime files
  (`~/.claude/plugins/known_marketplaces.json`, `installed_plugins.json`).
  An `enabledPlugins` key with no matching install is inert: a session starts
  clean, exit 0, no warning. The key declares; it does not restore.
